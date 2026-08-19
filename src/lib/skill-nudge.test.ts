import { describe, expect, it } from 'vitest';
import { TARGETS, pathFor, type AgentTarget } from './agent-targets.js';
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
  it('true when any single target landing exists (checked for every target)', () => {
    for (const id of Object.keys(TARGETS) as AgentTarget[]) {
      const landing = toPosix(pathFor(id, 'testsprite-verify'));
      const existsSync = (p: string) => toPosix(p).endsWith(landing);
      expect(isVerifySkillInstalled('/proj', { existsSync }), id).toBe(true);
    }
  });

  it('false when nothing is present', () => {
    expect(isVerifySkillInstalled('/proj', { existsSync: () => false })).toBe(false);
  });

  it('false for an unrelated file', () => {
    const existsSync = (p: string) => toPosix(p).endsWith('README.md');
    expect(isVerifySkillInstalled('/proj', { existsSync })).toBe(false);
  });

  it('checks paths under the supplied dir', () => {
    const seen: string[] = [];
    isVerifySkillInstalled('/some/proj', {
      existsSync: (p: string) => {
        seen.push(p);
        return false;
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(p => toPosix(p).startsWith('/some/proj'))).toBe(true);
    // One probe per supported target landing path.
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
