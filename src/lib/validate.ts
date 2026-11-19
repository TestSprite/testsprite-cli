/**
 * Validation helpers for caller-supplied values that commands share. Error
 * envelopes come from `localValidationError`, so wording and exit codes stay
 * consistent with the rest of the CLI.
 */
import { localValidationError } from './errors.js';

/**
 * Validate a caller-supplied `--idempotency-key` value before it is sent as
 * an HTTP header. The HTTP spec (RFC 7230) requires header values to be ASCII
 * printable characters (0x21–0x7E plus SP/HTAB). A value that contains
 * non-ASCII bytes causes Node's `fetch` to throw a `TypeError: ByteString`
 * exception at the transport layer, which surfaces as an opaque exit 10
 * UNAVAILABLE — completely unhelpful for the operator (dogfood P1 fix #2).
 *
 * Client-side rules enforced here:
 *   - 1–256 characters (inclusive)
 *   - All characters must be in the ASCII printable range (0x20–0x7E)
 *
 * On rejection throws a `VALIDATION_ERROR` (exit 5) with a clear message.
 * On `undefined` (auto-generated key path) this is a no-op.
 *
 * @param key  The raw flag value, or `undefined` when the key is auto-minted.
 */
export function assertIdempotencyKey(key: string | undefined): void {
  if (key === undefined) return;
  // ASCII-printable check: every codepoint must be in U+0020–U+007E (space through tilde).
  // Non-ASCII chars (codepoint > 127) trigger a TypeError in Node's fetch ByteString header.
  if (key.length === 0 || !/^[ -~]+$/.test(key)) {
    throw localValidationError(
      'idempotencyKey',
      'must be 1–256 printable ASCII characters (no non-ASCII, control chars, or empty string)',
      undefined,
      'flag',
    );
  }
  if (key.length > 256) {
    throw localValidationError(
      'idempotencyKey',
      'must be at most 256 characters',
      undefined,
      'flag',
    );
  }
}
