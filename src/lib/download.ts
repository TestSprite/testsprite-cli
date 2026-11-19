/**
 * Downloads to the user's disk: a signed storage link streamed to a file, and
 * the guards on where files land (the `--out` directory the user chose, and
 * every name composed under it).
 */

import { createWriteStream, type Stats } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { ApiError, InterruptError, TransportError, localValidationError } from './errors.js';
import type { FetchImpl } from './http.js';
import { globalShutdown, type ShutdownHandle } from './interrupt.js';
import { defaultSleep, sleepUnlessInterrupted } from './poll-support.js';

/** Max fetch attempts for each presigned URL (initial + retries). */
export const STREAM_URL_MAX_RETRIES = 3;
/** Delay between retries for transient transport failures (ms). */
export const STREAM_URL_RETRY_DELAY_MS = 1000;

/** Recording container extensions trusted from a video link. */
export const KNOWN_VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi']);

/**
 * Strip trailing path separators, tolerating both `/` and `\` since a
 * native Windows `--out` value (typed or pasted from Explorer) commonly
 * ends in a backslash. Preserves a bare drive root (`C:\`) — stripping
 * its separator would turn it into `C:`, which Windows resolves as
 * "current directory on drive C", not the drive root.
 */
function stripTrailingSeparators(rawPath: string): string {
  if (rawPath.length <= 1) return rawPath;
  let end = rawPath.length;
  while (end > 1 && (rawPath[end - 1] === '/' || rawPath[end - 1] === '\\')) {
    if (end === 3 && rawPath[1] === ':' && /[A-Za-z]/.test(rawPath[0]!)) break;
    end--;
  }
  return rawPath.slice(0, end);
}

/**
 * Resolve the user-supplied `--out` path into an absolute directory.
 * Empty strings are rejected with `VALIDATION_ERROR`.
 * Nothing is created here: the writer makes
 * the directory once the response has been read, so a failed read never
 * modifies the operator's filesystem.
 */
export function resolveOutDir(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request.',
        nextAction: 'Flag `--out` is invalid: must be a non-empty directory path.',
        requestId: 'local',
        details: { field: 'out', reason: 'must be a non-empty directory path' },
      },
    });
  }
  const trimmed = stripTrailingSeparators(rawPath);
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

/**
 * Validate the `--out` directory before any request goes out. Surfaces
 * `VALIDATION_ERROR` (exit 5) — matches the convention from `closeOutputFile`
 * for single-file `--out` flags.
 *
 * Missing parent directories are fine: the writer creates the whole tree
 * with `mkdir(dir, { recursive: true })` once the response has been read,
 * so a failed read still leaves nothing on disk. What is refused here is a
 * path that can never become a directory: `--out` pointing at an existing
 * file, or a file where one of its parent directories should be.
 *
 * The directory itself (`resolvedDir`) may or may not exist; the writer
 * creates it if absent.
 */
export async function assertOutDirParentExists(resolvedDir: string): Promise<void> {
  const closest = await closestExistingPath(dirname(resolvedDir));
  if (!closest.stats.isDirectory()) {
    throw localValidationError('out', `parent path is not a directory: ${closest.path}`);
  }
  // Also guard against --out pointing at an existing FILE (not a dir).
  let targetStat;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the --out directory the user chose.
    targetStat = await stat(resolvedDir);
  } catch {
    // Does not exist yet — fine; the writer will create it.
    return;
  }
  if (!targetStat.isDirectory()) {
    throw localValidationError('out', `must point to a directory, not a file: ${resolvedDir}`);
  }
}

/**
 * The nearest path at or above `target` that exists, with its stats. Missing
 * components are skipped. So is a file in the middle of the path (ENOTDIR on
 * POSIX, ENOENT on Windows): the walk stops at that file, and the caller
 * reports it as "not a directory".
 */
async function closestExistingPath(target: string): Promise<{ path: string; stats: Stats }> {
  let current = target;
  for (;;) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- this is the guard itself: walks up from the parent of the user-supplied --out path after resolve(); stat() only, nothing is read or written.
      return { path: current, stats: await stat(current) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const up = dirname(current);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || up === current) {
        throw localValidationError('out', `cannot access parent path: ${current}`);
      }
      current = up;
    }
  }
}

/**
 * Pick the on-disk extension for `video.<ext>` from the actual video link,
 * instead of hardcoding `mp4` (the recording is sometimes a `.webm`
 * container; saving it under a `video.mp4` name misleads strict-extension
 * consumers). Falls back to `mp4` when the URL is malformed or its extension
 * isn't a recognized container, so a response-controlled field can never
 * smuggle an arbitrary suffix onto disk.
 */
export function pickVideoExtension(url: string): string {
  try {
    const match = /\.([A-Za-z0-9]+)$/.exec(new URL(url).pathname);
    const ext = match?.[1]?.toLowerCase();
    if (ext !== undefined && KNOWN_VIDEO_EXTENSIONS.has(ext)) return ext;
  } catch {
    // Malformed URL — fall through to the default below.
  }
  return 'mp4';
}

/**
 * Refuse a composed artifact path that escapes `baseDir`. This is the final
 * containment check before any write. Returns the validated absolute path.
 */
export function assertNoEscape(baseDir: string, segment: string): string {
  const composed = resolve(baseDir, segment);
  const rel = relative(baseDir, composed);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw localValidationError(
      'out',
      'resolved artifact path escapes the --out directory',
      undefined,
      'field',
    );
  }
  return composed;
}

/**
 * Stream a presigned URL into a file with bounded retry on transport
 * failures. 4xx (presigned URL expired or unauthorized) is NOT
 * retried — the URL won't recover on its own; an upstream re-fetch
 * is the only fix. Maps to `UNAVAILABLE` so `index.ts` exits 10.
 *
 * Streaming uses `pipeline` to honor backpressure: a slow disk pauses
 * the upstream reader rather than buffering chunks in V8 heap. This
 * matters for video files (multi-MB) and for very large HTML
 * snapshots.
 *
 * Transport failures (network reset, DNS blip, mid-stream EOF) are
 * retried up to STREAM_URL_MAX_RETRIES times with a fixed delay, well
 * inside a signed link's lifetime. A file whose last attempt broke off
 * mid-stream is left as far as it got: the caller removes it.
 */
export async function streamUrlToFile(
  url: string,
  filePath: string,
  fetchImpl: FetchImpl,
  deps?: {
    sleep?: (ms: number) => Promise<void>;
    shutdownSignal?: AbortSignal;
    shutdown?: Pick<ShutdownHandle, 'runCriticalOperation'>;
  },
): Promise<void> {
  const shutdownSignal = deps?.shutdownSignal ?? globalShutdown.signal;
  const shutdown = deps?.shutdown ?? globalShutdown;
  return shutdown.runCriticalOperation(() =>
    streamUrlToFileTracked(url, filePath, fetchImpl, deps?.sleep ?? defaultSleep, shutdownSignal),
  );
}

async function streamUrlToFileTracked(
  url: string,
  filePath: string,
  fetchImpl: FetchImpl,
  sleepFn: (ms: number) => Promise<void>,
  shutdownSignal: AbortSignal,
): Promise<void> {
  const artifactUrl = redactArtifactUrlForDetails(url);
  for (let attempt = 1; attempt <= STREAM_URL_MAX_RETRIES; attempt++) {
    if (shutdownSignal.aborted) throw shutdownSignal.reason;
    let response: Response;
    try {
      response = await fetchImpl(url, { redirect: 'error', signal: shutdownSignal });
    } catch (err) {
      if (err instanceof InterruptError || shutdownSignal.aborted)
        throw shutdownSignal.reason ?? err;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < STREAM_URL_MAX_RETRIES) {
        await sleepUnlessInterrupted(sleepFn, STREAM_URL_RETRY_DELAY_MS, shutdownSignal);
        continue;
      }
      throw new TransportError(`Failed to download presigned URL ${artifactUrl}: ${message}`);
    }
    if (shutdownSignal.aborted) throw shutdownSignal.reason;
    if (!response.ok) {
      // Non-2xx: the URL itself is bad (expired, unauthorized, not found).
      // Retrying the same URL won't help — surface immediately.
      throw ApiError.fromEnvelope({
        error: {
          code: 'UNAVAILABLE',
          message: `Failed to download presigned URL (HTTP ${response.status}).`,
          nextAction:
            'Signed links expire. Re-run `testsprite result get <result-id> --out <dir>`: each read signs new ones.',
          requestId: 'local',
          details: { status: response.status, artifactUrl },
        },
      });
    }
    if (!response.body) {
      // Some test runtimes / fetch polyfills don't expose `body` as a
      // ReadableStream. Fall back to a buffered write — same correctness,
      // just no streaming benefit. Even a multi-MB video buffers fully in
      // a tolerable amount of memory.
      try {
        const buffer = Buffer.from(await response.arrayBuffer());
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path its caller composed under the --out directory.
        await writeFile(filePath, buffer);
        if (shutdownSignal.aborted) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- the partial file this download just wrote.
          await rm(filePath, { force: true }).catch(() => undefined);
          throw shutdownSignal.reason;
        }
        return;
      } catch (err) {
        if (err instanceof InterruptError || shutdownSignal.aborted) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- the partial file this download just wrote.
          await rm(filePath, { force: true }).catch(() => undefined);
          throw shutdownSignal.reason ?? err;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (attempt < STREAM_URL_MAX_RETRIES) {
          await sleepUnlessInterrupted(sleepFn, STREAM_URL_RETRY_DELAY_MS, shutdownSignal);
          continue;
        }
        throw new TransportError(`Failed to download presigned URL ${artifactUrl}: ${message}`);
      }
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the directory of a file under the --out directory the user chose.
    await mkdir(dirname(filePath), { recursive: true });
    // `response.body` is a Web ReadableStream. Node's `pipeline` accepts
    // it via `Readable.fromWeb` (Node >= 18). Wrap in a try so any error
    // from the stream propagates as a TransportError, preserving the
    // exit-code contract. `pipeline` destroys both streams on error, so
    // a new WriteStream on retry starts clean.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path its caller composed under the --out directory.
    const fileSink = createWriteStream(filePath);
    try {
      const webBody = response.body as unknown as NodeReadableStream<Uint8Array>;
      const { Readable } = await import('node:stream');
      const nodeStream = Readable.fromWeb(webBody);
      await pipeline(nodeStream, fileSink as unknown as Writable);
      if (shutdownSignal.aborted) throw shutdownSignal.reason;
      return;
    } catch (err) {
      if (err instanceof InterruptError || shutdownSignal.aborted) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- the partial file this download just wrote.
        await rm(filePath, { force: true }).catch(() => undefined);
        throw shutdownSignal.reason ?? err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < STREAM_URL_MAX_RETRIES) {
        await sleepUnlessInterrupted(sleepFn, STREAM_URL_RETRY_DELAY_MS, shutdownSignal);
        continue;
      }
      throw new TransportError(`Failed mid-download of ${artifactUrl}: ${message}`);
    }
  }
}

function redactArtifactUrlForDetails(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}
