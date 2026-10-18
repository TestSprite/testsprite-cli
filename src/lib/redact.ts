/**
 * Recursive, key-based secret redaction for CLI output.
 *
 * Before this module, the only redaction anywhere in the codebase was
 * `tunnel-session.ts`'s `redactTunnelSecret` — a literal `String.replaceAll`
 * of an ALREADY-KNOWN secret value out of a single log line. That only works
 * when the caller already holds the plaintext to search for; it does nothing
 * for an arbitrary server error `details` blob or a `--debug` trace, where
 * the secret has to be found by its KEY name (`password`, `apiKey`, …), not
 * by a value the caller can search for. This module fills that gap.
 *
 * Deliberately NOT applied to `Output.print`'s success data: generated test
 * code, plans and backend-test fixtures are the user's OWN content and must
 * round-trip byte-identical (`test code get --output json` -> edit ->
 * `test code put`), even when they legitimately contain a literal
 * `Authorization: Bearer …` header or a `password` fixture key — that is
 * not a secret the CLI is leaking, it is the value the user is asking to see
 * back. Applied instead at `Output.error`'s `details`, the hand-built
 * ApiError envelope in `index.ts`, and the `--debug` / dry-run request
 * tracing in `client-factory.ts` — server/error prose and request traces,
 * never the user's stored data — and never at request-construction time (the
 * real secret still has to go out on the wire). `--dry-run` previews that
 * commands print are built from non-secret shapes (booleans such as
 * `hasCredentials`, field names), so they never carry a secret to redact.
 */

export const REDACTED = '[REDACTED]';

/**
 * Key-name suffixes (case-insensitive, separators ignored) whose STRING
 * value is replaced by {@link REDACTED}. A suffix match, not a substring or
 * exact match: it has to catch the realistic compound names a server or a
 * future field could use (`refreshToken`, `clientSecret`, `x-api-key`,
 * `Set-Cookie`) while still excluding names that merely contain the word,
 * such as `credentialsPath` (a filesystem path, ends in "path") or
 * `tokenEndpoint` (a URL, ends in "endpoint").
 *
 * Only applied when the value is a `string`. Two real shapes in this
 * codebase would otherwise break under a type-blind rule:
 *  - `ci init`'s JSON output has a top-level `secret: {name, attempted, set,
 *    reason}` object describing metadata ABOUT a GitHub secret, never the
 *    secret's value.
 *  - `CliProjectEnvironment.hasCredentials` is a boolean PRESENCE flag, not
 *    a credential.
 * Both keys are left untouched by the string-only guard below, and their
 * children are still walked recursively (so an object nested under a
 * matching key can carry its own, separately-matched, leaf secret).
 */
const SECRET_KEY_SUFFIXES = [
  'password',
  'passwords',
  'secret',
  'secrets',
  'apikey',
  'apikeys',
  'authorization',
  'cookie',
  'cookies',
  'credential',
  'credentials',
];

/**
 * Exact (post-normalization) key names treated as an auth token — NOT a
 * suffix rule like the list above. This CLI's own pagination continuation
 * handles are also literally named "...Token" (`nextToken`, `startingToken`)
 * and are opaque cursors, not secrets; a suffix match on "token" would blank
 * them (`test result --history`'s `nextToken`, `project list`'s
 * `startingToken`/`nextToken`). Add a new compound auth-token name here, not
 * to the suffix list above.
 */
const SECRET_TOKEN_KEYS = new Set([
  'token',
  'tokens',
  'apitoken',
  'apitokens',
  'authtoken',
  'authtokens',
  'accesstoken',
  'accesstokens',
  'refreshtoken',
  'refreshtokens',
  'bearertoken',
  'bearertokens',
  'idtoken',
  'idtokens',
  'sessiontoken',
  'sessiontokens',
]);

/** Lowercase and strip every non-alphanumeric character for key matching. */
function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SECRET_TOKEN_KEYS.has(normalized)) return true;
  return SECRET_KEY_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A conservative check for a secret-shaped string VALUE regardless of its
 * key name — a bearer token embedded in server/error prose (e.g. inside a
 * free-form `message`/`nextAction` string) has no key to match on.
 * Deliberately narrow: only the `Bearer <token>` wire form, and only when
 * the run of token characters contains an actual DIGIT, so an ordinary
 * hyphenated or dotted phrase — "a Bearer authentication header", "Bearer
 * token-based auth" — is left alone. A separator alone used to be enough
 * (any of `._~+/=-`), which let the `{8,}` scan's greedy, position-blind
 * match swallow a whole compound word merely because it contained a hyphen
 * — a broader entropy/length heuristic would also flag long environment
 * names, test ids, or UUIDs, which must never be redacted.
 */
const BEARER_TOKEN_RE = /\bBearer\s+(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * Keys whose object value is user-authored data shown back on purpose:
 * environment `variables` are plaintext by design (a variable named
 * `DB_PASSWORD` is the user's own fixture value), so they are never masked.
 */
const VERBATIM_KEYS = new Set(['variables']);

/** Replace any `Bearer <token>` substring inside a free-form string. */
function redactSecretLookingSubstrings(value: string): string {
  return value.replace(BEARER_TOKEN_RE, `Bearer ${REDACTED}`);
}

/**
 * Recursively mask values residing directly or within arrays under a matched secret key.
 * String leaves become {@link REDACTED}; nested arrays are walked to mask their string
 * elements; objects are processed via {@link redactDeep} so that non-secret sibling
 * fields (e.g. `username` in a credentials object) are preserved.
 */
function redactSecretValue(val: unknown): unknown {
  if (typeof val === 'string') {
    return REDACTED;
  }
  if (Array.isArray(val)) {
    return val.map(item => redactSecretValue(item));
  }
  if (isPlainObject(val)) {
    return redactDeep(val);
  }
  return val;
}

/**
 * Deep-walk `value`, replacing:
 *  - string values (and arrays of string values) of any object key matching
 *    {@link isSecretKey}, at any depth, with {@link REDACTED};
 *  - a `Bearer <token>` substring inside any other string, wherever it
 *    appears (key name irrelevant).
 *
 * Never mutates its input — returns a new tree. Plain data only (the values
 * that ever reach here are parsed JSON or plain option objects); a `Date`,
 * `Map`, etc. is returned unchanged rather than walked.
 */
export function redactDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => redactDeep(item)) as unknown as T;
  }
  if (typeof value === 'string') {
    return redactSecretLookingSubstrings(value) as unknown as T;
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      if (VERBATIM_KEYS.has(key) && isPlainObject(v)) {
        result[key] = v;
        continue;
      }
      result[key] = isSecretKey(key) ? redactSecretValue(v) : redactDeep(v);
    }
    return result as unknown as T;
  }
  return value;
}
