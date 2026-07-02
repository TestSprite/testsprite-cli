import { createWriteStream, readFileSync, readdirSync, statSync, type WriteStream } from 'node:fs';
import { rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import {
  emitDryRunBanner,
  makeHttpClient,
  parseRequestTimeoutFlag,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import {
  assertContextIntegrity,
  buildMeta,
  pickCodeExtension,
  resolveBundleDir,
  stepFilenamePrefix,
  writeBundle,
  type WriteBundleResult,
} from '../lib/bundle.js';
import { findSample } from '../lib/dry-run/samples.js';
import {
  ApiError,
  CLIError,
  RequestTimeoutError,
  TransportError,
  localValidationError,
} from '../lib/errors.js';
import {
  assertIdempotencyKey,
  requireArrayLength,
  requireEnum,
  requireString,
} from '../lib/validate.js';
import { REQUEST_TIMEOUT_DEFAULT_MS, REQUEST_TIMEOUT_MAX_MS } from '../lib/http.js';
import type { FetchImpl } from '../lib/http.js';
import type { HttpClient } from '../lib/http.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode, type OutputMode } from '../lib/output.js';
import {
  fetchSinglePage,
  paginate,
  validatePaginationFlags,
  type Page,
  type PaginationFlags,
} from '../lib/pagination.js';
import { pollRunUntilTerminal, TimeoutError } from '../lib/poll.js';
import type {
  RunResponse,
  RunStatus,
  RunStepDto,
  TriggerRunResponse,
  RerunResponse,
  BatchRerunResponse,
  BatchRerunAccepted,
  BatchRerunClosureByProject,
  RerunClosureMember,
  ListRunsResponse,
  RunHistoryItem,
  RunSource,
  BatchRunFreshResponse,
  BatchRunFreshAccepted,
} from '../lib/runs.types.js';
import { RUN_SOURCES } from '../lib/runs.types.js';
import { assertNotLocal } from '../lib/target-url.js';
import { createTicker } from '../lib/ticker.js';
import { RateThrottle } from '../lib/rate-throttle.js';
import { resolvePortalBase, resolvePortalUrl } from '../lib/facade.js';
import { loadConfig } from '../lib/config.js';

/**
 * `details` debug block per the CLI OpenAPI `Test` schema
 * (M2.1 amendment). `processingStatus` / `testStatus` are the
 * structured pair; either may be `null` when the source row has no
 * analog (MCP rows have no separate processStatus). `rawStatus` is
 * the deprecated pre-M2.1 mirror, kept one minor for callers that
 * already parse it. All three are debug-only — automation depends on
 * the typed top-level `status` field.
 */
export interface CliTestStatusDetails {
  processingStatus: string | null;
  testStatus: string | null;
  rawStatus: string;
}

/**
 * Public Test shape per the CLI OpenAPI `Test` schema.
 * `details` is optional debug context — automation must depend only on
 * the typed top-level fields. `createdFrom` takes one of the three
 * documented values (`portal` | `mcp` | `cli`); anything else is a
 * contract violation worth surfacing rather than silently coercing.
 */
export interface CliTest {
  id: string;
  projectId: string;
  /**
   * §6.2 / M2.1 piece 4 — human-friendly project name. `null` when
   * project lookup wasn't possible (record missing, ownership
   * boundary, or pre-M2.1 backend that never populated the field).
   * Optional on the wire so older facades that don't ship the field
   * still type-check; the renderer falls back to `projectId` when
   * absent.
   */
  projectName?: string | null;
  name: string;
  type: 'frontend' | 'backend';
  createdFrom: 'portal' | 'mcp' | 'cli';
  status: CliPublicStatus;
  createdAt: string;
  updatedAt: string;
  /**
   * M3.4 — number of FE plan steps, or `null` for BE tests and rows
   * without plan steps. Optional on the wire so pre-M3.4 facades that
   * don't ship it still type-check; text mode shows it only when present
   * and non-null. The dedicated read path for recovering the current
   * count after a `test plan put --expected-step-count` 412.
   */
  planStepCount?: number | null;
  /**
   * M2.1: structured `processingStatus` / `testStatus` pair plus the
   * deprecated `rawStatus` mirror. Pre-M2.1 servers may still emit
   * `{ rawStatus }` only — keep the structured fields optional on
   * the wire even though M2.1 servers always populate them. The CLI
   * accepts both shapes.
   */
  details?: Partial<CliTestStatusDetails>;
  /**
   * G1a — test priority label, e.g. "p0" | "p1" | "p2" | "p3".
   * Optional on the wire: pre-G1a backends omit the field; `null` means
   * no priority has been set. Text mode surfaces it only when truthy.
   */
  priority?: string | null;
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

/**
 * §6.3 TestCode wire shape. `code` is either the inline source body
 * (when < 100 KB) or a presigned `https://` URL (when >= 100 KB). The
 * caller distinguishes via {@link isPresignedCodeUrl}.
 */
export interface CliTestCode {
  testId: string;
  language: 'typescript' | 'javascript' | 'python';
  framework: 'playwright' | 'pytest';
  code: string;
  codeVersion: string | null;
  etag?: string | null;
}

/** §6.4 TestStep wire shape. `null` is "not known", not "absent". */
export interface CliTestStep {
  testId: string;
  stepIndex: number;
  action: string;
  description: string;
  status: 'passed' | 'failed' | null;
  screenshotUrl: string | null;
  htmlSnapshotUrl: string | null;
  runIdIfAvailable: string | null;
  codeVersion: string | null;
  capturedAt: string | null;
  updatedAt: string;
  /**
   * §6.4 / M2.1 piece 4 — derived flag the facade owns. `true` only on
   * step(s) that actually contributed to the test failure. `null`
   * when the underlying backend row hasn't been classified yet (pre-
   * M2.1 persistence). Optional on the wire so pre-M2.1 servers
   * that don't emit the field still type-check.
   */
  outcomeContributesToFailure?: boolean | null;
}

/**
 * §6.5 failureKind enum (M2.1 piece 4 widened from six to nine values).
 * The CLI accepts unrecognized strings from the wire as `unknown` so
 * adding a future enum value (e.g. `quota_exceeded`) is non-breaking
 * — agents must not switch on raw strings outside the enumerated set.
 */
export type CliFailureKind =
  | 'assertion'
  | 'assertion_blocked' // M2.1 piece 4
  | 'routing_404' // M2.1 piece 4
  | 'network_timeout' // M2.1 piece 4
  | 'network'
  | 'timeout'
  | 'browser_crash'
  | 'infra'
  | 'unknown'
  | null;

/** test VERDICT (the outcome of a completed run). */
export type CliVerdict = 'passed' | 'failed' | 'blocked';

/** execution LIFECYCLE (where the test is in its run lifecycle). */
export type CliExecutionStatus =
  | 'draft'
  | 'ready'
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'unknown';

/** §6.5 LatestResult wire shape. All correlation fields are required. */
export interface CliLatestResult {
  testId: string;
  status: CliPublicStatus;
  startedAt: string | null;
  finishedAt: string | null;
  videoUrl: string | null;
  failureAnalysisUrl: string | null;
  snapshotId: string;
  runIdIfAvailable: string | null;
  codeVersion: string | null;
  /**
   * The target URL used for this run. May be `null` when `targetUrlSource`
   * is `'unresolved'` (the stored run row had no target URL and the backend
   * did not fall back to the project default).
   */
  targetUrl: string | null;
  /**
   * D1 — provenance of `targetUrl`. Present on backends that have shipped
   * the D1 fix; omitted on older backends (treat as unknown when absent).
   *
   * - `'run'`             — URL was stored explicitly on the TestRun row.
   * - `'project-default'` — URL came from the project's configured default.
   * - `'unresolved'`      — no URL on the run row AND no project default;
   *                         `targetUrl` will be `null`.
   * - `null`              — backend sent the field explicitly as null
   *                         (semantically equivalent to `'unresolved'`).
   */
  targetUrlSource?: 'run' | 'project-default' | 'unresolved' | null;
  failedStepIndex: number | null;
  failureKind: CliFailureKind;
  /**
   * the test VERDICT only (`passed | failed | blocked`), or `null`
   * when the latest run produced no verdict yet (never run / queued / running /
   * cancelled). Lifecycle lives in `executionStatus`; `status` above is the
   * legacy conflated field, retained for back-compat.
   */
  verdict: CliVerdict | null;
  /** the execution LIFECYCLE (terminal runs collapse to `completed`). */
  executionStatus: CliExecutionStatus;
  /**
   * a human/agent-readable description of the latest run (replaces the
   * former `{passed,failed,skipped}` count object).
   */
  summary: string;
  /**
   * §6.5.1 (M2.1 piece 3) — inline failure analysis. Present when the
   * caller passed `--include-analysis` (`?includeAnalysis=true` on
   * the wire); absent on the byte-identical-to-pre-M2.1 default.
   */
  analysis?: CliAnalysisBlock;
}

/**
 * §6.5.1 (M2.1 piece 3) — analysis fields surfaced inline on
 * `/result?includeAnalysis=true` and as the body of `/failure/summary`.
 *
 * Stable shape: ships even on passing/in-flight runs with every field
 * inside `null`. `recommendedFixTarget` is `null` (not the always-
 * `unknown` wrapper) when the analysis pipeline didn't fill it.
 * `failureKind` mirrors `LatestResult.failureKind` for caller
 * convenience. `snapshotId` mirrors the outer snapshot, so a caller
 * comparing the inline analysis with a later `/failure` bundle can
 * detect drift without a second round-trip.
 */
export interface CliAnalysisBlock {
  rootCauseHypothesis: string | null;
  recommendedFixTarget: CliFixTarget | null;
  failureKind: CliFailureKind;
  snapshotId: string;
  /**
   * L141 — set to `true` (JSON output only) when `rootCauseHypothesis`
   * ends with `…` (U+2026), indicating the server truncated the text.
   * Omitted when the field is null or untouched. This is a CLI-side
   * observation; the server does not send this field. Full untruncated
   * text requires backend support (backend follow-up).
   */
  rootCauseHypothesisTruncated?: true;
  /**
   * L141 — set to `true` (JSON output only) when
   * `recommendedFixTarget.rationale` ends with `…` (U+2026), indicating
   * the server truncated the rationale. Omitted when not truncated.
   */
  recommendedFixRationaleTruncated?: true;
}

/**
 * §5.2 (M2.1 piece 3) — body of `GET /tests/{testId}/failure/summary`.
 * One-screen agent triage answer: status + failureKind + analysis,
 * no bundle. Sibling of `failure get` for cases where the agent's
 * first pass doesn't need video / screenshots / DOM snapshots.
 */
export interface CliFailureSummary {
  testId: string;
  status: CliPublicStatus;
  failureKind: CliFailureKind;
  snapshotId: string;
  rootCauseHypothesis: string | null;
  recommendedFixTarget: CliFixTarget | null;
}

/** §6.7 narrow fix-target enum. Agents route on this; M2 emits 'unknown'. */
export type CliFixKind = 'code' | 'selector' | 'data' | 'env' | 'unknown';
export type CliEvidenceKind = 'screenshot' | 'snapshot' | 'log' | 'network' | 'console';

export interface CliFixTarget {
  kind: CliFixKind;
  reference: string | null;
  rationale: string | null;
}

export interface CliEvidence {
  kind: CliEvidenceKind;
  /** 1-based step index — matches portal display. */
  stepIndex: number;
  /** Presigned S3 URL with shared 15-min TTL. */
  url: string;
  /**
   * LLM-generated transcription per §6.1. The CLI emits whatever the
   * facade returned — never edited or generated client-side.
   */
  summary: string;
}

export interface CliFailureBlock {
  rootCauseHypothesis: string | null;
  /**
   * §6.7 / M2.1 piece 3 visibility policy: `null` when the analysis
   * pipeline didn't fill any of `kind` / `reference` / `rationale`.
   * Pre-M2.1 the facade always emitted an `unknown` wrapper here;
   * M2.1 drops it so agents route on `null` rather than parsing the
   * always-unknown shape.
   */
  recommendedFixTarget: CliFixTarget | null;
  evidence: CliEvidence[];
}

/** §6.7 wire shape — one atomic snapshot of the latest failing run. */
export interface CliFailureContext {
  snapshotId: string;
  testId: string;
  projectId: string;
  result: CliLatestResult;
  steps: CliTestStep[];
  code: CliTestCode;
  failure: CliFailureBlock;
}

export interface TestDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /**
   * Raw stdout writer for streaming code bodies in `test code get`. No
   * implicit newline; each call writes verbatim. Defaults to
   * `process.stdout.write`. See `Output.writeChunk` for rationale.
   */
  rawStdout?: (text: string) => void;
  /**
   * Injectable sleep function for the polling loop. Defaults to the
   * `defaultSleep` in `poll.ts` (`setTimeout`-based). Inject an instant
   * no-op in tests to avoid real delays.
   */
  sleep?: (ms: number) => Promise<void>;
}

type CommonOptions = FactoryCommonOptions;

interface ListOptions extends CommonOptions {
  projectId: string;
  type?: 'frontend' | 'backend';
  createdFrom?: 'portal' | 'mcp' | 'cli';
  /**
   * §6.6 / M2.1 piece 2 — comma-separated list of public status
   * values (e.g. `failed,blocked`). The CLI passes the raw string to
   * the facade which validates token-by-token. Pre-validating client-
   * side gives a friendlier error for typos like `--status fail`.
   */
  status?: string;
  pageSize?: number;
  startingToken?: string;
  maxItems?: number;
}

const TEST_TYPES: ReadonlyArray<'frontend' | 'backend'> = ['frontend', 'backend'];
// 'cli' added 2026-06-04 (dogfood): backend now stamps createFrom='cli' on
// tests created via `testsprite test create`, so the `--created-from cli`
// list filter must accept it. See backend-v2.0 CLI_CREATED_FROMS.
const CREATED_FROMS: ReadonlyArray<'portal' | 'mcp' | 'cli'> = ['portal', 'mcp', 'cli'];
/**
 * §6.6 / M2.1 piece 2 — public status values accepted by the
 * `--status` filter. Mirrors `CLI_PUBLIC_STATUSES` on the facade
 * side (cli-tests.types.ts). Client-side validation gives a friendly
 * error before the request hits the wire — the facade rejects the
 * same set with VALIDATION_ERROR.
 */
const PUBLIC_STATUSES: ReadonlyArray<CliPublicStatus> = [
  'draft',
  'ready',
  'queued',
  'running',
  'passed',
  'failed',
  'blocked',
  'cancelled',
  'unknown',
];

/**
 * Internal helper: resolve the effective API URL from command opts.
 * Mirrors the resolution logic in `makeHttpClient` so we can compute a
 * `dashboardUrl` without accessing the private `client.baseUrl`.
 * Calls `loadConfig` which reads the credentials file (cheap, cached by OS).
 * Used only at the emit stage, AFTER the main request completes.
 */
function resolveApiUrl(opts: CommonOptions, deps: TestDeps = {}): string {
  if (opts.dryRun) return opts.endpointUrl ?? 'https://api.testsprite.com';
  const config = loadConfig({
    profile: opts.profile,
    endpointUrl: opts.endpointUrl,
    env: (deps as { env?: NodeJS.ProcessEnv }).env,
    credentialsPath: (deps as { credentialsPath?: string }).credentialsPath,
  });
  return config.apiUrl;
}

export async function runList(opts: ListOptions, deps: TestDeps = {}): Promise<Page<CliTest>> {
  // Validate inputs before touching credentials so a missing `--project`
  // surfaces as `VALIDATION_ERROR` (exit 5) rather than `AUTH_REQUIRED`
  // (exit 3) when the caller also lacks a configured key. Order matters
  // for the CLI error spec §2 — bad input is a caller bug, not an auth
  // gate.
  requireProjectId(opts.projectId);

  const paginationFlags: PaginationFlags = validatePaginationFlags({
    pageSize: opts.pageSize,
    startingToken: opts.startingToken,
    maxItems: opts.maxItems,
  });

  const out = makeOutput(opts.output, deps);
  const client = makeClient(opts, deps);

  // Match P2's "explicit pageSize ⇒ single-page" convention so an
  // operator can grab one slice + cursor without auto-paging through a
  // huge project.
  const useSinglePage = opts.pageSize !== undefined && opts.maxItems === undefined;

  // M2.1 piece 2: validate `--status` tokens client-side before
  // sending. Friendlier error than waiting for the server's 400 with
  // a list of accepted tokens — and lets the user fix typos without
  // a round trip.
  validateStatusFilter(opts.status);

  const baseQuery: Record<string, string | number | boolean | undefined> = {
    projectId: opts.projectId,
    type: opts.type,
    createdFrom: opts.createdFrom,
    status: opts.status,
  };

  let page: Page<CliTest>;
  if (useSinglePage) {
    page = await fetchSinglePage<CliTest>(
      client,
      '/tests',
      paginationFlags.pageSize!,
      opts.startingToken,
      baseQuery,
    );
  } else {
    page = await paginate<CliTest>(
      async ({ pageSize, cursor }) =>
        client.get<Page<CliTest>>('/tests', {
          query: { ...baseQuery, pageSize, cursor },
        }),
      paginationFlags,
    );
  }

  out.print(page, data => renderTestListText(data as Page<CliTest>));
  return page;
}

/**
 * §6.X / M3.2 piece-2 `CreateTestResponse` shape. `codeVersion` is the
 * monotonic stamp piece-1 added to FE/BE Portal rows; the CLI re-uses
 * it as the `If-Match` etag on `test code put` (piece-4).
 */
export interface CliCreateTestResponse {
  testId: string;
  type: 'frontend' | 'backend';
  codeVersion: string;
  createdAt: string;
}

export const CLI_CREATE_PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
export type CliCreatePriority = (typeof CLI_CREATE_PRIORITIES)[number];

/**
 * 350 KB inline-code cap. Mirrors `MAX_INLINE_CODE_BYTES` in the backend
 * (`CliTestsController`), which is sized to fit a full test row inside
 * DDB's 400 KB item limit after metadata headroom. Enforced client-side
 * as a pre-flight check so an obvious oversize file fails fast (exit 5)
 * without spending a round-trip. The server enforces the same cap
 * defensively. Lowered from 1 MB → 350 KB in backend PR #464; this CLI
 * constant tracks it.
 */
const MAX_INLINE_CODE_BYTES = 350 * 1024;

interface CreateOptions extends CommonOptions {
  projectId: string;
  type: 'frontend' | 'backend';
  name: string;
  description?: string;
  priority?: CliCreatePriority;
  /** Source path to the test code. Read into memory; capped at 350 KB. */
  codeFile: string;
  /** Caller-supplied idempotency token; UUIDv4 minted client-side if absent. */
  idempotencyKey?: string;
  /** M3.3 chain: trigger a run after create. */
  run?: boolean;
  /** M3.3 chain: poll until terminal when `run` is true. */
  wait?: boolean;
  /** M3.3 chain: per-run timeout in seconds. */
  timeout?: number;
  /**
   * M4 piece-2 — BE dependency authoring flags.
   * `--produces <var>` (repeatable): variable names this test captures.
   * Maps to wire field `produces` → backend serialises as `captures` JSON.
   * Backend-only; supplying with --type frontend → exit 5 (FE has no wave model).
   */
  produces?: string[];
  /**
   * `--needs <var>` (repeatable): variable names this test consumes.
   * Maps to wire field `consumes`. Backend-only.
   */
  needs?: string[];
  /**
   * `--category <str>`: free-text category. Use `teardown`/`cleanup` to mark
   * a last-wave cleanup test in the wave planner. Backend-only.
   */
  category?: string;
  /**
   * B2(c): true when --timeout was NOT explicitly set (the default is in
   * effect). Threaded into RunTestRunOptions so the first-run hint fires.
   */
  timeoutIsDefault?: boolean;
  /** M3.3 chain: per-run target URL override. */
  targetUrl?: string;
}

/**
 * Chained `test create --run` / `test create --plan-from --run` derive the
 * trigger idempotency key as `<createKey>:run`. Validate that derived key
 * BEFORE the create POST so a near-limit user-supplied base key fails fast
 * (exit 5) instead of creating the test and THEN rejecting the 257+ char
 * derived run key — which would leave an orphan test with no run (codex #128
 * P2). Auto-minted keys (no `--idempotency-key` supplied) are always short and
 * thus exempt. `RUN_SUFFIX` must match the `:run` suffix appended in
 * `runCreate` / `runCreateFromPlan` when chaining into `runTestRun`.
 */
function assertChainedRunKeyFits(
  run: boolean | undefined,
  idempotencyKey: string | undefined,
): void {
  if (run !== true || idempotencyKey === undefined) return;
  const RUN_SUFFIX = ':run';
  if (idempotencyKey.length + RUN_SUFFIX.length > 256) {
    throw localValidationError(
      'idempotencyKey',
      `must be at most ${256 - RUN_SUFFIX.length} characters when used with --run ` +
        `(the chained trigger derives "<key>${RUN_SUFFIX}", which must stay within the 256-char limit)`,
      undefined,
      'flag',
    );
  }
}

/**
 * B3 / Fix 4: best-effort duplicate-name advisory shared by `runCreate`
 * and `runCreateFromPlan`. One-page lookup (pageSize=100) — not
 * exhaustive but cheap. Silently swallows all errors; must never block
 * or fail the caller's create.
 *
 * Skip when `projectId` or `name` is absent (e.g. plan not yet parsed)
 * or when the caller is in dry-run mode.
 */
/** Short deadline for the advisory duplicate-name lookup (5 s). */
const DUP_NAME_ADVISORY_TIMEOUT_MS = 5_000;

async function emitDupNameAdvisoryIfNeeded(
  client: HttpClient,
  projectId: string | undefined,
  name: string | undefined,
  stderrFn: (line: string) => void,
): Promise<void> {
  if (!projectId || !name) return;
  // B: the advisory lookup must NEVER block the create critical path.
  // Use an AbortController with a 5 s deadline. When the timer fires it
  // calls ac.abort(), which causes client.get (via the `signal` option) to
  // throw an AbortError — caught below and swallowed. This ensures a stalled
  // or retrying listing endpoint can't delay an otherwise-healthy create by
  // the full request-timeout (120 s) or multiple transport retries.
  // No secondary setTimeout is used to avoid leaking timers in tests.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DUP_NAME_ADVISORY_TIMEOUT_MS);
  try {
    const listing = await client.get<{ items: CliTest[] }>(
      `/tests?projectId=${encodeURIComponent(projectId)}&pageSize=100`,
      { signal: ac.signal },
    );
    const nameLower = name.toLowerCase();
    const match = listing.items?.find(t => t.name.toLowerCase() === nameLower);
    if (match) {
      stderrFn(
        `[advisory] A test named "${name}" already exists in this project (testId: ${match.id}). ` +
          `Use \`testsprite test update ${match.id}\` to modify it, or proceed to create a duplicate.`,
      );
    }
  } catch {
    // Swallow — this is best-effort; must not block the create.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `test create --code-file <path>` — M3.2 piece-2 first mutation.
 *
 * Reads the file (with the same 350 KB pre-flight the server enforces)
 * and POSTs to `/api/cli/v1/tests` with an `Idempotency-Key` header.
 * Default key is `cli-create-<uuidv4>`; a caller-supplied
 * `--idempotency-key` lets retry tooling pin the same key across
 * attempts so a network blip doesn't double-create. The exact key sent
 * is echoed to stderr at `--debug` so an operator can reuse it.
 *
 * Dry-run: the request still goes through `HttpClient.post`, but the
 * `client-factory` swaps in `createDryRunFetch` so no network call
 * happens — the caller sees the canned response shape from
 * `src/lib/dry-run/samples.ts`. The `--debug` events emit the canonical
 * request envelope (URL, method, headers including Idempotency-Key)
 * so the user can verify what would be sent. Matches the M2 P6
 * convention; no separate "envelope-only" output mode.
 */
export async function runCreate(
  opts: CreateOptions,
  deps: TestDeps = {},
): Promise<CliCreateTestResponse> {
  // P1-2: validate idempotency key before any I/O — non-ASCII chars cause a
  // ByteString TypeError at the HTTP transport layer (exit 10 UNAVAILABLE).
  assertIdempotencyKey(opts.idempotencyKey);
  // codex #128 P2: the `--run` chain derives `<key>:run` (see below); validate
  // that derived key BEFORE the create POST so a near-limit base key fails fast
  // (exit 5) instead of creating the test and THEN rejecting the 257+ char run
  // key — which would orphan a created test with no run.
  assertChainedRunKeyFits(opts.run, opts.idempotencyKey);
  // Validate inputs before touching credentials or fs — matches the
  // M2 read commands' "input gates first, then auth, then I/O" ordering.
  requireProjectId(opts.projectId);
  requireNonEmpty('name', opts.name);
  // P1-3: client-side length checks matching server limits (name ≤200,
  // description ≤2000) so the user gets instant, actionable errors instead
  // of a cryptic server validation message.
  if (opts.name !== undefined && opts.name.length > 200) {
    throw localValidationError('name', 'must be at most 200 characters');
  }
  if (opts.description !== undefined && opts.description.length > 2000) {
    throw localValidationError('description', 'must be at most 2000 characters');
  }
  // P2-11: extend the required-flag error message to suggest --plan-from for
  // FE tests so operators who missed that flag get an actionable hint.
  if (typeof opts.codeFile !== 'string' || opts.codeFile.length === 0) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request.',
        nextAction:
          'Flag `--code-file` is invalid: is required. ' +
          'For frontend tests you can also supply the plan with `--plan-from <plan.json>` instead of a code file.',
        requestId: 'local',
        details: { field: 'codeFile', reason: 'is required' },
      },
    });
  }
  assertPythonCodeFile(opts.codeFile);
  if (!['frontend', 'backend'].includes(opts.type)) {
    throw localValidationError('type', 'must be one of: frontend, backend', [
      'frontend',
      'backend',
    ]);
  }
  if (opts.priority !== undefined && !CLI_CREATE_PRIORITIES.includes(opts.priority)) {
    throw localValidationError('priority', `must be one of: ${CLI_CREATE_PRIORITIES.join(', ')}`, [
      ...CLI_CREATE_PRIORITIES,
    ]);
  }

  // M4 piece-2: --produces/--needs/--category are backend-only. FE plans have
  // no wave model; fail-fast client-side to match the backend's 400 reject and
  // save a round-trip.
  if (opts.type === 'frontend') {
    const depFlags: string[] = [];
    if (opts.produces !== undefined && opts.produces.length > 0) depFlags.push('--produces');
    if (opts.needs !== undefined && opts.needs.length > 0) depFlags.push('--needs');
    if (opts.category !== undefined) depFlags.push('--category');
    if (depFlags.length > 0) {
      throw localValidationError(
        depFlags[0]!,
        `${depFlags.join(', ')} are backend-only flags; frontend plans have no wave model. ` +
          `Remove ${depFlags.join('/')} or use --type backend.`,
      );
    }
  }

  // Dry-run path skips fs entirely so the operator can shake out the
  // wire shape with a dummy `--code-file` (matches the M2 P6 dry-run
  // contract — no real credentials, no real disk). The canned response
  // from `src/lib/dry-run/samples.ts` echoes the same response shape
  // a real call would produce.
  const code = opts.dryRun ? DRY_RUN_PLACEHOLDER_CODE : readCodeFileGuarded(opts.codeFile);

  const idempotencyKey = opts.idempotencyKey ?? `cli-create-${randomUUID()}`;
  // Surface the idempotency key on stderr so an operator who hits a
  // transport-level retry-budget exhaustion can re-run with the same
  // `--idempotency-key`. Without this, a generated UUID dies inside the
  // process and a retry would mint a fresh key — duplicating the test
  // if the original POST reached the server before the retry budget
  // ran out. Stderr (not stdout) keeps json-mode output clean.
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  const body: Record<string, unknown> = {
    projectId: opts.projectId,
    type: opts.type,
    name: opts.name,
    description: opts.description,
    priority: opts.priority,
    code,
  };

  // M4 piece-2: thread BE dependency fields into the POST body.
  // Only include when non-empty so the wire stays clean for tests that
  // don't declare any dependencies (undefined is omitted by JSON.stringify).
  if (opts.produces !== undefined && opts.produces.length > 0) {
    body.produces = opts.produces;
  }
  if (opts.needs !== undefined && opts.needs.length > 0) {
    body.consumes = opts.needs;
  }
  if (opts.category !== undefined) {
    body.category = opts.category;
  }

  if (opts.targetUrl !== undefined) {
    assertNotLocal(opts.targetUrl);
  }

  // C1: --target-url is inert for backend tests (base URL is baked into the
  // test code; the backend sandbox never receives targetUrl). Emit a
  // pre-flight advisory so the user doesn't silently get the wrong env.
  // Only fires when --run is also set, because targetUrl only matters at run
  // time; a bare `test create --type backend --target-url` without --run does
  // not execute the test, so the advisory would be confusing noise.
  if (opts.type === 'backend' && opts.targetUrl !== undefined && opts.run === true) {
    const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderrFn(
      "[advisory] --target-url has no effect for backend tests (a backend test's base URL is defined inside its code).",
    );
  }

  const client = makeClient(opts, deps);
  const out = makeOutput(opts.output, deps);

  // B3: best-effort duplicate-name advisory. Skip under --dry-run.
  if (!opts.dryRun) {
    const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    await emitDupNameAdvisoryIfNeeded(client, opts.projectId, opts.name, stderrFn);
  }

  const response = await client.post<CliCreateTestResponse>('/tests', {
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });

  // --run chain (M3.3 piece-3). Per codex round-1 P1: suppress the
  // create's own print when chaining; `runTestRun` emits a single
  // merged envelope `{ ...createResponse, run: <trigger|final> }` so
  // `--output json` stays parseable for agents and scripts.
  if (opts.run === true) {
    const runIdempotencyKey = `${idempotencyKey}:run`;
    // R3a: compute dashboardUrl before the early return so it flows into
    // the merged { ...createContext, run } envelope in JSON mode and
    // appears on the Dashboard: stderr line in text mode.
    // R1: suppress under --dry-run (fake canned test id).
    const chainDashboardUrl = opts.dryRun
      ? undefined
      : resolvePortalUrl(resolveApiUrl(opts, deps), opts.projectId, response.testId);
    const createContextWithUrl =
      chainDashboardUrl !== undefined ? { ...response, dashboardUrl: chainDashboardUrl } : response;
    await runTestRun(
      {
        ...opts,
        testId: response.testId,
        idempotencyKey: runIdempotencyKey,
        timeoutSeconds: opts.timeout ?? DEFAULT_RUN_TIMEOUT_SECONDS,
        // B2(c): pass through whether --timeout was explicitly set.
        // opts.timeout is already a parsed number (never undefined here) so we
        // thread the dedicated flag rather than checking undefined again.
        timeoutIsDefault: opts.timeoutIsDefault ?? false,
        wait: opts.wait === true,
        createContext: createContextWithUrl,
        // Thread the known type so fast BE runs (terminal on first poll, where
        // beFallbackUsed would be false) still render `steps: n/a (backend)`.
        type: opts.type,
      },
      deps,
    );
    return response;
  }

  // Fix 5: emit dashboard deep-link when projectId + testId are known client-side
  // (no extra network call — both come from opts / response).
  // R1: suppress under --dry-run — the test id is a fake canned value
  // (e.g. "test_dryrun_create_2026") and a live-looking URL would mislead.
  const dashboardUrl = opts.dryRun
    ? undefined
    : resolvePortalUrl(resolveApiUrl(opts, deps), opts.projectId, response.testId);
  if (opts.output === 'json') {
    out.print(dashboardUrl !== undefined ? { ...response, dashboardUrl } : response, data =>
      renderCreateText(data as CliCreateTestResponse),
    );
  } else {
    out.print(response, data => renderCreateText(data as CliCreateTestResponse));
    if (dashboardUrl !== undefined) {
      const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
      stderrFn(`Dashboard: ${dashboardUrl}`);
    }
  }
  return response;
}

/**
 * Stand-in `code` body used by `--dry-run`. The dry-run fetch impl
 * never inspects the request body, so the value is just a placeholder
 * — kept readable for debug-event captures.
 */
const DRY_RUN_PLACEHOLDER_CODE = '// dry-run placeholder code body';

function assertPythonCodeFile(path: string): void {
  if (!path.toLowerCase().endsWith('.py')) {
    throw localValidationError(
      'code-file',
      'must be a Python (.py) file — TestSprite runs all test code as Python ' +
        '(frontend: Playwright for Python; backend: requests + pytest).',
    );
  }
}

/**
 * Read the code body with a `stat`-first size guard so an oversize
 * artifact is rejected BEFORE we load + decode the whole thing into
 * memory. `readCodeFile` was the original sole-source — now wraps the
 * guard so the same VALIDATION_ERROR / PAYLOAD_TOO_LARGE shapes the
 * tests assert on still flow through.
 */
function readCodeFileGuarded(path: string): string {
  const absolute = resolveAbsolute(path);
  let stat;
  try {
    stat = statSync(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw localValidationError('code-file', `file does not exist: ${path}`);
    }
    if (code === 'EACCES') {
      throw localValidationError('code-file', `permission denied reading ${path}`);
    }
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw localValidationError('code-file', `cannot stat ${path}: ${reason}`);
  }
  if (stat.size > MAX_INLINE_CODE_BYTES) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Inline code exceeds the 350 KB CLI cap (${stat.size} bytes).`,
        nextAction: 'Upload via the Portal, or split into smaller tests.',
        requestId: 'local',
        details: { field: 'code-file', sizeBytes: stat.size, maxBytes: MAX_INLINE_CODE_BYTES },
      },
    });
  }
  return readCodeFile(absolute);
}

function readCodeFile(path: string): string {
  try {
    return stripBom(readFileSync(resolveAbsolute(path), 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw localValidationError('code-file', `file does not exist: ${path}`);
    }
    if (code === 'EACCES') {
      throw localValidationError('code-file', `permission denied reading ${path}`);
    }
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw localValidationError('code-file', `cannot read ${path}: ${reason}`);
  }
}

function resolveAbsolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/**
 * Drop a leading UTF-8 BOM (U+FEFF) from a freshly-read file. PowerShell 5.1's
 * default `Set-Content -Encoding utf8` writes a BOM; without this strip,
 * `JSON.parse` fails with an invisible "Unexpected token" error that renders
 * as a blank character on most consoles. Most JSON parsers strip BOM at this
 * boundary — we just bring this one in line.
 */
function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function requireNonEmpty(flagName: string, value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw localValidationError(flagName, 'is required');
  }
}

/**
 * `test create` text-mode rendering. JSON-mode callers (the agent
 * surface) get the wire shape verbatim via `out.print`; text mode is
 * the human surface — one line per field, no shell-incompatible chars.
 */
function renderCreateText(response: CliCreateTestResponse): string {
  return [
    `testId      ${response.testId}`,
    `type        ${response.type}`,
    `codeVersion ${response.codeVersion}`,
    `createdAt   ${response.createdAt}`,
  ].join('\n');
}

/**
 * §6.X / M3.2 piece-6 — response from `PUT /tests/{id}/plan-steps`.
 * `planStepsHash` is a sha256 over the canonicalized new array so
 * agents can detect their own no-op replays without an extra read.
 * `stepCount` is the post-update array length.
 */
export interface CliPutPlanStepsResponse {
  testId: string;
  planStepsHash: string;
  stepCount: number;
  updatedAt: string;
}

/**
 * piece-6 cap for the `PUT /tests/{id}/plan-steps` body. Distinct from
 * piece-5's `MAX_PLAN_BODY_BYTES` because the wire shape differs
 * slightly (no projectId / name / etc. on the replace path).
 */
const MAX_PLAN_STEPS_BODY_BYTES = 256 * 1024;

interface PlanPutOptions extends CommonOptions {
  testId: string;
  /** Source path to the new plan-step JSON file (`{ planSteps: [...] }`). */
  stepsFile: string;
  /**
   * Optional defensive concurrency check. Server rejects with 412
   * when the current entity's `planSteps.length !== N`. FE has no
   * `codeVersion`, so this is the only consistency knob.
   */
  expectedStepCount?: number;
  /** Caller-supplied idempotency token; UUIDv4 minted client-side if absent. */
  idempotencyKey?: string;
  /**
   * When set alongside `--dry-run`, synthesises a 412 error envelope
   * so the user can preview the retry-hint output and exit code without
   * a real API key. Only `PRECONDITION_FAILED` is supported today.
   */
  dryRunSimulateError?: 'PRECONDITION_FAILED';
}

/**
 * `test plan put <test-id> --steps <plan.json>` — M3.2 piece-6.
 *
 * Replace an FE test's `planSteps[]` with the array in `--steps`. The
 * file is a single JSON object `{ planSteps: [...] }`; we don't echo
 * the full `CliPlanInput` shape here because `projectId` / `name` etc.
 * are not mutable from this endpoint.
 *
 * FE-only. BE tests get a 400 `VALIDATION_ERROR` from the server with
 * a `nextAction` pointing at `test code put`. The CLI does **not**
 * pre-fetch the test type — letting the server route saves a round
 * trip and matches the piece-6 spec's "server-side routing" decision.
 *
 * Concurrency: FE has no `codeVersion`, so updates are last-writer-
 * wins by default. Pass `--expected-step-count <N>` to set
 * `If-Match-Step-Count`; the server rejects with 412 if the current
 * array length differs. Useful for defensive callers who want to
 * detect concurrent edits without a separate read.
 *
 * Idempotency: `cli-plan-put-<uuid>` is the default key, surfaced to
 * stderr so a transport retry can pin it.
 */
export async function runPlanPut(
  opts: PlanPutOptions,
  deps: TestDeps = {},
): Promise<CliPutPlanStepsResponse> {
  assertIdempotencyKey(opts.idempotencyKey);
  requireNonEmpty('test-id', opts.testId);
  requireNonEmpty('steps', opts.stepsFile);

  if (
    opts.expectedStepCount !== undefined &&
    (!Number.isInteger(opts.expectedStepCount) || opts.expectedStepCount < 0)
  ) {
    throw localValidationError('expected-step-count', 'must be a non-negative integer');
  }

  const planSteps = readPlanStepsFileGuarded(opts.stepsFile);

  const idempotencyKey = opts.idempotencyKey ?? `cli-plan-put-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  const headers: Record<string, string> = { 'idempotency-key': idempotencyKey };
  if (opts.expectedStepCount !== undefined) {
    headers['if-match-step-count'] = String(opts.expectedStepCount);
  }

  const client = makeClient(opts, deps);
  const out = makeOutput(opts.output, deps);

  // --dry-run --dry-run-simulate-error PRECONDITION_FAILED: synthesise
  // a 412 envelope so the user sees the error and exit code 6 without
  // a real API key.
  if (opts.dryRun && opts.dryRunSimulateError === 'PRECONDITION_FAILED') {
    const expectedCount = opts.expectedStepCount ?? planSteps.length;
    const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderr(
      `Plan-steps conflict. Server has a different step count than ${expectedCount}. ` +
        `Re-fetch with 'testsprite test get ${opts.testId}' to see the current planSteps[] length and retry with --expected-step-count <current>.`,
    );
    throw ApiError.fromEnvelope(
      {
        error: {
          code: 'PRECONDITION_FAILED',
          message: `[dry-run simulation] Plan-steps conflict: step count mismatch (expected ${expectedCount}, server has 99).`,
          nextAction: `Re-fetch the current plan-steps length and retry with --expected-step-count 99.`,
          requestId: 'req_dry-run-simulate',
          details: { expectedStepCount: expectedCount, currentStepCount: 99 },
        },
      },
      412,
    );
  }

  const response = await client.put<CliPutPlanStepsResponse>(
    `/tests/${encodeURIComponent(opts.testId)}/plan-steps`,
    {
      body: { planSteps },
      headers,
    },
  );
  out.print(response, data => renderPlanPutText(data as CliPutPlanStepsResponse));
  return response;
}

function renderPlanPutText(response: CliPutPlanStepsResponse): string {
  return [
    `testId        ${response.testId}`,
    `planStepsHash ${response.planStepsHash}`,
    `stepCount     ${response.stepCount}`,
    `updatedAt     ${response.updatedAt}`,
  ].join('\n');
}

/**
 * Read + validate the `--steps` file. Returns the parsed `planSteps`
 * array on success; throws a typed `VALIDATION_ERROR` envelope on any
 * schema problem with a `details.field` pointer the caller can act on.
 *
 * Stat-first guard mirrors piece-2's `readCodeFileGuarded`: oversize
 * payloads fail before we load them into V8's heap. The cap here is
 * 256 KB (vs. 350 KB for code) per the piece-6 spec.
 */
function readPlanStepsFileGuarded(path: string): CliPlanStep[] {
  const absolute = resolveAbsolute(path);

  let stat;
  try {
    stat = statSync(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw localValidationError('steps', `file does not exist: ${path}`);
    }
    if (code === 'EACCES') {
      throw localValidationError('steps', `permission denied reading ${path}`);
    }
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw localValidationError('steps', `cannot stat ${path}: ${reason}`);
  }
  if (stat.size > MAX_PLAN_STEPS_BODY_BYTES) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Plan-steps body exceeds the 256 KB CLI cap (${stat.size} bytes).`,
        nextAction: 'Split into multiple smaller tests or trim step descriptions.',
        requestId: 'local',
        details: {
          field: 'steps',
          sizeBytes: stat.size,
          maxBytes: MAX_PLAN_STEPS_BODY_BYTES,
        },
      },
    });
  }

  let raw;
  try {
    raw = stripBom(readFileSync(absolute, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw localValidationError('steps', `cannot read ${path}: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw localValidationError('steps', `not valid JSON: ${reason}`);
  }

  return assertPlanStepsShape(parsed);
}

/**
 * Type-narrow + validate a parsed `{ planSteps: [...] }` envelope.
 * The file is expected to be a single JSON object with a `planSteps`
 * array property; we tolerate the bare array form too (some agents
 * may emit `[...]` directly) so the surface forgives a common
 * mistake without surprising callers.
 */
function assertPlanStepsShape(parsed: unknown): CliPlanStep[] {
  let stepsRaw: unknown;
  if (Array.isArray(parsed)) {
    stepsRaw = parsed;
  } else if (typeof parsed === 'object' && parsed !== null) {
    stepsRaw = (parsed as Record<string, unknown>).planSteps;
  } else {
    throw localValidationError('steps', 'must be a JSON object with a `planSteps` array');
  }

  requireArrayLength('planSteps', stepsRaw, { min: 1, max: MAX_PLAN_STEPS, itemNoun: 'step' });

  for (let i = 0; i < stepsRaw.length; i += 1) {
    const step = stepsRaw[i];
    if (typeof step !== 'object' || step === null || Array.isArray(step)) {
      throw localValidationError(`planSteps[${i}]`, 'must be an object', undefined, 'field');
    }
    const s = step as Record<string, unknown>;
    requireEnum(`planSteps[${i}].type`, s.type, PLAN_STEP_TYPES);
    requireString(`planSteps[${i}].description`, s.description);
  }

  return stepsRaw as CliPlanStep[];
}

/**
 * §6.X / M3.2 piece-3 `UpdateTestResponse` shape. `updatedFields` is
 * the array of top-level fields that changed in this call so JSON
 * consumers know what landed — useful when the agent passed all three
 * flags but the server normalized one to a no-op.
 */
export interface CliUpdateTestResponse {
  testId: string;
  updatedFields: string[];
  updatedAt: string;
}

interface UpdateOptions extends CommonOptions {
  testId: string;
  /** Optional new name; at least one of `name`/`description`/`priority` must be set. */
  name?: string;
  /** Optional new description (`null` is reserved for "clear"; CLI surfaces both). */
  description?: string;
  /** Optional new priority. Enum-validated CLI-side. */
  priority?: CliCreatePriority;
  /** Caller-supplied idempotency token; UUIDv4 minted client-side if absent. */
  idempotencyKey?: string;
}

/**
 * `test update <test-id>` — M3.2 piece-3.
 *
 * Metadata-only update: `name?`, `description?`, `priority?`. Code and
 * plan-steps are not part of this surface (`test code put` and
 * `test plan put` are the dedicated paths). The CLI does not even
 * expose `--code` / `--plan-steps` flags here so a caller cannot
 * accidentally try; the server would also reject those keys, but
 * keeping the surface narrow is the cheaper guard.
 *
 * Refuses no-op invocations (none of the three set) with a typed
 * `VALIDATION_ERROR` so a careless `test update <id>` doesn't burn a
 * request. The error includes the accepted field set so an agent
 * can self-correct without reading the help text.
 *
 * Idempotency-Key default is `cli-update-<uuid>`; a caller-supplied
 * `--idempotency-key` lets retry tooling pin the key. The generated
 * value is echoed to stderr so an operator who hits a transport
 * retry-budget exhaustion can re-run with the same key. Surfacing
 * matches piece-2's pattern.
 */
export async function runUpdate(
  opts: UpdateOptions,
  deps: TestDeps = {},
): Promise<CliUpdateTestResponse> {
  assertIdempotencyKey(opts.idempotencyKey);
  requireNonEmpty('test-id', opts.testId);
  // P1-3: client-side length checks matching server limits.
  if (opts.name !== undefined && opts.name.trim().length === 0) {
    throw localValidationError(
      'name',
      'must be a non-empty string (whitespace-only is not allowed)',
    );
  }
  if (opts.name !== undefined && opts.name.length > 200) {
    throw localValidationError('name', 'must be at most 200 characters');
  }
  if (opts.description !== undefined && opts.description.length > 2000) {
    throw localValidationError('description', 'must be at most 2000 characters');
  }
  if (opts.priority !== undefined && !CLI_CREATE_PRIORITIES.includes(opts.priority)) {
    throw localValidationError('priority', `must be one of: ${CLI_CREATE_PRIORITIES.join(', ')}`, [
      ...CLI_CREATE_PRIORITIES,
    ]);
  }

  // No-op rejection: requires at least one of the three patchable
  // fields. Caught before fetching credentials or building the
  // request so the user gets the cheapest possible error.
  const hasName = opts.name !== undefined;
  const hasDescription = opts.description !== undefined;
  const hasPriority = opts.priority !== undefined;
  if (!hasName && !hasDescription && !hasPriority) {
    throw localValidationError(
      'fields',
      'at least one of --name / --description / --priority must be set',
      ['name', 'description', 'priority'],
    );
  }

  const idempotencyKey = opts.idempotencyKey ?? `cli-update-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  // Body carries only the fields the caller passed. Sending
  // `{ name: undefined }` would JSON-serialize to omit the key, which
  // is the intended wire shape — but we build the body deliberately
  // so the contract is auditable rather than dependent on
  // JSON.stringify undefined-skipping.
  const body: Record<string, string> = {};
  if (hasName) body.name = opts.name!;
  if (hasDescription) body.description = opts.description!;
  if (hasPriority) body.priority = opts.priority!;

  const client = makeClient(opts, deps);
  const out = makeOutput(opts.output, deps);
  const response = await client.put<CliUpdateTestResponse>(
    `/tests/${encodeURIComponent(opts.testId)}`,
    {
      body,
      headers: { 'idempotency-key': idempotencyKey },
    },
  );
  out.print(response, data => renderUpdateText(data as CliUpdateTestResponse));
  return response;
}

function renderUpdateText(response: CliUpdateTestResponse): string {
  return [
    `testId        ${response.testId}`,
    `updatedFields ${response.updatedFields.join(', ')}`,
    `updatedAt     ${response.updatedAt}`,
  ].join('\n');
}

/**
 * §6.X / M3.2 piece-3 `DeleteTestResponse` shape. `deletedAt` is the
 * delete timestamp (an ack) — hard-delete is immediate, so there is no
 * restore window.
 */
export interface CliDeleteTestResponse {
  testId: string;
  deletedAt: string;
}

interface DeleteOptions extends CommonOptions {
  testId: string;
  /** Hard gate — required (unless `--dry-run` is set). No interactive prompts. */
  confirm: boolean;
  /** Caller-supplied idempotency token; UUIDv4 minted client-side if absent. */
  idempotencyKey?: string;
}

/**
 * `test delete <test-id> --confirm` — M3.2 piece-3.
 *
 * Permanent hard-delete via DELETE /tests/{id}. The server removes the
 * test row plus its steps and code object immediately — matching the
 * Portal's own delete behavior — so the test disappears everywhere at
 * once. There is no restore window.
 *
 * **`--confirm` is required** (unless `--dry-run`). Without either,
 * the CLI exits 5 `VALIDATION_ERROR` with a typed envelope explaining
 * the convention. The CLI never prompts interactively — matches the
 * CI-friendly contract from the CLI error spec §2.
 *
 * Re-delete on an already-deleted (or missing) row returns 404 from the
 * server. The CLI surfaces the envelope as-is; no client-side branching.
 */
export async function runDelete(
  opts: DeleteOptions,
  deps: TestDeps = {},
): Promise<CliDeleteTestResponse> {
  assertIdempotencyKey(opts.idempotencyKey);
  requireNonEmpty('test-id', opts.testId);

  if (!opts.confirm && !opts.dryRun) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Refusing to delete without --confirm.',
        nextAction:
          'This permanently deletes the test (no restore window), and the CLI ' +
          'convention is explicit confirmation for destructive operations. ' +
          'Re-run with --confirm. (--dry-run also works without --confirm.)',
        requestId: 'local',
        details: { field: 'confirm', reason: 'required for destructive operation' },
      },
    });
  }

  const idempotencyKey = opts.idempotencyKey ?? `cli-delete-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  const client = makeClient(opts, deps);
  const out = makeOutput(opts.output, deps);
  const response = await client.delete<CliDeleteTestResponse>(
    `/tests/${encodeURIComponent(opts.testId)}`,
    {
      headers: { 'idempotency-key': idempotencyKey },
    },
  );

  out.print(response, data => renderDeleteText(data as CliDeleteTestResponse));
  return response;
}

function renderDeleteText(response: CliDeleteTestResponse): string {
  return [`testId    ${response.testId}`, `deletedAt ${response.deletedAt}`].join('\n');
}

/**
 * Per-test outcome record for `test delete-batch` and `test delete --all`.
 */
export interface CliBulkDeleteResult {
  testId: string;
  status: 'deleted' | 'skipped' | 'error';
  /**
   * Present when `status === 'deleted'`. ISO 8601 timestamp from the server.
   */
  deletedAt?: string;
  /** Present when `status === 'error'`. Short error description. */
  error?: string;
}

export interface CliBulkDeleteSummary {
  results: CliBulkDeleteResult[];
  summary: { total: number; deleted: number; skipped: number; failed: number };
}

interface DeleteBatchOptions extends CommonOptions {
  /** Explicit list of testIds to delete. */
  testIds: string[];
  /** --all: resolve all tests in the project and delete them. */
  all: boolean;
  /** --project <id>: required with --all. */
  projectId?: string;
  /**
   * --status <list>: with --all, only delete tests whose status matches.
   * Uses the same validated set as `test list --status`.
   */
  statusFilter?: string;
  /** Hard gate — required (unless --dry-run). */
  confirm: boolean;
}

/**
 * `test delete-batch <test-ids...>` and `test delete --all --project <id>` — dogfood L1800.
 *
 * Deletes tests sequentially (to avoid hammering the server) and aggregates
 * results into a single summary. Gated on `--confirm` (same convention as
 * `test delete`). Prints a summary line to stderr and the per-test results
 * object to stdout.
 *
 * Exit code: 0 if all targets were deleted (or `--dry-run`); 1 if any
 * deletion failed (server error); 5 if `--confirm` is missing.
 */
export async function runDeleteBatch(
  opts: DeleteBatchOptions,
  deps: TestDeps = {},
): Promise<CliBulkDeleteSummary> {
  const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const out = makeOutput(opts.output, deps);

  if (!opts.confirm && !opts.dryRun) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Refusing to bulk-delete without --confirm.',
        nextAction:
          'This permanently deletes the tests (no restore window). Re-run with --confirm.',
        requestId: 'local',
        details: { field: 'confirm', reason: 'required for destructive operation' },
      },
    });
  }

  // Bug 1 fix: reject the ambiguous combination of explicit IDs + --all before any
  // resolution happens. Without this guard the explicit IDs are silently discarded
  // and ALL project tests get deleted — a data-loss footgun.
  if (opts.all && opts.testIds.length > 0) {
    throw localValidationError('test-ids', 'Pass either explicit test IDs or --all, not both.');
  }

  if (opts.all && !opts.projectId) {
    throw localValidationError('project', '--all requires a project id — pass --project <id>');
  }
  if (!opts.all && opts.testIds.length === 0) {
    throw localValidationError(
      'test-ids',
      'provide at least one <test-id>, or use --all --project <id> to delete all tests in a project',
    );
  }

  // Bug 2 fix: --status without --all would silently be ignored because the filter
  // is only applied inside the `if (opts.all)` block below. Reject early so the
  // operator knows their flag had no effect.
  if (opts.statusFilter !== undefined && !opts.all) {
    throw localValidationError(
      'status',
      '--status only applies with --all (it filters which project tests get deleted). ' +
        'Remove --status, or add --all --project <id>.',
    );
  }

  // Validate --status filter.
  if (opts.statusFilter !== undefined) {
    validateStatusFilter(opts.statusFilter);
  }

  const client = makeClient(opts, deps);

  let testIds = opts.testIds;

  if (opts.all) {
    // Bug 3 fix: --dry-run uses a canned fetch impl that returns sample data
    // regardless of the projectId, so the resolved list does NOT reflect the
    // real project scope. Warn the operator so the preview isn't mistaken for
    // an accurate count.
    if (opts.dryRun) {
      stderrFn(
        '[dry-run] WARNING: the preview below uses sample data and does NOT reflect the ' +
          'real tests in your project. Remove --dry-run to see which tests would actually ' +
          'be deleted.',
      );
    }
    // Resolve all tests in the project.
    stderrFn(`Resolving tests in project ${opts.projectId}…`);
    const allPage = await paginate<CliTest>(
      async ({ pageSize, cursor }) =>
        client.get<Page<CliTest>>('/tests', {
          query: { projectId: opts.projectId!, pageSize, cursor },
        }),
      {},
    );
    let allTests = allPage.items;

    // --status filter.
    if (opts.statusFilter !== undefined && opts.statusFilter !== '') {
      const allowed = new Set(
        opts.statusFilter
          .split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0),
      );
      const before = allTests.length;
      allTests = allTests.filter(t => allowed.has(t.status));
      const skipped = before - allTests.length;
      if (skipped > 0) {
        stderrFn(
          `--status filter: skipping ${skipped} test${skipped !== 1 ? 's' : ''} not matching status=${opts.statusFilter}.`,
        );
      }
    }

    testIds = allTests.map(t => t.id);
    if (testIds.length === 0) {
      stderrFn(`No tests found in project ${opts.projectId} matching filters — nothing to delete.`);
      const empty: CliBulkDeleteSummary = {
        results: [],
        summary: { total: 0, deleted: 0, skipped: 0, failed: 0 },
      };
      out.print(empty);
      return empty;
    }
    stderrFn(`Resolved ${testIds.length} test${testIds.length !== 1 ? 's' : ''} to delete.`);
  }

  if (opts.dryRun) {
    emitDryRunBanner(stderrFn);
    const dryResults: CliBulkDeleteResult[] = testIds.map(id => ({
      testId: id,
      status: 'deleted' as const,
      deletedAt: new Date().toISOString(),
    }));
    const summary: CliBulkDeleteSummary = {
      results: dryResults,
      summary: { total: testIds.length, deleted: testIds.length, skipped: 0, failed: 0 },
    };
    out.print(summary, data => renderBulkDeleteText(data as CliBulkDeleteSummary));
    return summary;
  }

  const results: CliBulkDeleteResult[] = [];

  for (const testId of testIds) {
    const idempotencyKey = `cli-delete-${randomUUID()}`;
    try {
      const resp = await client.delete<CliDeleteTestResponse>(
        `/tests/${encodeURIComponent(testId)}`,
        { headers: { 'idempotency-key': idempotencyKey } },
      );
      results.push({
        testId,
        status: 'deleted',
        deletedAt: resp.deletedAt,
      });
    } catch (err) {
      // 404 = already deleted / not found. Surface as 'skipped' so the
      // summary count is accurate and the exit code stays 0.
      if (err instanceof ApiError && err.code === 'NOT_FOUND') {
        results.push({ testId, status: 'skipped', error: 'not found (already deleted?)' });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ testId, status: 'error', error: msg });
      }
    }
  }

  const deleted = results.filter(r => r.status === 'deleted').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const failed = results.filter(r => r.status === 'error').length;
  const bulk: CliBulkDeleteSummary = {
    results,
    summary: { total: testIds.length, deleted, skipped, failed },
  };

  stderrFn(`Deleted ${deleted}, skipped ${skipped}, failed ${failed}.`);

  out.print(bulk, data => renderBulkDeleteText(data as CliBulkDeleteSummary));

  if (failed > 0) {
    throw new CLIError(
      `${failed} deletion${failed !== 1 ? 's' : ''} failed. See results for details.`,
      1,
    );
  }
  return bulk;
}

function renderBulkDeleteText(bulk: CliBulkDeleteSummary): string {
  const header = `Deleted: ${bulk.summary.deleted}  Skipped: ${bulk.summary.skipped}  Failed: ${bulk.summary.failed}`;
  const rows = bulk.results.map(r => {
    if (r.status === 'deleted') {
      return `  ${r.testId}  deleted  ${r.deletedAt}`;
    }
    return `  ${r.testId}  ${r.status}  ${r.error ?? ''}`;
  });
  return [header, ...rows].join('\n');
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
}

const PLAN_STEP_TYPES: ReadonlyArray<CliPlanStep['type']> = ['action', 'assertion'];

/**
 * Plan-from input file shape. Mirrors the body the controller accepts
 * at `POST /api/cli/v1/tests` with `planSteps[]` (use-cases.md UC1).
 * `priority` and `description` are optional metadata; everything else
 * is required.
 *
 * FE-only after the 2026-05-13 scope cut. `type: "backend"` plans are
 * rejected pre-flight by the CLI with a `nextAction` pointing at
 * `test create --type backend --code-file <path>`.
 */
export interface CliPlanInput {
  projectId: string;
  type: 'frontend' | 'backend';
  name: string;
  description?: string;
  priority?: CliCreatePriority;
  planSteps: CliPlanStep[];
}

/**
 * §6.X / M3.2 piece-5 — response from POST /tests with planSteps[].
 * Same wire shape as the code-based create (piece-2) plus an optional
 * `planSteps` echo so the agent doesn't have to keep its own copy
 * between create and run. `planSteps` is absent in dry-run mode
 * because the sampler doesn't inspect the request body.
 */
export interface CliCreateFromPlanResponse extends CliCreateTestResponse {
  planSteps?: CliPlanStep[];
}

/** Per-spec result from `POST /tests/batch`. */
export interface CliBatchSpecResult {
  /** Position of the spec in the input JSONL, preserved across the response. */
  specIndex: number;
  /** Spec outcome. Mirrors the server's per-spec status enum. */
  status: 'created' | 'validation_error' | 'not_found';
  /** Set on success. */
  testId?: string;
  /** Set on non-success. Carries the same envelope an `ApiError` would. */
  error?: {
    code: string;
    message: string;
    field?: string;
  };
}

export interface CliCreateBatchResponse {
  results: CliBatchSpecResult[];
  summary: {
    total: number;
    created: number;
    failed: number;
  };
}

/**
 * Per-run result from the `--run` fan-out on `test create-batch`.
 * Each entry mirrors the shape of a single `test run --wait` JSON output
 * so automation can process the array the same way it processes a single run.
 */
export interface CliBatchRunResult {
  /** Test that was triggered. */
  testId: string;
  /** Run ID minted by the trigger call (or the in-flight runId on CONFLICT resume). */
  runId: string;
  /** Terminal status if `--wait`; `queued` if no `--wait`. */
  status: string;
  /** Code version resolved at trigger time. */
  codeVersion: string;
  /** Resolved target URL. */
  videoUrl?: string | null;
  /** Failure kind if status is `failed` or `blocked`. */
  failureKind?: string | null;
  /** Error envelope when the trigger itself failed (network/auth/validation). */
  error?: { code: string; message: string; exitCode: number };
}

/** Envelope emitted by `test create-batch --run` in JSON mode. */
export interface CliCreateBatchRunResponse {
  results: CliBatchRunResult[];
}

/**
 * 200-step + 256 KB caps on a single plan body. The CLI
 * enforces both client-side as a pre-flight guard so an obvious
 * oversize plan fails fast (exit 5) without spending a round trip.
 * The server enforces the same caps defensively.
 */
const MAX_PLAN_STEPS = 200;
const MAX_PLAN_BODY_BYTES = 256 * 1024;

/**
 * Batch caps per piece-5 §Backend: 50 specs per request, 5 MB total
 * body. Same fail-fast pattern as the single-plan caps.
 */
const MAX_BATCH_SPECS = 50;
const MAX_BATCH_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Maximum testIds per `POST /tests/batch/rerun` request (OpenAPI
 * `BatchRerunRequest.testIds` maxItems: 50). When --all resolves more
 * than this, the CLI splits into chunks and aggregates the results.
 */
const MAX_BATCH_RERUN_IDS = 50;

/**
 * Drop duplicate `testId` entries from a chunked batch-rerun's aggregated
 * `accepted[]`, keeping the first occurrence. BE producer/teardown closure
 * dedup happens per-request server-side, not across the separate requests
 * one chunk per `MAX_BATCH_RERUN_IDS` window produces, so the same producer
 * can come back accepted (with a different runId) from more than one
 * chunk. Returns the deduped list plus how many entries were dropped, so
 * the caller can warn the operator that a shared BE producer/teardown was
 * triggered more than once.
 */
function dedupeBatchRerunAccepted(entries: BatchRerunAccepted[]): {
  deduped: BatchRerunAccepted[];
  droppedCount: number;
} {
  const seen = new Map<string, BatchRerunAccepted>();
  let droppedCount = 0;
  for (const entry of entries) {
    if (seen.has(entry.testId)) {
      droppedCount++;
      continue;
    }
    seen.set(entry.testId, entry);
  }
  return { deduped: [...seen.values()], droppedCount };
}

/**
 * Merge per-project closure summaries from multiple batch-rerun chunk
 * responses, combining entries that share a `projectId` rather than
 * leaving one entry per chunk. `testIds` / `addedProducers` /
 * `addedTeardowns` are unioned (a producer present in two chunks' entries
 * for the same project, the closure-dedup race this fixes, must not be
 * counted twice); `clearedCaptured` is summed, each chunk's expansion is a
 * disjoint operation so its count is additive.
 */
function mergeBatchRerunClosureByProject(
  entries: BatchRerunClosureByProject[],
): BatchRerunClosureByProject[] {
  const byProject = new Map<string, BatchRerunClosureByProject>();
  for (const entry of entries) {
    const existing = byProject.get(entry.projectId);
    if (!existing) {
      byProject.set(entry.projectId, {
        projectId: entry.projectId,
        testIds: [...new Set(entry.testIds)],
        addedProducers: [...new Set(entry.addedProducers)],
        addedTeardowns: [...new Set(entry.addedTeardowns)],
        clearedCaptured: entry.clearedCaptured,
      });
      continue;
    }
    existing.testIds = [...new Set([...existing.testIds, ...entry.testIds])];
    existing.addedProducers = [...new Set([...existing.addedProducers, ...entry.addedProducers])];
    existing.addedTeardowns = [...new Set([...existing.addedTeardowns, ...entry.addedTeardowns])];
    existing.clearedCaptured += entry.clearedCaptured;
  }
  return [...byProject.values()];
}

/**
 * Default max in-flight run-triggers for `create-batch --run`.
 *
 * Rationale: the server caps run-triggers at 60/min/key
 * (`CLI_RUN_RATE_LIMIT_PER_MIN`, default 60 → `RATE_LIMITED` / exit 11).
 * A `create-batch` holds at most MAX_BATCH_SPECS (50) specs, so a default
 * of 50 lets a full batch dispatch all of its runs at once and finish
 * launching within a single window. With async Lambda invoke each trigger
 * returns in ~1s, so this bound mainly smooths the dispatch burst.
 *
 * NOTE: because 50 == MAX_BATCH_SPECS, a single `create-batch --run` can
 * never trip the client-side `BATCH_RUN_RATE_LIMIT` token bucket (also
 * 50/min) — the server's 60/min/key is the real backstop. The client
 * throttle still guards repeated runs within a window from one process.
 *
 * Callers can override this default via `--max-concurrency` (raising it
 * cannot lift the effective rate above the server cap).
 */
export const DEFAULT_BATCH_RUN_CONCURRENCY = 50;
/** Hard upper bound for --max-concurrency. Values above this are rejected with exit 5 (VALIDATION_ERROR). */
export const MAX_BATCH_CONCURRENCY = 100;

/** Client-side run-trigger throttle: 50 triggers per 60-second rolling window per key (sits just under the server's 60/min/key cap). */
export const BATCH_RUN_RATE_LIMIT = 50;
/** Rolling window duration (ms) for the client-side trigger rate throttle. */
export const BATCH_RUN_RATE_WINDOW_MS = 60_000;
/** Maximum number of outer RATE_LIMITED retries inside the batch fan-out (beyond HTTP-layer retries). */
export const BATCH_RUN_RATE_MAX_OUTER_RETRIES = 5;

/**
 * D3: max automatic retry attempts for deferred tests under `--wait`.
 * Each attempt is preceded by a Retry-After-aware sleep (server value if
 * present, else 61s default), clamped to the remaining `--timeout` budget.
 * Only active under `--wait`; the non-wait path is unchanged.
 */
export const MAX_DEFERRED_RETRIES = 3;
/** D3: default deferred-retry sleep when no Retry-After is available (ms). */
export const DEFERRED_RETRY_DEFAULT_SLEEP_MS = 61_000;

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
 * Limitation: a hypothetical future backend that emits `RATE_LIMITED` for a
 * third reason without a `Retry-After` header AND without the per-minute
 * wording would be classified as permanent here. Document this if it occurs.
 */
export function isTransientRateLimit(err: ApiError): boolean {
  // Fix 4 (hardening): insufficient-credits is ALWAYS permanent, regardless of
  // any Retry-After header the response may carry. Check this SHORT-CIRCUIT first
  // so a credits-429 with a stray Retry-After header is never retried.
  if (/insufficient credits/i.test(err.message)) return false;

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

interface CreateFromPlanOptions extends CommonOptions {
  /** Path to the JSON file containing one `CliPlanInput`. */
  planFrom: string;
  /** Caller-supplied idempotency token; UUIDv4 minted client-side if absent. */
  idempotencyKey?: string;
  /**
   * Reserved for the M3.3 chain. When `true`, the CLI will (once M3.3
   * lands) call `POST /tests/{id}/runs` after the create returns. For
   * v0.1.0 piece-5 this is wired but emits exit 7 `UNSUPPORTED`
   * pointing at the Portal trigger.
   */
  run?: boolean;
  /** Reserved for the M3.3 chain. Honored when `--run` is set. */
  wait?: boolean;
  /** Reserved for the M3.3 chain. Per-run timeout in seconds. */
  timeout?: number;
  /**
   * B2(c): true when --timeout was NOT explicitly set (the default is in
   * effect). Threaded into RunTestRunOptions so the first-run hint fires.
   */
  timeoutIsDefault?: boolean;
  /** Reserved for the M3.3 chain. Per-run target URL override. */
  targetUrl?: string;
  /**
   * Names of `test create` flags the caller supplied that `--plan-from`
   * ignores (identity lives in the JSON). Surfaced as a stderr advisory
   * AFTER the plan validates, so a malformed plan (e.g. missing
   * `projectId`) fails fast with a clear field error instead of the
   * misleading "ignoring --project" line landing first (dogfood L1778).
   */
  ignoredFlags?: string[];
}

/**
 * `test create --plan-from <plan.json>` — M3.2 piece-5.
 *
 * FE-only path: agent writes a `planSteps[]` JSON file describing the
 * test in natural language; CLI ships it to the backend; backend
 * stores it on `FrontendTestEntity` for the browser-use Lambda to
 * interpret at run time. The plan is the test definition — no
 * server-side LLM compile happens at create time (that was the
 * 2026-05-13 BE codegen scope cut; FE was never on that path).
 *
 * BE plans rejected pre-flight: if `plan.json` has `type: "backend"`,
 * exit 5 `VALIDATION_ERROR` with a `nextAction` pointing at
 * `test create --type backend --code-file <path>`. Same envelope the
 * server would return, just emitted without burning a round trip.
 *
 * `--run` is reserved for the M3.3 chain — currently exits 7
 * `UNSUPPORTED` per piece-5 spec; rewires to a real `POST /runs` call
 * when M3.3 lands.
 */
export async function runCreateFromPlan(
  opts: CreateFromPlanOptions,
  deps: TestDeps = {},
): Promise<CliCreateFromPlanResponse> {
  assertIdempotencyKey(opts.idempotencyKey);
  // codex #128 P2: validate the derived `<key>:run` chain key before the
  // create POST (see runCreate) so a near-limit base key fails fast instead
  // of orphaning a created test with no run.
  assertChainedRunKeyFits(opts.run, opts.idempotencyKey);
  requireNonEmpty('plan-from', opts.planFrom);

  if (opts.targetUrl !== undefined) {
    assertNotLocal(opts.targetUrl);
  }

  const plan = readPlanFromGuarded(opts.planFrom);

  // The plan validated (projectId/type/name/planSteps present). Only NOW
  // warn that overlapping `test create` flags were ignored — emitting this
  // before validation made a missing-projectId failure look like the
  // ignored --project flag was the cause (dogfood L1778).
  if (opts.ignoredFlags && opts.ignoredFlags.length > 0) {
    const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderr(
      `warning: --plan-from supplies the test definition; ignoring ${opts.ignoredFlags.join(', ')}. ` +
        `Edit the plan JSON to change these fields.`,
    );
  }

  // FE-only after the 2026-05-13 scope cut. The server also rejects
  // BE plans, but bailing here saves a round trip and matches piece-2's
  // "fast-fail at the input gate" pattern.
  if (plan.type === 'backend') {
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Backend tests via the CLI require --code-file.',
        nextAction:
          "Backend tests via the CLI require '--code-file <path>'. Use 'testsprite test create --type backend --code-file foo.py'.",
        requestId: 'local',
        details: { field: 'type', reason: 'backend not supported in --plan-from path' },
      },
    });
  }

  const idempotencyKey = opts.idempotencyKey ?? `cli-create-plan-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  const body = {
    projectId: plan.projectId,
    type: plan.type,
    name: plan.name,
    description: plan.description,
    priority: plan.priority,
    planSteps: plan.planSteps,
  };

  const client = makeClient(opts, deps);
  const out = makeOutput(opts.output, deps);

  // Fix 4: best-effort duplicate-name advisory — same semantics as runCreate.
  // The plan's projectId + name are available after validation above. Skip
  // under dry-run (no network calls); swallow all errors (advisory only).
  if (!opts.dryRun) {
    const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    await emitDupNameAdvisoryIfNeeded(client, plan.projectId, plan.name, stderrFn);
  }

  const response = await client.post<CliCreateFromPlanResponse>('/tests', {
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });

  // Fix 5 (plan-from coverage): the projectId for the deep-link comes from
  // the validated PLAN body (not opts — `--plan-from` has no --project-id
  // flag). Same dry-run suppression as runCreate (fake canned test id).
  const planDashboardUrl = opts.dryRun
    ? undefined
    : resolvePortalUrl(resolveApiUrl(opts, deps), plan.projectId, response.testId);

  // --run chain (M3.3 piece-3): trigger + optionally wait. Per codex
  // round-1 P1: suppress the create's own print when chaining;
  // `runTestRun` emits a single merged envelope on stdout.
  if (opts.run === true) {
    // Idempotency key for the run is the create key + ":run" suffix so a
    // retry of the whole chain gets the same runId. Per piece-3 spec.
    const runIdempotencyKey = `${idempotencyKey}:run`;
    const createContextWithUrl =
      planDashboardUrl !== undefined ? { ...response, dashboardUrl: planDashboardUrl } : response;
    return runTestRun(
      {
        ...opts,
        testId: response.testId,
        idempotencyKey: runIdempotencyKey,
        timeoutSeconds: opts.timeout ?? DEFAULT_RUN_TIMEOUT_SECONDS,
        // B2(c): thread through whether --timeout was explicitly set so the
        // first-run hint fires for `test create --plan-from --run --wait`.
        timeoutIsDefault: opts.timeoutIsDefault ?? false,
        wait: opts.wait === true,
        createContext: createContextWithUrl,
      },
      deps,
    ).then(() => response);
  }

  if (opts.output === 'json') {
    out.print(
      planDashboardUrl !== undefined ? { ...response, dashboardUrl: planDashboardUrl } : response,
      data => renderCreateText(data as CliCreateTestResponse),
    );
  } else {
    out.print(response, data => renderCreateText(data as CliCreateTestResponse));
    if (planDashboardUrl !== undefined) {
      const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
      stderrFn(`Dashboard: ${planDashboardUrl}`);
    }
  }
  return response;
}

/**
 * Read + validate a plan JSON file. Returns the parsed `CliPlanInput`
 * on success, throws a typed `VALIDATION_ERROR` envelope on any
 * schema problem (missing fields, wrong types, oversize body, etc.).
 *
 * Stat-first guard mirrors piece-2's `readCodeFileGuarded` — reject
 * obvious oversize files BEFORE loading them into V8's heap. For
 * plans the cap is 256 KB (vs. 350 KB for code).
 */
function readPlanFromGuarded(path: string): CliPlanInput {
  const absolute = resolveAbsolute(path);

  let stat;
  try {
    stat = statSync(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw localValidationError('plan-from', `file does not exist: ${path}`);
    }
    if (code === 'EACCES') {
      throw localValidationError('plan-from', `permission denied reading ${path}`);
    }
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw localValidationError('plan-from', `cannot stat ${path}: ${reason}`);
  }
  if (stat.size > MAX_PLAN_BODY_BYTES) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Plan body exceeds the 256 KB CLI cap (${stat.size} bytes).`,
        nextAction: 'Split into multiple smaller tests or trim step descriptions.',
        requestId: 'local',
        details: {
          field: 'plan-from',
          sizeBytes: stat.size,
          maxBytes: MAX_PLAN_BODY_BYTES,
        },
      },
    });
  }

  let raw;
  try {
    raw = stripBom(readFileSync(absolute, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw localValidationError('plan-from', `cannot read ${path}: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw localValidationError('plan-from', `not valid JSON: ${reason}`);
  }

  return assertPlanShape(parsed);
}

/**
 * Type-narrow + validate a parsed plan input. Pulled out so the same
 * checks run on `--plan-from` (single) and each JSONL line in
 * `create-batch --plans`. Throws `VALIDATION_ERROR` with a typed
 * `details.field` pointer so callers can fix specific issues without
 * re-reading the whole file.
 */
function assertPlanShape(parsed: unknown, context: { specIndex?: number } = {}): CliPlanInput {
  const prefix = context.specIndex !== undefined ? `specs[${context.specIndex}].` : '';

  // Every field below is a JSON body path inside the plan file (or
  // JSONL spec), not a CLI flag — pass `'field'` so the error message
  // says `Field \`projectId\` is invalid: ...` instead of inventing a
  // `--projectId` flag the user can't pass.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw localValidationError(`${prefix}plan`, 'must be a JSON object', undefined, 'field');
  }
  const obj = parsed as Record<string, unknown>;

  requireString(`${prefix}projectId`, obj.projectId);
  requireEnum(`${prefix}type`, obj.type, ['frontend', 'backend'] as const);
  requireString(`${prefix}name`, obj.name);
  if (obj.description !== undefined && typeof obj.description !== 'string') {
    throw localValidationError(
      `${prefix}description`,
      'must be a string when present',
      undefined,
      'field',
    );
  }
  if (obj.priority !== undefined) {
    requireEnum(`${prefix}priority`, obj.priority, CLI_CREATE_PRIORITIES);
  }
  requireArrayLength(`${prefix}planSteps`, obj.planSteps, {
    min: 1,
    max: MAX_PLAN_STEPS,
    itemNoun: 'step',
  });
  for (let i = 0; i < (obj.planSteps as unknown[]).length; i += 1) {
    const step = (obj.planSteps as unknown[])[i];
    if (typeof step !== 'object' || step === null || Array.isArray(step)) {
      throw localValidationError(
        `${prefix}planSteps[${i}]`,
        'must be an object',
        undefined,
        'field',
      );
    }
    const s = step as Record<string, unknown>;
    requireEnum(`${prefix}planSteps[${i}].type`, s.type, PLAN_STEP_TYPES);
    requireString(`${prefix}planSteps[${i}].description`, s.description);
  }

  return obj as unknown as CliPlanInput;
}

interface CreateBatchOptions extends CommonOptions {
  /** Path to the JSONL file containing one `CliPlanInput` per line. */
  plans: string;
  /**
   * Path to a directory containing `*.json` plan files. Globs all `*.json`
   * files (sorted by name for determinism), assembles them in-process into the
   * same spec array as `--plans`, then runs the existing create-batch path.
   * Mutually exclusive with `--plans`.
   */
  planFromDir?: string;
  /** Caller-supplied idempotency token; UUIDv4 minted client-side if absent. */
  idempotencyKey?: string;
  /** When true, trigger a run for each created test after the batch create. */
  run?: boolean;
  /** With `--run`, max number of in-flight triggers at once (default: `DEFAULT_BATCH_RUN_CONCURRENCY` = 50). */
  maxConcurrency?: number;
  /** With `--run`, poll each run until terminal status before returning. */
  wait?: boolean;
  /** With `--run --wait`, per-run max seconds to wait (1..3600, default 600). */
  timeoutSeconds?: number;
  /** With `--run`, override the project default env URL for each triggered run. */
  targetUrl?: string;
}

/**
 * `test create-batch --plans <plans.jsonl>` — M3.2 piece-5.
 *
 * Reads one `CliPlanInput` per line of the JSONL file, ships them as
 * a single `POST /tests/batch` request, returns per-spec results.
 * The endpoint is FE-only; any spec with `type: "backend"` returns
 * `validation_error` per-spec without aborting siblings.
 *
 * Caps:
 *   - 50 specs per batch (CLI rejects locally before sending)
 *   - 5 MB total body (CLI checks after stringify)
 *   - 200 steps + 256 KB per individual plan (per-line validation)
 *
 * BE specs in the batch are flagged on stderr with their `specIndex`
 * so the operator can see what will fail server-side, but the batch
 * still proceeds — the FE specs are perfectly valid. No interactive
 * prompt (the CLI is CI-friendly per piece-3's convention).
 *
 * Exit code: `0` if **any** spec succeeded (POSIX partial-success
 * convention per use-cases.md UC2 item 6). Non-zero only when zero
 * specs succeeded — in which case the underlying API failure is
 * surfaced via the normal exit-code mapper.
 *
 * `--run` triggers each successfully-created test after the batch
 * create completes. `--max-concurrency` bounds the in-flight trigger
 * count. `--wait` polls each run until terminal. `--timeout` is
 * per-run (not aggregate). Output in JSON mode is
 * `{ results: CliBatchRunResult[] }`. Exit code: 0 if every run
 * passed; 1 if any failed/blocked/cancelled; 7 if ALL runs timed out;
 * falls back to 1 for mixed outcomes.
 */
export async function runCreateBatch(
  opts: CreateBatchOptions,
  deps: TestDeps = {},
): Promise<CliCreateBatchResponse> {
  assertIdempotencyKey(opts.idempotencyKey);
  // Exactly one of --plans or --plan-from-dir is required.
  if (opts.planFromDir !== undefined && opts.plans !== undefined && opts.plans !== '') {
    throw localValidationError(
      'plan-from-dir',
      '--plan-from-dir and --plans are mutually exclusive — supply only one',
    );
  }
  if ((opts.planFromDir === undefined || opts.planFromDir === '') && !opts.plans) {
    throw localValidationError('plans', 'one of --plans or --plan-from-dir is required');
  }

  if (opts.maxConcurrency !== undefined && !Number.isInteger(opts.maxConcurrency)) {
    throw localValidationError('max-concurrency', 'must be an integer between 1 and 100');
  }
  if (
    opts.maxConcurrency !== undefined &&
    (opts.maxConcurrency < 1 || opts.maxConcurrency > MAX_BATCH_CONCURRENCY)
  ) {
    throw localValidationError('max-concurrency', 'must be an integer between 1 and 100');
  }
  if (opts.targetUrl !== undefined) {
    assertNotLocal(opts.targetUrl);
  }

  const stderrFnEarly = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const specs =
    opts.planFromDir !== undefined && opts.planFromDir !== ''
      ? readPlansFromDirGuarded(opts.planFromDir, stderrFnEarly)
      : readPlansJsonlGuarded(opts.plans);

  // Duplicate plan-body advisory (dogfood L120, 2026-05-28).
  // If ≥3 specs share an identical planSteps body + description, the operator
  // is likely scoring multiple targets against the same test definition.
  // Reusing one testId across targets (a) serializes runs per-testId on the
  // server and (b) overwrites video history — each run overwrites the last.
  // The correct pattern is one distinct testId per (agent × plan) pair,
  // e.g. prefix each name per agent. Non-blocking: batch proceeds normally.
  const dupBodyCount = countDuplicatePlanBodies(specs);
  if (dupBodyCount > 0) {
    const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderrFn(
      `[advisory] ${dupBodyCount} spec(s) share an identical plan body + description. If you are scoring multiple targets, keep tests distinct (e.g. prefix each name per agent) — reusing one testId serializes runs and overwrites video history per testId.`,
    );
  }

  // BE-spec stderr advisory. Server returns per-spec validation_error
  // for any BE spec in a batch; we flag them up front so the operator
  // sees the partial failure coming. No interactive prompt — CLI is
  // CI-friendly per piece-3's convention.
  const beIndexes = specs.map((s, i) => (s.type === 'backend' ? i : -1)).filter(i => i !== -1);
  if (beIndexes.length > 0) {
    const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderrFn(
      `warning: ${beIndexes.length} of ${specs.length} specs have type="backend" (indexes: ${beIndexes.join(', ')}) — server will return per-spec validation_error for these. FE specs will still process. Use 'test create --type backend --code-file' for BE tests.`,
    );
  }

  const idempotencyKey = opts.idempotencyKey ?? `cli-create-batch-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderrFn(`idempotency-key: ${idempotencyKey}`);
  }

  const body = { tests: specs };
  const bodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (bodyBytes > MAX_BATCH_BODY_BYTES) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Batch body exceeds the 5 MB CLI cap (${bodyBytes} bytes).`,
        nextAction: 'Split into multiple --plans files.',
        requestId: 'local',
        details: { field: 'plans', sizeBytes: bodyBytes, maxBytes: MAX_BATCH_BODY_BYTES },
      },
    });
  }

  const client = makeClient(opts, deps);
  const out = makeOutput(opts.output, deps);
  const response = await client.post<CliCreateBatchResponse>('/tests/batch', {
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });

  // Per codex round-1 P2: zero successes on a non-empty batch must not
  // exit 0. Partial success (some created, some failed) keeps exit 0 —
  // that's the documented "CI-friendly" semantic. But "submitted N specs
  // and got back 0 created" is indistinguishable from total failure to
  // a CI runner, and silently exit-0 would let a misconfigured batch
  // job leave nothing in DDB while the wrapping pipeline considers it
  // green.
  //
  // P3-13: in JSON mode, emit a SINGLE envelope that wraps both the results
  // and the error details, rather than printing the response first and then
  // throwing (which produces two separate JSON objects on different streams
  // and confuses machine consumers). Text mode still renders the human summary
  // first and then the error line.
  if (response.summary.total > 0 && response.summary.created === 0) {
    if (opts.output === 'json') {
      // Single JSON envelope on stdout: wraps all-failure results + error fields.
      out.print({
        results: response.results,
        summary: response.summary,
        error: {
          code: 'INTERNAL',
          message: `Batch create produced 0 successful tests out of ${response.summary.total} specs.`,
          nextAction:
            'Inspect per-spec errors in `results[]` (each entry carries `status` and `error.code`). Fix the failing specs and retry; pass the same --idempotency-key to safely re-send.',
        },
      });
    } else {
      // Text mode: print summary first so the operator can see per-spec failures.
      out.print(response, data => renderBatchText(data as CliCreateBatchResponse));
    }
    throw ApiError.fromEnvelope({
      error: {
        code: 'INTERNAL',
        message: `Batch create produced 0 successful tests out of ${response.summary.total} specs.`,
        nextAction:
          'Inspect per-spec errors in `results[]` (each entry carries `status` and `error.code`). Fix the failing specs and retry; pass the same --idempotency-key to safely re-send.',
        requestId: 'local',
        details: {
          total: response.summary.total,
          created: 0,
          failed: response.summary.failed,
        },
      },
    });
  }

  // Fix 5: enrich results with per-item dashboardUrl in JSON mode.
  // projectId comes from specs[specIndex].projectId; testId from the result row.
  // Only emitted where both are known client-side — no extra network calls.
  // R1: suppress under --dry-run — test ids are fake canned values and a
  // live-looking URL would mislead the caller.
  const apiUrlForDashboard = resolveApiUrl(opts, deps);
  const enrichedResponse: CliCreateBatchResponse =
    !opts.dryRun && opts.output === 'json'
      ? {
          ...response,
          results: response.results.map(r => {
            if (r.status !== 'created' || r.testId === undefined) return r;
            const spec = specs[r.specIndex];
            const projectId = spec?.projectId;
            if (!projectId) return r;
            const dashboardUrl = resolvePortalUrl(apiUrlForDashboard, projectId, r.testId);
            return dashboardUrl !== undefined ? { ...r, dashboardUrl } : r;
          }),
        }
      : response;

  // --run: suppress the create output in JSON mode (we'll emit a single
  // merged envelope at the end). In text mode, still print the create
  // summary so the operator can see what was created.
  if (!opts.run) {
    out.print(enrichedResponse, data => renderBatchText(data as CliCreateBatchResponse));
  } else if (opts.output !== 'json') {
    out.print(enrichedResponse, data => renderBatchText(data as CliCreateBatchResponse));
  }

  // --run: fan out a trigger for each created test, then emit results.
  if (opts.run === true) {
    // R3b: build testId → projectId map from the create results + specs so
    // runBatchRun can enrich per-item run JSON with dashboardUrl.
    const runTestIdToProjectId = new Map<string, string>();
    for (const r of response.results) {
      if (r.status === 'created' && r.testId !== undefined) {
        const projectId = specs[r.specIndex]?.projectId;
        if (projectId) runTestIdToProjectId.set(r.testId, projectId);
      }
    }
    await runBatchRun(
      opts,
      response,
      client,
      out,
      deps,
      opts.dryRun ? undefined : runTestIdToProjectId,
      opts.dryRun ? undefined : apiUrlForDashboard,
    );
    // runBatchRun handles its own exit-code logic via CLIError.
    // Return the create response to satisfy the return type; callers that
    // inspect the return value only do so when not using --run.
  }

  return response;
}

/**
 * Fan-out trigger for `test create-batch --run`.
 *
 * For each test successfully created in `createResponse`, mints a fresh
 * idempotency key and calls `POST /tests/{testId}/runs`. Concurrency is
 * bounded by `opts.maxConcurrency` (defaults to `DEFAULT_BATCH_RUN_CONCURRENCY` = 50 when absent). With
 * `--wait`, polls each run until terminal. Per-run timeout applies
 * individually (not aggregate).
 *
 * Output:
 *   - JSON mode: `{ results: CliBatchRunResult[] }` on stdout (single envelope).
 *   - Text mode: one line per completed run as they finish, then a final
 *     summary line `N/M passed, X failed, Y blocked, Z cancelled`.
 *
 * Exit codes:
 *   - 0 if every run passed.
 *   - 1 if any run failed/blocked/cancelled (or trigger error).
 *   - 7 if ALL runs timed out or errored with exit 7.
 *   - For other uniform errors (CONFLICT=6, RATE_LIMITED=11): exit with
 *     that code only when ALL runs share the same code; otherwise 1.
 */
async function runBatchRun(
  opts: CreateBatchOptions,
  createResponse: CliCreateBatchResponse,
  client: HttpClient,
  out: Output,
  deps: TestDeps,
  /** R3b: testId → projectId mapping built from create results + specs, used to enrich
   *  run-path JSON items with dashboardUrl. Populated by the caller; absent (undefined)
   *  means no enrichment (e.g. dry-run or caller didn't supply it). */
  testIdToProjectId?: Map<string, string>,
  /** R3b: resolved API URL for portal link resolution. */
  apiUrlForDashboard?: string,
): Promise<void> {
  const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const timeoutSeconds = opts.timeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS;
  const concurrencyLimit = opts.maxConcurrency ?? DEFAULT_BATCH_RUN_CONCURRENCY;

  // Collect successfully-created testIds in specIndex order.
  const testIds = createResponse.results
    .filter(r => r.status === 'created' && r.testId !== undefined)
    .map(r => r.testId as string);

  if (testIds.length === 0) {
    // All specs failed at create time — already threw above; unreachable.
    return;
  }

  // Dry-run: print a descriptor envelope and return without real triggers.
  if (opts.dryRun) {
    const dryRunResults: CliBatchRunResult[] = testIds.map(testId => ({
      testId,
      runId: `dry-run-${randomUUID()}`,
      status: 'queued',
      codeVersion: 'v1',
    }));
    const envelope = {
      dryRun: true,
      method: 'POST',
      pathTemplate: '/api/cli/v1/tests/{testId}/runs',
      maxConcurrency: opts.maxConcurrency ?? null,
      wait: opts.wait ?? false,
      timeoutSeconds,
      testIds,
      ...(opts.wait ? { thenPoll: `/api/cli/v1/runs/<run-id>?waitSeconds=25` } : {}),
      results: dryRunResults,
    };
    out.print(envelope);
    return;
  }

  const batchRunResults: CliBatchRunResult[] = [];
  const sleepFn = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));

  /**
   * Client-side sliding-window throttle: caps outgoing triggers at
   * BATCH_RUN_RATE_LIMIT (50) per BATCH_RUN_RATE_WINDOW_MS (60 s), sitting
   * just under the server's 60 triggers/min/key cap as a courtesy brake
   * regardless of `--max-concurrency`.
   *
   * Separate CLI processes cannot coordinate this counter; cross-process
   * collisions are handled by the RATE_LIMITED outer retry loop below.
   */
  const rateThrottle = new RateThrottle(BATCH_RUN_RATE_LIMIT, BATCH_RUN_RATE_WINDOW_MS);

  /**
   * Trigger (and optionally poll) a single testId.
   *
   * When `opts.wait` is set, a per-spec wall-clock deadline is set
   * immediately before the first trigger attempt.  Every throttle/retry sleep
   * and the final `pollRunUntilTerminal` call receive only the remaining
   * seconds so the `--wait` budget is never re-started after retries.
   *
   * Returns a CliBatchRunResult. Never throws — errors are captured
   * into the result's `error` field so one failure doesn't abort siblings.
   */
  async function triggerOne(testId: string): Promise<CliBatchRunResult> {
    // Mint a fresh idempotency key per run — MUST NOT reuse the create key.
    const runIdempotencyKey = `cli-batch-run-${randomUUID()}`;
    if (opts.debug) {
      stderrFn(`[batch-run] ${testId} idempotency-key: ${runIdempotencyKey}`);
    }

    // MAJOR 2: record the wall-clock deadline before the first trigger attempt
    // when --wait is set so that throttle/retry sleeps + the subsequent poll all
    // draw from the SAME budget. Triggering at t=0, waiting 60 s for throttle,
    // then starting a fresh full-timeout poll would allow the spec to consume
    // 2× the intended budget.
    const specDeadlineMs: number | undefined = opts.wait
      ? Date.now() + timeoutSeconds * 1000
      : undefined;

    /** Returns remaining milliseconds until the per-spec deadline, or Infinity when no deadline. */
    function remainingMs(): number {
      if (specDeadlineMs === undefined) return Infinity;
      return Math.max(0, specDeadlineMs - Date.now());
    }

    let triggerResponse: TriggerRunResponse;

    // Outer RATE_LIMITED retry loop.
    // The batch call site passes `retryOnRateLimit: false` to `triggerRunWithMeta`
    // so the HTTP layer throws on the first 429 — this loop is the SOLE owner of
    // rate-limit handling. Single `test run` / `test create --run` still use
    // retryOnRateLimit: true (the default) and are unaffected by this loop.
    let outerRateLimitAttempt = 0;
    while (true) {
      // Fix 2: deadline check BEFORE acquiring a throttle slot or firing a trigger.
      // Without this guard, an outer retry could acquire a slot and send a new
      // POST even after the --wait deadline has already expired.
      if (opts.wait && remainingMs() <= 0) {
        return {
          testId,
          runId: '',
          status: 'timeout',
          codeVersion: '',
          error: {
            code: 'UNSUPPORTED',
            message: `Timed out after ${timeoutSeconds}s before trigger attempt for ${testId}.`,
            exitCode: 7,
          },
        };
      }

      // Acquire a slot in the client-side rate window before firing the trigger.
      // If the window is full, sleep until the oldest slot ages out — clamped to
      // the remaining deadline so we don't overshoot the --wait budget.
      let throttleWait: number;
      while ((throttleWait = rateThrottle.acquire()) > 0) {
        const clampedWait = Math.min(throttleWait, remainingMs());
        if (clampedWait <= 0) {
          // Deadline already passed while waiting for a throttle slot.
          return {
            testId,
            runId: '',
            status: 'timeout',
            codeVersion: '',
            error: {
              code: 'UNSUPPORTED',
              message: `Timed out after ${timeoutSeconds}s waiting to acquire throttle slot for ${testId}.`,
              exitCode: 7,
            },
          };
        }
        if (opts.debug) {
          stderrFn(
            `[batch-run] ${testId} — rate throttle: waiting ${Math.ceil(clampedWait / 1000)}s before trigger`,
          );
        }
        await sleepFn(clampedWait);
      }

      try {
        const result = await client.triggerRunWithMeta(
          testId,
          { source: 'cli', ...(opts.targetUrl ? { targetUrl: opts.targetUrl } : {}) },
          // retryOnRateLimit: false — the outer retry loop is the SOLE owner of
          // rate-limit handling for the batch path. Allowing the HTTP layer to add
          // up to 3 internal retries per outer attempt would multiply trigger
          // POSTs per spec (e.g. 50×3 = 150/min), blowing the server's 60/min cap.
          { idempotencyKey: runIdempotencyKey, retryOnRateLimit: false },
        );
        triggerResponse = result.body;
        break; // success — exit the outer retry loop
      } catch (err) {
        // RATE_LIMITED outer retry. Since the HTTP layer no longer retries
        // RATE_LIMITED (retryOnRateLimit: false above), every 429 reaches here
        // on the first attempt.
        // MAJOR 3: `ApiError.retryAfterMs` now carries the parsed `Retry-After`
        // header value (clamped to [1s, 300s] by HttpClient). Use it instead of
        // falling back to a hardcoded 60 s when the header is present.
        //
        // Credit-depletion vs transient rate-limit (project knowledge):
        // Both conditions surface as `RATE_LIMITED` (exit 11). Credit depletion
        // is PERMANENT — no amount of waiting will fix it. Only the transient
        // per-minute throttle is safe to retry. `isTransientRateLimit()` checks
        // for the `Retry-After` header OR the per-minute wording to distinguish.
        if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
          if (!isTransientRateLimit(err)) {
            // Permanent condition (insufficient credits or unknown RATE_LIMITED
            // variant without Retry-After). Surface immediately — never retry.
            return {
              testId,
              runId: '',
              status: 'error',
              codeVersion: '',
              error: { code: err.code, message: err.message, exitCode: err.exitCode },
            };
          }

          if (outerRateLimitAttempt < BATCH_RUN_RATE_MAX_OUTER_RETRIES) {
            outerRateLimitAttempt++;

            // MAJOR 3: use retryAfterMs from the thrown ApiError when available
            // (set by HttpClient from the HTTP Retry-After header, clamped to
            // [1s, 300s]). Fall back to details.retryAfterSeconds, then 60 s.
            let retryAfterMs: number;
            if (err.retryAfterMs !== undefined) {
              retryAfterMs = err.retryAfterMs;
            } else {
              const retryAfterSec = err.getDetail<number>(
                'retryAfterSeconds',
                (v): v is number => typeof v === 'number' && v > 0,
              );
              retryAfterMs = Math.min((retryAfterSec ?? 60) * 1000, 120_000);
            }

            // MAJOR 2: clamp to remaining deadline so we don't overshoot the
            // --wait budget.
            const clampedRetryMs = Math.min(retryAfterMs, remainingMs());
            if (clampedRetryMs <= 0) {
              return {
                testId,
                runId: '',
                status: 'timeout',
                codeVersion: '',
                error: {
                  code: 'UNSUPPORTED',
                  message: `Timed out after ${timeoutSeconds}s during rate-limit backoff for ${testId}.`,
                  exitCode: 7,
                },
              };
            }
            stderrFn(
              `[batch-run] ${testId} — RATE_LIMITED (outer attempt ${outerRateLimitAttempt}/${BATCH_RUN_RATE_MAX_OUTER_RETRIES}): waiting ${Math.ceil(clampedRetryMs / 1000)}s before retry`,
            );
            await sleepFn(clampedRetryMs);
            continue; // retry the outer loop
          }
          // Exceeded outer retry cap — surface as terminal error.
          return {
            testId,
            runId: '',
            status: 'error',
            codeVersion: '',
            error: { code: err.code, message: err.message, exitCode: err.exitCode },
          };
        }
        // Reuse the same CONFLICT + --wait auto-resume logic as single-test run.
        if (opts.wait && err instanceof ApiError && err.code === 'CONFLICT') {
          const conflictReason = err.getDetail<string>(
            'reason',
            (v): v is string => typeof v === 'string' && v.length > 0,
          );
          const currentRunId = err.getDetail<string>(
            'currentRunId',
            (v): v is string => typeof v === 'string' && v.length > 0,
          );
          if (conflictReason === 'run_in_flight' && currentRunId !== undefined) {
            stderrFn(
              `[batch-run] ${testId} — run already in flight (runId: ${currentRunId}). Auto-resuming wait.`,
            );
            triggerResponse = {
              runId: currentRunId,
              status: 'queued',
              enqueuedAt: new Date().toISOString(),
              codeVersion: '',
              targetUrl: opts.targetUrl ?? '',
            };
            break; // exit the outer retry loop with a conflict-resumed response
          } else {
            return {
              testId,
              runId: '',
              status: 'error',
              codeVersion: '',
              error: {
                code: (err as ApiError).code,
                message: (err as Error).message,
                exitCode: (err as ApiError).exitCode,
              },
            };
          }
        } else if (err instanceof RequestTimeoutError) {
          // Client-side per-request timeout during trigger — classify as a timeout
          // (exit 7) so the all-timeout aggregation can fire, mirroring the poll
          // TimeoutError path below.
          return {
            testId,
            runId: '',
            status: 'timeout',
            codeVersion: '',
            error: { code: 'UNSUPPORTED', message: err.message, exitCode: err.exitCode },
          };
        } else {
          const apiErr = err instanceof ApiError ? err : undefined;
          return {
            testId,
            runId: '',
            status: 'error',
            codeVersion: '',
            error: {
              code: apiErr?.code ?? 'INTERNAL',
              message: err instanceof Error ? err.message : String(err),
              exitCode: apiErr?.exitCode ?? 1,
            },
          };
        }
      }
    }

    if (!opts.wait) {
      // No-wait path: return the trigger response as-is.
      if (opts.output !== 'json') {
        stderrFn(
          `[batch-run] ${testId} — triggered (runId: ${triggerResponse.runId}, status: ${triggerResponse.status})`,
        );
      }
      return {
        testId,
        runId: triggerResponse.runId,
        status: triggerResponse.status,
        codeVersion: triggerResponse.codeVersion,
      };
    }

    // --wait path: poll until terminal.
    // Fix 3: check remaining budget BEFORE computing remainingSeconds so that
    // 0 remaining ms (deadline already passed) yields a timeout result without
    // polling. Math.max(1, ...) would otherwise convert 0 ms → 1 s poll.
    const rem = remainingMs();
    if (opts.wait && rem <= 0) {
      return {
        testId,
        runId: triggerResponse.runId,
        status: 'timeout',
        codeVersion: triggerResponse.codeVersion,
        error: {
          code: 'UNSUPPORTED',
          message: `Timed out after ${timeoutSeconds}s before polling run ${triggerResponse.runId}.`,
          exitCode: 7,
        },
      };
    }
    // Pass only the REMAINING seconds into pollRunUntilTerminal so trigger
    // retries don't restart the timeout clock from zero.
    const remainingSeconds = Math.floor(rem / 1000) || 1;
    let finalRun: RunResponse;
    try {
      finalRun = await pollRunUntilTerminal(client, triggerResponse.runId, {
        timeoutSeconds: remainingSeconds,
        sleep: deps.sleep,
        onTransition: opts.verbose
          ? (msg: string) => stderrFn(`[batch-run][verbose] ${testId}: ${msg}`)
          : undefined,
      });
    } catch (err) {
      if (err instanceof TimeoutError) {
        if (opts.output !== 'json') {
          stderrFn(
            `[batch-run] ${testId} (runId: ${triggerResponse.runId}) — timed out after ${timeoutSeconds}s`,
          );
        }
        return {
          testId,
          runId: triggerResponse.runId,
          status: 'timeout',
          codeVersion: triggerResponse.codeVersion,
          error: {
            code: 'UNSUPPORTED',
            message: `Timed out after ${timeoutSeconds}s waiting for run ${triggerResponse.runId}.`,
            exitCode: 7,
          },
        };
      }
      if (err instanceof RequestTimeoutError) {
        // Client-side per-request timeout during polling — classify as timeout
        // (exit 7), consistent with the poll TimeoutError path above.
        return {
          testId,
          runId: triggerResponse.runId,
          status: 'timeout',
          codeVersion: triggerResponse.codeVersion,
          error: { code: 'UNSUPPORTED', message: err.message, exitCode: err.exitCode },
        };
      }
      const apiErr = err instanceof ApiError ? err : undefined;
      return {
        testId,
        runId: triggerResponse.runId,
        status: 'error',
        codeVersion: triggerResponse.codeVersion,
        error: {
          code: apiErr?.code ?? 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
          exitCode: apiErr?.exitCode ?? 1,
        },
      };
    }

    if (opts.output !== 'json') {
      stderrFn(
        `[batch-run] ${testId} (runId: ${finalRun.runId}) — ${finalRun.status}${finalRun.failureKind ? ` (${finalRun.failureKind})` : ''}`,
      );
    }

    return {
      testId: finalRun.testId,
      runId: finalRun.runId,
      status: finalRun.status,
      codeVersion: finalRun.codeVersion,
      videoUrl: finalRun.videoUrl,
      failureKind: finalRun.failureKind,
    };
  }

  // Bounded concurrency fan-out: launch up to concurrencyLimit jobs, then
  // launch the next one as each finishes. Mirrors the startNext() pattern
  // used by the other fan-outs in this file (e.g. pollFreshAccepted below).
  let nextIdx = 0;
  let inFlight = 0;

  await new Promise<void>((resolve, reject) => {
    function startNext(): void {
      while (inFlight < concurrencyLimit && nextIdx < testIds.length) {
        const testId = testIds[nextIdx++]!;
        inFlight++;
        triggerOne(testId)
          .then(result => {
            batchRunResults.push(result);
            inFlight--;
            startNext();
            if (inFlight === 0 && nextIdx >= testIds.length) resolve();
          })
          .catch(reject);
      }
    }
    startNext();
    if (testIds.length === 0) resolve();
  });

  // Sort by testId order (same as input order for stable output).
  batchRunResults.sort((a, b) => testIds.indexOf(a.testId) - testIds.indexOf(b.testId));

  // Emit output.
  if (opts.output === 'json') {
    // R3b: enrich per-item run results with dashboardUrl when both testId and
    // projectId are known (from the testIdToProjectId map built by the caller).
    // Additive-optional: items where projectId is unknown are left unchanged.
    const enrichedResults =
      !opts.dryRun && testIdToProjectId !== undefined && apiUrlForDashboard !== undefined
        ? batchRunResults.map(r => {
            const projectId = testIdToProjectId.get(r.testId);
            if (!projectId || !r.testId) return r;
            const dashboardUrl = resolvePortalUrl(apiUrlForDashboard, projectId, r.testId);
            return dashboardUrl !== undefined ? { ...r, dashboardUrl } : r;
          })
        : batchRunResults;
    out.print({ results: enrichedResults });
  } else {
    // Text mode: print summary line.
    const passed = batchRunResults.filter(r => r.status === 'passed').length;
    const failed = batchRunResults.filter(r => r.status === 'failed').length;
    const blocked = batchRunResults.filter(r => r.status === 'blocked').length;
    const cancelled = batchRunResults.filter(r => r.status === 'cancelled').length;
    const errored = batchRunResults.filter(
      r => r.status === 'error' || r.status === 'timeout',
    ).length;
    const total = batchRunResults.length;
    const parts = [`${passed}/${total} passed`];
    if (failed > 0) parts.push(`${failed} failed`);
    if (blocked > 0) parts.push(`${blocked} blocked`);
    if (cancelled > 0) parts.push(`${cancelled} cancelled`);
    if (errored > 0) parts.push(`${errored} error/timeout`);
    stderrFn(`batch-run summary: ${parts.join(', ')}`);
  }

  // Determine exit code.
  const allPassed = batchRunResults.every(r => r.status === 'passed');
  if (allPassed) return; // exit 0

  // Check for a uniform non-pass exit code across all non-passed results.
  const errorExitCodes = batchRunResults
    .filter(r => r.error !== undefined)
    .map(r => r.error!.exitCode);
  const nonPassedStatuses = batchRunResults.filter(r => r.status !== 'passed');
  // Exit 7 only when EVERY run timed out — a mix of pass + timeout is "mixed
  // outcomes" (exit 1), not "all timed out". `nonPassedStatuses.every(...)`
  // would incorrectly fire exit 7 when 1 of N passed and the rest timed out.
  const allTimeout =
    batchRunResults.length > 0 &&
    batchRunResults.every(r => r.status === 'timeout' || r.error?.exitCode === 7);
  if (allTimeout) {
    throw new CLIError(
      `All ${batchRunResults.length} batch run(s) timed out after ${timeoutSeconds}s.`,
      7,
    );
  }
  // If all non-passed results share the same specific exit code (6 or 11), use it.
  if (errorExitCodes.length > 0 && errorExitCodes.length === nonPassedStatuses.length) {
    const uniformCode = errorExitCodes[0];
    if (
      uniformCode !== undefined &&
      errorExitCodes.every(c => c === uniformCode) &&
      uniformCode !== 1 &&
      uniformCode !== 7
    ) {
      throw new CLIError(
        `Batch run finished: ${nonPassedStatuses.length} run(s) failed with exit code ${uniformCode}.`,
        uniformCode,
      );
    }
  }
  // Default: mixed outcomes or generic failure → exit 1.
  throw new CLIError(
    `Batch run finished: ${batchRunResults.filter(r => r.status !== 'passed').length} of ${batchRunResults.length} run(s) did not pass.`,
    1,
  );
}

/**
 * Read + parse a JSONL plans file. Per-line validation; spec-level
 * errors fail the whole batch before we send (since the server can't
 * give us a per-spec response for a parse error). Caps the number of
 * specs at 50 before any per-spec work happens.
 */
function readPlansJsonlGuarded(path: string): CliPlanInput[] {
  const absolute = resolveAbsolute(path);

  let stat;
  try {
    stat = statSync(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw localValidationError('plans', `file does not exist: ${path}`);
    }
    if (code === 'EACCES') {
      throw localValidationError('plans', `permission denied reading ${path}`);
    }
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw localValidationError('plans', `cannot stat ${path}: ${reason}`);
  }
  if (stat.size > MAX_BATCH_BODY_BYTES) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Batch file exceeds the 5 MB CLI cap (${stat.size} bytes).`,
        nextAction: 'Split into multiple --plans files.',
        requestId: 'local',
        details: { field: 'plans', sizeBytes: stat.size, maxBytes: MAX_BATCH_BODY_BYTES },
      },
    });
  }

  let raw;
  try {
    raw = stripBom(readFileSync(absolute, 'utf8'));
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw localValidationError('plans', `cannot read ${path}: ${reason}`);
  }

  const lines = raw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
  if (lines.length === 0) {
    throw localValidationError('plans', 'file is empty (no JSONL records)');
  }
  if (lines.length > MAX_BATCH_SPECS) {
    throw localValidationError(
      'plans',
      `must contain at most ${MAX_BATCH_SPECS} specs (got ${lines.length})`,
    );
  }

  const specs: CliPlanInput[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]!);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      throw localValidationError(`plans[${i}]`, `not valid JSON: ${reason}`);
    }
    specs.push(assertPlanShape(parsed, { specIndex: i }));
  }
  return specs;
}

/**
 * `test create-batch --plan-from-dir <dir>` helper — M3.2 piece-5 extension
 * (dogfood L1800).
 *
 * Globs all `*.json` files in the directory (non-recursive, sorted by name for
 * determinism), reads each as a `CliPlanInput`, assembles them into the same
 * in-process array that `--plans <jsonl>` produces, then runs the existing
 * create-batch path. Validates each file individually and reports errors by
 * filename so the caller can fix one file at a time.
 *
 * Caps: 50 specs total (same as JSONL); aggregate size checked against
 * MAX_BATCH_BODY_BYTES (5 MB) using the JSON-serialised size of the assembled
 * spec array.
 */
function readPlansFromDirGuarded(dir: string, stderrFn: (line: string) => void): CliPlanInput[] {
  const absolute = resolveAbsolute(dir);

  let entries: string[];
  try {
    const dirStat = statSync(absolute);
    if (!dirStat.isDirectory()) {
      throw localValidationError('plan-from-dir', `not a directory: ${dir}`);
    }
    entries = readdirSync(absolute)
      .filter(f => extname(f).toLowerCase() === '.json')
      .sort();
  } catch (err) {
    if (err instanceof ApiError || err instanceof CLIError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw localValidationError('plan-from-dir', `directory does not exist: ${dir}`);
    }
    if (code === 'EACCES') {
      throw localValidationError('plan-from-dir', `permission denied reading directory: ${dir}`);
    }
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw localValidationError('plan-from-dir', `cannot read directory ${dir}: ${reason}`);
  }

  if (entries.length === 0) {
    throw localValidationError('plan-from-dir', `no *.json files found in directory: ${dir}`);
  }

  stderrFn(`Reading ${entries.length} plan file${entries.length !== 1 ? 's' : ''} from ${dir}`);

  const specs: CliPlanInput[] = [];
  let skippedCount = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const filename = entries[i]!;
    const filePath = join(absolute, filename);

    let raw: string;
    try {
      raw = stripBom(readFileSync(filePath, 'utf8'));
    } catch (err) {
      // Hard I/O error (permission denied etc.): re-throw so the user knows the
      // directory is unreadable — this is not a "skip" case.
      const reason = err instanceof Error ? err.message : 'unknown error';
      throw localValidationError('plan-from-dir', `cannot read ${filename}: ${reason}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Malformed / truncated JSON — FATAL. A syntax error almost certainly
      // means the file was intended as a plan but got corrupted (e.g. a
      // truncated write). Silently skipping it would let automation create
      // an incomplete suite and exit 0 with no indication of the lost plan.
      // Only valid-JSON objects that clearly lack plan identity (see below)
      // are skipped.
      const reason = err instanceof Error ? err.message : 'unknown error';
      throw localValidationError(
        'plan-from-dir',
        `${filename} contains invalid JSON (syntax error / truncated): ${reason} — fix or remove the file`,
      );
    }

    // Heuristic: a "clearly non-plan" file is one that parses successfully as
    // a JSON object but lacks ALL core plan-identity fields (projectId AND
    // planSteps). Examples: suite-index.json, README.json, lock files.
    // A file that HAS some plan fields but fails full assertPlanShape validation
    // (e.g. has projectId but malformed planSteps) is a BOTCHED plan → FATAL.
    const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    const obj = isObject ? (parsed as Record<string, unknown>) : null;
    const looksLikePlan =
      obj !== null &&
      (obj['projectId'] !== undefined ||
        obj['planSteps'] !== undefined ||
        obj['plans'] !== undefined);

    if (!looksLikePlan) {
      // Clearly not a plan — skip with an advisory.
      stderrFn(
        `[warn] Skipping ${filename}: not a plan file (no projectId/planSteps fields — treating as metadata)`,
      );
      skippedCount += 1;
      continue;
    }

    // Parsed object looks like a plan (has some plan fields). Apply full
    // shape validation — any failure here is FATAL because this was an
    // INTENDED plan that has a structural problem the user must fix.
    try {
      specs.push(assertPlanShape(parsed, { specIndex: specs.length }));
    } catch (err) {
      const reason =
        err instanceof ApiError
          ? err.nextAction || err.message
          : err instanceof Error
            ? err.message
            : 'unknown error';
      throw localValidationError(
        'plan-from-dir',
        `${filename} looks like a plan file but failed validation: ${reason} — fix or remove the file`,
      );
    }
  }

  // If every file was skipped, escalate to a fatal error.
  if (specs.length === 0) {
    throw localValidationError(
      'plan-from-dir',
      `no valid plan files found in directory: ${dir} (${skippedCount} file${skippedCount !== 1 ? 's' : ''} skipped — not valid plan specs)`,
    );
  }

  // Enforce the batch-size cap on VALID specs (after skipping non-plan files
  // like suite-index.json). A directory with 50 valid plans + 1 skipped file
  // should succeed; the old check on entries.length rejected it pre-skip.
  if (specs.length > MAX_BATCH_SPECS) {
    throw localValidationError(
      'plan-from-dir',
      `directory contains ${specs.length} valid plan specs, but the batch limit is ${MAX_BATCH_SPECS} — remove some files or split into multiple batches`,
    );
  }

  // Aggregate size guard — stringify the assembled array and check total bytes.
  const assembled = JSON.stringify(specs);
  if (assembled.length > MAX_BATCH_BODY_BYTES) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: `Plan-from-dir batch exceeds the 5 MB CLI cap (${assembled.length} bytes after assembly).`,
        nextAction: 'Split into multiple smaller directories or trim step descriptions.',
        requestId: 'local',
        details: {
          field: 'plan-from-dir',
          sizeBytes: assembled.length,
          maxBytes: MAX_BATCH_BODY_BYTES,
        },
      },
    });
  }

  return specs;
}

/**
 * Returns the total number of specs that are members of groups where ≥3
 * specs share an identical plan body (planSteps + description).
 *
 * Group key: JSON-stable stringify of the spec's planSteps array (type +
 * description per step, in order) plus the optional top-level description.
 * Specs without planSteps (e.g. backend specs) are excluded — they produce
 * no group key and never trigger the advisory.
 *
 * Used by `runCreateBatch` to emit a one-shot stderr advisory when the
 * operator is likely scoring multiple targets against the same plan body
 * (dogfood L120, 2026-05-28).
 */
function countDuplicatePlanBodies(specs: CliPlanInput[]): number {
  const counts = new Map<string, number>();
  for (const spec of specs) {
    if (!spec.planSteps || spec.planSteps.length === 0) continue;
    // Normalise: extract only type+description from each step so incidental
    // extra fields don't break grouping, then pair with the spec description.
    const stepsKey = JSON.stringify(
      spec.planSteps.map(s => ({ type: s.type, description: s.description })),
    );
    const key = JSON.stringify({ steps: stepsKey, description: spec.description ?? '' });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let dupTotal = 0;
  for (const count of counts.values()) {
    if (count >= 3) dupTotal += count;
  }
  return dupTotal;
}

function renderBatchText(response: CliCreateBatchResponse): string {
  const lines = [
    `total   ${response.summary.total}`,
    `created ${response.summary.created}`,
    `failed  ${response.summary.failed}`,
    '',
    'specIndex  status            testId',
  ];
  for (const r of response.results) {
    const testId = r.testId ?? '-';
    const status = r.status.padEnd(17);
    const specIdx = String(r.specIndex).padStart(9);
    lines.push(`${specIdx}  ${status} ${testId}`);
  }
  return lines.join('\n');
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

interface CodeGetOptions extends CommonOptions {
  testId: string;
  /**
   * Optional output file path. When set, the source body (text mode) or
   * the JSON envelope (json mode) is written to this file instead of
   * stdout. Streaming + backpressure are preserved: presigned downloads
   * pipe straight into the file's write stream so a multi-MB body never
   * sits in memory waiting for the full download. Per
   * the CLI validation spec §4 P4: "the CLI streams the body to stdout
   * (or `--out`) without buffering the whole thing in memory."
   */
  out?: string;
}

/**
 * `test code get` — fetches §6.3 `TestCode`. JSON mode prints the wire
 * shape verbatim (the caller decides whether to follow `code` as a URL).
 * Text mode prints the source body itself: inline bodies pass through
 * directly; presigned URLs are dereferenced via the same fetch impl
 * (without API-key headers — the URL is the bearer of authority).
 *
 * `--out <path>` redirects the same bytes into a file. We validate the
 * path and open a sibling temp file before issuing the network request
 * so a permission/dir error fails fast (exit 5 / VALIDATION_ERROR)
 * without spending an API call. The temp file is renamed onto the real
 * `--out` path only after a successful, complete write; on any error
 * (or the "no code generated yet" branch, which writes nothing) the
 * temp file is discarded and the user's pre-existing `--out` file, if
 * any, is left untouched.
 */
export async function runCodeGet(opts: CodeGetOptions, deps: TestDeps = {}): Promise<CliTestCode> {
  // Dry-run: no fetch, no fs. Print the canned shape to stdout and, if
  // the user passed `--out`, log on stderr what would have been written.
  // We deliberately do NOT validate the `--out` path here in dry-run —
  // a missing-parent path is a real-mode failure mode; in dry-run the
  // point is "show me the shape, no side effects."
  if (opts.dryRun) {
    const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    const out = makeOutput(opts.output, deps);
    const client = makeClient(opts, deps);
    const code = await client.get<CliTestCode>(`/tests/${encodeURIComponent(opts.testId)}/code`);
    if (opts.out !== undefined) {
      const bytes = isPresignedCodeUrl(code.code) ? '<presigned-stream>' : `${code.code.length}`;
      stderr(`[dry-run] would write code body (${bytes} bytes) to ${opts.out}`);
    }
    if (opts.output === 'json') {
      out.print(code);
    } else {
      await out.writeChunk(code.code);
    }
    return code;
  }

  let fileSink = opts.out !== undefined ? openOutputFile(opts.out) : null;
  const out = fileSink ? makeFileOutput(opts.output, fileSink) : makeOutput(opts.output, deps);
  const client = makeClient(opts, deps);

  try {
    const code = await client.get<CliTestCode>(`/tests/${encodeURIComponent(opts.testId)}/code`);
    let wroteContent = false;

    if (opts.output === 'json') {
      out.print(code);
      wroteContent = true;
    } else if (isPresignedCodeUrl(code.code)) {
      // Text mode: dump the source body. JSON consumers want the wire
      // shape; humans (and agents shelling out via `> file.ts`) want
      // ready-to-edit code. Stream chunk-wise so a multi-MB generated
      // suite doesn't sit in memory waiting for the full download.
      // `writeChunk` awaits the rawStdout drain promise so a slow
      // downstream consumer (a file on a slow disk, an NFS mount,
      // or a piped `gzip`) pauses the upstream reader rather than
      // letting chunks accumulate in V8's heap.
      await streamPresignedBody(code.code, out, deps);
      wroteContent = true;
    } else if (code.code === '' || code.code === null) {
      // P2-10: draft test with no code yet — empty body would produce
      // silent empty stdout. Print a friendly hint to stderr instead so
      // the operator knows what happened, and keep exit 0 when no `--out`.
      //
      // With `--out`, refuse to leave a zero-byte artifact behind: agents
      // and scripts that check file size would otherwise treat exit 0 as
      // a successful download. Discard the temp sink without touching a
      // pre-existing destination file.
      if (fileSink) {
        await abortOutputFile(fileSink);
        fileSink = null;
        throw localValidationError(
          'out',
          'test has no generated code yet — run the test first (refusing to write an empty --out file)',
        );
      }
      const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
      stderrFn('(no code generated yet — run the test first)');
    } else {
      await out.writeChunk(code.code);
      wroteContent = true;
    }

    if (fileSink) await closeOutputFile(fileSink, wroteContent);
    return code;
  } catch (err) {
    if (fileSink) await closeOutputFile(fileSink, false).catch(() => undefined);
    throw err;
  }
}

/**
 * §6.X / M3.2 piece-4 `PutTestCodeResponse` shape. `codeVersion` is
 * the freshly bumped value the server stamped on the entity. Used as
 * the next call's `If-Match` so an agent can chain put → put without
 * round-tripping through `test get` between writes.
 */
export interface CliPutTestCodeResponse {
  testId: string;
  codeVersion: string;
  updatedAt: string;
}

type CodePutLanguage = CliTestCode['language'];
// Only `python` is accepted as a `--language` INPUT: TestSprite executes
// stored test code as Python (FE Playwright `playwright.async_api`, BE
// `requests`/pytest), so accepting `typescript`/`javascript` would be a
// false promise. The read-side `CliTestCode['language']` union keeps ts/js
// for wire fidelity with legacy rows the server may still return.
const CODE_PUT_LANGUAGES: ReadonlyArray<CodePutLanguage> = ['python'];

interface CodePutOptions extends CommonOptions {
  testId: string;
  /** Source path to the new code body. Read into memory; capped at 350 KB. */
  codeFile: string;
  /**
   * `If-Match: <codeVersion>` value. Mutually exclusive with `force`.
   * When neither is set, the CLI auto-fetches the current
   * `codeVersion` via `GET /tests/{id}/code` and uses that — a
   * convenience for human callers; agents should set this explicitly.
   */
  expectedVersion?: string;
  /** `--force` → sends `If-Match: *`. Audit-logged with `force: true`. */
  force?: boolean;
  /** Optional language override; server defaults from the test's existing language otherwise. */
  language?: CodePutLanguage;
  /** Caller-supplied idempotency token; UUIDv4 minted client-side if absent. */
  idempotencyKey?: string;
  /**
   * When set alongside `--dry-run`, synthesises an error envelope and
   * runs through the error-handler path so the user can preview the
   * retry-hint output and exit code without a real API key.
   * Only `PRECONDITION_FAILED` is supported today.
   */
  dryRunSimulateError?: 'PRECONDITION_FAILED';
}

/**
 * `test code put <test-id> --code-file <path>` — M3.2 piece-4.
 *
 * Replace the test's code body with optimistic concurrency. Backend
 * checks `If-Match: <codeVersion>` against the current entity row; on
 * match, bumps to `v(N+1)` and writes the new body via
 * `StorageService.saveCodeContent`. On mismatch, returns 412
 * `PRECONDITION_FAILED` with `currentCodeVersion` in the error body so
 * the caller can retry without an extra `GET`.
 *
 * Concurrency flag negotiation (CLI side):
 *
 *   --expected-version <v>     → If-Match: <v>          (preferred for agents)
 *   --force                    → If-Match: *            (audit-logged with force)
 *   (neither)                  → auto-fetch via GET, then If-Match: <fetched>
 *
 * The auto-fetch path is **a convenience for human callers**. Agents
 * should always pass `--expected-version` explicitly because the
 * auto-fetch introduces a TOCTOU window: a concurrent writer can bump
 * the version between our GET and our PUT. The CLI emits a stderr
 * advisory whenever it takes the auto-fetch path so an operator
 * watching the run can see what `If-Match` value was used.
 *
 * `--force` and `--expected-version` are mutually exclusive — passing
 * both is a caller bug and we reject locally (exit 5) rather than
 * silently picking one. Same is true for missing `--code-file`.
 *
 * 412 handling: the CLI extracts `currentCodeVersion` from the error
 * envelope's `details` block (server populates it per piece-1's
 * `CliPreconditionFailedError`) and prints a typed retry hint. The
 * underlying `ApiError` is re-thrown so the exit-code mapper in
 * `index.ts` lands on exit 6 — the CLI does not auto-retry.
 *
 * Dry-run skips all I/O including the auto-fetch — we substitute the
 * dry-run sample's `codeVersion` (`v3`) so the canned response makes
 * sense (v3 → v4 bump). Matches piece-2's pattern.
 */
export async function runCodePut(
  opts: CodePutOptions,
  deps: TestDeps = {},
): Promise<CliPutTestCodeResponse> {
  assertIdempotencyKey(opts.idempotencyKey);
  requireNonEmpty('test-id', opts.testId);
  requireNonEmpty('code-file', opts.codeFile);
  assertPythonCodeFile(opts.codeFile);

  if (opts.expectedVersion !== undefined && opts.force === true) {
    throw localValidationError(
      'expected-version',
      'is mutually exclusive with --force; pass one or the other (or neither for auto-fetch)',
    );
  }
  if (opts.language !== undefined && !CODE_PUT_LANGUAGES.includes(opts.language)) {
    throw localValidationError('language', `must be one of: ${CODE_PUT_LANGUAGES.join(', ')}`, [
      ...CODE_PUT_LANGUAGES,
    ]);
  }

  const code = opts.dryRun ? DRY_RUN_PLACEHOLDER_CODE : readCodeFileGuarded(opts.codeFile);

  const idempotencyKey = opts.idempotencyKey ?? `cli-code-put-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  // Resolve the If-Match header. Three cases:
  //   1. --force         → '*' (skip etag check; audit-logged)
  //   2. --expected-version <v> → that string verbatim
  //   3. neither         → auto-fetch via GET /tests/{id}/code, use
  //                        returned codeVersion. Tell the user (stderr)
  //                        so an operator watching can see the race
  //                        window we just opened.
  const client = makeClient(opts, deps);
  let ifMatch: string;
  if (opts.force === true) {
    ifMatch = '*';
  } else if (opts.expectedVersion !== undefined) {
    requireNonEmpty('expected-version', opts.expectedVersion);
    ifMatch = opts.expectedVersion;
  } else {
    const fetched = await client.get<CliTestCode>(`/tests/${encodeURIComponent(opts.testId)}/code`);
    const cv = fetched.codeVersion;
    if (cv === null || cv === undefined) {
      // Server hasn't stamped a codeVersion yet (legacy row). Send `*`
      // so the backend's force path applies the bump. Audit will mark
      // force: true — visible signal that our auto-fetch hit a
      // legacy row, not a concurrent-write race.
      ifMatch = '*';
      const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
      stderr(
        `auto-fetched codeVersion=null on legacy row; using If-Match: * for this put. Pass --expected-version explicitly to avoid this fallback.`,
      );
    } else {
      ifMatch = cv;
      const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
      if (opts.dryRun) {
        stderr(
          `[dry-run] would auto-fetch codeVersion before PUT; pass --expected-version to avoid races (sample: ${cv})`,
        );
      } else {
        stderr(
          `auto-fetched codeVersion=${cv} for If-Match. Pass --expected-version explicitly to avoid races.`,
        );
      }
    }
  }

  const body: { code: string; language?: CodePutLanguage } = { code };
  if (opts.language !== undefined) body.language = opts.language;

  const out = makeOutput(opts.output, deps);
  try {
    // --dry-run --dry-run-simulate-error PRECONDITION_FAILED: throw a
    // synthetic 412 envelope so the user sees the retry-hint and exit
    // code 6 without a real API key.  The throw feeds into the catch
    // block below — identical code path as a real server 412.
    if (opts.dryRun && opts.dryRunSimulateError === 'PRECONDITION_FAILED') {
      throw ApiError.fromEnvelope(
        {
          error: {
            code: 'PRECONDITION_FAILED',
            message: `[dry-run simulation] Code conflict: server is at v99, you sent ${ifMatch}.`,
            nextAction: `Re-fetch the current codeVersion and retry with --expected-version v99.`,
            requestId: 'req_dry-run-simulate',
            details: { currentCodeVersion: 'v99' },
          },
        },
        412,
      );
    }
    const response = await client.put<CliPutTestCodeResponse>(
      `/tests/${encodeURIComponent(opts.testId)}/code`,
      {
        body,
        headers: {
          'idempotency-key': idempotencyKey,
          'if-match': ifMatch,
        },
      },
    );
    out.print(response, data => renderCodePutText(data as CliPutTestCodeResponse));
    return response;
  } catch (err) {
    // 412 envelope carries `currentCodeVersion` in details; surface
    // the retry hint on stderr so an operator (or agent reading
    // stderr) can paste it back. We re-throw the ApiError unchanged
    // so the exit-code mapper still lands on exit 6 — the hint is
    // additive, not a substitute.
    if (err instanceof ApiError && err.code === 'PRECONDITION_FAILED') {
      const serverVersion =
        err.getDetail<string>('currentCodeVersion', (v): v is string => typeof v === 'string') ??
        null;
      const sentVersion = ifMatch === '*' ? '*' : ifMatch;
      const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
      if (serverVersion !== null) {
        stderr(
          `Code conflict. Server is at ${serverVersion}, you sent ${sentVersion}. ` +
            `Re-fetch with 'testsprite test get ${opts.testId}' (or 'test code get') and retry with --expected-version ${serverVersion}.`,
        );
      } else {
        stderr(
          `Code conflict on ${opts.testId}. Re-fetch the current codeVersion and retry with --expected-version <new>.`,
        );
      }
    }
    throw err;
  }
}

function renderCodePutText(response: CliPutTestCodeResponse): string {
  return [
    `testId      ${response.testId}`,
    `codeVersion ${response.codeVersion}`,
    `updatedAt   ${response.updatedAt}`,
  ].join('\n');
}

interface StepsOptions extends CommonOptions {
  testId: string;
  pageSize?: number;
  startingToken?: string;
  maxItems?: number;
  /**
   * When set, fetch per-run steps from the authoritative run-scoped endpoint
   * `GET /runs/{runId}?includeSteps=true` instead of client-filtering the
   * cumulative `/tests/{id}/steps` response.
   *
   * Background: FE Portal step rows in `FrontendTestStepEntity` don't reliably
   * carry per-run `runIdIfAvailable`, so client-side filtering of the cumulative
   * list returns an empty result for every runId (even completed runs). The
   * run-scoped endpoint reads from `TestRunStepEntity` directly and returns
   * only the steps for that specific run.
   *
   * Pagination flags (`--page-size`, `--starting-token`, `--max-items`) are
   * ignored when `--run-id` is supplied — the run-scoped endpoint returns all
   * steps in a single response.
   */
  runId?: string;
}

/**
 * Map a `RunStepDto` (from `GET /runs/{runId}?includeSteps=true`) to a
 * `CliTestStep` so both the run-scoped and cumulative paths share the same
 * renderer (`renderStepsText`).
 *
 * Fields that don't exist on `RunStepDto`:
 *   - `testId`                    — taken from the `RunResponse`
 *   - `runIdIfAvailable`          — set to the `runId` we queried
 *   - `codeVersion`               — taken from `RunResponse.codeVersion`
 *   - `capturedAt`                — closest available = `RunStepDto.createdAt`
 *   - `updatedAt`                 — same as `capturedAt` (no separate updatedAt for run-scoped steps)
 *   - `outcomeContributesToFailure` — derived: true when the step's numeric index
 *                                   matches `RunResponse.failedStepIndex`
 */
function mapRunStepToCliTestStep(step: RunStepDto, run: RunResponse): CliTestStep {
  const numericIndex = parseInt(step.stepIndex, 10);
  return {
    testId: run.testId,
    stepIndex: numericIndex,
    action: step.action,
    description: step.description ?? '',
    status: step.status,
    screenshotUrl: step.screenshotUrl,
    htmlSnapshotUrl: step.htmlSnapshotUrl,
    runIdIfAvailable: run.runId,
    codeVersion: run.codeVersion ?? null,
    capturedAt: step.createdAt,
    updatedAt: step.createdAt,
    // `null` = unclassified (the run has no known failed step); otherwise a
    // concrete boolean — `true` for the failing step, `false` for the known
    // non-contributors. (Per the CliTestStep contract: null ≠ false.)
    outcomeContributesToFailure:
      run.failedStepIndex === null ? null : numericIndex === run.failedStepIndex,
  };
}

export async function runSteps(
  opts: StepsOptions,
  deps: TestDeps = {},
): Promise<Page<CliTestStep>> {
  const out = makeOutput(opts.output, deps);
  const client = makeClient(opts, deps);
  const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  // When --run-id is supplied, use the authoritative run-scoped endpoint
  // `GET /runs/{runId}?includeSteps=true` instead of client-filtering the
  // cumulative `/tests/{id}/steps` response. The cumulative FE Portal step
  // rows don't reliably carry per-run `runIdIfAvailable`, so the old
  // client-side filter always returned empty — even for completed runs.
  if (opts.runId !== undefined) {
    // 404 → NOT_FOUND (exit 4) — unknown or cross-tenant runId.
    // All other errors propagate unchanged (auth, transport, etc.).
    const run = await client.getRun(opts.runId, { includeSteps: true });

    // Restore the implicit test-scoping the old `/tests/{testId}/steps` path
    // had: a runId belonging to a DIFFERENT test (same tenant) must not leak
    // that other test's steps under `test steps <thisTestId> --run-id <id>`.
    // Skipped under --dry-run — the canned sample's testId is fixed, not the
    // caller's argument, so a real comparison would always (falsely) mismatch.
    if (!opts.dryRun && run.testId !== opts.testId) {
      throw ApiError.fromEnvelope(
        {
          code: 'NOT_FOUND',
          message: `Run ${opts.runId} does not belong to test ${opts.testId} (it belongs to ${run.testId}). Use 'testsprite test steps ${run.testId} --run-id ${opts.runId}' or drop --run-id.`,
        },
        404,
      );
    }

    const rawSteps = run.steps ?? [];
    const items: CliTestStep[] = rawSteps.map(s => mapRunStepToCliTestStep(s, run));
    const page: Page<CliTestStep> = { items, nextToken: null };

    if (items.length === 0) {
      // The run exists but has no recorded step rows yet (e.g. a fast
      // code-replay run that finished before any steps were written).
      if (opts.output === 'json') {
        out.print(page, data => renderStepsText(data as Page<CliTestStep>));
      } else {
        stderrFn(
          `[advisory] No step records found for run ${opts.runId}. ` +
            `The run may have completed before steps were written, or this run type does not record per-step data. ` +
            `For the full failure bundle use: testsprite test artifact get ${opts.runId}`,
        );
      }
      return page;
    }

    out.print(page, data => renderStepsText(data as Page<CliTestStep>));
    return page;
  }

  // Bare `test steps <id>` (no --run-id): cumulative path — byte-identical to
  // the original behavior. Pagination flags are honored here.
  const paginationFlags: PaginationFlags = validatePaginationFlags({
    pageSize: opts.pageSize,
    startingToken: opts.startingToken,
    maxItems: opts.maxItems,
  });

  const useSinglePage = opts.pageSize !== undefined && opts.maxItems === undefined;
  const path = `/tests/${encodeURIComponent(opts.testId)}/steps`;

  let page: Page<CliTestStep>;
  if (useSinglePage) {
    page = await fetchSinglePage<CliTestStep>(
      client,
      path,
      paginationFlags.pageSize!,
      opts.startingToken,
    );
  } else {
    page = await paginate<CliTestStep>(
      async ({ pageSize, cursor }) =>
        client.get<Page<CliTestStep>>(path, { query: { pageSize, cursor } }),
      paginationFlags,
    );
  }

  // Bare cumulative path: when the returned items span multiple runIds,
  // print a stderr advisory pointing at --run-id so the next invocation
  // can scope. Stdout is unchanged (still the full §6.4 wire shape), so
  // JSON consumers keep working.
  const distinctRunIds = new Set(
    page.items.map(s => s.runIdIfAvailable).filter((v): v is string => v !== null),
  );
  if (distinctRunIds.size > 1) {
    stderrFn(
      `[advisory] returned ${page.items.length} steps span ${distinctRunIds.size} distinct runs. ` +
        `Pass --run-id <id> to scope to a single run.`,
    );
  }

  out.print(page, data => renderStepsText(data as Page<CliTestStep>));
  return page;
}

interface ResultOptions extends CommonOptions {
  testId: string;
  /**
   * §6.5.1 (M2.1 piece 3) — when set, the CLI requests the inline
   * `analysis` block from the facade and renders it under the result
   * summary in text mode. JSON mode prints the wire envelope as
   * received (the `analysis` block lives under the `analysis` key).
   * Optional with default `false` so pre-M2.1 callers don't have to
   * thread the flag through every call site.
   */
  includeAnalysis?: boolean;
}

export async function runResult(
  opts: ResultOptions,
  deps: TestDeps = {},
): Promise<CliLatestResult> {
  const out = makeOutput(opts.output, deps);
  const client = makeClient(opts, deps);
  const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  const path = `/tests/${encodeURIComponent(opts.testId)}/result`;
  const result = await client.get<CliLatestResult>(
    path,
    opts.includeAnalysis === true ? { query: { includeAnalysis: true } } : undefined,
  );

  // D1 — emit a single advisory to stderr when the backend signals that the
  // target URL could not be resolved (source is 'unresolved' or a null that
  // was explicitly sent). Text mode only; JSON mode passes the field through.
  if (
    opts.output !== 'json' &&
    (result.targetUrlSource === 'unresolved' || result.targetUrlSource === null) &&
    result.targetUrl === null
  ) {
    stderrFn(
      '[advisory] target URL unresolved for this run (the stored run row had no target URL); not falling back to the project default.',
    );
  }

  // L141 — in JSON mode, annotate the analysis block with truncation
  // indicators so programmatic consumers know when the backend cut the
  // text. Text mode is unchanged: the renderer already shows the raw
  // (possibly truncated) string and adding a `…` hint is redundant.
  const printData: CliLatestResult =
    opts.output === 'json' && result.analysis !== undefined
      ? { ...result, analysis: annotateAnalysisTruncation(result.analysis) }
      : result;

  out.print(printData, data => renderResultText(data as CliLatestResult));
  return result;
}

// ---------------------------------------------------------------------------
// M3.4 piece-5 — `test result --history` (run-history list)
// ---------------------------------------------------------------------------

/**
 * Parse a duration string (`24h`, `7d`) or ISO timestamp to an absolute
 * ISO string for use as the `?since=` query parameter.
 *
 * - `24h` → `now - 24 hours`
 * - `7d`  → `now - 7 days`
 * - Any other value is returned verbatim (assumed to be an ISO timestamp
 *   or epoch ms string that the server will validate).
 *
 * Translation is done client-side per piece-5 design decision #3.
 */
export function parseDuration(raw: string, now: Date = new Date()): string {
  const hourMatch = /^(\d+)h$/i.exec(raw);
  if (hourMatch) {
    const hours = Number(hourMatch[1]);
    return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
  }
  const dayMatch = /^(\d+)d$/i.exec(raw);
  if (dayMatch) {
    const days = Number(dayMatch[1]);
    return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  }
  // Pass-through: ISO timestamp or epoch value — server validates.
  return raw;
}

interface ResultHistoryOptions extends CommonOptions {
  testId: string;
  /** Filter by trigger source. */
  source?: RunSource;
  /**
   * Lower bound for `createdAt`. Accepts `24h`, `7d`, or an ISO timestamp.
   * Translated client-side to an absolute ISO string before the request.
   */
  since?: string;
  /** Page size 1–100 (default 20). */
  pageSize?: number;
  /** Opaque cursor from a prior page's `nextCursor`. */
  cursor?: string;
}

/**
 * `test result <test-id> --history [options]`
 *
 * List a test's prior runs (M3.4 piece-5). Complements the M2 `test result`
 * "latest result" mode (unchanged). Branches on `--history` inside the shared
 * action handler — the function exposed here is the `--history` branch only;
 * bare `test result <id>` continues to call `runResult`.
 */
export async function runResultHistory(
  opts: ResultHistoryOptions,
  deps: TestDeps = {},
): Promise<ListRunsResponse> {
  const out = makeOutput(opts.output, deps);

  // Validate page size BEFORE makeClient: local validation must win over
  // AUTH_REQUIRED so `--page-size 0` exits 5 even with no credentials
  // configured (codex round-2), matching validatePaginationFlags ordering
  // in `test list` / `project list`.
  if (opts.pageSize !== undefined) {
    if (!Number.isFinite(opts.pageSize) || !Number.isInteger(opts.pageSize)) {
      throw localValidationError('page-size', 'must be an integer between 1 and 100');
    }
    if (opts.pageSize < 1 || opts.pageSize > 100) {
      throw localValidationError('page-size', 'must be between 1 and 100');
    }
  }

  const client = makeClient(opts, deps);
  const pageSize = opts.pageSize ?? 20;
  const sinceIso = opts.since !== undefined ? parseDuration(opts.since) : undefined;

  const resp = await client.listTestRuns(opts.testId, {
    cursor: opts.cursor,
    pageSize,
    source: opts.source,
    since: sinceIso,
  });

  if (opts.output === 'json') {
    out.print({ runs: resp.runs, nextCursor: resp.nextCursor }, data => JSON.stringify(data));
    return resp;
  }

  // Text mode rendering
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  // Empty / pre-cutover: print the backend meta.note instead of a blank table.
  // EXCEPTION: if nextCursor is non-null this page is empty only because the
  // backend filters AFTER limiting rows (limit-before-filter). Matching runs
  // may exist on later pages — surface the cursor instead of reporting
  // "no history".
  if (resp.runs.length === 0) {
    if (resp.nextCursor !== null) {
      // Filtered-empty page, but more pages exist: prompt user to paginate.
      const msg =
        `No matching runs on this page (filters skipped all entries), but more history exists.\n` +
        `Continue with: --cursor ${resp.nextCursor}`;
      out.print(msg, d => d as string);
      if (resp.meta.portalUrl) {
        stderr(`  Portal: ${resp.meta.portalUrl}`);
      }
      return resp;
    }
    // Truly empty (nextCursor is null): pre-cutover or genuinely no history.
    const note =
      resp.meta.note ??
      'No CLI-tracked history for this test. History is recorded from 2026-05-14 onward.';
    out.print(note, d => d as string);
    if (resp.meta.portalUrl) {
      stderr(`  Portal: ${resp.meta.portalUrl}`);
    }
    return resp;
  }

  const lines: string[] = [];
  lines.push(renderRunHistoryTable(resp.runs));

  // Footer: pointer to per-run detail commands.
  lines.push('');
  lines.push('Per-run detail: testsprite test wait <run-id>');
  lines.push('Failure bundle: testsprite test artifact get <run-id>');

  // Pagination hint
  if (resp.nextCursor !== null) {
    lines.push('');
    lines.push(`Next page: --cursor ${resp.nextCursor}`);
  }

  out.print(lines.join('\n'), d => d as string);

  // Short-filtered-page hint: non-null nextCursor even though this page was
  // shorter than requested — "none in THIS window" does not mean end-of-history.
  if (resp.nextCursor !== null && resp.runs.length < pageSize) {
    stderr(
      `[hint] Fewer than ${pageSize} rows returned but more may exist — ` +
        `source filter skipped some entries. Pass --cursor ${resp.nextCursor} to continue.`,
    );
  }

  return resp;
}

const RUN_HISTORY_TABLE_COL_WIDTHS = {
  runId: 36,
  status: 10,
  source: 18,
  rerun: 6,
  when: 25,
};

/**
 * Max width of the `test steps` DESCRIPTION column in text mode. Long /
 * multi-line step descriptions are collapsed to one line and truncated to
 * this many chars (with an ellipsis) so a single blob can't blow the table
 * out (dogfood 2026-06-04). `--output json` carries the full text.
 */
const DESC_COL_MAX = 60;

/** Max chars to show in the TARGETURL sub-line (excess truncated with …). */
const HISTORY_TARGET_URL_MAX = 80;

/**
 * Render a compact table of `RunHistoryItem[]` rows, newest-first.
 *
 * Columns: RUN ID · STATUS · SOURCE · RERUN? · WHEN · DURATION
 * `RERUN?` is derived from `isRerun`.
 * `WHEN` is the `createdAt` ISO string.
 * `DURATION` is wall-clock `finishedAt − (startedAt ?? createdAt)`. The
 * `createdAt` fallback keeps the column populated for FE runs, which do
 * not record `startedAt` today (dogfood 2026-06-04).
 *
 * G1b: when `targetUrl` is present and `targetUrlSource` is not
 * `'unresolved'`, a sub-line `  targetUrl: <url>` is printed below each
 * run row (truncated to `HISTORY_TARGET_URL_MAX` chars). The table columns
 * are left intact to avoid width blow-out on terminals.
 */
function renderRunHistoryTable(runs: RunHistoryItem[]): string {
  const cols = RUN_HISTORY_TABLE_COL_WIDTHS;
  const header = [
    padEnd('RUN ID', cols.runId),
    padEnd('STATUS', cols.status),
    padEnd('SOURCE', cols.source),
    padEnd('RERUN?', cols.rerun),
    padEnd('WHEN', cols.when),
    'DURATION',
  ].join('  ');
  const sep = '-'.repeat(header.length);

  const rows = runs.flatMap(r => {
    // FE runs never populate `startedAt` today — the RUNNING heartbeat
    // that would set it doesn't fire on the legacy/sync execution path
    // (dogfood 2026-06-04), so without a fallback DURATION was always
    // "—" for every FE run. Fall back to `createdAt` so the column shows
    // wall-clock from trigger to finish; on sync dev the queue gap is
    // ~0, and `--output json` still exposes raw startedAt/finishedAt for
    // consumers that need to exclude queue time.
    const duration = formatDurationMs(r.startedAt ?? r.createdAt, r.finishedAt);
    const mainRow = [
      padEnd(r.runId, cols.runId),
      padEnd(r.status, cols.status),
      padEnd(r.source, cols.source),
      padEnd(r.isRerun ? 'yes' : 'no', cols.rerun),
      padEnd(r.createdAt, cols.when),
      duration,
    ].join('  ');

    // G1b: surface per-run targetUrl as an indented sub-line.
    // Render only when truthy (skip null, undefined, empty) and when the
    // source is not 'unresolved' (that would mean "backend couldn't resolve
    // a URL" — printing "—" is less informative than omitting the line).
    const lines: string[] = [mainRow];
    if (r.targetUrl && r.targetUrlSource !== 'unresolved') {
      const url =
        r.targetUrl.length > HISTORY_TARGET_URL_MAX
          ? `${r.targetUrl.slice(0, HISTORY_TARGET_URL_MAX - 1)}…`
          : r.targetUrl;
      lines.push(`  targetUrl: ${url}`);
    } else if (r.targetUrlSource === 'unresolved') {
      lines.push(`  targetUrl: —`);
    }

    return lines;
  });

  return [header, sep, ...rows].join('\n');
}

function padEnd(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function formatDurationMs(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt || !finishedAt) return '—';
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

interface FailureSummaryOptions extends CommonOptions {
  testId: string;
}

/**
 * `test failure summary <test-id>` — M2.1 piece 3.
 *
 * Sibling of `test failure get`. Returns one-screen failure triage
 * info (status, failureKind, root-cause hypothesis, suggested fix
 * target if the analysis pipeline produced one) without downloading
 * video, screenshots, or DOM snapshots. The command an agent should
 * reach for first when investigating a reported failure.
 *
 * 404 NOT_FOUND propagates as exit 4. The facade's `details.reason`
 * (`not_found` / `no_failing_run`) reaches the user via the
 * `nextAction` template.
 */
export async function runFailureSummary(
  opts: FailureSummaryOptions,
  deps: TestDeps = {},
): Promise<CliFailureSummary> {
  const out = makeOutput(opts.output, deps);
  const client = makeClient(opts, deps);

  const summary = await client.get<CliFailureSummary>(
    `/tests/${encodeURIComponent(opts.testId)}/failure/summary`,
  );
  out.print(summary, data => renderFailureSummaryText(data as CliFailureSummary));
  return summary;
}

interface FailureGetOptions extends CommonOptions {
  testId: string;
  /**
   * Directory to write the §7 disk layout into. When unset, the CLI
   * prints the wire envelope (`--output json`) or a human summary
   * (`--output text`) to stdout — useful for an agent piping straight
   * to a vision-aware LLM. When set, stdout is silent on success
   * (the on-disk artifact is the contract).
   */
  out?: string;
  /** §7.4 — keep only the failed step ± 1 in `steps[]` and `evidence[]`. */
  failedOnly: boolean;
}

export interface FailureGetResult {
  /** The wire envelope as returned by the facade. */
  context: CliFailureContext;
  /** Set when `--out` was used; otherwise undefined. */
  bundle?: WriteBundleResult;
}

/**
 * `test failure get` — the agent-facing entry point. Fetches the §6.7
 * `FailureContext` for `<test-id>` and either writes the §7 disk
 * layout (when `--out` is set) or prints the wire envelope to stdout
 * (default).
 *
 * Without `--out`:
 *   - `--output json` (the agent default) — full wire envelope on
 *     stdout. Presigned URLs left intact for the agent to fetch on
 *     its own.
 *   - `--output text` — human summary block (status, failureKind,
 *     failedStepIndex, hypothesis, fix target, evidence count).
 *
 * With `--out <dir>`:
 *   - Atomic write under `<dir>/.tmp/...` → `rename()`. `meta.json`
 *     renames last; its presence implies "bundle complete and
 *     self-consistent." On any failure, `<dir>/.partial` is written
 *     and the CLI exits non-zero with the underlying error code.
 *   - stdout prints one line per output mode after the bundle is
 *     written, matching the rest of M2's `--out` ergonomics.
 *
 * 404 NOT_FOUND propagates as exit 4. The facade's `details.reason`
 * (`not_found` / `no_failing_run` / `no_code`) reaches the user via
 * the `nextAction` template — the CLI doesn't re-derive its own
 * remediation text per §5.4.
 */
export async function runFailureGet(
  opts: FailureGetOptions,
  deps: TestDeps = {},
): Promise<FailureGetResult> {
  const out = makeOutput(opts.output, deps);
  const client = makeClient(opts, deps);

  // Resolve and validate --out BEFORE the network call so a missing /
  // empty path surfaces as VALIDATION_ERROR (exit 5) without spending
  // an API call. Mirrors `runArtifactGet`; `writeBundle` re-validates
  // internally as defense-in-depth.
  let resolvedDir: string | undefined;
  if (opts.out !== undefined) {
    resolvedDir = resolveBundleDir(opts.out);
    await assertOutDirParentExists(resolvedDir);
  }

  const context = await client.get<CliFailureContext>(
    `/tests/${encodeURIComponent(opts.testId)}/failure`,
  );

  // Run the §3 atomicity invariants on every path — even when --out is
  // absent. An agent piping the JSON envelope into a vision-LLM
  // consumer would otherwise be handed stitched data the contract
  // guarantees never reaches it. The bundle writer re-runs the check
  // internally; this call is the cheap upfront trap.
  assertContextIntegrity(context, 'local');

  if (resolvedDir !== undefined) {
    // Dry-run: do NOT call writeBundle (which would mkdir, fetch
    // presigned URLs, and write files). Print the would-be bundle layout
    // to stderr and emit the wire envelope to stdout so the agent sees
    // the shape it would parse from disk.
    if (opts.dryRun) {
      const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
      const fileNames = plannedBundleFiles(context, opts.failedOnly);
      stderr(
        `[dry-run] would write bundle to ${resolvedDir} (${fileNames.length} files; meta.json renames last)`,
      );
      for (const f of fileNames) stderr(`[dry-run]   ${f}`);
      if (opts.output === 'json') {
        out.print({ ok: true, dir: resolvedDir, dryRun: true, context });
      } else {
        // Use a dry-run-specific renderer: the real success renderer
        // says "Bundle written to ..." which would be a lie here. Stdout
        // is the success contract automation may parse, so it must not
        // imply the bundle was created.
        out.print(
          { dir: resolvedDir, files: fileNames.length, snapshotId: context.snapshotId },
          data =>
            renderBundleDryRunText(data as { dir: string; files: number; snapshotId: string }),
        );
      }
      return { context };
    }

    const bundle = await writeBundle(context, {
      dir: resolvedDir,
      failedOnly: opts.failedOnly,
      fetchImpl: deps.fetchImpl,
    });
    if (opts.output === 'json') {
      out.print({ ok: true, dir: bundle.dir, meta: bundle.meta, files: bundle.files });
    } else {
      out.print(
        { dir: bundle.dir, files: bundle.files.length, snapshotId: bundle.meta.snapshotId },
        data => renderBundleWrittenText(data as { dir: string; files: number; snapshotId: string }),
      );
    }
    return { context, bundle };
  }

  // --output json (no --out) — print the wire envelope verbatim. This
  // is the agent-piping path: the agent's vision-LLM consumer will
  // dereference presigned URLs itself.
  if (opts.output === 'json') {
    out.print(context);
  } else {
    out.print(context, data => renderFailureContextText(data as CliFailureContext));
  }
  return { context };
}

// ---------------------------------------------------------------------------
// M3.3 piece-3 — `test run` / `test wait` + create --run chain
// ---------------------------------------------------------------------------

/**
 * Default timeout in seconds for `--wait`. Range 1..3600.
 */
const DEFAULT_RUN_TIMEOUT_SECONDS = 600;
const MAX_RUN_TIMEOUT_SECONDS = 3600;

interface RunTestRunOptions extends CommonOptions {
  testId: string;
  targetUrl?: string;
  wait: boolean;
  timeoutSeconds: number;
  /**
   * B2(c): true when --timeout was not explicitly set by the user (the default
   * is in effect). Used to decide whether to emit the first-run hint.
   * Defaults to false (no hint) when not set; only the `test run` / `test
   * create --run` command wiring sets this to `cmdOpts.timeout === undefined`.
   */
  timeoutIsDefault?: boolean;
  idempotencyKey?: string;
  /**
   * Per codex round-1 P1: when chained from `test create --run`, the caller
   * passes the create response here so `runTestRun` can emit a single merged
   * envelope `{ ...createContext, run: <trigger|final> }` on stdout. Without
   * this, `test create --run --output json` produces two JSON objects back-to-
   * back and agents cannot `JSON.parse` the result.
   */
  createContext?: CliCreateTestResponse | CliCreateFromPlanResponse;
  /**
   * Optional type hint supplied by the caller when the type is already known
   * client-side (e.g. the `test create --run` chain knows `opts.type`).
   * Used to derive `isBackend` for the step-summary renderer BEFORE the
   * `beFallbackUsed` fallback fires, so fast backend runs that are terminal
   * on the first poll still render `steps: n/a (backend)` correctly.
   * Leave unset for `test run <id>` where the type is only discoverable via
   * the `resolveAlternate` probe (an extra round-trip we deliberately avoid).
   */
  type?: 'frontend' | 'backend';
}

interface RunTestWaitOptions extends CommonOptions {
  runId: string;
  timeoutSeconds: number;
}

// ---------------------------------------------------------------------------
// M3.4 piece-3 — `test rerun` options
// ---------------------------------------------------------------------------

interface RunTestRerunOptions extends CommonOptions {
  /** One or more testIds to rerun. Empty + all=false → validation error (exit 5). */
  testIds: string[];
  /** --all: resolve all tests in the project and batch-rerun them. */
  all: boolean;
  /** --project: used with --all to resolve the project's tests. */
  projectId?: string;
  /** --wait: block until terminal (or --timeout). */
  wait: boolean;
  /** Polling / overall deadline. Default 600, max 3600. */
  timeoutSeconds: number;
  /**
   * Auto-heal: defaults true for FE reruns (use --no-auto-heal to opt out).
   * Backend ignores the server-side tier gate for CLI callers — Free + paid
   * both get auto-heal; charged 0.2 credits per engage when Phase-2 runs.
   */
  autoHeal: boolean;
  /**
   * Whether the user explicitly requested a specific auto-heal state via a
   * flag (as opposed to the default-on value). Used to suppress the BE-test
   * "ignoring auto-heal" warning when the value was never explicitly set.
   *
   * With `--no-auto-heal` as the only flag (no `--auto-heal`), this is always
   * false — the default-on value is never an explicit user request, so the BE
   * warning is suppressed on every default-on rerun. Only future addition of
   * an explicit `--auto-heal` flag would set this to true.
   */
  autoHealExplicit: boolean;
  /** --skip-dependencies: BE only. Don't expand the producer/teardown closure. */
  skipDependencies: boolean;
  /** --max-concurrency: bounds the --wait poll fan-out (batch / BE closure). */
  maxConcurrency: number;
  /** --idempotency-key: caller-supplied; auto-minted UUID when absent. */
  idempotencyKey?: string;
  /**
   * --skip-terminal: with --all, exclude tests already in a terminal status
   * (passed|failed|blocked|cancelled) before dispatch so an interrupted sweep
   * doesn't re-replay finished tests.
   */
  skipTerminal?: boolean;
  /**
   * --status <list>: comma-separated list of public status values. With --all,
   * only tests whose status matches one of the listed values are dispatched.
   * Reuses the same validated set as `test list --status`.
   */
  statusFilter?: string;
  /**
   * --filter <substr>: with --all, only rerun tests whose name contains this
   * substring (case-insensitive). Applied after --skip-terminal and --status
   * filters. Client-side only.
   */
  nameFilter?: string;
}

/**
 * Map a terminal `RunResponse.status` to the CLI exit code.
 * `passed` → 0; everything else → 1.
 */
function exitCodeForRunStatus(status: string): number {
  return status === 'passed' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Backend-test wait fallback (dogfood L1888)
//
// Backend-test run-surface rows are written `queued` then orphaned server-side
// (`RunHistoryService.finalizeRun` is wired on FE terminal paths only), so a
// run-row poll always hits `--timeout` → exit 7 even when the BE test PASSES.
// The verdict DOES reach the test record, readable via `GET /tests/{id}/result`.
// These helpers let `test run --wait` / `test wait` fall back to that
// testId-scoped verdict for backend tests, so a passing BE test exits 0.
// Frontend tests are untouched (their run row finalizes normally).
// ---------------------------------------------------------------------------

/** Terminal subset of {@link CliPublicStatus} (mirrors TERMINAL_RUN_STATUSES). */
const TERMINAL_PUBLIC_STATUSES: ReadonlySet<CliPublicStatus> = new Set<CliPublicStatus>([
  'passed',
  'failed',
  'blocked',
  'cancelled',
]);

function isTerminalPublicStatus(status: CliPublicStatus): boolean {
  return TERMINAL_PUBLIC_STATUSES.has(status);
}

/** Minimal client surface the backend-test wait fallback needs. */
interface ResultReadClient {
  get<T>(path: string, options?: { signal?: AbortSignal }): Promise<T>;
}

/**
 * Overlay a terminal testId-scoped {@link CliLatestResult} onto the polled
 * (non-terminal) {@link RunResponse} so a backend test whose run-surface row
 * never finalizes still renders a complete, correctly-correlated run envelope.
 * The real correlation metadata (`runId`, `testId`, `projectId`, `userId`,
 * `source`, `createdAt`, `createdFrom`) is preserved from the polled run row;
 * only the verdict/result fields are taken from the test record (codex
 * round-2: don't fabricate blank correlation fields).
 */
function backendResultToRunResponse(result: CliLatestResult, run: RunResponse): RunResponse {
  // `result.summary` is now a semantic string, not a count object.
  // Reconstruct the synthetic 1-test stepSummary from the verdict (byte-identical
  // to the prior status-derived counts: passed→1/0, failed→0/1, else→0/0).
  const passedCount = result.status === 'passed' ? 1 : 0;
  const failedCount = result.status === 'failed' ? 1 : 0;
  const total = passedCount + failedCount;
  return {
    ...run,
    status: result.status as RunStatus,
    // Drop the polling hint — it's meaningless on a terminal response
    // (JSON.stringify omits undefined keys).
    retryAfterSeconds: undefined,
    startedAt: result.startedAt ?? run.startedAt,
    finishedAt: result.finishedAt ?? run.finishedAt,
    codeVersion: run.codeVersion || (result.codeVersion ?? ''),
    targetUrl: run.targetUrl || (result.targetUrl ?? ''),
    // createdFrom / projectId / userId / runId / testId / source / createdAt
    // inherited from the polled run row via the spread above.
    failedStepIndex: result.failedStepIndex,
    failureKind: result.failureKind,
    videoUrl: result.videoUrl,
    stepSummary: {
      total,
      completed: total,
      passedCount,
      failedCount,
    },
  };
}

/**
 * Decide whether a testId-scoped result belongs to THIS run (vs a stale
 * verdict from a prior run of the same test). Backend serializes runs per
 * testId, so the next terminal verdict after our trigger is ours — but a
 * just-finished prior run could still be showing. Gate:
 *   - result names our runId         → accept (strongest signal);
 *   - result names a different runId → reject (a different run);
 *   - result has no runId (legacy)   → accept iff finishedAt >= notBefore.
 */
export function backendResultIsForThisRun(
  result: CliLatestResult,
  runId: string,
  notBefore: string | undefined,
): boolean {
  if (!isTerminalPublicStatus(result.status)) return false;
  if (result.runIdIfAvailable) {
    return result.runIdIfAvailable === runId;
  }
  if (!result.finishedAt) return false;
  if (!notBefore) return true;
  const finished = Date.parse(result.finishedAt);
  const floor = Date.parse(notBefore);
  if (Number.isNaN(finished) || Number.isNaN(floor)) return true;
  return finished >= floor;
}

/**
 * Build a `resolveAlternate` callback for `pollRunUntilTerminal` that falls
 * back to the testId-scoped verdict for **backend** tests (dogfood L1888).
 *
 *  - The first non-terminal run tick does a one-time `GET /tests/{id}` to learn
 *    the test type (cached). Frontend tests → no-op forever, so the FE path is
 *    byte-identical to before.
 *  - For backend tests, each later non-terminal tick reads
 *    `GET /tests/{id}/result`; once that record is terminal AND belongs to this
 *    run, a synthesized terminal `RunResponse` resolves the wait (exit 0/1)
 *    instead of timing out (exit 7).
 *  - Every lookup is best-effort: any error → "keep polling the run row", so
 *    the fallback can never make either path worse than the prior timeout.
 */
function makeBackendWaitFallback(args: {
  client: ResultReadClient;
  resolveTestId: (run: RunResponse) => string;
  resolveNotBefore: (run: RunResponse) => string | undefined;
  onResolved?: (testId: string, status: CliPublicStatus) => void;
}): (run: RunResponse, elapsedMs: number, signal: AbortSignal) => Promise<RunResponse | null> {
  let detection: 'pending' | 'frontend' | 'backend' = 'pending';
  return async (
    run: RunResponse,
    _elapsedMs: number,
    signal: AbortSignal,
  ): Promise<RunResponse | null> => {
    const testId = args.resolveTestId(run);
    if (!testId) return null;
    if (detection === 'pending') {
      try {
        const test = await args.client.get<CliTest>(`/tests/${encodeURIComponent(testId)}`, {
          signal,
        });
        // Cache ONLY a successful read. A transient probe failure (5xx,
        // rate-limit, network blip) must NOT permanently mark a backend test
        // as frontend — that would silently re-break the timeout this fallback
        // exists to fix (codex round-1). Leave `detection` pending so the next
        // non-terminal tick retries; the FE path is unaffected because its run
        // row finalizes and `resolveAlternate` stops being called.
        detection = test.type === 'backend' ? 'backend' : 'frontend';
      } catch {
        return null; // transient — keep polling the run row, retry the probe next tick.
      }
    }
    if (detection !== 'backend') return null;
    let result: CliLatestResult;
    try {
      result = await args.client.get<CliLatestResult>(
        `/tests/${encodeURIComponent(testId)}/result`,
        { signal },
      );
    } catch {
      return null; // not-ready / transient — keep polling.
    }
    if (!backendResultIsForThisRun(result, run.runId, args.resolveNotBefore(run))) {
      return null;
    }
    args.onResolved?.(testId, result.status);
    // Overlay the verdict onto the polled run row (preserves real correlation
    // metadata; codex round-2).
    return backendResultToRunResponse(result, run);
  };
}

/**
 * Print the trigger/run response, merging the create context when the
 * caller is the `test create --run` chain. Per codex round-1 P1: chained
 * `--output json` must produce ONE parseable JSON object on stdout, not
 * two back-to-back envelopes. With `createContext` set, JSON mode emits
 * `{ ...createContext, run: <payload> }`; text mode prints the create
 * summary first, then the run.
 */
function printRunOrChain<T>(
  out: Output,
  payload: T,
  createContext: CliCreateTestResponse | CliCreateFromPlanResponse | undefined,
  textRenderer?: (data: unknown) => string,
): void {
  if (!createContext) {
    out.print(payload, textRenderer);
    return;
  }
  const merged = { ...createContext, run: payload };
  out.print(merged, () => {
    // Text mode of the chain: render the create envelope as a header,
    // a blank line, then the run envelope below. Stays readable for
    // operators while JSON mode owns the parseable contract.
    const createText = renderCreateText(createContext as CliCreateTestResponse);
    const runText = textRenderer ? textRenderer(payload) : JSON.stringify(payload, null, 2);
    return `${createText}\n\n${runText}`;
  });
}

/**
 * Enrich a terminal RunResponse with a client-synthesized Portal deep link.
 * Emitted only when the wire row carries both projectId and testId (the BE
 * testId-fallback path synthesizes rows with an empty projectId — those stay
 * unenriched) and the API endpoint maps to a known portal host
 * (`resolvePortalUrl` returns undefined otherwise).
 */
function withRunDashboardUrl(run: RunResponse, apiUrl: string): RunResponse {
  if (!run.projectId || !run.testId) return run;
  const dashboardUrl = resolvePortalUrl(apiUrl, run.projectId, run.testId);
  return dashboardUrl !== undefined ? { ...run, dashboardUrl } : run;
}

/**
 * Render a `RunResponse` to human-readable text. JSON mode callers get
 * the wire envelope via `out.print`.
 *
 * Pass `isBackend: true` to suppress the per-step breakdown (BE tests are
 * atomic — no per-step breakdown exists; showing `0/0 (passed=0, failed=0)`
 * reads like a no-op rather than a passing/failing atomic result).
 */
function renderRunResponseText(
  run: RunResponse,
  { isBackend = false }: { isBackend?: boolean } = {},
): string {
  // P2-9: omit null fields (codeVersion/targetUrl) to match renderResultText
  // convention — literal "null" in text output confuses human operators.
  const lines: string[] = [
    `runId       ${run.runId}`,
    `testId      ${run.testId}`,
    `status      ${run.status}`,
  ];
  if (run.codeVersion !== null) lines.push(`codeVersion ${run.codeVersion}`);
  if (run.targetUrl !== null) lines.push(`targetUrl   ${run.targetUrl}`);
  lines.push(`createdAt   ${run.createdAt}`);
  if (run.startedAt) lines.push(`startedAt   ${run.startedAt}`);
  if (run.finishedAt) lines.push(`finishedAt  ${run.finishedAt}`);
  if (run.failureKind) lines.push(`failureKind ${run.failureKind}`);
  // D5-UX: show the human error string when status is failed/blocked and
  // the backend provided it. Truncate long multi-line errors to the first
  // line (≤200 chars) so the text output stays readable. JSON mode is
  // unaffected — it ships the wire envelope verbatim via out.print.
  if (
    (run.status === 'failed' || run.status === 'blocked') &&
    run.error &&
    run.error.trim().length > 0
  ) {
    const firstLine = run.error.split('\n')[0] ?? run.error;
    const truncated = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
    lines.push(`error       ${truncated}`);
  }
  if (isBackend) {
    // BE tests are atomic — no per-step breakdown. Show n/a instead of
    // confusing "0/0 (passed=0, failed=0)" which reads like a broken no-op.
    lines.push(`steps       n/a (backend)`);
  } else if (run.stepSummary) {
    lines.push(
      `steps       ${run.stepSummary.completed}/${run.stepSummary.total} (passed=${run.stepSummary.passedCount}, failed=${run.stepSummary.failedCount})`,
    );
  }
  // Closing pointer: where to inspect this run in the Portal (video, steps,
  // screenshots). Present only when withRunDashboardUrl could resolve it.
  if (run.dashboardUrl) lines.push(`dashboard   ${run.dashboardUrl}`);
  return lines.join('\n');
}

/**
 * Render a `TriggerRunResponse` (no-wait path) to human-readable text.
 */
function renderTriggerRunText(r: TriggerRunResponse): string {
  // P2-9: omit null-valued fields to avoid printing literal "null".
  const lines: string[] = [
    `runId       ${r.runId}`,
    `status      ${r.status}`,
    `enqueuedAt  ${r.enqueuedAt}`,
  ];
  if (r.codeVersion !== null) lines.push(`codeVersion ${r.codeVersion}`);
  if (r.targetUrl !== null) lines.push(`targetUrl   ${r.targetUrl}`);
  return lines.join('\n');
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

/**
 * `test run <test-id>` — M3.3 piece-3.
 *
 * Triggers a run via `POST /api/cli/v1/tests/{testId}/runs`. With
 * `--wait`, polls until terminal status (via `pollRunUntilTerminal`).
 * Exit code is 0 on `passed`, 1 on `failed`/`blocked`/`cancelled`,
 * 7 on timeout.
 */
export async function runTestRun(
  opts: RunTestRunOptions,
  deps: TestDeps = {},
): Promise<TriggerRunResponse | RunResponse> {
  assertIdempotencyKey(opts.idempotencyKey);
  if (opts.targetUrl !== undefined) {
    assertNotLocal(opts.targetUrl);
  }

  if (opts.dryRun) {
    const client = makeClient(opts, deps);
    const out = makeOutput(opts.output, deps);
    const idempotencyKey = opts.idempotencyKey ?? `dry-run-${randomUUID()}`;
    // P3-14: use the dry-run sample (TriggerRunResponse shape) so `test run
    // --dry-run --output json` returns the same shape as a real trigger
    // response, matching `test rerun --dry-run` convention. Fall back to
    // the HTTP-descriptor envelope only when no sample is registered.
    const sampleBody = findSample('POST', `/api/cli/v1/tests/${opts.testId}/runs`)?.body();
    if (sampleBody !== undefined && !opts.wait) {
      // Standalone `test run --dry-run` prints just the sample; a chained
      // `test create --run --dry-run` routes through printRunOrChain so the
      // merged { ...create, run } envelope keeps the created-test fields for
      // JSON consumers (codex #128 P2-A). The --wait path falls through to the
      // descriptor envelope below so its `thenPoll` hint is preserved.
      printRunOrChain(out, sampleBody, opts.createContext, data =>
        renderTriggerRunText(data as TriggerRunResponse),
      );
      void client;
      return sampleBody as unknown as TriggerRunResponse;
    }
    const envelope = {
      method: 'POST',
      path: `/api/cli/v1/tests/${opts.testId}/runs`,
      body: { source: 'cli' as const, ...(opts.targetUrl ? { targetUrl: opts.targetUrl } : {}) },
      idempotencyKey,
      ...(opts.wait ? { thenPoll: `/api/cli/v1/runs/<run-id>?waitSeconds=25` } : {}),
    };
    printRunOrChain(out, envelope, opts.createContext);
    // Still exercise the client factory so dry-run surfaces credential errors.
    void client;
    return envelope as unknown as TriggerRunResponse;
  }

  const idempotencyKey = opts.idempotencyKey ?? `cli-run-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  // D4: under --wait, raise the per-request timeout to cover --timeout so a
  // slow trigger/long-poll under load isn't falsely cut at the 120s default.
  const client = makeClient({ ...opts, requestTimeoutMs: resolveWaitRequestTimeoutMs(opts) }, deps);
  const out = makeOutput(opts.output, deps);
  const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  let triggerResponse: TriggerRunResponse;
  let triggerRequestId: string | undefined;
  let resumedFromConflict = false;
  try {
    const result = await client.triggerRunWithMeta(
      opts.testId,
      { source: 'cli', ...(opts.targetUrl ? { targetUrl: opts.targetUrl } : {}) },
      { idempotencyKey },
    );
    triggerResponse = result.body;
    triggerRequestId = result.requestId;
  } catch (err) {
    // CONFLICT (409) can arise from two different causes:
    //   1. reason === 'run_in_flight'  — another run is currently executing for
    //      this test. Auto-resume polling is valid ONLY for this reason and ONLY
    //      when --wait is set. Any other reason (snapshot_in_flight, etc.) or
    //      IDEMPOTENCY_BODY_MISMATCH must propagate to exit 6 so callers can
    //      decide what to do.
    //   2. reason !== 'run_in_flight'  — snapshot mid-mutation or body-hash
    //      mismatch. Always propagate.
    if (opts.wait && err instanceof ApiError && err.code === 'CONFLICT') {
      const conflictReason = err.getDetail<string>(
        'reason',
        (v): v is string => typeof v === 'string' && v.length > 0,
      );
      const currentRunId = err.getDetail<string>(
        'currentRunId',
        (v): v is string => typeof v === 'string' && v.length > 0,
      );

      // Only the genuine "another run currently executing" race qualifies for
      // auto-resume. Other CONFLICT reasons (snapshot_in_flight, etc.) exit 6.
      if (conflictReason === 'run_in_flight' && currentRunId !== undefined) {
        const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

        // If the caller supplied --target-url, verify the in-flight run targets
        // the same URL. A mismatch means we would be reporting a different
        // environment's results as if our requested environment was tested.
        if (opts.targetUrl !== undefined) {
          const inFlightRun = await client.getRun(currentRunId);
          if (inFlightRun.targetUrl !== opts.targetUrl) {
            throw new ApiError({
              code: 'CONFLICT',
              message:
                `Conflict: another run for this test is in flight against a different ` +
                `target URL (${inFlightRun.targetUrl}). Your --target-url ${opts.targetUrl} ` +
                `cannot attach to that run. Wait for it to finish ` +
                `(\`testsprite test wait ${currentRunId}\`) or retry your trigger when ` +
                `the test is free.`,
              nextAction: `testsprite test wait ${currentRunId}`,
              requestId: err.requestId,
              details: {
                reason: 'run_in_flight',
                currentRunId,
                inFlightTargetUrl: inFlightRun.targetUrl,
                requestedTargetUrl: opts.targetUrl,
              },
            });
          }
          stderrFn(
            `[advisory] Run already in flight (runId: ${currentRunId}, ` +
              `target: ${inFlightRun.targetUrl}). ` +
              `Attaching to that run's --wait poll instead of creating a new one.`,
          );
          triggerResponse = {
            runId: currentRunId,
            status: 'queued',
            enqueuedAt: new Date().toISOString(),
            codeVersion: inFlightRun.codeVersion,
            targetUrl: inFlightRun.targetUrl,
          };
        } else {
          // D: No --target-url supplied — fetch the in-flight run so the
          // synthesised triggerResponse.targetUrl is the REAL environment being
          // tested, not an empty string that would propagate into the timeout
          // partial (Finding D). Fall back to null (not '') if the lookup fails.
          let inFlightTargetUrl: string | null = null;
          let inFlightCodeVersion = '';
          try {
            const inFlightRun = await client.getRun(currentRunId);
            inFlightTargetUrl = inFlightRun.targetUrl ?? null;
            inFlightCodeVersion = inFlightRun.codeVersion ?? '';
          } catch {
            // Best-effort — if the lookup fails, proceed with null targetUrl.
          }

          // Auto-resume but emit a stronger advisory so the caller is aware
          // they are attaching to the project default.
          stderrFn(
            `[advisory] Run already in flight (runId: ${currentRunId}` +
              (inFlightTargetUrl ? `, target: ${inFlightTargetUrl}` : '') +
              `). Auto-resuming wait on in-flight run. ` +
              `If you needed a specific target URL, cancel with Ctrl-C and ` +
              `re-trigger with --target-url.`,
          );
          triggerResponse = {
            runId: currentRunId,
            status: 'queued',
            enqueuedAt: new Date().toISOString(),
            codeVersion: inFlightCodeVersion,
            // Use the real targetUrl from the in-flight run (or null if unknown),
            // never '' — the timeout partial inherits this value.
            targetUrl: inFlightTargetUrl ?? '',
          };
        }
        resumedFromConflict = true;
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  if (!opts.wait) {
    printRunOrChain(out, triggerResponse, opts.createContext, data =>
      renderTriggerRunText(data as TriggerRunResponse),
    );
    if (triggerRequestId && (opts.output === 'json' || opts.verbose || opts.debug))
      stderrFn(`requestId: ${triggerRequestId}`);
    return triggerResponse;
  }

  // --wait path: poll until terminal.
  const startMs = Date.now();
  void resumedFromConflict; // used above; suppress unused-variable lint
  const ticker = createTicker(
    stderrFn,
    opts.output === 'json' ? false : undefined, // disable ticker when --output json
  );

  // B2(c): emit a one-time hint when the user did not explicitly set --timeout
  // (i.e. the default is in effect). First runs can take several minutes;
  // skipped when --output json (non-interactive consumers don't need the hint).
  if (opts.timeoutIsDefault === true && opts.output !== 'json') {
    stderrFn(
      `[hint] First runs can take several minutes; raise --timeout if this run is cut short.`,
    );
  }

  // Backend-test fallback (dogfood L1888): BE run rows never finalize, so
  // resolve the verdict from the testId record once it's terminal.
  let beFallbackUsed = false;
  const resolveAlternate = makeBackendWaitFallback({
    client,
    resolveTestId: () => opts.testId,
    resolveNotBefore: () => triggerResponse.enqueuedAt,
    onResolved: testId => {
      beFallbackUsed = true;
      stderrFn(
        `[advisory] Backend run-surface row is not finalized server-side (dogfood L1888); ` +
          `resolved the verdict from the test record (testId=${testId}). ` +
          `Read full detail with: testsprite test result ${testId}`,
      );
    },
  });

  let finalRun: RunResponse;
  try {
    finalRun = await pollRunUntilTerminal(client, triggerResponse.runId, {
      timeoutSeconds: opts.timeoutSeconds,
      sleep: deps.sleep,
      onTransition: opts.verbose ? (msg: string) => stderrFn(`[verbose] ${msg}`) : undefined,
      onTick: (run, elapsedMs) => {
        const elapsed = Math.round(elapsedMs / 1000);
        const s = run.stepSummary ?? { total: 0, completed: 0, passedCount: 0, failedCount: 0 };
        ticker.update(
          `Run ${run.runId} — ${run.status} (${s.completed}/${s.total} steps elapsed=${elapsed}s)`,
        );
      },
      resolveAlternate,
    });
  } catch (err) {
    if (err instanceof TimeoutError) {
      ticker.finalize(`Run ${triggerResponse.runId} — timed out after ${opts.timeoutSeconds}s`);
      throw ApiError.fromEnvelope({
        error: {
          code: 'UNSUPPORTED', // exit 7 per errors.md
          message: `Timed out after ${opts.timeoutSeconds}s waiting for run ${triggerResponse.runId}.`,
          nextAction: `Resume polling: testsprite test wait ${triggerResponse.runId}`,
          requestId: 'local',
          details: { runId: triggerResponse.runId, timeoutSeconds: opts.timeoutSeconds },
        },
      });
    }
    // C+D: RequestTimeoutError during polling — emit a partial object to stdout
    // routed through printRunOrChain so:
    //   TEXT mode: renders human-readable (not raw JSON)
    //   JSON mode: preserves the merged create-chain envelope
    //              { ...createContext, run: { runId, status, targetUrl } }
    // targetUrl is taken from triggerResponse, which is already bound to
    // the real in-flight URL (see Finding D fix in the 409 resume path).
    if (err instanceof RequestTimeoutError) {
      ticker.finalize(`Run ${triggerResponse.runId} — request timed out`);
      const partial = {
        runId: triggerResponse.runId,
        status: 'running' as const,
        enqueuedAt: triggerResponse.enqueuedAt,
        codeVersion: triggerResponse.codeVersion,
        targetUrl: triggerResponse.targetUrl || null,
      };
      printRunOrChain(out, partial, opts.createContext, data => {
        const p = data as typeof partial;
        const lines = [`runId       ${p.runId}`, `status      ${p.status} (request timed out)`];
        if (p.targetUrl) lines.push(`targetUrl   ${p.targetUrl}`);
        lines.push(`hint        Re-attach with: testsprite test wait ${p.runId}`);
        return lines.join('\n');
      });
      stderrFn(
        `Run ${triggerResponse.runId} is still in progress (request timed out). ` +
          `Re-attach with: testsprite test wait ${triggerResponse.runId}`,
      );
      throw err;
    }
    ticker.finalize();
    throw err;
  }

  const elapsed = Math.round((Date.now() - startMs) / 1000);
  const s = finalRun.stepSummary ?? { total: 0, completed: 0, passedCount: 0, failedCount: 0 };
  ticker.finalize(
    `Run ${finalRun.runId} — ${finalRun.status} (${s.completed}/${s.total} steps elapsed=${elapsed}s)`,
  );

  printRunOrChain(
    out,
    withRunDashboardUrl(finalRun, resolveApiUrl(opts, deps)),
    opts.createContext,
    data =>
      renderRunResponseText(data as RunResponse, {
        // BE detection: type hint (create-chain) OR beFallbackUsed (slow runs).
        // This ensures fast BE runs terminal on first poll still render n/a.
        isBackend: beFallbackUsed || opts.type === 'backend',
      }),
  );

  // Surface the trigger requestId under --verbose/--debug or JSON mode so
  // operators can trace the full lifecycle (gated since 2026-06-04 dogfood;
  // JSON mode always emits to stderr — it never pollutes stdout).
  if (triggerRequestId && (opts.output === 'json' || opts.verbose || opts.debug))
    stderrFn(`requestId: ${triggerRequestId}`);

  if (finalRun.status === 'failed' || finalRun.status === 'blocked') {
    // BE runs (resolved via the testId fallback) have no run-scoped artifact
    // bundle — their failure bundle is addressed by testId, not runId.
    stderrFn(
      beFallbackUsed
        ? `Run finished with status: ${finalRun.status}. Backend failure artifacts are addressed by testId — use 'testsprite test failure get ${finalRun.testId}' to download the bundle.`
        : `Run finished with status: ${finalRun.status}. Use 'testsprite test artifact get ${finalRun.runId}' to download the failure bundle.`,
    );
  }

  const exitCode = exitCodeForRunStatus(finalRun.status);
  if (exitCode !== 0) {
    // Throw a CLIError so index.ts exits with the right code without
    // printing an error envelope — the result was already printed above.
    throw new CLIError(`Run ${finalRun.runId} finished with status: ${finalRun.status}`, exitCode);
  }

  return finalRun;
}

/**
 * `test wait <run-id>` — M3.3 piece-3.
 *
 * Polls `GET /api/cli/v1/runs/{runId}` until terminal status. Exit
 * codes match the `--wait` behavior matrix in the spec.
 */
export async function runTestWait(
  opts: RunTestWaitOptions,
  deps: TestDeps = {},
): Promise<RunResponse> {
  if (opts.dryRun) {
    const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    emitDryRunBanner(stderrFn);
    const out = makeOutput(opts.output, deps);
    const envelope = {
      method: 'GET',
      path: `/api/cli/v1/runs/${opts.runId}?waitSeconds=25`,
      timeoutSeconds: opts.timeoutSeconds,
    };
    out.print(envelope);
    return envelope as unknown as RunResponse;
  }

  // D4: `test wait` is always a waiting command (it has no --wait flag — it IS
  // the wait), so force wait:true when deriving the per-request timeout. This
  // raises the window to cover --timeout so a long-poll under load isn't cut at
  // the 120s default.
  const client = makeClient(
    { ...opts, requestTimeoutMs: resolveWaitRequestTimeoutMs({ ...opts, wait: true }) },
    deps,
  );
  const out = makeOutput(opts.output, deps);
  const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  const startMs = Date.now();
  const ticker = createTicker(stderrFn, opts.output === 'json' ? false : undefined);

  // Backend-test fallback (dogfood L1888): the run row never finalizes, so
  // resolve the verdict from the testId record (discovered from the first
  // poll tick) once it's terminal for this run.
  let beFallbackUsed = false;
  const resolveAlternate = makeBackendWaitFallback({
    client,
    resolveTestId: run => run.testId,
    resolveNotBefore: run => run.createdAt,
    onResolved: testId => {
      beFallbackUsed = true;
      stderrFn(
        `[advisory] Backend run-surface row is not finalized server-side (dogfood L1888); ` +
          `resolved the verdict from the test record (testId=${testId}). ` +
          `Read full detail with: testsprite test result ${testId}`,
      );
    },
  });

  let finalRun: RunResponse;
  try {
    finalRun = await pollRunUntilTerminal(client, opts.runId, {
      timeoutSeconds: opts.timeoutSeconds,
      sleep: deps.sleep,
      onTransition: opts.verbose ? (msg: string) => stderrFn(`[verbose] ${msg}`) : undefined,
      onTick: (run, elapsedMs) => {
        const elapsed = Math.round(elapsedMs / 1000);
        const s = run.stepSummary ?? { total: 0, completed: 0, passedCount: 0, failedCount: 0 };
        ticker.update(
          `Run ${run.runId} — ${run.status} (${s.completed}/${s.total} steps elapsed=${elapsed}s)`,
        );
      },
      resolveAlternate,
    });
  } catch (err) {
    if (err instanceof TimeoutError) {
      ticker.finalize(`Run ${opts.runId} — timed out after ${opts.timeoutSeconds}s`);
      throw ApiError.fromEnvelope({
        error: {
          code: 'UNSUPPORTED', // exit 7 per errors.md
          message: `Timed out after ${opts.timeoutSeconds}s waiting for run ${opts.runId}.`,
          nextAction: `Resume polling: testsprite test wait ${opts.runId}`,
          requestId: 'local',
          details: { runId: opts.runId, timeoutSeconds: opts.timeoutSeconds },
        },
      });
    }
    // C: RequestTimeoutError during polling — emit a partial object to stdout
    // routed through the same render path as the success case (text mode renders
    // human-readable; JSON mode produces a parseable envelope — not raw JSON).
    if (err instanceof RequestTimeoutError) {
      ticker.finalize(`Run ${opts.runId} — request timed out`);
      const partial = { runId: opts.runId, status: 'running' as const };
      out.print(partial, data => {
        const p = data as typeof partial;
        return [
          `runId       ${p.runId}`,
          `status      ${p.status} (request timed out)`,
          `hint        Re-attach with: testsprite test wait ${p.runId}`,
        ].join('\n');
      });
      stderrFn(
        `Run ${opts.runId} is still in progress (request timed out). ` +
          `Re-attach with: testsprite test wait ${opts.runId}`,
      );
      throw err;
    }
    ticker.finalize();
    throw err;
  }

  const elapsed = Math.round((Date.now() - startMs) / 1000);
  const s = finalRun.stepSummary ?? { total: 0, completed: 0, passedCount: 0, failedCount: 0 };
  ticker.finalize(
    `Run ${finalRun.runId} — ${finalRun.status} (${s.completed}/${s.total} steps elapsed=${elapsed}s)`,
  );

  out.print(withRunDashboardUrl(finalRun, resolveApiUrl(opts, deps)), data =>
    renderRunResponseText(data as RunResponse, { isBackend: beFallbackUsed }),
  );

  if (finalRun.status === 'failed' || finalRun.status === 'blocked') {
    // BE runs (resolved via the testId fallback) have no run-scoped artifact
    // bundle — their failure bundle is addressed by testId, not runId.
    stderrFn(
      beFallbackUsed
        ? `Run finished with status: ${finalRun.status}. Backend failure artifacts are addressed by testId — use 'testsprite test failure get ${finalRun.testId}' to download the bundle.`
        : `Run finished with status: ${finalRun.status}. Use 'testsprite test artifact get ${finalRun.runId}' to download the failure bundle.`,
    );
  }

  const exitCode = exitCodeForRunStatus(finalRun.status);
  if (exitCode !== 0) {
    throw new CLIError(`Run ${finalRun.runId} finished with status: ${finalRun.status}`, exitCode);
  }

  return finalRun;
}

// ---------------------------------------------------------------------------
// M4 piece-2 — `test run --all --project <id>` (fresh wave-ordered batch run)
// ---------------------------------------------------------------------------

interface RunTestRunAllOptions extends CommonOptions {
  /** projectId to run all BE tests in. */
  projectId: string;
  /** --filter <substr>: only run tests whose name contains this substring (case-insensitive). */
  nameFilter?: string;
  /** --wait: block until terminal or --timeout. */
  wait: boolean;
  /** Polling / overall deadline in seconds. Default 600, max 3600. */
  timeoutSeconds: number;
  /** --max-concurrency: bounds the --wait poll fan-out. */
  maxConcurrency: number;
  /** Caller-supplied idempotency token; auto-minted if absent. */
  idempotencyKey?: string;
}

/**
 * CLI result shape for a single member of a fresh batch run poll.
 */
interface CliBatchRunFreshResult {
  testId: string;
  runId: string | undefined;
  status: string;
  error?: { code: string; message: string; exitCode: number };
  /** CLIENT-synthesized Portal deep link (projectId from opts, testId per item). */
  dashboardUrl?: string;
}

/**
 * `test run --all --project <id>` — M4 piece-2.
 *
 * Triggers a fresh wave-ordered batch run via `POST /tests/batch/run`.
 * FE tests in the project are skipped by the BE-only engine (advisory).
 * With `--wait`, polls each accepted runId.
 */
export async function runTestRunAll(
  opts: RunTestRunAllOptions,
  deps: TestDeps = {},
): Promise<BatchRunFreshResponse | undefined> {
  assertIdempotencyKey(opts.idempotencyKey);
  requireProjectId(opts.projectId);
  if (
    !Number.isInteger(opts.maxConcurrency) ||
    opts.maxConcurrency < 1 ||
    opts.maxConcurrency > MAX_BATCH_CONCURRENCY
  ) {
    throw localValidationError('max-concurrency', 'must be an integer between 1 and 100');
  }

  const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const out = makeOutput(opts.output, deps);

  // --- Dry-run path ---
  if (opts.dryRun) {
    // DEV-247: this path returns before makeClient() fires the banner, so emit it
    // here — otherwise the canned sample can be mistaken for a live response.
    emitDryRunBanner(stderrFn);
    const idempotencyKey = opts.idempotencyKey ?? `dry-run-${randomUUID()}`;
    const batchRunSample = findSample('POST', '/api/cli/v1/tests/batch/run')?.body();
    const envelope = {
      dryRun: true,
      method: 'POST',
      path: '/api/cli/v1/tests/batch/run',
      body: {
        projectId: opts.projectId,
        testIds: opts.nameFilter ? ['<filtered by --filter>'] : undefined,
        source: 'cli' as const,
      },
      idempotencyKey,
      ...(opts.wait ? { thenPoll: '/api/cli/v1/runs/<run-id>?waitSeconds=25' } : {}),
    };
    out.print(batchRunSample ?? envelope);
    return undefined;
  }

  // D4: under --wait, raise per-request timeout to cover --timeout.
  const client = makeClient({ ...opts, requestTimeoutMs: resolveWaitRequestTimeoutMs(opts) }, deps);

  // Portal deep links for batch output: every test in the batch belongs to
  // opts.projectId, so per-item dashboardUrl needs no extra wire data. The
  // project-level URL closes out text-mode output ("watch the wave here").
  // Both stay undefined for unknown API hosts (resolvePortalBase contract).
  const batchApiUrl = resolveApiUrl(opts, deps);
  const batchPortalBase = resolvePortalBase(batchApiUrl);
  const projectDashboardUrl =
    batchPortalBase === undefined
      ? undefined
      : `${batchPortalBase}/dashboard/tests/${encodeURIComponent(opts.projectId)}`;
  const withBatchDashboardUrl = <T extends { testId: string }>(item: T): T => {
    const dashboardUrl = resolvePortalUrl(batchApiUrl, opts.projectId, item.testId);
    return dashboardUrl !== undefined ? { ...item, dashboardUrl } : item;
  };

  const idempotencyKey = opts.idempotencyKey ?? `cli-batch-run-fresh-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    stderrFn(`idempotency-key: ${idempotencyKey}`);
  }

  // Resolve testIds: fetch all BE tests in the project, apply --filter.
  let testIds: string[] | undefined;
  if (opts.nameFilter !== undefined && opts.nameFilter !== '') {
    // We need to resolve the full test set to apply the name filter.
    const allPage = await paginate<CliTest>(
      async ({ pageSize, cursor }) =>
        client.get<Page<CliTest>>('/tests', {
          query: { projectId: opts.projectId, pageSize, cursor },
        }),
      {},
    );
    const needle = opts.nameFilter.toLowerCase();
    const filtered = allPage.items.filter(t => t.name.toLowerCase().includes(needle));
    const before = allPage.items.length;
    const skipped = before - filtered.length;
    if (skipped > 0) {
      stderrFn(
        `--filter: skipped ${skipped} test${skipped !== 1 ? 's' : ''} whose name does not contain "${opts.nameFilter}".`,
      );
    }
    testIds = filtered.map(t => t.id);
    if (testIds.length === 0) {
      stderrFn(
        `No tests found in project ${opts.projectId} matching --filter "${opts.nameFilter}" — nothing to run.`,
      );
      out.print({
        accepted: [],
        conflicts: [],
        deferred: [],
        skippedFrontend: [],
        skippedIntegration: [],
      } satisfies BatchRunFreshResponse);
      return undefined;
    }
    stderrFn(
      `Resolved ${testIds.length} test${testIds.length !== 1 ? 's' : ''} in project ${opts.projectId} for batch run.`,
    );
  }
  // When no --filter, omit testIds → server runs ALL BE tests in the project.

  const batchResp = await client.triggerBatchRunFresh(
    {
      projectId: opts.projectId,
      ...(testIds !== undefined ? { testIds } : {}),
      source: 'cli',
    },
    { idempotencyKey },
  );

  // Mutable: D3 deferred-retry loop may append to `accepted`, drain `deferred`,
  // and accumulate additional `conflicts` discovered during retries.
  let accepted = batchResp.accepted.slice();
  let deferred = batchResp.deferred.slice();
  let conflicts = batchResp.conflicts.slice();
  const { skippedFrontend, skippedIntegration } = batchResp;

  // Print advisory for skipped FE tests.
  if (skippedFrontend.length > 0) {
    stderrFn(
      `[advisory] ${skippedFrontend.length} frontend test${skippedFrontend.length !== 1 ? 's' : ''} skipped — the batch run endpoint uses the BE-only wave engine. ` +
        `Use 'testsprite test run <id>' individually for FE tests.`,
    );
  }
  if (skippedIntegration.length > 0) {
    stderrFn(
      `[advisory] ${skippedIntegration.length} assembled integration test${skippedIntegration.length !== 1 ? 's' : ''} skipped — not runnable via the CLI wave path. Run them from the portal.`,
    );
  }
  if (conflicts.length > 0) {
    stderrFn(
      `[advisory] ${conflicts.length} test${conflicts.length !== 1 ? 's' : ''} already in flight, skipped: ${conflicts.map(c => c.testId).join(' ')}`,
    );
  }
  if (deferred.length > 0) {
    stderrFn(`Rate-deferred testIds (retry later): ${deferred.map(d => d.testId).join(' ')}`);
  }

  stderrFn(
    `Dispatched ${accepted.length} test${accepted.length !== 1 ? 's' : ''}` +
      `${skippedFrontend.length > 0 ? ` (${skippedFrontend.length} FE skipped)` : ''}` +
      `${conflicts.length > 0 ? ` (${conflicts.length} in flight)` : ''}` +
      `${deferred.length > 0 ? ` (${deferred.length} rate-deferred)` : ''}.`,
  );

  if (!opts.wait) {
    const printResp: BatchRunFreshResponse = {
      accepted: accepted.map(withBatchDashboardUrl),
      conflicts,
      deferred,
      skippedFrontend,
      skippedIntegration,
    };
    out.print(printResp, data => {
      const r = data as BatchRunFreshResponse;
      const lines: string[] = [`accepted      ${r.accepted.length}`];
      if (r.conflicts.length > 0)
        lines.push(`conflicts     ${r.conflicts.length} (already in flight)`);
      if (r.deferred.length > 0)
        lines.push(`deferred      ${r.deferred.length} (rate-limited — retry)`);
      if (r.skippedFrontend.length > 0) {
        lines.push(`skippedFE     ${r.skippedFrontend.length} (use 'test run <id>' for FE tests)`);
      }
      if (r.skippedIntegration.length > 0) {
        lines.push(
          `skippedIntegr ${r.skippedIntegration.length} (run assembled integration tests via portal)`,
        );
      }
      for (const a of r.accepted) {
        lines.push(`  ${a.testId}  runId: ${a.runId}  enqueuedAt: ${a.enqueuedAt}`);
      }
      if (projectDashboardUrl !== undefined) {
        lines.push(`dashboard     ${projectDashboardUrl}`);
      }
      return lines.join('\n');
    });
    // Rate-deferred tests were NOT dispatched → signal incomplete (exit 7),
    // mirroring `test rerun --all`. The user retries with a fresh invocation.
    if (deferred.length > 0) {
      throw new CLIError(
        `Batch run incomplete: ${deferred.length} test${deferred.length !== 1 ? 's' : ''} rate-deferred (per-key run budget). Retry these individually after ~60s: ${deferred.map(d => d.testId).join(' ')}`,
        7,
      );
    }
    // Nothing queued and everything was an in-flight conflict → surface CONFLICT (exit 6).
    if (accepted.length === 0 && conflicts.length > 0) {
      throw ApiError.fromEnvelope({
        error: {
          code: 'CONFLICT',
          message: `Batch run: nothing was queued — ${conflicts.length} test${conflicts.length !== 1 ? 's' : ''} already in flight.`,
          nextAction: `Wait for the in-flight runs to complete, then retry, or use: testsprite test wait <run-id>`,
          requestId: 'local',
          details: { conflicts: conflicts.map(c => c.testId) },
        },
      });
    }
    // [P2] Return post-retry state so programmatic callers and the create-chain
    // JSON merge reflect what was actually dispatched, not the stale initial resp.
    return { ...batchResp, accepted, deferred, conflicts };
  }

  // D3: bounded deferred-retry loop (only under --wait).
  // Up to MAX_DEFERRED_RETRIES attempts to re-dispatch still-deferred tests.
  // Each attempt sleeps for Retry-After (if server provided it) or the default
  // 61s, clamped to the remaining --timeout budget. Newly-accepted runs are
  // merged into `accepted`; if still deferred after all attempts, fall through
  // to the existing exit-7 path.
  const sleepFn = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const batchDeadlineMs = Date.now() + opts.timeoutSeconds * 1000;

  for (let attempt = 1; attempt <= MAX_DEFERRED_RETRIES && deferred.length > 0; attempt++) {
    const remainingMs = batchDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      stderrFn(
        `[deferred-retry] timeout budget exhausted before attempt ${attempt}/${MAX_DEFERRED_RETRIES} — ${deferred.length} test${deferred.length !== 1 ? 's' : ''} still deferred.`,
      );
      break;
    }
    const sleepMs = Math.min(DEFERRED_RETRY_DEFAULT_SLEEP_MS, remainingMs);
    stderrFn(
      `[deferred-retry] attempt ${attempt}/${MAX_DEFERRED_RETRIES} — retrying ${deferred.length} deferred test${deferred.length !== 1 ? 's' : ''} in ${Math.round(sleepMs / 1000)}s`,
    );
    await sleepFn(sleepMs);

    const remainingAfterSleep = batchDeadlineMs - Date.now();
    if (remainingAfterSleep <= 0) {
      stderrFn(
        `[deferred-retry] timeout budget exhausted during sleep — ${deferred.length} test${deferred.length !== 1 ? 's' : ''} still deferred.`,
      );
      break;
    }

    const retryIds = deferred.map(d => d.testId);
    // [P2] Bound the derived key to ≤256 chars. Caller-supplied keys may be up
    // to 256 chars; appending `:deferred-retryN` (≤16 chars) could push past
    // the server's 256-char limit and cause every retry to be rejected. Truncate
    // the base key to leave room for the suffix before concatenating.
    const retrySuffix = `:deferred-retry${attempt}`;
    const retryBase =
      idempotencyKey.length + retrySuffix.length > 256
        ? idempotencyKey.slice(0, 256 - retrySuffix.length)
        : idempotencyKey;
    const retryKey = `${retryBase}${retrySuffix}`;
    let retryResp: BatchRunFreshResponse;
    try {
      retryResp = await client.triggerBatchRunFresh(
        {
          projectId: opts.projectId,
          testIds: retryIds,
          source: 'cli',
        },
        { idempotencyKey: retryKey },
      );
    } catch (err) {
      // If the retry itself errors, surface the error and stop retrying.
      stderrFn(
        `[deferred-retry] attempt ${attempt} failed with error: ${err instanceof Error ? err.message : String(err)}`,
      );
      break;
    }

    const newlyAccepted = retryResp.accepted;
    const newlyDeferred = retryResp.deferred;
    const newlyConflicted = retryResp.conflicts;

    if (newlyAccepted.length > 0) {
      stderrFn(
        `[deferred-retry] attempt ${attempt}: ${newlyAccepted.length} test${newlyAccepted.length !== 1 ? 's' : ''} now accepted.`,
      );
      accepted = accepted.concat(newlyAccepted);
    }
    if (newlyConflicted.length > 0) {
      // [P1] Merge retry-returned conflicts into the running conflicts collection
      // so the final summary, stderr output, and exit-code logic reflect them.
      // Without this merge, tests deferred-then-conflicted on retry are invisible
      // to the final accounting and can cause a false-zero conflicts count.
      stderrFn(
        `[deferred-retry] attempt ${attempt}: ${newlyConflicted.length} test${newlyConflicted.length !== 1 ? 's' : ''} in-flight (conflict).`,
      );
      conflicts = conflicts.concat(newlyConflicted);
    }
    deferred = newlyDeferred;
    if (deferred.length === 0) {
      stderrFn(`[deferred-retry] attempt ${attempt}: all previously-deferred tests accepted.`);
    }
  }

  // --wait: fan-out poll each accepted run by its runId. Every accepted entry
  // carries a real runId (the backend routes slot-claim failures to conflicts[]),
  // so there is no "draft, no runId" subset to silently skip — polling all of
  // them is the only way `--wait` can report a faithful (not false-green) verdict.
  const pollable = accepted;

  if (pollable.length === 0) {
    // Build final response with potentially-updated accepted/deferred from D3 retry loop.
    const finalResp: BatchRunFreshResponse = {
      accepted,
      conflicts,
      deferred,
      skippedFrontend,
      skippedIntegration,
    };
    out.print(finalResp);
    // Nothing to poll: surface deferred (rate-limit → exit 7) or all-conflict (exit 6),
    // mirroring the non-wait path so `--wait` never silently exits 0 on a no-op batch.
    if (deferred.length > 0) {
      throw new CLIError(
        `Batch run incomplete: ${deferred.length} test${deferred.length !== 1 ? 's' : ''} rate-deferred (per-key run budget) — retry these individually after ~60s: ${deferred.map(d => d.testId).join(' ')}`,
        7,
      );
    }
    if (conflicts.length > 0) {
      throw ApiError.fromEnvelope({
        error: {
          code: 'CONFLICT',
          message: `Batch run: nothing was queued — ${conflicts.length} test${conflicts.length !== 1 ? 's' : ''} already in flight.`,
          nextAction: `Wait for the in-flight runs to complete, then retry, or use: testsprite test wait <run-id>`,
          requestId: 'local',
          details: { conflicts: conflicts.map(c => c.testId) },
        },
      });
    }
    // [P2] Return post-retry state.
    return { ...batchResp, accepted, deferred, conflicts };
  }

  const ticker = createTicker(stderrFn, opts.output === 'json' ? false : undefined);
  const concurrencyLimit = opts.maxConcurrency;
  const freshRunResults: CliBatchRunFreshResult[] = [];

  // Single deadline shared across the whole fan-out (codex): each queued poll
  // gets the time REMAINING against this batch deadline, not a fresh full
  // `timeoutSeconds`. Without this, runs that wait behind `--max-concurrency`
  // could push total wall-clock to ~ceil(N/concurrency) × timeout instead of
  // the documented `--timeout` ceiling.
  // NOTE: batchDeadlineMs is set in the D3 deferred-retry loop above and reused here.

  async function pollFreshAccepted(entry: BatchRunFreshAccepted): Promise<CliBatchRunFreshResult> {
    const runId = entry.runId;
    const remainingMs = batchDeadlineMs - Date.now();
    if (remainingMs <= 0) {
      return {
        testId: entry.testId,
        runId,
        status: 'timeout',
        error: {
          code: 'UNSUPPORTED',
          message: `Timed out after ${opts.timeoutSeconds}s`,
          exitCode: 7,
        },
      };
    }
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    const resolveAlternate = makeBackendWaitFallback({
      client,
      resolveTestId: () => entry.testId,
      resolveNotBefore: () => entry.enqueuedAt,
      onResolved: () => undefined,
    });
    try {
      const finalRun = await pollRunUntilTerminal(client, runId, {
        timeoutSeconds: remainingSeconds,
        sleep: deps.sleep,
        onTransition: opts.verbose ? (msg: string) => stderrFn(`[verbose] ${msg}`) : undefined,
        onTick: (run, elapsedMs) => {
          const elapsed = Math.round(elapsedMs / 1000);
          const s = run.stepSummary ?? { total: 0, completed: 0, passedCount: 0, failedCount: 0 };
          ticker.update(
            `Run ${run.runId} (${entry.testId}) — ${run.status} (${s.completed}/${s.total} steps elapsed=${elapsed}s)`,
          );
        },
        resolveAlternate,
      });
      return { testId: entry.testId, runId, status: finalRun.status };
    } catch (err) {
      if (err instanceof TimeoutError) {
        return {
          testId: entry.testId,
          runId,
          status: 'timeout',
          error: {
            code: 'UNSUPPORTED',
            message: `Timed out after ${opts.timeoutSeconds}s`,
            exitCode: 7,
          },
        };
      }
      if (err instanceof ApiError) {
        // Preserve the real exit code + envelope (AUTH_INVALID=3, NOT_FOUND=4,
        // RATE_LIMITED=11, …) instead of flattening every member failure to 1
        // (codex) — an operator/agent needs the actionable code, not a generic 1.
        return {
          testId: entry.testId,
          runId,
          status: 'error',
          error: { code: err.code, message: err.message, exitCode: err.exitCode },
        };
      }
      throw err;
    }
  }

  // Bounded concurrency fan-out
  let pollIdx = 0;
  let inFlight = 0;

  await new Promise<void>((resolve, reject) => {
    function startNext(): void {
      while (inFlight < concurrencyLimit && pollIdx < pollable.length) {
        const entry = pollable[pollIdx++]!;
        inFlight++;
        pollFreshAccepted(entry)
          .then(result => {
            freshRunResults.push(result);
            inFlight--;
            startNext();
            if (inFlight === 0 && pollIdx >= pollable.length) resolve();
          })
          .catch(reject);
      }
    }
    startNext();
    if (pollable.length === 0) resolve();
  });

  ticker.finalize();

  const passed = freshRunResults.filter(r => r.status === 'passed').length;
  const failed = freshRunResults.filter(
    r => r.status !== 'passed' && r.status !== 'timeout',
  ).length;
  const timedOut = freshRunResults.filter(r => r.status === 'timeout').length;

  stderrFn(
    `Batch run complete: ${passed}/${pollable.length} passed, ${failed} failed/blocked, ${timedOut} timed out`,
  );
  if (projectDashboardUrl !== undefined) {
    stderrFn(`Dashboard: ${projectDashboardUrl}`);
  }

  const jsonPayload = {
    accepted: freshRunResults.map(withBatchDashboardUrl),
    conflicts,
    deferred,
    skippedFrontend,
    skippedIntegration,
    summary: {
      passed,
      failed,
      timedOut,
      deferred: deferred.length,
      conflicts: conflicts.length,
      total: pollable.length,
    },
  };
  out.print(jsonPayload);

  // Rate-deferred tests were never dispatched → the batch is incomplete (exit 7),
  // mirroring `test rerun --all`. Checked before the failed-run throw so the
  // operator learns to retry the deferred set.
  if (deferred.length > 0) {
    throw new CLIError(
      `Batch run incomplete: ${deferred.length} test${deferred.length !== 1 ? 's' : ''} rate-deferred (per-key run budget) — retry these individually after ~60s: ${deferred.map(d => d.testId).join(' ')}`,
      7,
    );
  }

  if (timedOut > 0) {
    const timedOutRunIds = freshRunResults
      .filter(r => r.status === 'timeout')
      .map(r => r.runId)
      .filter(Boolean) as string[];
    throw ApiError.fromEnvelope({
      error: {
        code: 'UNSUPPORTED',
        message: `${timedOut} run${timedOut !== 1 ? 's' : ''} timed out.`,
        nextAction: timedOutRunIds.map(rid => `Resume: testsprite test wait ${rid}`).join('\n'),
        requestId: 'local',
        details: { timedOutRunIds, timeoutSeconds: opts.timeoutSeconds },
      },
    });
  }

  if (failed > 0) {
    // An auth failure on any member is a batch-wide condition (the credential is
    // bad, not the test) — propagate exit 3 so the operator fixes auth rather
    // than chasing a "test failed" (exit 1). Other operational codes stay folded
    // into the generic batch-failure exit 1; their per-member envelope is in JSON.
    const authErr = freshRunResults.find(r => r.error?.exitCode === 3);
    if (authErr) {
      throw new CLIError(
        `${failed} run${failed !== 1 ? 's' : ''} failed — auth error (${authErr.error?.code}): ${authErr.error?.message}`,
        3,
      );
    }
    throw new CLIError(`${failed} run${failed !== 1 ? 's' : ''} failed.`, 1);
  }

  // [P2] Return object reconstructed from post-retry mutable state (accepted,
  // deferred, conflicts) so the caller always sees what was actually dispatched,
  // not the stale initial batchResp. accepted here still holds the original
  // BatchRunFreshAccepted entries (with runId + enqueuedAt); the freshRunResults
  // fan-out is for exit-code logic only and is not part of the returned type.
  return { ...batchResp, accepted, deferred, conflicts };
}

// ---------------------------------------------------------------------------
// M3.4 piece-3 — `test rerun` (single + batch)
// ---------------------------------------------------------------------------

/**
 * CLI result shape for a single rerun in a batch fan-out poll.
 * Mirrors `CliBatchRunResult` but keyed on the rerun's runId.
 */
interface CliRerunResult {
  testId: string;
  runId: string;
  /** Terminal status, or 'timeout' for per-run deadline exceeded. */
  status: string;
  /** Set when the test is a closure member (not the user's named test). */
  role?: string;
  /** Structured error for non-passing runs. */
  error?: {
    code: string;
    message: string;
    exitCode: number;
  };
}

/**
 * `test rerun` — M3.4 piece-3.
 *
 * FE: `POST /tests/{id}/runs/rerun` → verbatim replay (no credit). With
 * `--wait`, polls `GET /runs/{runId}` until terminal.
 *
 * BE: same route → closure + per-member runIds. With `--wait`, polls every
 * closure-member runId; exits on the named test's verdict; failed closure
 * members surface as warnings + `closureFailures[]` in JSON.
 *
 * Batch / `--all`: `POST /tests/batch/rerun` → per-test runIds. With
 * `--wait`, fan-out poll under `--max-concurrency`. `deferred[]` → exit 7.
 */
export async function runTestRerun(
  opts: RunTestRerunOptions,
  deps: TestDeps = {},
): Promise<RerunResponse | BatchRerunResponse | undefined> {
  assertIdempotencyKey(opts.idempotencyKey);
  const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const out = makeOutput(opts.output, deps);

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------
  if (opts.testIds.length === 0 && !opts.all) {
    throw localValidationError(
      'test-ids',
      'provide at least one <test-id>, or use --all to rerun all tests in the project',
    );
  }
  if (opts.all && !opts.projectId) {
    throw localValidationError(
      'project',
      '--all requires a project context — pass --project <id> or configure a default',
    );
  }
  // --filter is an --all-only narrowing filter (applied to the fetched project
  // test set). Without --all it would be SILENTLY ignored while explicit ids
  // still get reran — defeating the user's narrowing intent and burning
  // rerun/auto-heal credits (codex). Reject early. (Mirrors delete-batch's
  // --status guard.)
  if (opts.nameFilter !== undefined && opts.nameFilter !== '' && !opts.all) {
    throw localValidationError(
      'filter',
      '--filter only applies with --all (it narrows which project tests get reran). ' +
        'Remove --filter, or add --all --project <id>.',
    );
  }
  if (
    !Number.isInteger(opts.maxConcurrency) ||
    opts.maxConcurrency < 1 ||
    opts.maxConcurrency > MAX_BATCH_CONCURRENCY
  ) {
    throw localValidationError('max-concurrency', 'must be an integer between 1 and 100');
  }

  const isSingle = !opts.all && opts.testIds.length === 1;

  // -------------------------------------------------------------------------
  // Pre-flight: auto-heal + Free-tier hint (best-effort, non-blocking)
  // -------------------------------------------------------------------------
  let effectiveAutoHeal = opts.autoHeal;

  if (opts.dryRun) {
    const client = makeClient(opts, deps);
    const idempotencyKey = opts.idempotencyKey ?? `dry-run-${randomUUID()}`;
    if (isSingle) {
      const testId = opts.testIds[0]!;
      const envelope = {
        dryRun: true,
        method: 'POST',
        path: `/api/cli/v1/tests/${testId}/runs/rerun`,
        body: {
          source: 'cli' as const,
          autoHeal: effectiveAutoHeal,
          skipDependencies: opts.skipDependencies,
        },
        idempotencyKey,
        ...(opts.wait ? { thenPoll: `/api/cli/v1/runs/<run-id>?waitSeconds=25` } : {}),
      };
      out.print(findSample('POST', `/api/cli/v1/tests/${testId}/runs/rerun`)?.body() ?? envelope);
    } else {
      const testIds = opts.all ? ['<all tests in project>'] : opts.testIds;
      const envelope = {
        dryRun: true,
        method: 'POST',
        path: `/api/cli/v1/tests/batch/rerun`,
        body: {
          source: 'cli' as const,
          testIds,
          autoHeal: effectiveAutoHeal,
          skipDependencies: opts.skipDependencies,
        },
        idempotencyKey,
        ...(opts.wait ? { thenPoll: `/api/cli/v1/runs/<run-id>?waitSeconds=25` } : {}),
      };
      out.print(findSample('POST', '/api/cli/v1/tests/batch/rerun')?.body() ?? envelope);
    }
    void client;
    return undefined;
  }

  // D4: under --wait, raise the per-request timeout to cover --timeout so a
  // slow rerun trigger / long-poll under load isn't cut at the 120s default.
  const client = makeClient({ ...opts, requestTimeoutMs: resolveWaitRequestTimeoutMs(opts) }, deps);
  const idempotencyKey = opts.idempotencyKey ?? `cli-rerun-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    stderrFn(`idempotency-key: ${idempotencyKey}`);
  }

  // -------------------------------------------------------------------------
  // Single rerun path
  // -------------------------------------------------------------------------
  if (isSingle) {
    const testId = opts.testIds[0]!;

    // Pre-flight: check if BE test with auto-heal (best-effort).
    // Only emit the "ignoring auto-heal" advisory when the user EXPLICITLY
    // requested auto-heal via a flag (autoHealExplicit=true). With the current
    // default-on design (`--no-auto-heal` is the only flag), autoHealExplicit
    // is always false — there is no `--auto-heal` flag to set. Suppressing the
    // warning on default-on prevents every BE rerun from printing noisy advice
    // about a feature the user never asked for. A future explicit `--auto-heal`
    // flag would set autoHealExplicit=true and restore the warning.
    if (opts.autoHeal) {
      try {
        const test = await client.get<CliTest>(`/tests/${encodeURIComponent(testId)}`);
        if (test.type === 'backend') {
          if (opts.autoHealExplicit) {
            stderrFn(
              `[advisory] auto-heal applies to frontend tests only; ignoring for backend test ${testId}`,
            );
          }
          effectiveAutoHeal = false;
        }
      } catch {
        // Best-effort: don't fail on a lookup error; server will gate anyway.
      }
    }

    let rerunResp: RerunResponse;
    try {
      rerunResp = await client.triggerRerun(
        testId,
        {
          source: 'cli',
          ...(effectiveAutoHeal ? { autoHeal: true } : {}),
          ...(opts.skipDependencies ? { skipDependencies: true } : {}),
        },
        { idempotencyKey },
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        const currentRunId = err.getDetail<string>(
          'currentRunId',
          (v): v is string => typeof v === 'string' && v.length > 0,
        );
        throw ApiError.fromEnvelope({
          error: {
            code: 'CONFLICT',
            message: `Test ${testId} already has a run in flight. Wait for it to finish before rerunning.`,
            nextAction: currentRunId
              ? `testsprite test wait ${currentRunId}`
              : `testsprite test result ${testId}`,
            requestId: err.requestId ?? 'local',
            details: { testId, currentRunId },
          },
        });
      }
      if (err instanceof ApiError && err.code === 'NOT_FOUND') {
        // D2 (dogfood): a rerun replays a SAVED run/script. A test that has
        // never completed a clean run (or an unknown/cross-tenant id) has
        // nothing to replay → NOT_FOUND. Point the user at a fresh run, which
        // requires no prior result. (Without this hint the bare exit-4 gives no
        // clue that `test run` is the fallback.)
        throw ApiError.fromEnvelope({
          error: {
            code: 'NOT_FOUND',
            message: `Test ${testId} has no replayable run to rerun (unknown/cross-tenant id, or it has never completed a clean run).`,
            nextAction: `For a first run (no prior result to replay), trigger a fresh run: testsprite test run ${testId}`,
            requestId: err.requestId ?? 'local',
            details: { testId, reason: 'no_replayable_run' },
          },
        });
      }
      throw err;
    }

    // Print auto-heal advisory.
    // CLI path: auto-heal is default-on for FE reruns (--no-auto-heal to opt
    // out). Free and paid CLI callers both get auto-heal; backend no longer
    // tier-gates for source='cli'. Cost: 0.2 credits per engage (charged only
    // when Phase-2 heal actually runs; verbatim replay passes are free).
    //
    // Defensive branch: if the server still echoes autoHeal:false after we sent
    // autoHeal:true, the server did not apply it (unexpected; may happen on
    // very old portal backends or if the CLI's claim was rejected for another
    // reason). We keep this branch but reword it — do NOT claim "requires Pro
    // plan" since the CLI path has no paid gate.
    //
    // Use effectiveAutoHeal (not opts.autoHeal) so BE reruns — where
    // effectiveAutoHeal was set to false earlier — do NOT trigger the
    // "not applied" advisory on every run (opts.autoHeal is still the
    // default-on `true`, so opts.autoHeal && !rerunResp.autoHeal would
    // fire spuriously for every BE rerun).
    if (effectiveAutoHeal && !rerunResp.autoHeal) {
      // Env-correct billing link (dev/prod portals differ); route-only when
      // the API host is unknown.
      const advisoryPortalBase = resolvePortalBase(resolveApiUrl(opts, deps));
      stderrFn(
        `[advisory] auto-heal was not applied by the server (verbatim replay).` +
          ` If this was unexpected, check your balance at ${
            advisoryPortalBase !== undefined
              ? `${advisoryPortalBase}/dashboard/settings/billing`
              : 'the portal Billing page (/dashboard/settings/billing)'
          }.`,
      );
    } else if (rerunResp.autoHeal) {
      stderrFn(
        `[advisory] auto-heal on (FE rerun default). If a step has drifted, healing runs and costs 0.2 credit. Disable with --no-auto-heal.`,
      );
    }

    const isBERerun = !!rerunResp.closure;

    if (isBERerun && rerunResp.closure) {
      const totalCount = rerunResp.closure.members.length;
      // G1d: split producers and teardowns into separate parts so the
      // summary accurately labels each role. Example outputs:
      //   "Reran 5 tests: 1 selected + 2 producer(s) + 2 teardown(s)"
      //   "Reran 3 tests: 1 selected + 2 producer(s)"
      //   "Reran 2 tests: 1 selected + 1 teardown(s)"
      //   "Reran 1 test: 1 selected"
      const parts: string[] = ['1 selected'];
      const nProducers = rerunResp.closure.addedProducers.length;
      const nTeardowns = rerunResp.closure.addedTeardowns.length;
      if (nProducers > 0) parts.push(`${nProducers} producer${nProducers !== 1 ? 's' : ''}`);
      if (nTeardowns > 0) parts.push(`${nTeardowns} teardown${nTeardowns !== 1 ? 's' : ''}`);
      stderrFn(`Reran ${totalCount} test${totalCount !== 1 ? 's' : ''}: ${parts.join(' + ')}`);
      // B4 (dogfood): backend reruns do not set `createdFrom`, so run-history
      // can't distinguish a rerun from a fresh run for BE tests. Tell the user
      // up front so they don't trust `test result --history` to flag reruns.
      stderrFn(
        `[advisory] backend rerun history does not distinguish reruns — ` +
          `'test result --history' shows isRerun:false / createdFrom:null for backend rows by design. ` +
          `Rerun-ness lives in the audit trail only (command=test.rerun).`,
      );
    }

    if (!opts.wait) {
      out.print(rerunResp, data => {
        const r = data as RerunResponse;
        const lines = [
          `runId       ${r.runId}`,
          `status      ${r.status}`,
          `enqueuedAt  ${r.enqueuedAt}`,
          `codeVersion ${r.codeVersion}`,
          `autoHeal    ${r.autoHeal}`,
        ];
        if (r.closure) {
          lines.push(
            `closure     ${r.closure.members.length} members (${r.closure.addedProducers.length} producers added)`,
          );
        }
        return lines.join('\n');
      });
      return rerunResp;
    }

    // --wait path for single rerun
    const ticker = createTicker(stderrFn, opts.output === 'json' ? false : undefined);

    if (isBERerun && rerunResp.closure && rerunResp.closure.members.length > 1) {
      // BE rerun: poll every closure-member runId, exit on named test's verdict.
      const namedRunId = rerunResp.runId;
      const closureMembers = rerunResp.closure.members;
      const closureFailures: Array<{ testId: string; runId: string; status: string }> = [];

      const pollMember = async (member: RerunClosureMember): Promise<RunResponse | null> => {
        const resolveAlternate = makeBackendWaitFallback({
          client,
          resolveTestId: () => member.testId,
          resolveNotBefore: run => run.createdAt,
          onResolved: () => undefined,
        });
        try {
          return await pollRunUntilTerminal(client, member.runId, {
            timeoutSeconds: opts.timeoutSeconds,
            sleep: deps.sleep,
            onTransition: opts.verbose ? (msg: string) => stderrFn(`[verbose] ${msg}`) : undefined,
            onTick: (run, elapsedMs) => {
              const elapsed = Math.round(elapsedMs / 1000);
              const s = run.stepSummary ?? {
                total: 0,
                completed: 0,
                passedCount: 0,
                failedCount: 0,
              };
              ticker.update(
                `Run ${run.runId} [${member.role}] — ${run.status} (${s.completed}/${s.total} steps elapsed=${elapsed}s)`,
              );
            },
            resolveAlternate,
          });
        } catch (err) {
          if (err instanceof TimeoutError) {
            return null;
          }
          throw err;
        }
      };

      // Fan-out poll with concurrency limit
      const members = closureMembers;
      const memberResults = new Map<string, RunResponse | null>();
      const concurrencyLimit = opts.maxConcurrency;
      let inFlight = 0;
      let memberIdx = 0;

      try {
        await new Promise<void>((resolve, reject) => {
          function startNext(): void {
            while (inFlight < concurrencyLimit && memberIdx < members.length) {
              const member = members[memberIdx++]!;
              inFlight++;
              pollMember(member)
                .then(result => {
                  memberResults.set(member.runId, result);
                  if (member.runId !== namedRunId) {
                    if (result === null) {
                      // Timed-out closure member: treat as incomplete/failed so
                      // the exit-code path fires exit 7 rather than silently
                      // succeeding with an unobserved member.
                      closureFailures.push({
                        testId: member.testId,
                        runId: member.runId,
                        status: 'timeout',
                      });
                      stderrFn(
                        `⚠ closure member ${member.testId} (runId: ${member.runId}) timed out — rerun did not reach terminal within --timeout`,
                      );
                    } else if (result.status !== 'passed') {
                      closureFailures.push({
                        testId: member.testId,
                        runId: member.runId,
                        status: result.status,
                      });
                      stderrFn(
                        `⚠ closure member ${member.testId} (runId: ${member.runId}) finished with status: ${result.status}`,
                      );
                    }
                  }
                  inFlight--;
                  startNext();
                  if (inFlight === 0 && memberIdx >= members.length) resolve();
                })
                .catch(reject);
            }
          }
          startNext();
          if (members.length === 0) resolve();
        });
      } catch (fanOutErr) {
        // D4 (closure fan-out): a RequestTimeoutError from any member's poll
        // propagates through .catch(reject) and rejects the fan-out promise
        // before any stdout is written — leaving a redirected stdout empty.
        // Emit a partial object for every dispatched run so the caller always
        // has something parseable on stdout, then re-throw (exit 7).
        if (fanOutErr instanceof RequestTimeoutError) {
          ticker.finalize(`Closure fan-out — request timed out`);
          const dispatchedRunIds = closureMembers.map(m => ({
            runId: m.runId,
            testId: m.testId,
            role: m.role,
            status: 'running' as const,
          }));
          out.print({ runId: namedRunId, status: 'running', closure: dispatchedRunIds }, () =>
            dispatchedRunIds
              .map(m => `${m.role.padEnd(9)} ${m.testId} (runId: ${m.runId}) — running`)
              .join('\n'),
          );
          const reattachHints = closureMembers
            .map(m => `testsprite test wait ${m.runId}`)
            .join('\n');
          stderrFn(
            `Closure members are still in progress (request timed out). Re-attach with:\n${reattachHints}`,
          );
          throw fanOutErr;
        }
        throw fanOutErr;
      }

      ticker.finalize();

      // Find named test's result
      const namedMember = closureMembers.find(m => m.runId === namedRunId);
      const namedResult = namedMember ? memberResults.get(namedRunId) : null;

      const jsonPayload: Record<string, unknown> = {
        runId: namedRunId,
        testId,
        autoHeal: rerunResp.autoHeal,
        closure: rerunResp.closure,
        namedStatus: namedResult?.status ?? 'timeout',
        ...(closureFailures.length > 0 ? { closureFailures } : {}),
      };

      out.print(jsonPayload, () => {
        const lines = [
          `runId       ${namedRunId}`,
          `testId      ${testId}`,
          `status      ${namedResult?.status ?? 'timeout (exceeded --timeout)'}`,
          `autoHeal    ${rerunResp.autoHeal}`,
        ];
        if (closureFailures.length > 0) {
          lines.push(`⚠ closureFailures:`);
          for (const f of closureFailures) lines.push(`  ${f.testId} (${f.runId}): ${f.status}`);
        }
        return lines.join('\n');
      });

      if (!namedResult) {
        // timeout
        throw ApiError.fromEnvelope({
          error: {
            code: 'UNSUPPORTED',
            message: `Timed out after ${opts.timeoutSeconds}s waiting for rerun ${namedRunId}.`,
            nextAction: `Resume polling: testsprite test wait ${namedRunId}`,
            requestId: 'local',
            details: { runId: namedRunId, timeoutSeconds: opts.timeoutSeconds },
          },
        });
      }

      if (exitCodeForRunStatus(namedResult.status) !== 0) {
        stderrFn(
          `Run finished with status: ${namedResult.status}. Use 'testsprite test artifact get ${namedRunId}' to download the failure bundle.`,
        );
        throw new CLIError(`Run ${namedRunId} finished with status: ${namedResult.status}`, 1);
      }

      // Fix B: timed-out closure members (non-named) are recorded in
      // closureFailures with status 'timeout'. Even when the named run passes,
      // we must exit 7 so --wait does not silently succeed when the closure
      // as a whole was never observed to reach terminal.
      const timedOutMembers = closureFailures.filter(f => f.status === 'timeout');
      if (timedOutMembers.length > 0) {
        const resumeHints = timedOutMembers.map(f => `testsprite test wait ${f.runId}`).join('\n');
        throw ApiError.fromEnvelope({
          error: {
            code: 'UNSUPPORTED',
            message: `${timedOutMembers.length} closure member${timedOutMembers.length !== 1 ? 's' : ''} timed out before reaching terminal status.`,
            nextAction: resumeHints,
            requestId: 'local',
            details: {
              timedOutRunIds: timedOutMembers.map(f => f.runId),
              timeoutSeconds: opts.timeoutSeconds,
            },
          },
        });
      }

      return rerunResp;
    }

    // Single FE rerun (or BE without closure) — poll the single runId
    let beFallbackUsed = false;
    const resolveAlternate = makeBackendWaitFallback({
      client,
      resolveTestId: () => testId,
      resolveNotBefore: () => rerunResp.enqueuedAt,
      onResolved: tid => {
        beFallbackUsed = true;
        stderrFn(
          `[advisory] Backend run-surface row is not finalized server-side; ` +
            `resolved the verdict from the test record (testId=${tid}).`,
        );
      },
    });

    let finalRun: RunResponse;
    try {
      finalRun = await pollRunUntilTerminal(client, rerunResp.runId, {
        timeoutSeconds: opts.timeoutSeconds,
        sleep: deps.sleep,
        onTransition: opts.verbose ? (msg: string) => stderrFn(`[verbose] ${msg}`) : undefined,
        onTick: (run, elapsedMs) => {
          const elapsed = Math.round(elapsedMs / 1000);
          const s = run.stepSummary ?? { total: 0, completed: 0, passedCount: 0, failedCount: 0 };
          ticker.update(
            `Run ${run.runId} — ${run.status} (${s.completed}/${s.total} steps replay elapsed=${elapsed}s)`,
          );
        },
        resolveAlternate,
      });
    } catch (err) {
      if (err instanceof TimeoutError) {
        ticker.finalize(`Run ${rerunResp.runId} — timed out after ${opts.timeoutSeconds}s`);
        throw ApiError.fromEnvelope({
          error: {
            code: 'UNSUPPORTED',
            message: `Timed out after ${opts.timeoutSeconds}s waiting for rerun ${rerunResp.runId}.`,
            nextAction: `Resume polling: testsprite test wait ${rerunResp.runId}`,
            requestId: 'local',
            details: { runId: rerunResp.runId, timeoutSeconds: opts.timeoutSeconds },
          },
        });
      }
      // C: RequestTimeoutError during polling — emit partial through the same
      // render path (text mode: human-readable, JSON mode: parseable envelope).
      if (err instanceof RequestTimeoutError) {
        ticker.finalize(`Run ${rerunResp.runId} — request timed out`);
        const partial = { runId: rerunResp.runId, status: 'running' as const };
        out.print(partial, data => {
          const p = data as typeof partial;
          return [
            `runId       ${p.runId}`,
            `status      ${p.status} (request timed out)`,
            `hint        Re-attach with: testsprite test wait ${p.runId}`,
          ].join('\n');
        });
        stderrFn(
          `Run ${rerunResp.runId} is still in progress (request timed out). ` +
            `Re-attach with: testsprite test wait ${rerunResp.runId}`,
        );
        throw err;
      }
      ticker.finalize();
      throw err;
    }

    const elapsed = Math.round(Date.now() / 1000);
    void elapsed;
    const s = finalRun.stepSummary ?? { total: 0, completed: 0, passedCount: 0, failedCount: 0 };
    ticker.finalize(
      `Run ${finalRun.runId} — ${finalRun.status} (${s.completed}/${s.total} steps replay)`,
    );

    out.print(withRunDashboardUrl(finalRun, resolveApiUrl(opts, deps)), data =>
      renderRunResponseText(data as RunResponse, { isBackend: beFallbackUsed }),
    );

    if (finalRun.status === 'failed' || finalRun.status === 'blocked') {
      stderrFn(
        `Run finished with status: ${finalRun.status}. Use 'testsprite test artifact get ${finalRun.runId}' to download the failure bundle.`,
      );
    }

    const exitCode = exitCodeForRunStatus(finalRun.status);
    if (exitCode !== 0) {
      throw new CLIError(
        `Run ${finalRun.runId} finished with status: ${finalRun.status}`,
        exitCode,
      );
    }

    return rerunResp;
  }

  // -------------------------------------------------------------------------
  // Batch / --all rerun path
  // -------------------------------------------------------------------------
  let testIds = opts.testIds;

  if (opts.all) {
    // Validate --status filter before any network call.
    if (opts.statusFilter !== undefined) {
      validateStatusFilter(opts.statusFilter);
    }

    // Resolve all tests in the project — follow nextToken until exhausted so
    // projects with >1 service page (>25 tests) are fully covered.
    const allPage = await paginate<CliTest>(
      async ({ pageSize, cursor }) =>
        client.get<Page<CliTest>>('/tests', {
          query: { projectId: opts.projectId!, pageSize, cursor },
        }),
      {},
    );
    let allTests = allPage.items;

    // --skip-terminal: exclude tests already in a terminal status so an
    // interrupted sweep doesn't re-replay finished tests.
    if (opts.skipTerminal) {
      const before = allTests.length;
      allTests = allTests.filter(t => !TERMINAL_PUBLIC_STATUSES.has(t.status));
      const skipped = before - allTests.length;
      if (skipped > 0) {
        stderrFn(
          `--skip-terminal: skipped ${skipped} already-terminal test${skipped !== 1 ? 's' : ''} (passed|failed|blocked|cancelled).`,
        );
      }
    }

    // --status <list>: only dispatch tests whose status matches one of the
    // listed values. Tokens are already validated above.
    if (opts.statusFilter !== undefined && opts.statusFilter !== '') {
      const allowed = new Set(
        opts.statusFilter
          .split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0),
      );
      const before = allTests.length;
      allTests = allTests.filter(t => allowed.has(t.status));
      const skipped = before - allTests.length;
      if (skipped > 0) {
        stderrFn(
          `--status filter: skipped ${skipped} test${skipped !== 1 ? 's' : ''} not matching status=${opts.statusFilter}.`,
        );
      }
    }

    // --filter <substr>: only dispatch tests whose name contains the
    // substring (case-insensitive). Applied after --skip-terminal and --status.
    if (opts.nameFilter !== undefined && opts.nameFilter !== '') {
      const needle = opts.nameFilter.toLowerCase();
      const before = allTests.length;
      allTests = allTests.filter(t => t.name.toLowerCase().includes(needle));
      const skipped = before - allTests.length;
      if (skipped > 0) {
        stderrFn(
          `--filter: skipped ${skipped} test${skipped !== 1 ? 's' : ''} whose name does not contain "${opts.nameFilter}".`,
        );
      }
    }

    testIds = allTests.map(t => t.id);
    if (testIds.length === 0) {
      stderrFn(`No tests found in project ${opts.projectId} matching filters — nothing to rerun.`);
      out.print({ accepted: [], deferred: [], conflicts: [], closure: { byProject: [] } });
      return undefined;
    }
    stderrFn(
      `Resolved ${testIds.length} test${testIds.length !== 1 ? 's' : ''} in project ${opts.projectId} for batch rerun.`,
    );
  }

  // Fix D: chunk testIds to stay within the MAX_BATCH_RERUN_IDS (50) cap on
  // POST /tests/batch/rerun. When --all resolves >50 tests we issue one
  // request per chunk (distinct idempotency-key per chunk so retries are
  // safe) and aggregate accepted/deferred/conflicts/closure into a single
  // synthetic BatchRerunResponse that downstream --wait / exit-code logic
  // can treat as one result.
  const chunks: string[][] = [];
  for (let i = 0; i < testIds.length; i += MAX_BATCH_RERUN_IDS) {
    chunks.push(testIds.slice(i, i + MAX_BATCH_RERUN_IDS));
  }
  if (chunks.length === 0) chunks.push([]); // defensive: empty list handled above

  let chunkResponses: BatchRerunResponse[];
  try {
    // Dispatch chunks one at a time, NOT via Promise.all. BE producer/
    // teardown closure dedup happens per-request, server-side. Two chunks
    // that share a project's producer fired concurrently can each decide
    // independently "this producer hasn't been added yet" and both trigger
    // it, double-running the producer. Sequential dispatch closes that
    // race: by the time chunk N is sent, chunk N-1's trigger has already
    // landed server-side for it to dedup against.
    chunkResponses = [];
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx]!;
      const chunkKey = chunks.length === 1 ? idempotencyKey : `${idempotencyKey}:chunk${idx}`;
      const chunkResp = await client.triggerBatchRerun(
        {
          source: 'cli',
          testIds: chunk,
          ...(effectiveAutoHeal ? { autoHeal: true } : {}),
          ...(opts.skipDependencies ? { skipDependencies: true } : {}),
        },
        { idempotencyKey: chunkKey },
      );
      chunkResponses.push(chunkResp);
    }
  } catch (err) {
    // D2 (dogfood): the batch endpoint rejects the WHOLE request when any id is
    // unresolvable (unknown, cross-tenant, or never ran cleanly), so one bad id
    // aborts the batch with NOT_FOUND. Replace the bare exit-4 with an
    // actionable hint. (Server-side partial-accept of unknown ids — a
    // `notFound[]` in the batch response so good ids still run — is a tracked
    // backend follow-up.)
    if (err instanceof ApiError && err.code === 'NOT_FOUND') {
      throw ApiError.fromEnvelope({
        error: {
          code: 'NOT_FOUND',
          message: `Batch rerun aborted: one or more of the ${testIds.length} requested test${testIds.length !== 1 ? 's' : ''} has no replayable run (unknown/cross-tenant id, or never completed a clean run). The batch endpoint rejects the whole request when any id is unresolvable.`,
          nextAction: `Verify the test ids and drop any that have never run, or trigger fresh runs individually: testsprite test run <id>`,
          requestId: err.requestId ?? 'local',
          details: { reason: 'batch_contains_unreplayable', testIds },
        },
      });
    }
    throw err;
  }

  // Aggregate chunk responses into a single synthetic BatchRerunResponse.
  // `accepted` is deduped by testId (defense in depth: even with sequential
  // dispatch above, a shared producer/teardown should never be reported, or
  // polled under --wait, more than once) and `closure.byProject` entries
  // sharing a projectId are merged rather than left as separate per-chunk
  // entries.
  const { deduped: dedupedAccepted, droppedCount: duplicateAcceptedCount } =
    dedupeBatchRerunAccepted(chunkResponses.flatMap(r => r.accepted));
  if (duplicateAcceptedCount > 0) {
    stderrFn(
      `[warn] ${duplicateAcceptedCount} test${duplicateAcceptedCount !== 1 ? 's were' : ' was'} triggered more than once across chunked batch-rerun requests (shared BE producer/teardown); kept the first run, ignored the rest.`,
    );
  }
  const batchResp: BatchRerunResponse = {
    accepted: dedupedAccepted,
    deferred: chunkResponses.flatMap(r => r.deferred),
    conflicts: chunkResponses.flatMap(r => r.conflicts),
    closure: {
      byProject: mergeBatchRerunClosureByProject(chunkResponses.flatMap(r => r.closure.byProject)),
    },
    notFound: chunkResponses.flatMap(r => r.notFound ?? []),
  };

  // Print dispatch summary
  // Mutable: D3 deferred-retry loop may append to `accepted`/`conflicts` and
  // drain `deferred` under --wait.
  let accepted = batchResp.accepted.slice();
  let deferred = batchResp.deferred.slice();
  let conflicts = batchResp.conflicts.slice();
  // [P2] `notFound` is mutable: a deferred test may become un-replayable during
  // the retry window; the retry response's notFound[] is merged into this set so
  // the test is never reported as "resolved" when it actually vanished.
  let notFound = (batchResp.notFound ?? []).slice();
  const closureByProject = batchResp.closure.byProject;
  const addedProducersTotal = closureByProject.reduce((n, p) => n + p.addedProducers.length, 0);

  const summaryParts: string[] = [
    `Reran ${accepted.length} test${accepted.length !== 1 ? 's' : ''}`,
  ];
  if (addedProducersTotal > 0) {
    summaryParts[0] += ` (${addedProducersTotal} BE producer${addedProducersTotal !== 1 ? 's' : ''} auto-added)`;
  }
  if (conflicts.length > 0) {
    summaryParts.push(`${conflicts.length} already in flight, skipped`);
  }
  if (deferred.length > 0) {
    summaryParts.push(`${deferred.length} rate-deferred`);
  }
  if (notFound.length > 0) {
    summaryParts.push(`${notFound.length} not found, skipped`);
  }
  stderrFn(summaryParts.join('; '));

  // D2-CLI: warn about notFound ids so the operator knows which tests were
  // skipped while the remaining accepted ids were still dispatched. Mirror
  // the style of the deferred warning block above.
  if (notFound.length > 0) {
    stderrFn(
      `[warn] ${notFound.length} test id${notFound.length !== 1 ? 's' : ''} skipped (unknown/cross-tenant id, or test never completed a clean run):`,
    );
    for (const id of notFound) stderrFn(`  ${id}`);
    stderrFn(
      `  Skipped ids have no replayable run. Use 'testsprite test run <id>' for a first (fresh) run.`,
    );
  }

  if (deferred.length > 0) {
    stderrFn(`Rate-deferred testIds (retry later):`);
    for (const d of deferred) stderrFn(`  ${d.testId} (reason: ${d.reason})`);
    const deferredIds = deferred.map(d => d.testId).join(' ');
    stderrFn(`nextAction: testsprite test rerun ${deferredIds}`);
  }

  // D3: bounded deferred-retry loop for rerun --all (only under --wait).
  // Up to MAX_DEFERRED_RETRIES attempts to re-dispatch still-deferred tests.
  // Each attempt sleeps for Retry-After (if server provided it) or the default
  // 61s, clamped to the remaining --timeout budget. Newly-accepted runs are
  // merged into `accepted`; if still deferred after all attempts, fall through
  // to the existing exit-7 path.
  const sleepFn = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const batchDeadlineMs = Date.now() + opts.timeoutSeconds * 1000;

  if (opts.wait) {
    for (let attempt = 1; attempt <= MAX_DEFERRED_RETRIES && deferred.length > 0; attempt++) {
      const remainingMs = batchDeadlineMs - Date.now();
      if (remainingMs <= 0) {
        stderrFn(
          `[deferred-retry] timeout budget exhausted before attempt ${attempt}/${MAX_DEFERRED_RETRIES} — ${deferred.length} test${deferred.length !== 1 ? 's' : ''} still deferred.`,
        );
        break;
      }
      const sleepMs = Math.min(DEFERRED_RETRY_DEFAULT_SLEEP_MS, remainingMs);
      stderrFn(
        `[deferred-retry] attempt ${attempt}/${MAX_DEFERRED_RETRIES} — retrying ${deferred.length} deferred test${deferred.length !== 1 ? 's' : ''} in ${Math.round(sleepMs / 1000)}s`,
      );
      await sleepFn(sleepMs);

      const remainingAfterSleep = batchDeadlineMs - Date.now();
      if (remainingAfterSleep <= 0) {
        stderrFn(
          `[deferred-retry] timeout budget exhausted during sleep — ${deferred.length} test${deferred.length !== 1 ? 's' : ''} still deferred.`,
        );
        break;
      }

      // Chunk the retry ids to stay within MAX_BATCH_RERUN_IDS cap.
      const retryIds = deferred.map(d => d.testId);
      const retryChunks: string[][] = [];
      for (let i = 0; i < retryIds.length; i += MAX_BATCH_RERUN_IDS) {
        retryChunks.push(retryIds.slice(i, i + MAX_BATCH_RERUN_IDS));
      }

      let retryChunkResponses: BatchRerunResponse[];
      try {
        // Sequential, same reason as the initial dispatch above: concurrent
        // chunks racing on per-request server-side closure dedup can
        // double-trigger a shared BE producer/teardown.
        retryChunkResponses = [];
        for (let idx = 0; idx < retryChunks.length; idx++) {
          const chunk = retryChunks[idx]!;
          // [P2] Bound the derived key to ≤256 chars. Caller-supplied keys may
          // be up to 256 chars; appending the suffix could exceed the server
          // limit and cause every retry to be rejected. Truncate the base key
          // to leave room for the longest possible suffix before concatenating.
          const retrySuffix =
            retryChunks.length === 1
              ? `:deferred-retry${attempt}`
              : `:deferred-retry${attempt}:chunk${idx}`;
          const retryBase =
            idempotencyKey.length + retrySuffix.length > 256
              ? idempotencyKey.slice(0, 256 - retrySuffix.length)
              : idempotencyKey;
          const retryKey = `${retryBase}${retrySuffix}`;
          const retryChunkResp = await client.triggerBatchRerun(
            {
              source: 'cli',
              testIds: chunk,
              ...(effectiveAutoHeal ? { autoHeal: true } : {}),
              ...(opts.skipDependencies ? { skipDependencies: true } : {}),
            },
            { idempotencyKey: retryKey },
          );
          retryChunkResponses.push(retryChunkResp);
        }
      } catch (err) {
        stderrFn(
          `[deferred-retry] attempt ${attempt} failed with error: ${err instanceof Error ? err.message : String(err)}`,
        );
        break;
      }

      const { deduped: newlyAccepted, droppedCount: newlyDuplicateCount } =
        dedupeBatchRerunAccepted(retryChunkResponses.flatMap(r => r.accepted));
      const newlyDeferred = retryChunkResponses.flatMap(r => r.deferred);
      const newlyConflicted = retryChunkResponses.flatMap(r => r.conflicts);
      // [P2] Collect notFound[] from the retry response. A deferred test may be
      // un-replayable by the time we retry (e.g. the test was deleted). Merge
      // into the running notFound set and remove from deferred so it isn't
      // reported as "resolved" in the final output.
      const newlyNotFound = retryChunkResponses.flatMap(r => r.notFound ?? []);

      if (newlyDuplicateCount > 0) {
        stderrFn(
          `[warn] ${newlyDuplicateCount} test${newlyDuplicateCount !== 1 ? 's were' : ' was'} triggered more than once across deferred-retry chunked requests (shared BE producer/teardown); kept the first run, ignored the rest.`,
        );
      }
      if (newlyAccepted.length > 0) {
        stderrFn(
          `[deferred-retry] attempt ${attempt}: ${newlyAccepted.length} test${newlyAccepted.length !== 1 ? 's' : ''} now accepted.`,
        );
        accepted = dedupeBatchRerunAccepted(accepted.concat(newlyAccepted)).deduped;
      }
      if (newlyConflicted.length > 0) {
        // [P1] Merge retry-returned conflicts into the running conflicts collection
        // so the final summary, stderr output, and exit-code logic reflect them.
        stderrFn(
          `[deferred-retry] attempt ${attempt}: ${newlyConflicted.length} test${newlyConflicted.length !== 1 ? 's' : ''} in-flight (conflict).`,
        );
        conflicts = conflicts.concat(newlyConflicted);
      }
      if (newlyNotFound.length > 0) {
        // [P2] Merge retry-discovered notFound ids and warn so the operator knows
        // which tests vanished. Remove the now-un-replayable ids from `deferred`
        // (newlyDeferred is the authoritative post-retry deferred set — it won't
        // include these ids — but be explicit so the logic is clear).
        stderrFn(
          `[deferred-retry] attempt ${attempt}: ${newlyNotFound.length} test id${newlyNotFound.length !== 1 ? 's' : ''} not found on retry (deleted or never ran cleanly): ${newlyNotFound.join(' ')}`,
        );
        notFound = notFound.concat(newlyNotFound);
        // Warn via the standard notFound stderr block (mirrors the initial dispatch).
        for (const id of newlyNotFound) stderrFn(`  ${id}`);
        stderrFn(
          `  Skipped ids have no replayable run. Use 'testsprite test run <id>' for a first (fresh) run.`,
        );
      }
      deferred = newlyDeferred;
      if (deferred.length === 0) {
        stderrFn(`[deferred-retry] attempt ${attempt}: all previously-deferred tests accepted.`);
      }
    }
  }

  if (!opts.wait) {
    // [P2] Build output from post-retry mutable state so deferred/conflicts/notFound
    // reflect what the D3 loop discovered, not just the initial batchResp.
    out.print({ ...batchResp, accepted, deferred, conflicts, notFound });
    if (deferred.length > 0) {
      throw new CLIError(
        `Batch rerun incomplete: ${deferred.length} test${deferred.length !== 1 ? 's' : ''} were rate-deferred. Retry with: testsprite test rerun ${deferred.map(d => d.testId).join(' ')}`,
        7,
      );
    }
    // Fix C: all-conflict no-op (no --wait path)
    if (accepted.length === 0 && conflicts.length > 0) {
      // codex P2: don't claim "all in flight" when some ids were also notFound —
      // a mixed conflicts+notFound response with no accepted runs must report
      // both causes accurately and surface the notFound ids in details.
      throw ApiError.fromEnvelope({
        error: {
          code: 'CONFLICT',
          message: `Batch rerun: nothing was queued — ${conflicts.length} test${conflicts.length !== 1 ? 's' : ''} already in flight${notFound.length > 0 ? `, ${notFound.length} not found` : ''}.`,
          nextAction: `Wait for the in-flight runs to complete, then retry, or use: testsprite test wait <run-id>`,
          requestId: 'local',
          details: {
            conflicts: conflicts.map(c => ({ testId: c.testId, currentRunId: c.currentRunId })),
            ...(notFound.length > 0 ? { notFound } : {}),
          },
        },
      });
    }
    // [P2] Return post-retry state including merged notFound.
    return { ...batchResp, accepted, deferred, conflicts, notFound };
  }

  // --wait: fan-out poll each accepted run by its runId
  if (accepted.length === 0) {
    // [P2] Build output from post-retry mutable state including merged notFound.
    out.print({ ...batchResp, accepted, deferred, conflicts, notFound });
    if (deferred.length > 0) {
      throw new CLIError(
        `Batch rerun: no tests were accepted (${deferred.length} deferred). ` +
          `Retry with: testsprite test rerun ${deferred.map(d => d.testId).join(' ')}`,
        7,
      );
    }
    // Fix C: all-conflict no-op (--wait path)
    if (conflicts.length > 0) {
      // codex P2: mixed conflicts+notFound (no accepted runs) must not be
      // reported as "all in flight"; surface the notFound ids in details too.
      throw ApiError.fromEnvelope({
        error: {
          code: 'CONFLICT',
          message: `Batch rerun: nothing was queued — ${conflicts.length} test${conflicts.length !== 1 ? 's' : ''} already in flight${notFound.length > 0 ? `, ${notFound.length} not found` : ''}.`,
          nextAction: `Wait for the in-flight runs to complete, then retry, or use: testsprite test wait <run-id>`,
          requestId: 'local',
          details: {
            conflicts: conflicts.map(c => ({ testId: c.testId, currentRunId: c.currentRunId })),
            ...(notFound.length > 0 ? { notFound } : {}),
          },
        },
      });
    }
    // [P2] Return post-retry state including merged notFound.
    return { ...batchResp, accepted, deferred, conflicts, notFound };
  }

  const ticker = createTicker(stderrFn, opts.output === 'json' ? false : undefined);
  const concurrencyLimit = opts.maxConcurrency;
  const rerunResults: CliRerunResult[] = [];
  // sleepFn is declared above in the D3 deferred-retry section (shared by fan-out).

  async function pollAccepted(entry: BatchRerunAccepted): Promise<CliRerunResult> {
    const resolveAlternate = makeBackendWaitFallback({
      client,
      resolveTestId: () => entry.testId,
      resolveNotBefore: () => entry.enqueuedAt,
      onResolved: () => undefined,
    });
    try {
      // [P2] Use remaining time against the shared batch deadline rather than the
      // full opts.timeoutSeconds. Without this, a run that starts polling after
      // up to ~183s of retry sleeps still gets the full --timeout budget, so total
      // wall time can exceed the documented --timeout ceiling. Mirror the same
      // pattern used by pollFreshAccepted in runTestRunAll.
      const remainingSeconds = Math.max(1, Math.ceil((batchDeadlineMs - Date.now()) / 1000));
      const finalRun = await pollRunUntilTerminal(client, entry.runId, {
        timeoutSeconds: remainingSeconds,
        sleep: deps.sleep,
        onTransition: opts.verbose ? (msg: string) => stderrFn(`[verbose] ${msg}`) : undefined,
        onTick: (run, elapsedMs) => {
          const elapsed = Math.round(elapsedMs / 1000);
          const s = run.stepSummary ?? { total: 0, completed: 0, passedCount: 0, failedCount: 0 };
          ticker.update(
            `Run ${run.runId} (${entry.testId}) — ${run.status} (${s.completed}/${s.total} steps elapsed=${elapsed}s)`,
          );
        },
        resolveAlternate,
      });
      return { testId: entry.testId, runId: entry.runId, status: finalRun.status };
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
      if (err instanceof ApiError) {
        return {
          testId: entry.testId,
          runId: entry.runId,
          status: 'error',
          error: { code: err.code, message: err.message, exitCode: 1 },
        };
      }
      throw err;
    }
  }

  // Bounded concurrency fan-out
  let acceptedIdx = 0;
  let inFlight = 0;

  await new Promise<void>((resolve, reject) => {
    function startNext(): void {
      while (inFlight < concurrencyLimit && acceptedIdx < accepted.length) {
        const entry = accepted[acceptedIdx++]!;
        inFlight++;
        pollAccepted(entry)
          .then(result => {
            rerunResults.push(result);
            inFlight--;
            startNext();
            if (inFlight === 0 && acceptedIdx >= accepted.length) resolve();
          })
          .catch(reject);
      }
    }
    startNext();
    if (accepted.length === 0) resolve();
  });

  ticker.finalize();

  const passed = rerunResults.filter(r => r.status === 'passed').length;
  const failed = rerunResults.filter(r => r.status !== 'passed' && r.status !== 'timeout').length;
  const timedOut = rerunResults.filter(r => r.status === 'timeout').length;

  stderrFn(
    `Batch rerun complete: ${passed}/${accepted.length} passed, ${failed} failed/blocked, ${timedOut} timed out`,
  );

  const jsonPayload = {
    accepted: rerunResults,
    // [P2] Use post-retry mutable vars, not the stale initial batchResp fields.
    // batchResp.deferred/conflicts reflect only the INITIAL response; after D3
    // retries drain deferred and may accumulate conflicts, the mutable `deferred`
    // and `conflicts` vars are the authoritative post-retry state.
    deferred,
    conflicts,
    // D2-CLI (codex P2): the --wait path builds its own jsonPayload, so it must
    // carry `notFound` too — otherwise a partial batch with at least one
    // accepted run drops the skipped ids from JSON output and a consumer would
    // report the partial run as fully successful. Mirrors the non-wait
    // `out.print(batchResp)` path.
    notFound,
    closure: batchResp.closure,
    summary: {
      passed,
      failed,
      timedOut,
      // D3 (dogfood): surface deferred + conflicts + notFound in the summary so
      // a JSON consumer reading `summary` alone can't silently undercount —
      // `total` counts dispatched (accepted) runs only. requested = total +
      // deferred + conflicts + notFound.
      deferred: deferred.length,
      conflicts: conflicts.length,
      notFound: notFound.length,
      total: accepted.length,
    },
  };
  out.print(jsonPayload);

  // Determine exit code: timeout (deferred or any timeout) → 7; any fail → 1; all pass → 0
  if (deferred.length > 0 || timedOut > 0) {
    const stillRunning =
      timedOut > 0 ? rerunResults.filter(r => r.status === 'timeout').map(r => r.runId) : [];
    throw ApiError.fromEnvelope({
      error: {
        code: 'UNSUPPORTED',
        message: [
          deferred.length > 0 ? `${deferred.length} test(s) were rate-deferred.` : '',
          timedOut > 0 ? `${timedOut} run(s) timed out.` : '',
        ]
          .filter(Boolean)
          .join(' '),
        nextAction: [
          deferred.length > 0
            ? `testsprite test rerun ${deferred.map(d => d.testId).join(' ')}`
            : '',
          // `test wait` accepts exactly one run id — emit one command per
          // timed-out run so the hint is always valid.
          ...(timedOut > 0 ? stillRunning.map(rid => `Resume: testsprite test wait ${rid}`) : []),
        ]
          .filter(Boolean)
          .join('\n'),
        requestId: 'local',
        details: { deferredTestIds: deferred.map(d => d.testId), timedOutRunIds: stillRunning },
      },
    });
  }

  if (failed > 0) {
    throw new CLIError(`${failed} rerun${failed !== 1 ? 's' : ''} failed.`, 1);
  }

  // [P2] Return post-retry state including merged notFound so callers see the
  // final accounting (accepted = original BatchRerunAccepted[] dispatch list
  // as required by the BatchRerunResponse type; rerunResults is the polled
  // outcome printed to stdout and is not part of the returned shape).
  return { ...batchResp, accepted, deferred, conflicts, notFound };
}

// ---------------------------------------------------------------------------
// M3.3 piece-4 — `test artifact get <run-id>`
// ---------------------------------------------------------------------------

export interface ArtifactGetOptions extends CommonOptions {
  runId: string;
  /**
   * Directory to write the §7 disk layout into. When absent, defaults to
   * `./.testsprite/runs/<run-id>/` (computed at action time from `process.cwd()`).
   * The default is intentionally not stored here to ensure it is computed freshly
   * at action time; pass the resolved path when you want an explicit directory.
   */
  out?: string;
  /** §7.4 — keep only the failed step ± 1 in `steps[]` and `evidence[]`. */
  failedOnly: boolean;
}

export interface ArtifactGetResult {
  /** The wire envelope as returned by the facade. */
  context: CliFailureContext;
  /** Set when bundle was written to disk. */
  bundle?: WriteBundleResult;
}

/**
 * Validate that the parent directory of `resolvedDir` exists and is a
 * directory. Surfaces `VALIDATION_ERROR` (exit 5) — matches the convention
 * from `closeOutputFile` for single-file `--out` flags (P4 D4 convention).
 *
 * The bundle directory itself (`resolvedDir`) may or may not exist;
 * `writeBundle` creates it if absent.
 */
export async function assertOutDirParentExists(resolvedDir: string): Promise<void> {
  const parent = dirname(resolvedDir);
  let parentStat;
  try {
    parentStat = await stat(parent);
  } catch {
    throw localValidationError('out', `parent directory does not exist: ${parent}`);
  }
  if (!parentStat.isDirectory()) {
    throw localValidationError('out', `parent path is not a directory: ${parent}`);
  }
  // Also guard against --out pointing at an existing FILE (not a dir).
  let targetStat;
  try {
    targetStat = await stat(resolvedDir);
  } catch {
    // Does not exist yet — fine; writeBundle will create it.
    return;
  }
  if (!targetStat.isDirectory()) {
    throw localValidationError('out', `must point to a directory, not a file: ${resolvedDir}`);
  }
}

/**
 * `test artifact get <run-id>` — run-scoped failure-bundle download.
 *
 * Downloads `GET /api/cli/v1/runs/{runId}/failure` and either:
 *   - Writes the §7 disk layout under `<dir>` (default `./.testsprite/runs/<run-id>/`)
 *   - Or prints the wire envelope / human summary to stdout when `--out` is absent.
 *
 * Differences from M2 `test failure get`:
 *   - Addresses the bundle by `runId` (exact run) not `testId` (latest).
 *   - Enforces `meta.runId === <run-id>` as a cross-check against backend bugs.
 *   - Passes `{ requireRunId: true }` to `assertContextIntegrity`.
 */
export async function runArtifactGet(
  opts: ArtifactGetOptions,
  deps: TestDeps = {},
): Promise<ArtifactGetResult> {
  const out = makeOutput(opts.output, deps);
  const client = makeClient(opts, deps);
  const { runId } = opts;

  // Resolve output dir: explicit --out or the default .testsprite/runs/<runId>/
  const resolvedDir =
    opts.out !== undefined
      ? resolveBundleDir(opts.out)
      : join(process.cwd(), '.testsprite', 'runs', runId);

  // --dry-run: no network, no disk write.
  // The client (makeClient) is already wired with createDryRunFetch() when
  // dryRun: true, so a real call to client.get() would return the canned
  // sample. We replicate that here without touching credentials, the
  // network, or the filesystem.
  if (opts.dryRun) {
    const sample = findSample('GET', `/api/cli/v1/runs/${encodeURIComponent(runId)}/failure`);
    const cannedCtx = (sample?.body() ?? {}) as CliFailureContext;
    const cannedMeta = buildMeta(cannedCtx, new Date());

    if (opts.output === 'json') {
      // Emit the same schema shape as the real success path so automation
      // that learns the surface via dry-run sees the correct keys.
      out.print({
        out: resolvedDir,
        snapshotId: cannedMeta.snapshotId,
        meta: {
          runId: cannedCtx.result?.runIdIfAvailable ?? null,
          testId: cannedMeta.testId,
          projectId: cannedMeta.projectId,
          codeVersion: cannedMeta.codeVersion,
          targetUrl: cannedMeta.targetUrl,
          failedStepIndex: cannedMeta.failedStepIndex,
          failureKind: cannedMeta.failureKind,
          capturedAt: cannedMeta.capturedAt,
          fetchedAt: cannedMeta.fetchedAt,
        },
      });
    } else {
      out.print({ dir: resolvedDir, files: 0, snapshotId: cannedMeta.snapshotId, runId }, data =>
        renderArtifactGetDryRunText(
          data as { dir: string; files: number; snapshotId: string; runId: string },
        ),
      );
    }
    return { context: cannedCtx };
  }

  // Parent-dir validation for explicit --out only. The default path
  // (.testsprite/runs/<runId>/) is always under cwd — mkdir will create it.
  if (opts.out !== undefined) {
    await assertOutDirParentExists(resolvedDir);
  }

  // Fetch the run-scoped failure bundle.
  const { body: context, requestId: fetchRequestId } = await client.getWithMeta<CliFailureContext>(
    `/runs/${encodeURIComponent(runId)}/failure`,
  );

  // §3 atomicity invariants — run-scoped path requires runId to be present.
  assertContextIntegrity(context, 'local', { requireRunId: true });

  // Verify the backend returned the exact runId we asked for.
  // A mismatch is a backend bug; refuse rather than silently writing the wrong bundle.
  if (context.result.runIdIfAvailable !== runId) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Bundle integrity check failed.',
        nextAction:
          'The server returned a bundle for a different runId. ' +
          'Report the requestId to support@testsprite.com.',
        requestId: 'local',
        details: {
          field: 'meta.runId',
          reason: 'mismatch',
          expected: runId,
          received: context.result.runIdIfAvailable,
        },
      },
    });
  }

  // Write bundle to disk.
  const bundle = await writeBundle(context, {
    dir: resolvedDir,
    failedOnly: opts.failedOnly,
    fetchImpl: deps.fetchImpl,
  });

  if (opts.output === 'json') {
    out.print({
      out: bundle.dir,
      snapshotId: bundle.meta.snapshotId,
      requestId: fetchRequestId,
      meta: {
        runId: context.result.runIdIfAvailable,
        testId: bundle.meta.testId,
        projectId: bundle.meta.projectId,
        codeVersion: bundle.meta.codeVersion,
        targetUrl: bundle.meta.targetUrl,
        failedStepIndex: bundle.meta.failedStepIndex,
        failureKind: bundle.meta.failureKind,
        capturedAt: bundle.meta.capturedAt,
        fetchedAt: bundle.meta.fetchedAt,
      },
    });
  } else {
    out.print(
      { dir: bundle.dir, files: bundle.files.length, snapshotId: bundle.meta.snapshotId, runId },
      data =>
        renderArtifactGetWrittenText(
          data as { dir: string; files: number; snapshotId: string; runId: string },
        ),
    );
    if (opts.verbose || opts.debug) {
      const stderrWriter = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
      stderrWriter(`requestId: ${fetchRequestId}`);
    }
  }
  return { context, bundle };
}

function renderArtifactGetDryRunText(data: {
  dir: string;
  files: number;
  snapshotId: string;
  runId: string;
}): string {
  return [
    `[dry-run] no network call made`,
    `method:   GET`,
    `path:     /api/cli/v1/runs/${data.runId}/failure`,
    `writeTo:  ${data.dir}`,
    `snapshotId: ${data.snapshotId}`,
  ].join('\n');
}

function renderArtifactGetWrittenText(data: {
  dir: string;
  files: number;
  snapshotId: string;
  runId: string;
}): string {
  return [
    `Bundle written to ${data.dir}`,
    `runId:      ${data.runId}`,
    `snapshotId: ${data.snapshotId}`,
    `files:      ${data.files}`,
  ].join('\n');
}

export function createTestCommand(deps: TestDeps = {}): Command {
  const test = new Command('test').description('Inspect TestSprite tests');

  test
    .command('list')
    .description('List tests in a project')
    // Intentionally NOT `.requiredOption` — Commander's missing-required-option
    // path throws a plain Error and `index.ts` maps it to exit 1, which would
    // bypass the typed `VALIDATION_ERROR` (exit 5) envelope contract from
    // the CLI error spec §2 ("missing required field"). `requireProjectId`
    // below raises `ApiError(VALIDATION_ERROR)` so JSON consumers can read
    // `error.code` and the exit code matches the catalog.
    .option('--project <id>', 'project id (returned by `testsprite project list`)')
    .option('--type <type>', 'filter by test type (frontend|backend)')
    .option('--created-from <source>', 'filter by where the test was authored (portal|mcp|cli)')
    .option(
      '--status <list>',
      'filter by normalized status (comma-separated). One of: draft, ready, queued, running, passed, failed, blocked, cancelled, unknown — M2.1',
    )
    .option('--page-size <n>', 'service page-size hint (1-100, default 25)')
    .option('--starting-token <token>', 'opaque cursor from a previous list response')
    .option(
      '--cursor <token>',
      'alias for --starting-token; accepted for parity with `test result --history`',
    )
    .option('--max-items <n>', 'stop after this many items across auto-paged pages')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts: ListFlagOpts, command: Command) => {
      // Same parser strategy as `project list`: skip Commander's number
      // parser so a non-numeric --page-size surfaces as a typed
      // VALIDATION_ERROR (exit 5) rather than Commander's plain
      // exception (exit 1). Enum filters validate locally too.
      //
      // --cursor is an alias for --starting-token (vocabulary parity with
      // `test result --history`). --starting-token takes precedence if
      // both are supplied (prevents accidental override).
      await runList(
        {
          ...resolveCommonOptions(command),
          projectId: cmdOpts.project,
          type: parseEnumFlag(cmdOpts.type, 'type', TEST_TYPES),
          createdFrom: parseEnumFlag(cmdOpts.createdFrom, 'created-from', CREATED_FROMS),
          status: cmdOpts.status,
          pageSize: parseNumericFlag(cmdOpts.pageSize, 'page-size'),
          startingToken: cmdOpts.startingToken ?? cmdOpts.cursor,
          maxItems: parseNumericFlag(cmdOpts.maxItems, 'max-items'),
        },
        deps,
      );
    });

  test
    .command('get <test-id>')
    .description('Get a test by id')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (testId: string, _cmdOpts, command: Command) => {
      await runGet({ ...resolveCommonOptions(command), testId }, deps);
    });

  test
    .command('create')
    .description(
      'Create a test from saved code (--code-file) or an agent-supplied plan (--plan-from, FE-only, M3.2 piece-5)',
    )
    .option('--project <id>', 'project id (returned by `testsprite project list`)')
    .option('--type <type>', 'frontend|backend')
    .option('--name <name>', 'human-readable test name (becomes `title` in storage)')
    .option('--description <text>', 'optional human description (≤ 2000 chars)')
    .option('--priority <prio>', 'optional priority — one of: p0, p1, p2, p3')
    .option('--code-file <path>', 'file containing the test code (≤ 350 KB)')
    .option(
      '--plan-from <path>',
      'JSON file with the full FE test definition — projectId, type, name, planSteps[] all live in the file ' +
        '(≤ 256 KB; mutually exclusive with --code-file). In this mode --project/--type/--name/--description/--priority are ignored.',
    )
    .option(
      '--run',
      'after create, trigger the test. Combine with --wait to block until terminal.',
      false,
    )
    .option('--wait', 'with --run, poll until terminal status', false)
    .option('--timeout <s>', 'with --run --wait, max seconds to wait')
    .option('--target-url <url>', 'with --run, override the project default env URL')
    .option(
      '--idempotency-key <token>',
      'opaque idempotency token (1-256 ASCII chars). Defaults to a UUIDv4 minted per invocation; pin one yourself for safe retries.',
    )
    .option(
      '--produces <var>',
      'BE only: variable name this test captures (repeatable). Drives dependency-aware wave ordering on `test rerun` and `test run --all`.',
      (val: string, prev: string[]) => [...(prev ?? []), val],
      [] as string[],
    )
    .option(
      '--needs <var>',
      'BE only: variable name this test consumes (repeatable). Use to declare upstream producer dependencies.',
      (val: string, prev: string[]) => [...(prev ?? []), val],
      [] as string[],
    )
    .option(
      '--category <str>',
      "BE only: test category. Use 'teardown' or 'cleanup' to mark a final-wave cleanup test.",
    )
    .addHelpText(
      'after',
      '\nBE dependency authoring (M4):\n' +
        '  --produces/--needs drive wave ordering on `test rerun` + `test run --all`.\n' +
        '  --category teardown  marks a final-wave cleanup test.\n' +
        '  These flags are backend-only; supplying with --type frontend is an error (exit 5).',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts: CreateFlagOpts, command: Command) => {
      // --plan-from and --code-file are mutually exclusive. Dispatch
      // here so each `run*` function stays single-purpose. If neither
      // is set, the existing runCreate path enforces --code-file.
      if (cmdOpts.planFrom !== undefined && cmdOpts.codeFile !== undefined) {
        throw localValidationError(
          'plan-from',
          'is mutually exclusive with --code-file; pass one or the other',
        );
      }
      if (cmdOpts.planFrom !== undefined) {
        // BE dependency flags are backend-only (they drive the BE wave engine).
        // --plan-from creates FE plan-steps tests, which have no wave model — so
        // supplying --produces/--needs/--category here is a contradiction. Reject
        // loudly (exit 5) rather than silently dropping the requested metadata,
        // matching the `--type frontend` + dep-flags guard in runCreate (codex).
        if (
          (cmdOpts.produces && cmdOpts.produces.length > 0) ||
          (cmdOpts.needs && cmdOpts.needs.length > 0) ||
          cmdOpts.category !== undefined
        ) {
          throw localValidationError(
            'produces',
            '--produces/--needs/--category are backend-only and cannot be used with --plan-from (plan-steps tests are FE and have no dependency/wave model). Use --code-file --type backend to author a dependency-aware BE test.',
          );
        }
        // On the --plan-from path the test definition lives entirely
        // inside the JSON file (projectId, type, name, description,
        // priority, planSteps). Any of those flags supplied alongside
        // --plan-from is silently dropped — collect them so runCreateFromPlan
        // can warn the user AFTER the plan validates. Emitting the advisory
        // here (before validation) made a missing-projectId failure look like
        // the ignored --project flag was the cause (dogfood L1778); deferring
        // it means a malformed plan fails fast with a clear `projectId` field
        // error and no misleading warning lands first.
        const ignored: string[] = [];
        if (cmdOpts.project !== undefined) ignored.push('--project');
        if (cmdOpts.type !== undefined) ignored.push('--type');
        if (cmdOpts.name !== undefined) ignored.push('--name');
        if (cmdOpts.description !== undefined) ignored.push('--description');
        if (cmdOpts.priority !== undefined) ignored.push('--priority');
        await runCreateFromPlan(
          {
            ...resolveCommonOptions(command),
            planFrom: cmdOpts.planFrom,
            run: cmdOpts.run === true,
            wait: cmdOpts.wait === true,
            timeout: parseTimeoutFlag(cmdOpts.timeout, 'timeout'),
            // B2(c): capture before parseTimeoutFlag converts undefined → default.
            timeoutIsDefault: cmdOpts.timeout === undefined,
            targetUrl: cmdOpts.targetUrl,
            idempotencyKey: cmdOpts.idempotencyKey,
            ignoredFlags: ignored,
          },
          deps,
        );
        return;
      }
      await runCreate(
        {
          ...resolveCommonOptions(command),
          projectId: cmdOpts.project,
          type: parseEnumFlag(cmdOpts.type, 'type', TEST_TYPES) as 'frontend' | 'backend',
          name: cmdOpts.name,
          description: cmdOpts.description,
          priority: parseEnumFlag(cmdOpts.priority, 'priority', CLI_CREATE_PRIORITIES) as
            | CliCreatePriority
            | undefined,
          codeFile: cmdOpts.codeFile,
          idempotencyKey: cmdOpts.idempotencyKey,
          // M3.3 chain flags:
          run: cmdOpts.run === true,
          wait: cmdOpts.wait === true,
          timeout: parseTimeoutFlag(cmdOpts.timeout, 'timeout'),
          // B2(c): capture before parseTimeoutFlag converts undefined → default.
          timeoutIsDefault: cmdOpts.timeout === undefined,
          targetUrl: cmdOpts.targetUrl,
          // M4 piece-2: BE dependency authoring flags.
          // Commander variadic collectors initialise to [] — treat empty array as undefined
          // so we don't send an empty array on the wire when no flags were passed.
          produces: cmdOpts.produces && cmdOpts.produces.length > 0 ? cmdOpts.produces : undefined,
          needs: cmdOpts.needs && cmdOpts.needs.length > 0 ? cmdOpts.needs : undefined,
          category: cmdOpts.category,
        },
        deps,
      );
    });

  test
    .command('create-batch')
    .description('Create multiple FE tests from a JSONL of plan specs (FE-only)')
    .option('--plans <path>', 'JSONL file with one plan-from spec per line (≤ 50 specs, ≤ 5 MB)')
    .option(
      '--plan-from-dir <dir>',
      'directory of *.json plan files — each file is one plan spec (≤ 50 files, ≤ 5 MB total). Sorted by filename for determinism. Mutually exclusive with --plans.',
    )
    .option('--run', 'after create, trigger each created test as a run', false)
    .option(
      '--max-concurrency <n>',
      'with --run, max in-flight triggers at once (1-100, default: 50). The server caps run-triggers at 60/min/key; the CLI throttles to 50/min and auto-retries RATE_LIMITED responses client-side — raising this value does not bypass the server cap.',
    )
    .option('--wait', 'with --run, poll each run until terminal status', false)
    .option('--timeout <s>', 'with --run --wait, per-run max seconds to wait (1-3600, default 600)')
    .option('--target-url <url>', 'with --run, override the project default env URL for each run')
    .option(
      '--idempotency-key <token>',
      'opaque idempotency token for the batch create (1-256 ASCII chars). Defaults to a UUIDv4 minted per invocation; pin one yourself for safe retries.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts: CreateBatchFlagOpts, command: Command) => {
      await runCreateBatch(
        {
          ...resolveCommonOptions(command),
          plans: cmdOpts.plans,
          planFromDir: cmdOpts.planFromDir,
          run: cmdOpts.run === true,
          maxConcurrency: parseNumericFlag(cmdOpts.maxConcurrency, 'max-concurrency'),
          wait: cmdOpts.wait === true,
          timeoutSeconds: parseTimeoutFlag(cmdOpts.timeout, 'timeout'),
          targetUrl: cmdOpts.targetUrl,
          idempotencyKey: cmdOpts.idempotencyKey,
        },
        deps,
      );
    });

  test
    .command('steps <test-id>')
    .description(
      'List the steps for a test (server returns the cumulative log across every run; use --run-id to scope to one run)',
    )
    .option('--page-size <n>', 'service page size hint (1-100, default 25)')
    .option('--max-items <n>', 'stop after this many items across auto-paged pages')
    .option('--starting-token <token>', 'opaque cursor from a previous response')
    .option(
      '--run-id <id>',
      "Filter steps to those belonging to the specified runId. Useful for tests that have been run multiple times — by default 'test steps' returns the cumulative log across every run. Note: legacy step records (pre-M3.1) with null runIdIfAvailable are excluded when this flag is set.",
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (testId: string, cmdOpts: StepsFlagOpts, command: Command) => {
      await runSteps(
        {
          ...resolveCommonOptions(command),
          testId,
          pageSize: parseNumericFlag(cmdOpts.pageSize, 'page-size'),
          startingToken: cmdOpts.startingToken,
          maxItems: parseNumericFlag(cmdOpts.maxItems, 'max-items'),
          runId: cmdOpts.runId,
        },
        deps,
      );
    });

  test
    .command('result <test-id>')
    .description(
      'Get the latest result for a test (default) or list prior runs (--history).\n' +
        '\n--output json shape differs by mode:\n' +
        '  (default)  single CliLatestResult object\n' +
        '  --history  { runs: RunHistoryItem[], nextCursor: string|null }\n' +
        '\nPer-run detail: testsprite test wait <run-id>\n' +
        'Failure bundle:  testsprite test artifact get <run-id>',
    )
    .option(
      '--include-analysis',
      'attach the inline `analysis` block (rootCauseHypothesis, recommendedFixTarget, failureKind, snapshotId) — M2.1',
      false,
    )
    .option('--history', 'list prior runs for this test instead of showing the latest result')
    .option('--source <src>', `with --history: filter by trigger source (${RUN_SOURCES.join('|')})`)
    .option(
      '--since <dur>',
      'with --history: lower bound on createdAt — 24h, 7d, or ISO timestamp (client-side translated)',
    )
    .option('--page-size <n>', 'with --history: number of runs per page (1–100, default 20)')
    .option('--cursor <token>', 'with --history: opaque cursor from a prior page')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (testId: string, cmdOpts: ResultFlagOpts, command: Command) => {
      if (cmdOpts.history) {
        // M3.4 piece-5: --history mode — list prior runs.
        await runResultHistory(
          {
            ...resolveCommonOptions(command),
            testId,
            source: parseEnumFlag(cmdOpts.source, 'source', RUN_SOURCES) as RunSource | undefined,
            since: cmdOpts.since,
            pageSize:
              cmdOpts.pageSize !== undefined
                ? parseNumericFlag(cmdOpts.pageSize, 'page-size')
                : undefined,
            cursor: cmdOpts.cursor,
          },
          deps,
        );
      } else {
        // M2 mode: latest result (byte-identical to pre-piece-5 behavior).
        await runResult(
          {
            ...resolveCommonOptions(command),
            testId,
            includeAnalysis: cmdOpts.includeAnalysis === true,
          },
          deps,
        );
      }
    });

  test
    .command('update <test-id>')
    .description('Update test metadata — name, description, priority')
    .option('--name <name>', 'new human-readable test name')
    .option('--description <text>', 'new human description (≤ 2000 chars)')
    .option('--priority <prio>', 'new priority — one of: p0, p1, p2, p3')
    .option(
      '--idempotency-key <token>',
      'opaque idempotency token (1-256 ASCII chars). Defaults to a UUIDv4 minted per invocation; pin one yourself for safe retries.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (testId: string, cmdOpts: UpdateFlagOpts, command: Command) => {
      await runUpdate(
        {
          ...resolveCommonOptions(command),
          testId,
          name: cmdOpts.name,
          description: cmdOpts.description,
          priority: parseEnumFlag(cmdOpts.priority, 'priority', CLI_CREATE_PRIORITIES) as
            | CliCreatePriority
            | undefined,
          idempotencyKey: cmdOpts.idempotencyKey,
        },
        deps,
      );
    });

  test
    .command('delete <test-id>')
    .description('Permanently delete a test. Requires --confirm. (M3.2 piece-3)')
    .option('--confirm', 'required: explicit confirmation for the destructive operation', false)
    .option(
      '--idempotency-key <token>',
      'opaque idempotency token (1-256 ASCII chars). Defaults to a UUIDv4 minted per invocation; pin one yourself for safe retries.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (testId: string, cmdOpts: DeleteFlagOpts, command: Command) => {
      await runDelete(
        {
          ...resolveCommonOptions(command),
          testId,
          confirm: cmdOpts.confirm === true,
          idempotencyKey: cmdOpts.idempotencyKey,
        },
        deps,
      );
    });

  // -------------------------------------------------------------------------
  // dogfood L1800 — `test delete-batch` (bulk soft-delete)
  // -------------------------------------------------------------------------

  test
    .command('delete-batch [test-ids...]')
    .description(
      'Permanently delete multiple tests in one command. Requires --confirm.\n' +
        'Use --all --project <id> to delete all tests in a project (optionally filtered by --status).\n' +
        '\nPrints a per-test summary (Deleted N, Skipped M, Failed K) to stdout.\n' +
        '\nExit codes:\n' +
        '  0  all targeted tests deleted (or --dry-run)\n' +
        '  1  one or more deletions failed (server error)\n' +
        '  5  validation error (missing --confirm, missing --project with --all, etc.)\n' +
        '\nNote: a 404 "not found" response is counted as skipped in the summary, not an error.',
    )
    .option('--confirm', 'required: explicit confirmation for the destructive operation', false)
    .option('--all', 'delete all tests in the resolved project (requires --project)', false)
    .option(
      '--project <id>',
      'project id (required with --all; returned by `testsprite project list`)',
    )
    .option(
      '--status <list>',
      `with --all: only delete tests whose status matches these values (comma-separated; accepted: ${PUBLIC_STATUSES.join('|')})`,
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (testIdsArg: string[], cmdOpts: DeleteBatchFlagOpts, command: Command) => {
      await runDeleteBatch(
        {
          ...resolveCommonOptions(command),
          testIds: testIdsArg ?? [],
          all: cmdOpts.all === true,
          projectId: cmdOpts.project,
          statusFilter: cmdOpts.status,
          confirm: cmdOpts.confirm === true,
        },
        deps,
      );
    });

  // -------------------------------------------------------------------------
  // M3.3 piece-3 — `test run` and `test wait`
  // -------------------------------------------------------------------------

  test
    .command('run [test-id]')
    .description(
      'Trigger a test run. With --wait, polls until terminal status.\n' +
        'Use --all --project <id> for a wave-ordered batch run of all BE tests (M4).\n' +
        '\nExit codes:\n' +
        '  0  passed (or queued without --wait)\n' +
        '  1  failed / blocked / cancelled\n' +
        '  3  auth error\n' +
        '  4  test not found\n' +
        '  5  validation error (e.g., bad --target-url, or positional + --all both set)\n' +
        '  6  conflict (already running — see nextAction for the active runId)\n' +
        '  7  timeout — resume with: testsprite test wait <run-id>\n' +
        ' 10  transport/network failure (UNAVAILABLE) — retry the command\n' +
        ' 11  rate limited — honor Retry-After\n' +
        '\nOn failure/blocked/cancelled, run: testsprite test artifact get <run-id>',
    )
    .option(
      '--target-url <url>',
      'override the project default env URL for this run (http/https only, no localhost/private IPs)',
    )
    .option('--wait', 'poll until terminal status or --timeout elapses', false)
    .option(
      '--timeout <s>',
      `with --wait, max seconds to wait (1–3600, default ${DEFAULT_RUN_TIMEOUT_SECONDS})`,
    )
    .option(
      '--idempotency-key <key>',
      'opaque key for safe retries (1–256 chars). Printed to stderr at --debug if auto-generated.',
    )
    .option(
      '--all',
      'run all BE tests in the project (wave-ordered fresh run; requires --project). Mutually exclusive with <test-id>.',
      false,
    )
    .option(
      '--project <id>',
      'project id (required with --all; returned by `testsprite project list`)',
    )
    .option(
      '--filter <substr>',
      'with --all: only run tests whose name contains this substring (case-insensitive)',
    )
    .option(
      '--max-concurrency <n>',
      `with --all --wait, max in-flight polls at once (1-100, default: ${DEFAULT_BATCH_RUN_CONCURRENCY})`,
    )
    .addHelpText(
      'after',
      '\nDependency-aware fresh run (M4):\n' +
        '  testsprite test run --all --project <id>           run all BE tests in wave order\n' +
        '  testsprite test run --all --project <id> --filter <substr>  name-glob subset\n' +
        '\nBE tests can declare --produces/--needs at create time to drive wave ordering\n' +
        '(see `testsprite test create --help` for details).',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (testIdArg: string | undefined, cmdOpts: RunFlagOpts, command: Command) => {
      const isAll = cmdOpts.all === true;

      // Mutual-exclusion: exactly one of positional <test-id> vs --all must be set.
      if (testIdArg !== undefined && isAll) {
        throw localValidationError(
          'test-id',
          'positional <test-id> and --all are mutually exclusive; use one or the other',
        );
      }
      if (testIdArg === undefined && !isAll) {
        throw localValidationError(
          'test-id',
          'provide a <test-id>, or use --all --project <id> to run all BE tests in a project',
        );
      }
      // --filter is an --all-only narrowing flag (mirrors `test rerun --filter`).
      // Without --all it would be SILENTLY ignored while the explicit <test-id>
      // still runs — defeating the caller's narrowing intent. Reject early.
      if (cmdOpts.filter !== undefined && cmdOpts.filter !== '' && !isAll) {
        throw localValidationError(
          'filter',
          '--filter only applies with --all (it narrows which project tests run). Remove --filter, or add --all --project <id>.',
        );
      }

      if (isAll) {
        // --all path: wave-ordered fresh batch run.
        if (!cmdOpts.project) {
          throw localValidationError(
            'project',
            '--all requires a project id — pass --project <id>',
          );
        }
        // --target-url has no effect on the --all batch path: it is BE-only
        // (FE tests are skipped server-side) and a BE test's base URL is baked
        // into its code. Silently dropping it could run the suite against an
        // unintended environment in the caller's mind — reject loudly instead.
        if (cmdOpts.targetUrl !== undefined && cmdOpts.targetUrl !== '') {
          throw localValidationError(
            'target-url',
            '--target-url has no effect with --all (the batch path is the BE-only wave engine; a BE test’s URL is baked into its code). Remove --target-url.',
          );
        }
        await runTestRunAll(
          {
            ...resolveCommonOptions(command),
            projectId: cmdOpts.project,
            nameFilter: cmdOpts.filter,
            wait: cmdOpts.wait === true,
            timeoutSeconds: parseTimeoutFlag(cmdOpts.timeout, 'timeout'),
            maxConcurrency:
              parseNumericFlag(cmdOpts.maxConcurrency, 'max-concurrency') ??
              DEFAULT_BATCH_RUN_CONCURRENCY,
            idempotencyKey: cmdOpts.idempotencyKey,
          },
          deps,
        );
        return;
      }

      // Single test-id path (unchanged M3.3 behavior).
      await runTestRun(
        {
          ...resolveCommonOptions(command),
          testId: testIdArg!,
          targetUrl: cmdOpts.targetUrl,
          wait: cmdOpts.wait === true,
          timeoutSeconds: parseTimeoutFlag(cmdOpts.timeout, 'timeout'),
          // B2(c): tell runTestRun whether --timeout was explicitly provided.
          timeoutIsDefault: cmdOpts.timeout === undefined,
          idempotencyKey: cmdOpts.idempotencyKey,
        },
        deps,
      );
    });

  test
    .command('wait <run-id>')
    .description(
      'Wait for a run to reach a terminal status.\n' +
        '\nExit codes:\n' +
        '  0  passed\n' +
        '  1  failed / blocked / cancelled\n' +
        '  3  auth error\n' +
        '  4  run not found\n' +
        '  7  timeout — resume with: testsprite test wait <run-id>\n' +
        ' 10  transport/network failure (UNAVAILABLE) — retry the command\n' +
        '\nOn failure/blocked/cancelled, run: testsprite test artifact get <run-id>',
    )
    .option('--timeout <s>', `max seconds to wait (1–3600, default ${DEFAULT_RUN_TIMEOUT_SECONDS})`)
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (runId: string, cmdOpts: WaitFlagOpts, command: Command) => {
      await runTestWait(
        {
          ...resolveCommonOptions(command),
          runId,
          timeoutSeconds: parseTimeoutFlag(cmdOpts.timeout, 'timeout'),
        },
        deps,
      );
    });

  // -------------------------------------------------------------------------
  // M3.4 piece-3 — `test rerun`
  // -------------------------------------------------------------------------

  test
    .command('rerun [test-ids...]')
    .description(
      'Re-execute a test (or multiple) as a cheap replay — FE replays the saved script (no credit), BE re-runs the dependency closure.\n' +
        '\nExit codes:\n' +
        '  0  passed (or queued without --wait)\n' +
        '  1  failed / blocked / cancelled\n' +
        '  3  auth error\n' +
        '  4  test not found\n' +
        '  5  validation error\n' +
        '  6  conflict (already running — see nextAction for the active runId)\n' +
        '  7  timeout or deferred — resume with: testsprite test wait <run-id>\n' +
        ' 11  rate limited — honor Retry-After\n' +
        '\nOn failure/blocked/cancelled, run: testsprite test artifact get <run-id>',
    )
    .option('--all', 'rerun all tests in the resolved project (requires --project)', false)
    .option(
      '--project <id>',
      'project id (required with --all; returned by `testsprite project list`)',
    )
    .option(
      '--skip-terminal',
      'with --all: skip tests already in a terminal status (passed|failed|blocked|cancelled)',
      false,
    )
    .option(
      '--status <list>',
      `with --all: only dispatch tests whose status matches one of these values (comma-separated; accepted: ${PUBLIC_STATUSES.join('|')})`,
    )
    .option(
      '--filter <substr>',
      'with --all: only rerun tests whose name contains this substring (case-insensitive)',
    )
    .option('--wait', 'block until terminal status or --timeout elapses', false)
    .option(
      '--timeout <s>',
      `with --wait, max seconds to wait (1–3600, default ${DEFAULT_RUN_TIMEOUT_SECONDS})`,
    )
    .option(
      '--no-auto-heal',
      'opt out of AI heal-on-drift for this FE rerun (default: auto-heal is ON). Costs 0.2 credits per engage when a step has drifted. Ignored for backend tests.',
    )
    .option(
      '--skip-dependencies',
      'BE only: rerun only the named test without expanding the producer/teardown closure',
      false,
    )
    .option(
      '--max-concurrency <n>',
      `with --wait, max in-flight polls at once (1-100, default: ${DEFAULT_BATCH_RUN_CONCURRENCY})`,
    )
    .option(
      '--idempotency-key <key>',
      'opaque key for safe retries (1–256 chars). Printed to stderr at --verbose if auto-generated.',
    )
    .addHelpText(
      'after',
      '\nNotes:\n' +
        '  • rerun replays a saved run/script and is MORE LENIENT than a fresh `test run`\n' +
        '    (auto-heal can pass steps that have drifted) — for strict scoring/regression,\n' +
        '    prefer `test run`. The two are not interchangeable for pass-rate measurement.\n' +
        '  • Under --wait the per-request HTTP timeout is auto-raised to cover --timeout so a\n' +
        '    slow trigger/poll under load is not cut at the 120s default (see --request-timeout).\n' +
        '  • Batch --wait: rate-deferred tests appear in `deferred[]` and `summary.deferred`,\n' +
        '    and force a non-zero exit — they are NOT counted in `summary.total` (dispatched only).',
    )
    .addHelpText(
      'after',
      '\nDry-run shape notes:\n' +
        '  • --dry-run shows the BE rerun wire shape (includes `closure{}`); FE rerun responses\n' +
        '    omit `closure` (or return it as null) since there is no dependency expansion.\n' +
        '  • `autoHeal` defaults true for FE reruns; BE reruns ignore the field entirely.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (testIdsArg: string[], cmdOpts: RerunFlagOpts, command: Command) => {
      // Commander's `--no-auto-heal` pattern makes `cmdOpts.autoHeal` default
      // `true` (unchanged by the user) and `false` when the user passes
      // `--no-auto-heal`. There is no explicit `--auto-heal` flag, so
      // autoHealExplicit is always false in this design — the default-on value
      // is never a deliberate user choice to opt in.
      await runTestRerun(
        {
          ...resolveCommonOptions(command),
          testIds: testIdsArg ?? [],
          all: cmdOpts.all === true,
          projectId: cmdOpts.project,
          skipTerminal: cmdOpts.skipTerminal === true,
          statusFilter: cmdOpts.status,
          nameFilter: cmdOpts.filter,
          wait: cmdOpts.wait === true,
          timeoutSeconds: parseTimeoutFlag(cmdOpts.timeout, 'timeout'),
          autoHeal: cmdOpts.autoHeal !== false,
          autoHealExplicit: false,
          skipDependencies: cmdOpts.skipDependencies === true,
          maxConcurrency:
            parseNumericFlag(cmdOpts.maxConcurrency, 'max-concurrency') ??
            DEFAULT_BATCH_RUN_CONCURRENCY,
          idempotencyKey: cmdOpts.idempotencyKey,
        },
        deps,
      );
    });

  test.addCommand(createTestCodeCommand(deps));
  test.addCommand(createTestPlanCommand(deps));
  test.addCommand(createTestFailureCommand(deps));
  test.addCommand(createTestArtifactCommand(deps));

  return test;
}

interface RunFlagOpts {
  targetUrl?: string;
  wait?: boolean;
  timeout?: string;
  idempotencyKey?: string;
  /** M4 piece-2: batch fresh run flags. */
  all?: boolean;
  project?: string;
  filter?: string;
  maxConcurrency?: string;
}

interface WaitFlagOpts {
  timeout?: string;
}

interface RerunFlagOpts {
  all?: boolean;
  project?: string;
  skipTerminal?: boolean;
  status?: string;
  filter?: string;
  wait?: boolean;
  timeout?: string;
  autoHeal?: boolean;
  skipDependencies?: boolean;
  maxConcurrency?: string;
  idempotencyKey?: string;
}

interface UpdateFlagOpts {
  name?: string;
  description?: string;
  priority?: string;
  idempotencyKey?: string;
}

interface DeleteFlagOpts {
  confirm?: boolean;
  idempotencyKey?: string;
}

interface DeleteBatchFlagOpts {
  confirm?: boolean;
  all?: boolean;
  project?: string;
  status?: string;
}

interface ResultFlagOpts {
  includeAnalysis?: boolean;
  /** M3.4 piece-5: switch to run-history mode. */
  history?: boolean;
  /** Filter history by trigger source. */
  source?: string;
  /** Filter history by lower bound on createdAt: 24h, 7d, or ISO timestamp. */
  since?: string;
  /** History page size (1–100, default 20). */
  pageSize?: string;
  /** Opaque pagination cursor from a prior page's nextCursor. */
  cursor?: string;
}

interface CreateFlagOpts {
  project: string;
  type: string;
  name: string;
  description?: string;
  planFrom?: string;
  run?: boolean;
  wait?: boolean;
  timeout?: string;
  targetUrl?: string;
  priority?: string;
  codeFile: string;
  idempotencyKey?: string;
  /** M4 piece-2: BE dependency authoring flags. */
  produces?: string[];
  needs?: string[];
  category?: string;
}

interface CreateBatchFlagOpts {
  plans: string;
  planFromDir?: string;
  run?: boolean;
  maxConcurrency?: string;
  wait?: boolean;
  timeout?: string;
  targetUrl?: string;
  idempotencyKey?: string;
}

interface ListFlagOpts {
  project: string;
  type?: string;
  createdFrom?: string;
  status?: string;
  pageSize?: string;
  startingToken?: string;
  /**
   * Alias for `--starting-token` accepted for vocabulary parity with
   * `test result --history` which uses `--cursor`. Both flags are
   * forwarded to the same pagination field; `--starting-token` takes
   * precedence when both are supplied (unlikely in practice).
   */
  cursor?: string;
  maxItems?: string;
}

interface StepsFlagOpts {
  pageSize?: string;
  startingToken?: string;
  maxItems?: string;
  runId?: string;
}

function requireProjectId(projectId: string): void {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw localValidationError('project', 'is required');
  }
}

/**
 * §6.6 / M2.1 piece 2 — validate the `--status <list>` flag client
 * side. Empty / undefined → no filter. Each token must be a public
 * status value; unknown tokens fail with VALIDATION_ERROR (exit 5)
 * before the request hits the wire so a typo like `--status fail`
 * gets a pointed error including the accepted set.
 */
function validateStatusFilter(raw: string | undefined): void {
  if (raw === undefined || raw === '') return;
  for (const token of raw.split(',')) {
    const trimmed = token.trim();
    if (trimmed === '') continue;
    if (!PUBLIC_STATUSES.includes(trimmed as CliPublicStatus)) {
      throw localValidationError(
        'status',
        `must be one of: ${PUBLIC_STATUSES.join(', ')} (comma-separated for multiple)`,
        [...PUBLIC_STATUSES],
      );
    }
  }
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

function resolveCommonOptions(command: Command): CommonOptions {
  const globals = command.optsWithGlobals() as Partial<CommonOptions> & {
    requestTimeout?: string;
  };
  // P2-8: validate --output before allowing silent fallback to 'text'.
  // An invalid value (e.g. `--output yaml`) must exit 5 with a clear error
  // rather than silently treating the request as text mode.
  return {
    profile: globals.profile ?? 'default',
    output: resolveOutputMode(globals.output),
    dryRun: globals.dryRun ?? false,
    endpointUrl: globals.endpointUrl,
    debug: globals.debug ?? false,
    verbose: globals.verbose ?? false,
    requestTimeoutMs: parseRequestTimeoutFlag(globals.requestTimeout),
  };
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
 * lower it). The poll loop's own deadline-aware `AbortSignal` (poll.ts) still
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

function makeClient(opts: CommonOptions, deps: TestDeps): HttpClient {
  return makeHttpClient(opts, {
    env: deps.env,
    credentialsPath: deps.credentialsPath,
    fetchImpl: deps.fetchImpl,
    stderr: deps.stderr,
  });
}

function makeOutput(mode: OutputMode, deps: TestDeps): Output {
  return new Output(mode, {
    stdout: deps.stdout,
    stderr: deps.stderr,
    rawStdout: deps.rawStdout,
  });
}

/**
 * Internal handle for `--out <path>` writes. Wraps a Node WriteStream
 * with a tracked `error` field so `closeOutputFile` can re-raise an
 * async stream error (EACCES on a write, ENOSPC mid-stream, etc.) that
 * was emitted between writes. The stream writes to `tmpPath`, a sibling
 * of the real `path`; `closeOutputFile` renames it into place only on
 * a successful, complete write, so a forged or failed response never
 * modifies (or empties) the operator's pre-existing `--out` file.
 */
interface FileSink {
  readonly stream: WriteStream;
  readonly path: string;
  readonly tmpPath: string;
  error: Error | null;
}

/**
 * Open a temp file next to the `--out` target before any network I/O so
 * a permission/dir error fails fast. Synchronous open via
 * `createWriteStream` doesn't actually open the descriptor until first
 * write, so we don't surface EACCES/ENOENT here, instead the stream
 * emits `'error'`, which we remember on the sink and re-throw at close
 * time. The benefit of opening early is still real: invalid path
 * strings (empty, `/dev/null` on a sandboxed fs, etc.) are caught
 * before the API request goes out. Writing to a temp path rather than
 * `resolved` directly means the real `--out` file is never truncated
 * up front, see `closeOutputFile` for the commit step.
 */
function openOutputFile(rawPath: string): FileSink {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw localValidationError('out', 'must be a non-empty file path');
  }
  const resolved = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
  // Defensive: reject obviously-bad paths up front (a directory string
  // would fail later with EISDIR; that's a clearer 5/VALIDATION_ERROR
  // surface than letting it crash mid-write with TransportError).
  if (resolved.endsWith('/')) {
    throw localValidationError('out', 'must point to a file, not a directory');
  }
  // Validate the parent dir synchronously so a missing or non-directory
  // parent surfaces as exit 5 / VALIDATION_ERROR rather than exit 1 /
  // TRANSPORT_ERROR. Without this, an ENOENT/ENOTDIR fires asynchronously
  // on first write and gets re-raised through `closeOutputFile` as a
  // TransportError — an exit-code mismatch with the rest of `--out`'s
  // input validation.
  const parent = dirname(resolved);
  let parentStat;
  try {
    parentStat = statSync(parent);
  } catch {
    throw localValidationError('out', `parent directory does not exist: ${parent}`);
  }
  if (!parentStat.isDirectory()) {
    throw localValidationError('out', `parent path is not a directory: ${parent}`);
  }
  const tmpPath = join(parent, `.${basename(resolved)}.tmp-${randomUUID()}`);
  const stream = createWriteStream(tmpPath, { encoding: 'utf8' });
  const sink: FileSink = { stream, path: resolved, tmpPath, error: null };
  stream.on('error', err => {
    sink.error = err instanceof Error ? err : new Error(String(err));
  });
  return sink;
}

/**
 * Adapter that turns a `FileSink` into the `Output` writer set. Both
 * `print` (line-oriented JSON) and `writeChunk` (raw bytes) flow into
 * the same stream; backpressure is preserved on the chunk path by
 * resolving the returned promise on `'drain'` when the kernel buffer
 * is full, mirroring the stdout writer in `output.ts`.
 */
function makeFileOutput(mode: OutputMode, sink: FileSink): Output {
  return new Output(mode, {
    stdout: line => {
      sink.stream.write(`${line}\n`);
    },
    rawStdout: text => {
      if (sink.error) throw sink.error;
      if (sink.stream.write(text)) return;
      return new Promise<void>(resolve => {
        sink.stream.once('drain', () => resolve());
      });
    },
  });
}

/**
 * Flush + close the file sink, then either commit or discard the temp
 * file. Called on the success path after the last write (`commit:
 * true` when content was actually written) and on the error / "no code
 * yet" paths (`commit: false`) inside a `.catch(() => undefined)` so a
 * teardown failure doesn't mask the original error.
 *
 * `commit: true` renames `tmpPath` onto the real `--out` path, the
 * only point at which the operator's file is touched. `commit: false`
 * discards the temp file and leaves any pre-existing `--out` file
 * exactly as it was, this is what prevents a failed/empty response
 * from silently truncating the operator's filesystem (mirrors the
 * atomic-rename contract `bundle.ts` uses for multi-file bundles).
 *
 * Re-raises any async stream error captured by the `'error'` listener.
 * Without this re-raise, an EACCES on first write would leave a
 * zero-byte temp file behind and exit 0, a false-success surface that
 * is exactly the failure mode `--out` exists to avoid.
 */
async function closeOutputFile(sink: FileSink, commit: boolean): Promise<void> {
  await new Promise<void>(resolveStream => {
    sink.stream.end(() => resolveStream());
  });
  if (sink.error) {
    await unlink(sink.tmpPath).catch(() => undefined);
    throw new TransportError(`Failed to write --out ${sink.path}: ${sink.error.message}`);
  }
  if (!commit) {
    await unlink(sink.tmpPath).catch(() => undefined);
    return;
  }
  await rename(sink.tmpPath, sink.path);
}

/** Tear down an opened `--out` sink without leaving a zero-byte artifact. */
async function abortOutputFile(sink: FileSink): Promise<void> {
  await new Promise<void>(resolve => {
    if (sink.stream.destroyed) {
      resolve();
      return;
    }
    sink.stream.once('close', () => resolve());
    sink.stream.destroy();
  });
  await unlink(sink.tmpPath).catch(() => undefined);
}

/** A presigned `code` body is any `https://` URL — never anything else. */
export function isPresignedCodeUrl(code: string): boolean {
  return code.startsWith('https://');
}

/**
 * Stream a presigned URL into the Output's chunk writer using the
 * deps-provided fetch impl, with no API-key headers — presigned URLs
 * carry their own authority. Three failure shapes the caller might
 * see, all routed through the typed envelope so `index.ts` produces
 * the documented exit code:
 *
 *   - The fetch itself rejects (DNS, TLS reset, offline) →
 *     `TransportError` (UNAVAILABLE / exit 10) per the CLI error spec
 *     §7.
 *   - The fetch resolves with a non-2xx → `UNAVAILABLE` envelope with
 *     the HTTP status in `details`. Same exit code as transport, since
 *     a presigned URL that returns 4xx/5xx is functionally indistinct
 *     from a network failure (the URL is short-lived; the answer is
 *     "re-run").
 *   - The body stream errors mid-read → wrapped as `TransportError`
 *     so partial output to stdout never silently truncates without a
 *     non-zero exit.
 *
 * Streaming via `response.body.getReader()` keeps memory bounded for
 * multi-MB code bodies and starts emitting bytes to stdout the moment
 * the first chunk arrives — important for `> file.ts` piping where
 * the reader may want to start indexing before the download finishes.
 */
async function streamPresignedBody(url: string, out: Output, deps: TestDeps): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TransportError(`Failed to download presigned code body: ${message}`);
  }
  if (!response.ok) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'UNAVAILABLE',
        message: `Failed to download presigned code body (HTTP ${response.status}).`,
        nextAction:
          'Re-run `testsprite test code get`. Presigned URLs expire after a short window.',
        requestId: 'local',
        details: { status: response.status, url },
      },
    });
  }
  if (!response.body) {
    // No streamable body (some test runtimes / fetch polyfills). Fall
    // back to text() — same correctness, just no streaming benefit.
    await out.writeChunk(await response.text());
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        // `await` is load-bearing: the default rawStdout writer
        // resolves on `'drain'` when stdout's kernel buffer is full,
        // which pauses this loop so we don't pull more chunks from
        // the network than the consumer can absorb.
        await out.writeChunk(decoder.decode(value, { stream: true }));
      }
    }
    // Flush any remaining buffered bytes from a multi-byte UTF-8 codepoint
    // straddling a chunk boundary. Without this the last code point of a
    // file ending in (say) a Chinese character would be silently dropped.
    const tail = decoder.decode();
    if (tail.length > 0) await out.writeChunk(tail);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TransportError(`Failed mid-download of presigned code body: ${message}`);
  }
}

function renderTestListText(page: Page<CliTest>): string {
  if (page.items.length === 0) {
    return page.nextToken ? `No tests on this page.\nnextToken: ${page.nextToken}` : 'No tests.';
  }
  const idWidth = Math.max(2, ...page.items.map(t => t.id.length));
  const nameWidth = Math.max(4, ...page.items.map(t => t.name.length));
  const typeWidth = 8;
  const fromWidth = 6;
  const statusWidth = 9;

  const header =
    pad('ID', idWidth) +
    '  ' +
    pad('NAME', nameWidth) +
    '  ' +
    pad('TYPE', typeWidth) +
    '  ' +
    pad('FROM', fromWidth) +
    '  ' +
    pad('STATUS', statusWidth) +
    '  ' +
    'UPDATED';

  const rows = page.items.map(
    t =>
      pad(t.id, idWidth) +
      '  ' +
      pad(t.name, nameWidth) +
      '  ' +
      pad(t.type, typeWidth) +
      '  ' +
      pad(t.createdFrom, fromWidth) +
      '  ' +
      pad(t.status, statusWidth) +
      '  ' +
      t.updatedAt,
  );

  const lines = [header, ...rows];
  if (page.nextToken) lines.push('', `nextToken: ${page.nextToken}`);
  return lines.join('\n');
}

function renderTestText(t: CliTest): string {
  // M2.1 piece 4: when the facade ships `projectName`, lead with a
  // human-friendly `project: <name> (<id>)` line so an operator
  // skimming `test get` sees the project label without a second
  // command. Pre-M2.1 facades that don't emit the field still render
  // — we fall back to `projectId:` only.
  const projectLine =
    t.projectName != null && t.projectName.length > 0
      ? `project:     ${t.projectName} (${t.projectId})`
      : `projectId:   ${t.projectId}`;
  const lines = [
    `id:          ${t.id}`,
    projectLine,
    `name:        ${t.name}`,
    `type:        ${t.type}`,
    `createdFrom: ${t.createdFrom}`,
    `status:      ${t.status}`,
  ];
  // G1a: surface priority when the backend ships it and it is non-null.
  if (t.priority) {
    lines.push(`priority:    ${t.priority}`);
  }
  // M3.4: surface plan-step count when the facade ships it (FE tests).
  // Lets an operator read the current count — e.g. to recover after a
  // `test plan put --expected-step-count` 412 — without a JSON round-trip.
  if (typeof t.planStepCount === 'number') {
    lines.push(`planSteps:   ${t.planStepCount}`);
  }
  lines.push(`createdAt:   ${t.createdAt}`, `updatedAt:   ${t.updatedAt}`);
  return lines.join('\n');
}

function renderStepsText(page: Page<CliTestStep>): string {
  if (page.items.length === 0) {
    return page.nextToken ? `No steps on this page.\nnextToken: ${page.nextToken}` : 'No steps.';
  }

  // M2.1 piece 4: prefix every row with a marker column. `*` flags
  // steps the facade marked as contributing to the test failure
  // (synthetic terminal "assertion" rows always get the marker;
  // pre-M2.1 callers see no markers because the field is absent or
  // null). Two-character column ("* " or "  ") so alignment stays
  // stable across pages.
  // Collapse newlines / runs of whitespace to single spaces and cap the
  // column width. Without this, one long or multi-line description — e.g.
  // a synthetic "TEST BLOCKED\n\n<paragraphs>…" assertion blob — set the
  // column to its full length, padding every short row with hundreds of
  // trailing spaces and shoving UPDATED far off-screen; embedded newlines
  // broke alignment outright (dogfood 2026-06-04). Full untruncated text
  // is still available via `--output json`.
  const descOf = (s: CliTestStep): string => {
    const isSynthetic =
      s.action === 'assertion' && s.htmlSnapshotUrl === null && s.screenshotUrl === null;
    const base = s.description.length > 0 ? s.description : '—';
    // Truncate the base FIRST, then append the synthetic hint, so the
    // "(synthetic assertion failure)" marker always survives truncation
    // (it explains why an `assertion` row exists when the code had none).
    const oneLine = base.replace(/\s+/g, ' ').trim();
    const clamped =
      oneLine.length > DESC_COL_MAX ? `${oneLine.slice(0, DESC_COL_MAX - 1)}…` : oneLine;
    return isSynthetic ? `${clamped} (synthetic assertion failure)` : clamped;
  };

  const indexWidth = Math.max(5, ...page.items.map(s => String(s.stepIndex).length));
  const actionWidth = Math.max(6, ...page.items.map(s => s.action.length));
  const statusWidth = 6; // "passed" / "failed" / "—"
  const descWidth = Math.max(11, ...page.items.map(s => descOf(s).length));

  const header =
    pad('  ', 2) +
    pad('INDEX', indexWidth) +
    '  ' +
    pad('ACTION', actionWidth) +
    '  ' +
    pad('STATUS', statusWidth) +
    '  ' +
    pad('DESCRIPTION', descWidth) +
    '  ' +
    'UPDATED';

  const rows = page.items.map(s => {
    const marker = s.outcomeContributesToFailure === true ? '* ' : '  ';
    return [
      marker,
      pad(String(s.stepIndex), indexWidth),
      pad(s.action, actionWidth),
      pad(s.status ?? '—', statusWidth),
      pad(descOf(s), descWidth),
      s.updatedAt,
    ].join('  ');
  });

  const lines: string[] = [header, ...rows, ''];

  // §6.4: all steps in one response share `runIdIfAvailable` and
  // `codeVersion` when non-null. Render them once at the bottom — the
  // agent gets them per-step in JSON, but humans don't need a column
  // repeated 50 times.
  const sharedRunId = uniqueNonNull(page.items.map(s => s.runIdIfAvailable));
  const sharedCodeVersion = uniqueNonNull(page.items.map(s => s.codeVersion));
  if (sharedRunId !== undefined) lines.push(`runId:       ${sharedRunId}`);
  if (sharedCodeVersion !== undefined) lines.push(`codeVersion: ${sharedCodeVersion}`);
  if (page.nextToken) lines.push(`nextToken:   ${page.nextToken}`);

  return lines.join('\n').replace(/\n+$/, '');
}

/**
 * Human summary block for `test failure get` (no `--out`). Headlines
 * the routing-relevant bits (status / failureKind / failedStepIndex)
 * and folds the `failure` sub-block in plain text. Intentionally
 * compact — JSON mode is the automation contract; this is for an
 * engineer running it interactively.
 */
function renderFailureContextText(ctx: CliFailureContext): string {
  const lines: string[] = [];
  lines.push(`status:           ${ctx.result.status}`);
  lines.push(`testId:           ${ctx.testId}`);
  lines.push(`projectId:        ${ctx.projectId}`);
  if (ctx.result.failureKind !== null) lines.push(`failureKind:      ${ctx.result.failureKind}`);
  if (ctx.result.failedStepIndex !== null)
    lines.push(`failedStepIndex:  ${ctx.result.failedStepIndex}`);
  lines.push(`snapshotId:       ${ctx.snapshotId}`);
  if (ctx.result.runIdIfAvailable !== null)
    lines.push(`runId:            ${ctx.result.runIdIfAvailable}`);
  if (ctx.result.codeVersion !== null) lines.push(`codeVersion:      ${ctx.result.codeVersion}`);
  if (ctx.result.targetUrl !== null) lines.push(`targetUrl:        ${ctx.result.targetUrl}`);
  lines.push('');
  if (ctx.failure.rootCauseHypothesis !== null) {
    lines.push(`rootCause:        ${ctx.failure.rootCauseHypothesis}`);
  } else {
    lines.push('rootCause:        — (analysis pipeline produced none)');
  }
  // M2.1 piece 3: `recommendedFixTarget` may be `null` when every
  // field is unfilled. Use the shared helper so this surface, the
  // /result `--include-analysis` block, and `failure summary` all
  // format the field identically.
  appendFixTargetLines(lines, ctx.failure.recommendedFixTarget, 'recommendedFix:   ');
  // Evidence: count + per-kind breakdown.
  if (ctx.failure.evidence.length === 0) {
    lines.push('evidence:         (empty — bundle ships result + code only)');
  } else {
    const counts = new Map<string, number>();
    for (const e of ctx.failure.evidence) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    const breakdown = [...counts.entries()].map(([k, n]) => `${k}×${n}`).join(', ');
    lines.push(`evidence:         ${ctx.failure.evidence.length} items (${breakdown})`);
  }
  if (ctx.result.videoUrl !== null) lines.push(`videoUrl:         ${ctx.result.videoUrl}`);
  return lines.join('\n');
}

function renderBundleWrittenText(data: { dir: string; files: number; snapshotId: string }): string {
  return `Bundle written to ${data.dir}\n  ${data.files} files, snapshotId=${data.snapshotId}`;
}

function renderBundleDryRunText(data: { dir: string; files: number; snapshotId: string }): string {
  return `(dry-run) would write bundle to ${data.dir}\n  ${data.files} files, snapshotId=${data.snapshotId}`;
}

/**
 * Approximate the file list `writeBundle` would produce for the given
 * context, so dry-run can communicate it to the user without touching
 * disk. Mirrors `bundle.ts` write order (result/failure/code/video,
 * per-step screenshot+snapshot, meta last) at a coarse level — sidecar
 * evidence files (log/network/console) are summarized rather than
 * predicted by exact name. Honors `--failed-only` by trimming step rows
 * to the failure window the bundle writer would keep.
 */
function plannedBundleFiles(ctx: CliFailureContext, failedOnly: boolean): string[] {
  const files: string[] = [];
  files.push('result.json');
  files.push('failure.json');
  files.push(`code.${pickCodeExtension(ctx.code.language, ctx.code.framework)}`);
  if (ctx.result.videoUrl) files.push('video.mp4');

  const stepsToInclude = failedOnly
    ? ctx.steps.filter(s => {
        if (ctx.result.failedStepIndex === null) return false;
        const target = ctx.result.failedStepIndex;
        return s.stepIndex >= target - 1 && s.stepIndex <= target + 1;
      })
    : ctx.steps;

  for (const step of stepsToInclude) {
    const prefix = stepFilenamePrefix(step.stepIndex);
    if (step.screenshotUrl) files.push(`steps/${prefix}-screenshot.png`);
    if (step.htmlSnapshotUrl) files.push(`steps/${prefix}-snapshot.html`);
  }

  // Sidecar evidence (log/network/console): the count varies and depends
  // on the bundle writer's per-step grouping. Surface a rolled-up count
  // rather than predict per-file names — agents reading the dry-run see
  // there's "N more sidecar files" without us re-implementing the
  // grouping logic.
  const sidecar = ctx.failure.evidence.filter(
    e => e.kind !== 'screenshot' && e.kind !== 'snapshot',
  );
  if (sidecar.length > 0) {
    files.push(`steps/<stepIndex>-evidence.json (×${sidecar.length} sidecar entries)`);
  }

  files.push('meta.json');
  return files;
}

/**
 * L141 — detect server-side truncation: returns `true` when the string
 * ends with U+2026 (`…`) AND is long enough that the ellipsis is likely a
 * truncation sentinel rather than intentional punctuation in short text.
 *
 * The backend historically appended `…` when truncating analysis text at ~600
 * chars. The backend is in the process of removing that hard cap, so this
 * indicator is transitional/defensive. We apply a length heuristic (≥ 500
 * chars) to avoid flagging short strings that legitimately end in `…` as
 * truncated — e.g. "Check the failing element…" (22 chars) is not truncated.
 *
 * Only used on JSON output to add sibling indicator fields; text-mode
 * rendering is unchanged.
 *
 * Note: the CLI cannot un-truncate data it never received. Full text
 * requires backend support.
 */
const TRUNCATION_MIN_LENGTH = 500;

function isServerTruncated(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.length >= TRUNCATION_MIN_LENGTH && value.endsWith('…');
}

/**
 * L141 — annotate `CliAnalysisBlock` with truncation indicator fields
 * for programmatic consumers. Returns a shallow copy (never mutates the
 * original). Only called on the JSON output path; text mode is unchanged.
 */
function annotateAnalysisTruncation(block: CliAnalysisBlock): CliAnalysisBlock {
  const annotated: CliAnalysisBlock = { ...block };
  if (isServerTruncated(block.rootCauseHypothesis)) {
    annotated.rootCauseHypothesisTruncated = true;
  }
  if (
    block.recommendedFixTarget !== null &&
    isServerTruncated(block.recommendedFixTarget.rationale)
  ) {
    annotated.recommendedFixRationaleTruncated = true;
  }
  return annotated;
}

function renderResultText(r: CliLatestResult): string {
  // §12.7: failureKind + failedStepIndex highlighted "when present".
  // Position is the highlight — failure-relevant fields lead the block
  // when the run failed; passing/running runs render in chronological
  // order so a glance reads like a timeline.
  const lines: string[] = [];
  // surface verdict (outcome) and executionStatus (lifecycle) instead
  // of the legacy conflated `status` (still present on the JSON wire shape).
  lines.push(`verdict:            ${r.verdict ?? '— (no verdict yet)'}`);
  lines.push(`executionStatus:    ${r.executionStatus}`);
  lines.push(`testId:             ${r.testId}`);
  if (r.failureKind !== null) lines.push(`failureKind:        ${r.failureKind}`);
  if (r.failedStepIndex !== null) lines.push(`failedStepIndex:    ${r.failedStepIndex}`);
  if (r.startedAt !== null) lines.push(`startedAt:          ${r.startedAt}`);
  if (r.finishedAt !== null) lines.push(`finishedAt:         ${r.finishedAt}`);
  lines.push(`snapshotId:         ${r.snapshotId}`);
  if (r.runIdIfAvailable !== null) lines.push(`runId:              ${r.runIdIfAvailable}`);
  if (r.codeVersion !== null) lines.push(`codeVersion:        ${r.codeVersion}`);
  if (r.targetUrl !== null) lines.push(`targetUrl:          ${r.targetUrl}`);
  lines.push(`summary:            ${r.summary}`);
  if (r.videoUrl !== null) lines.push(`videoUrl:           ${r.videoUrl}`);
  if (r.failureAnalysisUrl !== null) lines.push(`failureAnalysisUrl: ${r.failureAnalysisUrl}`);
  if (r.analysis !== undefined) {
    // §6.5.1 (M2.1 piece 3) — render the inline analysis block under
    // the result summary. Only fires when the caller passed
    // `--include-analysis`. JSON mode bypasses this renderer
    // (`out.print(result)` ships the wire envelope verbatim).
    lines.push('');
    lines.push(`rootCause:          ${r.analysis.rootCauseHypothesis ?? '— (none)'}`);
    appendFixTargetLines(lines, r.analysis.recommendedFixTarget, 'recommendedFix:    ');
  }
  return lines.join('\n');
}

/**
 * Render a `recommendedFixTarget` value in text mode. Shared by
 * `renderResultText` (under `--include-analysis`),
 * `renderFailureContextText`, and `renderFailureSummaryText` so the
 * three surfaces format the field identically.
 *
 * `null` (M2.1 visibility policy) renders as "— (analysis pipeline
 * did not propose one)" — the user-facing equivalent of the wire-
 * level null. Non-null wrappers render `kind=...` plus an optional
 * reference and indented rationale.
 */
function appendFixTargetLines(lines: string[], fix: CliFixTarget | null, label: string): void {
  if (fix === null) {
    lines.push(`${label}— (analysis pipeline did not propose one)`);
    return;
  }
  const ref = fix.reference ? ` reference=${fix.reference}` : '';
  lines.push(`${label}kind=${fix.kind}${ref}`);
  if (fix.rationale !== null) {
    // Indent the rationale to the column under the value. The exact
    // column doesn't have to match the label width across surfaces;
    // a fixed two-space hanging indent keeps the rendering local to
    // this helper so callers don't pad themselves.
    lines.push(`                    ${fix.rationale}`);
  }
}

/**
 * §5.2 / M2.1 piece 3 — text renderer for `test failure summary`.
 * One-screen agent-readable triage card, no bundle. Mirrors
 * `renderFailureContextText`'s top section minus the bundle metadata
 * (no run id, no codeVersion, no evidence count, no videoUrl) so a
 * caller running `failure summary` after `failure get` doesn't see a
 * confusing partial bundle.
 */
function renderFailureSummaryText(s: CliFailureSummary): string {
  const lines: string[] = [];
  lines.push(`testId:               ${s.testId}`);
  lines.push(`status:               ${s.status}`);
  if (s.failureKind !== null) lines.push(`failureKind:          ${s.failureKind}`);
  lines.push(`snapshotId:           ${s.snapshotId}`);
  lines.push(
    `rootCauseHypothesis:  ${s.rootCauseHypothesis ?? '— (analysis pipeline produced none)'}`,
  );
  appendFixTargetLines(lines, s.recommendedFixTarget, 'recommendedFixTarget: ');
  return lines.join('\n');
}

/**
 * If every non-null entry shares the same value, return it; otherwise
 * undefined. Used by step rendering to surface a per-response shared
 * `runId` / `codeVersion` once instead of in every row.
 */
function uniqueNonNull(values: Array<string | null>): string | undefined {
  const filtered = values.filter((v): v is string => v !== null);
  if (filtered.length === 0) return undefined;
  const first = filtered[0]!;
  return filtered.every(v => v === first) ? first : undefined;
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function createTestCodeCommand(deps: TestDeps): Command {
  const code = new Command('code').description('Inspect and edit generated test code');
  code
    .command('get <test-id>')
    .description('Print the generated test code')
    .option(
      '--out <path>',
      'Write the response to this file instead of stdout (text mode: source body; json mode: wire envelope)',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (testId: string, cmdOpts: { out?: string }, command: Command) => {
      await runCodeGet({ ...resolveCommonOptions(command), testId, out: cmdOpts.out }, deps);
    });
  code
    .command('put <test-id>')
    .description('Replace test code with etag-guarded optimistic concurrency')
    .option('--code-file <path>', 'file containing the new test code (≤ 350 KB)')
    .option(
      '--expected-version <v>',
      'expected current codeVersion (e.g. v3); sent as `If-Match`. Mutually exclusive with --force.',
    )
    .option(
      '--force',
      'send `If-Match: *` to skip the etag check (audit-logged with force: true). Mutually exclusive with --expected-version.',
      false,
    )
    .option(
      '--language <lang>',
      'set the stored code language; only "python" is supported (TestSprite executes test code as Python). Defaults to the existing language.',
    )
    .option(
      '--idempotency-key <token>',
      'opaque idempotency token (1-256 ASCII chars). Defaults to a UUIDv4 minted per invocation; pin one yourself for safe retries.',
    )
    .option(
      '--dry-run-simulate-error <code>',
      'With --dry-run: synthesise an error envelope to preview the error path. Supported: PRECONDITION_FAILED (412).',
    )
    .addHelpText(
      'after',
      '\nDry-run note: --dry-run always returns the happy response shape.\n' +
        'To preview the 412 retry-hint path, combine with --dry-run-simulate-error PRECONDITION_FAILED.\n' +
        '\n' +
        GLOBAL_OPTS_HINT,
    )
    .action(async (testId: string, cmdOpts: CodePutFlagOpts, command: Command) => {
      const simulateError = cmdOpts.dryRunSimulateError;
      if (simulateError !== undefined && simulateError !== 'PRECONDITION_FAILED') {
        throw localValidationError(
          'dry-run-simulate-error',
          `unsupported value "${simulateError}"; only PRECONDITION_FAILED is supported`,
          ['PRECONDITION_FAILED'],
        );
      }
      await runCodePut(
        {
          ...resolveCommonOptions(command),
          testId,
          codeFile: cmdOpts.codeFile,
          expectedVersion: cmdOpts.expectedVersion,
          force: cmdOpts.force === true,
          language: parseEnumFlag(cmdOpts.language, 'language', CODE_PUT_LANGUAGES) as
            | CodePutLanguage
            | undefined,
          idempotencyKey: cmdOpts.idempotencyKey,
          dryRunSimulateError:
            simulateError === 'PRECONDITION_FAILED' ? 'PRECONDITION_FAILED' : undefined,
        },
        deps,
      );
    });
  return code;
}

function createTestPlanCommand(deps: TestDeps): Command {
  const plan = new Command('plan').description('Manage FE test plan-steps (FE-only)');
  plan
    .command('put <test-id>')
    .description("Replace an FE test's planSteps[] (BE tests return 400 → use 'test code put')")
    .option(
      '--steps <path>',
      'JSON file with { planSteps: [...] } (FE-only, ≤ 200 steps, ≤ 256 KB)',
    )
    .option(
      '--expected-step-count <n>',
      'optional defensive concurrency check; server rejects with 412 when the current length differs',
    )
    .option(
      '--idempotency-key <token>',
      'opaque idempotency token (1-256 ASCII chars). Defaults to a UUIDv4 minted per invocation; pin one yourself for safe retries.',
    )
    .option(
      '--dry-run-simulate-error <code>',
      'With --dry-run: synthesise an error envelope to preview the error path. Supported: PRECONDITION_FAILED (412).',
    )
    .addHelpText(
      'after',
      '\nDry-run note: --dry-run always returns the happy response shape.\n' +
        'To preview the 412 retry-hint path, combine with --dry-run-simulate-error PRECONDITION_FAILED.\n' +
        '\n' +
        GLOBAL_OPTS_HINT,
    )
    .action(async (testId: string, cmdOpts: PlanPutFlagOpts, command: Command) => {
      const simulateError = cmdOpts.dryRunSimulateError;
      if (simulateError !== undefined && simulateError !== 'PRECONDITION_FAILED') {
        throw localValidationError(
          'dry-run-simulate-error',
          `unsupported value "${simulateError}"; only PRECONDITION_FAILED is supported`,
          ['PRECONDITION_FAILED'],
        );
      }
      await runPlanPut(
        {
          ...resolveCommonOptions(command),
          testId,
          stepsFile: cmdOpts.steps,
          expectedStepCount: parseNumericFlag(cmdOpts.expectedStepCount, 'expected-step-count'),
          idempotencyKey: cmdOpts.idempotencyKey,
          dryRunSimulateError:
            simulateError === 'PRECONDITION_FAILED' ? 'PRECONDITION_FAILED' : undefined,
        },
        deps,
      );
    });
  return plan;
}

interface PlanPutFlagOpts {
  steps: string;
  expectedStepCount?: string;
  idempotencyKey?: string;
  dryRunSimulateError?: string;
}

interface CodePutFlagOpts {
  codeFile: string;
  expectedVersion?: string;
  force?: boolean;
  language?: string;
  idempotencyKey?: string;
  dryRunSimulateError?: string;
}

export function createTestArtifactCommand(deps: TestDeps): Command {
  const artifact = new Command('artifact').description(
    'Download run-scoped artifact bundles (M3.3 piece-4)',
  );
  artifact
    // `isDefault: true` makes `test artifact <run-id>` a pass-through alias for
    // `test artifact get <run-id>` (DEV-230 grammar consistency — bare-noun reads
    // mirror the flat `test result/steps/get <id>` forms). Run-id semantics are
    // preserved: the positional is still a run-id, not a test-id.
    .command('get <run-id>', { isDefault: true })
    .description(
      [
        'Download the §7 failure-context bundle for a specific run.',
        '',
        'Default <dir>: ./.testsprite/runs/<run-id>/',
        '',
        'Exit codes:',
        '  0  bundle written successfully',
        '  3  authentication error (AUTH_* scope)',
        '  4  run not found / not ready / no failure / cancelled',
        '  5  validation error (bad --out, meta.runId mismatch)',
        '  6  conflict — snapshot in flight (retried once)',
        ' 10  transport failure (.partial left on disk)',
      ].join('\n'),
    )
    .option(
      '--out <dir>',
      [
        'Directory to write the §7 disk layout (default: ./.testsprite/runs/<run-id>/).',
        'Parent must exist. The bundle dir itself is created if absent.',
      ].join(' '),
    )
    .option('--failed-only', 'Keep only the failed step plus its immediate neighbors (±1)')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (runId: string, cmdOpts: { out?: string; failedOnly?: boolean }, command: Command) => {
        await runArtifactGet(
          {
            ...resolveCommonOptions(command),
            runId,
            out: cmdOpts.out,
            failedOnly: Boolean(cmdOpts.failedOnly),
          },
          deps,
        );
      },
    );
  return artifact;
}

function createTestFailureCommand(deps: TestDeps): Command {
  const failure = new Command('failure').description('Export the latest-failure agent bundle');
  failure
    // `isDefault: true` makes `test failure <test-id>` a pass-through alias for
    // `test failure get <test-id>` (DEV-230 grammar consistency). `failure summary`
    // still routes explicitly; only the bare-noun form falls through to `get`.
    .command('get <test-id>', { isDefault: true })
    .description("Write a self-contained failure-context bundle for a test's latest failing run")
    .option(
      '--out <dir>',
      'Directory to write the §7 disk layout into (default: print wire envelope to stdout)',
    )
    .option('--failed-only', 'Keep only the failed step plus its immediate neighbors (±1)')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (testId: string, cmdOpts: { out?: string; failedOnly?: boolean }, command: Command) => {
        await runFailureGet(
          {
            ...resolveCommonOptions(command),
            testId,
            out: cmdOpts.out,
            failedOnly: Boolean(cmdOpts.failedOnly),
          },
          deps,
        );
      },
    );
  failure
    .command('summary <test-id>')
    .description(
      'Print a one-screen summary of the latest failing run (status, failureKind, hypothesis, fix target — M2.1)',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (testId: string, _cmdOpts, command: Command) => {
      await runFailureSummary({ ...resolveCommonOptions(command), testId }, deps);
    });
  return failure;
}
