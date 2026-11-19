/**
 * `writeEvidence`: a result read with `GET /results/{resultId}` written to a
 * directory as `result.json`, the videos and each step's screenshot and page.
 * The links are signed storage URLs, served here by a scripted fetch.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- every path is under this spec's own mkdtemp directory, never user input. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type { PathLike } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIError, InterruptError } from '../errors.js';
import { globalShutdown } from '../interrupt.js';
import type { ResultDetail, ResultSignIn, ResultStep } from './types.js';
import { planEvidence, writeEvidence } from './evidence.js';

const SIGNATURE = 'X-Amz-Signature=secret';
const link = (path: string): string => `https://storage.example.com/${path}?${SIGNATURE}`;

const step = (
  n: number,
  status: ResultStep['status'],
  more: Partial<ResultStep> = {},
): ResultStep => ({
  stepIndex: String(n),
  type: 'action',
  action: 'click',
  description: `Step ${n}`,
  status,
  selector: '#submit',
  url: 'https://app.example.com/checkout',
  healed: false,
  screenshotSignedUrl: link(`steps/${n}.png`),
  htmlSignedUrl: link(`steps/${n}.html`),
  ...more,
});

const RESULT: ResultDetail = {
  resultId: 'r1',
  runId: 'e1',
  caseKey: 'test_1',
  caseHash: 'hash_1',
  title: 'Checkout shows the order confirmation',
  type: 'frontend',
  testStatus: 'FAILED',
  processStatus: 'Idle',
  processErrorMessage: null,
  error: 'The confirmation heading never appeared.',
  cause: null,
  fix: null,
  blockedReason: null,
  videoUrl: link('video/r1.webm'),
  envId: 'env_1',
  created: '2026-11-10T08:00:00.000Z',
  modified: '2026-11-10T08:01:00.000Z',
  failedStep: step(2, 'failed'),
  steps: [step(1, 'passed'), step(2, 'failed')],
  signIn: null,
};

const SIGN_IN: ResultSignIn = {
  id: 'fa_1',
  status: 'failed',
  videoUrl: link('sign-in/fa_1.mp4'),
  finalUrl: 'https://app.example.com/login',
  stepCount: 1,
  error: 'The password was refused.',
  // A sign-in step has a page snapshot and no screenshot.
  steps: [step(1, 'failed', { screenshotSignedUrl: null, htmlSignedUrl: link('sign-in/1.html') })],
};

/** Storage: each link answers with the bytes of its path, or the status `failing` names. */
function storage(failing: Record<string, number> = {}) {
  return vi.fn(async (input: unknown, _init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const status = failing[url.pathname] ?? 200;
    return status === 200
      ? new Response(`bytes of ${url.pathname}`, { status })
      : new Response('Forbidden', { status });
  });
}

/**
 * `node:fs/promises` as it is, with hooks: every rename recorded and failed on
 * demand, an lstat that answers for one path with another's stats (as a
 * case-insensitive filesystem does), and a look at every writeFile.
 */
const fsHooks = vi.hoisted(() => ({
  renames: [] as Array<{ from: string; to: string }>,
  failRename: (_from: string, _to: string): Error | undefined => undefined,
  lstatAs: new Map<string, string>(),
  onWriteFile: (_path: string): void => undefined,
}));

vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof FsPromises>();
  return {
    ...real,
    rename: async (from: PathLike, to: PathLike): Promise<void> => {
      fsHooks.renames.push({ from: String(from), to: String(to) });
      const failure = fsHooks.failRename(String(from), String(to));
      if (failure !== undefined) throw failure;
      return real.rename(from, to);
    },
    lstat: (path: PathLike) => real.lstat(fsHooks.lstatAs.get(String(path)) ?? path),
    writeFile: (...args: Parameters<typeof real.writeFile>) => {
      fsHooks.onWriteFile(String(args[0]));
      return real.writeFile(...args);
    },
  };
});

/** An error as `node:fs` raises it. */
const fsError = (code: string): Error => Object.assign(new Error(`${code}: rename`), { code });

let parent: string;
let dir: string;
beforeEach(() => {
  fsHooks.renames.length = 0;
  fsHooks.failRename = () => undefined;
  fsHooks.lstatAs.clear();
  fsHooks.onWriteFile = () => undefined;
  parent = mkdtempSync(join(tmpdir(), 'evidence-test-'));
  dir = join(parent, 'evidence');
});
afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

const read = (file: string): string => readFileSync(join(dir, file), 'utf8');
const resultJson = (): ResultDetail => JSON.parse(read('result.json')) as ResultDetail;

/** Every file under `root`, relative to it with `/` between segments, as `written` names them. */
function filesUnder(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

/** Every file under `root` with its content. */
const contentsUnder = (root: string): Record<string, string> =>
  Object.fromEntries(filesUnder(root).map(file => [file, readFileSync(join(root, file), 'utf8')]));

/** The staging directories a download left in `dir`. */
const stagingLeft = (): string[] =>
  readdirSync(dir).filter(entry => entry.startsWith('.testsprite-partial-'));

describe('writeEvidence', () => {
  it('writes result.json, the video and one png + html per step', async () => {
    const out = await writeEvidence(RESULT, { dir, fetchImpl: storage() });
    expect(out).toEqual({
      dir,
      written: [
        'video.webm',
        'steps/001.png',
        'steps/001.html',
        'steps/002.png',
        'steps/002.html',
        'result.json',
      ],
      failed: [],
    });
    expect(filesUnder(dir)).toEqual([...out.written].sort());
    expect(read('video.webm')).toBe('bytes of /video/r1.webm');
    expect(read('steps/002.png')).toBe('bytes of /steps/2.png');
    expect(read('steps/002.html')).toBe('bytes of /steps/2.html');
  });

  it('fetches signed URLs with the bare fetch and no x-api-key header', async () => {
    const fetchImpl = storage();
    await writeEvidence(RESULT, { dir, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).has('x-api-key')).toBe(false);
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(init?.redirect).toBe('error');
    }
  });

  it('downloads the videos first: their links expire soonest', async () => {
    const fetchImpl = storage();
    await writeEvidence({ ...RESULT, testStatus: 'BLOCKED', signIn: SIGN_IN }, { dir, fetchImpl });
    const paths = fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths.slice(0, 2)).toEqual(['/video/r1.webm', '/sign-in/fa_1.mp4']);
  });

  it('a failed download is reported and the other files are still written', async () => {
    const out = await writeEvidence(RESULT, {
      dir,
      fetchImpl: storage({ '/steps/2.png': 403 }),
    });
    expect(out.failed).toEqual([{ file: 'steps/002.png', reason: expect.stringContaining('403') }]);
    expect(out.written).toContain('steps/001.png');
    expect(out.written).toContain('steps/002.html');
    expect(out.written).toContain('result.json');
    expect(out.written).not.toContain('steps/002.png');
    expect(existsSync(join(dir, 'steps', '002.png'))).toBe(false);
    // result.json says which file is missing rather than keeping its link.
    expect(resultJson().steps[1]).toMatchObject({
      screenshotSignedUrl: null,
      htmlSignedUrl: 'steps/002.html',
    });
    expect(resultJson().failedStep).toMatchObject({
      screenshotSignedUrl: null,
      htmlSignedUrl: 'steps/002.html',
    });
  });

  it("a rerun whose files fail keeps each one's earlier copy, and result.json points at it", async () => {
    await writeEvidence(RESULT, { dir, fetchImpl: storage() });
    const earlierVideo = read('video.webm');
    const earlierShot = read('steps/002.png');

    const out = await writeEvidence(RESULT, {
      dir,
      fetchImpl: storage({ '/video/r1.webm': 403, '/steps/2.png': 403 }),
    });
    // Still a failed download (exit 10), and the counts say so.
    expect(out.failed).toEqual([
      { file: 'video.webm', reason: expect.stringContaining('403'), kept: true },
      { file: 'steps/002.png', reason: expect.stringContaining('403'), kept: true },
    ]);
    expect(out.written).not.toContain('video.webm');
    expect(out.written).not.toContain('steps/002.png');
    // The earlier copies are still there, and the new result.json names them.
    expect(read('video.webm')).toBe(earlierVideo);
    expect(read('steps/002.png')).toBe(earlierShot);
    expect(resultJson().videoUrl).toBe('video.webm');
    expect(resultJson().steps[1]).toMatchObject({ screenshotSignedUrl: 'steps/002.png' });
    expect(stagingLeft()).toEqual([]);
  });

  it('a rerun where every file fails leaves the whole earlier set', async () => {
    await writeEvidence(RESULT, { dir, fetchImpl: storage() });
    const before = filesUnder(dir).sort();
    const out = await writeEvidence(RESULT, {
      dir,
      fetchImpl: vi.fn(async () => new Response('Forbidden', { status: 403 })),
    });
    expect(out.written).toEqual(['result.json']);
    expect(out.failed.every(f => f.kept === true)).toBe(true);
    expect(filesUnder(dir).sort()).toEqual(before);
  });

  it("another result's download in the directory is not kept for a file that fails", async () => {
    await writeEvidence({ ...RESULT, resultId: 'r0' }, { dir, fetchImpl: storage() });
    const out = await writeEvidence(RESULT, {
      dir,
      fetchImpl: storage({ '/video/r1.webm': 403 }),
    });
    expect(out.failed).toEqual([{ file: 'video.webm', reason: expect.stringContaining('403') }]);
    expect(existsSync(join(dir, 'video.webm'))).toBe(false);
    expect(resultJson()).toMatchObject({ resultId: 'r1', videoUrl: null });
  });

  it.each([
    ['steps/', 'steps', 'steps/002.png', { '/steps/2.png': 403 }],
    ['sign-in/', 'sign-in', 'sign-in/steps/001.html', { '/sign-in/1.html': 403 }],
  ])(
    'a rerun never keeps an earlier copy reached through a symlinked %s',
    async (_what, linked, file, failing) => {
      const blocked = { ...RESULT, testStatus: 'BLOCKED', signIn: SIGN_IN };
      await writeEvidence(blocked, { dir, fetchImpl: storage() });
      // The earlier directory is swapped for a link to one outside --out that
      // holds a file of the same name.
      const outside = join(parent, 'outside');
      mkdirSync(join(outside, 'steps'), { recursive: true });
      writeFileSync(join(outside, 'steps', '002.png'), 'outside --out');
      writeFileSync(join(outside, 'steps', '001.html'), 'outside --out');
      rmSync(join(dir, linked), { recursive: true });
      symlinkSync(linked === 'steps' ? join(outside, 'steps') : outside, join(dir, linked));

      const out = await writeEvidence(blocked, { dir, fetchImpl: storage(failing) });
      expect(out.failed).toEqual([{ file, reason: expect.stringContaining('403') }]);
      expect(existsSync(join(dir, file))).toBe(false);
      expect(JSON.stringify(resultJson())).not.toContain(file);
      expect(readFileSync(join(outside, 'steps', '002.png'), 'utf8')).toBe('outside --out');
    },
  );

  it('installs no empty steps/ or sign-in/ when none of their files came down', async () => {
    const out = await writeEvidence(
      { ...RESULT, testStatus: 'BLOCKED', signIn: SIGN_IN },
      {
        dir,
        fetchImpl: storage({
          '/steps/1.png': 403,
          '/steps/1.html': 403,
          '/steps/2.png': 403,
          '/steps/2.html': 403,
          '/sign-in/fa_1.mp4': 403,
          '/sign-in/1.html': 403,
        }),
      },
    );
    expect(out.written).toEqual(['video.webm', 'result.json']);
    expect(readdirSync(dir).sort()).toEqual(['result.json', 'video.webm']);
  });

  it('removes a file whose download broke off', async () => {
    // The body starts, then the connection drops, on every attempt.
    const fetchImpl = vi.fn(async (input: unknown): Promise<Response> => {
      if (new URL(String(input)).pathname !== '/video/r1.webm') {
        return new Response('ok', { status: 200 });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('half a video'));
            controller.error(new Error('ECONNRESET'));
          },
        }),
      );
    });
    const out = await writeEvidence(RESULT, { dir, fetchImpl, sleep: () => Promise.resolve() });
    expect(out.failed).toEqual([
      { file: 'video.webm', reason: expect.stringContaining('ECONNRESET') },
    ]);
    expect(existsSync(join(dir, 'video.webm'))).toBe(false);
    expect(resultJson().videoUrl).toBeNull();
    // The reason names the link without its signature.
    expect(JSON.stringify(out)).not.toContain(SIGNATURE);
  });

  it('an interrupt mid-download leaves the earlier download as it was, and no staging directory', async () => {
    await writeEvidence(RESULT, { dir, fetchImpl: storage() });
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    const before = contentsUnder(dir);

    const controller = new AbortController();
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
      if (new URL(String(input)).pathname === '/steps/1.png') {
        controller.abort(new Error('interrupted'));
        throw init?.signal?.reason ?? new Error('aborted');
      }
      return new Response('newer bytes', { status: 200 });
    });
    // A newer read: another video container, so a half-done swap would show.
    const newer: ResultDetail = { ...RESULT, videoUrl: link('video/r2.mp4') };
    await expect(
      writeEvidence(newer, { dir, fetchImpl, signal: controller.signal }),
    ).rejects.toThrow('interrupted');

    expect(contentsUnder(dir)).toEqual(before);
    expect(stagingLeft()).toEqual([]);
  });

  it('a Ctrl-C before anything starts creates no --out directory', async () => {
    const interrupted = AbortSignal.abort(new InterruptError('SIGINT'));
    await expect(
      writeEvidence(RESULT, { dir, fetchImpl: storage(), signal: interrupted }),
    ).rejects.toBeInstanceOf(InterruptError);
    expect(existsSync(dir)).toBe(false);
  });

  it('a Ctrl-C after the last download, before the swap, leaves the earlier download as it was', async () => {
    await writeEvidence(RESULT, { dir, fetchImpl: storage() });
    const before = contentsUnder(dir);
    const controller = new AbortController();
    // It lands while the staged result.json is written, after every download ended.
    fsHooks.onWriteFile = path => {
      if (path.includes('.testsprite-partial-')) controller.abort(new InterruptError('SIGINT'));
    };
    await expect(
      writeEvidence(
        { ...RESULT, videoUrl: link('video/r2.mp4') },
        { dir, fetchImpl: storage(), signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(InterruptError);
    expect(contentsUnder(dir)).toEqual(before);
    expect(stagingLeft()).toEqual([]);
  });

  describe('the swap', () => {
    const newer: ResultDetail = { ...RESULT, videoUrl: link('video/r2.mp4') };
    const movedInto = (path: string): boolean => !path.includes('.testsprite-partial-');

    it('moves result.json out first and in last', async () => {
      await writeEvidence(RESULT, { dir, fetchImpl: storage() });
      fsHooks.renames.length = 0;
      await writeEvidence(newer, { dir, fetchImpl: storage() });
      const aside = fsHooks.renames.filter(({ to }) => to.includes(`${sep}.earlier${sep}`));
      const movedIn = fsHooks.renames.filter(({ to }) => movedInto(to));
      expect(aside).toHaveLength(3);
      expect(aside[0]!.from).toBe(join(dir, 'result.json'));
      expect(movedIn).toHaveLength(3);
      expect(movedIn.at(-1)!.to).toBe(join(dir, 'result.json'));
    });

    it('a move-in that fails puts the earlier download back as it was', async () => {
      await writeEvidence(RESULT, { dir, fetchImpl: storage() });
      writeFileSync(join(dir, 'notes.txt'), 'mine');
      const before = contentsUnder(dir);
      // The last move in fails, once the new video and steps/ are in place.
      fsHooks.failRename = (from, to) =>
        to === join(dir, 'result.json') && !from.includes(`${sep}.earlier${sep}`)
          ? fsError('EPERM')
          : undefined;
      await expect(writeEvidence(newer, { dir, fetchImpl: storage() })).rejects.toMatchObject({
        code: 'EPERM',
      });
      expect(contentsUnder(dir)).toEqual(before);
      expect(stagingLeft()).toEqual([]);
    });

    it('when the earlier download cannot go back either, it stays in the staging directory and the error says where', async () => {
      await writeEvidence(RESULT, { dir, fetchImpl: storage() });
      const before = contentsUnder(dir);
      fsHooks.failRename = (from, to) =>
        (to === join(dir, 'result.json') && !from.includes(`${sep}.earlier${sep}`)) ||
        from.endsWith(`${sep}.earlier${sep}steps`)
          ? fsError('EPERM')
          : undefined;
      const err: unknown = await writeEvidence(newer, { dir, fetchImpl: storage() }).catch(
        (e: unknown) => e,
      );
      const [staging] = stagingLeft();
      const kept = join(dir, staging!, '.earlier');
      expect(err).toBeInstanceOf(CLIError);
      expect((err as Error).message).toContain(kept);
      // result.json went aside first, so it would come back last: without it
      // the directory reads as a download that did not finish.
      expect(existsSync(join(dir, 'result.json'))).toBe(false);
      expect(existsSync(join(dir, 'steps'))).toBe(false);
      expect(readFileSync(join(kept, 'result.json'), 'utf8')).toBe(before['result.json']);
      expect(contentsUnder(join(kept, 'steps'))).toEqual({
        '001.html': before['steps/001.html'],
        '001.png': before['steps/001.png'],
        '002.html': before['steps/002.html'],
        '002.png': before['steps/002.png'],
      });
    });

    it('refuses, before anything moves, when the filesystem takes a file of the user for one it writes', async () => {
      mkdirSync(dir);
      writeFileSync(join(dir, 'RESULT.JSON'), 'mine');
      // An earlier download's video, which a swap would move aside first.
      writeFileSync(join(dir, 'video.mp4'), 'older');
      // A case-insensitive filesystem answers for result.json with RESULT.JSON.
      fsHooks.lstatAs.set(join(dir, 'result.json'), join(dir, 'RESULT.JSON'));
      const fetchImpl = storage();
      const err: unknown = await writeEvidence(RESULT, { dir, fetchImpl }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
      // Refused before any download: the user does not wait for the video first.
      expect(fetchImpl).not.toHaveBeenCalled();
      expect((err as Error).message).toContain('RESULT.JSON');
      expect((err as Error).message).toContain('result.json');
      expect((err as { nextAction: string }).nextAction).toContain('another --out');
      // Refused before the earlier download moved aside: nothing was renamed.
      expect(fsHooks.renames).toEqual([]);
      expect(contentsUnder(dir)).toEqual({ 'RESULT.JSON': 'mine', 'video.mp4': 'older' });
      expect(stagingLeft()).toEqual([]);
    });
  });

  // A directory that cannot be moved stops the swap half-way. POSIX only: a
  // read-only mode does not stop root, and Windows modes do not apply.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a swap that fails half-way puts the earlier download back as it was',
    async () => {
      await writeEvidence(RESULT, { dir, fetchImpl: storage() });
      const before = contentsUnder(dir);
      chmodSync(join(dir, 'steps'), 0o555);
      try {
        await expect(
          writeEvidence(
            { ...RESULT, videoUrl: link('video/r2.mp4') },
            { dir, fetchImpl: storage() },
          ),
        ).rejects.toMatchObject({ code: 'EACCES' });
        expect(contentsUnder(dir)).toEqual(before);
        expect(stagingLeft()).toEqual([]);
      } finally {
        chmodSync(join(dir, 'steps'), 0o755);
      }
    },
  );

  it('is critical work from its first step, so a first Ctrl-C waits for its cleanup', async () => {
    // No file to download: only the download's own scope can be registered.
    const nothing: ResultDetail = { ...RESULT, videoUrl: null, failedStep: null, steps: [] };
    const pending = writeEvidence(nothing, { dir, fetchImpl: storage() });
    expect(globalShutdown.hasCriticalOperations).toBe(true);
    expect((await pending).written).toEqual(['result.json']);
    expect(globalShutdown.hasCriticalOperations).toBe(false);
  });

  it('runs at most 4 downloads at once, the video first', async () => {
    const many: ResultDetail = {
      ...RESULT,
      failedStep: null,
      steps: [1, 2, 3, 4, 5, 6].map(n => step(n, 'passed')),
    };
    const held: Array<() => void> = [];
    let holding = true;
    let inFlight = 0;
    let most = 0;
    let firstAsked!: () => void;
    const first = new Promise<void>(resolve => (firstAsked = resolve));
    let allAsked!: () => void;
    const all = new Promise<void>(resolve => (allAsked = resolve));
    const fetchImpl = vi.fn((input: unknown, _init?: RequestInit): Promise<Response> => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      const released = holding ? new Promise<void>(release => held.push(release)) : undefined;
      if (fetchImpl.mock.calls.length === 1) firstAsked();
      if (fetchImpl.mock.calls.length === 13) allAsked();
      return Promise.resolve(released).then(() => {
        inFlight -= 1;
        return new Response(`bytes of ${new URL(String(input)).pathname}`);
      });
    });

    const pending = writeEvidence(many, { dir, fetchImpl });
    await first;
    // Each download reaches its fetch without waiting on the disk, so every
    // download the limit lets start has been asked for by now.
    expect(held).toHaveLength(4);
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).pathname).toBe('/video/r1.webm');
    // The download is staged inside <dir>, and nothing else in it changes yet.
    expect(readdirSync(dir)).toEqual([expect.stringMatching(/^\.testsprite-partial-/)]);

    // The steps finish first, the last asked first; the video only once every
    // other file has been asked for.
    holding = false;
    for (const release of held.slice(1).reverse()) release();
    await all;
    held[0]!();
    const out = await pending;
    expect(most).toBe(4);
    expect(out.failed).toEqual([]);
    // Listed in the order planned, whatever order they finished in.
    expect(out.written).toEqual([
      'video.webm',
      ...[1, 2, 3, 4, 5, 6].flatMap(n => [`steps/00${n}.png`, `steps/00${n}.html`]),
      'result.json',
    ]);
  });

  describe('result.json', () => {
    it('is the result read, every signed link replaced by the file it was written to', async () => {
      await writeEvidence(
        { ...RESULT, testStatus: 'BLOCKED', signIn: SIGN_IN },
        {
          dir,
          fetchImpl: storage(),
        },
      );
      const written = resultJson();
      expect(written).toEqual({
        ...RESULT,
        testStatus: 'BLOCKED',
        videoUrl: 'video.webm',
        failedStep: {
          ...RESULT.failedStep,
          screenshotSignedUrl: 'steps/002.png',
          htmlSignedUrl: 'steps/002.html',
        },
        steps: [
          {
            ...RESULT.steps[0],
            screenshotSignedUrl: 'steps/001.png',
            htmlSignedUrl: 'steps/001.html',
          },
          {
            ...RESULT.steps[1],
            screenshotSignedUrl: 'steps/002.png',
            htmlSignedUrl: 'steps/002.html',
          },
        ],
        signIn: {
          ...SIGN_IN,
          videoUrl: 'sign-in/video.mp4',
          steps: [
            {
              ...SIGN_IN.steps[0],
              screenshotSignedUrl: null,
              htmlSignedUrl: 'sign-in/steps/001.html',
            },
          ],
        },
      });
      expect(read('sign-in/video.mp4')).toBe('bytes of /sign-in/fa_1.mp4');
      expect(read('sign-in/steps/001.html')).toBe('bytes of /sign-in/1.html');
    });

    it('holds no signed link, and neither does any file in the directory', async () => {
      await writeEvidence({ ...RESULT, signIn: SIGN_IN }, { dir, fetchImpl: storage() });
      for (const file of filesUnder(dir)) {
        expect(read(file), file).not.toContain(SIGNATURE);
        expect(read(file), file).not.toContain('storage.example.com');
      }
    });
  });

  describe('failedOnly', () => {
    const five: ResultDetail = {
      ...RESULT,
      failedStep: step(3, 'failed'),
      steps: [
        step(1, 'passed'),
        step(2, 'passed'),
        step(3, 'failed'),
        step(4, null),
        step(5, null),
      ],
    };

    it('keeps the failed step and one neighbour on each side', async () => {
      const out = await writeEvidence(five, { dir, failedOnly: true, fetchImpl: storage() });
      expect(out.written).toEqual([
        'video.webm',
        'steps/002.png',
        'steps/002.html',
        'steps/003.png',
        'steps/003.html',
        'steps/004.png',
        'steps/004.html',
        'result.json',
      ]);
      // Every step stays in result.json; a step not downloaded has no file.
      const steps = resultJson().steps;
      expect(steps).toHaveLength(5);
      expect(steps.map(s => s.screenshotSignedUrl)).toEqual([
        null,
        'steps/002.png',
        'steps/003.png',
        'steps/004.png',
        null,
      ]);
      expect(resultJson().failedStep).toMatchObject({ screenshotSignedUrl: 'steps/003.png' });
    });

    it('keeps the window around every failed step', async () => {
      const out = await writeEvidence(
        {
          ...five,
          steps: [
            step(1, 'failed'),
            step(2, null),
            step(3, null),
            step(4, null),
            step(5, 'failed'),
          ],
        },
        { dir, failedOnly: true, fetchImpl: storage() },
      );
      expect(out.written.filter(file => file.endsWith('.png'))).toEqual([
        'steps/001.png',
        'steps/002.png',
        'steps/004.png',
        'steps/005.png',
      ]);
    });

    it('with no failed step downloads every step, as it always has', async () => {
      const passed: ResultDetail = {
        ...five,
        testStatus: 'PASSED',
        failedStep: null,
        steps: five.steps.map(s => ({ ...s, status: 'passed' as const })),
      };
      const out = await writeEvidence(passed, { dir, failedOnly: true, fetchImpl: storage() });
      expect(out.written).toEqual([
        'video.webm',
        ...[1, 2, 3, 4, 5].flatMap(n => [`steps/00${n}.png`, `steps/00${n}.html`]),
        'result.json',
      ]);
    });

    it('narrows both lists once any step failed: a list without a failed step keeps no file', async () => {
      // One failed sign-in step and run steps that all passed.
      const mixed: ResultDetail = {
        ...RESULT,
        testStatus: 'BLOCKED',
        failedStep: null,
        steps: [step(1, 'passed'), step(2, 'passed')],
        signIn: SIGN_IN,
      };
      const out = await writeEvidence(mixed, { dir, failedOnly: true, fetchImpl: storage() });
      expect(out.written).toEqual([
        'video.webm',
        'sign-in/video.mp4',
        'sign-in/steps/001.html',
        'result.json',
      ]);
    });

    it('keeps the same window around a failed sign-in step', async () => {
      const signInStep = (n: number, status: ResultStep['status']): ResultStep =>
        step(n, status, { screenshotSignedUrl: null, htmlSignedUrl: link(`sign-in/${n}.html`) });
      const blocked: ResultDetail = {
        ...RESULT,
        testStatus: 'BLOCKED',
        failedStep: null,
        steps: [],
        signIn: {
          ...SIGN_IN,
          stepCount: 5,
          steps: [
            signInStep(1, 'passed'),
            signInStep(2, 'passed'),
            signInStep(3, 'failed'),
            signInStep(4, null),
            signInStep(5, null),
          ],
        },
      };
      const out = await writeEvidence(blocked, { dir, failedOnly: true, fetchImpl: storage() });
      expect(out.written).toEqual([
        'video.webm',
        'sign-in/video.mp4',
        'sign-in/steps/002.html',
        'sign-in/steps/003.html',
        'sign-in/steps/004.html',
        'result.json',
      ]);
      expect(resultJson().signIn!.steps.map(s => s.htmlSignedUrl)).toEqual([
        null,
        'sign-in/steps/002.html',
        'sign-in/steps/003.html',
        'sign-in/steps/004.html',
        null,
      ]);
    });
  });

  describe('file names', () => {
    it('names step files by position, whatever stepIndex holds', async () => {
      const forged: ResultDetail = {
        ...RESULT,
        failedStep: null,
        steps: [
          step(1, 'passed', { stepIndex: '../x' }),
          step(2, 'passed', { stepIndex: '/etc/passwd' }),
        ],
      };
      const out = await writeEvidence(forged, { dir, fetchImpl: storage() });
      expect(out.written).toEqual([
        'video.webm',
        'steps/001.png',
        'steps/001.html',
        'steps/002.png',
        'steps/002.html',
        'result.json',
      ]);
      // Nothing landed beside the directory.
      expect(readdirSync(parent)).toEqual(['evidence']);
    });

    it('names step files by position when stepIndex is numeric but out of line or repeated', async () => {
      const misaligned: ResultDetail = {
        ...RESULT,
        failedStep: null,
        steps: [
          step(1, 'passed', { stepIndex: '9' }),
          step(2, 'passed', { stepIndex: '9' }),
          step(3, 'passed', { stepIndex: null }),
        ],
      };
      const out = await writeEvidence(misaligned, { dir, fetchImpl: storage() });
      expect(out.written.filter(file => file.startsWith('steps/'))).toEqual([
        'steps/001.png',
        'steps/001.html',
        'steps/002.png',
        'steps/002.html',
        'steps/003.png',
        'steps/003.html',
      ]);
      expect(read('steps/002.png')).toBe('bytes of /steps/2.png');
      expect(resultJson().steps.map(s => [s.screenshotSignedUrl, s.htmlSignedUrl])).toEqual([
        ['steps/001.png', 'steps/001.html'],
        ['steps/002.png', 'steps/002.html'],
        ['steps/003.png', 'steps/003.html'],
      ]);
    });

    it('takes the video extension only from the known containers', async () => {
      const out = await writeEvidence(
        {
          ...RESULT,
          videoUrl: 'https://storage.example.com/v/r1.sh%2F..%2Fx?sig',
          steps: [],
          failedStep: null,
        },
        { dir, fetchImpl: storage() },
      );
      expect(out.written).toEqual(['video.mp4', 'result.json']);
    });
  });

  describe('an existing directory', () => {
    it('keeps its other files; result.json, video.*, steps/ and sign-in/ are replaced', async () => {
      mkdirSync(join(dir, 'steps'), { recursive: true });
      mkdirSync(join(dir, 'sign-in'));
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'notes.txt'), 'mine');
      writeFileSync(join(dir, 'video.txt'), 'mine too');
      writeFileSync(join(dir, 'src', 'app.js'), 'app');
      writeFileSync(join(dir, 'result.json'), '{"resultId":"older"}');
      writeFileSync(join(dir, 'video.mp4'), 'an older video');
      writeFileSync(join(dir, 'steps', '009.png'), 'an older step');
      writeFileSync(join(dir, 'sign-in', 'video.mp4'), 'an older sign-in');

      await writeEvidence(RESULT, { dir, fetchImpl: storage() });

      expect(filesUnder(dir)).toEqual(
        [
          'notes.txt',
          'video.txt',
          'src/app.js',
          'result.json',
          'video.webm',
          'steps/001.png',
          'steps/001.html',
          'steps/002.png',
          'steps/002.html',
        ].sort(),
      );
      expect(read('notes.txt')).toBe('mine');
      expect(resultJson().resultId).toBe('r1');
      expect(stagingLeft()).toEqual([]);
    });

    it("never claims a user's Steps/ where case matters, whatever the download then does", async () => {
      mkdirSync(join(dir, 'Steps'), { recursive: true });
      writeFileSync(join(dir, 'Steps', 'mine.txt'), 'mine');
      // A case-sensitive filesystem: steps/ is not there, whatever Steps/ holds.
      fsHooks.lstatAs.set(join(dir, 'steps'), join(dir, 'no-such-entry'));
      // Where case does not matter after all (this test may run on one), the
      // move-in meets Steps/ and the swap is rolled back; where it does, the
      // download lands beside it. Either way Steps/ is the user's.
      await writeEvidence(RESULT, { dir, fetchImpl: storage() }).catch(() => undefined);
      expect(readFileSync(join(dir, 'Steps', 'mine.txt'), 'utf8')).toBe('mine');
      expect(stagingLeft()).toEqual([]);
    });

    it("keeps a user's Steps/ when the download has no steps", async () => {
      mkdirSync(join(dir, 'Steps'), { recursive: true });
      writeFileSync(join(dir, 'Steps', 'mine.txt'), 'mine');
      const out = await writeEvidence(
        { ...RESULT, failedStep: null, steps: [], signIn: null },
        { dir, fetchImpl: storage() },
      );
      expect(out.written).toEqual(['video.webm', 'result.json']);
      expect(readFileSync(join(dir, 'Steps', 'mine.txt'), 'utf8')).toBe('mine');
    });

    it('is created with its missing parents', async () => {
      const deep = join(parent, 'a', 'b', 'evidence');
      const out = await writeEvidence(RESULT, { dir: deep, fetchImpl: storage() });
      expect(out.dir).toBe(deep);
      expect(existsSync(join(deep, 'result.json'))).toBe(true);
    });
  });
});

describe('planEvidence', () => {
  it('lists what a download would write, and touches nothing', () => {
    expect(planEvidence({ ...RESULT, signIn: SIGN_IN }).map(({ file }) => file)).toEqual([
      'video.webm',
      'sign-in/video.mp4',
      'steps/001.png',
      'steps/001.html',
      'steps/002.png',
      'steps/002.html',
      'sign-in/steps/001.html',
    ]);
    expect(existsSync(dir)).toBe(false);
  });
});
