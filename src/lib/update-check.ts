/**
 * Non-blocking "new version available" notice (issue #122), following the
 * pattern of the gh and npm CLIs: at most one npm-registry probe per 24 hours,
 * result cached on disk, advisory printed to stderr so stdout stays parseable.
 *
 * Behavior (`maybeNotifyUpdate`):
 *   1. Gate through `shouldCheckForUpdate`; every gate below must pass.
 *   2. Probe the npm registry for the `latest` dist-tag (1.5s hard timeout).
 *   3. Stamp the cache with `lastCheckMs` (plus `latestKnown` when the probe
 *      succeeded) so the next 24h of invocations skip the network entirely.
 *      The stamp happens even after a failed probe: a dead registry must not
 *      trigger a retry on every command.
 *   4. When `latest` is strictly newer than the running version, write exactly
 *      one advisory line to stderr. The function never throws or rejects and
 *      never alters the exit status of the command it rides along with.
 *
 * Gates, in order (`shouldCheckForUpdate`):
 *   - `TESTSPRITE_NO_UPDATE_NOTIFIER` set to any non-empty value: opted out.
 *     Presence-style, mirroring gh's GH_NO_UPDATE_NOTIFIER: even "0" disables.
 *   - `CI` set to anything except the literal "false": CI logs are not the
 *     place for update nags. `CI=false` explicitly re-enables the notice.
 *   - stderr is not a TTY: piped or redirected output stays clean.
 *   - the on-disk cache is fresh (last probe within the TTL). A missing,
 *     unreadable, corrupt, or wrong-shape cache counts as stale, and so does a
 *     `lastCheckMs` in the future (clock rollback or corrupt data).
 *
 * Why not the npm `update-notifier` package: this CLI's runtime dependency
 * budget is commander + valibot only (package.json). `update-notifier` would
 * add a transitive dependency tree for what Node 20 already ships as
 * primitives (fetch, AbortSignal.timeout, sync fs). Owning the ~100 lines
 * keeps the install size flat and every effect injectable for tests.
 *
 * All effects (env, network, clock, fs, tty, stderr sink) are injectable via
 * `UpdateCheckDeps`, the same dependency-injection style as `skill-nudge.ts`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { VERSION } from '../version.js';
import type { FetchImpl } from './http.js';

/** Re-check interval: 24 hours, expressed in milliseconds. */
export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Env var that disables the update notice entirely. Presence-style: any
 * non-empty value (including "0") opts out. Deliberately stricter than the
 * truthy-style `TESTSPRITE_NO_SKILL_WARNING` because it matches the
 * convention users already know from gh's GH_NO_UPDATE_NOTIFIER.
 */
export const UPDATE_CHECK_OPT_OUT_ENV = 'TESTSPRITE_NO_UPDATE_NOTIFIER';

/**
 * Hard cap for the registry probe, in milliseconds. The probe rides along a
 * real command, so unlike the 120s API budget in `http.ts` it gets a tiny
 * window: a slow registry means "no update info", never a visible delay.
 */
const REGISTRY_TIMEOUT_MS = 1_500;

/**
 * npm registry `latest` dist-tag endpoint for this package. Package name from
 * package.json (`@testsprite/testsprite-cli`); the scope separator must be
 * URL-encoded as %2F per the npm registry API.
 */
const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/@testsprite%2Ftestsprite-cli/latest';

/** On-disk cache shape at `cachePath`; unknown keys are stripped on read. */
const UPDATE_CHECK_CACHE_SCHEMA = v.object({
  lastCheckMs: v.number(),
  latestKnown: v.optional(v.string()),
});

export type UpdateCheckCache = v.InferOutput<typeof UPDATE_CHECK_CACHE_SCHEMA>;

/** Minimal slice of the registry response the notice needs. */
const REGISTRY_LATEST_BODY_SCHEMA = v.object({ version: v.string() });

export interface UpdateCheckDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  /** Clock, epoch milliseconds. */
  now?: () => number;
  /** Cache file; lives next to credentials/config under ~/.testsprite. */
  cachePath?: string;
  readFile?: (path: string) => string;
  writeFile?: (path: string, content: string) => void;
  /** Must create missing parent directories (recursive). */
  mkdir?: (dir: string) => void;
  /** Whether stderr is an interactive terminal. */
  isTTY?: boolean;
  /** Sink for the single advisory line. */
  stderr?: (line: string) => void;
  /** Version the running binary reports. */
  currentVersion?: string;
}

type ResolvedUpdateCheckDeps = Required<UpdateCheckDeps>;

function resolveUpdateCheckDeps(deps: UpdateCheckDeps): ResolvedUpdateCheckDeps {
  return {
    env: deps.env ?? process.env,
    fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    now: deps.now ?? Date.now,
    cachePath: deps.cachePath ?? join(homedir(), '.testsprite', 'update-check.json'),
    readFile: deps.readFile ?? ((path: string) => readFileSync(path, 'utf8')),
    writeFile:
      deps.writeFile ?? ((path: string, content: string) => writeFileSync(path, content, 'utf8')),
    mkdir:
      deps.mkdir ??
      ((dir: string) => {
        mkdirSync(dir, { recursive: true });
      }),
    isTTY: deps.isTTY ?? process.stderr.isTTY === true,
    stderr: deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`)),
    currentVersion: deps.currentVersion ?? VERSION,
  };
}

/**
 * Read and validate the cache file. Every failure mode (missing file,
 * unreadable file, invalid JSON, wrong shape) returns undefined, which the
 * caller treats as "stale, probe again".
 */
function readUpdateCheckCache(resolved: ResolvedUpdateCheckDeps): UpdateCheckCache | undefined {
  try {
    const raw = resolved.readFile(resolved.cachePath);
    const body: unknown = JSON.parse(raw);
    const parsed = v.safeParse(UPDATE_CHECK_CACHE_SCHEMA, body);
    return parsed.success ? parsed.output : undefined;
  } catch {
    // Missing or unreadable cache: treat as stale.
    return undefined;
  }
}

/**
 * Persist the cache, creating the parent directory when missing. Best-effort:
 * every error (read-only home, quota, fs races) is swallowed. A failed write
 * only means the next invocation probes the registry again.
 */
function writeUpdateCheckCache(resolved: ResolvedUpdateCheckDeps, cache: UpdateCheckCache): void {
  try {
    resolved.mkdir(dirname(resolved.cachePath));
    resolved.writeFile(resolved.cachePath, `${JSON.stringify(cache)}\n`);
  } catch {
    // Cache persistence is optional; never surface fs errors to the command.
  }
}

/**
 * True when every gate documented in the module header passes: no opt-out
 * env, not CI (unless CI=false), stderr is a TTY, and the cached check is
 * stale or absent. Order matters: the cheap env gates run before any fs read.
 */
export function shouldCheckForUpdate(deps: UpdateCheckDeps = {}): boolean {
  const resolved = resolveUpdateCheckDeps(deps);

  const optOutValue = resolved.env[UPDATE_CHECK_OPT_OUT_ENV];
  if (optOutValue !== undefined && optOutValue !== '') return false;

  // Any set CI value except the literal "false" counts as CI. The empty
  // string still signals a CI-managed environment; silence wins in doubt.
  const ciValue = resolved.env.CI;
  if (ciValue !== undefined && ciValue !== 'false') return false;

  if (!resolved.isTTY) return false;

  const cache = readUpdateCheckCache(resolved);
  if (cache !== undefined) {
    const elapsedMs = resolved.now() - cache.lastCheckMs;
    // A negative elapsed (lastCheckMs in the future) means clock rollback or
    // corrupt data: treat as stale instead of suppressing the check forever.
    // A NaN lastCheckMs fails both comparisons and lands on stale too.
    if (elapsedMs >= 0 && elapsedMs < UPDATE_CHECK_TTL_MS) return false;
  }

  return true;
}

/**
 * Probe the npm registry for the `latest` dist-tag version of this package.
 * Hard 1.5s timeout via AbortSignal.timeout. ANY failure (network error,
 * timeout, non-2xx status, invalid JSON, wrong shape) resolves to undefined;
 * this function never rejects.
 */
export async function fetchLatestVersion(deps: UpdateCheckDeps = {}): Promise<string | undefined> {
  const resolved = resolveUpdateCheckDeps(deps);
  try {
    const response = await resolved.fetchImpl(REGISTRY_LATEST_URL, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const parsed = v.safeParse(REGISTRY_LATEST_BODY_SCHEMA, body);
    return parsed.success ? parsed.output.version : undefined;
  } catch {
    // Offline, DNS failure, abort, or a non-JSON body: no update info.
    return undefined;
  }
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  hasPrerelease: boolean;
}

/**
 * x.y.z with optional prerelease (after "-") and optional build metadata
 * (after "+"), per the semver 2.0.0 grammar. A leading "v" is tolerated
 * because humans type it; the npm registry never returns one.
 */
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(version: string): ParsedSemver | undefined {
  const match = SEMVER_RE.exec(version.trim());
  if (!match) return undefined;
  const [, majorRaw, minorRaw, patchRaw, prerelease] = match;
  if (majorRaw === undefined || minorRaw === undefined || patchRaw === undefined) return undefined;
  return {
    major: Number(majorRaw),
    minor: Number(minorRaw),
    patch: Number(patchRaw),
    hasPrerelease: prerelease !== undefined,
  };
}

/**
 * Compare two semver strings numerically. Returns -1 when versionA is older
 * than versionB, 1 when newer, 0 when equal. A version carrying a prerelease
 * tag sorts OLDER than the plain release with the same x.y.z core. Prerelease
 * identifiers themselves are not ranked (two prereleases on the same core
 * compare as 0): the registry `latest` tag points at releases, so identifier
 * ordering never decides whether the notice fires. Unparseable input on
 * either side compares as 0, so garbage can never produce a false notice.
 */
export function compareSemver(versionA: string, versionB: string): number {
  const left = parseSemver(versionA);
  const right = parseSemver(versionB);
  if (left === undefined || right === undefined) return 0;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  if (left.hasPrerelease !== right.hasPrerelease) return left.hasPrerelease ? -1 : 1;
  return 0;
}

/**
 * Fire-and-forget update notice. Gates, probes, stamps the cache, and prints
 * at most one stderr line when the registry version is strictly newer than
 * the running one. Never throws and never rejects: any failure in any
 * injected dependency (clock, fs, network, the stderr sink itself) is
 * swallowed, because an advisory must never break or delay a real command.
 */
export async function maybeNotifyUpdate(deps: UpdateCheckDeps = {}): Promise<void> {
  try {
    const resolved = resolveUpdateCheckDeps(deps);
    if (!shouldCheckForUpdate(resolved)) return;

    const latest = await fetchLatestVersion(resolved);

    // Stamp even on a failed probe so a dead registry is retried at most
    // once per TTL window, not on every invocation.
    writeUpdateCheckCache(resolved, {
      lastCheckMs: resolved.now(),
      ...(latest === undefined ? {} : { latestKnown: latest }),
    });

    if (latest === undefined) return;
    if (compareSemver(latest, resolved.currentVersion) !== 1) return;

    // User-facing advisory copy (exact format specified by issue #122), not a
    // diagnostic log line; stderr keeps stdout parseable for scripts.
    resolved.stderr(
      `A new version of testsprite-cli is available: ${resolved.currentVersion} -> ${latest}. ` +
        `Run npm install -g @testsprite/testsprite-cli to update. ` +
        `(Disable with ${UPDATE_CHECK_OPT_OUT_ENV}=1)`,
    );
  } catch {
    // An update notice must never break, delay, or alter the exit status of
    // the command it accompanies. Swallow everything.
  }
}
