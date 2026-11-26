/**
 * Downloading a signed link to disk, and the guards on where it lands: the
 * `--out` directory the user chose, and every file name composed under it.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertNoEscape,
  assertOutDirParentExists,
  pickVideoExtension,
  refusedDownloadUrl,
  resolveOutDir,
  stallClock,
  STREAM_URL_MAX_RETRIES,
  stallTimedSink,
  streamUrlToFile,
} from './download.js';
import { ShutdownController } from './interrupt.js';

describe('pickVideoExtension', () => {
  it('matches the actual recording container instead of hardcoding mp4', () => {
    expect(pickVideoExtension('https://s3.example.com/run_abc.webm')).toBe('webm');
    expect(pickVideoExtension('https://s3.example.com/run_abc.mp4')).toBe('mp4');
  });

  it('strips presigned-URL query strings before reading the extension', () => {
    expect(
      pickVideoExtension(
        'https://s3.example.com/run_abc.webm?X-Amz-Signature=abc&X-Amz-Expires=60',
      ),
    ).toBe('webm');
  });

  it('is case-insensitive', () => {
    expect(pickVideoExtension('https://s3.example.com/run_abc.WEBM')).toBe('webm');
  });

  it('falls back to mp4 for an unrecognized or missing extension', () => {
    expect(pickVideoExtension('https://s3.example.com/run_abc.bin')).toBe('mp4');
    expect(pickVideoExtension('https://s3.example.com/run_abc')).toBe('mp4');
  });

  it('falls back to mp4 on a malformed URL rather than throwing', () => {
    expect(pickVideoExtension('not a url')).toBe('mp4');
  });
});

describe('resolveOutDir', () => {
  it('rejects an empty path with VALIDATION_ERROR', () => {
    expect(() => resolveOutDir('')).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        nextAction: expect.stringContaining('--out'),
      }),
    );
  });

  it('resolves a relative path against cwd', () => {
    const out = resolveOutDir('./tmp/x');
    expect(out).toBe(resolve(process.cwd(), 'tmp', 'x'));
    expect(isAbsolute(out)).toBe(true);
  });

  it('strips a trailing slash', () => {
    const out = resolveOutDir('/tmp/x/');
    expect(out).toBe('/tmp/x');
  });

  // `C:\...` is only recognized as absolute by node:path when the process
  // itself is running on win32 (path.isAbsolute/resolve are platform-native,
  // not path.win32.* explicitly) — these two assertions are only meaningful
  // under an actual Windows runtime, hence gated rather than run everywhere.
  it.runIf(process.platform === 'win32')(
    'strips a trailing backslash (native Windows path)',
    () => {
      const out = resolveOutDir('C:\\Users\\me\\bundle\\');
      expect(out).toBe('C:\\Users\\me\\bundle');
    },
  );

  it.runIf(process.platform === 'win32')(
    'preserves a bare Windows drive root instead of truncating it to a drive-relative path',
    () => {
      expect(resolveOutDir('C:\\')).toBe('C:\\');
    },
  );
});

describe('assertOutDirParentExists', () => {
  it('resolves successfully when parent dir exists', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-parent-'));
    const target = join(tmpDir, 'bundle');
    await expect(assertOutDirParentExists(target)).resolves.toBeUndefined();
  });

  it('resolves for a --out two levels under a missing directory and creates nothing', async () => {
    const noParentBase = mkdtempSync(join(tmpdir(), 'cli-p4-noparent-'));
    try {
      const target = join(noParentBase, 'missing', 'deeper', 'bundle');
      await expect(assertOutDirParentExists(target)).resolves.toBeUndefined();
      // Validation only: the writer creates the directories once the response
      // has been read, never this pre-check.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtemp temp dir, never user input.
      expect(existsSync(join(noParentBase, 'missing'))).toBe(false);
    } finally {
      rmSync(noParentBase, { recursive: true, force: true });
    }
  });

  it('throws VALIDATION_ERROR when parent is not a directory (is a file)', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-parent-'));
    const fileAsParent = join(tmpDir, 'file.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- writes into this test's own mkdtemp temp dir, never user input.
    await writeFile(fileAsParent, 'content');
    const target = join(fileAsParent, 'bundle');
    await expect(assertOutDirParentExists(target)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({
        reason: expect.stringContaining('parent path is not a directory'),
      }),
    });
  });

  it('throws VALIDATION_ERROR when --out points to an existing file', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-parent-'));
    const existingFile = join(tmpDir, 'bundle.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- writes into this test's own mkdtemp temp dir, never user input.
    await writeFile(existingFile, 'content');
    await expect(assertOutDirParentExists(existingFile)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({
        reason: expect.stringContaining('must point to a directory'),
      }),
    });
  });

  it('resolves successfully when --out points to an existing directory', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-parent-'));
    const existingDir = join(tmpDir, 'bundle');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- creates a dir in this test's own mkdtemp temp dir, never user input.
    await mkdir(existingDir);
    await expect(assertOutDirParentExists(existingDir)).resolves.toBeUndefined();
  });

  it('reports a file in the way as "not a directory", even a few levels up', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cli-p4-parent-'));
    const blocker = join(tmpDir, 'blocker');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- writes into this test's own mkdtemp temp dir, never user input.
    await writeFile(blocker, 'not a directory');
    await expect(
      assertOutDirParentExists(join(blocker, 'runs', 'run_x', 'bundle')),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({
        reason: `parent path is not a directory: ${blocker}`,
      }),
    });
  });
});

describe('streamUrlToFile retry', () => {
  const noSleep = () => Promise.resolve();
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stream-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('releases an interrupted body stream and removes its partial file', async () => {
    const dest = join(dir, 'out.bin');
    const shutdown = new ShutdownController();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    let requestSignal: AbortSignal | undefined;
    let calls = 0;
    const fetchImpl = async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (++calls > 1) throw new Error('retry after interrupted stream');
      requestSignal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController = controller;
          controller.enqueue(new TextEncoder().encode('partial artifact'));
        },
      });
      requestSignal?.addEventListener(
        'abort',
        () => bodyController.error(new DOMException('The operation was aborted', 'AbortError')),
        { once: true },
      );
      return new Response(body);
    };
    const pending = streamUrlToFile(
      'https://example.com/x',
      dest,
      fetchImpl as typeof fetch,
      {
        sleep: noSleep,
        shutdownSignal: shutdown.signal,
        shutdown,
      } as Parameters<typeof streamUrlToFile>[3],
    ).catch((err: unknown) => err);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture path built from this test's own mkdtempSync() dir, never user input
    await vi.waitFor(() => expect(existsSync(dest)).toBe(true));
    const trackedDuringBody = shutdown.hasCriticalOperations;
    shutdown.interrupt('SIGINT');
    if (!requestSignal?.aborted) bodyController.error(shutdown.signal.reason);
    expect(await pending).toBe(shutdown.signal.reason);
    expect(trackedDuringBody).toBe(true);
    expect(shutdown.hasCriticalOperations).toBe(false);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture path built from this test's own mkdtempSync() dir, never user input
    expect(existsSync(dest)).toBe(false);
  });

  it('succeeds on the first attempt: file written, fetchImpl called once', async () => {
    const dest = join(dir, 'out.bin');
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response('hello', { status: 200 });
    };
    await streamUrlToFile('https://example.com/x', dest, fetchImpl as typeof globalThis.fetch, {
      sleep: noSleep,
    });
    expect(calls).toBe(1);
  });

  it('retries on transport error and succeeds: fetchImpl called twice, file written', async () => {
    const dest = join(dir, 'out.bin');
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) throw new Error('ECONNRESET socket hang up');
      return new Response('retried-content', { status: 200 });
    };
    await streamUrlToFile('https://example.com/x', dest, fetchImpl as typeof globalThis.fetch, {
      sleep: noSleep,
    });
    expect(calls).toBe(2);
  });

  it('throws TransportError after all retries exhausted', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      throw new Error('ENETUNREACH dns lookup failed');
    };
    let caught: unknown;

    try {
      await streamUrlToFile(
        'https://example.com/x?X-Amz-Signature=secret-token',
        join(dir, 'will-not-be-written'),
        fetchImpl as typeof globalThis.fetch,
        { sleep: noSleep },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({
      name: 'TransportError',
      message: expect.stringContaining('ENETUNREACH'),
    });
    expect(caught).not.toMatchObject({ message: expect.stringContaining('secret-token') });
    expect(calls).toBe(STREAM_URL_MAX_RETRIES);
  });

  it('does NOT retry a non-2xx HTTP response (expired presigned URL)', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response('Forbidden', { status: 403 });
    };
    let caught: unknown;
    const presignedUrl = 'https://example.com/x?X-Amz-Signature=secret-token#download';

    try {
      await streamUrlToFile(
        presignedUrl,
        join(dir, 'will-not-be-written'),
        fetchImpl as typeof globalThis.fetch,
        { sleep: noSleep },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({
      code: 'UNAVAILABLE',
      details: { status: 403, artifactUrl: 'https://example.com/x' },
    });
    const details = (caught as { details?: Record<string, unknown> }).details;
    expect(details).not.toHaveProperty('url');
    expect(JSON.stringify(details)).not.toContain('secret-token');
    expect(calls).toBe(1);
  });

  it('points an expired link at the command that signs new ones', async () => {
    const fetchImpl = async () => new Response('Forbidden', { status: 403 });
    const caught = await streamUrlToFile(
      'https://example.com/x',
      join(dir, 'will-not-be-written'),
      fetchImpl as typeof globalThis.fetch,
      { sleep: noSleep },
    ).catch((err: unknown) => err);

    expect(caught).toMatchObject({
      message: expect.stringContaining('HTTP 403'),
      nextAction: expect.stringContaining('testsprite result get <result-id> --out <dir>'),
    });
    expect((caught as { nextAction: string }).nextAction).not.toContain('testsprite test ');
  });

  it('disables automatic redirects so unsafe redirect targets cannot bypass URL validation', async () => {
    const dest = join(dir, 'out.bin');
    const redirects: Array<RequestInit['redirect']> = [];
    const fetchImpl = async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      redirects.push(init?.redirect);
      return new Response('hello', { status: 200 });
    };

    await streamUrlToFile('https://example.com/x', dest, fetchImpl as typeof globalThis.fetch, {
      sleep: noSleep,
    });

    expect(redirects).toEqual(['error']);
  });

  it('sleeps between retries', async () => {
    const sleepDelays: number[] = [];
    const fetchImpl = async () => {
      throw new Error('flaky');
    };
    await expect(
      streamUrlToFile(
        'https://example.com/x',
        join(dir, 'will-not-be-written'),
        fetchImpl as typeof globalThis.fetch,
        {
          sleep: ms => {
            sleepDelays.push(ms);
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toThrow();
    expect(sleepDelays).toHaveLength(STREAM_URL_MAX_RETRIES - 1);
    expect(sleepDelays.every(d => d > 0)).toBe(true);
  });
});

describe('streamUrlToFile link check', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stream-link-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['http://storage.example.com/a.png', 'only https'],
    ['file:///etc/passwd', 'only https'],
    ['not a url', 'not a URL'],
    ['https://127.0.0.1/a.png', 'local or private address'],
    ['https://[::1]/a.png', 'local or private address'],
    ['https://localhost/a.png', 'local or private address'],
    ['https://storage.localhost./a.png', 'local or private address'],
    ['https://169.254.169.254/latest/meta-data/', 'local or private address'],
    ['https://169.254.10.1/a.png', 'local or private address'],
    ['https://10.0.0.5/a.png', 'local or private address'],
    ['https://192.168.1.10/a.png', 'local or private address'],
    ['https://[::ffff:10.0.0.5]/a.png', 'local or private address'],
  ])('refuses %s before any request', async (url, why) => {
    const fetchImpl = vi.fn();
    const err = await streamUrlToFile(url, join(dir, 'out.bin'), fetchImpl as typeof fetch).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'UNAVAILABLE', exitCode: 10 });
    expect((err as Error).message).toMatch(/^Refused to download /);
    expect((err as Error).message).toContain(why);
    expect(fetchImpl).not.toHaveBeenCalled();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path under this test's own mkdtempSync() directory, never user input
    expect(existsSync(join(dir, 'out.bin'))).toBe(false);
  });

  it('keeps the signature out of the refusal', async () => {
    const err = await streamUrlToFile(
      'http://storage.example.com/a.png?X-Amz-Signature=secret',
      join(dir, 'out.bin'),
      vi.fn() as typeof fetch,
    ).catch((e: unknown) => e);
    expect(
      JSON.stringify([(err as Error).message, (err as { details?: unknown }).details]),
    ).not.toContain('secret');
  });

  it('never repeats a data: link, which is its own content', async () => {
    const err = await streamUrlToFile(
      'data:image/png;base64,SCREENSHOTBYTES',
      join(dir, 'out.bin'),
      vi.fn() as typeof fetch,
    ).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      'Refused to download <data link>: only https links are downloaded.',
    );
    expect(JSON.stringify((err as { details?: unknown }).details)).not.toContain('SCREENSHOT');
  });

  it('judges the host as written: a name is downloaded without being resolved', () => {
    expect(refusedDownloadUrl('https://bucket.s3.us-east-1.amazonaws.com/a.png?sig=1')).toBe(
      undefined,
    );
    expect(refusedDownloadUrl('https://minio.corp.internal:9000/a.png')).toBe(undefined);
    expect(refusedDownloadUrl('https://8.8.8.8/a.png')).toBe(undefined);
  });
});

describe('streamUrlToFile stall timeout', () => {
  const noSleep = () => Promise.resolve();
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stream-stall-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A fetch that answers only when its signal aborts, as a silent server does. */
  const silent = () =>
    vi.fn(
      (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );

  it('gives up on a link that never answers, without retrying it', async () => {
    const fetchImpl = silent();
    const err = await streamUrlToFile(
      'https://storage.example.com/video.webm?X-Amz-Signature=secret',
      join(dir, 'out.bin'),
      fetchImpl as typeof fetch,
      { sleep: noSleep, stallTimeoutMs: 20 },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'UNAVAILABLE', exitCode: 10 });
    expect((err as Error).message).toBe(
      'Download of https://storage.example.com/video.webm stalled: no data for 0s.',
    );
    expect((err as { nextAction?: string }).nextAction).toContain('--request-timeout');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up on a body that stops arriving part-way', async () => {
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('first chunk'));
          init!.signal!.addEventListener('abort', () => controller.error(new Error('aborted')), {
            once: true,
          });
        },
      });
      return new Response(body);
    });
    const err = await streamUrlToFile(
      'https://storage.example.com/video.webm',
      join(dir, 'out.bin'),
      fetchImpl as typeof fetch,
      { sleep: noSleep, stallTimeoutMs: 20 },
    ).catch((e: unknown) => e);
    expect((err as Error).message).toContain('stalled: no data for');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('counts the wait for the response and the wait for its first chunk separately', async () => {
    // 200 ms to answer and 200 ms more to the first chunk: 400 ms in all,
    // each wait inside the 300 ms limit.
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      await wait(200);
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          // As fetch does: an aborted request fails its body.
          init!.signal!.addEventListener('abort', () => controller.error(new Error('aborted')), {
            once: true,
          });
        },
        async pull(controller) {
          if (sent) return controller.close();
          await wait(200);
          controller.enqueue(new TextEncoder().encode('late but alive'));
          sent = true;
        },
      });
      return new Response(body);
    });
    const dest = join(dir, 'out.bin');
    await streamUrlToFile('https://storage.example.com/a.png', dest, fetchImpl as typeof fetch, {
      sleep: noSleep,
      stallTimeoutMs: 300,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path under this test's own mkdtempSync() directory, never user input
    expect(readFileSync(dest, 'utf8')).toBe('late but alive');
  });

  it('gives up on a response without a stream whose bytes never arrive', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          body: null,
          arrayBuffer: () => new Promise<ArrayBuffer>(() => undefined),
        }) as unknown as Response,
    );
    const err = await streamUrlToFile(
      'https://storage.example.com/a.png',
      join(dir, 'out.bin'),
      fetchImpl as typeof fetch,
      { sleep: noSleep, stallTimeoutMs: 20 },
    ).catch((e: unknown) => e);
    expect((err as Error).message).toContain('stalled: no data for');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path under this test's own mkdtempSync() directory, never user input
    expect(existsSync(join(dir, 'out.bin'))).toBe(false);
  });

  it('does not count the time a slow disk takes as time the link was silent', async () => {
    // Every chunk is ready at once; the disk takes 80 ms over each, four
    // times the 20 ms limit.
    const written: string[] = [];
    const slowDisk = new Writable({
      write(chunk: Uint8Array, _encoding, callback) {
        setTimeout(() => {
          written.push(new TextDecoder().decode(chunk));
          callback();
        }, 80);
      },
    });
    const clock = stallClock(20);
    clock.arm();
    await pipeline(
      Readable.from(['a', 'b', 'c'].map(t => Buffer.from(t))),
      stallTimedSink(slowDisk, clock),
    );
    expect(written).toEqual(['a', 'b', 'c']);
    expect(clock.signal.aborted).toBe(false);
  });

  it('a disk that fails is that error, and nothing more is written to it', async () => {
    const writes: string[] = [];
    const fullDisk = new Writable({
      write(chunk: Uint8Array, _encoding, callback) {
        writes.push(new TextDecoder().decode(chunk));
        callback(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }));
      },
    });
    const clock = stallClock(20);
    clock.arm();
    await expect(
      pipeline(
        Readable.from(['a', 'b', 'c'].map(t => Buffer.from(t))),
        stallTimedSink(fullDisk, clock),
      ),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(writes).toEqual(['a']);
    expect(clock.signal.aborted).toBe(false);
  });

  it('does not cap a download that keeps arriving for longer than the timeout', async () => {
    // Four chunks 150 ms apart take 450 ms in all, past the 300 ms stall limit.
    const fetchImpl = vi.fn(async () => {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent > 0) await new Promise(resolve => setTimeout(resolve, 150));
          controller.enqueue(new TextEncoder().encode(`chunk${sent};`));
          if (++sent === 4) controller.close();
        },
      });
      return new Response(body);
    });
    const dest = join(dir, 'out.bin');
    const started = Date.now();
    await streamUrlToFile(
      'https://storage.example.com/video.webm',
      dest,
      fetchImpl as typeof fetch,
      {
        sleep: noSleep,
        stallTimeoutMs: 300,
      },
    );
    expect(Date.now() - started).toBeGreaterThan(300);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path under this test's own mkdtempSync() directory, never user input
    expect(readFileSync(dest, 'utf8')).toBe('chunk0;chunk1;chunk2;chunk3;');
  });
});

describe('assertNoEscape', () => {
  it('returns the resolved path for an in-bounds segment', () => {
    const base = mkdtempSync(join(tmpdir(), 'bundle-test-'));
    expect(assertNoEscape(base, '01-snapshot.html')).toBe(join(base, '01-snapshot.html'));
  });

  it('throws VALIDATION_ERROR for an out-of-bounds segment', () => {
    const base = mkdtempSync(join(tmpdir(), 'bundle-test-'));
    expect(() => assertNoEscape(base, '../../../evil')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });

  it('throws VALIDATION_ERROR for an absolute segment', () => {
    const base = mkdtempSync(join(tmpdir(), 'bundle-test-'));
    expect(() => assertNoEscape(base, '/etc/evil')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    );
  });
});
