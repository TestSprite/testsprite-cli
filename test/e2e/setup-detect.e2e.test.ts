/**
 * Local e2e tests for `setup`'s agent detection, through the real built binary.
 *
 * Every case runs under `--dry-run` against a temp project, so no network, no
 * credentials, and no files are written. The point of testing this end to end
 * rather than only in units: the wiring that decides which targets to install
 * for spans the flag parser, the detector, and `runInstall`, and the failure
 * mode is a successful-looking run that installs for the wrong agent.
 *
 * Run via: `npm run test:e2e` (builds first).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SKILLS, pathFor } from '../../src/lib/agent-targets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

beforeAll(() => {
  if (!existsSync(BIN_PATH)) {
    throw new Error('dist/index.js not found — run `npm run test:e2e` which builds first.');
  }
});

const nativePath = (p: string) => p.split('/').join(sep);

/**
 * A neutral environment. The child inherits this process's env, so an agent
 * variable set by whatever is running the suite would otherwise be detected as
 * the caller — passing locally and failing in CI, or the reverse. `HOME` /
 * `USERPROFILE` are redirected for the same reason credentials are: keep the
 * run out of the real user's files (see setup.e2e.test.ts).
 */
function neutralEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    USERPROFILE: home,
    CLAUDECODE: '',
    CLAUDE_CODE_ENTRYPOINT: '',
    CURSOR_AGENT: '',
  };
}

let currentTmpDir: string | null = null;

function freshProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'ts-detect-e2e-'));
  currentTmpDir = d;
  return d;
}

afterEach(() => {
  if (currentTmpDir !== null) {
    rmSync(currentTmpDir, { recursive: true, force: true });
    currentTmpDir = null;
  }
});

/** Create a file (and its parents) inside the temp project. */
function write(root: string, rel: string, body = 'team convention\n'): void {
  const full = join(root, rel);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture write into this test's own mkdtempSync-created temp project, not user input.
  mkdirSync(dirname(full), { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above.
  writeFileSync(full, body, 'utf8');
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runSetup(project: string, extraArgs: string[] = [], env: Record<string, string> = {}) {
  const result = spawnSync(
    'node',
    [BIN_PATH, 'setup', '--dry-run', '--dir', project, ...extraArgs],
    {
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...neutralEnv(project), ...env },
    },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  } satisfies CliResult;
}

/** The would-write preview line for a target's verify skill. */
const previews = (r: CliResult, target: Parameters<typeof pathFor>[0]) =>
  r.stdout.includes(nativePath(pathFor(target, 'testsprite-verify'))) ||
  r.stderr.includes(nativePath(pathFor(target, 'testsprite-verify')));

describe('setup detects the agents a project uses', () => {
  it('installs for codex when AGENTS.md is the only signal', () => {
    const project = freshProject();
    write(project, 'AGENTS.md', '# Contributing\n\nRun the tests before pushing.\n');

    const r = runSetup(project);

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('detected codex');
    expect(r.stdout).toContain('codex');
    expect(previews(r, 'claude')).toBe(false);
  });

  it('installs for every detected agent when a project uses more than one', () => {
    const project = freshProject();
    write(project, '.clinerules/team-style.md');
    write(project, '.kiro/steering/product.md');

    const r = runSetup(project);

    expect(r.status).toBe(0);
    expect(previews(r, 'cline')).toBe(true);
    expect(previews(r, 'kiro')).toBe(true);
    expect(previews(r, 'claude')).toBe(false);
  });

  it('falls back to claude in an empty project and names the fallback', () => {
    const project = freshProject();

    const r = runSetup(project);

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('no coding agent detected');
    expect(r.stderr).toContain('--agent');
    expect(previews(r, 'claude')).toBe(true);
  });

  it('does not read its own installed skills as a detected agent', () => {
    // Second run in a project the first run wrote to. If our own files counted,
    // the fallback would harden into a permanent answer.
    const project = freshProject();
    for (const skill of DEFAULT_SKILLS) write(project, pathFor('claude', skill), '# skill\n');

    const r = runSetup(project);

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('no coding agent detected');
  });

  it('detects the calling agent from the environment with no repo trace at all', () => {
    const project = freshProject();

    const r = runSetup(project, [], { CURSOR_AGENT: '1' });

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('detected cursor');
    expect(previews(r, 'cursor')).toBe(true);
  });

  it('honours an explicit --agent over both the environment and the repo', () => {
    const project = freshProject();
    write(project, '.cursor/rules/team-style.mdc');

    const r = runSetup(project, ['--agent', 'kiro'], { CLAUDECODE: '1' });

    expect(r.status).toBe(0);
    expect(previews(r, 'kiro')).toBe(true);
    expect(previews(r, 'cursor')).toBe(false);
    expect(r.stderr).not.toContain('detected');
  });
});
