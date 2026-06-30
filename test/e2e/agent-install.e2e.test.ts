/**
 * Full local e2e suite for `testsprite agent install`.
 *
 * Runs the real built binary (`dist/index.js`) via `spawnSync` against a
 * freshly `mkdtemp`-ed project directory. No network, no credentials — fully
 * CI-runnable.
 *
 * Run via: `npm run test:e2e` (which builds first).
 * Do NOT run via `npm test` — the main vitest.config.ts excludes `test/e2e/**`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MANAGED_SECTION_BEGIN,
  MANAGED_SECTION_END,
  TARGETS,
  renderForTarget,
  type AgentTarget,
} from '../../src/lib/agent-targets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

// ---------------------------------------------------------------------------
// Guard: fail loud if the binary isn't present (run via `npm run test:e2e`)
// ---------------------------------------------------------------------------
beforeAll(() => {
  if (!existsSync(BIN_PATH)) {
    throw new Error(
      `dist/index.js not found — run \`npm run test:e2e\` which builds first. ` +
        `Running vitest directly against this file will fail without a build.`,
    );
  }
});

// ---------------------------------------------------------------------------
// Per-test tmp dir (cleaned after each test)
// ---------------------------------------------------------------------------

let currentTmpDir: string | null = null;

function freshTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ts-agent-e2e-'));
  currentTmpDir = d;
  return d;
}

afterEach(() => {
  if (currentTmpDir !== null) {
    rmSync(currentTmpDir, { recursive: true, force: true });
    currentTmpDir = null;
  }
});

// ---------------------------------------------------------------------------
// Helper: spawn CLI without throwing on non-zero exit codes
// ---------------------------------------------------------------------------

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliResult {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ---------------------------------------------------------------------------
// 1. Fresh install — table-driven over all TARGETS
// ---------------------------------------------------------------------------

describe('fresh install (per target)', () => {
  const allTargets = Object.keys(TARGETS) as AgentTarget[];

  for (const target of allTargets) {
    it(`installs ${target} → exit 0, file at matrix path, action: written/section-installed`, () => {
      const tmpDir = freshTmpDir();
      const result = runCli([
        'agent',
        'install',
        `--target=${target}`,
        '--dir',
        tmpDir,
        '--output',
        'json',
      ]);
      expect(result.status, `exit code for ${target}`).toBe(0);

      // Parse JSON array output
      const parsed = JSON.parse(result.stdout) as Array<{
        target: string;
        path: string;
        action: string;
      }>;
      expect(Array.isArray(parsed), 'output should be a JSON array').toBe(true);
      const entry = parsed.find(r => r.target === target);
      expect(entry, `entry for ${target}`).toBeDefined();

      // managed-section targets report 'section-installed'; own-file targets report 'written'
      const expectedAction =
        TARGETS[target].mode === 'managed-section' ? 'section-installed' : 'written';
      expect(entry!.action, `action for ${target}`).toBe(expectedAction);
      expect(entry!.path).toBe(TARGETS[target].path);

      // File must exist at the matrix path
      const expectedAbsPath = join(tmpDir, TARGETS[target].path);
      expect(existsSync(expectedAbsPath), `file at ${expectedAbsPath}`).toBe(true);

      // Parent dirs must have been created
      expect(existsSync(dirname(expectedAbsPath))).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Content integrity — check every target's written file
// ---------------------------------------------------------------------------

describe('content integrity', () => {
  // own-file targets: full skill body with frontmatter
  const ownFileTargets = (Object.keys(TARGETS) as AgentTarget[]).filter(
    t => TARGETS[t].mode === 'own-file',
  );

  for (const target of ownFileTargets) {
    it(`${target} file has correct structure and load-bearing strings`, () => {
      const tmpDir = freshTmpDir();
      runCli(['agent', 'install', `--target=${target}`, '--dir', tmpDir, '--output', 'json']);

      const filePath = join(tmpDir, TARGETS[target].path);
      const content = readFileSync(filePath, 'utf8');

      // (a) Frontmatter check
      if (target === 'claude' || target === 'antigravity') {
        // Must start with --- (SKILL.md frontmatter)
        expect(content.startsWith('---'), `${target}: should start with ---`).toBe(true);
        expect(content).toContain('name: testsprite-verify');
      } else if (target === 'cursor') {
        expect(content.startsWith('---'), `cursor: should start with ---`).toBe(true);
        expect(content).toContain('alwaysApply: false');
      } else if (target === 'cline') {
        // cline has NO frontmatter fence
        expect(content.startsWith('---'), `cline: must NOT start with ---`).toBe(false);
        // cline body starts with the skill heading
        expect(
          content.trimStart().startsWith('#'),
          `cline: should start with a markdown heading`,
        ).toBe(true);
      }

      // (b) branding — the renamed H1 must be present.

      expect(content).toContain('TestSprite Verification Loop');
      // Match the verification-loop intro line used in the asset
      expect(content).toContain('The verification loop that flies');

      // (c) Load-bearing command strings — a body trim that drops these must fail CI
      expect(content, `${target}: missing 'testsprite test run'`).toContain('testsprite test run');
      expect(content, `${target}: missing '--wait'`).toContain('--wait');
      expect(content, `${target}: missing 'test artifact get'`).toContain('test artifact get');
    });
  }

  // codex: managed-section target — trimmed body, sentinels wrapping content, no frontmatter
  it('codex AGENTS.md contains sentinels and load-bearing command strings', () => {
    const tmpDir = freshTmpDir();
    runCli(['agent', 'install', '--target=codex', '--dir', tmpDir, '--output', 'json']);

    const filePath = join(tmpDir, TARGETS.codex.path);
    const content = readFileSync(filePath, 'utf8');

    // (a) Sentinels must be present
    expect(content).toContain(MANAGED_SECTION_BEGIN);
    expect(content).toContain(MANAGED_SECTION_END);
    // BEGIN must come before END
    expect(content.indexOf(MANAGED_SECTION_BEGIN)).toBeLessThan(
      content.indexOf(MANAGED_SECTION_END),
    );

    // (b) branding (trimmed asset shares the renamed H1)
    expect(content).toContain('TestSprite Verification Loop');

    // (c) No frontmatter fence — AGENTS.md is plain prose
    expect(content.startsWith('---'), 'codex: must NOT start with ---').toBe(false);

    // (d) Load-bearing command strings
    expect(content).toContain('testsprite test run');
    expect(content).toContain('--wait');
    expect(content).toContain('test artifact get');
  });
});

// ---------------------------------------------------------------------------
// 3. Idempotent re-run
// ---------------------------------------------------------------------------

describe('idempotent re-run', () => {
  it('second install exits 0 with action: skipped and file is byte-identical', () => {
    const tmpDir = freshTmpDir();

    // First install
    const first = runCli([
      'agent',
      'install',
      '--target=claude',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(first.status).toBe(0);
    const firstParsed = JSON.parse(first.stdout) as Array<{ action: string }>;
    expect(firstParsed[0]!.action).toBe('written');

    // Capture file content before second run
    const filePath = join(tmpDir, TARGETS.claude.path);
    const contentBefore = readFileSync(filePath, 'utf8');

    // Second install
    const second = runCli([
      'agent',
      'install',
      '--target=claude',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(second.status).toBe(0);
    const secondParsed = JSON.parse(second.stdout) as Array<{ action: string }>;
    expect(secondParsed[0]!.action).toBe('skipped');

    // File must be byte-identical
    const contentAfter = readFileSync(filePath, 'utf8');
    expect(contentAfter).toBe(contentBefore);
  });
});

// ---------------------------------------------------------------------------
// 4. Conflict — hand-edit, re-run without --force → exit 6, blocked
// ---------------------------------------------------------------------------

describe('conflict handling', () => {
  it('exits 6 with action: blocked when file differs and no --force', () => {
    const tmpDir = freshTmpDir();

    // First install
    const first = runCli([
      'agent',
      'install',
      '--target=claude',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(first.status).toBe(0);

    // Hand-edit the file
    const filePath = join(tmpDir, TARGETS.claude.path);
    const originalContent = readFileSync(filePath, 'utf8');
    const editedContent = originalContent + '\n\n<!-- HAND-EDITED: do not overwrite -->';
    writeFileSync(filePath, editedContent, 'utf8');

    // Re-run without --force
    const second = runCli([
      'agent',
      'install',
      '--target=claude',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(second.status).toBe(6);

    // action: blocked in JSON
    const parsed = JSON.parse(second.stdout) as Array<{ action: string }>;
    expect(parsed[0]!.action).toBe('blocked');

    // File must be unchanged (not overwritten)
    expect(readFileSync(filePath, 'utf8')).toBe(editedContent);

    // Stderr must contain --force hint
    expect(second.stderr).toContain('--force');
  });
});

// ---------------------------------------------------------------------------
// 5. Force + backup
// ---------------------------------------------------------------------------

describe('force overwrite with backup', () => {
  it('--force exits 0 with action: updated, file = canonical, .bak holds edited bytes', () => {
    const tmpDir = freshTmpDir();

    // First install
    runCli(['agent', 'install', '--target=claude', '--dir', tmpDir, '--output', 'json']);

    // Hand-edit the file
    const filePath = join(tmpDir, TARGETS.claude.path);
    const editedContent = readFileSync(filePath, 'utf8') + '\n\n<!-- EDITED -->';
    writeFileSync(filePath, editedContent, 'utf8');

    // Re-run with --force
    const forced = runCli([
      'agent',
      'install',
      '--target=claude',
      '--dir',
      tmpDir,
      '--force',
      '--output',
      'json',
    ]);
    expect(forced.status).toBe(0);

    const parsed = JSON.parse(forced.stdout) as Array<{ action: string }>;
    expect(parsed[0]!.action).toBe('updated');

    // File must now equal canonical content
    const { content: canonical } = renderForTarget('claude', 'testsprite-verify');
    expect(readFileSync(filePath, 'utf8')).toBe(canonical);

    // .bak must hold the edited bytes
    const bakPath = filePath + '.bak';
    expect(existsSync(bakPath), '.bak file must exist').toBe(true);
    expect(readFileSync(bakPath, 'utf8')).toBe(editedContent);
  });
});

// ---------------------------------------------------------------------------
// 6. Dry-run — no file created
// ---------------------------------------------------------------------------

describe('dry-run', () => {
  it('--dry-run exits 0, prints path + byte count to stderr, creates no file', () => {
    const tmpDir = freshTmpDir();

    const result = runCli([
      '--dry-run',
      'agent',
      'install',
      '--target=claude',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(0);

    // Stderr shows the intended path (absolute resolved path) and byte count
    // The CLI emits "[dry-run] would write <absPath> (<bytes> bytes)"
    expect(result.stderr).toContain(TARGETS.claude.path);
    // "would write" banner
    expect(result.stderr).toContain('would write');

    // No file created on disk
    const filePath = join(tmpDir, TARGETS.claude.path);
    expect(existsSync(filePath), 'file must NOT be created in dry-run').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Multi-target — all five files land in one invocation
// ---------------------------------------------------------------------------

describe('multi-target install', () => {
  it('--target=claude,cursor,cline,antigravity,codex writes all five targets, exit 0', () => {
    const tmpDir = freshTmpDir();

    const result = runCli([
      'agent',
      'install',
      '--target=claude,cursor,cline,antigravity,codex',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout) as Array<{
      target: string;
      action: string;
      path: string;
    }>;
    const allTargets: AgentTarget[] = ['claude', 'cursor', 'cline', 'antigravity', 'codex'];

    for (const target of allTargets) {
      const entry = parsed.find(r => r.target === target);
      expect(entry, `entry for ${target}`).toBeDefined();

      const expectedAction =
        TARGETS[target].mode === 'managed-section' ? 'section-installed' : 'written';
      expect(entry!.action, `action for ${target}`).toBe(expectedAction);

      const absPath = join(tmpDir, TARGETS[target].path);
      expect(existsSync(absPath), `file at ${absPath}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Unknown target → exit 5, supported list on stderr, nothing written
// ---------------------------------------------------------------------------

describe('unknown target', () => {
  it('--target=bogus exits 5 with supported-target list, nothing written', () => {
    const tmpDir = freshTmpDir();

    const result = runCli([
      'agent',
      'install',
      '--target=bogus',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(5);

    // stderr lists supported targets
    for (const t of Object.keys(TARGETS)) {
      expect(result.stderr, `stderr should mention "${t}"`).toContain(t);
    }

    // Nothing written to disk
    for (const spec of Object.values(TARGETS)) {
      const absPath = join(tmpDir, spec.path);
      expect(existsSync(absPath), `unexpected file at ${absPath}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. managed-section (codex) — lifecycle scenarios
// ---------------------------------------------------------------------------

describe('managed-section (codex target)', () => {
  it('create: AGENTS.md absent → creates file with sentinels, action: section-installed', () => {
    const tmpDir = freshTmpDir();
    const result = runCli([
      'agent',
      'install',
      '--target=codex',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout) as Array<{ target: string; action: string }>;
    const entry = parsed.find(r => r.target === 'codex');
    expect(entry).toBeDefined();
    expect(entry!.action).toBe('section-installed');

    const filePath = join(tmpDir, TARGETS.codex.path);
    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain(MANAGED_SECTION_BEGIN);
    expect(content).toContain(MANAGED_SECTION_END);
  });

  it('append: AGENTS.md exists (no sentinels) → appends section, original preserved, action: section-installed', () => {
    const tmpDir = freshTmpDir();
    const agentsPath = join(tmpDir, 'AGENTS.md');
    const existingContent = '# My Project\n\nExisting project instructions here.\n';
    writeFileSync(agentsPath, existingContent, 'utf8');

    const result = runCli([
      'agent',
      'install',
      '--target=codex',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout) as Array<{ target: string; action: string }>;
    const entry = parsed.find(r => r.target === 'codex');
    expect(entry!.action).toBe('section-installed');

    const content = readFileSync(agentsPath, 'utf8');
    // original content preserved
    expect(content).toContain('My Project');
    expect(content).toContain('Existing project instructions here.');
    // section appended
    expect(content).toContain(MANAGED_SECTION_BEGIN);
    expect(content).toContain(MANAGED_SECTION_END);
    // original comes first (append, not prepend)
    expect(content.indexOf('My Project')).toBeLessThan(content.indexOf(MANAGED_SECTION_BEGIN));
  });

  it('replace: sentinels present → replaces section content, surrounding text preserved, action: section-updated', () => {
    const tmpDir = freshTmpDir();
    const agentsPath = join(tmpDir, 'AGENTS.md');
    const before = '# Intro\n\nBefore content.\n';
    const after = '\n\nAfter content.\n';
    const oldSection = `${MANAGED_SECTION_BEGIN}\nOLD CONTENT\n${MANAGED_SECTION_END}`;
    writeFileSync(agentsPath, `${before}${oldSection}${after}`, 'utf8');

    const result = runCli([
      'agent',
      'install',
      '--target=codex',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout) as Array<{ target: string; action: string }>;
    const entry = parsed.find(r => r.target === 'codex');
    expect(entry!.action).toBe('section-updated');

    const content = readFileSync(agentsPath, 'utf8');
    // surrounding content preserved
    expect(content).toContain('Before content.');
    expect(content).toContain('After content.');
    // old section content replaced
    expect(content).not.toContain('OLD CONTENT');
    // new section content present
    expect(content).toContain(MANAGED_SECTION_BEGIN);
    expect(content).toContain(MANAGED_SECTION_END);
    expect(content).toContain('testsprite test run');
  });

  it('unchanged: re-running on identical sentinels → no write, action: section-unchanged', () => {
    const tmpDir = freshTmpDir();

    // First install
    const first = runCli([
      'agent',
      'install',
      '--target=codex',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(first.status).toBe(0);

    const agentsPath = join(tmpDir, 'AGENTS.md');
    const contentBefore = readFileSync(agentsPath, 'utf8');

    // Second install (same content)
    const second = runCli([
      'agent',
      'install',
      '--target=codex',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(second.status).toBe(0);

    const parsed = JSON.parse(second.stdout) as Array<{ target: string; action: string }>;
    const entry = parsed.find(r => r.target === 'codex');
    expect(entry!.action).toBe('section-unchanged');

    // File must be byte-identical
    expect(readFileSync(agentsPath, 'utf8')).toBe(contentBefore);
  });

  it('corrupt sentinel (BEGIN without END) → exit 5, error message mentions sentinel/corrupt', () => {
    const tmpDir = freshTmpDir();
    const agentsPath = join(tmpDir, 'AGENTS.md');
    // BEGIN present but END is absent — malformed file
    writeFileSync(agentsPath, `${MANAGED_SECTION_BEGIN}\nOrphaned section\n`, 'utf8');

    const result = runCli([
      'agent',
      'install',
      '--target=codex',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(5);
    expect(result.stderr).toMatch(/malformed|corrupt|sentinel/i);
  });

  it('--dry-run: no writes, stderr mentions managed section, action: dry-run', () => {
    const tmpDir = freshTmpDir();

    const result = runCli([
      '--dry-run',
      'agent',
      'install',
      '--target=codex',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(0);

    // JSON action is dry-run
    const parsed = JSON.parse(result.stdout) as Array<{ target: string; action: string }>;
    const entry = parsed.find(r => r.target === 'codex');
    expect(entry!.action).toBe('dry-run');

    // stderr should mention managed section and the path
    expect(result.stderr).toContain('AGENTS.md');

    // No file created
    const agentsPath = join(tmpDir, 'AGENTS.md');
    expect(existsSync(agentsPath), 'AGENTS.md must NOT be created in dry-run').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. Matrix-coverage guard — hardcoded list forces a conscious update when
//     a target is added or removed from TARGETS.
// ---------------------------------------------------------------------------
describe('matrix coverage guard', () => {
  it('TARGETS matches the documented, e2e-covered set (update this list when adding a target)', () => {
    expect(Object.keys(TARGETS)).toEqual(['claude', 'antigravity', 'cursor', 'cline', 'codex']);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap tip (piece-3) — SKIPPED in e2e
// Note: tip coverage lives in src/commands/auth.test.ts. Wiring a /me stub
// for `auth configure` is disproportionate here; the unit tests cover the tip.
// ---------------------------------------------------------------------------
it.skip('bootstrap tip after auth configure — see auth.test.ts for tip coverage', () => {
  // No-op: piece-3 unit tests in src/commands/auth.test.ts cover the tip.
});
