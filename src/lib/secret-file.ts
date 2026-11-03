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
 *
 * The check (is this a regular file?) and the use (read its bytes) happen
 * against a single open file descriptor rather than against the path twice,
 * so nothing can be swapped in between: whatever `openSync` resolved is
 * exactly what `fstatSync` classifies and `readFileSync` reads.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
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

  let fd: number;
  try {
    // O_NONBLOCK matters here specifically because this is a *-file flag:
    // a plain `open(path, O_RDONLY)` on a FIFO with no writer blocks the
    // calling thread until one connects (POSIX fifo(7)), and since this is
    // a synchronous fs call on Node's single main thread, that blocks the
    // entire CLI process -- including its SIGINT handler, since delivering
    // that signal to JS requires the (blocked) event loop to run. The old
    // statSync()-first code rejected a FIFO instantly via `isFile()` before
    // ever opening it; O_NONBLOCK restores that instant-fail behavior by
    // making the open itself return right away instead of waiting for a
    // writer, so the existing fstatSync().isFile() check below still does
    // the rejecting. It has no effect on a regular file's read semantics.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this is the guard itself: `absolute` is the user-supplied --*-file path after isAbsolute()/resolve(); everything after (fstat, then read) uses the fd this open() returns, not the path string, which is the mitigation for a non-literal fs path here.
    fd = openSync(absolute, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    // Opening a directory succeeds on POSIX (the fstat().isFile() check
    // below is the gate for that case) but can fail right here on other
    // platforms, and not always with the same errno a directory produces
    // elsewhere. Classify the failure by re-stat'ing the path once,
    // diagnostically, before falling back to errno-based mapping: nothing is
    // read as a result, so this cannot reintroduce a check-then-use race —
    // it only decides which message to throw for an open() that already
    // failed.
    let isDir = false;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- diagnostic only, to pick an error message for the open() failure above; no data is read from `absolute` here or afterward.
      isDir = statSync(absolute).isDirectory();
    } catch {
      // Path vanished or became inaccessible between the failed open() and
      // this diagnostic stat — fall through to the errno-based mapping,
      // which still accurately reports that the open() failed.
    }
    if (isDir) {
      throw localValidationError(flag, `not a regular file: ${path}`);
    }
    throw secretFileError(flag, path, err, 'stat');
  }

  try {
    let stat;
    try {
      stat = fstatSync(fd);
    } catch (err) {
      throw secretFileError(flag, path, err, 'stat');
    }

    if (!stat.isFile()) {
      throw localValidationError(flag, `not a regular file: ${path}`);
    }

    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- `fd` is the open file descriptor from openSync() above, not a path string; the rule's non-literal-argument check does not distinguish the two, but there is no path re-resolution here for anything to race against.
      return readFileSync(fd, 'utf8').trim();
    } catch (err) {
      throw secretFileError(flag, path, err, 'read');
    }
  } finally {
    closeSync(fd);
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
  if (code === 'EMFILE' || code === 'ENFILE') {
    // The old stat-then-read code's statSync() opens no file descriptor, so
    // it always succeeded even with the process's fd table exhausted; only
    // the later readFileSync (which does open one) could hit EMFILE/ENFILE,
    // landing in the generic "cannot read" wording. The fd-based guard's
    // openSync is the first fs call here, so the same exhaustion now surfaces
    // at what looks like the "stat" step; route it to the same "cannot read"
    // wording regardless of `verb` so fd-table exhaustion always reads the
    // same as it did before, no matter which syscall actually hit the ceiling.
    const reason = err instanceof Error ? err.message : 'unknown error';
    return localValidationError(flag, `cannot read ${path}: ${reason}`);
  }
  const reason = err instanceof Error ? err.message : 'unknown error';
  return localValidationError(flag, `cannot ${verb} ${path}: ${reason}`);
}
