/**
 * A result's evidence on disk, as `result get --out <dir>` writes it:
 *
 *   result.json                  the result read, each signed link replaced by
 *                                the file it was written to, or null
 *   video.<ext>                  the run's recording
 *   steps/<NNN>.png              each step's screenshot; NNN is its position in steps[], from 001
 *   steps/<NNN>.html             each step's page
 *   sign-in/video.<ext>          for a result blocked at sign-in: the sign-in run's recording,
 *   sign-in/steps/<NNN>.png      and each of its steps' files, by position in signIn.steps[]
 *   sign-in/steps/<NNN>.html
 *
 * File names come from positions and the known video containers, never from a
 * server value. The links are signed and expire (the video's after 15
 * minutes), so the download runs right after the read, the videos first.
 */

import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { concurrencyLimiter } from '../concurrency-limiter.js';
import {
  assertNoEscape,
  KNOWN_VIDEO_EXTENSIONS,
  pickVideoExtension,
  streamUrlToFile,
} from '../download.js';
import { ApiError, CLIError, InterruptError } from '../errors.js';
import { ensureStateGitignore, findGitRoot } from '../git-utils.js';
import type { FetchImpl } from '../http.js';
import { globalShutdown } from '../interrupt.js';
import type { ResultDetail, ResultStep } from './types.js';

/** How many steps on each side of a failed one `--failed-only` keeps. */
const FAILED_ONLY_RADIUS = 1;

/** Written last: a directory without it holds a download that did not finish. */
export const RESULT_FILE = 'result.json';

/** How many files download at once. */
const PARALLEL_DOWNLOADS = 4;

/** The download is staged in a directory of this name inside `dir`, then swapped in. */
const STAGING_PREFIX = '.testsprite-partial-';

/** Inside the staging directory: where the earlier download waits while the new one moves in. */
const ASIDE = '.earlier';

const SIGN_IN = 'sign-in/';

/** One file to download: where it goes, relative to the directory, and its signed link. */
export interface EvidenceFile {
  file: string;
  url: string;
}

export interface WrittenEvidence {
  dir: string;
  /** Relative to `dir`, in the order planned; `result.json` last. */
  written: string[];
  /**
   * The files that could not be downloaded, and why. `kept` when `dir` held
   * an earlier download of the same result with that file: its copy stays,
   * and result.json names it.
   */
  failed: Array<{ file: string; reason: string; kept?: true }>;
}

const videoFile = (url: string, under = ''): string => `${under}video.${pickVideoExtension(url)}`;

const stepFile = (under: string, position: number, ext: 'png' | 'html'): string =>
  `${under}steps/${String(position + 1).padStart(3, '0')}.${ext}`;

/** Whether any step of the run or of its sign-in failed. */
export function hasFailedStep(result: ResultDetail): boolean {
  return [...result.steps, ...(result.signIn?.steps ?? [])].some(step => step.status === 'failed');
}

/** The files of `steps` under `under`; when `narrow`, only those of a failed step and its neighbours. */
function stepFiles(steps: readonly ResultStep[], under: string, narrow: boolean): EvidenceFile[] {
  const failed = steps.flatMap((step, position) => (step.status === 'failed' ? [position] : []));
  const kept = (position: number): boolean =>
    !narrow || failed.some(at => Math.abs(position - at) <= FAILED_ONLY_RADIUS);
  return steps.flatMap((step, position) => {
    if (!kept(position)) return [];
    const files: EvidenceFile[] = [];
    if (step.screenshotSignedUrl) {
      files.push({ file: stepFile(under, position, 'png'), url: step.screenshotSignedUrl });
    }
    if (step.htmlSignedUrl) {
      files.push({ file: stepFile(under, position, 'html'), url: step.htmlSignedUrl });
    }
    return files;
  });
}

/**
 * What a download of `result` fetches, in order. Pure: nothing is fetched or
 * written. `failedOnly` keeps the failed steps and their neighbours; with no
 * failed step at all it keeps every step, as `--failed-only` always has.
 */
export function planEvidence(result: ResultDetail, failedOnly = false): EvidenceFile[] {
  const narrow = failedOnly && hasFailedStep(result);
  const files: EvidenceFile[] = [];
  if (result.videoUrl) files.push({ file: videoFile(result.videoUrl), url: result.videoUrl });
  const signInVideo = result.signIn?.videoUrl;
  if (signInVideo) files.push({ file: videoFile(signInVideo, SIGN_IN), url: signInVideo });
  return [
    ...files,
    ...stepFiles(result.steps, '', narrow),
    ...stepFiles(result.signIn?.steps ?? [], SIGN_IN, narrow),
  ];
}

interface DownloadDeps {
  fetchImpl: FetchImpl;
  signal: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  stallTimeoutMs?: number;
}

/**
 * Download a result's evidence into `dir` and write its `result.json`.
 *
 * `dir` is created with its parents. The files download, at most four at a
 * time, into a staging directory inside `dir`; only once every download has
 * ended does the new set replace what an earlier download wrote (`result.json`,
 * `video.<mp4|webm|mov|mkv|avi>`, `steps/`, `sign-in/`), and every other file
 * in `dir` is left alone. A file that cannot be downloaded is listed in
 * `failed` and the rest are still written.
 *
 * An interrupt before the swap starts, an error before it, or a swap that
 * fails part-way leaves the earlier download as it was, and the staging
 * directory is removed. Only when the earlier files cannot all be put back is
 * the staging directory kept, and the error says where they are.
 */
export async function writeEvidence(
  result: ResultDetail,
  opts: {
    dir: string;
    warn?: (message: string) => void;
    failedOnly?: boolean;
    fetchImpl?: FetchImpl;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
    /** How long one file may go without data before it is given up on. */
    stallTimeoutMs?: number;
  },
): Promise<WrittenEvidence> {
  const { dir } = opts;
  const plan = planEvidence(result, opts.failedOnly);
  const deps: DownloadDeps = {
    fetchImpl: opts.fetchImpl ?? globalThis.fetch.bind(globalThis),
    signal: opts.signal ?? globalShutdown.signal,
    sleep: opts.sleep,
    stallTimeoutMs: opts.stallTimeoutMs,
  };
  // Critical work: a first Ctrl-C aborts the downloads and waits for the
  // staging directory to go, rather than exiting with it half written.
  return globalShutdown.runCriticalOperation(async () => {
    if (deps.signal.aborted) throw deps.signal.reason;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the --out directory the user chose.
    await mkdir(dir, { recursive: true });
    // Use the physical destination so a symlink or a nested checkout cannot
    // make an export appear protected by another directory's ignore rules.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the output directory just created.
    const destination = await realpath(dir);
    const repo = findGitRoot(destination);
    for (let at = destination; at !== repo && at !== dirname(at); at = dirname(at)) {
      if (basename(at) === '.testsprite') {
        ensureStateGitignore(at);
        break;
      }
    }
    if (repo) {
      opts.warn?.(
        'Result evidence can contain credentials. Check that Git ignores the exported files before staging changes.',
      );
    }
    // The top-level names this download installs are known from the plan, so
    // a name the filesystem takes for one of them is refused before anything
    // is downloaded; the swap checks again at the end.
    const installs = [...new Set([...plan.map(({ file }) => file.split('/')[0]!), RESULT_FILE])];
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the --out directory the user chose.
    await refuseNamesTheUserHolds(dir, await readdir(dir), installs);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a staging directory under --out, its name checked by assertNoEscape.
    const staging = await mkdtemp(assertNoEscape(dir, STAGING_PREFIX));
    let keepStaging = false;
    try {
      const reasons = await downloadAll(plan, staging, deps);
      const written = plan.filter((_, i) => reasons[i] === null).map(({ file }) => file);
      const failed = plan.flatMap(({ file }, i) => {
        const reason = reasons[i];
        return reason === null || reason === undefined ? [] : [{ file, reason }];
      });
      const kept = await keepEarlierCopies(
        dir,
        staging,
        result.resultId,
        failed.map(({ file }) => file),
      );
      const local = localCopy(result, new Set([...written, ...kept]));
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- result.json in the staging directory, its name checked by assertNoEscape.
      await writeFile(assertNoEscape(staging, RESULT_FILE), `${JSON.stringify(local, null, 2)}\n`);
      // A Ctrl-C up to here leaves the earlier download as it was; once the
      // swap starts, it runs to the end.
      if (deps.signal.aborted) throw deps.signal.reason;
      await swapIn(staging, dir);
      return {
        dir,
        written: [...written, RESULT_FILE],
        failed: failed.map(entry => (kept.has(entry.file) ? { ...entry, kept: true } : entry)),
      };
    } catch (err) {
      keepStaging = err instanceof EarlierDownloadKept;
      throw err;
    } finally {
      if (!keepStaging) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- the staging directory this download made under --out.
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });
}

/**
 * Whether `path`, below `dir`, is a regular file reached through real
 * directories: each directory between `dir` and it is an lstat'ed directory,
 * not a link, and the file is an lstat'ed regular file. `dir` itself, the
 * --out the user chose, is not checked.
 */
async function isRegularFileBelow(dir: string, path: string): Promise<boolean> {
  const names = relative(dir, path).split(sep);
  let at = dir;
  for (const [i, name] of names.entries()) {
    at = join(at, name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a directory or file under the --out directory the user chose, its name checked by assertNoEscape.
    const stats = await lstat(at).catch(() => undefined);
    if (!(i === names.length - 1 ? stats?.isFile() : stats?.isDirectory())) return false;
  }
  return true;
}

/**
 * Stage the earlier copy of each file that failed, when `dir` holds an earlier
 * download of the same result: a rerun after a link stopped working (the
 * video aged out of storage, a permission change) never costs the copy
 * already made. Another result's files are never mixed in. An earlier copy is
 * staged only when, at the moment it is checked, it is a regular file and each
 * directory between `dir` and it is a real directory, not a symlink. The check
 * and the copy are separate calls, so it is not atomic; and result.json, read
 * only to compare its resultId, is read through a link. Returns the files
 * staged.
 */
async function keepEarlierCopies(
  dir: string,
  staging: string,
  resultId: string,
  files: readonly string[],
): Promise<Set<string>> {
  const kept = new Set<string>();
  if (files.length === 0) return kept;
  let earlier: unknown;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- result.json under the --out directory the user chose, its name checked by assertNoEscape.
    earlier = JSON.parse(await readFile(assertNoEscape(dir, RESULT_FILE), 'utf8'));
  } catch {
    return kept;
  }
  const earlierId =
    typeof earlier === 'object' && earlier !== null
      ? (earlier as { resultId?: unknown }).resultId
      : undefined;
  if (earlierId !== resultId) return kept;
  for (const file of files) {
    const from = assertNoEscape(dir, file);
    if (!(await isRegularFileBelow(dir, from))) continue;
    const to = assertNoEscape(staging, file);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a directory in the staging directory, its name checked by assertNoEscape.
    await mkdir(dirname(to), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- from --out into its staging directory, both names checked by assertNoEscape.
    await copyFile(from, to);
    kept.add(file);
  }
  return kept;
}

/** The directories below `root` that the planned files go in, parents before children. */
function directoriesFor(root: string, plan: readonly EvidenceFile[]): string[] {
  const dirs = new Set<string>();
  for (const { file } of plan) {
    for (let at = dirname(assertNoEscape(root, file)); at.length > root.length; at = dirname(at)) {
      dirs.add(at);
    }
  }
  return [...dirs].sort((a, b) => a.length - b.length);
}

/**
 * Download every planned file into `staging`, at most four at a time, in plan
 * order. Returns, per file, null when it was written or the reason it was not.
 * An interrupt rethrows, but only once every download has ended, so none
 * writes into the staging directory after it is removed.
 */
async function downloadAll(
  plan: readonly EvidenceFile[],
  staging: string,
  deps: DownloadDeps,
): Promise<Array<string | null>> {
  const dirs = directoriesFor(staging, plan);
  // The directories first, so each download reaches its fetch at once.
  for (const at of dirs) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a directory in the staging directory, its name checked by assertNoEscape.
    await mkdir(at, { recursive: true });
  }
  const slot = concurrencyLimiter(PARALLEL_DOWNLOADS);
  const outcomes = await Promise.allSettled(
    plan.map(({ file, url }) => slot(() => downloadOne(url, assertNoEscape(staging, file), deps))),
  );
  const stopped = outcomes.find(outcome => outcome.status === 'rejected');
  if (stopped !== undefined) throw stopped.reason;
  // A directory none of whose files came down is not installed. Children go
  // first; removing one that holds a file fails, and it stays.
  for (const at of dirs.reverse()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a directory in the staging directory, its name checked by assertNoEscape.
    await rmdir(at).catch(() => undefined);
  }
  return outcomes.map(outcome => (outcome.status === 'fulfilled' ? outcome.value : null));
}

/** Download one file: null when written, or why it was not. An interrupt rethrows. */
async function downloadOne(url: string, path: string, deps: DownloadDeps): Promise<string | null> {
  try {
    await streamUrlToFile(url, path, deps.fetchImpl, {
      sleep: deps.sleep,
      shutdownSignal: deps.signal,
      stallTimeoutMs: deps.stallTimeoutMs,
    });
    return null;
  } catch (err) {
    if (err instanceof InterruptError || deps.signal.aborted) throw err;
    // A download that broke off leaves what it got, which is not the file.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the staging directory, its name checked by assertNoEscape.
    await rm(path, { force: true }).catch(() => undefined);
    return messageOf(err);
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What an earlier download wrote in `dir`; every other entry is the user's. */
function isEvidenceEntry(entry: string): boolean {
  if (entry === RESULT_FILE || entry === 'steps' || entry === 'sign-in') return true;
  return entry.startsWith('video.') && KNOWN_VIDEO_EXTENSIONS.has(entry.slice('video.'.length));
}

/** A swap that failed and could not put the whole earlier download back. */
class EarlierDownloadKept extends CLIError {
  constructor(aside: string, cause: unknown) {
    super(
      `The new download could not be moved into place (${messageOf(cause)}), and the earlier ` +
        `one could not all be put back: the files missing from the directory are in ${aside}.`,
    );
    this.name = 'EarlierDownloadKept';
  }
}

/**
 * Replace the earlier download in `dir` with the staged one. The earlier
 * entries move aside into the staging directory (which `writeEvidence`
 * removes), `result.json` first; the staged ones move in, `result.json` last,
 * so while the sets change places the directory reads as a download in
 * progress. If a move fails, what moved in comes out and what moved aside goes
 * back, newest first, so `dir` holds the whole earlier set. A restore that
 * fails stops the rest: `result.json` stays out, so the directory reads as a
 * download that did not finish, and the error names where the files are.
 */
async function swapIn(staging: string, dir: string): Promise<void> {
  const aside = assertNoEscape(staging, ASIDE);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a directory in the staging directory, its name checked by assertNoEscape.
  await mkdir(aside);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the --out directory the user chose.
  const names = await readdir(dir);
  const earlier = names.filter(isEvidenceEntry).sort(byResultFile(-1));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the staging directory this download made under --out.
  const staged = (await readdir(staging)).filter(entry => entry !== ASIDE).sort(byResultFile(1));
  await refuseNamesTheUserHolds(dir, names, staged);
  const movedAside: string[] = [];
  const movedIn: string[] = [];
  try {
    for (const entry of earlier) {
      await move(dir, aside, entry);
      movedAside.push(entry);
    }
    for (const entry of staged) {
      await move(staging, dir, entry);
      movedIn.push(entry);
    }
  } catch (err) {
    for (const entry of movedIn.reverse()) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- an entry this download moved into --out, its name checked by assertNoEscape.
      await rm(assertNoEscape(dir, entry), { recursive: true, force: true }).catch(() => undefined);
    }
    for (const entry of movedAside.reverse()) {
      try {
        await move(aside, dir, entry);
      } catch {
        throw new EarlierDownloadKept(aside, err);
      }
    }
    throw err;
  }
}

/**
 * Refuse, before anything moves, an entry this download installs that `dir`
 * already holds under another name: a case-insensitive filesystem (macOS and
 * Windows by default) takes a user's RESULT.JSON for result.json, or their
 * Steps/ for steps/. The names this download owns are not lower-cased
 * instead: where case matters, a user's Steps/ is a directory of its own.
 */
async function refuseNamesTheUserHolds(
  dir: string,
  names: readonly string[],
  staged: readonly string[],
): Promise<void> {
  for (const entry of staged) {
    if (names.includes(entry) || !(await exists(assertNoEscape(dir, entry)))) continue;
    const theirs = names.find(name => name.toLowerCase() === entry.toLowerCase()) ?? entry;
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: `--out holds ${theirs}, which this filesystem takes for the ${entry} that result get writes.`,
        nextAction: 'Pick another --out directory; nothing in this one was changed.',
        requestId: 'local',
        details: { field: 'out', entry, existing: theirs },
      },
    });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path its caller placed under --out with assertNoEscape.
    await lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Orders `result.json` first (-1) or last (1) among the other entries. */
const byResultFile =
  (place: -1 | 1) =>
  (a: string, b: string): number =>
    place * (Number(a === RESULT_FILE) - Number(b === RESULT_FILE));

/** Move `entry` from `fromBase` to `toBase`; both paths are placed here by assertNoEscape. */
async function move(fromBase: string, toBase: string, entry: string): Promise<void> {
  const from = assertNoEscape(fromBase, entry);
  const to = assertNoEscape(toBase, entry);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- both paths were placed under their base by assertNoEscape just above.
  await rename(from, to);
}

/**
 * The result as `result.json` holds it: each signed link replaced by the file
 * it was written to, or null when that file was not downloaded.
 */
function localCopy(result: ResultDetail, written: ReadonlySet<string>): ResultDetail {
  const local = (file: string): string | null => (written.has(file) ? file : null);
  const localSteps = (steps: readonly ResultStep[], under: string): ResultStep[] =>
    steps.map((step, position) => ({
      ...step,
      screenshotSignedUrl: local(stepFile(under, position, 'png')),
      htmlSignedUrl: local(stepFile(under, position, 'html')),
    }));
  const steps = localSteps(result.steps, '');
  // The failed step is a copy of the first failed one in `steps`.
  const failedAt = steps[result.steps.findIndex(step => step.status === 'failed')];
  return {
    ...result,
    videoUrl: result.videoUrl ? local(videoFile(result.videoUrl)) : null,
    failedStep:
      result.failedStep === null
        ? null
        : {
            ...result.failedStep,
            screenshotSignedUrl: failedAt?.screenshotSignedUrl ?? null,
            htmlSignedUrl: failedAt?.htmlSignedUrl ?? null,
          },
    steps,
    signIn:
      result.signIn === null
        ? null
        : {
            ...result.signIn,
            videoUrl: result.signIn.videoUrl
              ? local(videoFile(result.signIn.videoUrl, SIGN_IN))
              : null,
            steps: localSteps(result.signIn.steps, SIGN_IN),
          },
  };
}
