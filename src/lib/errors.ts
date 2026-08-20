import { resolvePortalBase } from './facade.js';

/**
 * Error codes shared with the backend facade and the MCP plugin.
 * Must stay in sync across all three.
 */
export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'AUTH_INVALID',
  'AUTH_FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_ERROR',
  // M3.2 piece-2 — inline `code` body cap (350 KB) exceeded. Exit 5
  // (validation family) — the request is well-formed but oversized;
  // `nextAction` points the operator at the Portal upload flow.
  'PAYLOAD_TOO_LARGE',
  'CONFLICT',
  // M3.2 piece-1 / piece-4 — `If-Match: <codeVersion>` etag mismatch on
  // `test code put`. Exit 6, same family as CONFLICT (the caller should
  // re-fetch and retry); kept distinct so machine consumers can route on
  // it without parsing message strings.
  'PRECONDITION_FAILED',
  // M3.2 piece-1 — `Idempotency-Key` reused with a different request
  // body. Exit 6; distinct from CONFLICT (snapshot-in-flight) so
  // automation can tell "you mutated the body between retries" from
  // "a Portal write is in flight."
  'IDEMPOTENCY_BODY_MISMATCH',
  'RATE_LIMITED',
  // Emitted natively by the backend as HTTP 402 with `details.required` (the
  // shortfall) — non-retriable, exit 12: out-of-credits cannot self-heal with
  // retries. The CLI additionally re-maps the legacy credits sub-case of a
  // RATE_LIMITED envelope (message matching /insufficient credits/i or
  // details.required present) for older backends. The genuine per-minute
  // throttle, 60/min/key ("Run trigger rate limit exceeded") retains code
  // RATE_LIMITED / exit 11 / retriable.
  'INSUFFICIENT_CREDITS',
  // Emitted natively by the backend as a fatal HTTP 403 when a plan-gated
  // feature is requested by a tier that doesn't include it (e.g. auto-auth on
  // a Free-plan org). `details` carries `{feature, plan, reason: 'plan'}`;
  // exit code 13 (non-retriable) — the fix is an upgrade, not a retry.
  // Distinct from silent tier DOWNGRADES (a request that still succeeds with
  // the feature dropped): those are surfaced via the response's advisory
  // fields, not this error.
  'FEATURE_GATED',
  // Client-side re-map of the org-ambiguity sub-case of a CONFLICT (409)
  // envelope. Raised when a membership-key caller's testId resolves to
  // projects in more than one of their organizations (uuid-derived ids
  // should not normally collide, so this is pathological — a shared-id
  // union-resolution edge case, not a transient snapshot race). Detected
  // when the backend returns `code: "CONFLICT"` with
  // `details.reason === "ambiguous_org"`. Same exit-code family as CONFLICT
  // (exit 6) but kept as a distinct code — unlike a generic CONFLICT this is
  // never retried (retrying resolves the same ambiguity again) and
  // `details.candidates[]` needs its own rendering.
  'AMBIGUOUS_ORG',
  'UNSUPPORTED',
  // The running CLI is older than the backend's minimum supported version.
  // Backend emits this as HTTP 426 when version enforcement is enabled. Exit
  // 14, non-retriable — a too-old client cannot self-heal by retrying; the
  // user must upgrade. `nextAction` carries the upgrade instruction and
  // `details` echoes { minVersion, latestVersion, yourVersion }.
  'CLIENT_TOO_OLD',
  'INTERNAL',
  'UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Exit-code mapping. INTERNAL maps to 1
 * (generic CLI failure) intentionally — operators triage by `requestId`,
 * not by exit code.
 */
export function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case 'AUTH_REQUIRED':
    case 'AUTH_INVALID':
    case 'AUTH_FORBIDDEN':
      return 3;
    case 'NOT_FOUND':
      return 4;
    case 'VALIDATION_ERROR':
    case 'PAYLOAD_TOO_LARGE':
      return 5;
    case 'CONFLICT':
    case 'PRECONDITION_FAILED':
    case 'IDEMPOTENCY_BODY_MISMATCH':
    case 'AMBIGUOUS_ORG':
      return 6;
    case 'UNSUPPORTED':
      return 7;
    case 'CLIENT_TOO_OLD':
      return 14;
    case 'UNAVAILABLE':
      return 10;
    case 'RATE_LIMITED':
      return 11;
    case 'INSUFFICIENT_CREDITS':
      return 12;
    case 'FEATURE_GATED':
      return 13;
    case 'INTERNAL':
      return 1;
  }
}

/**
 * Whether an error code is an authentication failure. DERIVED from the single
 * `exitCodeFor` mapping (auth === exit 3) rather than a second hand-maintained
 * list of code strings: a future `AUTH_*` code gets classified as auth the
 * moment it is given an exit-3 row, so it can never be present in one place and
 * missing in the other. The `ERROR_CODES` membership check keeps `exitCodeFor`
 * off unknown/out-of-contract strings (its switch has no default).
 */
export function isAuthCode(code: string): boolean {
  return (ERROR_CODES as readonly string[]).includes(code) && exitCodeFor(code as ErrorCode) === 3;
}

export class CLIError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CLIError';
    this.exitCode = exitCode;
  }
}

/**
 * Termination signals with graceful handling, mapped to their conventional
 * `128 + signum` exit code. sourceRef: POSIX signal numbers (SIGHUP=1,
 * SIGINT=2, SIGTERM=15). Lives here (not interrupt.ts) so `InterruptError`
 * needs no import cycle; `interrupt.ts` re-exports for back-compat.
 */
export const TERMINATION_EXIT_CODES = {
  SIGINT: 130, // 128 + 2
  SIGTERM: 143, // 128 + 15
  SIGHUP: 129, // 128 + 1
} as const;

export type TerminationSignal = keyof typeof TERMINATION_EXIT_CODES;

/**
 * User-initiated interrupt (SIGINT/SIGTERM/SIGHUP) observed while a
 * graceful-detach scope (the `--wait` polling window) was armed — see
 * `interrupt.ts::ShutdownController`. The `--wait` catch blocks render the
 * honest partial envelope + re-attach hint, then rethrow to `index.ts`.
 *
 * Deliberately NOT in `ERROR_CODES` — on a signal the CLI
 * exits 130/143 without consulting the error catalog. The JSON-mode stderr
 * envelope uses the out-of-catalog code `"INTERRUPTED"`. Same client-local
 * synthetic category as `RequestTimeoutError`.
 */
export class InterruptError extends CLIError {
  readonly signal: TerminationSignal;

  constructor(signal: TerminationSignal) {
    super(`Interrupted by ${signal}.`, TERMINATION_EXIT_CODES[signal]);
    this.name = 'InterruptError';
    this.signal = signal;
  }
}

export class NotImplementedError extends CLIError {
  constructor(commandPath: string) {
    super(`Command not yet implemented: ${commandPath}`, 2);
    this.name = 'NotImplementedError';
  }
}

export interface ErrorEnvelopeBody {
  code: ErrorCode;
  message: string;
  nextAction: string;
  requestId: string;
  details: Record<string, unknown>;
}

export interface ErrorEnvelope {
  error: ErrorEnvelopeBody;
}

/**
 * Server-returned API error. The CLI never invents `code`, `nextAction`,
 * or `requestId` — it forwards what the facade returned (or, for
 * locally-detected pre-flight conditions like a missing API key,
 * constructs an envelope with the same shape so the user sees identical
 * wording across paths).
 */
export class ApiError extends CLIError {
  readonly code: ErrorCode;
  readonly requestId: string;
  readonly nextAction: string;
  readonly details: Record<string, unknown>;
  readonly httpStatus: number | undefined;
  /**
   * Parsed `Retry-After` header value in milliseconds, when present on the
   * HTTP response. Only set for `RATE_LIMITED` (429) responses where the
   * server is telling the caller how long to wait. Clamped to `[1s, 300s]`
   * per the outer retry loop contract. `undefined` when the header was
   * absent or unparseable.
   */
  readonly retryAfterMs: number | undefined;

  constructor(envelope: ErrorEnvelopeBody, httpStatus?: number, retryAfterMs?: number) {
    super(envelope.message, exitCodeFor(envelope.code));
    this.name = 'ApiError';
    this.code = envelope.code;
    this.requestId = envelope.requestId;
    this.nextAction = envelope.nextAction;
    this.details = envelope.details;
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
  }

  /**
   * @param apiUrl Optional API endpoint the failing request targeted. Used to
   *   resolve environment-correct portal links in synthesized `nextAction`
   *   text (dev and prod portals live on different domains — never hardcode).
   */
  static fromEnvelope(
    raw: unknown,
    httpStatus?: number,
    retryAfterMs?: number,
    apiUrl?: string,
  ): ApiError {
    const envelope = parseEnvelopeBody(raw, httpStatus, apiUrl);
    return new ApiError(envelope, httpStatus, retryAfterMs);
  }

  /**
   * Type-safe accessor for a single key inside `details`. Avoids the
   * `(err.details as { foo?: unknown })?.foo` cast pattern that every
   * 412 / CONFLICT handler had to repeat.
   *
   * @param key     The key to read from `details`.
   * @param validator Optional type-guard. When provided, returns
   *                  `undefined` if the guard rejects the value.
   *
   * @example
   *   const ver = err.getDetail<string>(
   *     'currentCodeVersion',
   *     (v): v is string => typeof v === 'string',
   *   );
   */
  getDetail<T = unknown>(key: string, validator?: (v: unknown) => v is T): T | undefined {
    const details = this.details;
    if (details === undefined || details === null || typeof details !== 'object') {
      return undefined;
    }
    const value = (details as Record<string, unknown>)[key];
    if (value === undefined) return undefined;
    if (validator && !validator(value)) return undefined;
    return value as T;
  }

  /**
   * Local fabrication of a missing-key error. Wording matches the server
   * AUTH_REQUIRED template so the user sees the same thing whether the
   * miss was detected before or after sending the request.
   */
  static authRequired(requestId = 'local'): ApiError {
    return new ApiError({
      code: 'AUTH_REQUIRED',
      message: 'Authentication is required.',
      nextAction:
        'Run `testsprite setup` (interactive — prompts for your API key and installs the verification skill),' +
        ' or set TESTSPRITE_API_KEY and run `testsprite setup --from-env` for non-interactive flows.',
      requestId,
      details: {},
    });
  }
}

/**
 * Fabricate a locally-detected VALIDATION_ERROR envelope using the same
 * shape the backend facade emits, so callers see identical wording whether
 * the error is caught before or after a network round-trip.
 *
 * `kind` controls how `nextAction` is phrased:
 *
 *   - `'flag'` (default) — wraps the field name as a CLI flag:
 *     `Flag \`--page-size\` is invalid: must be a positive integer.`
 *   - `'field'` — uses the bare field path:
 *     `Field \`planSteps[0].description\` is invalid: must be a string.`
 *
 * Use `'field'` for JSON-body paths to avoid fabricating a `--fieldName`
 * flag that doesn't exist in the CLI surface.
 *
 * `reason` is trailed with a period UNLESS it already ends with one — some
 * call sites compose `reason` from multiple already-punctuated sentences
 * (e.g. `'... Remove --target-url.'`), and unconditionally appending a
 * second period produced a doubled `..` at the end of the rendered message.
 */
export function localValidationError(
  field: string,
  reason: string,
  accepted?: unknown,
  kind: 'flag' | 'field' = 'flag',
): ApiError {
  const subject =
    kind === 'flag'
      ? `Flag \`--${field.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`)}\``
      : `Field \`${field}\``;
  const punctuatedReason = reason.endsWith('.') ? reason : `${reason}.`;
  return ApiError.fromEnvelope({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request.',
      nextAction: `${subject} is invalid: ${punctuatedReason}`,
      requestId: 'local',
      details: accepted === undefined ? { field, reason } : { field, reason, accepted },
    },
  });
}

/**
 * Network/transport failure not associated with a server envelope. Treated
 * as `UNAVAILABLE` for exit-code purposes per design §8.2.
 */
export class TransportError extends ApiError {
  constructor(message: string, requestId = 'local') {
    super({
      code: 'UNAVAILABLE',
      message,
      nextAction:
        'Service is temporarily unavailable. The CLI retries with exponential backoff; if this persists, report it.',
      requestId,
      details: {},
    });
    this.name = 'TransportError';
  }
}

/**
 * Client-side per-request timeout. The fetch was aborted because the
 * configurable per-request deadline elapsed before the server responded.
 *
 * Maps to `UNSUPPORTED` for exit-code purposes (exit 7) — the same bucket
 * as `TimeoutError` from the polling path. Use `--request-timeout <s>` or
 * `TESTSPRITE_REQUEST_TIMEOUT_MS` to extend the deadline when targeting a
 * slow backend.
 */
export class RequestTimeoutError extends CLIError {
  readonly requestId: string;
  readonly timeoutMs: number;

  constructor(timeoutMs: number, requestId = 'local') {
    const timeoutSec = Math.round(timeoutMs / 1000);
    super(
      `Request timed out after ${timeoutSec}s (client-side). ` +
        `Use --request-timeout <seconds> or TESTSPRITE_REQUEST_TIMEOUT_MS to extend the deadline.`,
      7,
    );
    this.name = 'RequestTimeoutError';
    this.requestId = requestId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Every facade-emitted HTTP status maps to a
 * known error code. When the envelope is missing or its `code` field is
 * unrecognized (proxy returned an empty body, content was mangled), we fall
 * back to the status-derived code so the retry budget and exit code match
 * what the contract promises.
 */
function codeFromHttpStatus(status: number | undefined): ErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION_ERROR';
    case 401:
      return 'AUTH_INVALID';
    case 402:
      return 'INSUFFICIENT_CREDITS';
    case 403:
      return 'AUTH_FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 412:
      return 'PRECONDITION_FAILED';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 426:
      return 'CLIENT_TOO_OLD';
    case 429:
      return 'RATE_LIMITED';
    case 501:
      return 'UNSUPPORTED';
    case 503:
      return 'UNAVAILABLE';
    default:
      return 'INTERNAL';
  }
}

/**
 * Detect the "insufficient credits" sub-case of a RATE_LIMITED (429) envelope.
 *
 * Detection signals (require at least one strong signal):
 *   1. `details.required` is present (a number > 0) — the credit cost field
 *      that the backend attaches only to the credits error, not to throttle.
 *   2. `message` matches /insufficient credits/i — the backend's stable
 *      template for this error.
 *
 * The genuine per-minute throttle has message "Run trigger rate limit exceeded: …"
 * and no `details.required`, so it cannot match either signal.
 *
 * This is a CLIENT-SIDE detection bridge. The backend will emit a distinct
 * `INSUFFICIENT_CREDITS` code in a future release at which point this
 * function becomes unreachable for new backends.
 */
function isInsufficientCredits(
  rawCode: string,
  message: string,
  details: Record<string, unknown>,
): boolean {
  if (rawCode !== 'RATE_LIMITED') return false;
  const hasRequiredField = typeof details.required === 'number' && details.required > 0;
  const hasCreditsMessage = /insufficient credits/i.test(message);
  return hasRequiredField || hasCreditsMessage;
}

/**
 * Detect the "ambiguous org" sub-case of a CONFLICT (409) envelope: a
 * membership-key caller's testId resolved to projects in more than one of
 * their organizations. `details.reason === "ambiguous_org"` is the backend's
 * stable discriminator (see `CliAmbiguousTestError` server-side) — distinct
 * from the default CONFLICT meaning (snapshot in flight).
 */
function isAmbiguousOrgConflict(rawCode: string, details: Record<string, unknown>): boolean {
  return rawCode === 'CONFLICT' && details.reason === 'ambiguous_org';
}

function parseEnvelopeBody(raw: unknown, httpStatus?: number, apiUrl?: string): ErrorEnvelopeBody {
  if (typeof raw !== 'object' || raw === null) {
    const fallbackCode = codeFromHttpStatus(httpStatus);
    return {
      code: fallbackCode,
      message:
        fallbackCode === 'INTERNAL'
          ? 'Server returned a malformed error response.'
          : `Server returned ${httpStatus} without an error envelope.`,
      nextAction:
        fallbackCode === 'INTERNAL'
          ? 'Server error. Retry once; if it persists, report the `requestId` to support@testsprite.com.'
          : '',
      requestId: 'unknown',
      details: {},
    };
  }
  const obj = raw as Record<string, unknown>;

  // Raw Nest/Express 404 shape: `{ message, error: "Not Found", statusCode }`.
  // The current parser was matching `obj.error` (a string) and falling to
  // `Server error.` while losing the actual `message` from the body
  // (e.g. `Cannot POST /api/cli/v1/tests/{id}/runs`). Detect this shape
  // explicitly so the user sees something actionable like
  // "endpoint not deployed" instead of the generic CLI failure text.
  if (typeof obj.error === 'string' && typeof obj.message === 'string') {
    const message = obj.message;
    const cannotMethod = /^Cannot (GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) /.exec(message);
    const isRouteMissing404 = (httpStatus === 404 || obj.statusCode === 404) && !!cannotMethod;
    return {
      code: codeFromHttpStatus(httpStatus),
      message: isRouteMissing404
        ? `${message} — endpoint not available on the current backend deployment.`
        : message,
      nextAction: isRouteMissing404
        ? 'Verify the CLI is targeting the right environment (check `testsprite auth status` for `env`), and confirm the backend has the corresponding M3.3 piece deployed.'
        : '',
      requestId: 'unknown',
      details: { statusCode: obj.statusCode },
    };
  }

  const errorObj = (obj.error ?? obj) as Record<string, unknown>;
  const rawCode = isErrorCode(errorObj.code) ? errorObj.code : codeFromHttpStatus(httpStatus);
  const message = typeof errorObj.message === 'string' ? errorObj.message : 'Server error.';
  const details =
    typeof errorObj.details === 'object' && errorObj.details !== null
      ? (errorObj.details as Record<string, unknown>)
      : {};
  const nextAction = typeof errorObj.nextAction === 'string' ? errorObj.nextAction : '';
  const requestId = typeof errorObj.requestId === 'string' ? errorObj.requestId : 'unknown';

  // Client-side re-map: RATE_LIMITED with credits signal -> INSUFFICIENT_CREDITS.
  // This makes the code non-retriable and sets exit 12 before the retry
  // decision in http.ts sees it, so BOTH retry and exit-code paths are correct.
  // A nextAction pointing to the billing page is synthesized when the backend
  // didn't supply one (older backend versions).
  if (isInsufficientCredits(rawCode, message, details)) {
    // Synthesize a nextAction when the backend did not supply one, or when
    // the backend-supplied nextAction lacks the CLI pre-flight hint.
    // The `testsprite usage` command is the CLI-native way to check balance
    // before a large run fan-out (dogfood L1868 + L1890).
    // Portal links resolve per environment from the API endpoint (dev and
    // prod portals live on different domains); unknown hosts get the route
    // only — a hardcoded domain would point at the wrong environment.
    //
    // V3 API keys are membership-bound: a key minted for a team org spends
    // THAT org's wallet, not the holder's personal one, and there is no
    // request-scoped signal here (this branch fires client-side, purely
    // from the HTTP status/body) to tell which kind of key just failed. So
    // this synthesized hint deliberately does NOT assert "top up your
    // (personal) credits" as the only path — it offers the personal-key
    // link (still correct for the common case) alongside an honest
    // org-bound alternative, rather than guessing.
    const portalBase = apiUrl === undefined ? undefined : resolvePortalBase(apiUrl);
    const billingNextAction =
      nextAction !== ''
        ? nextAction
        : (portalBase !== undefined
            ? `Top up credits at ${portalBase}/dashboard/settings/billing (personal keys) — ask an org admin if this key is organization-bound — or upgrade your plan at ${portalBase}/pricing.`
            : 'Top up credits on the portal Billing page (/dashboard/settings/billing) if this is a personal key — ask an org admin if it is organization-bound — or upgrade your plan (/pricing).') +
          ' Run `testsprite usage` to check your current balance before the next run.';
    return {
      code: 'INSUFFICIENT_CREDITS',
      message,
      nextAction: billingNextAction,
      requestId,
      details,
    };
  }

  // Client-side re-map: CONFLICT with the ambiguous-org discriminator ->
  // AMBIGUOUS_ORG. Same message/nextAction as the backend supplied — the
  // server already writes an actionable template — but a distinct `code`
  // so the retry decision (http.ts) and the candidates rendering (index.ts)
  // can key off it directly instead of re-parsing `details.reason`.
  if (isAmbiguousOrgConflict(rawCode, details)) {
    return {
      code: 'AMBIGUOUS_ORG',
      message,
      nextAction,
      requestId,
      details,
    };
  }

  return {
    code: rawCode,
    message,
    nextAction,
    requestId,
    details,
  };
}
