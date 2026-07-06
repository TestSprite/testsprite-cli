/**
 * `--help` snapshot baseline. Locks the user-facing help surface for v0.1.0
 * so any drift in command names, flag wording, or default values is a
 * conscious reviewer decision (snapshot updates are part of the diff).
 *
 * Lives under `test/`
 * (not `src/`) to mirror the existing subprocess test pattern — the
 * snapshot runs the real built binary and therefore needs a build in
 * `beforeAll`, the same way `test/cli.subprocess.test.ts` does.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

const cases: Array<[string, string[]]> = [
  ['top', ['--help']],
  ['agent', ['agent', '--help']],
  ['agent install', ['agent', 'install', '--help']],
  ['agent list', ['agent', 'list', '--help']],
  ['auth', ['auth', '--help']],
  ['auth configure', ['auth', 'configure', '--help']],
  ['auth whoami', ['auth', 'whoami', '--help']],
  ['auth logout', ['auth', 'logout', '--help']],
  ['init', ['init', '--help']],
  ['project', ['project', '--help']],
  ['project list', ['project', 'list', '--help']],
  ['project get', ['project', 'get', '--help']],
  ['test', ['test', '--help']],
  ['test list', ['test', 'list', '--help']],
  ['test get', ['test', 'get', '--help']],
  ['test code get', ['test', 'code', 'get', '--help']],
  ['test steps', ['test', 'steps', '--help']],
  ['test result', ['test', 'result', '--help']],
  ['test failure get', ['test', 'failure', 'get', '--help']],
  ['test rerun', ['test', 'rerun', '--help']],
  ['test flaky', ['test', 'flaky', '--help']],
  // R5: regression guard for commands that gained new flag wording
  ['test create-batch', ['test', 'create-batch', '--help']],
  ['test run', ['test', 'run', '--help']],
];

describe('--help snapshots', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'pipe' });
  });

  for (const [name, args] of cases) {
    it(name, () => {
      const out = execFileSync('node', [BIN_PATH, ...args], {
        encoding: 'utf8',
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      expect(out).toMatchSnapshot();
    });
  }
});
