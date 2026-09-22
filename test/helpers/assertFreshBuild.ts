import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Fail-fast invariant for suites that spawn the built `dist/index.js`.
 *
 * `test/global-setup.ts` builds exactly once per `vitest` INVOCATION —
 * which is correct for `npm test` / CI, but under `npm run test:watch`
 * a source edit re-runs the suites WITHOUT re-running globalSetup, so a
 * subprocess suite would silently exercise a stale binary (false green /
 * false red). Rebuilding here would reintroduce the build race that
 * `globalSetup` exists to avoid, so instead this check is read-only: if
 * anything under `src/` is newer than the built entrypoint, throw with
 * instructions rather than let a stale binary masquerade as the code
 * under test.
 */
export function assertFreshBuild(repoRoot: string, binPath: string): void {
  if (!existsSync(binPath)) {
    throw new Error(
      `Built CLI not found at ${binPath}. Expected test/global-setup.ts to build it before this suite runs.`,
    );
  }
  const binMtime = statSync(binPath).mtimeMs;
  const newest = newestMtimeUnder(join(repoRoot, 'src'));
  if (newest > binMtime) {
    throw new Error(
      `dist/ is stale: a file under src/ is newer than ${binPath}. ` +
        `Vitest watch mode re-runs suites without re-running globalSetup's build — ` +
        `run \`npm run build\` (or restart \`npm test\`) so this suite spawns the code under test.`,
    );
  }
}

function newestMtimeUnder(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const mtime = entry.isDirectory() ? newestMtimeUnder(path) : statSync(path).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}
