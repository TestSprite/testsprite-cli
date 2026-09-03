import { describe, expect, it } from 'vitest';
import { DEFAULT_SKILLS, TARGETS, pathFor, type AgentTarget } from './agent-targets.js';
import {
  FALLBACK_TARGET,
  detectAgentTargets,
  detectedTargets,
  resolveAgentTargets,
  type DetectAgentDeps,
} from './agent-detect.js';

const ALL_TARGETS = Object.keys(TARGETS) as AgentTarget[];

/**
 * A fake repo built from a list of relative paths. Directories are implied by
 * their children, so a fixture reads as the files a real repo would hold.
 */
function repo(paths: string[], env: NodeJS.ProcessEnv = {}): DetectAgentDeps {
  const files = new Set(paths.map(p => p.replace(/\\/g, '/')));
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const rel = (abs: string) => abs.replace(/\\/g, '/').replace(/^\.\//, '');

  return {
    env,
    existsSync: p => files.has(rel(p)) || dirs.has(rel(p)),
    isDirectory: p => dirs.has(rel(p)),
    readdirSync: p => {
      const base = rel(p);
      const kids = new Set<string>();
      for (const f of [...files, ...dirs]) {
        if (!f.startsWith(`${base}/`)) continue;
        kids.add(f.slice(base.length + 1).split('/')[0]!);
      }
      return [...kids];
    },
    readFileSync: p => {
      if (!files.has(rel(p))) throw new Error('ENOENT');
      return contents.get(rel(p)) ?? '';
    },
  };
}

/** Contents for the handful of fixtures that need a readable file. */
const contents = new Map<string, string>();

// ---------------------------------------------------------------------------
// env signals — the two that exist, and the six absences
// ---------------------------------------------------------------------------

describe('env detection', () => {
  it('detects claude from CLAUDECODE', () => {
    const d = detectAgentTargets('.', repo([], { CLAUDECODE: '1' }));
    expect(d).toEqual([{ target: 'claude', source: 'env', signal: 'CLAUDECODE' }]);
  });

  it('detects cursor from CURSOR_AGENT', () => {
    const d = detectAgentTargets('.', repo([], { CURSOR_AGENT: '1' }));
    expect(d).toEqual([{ target: 'cursor', source: 'env', signal: 'CURSOR_AGENT' }]);
  });

  it('treats an empty or falsy value as unset', () => {
    for (const value of ['', '  ', '0', 'false', 'FALSE']) {
      expect(detectedTargets('.', repo([], { CLAUDECODE: value }))).toEqual([]);
    }
  });

  it('claims NO env signal for the six targets that publish none', () => {
    // Guards against a plausible-looking variable being added from a guess:
    // a name that never matches fails silently, via the fallback.
    const guesses: Record<string, string> = {
      CODEX_SANDBOX: 'seatbelt',
      CODEX_AGENT: '1',
      CLINE_AGENT: '1',
      KIRO_AGENT: '1',
      WINDSURF_AGENT: '1',
      COPILOT_AGENT: '1',
      ANTIGRAVITY_AGENT: '1',
      GITHUB_COPILOT: '1',
      VSCODE_PID: '1234',
      VSCODE_IPC_HOOK: '/tmp/vscode.sock',
      TERM_PROGRAM: 'vscode',
      AI_AGENT: 'codex',
    };
    expect(detectedTargets('.', repo([], guesses))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// repo traces — one case per target, driven off the real path table
// ---------------------------------------------------------------------------

describe('trace detection', () => {
  /** A file the agent itself would own, distinct from anything we write. */
  const foreign: Record<AgentTarget, string> = {
    claude: '.claude/settings.json',
    antigravity: '.agents/config.json',
    cursor: '.cursor/rules/team-style.mdc',
    cline: '.clinerules/team-style.md',
    kiro: '.kiro/steering/product.md',
    windsurf: '.windsurf/rules/team-style.md',
    copilot: '.github/instructions/team-style.instructions.md',
    codex: 'AGENTS.md',
  };

  it('detects every target from its own config trace', () => {
    for (const target of ALL_TARGETS) {
      if (target === 'codex') continue; // needs file content, covered below
      const d = detectAgentTargets('.', repo([foreign[target]]));
      expect(
        d.map(x => x.target),
        target,
      ).toEqual([target]);
      expect(d[0]!.source, target).toBe('trace');
    }
  });

  it('detects codex from an AGENTS.md that holds more than our section', () => {
    contents.set('AGENTS.md', '# Contributing\n\nRun the tests.\n');
    const d = detectAgentTargets('.', repo(['AGENTS.md']));
    expect(d).toEqual([{ target: 'codex', source: 'trace', signal: 'AGENTS.md' }]);
  });

  it('finds several targets when several agents have been used', () => {
    const d = detectedTargets(
      '.',
      repo([foreign.cursor, foreign.cline, '.windsurf/rules/team-style.md']),
    );
    expect(d.sort()).toEqual(['cline', 'cursor', 'windsurf']);
  });

  it('claims nothing in an empty repo', () => {
    expect(detectedTargets('.', repo([]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the self-created-trace rule
// ---------------------------------------------------------------------------

describe('a trace this CLI wrote itself is not evidence', () => {
  it('ignores a .claude tree containing only our skills', () => {
    // Otherwise the fallback is self-reinforcing: nothing detected → our files
    // written → next run reads them back as a real signal.
    const ours = DEFAULT_SKILLS.map(s => pathFor('claude', s));
    expect(detectedTargets('.', repo(ours))).toEqual([]);
  });

  it('ignores our own files for every own-file target', () => {
    for (const target of ALL_TARGETS) {
      if (TARGETS[target].mode === 'managed-section') continue;
      const ours = DEFAULT_SKILLS.map(s => pathFor(target, s));
      expect(detectedTargets('.', repo(ours)), target).toEqual([]);
    }
  });

  it('ignores an AGENTS.md that is only our managed section', () => {
    contents.set(
      'AGENTS.md',
      '<!-- BEGIN TESTSPRITE AGENT SECTION (testsprite agent install codex) -->\nskill body\n<!-- END TESTSPRITE AGENT SECTION -->\n',
    );
    expect(detectedTargets('.', repo(['AGENTS.md']))).toEqual([]);
  });

  it('ignores the .bak sibling `agent install --force` leaves behind', () => {
    // One forced reinstall would otherwise make that target permanently
    // detected from its own backup — the same self-reinforcement, one file over.
    const ours = DEFAULT_SKILLS.map(s => pathFor('claude', s));
    const withBackup = [...ours, `${ours[0]!}.bak`];
    expect(detectedTargets('.', repo(withBackup))).toEqual([]);
  });

  it('still detects a target whose dir holds our skills AND real config', () => {
    const paths = [
      ...DEFAULT_SKILLS.map(s => pathFor('cursor', s)),
      '.cursor/rules/team-style.mdc',
    ];
    expect(detectedTargets('.', repo(paths))).toEqual(['cursor']);
  });
});

// ---------------------------------------------------------------------------
// resolution and robustness
// ---------------------------------------------------------------------------

describe('resolution', () => {
  it('reports env before trace, and a target found by both only once', () => {
    const d = detectAgentTargets(
      '.',
      repo(['.claude/settings.json', '.clinerules/team-style.md'], { CLAUDECODE: '1' }),
    );
    expect(d.filter(x => x.target === 'claude')).toHaveLength(1);
    expect(d[0]).toEqual({ target: 'claude', source: 'env', signal: 'CLAUDECODE' });
    // The trace-only target still comes through, after the env hit.
    expect(d.map(x => x.target)).toEqual(['claude', 'cline']);
  });

  it('claims nothing rather than throwing when a trace is unreadable', () => {
    const deps: DetectAgentDeps = {
      env: {},
      existsSync: () => true,
      isDirectory: () => true,
      readdirSync: () => {
        throw new Error('EACCES');
      },
      readFileSync: () => {
        throw new Error('EACCES');
      },
    };
    expect(() => detectedTargets('.', deps)).not.toThrow();
    expect(detectedTargets('.', deps)).toEqual([]);
  });

  it('resolves an explicit choice without looking at the repo', () => {
    const r = resolveAgentTargets(
      'kiro',
      '.',
      repo(['.cursor/rules/team-style.mdc'], { CLAUDECODE: '1' }),
    );
    expect(r).toEqual({ targets: ['kiro'], source: 'flag', detections: [] });
  });

  it('resolves to every detected target when no choice was made', () => {
    const r = resolveAgentTargets(
      undefined,
      '.',
      repo(['.clinerules/team-style.md', '.kiro/steering/product.md']),
    );
    expect(r.targets.sort()).toEqual(['cline', 'kiro']);
    expect(r.source).toBe('trace');
  });

  it('reports source env when any detection came from the environment', () => {
    const r = resolveAgentTargets(
      undefined,
      '.',
      repo(['.clinerules/team-style.md'], { CLAUDECODE: '1' }),
    );
    expect(r.targets).toEqual(['claude', 'cline']);
    expect(r.source).toBe('env');
  });

  it('falls back to a single named target when nothing is detected', () => {
    const r = resolveAgentTargets(undefined, '.', repo([]));
    expect(r).toEqual({ targets: [FALLBACK_TARGET], source: 'fallback', detections: [] });
  });
});
