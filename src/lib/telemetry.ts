/**
 * Client-side telemetry: one "command outcome" event per CLI invocation,
 * fired to the backend beacon (`POST /api/cli/v1/telemetry`), which forwards it
 * to PostHog server-side. The CLI ships no PostHog SDK / write-key.
 *
 * Contract:
 *   - Best-effort: every failure is swallowed; telemetry NEVER changes a
 *     command's behavior, output, or exit code.
 *   - Bounded: the POST is aborted after {@link TELEMETRY_TIMEOUT_MS}, so the
 *     flush-before-exit can add at most that long to a slow/unreachable-backend
 *     invocation (normal case is a sub-200ms POST).
 *   - Authenticated-only: skipped when no api-key is configured (the backend
 *     keys the event on the api-key's user; anonymous events are out of scope).
 *   - Opt-out: skipped when `TESTSPRITE_NO_TELEMETRY` or the cross-tool
 *     `DO_NOT_TRACK` is set. Also skipped under `--dry-run` (no network) and
 *     when no leaf command actually ran (bare `--help` / parse errors).
 *   - Never on abort (SIGINT/SIGTERM): Ctrl-C must exit immediately, so the
 *     abort path emits nothing (awaiting would delay shutdown; fire-and-forget
 *     would be cut off before delivery anyway).
 *
 * Privacy: the event is a fixed allowlist of low-cardinality, PII-free fields.
 * It NEVER carries target URLs, api keys, arg values, error messages, or
 * repository names — `errorCode` is a stable machine code, never the human
 * message, and the CI repository is reduced to a salted, truncated hash so
 * runs from one repo can be grouped without the slug ever leaving the runner.
 * `timeoutSeconds` is the one field derived from a flag, and it is allowed
 * for a narrow, checkable reason, not a case-by-case judgment call: it is the
 * literal integer value of `--timeout`/`--request-timeout` as typed by the
 * operator — not a path, not a URL, not free text, and not derived from
 * anything the target application returned. It carries no more information
 * than `exitCode` or `durationMs` already do, and is included so a `--wait`
 * timeout is distinguishable from a genuinely slow backend (see `errorOrigin`
 * below). Anyone auditing this allowlist can verify that reasoning against
 * the two call sites that set it (`RequestTimeoutError.timeoutMs`, and the
 * `ApiError` `details.timeoutSeconds` a `--wait` deadline conversion stamps)
 * without having to trust a one-off exception.
 *
 * `errorOrigin` ('client' | 'server') and `timeoutSeconds` are sent by this
 * revision of the CLI. The telemetry endpoint validates against an allowlist
 * and silently DROPS fields it does not declare rather than rejecting the
 * request, so a server that predates these two fields accepts the event and
 * discards them — inert, not an error. Declaring a field is also not enough
 * on its own: the server has a separate mapping step onto the analytics
 * event, so a field can pass validation and still not be recorded.
 */
import { createHash } from 'node:crypto';
import { CommanderError } from 'commander';
import { buildUserAgent, resolveClientTag } from './client-tag.js';
import { dominantConflictReason, type RunConflict } from './conflict-reason.js';
import { loadConfig } from './config.js';
import { defaultCredentialsPath } from './credentials.js';
import {
  ApiError,
  CLIError,
  InterruptError,
  RequestTimeoutError,
  extractNodeErrorCode,
} from './errors.js';
import { facadeBaseUrl } from './facade.js';
import { VERSION } from '../version.js';

/**
 * Max time the flush-before-exit will wait on the beacon POST. Kept short so a
 * slow/unreachable backend adds at most this to a command's exit (including
 * Ctrl-C); a healthy POST completes in well under it, and when it doesn't,
 * dropping the event is the correct best-effort behavior.
 */
export const TELEMETRY_TIMEOUT_MS = 1000;

export type TelemetryOutcome = 'success' | 'error' | 'abort';

export interface WaitTimeoutTelemetry {
  reason: 'wait_timeout';
  cancelOutcome?: 'cancelled' | 'already_terminal' | 'failed' | 'skipped';
}

export interface TelemetryOutcomeInput extends Partial<WaitTimeoutTelemetry> {
  /** Leaf command path that ran, e.g. `test run`. Empty → skip (no command). */
  command: string;
  outcome: TelemetryOutcome;
  exitCode: number;
  /** Stable machine error code (e.g. `VALIDATION_ERROR`) — never a message. */
  errorCode?: string;
  /**
   * Whether `errorCode` was actually classified by the backend
   * ('server') or fabricated client-side ('client' — a `--wait` timeout
   * conversion, local pre-flight validation, a transport failure, an
   * uncaught exception, …). Without this, a client-fabricated `UNSUPPORTED`
   * (the `--wait` timeout bucket, exit 7) is indistinguishable in telemetry
   * from a genuine backend 501 — see `classifyCliError()` for the exact
   * discriminator.
   */
  errorOrigin?: 'client' | 'server';
  /**
   * The effective timeout deadline (seconds) for an error event caused by a
   * client-side timeout — either a per-request timeout (`RequestTimeoutError`)
   * or a `--wait`/`--timeout` poll deadline surfaced as `UNSUPPORTED`. Absent
   * for every other error.
   */
  timeoutSeconds?: number;
  durationMs: number;
  /** Global flags, used to resolve config + fill context. */
  profile?: string;
  endpointUrl?: string;
  output?: string;
  dryRun?: boolean;
  /**
   * True when the invocation requested a local tunnel target (`test run
   * --local <port>`) — the flag's mere presence, never its port number or
   * host. Reported regardless of outcome, including a zero-network refusal
   * (dead port, `--local` combined with an incompatible flag): those are
   * exactly the attempts nothing server-side ever sees, which is why this
   * field is not redundant with a backend-side mint/attach analytics event.
   */
  local?: boolean;
}

export interface TelemetryDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: typeof globalThis.fetch;
  /** Test seam for TTY detection (CI/non-interactive context prop). */
  isTTY?: boolean;
  /**
   * Auth pre-resolved by the caller (the preAction hook). When present,
   * recordOutcome uses it verbatim instead of re-reading the credentials file —
   * so a command that mutates that file (`auth remove` deletes the profile) is
   * still reported on the key it ran under.
   */
  resolvedAuth?: ResolvedTelemetryAuth;
}

/** The (apiKey, apiUrl) pair telemetry needs, resolved once per invocation. */
export interface ResolvedTelemetryAuth {
  apiKey?: string;
  apiUrl: string;
}

// ---------------------------------------------------------------------------
// CI context — which CI system ran the command, and (GitHub only) which event
// ---------------------------------------------------------------------------

export type CiProvider = 'github' | 'gitlab' | 'circleci' | 'buildkite' | 'other' | 'none';
export type CiEvent = 'push' | 'pull_request' | 'schedule' | 'workflow_dispatch' | 'other';

/**
 * Which CI system the process is running under, from the standard env markers
 * each vendor documents. `other` is any CI that only sets the generic `CI`
 * variable; `none` is an interactive/unknown context.
 */
export function detectCiProvider(env: NodeJS.ProcessEnv): CiProvider {
  if (env.GITHUB_ACTIONS === 'true') return 'github';
  if (isTruthyEnv(env.GITLAB_CI)) return 'gitlab';
  if (isTruthyEnv(env.CIRCLECI)) return 'circleci';
  if (isTruthyEnv(env.BUILDKITE)) return 'buildkite';
  if (isTruthyEnv(env.CI)) return 'other';
  return 'none';
}

const CI_EVENTS: ReadonlySet<CiEvent> = new Set<CiEvent>([
  'push',
  'pull_request',
  'schedule',
  'workflow_dispatch',
]);

/**
 * The GitHub Actions event that triggered the workflow, bucketed to a fixed
 * vocabulary (`other` for everything outside it, e.g. `release`). Only
 * meaningful under GitHub; undefined for every other provider and when the
 * runner did not set `GITHUB_EVENT_NAME`.
 */
export function detectCiEvent(env: NodeJS.ProcessEnv, provider: CiProvider): CiEvent | undefined {
  if (provider !== 'github') return undefined;
  const name = env.GITHUB_EVENT_NAME;
  if (typeof name !== 'string' || name === '') return undefined;
  return CI_EVENTS.has(name as CiEvent) ? (name as CiEvent) : 'other';
}

/**
 * Stable, non-reversible grouping key for a CI repository: the first 16 hex
 * chars of `sha256('testsprite-ci-repo:' + slug)`. The salt prefix keeps the
 * digest from matching a plain `sha256(slug)` lookup table; the slug itself
 * never leaves the runner.
 */
export function hashRepository(slug: string): string {
  return createHash('sha256').update(`testsprite-ci-repo:${slug}`).digest('hex').slice(0, 16);
}

/** The CI-context slice of the event (provider always present; the rest only when known). */
export function buildCiContext(env: NodeJS.ProcessEnv): {
  ciProvider: CiProvider;
  ciEvent?: CiEvent;
  repoHash?: string;
} {
  const ciProvider = detectCiProvider(env);
  const ciEvent = detectCiEvent(env, ciProvider);
  const repo = env.GITHUB_REPOSITORY;
  return {
    ciProvider,
    ...(ciEvent !== undefined ? { ciEvent } : {}),
    ...(typeof repo === 'string' && repo !== '' ? { repoHash: hashRepository(repo) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Per-command extras — batch outcome counts and `ci init` facts
// ---------------------------------------------------------------------------

/**
 * Conflict reasons the beacon accepts for `conflictReason` (the backend DTO
 * whitelist-strips anything else). Deliberately a SEPARATE vocabulary from
 * `conflict-reason.ts`'s rendering type: `tunnel-required` is a server reason
 * this CLI has no label for yet, and `not_found` is rendered but not counted.
 */
export type TelemetryConflictReason =
  | 'in_flight'
  | 'insufficient_credits'
  | 'billing_hold'
  | 'mcp_view_only'
  | 'local_address'
  | 'tunnel-required'
  | 'error';

/**
 * Low-cardinality facts a command records about its own outcome before it
 * returns, merged into the one event `index.ts` fires. Counts are non-negative
 * integers; enums are closed. Nothing here can carry an id, a URL, or a message.
 */
export interface TelemetryExtras {
  /** Batch dispatch accounting (`test run --all`, `testlist run`). */
  accepted?: number;
  conflicts?: number;
  deferred?: number;
  skipped?: number;
  /** Terminal verdict counts over the polled runs (`--wait` paths; 0/1 for a single run). */
  passed?: number;
  failed?: number;
  blocked?: number;
  timedOut?: number;
  /** The most frequent conflict reason of the batch. */
  conflictReason?: TelemetryConflictReason;
  /** `ci init` facts. */
  platform?: 'github';
  force?: boolean;
  workflowExisted?: boolean;
  projectResolved?: 'flag' | 'auto';
}

/** What callers may hand the sanitizer: the typed shape, or an arbitrary bag it filters. */
export type TelemetryExtrasInput = TelemetryExtras | Readonly<Record<string, unknown>>;

const COUNT_KEYS = [
  'accepted',
  'conflicts',
  'deferred',
  'skipped',
  'passed',
  'failed',
  'blocked',
  'timedOut',
] as const;
const BOOLEAN_KEYS = ['force', 'workflowExisted'] as const;
const ENUM_KEYS: { [K in 'conflictReason' | 'platform' | 'projectResolved']: ReadonlySet<string> } =
  {
    conflictReason: new Set<TelemetryConflictReason>([
      'in_flight',
      'insufficient_credits',
      'billing_hold',
      'mcp_view_only',
      'local_address',
      'tunnel-required',
      'error',
    ]),
    platform: new Set(['github']),
    projectResolved: new Set(['flag', 'auto']),
  };

/**
 * Keep only the allowlisted keys with a value of the right shape. Pure: this is
 * the single gate both the sink and the event builder run, so a stray field or
 * a mistyped value can never reach the wire from either direction.
 */
export function sanitizeTelemetryExtras(partial: TelemetryExtrasInput): TelemetryExtras {
  const rec = partial as Record<string, unknown>;
  const out: TelemetryExtras = {};
  for (const key of COUNT_KEYS) {
    const v = rec[key];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[key] = v;
  }
  for (const key of BOOLEAN_KEYS) {
    const v = rec[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  for (const key of Object.keys(ENUM_KEYS) as Array<keyof typeof ENUM_KEYS>) {
    const v = rec[key];
    if (typeof v === 'string' && ENUM_KEYS[key].has(v)) {
      (out as Record<string, unknown>)[key] = v;
    }
  }
  return out;
}

/** Module-level sink: the extras the running command has recorded so far. */
let pendingExtras: TelemetryExtras = {};

/**
 * Record outcome facts for the event this process will fire. Called by a
 * command just before it returns/throws; merged per key, so a later call for
 * the same key wins and different commands' keys never collide. Values outside
 * the allowlist (or of the wrong shape) are dropped silently — a caller can
 * never widen the wire contract from here.
 */
export function recordTelemetryExtras(partial: TelemetryExtrasInput): void {
  pendingExtras = { ...pendingExtras, ...sanitizeTelemetryExtras(partial) };
}

/** Return everything recorded so far and clear the sink (one event per process). */
export function takeTelemetryExtras(): TelemetryExtras {
  const taken = pendingExtras;
  pendingExtras = {};
  return taken;
}

/**
 * Disjoint verdict counts over a set of polled runs — `passed` + `failed` +
 * `blocked` + `timedOut` = total. Unlike the CI summary's `failed` (which folds
 * blocked in), `blocked` is split out here because it is the signal that
 * separates a broken target from a failing assertion.
 */
export function batchOutcomeCounts(results: ReadonlyArray<{ status: string }>): {
  passed: number;
  failed: number;
  blocked: number;
  timedOut: number;
} {
  let passed = 0;
  let blocked = 0;
  let timedOut = 0;
  for (const r of results) {
    if (r.status === 'passed') passed++;
    else if (r.status === 'blocked') blocked++;
    else if (r.status === 'timeout') timedOut++;
  }
  return { passed, failed: results.length - passed - blocked - timedOut, blocked, timedOut };
}

/**
 * Record a batch command's dispatch accounting (and, under `--wait`, its
 * verdict counts) in one call, so `test run --all` and `testlist run` cannot
 * drift in how they count. `conflictReason` is the dominant reason of the
 * batch; `results` are the polled runs (omit for a non-wait dispatch).
 */
export function recordBatchOutcome(batch: {
  accepted: number;
  conflicts: readonly RunConflict[];
  deferred: number;
  skipped: number;
  results?: ReadonlyArray<{ status: string }>;
}): void {
  recordTelemetryExtras({
    accepted: batch.accepted,
    conflicts: batch.conflicts.length,
    deferred: batch.deferred,
    skipped: batch.skipped,
    conflictReason: dominantConflictReason(batch.conflicts),
    ...(batch.results !== undefined ? batchOutcomeCounts(batch.results) : {}),
  });
}

/** The exact wire body — a flat allowlist mirroring the backend DTO. */
export interface TelemetryEvent extends Partial<WaitTimeoutTelemetry>, TelemetryExtras {
  command: string;
  outcome: TelemetryOutcome;
  exitCode?: number;
  errorCode?: string;
  errorOrigin?: 'client' | 'server';
  timeoutSeconds?: number;
  durationMs?: number;
  cliVersion?: string;
  os?: string;
  nodeVersion?: string;
  output?: string;
  ci?: boolean;
  /** Present (always `true`) only for a `test run --local` invocation; absent otherwise. */
  local?: boolean;
  /** The validated `TESTSPRITE_CLIENT` tag (e.g. `github-action/v1`); absent when unset/invalid. */
  client?: string;
  ciProvider?: CiProvider;
  ciEvent?: CiEvent;
  repoHash?: string;
}

/**
 * Map a thrown CLI error to its telemetry disposition — mirrors the exit-code
 * mapping in `index.ts`'s top-level catch so telemetry and the process exit
 * code never disagree. Pure; safe to unit-test.
 *
 * Every branch below now fills `errorCode` — the two fallback branches
 * (`CLIError`, and the final catch-all for a non-CLIError throw) previously
 * left it `undefined`, which is why a meaningful share of `test run`
 * invocations and `setup` failures landed in telemetry with `errorCode=None`.
 *
 * `errorOrigin` ('client' | 'server') resolves a real UNSUPPORTED
 * misclassification: prod data showed genuine backend 501 UNSUPPORTED
 * responses are rare compared to the PostHog events carrying that code,
 * because every `--wait` timeout is ALSO converted to a client-fabricated
 * `UNSUPPORTED`/exit-7 envelope (exit 7 is the timeout bucket by design;
 * this patch does not touch that contract, only observability).
 *
 * Discriminator: for an `ApiError`, `err.httpStatus !== undefined` iff the
 * code came from a real HTTP response (http.ts passes `response.status` into
 * `ApiError.fromEnvelope` on every non-OK response it parses) — every
 * CLI-fabricated envelope (`localValidationError`, `ApiError.authRequired()`,
 * `TransportError`, and every `throw ApiError.fromEnvelope({... requestId:
 * 'local' ...})` timeout conversion in commands/test.ts) never passes an
 * `httpStatus`, so it reads `undefined`. `requestId` was considered and
 * REJECTED as the discriminator: http.ts stamps a real, non-'local'
 * `x-request-id` (`newRequestId()`) on every OUTGOING request before it knows
 * whether a response will ever arrive, so `TransportError` (a DNS/TLS
 * failure that never got a response) carries a real requestId despite being
 * 100% client-side — `requestId === 'local'` would have misclassified it as
 * 'server'. All non-`ApiError` branches (`RequestTimeoutError`,
 * `InterruptError`, a plain `CLIError`, `CommanderError`, and a genuinely
 * uncaught exception) never involve an HTTP response at all, so they are
 * unconditionally 'client'.
 */
export function classifyCliError(err: unknown): {
  outcome: TelemetryOutcome;
  exitCode: number;
  errorCode?: string;
  errorOrigin?: 'client' | 'server';
  timeoutSeconds?: number;
} {
  if (err instanceof InterruptError) {
    // err.code is 'INTERRUPTED' (set in its constructor) — read it rather
    // than re-hardcoding the literal, so there is exactly one place that
    // knows InterruptError's telemetry code.
    return {
      outcome: 'abort',
      exitCode: err.exitCode,
      errorCode: err.code,
      errorOrigin: 'client',
    };
  }
  if (err instanceof RequestTimeoutError) {
    // err.code is 'REQUEST_TIMEOUT' (set in its constructor) — same reasoning.
    return {
      outcome: 'error',
      exitCode: err.exitCode,
      errorCode: err.code,
      errorOrigin: 'client',
      timeoutSeconds: Math.round(err.timeoutMs / 1000),
    };
  }
  if (err instanceof ApiError) {
    const errorOrigin: 'client' | 'server' = err.httpStatus !== undefined ? 'server' : 'client';
    const timeoutSeconds = err.getDetail<number>(
      'timeoutSeconds',
      (v): v is number => typeof v === 'number',
    );
    return {
      outcome: 'error',
      exitCode: err.exitCode,
      errorCode: err.code,
      errorOrigin,
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    };
  }
  if (err instanceof CommanderError) {
    // Help / version are user-requested successes (exit 0); everything else
    // Commander throws is a parse/validation error (exit 5).
    if (
      err.code === 'commander.helpDisplayed' ||
      err.code === 'commander.help' ||
      err.code === 'commander.version'
    ) {
      return { outcome: 'success', exitCode: 0 };
    }
    return {
      outcome: 'error',
      exitCode: 5,
      errorCode: 'VALIDATION_ERROR',
      errorOrigin: 'client',
    };
  }
  if (err instanceof CLIError) {
    return { outcome: 'error', exitCode: err.exitCode, errorCode: err.code, errorOrigin: 'client' };
  }
  return {
    outcome: 'error',
    exitCode: 1,
    errorCode: extractNodeErrorCode(err) ?? 'UNCAUGHT_EXCEPTION',
    errorOrigin: 'client',
  };
}

/** True when the operator has opted out via either supported env var. */
export function isTelemetryOptedOut(env: NodeJS.ProcessEnv): boolean {
  return isTruthyEnv(env.TESTSPRITE_NO_TELEMETRY) || isTruthyEnv(env.DO_NOT_TRACK);
}

function isTruthyEnv(v: string | undefined): boolean {
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t !== '' && t !== '0' && t !== 'false';
}

/**
 * Assemble the allowlisted wire event. No URL / message / flag value ever.
 * `extras` are the per-command facts the sink collected (re-sanitized here so a
 * direct caller cannot bypass the allowlist).
 */
export function buildTelemetryEvent(
  input: TelemetryOutcomeInput,
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
  extras: TelemetryExtrasInput = {},
): TelemetryEvent {
  const client = resolveClientTag(env);
  return {
    command: input.command,
    outcome: input.outcome,
    exitCode: input.exitCode,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.errorOrigin ? { errorOrigin: input.errorOrigin } : {}),
    ...(typeof input.timeoutSeconds === 'number' ? { timeoutSeconds: input.timeoutSeconds } : {}),
    durationMs: input.durationMs,
    cliVersion: VERSION,
    os: process.platform,
    nodeVersion: process.versions.node,
    ...(input.output === 'json' || input.output === 'text' ? { output: input.output } : {}),
    ci: isTruthyEnv(env.CI) || !isTTY,
    ...(client !== undefined ? { client } : {}),
    ...buildCiContext(env),
    ...(input.local ? { local: true } : {}),
    ...(input.outcome === 'error' && input.reason === 'wait_timeout'
      ? {
          reason: 'wait_timeout',
          ...(input.local &&
          (input.cancelOutcome === 'cancelled' ||
            input.cancelOutcome === 'already_terminal' ||
            input.cancelOutcome === 'failed' ||
            input.cancelOutcome === 'skipped')
            ? { cancelOutcome: input.cancelOutcome }
            : {}),
        }
      : {}),
    ...sanitizeTelemetryExtras(extras),
  };
}

/**
 * Resolve just the (apiKey, apiUrl) pair telemetry needs. Called once from the
 * `index.ts` preAction hook — BEFORE the command's own action runs — so a
 * command that mutates the credentials file (`auth remove` deletes the profile)
 * is still reported on the key it ran under. The hook only calls this for a
 * telemetry-eligible, non-opted-out, non-dry-run invocation, so a gated-out or
 * opted-out call never reads the credentials file.
 */
export function resolveTelemetryAuth(
  opts: { profile?: string; endpointUrl?: string },
  deps: { env?: NodeJS.ProcessEnv; credentialsPath?: string } = {},
): ResolvedTelemetryAuth {
  const config = loadConfig({
    profile: opts.profile ?? 'default',
    endpointUrl: opts.endpointUrl,
    env: deps.env ?? process.env,
    credentialsPath: deps.credentialsPath ?? defaultCredentialsPath(),
  });
  return { apiKey: config.apiKey, apiUrl: config.apiUrl };
}

/**
 * Fire one command-outcome event to the beacon. Awaited by `index.ts` before
 * `process.exit` (the flush) — bounded and fully best-effort, so it can neither
 * hang nor throw. Skips silently when opted out, under dry-run, with no leaf
 * command, or when no api-key is configured.
 */
export async function recordOutcome(
  input: TelemetryOutcomeInput,
  deps: TelemetryDeps = {},
): Promise<void> {
  // Drain the sink unconditionally — one event per process, and a gated-out
  // flush must not leave a previous command's facts behind for the next test.
  const extras = takeTelemetryExtras();
  try {
    const env = deps.env ?? process.env;
    if (isTelemetryOptedOut(env)) return;
    if (input.dryRun) return;
    if (!input.command) return; // no leaf command ran (bare --help / parse error)
    // Never on the abort path: Ctrl-C / SIGTERM must exit immediately. Awaiting
    // a beacon post here would delay shutdown by up to the bounded timeout, and
    // a fire-and-forget post would be cut off by process.exit before delivery —
    // so the event would be unreliable anyway. Aborts are simply not reported.
    if (input.outcome === 'abort') return;

    // Prefer auth the preAction hook already resolved (before a command like
    // `auth remove` could delete the profile); fall back to a fresh read.
    const config =
      deps.resolvedAuth ??
      loadConfig({
        profile: input.profile ?? 'default',
        endpointUrl: input.endpointUrl,
        env,
        credentialsPath: deps.credentialsPath ?? defaultCredentialsPath(),
      });
    if (!config.apiKey) return; // authenticated-only

    const url = `${facadeBaseUrl(config.apiUrl)}/telemetry`;
    const isTTY = deps.isTTY ?? process.stderr.isTTY === true;
    const body = buildTelemetryEvent(input, env, isTTY, extras);
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
    // Don't keep the event loop alive just for the timer.
    if (typeof timer.unref === 'function') timer.unref();
    try {
      await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'user-agent': buildUserAgent(env),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Best-effort: telemetry must never affect the command.
  }
}
