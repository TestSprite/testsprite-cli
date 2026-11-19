/**
 * Local e2e tests for `testsprite setup` (the consolidated onboarding command).
 *
 * Uses the real built binary (`dist/index.js`) against a temp directory.
 * No network or real credentials required — tests use --dry-run or paths that
 * exit before making network calls (--no-agent + expected error).
 *
 * Run via: `npm run test:e2e` (builds first).
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TARGETS, pathFor } from '../../src/lib/agent-targets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

beforeAll(() => {
  if (!existsSync(BIN_PATH)) {
    throw new Error(`dist/index.js not found — run \`npm run test:e2e\` which builds first.`);
  }
});

/**
 * `pathFor` returns POSIX-separated paths, but the CLI prints native ones, so a
 * substring match against its output fails on Windows. Use this whenever a
 * `pathFor` result is compared against CLI output; it is a no-op on POSIX.
 * `join` needs no such treatment — it accepts POSIX input on every platform.
 */
function nativePath(p: string): string {
  return p.split('/').join(sep);
}

/**
 * Redirect the child's home directory. `os.homedir()` — which is how the CLI
 * locates the credentials file — reads `HOME` on POSIX but `USERPROFILE` on
 * Windows, so setting only `HOME` leaves a Windows child reading the real
 * user's credentials instead of the fixture's. Same rule as `hermetic-env.ts`.
 */
function homeEnv(dir: string): Record<string, string> {
  return { HOME: dir, USERPROFILE: dir };
}

let currentTmpDir: string | null = null;

function freshTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ts-setup-e2e-'));
  currentTmpDir = d;
  return d;
}

afterEach(() => {
  if (currentTmpDir !== null) {
    rmSync(currentTmpDir, { recursive: true, force: true });
    currentTmpDir = null;
  }
});

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env?: Record<string, string>): CliResult {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ---------------------------------------------------------------------------
// 1. setup --help surface
// ---------------------------------------------------------------------------

describe('setup --help', () => {
  it('exits 0 and shows the setup command flags', () => {
    const result = runCli(['setup', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--api-key');
    expect(result.stdout).toContain('--from-env');
    expect(result.stdout).toContain('--agent');
    expect(result.stdout).toContain('--no-agent');
    expect(result.stdout).toContain('--force');
    expect(result.stdout).toContain('--dir');
    expect(result.stdout).toContain('--yes');
  });

  it('--help lists all valid agent targets', () => {
    const result = runCli(['setup', '--help']);
    for (const t of Object.keys(TARGETS)) {
      expect(result.stdout, `target "${t}" should be in --help`).toContain(t);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. setup --dry-run + --no-agent: zero writes, no network
// ---------------------------------------------------------------------------

describe('setup --dry-run --no-agent', () => {
  it('exits 0, emits dry-run banner, creates no files', () => {
    const tmpDir = freshTmpDir();
    const credsTmpDir = freshTmpDir();

    const result = runCli(
      ['--dry-run', 'setup', '--api-key', 'sk-user-dry-no-agent', '--no-agent', '--dir', tmpDir],
      homeEnv(credsTmpDir),
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('[dry-run]');
    expect(result.stderr).toContain('no writes or network calls');

    for (const spec of Object.values(TARGETS)) {
      const absPath = join(tmpDir, spec.path);
      expect(existsSync(absPath), `unexpected file: ${absPath}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. setup --dry-run with default claude agent: shows would-write for both skills
// ---------------------------------------------------------------------------

describe('setup --dry-run (with agent)', () => {
  it('exits 0, shows would-write preview for both claude skill files, no files created', () => {
    const tmpDir = freshTmpDir();
    const credsTmpDir = freshTmpDir();

    const result = runCli(
      [
        '--dry-run',
        'setup',
        '--api-key',
        'sk-user-dry-with-agent',
        '--agent',
        'claude',
        '--dir',
        tmpDir,
      ],
      homeEnv(credsTmpDir),
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('[dry-run]');

    // Both skill paths must appear in the dry-run preview
    const verifyPath = pathFor('claude', 'testsprite-verify');
    const onboardPath = pathFor('claude', 'testsprite-onboard');
    expect(result.stderr, 'verify path in dry-run preview').toContain(nativePath(verifyPath));
    expect(result.stderr, 'onboard path in dry-run preview').toContain(nativePath(onboardPath));

    // No files written under dry-run
    expect(existsSync(join(tmpDir, verifyPath))).toBe(false);
    expect(existsSync(join(tmpDir, onboardPath))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Non-interactive + no key source → exit 5
// ---------------------------------------------------------------------------

describe('setup — non-interactive, no key', () => {
  it('exits 5 when no --api-key, no --from-env, and no TTY', () => {
    const tmpDir = freshTmpDir();
    const credsTmpDir = freshTmpDir();

    const result = runCli(['setup', '--yes', '--no-agent', '--dir', tmpDir], homeEnv(credsTmpDir));

    expect(result.status).toBe(5);
    expect(result.stderr).toContain('--api-key');
  });
});

// ---------------------------------------------------------------------------
// 5. Top-level --help: `setup` is listed
// ---------------------------------------------------------------------------

describe('top-level --help', () => {
  it('includes `setup` in the command list', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('setup');
  });
});

// ---------------------------------------------------------------------------
// 6. Matrix-coverage guard — documents the TARGETS set
// ---------------------------------------------------------------------------

describe('matrix coverage guard', () => {
  it('TARGETS matches the documented set (update this list when adding a target)', () => {
    expect(Object.keys(TARGETS)).toEqual([
      'claude',
      'antigravity',
      'cursor',
      'cline',
      'kiro',
      'windsurf',
      'copilot',
      'codex',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 7. rawArgConflict wiring — conflict warn fires through parseAsync
// ---------------------------------------------------------------------------

describe('setup --agent <t> --no-agent conflict warn fires through real binary', () => {
  it('--dry-run --agent cursor --no-agent emits [warn] about conflict on stderr', () => {
    const tmpDir = freshTmpDir();
    const credsTmpDir = freshTmpDir();

    const result = runCli(
      [
        '--dry-run',
        'setup',
        '--api-key',
        'sk-user-conflict-e2e',
        '--agent',
        'cursor',
        '--no-agent',
        '--dir',
        tmpDir,
      ],
      homeEnv(credsTmpDir),
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('[warn]');
    expect(result.stderr).toMatch(/--no-agent.*--agent|--agent.*--no-agent/i);
  });
});
