import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { VERSION } from '../version.js';

export type AgentTarget =
  | 'claude'
  | 'cursor'
  | 'cline'
  | 'antigravity'
  | 'codex'
  | 'kiro'
  | 'windsurf';

export interface TargetSpec {
  status: 'ga' | 'experimental';
  /**
   * Repo-relative landing path for the CANONICAL skill (`testsprite-verify`),
   * POSIX separators. Kept for back-compat: `skill-nudge.ts` reads this to detect
   * a verify install, and `agent list`/tests reference it. For any skill, derive
   * the real path via {@link pathFor} — this field is `pathFor(target, SKILL_NAME)`.
   */
  path: string;
  /**
   * 'own-file': the CLI owns the whole file (claude/cursor/cline/antigravity/windsurf).
   * 'managed-section': the CLI writes only a sentinel-delimited section inside
   * a potentially user-authored file (codex target, AGENTS.md).
   */
  mode: 'own-file' | 'managed-section';
  /**
   * When true, render the budget-friendly body (see {@link compactBodyFor})
   * instead of the full own-file skill body. Used for own-file targets whose
   * rule files are size-capped — currently `windsurf` (`.windsurf/rules/*.md`
   * files cap at ~12 K characters and Cascade silently truncates beyond that,
   * which would cut the full ~22 KB verify skill in half).
   */
  compactBody?: boolean;
  /**
   * Wrap a skill body in this target's frontmatter/header. Takes the skill's
   * `name`+`description` (own-file targets emit them as frontmatter) and the body.
   * No-op for cline (body verbatim) and codex (managed-section authors plain
   * Markdown with no frontmatter).
   */
  wrap(name: string, description: string, body: string): string;
}

// ---------------------------------------------------------------------------
// Skill registry
// ---------------------------------------------------------------------------

/**
 * How a skill contributes to the codex target's always-on `AGENTS.md` section.
 *
 * - 'full': inject the skill's trimmed codex body (a `*.codex.md` asset). Used by
 *   `testsprite-verify` (~6 KiB).
 * - 'line': inject a single short line authored inline here. Used by
 *   `testsprite-onboard` — the full 6-step flow doesn't belong in an always-on,
 *   32 KiB-budgeted file, but a one-line signal does.
 * - 'none': skill is not represented in AGENTS.md at all (reserved).
 */
export type CodexContribution =
  | { kind: 'full'; file: string }
  | { kind: 'line'; text: string }
  | { kind: 'none' };

export interface SkillSpec {
  /** Skill name — appears in own-file frontmatter and the landing path. */
  name: string;
  /** ≤1536 chars (claude description cap). Byte-identical to its template doc. */
  description: string;
  /** Own-file body asset basename under `skills/`, e.g. 'testsprite-verify.skill.md'. */
  bodyFile: string;
  /** How this skill contributes to the codex AGENTS.md managed section. */
  codex: CodexContribution;
}

/**
 * `testsprite-onboard` codex contribution — a single always-on line. Kept here
 * (not in a `*.codex.md` asset) because it is one line; see {@link CodexContribution}.
 */
export const ONBOARD_CODEX_LINE =
  '**First-time setup:** if this repo has no TestSprite tests yet, seed a *broad* first suite across its main user flows — not just one test — each with a concrete, observable assertion, before reporting setup as done.';

/**
 * The skill registry. Each entry owns its name, description (drift-guarded by a
 * byte-identity unit test against a template doc), own-file body asset, and codex
 * contribution. `agent install` / `setup` install {@link DEFAULT_SKILLS}; the
 * codex target aggregates every installed skill's codex contribution into ONE
 * AGENTS.md section.
 */
export const SKILLS: Record<string, SkillSpec> = {
  'testsprite-verify': {
    name: 'testsprite-verify',
    description:
      'TestSprite verification loop — after finishing a feature or fix in a TestSprite-tested repo, use the `testsprite` CLI to run the relevant TestSprite tests against the change and inspect any failure artifacts before reporting the work as done. Use whenever code has changed outside docs/config and is about to be reported complete — by running an existing test that covers the change, or by creating a new TestSprite test (a frontend plan, or a backend Python assertion) and running it to a terminal verdict.',
    bodyFile: 'testsprite-verify.skill.md',
    codex: { kind: 'full', file: 'testsprite-verify.codex.md' },
  },
  'testsprite-onboard': {
    name: 'testsprite-onboard',
    description:
      'Stand up a complete, runnable TestSprite test suite for the current repo at first use — create a project (with a target URL and auth), derive a coherent set of tests from the codebase, batch-create them, and smoke-run a few to a green verdict so the user immediately has something worth running. Use ONLY when a repo has no TestSprite tests yet (a fresh project), right after `testsprite setup`, or when the user asks to "set up / bootstrap / seed tests". This is first-run setup, NOT change verification — once a project already has tests, use the testsprite-verify skill instead.',
    bodyFile: 'testsprite-onboard.skill.md',
    codex: { kind: 'line', text: ONBOARD_CODEX_LINE },
  },
};

/**
 * Skills installed by `setup` and by `agent install` when no `--skill` subset is
 * given. Order is significant for the codex aggregate (verify first, then the
 * onboard line as a short addendum).
 */
export const DEFAULT_SKILLS = ['testsprite-verify', 'testsprite-onboard'] as const;

// ---------------------------------------------------------------------------
// Back-compat single-skill exports (= the canonical `testsprite-verify` skill)
// ---------------------------------------------------------------------------

/** @deprecated The canonical skill name. New code: iterate {@link SKILLS}. */
export const SKILL_NAME = 'testsprite-verify';

/**
 * @deprecated The canonical skill's description. New code:
 * `SKILLS['testsprite-verify'].description`. Kept so existing importers and the
 * byte-identity unit test keep working.
 */
export const SKILL_DESCRIPTION = SKILLS['testsprite-verify']!.description;

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

function wrapSkill(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

function wrapMdc(_name: string, description: string, body: string): string {
  return `---\ndescription: ${description}\nalwaysApply: false\n---\n\n${body}\n`;
}

/**
 * Windsurf (Cascade) reads workspace rules from `.windsurf/rules/*.md` with YAML
 * frontmatter. `trigger: model_decision` is the Cascade equivalent of the Cursor
 * `.mdc` `alwaysApply: false` mode: only the `description` is surfaced up front,
 * and Cascade pulls in the full rule body when the description shows it is
 * relevant — exactly the on-demand activation these skills want. (The other
 * triggers are `always_on`, `manual`, and `glob`.)
 */
function wrapWindsurf(_name: string, description: string, body: string): string {
  return `---\ntrigger: model_decision\ndescription: ${description}\n---\n\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Landing paths
// ---------------------------------------------------------------------------

/**
 * Repo-relative landing path for a given skill on a given target (POSIX
 * separators). Own-file targets embed the skill name in the path so multiple
 * skills coexist; the codex target always lands at the single shared `AGENTS.md`
 * (every skill's codex contribution is merged into one managed section there).
 */
export function pathFor(target: AgentTarget, skill: string): string {
  switch (target) {
    case 'claude':
      return `.claude/skills/${skill}/SKILL.md`;
    case 'antigravity':
      return `.agents/skills/${skill}/SKILL.md`;
    case 'cursor':
      return `.cursor/rules/${skill}.mdc`;
    case 'cline':
      return `.clinerules/${skill}.md`;
    case 'kiro':
      return `.kiro/skills/${skill}/SKILL.md`;
    case 'windsurf':
      return `.windsurf/rules/${skill}.md`;
    case 'codex':
      return 'AGENTS.md';
  }
}

export const TARGETS: Record<AgentTarget, TargetSpec> = {
  claude: {
    status: 'ga',
    path: pathFor('claude', SKILL_NAME),
    mode: 'own-file',
    wrap: wrapSkill,
  },
  antigravity: {
    status: 'experimental',
    path: pathFor('antigravity', SKILL_NAME),
    mode: 'own-file',
    wrap: wrapSkill,
  },
  cursor: {
    status: 'experimental',
    path: pathFor('cursor', SKILL_NAME),
    mode: 'own-file',
    wrap: wrapMdc,
  },
  cline: {
    status: 'experimental',
    path: pathFor('cline', SKILL_NAME),
    mode: 'own-file',
    wrap: (_name, _description, body) => body,
  },
  kiro: {
    status: 'experimental',
    path: pathFor('kiro', SKILL_NAME),
    mode: 'own-file',
    // kiro reads SKILL.md files with name/description frontmatter, same as
    // claude/antigravity, so it shares the wrapSkill wrapper.
    wrap: wrapSkill,
  },
  windsurf: {
    status: 'experimental',
    path: pathFor('windsurf', SKILL_NAME),
    mode: 'own-file',
    // Windsurf rules files are budget-capped (~12 K chars per `.windsurf/rules/*.md`),
    // so render the compact body per skill (see compactBodyFor).
    compactBody: true,
    wrap: wrapWindsurf,
  },
  /**
   * codex target — managed-section mode.
   *
   * Codex auto-loads AGENTS.md from the project root (always-on, 32 KiB budget
   * for the whole file). Unlike own-file targets, we must NOT clobber a user's
   * existing AGENTS.md: we write only a sentinel-delimited section so other
   * project instructions coexist. The sentinel pair is the canonical identity
   * marker; the content between them is ours to replace. EVERY installed skill's
   * codex contribution is aggregated into this one section (see
   * {@link buildCodexAggregate}).
   *
   * --force with managed-section: replaces the section unconditionally but
   * NEVER destroys content outside the sentinels. No whole-file .bak is written
   * for a section-only change — only a whole-file backup makes sense if the
   * entire file was ours to own (own-file mode). User content is never at risk.
   */
  codex: {
    status: 'experimental',
    path: pathFor('codex', SKILL_NAME),
    mode: 'managed-section',
    // wrap is a no-op for managed-section — content is authored as plain Markdown
    // with no frontmatter (AGENTS.md is plain prose, not a skill schema).
    wrap: (_name, _description, body) => body,
  },
};

/** Sentinel pair that bounds our managed section in AGENTS.md. */
export const MANAGED_SECTION_BEGIN =
  '<!-- BEGIN TESTSPRITE AGENT SECTION (testsprite agent install codex) -->';
export const MANAGED_SECTION_END = '<!-- END TESTSPRITE AGENT SECTION -->';

// ---------------------------------------------------------------------------
// Install marker (stale-skill detection, issue #123)
// ---------------------------------------------------------------------------

/**
 * Hex characters of the canonical body's SHA-256 kept in the install marker.
 * 12 hex chars (48 bits) is ample for drift DETECTION (equality against bodies
 * this CLI ships); the marker is provenance metadata, not a security boundary.
 */
const MARKER_HASH_HEX_LENGTH = 12;

/**
 * When one marker covers several skills (the codex managed section aggregates
 * every installed skill), their names are joined with this separator in the
 * marker's skill field. Skill names never contain '+' (see {@link SKILLS} keys).
 */
export const MARKER_SKILL_SEPARATOR = '+';

/**
 * Marker line shape: `<!-- testsprite-skill: <name> v<version> sha256:<hash> -->`.
 * An HTML comment is inert in every target format (SKILL.md, .mdc, .clinerules
 * markdown, AGENTS.md). Built via `new RegExp` so the hash length stays bound
 * to {@link MARKER_HASH_HEX_LENGTH}.
 */
const SKILL_MARKER_LINE_RE = new RegExp(
  `^<!-- testsprite-skill: (\\S+) v(\\S+) sha256:([0-9a-f]{${MARKER_HASH_HEX_LENGTH}}) -->$`,
);

/**
 * First {@link MARKER_HASH_HEX_LENGTH} hex chars of the SHA-256 of a canonical
 * skill body. The hash covers the CANONICAL BODY ONLY (pre-wrap, pre-marker),
 * so writing the marker into the rendered artifact never changes the hash the
 * marker itself carries.
 */
export function bodyHash12(canonicalBody: string): string {
  return createHash('sha256')
    .update(canonicalBody, 'utf8')
    .digest('hex')
    .slice(0, MARKER_HASH_HEX_LENGTH);
}

/**
 * Build the provenance marker line for a skill (or a
 * {@link MARKER_SKILL_SEPARATOR}-joined skill set) and its canonical body.
 * `agent status` compares this fingerprint against the bodies the running CLI
 * ships to detect silently stale installs.
 */
export function buildSkillMarker(skillName: string, canonicalBody: string): string {
  return `<!-- testsprite-skill: ${skillName} v${VERSION} sha256:${bodyHash12(canonicalBody)} -->`;
}

/** A marker line parsed back into its fields. */
export interface ParsedSkillMarker {
  /** Skill name, or several names joined with {@link MARKER_SKILL_SEPARATOR}. */
  skill: string;
  /** CLI version that wrote the artifact. */
  version: string;
  /** First 12 hex chars of the canonical body's SHA-256 at install time. */
  hash12: string;
  /** The exact marker line (trailing CR/whitespace stripped) as found. */
  line: string;
}

/**
 * Find the first testsprite-skill marker line in `content`, or null when the
 * content carries none (a pre-marker install). Lines are matched whole with
 * trailing CR/whitespace stripped, so CRLF checkouts parse identically.
 */
export function parseSkillMarker(content: string): ParsedSkillMarker | null {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd();
    const matched = SKILL_MARKER_LINE_RE.exec(line);
    if (matched) {
      return { skill: matched[1]!, version: matched[2]!, hash12: matched[3]!, line };
    }
  }
  return null;
}

type ReadFn = (url: URL) => string;

const defaultRead: ReadFn = (url: URL) => readFileSync(url, 'utf8');

// ---------------------------------------------------------------------------
// Asset loaders
// ---------------------------------------------------------------------------

/**
 * Resolve a `skills/<file>` asset. `../../skills/...` resolves to the repo-root
 * `skills/` directory in BOTH source (vitest: `src/lib/` → `../../skills`) and
 * the built/published package (`dist/lib/` → `../../skills` = package root). The
 * directory ships verbatim via package.json `files`, so no build-time copy step
 * is needed. Injectable `read` keeps unit tests off disk.
 */
function readSkillAsset(file: string, read: ReadFn): string {
  return read(new URL(`../../skills/${file}`, import.meta.url));
}

/** Load a skill's own-file body by skill name (frontmatter is added by `wrap`). */
export function loadSkillBodyFor(skill: string, read: ReadFn = defaultRead): string {
  const spec = SKILLS[skill];
  if (!spec) throw new Error(`unknown skill: ${skill}`);
  return readSkillAsset(spec.bodyFile, read);
}

/**
 * Budget-friendly body for an own-file target whose rule files are size-capped
 * (e.g. windsurf). For a skill that ships a trimmed codex asset (`codex.kind ===
 * 'full'`, e.g. `testsprite-verify` — full body ~22 KB, codex ~5 KB) we render
 * that compact asset so the wrapped file stays under the cap. For skills whose
 * codex contribution is only a one-liner (`'line'`/`'none'`, e.g.
 * `testsprite-onboard`), the one-liner is useless as a standalone rule and the
 * full own-file body (~6.5 KB) already fits the budget — so the full body is
 * used.
 */
export function compactBodyFor(skill: string, read: ReadFn = defaultRead): string {
  const spec = SKILLS[skill];
  if (!spec) throw new Error(`unknown skill: ${skill}`);
  return spec.codex.kind === 'full'
    ? readSkillAsset(spec.codex.file, read)
    : loadSkillBodyFor(skill, read);
}

/**
 * Resolve a skill's codex (AGENTS.md) contribution as a Markdown string.
 * 'full' → read the `*.codex.md` asset; 'line' → the inline one-liner; 'none' → ''.
 */
export function codexContentFor(skill: string, read: ReadFn = defaultRead): string {
  const spec = SKILLS[skill];
  if (!spec) throw new Error(`unknown skill: ${skill}`);
  const c = spec.codex;
  if (c.kind === 'full') return readSkillAsset(c.file, read);
  if (c.kind === 'line') return c.text;
  return '';
}

/**
 * Compose the codex managed-section BODY (sans sentinels) from several skills:
 * each skill's codex contribution, trimmed, joined by a blank line, in the given
 * order. A single `['testsprite-verify']` aggregate is byte-identical to the old
 * single-skill codex body, so existing AGENTS.md installs round-trip unchanged.
 */
export function buildCodexAggregate(skills: readonly string[], read: ReadFn = defaultRead): string {
  return skills
    .map(s => codexContentFor(s, read).trimEnd())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Back-compat: the canonical verify skill body (own-file). Kept so existing
 * importers and the `loadSkillBody(read)` unit-test signature keep working.
 * @deprecated Use {@link loadSkillBodyFor}.
 */
export function loadSkillBody(read: ReadFn = defaultRead): string {
  return loadSkillBodyFor(SKILL_NAME, read);
}

/**
 * Back-compat: the canonical verify skill's trimmed codex body. Kept so existing
 * importers and the `loadCodexSkillBody(read)` unit-test signature keep working.
 * @deprecated Use {@link codexContentFor}.
 */
export function loadCodexSkillBody(read: ReadFn = defaultRead): string {
  return codexContentFor(SKILL_NAME, read);
}

// ---------------------------------------------------------------------------
// renderForTarget
// ---------------------------------------------------------------------------

/**
 * Place the marker line inside a wrapped own-file render.
 *
 * - Wraps that emit YAML frontmatter (claude/antigravity/cursor): the marker
 *   lands on the line right after the closing `---` fence, before the body.
 * - Wrapless targets (cline, body verbatim): the marker is appended as the
 *   LAST line instead. Cline surfaces the file's first heading as the rule
 *   title, so a leading comment would displace the body's H1.
 */
function injectMarkerLine(wrapped: string, markerLine: string): string {
  if (wrapped.startsWith('---\n')) {
    // The name/description frontmatter values are single-line, so the first
    // `\n---\n` after the opening fence is always the closing fence.
    const closingFence = '\n---\n';
    const fenceIdx = wrapped.indexOf(closingFence);
    if (fenceIdx !== -1) {
      const insertAt = fenceIdx + closingFence.length;
      return `${wrapped.slice(0, insertAt)}${markerLine}\n${wrapped.slice(insertAt)}`;
    }
  }
  const separator = wrapped.endsWith('\n') ? '' : '\n';
  return `${wrapped}${separator}${markerLine}\n`;
}

/**
 * Exact own-file bytes for a skill on a target, carrying the GIVEN marker line.
 * `agent status` uses this to re-render the current canonical body with a
 * file's own (possibly older-versioned) marker: when only the marker's version
 * string lags but the body is unchanged, the artifact still compares pristine.
 */
export function renderOwnFileWithMarker(
  target: AgentTarget,
  skill: string,
  markerLine: string,
  body?: string,
): string {
  const spec = TARGETS[target];
  if (spec.mode !== 'own-file') {
    throw new Error(`renderOwnFileWithMarker: ${target} is not an own-file target`);
  }
  const skillSpec = SKILLS[skill];
  if (!skillSpec) throw new Error(`unknown skill: ${skill}`);
  const resolvedBody = body !== undefined ? body : loadSkillBodyFor(skill);
  return injectMarkerLine(
    spec.wrap(skillSpec.name, skillSpec.description, resolvedBody),
    markerLine,
  );
}

/**
 * The exact bytes to write for one skill on one target.
 *
 * - own-file targets: `body` defaults to the skill's own-file asset, wrapped in
 *   the target's frontmatter/header, and carrying a provenance marker line so
 *   `agent status` can tell fresh, stale, and hand-edited installs apart.
 * - codex (managed-section): returns the skill's codex contribution unwrapped
 *   and marker-free (plain Markdown, no frontmatter). The real install does NOT
 *   call this for codex: it aggregates all skills via
 *   {@link buildCodexAggregate} and writes ONE marker just inside the BEGIN
 *   sentinel. It is kept single-skill here for tests and parity. Pass an
 *   explicit `body` to override.
 */
export function renderForTarget(
  t: AgentTarget,
  skill: string,
  body?: string,
): { path: string; content: string } {
  const spec = TARGETS[t];
  const skillSpec = SKILLS[skill];
  if (!skillSpec) throw new Error(`unknown skill: ${skill}`);
  const path = pathFor(t, skill);
  if (spec.mode === 'managed-section') {
    const resolvedBody = body !== undefined ? body : codexContentFor(skill);
    return { path, content: spec.wrap(skillSpec.name, skillSpec.description, resolvedBody) };
  }
  const resolvedBody =
    body !== undefined ? body : spec.compactBody ? compactBodyFor(skill) : loadSkillBodyFor(skill);
  return {
    path,
    content: renderOwnFileWithMarker(t, skill, buildSkillMarker(skill, resolvedBody), resolvedBody),
  };
}
