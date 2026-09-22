/**
 * Shared temp-directory helper for tests that scratch files to disk —
 * credentials files included.
 *
 * `mkdtempSync` (unlike a bare `mkdirSync`) creates the directory with
 * owner-only `0700` permissions on POSIX by construction, matching the mode
 * the CLI's own credential writer applies by hand
 * (`mkdirSync(dirname(path), { recursive: true, mode: 0o700 })` in
 * `src/lib/credentials.ts`). Pairing every `makeTempDir` with its returned
 * `cleanup()` in a `finally`/`afterEach` is what keeps a test that writes a
 * throwaway API key (or any other secret-shaped fixture) from leaving that
 * directory behind on disk after the run — hand-rolled
 * `mkdirSync`/`join(tmpdir(), ...)` call sites have no such guarantee and
 * are easy to forget to clean up.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TempDir {
  /** Absolute path to the created directory. */
  path: string;
  /** Removes the directory (recursive, force) — safe to call even if the directory was already removed. */
  cleanup: () => void;
}

/** Create a fresh, uniquely-named temp directory under the OS tmpdir. */
export function makeTempDir(prefix: string): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
