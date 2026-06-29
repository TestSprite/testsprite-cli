import { readFileSync } from 'node:fs';

export type AgentTarget = 'claude' | 'cursor' | 'cline' | 'antigravity' | 'codex' | 'gemini';

export interface ManagedSectionSpec {
  begin: string;
  end: string;
  /** Optional documented load budget for root instruction files such as AGENTS.md. */
  loadBudgetBytes?: number;
  loadBudgetLabel?: string;
}

export interface TargetSpec {
  status: 'ga' | 'experimental';
  /** repo-relative landing path, POSIX separators */
  path: string;
  /**
   * 'own-file': the CLI owns the whole file.
   * 'managed-section': the CLI writes only a sentinel-delimited section inside
   * a potentially user-authored root instruction file.
   */
  mode: 'own-file' | 'managed-section';
  /** wrap the canonical body in this target's frontmatter/header */
  wrap(body: string): string;
  /** Sentinel and budget metadata for managed-section targets. */
  managedSection?: ManagedSectionSpec;
}

export const SKILL_NAME = 'testsprite-verify';

/**
 * Mirrors skill-template.md frontmatter `description`. ≤1536 chars (claude cap).
 * A unit test asserts byte-identity with the template file.
 */
export const SKILL_DESCRIPTION =
  'TestSprite verification loop — after finishing a feature or fix in a TestSprite-tested repo, use the `testsprite` CLI to run the relevant TestSprite tests against the change and inspect any failure artifacts before reporting the work as done. Use whenever code has changed outside docs/config and is about to be reported complete — by running an existing test that covers the change, or by creating a new TestSprite test (a frontend plan, or a backend Python assertion) and running it to a terminal verdict.';

function wrapSkill(body: string): string {
  return `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESCRIPTION}\n---\n\n${body}\n`;
}

function wrapMdc(body: string): string {
  return `---\ndescription: ${SKILL_DESCRIPTION}\nalwaysApply: false\n---\n\n${body}\n`;
}

/** Sentinel pair that bounds our managed section in AGENTS.md. */
export const MANAGED_SECTION_BEGIN =
  '<!-- BEGIN TESTSPRITE AGENT SECTION (testsprite agent install codex) -->';
export const MANAGED_SECTION_END = '<!-- END TESTSPRITE AGENT SECTION -->';

export const TARGETS: Record<AgentTarget, TargetSpec> = {
  claude: {
    status: 'ga',
    path: '.claude/skills/testsprite-verify/SKILL.md',
    mode: 'own-file',
    wrap: wrapSkill,
  },
  antigravity: {
    status: 'experimental',
    path: '.agents/skills/testsprite-verify/SKILL.md',
    mode: 'own-file',
    wrap: wrapSkill,
  },
  cursor: {
    status: 'experimental',
    path: '.cursor/rules/testsprite-verify.mdc',
    mode: 'own-file',
    wrap: wrapMdc,
  },
  cline: {
    status: 'experimental',
    path: '.clinerules/testsprite-verify.md',
    mode: 'own-file',
    wrap: body => body,
  },
  /**
   * codex target — managed-section mode.
   *
   * Codex auto-loads AGENTS.md from the project root (always-on, 32 KiB budget
   * for the whole file). Unlike own-file targets, we must NOT clobber a user's
   * existing AGENTS.md: we write only a sentinel-delimited section so other
   * project instructions coexist. The sentinel pair is the canonical identity
   * marker; the content between them is ours to replace.
   *
   * --force with managed-section: replaces the section unconditionally but
   * NEVER destroys content outside the sentinels. No whole-file .bak is written
   * for a section-only change — only a whole-file backup makes sense if the
   * entire file was ours to own (own-file mode). User content is never at risk.
   */
  codex: {
    status: 'experimental',
    path: 'AGENTS.md',
    mode: 'managed-section',
    // wrap is a no-op for managed-section — content is authored as plain Markdown
    // with no frontmatter (AGENTS.md is plain prose, not a skill schema).
    wrap: body => body,
    managedSection: {
      begin: MANAGED_SECTION_BEGIN,
      end: MANAGED_SECTION_END,
      loadBudgetBytes: 32768,
      loadBudgetLabel: 'Codex may not load content beyond its 32 KiB budget',
    },
  },
  /**
   * gemini target — managed-section mode.
   *
   * Gemini CLI reads GEMINI.md as the project instruction file. Like AGENTS.md,
   * it is commonly user-authored project context, so we merge a sentinel-delimited
   * section rather than owning the whole file.
   */
  gemini: {
    status: 'experimental',
    path: 'GEMINI.md',
    mode: 'managed-section',
    wrap: body => body,
    managedSection: {
      begin: '<!-- BEGIN TESTSPRITE AGENT SECTION (testsprite agent install gemini) -->',
      end: '<!-- END TESTSPRITE AGENT SECTION -->',
    },
  },
};

type ReadFn = (url: URL) => string;

const defaultRead: ReadFn = (url: URL) => readFileSync(url, 'utf8');

/**
 * Load the canonical skill body. `../../skills/...` resolves to the repo-root
 * `skills/` directory in BOTH source (vitest: `src/lib/` → `../../skills`) and
 * the built/published package (`dist/lib/` → `../../skills` = package root). The
 * directory ships verbatim via package.json `files`, so no build-time copy step
 * is needed (unlike the old `src/assets` → `dist/assets` mirror).
 *
 * Injectable `read` fn keeps unit tests off disk.
 */
export function loadSkillBody(read: ReadFn = defaultRead): string {
  return read(new URL('../../skills/testsprite-verify.skill.md', import.meta.url));
}

/**
 * Load the trimmed codex skill body (plain Markdown, no frontmatter).
 * Designed for managed-section injection into root instruction files.
 */
export function loadCodexSkillBody(read: ReadFn = defaultRead): string {
  return read(new URL('../../skills/testsprite-verify.codex.md', import.meta.url));
}

/**
 * Convenience for piece-2: returns the exact bytes to write for a target.
 *
 * For own-file targets, `body` defaults to the full skill body.
 * For managed-section targets, the trimmed Markdown body is used instead —
 * pass an explicit `body` to override in tests.
 */
export function renderForTarget(t: AgentTarget, body?: string): { path: string; content: string } {
  const spec = TARGETS[t];
  const resolvedBody =
    body !== undefined
      ? body
      : spec.mode === 'managed-section'
        ? loadCodexSkillBody()
        : loadSkillBody();
  return { path: spec.path, content: spec.wrap(resolvedBody) };
}
