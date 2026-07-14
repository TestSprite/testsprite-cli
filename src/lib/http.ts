import { randomUUID } from 'node:crypto';
import type { ErrorCode } from './errors.js';
import { ApiError, RequestTimeoutError, TransportError } from './errors.js';
import { VERSION } from '../version.js';
import type {
  TriggerRunBody,
  TriggerRunResponse,
  RunResponse,
  RerunRequest,
  RerunResponse,
  BatchRerunRequest,
  BatchRerunResponse,
  BatchRunFreshRequest,
  BatchRunFreshResponse,
  ListRunsQuery,
  ListRunsResponse,
} from './runs.types.js';

export type FetchImpl = typeof globalThis.fetch;

export type DebugEventKind = 'request' | 'response' | 'retry' | 'error';

export interface DebugEvent {
  kind: DebugEventKind;
  method: string;
  url: string;
  attempt: number;
  status?: number;
  errorCode?: ErrorCode | 'TRANSPORT';
  durationMs?: number;
  requestId: string;
  delayMs?: number;
}

/**
 * Default per-request timeout (120s). Comfortably covers every metadata/read
 * request and every <=25s long-poll request (`?waitSeconds` is capped at 25
 * by the polling layer), while still failing fast on a dead backend.
 *
 * The 15-minute test-execution ceiling is enforced separately by the `--timeout`
 * / polling path (`poll.ts`) which supplies its own `AbortSignal` per iteration.
 * That path is unaffected — each 25s long-poll request still falls well within
 * this 120s per-request guard.
 *
 * Override via `--request-timeout <s>` (flag, in seconds) or
 * `TESTSPRITE_REQUEST_TIMEOUT_MS` (env var, in milliseconds).
 * Precedence: flag > env > default.
 */
export const REQUEST_TIMEOUT_DEFAULT_MS = 120_000;

/**
 * Minimum accepted value: 1 second. Below this the timeout fires before a
 * TLS handshake can complete on a healthy connection.
 */
export const REQUEST_TIMEOUT_MIN_MS = 1_000;

/**
 * Maximum accepted value: 10 minutes. Values above this cap are clamped
 * rather than rejected, so scripts that forward large numbers still work.
 */
export const REQUEST_TIMEOUT_MAX_MS = 600_000;

export interface HttpClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: FetchImpl;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onDebug?: (event: DebugEvent) => void;
  /**
   * Optional callback for user-relevant state transitions (verbose tier).
   * Emits human-readable messages for HTTP retries, rate-limit backoff,
   * and polling-mode switches without dumping the full debug JSON.
   * Stays silent when absent; wired to stderr at `--verbose` level.
   */
  onTransition?: (msg: string) => void;
  /**
   * Per-request wall-clock timeout in milliseconds applied to every outgoing
   * fetch. The signal fires independently of any caller-supplied signal — the
   * request aborts on whichever fires first.
   *
   * Defaults to {@link REQUEST_TIMEOUT_DEFAULT_MS} (120 000 ms). Override
   * via `--request-timeout <s>` flag or `TESTSPRITE_REQUEST_TIMEOUT_MS` env var.
   *
   * This timeout is intentionally NOT applied to the polling path's own
   * long-poll `AbortSignal` (which is deadline-aware); each 25s long-poll
   * request is well within the 120s default.
   */
  requestTimeoutMs?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  requestId?: string;
  /**
   * Optional JSON body for non-GET requests. Serialized with
   * `JSON.stringify`; `Content-Type: application/json` is auto-attached
   * when present.
   */
  body?: unknown;
  /**
   * Per-request header overrides merged on top of the defaults
   * (`x-api-key`, `x-request-id`, `accept`, `user-agent`). Used for
   * mutation routes that need `Idempotency-Key` / `If-Match`.
   */
  headers?: Record<string, string>;
  /**
   * Whether to retry on 409 CONFLICT.
   *
   * The shared retry policy retries CONFLICT once by default (read paths
   * where 409 = mid-mutation snapshot). Set to `false` for write paths
   * where 409 is a persistent condition (e.g. POST /tests/{testId}/runs
   * when another run is already in flight) — retrying there would enqueue
   * a second run once the first finishes.
   *
   * Defaults to `true` to preserve the original M2 read-path behavior.
   */
  retryOnConflict?: boolean;
  /**
   * Whether the HTTP layer should retry internally on 429 RATE_LIMITED.
   *
   * Set to `false` for the batch-run trigger path where the outer
   * `runBatchRun` loop is the single owner of rate-limit handling —
   * keeping the HTTP layer from adding up to 3 extra retries per outer
   * attempt, which would multiply trigger POSTs per spec (e.g. 50×3 = 150/min)
   * instead of staying within the client throttle's 50/min.
   *
   * Defaults to `true` to preserve backward-compatible behavior for all
   * other callers.
   */
  retryOnRateLimit?: boolean;
}

const RETRY_BASE_MS = 250;
const RETRY_JITTER_MS = 250;
const RETRY_MAX_DELAY_MS = 4000;

const MAX_ATTEMPTS_TRANSPORT = 4;
const MAX_ATTEMPTS_UNAVAILABLE = 4;
const MAX_ATTEMPTS_RATE_LIMITED = 3;
const MAX_ATTEMPTS_CONFLICT = 2;
const MAX_ATTEMPTS_INTERNAL = 2;

// Cap server-directed RATE_LIMITED waits so a hostile or misconfigured
// `Retry-After` (e.g. 86400) can't hang the CLI inside the retry sleep.
const MAX_RATE_LIMITED_DELAY_MS = 60_000;

const CONFLICT_DELAY_MS = 1000;
const INTERNAL_DELAY_MS = 500;

/**
 * Result of a successful HTTP request, including the parsed body and the
 * `x-request-id` that was sent (useful for surfacing in happy-path output).
 */
export interface RequestResult<T> {
  body: T;
  requestId: string;
  status: number;
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly onDebug?: (event: DebugEvent) => void;
  private readonly onTransition?: (msg: string) => void;
  private readonly requestTimeoutMs: number;

  constructor(options: HttpClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.onDebug = options.onDebug;
    this.onTransition = options.onTransition;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_DEFAULT_MS;
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.requestWithMeta<T>('GET', path, options).then(r => r.body);
  }

  async post<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.requestWithMeta<T>('POST', path, options).then(r => r.body);
  }

  async put<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.requestWithMeta<T>('PUT', path, options).then(r => r.body);
  }

  async patch<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.requestWithMeta<T>('PATCH', path, options).then(r => r.body);
  }

  async delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.requestWithMeta<T>('DELETE', path, options).then(r => r.body);
  }

  /**
   * Like `get` / `post` / etc. but returns the full `RequestResult` including
   * `requestId` and `status`, so callers can surface the requestId in
   * happy-path output (dogfood item 1).
   */
  async getWithMeta<T>(path: string, options: RequestOptions = {}): Promise<RequestResult<T>> {
    return this.requestWithMeta<T>('GET', path, options);
  }

  async postWithMeta<T>(path: string, options: RequestOptions = {}): Promise<RequestResult<T>> {
    return this.requestWithMeta<T>('POST', path, options);
  }

  async putWithMeta<T>(path: string, options: RequestOptions = {}): Promise<RequestResult<T>> {
    return this.requestWithMeta<T>('PUT', path, options);
  }

  async patchWithMeta<T>(path: string, options: RequestOptions = {}): Promise<RequestResult<T>> {
    return this.requestWithMeta<T>('PATCH', path, options);
  }

  async deleteWithMeta<T>(path: string, options: RequestOptions = {}): Promise<RequestResult<T>> {
    return this.requestWithMeta<T>('DELETE', path, options);
  }

  /**
   * POST /api/cli/v1/tests/{testId}/runs
   * Trigger a run and return the queued-run envelope.
   * The caller must supply an `idempotencyKey` which is sent as the
   * `Idempotency-Key` header per M3.2 piece-1 §2 contract.
   */
  async triggerRun(
    testId: string,
    body: TriggerRunBody,
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<TriggerRunResponse> {
    return this.postWithMeta<TriggerRunResponse>(`/tests/${encodeURIComponent(testId)}/runs`, {
      body,
      headers: { 'idempotency-key': options.idempotencyKey },
      signal: options.signal,
      // 409 on POST /runs means "another run is already in flight" — a
      // persistent condition, not a transient snapshot conflict. Retrying
      // would enqueue a second run once the first finishes.
      retryOnConflict: false,
    }).then(r => r.body);
  }

  /**
   * Like `triggerRun` but returns the full `RequestResult` so the caller
   * can surface the `requestId` in happy-path CLI output.
   *
   * `retryOnRateLimit` defaults to `true` so single `test run` and
   * `test create --run` retain the standard HTTP-layer 429 retry budget.
   *
   * Pass `retryOnRateLimit: false` ONLY at the batch fan-out call site
   * (`runBatchRun` / `triggerOne`) where the outer loop is the single owner
   * of rate-limit handling — preventing the HTTP layer from adding up to 3
   * extra retries per outer attempt, which would multiply POSTs per spec (e.g. 50×3 = 150/min).
   */
  async triggerRunWithMeta(
    testId: string,
    body: TriggerRunBody,
    options: { idempotencyKey: string; signal?: AbortSignal; retryOnRateLimit?: boolean },
  ): Promise<RequestResult<TriggerRunResponse>> {
    return this.postWithMeta<TriggerRunResponse>(`/tests/${encodeURIComponent(testId)}/runs`, {
      body,
      headers: { 'idempotency-key': options.idempotencyKey },
      signal: options.signal,
      retryOnConflict: false,
      // Default true: single `test run` / `test create --run` retain 429 retry.
      // Batch call site passes false to keep outer-loop as sole rate-limit owner.
      retryOnRateLimit: options.retryOnRateLimit ?? true,
    });
  }

  /**
   * POST /api/cli/v1/tests/{testId}/runs/rerun
   * Trigger a rerun (replay) for a single test. FE: verbatim script replay (no credits).
   * BE: dependency-closure re-run. Returns `runId` + optional `closure` (BE).
   *
   * `retryOnConflict: false` — 409 on rerun means the test is already in-flight,
   * a persistent condition. Retrying would race against the running test.
   */
  async triggerRerun(
    testId: string,
    body: RerunRequest,
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<RerunResponse> {
    return this.postWithMeta<RerunResponse>(`/tests/${encodeURIComponent(testId)}/runs/rerun`, {
      body,
      headers: { 'idempotency-key': options.idempotencyKey },
      signal: options.signal,
      retryOnConflict: false,
    }).then(r => r.body);
  }

  /**
   * POST /api/cli/v1/tests/batch/rerun
   * Trigger a batch rerun across multiple tests (mixed FE/BE allowed).
   * BE closure is deduped server-side per project.
   *
   * `retryOnConflict: false` — 409 on batch rerun is persistent ("in flight").
   */
  async triggerBatchRerun(
    body: BatchRerunRequest,
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<BatchRerunResponse> {
    return this.postWithMeta<BatchRerunResponse>('/tests/batch/rerun', {
      body,
      headers: { 'idempotency-key': options.idempotencyKey },
      signal: options.signal,
      retryOnConflict: false,
    }).then(r => r.body);
  }

  /**
   * POST /api/cli/v1/tests/batch/run
   * Trigger a fresh wave-ordered batch run across all (or a subset of) BE tests
   * in a project. FE tests in the set are skipped server-side (advisory).
   * `testIds` absent / empty → run ALL BE tests in the project.
   *
   * `retryOnConflict: false` — 409 on batch run means a run is already in flight.
   */
  async triggerBatchRunFresh(
    body: BatchRunFreshRequest,
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<BatchRunFreshResponse> {
    return this.postWithMeta<BatchRunFreshResponse>('/tests/batch/run', {
      body,
      headers: { 'idempotency-key': options.idempotencyKey },
      signal: options.signal,
      retryOnConflict: false,
    }).then(r => r.body);
  }

  /**
   * GET /api/cli/v1/tests/{testId}/runs
   * List a test's prior run history, newest-first.
   *
   * Limit-before-filter caveat: a `source`-filtered page may return fewer
   * than `pageSize` rows while still yielding a non-null `nextCursor`.
   * That means "none in THIS window", not end-of-history.
   */
  async listTestRuns(testId: string, query: ListRunsQuery): Promise<ListRunsResponse> {
    const q: Record<string, string | number | undefined> = {};
    if (query.cursor !== undefined) q.cursor = query.cursor;
    if (query.pageSize !== undefined) q.pageSize = query.pageSize;
    if (query.source !== undefined) q.source = query.source;
    if (query.since !== undefined) q.since = query.since;
    return this.get<ListRunsResponse>(`/tests/${encodeURIComponent(testId)}/runs`, { query: q });
  }

  /**
   * GET /api/cli/v1/runs/{runId}
   * Fetch the current state of a run. When `waitSeconds` is provided
   * (1–25) the server performs a bounded long-poll and returns when the
   * run is terminal or when `waitSeconds` elapses, whichever comes
   * first. On `400 VALIDATION_ERROR` (server doesn't support
   * `waitSeconds`) the caller should retry without the param and switch
   * to client-side backoff — see `src/lib/poll.ts`.
   *
   * When `includeSteps` is `true`, the server appends the full ordered
   * `steps[]` array (M3.4 piece-4). Default (absent/false) is byte-
   * identical to the M3.3 summary shape — the polling path is unaffected.
   */
  async getRun(
    runId: string,
    options?: { waitSeconds?: number; includeSteps?: boolean; signal?: AbortSignal },
  ): Promise<RunResponse> {
    const query: Record<string, number | boolean | undefined> = {};
    if (options?.waitSeconds !== undefined) {
      query.waitSeconds = options.waitSeconds;
    }
    if (options?.includeSteps === true) {
      query.includeSteps = true;
    }
    return this.get<RunResponse>(`/runs/${encodeURIComponent(runId)}`, {
      query: Object.keys(query).length > 0 ? query : undefined,
      signal: options?.signal,
    });
  }

  /**
   * Classify an error thrown while issuing OR reading a request. When it is an
   * abort/timeout and our per-request timeout signal fired (and the caller had
   * not already aborted), surface a clear RequestTimeoutError; when it is a
   * caller-supplied abort (SIGINT, poll-iteration deadline), rethrow it
   * unmodified. Returns normally when `err` is not an abort, so the caller can
   * continue its own error handling (transport retry / envelope parse).
   */
  private rethrowIfAbort(
    err: unknown,
    timeoutSignal: AbortSignal,
    callerSignal: AbortSignal | undefined,
    requestId: string,
    effectiveSignal: AbortSignal = timeoutSignal,
  ): void {
    if (isAbortError(err) || isTimeoutError(err)) {
      const timeoutWon =
        timeoutSignal.aborted &&
        (callerSignal == null ||
          !callerSignal.aborted ||
          effectiveSignal.reason === timeoutSignal.reason);
      if (timeoutWon) {
        throw new RequestTimeoutError(this.requestTimeoutMs, requestId);
      }
      throw err;
    }
  }

  async requestWithMeta<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<RequestResult<T>> {
    if (!this.apiKey) throw ApiError.authRequired();

    const url = buildUrl(this.baseUrl, path, options.query);
    const requestId = options.requestId ?? newRequestId();

    let attempt = 0;
    while (true) {
      attempt += 1;
      this.debug({ kind: 'request', method, url, attempt, requestId });
      const startedAt = Date.now();
      let response: Response;

      // Compose the per-request timeout signal with any caller-supplied signal.
      // The fetch aborts on whichever fires first. This ensures every one-shot
      // request (test create/update/delete/list/get, auth whoami, code put/get,
      // plan put) has a client-side deadline even when the caller supplies no
      // signal. The polling path supplies its own deadline-aware signal per
      // iteration — this timeout (120s default) is safely larger than any single
      // long-poll window (<=25s via ?waitSeconds), so it never bites polling.
      const requestTimeout = createRequestTimeout(this.requestTimeoutMs);
      const timeoutSignal = requestTimeout.signal;
      const effectiveSignal =
        options.signal != null ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;

      try {
        try {
          response = await this.fetchImpl(url, {
            method,
            headers: this.buildHeaders(requestId, options),
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
            signal: effectiveSignal,
          });
        } catch (err) {
          // Distinguish a client-side request timeout from a caller-supplied abort.
          //
          // The request-timeout controller aborts with an Error/DOMException whose
          // `name === 'TimeoutError'` (not 'AbortError') when the signal fires.
          // A caller-supplied abort sets `name === 'AbortError'`.
          // We treat both abort variants together: if the timeout signal fired and
          // the caller hadn't already aborted, surface a clear RequestTimeoutError.
          // A timeout/abort during the fetch itself: classify it (RequestTimeoutError
          // when our deadline fired; otherwise rethrow the caller's abort unmodified).
          this.rethrowIfAbort(err, timeoutSignal, options.signal, requestId, effectiveSignal);
          // If a RequestTimeoutError already propagated from somewhere (e.g. from a
          // nested call or from a test-injected fetchImpl), pass it through unchanged
          // rather than re-wrapping it as a TransportError.
          if (err instanceof RequestTimeoutError) throw err;
          const message = err instanceof Error ? err.message : String(err);
          this.debug({
            kind: 'error',
            method,
            url,
            attempt,
            requestId,
            errorCode: 'TRANSPORT',
            durationMs: Date.now() - startedAt,
          });
          const decision = transportRetryDecision(attempt, this.random);
          if (!decision.retry) throw new TransportError(message, requestId);
          this.transition(
            `Network error on ${shortPath(path)} — retrying in ${Math.round(decision.delayMs / 1000)}s (attempt ${attempt})`,
          );
          this.debug({
            kind: 'retry',
            method,
            url,
            attempt,
            requestId,
            errorCode: 'TRANSPORT',
            delayMs: decision.delayMs,
          });
          requestTimeout.clear();
          await this.sleep(decision.delayMs);
          continue;
        }

        const durationMs = Date.now() - startedAt;
        if (response.ok) {
          this.debug({
            kind: 'response',
            method,
            url,
            attempt,
            status: response.status,
            requestId,
            durationMs,
          });
          try {
            return { body: (await response.json()) as T, requestId, status: response.status };
          } catch (err) {
            // A timeout/abort can fire mid-body-read (headers received, stream stalls).
            this.rethrowIfAbort(err, timeoutSignal, options.signal, requestId, effectiveSignal);
            // Otherwise the successful response body was not valid JSON — a
            // misconfigured endpoint, a proxy / captive-portal / login page that
            // returns HTML with a 200 status, or an empty body. Surface a typed
            // error carrying the requestId instead of letting the raw SyntaxError
            // escape to index.ts, where it would print a bare `{"error":"..."}`
            // and break the --output json envelope contract.
            throw malformedResponseError(response, requestId, err);
          }
        }

        let rawBody: unknown;
        try {
          rawBody = await safeReadJson(response);
        } catch (err) {
          // safeReadJson rethrows aborts/timeouts (it swallows only non-abort parse
          // errors), so a timeout fired mid-body-read on a non-OK response lands here.
          this.rethrowIfAbort(err, timeoutSignal, options.signal, requestId, effectiveSignal);
          throw err;
        }

        // Edge proxies / load balancers return 408/502/504 without our error
        // envelope on transient outages. These are transport-level retries,
        // not facade errors — fold them in here so we get the bounded backoff
        // budget instead of a single INTERNAL bail.
        if (rawBody === null && isTransportEdgeStatus(response.status)) {
          this.debug({
            kind: 'error',
            method,
            url,
            attempt,
            status: response.status,
            requestId,
            errorCode: 'TRANSPORT',
            durationMs,
          });
          const decision = transportRetryDecision(attempt, this.random);
          if (!decision.retry) {
            throw new TransportError(`HTTP ${response.status} from ${url}`, requestId);
          }
          this.transition(
            `HTTP ${response.status} from ${shortPath(path)} — transport error, retrying in ${Math.round(decision.delayMs / 1000)}s (attempt ${attempt})`,
          );
          this.debug({
            kind: 'retry',
            method,
            url,
            attempt,
            requestId,
            errorCode: 'TRANSPORT',
            delayMs: decision.delayMs,
          });
          requestTimeout.clear();
          await this.sleep(decision.delayMs);
          continue;
        }

        const retryAfterSec = parseRetryAfter(response.headers.get('retry-after'));
        // Clamp server-directed Retry-After to [1s, 300s] and surface on the
        // thrown error so outer callers (e.g. runBatchRun outer retry loop)
        // can honor it without re-reading the now-consumed HTTP response.
        const retryAfterMsForError =
          retryAfterSec !== undefined
            ? Math.min(Math.max(retryAfterSec, 1), 300) * 1000
            : undefined;
        const apiError = ApiError.fromEnvelope(
          rawBody,
          response.status,
          retryAfterMsForError,
          // Lets synthesized nextAction text (e.g. INSUFFICIENT_CREDITS billing
          // links) resolve the environment-correct portal domain.
          this.baseUrl,
        );
        this.debug({
          kind: 'error',
          method,
          url,
          attempt,
          status: response.status,
          errorCode: apiError.code,
          requestId,
          durationMs,
        });
        const retryOnConflict = options.retryOnConflict !== false;
        const retryOnRateLimit = options.retryOnRateLimit !== false;
        const decision = apiRetryDecision(
          apiError.code,
          attempt,
          retryAfterSec,
          this.random,
          retryOnConflict,
          retryOnRateLimit,
        );
        if (!decision.retry) throw apiError;
        const delaySec = Math.round(decision.delayMs / 1000);
        if (apiError.code === 'RATE_LIMITED') {
          this.transition(
            `Rate limited (HTTP 429) — waiting ${delaySec}s before retry (attempt ${attempt})`,
          );
        } else if (apiError.code === 'INTERNAL') {
          this.transition(
            `Server error (HTTP 5xx, requestId: ${requestId}) — retrying in ${delaySec}s (attempt ${attempt})`,
          );
        } else if (apiError.code === 'UNAVAILABLE') {
          this.transition(
            `Service unavailable (HTTP 503) — retrying in ${delaySec}s (attempt ${attempt})`,
          );
        }
        this.debug({
          kind: 'retry',
          method,
          url,
          attempt,
          requestId,
          errorCode: apiError.code,
          delayMs: decision.delayMs,
        });
        requestTimeout.clear();
        await this.sleep(decision.delayMs);
      } finally {
        requestTimeout.clear();
      }
    }
  }

  private buildHeaders(requestId: string, options: RequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      'x-request-id': requestId,
      accept: 'application/json',
      'user-agent': `testsprite-cli/${VERSION}`,
    };
    // The CLI v1 facade authenticates via `x-api-key`.
    // (securitySchemes.ApiKeyAuth). Sending only Authorization Bearer would be
    // treated as a missing key by the backend.
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    // Mutation-route headers (Idempotency-Key, If-Match) get merged last
    // so callers cannot accidentally strip the auth or request-id keys.
    if (options.headers) {
      for (const [name, value] of Object.entries(options.headers)) {
        headers[name.toLowerCase()] = value;
      }
    }
    return headers;
  }

  private debug(event: DebugEvent): void {
    if (this.onDebug) this.onDebug(event);
  }

  private transition(msg: string): void {
    if (this.onTransition) this.onTransition(msg);
  }

  /**
   * Legacy alias kept for backward-compat with test files that call
   * `client.request(...)` directly. New callers should use
   * `requestWithMeta` or the typed helpers (`get`, `post`, etc.).
   */
  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    return this.requestWithMeta<T>(method, path, options).then(r => r.body);
  }
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Extracts the path component from a full URL for concise log messages. */
function shortPath(pathOrUrl: string): string {
  try {
    return new URL(pathOrUrl).pathname;
  } catch {
    return pathOrUrl;
  }
}

export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${trimTrailingSlash(baseUrl)}${normalizedPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function newRequestId(): string {
  return `cli_${randomUUID()}`;
}

interface RequestTimeoutHandle {
  signal: AbortSignal;
  clear: () => void;
}

function createRequestTimeout(timeoutMs: number): RequestTimeoutHandle {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(makeTimeoutReason());
  }, timeoutMs);
  unrefTimer(timer);

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function makeTimeoutReason(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('The operation timed out.', 'TimeoutError');
  }
  const err = new Error('The operation timed out.');
  err.name = 'TimeoutError';
  return err;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer !== 'object' || timer === null || !('unref' in timer)) return;
  const unref = (timer as { unref?: () => void }).unref;
  if (typeof unref === 'function') unref.call(timer);
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (err) {
    // Don't swallow client-side aborts/timeouts as a null body — the caller must
    // be able to classify a mid-body-read timeout as a RequestTimeoutError.
    if (isAbortError(err) || isTimeoutError(err)) throw err;
    return null;
  }
}

/**
 * Build a typed error for a successful response whose body could not be parsed
 * as JSON.
 *
 * The CLI expects every API response to be a JSON envelope. When a `200 OK`
 * carries a non-JSON body — a misconfigured endpoint, a proxy / captive-portal
 * / SSO login page returning HTML with a success status, or an empty body —
 * `response.json()` throws a raw `SyntaxError`. Left unhandled it escapes to
 * the top-level handler in `index.ts`, which prints a bare
 * `{"error":"<parse message>"}` under `--output json` (breaking the
 * typed-envelope contract every other error honors) and gives the operator no
 * actionable context.
 *
 * This wraps it in a typed `INTERNAL` `ApiError` (exit 1, unchanged) that
 * carries the `requestId`, names the likely cause, and points the operator at
 * their endpoint configuration. `details` includes the HTTP status, the
 * response `content-type` (when present), and the underlying parse message.
 */
export function malformedResponseError(
  response: Response,
  requestId: string,
  cause: unknown,
): ApiError {
  const contentType = response.headers.get('content-type') ?? undefined;
  const parseError = cause instanceof Error ? cause.message : String(cause);
  const contentTypeNote = contentType ? ` (content-type: ${contentType})` : '';
  return new ApiError(
    {
      code: 'INTERNAL',
      message:
        `The server returned a non-JSON response${contentTypeNote} for an HTTP ${response.status}. ` +
        `This usually means the endpoint is not the TestSprite API — a proxy, captive portal, or ` +
        `login page can return HTML with a success status.`,
      nextAction:
        'Check that --endpoint-url / TESTSPRITE_API_URL points at the TestSprite API ' +
        '(default https://api.testsprite.com), then retry.',
      requestId,
      details: {
        httpStatus: response.status,
        ...(contentType ? { contentType } : {}),
        parseError,
      },
    },
    response.status,
  );
}

export function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const numeric = Number(headerValue);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  const date = Date.parse(headerValue);
  if (!Number.isNaN(date)) {
    const diffMs = date - Date.now();
    return diffMs > 0 ? Math.ceil(diffMs / 1000) : 0;
  }
  return undefined;
}

/**
 * HTTP statuses that arrive without our error envelope on transient
 * upstream outages (edge LB returning HTML, etc.). Treated as transport
 * failures.
 */
function isTransportEdgeStatus(status: number): boolean {
  return status === 408 || status === 502 || status === 504;
}

interface RetryDecision {
  retry: boolean;
  delayMs: number;
}

function transportRetryDecision(attempt: number, random: () => number): RetryDecision {
  if (attempt >= MAX_ATTEMPTS_TRANSPORT) return { retry: false, delayMs: 0 };
  return { retry: true, delayMs: backoffDelay(attempt, random) };
}

function apiRetryDecision(
  code: ErrorCode,
  attempt: number,
  retryAfterSec: number | undefined,
  random: () => number,
  retryOnConflict = true,
  retryOnRateLimit = true,
): RetryDecision {
  switch (code) {
    // M3.2 piece-1 / piece-2: `PRECONDITION_FAILED` (etag mismatch),
    // `IDEMPOTENCY_BODY_MISMATCH` (caller mutated body across retries),
    // and `PAYLOAD_TOO_LARGE` (350 KB cap) are all caller-side bugs —
    // never retry, exit immediately with the typed envelope.
    // INSUFFICIENT_CREDITS is non-retriable: out-of-credits cannot self-heal.
    // The RATE_LIMITED credits sub-case is re-mapped to INSUFFICIENT_CREDITS
    // in parseEnvelopeBody (errors.ts) before apiRetryDecision is called,
    // so the genuine per-minute throttle (RATE_LIMITED) reaches the RATE_LIMITED
    // case below and retries normally.
    // FEATURE_GATED is non-retriable: a paid-feature gate can't self-heal with
    // retries — the caller must upgrade their plan first.
    case 'AUTH_REQUIRED':
    case 'AUTH_INVALID':
    case 'AUTH_FORBIDDEN':
    case 'NOT_FOUND':
    case 'VALIDATION_ERROR':
    case 'PAYLOAD_TOO_LARGE':
    case 'PRECONDITION_FAILED':
    case 'IDEMPOTENCY_BODY_MISMATCH':
    case 'UNSUPPORTED':
    case 'INSUFFICIENT_CREDITS':
    case 'FEATURE_GATED':
      return { retry: false, delayMs: 0 };
    case 'CONFLICT':
      // Read paths (e.g. GET /failure) retry once: 409 = mid-mutation snapshot.
      // Write paths (e.g. POST /runs) must NOT retry: 409 = another run is in
      // flight (persistent), retrying would enqueue a second run.
      if (!retryOnConflict) return { retry: false, delayMs: 0 };
      if (attempt >= MAX_ATTEMPTS_CONFLICT) return { retry: false, delayMs: 0 };
      return { retry: true, delayMs: CONFLICT_DELAY_MS };
    case 'INTERNAL':
      if (attempt >= MAX_ATTEMPTS_INTERNAL) return { retry: false, delayMs: 0 };
      return { retry: true, delayMs: INTERNAL_DELAY_MS };
    case 'RATE_LIMITED':
      if (!retryOnRateLimit) return { retry: false, delayMs: 0 };
      if (attempt >= MAX_ATTEMPTS_RATE_LIMITED) return { retry: false, delayMs: 0 };
      return {
        retry: true,
        delayMs: Math.min(Math.max(0, (retryAfterSec ?? 1) * 1000), MAX_RATE_LIMITED_DELAY_MS),
      };
    case 'UNAVAILABLE':
      if (attempt >= MAX_ATTEMPTS_UNAVAILABLE) return { retry: false, delayMs: 0 };
      return { retry: true, delayMs: backoffDelay(attempt, random) };
  }
}

function backoffDelay(attempt: number, random: () => number): number {
  const base = RETRY_BASE_MS * Math.pow(2, attempt - 1);
  const jitter = Math.floor(random() * RETRY_JITTER_MS);
  return Math.min(base + jitter, RETRY_MAX_DELAY_MS);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (typeof err === 'object' && err !== null && 'name' in err) {
    return (err as { name?: string }).name === 'AbortError';
  }
  return false;
}

/**
 * Detects the `TimeoutError` thrown by `AbortSignal.timeout()` in Node 22+.
 * Node's `fetch` aborts with a `DOMException` whose `.name === 'TimeoutError'`
 * (distinct from `'AbortError'` used for explicit `AbortController.abort()`).
 */
function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'TimeoutError') return true;
  if (typeof err === 'object' && err !== null && 'name' in err) {
    return (err as { name?: string }).name === 'TimeoutError';
  }
  return false;
}
