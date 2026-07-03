/**
 * Local e2e tests for `testsprite setup` (the consolidated onboarding command)
 * and its hidden, deprecated `init` alias.
 *
 * Uses the real built binary (`dist/index.js`) against a temp directory.
 * No network or real credentials required — tests use --dry-run or paths that
 * exit before making network calls (--no-agent + expected error).
 *
 * Run via: `npm run test:e2e` (builds first).
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
      ['--dry-run', 'setup', '--api-key', 'sk-dry-no-agent', '--no-agent', '--dir', tmpDir],
      { HOME: credsTmpDir },
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
        'sk-dry-with-agent',
        '--agent',
        'claude',
        '--dir',
        tmpDir,
      ],
      { HOME: credsTmpDir },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('[dry-run]');

    // Both skill paths must appear in the dry-run preview
    const verifyPath = pathFor('claude', 'testsprite-verify');
    const onboardPath = pathFor('claude', 'testsprite-onboard');
    expect(result.stderr, 'verify path in dry-run preview').toContain(verifyPath);
    expect(result.stderr, 'onboard path in dry-run preview').toContain(onboardPath);

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

    const result = runCli(['setup', '--yes', '--no-agent', '--dir', tmpDir], {
      HOME: credsTmpDir,
    });

    expect(result.status).toBe(5);
    expect(result.stderr).toContain('--api-key');
  });
});

// ---------------------------------------------------------------------------
// 5. Top-level --help: `setup` is listed; deprecated `init` is hidden
// ---------------------------------------------------------------------------

describe('top-level --help', () => {
  it('includes `setup` in the command list', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('setup');
  });

  it('does NOT list the deprecated `init` alias (hidden)', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    // `init` must not appear as a top-level command entry. Guard against a
    // loose substring match (e.g. inside "initialize") by checking the command
    // column convention: a line beginning with optional spaces then `init`.
    const lists = result.stdout.split('\n').some(l => /^\s+init(\s|$)/.test(l));
    expect(lists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Deprecated `init` alias still works (hidden) and warns
// ---------------------------------------------------------------------------

describe('deprecated `init` alias', () => {
  it('still runs (exit 0 under --dry-run --no-agent) and prints a deprecation notice', () => {
    const tmpDir = freshTmpDir();
    const credsTmpDir = freshTmpDir();

    const result = runCli(
      ['--dry-run', 'init', '--api-key', 'sk-dep-init', '--no-agent', '--dir', tmpDir],
      { HOME: credsTmpDir },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('[deprecated]');
    expect(result.stderr).toContain('testsprite setup');
    // Still performs the (dry-run) setup preview.
    expect(result.stderr).toContain('[dry-run]');
  });

  it('init --help still works (exit 0) for anyone on the old command', () => {
    const result = runCli(['init', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--api-key');
  });
});

// ---------------------------------------------------------------------------
// 7. Matrix-coverage guard — documents the TARGETS set
// ---------------------------------------------------------------------------

describe('matrix coverage guard', () => {
  it('TARGETS matches the documented set (update this list when adding a target)', () => {
    expect(Object.keys(TARGETS)).toEqual([
      'claude',
      'antigravity',
      'cursor',
      'cline',
      'kiro',
      'codex',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 8. rawArgConflict wiring — conflict warn fires through parseAsync
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
        'sk-conflict-e2e',
        '--agent',
        'cursor',
        '--no-agent',
        '--dir',
        tmpDir,
      ],
      { HOME: credsTmpDir },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('[warn]');
    expect(result.stderr).toMatch(/--no-agent.*--agent|--agent.*--no-agent/i);
  });
});
