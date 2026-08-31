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
 * It NEVER carries target URLs, api keys, flag values, arg values, or error
 * messages — `errorCode` is a stable machine code, never the human message.
 */
import { CommanderError } from 'commander';
import { loadConfig } from './config.js';
import { defaultCredentialsPath } from './credentials.js';
import { ApiError, CLIError, InterruptError, RequestTimeoutError } from './errors.js';
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

export interface TelemetryOutcomeInput {
  /** Leaf command path that ran, e.g. `test run`. Empty → skip (no command). */
  command: string;
  outcome: TelemetryOutcome;
  exitCode: number;
  /** Stable machine error code (e.g. `VALIDATION_ERROR`) — never a message. */
  errorCode?: string;
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

/** The exact wire body — a flat allowlist mirroring the backend DTO. */
export interface TelemetryEvent {
  command: string;
  outcome: TelemetryOutcome;
  exitCode?: number;
  errorCode?: string;
  durationMs?: number;
  cliVersion?: string;
  os?: string;
  nodeVersion?: string;
  output?: string;
  ci?: boolean;
  /** Present (always `true`) only for a `test run --local` invocation; absent otherwise. */
  local?: boolean;
}

/**
 * Map a thrown CLI error to its telemetry disposition — mirrors the exit-code
 * mapping in `index.ts`'s top-level catch so telemetry and the process exit
 * code never disagree. Pure; safe to unit-test.
 */
export function classifyCliError(err: unknown): {
  outcome: TelemetryOutcome;
  exitCode: number;
  errorCode?: string;
} {
  if (err instanceof InterruptError) {
    return { outcome: 'abort', exitCode: err.exitCode, errorCode: 'INTERRUPTED' };
  }
  if (err instanceof RequestTimeoutError) {
    return { outcome: 'error', exitCode: err.exitCode, errorCode: 'REQUEST_TIMEOUT' };
  }
  if (err instanceof ApiError) {
    return { outcome: 'error', exitCode: err.exitCode, errorCode: err.code };
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
    return { outcome: 'error', exitCode: 5, errorCode: 'VALIDATION_ERROR' };
  }
  if (err instanceof CLIError) {
    return { outcome: 'error', exitCode: err.exitCode };
  }
  return { outcome: 'error', exitCode: 1 };
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

/** Assemble the allowlisted wire event. No URL / message / flag value ever. */
export function buildTelemetryEvent(
  input: TelemetryOutcomeInput,
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
): TelemetryEvent {
  return {
    command: input.command,
    outcome: input.outcome,
    exitCode: input.exitCode,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    durationMs: input.durationMs,
    cliVersion: VERSION,
    os: process.platform,
    nodeVersion: process.versions.node,
    ...(input.output === 'json' || input.output === 'text' ? { output: input.output } : {}),
    ci: isTruthyEnv(env.CI) || !isTTY,
    ...(input.local ? { local: true } : {}),
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
    const body = buildTelemetryEvent(input, env, isTTY);
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
          'user-agent': `testsprite-cli/${VERSION}`,
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
