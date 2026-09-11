/**
 * Guarded reader for the `--*-file` secret flags.
 *
 * Every one of these flags exists so a secret stays out of shell history, and
 * every one of them is a path the user types by hand — so a typo is the
 * expected failure, not an exceptional one. A bare
 * `readFileSync(path, 'utf8').trim()` turns that typo into an unhandled Node
 * exception: exit `1` instead of `5`, an `--output json` payload whose `error`
 * is a bare string rather than the `{ code, message, nextAction }` envelope the
 * rest of the CLI emits, and the absolute path plus errno leaked to stderr.
 *
 * This maps those failures onto the same typed `VALIDATION_ERROR` envelope the
 * already-guarded file flags produce, mirroring `readCodeFileGuarded` in
 * `src/commands/test.ts` — including its size ceiling, so a mistyped path that
 * happens to name a real file cannot stream an arbitrary amount of unrelated
 * content to the API server.
 *
 * Callers pass the flag name so the envelope names the flag the user actually
 * typed — one helper serves `--password-file` today and the remaining
 * credential/auto-auth file flags once they are migrated.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { ApiError, localValidationError } from './errors.js';

/**
 * 64 KB ceiling on any `--*-file` secret.
 *
 * Sized off the largest secret these flags legitimately carry, with room to
 * spare: a 4096-bit RSA private key in PEM is ~3.2 KB and a GCP
 * service-account JSON key is ~2.4 KB, so 64 KB is roughly 20x headroom. What
 * it does catch is the flag pointed at the wrong file — a log, a database
 * dump, a binary — which the CLI would otherwise read into memory whole and
 * POST to the configured API server as `body.password`, with no size advisory
 * and no confirmation prompt.
 *
 * Unlike `MAX_INLINE_CODE_BYTES` this tracks no backend limit; the server
 * rejects oversize credentials on its own terms. The check is a client-side
 * pre-flight so an obvious mistake fails fast (exit 5) without spending a
 * round-trip — and, because it runs on `statSync` before the read, without
 * pulling the file into memory at all.
 */
export const MAX_SECRET_FILE_BYTES = 64 * 1024;

/**
 * Read a secret from `path`, surfacing every filesystem failure as a typed
 * `VALIDATION_ERROR` (exit 5) attributed to `flag`.
 *
 * The returned value is trimmed, matching what the unguarded call sites did.
 * Trimming also drops a leading UTF-8 BOM: `U+FEFF` is ECMAScript whitespace,
 * so a file written by PowerShell 5.1's default `Set-Content -Encoding utf8`
 * no longer smuggles an invisible character into the secret.
 *
 * @param flag - Flag name without the leading dashes, e.g. `'password-file'`.
 * @param path - Path as supplied by the user; may be relative.
 * @throws {ApiError} `VALIDATION_ERROR` when the path is missing, unreadable,
 *   or not a regular file; `PAYLOAD_TOO_LARGE` when it exceeds
 *   {@link MAX_SECRET_FILE_BYTES}. Both exit 5.
 */
export function readSecretFileGuarded(flag: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);

  let stat;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this is the guard itself: `absolute` is the user-supplied `--*-file` path after isAbsolute()/resolve() normalization, and this statSync().isFile() check (below) plus the try/catch mapping every errno to a typed VALIDATION_ERROR is exactly the mitigation for a non-literal fs path here.
    stat = statSync(absolute);
  } catch (err) {
    throw secretFileError(flag, path, err, 'stat');
  }

  // A directory would otherwise reach readFileSync and throw EISDIR on Linux
  // while resolving to an empty read on some platforms — reject it up front so
  // the contract is the same everywhere.
  if (!stat.isFile()) {
    throw localValidationError(flag, `not a regular file: ${path}`);
  }

  if (stat.size > MAX_SECRET_FILE_BYTES) {
    throw secretFileTooLarge(flag, path, stat.size);
  }

  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- same guarded path as the statSync() above: `absolute` already passed the isFile() regular-file check, so this read is the guard's intended purpose (reading a user-supplied secret path), not an unvalidated pass-through.
    return readFileSync(absolute, 'utf8').trim();
  } catch (err) {
    throw secretFileError(flag, path, err, 'read');
  }
}

/**
 * Oversize secret file. Uses `PAYLOAD_TOO_LARGE` rather than
 * `VALIDATION_ERROR` — matching `readCodeFileGuarded`, and giving a caller
 * parsing `--output json` a code it can distinguish from a bad path — but both
 * exit 5, so shell callers see no behaviour split.
 *
 * Reports the size it found so the operator can tell "wrong file" from "secret
 * genuinely too big", and the path as typed so no directory layout leaks.
 */
function secretFileTooLarge(flag: string, path: string, sizeBytes: number): ApiError {
  const kb = Math.round(MAX_SECRET_FILE_BYTES / 1024);
  return ApiError.fromEnvelope({
    error: {
      code: 'PAYLOAD_TOO_LARGE',
      message: `Secret file exceeds the ${kb} KB CLI cap (${sizeBytes} bytes).`,
      nextAction: `Point \`--${flag}\` at the secret itself: ${path} is larger than any credential should be.`,
      requestId: 'local',
      details: { field: flag, path, sizeBytes, maxBytes: MAX_SECRET_FILE_BYTES },
    },
  });
}

/**
 * Translate a Node filesystem error into the CLI's validation envelope,
 * reporting the path the user typed rather than the resolved absolute path so
 * no directory layout leaks into output.
 */
function secretFileError(
  flag: string,
  path: string,
  err: unknown,
  verb: 'stat' | 'read',
): ReturnType<typeof localValidationError> {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return localValidationError(flag, `file does not exist: ${path}`);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return localValidationError(flag, `permission denied reading ${path}`);
  }
  if (code === 'EISDIR') {
    return localValidationError(flag, `not a regular file: ${path}`);
  }
  const reason = err instanceof Error ? err.message : 'unknown error';
  return localValidationError(flag, `cannot ${verb} ${path}: ${reason}`);
}
