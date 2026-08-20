import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import {
  emitDryRunBanner,
  makeHttpClient,
  parseRequestTimeoutFlag,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import {
  ApiError,
  CLIError,
  InterruptError,
  RequestTimeoutError,
  localValidationError,
} from '../lib/errors.js';
import {
  REQUEST_TIMEOUT_DEFAULT_MS,
  REQUEST_TIMEOUT_MAX_MS,
  type FetchImpl,
  type HttpClient,
} from '../lib/http.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode, type OutputMode } from '../lib/output.js';
import { pollRunUntilTerminal, TimeoutError } from '../lib/poll.js';
import { emitCiArtifacts, summarizeAcceptedPayload } from '../lib/gh-output.js';
import { describeConflict, summarizeConflicts } from '../lib/conflict-reason.js';
import { createTicker } from '../lib/ticker.js';
import {
  buildJUnitReport,
  parseJUnitReportFormat,
  writeJUnitReportFile,
  type JUnitReportFormat,
  type JUnitTestResult,
} from '../lib/junit-report.js';
import { renderTextTable, resolveTextColumns, type TextTableColumn } from '../lib/text-table.js';
import { assertIdempotencyKey } from '../lib/validate.js';
import { resolveWaitFailure } from '../lib/wait-exit.js';
import type {
  CliDeleteTestListResponse,
  CliProjectEnvironment,
  CliTestList,
  CliTestListDetail,
  CliTestListListResponse,
  CliTestListRunAccepted,
  CliTestListRunResponse,
} from '../lib/testlist.types.js';

export interface TestListDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Injectable sleep for the `--wait` poll (tests pass an instant sleep). */
  sleep?: (ms: number) => Promise<void>;
}

type CommonOptions = FactoryCommonOptions;

// ── helpers ──────────────────────────────────────────────────────────────────

function resolveCommonOptions(command: Command): CommonOptions {
  const g = command.optsWithGlobals() as Partial<CommonOptions> & { requestTimeout?: string };
  return {
    profile: g.profile ?? 'default',
    output: resolveOutputMode(g.output),
    endpointUrl: g.endpointUrl,
    debug: g.debug ?? false,
    verbose: g.verbose ?? false,
    dryRun: g.dryRun ?? false,
    requestTimeoutMs: parseRequestTimeoutFlag(g.requestTimeout),
  };
}

function makeClient(opts: CommonOptions, deps: TestListDeps): HttpClient {
  return makeHttpClient(opts, {
    env: deps.env,
    credentialsPath: deps.credentialsPath,
    fetchImpl: deps.fetchImpl,
    stderr: deps.stderr,
  });
}

function makeOutput(mode: OutputMode, deps: TestListDeps): Output {
  return new Output(mode, { stdout: deps.stdout, stderr: deps.stderr });
}

function emitIdempotencyKey(
  opts: CommonOptions,
  deps: TestListDeps,
  key: string,
  supplied?: string,
) {
  if (supplied === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    const stderr = deps.stderr ?? (line => process.stderr.write(`${line}\n`));
    stderr(`idempotency-key: ${key}`);
  }
}

/**
 * Parse a repeatable `--project-env <projectId>:<environmentName>` flag. Splits
 * on the FIRST `:` so an environment name containing `:` still round-trips
 * (project ids are UUIDs and never contain one). Raises a typed
 * VALIDATION_ERROR (exit 5) on a malformed pair.
 */
function parseProjectEnvs(pairs: string[] | undefined): CliProjectEnvironment[] | undefined {
  if (pairs === undefined || pairs.length === 0) return undefined;
  return pairs.map(raw => {
    const idx = raw.indexOf(':');
    if (idx <= 0 || idx === raw.length - 1) {
      throw localValidationError('project-env', 'expected <projectId>:<environmentName>', raw);
    }
    return { projectId: raw.slice(0, idx), environmentName: raw.slice(idx + 1) };
  });
}

const collectRepeatable = (value: string, acc: string[]): string[] => [...acc, value];

function dryRunStderr(deps: TestListDeps): (line: string) => void {
  return deps.stderr ?? (line => process.stderr.write(`${line}\n`));
}

// Canned `--dry-run` samples (offline, no network) — the global `--dry-run`
// contract promises a shape-accurate sample for every command.
const DRY_RUN_LIST: CliTestList = {
  id: 'tl_dryrun',
  name: 'dry-run test list',
  orgId: 'org_dryrun',
  caseCount: 0,
  projectEnvironments: [],
  lastExecutionId: null,
  createdAt: '2026-05-16T00:00:00.000Z',
  updatedAt: '2026-05-16T00:00:00.000Z',
};
const DRY_RUN_DETAIL: CliTestListDetail = {
  ...DRY_RUN_LIST,
  cases: [],
  stats: { total: 0, passed: 0, failed: 0, blocked: 0, running: 0 },
  lastExecutionCreated: null,
};

// ── run functions (called directly by tests) ─────────────────────────────────

export async function runTestlistList(
  opts: CommonOptions & { columns?: string; noHeader?: boolean },
  deps: TestListDeps = {},
): Promise<CliTestList[]> {
  const out = makeOutput(opts.output, deps);
  if (opts.output === 'text' && opts.columns !== undefined) {
    resolveTextColumns(opts.columns, TESTLIST_COLUMNS); // validate up front (exit 5 on a bad key)
  }
  if (opts.dryRun) {
    emitDryRunBanner(dryRunStderr(deps));
    out.print([DRY_RUN_LIST], data => renderTestListListText(data as CliTestList[], opts));
    return [DRY_RUN_LIST];
  }
  const client = makeClient(opts, deps);
  const resp = await client.get<CliTestListListResponse>('/testlist');
  out.print(resp.items, data => renderTestListListText(data as CliTestList[], opts));
  return resp.items;
}

export async function runTestlistGet(
  opts: CommonOptions & { listId: string },
  deps: TestListDeps = {},
): Promise<CliTestListDetail> {
  const out = makeOutput(opts.output, deps);
  if (opts.dryRun) {
    emitDryRunBanner(dryRunStderr(deps));
    out.print(DRY_RUN_DETAIL, data => renderTestListDetailText(data as CliTestListDetail));
    return DRY_RUN_DETAIL;
  }
  const client = makeClient(opts, deps);
  const detail = await client.get<CliTestListDetail>(
    `/testlist/${encodeURIComponent(opts.listId)}`,
  );
  out.print(detail, data => renderTestListDetailText(data as CliTestListDetail));
  return detail;
}

export async function runTestlistCreate(
  opts: CommonOptions & {
    name?: string;
    projectEnv?: string[];
    idempotencyKey?: string;
  },
  deps: TestListDeps = {},
): Promise<CliTestListDetail> {
  const out = makeOutput(opts.output, deps);
  if (opts.name === undefined || opts.name.trim() === '') {
    throw localValidationError('name', 'is required');
  }
  if (opts.idempotencyKey !== undefined) assertIdempotencyKey(opts.idempotencyKey);
  const projectEnvironments = parseProjectEnvs(opts.projectEnv);

  const idempotencyKey = opts.idempotencyKey ?? `cli-testlist-create-${randomUUID()}`;
  emitIdempotencyKey(opts, deps, idempotencyKey, opts.idempotencyKey);

  if (opts.dryRun) {
    emitDryRunBanner(dryRunStderr(deps));
    const sample = { ...DRY_RUN_DETAIL, name: opts.name };
    out.print(sample, data => renderTestListDetailText(data as CliTestListDetail));
    return sample;
  }

  const client = makeClient(opts, deps);
  const detail = await client.post<CliTestListDetail>('/testlist', {
    body: { name: opts.name, ...(projectEnvironments ? { projectEnvironments } : {}) },
    headers: { 'idempotency-key': idempotencyKey },
  });
  out.print(detail, data => renderTestListDetailText(data as CliTestListDetail));
  return detail;
}

export async function runTestlistUpdate(
  opts: CommonOptions & {
    listId: string;
    name?: string;
    projectEnv?: string[];
    clearProjectEnv?: boolean;
    idempotencyKey?: string;
  },
  deps: TestListDeps = {},
): Promise<CliTestListDetail> {
  const out = makeOutput(opts.output, deps);
  const hasProjectEnv = opts.projectEnv !== undefined && opts.projectEnv.length > 0;
  if (opts.clearProjectEnv && hasProjectEnv) {
    throw localValidationError('clear-project-env', 'cannot be combined with --project-env');
  }
  if (opts.name === undefined && !hasProjectEnv && !opts.clearProjectEnv) {
    throw localValidationError('name', 'pass --name, --project-env, or --clear-project-env');
  }
  if (opts.idempotencyKey !== undefined) assertIdempotencyKey(opts.idempotencyKey);
  // `[]` (clear) vs the parsed array vs `undefined` (leave untouched) — the
  // three cases the V3 update contract distinguishes.
  const projectEnvironments = opts.clearProjectEnv ? [] : parseProjectEnvs(opts.projectEnv);

  const idempotencyKey = opts.idempotencyKey ?? `cli-testlist-update-${randomUUID()}`;
  emitIdempotencyKey(opts, deps, idempotencyKey, opts.idempotencyKey);

  if (opts.dryRun) {
    emitDryRunBanner(dryRunStderr(deps));
    const sample = { ...DRY_RUN_DETAIL, ...(opts.name !== undefined ? { name: opts.name } : {}) };
    out.print(sample, data => renderTestListDetailText(data as CliTestListDetail));
    return sample;
  }

  const client = makeClient(opts, deps);
  const detail = await client.put<CliTestListDetail>(
    `/testlist/${encodeURIComponent(opts.listId)}`,
    {
      body: {
        ...(opts.name !== undefined ? { name: opts.name } : {}),
        ...(projectEnvironments !== undefined ? { projectEnvironments } : {}),
      },
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
  out.print(detail, data => renderTestListDetailText(data as CliTestListDetail));
  return detail;
}

export async function runTestlistDelete(
  opts: CommonOptions & { listId: string; confirm?: boolean; idempotencyKey?: string },
  deps: TestListDeps = {},
): Promise<CliDeleteTestListResponse> {
  const out = makeOutput(opts.output, deps);
  // Destructive: deleting a list also deletes its schedules (and reaps their
  // EventBridge triggers). Require explicit --confirm — matches the CLI's
  // project/test delete convention and prevents accidental CI/shell deletion.
  // --dry-run is exempt (it never touches the server).
  if (!opts.confirm && !opts.dryRun) {
    throw localValidationError(
      'confirm',
      'required for a destructive delete (deletes the list and its schedules); re-run with --confirm, or use --dry-run',
      undefined,
      'flag',
    );
  }
  if (opts.idempotencyKey !== undefined) assertIdempotencyKey(opts.idempotencyKey);
  const idempotencyKey = opts.idempotencyKey ?? `cli-testlist-delete-${randomUUID()}`;
  emitIdempotencyKey(opts, deps, idempotencyKey, opts.idempotencyKey);

  if (opts.dryRun) {
    emitDryRunBanner(dryRunStderr(deps));
    const sample: CliDeleteTestListResponse = { listId: opts.listId };
    out.print(sample, data => `Deleted test list ${(data as CliDeleteTestListResponse).listId}`);
    return sample;
  }

  const client = makeClient(opts, deps);
  const resp = await client.delete<CliDeleteTestListResponse>(
    `/testlist/${encodeURIComponent(opts.listId)}`,
    { headers: { 'idempotency-key': idempotencyKey } },
  );
  out.print(resp, data => `Deleted test list ${(data as CliDeleteTestListResponse).listId}`);
  return resp;
}

async function mutateCases(
  verb: 'add' | 'remove',
  opts: CommonOptions & { listId: string; testIds: string[]; idempotencyKey?: string },
  deps: TestListDeps,
): Promise<CliTestListDetail> {
  const out = makeOutput(opts.output, deps);
  if (opts.testIds.length === 0) {
    throw localValidationError('test-id', 'at least one test id is required', undefined, 'field');
  }
  if (opts.idempotencyKey !== undefined) assertIdempotencyKey(opts.idempotencyKey);
  const idempotencyKey = opts.idempotencyKey ?? `cli-testlist-${verb}-${randomUUID()}`;
  emitIdempotencyKey(opts, deps, idempotencyKey, opts.idempotencyKey);

  if (opts.dryRun) {
    emitDryRunBanner(dryRunStderr(deps));
    out.print(DRY_RUN_DETAIL, data => renderTestListDetailText(data as CliTestListDetail));
    return DRY_RUN_DETAIL;
  }

  const path =
    verb === 'add'
      ? `/testlist/${encodeURIComponent(opts.listId)}/cases`
      : `/testlist/${encodeURIComponent(opts.listId)}/cases/delete`;

  const client = makeClient(opts, deps);
  const detail = await client.post<CliTestListDetail>(path, {
    body: { testIds: opts.testIds },
    headers: { 'idempotency-key': idempotencyKey },
  });
  out.print(detail, data => renderTestListDetailText(data as CliTestListDetail));
  return detail;
}

export const runTestlistAdd = (
  opts: CommonOptions & { listId: string; testIds: string[]; idempotencyKey?: string },
  deps: TestListDeps = {},
) => mutateCases('add', opts, deps);

export const runTestlistRemove = (
  opts: CommonOptions & { listId: string; testIds: string[]; idempotencyKey?: string },
  deps: TestListDeps = {},
) => mutateCases('remove', opts, deps);

// ── run ────────────────────────────────────────────────────────────────────

const MAX_TESTLIST_RUN_CONCURRENCY = 50;
const DEFAULT_TESTLIST_RUN_CONCURRENCY = 10;
const DEFAULT_TESTLIST_RUN_TIMEOUT_SECONDS = 600;
const WAIT_REQUEST_TIMEOUT_CUSHION_MS = 5_000;

/**
 * Under `--wait`, raise the per-request HTTP timeout to cover `--timeout` so a
 * slow trigger / long-poll on a large list isn't cut short by the default 120s
 * request deadline and mis-reported as a member timeout. Mirrors
 * `test run`'s `resolveWaitRequestTimeoutMs` (reimplemented locally to keep this
 * file off the `test.ts` module — see the security-lint note on `run`).
 */
export function waitRequestTimeoutMs(opts: {
  wait?: boolean;
  timeoutSeconds?: number;
  requestTimeoutMs?: number;
}): number | undefined {
  if (opts.wait !== true || opts.timeoutSeconds === undefined) return opts.requestTimeoutMs;
  const base = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_DEFAULT_MS;
  const cover = Math.min(
    opts.timeoutSeconds * 1000 + WAIT_REQUEST_TIMEOUT_CUSHION_MS,
    REQUEST_TIMEOUT_MAX_MS,
  );
  return Math.max(base, cover);
}

/** Parse `--timeout <s>` (1–3600, default 600). Mirrors `test run`'s bounds. */
function parseTestlistTimeoutFlag(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TESTLIST_RUN_TIMEOUT_SECONDS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 3600) {
    throw localValidationError('timeout', 'must be an integer between 1 and 3600', raw);
  }
  return n;
}

/** Parse `--max-concurrency <n>` (≥1, default 10). Upper bound is enforced in `runTestlistRun`. */
function parseTestlistConcurrencyFlag(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TESTLIST_RUN_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw localValidationError('max-concurrency', 'must be a positive integer', raw);
  }
  return n;
}

export interface RunTestlistRunOptions extends CommonOptions {
  listId: string;
  /** --case (repeatable): run only this subset of the list's cases (== test ids). */
  cases?: string[];
  /** --wait: block until every dispatched run is terminal or --timeout. */
  wait: boolean;
  /** Shared poll deadline in seconds. */
  timeoutSeconds: number;
  /** --max-concurrency: bounds the --wait poll fan-out. */
  maxConcurrency: number;
  idempotencyKey?: string;
  report?: JUnitReportFormat;
  reportFile?: string;
  reportSuiteName?: string;
  /** --gh-output: force the GitHub-native output layer (::error:: + job summary) even off-Actions. */
  ghOutput?: boolean;
  /** --summary-file: also write the reduced machine summary JSON to this path. */
  summaryFile?: string;
}

/**
 * One member of the `--wait` poll — shape shared with the JUnit builder, plus
 * the run's dashboard link so the CI annotations / summary table are clickable
 * (the JUnit report ignores the extra field).
 */
type TestlistRunMemberResult = JUnitTestResult & { dashboardUrl?: string };

/**
 * Rate-deferred members were never dispatched → the batch is incomplete (exit 7),
 * mirroring `test run --all`. The backend applies the same per-key run-rate
 * soft-fold as `POST /tests/batch/run` and returns the overflow here, so a
 * partial dispatch surfaces as a non-zero exit instead of silently passing CI.
 */
function assertNoDeferred(resp: CliTestListRunResponse): void {
  if (resp.deferred.length === 0) return;
  const ids = resp.deferred.map(d => d.testId).join(' ');
  throw new CLIError(
    `Batch run incomplete: ${resp.deferred.length} test(s) rate-deferred (per-key run budget) — retry after ~60s: ${ids}`,
    7,
  );
}

/**
 * A partial `--case` miss (some ids are not members of the list) means the run
 * did not cover everything the operator asked for → exit non-zero (4, NOT_FOUND)
 * so a mistyped/renamed id fails the CI step instead of passing green. Checked
 * AFTER the poll gates, so a genuine failure/timeout on the matched subset is
 * reported first; the ids were already surfaced on stderr the moment they were
 * known. A FULL miss is a 404 upstream and never reaches this command.
 */
function assertNoNotFound(resp: CliTestListRunResponse): void {
  if (!resp.notFound || resp.notFound.length === 0) return;
  throw new CLIError(
    `${resp.notFound.length} --case id(s) not in this list: ${resp.notFound.join(' ')}`,
    4,
  );
}

/**
 * `testlist run` — dispatch the list's cases (optionally a `--case` subset) and,
 * with `--wait`, poll every returned runId to a verdict, optionally writing a
 * JUnit XML report (`--report junit`). testlist run is V3-only.
 */
export async function runTestlistRun(
  opts: RunTestlistRunOptions,
  deps: TestListDeps = {},
): Promise<CliTestListRunResponse> {
  const out = makeOutput(opts.output, deps);
  const stderrFn = deps.stderr ?? (line => process.stderr.write(`${line}\n`));

  if (opts.idempotencyKey !== undefined) assertIdempotencyKey(opts.idempotencyKey);
  if (
    !Number.isInteger(opts.maxConcurrency) ||
    opts.maxConcurrency < 1 ||
    opts.maxConcurrency > MAX_TESTLIST_RUN_CONCURRENCY
  ) {
    throw localValidationError(
      'max-concurrency',
      `must be an integer between 1 and ${MAX_TESTLIST_RUN_CONCURRENCY}`,
    );
  }
  if (opts.report === 'junit' && opts.reportFile === undefined) {
    throw localValidationError('report-file', 'required when --report junit is set');
  }
  if (opts.report === 'junit' && !opts.wait) {
    throw localValidationError(
      'report',
      '--report junit requires --wait (verdicts come from the poll)',
    );
  }
  // --gh-output / --summary-file reduce a --wait run's per-member results into the
  // CI summary. They require --wait (without it the command returns after dispatch,
  // before any terminal result exists) — reject loudly, same rule as --report junit
  // above and the sibling `test run` flags. Gate only the EXPLICIT flags; the
  // GITHUB_ACTIONS auto-enable must stay silent without --wait, same as `test run`.
  if (opts.ghOutput === true && !opts.wait) {
    throw localValidationError(
      'gh-output',
      '--gh-output requires --wait (it reduces the terminal run result). Add --wait.',
    );
  }
  if (opts.summaryFile !== undefined && !opts.wait) {
    throw localValidationError(
      'summary-file',
      '--summary-file requires --wait (it reduces the terminal run result). Add --wait.',
    );
  }

  const idempotencyKey = opts.idempotencyKey ?? `cli-testlist-run-${randomUUID()}`;
  emitIdempotencyKey(opts, deps, idempotencyKey, opts.idempotencyKey);

  if (opts.dryRun) {
    emitDryRunBanner(dryRunStderr(deps));
    const sample: CliTestListRunResponse = { accepted: [], conflicts: [], deferred: [] };
    out.print(sample, () => 'dry-run: no runs dispatched');
    return sample;
  }

  // Under --wait, raise the per-request timeout to cover --timeout (see helper).
  const client = makeClient({ ...opts, requestTimeoutMs: waitRequestTimeoutMs(opts) }, deps);
  const resp = await client.triggerTestListRun(
    opts.listId,
    opts.cases && opts.cases.length > 0 ? { testIds: opts.cases } : {},
    { idempotencyKey },
  );

  // Partial `--case` miss: some ids were not members of this list. The matched
  // subset still dispatched; a FULL miss is a 404 upstream and never reaches
  // here. Warn on stderr so JSON stdout stays the machine payload (the ids are
  // also carried on `resp.notFound`).
  if (resp.notFound && resp.notFound.length > 0) {
    stderrFn(
      `warning: ${resp.notFound.length} --case id(s) not in this list, skipped: ${resp.notFound.join(' ')}`,
    );
  }

  // All-conflict: nothing new dispatched because every targeted case is already
  // in flight → exit 6, for BOTH --wait and non-wait (a --wait over zero accepted
  // would otherwise no-op straight to exit 0). Distinct from the empty/no-match
  // case (accepted AND conflicts both empty), which is a legitimate success and
  // flows through the tail below so its CI artifacts are still emitted.
  if (resp.accepted.length === 0 && resp.conflicts.length > 0) {
    out.print(resp, () => renderRunAcceptedText(resp));
    // Surface the exit-6 in CI too (only under --wait, the CI-artifact contract):
    // an all-conflict re-run — every targeted case already in flight — otherwise
    // exits 6 with no ::error:: annotation and no summary file. The conflicts fold
    // into the summary as non-passed rows. The non-wait path never emits CI
    // artifacts, matching the main tail below.
    if (opts.wait) {
      emitCiArtifacts(
        summarizeAcceptedPayload(
          JSON.stringify({
            accepted: [],
            conflicts: resp.conflicts,
            deferred: resp.deferred,
            // Include notFound too: a mixed `--case` selection can be
            // all-conflict on its matched ids AND carry not-in-list ids, and the
            // CI summary must report the whole requested set (same reason the
            // main --wait envelope threads it). Undefined ⇒ JSON.stringify drops it.
            notFound: resp.notFound,
          }),
          { notFoundNote: 'not a member of this list (not dispatched)' },
        ),
        opts,
        {
          env: deps.env ?? process.env,
          stdout: deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`)),
          stderr: stderrFn,
        },
        'testlist run',
      );
    }
    const pollIds = resp.conflicts
      .map(c => c.currentRunId)
      .filter((id): id is string => Boolean(id));
    // Name the causes instead of blanket "already in flight" — a list pinned to
    // a local env or a view-only project is not something to poll. The poll hint
    // is emitted only for the cases that actually have an in-flight run.
    throw new CLIError(
      `Nothing dispatched — ${resp.conflicts.length} conflict(s): ${summarizeConflicts(resp.conflicts)}` +
        (pollIds.length > 0
          ? `. Poll in-flight runs: testsprite test wait ${pollIds.join(' ')}`
          : ''),
      6,
    );
  }

  if (!opts.wait) {
    // Print what dispatched, or the empty/no-match reason. Exit 0.
    out.print(resp, () =>
      resp.accepted.length > 0
        ? renderRunAcceptedText(resp)
        : `No runs dispatched${resp.reason ? ` (${resp.reason})` : ''}.`,
    );
    assertNoDeferred(resp);
    assertNoNotFound(resp);
    return resp;
  }

  // --wait beyond this point. An empty/no-match run (zero accepted, zero
  // conflicts) is NOT short-circuited: it flows through the fan-out (a no-op) and
  // the report tail so an explicitly-requested --report junit still emits an
  // empty-suite report rather than nothing.

  // --- --wait fan-out ---
  const ticker = createTicker(stderrFn, opts.output === 'json' ? false : undefined);
  const batchDeadlineMs = Date.now() + opts.timeoutSeconds * 1000;
  const results: TestlistRunMemberResult[] = [];

  async function pollOne(entry: CliTestListRunAccepted): Promise<TestlistRunMemberResult> {
    const remainingMs = batchDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      return {
        testId: entry.testId,
        runId: entry.runId,
        status: 'timeout',
        error: {
          code: 'UNSUPPORTED',
          message: `Timed out after ${opts.timeoutSeconds}s`,
          exitCode: 7,
        },
      };
    }
    try {
      // testlist run is V3-only; V3 run rows (FE and BE) finalize via the
      // execution completion path, so the run-surface poll resolves without the
      // V2 BE-orphan-row fallback that `test run` needs.
      const finalRun = await pollRunUntilTerminal(client, entry.runId, {
        timeoutSeconds: Math.ceil(remainingMs / 1000),
        sleep: deps.sleep,
        onTransition: opts.verbose ? (msg: string) => stderrFn(`[verbose] ${msg}`) : undefined,
        onTick: (run, elapsedMs) => {
          const s = run.stepSummary ?? { total: 0, completed: 0, passedCount: 0, failedCount: 0 };
          ticker.update(
            `Run ${run.runId} (${entry.testId}) — ${run.status} (${s.completed}/${s.total} steps elapsed=${Math.round(elapsedMs / 1000)}s)`,
          );
        },
      });
      return {
        testId: entry.testId,
        runId: entry.runId,
        projectId: finalRun.projectId,
        status: finalRun.status,
        // Carry the run's dashboard link so the ::error:: annotations and the
        // job-summary Run column are clickable (parity with `test run --all`).
        // Use the SERVER's dashboardUrl, not a client-built resolvePortalUrl:
        // testlist run is V3-only, and the client helper emits the V2 route
        // shape (`/dashboard/tests/...`) which 404s for a V3 project.
        ...(typeof finalRun.dashboardUrl === 'string'
          ? { dashboardUrl: finalRun.dashboardUrl }
          : {}),
      };
    } catch (err) {
      if (err instanceof TimeoutError) {
        return {
          testId: entry.testId,
          runId: entry.runId,
          status: 'timeout',
          error: {
            code: 'UNSUPPORTED',
            message: `Timed out after ${opts.timeoutSeconds}s`,
            exitCode: 7,
          },
        };
      }
      // Interrupt must reject the whole fan-out (never flatten to a per-member
      // outcome that would swallow the 128+signum exit).
      if (err instanceof InterruptError) throw err;
      if (err instanceof RequestTimeoutError) {
        return {
          testId: entry.testId,
          runId: entry.runId,
          status: 'timeout',
          error: { code: 'UNSUPPORTED', message: err.message, exitCode: err.exitCode },
        };
      }
      if (err instanceof ApiError) {
        // Preserve the real code/exit (AUTH_INVALID=3, NOT_FOUND=4, …) rather
        // than flattening every member failure to a generic 1.
        return {
          testId: entry.testId,
          runId: entry.runId,
          status: 'error',
          error: { code: err.code, message: err.message, exitCode: err.exitCode },
        };
      }
      throw err;
    }
  }

  // Bounded-concurrency fan-out (self-contained; deliberately kept separate from
  // `runTestRunAll`'s inline driver rather than extracting a shared helper).
  let pollIdx = 0;
  let inFlight = 0;
  await new Promise<void>((resolve, reject) => {
    function startNext(): void {
      while (inFlight < opts.maxConcurrency && pollIdx < resp.accepted.length) {
        const entry = resp.accepted[pollIdx++]!;
        inFlight++;
        pollOne(entry)
          .then(r => {
            results.push(r);
            inFlight--;
            startNext();
            if (inFlight === 0 && pollIdx >= resp.accepted.length) resolve();
          })
          .catch(reject);
      }
    }
    startNext();
    if (resp.accepted.length === 0) resolve();
  });

  ticker.finalize();

  const passed = results.filter(r => r.status === 'passed').length;
  const failed = results.filter(r => r.status !== 'passed' && r.status !== 'timeout').length;
  const timedOut = results.filter(r => r.status === 'timeout').length;
  stderrFn(
    `Test-list run complete: ${passed}/${resp.accepted.length} passed, ${failed} failed/blocked, ${timedOut} timed out`,
  );

  const jsonPayload = {
    accepted: results,
    conflicts: resp.conflicts,
    deferred: resp.deferred,
    // Not members of this list (partial `--case` miss). Threaded into the
    // envelope so `summarizeAcceptedPayload` folds them as non-passed rows
    // (gh-output.ts) — without this a `1 accepted passed + 1 not-found` run
    // read as "1/1 passed" in the CI summary while the command exits 4.
    ...(resp.notFound && resp.notFound.length > 0 ? { notFound: resp.notFound } : {}),
    // Present only on a nothing-dispatched run (empty list / no-match --case);
    // surfaced here so the --wait envelope explains a zero-run report.
    ...(resp.reason ? { reason: resp.reason } : {}),
    summary: {
      passed,
      failed,
      timedOut,
      deferred: resp.deferred.length,
      conflicts: resp.conflicts.length,
      total: resp.accepted.length,
    },
  };

  if (opts.report === 'junit' && opts.reportFile !== undefined) {
    // Multi-project list: name the suite/classname by the LIST, not one project
    // (`resolveBatchReportProjectId`'s single-project assumption doesn't hold).
    const suiteName = opts.reportSuiteName ?? `testsprite:testlist:${opts.listId}`;
    const xml = buildJUnitReport({ suiteName, classname: `testlist:${opts.listId}`, results });
    await writeJUnitReportFile(opts.reportFile, xml);
  }

  out.print(jsonPayload, () => results.map(r => `${r.runId}  ${r.status}`).join('\n'));

  // CI-native output parity with `test run` (--gh-output / --summary-file):
  // auto-enable under GITHUB_ACTIONS. Emit BEFORE the exit-code gates below so a
  // failing/timed-out/deferred run still gets its ::error:: annotations + the
  // job-summary table. `emitCiArtifacts` is the shared helper the sibling run
  // paths use, keyed off the identical reduced envelope.
  emitCiArtifacts(
    summarizeAcceptedPayload(JSON.stringify(jsonPayload), {
      notFoundNote: 'not a member of this list (not dispatched)',
    }),
    opts,
    {
      env: deps.env ?? process.env,
      stdout: deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`)),
      stderr: stderrFn,
    },
    'testlist run',
  );

  // Rate-deferred → incomplete batch (exit 7), checked before the timeout/failed
  // gates so the operator learns to retry the deferred set (mirrors test run --all).
  assertNoDeferred(resp);

  // Shared exit-code precedence (auth 3 → typed operational ApiError → timeout 7
  // → generic fail 1) so `testlist run` and `test run` can't drift.
  const failure = resolveWaitFailure(results, { timeoutSeconds: opts.timeoutSeconds });
  if (failure) throw failure;

  assertNoNotFound(resp);
  return resp;
}

function renderRunAcceptedText(resp: CliTestListRunResponse): string {
  const lines: string[] = [];
  for (const a of resp.accepted) lines.push(`${a.runId}  ${a.testId}  dispatched`);
  for (const c of resp.conflicts) {
    // Reason-aware: a view-only / un-runnable / not-found case is no longer
    // mislabelled "already-in-flight" (see describeConflict).
    lines.push(`${c.currentRunId ?? '(none)'}  ${c.testId}  ${describeConflict(c)}`);
  }
  if (lines.length === 0) return 'No runs dispatched.';
  return lines.join('\n');
}

// ── text renderers ───────────────────────────────────────────────────────────

const TESTLIST_COLUMNS: ReadonlyArray<TextTableColumn<CliTestList>> = [
  { header: 'ID', width: rows => Math.max(2, ...rows.map(r => r.id.length)), render: r => r.id },
  {
    header: 'NAME',
    width: rows => Math.max(4, ...rows.map(r => r.name.length)),
    render: r => r.name,
  },
  { header: 'CASES', width: 5, render: r => String(r.caseCount) },
  // Fixed 36 (a UUID); `width: 0` (skip-padding) is only valid on the LAST
  // column, and UPDATED is last — a `width: 0` here would leave LAST_EXEC
  // unpadded and drift UPDATED per row (UUID 36 chars vs "(none)" 6 chars).
  { header: 'LAST_EXEC', width: 36, render: r => r.lastExecutionId ?? '(none)' },
  { header: 'UPDATED', width: 0, render: r => r.updatedAt },
];

function renderTestListListText(
  items: CliTestList[],
  options: { columns?: string; noHeader?: boolean } = {},
): string {
  if (items.length === 0) return 'No test lists.';
  return renderTextTable(items, TESTLIST_COLUMNS, {
    columns: options.columns,
    noHeader: options.noHeader,
  });
}

function renderTestListDetailText(d: CliTestListDetail): string {
  const lines: string[] = [
    `ID:        ${d.id}`,
    `Name:      ${d.name}`,
    `Cases:     ${d.stats.total} (passed ${d.stats.passed}, failed ${d.stats.failed}, blocked ${d.stats.blocked}, running ${d.stats.running})`,
  ];
  if (d.projectEnvironments.length > 0) {
    lines.push(
      `Envs:      ${d.projectEnvironments.map(e => `${e.projectId}:${e.environmentName}`).join(', ')}`,
    );
  }
  lines.push(`Last exec: ${d.lastExecutionId ?? '(none)'}`);
  lines.push(`Updated:   ${d.updatedAt}`);
  if (d.cases.length > 0) {
    lines.push('');
    const caseTable = renderTextTable(d.cases, [
      {
        header: 'TEST_ID',
        width: rows => Math.max(7, ...rows.map(c => c.testId.length)),
        render: c => c.testId,
      },
      { header: 'TYPE', width: 8, render: c => c.type },
      {
        header: 'TITLE',
        width: rows => Math.max(5, ...rows.map(c => (c.title ?? '').length)),
        render: c => c.title ?? '',
      },
      { header: 'STATUS', width: 0, render: c => c.status ?? '' },
    ]);
    lines.push(caseTable);
  }
  return lines.join('\n');
}

// ── command wiring ───────────────────────────────────────────────────────────

export function createTestListCommand(deps: TestListDeps = {}): Command {
  const testlist = new Command('testlist').description('Manage test lists (groups of tests)');

  testlist
    .command('list')
    .description('List test lists visible to the API key')
    .option('--columns <list>', 'select/reorder text table columns (comma-separated keys)')
    .option('--no-header', 'suppress the text table header row')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts: { columns?: string; header?: boolean }, command: Command) => {
      await runTestlistList(
        {
          ...resolveCommonOptions(command),
          columns: cmdOpts.columns,
          noHeader: cmdOpts.header === false,
        },
        deps,
      );
    });

  testlist
    .command('get <list-id>')
    .description('Get a test list with its cases')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (listId: string, _cmdOpts, command: Command) => {
      await runTestlistGet({ ...resolveCommonOptions(command), listId }, deps);
    });

  testlist
    .command('create')
    .description('Create a test list')
    .option('--name <name>', 'test-list name (required)')
    .option(
      '--project-env <projectId:env>',
      'project+environment pair the list runs against (repeatable)',
      collectRepeatable,
      [] as string[],
    )
    .option('--idempotency-key <key>', 'caller-supplied idempotency key (1-256 chars)')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (
        cmdOpts: { name?: string; projectEnv?: string[]; idempotencyKey?: string },
        command: Command,
      ) => {
        await runTestlistCreate(
          {
            ...resolveCommonOptions(command),
            name: cmdOpts.name,
            projectEnv: cmdOpts.projectEnv,
            idempotencyKey: cmdOpts.idempotencyKey,
          },
          deps,
        );
      },
    );

  testlist
    .command('update <list-id>')
    .description('Update a test list (name and/or environments)')
    .option('--name <name>', 'new name')
    .option(
      '--project-env <projectId:env>',
      'replace the env mapping with these pairs (repeatable)',
      collectRepeatable,
      [] as string[],
    )
    .option('--clear-project-env', 'remove all environment mappings from the list')
    .option('--idempotency-key <key>', 'caller-supplied idempotency key (1-256 chars)')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (
        listId: string,
        cmdOpts: {
          name?: string;
          projectEnv?: string[];
          clearProjectEnv?: boolean;
          idempotencyKey?: string;
        },
        command: Command,
      ) => {
        await runTestlistUpdate(
          {
            ...resolveCommonOptions(command),
            listId,
            name: cmdOpts.name,
            projectEnv: cmdOpts.projectEnv,
            clearProjectEnv: cmdOpts.clearProjectEnv,
            idempotencyKey: cmdOpts.idempotencyKey,
          },
          deps,
        );
      },
    );

  testlist
    .command('delete <list-id>')
    .description('Delete a test list and its schedules (requires --confirm)')
    .option('--confirm', 'confirm the destructive delete (required unless --dry-run)')
    .option('--idempotency-key <key>', 'caller-supplied idempotency key (1-256 chars)')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (
        listId: string,
        cmdOpts: { confirm?: boolean; idempotencyKey?: string },
        command: Command,
      ) => {
        await runTestlistDelete(
          {
            ...resolveCommonOptions(command),
            listId,
            confirm: cmdOpts.confirm,
            idempotencyKey: cmdOpts.idempotencyKey,
          },
          deps,
        );
      },
    );

  testlist
    .command('add <list-id> <test-id...>')
    .description('Add one or more tests to a test list')
    .option('--idempotency-key <key>', 'caller-supplied idempotency key (1-256 chars)')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (
        listId: string,
        testIds: string[],
        cmdOpts: { idempotencyKey?: string },
        command: Command,
      ) => {
        await runTestlistAdd(
          {
            ...resolveCommonOptions(command),
            listId,
            testIds,
            idempotencyKey: cmdOpts.idempotencyKey,
          },
          deps,
        );
      },
    );

  testlist
    .command('remove <list-id> <test-id...>')
    .description('Remove one or more tests from a test list')
    .option('--idempotency-key <key>', 'caller-supplied idempotency key (1-256 chars)')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (
        listId: string,
        testIds: string[],
        cmdOpts: { idempotencyKey?: string },
        command: Command,
      ) => {
        await runTestlistRemove(
          {
            ...resolveCommonOptions(command),
            listId,
            testIds,
            idempotencyKey: cmdOpts.idempotencyKey,
          },
          deps,
        );
      },
    );

  testlist
    .command('run <list-id>')
    .description('Run a test list (dispatch its cases and return pollable run ids)')
    .option(
      '--case <test-id>',
      'run only this case (repeatable; default: every case in the list)',
      collectRepeatable,
      [] as string[],
    )
    .option('--wait', 'poll every dispatched run until terminal or --timeout', false)
    .option('--timeout <s>', 'with --wait, max seconds to wait (1–3600, default 600)')
    .option(
      '--max-concurrency <n>',
      `with --wait, max in-flight polls at once (1-${MAX_TESTLIST_RUN_CONCURRENCY}, default ${DEFAULT_TESTLIST_RUN_CONCURRENCY})`,
    )
    .option('--idempotency-key <key>', 'caller-supplied idempotency key (1-256 chars)')
    .option(
      '--report <format>',
      'with --wait: write a JUnit XML sidecar after polling (accepted: junit)',
    )
    .option('--report-file <path>', 'output path for --report (atomic write)')
    .option(
      '--report-suite-name <name>',
      'JUnit <testsuite name=...> override (default: testsprite:testlist:<listId>)',
    )
    .option(
      '--gh-output',
      'with --wait: emit GitHub-native output (::error:: annotations per non-passed member; job-summary table when $GITHUB_STEP_SUMMARY is set). Auto-enabled when GITHUB_ACTIONS=true',
    )
    .option(
      '--summary-file <path>',
      'with --wait: also write the reduced machine summary JSON {total, passed, failed, timedOut, runs[]} to this file',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (
        listId: string,
        cmdOpts: {
          case?: string[];
          wait?: boolean;
          timeout?: string;
          maxConcurrency?: string;
          idempotencyKey?: string;
          report?: string;
          reportFile?: string;
          reportSuiteName?: string;
          ghOutput?: boolean;
          summaryFile?: string;
        },
        command: Command,
      ) => {
        const wait = cmdOpts.wait === true;
        await runTestlistRun(
          {
            ...resolveCommonOptions(command),
            listId,
            cases: cmdOpts.case,
            wait,
            timeoutSeconds: parseTestlistTimeoutFlag(cmdOpts.timeout),
            maxConcurrency: parseTestlistConcurrencyFlag(cmdOpts.maxConcurrency),
            idempotencyKey: cmdOpts.idempotencyKey,
            report: parseJUnitReportFormat(cmdOpts.report),
            reportFile: cmdOpts.reportFile,
            reportSuiteName: cmdOpts.reportSuiteName,
            ghOutput: cmdOpts.ghOutput,
            summaryFile: cmdOpts.summaryFile,
          },
          deps,
        );
      },
    );

  return testlist;
}
