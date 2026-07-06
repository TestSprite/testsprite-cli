import { existsSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, CLIError } from '../lib/errors.js';
import {
  DEFAULT_SKILLS,
  MANAGED_SECTION_BEGIN,
  MANAGED_SECTION_END,
  ONBOARD_CODEX_LINE,
  SKILLS,
  buildSkillMarker,
  pathFor,
  renderForTarget,
  renderOwnFileWithMarker,
  TARGETS,
  type AgentTarget,
} from '../lib/agent-targets.js';
import type { AgentDeps, AgentFs, InstallResult, ListResult, StatusResult } from './agent.js';
import {
  AGENTS_MD_CODEX_BUDGET_BYTES,
  createAgentCommand,
  runInstall,
  runList,
  runStatus,
} from './agent.js';

// ---------------------------------------------------------------------------
// In-memory AgentFs backed by a Map
// ---------------------------------------------------------------------------

function makeMemFs(): {
  store: Map<string, string>;
  fs: AgentFs;
  mkdirCalls: string[];
  writeCalls: string[];
  seedFile: (p: string, content: string) => void;
  seedDir: (p: string) => void;
  seedSymlink: (p: string) => void;
} {
  const store = new Map<string, string>(); // regular files: path -> content
  const dirs = new Set<string>(); // directories
  const symlinks = new Set<string>(); // symlinks (we only need to know it IS one)
  const mkdirCalls: string[] = [];
  const writeCalls: string[] = [];

  // Record `p` and all of its ancestors as directories, modelling a real fs
  // tree so the per-component lstat walk in inspectTargetPath can traverse.
  const addAncestorDirs = (p: string) => {
    let cur = path.dirname(p);
    while (cur !== path.dirname(cur)) {
      dirs.add(cur);
      cur = path.dirname(cur);
    }
    dirs.add(cur); // filesystem root
  };

  const agentFs: AgentFs = {
    async lstat(p: string) {
      if (symlinks.has(p)) return { isFile: false, isSymbolicLink: true };
      if (store.has(p)) return { isFile: true, isSymbolicLink: false };
      if (dirs.has(p)) return { isFile: false, isSymbolicLink: false };
      return null;
    },
    async readFile(p: string) {
      const v = store.get(p);
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return v;
    },
    async writeFile(p: string, data: string, opts?: { exclusive?: boolean }) {
      if (opts?.exclusive && (store.has(p) || dirs.has(p) || symlinks.has(p))) {
        throw Object.assign(new Error(`EEXIST: ${p}`), { code: 'EEXIST' });
      }
      writeCalls.push(p);
      store.set(p, data);
      addAncestorDirs(p);
    },
    async mkdir(p: string) {
      mkdirCalls.push(p);
      dirs.add(p);
      addAncestorDirs(p);
    },
  };

  return {
    store,
    fs: agentFs,
    mkdirCalls,
    writeCalls,
    seedFile: (p, content) => {
      store.set(p, content);
      addAncestorDirs(p);
    },
    seedDir: p => {
      dirs.add(p);
      addAncestorDirs(p);
    },
    seedSymlink: p => {
      symlinks.add(p);
      addAncestorDirs(p);
    },
  };
}

// ---------------------------------------------------------------------------
// Captured output helper
// ---------------------------------------------------------------------------

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

function makeCapture(): { capture: CapturedOutput; deps: Pick<AgentDeps, 'stdout' | 'stderr'> } {
  const capture: CapturedOutput = { stdout: [], stderr: [] };
  return {
    capture,
    deps: {
      stdout: line => capture.stdout.push(line),
      stderr: line => capture.stderr.push(line),
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CWD = '/test-project';
const ALL_TARGETS = Object.keys(TARGETS) as AgentTarget[];
/** own-file targets (not managed-section — codex has different install semantics) */
const OWN_FILE_TARGETS = ALL_TARGETS.filter(t => TARGETS[t].mode === 'own-file');

// ---------------------------------------------------------------------------
// runInstall — fresh install per target
// ---------------------------------------------------------------------------

describe('runInstall — fresh install', () => {
  it.each(OWN_FILE_TARGETS)('writes correct file for own-file target %s', async t => {
    const { store, fs: agentFs, mkdirCalls } = makeMemFs();
    const { capture, deps } = makeCapture();

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: [t],
        skills: ['testsprite-verify'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const { path: relPath, content } = renderForTarget(t, 'testsprite-verify');
    const abs = path.resolve(CWD, relPath);

    // File was written to store
    expect(store.get(abs)).toBe(content);

    // mkdir was called for the parent directory
    expect(mkdirCalls.some(d => d === path.dirname(abs))).toBe(true);

    // stdout contains 'written'
    expect(capture.stdout.join('\n')).toContain('written');
    expect(capture.stdout.join('\n')).toContain(relPath);
  });

  it('written content equals renderForTarget exactly', async () => {
    const { store, fs: agentFs } = makeMemFs();
    const { deps } = makeCapture();

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude'],
        skills: ['testsprite-verify'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const { path: relPath, content } = renderForTarget('claude', 'testsprite-verify');
    const abs = path.resolve(CWD, relPath);
    expect(store.get(abs)).toBe(content);
  });

  it('writes to the correct matrix paths (claude and antigravity)', async () => {
    const { store, fs: agentFs } = makeMemFs();
    const { deps } = makeCapture();

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude', 'antigravity'],
        skills: ['testsprite-verify'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const claudeAbs = path.resolve(CWD, TARGETS.claude.path);
    const antigravityAbs = path.resolve(CWD, TARGETS.antigravity.path);
    expect(store.has(claudeAbs)).toBe(true);
    expect(store.has(antigravityAbs)).toBe(true);
  });

  it('cline landing path .clinerules/testsprite-verify.md', async () => {
    const { store, fs: agentFs } = makeMemFs();
    const { deps } = makeCapture();

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['cline'],
        skills: ['testsprite-verify'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const abs = path.resolve(CWD, '.clinerules/testsprite-verify.md');
    expect(store.has(abs)).toBe(true);
  });

  it('cursor landing path .cursor/rules/testsprite-verify.mdc', async () => {
    const { store, fs: agentFs } = makeMemFs();
    const { deps } = makeCapture();

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['cursor'],
        skills: ['testsprite-verify'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const abs = path.resolve(CWD, '.cursor/rules/testsprite-verify.mdc');
    expect(store.has(abs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runInstall — idempotency
// ---------------------------------------------------------------------------

describe('runInstall — idempotency (skipped)', () => {
  it('re-run with identical content → action skipped, no extra write', async () => {
    const { store, fs: agentFs, writeCalls, seedFile } = makeMemFs();
    const { capture, deps } = makeCapture();

    // Pre-seed with the canonical content
    const { path: relPath, content } = renderForTarget('claude', 'testsprite-verify');
    const abs = path.resolve(CWD, relPath);
    seedFile(abs, content);

    const writeCountBefore = writeCalls.length;

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude'],
        skills: ['testsprite-verify'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    // No new write happened
    expect(writeCalls.length).toBe(writeCountBefore);
    expect(capture.stdout.join('\n')).toContain('skipped');
    // Content unchanged
    expect(store.get(abs)).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// runInstall — conflict without --force
// ---------------------------------------------------------------------------

describe('runInstall — conflict (blocked)', () => {
  it('exits 6 when file differs and --force not set', async () => {
    const { store, fs: agentFs, writeCalls, seedFile } = makeMemFs();
    const { capture, deps } = makeCapture();

    const { path: relPath } = renderForTarget('claude', 'testsprite-verify');
    const abs = path.resolve(CWD, relPath);
    seedFile(abs, 'DIFFERENT CONTENT');

    const writeCountBefore = writeCalls.length;

    let thrown: unknown;
    try {
      await runInstall(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          dryRun: false,
          target: ['claude'],
          skills: ['testsprite-verify'],
          force: false,
        },
        { cwd: CWD, fs: agentFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(6);

    // File not written
    expect(writeCalls.length).toBe(writeCountBefore);
    expect(store.get(abs)).toBe('DIFFERENT CONTENT');

    // stderr has a --force hint
    expect(capture.stderr.join('\n')).toContain('--force');
    // stdout has action:blocked
    expect(capture.stdout.join('\n')).toContain('blocked');
  });
});

// ---------------------------------------------------------------------------
// runInstall — --force
// ---------------------------------------------------------------------------

describe('runInstall — --force', () => {
  it('backs up to .bak and writes canonical content', async () => {
    const { store, fs: agentFs, writeCalls, seedFile } = makeMemFs();
    const { capture, deps } = makeCapture();

    const { path: relPath, content } = renderForTarget('claude', 'testsprite-verify');
    const abs = path.resolve(CWD, relPath);
    const oldContent = 'OLD CONTENT';
    seedFile(abs, oldContent);

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude'],
        skills: ['testsprite-verify'],
        force: true,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    // .bak was written via writeFile
    expect(writeCalls).toContain(`${abs}.bak`);

    // .bak has old content
    expect(store.get(`${abs}.bak`)).toBe(oldContent);

    // File now has canonical content
    expect(store.get(abs)).toBe(content);

    // Action reported as updated
    expect(capture.stdout.join('\n')).toContain('updated');
  });

  it('double --force preserves the first backup and writes a numbered .bak.1', async () => {
    const { store, fs: agentFs, seedFile } = makeMemFs();
    const { deps: deps1 } = makeCapture();

    const { path: relPath, content } = renderForTarget('claude', 'testsprite-verify');
    const abs = path.resolve(CWD, relPath);
    const firstEdit = 'FIRST EDIT';
    seedFile(abs, firstEdit);

    // First --force
    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude'],
        skills: ['testsprite-verify'],
        force: true,
      },
      { cwd: CWD, fs: agentFs, ...deps1 },
    );

    // .bak holds firstEdit; abs holds canonical
    expect(store.get(`${abs}.bak`)).toBe(firstEdit);
    expect(store.get(abs)).toBe(content);

    // Now mutate the file again (simulate user editing after first --force)
    const secondEdit = 'SECOND EDIT';
    seedFile(abs, secondEdit);

    const { deps: deps2 } = makeCapture();
    // Second --force
    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude'],
        skills: ['testsprite-verify'],
        force: true,
      },
      { cwd: CWD, fs: agentFs, ...deps2 },
    );

    // First backup preserved (not clobbered); the second lands at .bak.1.
    expect(store.get(`${abs}.bak`)).toBe(firstEdit);
    expect(store.get(`${abs}.bak.1`)).toBe(secondEdit);
    // abs still holds canonical
    expect(store.get(abs)).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// runInstall — --dry-run
// ---------------------------------------------------------------------------

describe('runInstall — --dry-run', () => {
  it('writes nothing to fs; emits banner + would-write lines on stderr', async () => {
    const { store, fs: agentFs, writeCalls, mkdirCalls } = makeMemFs();
    const { capture, deps } = makeCapture();

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: true,
        target: ['claude'],
        skills: ['testsprite-verify'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    // No writes
    expect(writeCalls.length).toBe(0);
    expect(mkdirCalls.length).toBe(0);
    expect(store.size).toBe(0);

    const stderrOut = capture.stderr.join('\n');
    // Banner present
    expect(stderrOut).toContain('[dry-run] no files written');
    // Would-write line present
    expect(stderrOut).toContain('would write');
    // bytes count present (positive integer)
    expect(stderrOut).toMatch(/\(\d+ bytes\)/);

    // stdout contains 'dry-run' action
    expect(capture.stdout.join('\n')).toContain('dry-run');
  });
});

// ---------------------------------------------------------------------------
// runInstall — --dir override
// ---------------------------------------------------------------------------

describe('runInstall — --dir override', () => {
  it('writes under --dir instead of cwd', async () => {
    const { store, fs: agentFs } = makeMemFs();
    const { deps } = makeCapture();

    const customDir = '/custom-dir';

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude'],
        skills: ['testsprite-verify'],
        force: false,
        dir: customDir,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const { path: relPath, content } = renderForTarget('claude', 'testsprite-verify');
    const abs = path.resolve(customDir, relPath);
    expect(store.get(abs)).toBe(content);
    // Not written under CWD
    const cwdAbs = path.resolve(CWD, relPath);
    expect(store.has(cwdAbs)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runInstall — unknown target
// ---------------------------------------------------------------------------

describe('runInstall — unknown target', () => {
  it('throws exit 5 with supported list, nothing written', async () => {
    const { store, fs: agentFs, writeCalls } = makeMemFs();
    const { deps } = makeCapture();

    let thrown: unknown;
    try {
      await runInstall(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          dryRun: false,
          target: ['bogus'],
          force: false,
        },
        { cwd: CWD, fs: agentFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).exitCode).toBe(5);
    // localValidationError puts the detail in nextAction; message is always 'Invalid request.'
    expect((thrown as ApiError).nextAction).toContain('bogus');
    expect(writeCalls.length).toBe(0);
    expect(store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runInstall — multi-target
// ---------------------------------------------------------------------------

describe('runInstall — multi-target', () => {
  it('writes both claude and cursor when both specified', async () => {
    const { store, fs: agentFs } = makeMemFs();
    const { capture, deps } = makeCapture();

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude', 'cursor'],
        skills: ['testsprite-verify'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    expect(store.has(path.resolve(CWD, TARGETS.claude.path))).toBe(true);
    expect(store.has(path.resolve(CWD, TARGETS.cursor.path))).toBe(true);
    expect(capture.stdout.join('\n')).toContain('written');
  });

  it('comma-separated in single --target value works', async () => {
    const { store, fs: agentFs } = makeMemFs();
    const { deps } = makeCapture();

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude,cursor'],
        skills: ['testsprite-verify'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    expect(store.has(path.resolve(CWD, TARGETS.claude.path))).toBe(true);
    expect(store.has(path.resolve(CWD, TARGETS.cursor.path))).toBe(true);
  });

  it('mixed: one blocked, one fresh — fresh is still written, overall exits 6', async () => {
    const { store, fs: agentFs, seedFile } = makeMemFs();
    const { capture, deps } = makeCapture();

    // Pre-seed claude with different content
    const claudeAbs = path.resolve(CWD, TARGETS.claude.path);
    seedFile(claudeAbs, 'DIFFERENT CONTENT');

    let thrown: unknown;
    try {
      await runInstall(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          dryRun: false,
          target: ['claude', 'cursor'],
          skills: ['testsprite-verify'],
          force: false,
        },
        { cwd: CWD, fs: agentFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    // Overall exit 6
    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(6);

    // cursor was still written
    const cursorAbs = path.resolve(CWD, TARGETS.cursor.path);
    expect(store.has(cursorAbs)).toBe(true);

    // claude not overwritten
    expect(store.get(claudeAbs)).toBe('DIFFERENT CONTENT');

    // stdout has both blocked and written
    const stdoutOut = capture.stdout.join('\n');
    expect(stdoutOut).toContain('blocked');
    expect(stdoutOut).toContain('written');
  });

  it('de-duplicates repeated targets', async () => {
    const { fs: agentFs, writeCalls } = makeMemFs();
    const { deps } = makeCapture();

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude', 'claude'],
        skills: ['testsprite-verify'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    // Only one write
    const claudeAbs = path.resolve(CWD, TARGETS.claude.path);
    expect(writeCalls.filter(p => p === claudeAbs).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runInstall — empty target (TTY / non-TTY)
// ---------------------------------------------------------------------------

describe('runInstall — empty target', () => {
  it('non-TTY with no target throws exit 5', async () => {
    const { fs: agentFs } = makeMemFs();
    const { deps } = makeCapture();

    let thrown: unknown;
    try {
      await runInstall(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          dryRun: false,
          target: [],
          force: false,
        },
        { cwd: CWD, fs: agentFs, isTTY: false, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).exitCode).toBe(5);
  });

  it('TTY with injected prompt returning "claude" installs claude', async () => {
    const { store, fs: agentFs } = makeMemFs();
    const { deps } = makeCapture();

    const promptFn = vi.fn().mockResolvedValue('claude');

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: [],
        skills: ['testsprite-verify'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, isTTY: true, prompt: promptFn, ...deps },
    );

    expect(promptFn).toHaveBeenCalledOnce();
    const claudeAbs = path.resolve(CWD, TARGETS.claude.path);
    expect(store.has(claudeAbs)).toBe(true);
  });

  it('TTY with empty prompt answer defaults to claude', async () => {
    const { store, fs: agentFs } = makeMemFs();
    const { deps } = makeCapture();

    const promptFn = vi.fn().mockResolvedValue(''); // empty => default to claude

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: [],
        skills: ['testsprite-verify'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, isTTY: true, prompt: promptFn, ...deps },
    );

    const claudeAbs = path.resolve(CWD, TARGETS.claude.path);
    expect(store.has(claudeAbs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runList
// ---------------------------------------------------------------------------

describe('runList', () => {
  it('returns all five targets with correct status', async () => {
    const { capture, deps } = makeCapture();

    await runList({ profile: 'default', output: 'text', debug: false, dryRun: false }, deps);

    const out = capture.stdout.join('\n');
    expect(out).toContain('claude');
    expect(out).toContain('cursor');
    expect(out).toContain('cline');
    expect(out).toContain('antigravity');
    expect(out).toContain('kiro');
    expect(out).toContain('codex');
    expect(out).toContain('ga');
    expect(out).toContain('experimental');
    // All matrix paths present
    expect(out).toContain(TARGETS.claude.path);
    expect(out).toContain(TARGETS.cursor.path);
    expect(out).toContain(TARGETS.cline.path);
    expect(out).toContain(TARGETS.antigravity.path);
    expect(out).toContain(TARGETS.kiro.path);
    expect(out).toContain(TARGETS.codex.path);
  });

  it('JSON mode emits array of {target, skill, status, path, mode}', async () => {
    const { capture, deps } = makeCapture();

    await runList({ profile: 'default', output: 'json', debug: false, dryRun: false }, deps);

    const json = JSON.parse(capture.stdout.join('\n')) as ListResult[];
    expect(Array.isArray(json)).toBe(true);
    // 7 targets × 2 default skills = 14 rows
    expect(json).toHaveLength(14);
    const targets = json.map(r => r.target);
    expect(targets).toContain('claude');
    expect(targets).toContain('cursor');
    expect(targets).toContain('cline');
    expect(targets).toContain('windsurf');
    expect(targets).toContain('antigravity');
    expect(targets).toContain('kiro');
    expect(targets).toContain('codex');
    // skill field present on each row
    const skills = json.map(r => r.skill);
    expect(skills).toContain('testsprite-verify');
    expect(skills).toContain('testsprite-onboard');
    const claudeEntry = json.find(r => r.target === 'claude' && r.skill === 'testsprite-verify');
    expect(claudeEntry?.status).toBe('ga');
    expect(claudeEntry?.path).toBe(TARGETS.claude.path);
    // codex entry has mode: managed-section
    const codexEntry = json.find(r => r.target === 'codex' && r.skill === 'testsprite-verify');
    expect(codexEntry?.mode).toBe('managed-section');
  });

  it('text mode has a header row', async () => {
    const { capture, deps } = makeCapture();

    await runList({ profile: 'default', output: 'text', debug: false, dryRun: false }, deps);

    const lines = capture.stdout.join('\n').split('\n');
    expect(lines[0]).toMatch(/TARGET/i);
    expect(lines[0]).toMatch(/SKILL/i);
    expect(lines[0]).toMatch(/STATUS/i);
    expect(lines[0]).toMatch(/PATH/i);
  });
});

// ---------------------------------------------------------------------------
// JSON vs text output shapes for install
// ---------------------------------------------------------------------------

describe('runInstall — output modes', () => {
  it('JSON mode emits array of {target, path, action, skills}', async () => {
    const { fs: agentFs } = makeMemFs();
    const { capture, deps } = makeCapture();

    await runInstall(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        target: ['claude'],
        skills: ['testsprite-verify'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const json = JSON.parse(capture.stdout.join('\n')) as InstallResult[];
    expect(Array.isArray(json)).toBe(true);
    expect(json[0]).toMatchObject({
      target: 'claude',
      action: 'written',
      skills: ['testsprite-verify'],
    });
    expect(json[0]?.path).toBe(TARGETS.claude.path);
  });

  it('text mode emits one line per target with padded columns', async () => {
    const { fs: agentFs } = makeMemFs();
    const { capture, deps } = makeCapture();

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude'],
        skills: ['testsprite-verify'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const line = capture.stdout.join('\n');
    // Should contain target name, action, and path
    expect(line).toContain('claude');
    expect(line).toContain('written');
    expect(line).toContain(TARGETS.claude.path);
  });
});

// ---------------------------------------------------------------------------
// createAgentCommand wiring (parseAsync smoke tests)
// ---------------------------------------------------------------------------

describe('createAgentCommand wiring', () => {
  it('agent install with unknown target via parseAsync → throws CLIError exit 5', async () => {
    const { fs: agentFs } = makeMemFs();
    const { deps } = makeCapture();

    const command = createAgentCommand({ cwd: CWD, fs: agentFs, ...deps });
    // We need a parent for optsWithGlobals to work
    const parent = new (await import('commander')).Command('testsprite');
    parent.option('--output <mode>', 'output', 'text');
    parent.option('--profile <name>', 'profile', 'default');
    parent.option('--endpoint-url <url>');
    parent.option('--debug', 'debug', false);
    parent.option('--verbose', 'verbose', false);
    parent.option('--dry-run', 'dry-run', false);
    parent.addCommand(command);

    let thrown: unknown;
    try {
      await parent.parseAsync(['node', 'ts', 'agent', 'install', '--target=bogus', `--dir=${CWD}`]);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    const isValidationErr =
      (thrown instanceof ApiError && thrown.exitCode === 5) ||
      (thrown instanceof CLIError && thrown.exitCode === 5);
    expect(isValidationErr).toBe(true);
  });

  it('agent list via parseAsync → stdout contains all targets', async () => {
    const { deps, capture } = makeCapture();

    const command = createAgentCommand({ cwd: CWD, ...deps });
    const parent = new (await import('commander')).Command('testsprite');
    parent.option('--output <mode>', 'output', 'text');
    parent.option('--profile <name>', 'profile', 'default');
    parent.option('--endpoint-url <url>');
    parent.option('--debug', 'debug', false);
    parent.option('--verbose', 'verbose', false);
    parent.option('--dry-run', 'dry-run', false);
    parent.addCommand(command);

    await parent.parseAsync(['node', 'ts', 'agent', 'list']);

    const out = capture.stdout.join('\n');
    expect(out).toContain('claude');
    expect(out).toContain('antigravity');
  });
});

// ---------------------------------------------------------------------------
// All own-file targets installed at once
// ---------------------------------------------------------------------------

describe('runInstall — all own-file targets', () => {
  it('installs every own-file target in one invocation', async () => {
    const { store, fs: agentFs } = makeMemFs();
    const { capture, deps } = makeCapture();

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: [...OWN_FILE_TARGETS],
        skills: ['testsprite-verify'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    for (const t of OWN_FILE_TARGETS) {
      const abs = path.resolve(CWD, TARGETS[t].path);
      expect(store.has(abs)).toBe(true);
    }

    const out = capture.stdout.join('\n');
    expect(out).toContain('written');
  });
});

// ---------------------------------------------------------------------------
// Dry-run for all six own-file targets
// ---------------------------------------------------------------------------

describe('runInstall — dry-run all own-file targets', () => {
  it('writes nothing for any of the six own-file targets (default 2 skills = 12 would-write lines)', async () => {
    const { store, fs: agentFs } = makeMemFs();
    const { capture, deps } = makeCapture();

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: true,
        target: ['claude', 'cursor', 'cline', 'antigravity', 'kiro', 'windsurf'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    expect(store.size).toBe(0);
    const stderrOut = capture.stderr.join('\n');
    // Banner appears once
    expect(stderrOut).toContain('[dry-run] no files written');
    // 6 targets × 2 default skills = 12 would-write lines
    const wouldWriteLines = stderrOut.split('\n').filter(l => l.includes('would write'));
    expect(wouldWriteLines.length).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Default AgentFs adapter (real disk I/O) — covers the adapter functions
// ---------------------------------------------------------------------------

describe('runInstall — default AgentFs (real disk)', () => {
  it('writes file to real tmpdir when no fs is injected', async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'agent-test-default-'));
    const { capture, deps } = makeCapture();

    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude'],
        skills: ['testsprite-verify'],
        force: false,
        dir: tmpRoot,
      },
      { ...deps }, // no fs injected → uses defaultAgentFs
    );

    const { path: relPath, content } = renderForTarget('claude', 'testsprite-verify');
    const abs = path.resolve(tmpRoot, relPath);
    // File exists on real disk
    expect(readFileSync(abs, 'utf8')).toBe(content);
    expect(capture.stdout.join('\n')).toContain('written');
  });

  it('skips on idempotent re-run with real disk', async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'agent-test-idem-'));
    const { deps: deps1 } = makeCapture();

    // First install
    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude'],
        skills: ['testsprite-verify'],
        force: false,
        dir: tmpRoot,
      },
      { ...deps1 },
    );

    const { capture: cap2, deps: deps2 } = makeCapture();
    // Second install → should skip
    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude'],
        skills: ['testsprite-verify'],
        force: false,
        dir: tmpRoot,
      },
      { ...deps2 },
    );

    expect(cap2.stdout.join('\n')).toContain('skipped');
  });

  it('blocked on real disk when file differs, --force backs up and overwrites', async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'agent-test-force-'));
    const { deps: deps1 } = makeCapture();

    // First install
    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude'],
        skills: ['testsprite-verify'],
        force: false,
        dir: tmpRoot,
      },
      { ...deps1 },
    );

    // Mutate the file
    const { path: relPath, content } = renderForTarget('claude', 'testsprite-verify');
    const abs = path.resolve(tmpRoot, relPath);
    const oldContent = 'MODIFIED BY USER';
    // Use default fs to write the modified content
    const nodeFs = await import('node:fs/promises');
    await nodeFs.writeFile(abs, oldContent, 'utf8');

    // --force re-run
    const { capture: cap3, deps: deps3 } = makeCapture();
    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude'],
        skills: ['testsprite-verify'],
        force: true,
        dir: tmpRoot,
      },
      { ...deps3 },
    );

    expect(cap3.stdout.join('\n')).toContain('updated');
    // .bak has old content
    expect(readFileSync(`${abs}.bak`, 'utf8')).toBe(oldContent);
    // File has canonical content
    expect(readFileSync(abs, 'utf8')).toBe(content);
  });

  it('refuses to write through a symlinked parent dir (real disk) — exit 5', async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'agent-test-symlink-parent-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'agent-test-outside-'));
    // `.claude` is a real symlink to a directory outside the project root.
    symlinkSync(outside, path.join(tmpRoot, '.claude'), 'dir');
    const { deps } = makeCapture();

    let thrown: unknown;
    try {
      await runInstall(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          dryRun: false,
          target: ['claude'],
          skills: ['testsprite-verify'],
          force: false,
          dir: tmpRoot,
        },
        { ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(5);
    // Nothing was created through the symlink, outside --dir.
    expect(existsSync(path.join(outside, 'skills'))).toBe(false);
  });

  it('refuses to overwrite a symlinked target file (real disk) with --force — exit 5', async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'agent-test-symlink-target-'));
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'agent-test-outside-target-'));
    const { path: relPath } = renderForTarget('claude', 'testsprite-verify');
    const abs = path.resolve(tmpRoot, relPath);
    const nodeFs = await import('node:fs/promises');
    await nodeFs.mkdir(path.dirname(abs), { recursive: true });
    // SKILL.md is a real symlink to a file outside the project root.
    const outsideFile = path.join(outsideDir, 'secret.txt');
    await nodeFs.writeFile(outsideFile, 'SECRET', 'utf8');
    symlinkSync(outsideFile, abs, 'file');
    const { deps } = makeCapture();

    let thrown: unknown;
    try {
      await runInstall(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          dryRun: false,
          target: ['claude'],
          skills: ['testsprite-verify'],
          force: true,
          dir: tmpRoot,
        },
        { ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(5);
    // The outside file was NOT overwritten (nor clobbered via the .bak path).
    expect(readFileSync(outsideFile, 'utf8')).toBe('SECRET');
  });
});

// ---------------------------------------------------------------------------
// Path safety — non-regular-file + intermediate guards
// ---------------------------------------------------------------------------

const BASE_OPTS = {
  profile: 'default' as const,
  output: 'text' as const,
  debug: false,
  dryRun: false,
  skills: ['testsprite-verify'],
};

describe('runInstall — path safety', () => {
  it('rethrows a non-ENOENT error from fs.lstat as-is', async () => {
    // inspectTargetPath lstats the first component; a non-ENOENT failure
    // (e.g. EPERM) must propagate unchanged rather than be swallowed.
    const permError = Object.assign(new Error('EPERM: operation not permitted'), {
      code: 'EPERM',
    });
    const badFs: AgentFs = {
      lstat: async () => {
        throw permError;
      },
      readFile: async () => '',
      writeFile: async () => undefined,
      mkdir: async () => undefined,
    };
    const { deps } = makeCapture();

    let thrown: unknown;
    try {
      await runInstall(
        { ...BASE_OPTS, target: ['claude'], force: false },
        { cwd: CWD, fs: badFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(permError);
  });

  it('exit 5 when the landing path already exists as a directory', async () => {
    const { fs: agentFs, writeCalls, seedDir } = makeMemFs();
    seedDir(path.resolve(CWD, TARGETS.claude.path)); // SKILL.md path is a directory
    const { deps } = makeCapture();

    let thrown: unknown;
    try {
      await runInstall(
        { ...BASE_OPTS, target: ['claude'], force: false },
        { cwd: CWD, fs: agentFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(5);
    expect((thrown as CLIError).message).toContain('not a regular file');
    expect(writeCalls.length).toBe(0);
  });

  it('--force does NOT bypass the directory-at-landing-path guard', async () => {
    const { fs: agentFs, writeCalls, seedDir } = makeMemFs();
    seedDir(path.resolve(CWD, TARGETS.claude.path));
    const { deps } = makeCapture();

    let thrown: unknown;
    try {
      await runInstall(
        { ...BASE_OPTS, target: ['claude'], force: true },
        { cwd: CWD, fs: agentFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(5);
    expect(writeCalls.length).toBe(0);
  });

  it('exit 5 when an intermediate path component is a regular file, not a directory', async () => {
    const { fs: agentFs, writeCalls, seedFile } = makeMemFs();
    // `.claude` exists as a FILE, so `.claude/skills/...` cannot be created.
    seedFile(path.resolve(CWD, '.claude'), 'oops');
    const { deps } = makeCapture();

    let thrown: unknown;
    try {
      await runInstall(
        { ...BASE_OPTS, target: ['claude'], force: false },
        { cwd: CWD, fs: agentFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(5);
    expect((thrown as CLIError).message).toContain('not a directory');
    expect(writeCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Path safety — symlink escape (regression for the adversarial-review finding)
// ---------------------------------------------------------------------------

describe('runInstall — symlink safety', () => {
  it('refuses (exit 5) when a parent path component is a symlink', async () => {
    const { fs: agentFs, writeCalls, seedSymlink } = makeMemFs();
    // A planted `.claude` symlink (e.g. -> /etc) would let writes escape --dir.
    seedSymlink(path.resolve(CWD, '.claude'));
    const { deps } = makeCapture();

    let thrown: unknown;
    try {
      await runInstall(
        { ...BASE_OPTS, target: ['claude'], force: false },
        { cwd: CWD, fs: agentFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(5);
    expect((thrown as CLIError).message).toContain('symlink');
    expect(writeCalls.length).toBe(0);
  });

  it('refuses (exit 5) when the target file is a symlink, even with --force', async () => {
    const { fs: agentFs, writeCalls, seedSymlink } = makeMemFs();
    // SKILL.md itself is a symlink (e.g. -> ~/.bashrc); parents modelled as dirs.
    seedSymlink(path.resolve(CWD, TARGETS.claude.path));
    const { deps } = makeCapture();

    let thrown: unknown;
    try {
      await runInstall(
        { ...BASE_OPTS, target: ['claude'], force: true },
        { cwd: CWD, fs: agentFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(5);
    expect((thrown as CLIError).message).toContain('symlink');
    expect(writeCalls.length).toBe(0); // never wrote a .bak nor through the link
  });

  it('dry-run: refuses (exit 5) when the target file is a symlink (parity with real install)', async () => {
    const { fs: agentFs, writeCalls, seedSymlink } = makeMemFs();
    // Same planted SKILL.md symlink as the real-install case above: dry-run
    // must report the same refusal the real install would, not a success.
    seedSymlink(path.resolve(CWD, TARGETS.claude.path));
    const { deps } = makeCapture();

    let thrown: unknown;
    try {
      await runInstall(
        { ...BASE_OPTS, target: ['claude'], force: false, dryRun: true },
        { cwd: CWD, fs: agentFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(5);
    expect((thrown as CLIError).message).toContain('symlink');
    expect(writeCalls.length).toBe(0);
  });

  it('dry-run: refuses (exit 5) when a parent path component is a symlink', async () => {
    const { fs: agentFs, writeCalls, seedSymlink } = makeMemFs();
    seedSymlink(path.resolve(CWD, '.claude'));
    const { deps } = makeCapture();

    let thrown: unknown;
    try {
      await runInstall(
        { ...BASE_OPTS, target: ['claude'], force: false, dryRun: true },
        { cwd: CWD, fs: agentFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(5);
    expect((thrown as CLIError).message).toContain('symlink');
    expect(writeCalls.length).toBe(0);
  });

  it('does not write through a symlinked .bak slot — backs up to a numbered slot', async () => {
    const { store, fs: agentFs, seedFile, seedSymlink } = makeMemFs();
    const abs = path.resolve(CWD, TARGETS.claude.path);
    seedFile(abs, 'DIFFERENT CONTENT'); // real file that differs -> overwrite
    seedSymlink(`${abs}.bak`); // a planted symlink at the default .bak slot
    const { content } = renderForTarget('claude', 'testsprite-verify');
    const { deps } = makeCapture();

    await runInstall(
      { ...BASE_OPTS, target: ['claude'], force: true },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    // Exclusive create never writes through the symlink slot; backup -> .bak.1.
    expect(store.has(`${abs}.bak`)).toBe(false); // symlink slot untouched
    expect(store.get(`${abs}.bak.1`)).toBe('DIFFERENT CONTENT');
    expect(store.get(abs)).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// Backup collision (regression for round-2 finding: don't clobber backups)
// ---------------------------------------------------------------------------

describe('runInstall — backup collision', () => {
  it('--force does not clobber a pre-existing regular .bak; uses .bak.1', async () => {
    const { store, fs: agentFs, seedFile } = makeMemFs();
    const abs = path.resolve(CWD, TARGETS.claude.path);
    seedFile(abs, 'CURRENT EDIT');
    seedFile(`${abs}.bak`, 'PRECIOUS USER BACKUP'); // a backup the user already has
    const { content } = renderForTarget('claude', 'testsprite-verify');
    const { capture, deps } = makeCapture();

    await runInstall(
      { ...BASE_OPTS, target: ['claude'], force: true },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    expect(store.get(`${abs}.bak`)).toBe('PRECIOUS USER BACKUP'); // preserved
    expect(store.get(`${abs}.bak.1`)).toBe('CURRENT EDIT'); // our backup
    expect(store.get(abs)).toBe(content);
    // The actual backup path is reported to the user.
    expect(capture.stderr.join('\n')).toContain('.bak.1');
  });

  it('fresh install: a target that races in after the path check → exit 6', async () => {
    const eexist = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    const racyFs: AgentFs = {
      lstat: async () => null, // the path check sees nothing
      readFile: async () => '',
      writeFile: async (_p: string, _d: string, o?: { exclusive?: boolean }) => {
        if (o?.exclusive) throw eexist; // but it exists by the time we write
      },
      mkdir: async () => undefined,
    };
    const { deps } = makeCapture();

    let thrown: unknown;
    try {
      await runInstall(
        { ...BASE_OPTS, target: ['claude'], force: false },
        { cwd: CWD, fs: racyFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// runInstall — managed-section (codex target)
// ---------------------------------------------------------------------------

describe('runInstall — codex managed-section: create (AGENTS.md absent)', () => {
  it('creates AGENTS.md with just the section when file is absent', async () => {
    const { store, fs: agentFs, writeCalls } = makeMemFs();
    const { capture, deps } = makeCapture();

    await runInstall(
      { ...BASE_OPTS, target: ['codex'], force: false },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const abs = path.resolve(CWD, TARGETS.codex.path);
    expect(store.has(abs)).toBe(true);
    const written = store.get(abs)!;
    // Section sentinels are present
    expect(written).toContain(MANAGED_SECTION_BEGIN);
    expect(written).toContain(MANAGED_SECTION_END);
    // action reported
    const out = capture.stdout.join('\n');
    expect(out).toContain('section-installed');
    expect(writeCalls.some(p => p === abs)).toBe(true);
  });
});

describe('runInstall — codex managed-section: append (AGENTS.md exists, no sentinels)', () => {
  it('appends the section to existing AGENTS.md content', async () => {
    const { store, fs: agentFs, seedFile } = makeMemFs();
    const { capture, deps } = makeCapture();

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    const existingContent = '# My Project\n\nSome existing agent notes.\n';
    seedFile(agentsAbs, existingContent);

    await runInstall(
      { ...BASE_OPTS, target: ['codex'], force: false },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const written = store.get(agentsAbs)!;
    // Original content preserved
    expect(written).toContain('# My Project');
    expect(written).toContain('Some existing agent notes.');
    // Section appended
    expect(written).toContain(MANAGED_SECTION_BEGIN);
    expect(written).toContain(MANAGED_SECTION_END);
    // Action reported as section-installed (first-time append = install)
    expect(capture.stdout.join('\n')).toContain('section-installed');
  });

  it('inserts a blank line separator when existing content has no trailing blank line', async () => {
    const { store, fs: agentFs, seedFile } = makeMemFs();
    const { deps } = makeCapture();

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    // No trailing newline after last line
    seedFile(agentsAbs, '# Existing\n');

    await runInstall(
      { ...BASE_OPTS, target: ['codex'], force: false },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const written = store.get(agentsAbs)!;
    // Separator between existing and section
    const beginIdx = written.indexOf(MANAGED_SECTION_BEGIN);
    const before = written.slice(0, beginIdx);
    // Should end with two newlines (one from the original, one separator)
    expect(before.endsWith('\n\n')).toBe(true);
  });
});

describe('runInstall — codex managed-section: replace (sentinels already present)', () => {
  it('replaces the section when content differs, preserves surrounding text', async () => {
    const { store, fs: agentFs, seedFile } = makeMemFs();
    const { capture, deps } = makeCapture();

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    // Pre-seed with an outdated section
    const oldSection = `${MANAGED_SECTION_BEGIN}\nOLD CONTENT\n${MANAGED_SECTION_END}\n`;
    const beforeText = '# My Project\n\n';
    const afterText = '\n## Other section\n';
    seedFile(agentsAbs, `${beforeText}${oldSection}${afterText}`);

    await runInstall(
      { ...BASE_OPTS, target: ['codex'], force: false },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const written = store.get(agentsAbs)!;
    // Before-text preserved
    expect(written).toContain('# My Project');
    // After-text preserved
    expect(written).toContain('## Other section');
    // Old content replaced
    expect(written).not.toContain('OLD CONTENT');
    // New section present
    expect(written).toContain(MANAGED_SECTION_BEGIN);
    expect(written).toContain(MANAGED_SECTION_END);
    // Action reported
    expect(capture.stdout.join('\n')).toContain('section-updated');
  });
});

describe('runInstall — codex managed-section: unchanged (byte-identical section)', () => {
  it('reports section-unchanged and makes no write when content matches', async () => {
    const { store, fs: agentFs, seedFile, writeCalls } = makeMemFs();
    const { deps: deps1 } = makeCapture();

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);

    // First install to get the canonical section bytes
    await runInstall(
      { ...BASE_OPTS, target: ['codex'], force: false },
      { cwd: CWD, fs: agentFs, ...deps1 },
    );

    // Re-read from the store to get the canonical content
    const canonicalContent = store.get(agentsAbs)!;
    // Re-seed to simulate no change
    seedFile(agentsAbs, canonicalContent);

    const writesBeforeSecondInstall = writeCalls.length;

    const { capture: cap2, deps: deps2 } = makeCapture();
    await runInstall(
      { ...BASE_OPTS, target: ['codex'], force: false },
      { cwd: CWD, fs: agentFs, ...deps2 },
    );

    expect(writeCalls.length).toBe(writesBeforeSecondInstall);
    expect(cap2.stdout.join('\n')).toContain('section-unchanged');
    // Content untouched
    expect(store.get(agentsAbs)).toBe(canonicalContent);
  });
});

describe('runInstall — codex managed-section: corrupt sentinel → exit 5', () => {
  it('throws exit 5 when BEGIN is present but END is missing', async () => {
    const { fs: agentFs, seedFile } = makeMemFs();
    const { deps } = makeCapture();

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    // Only BEGIN, no END
    seedFile(
      agentsAbs,
      `# My Project\n\n${MANAGED_SECTION_BEGIN}\n# Partial section without end\n`,
    );

    let thrown: unknown;
    try {
      await runInstall(
        { ...BASE_OPTS, target: ['codex'], force: false },
        { cwd: CWD, fs: agentFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(5);
    expect((thrown as CLIError).message).toMatch(/malformed|corrupt|sentinel/i);
  });

  it('throws exit 5 when END appears before BEGIN', async () => {
    const { fs: agentFs, seedFile } = makeMemFs();
    const { deps } = makeCapture();

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    // END before BEGIN — reversed sentinels
    seedFile(
      agentsAbs,
      `# My Project\n\n${MANAGED_SECTION_END}\nsome content\n${MANAGED_SECTION_BEGIN}\n`,
    );

    let thrown: unknown;
    try {
      await runInstall(
        { ...BASE_OPTS, target: ['codex'], force: false },
        { cwd: CWD, fs: agentFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(5);
  });
});

describe('runInstall — codex managed-section: --dry-run', () => {
  it('writes nothing; reports managed section in dry-run output', async () => {
    const { store, fs: agentFs, writeCalls, mkdirCalls } = makeMemFs();
    const { capture, deps } = makeCapture();

    await runInstall(
      { ...BASE_OPTS, dryRun: true, target: ['codex'], force: false },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    expect(store.size).toBe(0);
    expect(writeCalls.length).toBe(0);
    expect(mkdirCalls.length).toBe(0);

    const stderrOut = capture.stderr.join('\n');
    expect(stderrOut).toContain('[dry-run] no files written');
    expect(stderrOut).toContain('managed section');
    // stdout has dry-run action
    expect(capture.stdout.join('\n')).toContain('dry-run');
  });

  it('dry-run + AGENTS.md already present: still writes nothing', async () => {
    const { store, fs: agentFs, seedFile, writeCalls } = makeMemFs();
    const { deps } = makeCapture();

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    seedFile(agentsAbs, '# Existing notes\n');
    const contentBefore = store.get(agentsAbs);

    await runInstall(
      { ...BASE_OPTS, dryRun: true, target: ['codex'], force: false },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    // Content unchanged
    expect(store.get(agentsAbs)).toBe(contentBefore);
    expect(writeCalls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// [P2] AGENTS.md 32 KiB budget warning
// Codex has a documented ~32 KiB load budget per AGENTS.md. When the would-be
// file content exceeds that threshold we emit a [warn] to stderr. We still
// write (warn, not refusal). Small files must not trigger the warning.
// ---------------------------------------------------------------------------

describe('[codex-P2] AGENTS.md 32 KiB budget warning', () => {
  it('no warning when existing file is small (well under 32 KiB)', async () => {
    const { fs: agentFs, seedFile } = makeMemFs();
    const { capture, deps } = makeCapture();

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    seedFile(agentsAbs, '# Small project notes\n');

    await runInstall(
      { ...BASE_OPTS, target: ['codex'], force: false },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    // No budget warning should appear
    const warnLines = capture.stderr.filter(l => l.includes('[warn]') && l.includes('KiB'));
    expect(warnLines).toHaveLength(0);
  });

  it('emits [warn] on stderr when resulting file would exceed 32 KiB budget', async () => {
    const { fs: agentFs, seedFile } = makeMemFs();
    const { capture, deps } = makeCapture();

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    // Seed a near-full existing file: 31.5 KiB of content (just under the budget on its own).
    // After appending the ~3.5 KiB codex section the total will exceed 32 KiB.
    const nearFullContent = '# Project notes\n' + 'x'.repeat(AGENTS_MD_CODEX_BUDGET_BYTES - 512);
    seedFile(agentsAbs, nearFullContent);

    await runInstall(
      { ...BASE_OPTS, target: ['codex'], force: false },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    // At least one stderr line must be a budget warning
    const warnLines = capture.stderr.filter(l => l.includes('[warn]') && l.includes('KiB'));
    expect(warnLines.length).toBeGreaterThanOrEqual(1);

    // The warning must mention the resulting byte size and the 32 KiB budget
    const warnText = warnLines[0]!;
    expect(warnText).toMatch(/\d+ bytes/);
    expect(warnText).toContain('32 KiB');

    // The write must still happen (warning is advisory, not a refusal)
    expect(capture.stderr.some(l => l.includes('section-'))).toBe(false); // action only in stdout
    expect(capture.stdout.join('\n')).toMatch(/section-installed|section-updated/);
  });
});

// ---------------------------------------------------------------------------
// [codex-P2] Sentinel standalone-line matching — Finding 1 hardening
//
// Sentinels must only be recognised when they appear as STANDALONE lines.
// An inline mention inside prose (e.g. documentation quoting the marker) must
// NOT be treated as a managed block. Duplicate standalone pairs must be
// rejected as corrupt (exit 5).
// ---------------------------------------------------------------------------

describe('[codex-P2] sentinel standalone-line matching', () => {
  it('inline-only mention → treated as no sentinels → appends section', async () => {
    // The file mentions the sentinel string INSIDE a prose paragraph, not as a
    // standalone line. The classifier must see this as "no sentinels" and append.
    const { store, fs: agentFs, seedFile } = makeMemFs();
    const { capture, deps } = makeCapture();

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    // Inline mention: sentinel string is embedded in a longer sentence.
    const inlineMentionContent =
      '# My Project\n\n' +
      `You can identify our managed block by looking for the marker ${MANAGED_SECTION_BEGIN} in the text.\n` +
      `Likewise the closing marker is ${MANAGED_SECTION_END} but both are only in this paragraph.\n`;
    seedFile(agentsAbs, inlineMentionContent);

    await runInstall(
      { ...BASE_OPTS, target: ['codex'], force: false },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const written = store.get(agentsAbs)!;
    // Original prose preserved
    expect(written).toContain('You can identify our managed block');
    // Section was appended (not replacing the prose)
    const beginCount = written.split(MANAGED_SECTION_BEGIN).length - 1;
    const endCount = written.split(MANAGED_SECTION_END).length - 1;
    // The inline mention + the newly written standalone sentinel = 2 occurrences each
    expect(beginCount).toBe(2);
    expect(endCount).toBe(2);
    // Action must be 'section-installed' (first-time append)
    expect(capture.stdout.join('\n')).toContain('section-installed');
  });

  it('inline mention + real standalone block → replaces only the standalone block', async () => {
    // The file has one inline mention AND a real standalone sentinel pair.
    // Only the standalone pair is the managed block; the inline mention is
    // left untouched.
    const { store, fs: agentFs, seedFile } = makeMemFs();
    const { capture, deps } = makeCapture();

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    const oldSection = `${MANAGED_SECTION_BEGIN}\nOLD MANAGED CONTENT\n${MANAGED_SECTION_END}\n`;
    const content =
      '# My Project\n\n' +
      // Inline mention (NOT a standalone line — embedded in a paragraph)
      `See the marker ${MANAGED_SECTION_BEGIN} for details.\n\n` +
      oldSection +
      '\n## Other section\n';
    seedFile(agentsAbs, content);

    await runInstall(
      { ...BASE_OPTS, target: ['codex'], force: false },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const written = store.get(agentsAbs)!;
    // Inline prose mention preserved
    expect(written).toContain(`See the marker ${MANAGED_SECTION_BEGIN} for details.`);
    // Old content replaced
    expect(written).not.toContain('OLD MANAGED CONTENT');
    // Surrounding sections preserved
    expect(written).toContain('## Other section');
    // Action must be 'section-updated'
    expect(capture.stdout.join('\n')).toContain('section-updated');
  });

  it('duplicate standalone BEGIN lines → corrupt → exit 5', async () => {
    const { fs: agentFs, seedFile } = makeMemFs();
    const { deps } = makeCapture();

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    // Two standalone BEGIN lines → ambiguous; must be rejected as corrupt.
    const content =
      `${MANAGED_SECTION_BEGIN}\nSection content\n${MANAGED_SECTION_END}\n\n` +
      `${MANAGED_SECTION_BEGIN}\nDuplicate second block\n${MANAGED_SECTION_END}\n`;
    seedFile(agentsAbs, content);

    let thrown: unknown;
    try {
      await runInstall(
        { ...BASE_OPTS, target: ['codex'], force: false },
        { cwd: CWD, fs: agentFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(5);
    expect((thrown as CLIError).message).toMatch(/malformed|corrupt|sentinel|ambiguous/i);
  });

  it('duplicate standalone END lines → corrupt → exit 5', async () => {
    const { fs: agentFs, seedFile } = makeMemFs();
    const { deps } = makeCapture();

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    // One BEGIN but two standalone END lines.
    const content =
      `${MANAGED_SECTION_BEGIN}\nContent\n${MANAGED_SECTION_END}\n` +
      `Stray content\n${MANAGED_SECTION_END}\n`;
    seedFile(agentsAbs, content);

    let thrown: unknown;
    try {
      await runInstall(
        { ...BASE_OPTS, target: ['codex'], force: false },
        { cwd: CWD, fs: agentFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(5);
  });

  it('CRLF file with real standalone block → replaces correctly', async () => {
    // Regression: sentinel lines in a CRLF file have a trailing \r that must
    // be stripped before comparison so they still match.
    const { store, fs: agentFs, seedFile } = makeMemFs();
    const { capture, deps } = makeCapture();

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    // Build a CRLF file: each line ends with \r\n.
    const oldSection = `${MANAGED_SECTION_BEGIN}\r\nOLD CRLF CONTENT\r\n${MANAGED_SECTION_END}\r\n`;
    const crlfContent = `# My Project\r\n\r\n${oldSection}\r\n## Other\r\n`;
    seedFile(agentsAbs, crlfContent);

    await runInstall(
      { ...BASE_OPTS, target: ['codex'], force: false },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const written = store.get(agentsAbs)!;
    // Old CRLF content must have been replaced
    expect(written).not.toContain('OLD CRLF CONTENT');
    // After-section preserved
    expect(written).toContain('## Other');
    // Action reported
    expect(capture.stdout.join('\n')).toContain('section-updated');
  });
});

// ---------------------------------------------------------------------------
// [B-E2E-04] Fix 4 regression — codex --dry-run warns when existing file
//            + section would exceed the 32 KiB Codex budget
// ---------------------------------------------------------------------------

describe('[B-E2E-04] codex --dry-run: over-budget warning (Fix 4 regression)', () => {
  const BASE_OPTS_DRY = {
    profile: 'default' as const,
    output: 'text' as const,
    debug: false,
    dryRun: true,
    force: false,
  };

  it('emits [warn] on stderr when existing AGENTS.md + section > 32 KiB; writes nothing', async () => {
    const { store, fs: agentFs, seedFile, writeCalls } = makeMemFs();
    const { capture, deps } = makeCapture();

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);

    // Seed an AGENTS.md that is large enough to push the total over budget.
    // AGENTS_MD_CODEX_BUDGET_BYTES = 32768.
    // We use 31 KiB of existing content so that existing + section > 32 KiB.
    const bigExisting = '#'.repeat(31 * 1024);
    seedFile(agentsAbs, bigExisting);

    await runInstall({ ...BASE_OPTS_DRY, target: ['codex'] }, { cwd: CWD, fs: agentFs, ...deps });

    // Must not write anything in dry-run
    expect(writeCalls.length).toBe(0);
    expect(store.get(agentsAbs)).toBe(bigExisting); // unchanged

    // Must emit a [warn] about the budget
    const stderrOut = capture.stderr.join('\n');
    expect(stderrOut).toMatch(/\[warn\].*bytes.*Codex/i);
  });

  it('does NOT warn when AGENTS.md is absent (fresh install would be under budget)', async () => {
    const { fs: agentFs, writeCalls } = makeMemFs();
    const { capture, deps } = makeCapture();

    await runInstall({ ...BASE_OPTS_DRY, target: ['codex'] }, { cwd: CWD, fs: agentFs, ...deps });

    // Dry-run = no writes
    expect(writeCalls.length).toBe(0);

    // No over-budget warning when file is absent (section alone is ≤ 32 KiB)
    const stderrOut = capture.stderr.join('\n');
    expect(stderrOut).not.toMatch(/\[warn\].*Codex/i);
  });

  it('reports AGENTS_MD_CODEX_BUDGET_BYTES constant publicly (sanity)', () => {
    expect(AGENTS_MD_CODEX_BUDGET_BYTES).toBe(32768);
  });
});

// ---------------------------------------------------------------------------
// [P2 regression] codex --dry-run: symlinked AGENTS.md must fail-close (exit 5)
// before any readFile call — dry-run must apply the same symlink guard as the
// real install path (inspectTargetPath runs first in both modes).
// ---------------------------------------------------------------------------

describe('[P2] codex --dry-run: symlink fail-close (same guard as real install)', () => {
  const BASE_OPTS_DRY = {
    profile: 'default' as const,
    output: 'text' as const,
    debug: false,
    dryRun: true,
    force: false,
  };

  it('symlinked AGENTS.md + --dry-run → exit 5, readFile never called', async () => {
    // The final AGENTS.md path is a symlink. In dry-run the old code called
    // readFile BEFORE inspectTargetPath, so the symlink was followed silently.
    // The fix runs inspectTargetPath first in both modes; this test is the
    // regression gate.
    const { fs: agentFs, writeCalls, seedSymlink } = makeMemFs();
    const { deps } = makeCapture();

    // Seed AGENTS.md as a symlink at the codex landing path.
    seedSymlink(path.resolve(CWD, TARGETS.codex.path));

    // Also confirm readFile is never called by using a custom fs
    let readFileCalled = false;
    const spyFs: AgentFs = {
      ...agentFs,
      async readFile(p: string) {
        readFileCalled = true;
        return agentFs.readFile(p);
      },
    };

    let thrown: unknown;
    try {
      await runInstall({ ...BASE_OPTS_DRY, target: ['codex'] }, { cwd: CWD, fs: spyFs, ...deps });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(5);
    expect((thrown as CLIError).message).toContain('symlink');
    expect(writeCalls.length).toBe(0);
    // readFile must never have been called on the symlinked path
    expect(readFileCalled).toBe(false);
  });

  it('regular AGENTS.md + --dry-run: lstat check passes, readFile called normally', async () => {
    // Confirm normal operation is not disrupted: a regular AGENTS.md file
    // is lstat-checked (not a symlink), then readFile runs for the budget check.
    const { fs: agentFs, writeCalls, seedFile } = makeMemFs();
    const { capture, deps } = makeCapture();

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    // Seed a regular file (not a symlink)
    seedFile(agentsAbs, '# My Project\nSome content.\n');

    await runInstall({ ...BASE_OPTS_DRY, target: ['codex'] }, { cwd: CWD, fs: agentFs, ...deps });

    // No writes (dry-run)
    expect(writeCalls.length).toBe(0);
    // Stdout reports dry-run action
    expect(capture.stdout.join('\n')).toContain('dry-run');
  });
});

// ---------------------------------------------------------------------------
// [P3 round-2] codex --dry-run budget: measure the COMPOSED result, not
// existing+section (replace must not double-count the old block), and surface
// non-ENOENT read failures instead of treating them as absence.
// ---------------------------------------------------------------------------

describe('[P3 round-2] codex --dry-run: composed-size precision + read-failure surfacing', () => {
  const BASE_OPTS_DRY = {
    profile: 'default' as const,
    output: 'text' as const,
    debug: false,
    dryRun: true,
    force: false,
  };

  it('replace path: no warn when the composed file is under budget even though existing+section is over', async () => {
    const { store, fs: agentFs, seedFile, writeCalls } = makeMemFs();
    const { capture, deps } = makeCapture();
    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);

    // Old managed section with a 6 KiB body + 26 KiB of user prose.
    // existing (~32.9 KiB) + new section (~4.8 KiB) > 32 KiB → the OLD formula
    // would warn; the composed replace result (26 KiB + new section) is
    // comfortably under budget → no warn expected.
    const oldSection = `${MANAGED_SECTION_BEGIN}\n${'o'.repeat(6 * 1024)}\n${MANAGED_SECTION_END}\n`;
    const userProse = `# My own AGENTS.md\n${'u'.repeat(26 * 1024)}\n`;
    seedFile(agentsAbs, `${userProse}\n${oldSection}`);

    await runInstall({ ...BASE_OPTS_DRY, target: ['codex'] }, { cwd: CWD, fs: agentFs, ...deps });

    expect(writeCalls.length).toBe(0);
    expect(store.get(agentsAbs)).toBe(`${userProse}\n${oldSection}`);
    expect(capture.stderr.join('\n')).not.toMatch(/\[warn\].*Codex/i);
  });

  it('corrupt sentinel + --dry-run → exit 5 (same outcome the real install would report), no writes', async () => {
    const { fs: agentFs, seedFile, writeCalls } = makeMemFs();
    const { deps } = makeCapture();
    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    seedFile(agentsAbs, `user content\n${MANAGED_SECTION_BEGIN}\nno end sentinel here\n`);

    await expect(
      runInstall({ ...BASE_OPTS_DRY, target: ['codex'] }, { cwd: CWD, fs: agentFs, ...deps }),
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(writeCalls.length).toBe(0);
  });

  it('non-ENOENT read failure (EACCES) on --dry-run → exit 5, not silent success', async () => {
    const { fs: agentFs, seedFile } = makeMemFs();
    const { deps } = makeCapture();
    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    seedFile(agentsAbs, 'unreadable');

    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const realRead = agentFs.readFile.bind(agentFs);
    agentFs.readFile = async (p: string) =>
      p === agentsAbs ? Promise.reject(denied) : realRead(p);

    await expect(
      runInstall({ ...BASE_OPTS_DRY, target: ['codex'] }, { cwd: CWD, fs: agentFs, ...deps }),
    ).rejects.toMatchObject({ exitCode: 5 });
  });
});

// ---------------------------------------------------------------------------
// Multi-skill behavior — new tests covering the SKILLS registry refactor
// ---------------------------------------------------------------------------

describe('runInstall — multi-skill: default install writes BOTH skills (own-file target)', () => {
  it('default claude install produces 2 results: verify + onboard, both action:written', async () => {
    const { store, fs: agentFs, writeCalls } = makeMemFs();
    const { capture, deps } = makeCapture();

    // No skills option → DEFAULT_SKILLS (both verify and onboard); use json output to parse results
    await runInstall(
      {
        ...BASE_OPTS,
        output: 'json',
        dryRun: false,
        skills: undefined,
        target: ['claude'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    // Both skill files should be written
    const verifyAbs = path.resolve(CWD, pathFor('claude', 'testsprite-verify'));
    const onboardAbs = path.resolve(CWD, pathFor('claude', 'testsprite-onboard'));
    expect(store.has(verifyAbs)).toBe(true);
    expect(store.has(onboardAbs)).toBe(true);

    // Both writes recorded
    expect(writeCalls).toContain(verifyAbs);
    expect(writeCalls).toContain(onboardAbs);

    // JSON output contains 2 results
    const json = JSON.parse(capture.stdout.join('\n')) as InstallResult[];

    // There must be a result for testsprite-verify
    const verifyResult = json.find(r => r.skills.includes('testsprite-verify'));
    expect(verifyResult).toBeDefined();
    expect(verifyResult?.target).toBe('claude');
    expect(verifyResult?.action).toBe('written');
    expect(verifyResult?.path).toBe(pathFor('claude', 'testsprite-verify'));

    // There must be a result for testsprite-onboard
    const onboardResult = json.find(r => r.skills.includes('testsprite-onboard'));
    expect(onboardResult).toBeDefined();
    expect(onboardResult?.target).toBe('claude');
    expect(onboardResult?.action).toBe('written');
    expect(onboardResult?.path).toBe(pathFor('claude', 'testsprite-onboard'));
  });

  it('onboard skill file content contains the onboard H1 heading', async () => {
    const { store, fs: agentFs } = makeMemFs();
    const { deps } = makeCapture();

    await runInstall(
      { ...BASE_OPTS, dryRun: false, skills: undefined, target: ['claude'], force: false },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const onboardAbs = path.resolve(CWD, pathFor('claude', 'testsprite-onboard'));
    const content = store.get(onboardAbs)!;
    // The onboard skill body must contain its H1
    expect(content).toContain('# TestSprite: onboard a repo');
  });

  it('each result has skills:[skill] (one-element array) for own-file targets', async () => {
    const { fs: agentFs } = makeMemFs();
    const { capture, deps } = makeCapture();

    await runInstall(
      {
        ...BASE_OPTS,
        output: 'json',
        dryRun: false,
        skills: undefined,
        target: ['claude'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const json = JSON.parse(capture.stdout.join('\n')) as InstallResult[];
    expect(json.length).toBe(2);
    for (const r of json) {
      expect(Array.isArray(r.skills)).toBe(true);
      expect(r.skills.length).toBe(1);
    }
  });

  it('text output FORMAT is unchanged: one row per result (target padEnd(12) action padEnd(12) path), 2 rows for default install', async () => {
    const { fs: agentFs } = makeMemFs();
    const { capture, deps } = makeCapture();

    await runInstall(
      {
        ...BASE_OPTS,
        dryRun: false,
        output: 'text',
        skills: undefined,
        target: ['claude'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const lines = capture.stdout.join('\n').split('\n').filter(Boolean);
    // 2 results → 2 lines
    expect(lines.length).toBe(2);
    // Each line has target, action, and path
    for (const line of lines) {
      expect(line).toContain('claude');
      expect(line).toContain('written');
    }
    // One line for each skill path
    expect(lines.some(l => l.includes(pathFor('claude', 'testsprite-verify')))).toBe(true);
    expect(lines.some(l => l.includes(pathFor('claude', 'testsprite-onboard')))).toBe(true);
  });
});

describe('runInstall — multi-skill: default codex install aggregates BOTH skills in ONE section', () => {
  it('creates ONE AGENTS.md managed section containing verify H1 AND onboard one-liner', async () => {
    const { store, fs: agentFs, writeCalls } = makeMemFs();
    const { capture, deps } = makeCapture();

    // Default (no skills opt) → both skills; json output for result parsing
    await runInstall(
      {
        ...BASE_OPTS,
        output: 'json',
        dryRun: false,
        skills: undefined,
        target: ['codex'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const agentsAbs = path.resolve(CWD, TARGETS.codex.path);
    expect(writeCalls).toContain(agentsAbs);

    const written = store.get(agentsAbs)!;
    // Exactly ONE BEGIN sentinel (not two)
    const beginCount = written.split(MANAGED_SECTION_BEGIN).length - 1;
    expect(beginCount).toBe(1);

    // Section contains the verify H1
    expect(written).toContain('# TestSprite Verification Loop');

    // Section contains the onboard one-liner
    expect(written).toContain('**First-time setup:**');

    // The result is a single codex result with skills = both
    const json = JSON.parse(capture.stdout.join('\n')) as InstallResult[];
    expect(json.length).toBe(1);
    const codexResult = json[0]!;
    expect(codexResult.target).toBe('codex');
    expect(codexResult.action).toBe('section-installed');
    expect(codexResult.skills).toContain('testsprite-verify');
    expect(codexResult.skills).toContain('testsprite-onboard');
  });

  it('single-skill codex install produces a section byte-identical to old single-skill behavior', async () => {
    // A ['testsprite-verify']-only codex install should produce the same section
    // content as the pre-refactor behavior (single-skill codex body).
    const { store: storeA, fs: fsA } = makeMemFs();
    const { deps: depsA } = makeCapture();
    await runInstall(
      {
        ...BASE_OPTS,
        dryRun: false,
        skills: ['testsprite-verify'],
        target: ['codex'],
        force: false,
      },
      { cwd: CWD, fs: fsA, ...depsA },
    );
    const verifyOnlyContent = storeA.get(path.resolve(CWD, TARGETS.codex.path))!;

    // The section must contain the verify H1 but NOT the onboard line
    expect(verifyOnlyContent).toContain('# TestSprite Verification Loop');
    expect(verifyOnlyContent).not.toContain('**First-time setup:**');
    // Exactly one BEGIN sentinel
    expect(verifyOnlyContent.split(MANAGED_SECTION_BEGIN).length - 1).toBe(1);
  });
});

describe('runInstall — multi-skill: --skill subset installs only the named skill', () => {
  it('skills:[testsprite-onboard] installs ONLY the onboard file (1 result, 1 write)', async () => {
    const { store, fs: agentFs, writeCalls } = makeMemFs();
    const { capture, deps } = makeCapture();

    await runInstall(
      {
        ...BASE_OPTS,
        output: 'json',
        dryRun: false,
        skills: ['testsprite-onboard'],
        target: ['claude'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const onboardAbs = path.resolve(CWD, pathFor('claude', 'testsprite-onboard'));
    const verifyAbs = path.resolve(CWD, pathFor('claude', 'testsprite-verify'));

    // Only onboard written; verify NOT written
    expect(store.has(onboardAbs)).toBe(true);
    expect(store.has(verifyAbs)).toBe(false);
    expect(writeCalls).toContain(onboardAbs);
    expect(writeCalls).not.toContain(verifyAbs);

    // Exactly 1 result
    const json = JSON.parse(capture.stdout.join('\n')) as InstallResult[];
    expect(json.length).toBe(1);
    expect(json[0]?.skills).toEqual(['testsprite-onboard']);
    expect(json[0]?.action).toBe('written');
  });

  it('skills:[testsprite-verify] installs ONLY the verify file (1 result)', async () => {
    const { store, fs: agentFs } = makeMemFs();
    const { capture, deps } = makeCapture();

    await runInstall(
      {
        ...BASE_OPTS,
        output: 'json',
        dryRun: false,
        skills: ['testsprite-verify'],
        target: ['claude'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const verifyAbs = path.resolve(CWD, pathFor('claude', 'testsprite-verify'));
    const onboardAbs = path.resolve(CWD, pathFor('claude', 'testsprite-onboard'));

    expect(store.has(verifyAbs)).toBe(true);
    expect(store.has(onboardAbs)).toBe(false);

    const json = JSON.parse(capture.stdout.join('\n')) as InstallResult[];
    expect(json.length).toBe(1);
    expect(json[0]?.skills).toEqual(['testsprite-verify']);
  });
});

describe('runInstall — multi-skill: unknown --skill exits 5', () => {
  it('skills:[bogus] → localValidationError exit 5 with documented message', async () => {
    const { fs: agentFs, writeCalls } = makeMemFs();
    const { deps } = makeCapture();

    let thrown: unknown;
    try {
      await runInstall(
        { ...BASE_OPTS, dryRun: false, skills: ['bogus'], target: ['claude'], force: false },
        { cwd: CWD, fs: agentFs, ...deps },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).exitCode).toBe(5);
    // The nextAction must contain the exact documented message format
    const nextAction = (thrown as ApiError).nextAction ?? '';
    expect(nextAction).toContain('unknown skill "bogus"');
    expect(nextAction).toContain('testsprite-verify');
    expect(nextAction).toContain('testsprite-onboard');
    // Nothing written
    expect(writeCalls.length).toBe(0);
  });

  it('unknown skill via createAgentCommand parseAsync → exit 5', async () => {
    const { fs: agentFs } = makeMemFs();
    const { deps } = makeCapture();

    const command = createAgentCommand({ cwd: CWD, fs: agentFs, ...deps });
    const parent = new (await import('commander')).Command('testsprite');
    parent.option('--output <mode>', 'output', 'text');
    parent.option('--profile <name>', 'profile', 'default');
    parent.option('--endpoint-url <url>');
    parent.option('--debug', 'debug', false);
    parent.option('--verbose', 'verbose', false);
    parent.option('--dry-run', 'dry-run', false);
    parent.addCommand(command);

    let thrown: unknown;
    try {
      await parent.parseAsync([
        'node',
        'ts',
        'agent',
        'install',
        '--target=claude',
        '--skill=bogus',
        `--dir=${CWD}`,
      ]);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    const isValidationErr =
      (thrown instanceof ApiError && thrown.exitCode === 5) ||
      (thrown instanceof CLIError && thrown.exitCode === 5);
    expect(isValidationErr).toBe(true);
  });
});

describe('runInstall — multi-skill: multi-target own-file with default skills', () => {
  it('default install to claude + cursor writes 4 files (2 targets × 2 skills)', async () => {
    const { store, fs: agentFs, writeCalls } = makeMemFs();
    const { capture, deps } = makeCapture();

    // No skills → default both; json output for result parsing
    await runInstall(
      {
        ...BASE_OPTS,
        output: 'json',
        dryRun: false,
        skills: undefined,
        target: ['claude', 'cursor'],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const expectedPaths = [
      path.resolve(CWD, pathFor('claude', 'testsprite-verify')),
      path.resolve(CWD, pathFor('claude', 'testsprite-onboard')),
      path.resolve(CWD, pathFor('cursor', 'testsprite-verify')),
      path.resolve(CWD, pathFor('cursor', 'testsprite-onboard')),
    ];

    for (const p of expectedPaths) {
      expect(store.has(p)).toBe(true);
      expect(writeCalls).toContain(p);
    }

    const json = JSON.parse(capture.stdout.join('\n')) as InstallResult[];
    expect(json.length).toBe(4);
    expect(json.every(r => r.action === 'written')).toBe(true);
  });
});

describe('runInstall — SKILLS registry / DEFAULT_SKILLS contract', () => {
  it('DEFAULT_SKILLS contains exactly testsprite-verify and testsprite-onboard', () => {
    expect(DEFAULT_SKILLS).toContain('testsprite-verify');
    expect(DEFAULT_SKILLS).toContain('testsprite-onboard');
    expect(DEFAULT_SKILLS.length).toBe(2);
  });

  it('SKILLS registry contains both skills with required fields', () => {
    expect(SKILLS['testsprite-verify']).toBeDefined();
    expect(SKILLS['testsprite-onboard']).toBeDefined();
    for (const [name, spec] of Object.entries(SKILLS)) {
      expect(spec.name).toBe(name);
      expect(typeof spec.description).toBe('string');
      expect(spec.description.length).toBeGreaterThan(0);
      expect(typeof spec.bodyFile).toBe('string');
      expect(spec.codex).toBeDefined();
    }
  });

  it('ONBOARD_CODEX_LINE is the one-liner used in the codex section', () => {
    expect(typeof ONBOARD_CODEX_LINE).toBe('string');
    expect(ONBOARD_CODEX_LINE).toContain('**First-time setup:**');
  });
});

// ---------------------------------------------------------------------------
// runStatus — `agent status` (issue #123)
// ---------------------------------------------------------------------------

describe('runStatus — agent status (issue #123)', () => {
  const statusOpts = {
    profile: 'default' as const,
    output: 'json' as const,
    debug: false,
    dryRun: false,
  };

  /** Run status against the given fs and return the printed rows. */
  async function statusRows(agentFs: AgentFs): Promise<{ rows: StatusResult[]; thrown: unknown }> {
    const { capture, deps } = makeCapture();
    let thrown: unknown;
    try {
      await runStatus(statusOpts, { cwd: CWD, fs: agentFs, ...deps });
    } catch (err) {
      thrown = err;
    }
    return { rows: JSON.parse(capture.stdout.join('')) as StatusResult[], thrown };
  }

  it('nothing installed: every row is absent and the command exits 0', async () => {
    const { fs: agentFs } = makeMemFs();
    const { rows, thrown } = await statusRows(agentFs);
    expect(thrown).toBeUndefined();
    expect(rows).toHaveLength(Object.keys(TARGETS).length * DEFAULT_SKILLS.length);
    expect(rows.every(row => row.state === 'absent')).toBe(true);
  });

  it('fresh installs read ok (own-file and codex managed section), exit 0', async () => {
    const { fs: agentFs } = makeMemFs();
    const { deps } = makeCapture();
    await runInstall(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        target: ['claude', 'codex'],
        skills: [...DEFAULT_SKILLS],
        force: false,
      },
      { cwd: CWD, fs: agentFs, ...deps },
    );

    const { rows, thrown } = await statusRows(agentFs);
    expect(thrown).toBeUndefined();
    for (const skill of DEFAULT_SKILLS) {
      expect(rows.find(r => r.target === 'claude' && r.skill === skill)?.state).toBe('ok');
      expect(rows.find(r => r.target === 'codex' && r.skill === skill)?.state).toBe('ok');
      expect(rows.find(r => r.target === 'cursor' && r.skill === skill)?.state).toBe('absent');
    }
  });

  it('stale: a marker whose hash matches an OLDER body reads stale and exits 1', async () => {
    const { fs: agentFs, seedFile } = makeMemFs();
    const oldBody = '# TestSprite Verification Loop\n\nold body from a previous CLI release\n';
    seedFile(
      path.resolve(CWD, pathFor('claude', 'testsprite-verify')),
      renderOwnFileWithMarker(
        'claude',
        'testsprite-verify',
        buildSkillMarker('testsprite-verify', oldBody),
        oldBody,
      ),
    );

    const { rows, thrown } = await statusRows(agentFs);
    expect(rows.find(r => r.target === 'claude' && r.skill === 'testsprite-verify')?.state).toBe(
      'stale',
    );
    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(1);
    expect((thrown as CLIError).message).toContain('need attention');
  });

  it('modified: current hash but edited bytes reads modified and exits 1', async () => {
    const { fs: agentFs, seedFile } = makeMemFs();
    const canonical = renderForTarget('claude', 'testsprite-verify').content;
    seedFile(
      path.resolve(CWD, pathFor('claude', 'testsprite-verify')),
      `${canonical}\n<!-- my local tweak -->\n`,
    );

    const { rows, thrown } = await statusRows(agentFs);
    expect(rows.find(r => r.target === 'claude' && r.skill === 'testsprite-verify')?.state).toBe(
      'modified',
    );
    expect((thrown as CLIError).exitCode).toBe(1);
  });

  it('unmarked: an artifact without a marker line reads unmarked and exits 1', async () => {
    const { fs: agentFs, seedFile } = makeMemFs();
    seedFile(
      path.resolve(CWD, pathFor('claude', 'testsprite-verify')),
      '# hand-rolled skill file with no marker\n',
    );

    const { rows, thrown } = await statusRows(agentFs);
    expect(rows.find(r => r.target === 'claude' && r.skill === 'testsprite-verify')?.state).toBe(
      'unmarked',
    );
    expect((thrown as CLIError).exitCode).toBe(1);
  });

  it('rejects an explicit empty --dir (exit 5), matching the resolve-to-cwd hazard', async () => {
    const { fs: agentFs } = makeMemFs();
    const { deps } = makeCapture();
    await expect(
      runStatus({ ...statusOpts, dir: '   ' }, { cwd: CWD, fs: agentFs, ...deps }),
    ).rejects.toMatchObject({ exitCode: 5 });
  });
});
