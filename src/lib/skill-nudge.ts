import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MANAGED_SECTION_BEGIN, MANAGED_SECTION_END, TARGETS } from './agent-targets.js';
import { defaultCredentialsPath, readProfile } from './credentials.js';
import type { OutputMode } from './output.js';

/**
 * Full command paths (group + leaf) that signal the caller is actively driving
 * the verification loop — running or authoring tests, or checking auth in
 * preflight. The skill nudge fires ONLY for these.
 *
 * Deliberately excluded:
 * - `setup` / `init` / `agent install` — they ARE the fix; nudging is circular.
 * - read-only inspection (`test list/get/result/...`, `project list/get`) —
 *   keeps an agent that is merely browsing from being nagged.
 * - `auth configure` / `auth remove` (and the deprecated `auth logout`) —
 *   credential management, not the loop.
 *
 * Match the strings emitted by `commandPathOf` in `src/index.ts`. `auth status`
 * is the primary identity command; `auth whoami` is its deprecated alias and is
 * listed too so the warning fires regardless of which name the caller uses.
 */
export const SKILL_NUDGE_COMMANDS: ReadonlySet<string> = new Set([
  'test run',
  'test rerun',
  'test create',
  'test create-batch',
  'auth status',
  'auth whoami',
]);

/**
 * Env var that silences the warning. For CI, or users who deliberately drive
 * the CLI by hand without wiring a coding agent.
 */
export const SKILL_NUDGE_OPT_OUT_ENV = 'TESTSPRITE_NO_SKILL_WARNING';

export interface SkillPresenceDeps {
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string) => string;
}

/**
 * True if the `testsprite-verify` skill is installed for ANY supported agent in
 * `dir`. own-file targets (claude/cursor/cline/antigravity): the landing file
 * exists. managed-section target (codex / AGENTS.md): the file exists AND
 * carries one complete managed section — a user-authored AGENTS.md without the
 * sentinels, or with a truncated section, does NOT count as our skill.
 *
 * The TARGETS table is the single source of truth for landing paths, so this
 * stays in lockstep with `agent install` without re-listing paths. Best-effort:
 * a per-target read error is swallowed (that target is treated as absent).
 */
export function isVerifySkillInstalled(dir: string, deps: SkillPresenceDeps = {}): boolean {
  const exists = deps.existsSync ?? existsSync;
  const read = deps.readFileSync ?? ((p: string) => readFileSync(p, 'utf8'));
  for (const spec of Object.values(TARGETS)) {
    const full = join(dir, spec.path);
    if (!exists(full)) continue;
    if (spec.mode === 'managed-section') {
      try {
        if (hasCompleteManagedSection(read(full))) return true;
      } catch {
        // unreadable AGENTS.md → treat this target as absent, keep checking
      }
      continue;
    }
    return true; // own-file landing file present
  }
  return false;
}

/** True when a managed-section file contains an ordered TestSprite BEGIN/END pair. */
function hasCompleteManagedSection(content: string): boolean {
  const begin = content.indexOf(MANAGED_SECTION_BEGIN);
  if (begin === -1) return false;
  const end = content.indexOf(MANAGED_SECTION_END, begin + MANAGED_SECTION_BEGIN.length);
  return end !== -1;
}

export interface SkillNudgeContext {
  /** Full command path, e.g. "test run" / "auth whoami". */
  commandPath: string;
  output: OutputMode;
  dryRun: boolean;
  profile: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Override the credentials file location (tests). */
  credentialsPath?: string;
  /** Override the profile lookup (tests); defaults to the real `readProfile`. */
  readProfileImpl?: (profile: string, opts: { path: string }) => { apiKey?: string } | undefined;
  /** Sink for the hint line; defaults to `process.stderr`. */
  stderr?: (line: string) => void;
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string) => string;
}

/**
 * Best-effort onboarding warning. When a configured caller drives a verify-loop
 * command in a project that has NO installed skill, print a one-line `[warn]`
 * line to stderr pointing at `testsprite setup`. Reaches a coding agent at the
 * exact moment it uses the CLI without the skill wired up.
 *
 * Gates (all must pass to emit): text output (never pollutes `--output json`),
 * not `--dry-run`, the command is in {@link SKILL_NUDGE_COMMANDS}, the opt-out
 * env is unset, the active profile has an api key (un-configured callers hit an
 * auth error that already points at setup), and the skill is not already
 * installed. Never throws and never blocks the command — any error is swallowed.
 */
export function maybeEmitSkillNudge(ctx: SkillNudgeContext): void {
  try {
    if (ctx.output !== 'text') return;
    if (ctx.dryRun) return;
    if (isTruthyEnv(ctx.env[SKILL_NUDGE_OPT_OUT_ENV])) return;
    if (!SKILL_NUDGE_COMMANDS.has(ctx.commandPath)) return;

    const credsPath = ctx.credentialsPath ?? defaultCredentialsPath();
    const lookup = ctx.readProfileImpl ?? readProfile;
    const profile = lookup(ctx.profile, { path: credsPath });
    if (!profile?.apiKey) return;

    if (
      isVerifySkillInstalled(ctx.cwd, {
        existsSync: ctx.existsSync,
        readFileSync: ctx.readFileSync,
      })
    ) {
      return;
    }

    const write = ctx.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    write(
      '[warn] No TestSprite verification skill is installed in this project — your coding ' +
        'agent will not verify its changes against TestSprite. Run `testsprite setup` (or ' +
        `\`testsprite agent install\`) to set it up. Silence: ${SKILL_NUDGE_OPT_OUT_ENV}=1`,
    );
  } catch {
    // A nudge must never break, delay, or alter the exit status of a real
    // command. Swallow everything (missing creds file, fs races, etc.).
  }
}

/** Interpret common env-var spellings for an enabled opt-out flag. */
function isTruthyEnv(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false' && s !== 'no';
}
