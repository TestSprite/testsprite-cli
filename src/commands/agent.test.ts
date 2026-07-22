import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SKILLS,
  SKILLS,
  TARGETS,
  type AgentTarget,
  buildSkillMarker,
  canonicalSkillFile,
  loadSkillFull,
  pathFor,
  renderCanonicalWithMarker,
  targetLandingDir,
} from '../lib/agent-targets.js';
import type { AgentDeps, AgentFs, InstallResult, ListResult, StatusResult } from './agent.js';
import { createAgentCommand, runInstall, runList, runStatus } from './agent.js';

// ---------------------------------------------------------------------------
// In-memory AgentFs (files + dirs + symlinks), platform-agnostic
// ---------------------------------------------------------------------------

interface MemNode {
  kind: 'file' | 'symlink';
  content?: string; // file
  target?: string; // symlink (stored form, relative or absolute)
}

function makeMemFs() {
  const files = new Map<string, MemNode>();
  const dirs = new Set<string>();
  const mkdirCalls: string[] = [];
  const writeCalls: string[] = [];
  const symlinkCalls: { target: string; link: string }[] = [];

  const addAncestorDirs = (p: string) => {
    let cur = path.dirname(p);
    let guard = 0;
    while (cur !== path.dirname(cur) && guard++ < 64) {
      dirs.add(cur);
      cur = path.dirname(cur);
    }
    dirs.add(cur);
  };

  const agentFs: AgentFs = {
    async lstat(p) {
      const node = files.get(p);
      if (node) return { isFile: node.kind === 'file', isSymbolicLink: node.kind === 'symlink' };
      if (dirs.has(p)) return { isFile: false, isSymbolicLink: false };
      return null;
    },
    async readFile(p) {
      const node = files.get(p);
      if (!node || node.kind !== 'file') {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      return node.content ?? '';
    },
    async writeFile(p, data, opts) {
      if (opts?.exclusive && (files.has(p) || dirs.has(p))) {
        throw Object.assign(new Error(`EEXIST: ${p}`), { code: 'EEXIST' });
      }
      writeCalls.push(p);
      files.set(p, { kind: 'file', content: data });
      addAncestorDirs(p);
    },
    async mkdir(p) {
      mkdirCalls.push(p);
      dirs.add(p);
      addAncestorDirs(p);
    },
    async readlink(p) {
      const node = files.get(p);
      if (!node || node.kind !== 'symlink') return null;
      return node.target ?? null;
    },
    async symlink(target, linkPath) {
      symlinkCalls.push({ target, link: linkPath });
      if (files.has(linkPath) || dirs.has(linkPath)) {
        throw Object.assign(new Error(`EEXIST: ${linkPath}`), { code: 'EEXIST' });
      }
      files.set(linkPath, { kind: 'symlink', target });
      addAncestorDirs(linkPath);
    },
    async unlink(p) {
      files.delete(p);
    },
    async rm(p) {
      files.delete(p);
      // remove anything beneath p
      for (const k of [...files.keys()]) {
        if (k.startsWith(p + path.sep)) files.delete(k);
      }
      for (const d of [...dirs]) {
        if (d === p || d.startsWith(p + path.sep)) dirs.delete(d);
      }
    },
  };

  const seedFile = (p: string, content: string) => {
    files.set(path.resolve(p), { kind: 'file', content });
    addAncestorDirs(path.resolve(p));
  };
  const seedDir = (p: string) => {
    dirs.add(path.resolve(p));
    addAncestorDirs(path.resolve(p));
  };
  const seedSymlink = (p: string, target: string) => {
    files.set(path.resolve(p), { kind: 'symlink', target });
    addAncestorDirs(path.resolve(p));
  };

  return {
    agentFs,
    files,
    dirs,
    mkdirCalls,
    writeCalls,
    symlinkCalls,
    seedFile,
    seedDir,
    seedSymlink,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ROOT = path.resolve('/testsprite-proj');

function deps(fs: ReturnType<typeof makeMemFs>, opts: { isTTY?: boolean } = {}): AgentDeps {
  return {
    cwd: ROOT,
    fs: fs.agentFs,
    isTTY: opts.isTTY ?? false,
    stderr: () => {},
    stdout: () => {},
  };
}

/** Full CommonOptions base so every runInstall/runList/runStatus call typechecks. */
const COMMON = {
  profile: 'default',
  output: 'json' as const,
  endpointUrl: undefined,
  debug: false,
  verbose: false,
  dryRun: false,
};

async function runInstallJson(
  fs: ReturnType<typeof makeMemFs>,
  args: { target?: string[]; skills?: string[]; force?: boolean; dir?: string; dryRun?: boolean },
): Promise<InstallResult[]> {
  const stdout: string[] = [];
  await runInstall(
    {
      ...COMMON,
      target: args.target ?? [],
      skills: args.skills,
      force: args.force ?? false,
      dir: args.dir,
      dryRun: args.dryRun ?? false,
    },
    { ...deps(fs), stdout: (l: string) => stdout.push(l) },
  );
  return JSON.parse(stdout.join(''));
}

const canonicalPath = (skill: string) => path.resolve(ROOT, canonicalSkillFile(skill));
const canonicalContent = (skill: string) =>
  renderCanonicalWithMarker(skill, buildSkillMarker(skill, loadSkillFull(skill)));
const landingPath = (target: AgentTarget, skill: string) =>
  path.resolve(ROOT, targetLandingDir(target, skill));

// ---------------------------------------------------------------------------
// runInstall — canonical + symlink model
// ---------------------------------------------------------------------------

describe('runInstall — universal target (codex) writes only the canonical file', () => {
  it('writes .agents/skills/<skill>/SKILL.md and reports mode=canonical', async () => {
    const fs = makeMemFs();
    const res = await runInstallJson(fs, { target: ['codex'] });
    const verify = res.find(r => r.skills.includes('testsprite-verify'))!;
    expect(verify.target).toBe('codex');
    expect(verify.mode).toBe('canonical');
    expect(verify.action).toBe('written');
    expect(verify.path).toBe('.agents/skills/testsprite-verify/SKILL.md');
    expect(fs.files.has(canonicalPath('testsprite-verify'))).toBe(true);
    // No symlink created for a universal target.
    expect(fs.symlinkCalls.length).toBe(0);
  });

  it('installs both default skills', async () => {
    const fs = makeMemFs();
    const res = await runInstallJson(fs, { target: ['codex'] });
    expect(res.map(r => r.skills[0]).sort()).toEqual([...DEFAULT_SKILLS].sort());
  });
});

describe('runInstall — symlinked target (claude-code) writes canonical + a symlink back to it', () => {
  it('creates .claude/skills/<skill> → .agents/skills/<skill>', async () => {
    const fs = makeMemFs();
    const res = await runInstallJson(fs, { target: ['claude-code'] });
    const verify = res.find(r => r.skills.includes('testsprite-verify'))!;
    expect(verify.target).toBe('claude-code');
    expect(verify.mode).toBe('symlink');
    expect(verify.action).toBe('written');
    expect(verify.path).toBe('.claude/skills/testsprite-verify/SKILL.md');

    // canonical exists
    expect(fs.files.has(canonicalPath('testsprite-verify'))).toBe(true);
    // symlink exists and resolves to canonical dir
    const link = path.resolve(ROOT, '.claude/skills/testsprite-verify');
    const node = fs.files.get(link);
    expect(node?.kind).toBe('symlink');
    const resolved = path.resolve(path.dirname(link), node!.target!);
    expect(resolved).toBe(path.resolve(ROOT, '.agents/skills/testsprite-verify'));
  });

  it('symlink target is relative (portable when the project moves)', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['claude-code'] });
    const link = path.resolve(ROOT, '.claude/skills/testsprite-verify');
    const target = fs.files.get(link)!.target!;
    expect(target).not.toBe(path.resolve(ROOT, '.agents/skills/testsprite-verify'));
    expect(path.isAbsolute(target)).toBe(false);
  });
});

describe('runInstall — alias resolution', () => {
  it('--target claude resolves to claude-code and lands under .claude/skills', async () => {
    const fs = makeMemFs();
    const res = await runInstallJson(fs, { target: ['claude'] });
    expect(res[0]!.target).toBe('claude-code');
    expect(res[0]!.path).toBe('.claude/skills/testsprite-verify/SKILL.md');
  });

  it('--target copilot resolves to github-copilot (universal)', async () => {
    const fs = makeMemFs();
    const res = await runInstallJson(fs, { target: ['copilot'] });
    expect(res[0]!.target).toBe('github-copilot');
    expect(res[0]!.mode).toBe('canonical');
  });

  it('comma-separated targets and repeats are accepted', async () => {
    const fs = makeMemFs();
    const res = await runInstallJson(fs, { target: ['claude-code,codex'] });
    expect([...new Set(res.map(r => r.target))].sort()).toEqual(['claude-code', 'codex']);
  });
});

describe('runInstall — unknown target or skill', () => {
  it('throws exit 5 with the supported list, nothing written', async () => {
    const fs = makeMemFs();
    await expect(runInstallJson(fs, { target: ['nope'] })).rejects.toMatchObject({
      exitCode: 5,
    });
    expect(fs.writeCalls.length).toBe(0);
    expect(fs.symlinkCalls.length).toBe(0);
  });

  it('throws exit 5 for an unknown skill, writing nothing', async () => {
    const fs = makeMemFs();
    await expect(
      runInstallJson(fs, { target: ['codex'], skills: ['bogus'] }),
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(fs.writeCalls.length).toBe(0);
    expect(fs.symlinkCalls.length).toBe(0);
  });
});

describe('runInstall — default target', () => {
  it('non-TTY with no target defaults to claude-code', async () => {
    const fs = makeMemFs();
    const res = await runInstallJson(fs, {});
    expect(res[0]!.target).toBe('claude-code');
  });

  it('interactive TTY prompts for targets and uses the answer', async () => {
    const fs = makeMemFs();
    const stdout: string[] = [];
    await runInstall(
      { ...COMMON, target: [], force: false },
      {
        ...deps(fs, { isTTY: true }),
        stdout: (l: string) => stdout.push(l),
        prompt: async () => 'codex',
      },
    );
    expect((JSON.parse(stdout.join('')) as InstallResult[])[0]!.target).toBe('codex');
  });

  it('interactive TTY with an empty answer falls back to claude-code', async () => {
    const fs = makeMemFs();
    const stdout: string[] = [];
    await runInstall(
      { ...COMMON, target: [], force: false },
      {
        ...deps(fs, { isTTY: true }),
        stdout: (l: string) => stdout.push(l),
        prompt: async () => '   ',
      },
    );
    expect((JSON.parse(stdout.join('')) as InstallResult[])[0]!.target).toBe('claude-code');
  });
});

describe('runInstall — idempotency', () => {
  it('re-run with identical content → skipped (canonical), skipped (symlink)', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['claude-code', 'codex'] });
    fs.writeCalls.length = 0;
    fs.symlinkCalls.length = 0;
    const res = await runInstallJson(fs, { target: ['claude-code', 'codex'] });
    expect(res.every(r => r.action === 'skipped')).toBe(true);
    expect(fs.writeCalls.length).toBe(0);
    expect(fs.symlinkCalls.length).toBe(0);
  });
});

describe('runInstall — blocked without --force', () => {
  it('exits 6 when the canonical file differs', async () => {
    const fs = makeMemFs();
    fs.seedFile(canonicalPath('testsprite-verify'), 'different content');
    await expect(runInstallJson(fs, { target: ['codex'] })).rejects.toMatchObject({
      exitCode: 6,
    });
  });

  it('exits 6 when a symlink landing points elsewhere', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['claude-code'] });
    fs.files.set(landingPath('claude-code', 'testsprite-verify'), {
      kind: 'symlink',
      target: '/somewhere/else',
    });
    await expect(runInstallJson(fs, { target: ['claude-code'] })).rejects.toMatchObject({
      exitCode: 6,
    });
  });

  it('exits 6 when a regular file occupies the symlink landing', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['codex'] });
    fs.seedFile(landingPath('claude-code', 'testsprite-verify'), 'stray');
    await expect(runInstallJson(fs, { target: ['claude-code'] })).rejects.toMatchObject({
      exitCode: 6,
    });
  });
});

describe('runInstall — --force', () => {
  it('backs up the canonical file to .bak and overwrites', async () => {
    const fs = makeMemFs();
    fs.seedFile(canonicalPath('testsprite-verify'), 'old bytes');
    const res = await runInstallJson(fs, { target: ['codex'], force: true });
    expect(res.find(r => r.skills.includes('testsprite-verify'))!.action).toBe('updated');
    expect(fs.files.has(`${canonicalPath('testsprite-verify')}.bak`)).toBe(true);
    expect(fs.files.get(`${canonicalPath('testsprite-verify')}.bak`)!.content).toBe('old bytes');
  });

  it('replaces a symlink that points elsewhere', async () => {
    const fs = makeMemFs();
    // canonical first
    await runInstallJson(fs, { target: ['claude-code'] });
    // sabotage the symlink to point elsewhere
    const link = path.resolve(ROOT, '.claude/skills/testsprite-verify');
    fs.files.set(link, { kind: 'symlink', target: '/somewhere/else' });
    const res = await runInstallJson(fs, { target: ['claude-code'], force: true });
    expect(res.find(r => r.skills.includes('testsprite-verify'))!.action).toBe('updated');
    const resolved = path.resolve(path.dirname(link), fs.files.get(link)!.target!);
    expect(resolved).toBe(path.resolve(ROOT, '.agents/skills/testsprite-verify'));
  });

  it('replaces a regular file at the landing, backing it up to .bak', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['codex'] });
    const link = landingPath('claude-code', 'testsprite-verify');
    fs.seedFile(link, 'stray');
    const res = await runInstallJson(fs, { target: ['claude-code'], force: true });
    expect(res.find(r => r.skills.includes('testsprite-verify'))!.action).toBe('updated');
    expect(fs.files.get(`${link}.bak`)!.content).toBe('stray');
    expect(fs.files.get(link)?.kind).toBe('symlink');
  });

  it('uses .bak.1 when .bak already exists, leaving the prior backup intact', async () => {
    const fs = makeMemFs();
    const cp = canonicalPath('testsprite-verify');
    fs.seedFile(cp, 'tampered');
    fs.seedFile(`${cp}.bak`, 'old backup');
    const res = await runInstallJson(fs, { target: ['codex'], force: true });
    expect(res.find(r => r.skills.includes('testsprite-verify'))!.action).toBe('updated');
    expect(fs.files.get(`${cp}.bak.1`)!.content).toBe('tampered');
    expect(fs.files.get(`${cp}.bak`)!.content).toBe('old backup');
  });
});

describe('runInstall — --dry-run', () => {
  it('writes nothing; reports would-write lines on stderr', async () => {
    const fs = makeMemFs();
    const stderrLines: string[] = [];
    await runInstall(
      {
        ...COMMON,
        target: ['claude-code'],
        force: false,
        dryRun: true,
      },
      { ...deps(fs), stderr: (l: string) => stderrLines.push(l) },
    );
    expect(fs.writeCalls.length).toBe(0);
    expect(fs.symlinkCalls.length).toBe(0);
    expect(stderrLines.some(l => l.includes('[dry-run]'))).toBe(true);
  });

  it('classifies an existing correct symlink as skipped in the note', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['claude-code'] });
    const stderrLines: string[] = [];
    await runInstall(
      { ...COMMON, target: ['claude-code'], force: false, dryRun: true },
      { ...deps(fs), stderr: (l: string) => stderrLines.push(l) },
    );
    const note = stderrLines.find(l => l.includes('symlink →'));
    expect(note).toBeTruthy();
    expect(note!.includes('(skipped)')).toBe(true);
  });

  it('classifies a symlink pointing elsewhere as dry-run (not skipped)', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['claude-code'] });
    fs.files.set(landingPath('claude-code', 'testsprite-verify'), {
      kind: 'symlink',
      target: '/elsewhere',
    });
    const stderrLines: string[] = [];
    await runInstall(
      { ...COMMON, target: ['claude-code'], force: false, dryRun: true },
      { ...deps(fs), stderr: (l: string) => stderrLines.push(l) },
    );
    const note = stderrLines.find(l => l.includes('symlink →'));
    expect(note).toBeTruthy();
    expect(note!.includes('(dry-run)')).toBe(true);
    expect(note!.includes('(skipped)')).toBe(false);
  });
});

describe('runInstall — path safety', () => {
  it('refuses (exit 5) when an ancestor of the canonical path is a symlink', async () => {
    const fs = makeMemFs();
    // Plant a symlink at .agents — the canonical write must refuse to traverse it.
    fs.seedSymlink(path.resolve(ROOT, '.agents'), '/elsewhere');
    await expect(runInstallJson(fs, { target: ['codex'] })).rejects.toMatchObject({
      exitCode: 5,
    });
  });

  it('refuses (exit 5) when an ancestor of a symlink landing is a symlink', async () => {
    const fs = makeMemFs();
    fs.seedSymlink(path.resolve(ROOT, '.claude'), '/elsewhere');
    await expect(runInstallJson(fs, { target: ['claude-code'] })).rejects.toMatchObject({
      exitCode: 5,
    });
  });

  it('refuses (exit 5) when an ancestor of the canonical path is a regular file', async () => {
    const fs = makeMemFs();
    // .agents is a file → cannot descend into .agents/skills/...
    fs.seedFile(path.resolve(ROOT, '.agents'), 'oops');
    await expect(runInstallJson(fs, { target: ['codex'] })).rejects.toMatchObject({
      exitCode: 5,
    });
  });

  it('refuses (exit 5) when an ancestor of the landing path is a regular file', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['codex'] });
    fs.seedFile(path.resolve(ROOT, '.claude'), 'oops');
    await expect(runInstallJson(fs, { target: ['claude-code'] })).rejects.toMatchObject({
      exitCode: 5,
    });
  });

  it('refuses (exit 5) when the canonical path itself is a directory', async () => {
    const fs = makeMemFs();
    fs.seedDir(canonicalPath('testsprite-verify'));
    await expect(runInstallJson(fs, { target: ['codex'] })).rejects.toMatchObject({
      exitCode: 5,
    });
  });
});

describe('runInstall — copy fallback when symlink is unavailable', () => {
  it('writes a real SKILL.md under the agent dir and reports copy-fallback', async () => {
    const fs = makeMemFs();
    // Make symlink reject (simulate Windows without Developer Mode).
    const base = fs.agentFs;
    const noLinkFs: AgentFs = {
      ...base,
      symlink: async () => {
        throw new Error('EPERM: symlinks unavailable');
      },
    };
    const stderrLines: string[] = [];
    const stdout: string[] = [];
    const res = await runInstall(
      {
        ...COMMON,
        target: ['claude-code'],
        force: false,
      },
      {
        cwd: ROOT,
        fs: noLinkFs,
        isTTY: false,
        stderr: l => stderrLines.push(l),
        stdout: (l: string) => stdout.push(l),
      },
    );
    void res;
    const parsed = JSON.parse(stdout.join('')) as InstallResult[];
    const verify = parsed.find(r => r.skills.includes('testsprite-verify'))!;
    expect(verify.action).toBe('copy-fallback');
    // A real SKILL.md exists under the landing dir.
    const copied = path.resolve(ROOT, '.claude/skills/testsprite-verify/SKILL.md');
    expect(fs.files.has(copied)).toBe(true);
    expect(stderrLines.some(l => l.includes('copied instead'))).toBe(true);
    // canonical still exists (source of truth)
    expect(fs.files.has(canonicalPath('testsprite-verify'))).toBe(true);
  });
});

// A prior copy-fallback leaves a real directory at the landing (not a symlink).
// Re-running install must treat that directory like any other landing: idempotent
// when it matches, blocked when it differs, refreshed with --force.
describe('runInstall — copy-fallback directory (re-install)', () => {
  const seedCopyDir = (fs: ReturnType<typeof makeMemFs>, skillMdContent: string | null): void => {
    const dir = landingPath('claude-code', 'testsprite-verify');
    fs.seedDir(dir);
    if (skillMdContent !== null) fs.seedFile(path.join(dir, 'SKILL.md'), skillMdContent);
  };

  it('skipped when the copy matches the canonical content', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['codex'] });
    seedCopyDir(fs, canonicalContent('testsprite-verify'));
    const res = await runInstallJson(fs, { target: ['claude-code'] });
    expect(res.find(r => r.skills.includes('testsprite-verify'))!.action).toBe('skipped');
  });

  it('blocked (exit 6) when the copy differs, without --force', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['codex'] });
    seedCopyDir(fs, 'tampered');
    await expect(runInstallJson(fs, { target: ['claude-code'] })).rejects.toMatchObject({
      exitCode: 6,
    });
  });

  it('updated when the copy differs and --force is given', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['codex'] });
    const dir = landingPath('claude-code', 'testsprite-verify');
    seedCopyDir(fs, 'tampered');
    const res = await runInstallJson(fs, { target: ['claude-code'], force: true });
    expect(res.find(r => r.skills.includes('testsprite-verify'))!.action).toBe('updated');
    expect(fs.files.get(path.join(dir, 'SKILL.md'))!.content).toBe(
      canonicalContent('testsprite-verify'),
    );
  });

  it('written when the directory exists but its SKILL.md is missing', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['codex'] });
    const dir = landingPath('claude-code', 'testsprite-verify');
    seedCopyDir(fs, null);
    const res = await runInstallJson(fs, { target: ['claude-code'] });
    expect(res.find(r => r.skills.includes('testsprite-verify'))!.action).toBe('written');
    expect(fs.files.get(path.join(dir, 'SKILL.md'))!.content).toBe(
      canonicalContent('testsprite-verify'),
    );
  });

  it('blocked (exit 6) when SKILL.md is itself a directory — even with --force', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['codex'] });
    const dir = landingPath('claude-code', 'testsprite-verify');
    fs.seedDir(dir);
    fs.seedDir(path.join(dir, 'SKILL.md'));
    await expect(runInstallJson(fs, { target: ['claude-code'] })).rejects.toMatchObject({
      exitCode: 6,
    });
    await expect(
      runInstallJson(fs, { target: ['claude-code'], force: true }),
    ).rejects.toMatchObject({ exitCode: 6 });
  });
});

describe('runInstall — output modes', () => {
  it('JSON mode emits the exact result row', async () => {
    const fs = makeMemFs();
    const res = await runInstallJson(fs, { target: ['codex'] });
    expect(res).toContainEqual({
      target: 'codex',
      mode: 'canonical',
      action: 'written',
      path: '.agents/skills/testsprite-verify/SKILL.md',
      skills: ['testsprite-verify'],
    });
  });

  it('text mode emits one line per result with padded columns', async () => {
    const fs = makeMemFs();
    const stdout: string[] = [];
    await runInstall(
      { ...COMMON, output: 'text', target: ['codex'], force: false },
      { ...deps(fs), stdout: (l: string) => stdout.push(l) },
    );
    const line = stdout
      .join('')
      .split('\n')
      .find(l => l.includes('codex'))!;
    expect(line).toContain('codex');
    expect(line).toContain('canonical');
    expect(line).toContain('.agents/skills/testsprite-verify/SKILL.md');
  });
});

describe('runInstall — --dir override', () => {
  it('writes under --dir instead of cwd', async () => {
    const fs = makeMemFs();
    const other = path.resolve('/other-dir');
    await runInstall(
      { ...COMMON, target: ['codex'], force: false, dir: other },
      { ...deps(fs), cwd: ROOT },
    );
    expect(fs.files.has(path.resolve(other, '.agents/skills/testsprite-verify/SKILL.md'))).toBe(
      true,
    );
  });
});

describe('runInstall — landing path for every target', () => {
  it('universal targets write canonical only; every other target symlinks to it', async () => {
    for (const id of Object.keys(TARGETS) as AgentTarget[]) {
      const fs = makeMemFs();
      const res = await runInstallJson(fs, { target: [id], skills: ['testsprite-verify'] });
      const row = res[0]!;
      expect(row.path).toBe(pathFor(id, 'testsprite-verify'));
      // The canonical source of truth is always written.
      expect(fs.files.has(canonicalPath('testsprite-verify'))).toBe(true);
      if (TARGETS[id]!.universal) {
        expect(row.mode).toBe('canonical');
        expect(fs.symlinkCalls).toHaveLength(0);
      } else {
        expect(row.mode).toBe('symlink');
        expect(fs.symlinkCalls).toHaveLength(1);
        const link = path.resolve(ROOT, targetLandingDir(id, 'testsprite-verify'));
        const resolved = path.resolve(path.dirname(link), fs.files.get(link)!.target!);
        expect(resolved).toBe(path.resolve(ROOT, '.agents/skills/testsprite-verify'));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// runList
// ---------------------------------------------------------------------------

describe('runList', () => {
  it('lists every target with mode/skillsDir/path matching TARGETS', async () => {
    const stdout: string[] = [];
    await runList({ ...COMMON }, { ...deps(makeMemFs()), stdout: (l: string) => stdout.push(l) });
    const rows = JSON.parse(stdout.join('')) as ListResult[];
    expect(rows.map(r => r.target)).toEqual(Object.keys(TARGETS));
    for (const row of rows) {
      const spec = TARGETS[row.target as AgentTarget]!;
      expect(row.displayName).toBe(spec.displayName);
      expect(row.mode).toBe(spec.universal ? 'universal' : 'symlink');
      expect(row.skillsDir).toBe(spec.skillsDir);
      expect(row.path).toBe(pathFor(row.target as AgentTarget, 'testsprite-verify'));
    }
  });
});

// ---------------------------------------------------------------------------
// runStatus
// ---------------------------------------------------------------------------

function seedCanonical(fs: ReturnType<typeof makeMemFs>, skill: string, content: string) {
  fs.seedFile(canonicalPath(skill), content);
}

describe('runStatus', () => {
  it('empty project: no rows, exit 0', async () => {
    const fs = makeMemFs();
    await expect(runStatus({ ...COMMON }, deps(fs))).resolves.toBeUndefined();
  });

  it('fresh install → ok, exit 0', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['codex'] });
    const stdout: string[] = [];
    await runStatus({ ...COMMON }, { ...deps(fs), stdout: (l: string) => stdout.push(l) });
    const rows = JSON.parse(stdout.join('')) as StatusResult[];
    const verify = rows.find(r => r.target === 'codex' && r.skill === 'testsprite-verify')!;
    expect(verify.state).toBe('ok');
  });

  it('stale: marker hash does not match the current content → exit 1', async () => {
    const fs = makeMemFs();
    // Build the canonical render but with a WRONG hash in the marker.
    const badMarker = `<!-- testsprite-skill: testsprite-verify v${'0.0.0'} sha256:${'000000000000'} -->`;
    seedCanonical(
      fs,
      'testsprite-verify',
      renderCanonicalWithMarker('testsprite-verify', badMarker),
    );
    const stdout: string[] = [];
    await expect(
      runStatus({ ...COMMON }, { ...deps(fs), stdout: (l: string) => stdout.push(l) }),
    ).rejects.toMatchObject({ exitCode: 1 });
    const rows = JSON.parse(stdout.join('')) as StatusResult[];
    expect(rows.find(r => r.skill === 'testsprite-verify')!.state).toBe('stale');
  });

  it('modified: correct hash but content bytes differ → exit 1', async () => {
    const fs = makeMemFs();
    const full = loadSkillFull('testsprite-verify');
    const marker = buildSkillMarker('testsprite-verify', full);
    // Re-render then tamper with the body bytes (keeping the marker).
    const rendered = renderCanonicalWithMarker('testsprite-verify', marker);
    seedCanonical(fs, 'testsprite-verify', rendered + '\n# hand edit\n');
    await expect(runStatus({ ...COMMON }, deps(fs))).rejects.toMatchObject({ exitCode: 1 });
  });

  it('unmarked: no marker line → exit 1', async () => {
    const fs = makeMemFs();
    seedCanonical(fs, 'testsprite-verify', '---\nname: testsprite-verify\n---\n\nno marker here\n');
    await expect(runStatus({ ...COMMON }, deps(fs))).rejects.toMatchObject({ exitCode: 1 });
  });

  it('symlinked target: ok when linked to canonical', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['claude-code'] });
    const stdout: string[] = [];
    await runStatus({ ...COMMON }, { ...deps(fs), stdout: (l: string) => stdout.push(l) });
    const rows = JSON.parse(stdout.join('')) as StatusResult[];
    // claude-code reads through the symlink → canonical → ok
    const claudeVerify = rows.find(
      r => r.target === 'claude-code' && r.skill === 'testsprite-verify',
    );
    expect(claudeVerify?.state).toBe('ok');
  });

  it('symlinked target: modified when the link points elsewhere', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['claude-code'] });
    const link = path.resolve(ROOT, '.claude/skills/testsprite-verify');
    fs.files.set(link, { kind: 'symlink', target: '/somewhere/else' });
    await expect(runStatus({ ...COMMON }, deps(fs))).rejects.toMatchObject({ exitCode: 1 });
  });

  it('canonical tampering reflects through the symlink as modified', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['claude-code'] });
    // Tamper the canonical body while keeping the (now-lying) marker.
    const marker = buildSkillMarker('testsprite-verify', loadSkillFull('testsprite-verify'));
    const tampered = renderCanonicalWithMarker('testsprite-verify', marker) + '\n# hand edit\n';
    fs.seedFile(canonicalPath('testsprite-verify'), tampered);
    const stdout: string[] = [];
    await expect(
      runStatus({ ...COMMON }, { ...deps(fs), stdout: (l: string) => stdout.push(l) }),
    ).rejects.toMatchObject({ exitCode: 1 });
    const rows = JSON.parse(stdout.join('')) as StatusResult[];
    const claudeVerify = rows.find(
      r => r.target === 'claude-code' && r.skill === 'testsprite-verify',
    );
    expect(claudeVerify?.state).toBe('modified');
  });

  it('directory at the canonical path → unmarked', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['codex'] });
    fs.files.delete(canonicalPath('testsprite-verify'));
    fs.seedDir(canonicalPath('testsprite-verify'));
    const stdout: string[] = [];
    await expect(
      runStatus({ ...COMMON }, { ...deps(fs), stdout: (l: string) => stdout.push(l) }),
    ).rejects.toMatchObject({ exitCode: 1 });
    const rows = JSON.parse(stdout.join('')) as StatusResult[];
    expect(rows.find(r => r.skill === 'testsprite-verify')!.state).toBe('unmarked');
  });

  it('rejects an empty --dir with exit 5', async () => {
    const fs = makeMemFs();
    await expect(runStatus({ ...COMMON, dir: '   ' }, deps(fs))).rejects.toMatchObject({
      exitCode: 5,
    });
  });

  it('text mode renders a header + one row per artifact', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['codex'] });
    const stdout: string[] = [];
    await runStatus(
      { ...COMMON, output: 'text' },
      { ...deps(fs), stdout: (l: string) => stdout.push(l) },
    );
    const text = stdout.join('');
    expect(text).toContain('TARGET');
    expect(text).toContain('STATE');
    expect(text).toContain('codex');
    expect(text).toContain('ok');
  });

  it('regular file at the symlink landing → unmarked', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['codex'] });
    fs.seedFile(landingPath('claude-code', 'testsprite-verify'), 'not a skill');
    const stdout: string[] = [];
    await expect(
      runStatus({ ...COMMON }, { ...deps(fs), stdout: (l: string) => stdout.push(l) }),
    ).rejects.toMatchObject({ exitCode: 1 });
    const rows = JSON.parse(stdout.join('')) as StatusResult[];
    expect(
      rows.find(r => r.target === 'claude-code' && r.skill === 'testsprite-verify')!.state,
    ).toBe('unmarked');
  });

  it('copy-fallback dir landing is classified via its SKILL.md (ok)', async () => {
    const fs = makeMemFs();
    await runInstallJson(fs, { target: ['codex'] });
    const dir = landingPath('claude-code', 'testsprite-verify');
    fs.seedDir(dir);
    fs.seedFile(path.join(dir, 'SKILL.md'), canonicalContent('testsprite-verify'));
    const stdout: string[] = [];
    await runStatus({ ...COMMON }, { ...deps(fs), stdout: (l: string) => stdout.push(l) });
    const rows = JSON.parse(stdout.join('')) as StatusResult[];
    expect(
      rows.find(r => r.target === 'claude-code' && r.skill === 'testsprite-verify')!.state,
    ).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

describe('createAgentCommand wiring', () => {
  it('agent install with unknown target via parseAsync → exit 5', async () => {
    const program = createAgentCommand(deps(makeMemFs()));
    await expect(
      program.parseAsync(['install', '--target', 'nope'], { from: 'user' }),
    ).rejects.toMatchObject({ exitCode: 5 });
  });

  it('agent list via parseAsync → stdout contains claude-code', async () => {
    const stdout: string[] = [];
    const program = createAgentCommand({
      ...deps(makeMemFs()),
      stdout: (l: string) => stdout.push(l),
    });
    await program.parseAsync(['list'], { from: 'user' });
    expect(stdout.join('')).toContain('claude-code');
  });

  it('agent status via parseAsync → prints the empty-project notice on a clean project', async () => {
    const stdout: string[] = [];
    const program = createAgentCommand({
      ...deps(makeMemFs()),
      stdout: (l: string) => stdout.push(l),
    });
    await program.parseAsync(['status'], { from: 'user' });
    expect(stdout.join('')).toContain('No TestSprite skill artifacts');
  });
});

// ---------------------------------------------------------------------------
// Sanity: SKILLS still ships the expected bodies (compile-time drift guard)
// ---------------------------------------------------------------------------

describe('shipped skills', () => {
  it('SKILLS has testsprite-verify and testsprite-onboard', () => {
    expect(Object.keys(SKILLS).sort()).toEqual(['testsprite-onboard', 'testsprite-verify']);
  });
});
