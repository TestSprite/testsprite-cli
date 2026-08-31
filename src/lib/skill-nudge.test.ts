import { describe, expect, it } from 'vitest';
import { MANAGED_SECTION_BEGIN, MANAGED_SECTION_END, TARGETS } from './agent-targets.js';
import type { OutputMode } from './output.js';
import {
  SKILL_NUDGE_COMMANDS,
  SKILL_NUDGE_OPT_OUT_ENV,
  isPlanTemplateInvocation,
  isVerifySkillInstalled,
  maybeEmitSkillNudge,
  type SkillNudgeContext,
} from './skill-nudge.js';

// ---------------------------------------------------------------------------
// isVerifySkillInstalled
// ---------------------------------------------------------------------------

// The implementation joins paths with the native separator; normalize so the
// fakes below match on Windows (backslashes) as well as POSIX.
const toPosix = (p: string) => p.replaceAll('\\', '/');

describe('isVerifySkillInstalled', () => {
  it('true when the claude own-file SKILL.md exists', () => {
    const existsSync = (p: string) =>
      toPosix(p).endsWith('.claude/skills/testsprite-verify/SKILL.md');
    expect(isVerifySkillInstalled('/proj', { existsSync })).toBe(true);
  });

  it('true for the cursor .mdc landing file', () => {
    const existsSync = (p: string) => toPosix(p).endsWith('.cursor/rules/testsprite-verify.mdc');
    expect(isVerifySkillInstalled('/proj', { existsSync })).toBe(true);
  });

  it('true for the cline landing file', () => {
    const existsSync = (p: string) => toPosix(p).endsWith('.clinerules/testsprite-verify.md');
    expect(isVerifySkillInstalled('/proj', { existsSync })).toBe(true);
  });

  it('true for the antigravity landing file', () => {
    const existsSync = (p: string) =>
      toPosix(p).endsWith('.agents/skills/testsprite-verify/SKILL.md');
    expect(isVerifySkillInstalled('/proj', { existsSync })).toBe(true);
  });

  it('true when AGENTS.md exists AND carries our BEGIN sentinel', () => {
    const existsSync = (p: string) => p.endsWith('AGENTS.md');
    const readFileSync = () =>
      `# project\n${MANAGED_SECTION_BEGIN}\n...skill...\n${MANAGED_SECTION_END}\n`;
    expect(isVerifySkillInstalled('/proj', { existsSync, readFileSync })).toBe(true);
  });

  it('false when AGENTS.md has only the BEGIN sentinel without a complete managed section', () => {
    const existsSync = (p: string) => p.endsWith('AGENTS.md');
    const readFileSync = () => `# project\n${MANAGED_SECTION_BEGIN}\n...partial skill...\n`;
    expect(isVerifySkillInstalled('/proj', { existsSync, readFileSync })).toBe(false);
  });

  it('false when only a bare AGENTS.md (no sentinel) exists', () => {
    const existsSync = (p: string) => p.endsWith('AGENTS.md');
    const readFileSync = () => '# my project\nNothing TestSprite here.\n';
    expect(isVerifySkillInstalled('/proj', { existsSync, readFileSync })).toBe(false);
  });

  it('false when an unreadable AGENTS.md is the only candidate', () => {
    const existsSync = (p: string) => p.endsWith('AGENTS.md');
    const readFileSync = () => {
      throw new Error('EACCES');
    };
    expect(isVerifySkillInstalled('/proj', { existsSync, readFileSync })).toBe(false);
  });

  it('reports an unreadable managed target through the optional diagnostic callback', () => {
    const errors: Array<{ path: string; error: unknown }> = [];
    const existsSync = (p: string) => p.endsWith('AGENTS.md');
    const readFileSync = () => {
      throw new Error('EACCES');
    };

    expect(
      isVerifySkillInstalled('/proj', {
        existsSync,
        readFileSync,
        onReadError: (path, error) => errors.push({ path, error }),
      }),
    ).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toContain('AGENTS.md');
    expect(errors[0]?.error).toBeInstanceOf(Error);
  });

  it('never lets a failing diagnostic callback break the presence probe', () => {
    const existsSync = (p: string) => p.endsWith('AGENTS.md');
    const readFileSync = () => {
      throw new Error('EACCES');
    };

    expect(() =>
      isVerifySkillInstalled('/proj', {
        existsSync,
        readFileSync,
        onReadError: () => {
          throw new Error('diagnostic sink failed');
        },
      }),
    ).not.toThrow();
  });

  it('false when nothing is present', () => {
    expect(isVerifySkillInstalled('/proj', { existsSync: () => false })).toBe(false);
  });

  it('checks paths under the supplied dir', () => {
    const seen: string[] = [];
    isVerifySkillInstalled('/some/proj', {
      existsSync: (p: string) => {
        seen.push(p);
        return false;
      },
    });
    expect(seen.every(p => toPosix(p).startsWith('/some/proj'))).toBe(true);
    // One probe per target landing path.
    expect(seen).toHaveLength(Object.keys(TARGETS).length);
  });
});

// ---------------------------------------------------------------------------
// maybeEmitSkillNudge
// ---------------------------------------------------------------------------

function makeCtx(over: Partial<SkillNudgeContext> = {}): {
  ctx: SkillNudgeContext;
  lines: string[];
} {
  const lines: string[] = [];
  const ctx: SkillNudgeContext = {
    commandPath: 'test run',
    output: 'text' as OutputMode,
    dryRun: false,
    profile: 'default',
    cwd: '/proj',
    env: {} as NodeJS.ProcessEnv,
    credentialsPath: '/tmp/creds',
    readProfileImpl: () => ({ apiKey: 'sk-fake' }),
    existsSync: () => false, // skill absent by default
    stderr: (line: string) => lines.push(line),
    ...over,
  };
  return { ctx, lines };
}

describe('maybeEmitSkillNudge', () => {
  it('emits a single [warn] line when text + configured + skill absent + eligible command', () => {
    const { ctx, lines } = makeCtx();
    maybeEmitSkillNudge(ctx);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[warn]');
    expect(lines[0]).toContain('testsprite setup');
    expect(lines[0]).toContain('agent install');
    expect(lines[0]).toContain(SKILL_NUDGE_OPT_OUT_ENV);
  });

  it('fires for every command in the documented allowlist', () => {
    for (const cmd of SKILL_NUDGE_COMMANDS) {
      const { ctx, lines } = makeCtx({ commandPath: cmd });
      maybeEmitSkillNudge(ctx);
      expect(lines, `expected a hint for "${cmd}"`).toHaveLength(1);
    }
  });

  it('is silent in JSON mode even with debug enabled', () => {
    const { ctx, lines } = makeCtx({ output: 'json' as OutputMode, debug: true });
    maybeEmitSkillNudge(ctx);
    expect(lines).toHaveLength(0);
  });

  it('is silent under --dry-run', () => {
    const { ctx, lines } = makeCtx({ dryRun: true });
    maybeEmitSkillNudge(ctx);
    expect(lines).toHaveLength(0);
  });

  it('is silent when the opt-out env is set', () => {
    const { ctx, lines } = makeCtx({
      env: { [SKILL_NUDGE_OPT_OUT_ENV]: '1' } as NodeJS.ProcessEnv,
    });
    maybeEmitSkillNudge(ctx);
    expect(lines).toHaveLength(0);
  });

  it('treats opt-out values 0 / false / no / empty as NOT opted out', () => {
    for (const v of ['0', 'false', 'no', '', '  ']) {
      const { ctx, lines } = makeCtx({
        env: { [SKILL_NUDGE_OPT_OUT_ENV]: v } as NodeJS.ProcessEnv,
      });
      maybeEmitSkillNudge(ctx);
      expect(lines, `value ${JSON.stringify(v)} should not suppress`).toHaveLength(1);
    }
  });

  it('is silent for a non-eligible command (e.g. test list)', () => {
    const { ctx, lines } = makeCtx({ commandPath: 'test list' });
    maybeEmitSkillNudge(ctx);
    expect(lines).toHaveLength(0);
  });

  it('is silent for init itself (would be circular)', () => {
    const { ctx, lines } = makeCtx({ commandPath: 'init' });
    maybeEmitSkillNudge(ctx);
    expect(lines).toHaveLength(0);
  });

  it('is silent when the active profile has no api key', () => {
    const { ctx, lines } = makeCtx({ readProfileImpl: () => undefined });
    maybeEmitSkillNudge(ctx);
    expect(lines).toHaveLength(0);
  });

  it('is silent when the skill is already installed', () => {
    const { ctx, lines } = makeCtx({ existsSync: () => true });
    maybeEmitSkillNudge(ctx);
    expect(lines).toHaveLength(0);
  });

  it('never throws when the profile lookup throws (best-effort)', () => {
    const { ctx, lines } = makeCtx({
      readProfileImpl: () => {
        throw new Error('boom');
      },
    });
    expect(() => maybeEmitSkillNudge(ctx)).not.toThrow();
    expect(lines).toHaveLength(0);
  });

  it('reports a swallowed profile lookup error only in debug mode', () => {
    const { ctx, lines } = makeCtx({
      debug: true,
      readProfileImpl: () => {
        throw new Error('credentials unavailable');
      },
    });

    maybeEmitSkillNudge(ctx);

    expect(lines).toEqual(['[debug] skill nudge skipped: credentials unavailable']);
  });

  it('keeps an unreadable managed target byte-identical without debug', () => {
    const normal = makeCtx();
    maybeEmitSkillNudge(normal.ctx);

    const unreadable = makeCtx({
      existsSync: p => p.endsWith('AGENTS.md'),
      readFileSync: () => {
        throw new Error('EACCES');
      },
    });
    maybeEmitSkillNudge(unreadable.ctx);

    expect(unreadable.lines).toEqual(normal.lines);
  });

  it('reports an unreadable managed target only in debug mode, then preserves the warning', () => {
    const { ctx, lines } = makeCtx({
      debug: true,
      existsSync: p => p.endsWith('AGENTS.md'),
      readFileSync: () => {
        throw new Error('EACCES');
      },
    });

    maybeEmitSkillNudge(ctx);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[debug] skill nudge could not read');
    expect(lines[0]).toContain('AGENTS.md');
    expect(lines[0]).toContain('EACCES');
    expect(lines[1]).toContain('[warn] No TestSprite verification skill is installed');
  });

  it('never lets a failing debug stderr sink break the command', () => {
    const { ctx } = makeCtx({
      debug: true,
      stderr: () => {
        throw new Error('stderr unavailable');
      },
      readProfileImpl: () => {
        throw new Error('credentials unavailable');
      },
    });

    expect(() => maybeEmitSkillNudge(ctx)).not.toThrow();
  });

  it('passes the cwd through to the presence check', () => {
    const probed: string[] = [];
    const { ctx } = makeCtx({
      cwd: '/work/here',
      existsSync: (p: string) => {
        probed.push(p);
        return false;
      },
    });
    maybeEmitSkillNudge(ctx);
    expect(probed.length).toBeGreaterThan(0);
    expect(probed.every(p => toPosix(p).startsWith('/work/here'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isPlanTemplateInvocation — src/index.ts's preAction hook uses
// this to exempt `test create --plan-template` from BOTH the skill nudge
// above and the update-registry check in update-check.ts. Extracted here
// (rather than left inline in src/index.ts, which executes `program.parse()`
// at import time and so cannot safely be imported by a unit test) purely so
// the boolean logic is directly unit-testable.
// ---------------------------------------------------------------------------

describe('isPlanTemplateInvocation', () => {
  it('true for `test create` with planTemplate: true', () => {
    expect(isPlanTemplateInvocation('test create', true)).toBe(true);
  });

  it('false for `test create` without planTemplate (undefined)', () => {
    expect(isPlanTemplateInvocation('test create', undefined)).toBe(false);
  });

  it('false for `test create` with planTemplate: false', () => {
    expect(isPlanTemplateInvocation('test create', false)).toBe(false);
  });

  it('false for any other command path even with planTemplate: true (Commander would never actually set this, but the check must not false-positive)', () => {
    expect(isPlanTemplateInvocation('test create-batch', true)).toBe(false);
    expect(isPlanTemplateInvocation('test run', true)).toBe(false);
    expect(isPlanTemplateInvocation('auth status', true)).toBe(false);
  });
});
