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
 * `src/commands/test.ts`. The payload cap is deliberately not carried over:
 * secrets are small, and a size ceiling would be a behaviour change on a
 * shipped flag rather than part of fixing the crash.
 *
 * Callers pass the flag name so the envelope names the flag the user actually
 * typed — one helper serves `--password-file` today and the remaining
 * credential/auto-auth file flags once they are migrated.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { localValidationError } from './errors.js';

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
 *   or not a regular file.
 */
export function readSecretFileGuarded(flag: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);

  let stat;
  try {
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

  try {
    return readFileSync(absolute, 'utf8').trim();
  } catch (err) {
    throw secretFileError(flag, path, err, 'read');
  }
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
