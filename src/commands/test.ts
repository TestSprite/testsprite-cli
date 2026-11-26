import { runTestlistRunFromCommand } from './testlist.js';
import { ciRefusalOutcome, recordBatchOutcome } from '../lib/telemetry.js';
import type { RunConflict } from '../lib/conflict-reason.js';
import { launchIds } from '../lib/run-render.js';

import { parseLoopbackTargetUrl } from '../lib/local-target.js';
import {
  resolveEnvironmentRunTarget,
  withEnvironmentTunnel,
  assertNoTunnelOptions,
  quoteEnvironmentName,
  type EnvironmentTunnelContext,
  type ResolvedRunTarget,
  type RunTargetTest,
} from '../lib/environment-tunnel.js';
import { createHash, randomUUID } from 'node:crypto';
import { Command } from 'commander';
import {
  emitDryRunBanner,
  makeHttpClient,
  resolveCommonOptions,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import { sampleJUnitReportXml } from '../lib/dry-run/samples.js';
import {
  assertJUnitReportOptions,
  buildJUnitReport,
  durationSecondsBetween,
  resolveBatchReportProjectId,
  skippedJUnitResultsFromSummary,
  writeJUnitReportFile,
  assertArtifactPath,
  type JUnitReportFormat,
  parseJUnitReportFormat,
  type JUnitTestResult,
  writeReportOwing,
} from '../lib/junit-report.js';
import {
  ApiError,
  CLIError,
  InterruptError,
  RequestTimeoutError,
  isAuthCode,
  localValidationError,
} from '../lib/errors.js';
import { emptyProjectHint, emptyProjectNextStep, type LocalHint } from '../lib/first-suite-hint.js';
import { globalShutdown, type ShutdownHandle } from '../lib/interrupt.js';
import { defaultSleep, sleepUnlessInterrupted } from '../lib/poll-support.js';
import { assertIdempotencyKey } from '../lib/validate.js';
import {
  isStandingRateLimit,
  REQUEST_TIMEOUT_DEFAULT_MS,
  REQUEST_TIMEOUT_MAX_MS,
} from '../lib/http.js';
import type { FetchImpl } from '../lib/http.js';
import type { HttpClient } from '../lib/http.js';
import { GLOBAL_OPTS_HINT, Output, type OutputMode } from '../lib/output.js';
import {
  fetchSinglePage,
  paginate,
  validatePaginationFlags,
  type Page,
  type PaginationFlags,
} from '../lib/pagination.js';
import { recordTelemetryExtras, type WaitTimeoutTelemetry } from '../lib/telemetry.js';
import {
  buildRunOutput,
  previewRun,
  renderRunResults,
  runCounts,
  runListingPath,
  type RunCounts,
  type RunReceipt,
  type RunResult,
} from '../lib/run-output.js';
import { resolveCiRunFailure } from '../lib/ci-run.js';
import type {
  ProjectRunRequest,
  ProjectRunResponse,
  RunResponse,
  RunStatus,
  CancelRunResponse,
  CancelRunRefund,
  CiGithubTrigger,
  ExecutionReport,
} from '../lib/runs.types.js';
import { isProxyAgentActive } from '../lib/proxy.js';
import type { CliProjectEnvListResponse } from './project-env.js';
import { assertNotLocal } from '../lib/target-url.js';
import { assertTargetUrlReachable } from '../lib/target-url-preflight.js';
import { TunnelLostError, type TunnelClientHandle } from '../lib/tunnel-session.js';
import { type TunnelClientOptions } from '../vendor/tunnel-client/index.js';
import { renderTextTable, resolveTextColumns, type TextTableColumn } from '../lib/text-table.js';
import { markRunWaitInterrupt } from '../lib/render-error.js';
import {
  cancelCommand,
  interruptDetachMessage,
  reattachSentence,
  runLabel,
  stillRunningAndBillingSubject,
  waitCommand,
  type RunRef,
} from '../lib/run-render.js';
import { waitForRun, resolveRunWaitFailure, type RunWaitOutcome } from '../lib/run-wait.js';
import { terminalWidth } from '../lib/ticker.js';
import {
  emitCiArtifacts,
  emitCiStepOutputs,
  reconcileExecutionReportMarkdown,
  type CiRunRow,
  type CiSummary,
  emitExecutionReportOutputs,
} from '../lib/gh-output.js';
import { terminalSafeLine, terminalSafeWriter } from '../lib/terminal-text.js';

/**
 * `details` debug block per the CLI OpenAPI `Test` schema
 * (M2.1 amendment). `processingStatus` / `testStatus` are the
 * structured pair; either may be `null` when the source row has no
 * analog (MCP rows have no separate processStatus). `rawStatus` is
 * the deprecated pre-M2.1 mirror, kept one minor for callers that
 * already parse it. All three are debug-only — automation depends on
 * the typed top-level `status` field.
 */
/**
 * A test case as `test list` / `test get` show it: the case's own fields and
 * nothing of its results, which `result list --test` reads. Fields a backend may
 * leave out stay optional; JSON output preserves the wire objects unchanged.
 */
export interface CliTest {
  id: string;
  projectId: string;
  /** Human-friendly project name; `null` when the lookup was not possible. */
  projectName?: string | null;
  /** The display id the Test Cases table shows (`CHECKOUT-004`); `null` on rows written before slugs. */
  slug?: string | null;
  title: string;
  description?: string | null;
  type: 'frontend' | 'backend';
  /** Assembled integration test (backend). Listed as `backend/int` so it is not mistaken for a plain test. */
  isIntegration?: boolean;
  category?: string | null;
  priority?: string | null;
  /** The active version: its hash, and the label the UI shows (`v1.0`). */
  version?: { hash: string; label: string | null };
  /** Frontend cases: how many steps the active version has; `get` lists them in `steps`. */
  stepCount?: number | null;
  steps?: CliPlanStep[] | null;
  /** Frontend-only timeout applied to every step; omitted when unset and on backend tests. */
  stepTimeoutMs?: number | null;
  /** Backend-only dependency declarations that drive wave ordering. */
  produces?: string[] | null;
  consumes?: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export type CliPublicStatus =
  | 'draft'
  | 'ready'
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'unknown';

export interface TestDeps {
  environmentCache?: Parameters<typeof resolveEnvironmentRunTarget>[0]['cache'];
  environmentTunnel?: EnvironmentTunnelContext;
  /** Report an exhausted poll deadline without changing the public output/error shape. */
  onWaitTimeout?: (context: WaitTimeoutTelemetry) => void;
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /**
   * Injectable sleep function for the polling loop. Defaults to the
   * `defaultSleep` in `poll.ts` (`setTimeout`-based). Inject an instant
   * no-op in tests to avoid real delays.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Graceful-detach coordinator for the `--wait` paths.
   * Defaults to the process-wide `globalShutdown`; tests inject their own
   * controller and abort it to simulate Ctrl-C deterministically (same
   * pattern as `sleep` / `fetchImpl`).
   */
  shutdown?: ShutdownHandle;
  /**
   * Tunnel-client factory for a run on a local environment. Defaults
   * to the vendored `TunnelClient`; tests inject a fake so the command's
   * contract can be exercised without a real control plane — same pattern as
   * `sleep` / `fetchImpl` / `shutdown`.
   */
  createTunnelClient?: (options: TunnelClientOptions) => TunnelClientHandle;
}

/** The effective shutdown handle for a command invocation. */
function shutdownOf(deps: TestDeps): ShutdownHandle {
  return deps.shutdown ?? globalShutdown;
}

/**
 * How a tunnel run's wait ended while the run was still non-terminal.
 * `tunnel-lost` is the one that is not a detach at all — it is the tunnel
 * dying under a run that is otherwise fine.
 */
export type TunnelDetachReason =
  'interrupt' | 'timeout' | 'request-timeout' | 'rate-limited' | 'tunnel-lost' | 'poll-error';

/** What happened when we tried to stop a doomed tunnel run. */
export type TunnelCancelOutcome = 'cancelled' | 'already-terminal' | 'failed' | 'skipped';

export interface TunnelDetach {
  /** The result id (wire name). */
  resultId?: string;
  /** The launch the result belongs to (wire name); absent on an older backend. */
  runId?: string;
  testId: string;
  automatic?: boolean;
  environment?: string;
  reason: TunnelDetachReason;
  /** The borrowed tunnel owner disappeared while this run was non-terminal. */
  ownerGone?: boolean;
  cancel: TunnelCancelOutcome;
  terminalStatus?: RunStatus;
}

const TUNNEL_INTERRUPT_OPT_OUT_CONSEQUENCE =
  'Passing --no-cancel-on-interrupt keeps the run going in the cloud, and it is still billed. ' +
  'The tunnel is closed, so steps that still need your machine will fail; the run can still ' +
  'pass if it no longer needs to load anything from your machine.';

function tunnelInterruptOptOutConsequence(
  detach: Pick<TunnelDetach, 'cancel' | 'testId'>,
  refs: readonly RunRef[],
): string {
  if (detach.cancel !== 'skipped') return TUNNEL_INTERRUPT_OPT_OUT_CONSEQUENCE;
  const wait = waitCommand(refs);
  return (
    `${TUNNEL_INTERRUPT_OPT_OUT_CONSEQUENCE} Check the verdict later with ` +
    `testsprite result list --test ${terminalSafeLine(String(detach.testId))}${wait ? ` or ${wait}` : ''}.`
  );
}

function tunnelRerunCommand(detach: TunnelDetach): string {
  return (
    `testsprite run ${terminalSafeLine(detach.testId)}` +
    (detach.environment ? ` --env ${quoteEnvironmentName(detach.environment)}` : '') +
    (detach.reason === 'timeout' ? ' --timeout 1800' : '')
  );
}

/** Tunnel-specific interrupt outcome consumed by the top-level JSON renderer. */
export interface TunnelInterruptDetach {
  /** The result id (wire name); the envelope prints it as `resultId`. */
  resultId: string;
  /** The launch (wire name); the envelope prints it as `runId` when known. */
  runId?: string;
  cancel: TunnelCancelOutcome;
  nextAction: string;
}

/**
 * The stderr line for a tunnel run whose wait is ending.
 *
 * Deliberately NOT built from `stillRunningAndBillingSubject`: that sentence
 * is true for an ordinary run and false here, and the whole point of D1 (a)
 * is that the four detach paths stop telling a tunnel user something untrue.
 */
export function tunnelDetachMessage(detach: TunnelDetach, interrupt?: InterruptError): string {
  const { reason, cancel } = detach;
  // The run is named by its launch, or as "result <id>" when the backend named
  // none; `run wait` / `run cancel` are offered only for a known launch.
  const subject = runLabel(detach);
  const subjectMidSentence = runLabel(detach, 'lower');
  const wait = waitCommand([detach]);
  const stop = cancelCommand([detach]);
  if (detach.ownerGone === true) {
    const cause = `The borrowed tunnel for ${subjectMidSentence} is no longer registered.`;
    const outcome: Record<TunnelCancelOutcome, string> = {
      cancelled:
        `${subject} was cancelled. For a frontend test cancelled before a terminal verdict ` +
        "the server attempts a refund; the result's `refund` says what happened.",
      'already-terminal': `${subject} had already finished, so there was nothing to cancel.`,
      failed:
        `${subject} could NOT be cancelled from here` + (stop ? ` — stop it with: ${stop}.` : '.'),
      skipped:
        `${subject} cancellation was skipped because --no-cancel-on-interrupt was passed. ` +
        'It may still be executing and billed.',
    };
    return (
      `${cause} ${outcome[cancel]}` + (wait ? `\n  Check the run before re-running: ${wait}.` : '')
    );
  }
  if (reason === 'interrupt' && cancel === 'cancelled') {
    return (
      `Interrupted${interrupt ? ` by ${interrupt.signal}` : ''}. ${subject} was reaching your ` +
      `machine through a tunnel that closes with this process, so it was cancelled (exit ` +
      `${interrupt?.exitCode ?? 130}). The run may already have been billed; a cancelled run's ` +
      `verdict is discarded. Start a new run with: ${tunnelRerunCommand(detach)}. ` +
      tunnelInterruptOptOutConsequence(detach, [detach])
    );
  }
  const cause: Record<TunnelDetachReason, string> = {
    interrupt: `Interrupted${interrupt ? ` by ${interrupt.signal}` : ''}`,
    timeout: `Timed out waiting for ${subjectMidSentence}`,
    'request-timeout': 'Request timed out',
    'rate-limited': 'Rate limited by the server (HTTP 429)',
    'tunnel-lost': 'The tunnel was disconnected by the tunnel service',
    'poll-error': 'Polling stopped because the run status could not be read',
  };
  const doom =
    reason === 'tunnel-lost'
      ? `${subject} was reaching your machine through that tunnel, and the run's proxy credential ` +
        `names the client that just went away, so it cannot be restored for this run.`
      : `${subject} was reaching your machine through a tunnel that closes with this process.`;
  const outcome: Record<TunnelCancelOutcome, string> = {
    cancelled:
      "  Cancelled it. The run may already have been billed; a cancelled run's verdict is discarded.",
    'already-terminal': '  It had already finished server-side; there was nothing to cancel.',
    failed: '  Could NOT cancel it from here' + (stop ? ` — stop it with: ${stop}` : ''),
    skipped: '  It was not cancelled' + (stop ? ` — stop it now with: ${stop}` : ''),
  };
  const message =
    `${cause[reason]}. ${doom}\n` +
    `${outcome[cancel]}\n` +
    `  Start a new run with: ${tunnelRerunCommand(detach)}.`;
  return cancel === 'cancelled' || cancel === 'skipped'
    ? `${message}\n  ${tunnelInterruptOptOutConsequence(detach, [detach])}`
    : message;
}

/**
 * The stderr pointer after a failed or blocked result: where to read the
 * failure, and for a frontend test where to download its evidence.
 */
function failureHint(status: string, wireResultId: string, isBackend: boolean): string {
  const resultId = terminalSafeLine(wireResultId);
  return (
    `Result ${resultId} finished with status: ${terminalSafeLine(status)}. Use 'testsprite result get ${resultId}' to read the failure` +
    (isBackend ? '.' : ', or add --out <dir> to download its evidence.')
  );
}

export function tunnelInterruptNextAction(detach: TunnelDetach, err: InterruptError): string {
  const rerun = tunnelRerunCommand(detach);
  const subject = runLabel(detach);
  const stop = cancelCommand([detach]);
  const stopping = `after stopping ${runLabel(detach, 'lower')}${stop ? ` with: ${stop}` : ''}`;
  if (detach.cancel === 'cancelled') {
    return (
      `${subject} was cancelled after ${err.signal} (exit ${err.exitCode}) and its ` +
      `tunnel was closed. ` +
      "The run may already have been billed; a cancelled run's verdict is discarded. " +
      `Start a new run with: ${rerun}. ${tunnelInterruptOptOutConsequence(detach, [detach])}`
    );
  }
  if (detach.cancel === 'already-terminal') {
    return (
      `${subject} had already finished` +
      (detach.terminalStatus ? ` with status ${detach.terminalStatus}` : '') +
      ` when ${err.signal} interrupted the wait; its tunnel was closed. Start a new run with: ` +
      `${rerun}.`
    );
  }
  if (detach.cancel === 'skipped') {
    return (
      `Start a new run with: ${rerun}, ${stopping}. ` +
      tunnelInterruptOptOutConsequence(detach, [detach])
    );
  }
  return (
    `Start a new run with: ${rerun}, ${stopping}; ` +
    `automatic cancellation after ${err.signal} failed.`
  );
}

type CommonOptions = FactoryCommonOptions;

interface ListOptions extends CommonOptions {
  projectId?: string;
  type?: 'frontend' | 'backend';
  pageSize?: number;
  startingToken?: string;
  maxItems?: number;
  columns?: string;
  noHeader?: boolean;
}

const TEST_TYPES: ReadonlyArray<'frontend' | 'backend'> = ['frontend', 'backend'];

export async function runList(opts: ListOptions, deps: TestDeps = {}): Promise<Page<CliTest>> {
  // The CLI error spec (§2) puts bad input (exit 5) ahead of authentication
  // (exit 3), and the filter validation below keeps that order. `--project` is
  // the one deliberate exception: with no credentials at all, being sent to
  // `testsprite setup` beats being told about a flag you cannot use yet, so the
  // required project is checked only after the client is built. With a key
  // configured, a missing `--project` still exits 5 as before.
  const projectId = resolveProjectId(opts.projectId, deps);

  const paginationFlags: PaginationFlags = validatePaginationFlags({
    pageSize: opts.pageSize,
    startingToken: opts.startingToken,
    maxItems: opts.maxItems,
  });

  const out = makeOutput(opts.output, deps);
  if (opts.output === 'text') {
    resolveTextColumns(opts.columns, TEST_LIST_COLUMNS);
  }
  const client = makeClient(opts, deps);
  requireProjectId(projectId);
  // Match P2's "explicit pageSize ⇒ single-page" convention so an
  // operator can grab one slice + cursor without auto-paging through a
  // huge project.
  const useSinglePage = opts.pageSize !== undefined && opts.maxItems === undefined;

  const baseQuery: Record<string, string | number | boolean | undefined> = {
    projectId,
    type: opts.type,
  };

  const page: Page<CliTest> = useSinglePage
    ? await fetchSinglePage<CliTest>(
        client,
        '/tests',
        paginationFlags.pageSize!,
        opts.startingToken,
        baseQuery,
      )
    : await paginate<CliTest>(
        async ({ pageSize, cursor }) =>
          client.get<Page<CliTest>>('/tests', {
            query: { ...baseQuery, pageSize, cursor },
          }),
        paginationFlags,
      );

  out.print(page, data =>
    renderTestListText(data as Page<CliTest>, {
      columns: opts.columns,
      noHeader: opts.noHeader,
    }),
  );
  // An EMPTY project — nothing narrowed the page, no further page —
  // is where a new user without a coding agent stalls. One stderr hint, text
  // mode only, so stdout stays exactly "No tests." for pipes.
  if (
    opts.output !== 'json' &&
    page.items.length === 0 &&
    !page.nextToken &&
    opts.startingToken === undefined &&
    opts.type === undefined
  ) {
    const stderrFn = terminalSafeWriter(deps.stderr);
    stderrFn(emptyProjectHint(projectId));
  }
  return page;
}

/**
 * §6.X / M3.2 piece-5 — plan-step structure. `description` is the
 * natural-language instruction the browser-use Lambda interprets at
 * run time. `type` is the action/assertion binary the FE pipeline
 * uses to decide whether a step is mutating UI or verifying state.
 */
export interface CliPlanStep {
  type: 'action' | 'assertion';
  description: string;
  /**
   * Read-only view fields: structured steps carry the engine-level action
   * the Portal recorded. Optional because older backends omit them; they are
   * never part of a request body.
   */
  action?: string;
  selector?: string;
  inputValue?: string;
  structured?: boolean;
}

/**
 * Append `suffix` to an idempotency key within 256 chars. A base that does not
 * fit is cut and tagged with a digest of the whole key, so two long keys that
 * differ only in their tail still get different request keys.
 */
function suffixedIdempotencyKey(base: string, suffix: string): string {
  const room = 256 - suffix.length;
  if (base.length <= room) return `${base}${suffix}`;
  const digest = createHash('sha256').update(base).digest('hex').slice(0, 16);
  return `${base.slice(0, room - digest.length - 1)}~${digest}${suffix}`;
}

/**
 * Resolve the owning project of every id with an authoritative `GET /tests/<id>`
 * (a handful in flight at a time). An unknown id fails the whole call with its
 * own NOT_FOUND before anything is dispatched, so an ID in a later project cannot
 * be discovered after an earlier project already ran.
 */
async function resolveTestProjects(
  client: HttpClient,
  ids: readonly string[],
  known: Map<string, Pick<CliTest, 'type' | 'projectId'>>,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const pending: string[] = [];
  for (const id of ids) {
    const projectId = known?.get(id)?.projectId;
    if (projectId) resolved.set(id, projectId);
    else pending.push(id);
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const id = pending[next++];
      if (id === undefined) return;
      const test = await client.get<CliTest>(`/tests/${encodeURIComponent(id)}`);
      if (!test.projectId) {
        throw localValidationError('test-id', `could not determine the project of test ${id}`);
      }
      known.set(id, test);
      resolved.set(id, test.projectId);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, worker));
  return resolved;
}

/** Default server dispatch limit per project execution without a tunnel. */
export const DEFAULT_BATCH_RUN_CONCURRENCY = 50;
/** Hard upper bound for the server execution cap. */
export const MAX_BATCH_CONCURRENCY = 100;
/**
 * Sleep that a termination signal cuts short by rejecting with the signal's
 * `InterruptError`, so the caller's existing catch owns the detach UX.
 *
 * Mirrors `HttpClient.sleepBeforeRetry` — an in-flight backoff must not be a
 * window where a first Ctrl-C waits for a timer before the command exits.
 */
export function sleepUntilOrInterrupt(
  ms: number,
  signal: AbortSignal | undefined,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<void> {
  if (signal === undefined) return sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    sleep(ms, signal).then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      err => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export function resolveRateLimitRetryMs(err: ApiError): number {
  if (err.retryAfterMs !== undefined) return err.retryAfterMs;
  const retryAfterSec = err.getDetail<number>(
    'retryAfterSeconds',
    (v): v is number => typeof v === 'number' && v > 0,
  );
  return Math.min((retryAfterSec ?? 60) * 1000, 120_000);
}

/**
 * Returns `true` when a `RATE_LIMITED` error is the **transient per-minute**
 * rate limit from `RunRateLimiterGuard` — the one worth retrying.
 *
 * The backend surfaces two distinct situations as `RATE_LIMITED` (429):
 *
 *   1. **Per-minute trigger cap** (RunRateLimiterGuard):
 *      message = `"Run trigger rate limit exceeded: N triggers per minute per key."`
 *      Has `Retry-After` header + `details.retryAfterSeconds`.
 *      → TRANSIENT — safe to retry once the window expires.
 *
 *   2. **Insufficient credits** (InsufficientCreditsException):
 *      message starts with `"Insufficient credits: N credit(s) required."`
 *      No `Retry-After` header, no `details.retryAfterSeconds`.
 *      → PERMANENT — retrying cannot succeed; only a top-up will fix it.
 *
 * We prefer a structural match (presence of `retryAfterMs` on the thrown
 * `ApiError`, which is set only when the HTTP response carried a `Retry-After`
 * header) as the primary discriminator, with the per-minute message wording as
 * a secondary guard. If both fields are absent we treat the error as permanent
 * to avoid silently burning the entire retry budget on a non-recoverable state.
 *
 * A 429 whose `details.reason` names a standing condition (see
 * `STANDING_RATE_LIMIT_REASONS` in `lib/http.ts` — e.g. the live
 * tunnel-binding cap) is also permanent, even though it now carries a real
 * `Retry-After`: that header says when a retry COULD first succeed if the
 * caller frees the resource, not that the condition clears on its own.
 *
 * Limitation: a hypothetical future backend that emits `RATE_LIMITED` for a
 * new reason without a `Retry-After` header AND without the per-minute
 * wording would be classified as permanent here. Document this if it occurs.
 */
export function isTransientRateLimit(err: ApiError): boolean {
  // Fix 4 (hardening): insufficient-credits is ALWAYS permanent, regardless of
  // any Retry-After header the response may carry. Check this SHORT-CIRCUIT first
  // so a credits-429 with a stray Retry-After header is never retried.
  if (/insufficient credits/i.test(err.message)) return false;

  // Standing-condition 429s are permanent regardless of Retry-After too.
  if (isStandingRateLimit(err)) return false;

  // Primary transient signal: Retry-After header was present and parsed (set on
  // the error by HttpClient when retryOnRateLimit: false is used and the HTTP
  // layer throws after a single 429).
  if (err.retryAfterMs !== undefined) return true;
  // Secondary: the per-minute rate-limit message wording.
  if (/run trigger rate limit exceeded/i.test(err.message)) return true;
  // Details presence (retryAfterSeconds in body) also indicates the throttle path.
  const retryAfterSec = err.getDetail<number>(
    'retryAfterSeconds',
    (v): v is number => typeof v === 'number' && v > 0,
  );
  if (retryAfterSec !== undefined) return true;
  // Absent all signals → treat as permanent (credit depletion or unknown).
  return false;
}

interface GetOptions extends CommonOptions {
  testId: string;
}

export async function runGet(opts: GetOptions, deps: TestDeps = {}): Promise<CliTest> {
  const out = makeOutput(opts.output, deps);
  const client = makeClient(opts, deps);

  const test = await client.get<CliTest>(`/tests/${encodeURIComponent(opts.testId)}`);
  out.print(test, data => renderTestText(data as CliTest));
  return test;
}

// ---------------------------------------------------------------------------
// M3.3 piece-3 — `run` / `run wait`
// ---------------------------------------------------------------------------

/**
 * Default timeout in seconds for `--wait`. Range 1..3600.
 */
const DEFAULT_RUN_TIMEOUT_SECONDS = 600;
const DEFAULT_LOCAL_RUN_TIMEOUT_SECONDS = 1200;
const MAX_RUN_TIMEOUT_SECONDS = 3600;

interface RunTestRunOptions extends CommonOptions {
  knownTest?: RunTargetTest;
  noWait?: boolean;
  testId: string;
  /** BE only: run just the named test without expanding the producer/teardown closure. */
  skipDependencies?: boolean;
  /** Skip a local environment's port check before its tunnel opens (zero network calls). */
  skipPreflight?: boolean;
  wait: boolean;
  timeoutSeconds: number;
  /**
   * B2(c): true when --timeout was not explicitly set by the user (the default
   * is in effect). Used to decide whether to emit the first-run hint.
   * Defaults to false (no hint) when not set; only the `run` command
   * wiring sets this to `cmdOpts.timeout === undefined`.
   */
  timeoutIsDefault?: boolean;
  idempotencyKey?: string;
  /**
   * --gh-output: force the GitHub-native output layer (::error:: annotations +
   * job-summary table) even off-Actions. On the single-test `--wait` path the
   * result is reduced to a one-row CI summary (`summarizeSingleRun`).
   */
  ghOutput?: boolean;
  /** --summary-file: also write the reduced machine summary JSON to this path. */
  summaryFile?: string;
  /**
   * `--tunnel-client <id>` — attach to a tunnel someone else already started
   * (`testsprite tunnel start`) instead of minting one. The client id is a
   * non-secret handle; the secret never leaves the process that minted it,
   * and this run neither owns nor deletes that binding.
   */
  tunnelClientId?: string;
  /**
   * `--cancel-on-interrupt` / `--no-cancel-on-interrupt`. Default ON, and
   * scoped to tunnel runs only. A tunnel run whose tunnel is closing is
   * already doomed, so cancelling stops the billing instead of paying for a
   * guaranteed failure — which is exactly why this was correctly shelved for
   * ordinary runs, where detaching leaves a run that can still pass.
   */
  cancelOnInterrupt?: boolean;
  /**
   * `--env <name>` — the project environment this run uses: its address,
   * credentials, auto-auth and OTP settings. Absent → the project's default
   * environment. Feature-gated per workspace: checked client-side before
   * anything is minted or billed.
   */
  environment?: string;
}

/**
 * Validate `--env <name>`. The name is passed to the server
 * verbatim (it resolves `unique(project_id, name)` and lists the valid names
 * on a miss); the only local rule is that an empty/whitespace value is a typo,
 * not a request for the default environment — omitting the flag is.
 */
function normalizeEnvironmentName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const name = raw.trim();
  if (name.length === 0) {
    throw localValidationError(
      'env',
      'must be a non-empty environment name (list them with: testsprite project env list <project-id>); omit --env to use the default environment',
    );
  }
  return name;
}

/** Reject an explicitly empty name filter; omission alone selects every test. */
export function parseNameFilter(raw: string | undefined): string | undefined {
  if (raw === '') {
    throw localValidationError(
      'filter',
      'must not be empty; omit --filter to run every project test, or pass a non-empty substring',
    );
  }
  return raw;
}

/**
 * Validate the `--timeout` flag value. Returns a clamped integer in
 * range [1, 3600], or the default when absent.
 */
function parseTimeoutFlag(raw: string | undefined, flagName: string): number {
  if (raw === undefined) return DEFAULT_RUN_TIMEOUT_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw localValidationError(
      flagName,
      `must be an integer between 1 and ${MAX_RUN_TIMEOUT_SECONDS}`,
    );
  }
  if (n > MAX_RUN_TIMEOUT_SECONDS) {
    throw localValidationError(flagName, `must be at most ${MAX_RUN_TIMEOUT_SECONDS} seconds`);
  }
  return n;
}

/** Pre-dispatch: refuse unwritable --report-file / --summary-file before anything is triggered. */
function assertRunArtifactPaths(opts: {
  report?: JUnitReportFormat;
  reportFile?: string;
  summaryFile?: string;
}): void {
  if (opts.report === 'junit' && opts.reportFile !== undefined)
    assertArtifactPath('report-file', opts.reportFile);
  if (opts.summaryFile !== undefined) assertArtifactPath('summary-file', opts.summaryFile);
}

/**
 * The environment half of the 409 auto-resume gate, shared by the single run
 * and the whole-project batch: may the in-flight run stand in for the run this
 * invocation asked for? Resolves to the `--env` flag naming the verified
 * environment for a later retry, or throws `incompatibleRun(reason)`.
 *
 * A run read always carries the `environment` key. `null` means the row
 * names no environment, OR its environment lookup failed and was swallowed
 * server-side, and a missing key means a backend that cannot report one —
 * none of them can be verified, so none may attach: letting them through
 * would let a failed lookup slip past the gate it exists to enforce.
 */
async function verifyInFlightRunEnvironment(
  inFlightRun: RunResponse,
  environment: string | undefined,
  listEnvironments: (projectId: string) => Promise<CliProjectEnvListResponse>,
  incompatibleRun: (reason: string) => ApiError,
): Promise<string> {
  const inFlightEnvironment = inFlightRun.environment;
  if (
    inFlightEnvironment === undefined ||
    inFlightEnvironment === null ||
    typeof inFlightEnvironment.id !== 'string' ||
    inFlightEnvironment.id.length === 0
  ) {
    throw incompatibleRun('its environment could not be verified');
  }
  const listing = await listEnvironments(inFlightRun.projectId);
  const currentEnvironment = listing.environments.find(row =>
    environment === undefined ? row.isDefault : row.name === environment,
  );
  if (typeof currentEnvironment?.id !== 'string' || currentEnvironment.id.length === 0) {
    // The listing succeeded but named nothing we can compare against — that
    // is unverified, not a proven mismatch.
    throw incompatibleRun('its environment could not be verified');
  }
  if (currentEnvironment.id !== inFlightEnvironment.id) {
    throw incompatibleRun('its environment does not match the requested environment');
  }
  return `--env ${quoteEnvironmentName(currentEnvironment.name)}`;
}

export async function runTestRun(
  opts: RunTestRunOptions,
  deps: TestDeps = {},
): Promise<ProjectLaunchOutput> {
  return runTestRunAll(
    {
      ...opts,
      testIds: [opts.testId],
      maxConcurrency: 5,
      single: true,
      knownTests: opts.knownTest ? new Map([[opts.testId, opts.knownTest]]) : undefined,
    },
    deps,
  );
}

// ---------------------------------------------------------------------------
// `run wait <run-id...>` / `run cancel <run-id...>`: a run id names a launch,
// and both commands act on every test in it
// ---------------------------------------------------------------------------

export interface RunTestWaitOptions extends CommonOptions {
  /** The runs to wait for, as `run` prints them. */
  runIds: string[];
  timeoutSeconds: number;
}

/** Wait for each execution to finish, including results created after its unit phase. */
export async function runTestWait(opts: RunTestWaitOptions, deps: TestDeps = {}) {
  const out = makeOutput(opts.output, deps);
  const stderr = terminalSafeWriter(deps.stderr);
  const runIds = [...new Set(opts.runIds)];
  if (opts.dryRun) {
    emitDryRunBanner(stderr);
    const requests = runIds.map(runId => ({ method: 'GET' as const, path: runListingPath(runId) }));
    const preview = previewRun(requests, true);
    out.print(preview, () =>
      requests.map(request => `${request.method} ${request.path}`).join('\n'),
    );
    return { ...preview, summary: preview.summary! };
  }
  const client = makeClient(
    { ...opts, requestTimeoutMs: resolveWaitRequestTimeoutMs({ ...opts, wait: true }) },
    deps,
  );
  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  const shutdown = shutdownOf(deps);
  const outcomes = new Map<string, RunWaitOutcome>();
  const snapshots = new Map<string, RunWaitOutcome>();
  const stop = new AbortController();
  let fatal: unknown;
  const disarm = shutdown.arm();
  try {
    await Promise.all(
      runIds.map(async runId => {
        if (stop.signal.aborted) return;
        try {
          const outcome = await waitForRun(client, runId, {
            deadline,
            shutdown,
            signal: stop.signal,
            sleep: deps.sleep,
            onRead: snapshot => {
              snapshots.set(runId, { runId, ...snapshot, missingResultIds: [], timedOut: false });
            },
          });
          outcomes.set(runId, outcome);
          if (outcome.timedOut) deps.onWaitTimeout?.({ reason: 'wait_timeout' });
        } catch (err) {
          if (err instanceof ApiError) {
            outcomes.set(runId, {
              runId,
              run: null,
              results: [],
              missingResultIds: [],
              timedOut: false,
              error: err,
            });
          } else if (fatal === undefined || err instanceof InterruptError) {
            fatal = err;
            if (!(err instanceof RequestTimeoutError)) stop.abort(err);
          }
        }
      }),
    );
  } finally {
    disarm();
  }
  const current = runIds.map(
    runId =>
      outcomes.get(runId) ??
      snapshots.get(runId) ?? {
        runId,
        run: null,
        results: [],
        missingResultIds: [],
        timedOut: false,
      },
  );
  const { output, summary, unfinishedRuns } = buildRunOutput({
    receipts: runIds.map(runId => ({ runId })),
    outcomes: new Map(current.map(outcome => [outcome.runId, outcome])),
    wait: true,
    failure: fatal,
  });
  out.print(output, () => renderRunResults(output.runs, output.results, summary));
  if (!(fatal instanceof InterruptError)) {
    const unknown = [...outcomes.values()].find(value => value.error?.code === 'NOT_FOUND');
    if (unknown?.error) throw unknown.error;
  }
  if (fatal instanceof RequestTimeoutError) {
    fatal = resolveRunWaitFailure(current, { timeoutSeconds: opts.timeoutSeconds }, fatal);
  }
  if (fatal !== undefined) {
    if (fatal instanceof InterruptError && unfinishedRuns.length)
      markRunWaitInterrupt(fatal, unfinishedRuns);
    if (unfinishedRuns.length)
      stderr(
        fatal instanceof InterruptError
          ? interruptDetachMessage(fatal, unfinishedRuns)
          : stillRunningAndBillingSubject(unfinishedRuns) + reattachSentence(unfinishedRuns),
      );
    throw fatal;
  }
  for (const row of output.results) {
    if (row.resultId && (row.status === 'failed' || row.status === 'blocked'))
      stderr(failureHint(row.status, row.resultId, false));
  }
  const failure = resolveRunWaitFailure(current, { timeoutSeconds: opts.timeoutSeconds });
  if (failure !== null) throw failure;
  return { ...output, summary: runCounts(summary) };
}

export interface RunTestCancelOptions extends CommonOptions {
  /** The runs to cancel, as `run` prints them. */
  runIds: string[];
}

/** Execution ID lists and errors; each run response carries its result outcomes. */
export interface CliCancelSummary {
  cancelled: string[];
  alreadyCancelled: string[];
  /** Executions that had finished before cancellation. */
  alreadyFinished: string[];
  notFound: string[];
  /**
   * Results whose cancel failed for a reason other than 404/409 (e.g. auth,
   * transport). Always present — an empty array on full success — so machine
   * consumers can rely on a stable shape.
   */
  errors: Array<{ runId: string; message: string }>;
}

/**
 * Track the error a cancel exits with after its summary: one that fails EVERY
 * request the same way — a rejected credential (exit 3) or a CLI too old for
 * the backend (exit 14) — rather than folding it into the generic per-result
 * failure (1). Auth outranks CLIENT_TOO_OLD, as in lib/wait-exit.ts; the first
 * error of each kind is kept.
 */
function keepBatchWideError(current: ApiError | undefined, err: unknown): ApiError | undefined {
  if (!(err instanceof ApiError)) return current;
  const currentIsAuth = current !== undefined && isAuthCode(current.code);
  if (isAuthCode(err.code)) return currentIsAuth ? current : err;
  if (err.code === 'CLIENT_TOO_OLD') return current ?? err;
  return current;
}

/** Cancel each execution once; the server owns membership, refunds and terminal races. */
export async function runTestCancel(
  opts: RunTestCancelOptions,
  deps: TestDeps = {},
): Promise<CliCancelSummary & { runs: CancelRunResponse[] }> {
  const stderr = terminalSafeWriter(deps.stderr);
  const out = makeOutput(opts.output, deps);
  const client = makeClient(opts, deps);
  if (opts.dryRun) emitDryRunBanner(stderr);
  const runIds = [...new Set(opts.runIds)];
  const runs: CancelRunResponse[] = [];
  const summary: CliCancelSummary = {
    cancelled: [],
    alreadyCancelled: [],
    alreadyFinished: [],
    notFound: [],
    errors: [],
  };
  const failures: ApiError[] = [];
  const shutdown = shutdownOf(deps);
  let current: string | undefined;
  const disarm = shutdown.arm();
  const print = (interrupted = false): void => {
    const attempted = new Set([
      ...runs.map(run => run.runId),
      ...summary.notFound,
      ...summary.errors.map(row => row.runId),
    ]);
    out.print(
      {
        runs,
        ...summary,
        ...(interrupted
          ? {
              interrupted: current,
              notAttempted: runIds.filter(id => !attempted.has(id) && id !== current),
            }
          : {}),
      },
      () =>
        [
          ...runs.flatMap(run => [
            `Run ${terminalSafeLine(run.runId)} — ${run.alreadyFinished ? 'already finished' : run.alreadyCancelled ? 'already cancelled' : 'cancelled'}`,
            ...run.results.map(
              result =>
                `  ${terminalSafeLine(result.resultId)}  ${terminalSafeLine(result.status)}` +
                (result.refund ? `  refund: ${terminalSafeLine(refundText(result.refund))}` : ''),
            ),
          ]),
          ...summary.notFound.map(id => `Run ${terminalSafeLine(id)} — not found`),
          ...summary.errors.map(
            row => `Run ${terminalSafeLine(row.runId)} — ${terminalSafeLine(row.message)}`,
          ),
        ].join('\n'),
    );
  };
  try {
    for (const runId of runIds) {
      current = undefined;
      if (shutdown.signal.aborted) throw shutdown.signal.reason;
      current = runId;
      try {
        const response = await client.cancelRun(runId);
        runs.push(response);
        if (response.alreadyFinished) summary.alreadyFinished.push(runId);
        else if (response.alreadyCancelled) summary.alreadyCancelled.push(runId);
        else summary.cancelled.push(runId);
      } catch (err) {
        if (err instanceof InterruptError) throw err;
        if (err instanceof ApiError) failures.push(err);
        if (err instanceof ApiError && err.code === 'NOT_FOUND') summary.notFound.push(runId);
        else
          summary.errors.push({ runId, message: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    if (err instanceof InterruptError) {
      print(true);
      stderr(
        `Interrupted (${err.signal}); retry unfinished runs with testsprite run cancel ${runIds
          .filter(id => !runs.some(run => run.runId === id))
          .map(terminalSafeLine)
          .join(' ')}.`,
      );
    }
    throw err;
  } finally {
    disarm();
  }
  print();
  const batchWide = failures.reduce<ApiError | undefined>(keepBatchWideError, undefined);
  if (batchWide) throw batchWide;
  const missing = failures.find(error => error.code === 'NOT_FOUND');
  if (missing) throw missing;
  if (failures[0]) throw failures[0];
  if (summary.errors.length > 0)
    throw new CLIError(`Could not cancel ${summary.errors.length} run(s).`, 1);
  return { ...summary, runs };
}

/** What happened to a cancelled result's charge, as one phrase. */
function refundText(refund: NonNullable<CancelRunRefund>): string {
  switch (refund.status) {
    case 'refunded':
      return refund.amount === undefined
        ? 'credits returned'
        : `credits returned: ${refund.amount}`;
    case 'not_charged':
      return 'never charged; nothing to return';
    case 'failed':
      return 'failed — retry testsprite run cancel with the same run ID to retry the refund';
    default:
      return String(refund.status);
  }
}

export function createTestCancelCommand(deps: TestDeps): Command {
  const cancel = new Command('cancel');
  cancel
    .argument('<run-id...>', 'one or more execution IDs (the runId `run` prints)')
    .summary(
      'Cancel every queued/running test in one or more runs (the server reports per-result cancellation and refund outcomes)',
    )
    .description(
      'Cancel one or more whole executions, including queued work and later integration phases.\n' +
        '\nA run id is the runId `run` prints, not an individual resultId.\n' +
        'The CLI sends one cancellation request per execution, without listing results first.\n' +
        'The server owns membership and terminal races; already-finished or already-cancelled\n' +
        'executions return their current state. Each response includes native result IDs\n' +
        'and refund outcomes. A failed refund can be retried with the same run ID.\n' +
        '\nCtrl-C during an ordinary --wait only detaches; use this command to stop the run.\n' +
        'Owned-tunnel runs are cancelled on interrupt by default; see `run --help`.\n' +
        '\nExit codes:\n' +
        '  0  executions cancelled, already cancelled or already finished\n' +
        '  1  a local cancellation failure\n' +
        '  3  authentication or permission failure\n' +
        '  4  an execution ID was not found (other requested cancellations may have succeeded)\n' +
        ' 10  server or transport unavailable\n' +
        ' 11  rate limited after automatic retries\n' +
        ' 14  client too old\n' +
        'Other server errors retain their original exit classification.\n' +
        '\nOutput: {runs, cancelled, alreadyCancelled, alreadyFinished, notFound, errors}.\n' +
        'Each run includes result outcomes; notFound and errors identify executions.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (runIds: string[], _cmdOpts: unknown, command: Command) => {
      await runTestCancel(
        {
          ...resolveCommonOptions(command, deps.env),
          runIds,
        },
        deps,
      );
    });
  return cancel;
}

// ---------------------------------------------------------------------------
// M4 piece-2 — `run --project <id>` (fresh wave-ordered batch run)
// ---------------------------------------------------------------------------

export interface RunTestRunAllOptions extends CommonOptions {
  environmentResolutionComplete?: boolean;
  cancelOnInterrupt?: boolean;
  timeoutIsDefault?: boolean;
  noWait?: boolean;
  concurrencyIsDefault?: boolean;
  /** projectId to run all tests in; may be resolved from --project or TESTSPRITE_PROJECT_ID. */
  projectId?: string;
  /** --filter <substr>: only run tests whose name contains this substring (case-insensitive). */
  nameFilter?: string;
  /** --wait: block until terminal or --timeout. */
  wait: boolean;
  /** Polling / overall deadline in seconds. Default 600, max 3600. */
  timeoutSeconds: number;
  /** --max-concurrency: server dispatch limit per project execution. */
  maxConcurrency: number;
  /** Internal CI policy. The public `ci run` entry point always enables wait. */
  ci?: {
    failOnSkipped?: boolean;
    /** How long `ci run` waits for the execution report before falling back to the local table. */
    executionReportTimeoutSeconds?: number;
    /** `--no-execution-report`: never read the report; the job summary is the local table. */
    executionReport?: boolean;
  };
  /** Caller-supplied idempotency token; auto-minted if absent. */
  idempotencyKey?: string;
  /** --report junit: write a JUnit XML sidecar after batch --wait completes. */
  report?: JUnitReportFormat;
  /** --report-file: destination path for the JUnit XML artifact. */
  reportFile?: string;
  /** --report-suite-name: optional override for the JUnit <testsuite name=...>. */
  reportSuiteName?: string;
  /** --gh-output: force the GitHub-native output layer even off-Actions (issue #99). */
  ghOutput?: boolean;
  /** --summary-file: also write the reduced machine summary JSON to this path. */
  summaryFile?: string;
  /**
   * --allow-empty: exit 0 (instead of failing) when the batch dispatches ZERO
   * tests (all skipped / empty project / --filter matched nothing). Default off:
   * a zero-dispatch project run is a CI false-green, so it fails with exit 5 by
   * default and still emits the summary / annotation / JUnit report.
   */
  allowEmpty?: boolean;
  /** `--env <name>`: see `RunTestRunOptions.environment` — applied to every test in the batch. */
  environment?: string;
  /** Per-run URL override for every frontend test in the batch. */
  targetUrl?: string;
  /**
   * `ci run`: `'all'` asks the server to seed every selected case into one
   * execution and pace dispatch itself, so a CI run is one execution (and,
   * with `previewName`, one environment row) instead of a first batch plus a
   * client-side retry. A backend that read the field echoes it; a missing
   * echo is refused the way an unconfirmed `targetUrl` is.
   */
  admission?: 'all';
  /** `ci run` in a pull request: run in a temporary clone of `environment` at `targetUrl`. */
  previewName?: string;
  /** `ci run` in GitHub Actions: where the run came from, for the Portal's PR link. */
  githubTrigger?: CiGithubTrigger;
  /** Skip the pre-charge target URL reachability probe. */
  skipPreflight?: boolean;
  /** See `RunTestRunOptions.skipDependencies`; sent on every dispatch leg. */
  skipDependencies?: boolean;
  /**
   * Run exactly these tests (`run <id> <id> ...`) instead of a whole project.
   * Each id's project is read first and the ids are dispatched per project.
   */
  testIds?: string[];
  /** Tests whose type/project the caller already read, so the resolver does not read them again. */
  knownTests?: ReadonlyMap<string, Pick<CliTest, 'type' | 'projectId'>>;
  /**
   * Set by the explicit-ids resolver: each test's own project, for dashboard
   * links and the JUnit classname of a batch that spans several projects.
   */
  projectIdByTestId?: ReadonlyMap<string, string>;
}

export async function writeBatchJUnitReportIfRequested(
  opts: {
    report?: JUnitReportFormat;
    reportFile?: string;
    reportSuiteName?: string;
    projectId?: string;
    projectIdByTestId?: ReadonlyMap<string, string>;
  },
  results: readonly (JUnitTestResult & {
    createdAt?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
    testTitle?: string | null;
  })[],
  nameByTestId?: ReadonlyMap<string, string>,
): Promise<void> {
  if (opts.report !== 'junit' || opts.reportFile === undefined) return;
  const projectId = resolveBatchReportProjectId(opts, results);
  const suiteName = opts.reportSuiteName ?? `testsprite:${projectId}`;
  // Enrich each row with the human name (from the map) and the run duration
  // (from poll timing) — the two fields whose absence made the report unreadable.
  // Name precedence: the sweep map wins (it's a full page scan), then the poll
  // response's own `testTitle` (same source the summary table uses — this keeps
  // the two surfaces on the same name when the sweep over-pages / times out),
  // then the row's fallback name. `.trim() ||` so a blank title never shadows it.
  const enriched: JUnitTestResult[] = results.map(r => ({
    ...r,
    name: nameByTestId?.get(r.testId) ?? (r.testTitle?.trim() ? r.testTitle : undefined) ?? r.name,
    classname: r.classname ?? opts.projectIdByTestId?.get(r.testId),
    durationSeconds:
      r.durationSeconds ?? durationSecondsBetween(r.startedAt, r.finishedAt, r.createdAt),
  }));
  const xml = buildJUnitReport({
    suiteName,
    classname: projectId,
    results: enriched,
  });
  await writeJUnitReportFile(opts.reportFile, xml);
}

/** The server's execution report plus its rendered Markdown, once `ready`. */
interface ExecutionReportReady {
  report: ExecutionReport;
  markdown: string;
}

const EXECUTION_REPORT_DEFAULT_TIMEOUT_SECONDS = 60;
const EXECUTION_REPORT_DEFAULT_RETRY_SECONDS = 5;

/**
 * Fetch the execution report — the content the GitHub App posts as its PR
 * comment — for the one execution this CI batch dispatched into.
 *
 * Best-effort by contract: the local results table is the fallback, so an
 * older backend (404), a report that is not ready within the budget, a
 * report for some other execution, or any other failure returns `undefined`
 * with one stderr line. An interrupt while waiting (the request or the retry
 * sleep — the scope is armed across both, so a first signal is a graceful
 * stop, not an immediate exit) also falls back, and is handed back in
 * `interrupted`: the batch is already finished, so its summary and outputs are
 * written first, then the caller rethrows it so the exit is the signal's
 * code. Reads nothing when `--no-execution-report`
 * was passed, when a run timed out (the execution is not terminal, so the
 * report could only arrive late), or unless EVERY accepted row names the same
 * execution (an older backend omits the id; a batch spanning several
 * executions gets one report per execution as a follow-up — a report for one
 * of them would read as the whole batch's).
 */
async function fetchExecutionReport(
  client: HttpClient,
  accepted: readonly RunRef[],
  results: readonly { status: string }[],
  opts: RunTestRunAllOptions,
  deps: TestDeps,
  stderrFn: (line: string) => void,
): Promise<{ ready?: ExecutionReportReady; interrupted?: InterruptError }> {
  if (opts.ci?.executionReport === false) return {};
  const ids = launchIds(accepted);
  const runId = ids.length === 1 ? ids[0] : undefined;
  if (runId === undefined) return {};
  if (results.some(r => r.status === 'timeout')) {
    stderrFn(
      '[ci run] a test timed out, so the run is not finished; the job summary uses the local results table',
    );
    return {};
  }
  const timeoutSeconds =
    opts.ci?.executionReportTimeoutSeconds ?? EXECUTION_REPORT_DEFAULT_TIMEOUT_SECONDS;
  const deadlineMs = Date.now() + timeoutSeconds * 1000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutSeconds * 1000);
  const sleepFn = deps.sleep ?? defaultSleep;
  const shutdown = shutdownOf(deps);
  // Every whole-run wait has disarmed by now, so without this scope a
  // SIGINT/SIGTERM during the retry sleep would take the signal handler's
  // disarmed path and exit at once — no summary, no outputs.
  const disarm = shutdown.arm();
  try {
    for (;;) {
      // No automatic retries: the deadline below is the only retry policy.
      const res = await client.getExecutionReport(runId, { signal: ac.signal, retry: false });
      if (res.ready && res.report && typeof res.markdown === 'string') {
        if (res.report.runId !== runId) {
          stderrFn(
            `[ci run] execution report names run ${terminalSafeLine(res.report.runId)}, not ${terminalSafeLine(runId)}; the job summary uses the local results table`,
          );
          return {};
        }
        return { ready: { report: res.report, markdown: res.markdown } };
      }
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) break;
      const retrySeconds = Math.max(
        1,
        res.retryAfterSeconds ?? EXECUTION_REPORT_DEFAULT_RETRY_SECONDS,
      );
      // Interruptible: a SIGINT/SIGTERM here means "stop waiting for the
      // report", not "drop the finished batch's summary and outputs".
      await sleepUnlessInterrupted(
        sleepFn,
        Math.min(remainingMs, retrySeconds * 1000),
        shutdown.signal,
      );
      if (Date.now() >= deadlineMs) break;
    }
    stderrFn(
      `[ci run] execution report not ready within ${timeoutSeconds}s; the job summary uses the local results table`,
    );
  } catch (err) {
    if (err instanceof InterruptError) {
      stderrFn(
        '[ci run] interrupted while waiting for the execution report; the job summary uses the local results table',
      );
      return { interrupted: err };
    }
    stderrFn(
      `[ci run] execution report unavailable (${terminalSafeLine(err instanceof Error ? err.message : String(err))}); the job summary uses the local results table`,
    );
  } finally {
    clearTimeout(timer);
    disarm();
  }
  return {};
}

/**
 * Handle a batch invocation that dispatched ZERO tests — all skipped, an empty
 * project, or a `--filter` that matched nothing. Left alone this exits 0 with no
 * artifact, a CI false-green: a gate that greens on zero tests is worse than no
 * gate. So it emits the CI artifacts (summary with `skipped` rows +
 * `::warning::` annotations + JUnit report) so the gate shows WHY, then fails
 * with **exit 5** unless the caller passed `--allow-empty` (in which case it
 * returns and the caller exits 0).
 *
 * `skipped` is the union of skipped FE + integration tests (rendered as
 * `<skipped/>` JUnit cases and non-passed summary rows so they're visible);
 * `reason` is the human explanation shown in the annotation and the throw.
 */
async function finishZeroDispatchBatch(params: {
  reason: string;
  /** Tests left out, each with its own reason. */
  skipped: ReadonlyArray<{ testId: string; reason: string }>;
  allowEmpty: boolean;
  // Structural subset of the project-run options — only the CI-artifact and
  // JUnit fields are read here.
  opts: {
    wait?: boolean;
    ghOutput?: boolean;
    summaryFile?: string;
    output?: string;
    report?: JUnitReportFormat;
    reportFile?: string;
    reportSuiteName?: string;
    projectId?: string;
  };
  deps: TestDeps;
  stderrFn: (line: string) => void;
  /**
   * True only when the project genuinely has nothing — no test was
   * skipped and no filter narrowed the set. The message then also says where
   * a first suite comes from. Never inferred from the humanized `reason`.
   */
  emptyProject?: boolean;
  /**
   * The RESOLVED project id (`--project` or `TESTSPRITE_PROJECT_ID`).
   * `opts.projectId` is only the flag, so reading it here dropped the hint for
   * a caller relying on the environment variable.
   */
  projectId?: string;
  /** Set by a project run on a local environment, the one batch path that knows the app is local. */
  local?: LocalHint;
}): Promise<void> {
  const {
    reason,
    skipped,
    allowEmpty,
    opts,
    deps,
    stderrFn,
    emptyProject = false,
    projectId,
    local,
  } = params;
  // Text mode only: under --output json neither the error envelope's message
  // nor stderr carries the sentence (review feedback).
  const nextStep =
    emptyProject && projectId !== undefined && opts.output !== 'json'
      ? emptyProjectNextStep(projectId, local)
      : undefined;
  const rows: CiRunRow[] =
    skipped.length > 0
      ? skipped.map(entry => ({ testId: entry.testId, status: 'skipped', error: entry.reason }))
      : [{ testId: '(no tests)', status: 'no_tests', error: reason }];
  // Counted as `skipped`, not `failed`: nothing ran, so nothing
  // failed — the exit-5 gate below is what makes the job red, and the summary
  // must agree with it rather than claim failures the gates don't see.
  const summary: CiSummary = {
    total: rows.length,
    passed: 0,
    failed: 0,
    skipped: rows.length,
    timedOut: 0,
    results: rows,
  };
  // Emit the in-memory artifacts (summary + `::warning::` annotation) FIRST: they
  // can't fail on I/O, so the "show WHY it's red" diagnostics always land — even
  // if the JUnit path below is misconfigured. Ordering these after the file write
  // would let an unwritable --report-file throw (exit 10) preempt both the
  // diagnostics AND the exit-5 gate, masking the zero-dispatch cause.
  makeOutput(opts.output === 'json' ? 'json' : 'text', deps).print(
    {
      runs: [],
      results: [],
      reason,
      skipped,
      ...(opts.wait ? { summary: runCounts(summary) } : {}),
    },
    () => `0 tests dispatched (${reason})`,
  );
  emitCiArtifacts(
    summary,
    opts,
    {
      env: deps.env ?? process.env,
      stdout: deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`)),
      stderr: stderrFn,
    },
    'run',
  );
  // Then the JUnit sidecar (the other half of "no artifact was produced before").
  // `writeBatchJUnitReportIfRequested` no-ops unless --report junit. A write
  // failure is a warning when the exit-5 gate below is owed, so an unwritable
  // path can't mask it with an I/O exit code; with --allow-empty nothing else
  // is owed, so it is the command's error.
  await writeReportOwing(
    !allowEmpty,
    () => writeBatchJUnitReportIfRequested(opts, skippedJUnitResultsFromSummary(summary)),
    stderrFn,
    { label: 'run', what: 'the JUnit report on a zero-dispatch run' },
  );
  if (allowEmpty) {
    stderrFn(`[run] 0 tests dispatched (${reason}); --allow-empty set — exiting 0.`);
    if (nextStep !== undefined) stderrFn(`[hint] ${nextStep}`);
    return;
  }
  // The pointer rides inside the message so it prints AFTER "Error:", in
  // reading order — a CLIError has no nextAction slot of its own. A project
  // with no tests leads with where a first set comes from; the gate is a
  // footnote there.
  throw new CLIError(
    nextStep !== undefined
      ? `${nextStep}. (Nothing ran; --allow-empty exits 0 on an empty run.)`
      : `No tests were dispatched — ${reason}. A CI gate that passes on zero tests is unsafe; ` +
          `pass --allow-empty to exit 0 intentionally.`,
    5,
  );
}

function refuseCiLoopbackTarget(deps: TestDeps, validationError?: unknown): never {
  recordTelemetryExtras({ ciRunOutcome: 'refused_loopback' });
  emitCiStepOutputs(
    { total: 0, passed: 0, failed: 0, skipped: 0, timedOut: 0, results: [] },
    {
      env: deps.env ?? process.env,
      stderr: terminalSafeWriter(deps.stderr),
    },
  );
  if (validationError !== undefined) throw validationError;
  throw localValidationError(
    'target-url',
    'ci run requires a publicly reachable target URL. For a local app, use ' +
      'testsprite run --project <id> --env <name> --wait',
  );
}

/**
 * `run --project <id>` — M4 piece-2.
 *
 * Triggers a fresh wave-ordered batch run via `POST /tests/batch/run`.
 * FE tests in the project are skipped by the BE-only engine (advisory).
 * With `--wait`, polls each accepted resultId.
 */
export interface ProjectLaunchOutput {
  runs: RunReceipt[];
  joinedRuns?: Array<{ runId: string; resultIds: string[] }>;
  held?: ProjectRunResponse['held'];
  skipped?: Array<{ testId: string; runId?: string; resultId?: string; reason: string }>;
  results?: RunResult[];
  summary?: RunCounts;
}

/** Launch once per project; the server owns membership expansion and pacing. */
export async function runTestRunAll(
  opts: RunTestRunAllOptions & {
    tunnelClientId?: string;
    resolvedTarget?: ResolvedRunTarget;
    single?: boolean;
  },
  deps: TestDeps = {},
): Promise<ProjectLaunchOutput> {
  assertIdempotencyKey(opts.idempotencyKey);
  if (!opts.ci) assertRunArtifactPaths(opts);
  if (opts.wait || opts.report === undefined)
    assertJUnitReportOptions({ ...opts, batchPath: true });
  const environment = normalizeEnvironmentName(opts.environment);
  // Only `ci run` passes a target: a preview the cloud runner must reach. A
  // loopback one is refused below, with the rest of its outputs.
  try {
    if (opts.targetUrl !== undefined && !parseLoopbackTargetUrl(opts.targetUrl))
      assertNotLocal(opts.targetUrl, {
        field: 'target-url',
        helpCommand: 'testsprite ci run',
        hintContext: 'runtime',
      });
  } catch (err) {
    refuseCiLoopbackTarget(deps, err);
  }
  if (!opts.wait && !opts.targetUrl && (opts.ghOutput || opts.summaryFile))
    throw localValidationError('wait', '--gh-output and --summary-file require --wait');
  const stderr = terminalSafeWriter(deps.stderr);
  const shutdown = shutdownOf(deps);
  if (
    !Number.isInteger(opts.maxConcurrency) ||
    opts.maxConcurrency < 1 ||
    opts.maxConcurrency > 100
  )
    throw localValidationError('max-concurrency', 'must be an integer between 1 and 100');
  if (opts.targetUrl && parseLoopbackTargetUrl(opts.targetUrl)) refuseCiLoopbackTarget(deps);
  const client = makeClient(
    { ...opts, requestTimeoutMs: resolveWaitRequestTimeoutMs(opts) },
    opts.dryRun ? { ...deps, fetchImpl: undefined } : deps,
  );
  let discoveryClient = client;
  if (opts.dryRun) {
    try {
      discoveryClient = makeClient({ ...opts, dryRun: false }, deps);
    } catch (err) {
      if (!(err instanceof ApiError) || !isAuthCode(err.code)) throw err;
    }
  }
  let ids = opts.testIds ? [...new Set(opts.testIds)] : undefined;
  const projects = new Map<string, string[] | undefined>();
  let projectIdByTestId = opts.projectIdByTestId;
  const skippedSelection: NonNullable<ProjectLaunchOutput['skipped']> = [];
  const knownTests = new Map(opts.knownTests);
  opts = { ...opts, knownTests };
  if (ids?.length) {
    projectIdByTestId ??= opts.dryRun
      ? new Map(
          ids.map(id => [
            id,
            opts.knownTests?.get(id)?.projectId ?? opts.projectId ?? '<project-id>',
          ]),
        )
      : await resolveTestProjects(client, ids, knownTests);
    for (const id of ids) {
      const projectId = projectIdByTestId.get(id);
      if (!projectId)
        throw localValidationError('test-id', `could not determine the project of test ${id}`);
      const group = projects.get(projectId) ?? [];
      group.push(id);
      projects.set(projectId, group);
    }
  } else {
    const projectId = resolveProjectId(opts.projectId, deps);
    requireProjectId(projectId);
    opts = { ...opts, projectId };
    if (!opts.dryRun && opts.nameFilter) {
      const tests = await resolveAllProjectTests({
        client,
        projectId,
        nameFilter: opts.nameFilter,
        stderr,
      });
      for (const test of tests)
        knownTests.set(test.id, { type: test.type, projectId: test.projectId ?? projectId });
      ids = tests.map(test => test.id);
      if (ids.length === 0 && opts.ci) {
        const summary: CiSummary = {
          total: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          timedOut: 0,
          results: [],
        };
        const payload = { runs: [], results: [], summary };
        const io = {
          env: deps.env ?? process.env,
          stdout: deps.stdout ?? (line => process.stdout.write(`${line}\n`)),
          stderr,
        };
        makeOutput(opts.output, deps).print(payload);
        emitCiArtifacts(summary, opts, io, 'ci run');
        emitCiStepOutputs(summary, io);
        recordTelemetryExtras({ ciRunOutcome: 'empty' });
        await writeReportOwing(
          !opts.allowEmpty,
          () => writeBatchJUnitReportIfRequested(opts, []),
          stderr,
          { label: 'ci run', what: 'the JUnit report' },
        );
        if (!opts.allowEmpty)
          throw new CLIError(
            'No tests match --filter. Pass --allow-empty to exit 0 intentionally.',
            5,
          );
        return payload;
      }
      if (ids.length === 0) {
        await finishZeroDispatchBatch({
          reason: skippedSelection.length
            ? 'no frontend tests can use the tunnel'
            : opts.nameFilter
              ? 'no tests match --filter'
              : 'project has no tests',
          skipped: skippedSelection,
          allowEmpty: opts.allowEmpty === true,
          opts,
          deps,
          stderrFn: stderr,
        });
        return { runs: [] };
      }
    }
    projects.set(projectId, ids);
  }
  for (const selection of projects.values()) {
    if (selection && selection.length > 5000)
      throw localValidationError(
        'test-id',
        'a project request accepts at most 5000 named test IDs; narrow the selection or use --project <id> without --filter',
      );
  }
  const backendProjects = new Set<string>();
  if (opts.targetUrl && !opts.previewName && !opts.dryRun) {
    for (const [projectId, selection] of projects) {
      let type: string | undefined =
        selection?.length &&
        selection.every(id => knownTests.get(id)?.type === knownTests.get(selection[0]!)?.type)
          ? knownTests.get(selection[0]!)?.type
          : undefined;
      if (!type)
        type = (await client.get<{ type: string }>(`/projects/${encodeURIComponent(projectId)}`))
          .type;
      if (type !== 'frontend' && type !== 'backend')
        throw new ApiError({
          code: 'UNSUPPORTED',
          message: `Project ${projectId} did not return a supported test type.`,
          nextAction: 'Inspect the project before retrying.',
          requestId: 'local',
          details: {},
        });
      if (type === 'backend') backendProjects.add(projectId);
    }
  }
  const targets = new Map<string, ResolvedRunTarget>();
  // What resolving a project's local environment says ("opening a tunnel"),
  // held until the project is known to keep its tunnel: one with no tests, or
  // only backend tests, drops it below.
  const tunnelNotes = new Map<string, string[]>();
  if (!opts.environmentResolutionComplete) {
    for (const [projectId, selection] of projects) {
      const firstId =
        selection?.find(id => knownTests.get(id)?.type === 'frontend') ?? selection?.[0];
      const notes: string[] = [];
      const target =
        opts.resolvedTarget ??
        (await resolveEnvironmentRunTarget({
          client: discoveryClient,
          projectId,
          dryRun: opts.dryRun,
          testId: opts.dryRun ? undefined : firstId,
          knownTest: firstId ? opts.knownTests?.get(firstId) : undefined,
          skipTestLookup: !firstId,
          environment,
          targetUrl: opts.targetUrl,
          tunnelClientId: opts.tunnelClientId,
          noWait: opts.noWait,
          cache: deps.environmentCache,
          verbose: opts.verbose || opts.debug,
          stderr: opts.ci ? () => {} : line => notes.push(line),
        }));
      if (target) {
        targets.set(projectId, target);
        tunnelNotes.set(projectId, notes);
      } else for (const line of notes) stderr(line);
    }
  }
  if (targets.size && opts.ci) refuseCiLoopbackTarget(deps);
  for (const [projectId] of targets) {
    let selection = projects.get(projectId);
    if (!selection && !opts.dryRun) {
      const tests = await resolveAllProjectTests({ client, projectId, stderr });
      for (const test of tests)
        knownTests.set(test.id, { type: test.type, projectId: test.projectId ?? projectId });
      if (tests.length === 0) {
        // Nothing to run: say where a first set comes from, through the tunnel,
        // rather than send a run that the server refuses for want of one.
        const target = targets.get(projectId)!;
        await finishZeroDispatchBatch({
          reason: 'project has no tests',
          skipped: [],
          allowEmpty: opts.allowEmpty === true,
          opts,
          deps,
          stderrFn: stderr,
          emptyProject: true,
          projectId,
          local: {
            ...(target.environmentName !== undefined
              ? { environment: target.environmentName }
              : {}),
            ...(target.environmentIsDefault !== undefined
              ? { isDefault: target.environmentIsDefault }
              : {}),
          },
        });
        return { runs: [] };
      }
      if (tests.every(test => test.type === 'backend')) {
        targets.delete(projectId);
        continue;
      }
      selection = tests.map(test => test.id);
    }
    if (!selection) continue;
    const kept = selection.filter(id => knownTests.get(id)?.type !== 'backend');
    if (kept.length > 5000)
      throw localValidationError(
        'test-id',
        'a tunnel project request accepts at most 5000 named test IDs; narrow the selection',
      );
    for (const id of selection)
      if (!kept.includes(id)) skippedSelection.push({ testId: id, reason: 'backend-test' });
    if (kept.length) projects.set(projectId, kept);
    else {
      projects.delete(projectId);
      targets.delete(projectId);
    }
  }
  for (const [projectId, notes] of tunnelNotes)
    if (targets.has(projectId)) for (const line of notes) stderr(line);
  if (opts.timeoutIsDefault)
    opts = {
      ...opts,
      timeoutSeconds: targets.size
        ? DEFAULT_LOCAL_RUN_TIMEOUT_SECONDS
        : DEFAULT_RUN_TIMEOUT_SECONDS,
    };
  const wait = opts.wait || targets.size > 0;
  assertJUnitReportOptions({ ...opts, wait, batchPath: true });
  if (!wait && (opts.ghOutput || opts.summaryFile))
    throw localValidationError('wait', '--gh-output and --summary-file require --wait');
  if (!targets.size) assertNoTunnelOptions(opts);
  if (opts.targetUrl) {
    assertNotLocal(opts.targetUrl, {
      field: 'target-url',
      helpCommand: 'testsprite ci run',
      hintContext: 'runtime',
    });
    if (!opts.dryRun)
      await assertTargetUrlReachable(
        opts.targetUrl,
        opts,
        { fetchImpl: deps.fetchImpl, proxyActive: isProxyAgentActive() },
        stderr,
      );
  }
  const idempotencyKey = opts.idempotencyKey ?? randomUUID();
  const bodyFor = (
    projectId: string,
    selection: string[] | undefined,
    tunnel?: EnvironmentTunnelContext,
  ): ProjectRunRequest => {
    const target = targets.get(projectId);
    const ignoresBackendOverride =
      backendProjects.has(projectId) ||
      (!opts.previewName &&
        selection?.length &&
        selection.every(id => knownTests.get(id)?.type === 'backend'));
    const targetUrl = ignoresBackendOverride ? undefined : (target?.targetUrl ?? opts.targetUrl);
    return {
      ...(selection ? { testIds: selection } : {}),
      ...(environment !== undefined ? { environment } : {}),
      ...(targetUrl ? { targetUrl } : {}),
      ...(target && tunnel ? { tunnelClientId: tunnel.clientId } : {}),
      ...(opts.skipDependencies ? { skipDependencies: true } : {}),
      maxConcurrency: target
        ? (tunnel?.maxConcurrency ?? tunnelRunConcurrency(opts))
        : opts.maxConcurrency,
      ...(opts.admission ? { admission: opts.admission } : {}),
      ...(opts.previewName ? { previewName: opts.previewName } : {}),
      ...(opts.githubTrigger ? { githubTrigger: opts.githubTrigger } : {}),
    };
  };
  if (opts.dryRun) {
    // The preview is built here, not fetched: with credentials the environment
    // preflight above went through a live client, so no dry-run response has
    // fired the banner. Emit it after all validation (no-op if already shown).
    emitDryRunBanner(stderr);
    const requests: Parameters<typeof previewRun>[0] = [];
    for (const [projectId, selection] of projects) {
      if (opts.nameFilter)
        requests.push({
          method: 'GET',
          path: `/api/cli/v1/tests?projectId=${encodeURIComponent(projectId)}`,
        });
      requests.push({
        method: 'POST',
        path: `/api/cli/v1/projects/${encodeURIComponent(projectId)}/runs`,
        body: bodyFor(projectId, opts.nameFilter ? ['<matching-test-id>'] : selection),
        idempotencyKey,
      });
    }
    const preview = {
      ...previewRun(requests, wait, wait),
      ...(opts.nameFilter ? { filter: opts.nameFilter } : {}),
    };
    makeOutput(opts.output, deps).print(preview);
    if (!opts.ci && opts.report === 'junit' && opts.reportFile)
      await writeJUnitReportFile(
        opts.reportFile,
        sampleJUnitReportXml(opts.projectId, opts.reportSuiteName),
      );
    return preview;
  }
  const execute = async (tunnel?: EnvironmentTunnelContext): Promise<ProjectLaunchOutput> => {
    const runs: ProjectRunResponse[] = [];
    const scopes = new Map<string, string[] | undefined>();
    const skipped: NonNullable<ProjectLaunchOutput['skipped']> = [...skippedSelection];
    const conflictHeld: ProjectRunResponse['held'] = [];
    const mismatches = new WeakSet<ApiError>();
    const outcomes = new Map<string, RunWaitOutcome>();
    const pendingProjects = new Set(projects.keys());
    const unconfirmedProjects: Array<{ projectId: string; idempotencyKey: string }> = [];
    const activeClient = tunnel?.client ?? client;
    const deadline = tunnel?.deadlineMs ?? Date.now() + opts.timeoutSeconds * 1000;
    let failure: unknown;
    let requestTimedOut = false;
    const joinHeld = async (
      held: { runId: string; resultId: string },
      projectId: string,
      body: ProjectRunRequest,
      original?: ApiError,
    ): Promise<void> => {
      const card = await activeClient.getRun(held.resultId);
      const incompatible = (reason: string): ApiError => {
        const error =
          original ??
          new ApiError(
            {
              code: 'CONFLICT',
              message: `Cannot join result ${held.resultId}: ${reason}.`,
              nextAction: `testsprite run wait ${held.runId}`,
              requestId: 'local',
              details: { currentRunId: held.runId, currentResultId: held.resultId },
            },
            409,
          );
        mismatches.add(error);
        return error;
      };
      if (
        card.runId !== held.runId ||
        card.projectId !== projectId ||
        (body.targetUrl !== undefined && card.targetUrl !== body.targetUrl)
      )
        throw incompatible('its run or target does not match');
      if (tunnel && targets.has(projectId))
        throw incompatible('its tunnel ownership cannot be verified');
      await verifyInFlightRunEnvironment(
        card,
        environment,
        p => activeClient.get(`/projects/${encodeURIComponent(p)}/env`),
        incompatible,
      );
      if (!scopes.has(held.runId)) scopes.set(held.runId, [held.resultId]);
      else scopes.get(held.runId)?.push(held.resultId);
      stderr(
        `[advisory] Joined run ${terminalSafeLine(held.runId)} for result ${terminalSafeLine(held.resultId)}. ${cancelCommand([{ runId: held.runId, resultId: held.resultId, joined: true }])}`,
      );
    };
    const joinOrSkip = async (
      held: { testId: string; runId: string; resultId: string },
      projectId: string,
      body: ProjectRunRequest,
      original?: ApiError,
    ): Promise<void> => {
      try {
        await joinHeld(held, projectId, body, original);
      } catch (err) {
        if (opts.single || !(err instanceof ApiError) || !mismatches.has(err)) throw err;
        skipped.push({ ...held, reason: err.message });
        stderr(
          `[advisory] ${terminalSafeLine(err.message)} This test is skipped by this invocation.`,
        );
      }
    };
    const disarm = shutdown.arm();
    try {
      if (opts.verbose || opts.debug || opts.output === 'json')
        stderr(`idempotency-key: ${idempotencyKey}`);
      for (const [projectId, selection] of projects) {
        shutdown.signal.throwIfAborted();
        const body = bodyFor(projectId, selection, tunnel);
        if (opts.targetUrl && body.targetUrl === undefined && !opts.previewName)
          stderr(
            "[advisory] --target-url is not applied to a backend project outside a pull request; its tests use the selected environment's URL. In a pull request, ci run --env <name> --target-url <url> clones that environment at the preview.",
          );
        const key =
          projects.size === 1 ? idempotencyKey : suffixedIdempotencyKey(idempotencyKey, projectId);
        let launched: ProjectRunResponse;
        try {
          const response = await activeClient.triggerProjectRun(projectId, body, {
            idempotencyKey: key,
          });
          launched = response.body;
          if (opts.verbose || opts.debug) stderr(`requestId: ${response.requestId}`);
        } catch (err) {
          if (!(err instanceof ApiError) || err.httpStatus === undefined || err.httpStatus >= 500) {
            pendingProjects.delete(projectId);
            unconfirmedProjects.push({ projectId, idempotencyKey: key });
            stderr(
              `Project ${terminalSafeLine(projectId)} may have started, but no launch receipt was received. Inspect its runs before retrying. For the same command, reuse this --idempotency-key value: ${idempotencyKey}`,
            );
          }
          const conflicts =
            err instanceof ApiError && Array.isArray(err.details?.conflicts)
              ? (err.details.conflicts as RunConflict[])
              : [];
          if (
            !(err instanceof ApiError) ||
            err.code !== 'CONFLICT' ||
            err.httpStatus !== 409 ||
            err.details.reason !== 'run_in_flight' ||
            !wait ||
            !conflicts.length ||
            !conflicts.every(
              row =>
                row !== null &&
                typeof row === 'object' &&
                typeof row.testId === 'string' &&
                row.testId.length > 0 &&
                typeof row.currentRunId === 'string' &&
                row.currentRunId.length > 0 &&
                typeof row.currentResultId === 'string' &&
                row.currentResultId.length > 0,
            )
          )
            throw err;
          conflictHeld.push(
            ...conflicts.map(row => ({
              testId: row.testId,
              runId: row.currentRunId!,
              resultId: row.currentResultId!,
            })),
          );
          for (const held of conflicts)
            await joinOrSkip(
              { testId: held.testId, runId: held.currentRunId!, resultId: held.currentResultId! },
              projectId,
              body,
              err,
            );
          pendingProjects.delete(projectId);
          continue;
        }
        runs.push(launched);
        pendingProjects.delete(projectId);
        scopes.set(launched.runId, undefined);
        if (targets.has(projectId) && tunnel) await tunnel.confirm(launched, [launched.runId]);
        const unconfirmed =
          body.targetUrl !== undefined && launched.targetUrl !== body.targetUrl
            ? 'targetUrl'
            : opts.previewName && launched.environment?.name !== opts.previewName
              ? 'previewName'
              : !opts.previewName &&
                  environment !== undefined &&
                  launched.environment?.name !== environment
                ? 'environment'
                : launched.maxConcurrency !== undefined &&
                    launched.maxConcurrency > body.maxConcurrency!
                  ? 'maxConcurrency'
                  : undefined;
        if (unconfirmed) {
          if (opts.ci) recordTelemetryExtras({ ciRunOutcome: 'refused_admission' });
          throw new ApiError({
            code: 'UNSUPPORTED',
            message: `Run ${launched.runId} did not confirm the requested ${unconfirmed}.`,
            nextAction: `Inspect run ${launched.runId} before retrying.`,
            requestId: 'local',
            details: { field: unconfirmed, runId: launched.runId },
          });
        }
        for (const held of launched.held) if (wait) await joinOrSkip(held, projectId, body);
        stderr(`Run ${terminalSafeLine(launched.runId)}`);
        recordTelemetryExtras({
          executionId: launched.runId,
          ...(opts.ci ? { ciRunOutcome: launched.total === 0 ? 'empty' : 'gated' } : {}),
        });
      }
      if (wait) {
        const stopped = new AbortController();
        await Promise.all(
          [...scopes].map(async ([runId, onlyResultIds]) => {
            if (stopped.signal.aborted) return;
            try {
              const outcome = await waitForRun(activeClient, runId, {
                deadline,
                shutdown,
                onlyResultIds,
                signal: stopped.signal,
                sleep: deps.sleep,
                onRead: async (snapshot, signal) => {
                  outcomes.set(runId, {
                    ...snapshot,
                    runId,
                    missingResultIds: [],
                    timedOut: false,
                    ...(onlyResultIds ? { joined: true } : {}),
                  });
                  if (tunnel) await tunnel.onRead(snapshot, signal);
                },
              });
              outcomes.set(runId, outcome);
              if (outcome.timedOut && !tunnel) deps.onWaitTimeout?.({ reason: 'wait_timeout' });
            } catch (err) {
              if (err instanceof ApiError)
                outcomes.set(runId, {
                  ...(outcomes.get(runId) ?? {
                    runId,
                    run: null,
                    results: [],
                    missingResultIds: [],
                    timedOut: false,
                    ...(onlyResultIds ? { joined: true as const } : {}),
                  }),
                  error: err,
                });
              else {
                if (failure === undefined || err instanceof InterruptError) failure = err;
                if (err instanceof RequestTimeoutError) requestTimedOut = true;
                else stopped.abort(err);
              }
              if (err instanceof TunnelLostError) stopped.abort(err);
            }
          }),
        );
        // Completion order must not change the launch/held scope order in output.
        const observed = new Map(outcomes);
        outcomes.clear();
        for (const runId of scopes.keys()) {
          const outcome = observed.get(runId);
          if (outcome) outcomes.set(runId, outcome);
        }
        if (failure === undefined || failure instanceof RequestTimeoutError) {
          failure = resolveRunWaitFailure([...outcomes.values()], opts, failure) ?? undefined;
        }
      }
    } catch (err) {
      failure = err;
      if (opts.ci && runs.length === 0 && err instanceof ApiError)
        recordTelemetryExtras({ ciRunOutcome: ciRefusalOutcome(err) });
    } finally {
      disarm();
    }
    if (failure && tunnel) {
      await tunnel.cancelActive();
      for (const [runId, outcome] of outcomes)
        if (outcome.timedOut) {
          const cancellation = tunnel.cancellation(runId);
          deps.onWaitTimeout?.({
            reason: 'wait_timeout',
            cancelOutcome:
              cancellation === 'cancelled'
                ? 'cancelled'
                : cancellation === 'already-terminal'
                  ? 'already_terminal'
                  : cancellation === 'cancel-failed'
                    ? 'failed'
                    : 'skipped',
          });
        }
      const target = targets.values().next().value as ResolvedRunTarget | undefined;
      for (const launched of runs) {
        const outcome = outcomes.get(launched.runId);
        const ownerGone =
          failure instanceof TunnelLostError && failure.details.reason === 'owner-gone';
        if (
          outcome?.run?.status === 'finished' ||
          !target ||
          (tunnel.session.adopted && !ownerGone)
        )
          continue;
        const detach: TunnelDetach = {
          runId: launched.runId,
          resultId: outcome?.results[0]?.resultId,
          testId: opts.single ? ids![0]! : `--project ${launched.projectId}`,
          automatic: target.automatic,
          environment,
          ownerGone,
          reason:
            failure instanceof TunnelLostError
              ? 'tunnel-lost'
              : failure instanceof InterruptError
                ? 'interrupt'
                : outcome?.timedOut
                  ? 'timeout'
                  : failure instanceof RequestTimeoutError
                    ? 'request-timeout'
                    : failure instanceof ApiError && failure.code === 'RATE_LIMITED'
                      ? 'rate-limited'
                      : 'poll-error',
          cancel:
            tunnel.cancellation(launched.runId) === 'already-terminal'
              ? 'already-terminal'
              : tunnel.cancellation(launched.runId) === 'cancelled'
                ? 'cancelled'
                : opts.cancelOnInterrupt === false
                  ? 'skipped'
                  : 'failed',
        };
        const message = tunnelDetachMessage(
          detach,
          failure instanceof InterruptError ? failure : undefined,
        );
        stderr(message);
        if (failure instanceof InterruptError)
          Object.assign(failure, {
            tunnelDetach: {
              runId: launched.runId,
              ...(detach.resultId ? { resultId: detach.resultId } : {}),
              cancel: detach.cancel,
              nextAction: tunnelInterruptNextAction(detach, failure),
            },
          });
        // This timeout is synthesized by our wait loop, not a backend envelope.
        if (failure instanceof ApiError && failure.requestId === 'local' && outcome?.timedOut)
          Object.assign(failure, { nextAction: message, serverNextAction: message });
      }
    }
    const joinedRuns = [...scopes].flatMap(([runId, resultIds]) =>
      resultIds ? [{ runId, resultIds }] : [],
    );
    const {
      output: payload,
      members: results,
      diagnosticRows: runFailureRows,
      unfinishedRuns,
      summary,
    } = buildRunOutput({
      receipts: [...runs, ...joinedRuns.map(({ runId }) => ({ runId, joined: true }))],
      dispatched: runs.flatMap(run =>
        run.blocked.map(row => ({
          testId: row.testId,
          resultId: row.resultId,
          runId: run.runId,
          status: 'blocked',
          error: { code: row.reason, message: row.message ?? row.reason },
        })),
      ),
      outcomes,
      wait,
      failure,
      requestTimedOut,
      joinedScopes: scopes,
      incompleteDispatch: pendingProjects.size > 0 || unconfirmedProjects.length > 0,
      buckets: { skipped },
      foldSkippedBuckets: true,
      cancellation: tunnel?.cancellation,
    });
    recordBatchOutcome({
      accepted: runs.reduce((total, row) => total + row.total, 0),
      conflicts: [],
      deferred: 0,
      skipped: skipped.length,
      ...(wait ? { results } : {}),
    });
    const launchOutput: ProjectLaunchOutput = {
      ...payload,
      ...(conflictHeld.length ? { held: conflictHeld } : {}),
      ...(joinedRuns.length ? { joinedRuns } : {}),
      ...(skipped.length ? { skipped } : {}),
    };
    for (const row of results)
      if ((row.status === 'failed' || row.status === 'blocked') && row.resultId)
        stderr(
          failureHint(row.status, row.resultId, knownTests.get(row.testId)?.type === 'backend'),
        );
    if (opts.ci && [...outcomes.values()].some(row => row.timedOut))
      stderr(
        '[ci run] a test timed out, so the run is not finished; the job summary uses the local results table',
      );
    let report: ExecutionReportReady | undefined;
    if (
      opts.ci &&
      wait &&
      scopes.size === 1 &&
      !(failure instanceof InterruptError) &&
      ![...outcomes.values()].some(
        row => row.error || row.timedOut || (row.run?.cancelled && !row.joined),
      )
    ) {
      const fetched = await fetchExecutionReport(
        activeClient,
        runs.map(row => ({ runId: row.runId })),
        results,
        opts,
        deps,
        stderr,
      );
      report = fetched.ready;
      recordTelemetryExtras({ reportReady: report !== undefined });
      failure = fetched.interrupted ?? failure;
      if (report) summary.executionReport = report.report;
    }
    makeOutput(opts.output, deps).print(
      {
        ...launchOutput,
        ...(opts.ci && wait ? { summary } : {}),
        ...(pendingProjects.size ? { notRunProjects: [...pendingProjects] } : {}),
        ...(unconfirmedProjects.length
          ? { unconfirmedProjects, retryIdempotencyKey: idempotencyKey }
          : {}),
      },
      () => renderRunResults(payload.runs, payload.results, wait ? summary : undefined),
    );
    if (wait) {
      const io = {
        env: deps.env ?? process.env,
        stdout: deps.stdout ?? (line => process.stdout.write(`${line}\n`)),
        stderr,
      };
      emitCiArtifacts(summary, opts, io, opts.ci ? 'ci run' : 'run', {
        markdown: report ? reconcileExecutionReportMarkdown(summary, report) : undefined,
      });
      if (opts.ci) {
        emitCiStepOutputs(summary, io);
        if (report) emitExecutionReportOutputs(report, io);
      }
      const gate = resolveCiRunFailure(
        summary,
        results,
        { ...opts, failOnSkipped: opts.ci?.failOnSkipped },
        [],
      );
      failure ??= gate ?? undefined;
      if (
        !opts.single &&
        runs.every(row => row.total === 0) &&
        joinedRuns.length === 0 &&
        !opts.allowEmpty
      )
        failure ??= new CLIError(
          'No new tests were dispatched. Pass --allow-empty to exit 0 intentionally.',
          5,
        );
      await writeReportOwing(
        failure !== undefined,
        () =>
          writeBatchJUnitReportIfRequested({ ...opts, projectIdByTestId }, [
            ...results,
            ...skippedJUnitResultsFromSummary(summary, results),
            ...runFailureRows,
          ]),
        stderr,
        { label: opts.ci ? 'ci run' : 'run', what: 'the JUnit report' },
      );
    }
    if (failure instanceof ApiError && !tunnel && unfinishedRuns.length)
      stderr(`Resume: ${waitCommand(unfinishedRuns)}\nCancel: ${cancelCommand(unfinishedRuns)}`);
    if (failure instanceof InterruptError && unfinishedRuns.length) {
      markRunWaitInterrupt(failure, unfinishedRuns);
      if (!tunnel || tunnel.session.adopted)
        stderr(interruptDetachMessage(failure, unfinishedRuns));
    }
    if (failure) throw failure;
    if (runs.length && runs.every(row => row.total === 0) && !opts.allowEmpty)
      throw new CLIError(
        'No tests were dispatched. Pass --allow-empty to exit 0 intentionally.',
        5,
      );
    return launchOutput;
  };
  return targets.size && !deps.environmentTunnel
    ? withEnvironmentTunnel(
        { ...opts, maxConcurrency: tunnelRunConcurrency(opts) },
        deps,
        [...targets.values()],
        'run',
        execute,
      )
    : execute(deps.environmentTunnel);
}

interface RunTestRunLocalBatchOptions extends CommonOptions {
  wait?: boolean;
  noWait?: boolean;
  concurrencyIsDefault?: boolean;
  resolvedTarget?: ResolvedRunTarget;
  testIds: string[];
  all: boolean;
  projectId?: string;
  nameFilter?: string;
  skipPreflight: boolean;
  tunnelClientId?: string;
  cancelOnInterrupt: boolean;
  timeoutSeconds: number;
  /**
   * Per-execution server dispatch cap, including executions using a tunnel.
   * The client groups by project and never divides this into pacing shares.
   */
  maxConcurrency: number;
  idempotencyKey?: string;
  report?: JUnitReportFormat;
  reportFile?: string;
  reportSuiteName?: string;
  ghOutput?: boolean;
  summaryFile?: string;
  allowEmpty: boolean;
  environment?: string;
  /** See `RunTestRunOptions.skipDependencies`; forwarded to every dispatch. */
  skipDependencies?: boolean;
  /** `--timeout` was not given: a batch run that needs no tunnel uses the ordinary default. */
  timeoutIsDefault?: boolean;
}

/** Default server dispatch limit for each execution using the tunnel. */
const DEFAULT_TUNNEL_RUN_CONCURRENCY = 5;
/** The server never runs more tests of one run through a tunnel at once. */
const MAX_TUNNEL_RUN_CONCURRENCY = 15;

/** The server cap per tunnel execution: the default, or --max-concurrency within 1..15. */
function tunnelRunConcurrency(opts: {
  maxConcurrency: number;
  concurrencyIsDefault?: boolean;
}): number {
  if (opts.concurrencyIsDefault) return DEFAULT_TUNNEL_RUN_CONCURRENCY;
  if (
    !Number.isInteger(opts.maxConcurrency) ||
    opts.maxConcurrency < 1 ||
    opts.maxConcurrency > MAX_TUNNEL_RUN_CONCURRENCY
  ) {
    throw localValidationError(
      'max-concurrency',
      `with a tunnel, --max-concurrency must be between 1 and ${MAX_TUNNEL_RUN_CONCURRENCY} ` +
        `(how many tests run at once in each execution through the tunnel; the default is ${DEFAULT_TUNNEL_RUN_CONCURRENCY})`,
    );
  }
  return opts.maxConcurrency;
}

/** Several selected projects share one tunnel; each execution is paced by the server. */
export async function runTestRunLocalBatch(
  opts: RunTestRunLocalBatchOptions,
  deps: TestDeps = {},
): Promise<ProjectLaunchOutput> {
  return runTestRunAll(
    { ...opts, wait: opts.wait === true, testIds: opts.all ? undefined : opts.testIds },
    deps,
  );
}

const SKIP_PREFLIGHT_HELP =
  "skip the check that a local environment's app is listening before its tunnel opens";

export function createTestCommand(deps: TestDeps = {}): Command {
  const test = new Command('test').description('List and inspect tests');

  test
    .command('list')
    .description('List tests in a project')
    // Intentionally NOT `.requiredOption` — Commander's missing-required-option
    // path throws a plain Error and `index.ts` maps it to exit 1, which would
    // bypass the typed `VALIDATION_ERROR` (exit 5) envelope contract from
    // the CLI error spec §2 ("missing required field"). `requireProjectId`
    // below raises `ApiError(VALIDATION_ERROR)` so JSON consumers can read
    // `error.code` and the exit code matches the catalog.
    .option('--project <id>', 'project id (required unless TESTSPRITE_PROJECT_ID is set)')
    .option('--type <type>', 'filter by test type (frontend|backend)')
    .option(
      '--page-size <n>',
      'fetch ONE page of N items (1-100) and print the next token (default: follow every page; --max-items caps that)',
    )
    .option('--starting-token <token>', 'opaque cursor from a previous list response')
    .option('--cursor <token>', 'alias for --starting-token')
    .option('--max-items <n>', 'stop after this many items across auto-paged pages')
    .option('--columns <list>', 'select/reorder text table columns (comma-separated keys)')
    .option('--no-header', 'suppress the text table header row')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts: ListFlagOpts, command: Command) => {
      // Same parser strategy as `project list`: skip Commander's number
      // parser so a non-numeric --page-size surfaces as a typed
      // VALIDATION_ERROR (exit 5) rather than Commander's plain
      // exception (exit 1). Enum filters validate locally too.
      //
      // --cursor is an alias for --starting-token, kept for scripts that
      // already pass it. --starting-token takes precedence if both are
      // supplied (prevents accidental override).
      await runList(
        {
          ...resolveCommonOptions(command, deps.env),
          projectId: cmdOpts.project,
          type: parseEnumFlag(cmdOpts.type, 'type', TEST_TYPES),
          pageSize: parseNumericFlag(cmdOpts.pageSize, 'page-size'),
          startingToken: cmdOpts.startingToken ?? cmdOpts.cursor,
          maxItems: parseNumericFlag(cmdOpts.maxItems, 'max-items'),
          columns: cmdOpts.columns,
          noHeader: cmdOpts.header === false,
        },
        deps,
      );
    });

  test
    .command('get <test-id>')
    .description('Get a test by id')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (testId: string, _cmdOpts, command: Command) => {
      await runGet({ ...resolveCommonOptions(command, deps.env), testId }, deps);
    });

  return test;
}

/** Public launch adapter; execution engines remain shared in this module. */
export function createRunCommand(deps: TestDeps = {}): Command {
  const run = new Command('run');
  run
    .argument('[test-id...]')
    .enablePositionalOptions()
    .helpCommand(true)
    .summary('Run a project, named tests or a saved test list')
    .description(
      'Run a whole project, named test cases or a saved list (--testlist <id>). Saved loopback environments open a tunnel automatically and wait for a verdict.\n' +
        'Pass several <test-id>s, or use --project <id> [--filter <substr>], for a batch run (IDs are grouped per project into one request (at most 5000 named IDs per project)). Loopback environments share one tunnel.\n' +
        '\nExit codes:\n' +
        '  0  passed (or queued without --wait)\n' +
        '  1  failed / blocked / cancelled\n' +
        '  3  auth error\n' +
        '  4  test not found\n' +
        '  5  validation error (e.g., bad URL, or conflicting selectors)\n' +
        '  6  conflict (already running — see nextAction for the active runId and resultId)\n' +
        '  7  timeout — resume with: testsprite run wait <run-id>, ' +
        'or stop it with: testsprite run cancel <run-id>\n' +
        ' 10  transport/network failure (UNAVAILABLE). If it printed a runId with status\n' +
        '     running, that run is still executing: check it with testsprite run wait\n' +
        '     <run-id> (running this command again triggers and bills a new run).\n' +
        '     With a local environment, the tunnel closed with this command\n' +
        '     and run wait cannot reopen it: follow the printed next step. If its\n' +
        '     cancellation was skipped, the run can still finish, but steps that need\n' +
        '     your machine can fail. Otherwise retry the command\n' +
        ' 11  rate limited — honor Retry-After\n' +
        ' 12  insufficient credits (non-retriable; top up)\n' +
        ' 13  feature gated / workspace paused\n' +
        '\nJSON lists executions in runs and per-test outcomes in results. With --wait, summary counts the outcomes.\n' +
        'An incomplete timeout or interrupt adds partial: true.\n' +
        '\nOn failure/blocked/cancelled, read the result: testsprite result get <result-id>\n' +
        '(add --out <dir> to download its evidence). <run-id> is the execution, printed as runId;\n' +
        "<result-id> is one test's part of it, printed as resultId.\n" +
        '\nCtrl-C during an ordinary --wait detaches; an owned tunnel cancels unfinished runs by default.\n' +
        'Stop a detached run with: testsprite run cancel <run-id>\n' +
        'Dev servers can take a minute per page through a tunnel; prefer a built server (npm run build, then start).',
    )
    .option('--skip-preflight', SKIP_PREFLIGHT_HELP, false)
    .option(
      '--tunnel-client <id>',
      'for a local environment, attach to a tunnel already running under `testsprite tunnel start` ' +
        '(use the id it prints) instead of opening one; that process keeps the tunnel open afterwards.',
    )
    .option(
      '--no-cancel-on-interrupt',
      'with a tunnel, do not auto-cancel runs when an owned tunnel closes or a ' +
        "borrowed tunnel's owner disappears",
    )
    .option(
      '--env <name>',
      'run against the named project environment — its credentials, auto-auth and OTP settings ' +
        '(see `testsprite project env list <project-id>`); a loopback one opens a tunnel. ' +
        "Default: the project's default environment. Also applies to whole-project runs.",
    )
    .option('--wait', 'poll until terminal status or --timeout elapses', false)
    .option('--no-wait', 'detach without opening an automatic environment tunnel')
    .option(
      '--timeout <s>',
      'with --wait, one shared deadline for all executions (1–3600 seconds; default 600, or 1200 through a tunnel)',
    )
    .option(
      '--idempotency-key <key>',
      'opaque key for safe retries (1–256 chars); unchanged for one project, with stable project-specific suffixes for several projects',
    )
    .option(
      '--project <id>',
      'run the whole project (overrides TESTSPRITE_PROJECT_ID); excludes named test IDs and --testlist',
    )
    .option(
      '--testlist <id>',
      'run a saved list; optional positional IDs select its cases using saved project/environment mappings',
    )
    .option(
      '--filter <substr>',
      'with a project run: only run tests whose name contains this non-empty substring (case-insensitive); omit to run every test',
    )
    .option(
      '--max-concurrency <n>',
      `project/multiple IDs server limit; with a tunnel: 1-${MAX_TUNNEL_RUN_CONCURRENCY}, default ${DEFAULT_TUNNEL_RUN_CONCURRENCY}; without a tunnel: 1-100, default ${DEFAULT_BATCH_RUN_CONCURRENCY}; single-test adapter default 5; saved lists: 1-50/default 10, or tunnel 1-10/default 5`,
    )
    .option(
      '--report <format>',
      'with a --wait batch (project, several IDs or saved list): write a JUnit XML sidecar report after polling (accepted: junit)',
    )
    .option('--report-file <path>', 'output path for --report (atomic write)')
    .option(
      '--report-suite-name <name>',
      'optional JUnit suite name (default: testsprite:<projectId>, or testsprite:testlist:<listId>)',
    )
    .option(
      '--gh-output',
      'with --wait: emit GitHub annotations (::error:: failed/timed-out, ::warning:: never dispatched) and a job-summary table when $GITHUB_STEP_SUMMARY is set; auto-enabled when GITHUB_ACTIONS=true',
    )
    .option(
      '--summary-file <path>',
      'with --wait: also write summary JSON {total, passed, failed, blocked?, cancelled?, errors?, skipped, timedOut, results[]} to this file',
    )
    .option(
      '--allow-empty',
      'with a project, a test list or a multi-ID batch: exit 0 when ZERO test cases are dispatched (default: exit 5, so an empty run is not a CI false-green)',
    )
    .option(
      '--skip-dependencies',
      'Backend test cases only: run without the test cases they depend on',
      false,
    )
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  testsprite run --project <id>                all test cases in the project, in wave order\n' +
        '  testsprite run <id> <id> <id>                      several test cases in one run (one request per project; at most 5000 named IDs per project)\n' +
        '  testsprite run <id> <id> --env local               several test cases on a local environment, one tunnel\n' +
        '  testsprite run --project <id> --env staging                all test cases in the project, run in staging\n' +
        '  testsprite run --project <id> --filter <substr> --wait --report junit --report-file ./results.xml\n' +
        '  testsprite run --testlist <list-id> --wait             all saved list cases, using pinned environments\n' +
        '  testsprite run <id> <id> --testlist <list-id> --wait   selected saved list cases\n' +
        '  testsprite run wait <run-id...> --timeout 600         resume without starting a new run\n' +
        '  testsprite run cancel <run-id...>                    cancel whole executions\n' +
        '\nList mode: concurrency defaults to 10 (1-50), or 5 through a tunnel (1-10); timeout defaults to 600 even through a tunnel.\n' +
        'List environments come from saved project mappings; --env and other project-only launch flags are refused.\n' +
        '\nQueueing and limits:\n' +
        '  - Each request starts one run; its results show queued until they start,\n' +
        '    as in the Portal.\n' +
        '  - In-flight test cases appear as held references; --wait verifies compatibility\n' +
        '    before joining only those results. Other cases remain skipped or conflict.\n' +
        '  - Server rate limits retain their error details and Retry-After policy.\n' +
        '  - --max-concurrency is a server limit per execution, never a shared client budget.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (testIdArgs: string[], cmdOpts: RunFlagOpts, command: Command) => {
      // A literal `testsprite run list` is someone guessing at a
      // "list prior runs" subcommand, not naming a test whose id is the
      // string "list". Left unguarded, this parses as a normal `<test-id>`
      // and dispatches a run against a test that (almost certainly) does not
      // exist, wasting a round trip on a typo that a clear message could
      // have caught locally. Checked first, before any other validation or
      // network access, so it wins even if other flags (`--project`, etc.) are
      // also present.
      if (testIdArgs.length === 1 && testIdArgs[0] === 'list') {
        throw localValidationError(
          'test-id',
          'there is no `run list` command; to see a test’s prior results use: ' +
            'testsprite result list --test <test-id>',
        );
      }
      const explicitProject = command.getOptionValueSource('project') === 'cli';
      const explicitList = command.getOptionValueSource('testlist') === 'cli';
      if (explicitProject && !cmdOpts.project?.trim()) {
        throw localValidationError('project', '--project must be a non-empty project ID');
      }
      if (explicitList && !cmdOpts.testlist?.trim()) {
        throw localValidationError('testlist', '--testlist must be a non-empty test-list ID');
      }
      if (explicitProject && (testIdArgs.length > 0 || explicitList)) {
        throw localValidationError(
          'project',
          '--project cannot be combined with test IDs or --testlist',
        );
      }
      if (explicitList) {
        for (const name of [
          'env',
          'tunnelClient',
          'cancelOnInterrupt',
          'skipDependencies',
          'filter',
        ]) {
          if (command.getOptionValueSource(name) === 'cli') {
            const flag = command.options.find(option => option.attributeName() === name)!.long!;
            throw localValidationError(
              'testlist',
              `${flag} is not supported with --testlist; use the list's saved project/environment mappings`,
            );
          }
        }
        await runTestlistRunFromCommand(
          command,
          cmdOpts.testlist!.trim(),
          [...new Set(testIdArgs)],
          deps,
        );
        return;
      }
      const isAll = testIdArgs.length === 0;
      const projectId = isAll ? resolveProjectId(cmdOpts.project, deps) : undefined;
      if (isAll)
        requireProjectId(
          projectId,
          'provide test IDs, --testlist <id>, or --project <id> (or set TESTSPRITE_PROJECT_ID)',
        );
      const nameFilter = parseNameFilter(cmdOpts.filter);
      if (nameFilter !== undefined && !isAll) {
        throw localValidationError(
          'filter',
          '--filter only applies to a whole-project run; use --project <id> or TESTSPRITE_PROJECT_ID without test IDs',
        );
      }
      // Every refusal here happens BEFORE any network call: a mistake in the
      // invocation must never reach a run row, a credit spend, or a minted
      // tunnel credential.
      const effectiveWait = cmdOpts.wait === true;
      const canAutoWait =
        !resolveCommonOptions(command, deps.env).dryRun &&
        !(command.getOptionValueSource('wait') === 'cli' && cmdOpts.wait === false);
      if (command.getOptionValueSource('wait') === 'cli' && cmdOpts.wait === false) {
        assertNoTunnelOptions({
          tunnelClientId: cmdOpts.tunnelClient,
          cancelOnInterrupt: cmdOpts.cancelOnInterrupt,
        });
      }
      const maxConcurrency =
        cmdOpts.maxConcurrency === undefined
          ? DEFAULT_BATCH_RUN_CONCURRENCY
          : Number(cmdOpts.maxConcurrency);
      const testIds = [...new Set(testIdArgs)];

      const report = parseJUnitReportFormat(cmdOpts.report);
      assertJUnitReportOptions({
        report,
        reportFile: cmdOpts.reportFile,
        reportSuiteName: cmdOpts.reportSuiteName,
        wait: effectiveWait || canAutoWait,
        batchPath: isAll || testIds.length > 1,
      });
      // --gh-output / --summary-file reduce a --wait run's terminal result into
      // the CI summary. They require --wait (without it the command returns after
      // enqueueing, before any terminal result exists) but apply to BOTH a single
      // <test-id> run and the project batch. Without --wait they would silently
      // no-op — reject loudly (same rule as --filter and the JUnit report flags).
      if (cmdOpts.ghOutput === true && !effectiveWait && !canAutoWait) {
        throw localValidationError(
          'gh-output',
          '--gh-output requires --wait (it reduces the terminal run result). Add --wait.',
        );
      }
      if (cmdOpts.summaryFile !== undefined && !effectiveWait && !canAutoWait) {
        throw localValidationError(
          'summary-file',
          '--summary-file requires --wait (it reduces the terminal run result). Add --wait.',
        );
      }
      assertRunArtifactPaths({
        report,
        reportFile: cmdOpts.reportFile,
        summaryFile: cmdOpts.summaryFile,
      });

      if (isAll && cmdOpts.tunnelClient === undefined) {
        // Project path: wave-ordered fresh batch run.
        requireProjectId(projectId, 'pass --project <id> or set TESTSPRITE_PROJECT_ID');
        await runTestRunAll(
          {
            ...resolveCommonOptions(command, deps.env),
            projectId,
            nameFilter,
            wait: effectiveWait,
            noWait: command.getOptionValueSource('wait') === 'cli' && cmdOpts.wait === false,
            concurrencyIsDefault: cmdOpts.maxConcurrency === undefined,
            timeoutIsDefault: cmdOpts.timeout === undefined,
            cancelOnInterrupt: cmdOpts.cancelOnInterrupt !== false,
            timeoutSeconds: parseTimeoutFlag(cmdOpts.timeout, 'timeout'),
            maxConcurrency:
              parseNumericFlag(cmdOpts.maxConcurrency, 'max-concurrency') ??
              DEFAULT_BATCH_RUN_CONCURRENCY,
            idempotencyKey: cmdOpts.idempotencyKey,
            report,
            reportFile: cmdOpts.reportFile,
            reportSuiteName: cmdOpts.reportSuiteName,
            ghOutput: cmdOpts.ghOutput === true,
            summaryFile: cmdOpts.summaryFile,
            allowEmpty: cmdOpts.allowEmpty === true,
            environment: cmdOpts.env,
            skipPreflight: cmdOpts.skipPreflight === true,
            ...(cmdOpts.skipDependencies === true ? { skipDependencies: true } : {}),
          },
          deps,
        );
        return;
      }

      const commonOpts = resolveCommonOptions(command, deps.env);

      if (isAll || testIds.length > 1) {
        await runTestRunLocalBatch(
          {
            ...commonOpts,
            testIds,
            wait: effectiveWait,
            all: isAll,
            projectId,
            nameFilter,
            noWait: command.getOptionValueSource('wait') === 'cli' && cmdOpts.wait === false,
            concurrencyIsDefault: cmdOpts.maxConcurrency === undefined,
            timeoutIsDefault: cmdOpts.timeout === undefined,
            skipPreflight: cmdOpts.skipPreflight === true,
            tunnelClientId: cmdOpts.tunnelClient,
            cancelOnInterrupt: cmdOpts.cancelOnInterrupt !== false,
            timeoutSeconds:
              cmdOpts.timeout === undefined
                ? DEFAULT_LOCAL_RUN_TIMEOUT_SECONDS
                : parseTimeoutFlag(cmdOpts.timeout, 'timeout'),
            maxConcurrency,
            idempotencyKey: cmdOpts.idempotencyKey,
            report,
            reportFile: cmdOpts.reportFile,
            reportSuiteName: cmdOpts.reportSuiteName,
            ghOutput: cmdOpts.ghOutput === true,
            summaryFile: cmdOpts.summaryFile,
            allowEmpty: cmdOpts.allowEmpty === true,
            environment: cmdOpts.env,
            ...(cmdOpts.skipDependencies === true ? { skipDependencies: true } : {}),
          },
          deps,
        );
        return;
      }

      // Single test-id path (unchanged M3.3 behavior).
      await runTestRun(
        {
          ...commonOpts,
          testId: testIds[0]!,
          skipPreflight: cmdOpts.skipPreflight === true,
          ...(cmdOpts.tunnelClient !== undefined ? { tunnelClientId: cmdOpts.tunnelClient } : {}),
          cancelOnInterrupt: cmdOpts.cancelOnInterrupt !== false,
          wait: effectiveWait,
          noWait: command.getOptionValueSource('wait') === 'cli' && cmdOpts.wait === false,
          timeoutSeconds: parseTimeoutFlag(cmdOpts.timeout, 'timeout'),
          // B2(c): tell runTestRun whether --timeout was explicitly provided.
          timeoutIsDefault: cmdOpts.timeout === undefined,
          idempotencyKey: cmdOpts.idempotencyKey,
          ghOutput: cmdOpts.ghOutput === true,
          summaryFile: cmdOpts.summaryFile,
          environment: cmdOpts.env,
          ...(cmdOpts.skipDependencies === true ? { skipDependencies: true } : {}),
        },
        deps,
      );
    });

  run.hook('preSubcommand', command => {
    const explicit = command.options.find(
      option =>
        command.getOptionValueSource(option.attributeName()) === 'cli' &&
        option.negate === (command.getOptionValue(option.attributeName()) === false),
    );
    if (explicit) {
      throw localValidationError(
        explicit.attributeName(),
        `${explicit.long} is a launch option; put lifecycle options after run wait/cancel`,
      );
    }
  });
  run.addCommand(createRunWaitCommand(deps));
  run.addCommand(createTestCancelCommand(deps));
  return run;
}

export function createRunWaitCommand(deps: TestDeps = {}): Command {
  return new Command('wait')
    .argument('<run-id...>')
    .summary('Wait for one or more whole executions to finish')
    .description(
      'Wait for authoritative execution status, including later integration results.\n' +
        '\nA run id is the runId `run` prints, not an individual resultId.\n' +
        'Each read lists GET /results?run=<run-id>; no individual result cards are polled.\n' +
        'Each distinct run is read independently; runs share one --timeout deadline. Finished rows alone do not finish an execution.\n' +
        'A cancelled execution fails even when its existing results all passed or are empty.\n' +
        '\nJSON contains top-level runs, results and summary. An incomplete wait reports partial: true on timeout or interrupt.\n' +
        '\nExit codes:\n' +
        '  0  executions finished without failed, blocked or cancelled results\n' +
        '  1  a result failed/blocked/cancelled, or an execution was cancelled\n' +
        '  3  authentication or permission failure\n' +
        '  4  an execution ID was not found\n' +
        '  7  deadline expired, or the backend lacks whole-run status\n' +
        ' 10  server or transport unavailable through the deadline\n' +
        ' 11  standing rate limit (a transient throttle exhausting --timeout reports 7)\n' +
        ' 14  client too old\n' +
        '\nInspect details with: testsprite result get <result-id> (add --out <dir> for evidence).\n' +
        'Ctrl-C detaches; executions continue. Resume with: testsprite run wait <run-id...>\n' +
        'Stop them with: testsprite run cancel <run-id...>',
    )
    .option(
      '--timeout <s>',
      `shared seconds to wait for executions (1–3600, default ${DEFAULT_RUN_TIMEOUT_SECONDS})`,
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (runIds: string[], cmdOpts: WaitFlagOpts, command: Command) => {
      await runTestWait(
        {
          ...resolveCommonOptions(command, deps.env),
          runIds,
          timeoutSeconds: parseTimeoutFlag(cmdOpts.timeout, 'timeout'),
        },
        deps,
      );
    });
}

interface RunFlagOpts {
  skipPreflight?: boolean;
  wait?: boolean;
  timeout?: string;
  idempotencyKey?: string;
  /** M4 piece-2: batch fresh run flags. */
  project?: string;
  testlist?: string;
  filter?: string;
  /** Server dispatch concurrency for the selected run mode. */
  maxConcurrency?: string;
  report?: string;
  reportFile?: string;
  reportSuiteName?: string;
  ghOutput?: boolean;
  summaryFile?: string;
  /** Exit 0 instead of failing when the batch dispatches zero tests. */
  allowEmpty?: boolean;
  /** `--tunnel-client <id>`: a tunnel `testsprite tunnel start` holds open. */
  tunnelClient?: string;
  /** Commander's `--no-` negation: `true` unless `--no-cancel-on-interrupt` was passed. */
  cancelOnInterrupt?: boolean;
  /** `--env <name>` — the project environment to run against. */
  env?: string;
  /** `--skip-dependencies`: BE only, run just the named tests. */
  skipDependencies?: boolean;
}

interface WaitFlagOpts {
  timeout?: string;
}

interface ListFlagOpts {
  project: string;
  type?: string;
  pageSize?: string;
  startingToken?: string;
  /**
   * Alias for `--starting-token`, kept for scripts that already pass it.
   * Both flags are forwarded to the same pagination field;
   * `--starting-token` takes precedence when both are supplied (unlikely in
   * practice).
   */
  cursor?: string;
  maxItems?: string;
  columns?: string;
  header?: boolean;
}

function resolveProjectId(projectId: string | undefined, deps: TestDeps): string | undefined {
  const explicit = projectId?.trim();
  if (explicit && explicit.length > 0) return explicit;
  const envValue = (deps.env ?? process.env).TESTSPRITE_PROJECT_ID;
  const trimmed = envValue?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
function requireProjectId(
  projectId: string | undefined,
  message = 'is required; pass --project <id> or set TESTSPRITE_PROJECT_ID',
): asserts projectId is string {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw localValidationError('project', message);
  }
}

/** Every test of one project, narrowed client-side by `--filter` on the title. */
async function resolveAllProjectTests(args: {
  client: HttpClient;
  projectId: string;
  nameFilter?: string;
  stderr: (line: string) => void;
}): Promise<CliTest[]> {
  const { client, projectId, nameFilter, stderr } = args;
  let items: CliTest[] = (
    await paginate<CliTest>(
      async ({ pageSize, cursor }) =>
        client.get<Page<CliTest>>('/tests', {
          query: { projectId, pageSize, cursor },
        }),
      {},
    )
  ).items;
  if (nameFilter !== undefined && nameFilter !== '') {
    const needle = nameFilter.toLowerCase();
    const before = items.length;
    items = items.filter(t => t.title.toLowerCase().includes(needle));
    const skipped = before - items.length;
    if (skipped > 0) {
      stderr(
        `--filter: skipped ${skipped} test${skipped !== 1 ? 's' : ''} not matching "${nameFilter}".`,
      );
    }
  }
  return items;
}

function parseEnumFlag<T extends string>(
  raw: string | undefined,
  flagName: string,
  accepted: ReadonlyArray<T>,
): T | undefined {
  if (raw === undefined) return undefined;
  if (!accepted.includes(raw as T)) {
    throw localValidationError(flagName, `must be one of: ${accepted.join(', ')}`, [...accepted]);
  }
  return raw as T;
}

function parseNumericFlag(raw: string | undefined, flagName: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw localValidationError(flagName, 'must be an integer');
  }
  return n;
}

/** D4: headroom added on top of `--timeout` when deriving the per-request window under `--wait`. */
const WAIT_REQUEST_TIMEOUT_CUSHION_MS = 5_000;

/**
 * D4 (dogfood CoderCup 2026-06-05): under `--wait` the user opts into a
 * long-running operation bounded by `--timeout`. The default 120s per-request
 * timeout can falsely cut a single trigger or long-poll request when the
 * backend is slow under load (e.g. a large concurrent batch) — failing the
 * command even though `--timeout` is large and the run finishes fine
 * server-side. Raise the per-request window to cover `--timeout` (capped at
 * {@link REQUEST_TIMEOUT_MAX_MS}, floored at the resolved default so we never
 * lower it). The whole-run waiter's deadline-aware `AbortSignal` (run-wait.ts) still
 * bounds the TOTAL wait to `--timeout`; non-wait callers are unchanged.
 */
export function resolveWaitRequestTimeoutMs(opts: {
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

function makeClient(
  opts: CommonOptions,
  deps: TestDeps,
  shutdownSignal: AbortSignal = shutdownOf(deps).signal,
): HttpClient {
  return makeHttpClient(opts, {
    env: deps.env,
    credentialsPath: deps.credentialsPath,
    fetchImpl: deps.fetchImpl,
    stderr: deps.stderr,
    shutdownSignal,
  });
}

function makeOutput(mode: OutputMode, deps: TestDeps): Output {
  return new Output(mode, {
    stdout: deps.stdout,
    stderr: deps.stderr,
  });
}

function renderTestTypeCell(test: CliTest): string {
  return test.isIntegration === true ? `${test.type}/int` : test.type;
}

const TEST_LIST_COLUMNS: ReadonlyArray<TextTableColumn<CliTest>> = [
  {
    header: 'ID',
    width: rows => Math.max(2, ...rows.map(test => test.id.length)),
    render: test => test.id,
  },
  {
    header: 'SLUG',
    width: rows => Math.max(4, ...rows.map(test => (test.slug ?? '-').length)),
    render: test => test.slug ?? '-',
  },
  {
    header: 'TITLE',
    width: rows => Math.max(5, ...rows.map(test => terminalWidth(test.title))),
    render: test => test.title,
  },
  {
    header: 'TYPE',
    width: rows => Math.max(8, ...rows.map(test => renderTestTypeCell(test).length)),
    render: renderTestTypeCell,
  },
  {
    header: 'CATEGORY',
    width: rows => Math.max(8, ...rows.map(test => terminalWidth(test.category ?? '-'))),
    render: test => test.category ?? '-',
  },
  { header: 'PRIORITY', width: 8, render: test => test.priority ?? '-' },
  { header: 'VERSION', width: 7, render: test => test.version?.label ?? '-' },
  {
    header: 'STEPS',
    width: 5,
    render: test => (test.stepCount == null ? '-' : String(test.stepCount)),
  },
  {
    header: 'UPDATED',
    width: rows => Math.max(7, ...rows.map(test => test.updatedAt.length)),
    render: test => test.updatedAt,
  },
];

export function renderTestListText(
  page: Page<CliTest>,
  options: { columns?: string; noHeader?: boolean } = {},
): string {
  if (page.items.length === 0) {
    return page.nextToken
      ? `No tests on this page.\nnextToken: ${terminalSafeLine(page.nextToken)}`
      : 'No tests.';
  }
  const lines = [
    renderTextTable(page.items, TEST_LIST_COLUMNS, {
      columns: options.columns,
      noHeader: options.noHeader,
    }),
  ];
  if (page.nextToken) lines.push('', `nextToken: ${terminalSafeLine(page.nextToken)}`);
  return lines.join('\n');
}

/** `test get` in text mode: the case as it is written, one field per line, then its steps. */
function renderTestText(t: CliTest): string {
  const projectLine =
    t.projectName != null && t.projectName.length > 0
      ? `project:     ${terminalSafeLine(t.projectName)} (${terminalSafeLine(t.projectId)})`
      : `projectId:   ${terminalSafeLine(t.projectId)}`;
  const lines = [`id:          ${terminalSafeLine(t.id)}`, projectLine];
  if (t.slug) lines.push(`slug:        ${terminalSafeLine(t.slug)}`);
  lines.push(
    `title:       ${terminalSafeLine(t.title)}`,
    `type:        ${terminalSafeLine(renderTestTypeCell(t))}`,
  );
  if (t.category) lines.push(`category:    ${terminalSafeLine(t.category)}`);
  if (t.priority) lines.push(`priority:    ${terminalSafeLine(t.priority)}`);
  if (t.version) {
    lines.push(`version:     ${terminalSafeLine(t.version.label ?? t.version.hash)}`);
  }
  if (t.description) lines.push(`description: ${terminalSafeLine(t.description)}`);
  const steps = Array.isArray(t.steps) ? (t.steps as unknown[]) : undefined;
  const stepCount = typeof t.stepCount === 'number' ? t.stepCount : steps?.length;
  if (typeof stepCount === 'number') lines.push(`steps:       ${stepCount}`);
  if (steps) {
    steps.forEach((step, index) => {
      if (typeof step !== 'object' || step === null) return;
      const fields = step as Record<string, unknown>;
      const type = typeof fields.type === 'string' ? fields.type : 'step';
      const description =
        typeof fields.description === 'string' ? fields.description : '(no description)';
      const mark = fields.structured === true ? '*' : ' ';
      lines.push(
        `${mark} ${index + 1}. [${terminalSafeLine(type)}] ${terminalSafeLine(description)}`,
      );
    });
    const structuredCount = steps.filter(
      step =>
        typeof step === 'object' && step !== null && (step as CliPlanStep).structured === true,
    ).length;
    if (structuredCount > 0) {
      lines.push(`* ${structuredCount} step(s) carry structured fields.`);
    }
  }
  if (typeof t.stepTimeoutMs === 'number') {
    lines.push(`stepTimeout: ${t.stepTimeoutMs} ms (applies to every step)`);
  }
  if (Array.isArray(t.produces) && t.produces.length > 0) {
    lines.push(`produces:    ${terminalSafeLine(t.produces.join(', '))}`);
  }
  if (Array.isArray(t.consumes) && t.consumes.length > 0) {
    lines.push(`consumes:    ${terminalSafeLine(t.consumes.join(', '))}`);
  }
  lines.push(
    `createdAt:   ${terminalSafeLine(t.createdAt)}`,
    `updatedAt:   ${terminalSafeLine(t.updatedAt)}`,
  );
  return lines.join('\n');
}
