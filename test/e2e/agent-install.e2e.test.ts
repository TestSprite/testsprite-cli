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
  SKILLS,
  DEFAULT_SKILLS,
  pathFor,
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
    it(`installs ${target} → exit 0, all skill files land, action: written/section-installed`, () => {
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
        skills: string[];
      }>;
      expect(Array.isArray(parsed), 'output should be a JSON array').toBe(true);

      if (TARGETS[target].mode === 'managed-section') {
        // codex: ONE result aggregating all skills
        const entry = parsed.find(r => r.target === target);
        expect(entry, `entry for ${target}`).toBeDefined();
        expect(entry!.action, `action for ${target}`).toBe('section-installed');
        expect(entry!.path).toBe(TARGETS[target].path);
        const absPath = join(tmpDir, TARGETS[target].path);
        expect(existsSync(absPath), `file at ${absPath}`).toBe(true);
        expect(existsSync(dirname(absPath))).toBe(true);
      } else {
        // own-file: one result per skill, one file per skill
        for (const skill of DEFAULT_SKILLS) {
          const entry = parsed.find(r => r.target === target && r.path === pathFor(target, skill));
          expect(entry, `entry for ${target}/${skill}`).toBeDefined();
          expect(entry!.action, `action for ${target}/${skill}`).toBe('written');

          const absPath = join(tmpDir, pathFor(target, skill));
          expect(existsSync(absPath), `file at ${absPath}`).toBe(true);
          expect(existsSync(dirname(absPath))).toBe(true);
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Content integrity — check every target's written file
// ---------------------------------------------------------------------------

describe('content integrity', () => {
  // own-file targets: both skill files land with correct structure
  const ownFileTargets = (Object.keys(TARGETS) as AgentTarget[]).filter(
    t => TARGETS[t].mode === 'own-file',
  );

  for (const target of ownFileTargets) {
    it(`${target} testsprite-verify file has correct structure and load-bearing strings`, () => {
      const tmpDir = freshTmpDir();
      runCli(['agent', 'install', `--target=${target}`, '--dir', tmpDir, '--output', 'json']);

      const filePath = join(tmpDir, pathFor(target, 'testsprite-verify'));
      const content = readFileSync(filePath, 'utf8');

      // (a) Frontmatter check
      if (target === 'claude' || target === 'antigravity') {
        expect(content.startsWith('---'), `${target}: should start with ---`).toBe(true);
        expect(content).toContain('name: testsprite-verify');
      } else if (target === 'cursor') {
        expect(content.startsWith('---'), `cursor: should start with ---`).toBe(true);
        expect(content).toContain('alwaysApply: false');
      } else if (target === 'cline') {
        expect(content.startsWith('---'), `cline: must NOT start with ---`).toBe(false);
        expect(
          content.trimStart().startsWith('#'),
          `cline: should start with a markdown heading`,
        ).toBe(true);
      } else if (target === 'windsurf') {
        // Windsurf Cascade frontmatter: trigger + description (no name/alwaysApply)
        expect(content.startsWith('---'), `windsurf: should start with ---`).toBe(true);
        expect(content).toContain('trigger: model_decision');
        expect(content).toContain('description:');
      } else if (target === 'copilot') {
        // GitHub Copilot instructions frontmatter: applyTo glob + description
        expect(content.startsWith('---'), `copilot: should start with ---`).toBe(true);
        expect(content).toContain("applyTo: '**'");
        expect(content).toContain('description:');
      }

      // (b) branding — the renamed H1 must be present in every body variant
      expect(content).toContain('TestSprite Verification Loop');
      // The full-body intro line lives only in the FULL body; compact-body targets
      // (e.g. windsurf, budget-capped) ship the trimmed verify body and omit it.
      if (!TARGETS[target].compactBody) {
        expect(content).toContain('The verification loop that flies');
      }

      // (c) Load-bearing command strings
      expect(content, `${target}: missing 'testsprite test run'`).toContain('testsprite test run');
      expect(content, `${target}: missing '--wait'`).toContain('--wait');
      expect(content, `${target}: missing 'test artifact get'`).toContain('test artifact get');
    });

    it(`${target} testsprite-onboard file lands and has correct structure`, () => {
      const tmpDir = freshTmpDir();
      runCli(['agent', 'install', `--target=${target}`, '--dir', tmpDir, '--output', 'json']);

      const filePath = join(tmpDir, pathFor(target, 'testsprite-onboard'));
      expect(existsSync(filePath), `onboard file must exist at ${filePath}`).toBe(true);
      const content = readFileSync(filePath, 'utf8');

      // Frontmatter check for onboard skill
      if (target === 'claude' || target === 'antigravity') {
        expect(content.startsWith('---'), `${target}/onboard: should start with ---`).toBe(true);
        expect(content).toContain('name: testsprite-onboard');
      } else if (target === 'cursor') {
        expect(content.startsWith('---'), `cursor/onboard: should start with ---`).toBe(true);
        expect(content).toContain('alwaysApply: false');
      } else if (target === 'cline') {
        expect(content.startsWith('---'), `cline/onboard: must NOT start with ---`).toBe(false);
      } else if (target === 'windsurf') {
        expect(content.startsWith('---'), `windsurf/onboard: should start with ---`).toBe(true);
        expect(content).toContain('trigger: model_decision');
        expect(content).toContain('description:');
      } else if (target === 'copilot') {
        expect(content.startsWith('---'), `copilot/onboard: should start with ---`).toBe(true);
        expect(content).toContain("applyTo: '**'");
      }

      // Load-bearing onboard string: the skill body must reference setup
      expect(content).toContain('testsprite');
    });
  }

  // codex: ONE managed section containing BOTH verify body and onboard one-liner
  it('codex AGENTS.md contains ONE managed section with both verify and onboard content', () => {
    const tmpDir = freshTmpDir();
    runCli(['agent', 'install', '--target=codex', '--dir', tmpDir, '--output', 'json']);

    const filePath = join(tmpDir, TARGETS.codex.path);
    const content = readFileSync(filePath, 'utf8');

    // (a) Exactly ONE pair of sentinels
    const beginCount = (
      content.match(
        new RegExp(MANAGED_SECTION_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      ) ?? []
    ).length;
    const endCount = (
      content.match(new RegExp(MANAGED_SECTION_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ??
      []
    ).length;
    expect(beginCount, 'exactly one BEGIN sentinel').toBe(1);
    expect(endCount, 'exactly one END sentinel').toBe(1);

    // BEGIN must come before END
    expect(content.indexOf(MANAGED_SECTION_BEGIN)).toBeLessThan(
      content.indexOf(MANAGED_SECTION_END),
    );

    // (b) Verify content: branding heading + load-bearing command strings
    expect(content).toContain('TestSprite Verification Loop');
    expect(content).toContain('testsprite test run');
    expect(content).toContain('--wait');
    expect(content).toContain('test artifact get');

    // (c) Onboard content: the one-liner must be inside the managed section
    expect(content).toContain('First-time setup');

    // (d) No frontmatter fence — AGENTS.md is plain prose
    expect(content.startsWith('---'), 'codex: must NOT start with ---').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Idempotent re-run
// ---------------------------------------------------------------------------

describe('idempotent re-run', () => {
  it('second install exits 0 with all actions: skipped, files byte-identical', () => {
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
    const firstParsed = JSON.parse(first.stdout) as Array<{ path: string; action: string }>;
    // Both skills written on first install
    expect(firstParsed.every(r => r.action === 'written')).toBe(true);

    // Capture file contents before second run
    const verifyPath = join(tmpDir, pathFor('claude', 'testsprite-verify'));
    const onboardPath = join(tmpDir, pathFor('claude', 'testsprite-onboard'));
    const verifyBefore = readFileSync(verifyPath, 'utf8');
    const onboardBefore = readFileSync(onboardPath, 'utf8');

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
    const secondParsed = JSON.parse(second.stdout) as Array<{ path: string; action: string }>;
    // Both skills skipped on second install
    expect(secondParsed.every(r => r.action === 'skipped')).toBe(true);

    // Files must be byte-identical
    expect(readFileSync(verifyPath, 'utf8')).toBe(verifyBefore);
    expect(readFileSync(onboardPath, 'utf8')).toBe(onboardBefore);
  });
});

// ---------------------------------------------------------------------------
// 4. Conflict — hand-edit, re-run without --force → exit 6, blocked
// ---------------------------------------------------------------------------

describe('conflict handling', () => {
  it('exits 6 with action: blocked when verify file differs and no --force', () => {
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

    // Hand-edit the verify file
    const verifyFilePath = join(tmpDir, pathFor('claude', 'testsprite-verify'));
    const originalContent = readFileSync(verifyFilePath, 'utf8');
    const editedContent = originalContent + '\n\n<!-- HAND-EDITED: do not overwrite -->';
    writeFileSync(verifyFilePath, editedContent, 'utf8');

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

    // At least one entry must be blocked (the verify file)
    const parsed = JSON.parse(second.stdout) as Array<{ path: string; action: string }>;
    const blockedEntry = parsed.find(r => r.path === pathFor('claude', 'testsprite-verify'));
    expect(blockedEntry, 'verify entry should be blocked').toBeDefined();
    expect(blockedEntry!.action).toBe('blocked');

    // File must be unchanged (not overwritten)
    expect(readFileSync(verifyFilePath, 'utf8')).toBe(editedContent);

    // Stderr must contain --force hint
    expect(second.stderr).toContain('--force');
  });
});

// ---------------------------------------------------------------------------
// 5. Force + backup
// ---------------------------------------------------------------------------

describe('force overwrite with backup', () => {
  it('--force exits 0 with action: updated for edited file, .bak holds edited bytes', () => {
    const tmpDir = freshTmpDir();

    // First install
    runCli(['agent', 'install', '--target=claude', '--dir', tmpDir, '--output', 'json']);

    // Hand-edit the verify file
    const verifyFilePath = join(tmpDir, pathFor('claude', 'testsprite-verify'));
    const editedContent = readFileSync(verifyFilePath, 'utf8') + '\n\n<!-- EDITED -->';
    writeFileSync(verifyFilePath, editedContent, 'utf8');

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

    const parsed = JSON.parse(forced.stdout) as Array<{ path: string; action: string }>;
    const verifyEntry = parsed.find(r => r.path === pathFor('claude', 'testsprite-verify'));
    expect(verifyEntry, 'verify entry must be present').toBeDefined();
    expect(verifyEntry!.action).toBe('updated');

    // Verify file must now equal canonical content
    const { content: canonicalVerify } = renderForTarget('claude', 'testsprite-verify');
    expect(readFileSync(verifyFilePath, 'utf8')).toBe(canonicalVerify);

    // .bak must hold the edited bytes
    const bakPath = verifyFilePath + '.bak';
    expect(existsSync(bakPath), '.bak file must exist').toBe(true);
    expect(readFileSync(bakPath, 'utf8')).toBe(editedContent);
  });
});

// ---------------------------------------------------------------------------
// 6. Dry-run — no file created
// ---------------------------------------------------------------------------

describe('dry-run', () => {
  it('--dry-run exits 0, prints both skill paths to stderr, creates no files', () => {
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

    // Stderr shows both skill paths and "would write" banner
    expect(result.stderr).toContain('would write');
    expect(result.stderr).toContain(pathFor('claude', 'testsprite-verify'));
    expect(result.stderr).toContain(pathFor('claude', 'testsprite-onboard'));

    // No files created on disk for either skill
    for (const skill of DEFAULT_SKILLS) {
      const filePath = join(tmpDir, pathFor('claude', skill));
      expect(existsSync(filePath), `file must NOT be created in dry-run: ${skill}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Multi-target — all five files land in one invocation
// ---------------------------------------------------------------------------

describe('multi-target install', () => {
  it('--target=claude,cursor,cline,antigravity,kiro,codex writes all targets + skills, exit 0', () => {
    const tmpDir = freshTmpDir();

    const result = runCli([
      'agent',
      'install',
      '--target=claude,cursor,cline,antigravity,kiro,codex',
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
    const allTargets: AgentTarget[] = ['claude', 'cursor', 'cline', 'antigravity', 'kiro', 'codex'];

    for (const target of allTargets) {
      if (TARGETS[target].mode === 'managed-section') {
        // codex: one result aggregating all skills
        const entry = parsed.find(r => r.target === target);
        expect(entry, `entry for ${target}`).toBeDefined();
        expect(entry!.action, `action for ${target}`).toBe('section-installed');
        const absPath = join(tmpDir, TARGETS[target].path);
        expect(existsSync(absPath), `file at ${absPath}`).toBe(true);
      } else {
        // own-file: one result per skill
        for (const skill of DEFAULT_SKILLS) {
          const skillPath = pathFor(target, skill);
          const entry = parsed.find(r => r.target === target && r.path === skillPath);
          expect(entry, `entry for ${target}/${skill}`).toBeDefined();
          expect(entry!.action, `action for ${target}/${skill}`).toBe('written');
          const absPath = join(tmpDir, skillPath);
          expect(existsSync(absPath), `file at ${absPath}`).toBe(true);
        }
      }
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
// 10. --skill flag: install a single named skill
// ---------------------------------------------------------------------------

describe('--skill flag', () => {
  it('--skill testsprite-onboard installs only the onboard file, not verify', () => {
    const tmpDir = freshTmpDir();

    const result = runCli([
      'agent',
      'install',
      '--target=claude',
      '--skill',
      'testsprite-onboard',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout) as Array<{ path: string; action: string }>;
    // Only one result — the onboard skill
    expect(parsed.length).toBe(1);
    expect(parsed[0]!.path).toBe(pathFor('claude', 'testsprite-onboard'));
    expect(parsed[0]!.action).toBe('written');

    // Onboard file must exist
    const onboardPath = join(tmpDir, pathFor('claude', 'testsprite-onboard'));
    expect(existsSync(onboardPath), 'onboard file must exist').toBe(true);

    // Verify file must NOT exist
    const verifyPath = join(tmpDir, pathFor('claude', 'testsprite-verify'));
    expect(existsSync(verifyPath), 'verify file must NOT exist').toBe(false);
  });

  it('unknown --skill bogus exits 5 with documented error message', () => {
    const tmpDir = freshTmpDir();

    const result = runCli([
      'agent',
      'install',
      '--target=claude',
      '--skill',
      'bogus',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(5);

    // The error message must name the unknown skill and list supported skills
    expect(result.stderr).toContain('bogus');
    expect(result.stderr).toContain('testsprite-verify');
    expect(result.stderr).toContain('testsprite-onboard');

    // Nothing written to disk
    for (const skill of Object.keys(SKILLS)) {
      const absPath = join(tmpDir, pathFor('claude', skill));
      expect(existsSync(absPath), `unexpected file at ${absPath}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. agent list — includes SKILL column with both skill names
// ---------------------------------------------------------------------------

describe('agent list', () => {
  it('output includes TARGET, SKILL column header and both default skill names', () => {
    const result = runCli(['agent', 'list']);
    expect(result.status).toBe(0);

    // Header must include TARGET and SKILL columns
    expect(result.stdout).toContain('TARGET');
    expect(result.stdout).toContain('SKILL');

    // Both default skills must appear in the output
    for (const skill of DEFAULT_SKILLS) {
      expect(result.stdout, `${skill} should appear in agent list`).toContain(skill);
    }

    // All targets must appear
    for (const target of Object.keys(TARGETS)) {
      expect(result.stdout, `${target} should appear in agent list`).toContain(target);
    }
  });

  it('--output json returns an array with one entry per (target × skill)', () => {
    const result = runCli(['agent', 'list', '--output', 'json']);
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout) as Array<{
      target: string;
      skill: string;
      status: string;
      mode: string;
      path: string;
    }>;
    expect(Array.isArray(parsed)).toBe(true);

    // Expected: 8 targets × 2 skills = 16 rows
    const expectedCount = Object.keys(TARGETS).length * DEFAULT_SKILLS.length;
    expect(parsed.length).toBe(expectedCount);

    // Every row must have a non-empty skill field from DEFAULT_SKILLS
    for (const row of parsed) {
      expect(DEFAULT_SKILLS as readonly string[]).toContain(row.skill);
    }

    // Claude verify row must have the verify path
    const claudeVerify = parsed.find(r => r.target === 'claude' && r.skill === 'testsprite-verify');
    expect(claudeVerify).toBeDefined();
    expect(claudeVerify!.path).toBe(pathFor('claude', 'testsprite-verify'));

    // Claude onboard row must have the onboard path
    const claudeOnboard = parsed.find(
      r => r.target === 'claude' && r.skill === 'testsprite-onboard',
    );
    expect(claudeOnboard).toBeDefined();
    expect(claudeOnboard!.path).toBe(pathFor('claude', 'testsprite-onboard'));
  });
});

// ---------------------------------------------------------------------------
// 12. Matrix-coverage guard — hardcoded list forces a conscious update when
//     a target is added or removed from TARGETS.
// ---------------------------------------------------------------------------
describe('matrix coverage guard', () => {
  it('TARGETS matches the documented, e2e-covered set (update this list when adding a target)', () => {
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

  it('SKILLS matches the documented, e2e-covered set (update this list when adding a skill)', () => {
    expect(Object.keys(SKILLS)).toEqual(['testsprite-verify', 'testsprite-onboard']);
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
