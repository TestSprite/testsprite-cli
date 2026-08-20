/**
 * Local e2e tests for the missing-skill onboarding nudge (lib/skill-nudge.ts).
 *
 * Exercises the real built binary (`dist/index.js`) so the `preAction` hook
 * wiring in `src/index.ts` is verified end-to-end: command-path extraction,
 * global-option plumbing (output / dry-run / profile), credential lookup, and
 * cwd-based skill detection.
 *
 * The hint is emitted in the preAction hook BEFORE any network call, so the
 * "configured + skill absent" cases assert the hint on stderr and ignore the
 * (non-zero) exit from the unreachable endpoint. The dry-run case is fully
 * offline.
 *
 * Run via: `npm run test:e2e` (builds first). Excluded from `npm test`.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TARGETS } from '../../src/lib/agent-targets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

const WARN_SUBSTR = 'No TestSprite verification skill';
// An address with nothing listening → fast ECONNREFUSED. The hint fires before
// the request, so the run's failure is irrelevant to the assertions.
const DEAD_ENDPOINT = 'http://127.0.0.1:9';
const NETWORK_TIMEOUT_MS = 30_000;

beforeAll(() => {
  if (!existsSync(BIN_PATH)) {
    throw new Error('dist/index.js not found — run `npm run test:e2e` which builds first.');
  }
});

const tmpDirs: string[] = [];

function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** A temp HOME containing a credentials file with a configured default profile. */
function homeWithCreds(): string {
  const home = freshDir('ts-nudge-home-');
  mkdirSync(join(home, '.testsprite'), { recursive: true });
  writeFileSync(
    join(home, '.testsprite', 'credentials'),
    `[default]\napi_key = sk-user-fake-nudge\napi_url = ${DEAD_ENDPOINT}\n`,
    'utf8',
  );
  return home;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { cwd: string; home: string }): CliResult {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd,
    timeout: 20_000,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      // `os.homedir()` — how the CLI locates the credentials file — reads HOME
      // on POSIX but USERPROFILE on Windows. Setting only HOME leaves a Windows
      // child reading the real user's credentials instead of the fixture's.
      HOME: opts.home,
      USERPROFILE: opts.home,
      // Neutralize any opt-out inherited from the developer's shell (empty is
      // NOT treated as opted-out by the warning).
      TESTSPRITE_NO_SKILL_WARNING: '',
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('skill nudge — configured caller, skill absent', () => {
  it(
    'emits the warning on a verify-loop command (auth status)',
    () => {
      const proj = freshDir('ts-nudge-proj-');
      const home = homeWithCreds();
      const result = runCli(
        ['auth', 'status', '--endpoint-url', DEAD_ENDPOINT, '--request-timeout', '1'],
        { cwd: proj, home },
      );
      expect(result.stderr).toContain(WARN_SUBSTR);
      expect(result.stderr).toContain('testsprite setup');
    },
    NETWORK_TIMEOUT_MS,
  );
});

describe('skill nudge — suppression gates', () => {
  it('is silent under --dry-run (offline, exit 0)', () => {
    const proj = freshDir('ts-nudge-proj-');
    const home = homeWithCreds();
    const result = runCli(['--dry-run', 'auth', 'whoami'], { cwd: proj, home });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain(WARN_SUBSTR);
  });

  it(
    'is silent when the skill is already installed in the project',
    () => {
      const proj = freshDir('ts-nudge-proj-');
      const home = homeWithCreds();
      // Drop a claude own-file skill so detection finds it.
      const skillPath = join(proj, TARGETS.claude.path);
      mkdirSync(dirname(skillPath), { recursive: true });
      writeFileSync(skillPath, '---\nname: testsprite-verify\n---\nbody\n', 'utf8');

      const result = runCli(
        ['auth', 'status', '--endpoint-url', DEAD_ENDPOINT, '--request-timeout', '1'],
        { cwd: proj, home },
      );
      expect(result.stderr).not.toContain(WARN_SUBSTR);
    },
    NETWORK_TIMEOUT_MS,
  );

  // `test create --plan-template` is pure-local and informational
  // (same family as `setup` / `agent install`) — it must not trip the
  // "test create" entry in SKILL_NUDGE_COMMANDS even with a configured
  // profile and no skill installed. Regression guard for the flag-aware
  // skip added to src/index.ts's preAction hook.
  it('is silent for `test create --plan-template` even with a configured profile and no skill installed', () => {
    const proj = freshDir('ts-nudge-proj-');
    const home = homeWithCreds();
    const result = runCli(['test', 'create', '--plan-template'], { cwd: proj, home });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain(WARN_SUBSTR);
    expect(result.stdout).toContain('"planSteps"');
  });
});
