/**
 * Full local e2e suite for `testsprite agent install`.
 *
 * Runs the real built binary (`dist/index.js`) via `spawnSync` against a
 * freshly `mkdtemp`-ed project directory. No network, no credentials — fully
 * CI-runnable.
 *
 * Covers the canonical-source model: every skill is written once to
 * `.agents/skills/<skill>/SKILL.md`; universal agents read it directly and
 * symlinked agents reach it through a short link (or a copy when symlinks are
 * unavailable, e.g. Windows without Developer Mode).
 *
 * Run via: `npm run test:e2e` (which builds first).
 * Do NOT run via `npm test` — the main vitest.config.ts excludes `test/e2e/**`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  TARGETS,
  SKILLS,
  DEFAULT_SKILLS,
  canonicalSkillFile,
  pathFor,
  renderCanonical,
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
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// 1. Fresh install — table-driven over a representative slice of TARGETS
//    (universal + symlinked), plus a full-registry smoke pass.
// ---------------------------------------------------------------------------

const representative: AgentTarget[] = [
  'claude-code', // symlinked
  'codex', // universal
  'cursor', // universal
  'antigravity-cli', // universal
  'github-copilot', // universal
  'kiro-cli', // symlinked
  'devin-desktop', // symlinked
];

describe('fresh install (representative targets)', () => {
  for (const target of representative) {
    it(`installs ${target} → exit 0, canonical SKILL.md lands, every skill action: written`, () => {
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

      const parsed = JSON.parse(result.stdout) as Array<{
        target: string;
        path: string;
        action: string;
        skills: string[];
        mode: string;
      }>;
      expect(Array.isArray(parsed), 'output should be a JSON array').toBe(true);

      // The canonical source of truth exists for every skill.
      for (const skill of DEFAULT_SKILLS) {
        const canonicalAbs = join(tmpDir, canonicalSkillFile(skill));
        expect(existsSync(canonicalAbs), `canonical file at ${canonicalAbs}`).toBe(true);
      }

      // Every result row for this target reports a fresh-write action.
      for (const row of parsed.filter(r => r.target === target)) {
        expect(['written', 'copy-fallback']).toContain(row.action);
      }
    });
  }

  it('universal target (codex) creates NO symlink — only the canonical file', () => {
    const tmpDir = freshTmpDir();
    runCli(['agent', 'install', '--target=codex', '--dir', tmpDir, '--output', 'json']);
    // canonical present
    expect(existsSync(join(tmpDir, canonicalSkillFile('testsprite-verify')))).toBe(true);
    // no agent-specific skills dir created (codex reads .agents/skills directly)
    expect(existsSync(join(tmpDir, '.codex'))).toBe(false);
  });

  it('symlinked target (claude-code) links .claude/skills/<skill> → canonical (or copies)', () => {
    const tmpDir = freshTmpDir();
    runCli(['agent', 'install', '--target=claude-code', '--dir', tmpDir, '--output', 'json']);
    // The agent reaches the skill through its own folder, via symlink or copy.
    const landing = join(tmpDir, '.claude/skills/testsprite-verify/SKILL.md');
    expect(existsSync(landing), `claude-code landing should resolve to a SKILL.md`).toBe(true);
    // canonical still present
    expect(existsSync(join(tmpDir, canonicalSkillFile('testsprite-verify')))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Content integrity — the canonical SKILL.md shape
// ---------------------------------------------------------------------------

describe('content integrity', () => {
  it('testsprite-verify SKILL.md has frontmatter, marker, branding, and command strings', () => {
    const tmpDir = freshTmpDir();
    runCli(['agent', 'install', '--target=claude-code', '--dir', tmpDir, '--output', 'json']);

    // Read through the claude-code landing (exercises the symlink/copy path).
    const filePath = join(tmpDir, pathFor('claude-code', 'testsprite-verify'));
    const content = readFileSync(filePath, 'utf8');

    expect(content.startsWith('---')).toBe(true);
    expect(content).toContain('name: testsprite-verify');
    expect(content).toContain('description:');
    expect(content).toContain('TestSprite Verification Loop');
    expect(content).toContain('testsprite test run');
    expect(content).toContain('--wait');
    expect(content).toContain('test artifact get');
    // provenance marker line
    expect(content).toMatch(/<!-- testsprite-skill: testsprite-verify v/);
  });

  it('testsprite-onboard SKILL.md lands with its own frontmatter', () => {
    const tmpDir = freshTmpDir();
    runCli(['agent', 'install', '--target=claude-code', '--dir', tmpDir, '--output', 'json']);
    const filePath = join(tmpDir, pathFor('claude-code', 'testsprite-onboard'));
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain('name: testsprite-onboard');
  });
});

// ---------------------------------------------------------------------------
// 3. Idempotent re-run
// ---------------------------------------------------------------------------

describe('idempotent re-run', () => {
  it('second install exits 0 with all actions: skipped, files byte-identical', () => {
    const tmpDir = freshTmpDir();

    const first = runCli([
      'agent',
      'install',
      '--target=claude-code',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(first.status).toBe(0);

    const verifyPath = join(tmpDir, canonicalSkillFile('testsprite-verify'));
    const verifyBefore = readFileSync(verifyPath, 'utf8');

    const second = runCli([
      'agent',
      'install',
      '--target=claude-code',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(second.status).toBe(0);
    const secondParsed = JSON.parse(second.stdout) as Array<{ action: string }>;
    expect(secondParsed.every(r => r.action === 'skipped')).toBe(true);

    expect(readFileSync(verifyPath, 'utf8')).toBe(verifyBefore);
  });
});

// ---------------------------------------------------------------------------
// 4. Conflict — hand-edit canonical, re-run without --force → exit 6, blocked
// ---------------------------------------------------------------------------

describe('conflict handling', () => {
  it('exits 6 with action: blocked when the canonical file differs and no --force', () => {
    const tmpDir = freshTmpDir();
    runCli(['agent', 'install', '--target=claude-code', '--dir', tmpDir, '--output', 'json']);

    const canonical = join(tmpDir, canonicalSkillFile('testsprite-verify'));
    const edited = readFileSync(canonical, 'utf8') + '\n\n<!-- HAND-EDITED -->';
    writeFileSync(canonical, edited, 'utf8');

    const second = runCli([
      'agent',
      'install',
      '--target=claude-code',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(second.status).toBe(6);
    expect(second.stderr).toContain('--force');
    // File unchanged
    expect(readFileSync(canonical, 'utf8')).toBe(edited);
  });
});

// ---------------------------------------------------------------------------
// 5. Force + backup
// ---------------------------------------------------------------------------

describe('force overwrite with backup', () => {
  it('--force backs up the canonical file and writes canonical content', () => {
    const tmpDir = freshTmpDir();
    runCli(['agent', 'install', '--target=claude-code', '--dir', tmpDir, '--output', 'json']);

    const canonical = join(tmpDir, canonicalSkillFile('testsprite-verify'));
    const edited = readFileSync(canonical, 'utf8') + '\n\n<!-- EDITED -->';
    writeFileSync(canonical, edited, 'utf8');

    const forced = runCli([
      'agent',
      'install',
      '--target=claude-code',
      '--dir',
      tmpDir,
      '--force',
      '--output',
      'json',
    ]);
    expect(forced.status).toBe(0);

    const parsed = JSON.parse(forced.stdout) as Array<{ action: string }>;
    expect(parsed.some(r => r.action === 'updated')).toBe(true);

    // canonical content restored
    expect(readFileSync(canonical, 'utf8')).toBe(renderCanonical('testsprite-verify'));
    // .bak holds the edited bytes
    expect(readFileSync(`${canonical}.bak`, 'utf8')).toBe(edited);
  });
});

// ---------------------------------------------------------------------------
// 6. Dry-run — no file created
// ---------------------------------------------------------------------------

describe('dry-run', () => {
  it('--dry-run exits 0, prints would-write lines, creates no files', () => {
    const tmpDir = freshTmpDir();
    const result = runCli([
      '--dry-run',
      'agent',
      'install',
      '--target=claude-code',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('would write');
    expect(result.stderr).toContain(canonicalSkillFile('testsprite-verify'));
    expect(existsSync(join(tmpDir, canonicalSkillFile('testsprite-verify')))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Multi-target — canonical written once, symlinks per non-universal target
// ---------------------------------------------------------------------------

describe('multi-target install', () => {
  it('--target=claude-code,codex,cursor writes canonical once + links per symlinked target', () => {
    const tmpDir = freshTmpDir();
    const result = runCli([
      'agent',
      'install',
      '--target=claude-code,codex,cursor',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(0);

    // canonical source of truth present
    for (const skill of DEFAULT_SKILLS) {
      expect(existsSync(join(tmpDir, canonicalSkillFile(skill)))).toBe(true);
    }
    // claude-code landing resolves to a SKILL.md
    expect(existsSync(join(tmpDir, pathFor('claude-code', 'testsprite-verify')))).toBe(true);
    // codex/cursor are universal — no private skills dir
    expect(existsSync(join(tmpDir, '.codex'))).toBe(false);
    expect(existsSync(join(tmpDir, '.cursor'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Unknown target → exit 5
// ---------------------------------------------------------------------------

describe('unknown target', () => {
  it('--target=bogus exits 5, nothing written', () => {
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
    expect(result.stderr).toContain('unknown target');
    expect(existsSync(join(tmpDir, '.agents'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. --skill flag
// ---------------------------------------------------------------------------

describe('--skill flag', () => {
  it('--skill testsprite-onboard installs only the onboard canonical file', () => {
    const tmpDir = freshTmpDir();
    const result = runCli([
      'agent',
      'install',
      '--target=claude-code',
      '--skill',
      'testsprite-onboard',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(0);
    expect(existsSync(join(tmpDir, canonicalSkillFile('testsprite-onboard')))).toBe(true);
    expect(existsSync(join(tmpDir, canonicalSkillFile('testsprite-verify')))).toBe(false);
  });

  it('unknown --skill bogus exits 5', () => {
    const tmpDir = freshTmpDir();
    const result = runCli([
      'agent',
      'install',
      '--target=claude-code',
      '--skill',
      'bogus',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('bogus');
  });
});

// ---------------------------------------------------------------------------
// 10. agent list
// ---------------------------------------------------------------------------

describe('agent list', () => {
  it('output includes TARGET/MODE columns and the headline agents', () => {
    const result = runCli(['agent', 'list']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('TARGET');
    expect(result.stdout).toContain('MODE');
    expect(result.stdout).toContain('claude-code');
    expect(result.stdout).toContain('codex');
  });

  it('--output json returns one row per target with mode + skillsDir', () => {
    const result = runCli(['agent', 'list', '--output', 'json']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Array<{
      target: string;
      mode: string;
      skillsDir: string;
    }>;
    expect(parsed.length).toBe(Object.keys(TARGETS).length);
    const codex = parsed.find(r => r.target === 'codex')!;
    expect(codex.mode).toBe('universal');
    expect(codex.skillsDir).toBe('.agents/skills');
    const claude = parsed.find(r => r.target === 'claude-code')!;
    expect(claude.mode).toBe('symlink');
  });
});

// ---------------------------------------------------------------------------
// 11. Registry coverage guard — forces a conscious update when agents change
// ---------------------------------------------------------------------------

describe('registry coverage guard', () => {
  it('TARGETS includes the documented headline agents (superset of the legacy 8)', () => {
    expect(Object.keys(TARGETS)).toEqual(
      expect.arrayContaining([
        'claude-code',
        'codex',
        'cursor',
        'cline',
        'antigravity-cli',
        'github-copilot',
        'kiro-cli',
        'devin-desktop',
        'antigravity',
      ]),
    );
  });

  it('SKILLS matches the documented set', () => {
    expect(Object.keys(SKILLS)).toEqual(['testsprite-verify', 'testsprite-onboard']);
  });

  it('legacy short aliases still resolve via the real binary', () => {
    const tmpDir = freshTmpDir();
    const result = runCli([
      'agent',
      'install',
      '--target=claude',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as Array<{ target: string }>;
    expect(parsed[0]!.target).toBe('claude-code');
    expect(existsSync(join(tmpDir, '.claude/skills/testsprite-verify'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. Full-registry smoke — every accepted target installs cleanly
// ---------------------------------------------------------------------------

describe('full-registry smoke', () => {
  for (const target of Object.keys(TARGETS) as AgentTarget[]) {
    it(`target=${target}: installs exit 0, no thrown error`, () => {
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
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      // canonical always present
      expect(existsSync(join(tmpDir, canonicalSkillFile('testsprite-verify')))).toBe(true);
      // symlinked targets: the landing resolves to a SKILL.md (symlink or copy)
      const spec = TARGETS[target]!;
      if (!spec.universal) {
        const landing = join(tmpDir, spec.skillsDir, 'testsprite-verify', 'SKILL.md');
        expect(existsSync(landing), `landing SKILL.md for ${target}`).toBe(true);
        // On POSIX the landing is a symlink; on Windows it may be a copy. Either is fine.
        try {
          const st = lstatSync(join(tmpDir, spec.skillsDir, 'testsprite-verify'));
          expect(st.isSymbolicLink() || st.isDirectory()).toBe(true);
        } catch {
          // copy-fallback produced a directory; the existsSync above already proved reachability
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 13. Positional target argument
//
// Repro: `agent install <target>` (the exact one-liner form documented in
// DOCUMENTATION.md / README for all 8 targets) previously installed the
// claude skill regardless of the target named, because `install` declared
// only `--target <t>` with no positional `.argument()` — Commander silently
// dropped the excess positional and the non-TTY default-to-claude path won.
// These tests drive the real built binary (not just the command wiring) to
// pin the documented one-liner behavior for good.
// ---------------------------------------------------------------------------
describe('positional target argument', () => {
  it('installs the named target, not the claude default (repro: agent install cursor)', () => {
    const tmpDir = freshTmpDir();
    const result = runCli(['agent', 'install', 'cursor', '--dir', tmpDir, '--output', 'json']);
    expect(result.status).toBe(0);

    expect(existsSync(join(tmpDir, pathFor('cursor', 'testsprite-verify')))).toBe(true);
    expect(existsSync(join(tmpDir, pathFor('claude', 'testsprite-verify')))).toBe(false);
  });

  it('accepts every documented one-liner form (agent install <target>) for all 8 targets', () => {
    for (const target of Object.keys(TARGETS) as AgentTarget[]) {
      const tmpDir = freshTmpDir();
      const result = runCli(['agent', 'install', target, '--dir', tmpDir, '--output', 'json']);
      expect(result.status, `exit code for positional '${target}'`).toBe(0);
      expect(
        existsSync(join(tmpDir, pathFor(target, 'testsprite-verify'))),
        `landing file for positional '${target}'`,
      ).toBe(true);
    }
  });

  it('accepts multiple positional targets in one invocation', () => {
    const tmpDir = freshTmpDir();
    const result = runCli([
      'agent',
      'install',
      'cline',
      'kiro',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(0);
    expect(existsSync(join(tmpDir, pathFor('cline', 'testsprite-verify')))).toBe(true);
    expect(existsSync(join(tmpDir, pathFor('kiro', 'testsprite-verify')))).toBe(true);
  });

  it('merges a positional target with --target', () => {
    const tmpDir = freshTmpDir();
    const result = runCli([
      'agent',
      'install',
      'antigravity',
      '--target=windsurf',
      '--dir',
      tmpDir,
      '--output',
      'json',
    ]);
    expect(result.status).toBe(0);
    expect(existsSync(join(tmpDir, pathFor('antigravity', 'testsprite-verify')))).toBe(true);
    expect(existsSync(join(tmpDir, pathFor('windsurf', 'testsprite-verify')))).toBe(true);
  });

  it('rejects an unknown positional target with exit 5 instead of silently defaulting', () => {
    const tmpDir = freshTmpDir();
    const result = runCli(['agent', 'install', 'banana', '--dir', tmpDir]);
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('unknown target "banana"');
    expect(existsSync(join(tmpDir, pathFor('claude', 'testsprite-verify')))).toBe(false);
  });
});
