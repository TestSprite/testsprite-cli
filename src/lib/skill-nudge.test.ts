import { describe, expect, it } from 'vitest';
import { MANAGED_SECTION_BEGIN, MANAGED_SECTION_END, TARGETS } from './agent-targets.js';
import type { OutputMode } from './output.js';
import {
  SKILL_NUDGE_COMMANDS,
  SKILL_NUDGE_OPT_OUT_ENV,
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

  it('is silent in JSON mode (never pollutes a machine-readable stream)', () => {
    const { ctx, lines } = makeCtx({ output: 'json' as OutputMode });
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
