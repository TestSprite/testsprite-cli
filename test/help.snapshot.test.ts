/**
 * `--help` snapshot baseline. Locks the user-facing help surface for v0.1.0
 * so any drift in command names, flag wording, or default values is a
 * conscious reviewer decision (snapshot updates are part of the diff).
 *
 * Lives under `test/`
 * (not `src/`) to mirror the existing subprocess test pattern — the
 * snapshot runs the real built binary. The build itself happens exactly
 * once in `test/global-setup.ts`, before any test file runs, so
 * this suite only asserts the binary is there rather than rebuilding it
 * itself.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertFreshBuild } from './helpers/assertFreshBuild.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

const cases: Array<[string, string[]]> = [
  ['top', ['--help']],
  ['plan', ['plan', '--help']],
  ['apply', ['apply', '--help']],
  ['reject', ['reject', '--help']],
  ['reply', ['reply', '--help']],
  ['status', ['status', '--help']],
  ['stop', ['stop', '--help']],
  ['discard', ['discard', '--help']],
  ['agent', ['agent', '--help']],
  ['agent install', ['agent', 'install', '--help']],
  ['agent list', ['agent', 'list', '--help']],
  ['auth', ['auth', '--help']],
  ['project', ['project', '--help']],
  ['project list', ['project', 'list', '--help']],
  ['project get', ['project', 'get', '--help']],
  ['project create', ['project', 'create', '--help']],
  ['project update', ['project', 'update', '--help']],
  ['project env create', ['project', 'env', 'create', '--help']],
  ['project env update', ['project', 'env', 'update', '--help']],
  ['test', ['test', '--help']],
  ['test list', ['test', 'list', '--help']],
  ['test get', ['test', 'get', '--help']],
  ['run', ['run', '--help']],
  ['run wait', ['run', 'wait', '--help']],
  ['run cancel', ['run', 'cancel', '--help']],
  ['result', ['result', '--help']],
  ['result list', ['result', 'list', '--help']],
  ['result get', ['result', 'get', '--help']],
  ['testlist', ['testlist', '--help']],
  ['testlist list', ['testlist', 'list', '--help']],
  ['testlist get', ['testlist', 'get', '--help']],
  ['testlist create', ['testlist', 'create', '--help']],
  ['testlist update', ['testlist', 'update', '--help']],
  ['testlist delete', ['testlist', 'delete', '--help']],
  ['testlist add', ['testlist', 'add', '--help']],
  ['testlist remove', ['testlist', 'remove', '--help']],
  ['ci', ['ci', '--help']],
  ['ci run', ['ci', 'run', '--help']],
  ['ci init', ['ci', 'init', '--help']],
  ['tunnel', ['tunnel', '--help']],
  ['tunnel start', ['tunnel', 'start', '--help']],
  ['tunnel list', ['tunnel', 'list', '--help']],
  ['tunnel stop', ['tunnel', 'stop', '--help']],
  ['tunnel status', ['tunnel', 'status', '--help']],
];

describe('--help snapshots', () => {
  beforeAll(() => {
    // Missing OR stale (watch-mode reruns skip globalSetup's build) → fail
    // fast instead of snapshotting a binary that isn't the code under test.
    assertFreshBuild(REPO_ROOT, BIN_PATH);
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
