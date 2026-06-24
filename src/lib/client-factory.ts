/**
 * Shared `HttpClient` factory used by every M2 command. Two reasons for
 * the extraction:
 *
 *  1. Three command files (`auth`, `project`, `test`) had byte-equivalent
 *    `makeClient` helpers — drift between them would silently change
 *    behavior depending on which command you called.
 *  2. P6's `--dry-run` branch needs to bypass `loadConfig` (so it works
 *    with no `~/.testsprite/credentials`) and substitute a canned-fetch
 *    impl. Doing that once here is safer than three near-copies.
 *
 * The factory is intentionally narrow: it only takes the HTTP-relevant
 * deps. Per-command deps (auth's `prompt`, test's `rawStdout`) stay
 * with the command.
 */
import { loadConfig } from './config.js';
import { defaultCredentialsPath } from './credentials.js';
import { ApiError, localValidationError } from './errors.js';
import { facadeBaseUrl } from './facade.js';
import type { DebugEvent, FetchImpl } from './http.js';
import {
  HttpClient,
  REQUEST_TIMEOUT_DEFAULT_MS,
  REQUEST_TIMEOUT_MAX_MS,
  REQUEST_TIMEOUT_MIN_MS,
} from './http.js';
import type { OutputMode } from './output.js';
import { createDryRunFetch } from './dry-run/fetch.js';

export interface CommonOptions {
  profile: string;
  output: OutputMode;
  endpointUrl?: string;
  debug: boolean;
  /**
   * When true: emit human-readable transition messages (HTTP retry, rate-limit,
   * polling-mode switch) to stderr without the full debug JSON firehose.
   * Sits between the default (silent retries) and `--debug` (full trace).
   */
  verbose?: boolean;
  /**
   * When true: skip credential read, skip the network, return canned
   * samples per `src/lib/dry-run/samples.ts`. The CLI binary still
   * runs all argument validation, output formatting, and exit-code
   * mapping, so dry-run output is byte-identical to a real success
   * response (modulo the data values being canned).
   *
   * Optional so legacy call sites (P1–P5 tests) don't need to pass
   * `false` everywhere — undefined is treated as `false`.
   */
  dryRun?: boolean;
  /**
   * Per-request wall-clock timeout in milliseconds. Applied to every
   * outgoing fetch call. Defaults to {@link REQUEST_TIMEOUT_DEFAULT_MS}
   * (120 000 ms). Set via `--request-timeout <s>` flag (seconds) or
   * `TESTSPRITE_REQUEST_TIMEOUT_MS` env var (milliseconds).
   *
   * Precedence: `--request-timeout` flag > `TESTSPRITE_REQUEST_TIMEOUT_MS`
   * env var > default (120s).
   *
   * Clamped to [{@link REQUEST_TIMEOUT_MIN_MS}, {@link REQUEST_TIMEOUT_MAX_MS}].
   */
  requestTimeoutMs?: number;
}

export interface ClientFactoryDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stderr?: (line: string) => void;
}

/**
 * The fake API key used in dry-run. Never sent — the dry-run fetch
 * impl ignores headers and returns a canned sample. Documented in the
 * runbook so secret-scanners don't flag it as a leak.
 */
export const DRY_RUN_API_KEY = 'sk-user-DRY-RUN';

const DRY_RUN_DEFAULT_ENDPOINT = 'https://api.testsprite.com';

/** Stable banner text. Snapshot tests assert on this string. */
export const DRY_RUN_BANNER = '[dry-run] sample response — not from the server';

/**
 * Emit the dry-run banner to stderr. Idempotent per process — the
 * banner prints only on the first call so scripts that run several
 * commands sequentially under one shell don't drown in repeats. The
 * gate is reset by {@link resetDryRunBannerForTesting} for unit tests.
 */
let bannerEmitted = false;

export function emitDryRunBanner(stderr: (line: string) => void): void {
  if (bannerEmitted) return;
  bannerEmitted = true;
  stderr(DRY_RUN_BANNER);
}

export function resetDryRunBannerForTesting(): void {
  bannerEmitted = false;
}

/**
 * Resolve per-request timeout in milliseconds.
 *
 * Precedence: `--request-timeout` flag (already converted to ms by the caller)
 * > `TESTSPRITE_REQUEST_TIMEOUT_MS` env var > default (120s).
 *
 * The flag is supplied in seconds (consistent with `--timeout`); the caller
 * multiplies by 1000 before storing in `opts.requestTimeoutMs`. The env var
 * is in milliseconds to give scripts sub-second granularity and match the
 * typical convention for `*_MS` env vars.
 *
 * Values are clamped to [REQUEST_TIMEOUT_MIN_MS, REQUEST_TIMEOUT_MAX_MS];
 * values below the minimum are raised to 1s, values above the maximum are
 * lowered to 10m — both silently (no exit 5), since this is a tuning knob,
 * not a safety-critical gate.
 */
export function resolveRequestTimeoutMs(
  opts: Pick<CommonOptions, 'requestTimeoutMs'>,
  env: NodeJS.ProcessEnv,
): number {
  // Flag (already in ms) takes precedence.
  if (opts.requestTimeoutMs !== undefined) {
    return clampRequestTimeout(opts.requestTimeoutMs);
  }
  // Env var (milliseconds).
  const envRaw = env.TESTSPRITE_REQUEST_TIMEOUT_MS;
  if (envRaw !== undefined) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return clampRequestTimeout(parsed);
    }
  }
  return REQUEST_TIMEOUT_DEFAULT_MS;
}

function clampRequestTimeout(ms: number): number {
  return Math.min(Math.max(Math.round(ms), REQUEST_TIMEOUT_MIN_MS), REQUEST_TIMEOUT_MAX_MS);
}

/**
 * Validate that the resolved API endpoint is a syntactically valid http(s)
 * URL before it is used to build requests.
 *
 * Unlike the `--target-url` guard in `target-url.ts`, this deliberately does
 * NOT reject localhost or private addresses: the API endpoint legitimately
 * points at a self-hosted, local-dev, or mock backend on a private host. It
 * only catches a malformed value (unparseable, or a non-http(s) scheme) so the
 * operator gets a fast, actionable VALIDATION_ERROR (exit 5) instead of an
 * opaque `Invalid URL` (exit 1, a raw `new URL()` throw) or a misleading
 * `fetch failed / Service temporarily unavailable` emitted only after a full
 * retry-and-backoff cycle.
 *
 * The value can originate from `--endpoint-url`, `TESTSPRITE_API_URL`, or the
 * credentials file `api_url`, so the message names all three rather than
 * assuming the flag.
 */
export function assertValidEndpointUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw localValidationError(
      'endpoint-url',
      `"${rawUrl}" is not a valid URL — provide an http(s) URL (e.g. https://api.testsprite.com) ` +
        `via --endpoint-url, TESTSPRITE_API_URL, or the credentials file`,
      undefined,
      'field',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw localValidationError(
      'endpoint-url',
      `scheme "${parsed.protocol.replace(/:$/, '')}" is not supported — use http or https ` +
        `(e.g. https://api.testsprite.com)`,
      undefined,
      'field',
    );
  }
}

/**
 * Parse the `--request-timeout <seconds>` flag value into milliseconds.
 *
 * Returns `undefined` when the flag was omitted (the factory then falls back to
 * the `TESTSPRITE_REQUEST_TIMEOUT_MS` env var, else the 120s default).
 *
 * A supplied-but-invalid value (non-numeric, zero, or negative) throws a typed
 * VALIDATION_ERROR (exit 5) rather than being silently dropped. An explicit
 * `--request-timeout 30s` typo previously resolved to `undefined` and the
 * command ran with the default 120s deadline — the operator believed they had
 * set a timeout but had not, with no signal. Failing loudly here is consistent
 * with every other validated flag (`--page-size`, `--output`, `--type`).
 *
 * Out-of-range but positive values are intentionally NOT rejected — they flow
 * through to {@link resolveRequestTimeoutMs}, which clamps to
 * `[REQUEST_TIMEOUT_MIN_MS, REQUEST_TIMEOUT_MAX_MS]`. The env-var path stays
 * lenient by design (a stray global env var should not hard-fail every
 * command); only the explicit per-invocation flag is strict.
 *
 * This single definition replaces five byte-identical copies that previously
 * lived in `auth`, `project`, `usage`, `init`, and `test` — drift between them
 * would have silently changed timeout behaviour depending on the command.
 */
export function parseRequestTimeoutFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    // Surface the offending value in the message (same as assertValidEndpointUrl)
    // so the operator sees exactly what they typed.
    throw localValidationError(
      'request-timeout',
      `"${raw}" is not valid — must be a positive number of seconds`,
    );
  }
  return Math.round(n * 1000); // seconds → milliseconds
}

export function makeHttpClient(opts: CommonOptions, deps: ClientFactoryDeps = {}): HttpClient {
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const env = deps.env ?? process.env;
  const requestTimeoutMs = resolveRequestTimeoutMs(opts, env);

  if (opts.dryRun) {
    const dryRunEndpoint = opts.endpointUrl ?? DRY_RUN_DEFAULT_ENDPOINT;
    // Validate even under --dry-run so a typo in --endpoint-url is caught
    // offline (no creds, no network). Validate BEFORE the banner so a rejected
    // endpoint doesn't first announce a "sample response".
    assertValidEndpointUrl(dryRunEndpoint);
    emitDryRunBanner(stderr);
    return new HttpClient({
      baseUrl: facadeBaseUrl(dryRunEndpoint),
      apiKey: DRY_RUN_API_KEY,
      fetchImpl: deps.fetchImpl ?? createDryRunFetch(),
      onDebug: opts.debug ? (event: DebugEvent) => stderr(formatDryRunDebug(event)) : undefined,
      onTransition: opts.verbose ? (msg: string) => stderr(`[verbose] ${msg}`) : undefined,
      requestTimeoutMs,
    });
  }

  const credentialsPath = deps.credentialsPath ?? defaultCredentialsPath();
  const config = loadConfig({
    profile: opts.profile,
    endpointUrl: opts.endpointUrl,
    env,
    credentialsPath,
  });
  // Catch a malformed endpoint (from --endpoint-url / TESTSPRITE_API_URL /
  // credentials) before the auth check so a config typo surfaces as a clear
  // VALIDATION_ERROR rather than an opaque URL throw or a retried "fetch failed".
  assertValidEndpointUrl(config.apiUrl);
  if (!config.apiKey) throw ApiError.authRequired();
  return new HttpClient({
    baseUrl: facadeBaseUrl(config.apiUrl),
    apiKey: config.apiKey,
    fetchImpl: deps.fetchImpl,
    onDebug: opts.debug ? (event: DebugEvent) => stderr(formatDebug(event)) : undefined,
    onTransition: opts.verbose ? (msg: string) => stderr(`[verbose] ${msg}`) : undefined,
    requestTimeoutMs,
  });
}

function formatDebug(event: DebugEvent): string {
  return `[debug ${new Date().toISOString()}] ${JSON.stringify(event)}`;
}

function formatDryRunDebug(event: DebugEvent): string {
  return `[debug ${new Date().toISOString()}] ${JSON.stringify({ ...event, mode: 'dry-run' })}`;
}
