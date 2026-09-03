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

  it('false when nothing is present', () => {
    expect(isVerifySkillInstalled('/proj', { existsSync: () => false })).toBe(false);
  });

  it('false when the skill is installed only for an agent other than the required one', () => {
    // The silent miss this narrowing exists for: skills landed for claude, the
    // caller is cursor, and "installed" would be a lie from cursor's view.
    const existsSync = (p: string) =>
      toPosix(p).endsWith('.claude/skills/testsprite-verify/SKILL.md');
    expect(isVerifySkillInstalled('/proj', { existsSync })).toBe(true);
    expect(isVerifySkillInstalled('/proj', { existsSync, requiredTargets: ['cursor'] })).toBe(
      false,
    );
  });

  it('true when the skill is installed for the required agent', () => {
    const existsSync = (p: string) => toPosix(p).endsWith('.cursor/rules/testsprite-verify.mdc');
    expect(isVerifySkillInstalled('/proj', { existsSync, requiredTargets: ['cursor'] })).toBe(true);
  });

  it('probes only the required targets', () => {
    const seen: string[] = [];
    isVerifySkillInstalled('/proj', {
      existsSync: (p: string) => {
        seen.push(p);
        return false;
      },
      requiredTargets: ['cursor', 'codex'],
    });
    expect(seen).toHaveLength(2);
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

// ---------------------------------------------------------------------------
// maybeEmitSkillNudge — the calling agent narrows what counts as installed
// ---------------------------------------------------------------------------

describe('maybeEmitSkillNudge — when the environment names the caller', () => {
  const claudeInstalled = (p: string) =>
    toPosix(p).endsWith('.claude/skills/testsprite-verify/SKILL.md');
  const cursorInstalled = (p: string) => toPosix(p).endsWith('.cursor/rules/testsprite-verify.mdc');

  it('warns a cursor caller about a claude-only install, and says so', () => {
    const { ctx, lines } = makeCtx({
      env: { CURSOR_AGENT: '1' } as NodeJS.ProcessEnv,
      existsSync: claudeInstalled,
    });
    maybeEmitSkillNudge(ctx);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('not for cursor');
  });

  it('stays silent when the skill is installed for the calling agent', () => {
    const { ctx, lines } = makeCtx({
      env: { CURSOR_AGENT: '1' } as NodeJS.ProcessEnv,
      existsSync: cursorInstalled,
    });
    maybeEmitSkillNudge(ctx);
    expect(lines).toHaveLength(0);
  });

  it('keeps the any-agent answer when no environment signal names a caller', () => {
    const { ctx, lines } = makeCtx({ existsSync: claudeInstalled });
    maybeEmitSkillNudge(ctx);
    expect(lines).toHaveLength(0);
  });

  it('reports nothing-installed rather than installed-elsewhere when the project is bare', () => {
    const { ctx, lines } = makeCtx({
      env: { CURSOR_AGENT: '1' } as NodeJS.ProcessEnv,
      existsSync: () => false,
    });
    maybeEmitSkillNudge(ctx);
    expect(lines[0]).toContain('No TestSprite verification skill is installed');
  });

  // Two agents' variables can both be present — a shell that still carries the
  // outer agent's variable. The presence check is per caller and ANDed, so one
  // satisfied caller must not answer for the other.
  it('still warns when only one of two named callers has a skill', () => {
    const { ctx, lines } = makeCtx({
      env: { CLAUDECODE: '1', CURSOR_AGENT: '1' } as NodeJS.ProcessEnv,
      existsSync: claudeInstalled,
    });
    maybeEmitSkillNudge(ctx);
    expect(lines).toHaveLength(1);
    // Names only the caller that is actually missing one.
    expect(lines[0]).toContain('not for cursor');
    expect(lines[0]).not.toContain('claude');
  });

  it('stays silent only when every named caller has its own skill', () => {
    const { ctx, lines } = makeCtx({
      env: { CLAUDECODE: '1', CURSOR_AGENT: '1' } as NodeJS.ProcessEnv,
      existsSync: (p: string) => claudeInstalled(p) || cursorInstalled(p),
    });
    maybeEmitSkillNudge(ctx);
    expect(lines).toHaveLength(0);
  });

  it('names both callers when neither has a skill', () => {
    const { ctx, lines } = makeCtx({
      env: { CLAUDECODE: '1', CURSOR_AGENT: '1' } as NodeJS.ProcessEnv,
      existsSync: () => false,
    });
    maybeEmitSkillNudge(ctx);
    expect(lines[0]).toContain('No TestSprite verification skill is installed');
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
