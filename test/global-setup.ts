/**
 * Vitest `globalSetup` for the main unit suite (`npm test` / `npm run
 * test:coverage`).
 *
 * Builds the CLI exactly once, synchronously, in the main process BEFORE
 * any test file is collected or run.
 *
 * `test/cli.subprocess.test.ts` and `test/help.snapshot.test.ts` both spawn
 * the built `dist/index.js` as a real child process, and used to rebuild it
 * themselves inside their own `beforeAll`. On a cold or contended `dist/`
 * (notably the public `release.yaml` gate, where `test:coverage` runs
 * BEFORE the explicit `build` step) two independent in-suite rebuilds could
 * overlap with a concurrent spawn of the binary they were still writing,
 * producing a flaky non-zero exit unrelated to the assertion under test.
 *
 * `globalSetup` runs once, before any worker spawns — building here instead
 * guarantees a single, complete build finishes before Vitest ever imports
 * or spawns anything, eliminating the race at the root rather than papering
 * over it with `fileParallelism: false` alone (kept for other hermeticity
 * reasons, but no longer load-bearing for this specific flake).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execNpm } from './helpers/execNpm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export default function setup(): void {
  execNpm(['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' });
}
