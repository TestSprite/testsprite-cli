import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TARGETS, pathFor, type AgentTarget } from './agent-targets.js';
import { defaultCredentialsPath, readProfile } from './credentials.js';
import type { OutputMode } from './output.js';

/** Command paths that drive the verification loop, where a missing skill matters. */
export const SKILL_NUDGE_COMMANDS: ReadonlySet<string> = new Set([
  'test run',
  'test rerun',
  'test create',
  'test create-batch',
  'auth status',
  'auth whoami',
]);

/** Env var that silences the nudge. */
export const SKILL_NUDGE_OPT_OUT_ENV = 'TESTSPRITE_NO_SKILL_WARNING';

/**
 * True when this invocation is `test create --plan-template`, a
 * pure-local/informational flag (prints the plan-file skeleton and exits)
 * that must be treated like `setup` / `agent install`: exempt from BOTH the
 * missing-skill nudge above AND the update-registry check
 * (`src/lib/update-check.ts`'s `maybeNotifyUpdate`, which hits the network
 * and writes `~/.testsprite/update-check.json` — both contradict "no
 * network" for this flag). Neither allowlist (`SKILL_NUDGE_COMMANDS` here,
 * the unconditional call site in `src/index.ts`) tracks individual flags,
 * only whole commands, so `src/index.ts`'s `preAction` hook filters this one
 * case via this pure, independently-testable helper instead of teaching
 * either module about flags. Exported from `skill-nudge.ts` (rather than
 * `src/index.ts`, which executes `program.parse()` at import time and so
 * cannot be safely imported by a unit test) purely so it has a home that
 * supports direct unit testing.
 */
export function isPlanTemplateInvocation(
  commandPath: string,
  planTemplate: boolean | undefined,
): boolean {
  return commandPath === 'test create' && planTemplate === true;
}

export interface SkillPresenceDeps {
  existsSync?: (p: string) => boolean;
}

/** True if the `testsprite-verify` skill is reachable from any agent's skills directory in `dir`. */
export function isVerifySkillInstalled(dir: string, deps: SkillPresenceDeps = {}): boolean {
  const exists = deps.existsSync ?? existsSync;
  for (const target of Object.keys(TARGETS) as AgentTarget[]) {
    try {
      if (exists(join(dir, pathFor(target, 'testsprite-verify')))) return true;
    } catch {
      // unreadable → treat as absent, keep checking
    }
  }
  return false;
}

export interface SkillNudgeContext {
  /** Full command path, e.g. "test run" / "auth whoami". */
  commandPath: string;
  output: OutputMode;
  dryRun: boolean;
  profile: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  credentialsPath?: string;
  readProfileImpl?: (profile: string, opts: { path: string }) => { apiKey?: string } | undefined;
  stderr?: (line: string) => void;
  existsSync?: (p: string) => boolean;
}

/**
 * Best-effort stderr hint: when a configured caller runs a verify-loop command
 * in a project with no installed skill, point it at `testsprite setup`. Text
 * output only, skipped under --dry-run / opt-out env / unconfigured profile,
 * and never throws or blocks the command.
 */
export function maybeEmitSkillNudge(ctx: SkillNudgeContext): void {
  try {
    if (ctx.output !== 'text' || ctx.dryRun || isTruthyEnv(ctx.env[SKILL_NUDGE_OPT_OUT_ENV]))
      return;
    if (!SKILL_NUDGE_COMMANDS.has(ctx.commandPath)) return;

    const profile = (ctx.readProfileImpl ?? readProfile)(ctx.profile, {
      path: ctx.credentialsPath ?? defaultCredentialsPath(),
    });
    if (!profile?.apiKey) return;
    if (isVerifySkillInstalled(ctx.cwd, { existsSync: ctx.existsSync })) return;

    const write = ctx.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    write(
      '[warn] No TestSprite verification skill is installed in this project — your coding ' +
        'agent will not verify its changes against TestSprite. Run `testsprite setup` (or ' +
        `\`testsprite agent install\`) to set it up. Silence: ${SKILL_NUDGE_OPT_OUT_ENV}=1`,
    );
  } catch {
    // A nudge must never alter the outcome of the real command.
  }
}

function isTruthyEnv(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no';
}
