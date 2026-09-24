/**
 * Inline "your CLI is below the backend's minimum supported version" advisory.
 *
 * The backend advertises its supported floor on every `/api/cli/v1` response via
 * the `X-TestSprite-CLI-Min-Version` header. Unlike the npm-registry update
 * notice (`update-check.ts`, which runs in a Commander `preAction` hook before
 * any HTTP request), this advisory reacts to a header observed *during* the
 * request, so it is emitted from the HTTP layer's `onServerVersion` hook (wired
 * in `client-factory.ts`) rather than the pre-request notifier — no cross-run
 * cache needed.
 *
 * Distinct from the update notice on purpose, and non-redundant: this names the
 * backend FLOOR and fires only when the running version is strictly below it (a
 * serious "you will be rejected once enforcement is on" state); the update
 * notice names the npm LATEST and fires whenever a newer release exists. Each
 * owns its own number — the backend never advertises "latest".
 *
 * Under GitHub Actions the same below-floor observation is surfaced as a
 * `::warning::` workflow command instead (see {@link formatPinnedVersionWarning}):
 * a `ci init`-generated workflow pins `cli-version` to the version that
 * generated it, so the job keeps running that version forever and the plain
 * stderr line (TTY-gated) would never be seen. The floor header is the only
 * version signal a CI run has in-process — the npm update check is skipped
 * under `CI` by design — so this fires only when the pin has fallen BELOW the
 * floor, not merely behind the newest release.
 *
 * Reuses `compareSemver` and the `TESTSPRITE_NO_UPDATE_NOTIFIER` opt-out from
 * `update-check.ts` so the gating and semver semantics stay consistent.
 */
import { compareSemver, UPDATE_CHECK_OPT_OUT_ENV } from './update-check.js';
import { VERSION } from '../version.js';

/** Version-compatibility signal observed on a backend response (the floor). */
export interface ServerVersionInfo {
  minVersion?: string;
}

export interface VersionNoticeDeps {
  /** Version the running binary reports. Defaults to the built-in `VERSION`. */
  currentVersion?: string;
  env?: NodeJS.ProcessEnv;
  /** Whether stderr is an interactive terminal. */
  isTTY?: boolean;
  /** The command's `--output` mode; `'json'` suppresses the advisory. */
  outputMode?: string;
  /** Suppress under `--dry-run` (the dry-run fetch returns no real headers). */
  dryRun?: boolean;
  /** Sink for the single advisory line. */
  stderr?: (line: string) => void;
}

/**
 * The gates every advisory shares: opt-out env, dry-run, a present + parseable
 * floor, and the running version strictly below it. Pure.
 */
function isBelowFloor(info: ServerVersionInfo, deps: VersionNoticeDeps): boolean {
  const env = deps.env ?? process.env;
  const currentVersion = deps.currentVersion ?? VERSION;

  const optOut = env[UPDATE_CHECK_OPT_OUT_ENV];
  if (optOut !== undefined && optOut !== '') return false;
  if (deps.dryRun === true) return false;

  const minVersion = info.minVersion;
  if (!minVersion) return false;

  // compareSemver returns -1 when the first arg is OLDER than the second.
  // Unparseable input on either side compares as 0, so garbage never warns.
  return compareSemver(currentVersion, minVersion) === -1;
}

/**
 * True when every gate passes and the running version is strictly below the
 * advertised floor. Gates mirror the update notice: opt-out env, JSON output,
 * dry-run, and non-TTY all suppress. Pure — no side effects, no process state.
 */
export function shouldWarnBelowFloor(
  info: ServerVersionInfo,
  deps: VersionNoticeDeps = {},
): boolean {
  const isTTY = deps.isTTY ?? process.stderr.isTTY === true;
  if (deps.outputMode === 'json') return false;
  if (!isTTY) return false;
  return isBelowFloor(info, deps);
}

/**
 * True when the below-floor state should be surfaced as a GitHub Actions
 * `::warning::` annotation: running under Actions (`GITHUB_ACTIONS=true`), not
 * opted out, not dry-run, and strictly below the floor. Deliberately NOT gated
 * on TTY or `--output json` — an Actions job is never a TTY, and a workflow
 * command is parsed by the runner from either stream, so it can ride stderr
 * without touching a JSON envelope on stdout.
 */
export function shouldWarnPinnedInActions(
  info: ServerVersionInfo,
  deps: VersionNoticeDeps = {},
): boolean {
  const env = deps.env ?? process.env;
  if (env.GITHUB_ACTIONS !== 'true') return false;
  return isBelowFloor(info, deps);
}

/**
 * The single advisory line. Names the floor (the backend's authority) and the
 * upgrade command — it deliberately does NOT name a target release; the npm
 * update-notice is the single source of truth for the newest version.
 */
export function formatBelowFloorNotice(currentVersion: string, minVersion: string): string {
  return (
    `Your testsprite-cli (${currentVersion}) is below the minimum supported version ${minVersion}. ` +
    `Upgrade: npm install -g @testsprite/testsprite-cli ` +
    `(disable this notice with ${UPDATE_CHECK_OPT_OUT_ENV}=1).`
  );
}

/**
 * The GitHub Actions workflow-command form of the advisory. Names the pinned
 * (running) version, the floor it has fallen below, and the one command that
 * re-pins the workflow to a current release. Both versions come from semver
 * strings that already parsed (see `isBelowFloor`), so no command-data escaping
 * is needed — neither can carry `%`, CR or LF.
 */
export function formatPinnedVersionWarning(currentVersion: string, minVersion: string): string {
  return (
    `::warning title=TestSprite::testsprite-cli ${currentVersion} is pinned in this workflow ` +
    `and is below the minimum supported version ${minVersion}. ` +
    `Regenerate with testsprite ci init github --force.`
  );
}

/** Module-level guard: at most one below-floor advisory per process. */
let warnedThisProcess = false;

/** Test-only: reset the once-per-process guard between cases. */
export function resetBelowFloorNoticeState(): void {
  warnedThisProcess = false;
}

/**
 * Emit the below-floor advisory at most once per process. Wired to the HTTP
 * client's `onServerVersion` hook. Never throws — an advisory must not break or
 * delay the command it rides along with. Under GitHub Actions the advisory is
 * the `::warning::` workflow command (annotates the job) instead of the plain
 * TTY line; exactly one of the two is ever emitted.
 */
export function noteServerVersion(info: ServerVersionInfo, deps: VersionNoticeDeps = {}): void {
  try {
    if (warnedThisProcess) return;

    const inActions = shouldWarnPinnedInActions(info, deps);
    if (!inActions && !shouldWarnBelowFloor(info, deps)) return;

    const minVersion = info.minVersion;
    if (!minVersion) return;

    const currentVersion = deps.currentVersion ?? VERSION;
    const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderr(
      inActions
        ? formatPinnedVersionWarning(currentVersion, minVersion)
        : formatBelowFloorNotice(currentVersion, minVersion),
    );
    warnedThisProcess = true;
  } catch {
    // Advisory is best-effort; never surface its failures to the command.
  }
}
