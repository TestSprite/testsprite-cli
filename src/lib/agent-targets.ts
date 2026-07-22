import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { VERSION } from '../version.js';

/**
 * Agent-skill installation, following the [Agent Skills](https://agentskills.io)
 * open standard. Each skill has one canonical copy at
 * `.agents/skills/<skill>/SKILL.md`. "Universal" agents read it directly;
 * every other agent gets a symlink from its own skills folder back to it.
 */

/** Canonical skills directory (POSIX, repo-relative). */
export const CANONICAL_SKILLS_DIR = '.agents/skills';

// ---------------------------------------------------------------------------
// Skill registry — name/description live in each SKILL.md's frontmatter.
// ---------------------------------------------------------------------------

/** Static index of a shipped skill → its SKILL.md asset. Disk-free on import. */
interface SkillAsset {
  /** Asset basename under `skills/`, e.g. 'testsprite-verify.skill.md'. */
  file: string;
}

/** id → SKILL.md asset. Disk-free on import; metadata is parsed on load. */
export const SKILLS: Record<string, SkillAsset> = {
  'testsprite-verify': { file: 'testsprite-verify.skill.md' },
  'testsprite-onboard': { file: 'testsprite-onboard.skill.md' },
};

/** Skills installed by `setup` and `agent install` when `--skill` is omitted. */
export const DEFAULT_SKILLS = ['testsprite-verify', 'testsprite-onboard'] as const;

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

export interface TargetSpec {
  displayName: string;
  /** Project-relative skills directory (POSIX). Universal agents use CANONICAL_SKILLS_DIR. */
  skillsDir: string;
  /** True when the agent reads .agents/skills directly (no symlink needed). */
  universal: boolean;
}

/** Standard agent id → its project skills directory and universal flag. */
export const TARGETS: Record<string, TargetSpec> = {
  'aider-desk': { displayName: 'AiderDesk', skillsDir: '.aider-desk/skills', universal: false },
  amp: { displayName: 'Amp', skillsDir: CANONICAL_SKILLS_DIR, universal: true },
  antigravity: { displayName: 'Antigravity', skillsDir: CANONICAL_SKILLS_DIR, universal: true },
  'antigravity-cli': {
    displayName: 'Antigravity CLI',
    skillsDir: CANONICAL_SKILLS_DIR,
    universal: true,
  },
  astrbot: { displayName: 'AstrBot', skillsDir: 'data/skills', universal: false },
  'autohand-code': {
    displayName: 'Autohand Code CLI',
    skillsDir: '.autohand/skills',
    universal: false,
  },
  augment: { displayName: 'Augment', skillsDir: '.augment/skills', universal: false },
  bob: { displayName: 'IBM Bob', skillsDir: '.bob/skills', universal: false },
  'claude-code': { displayName: 'Claude Code', skillsDir: '.claude/skills', universal: false },
  openclaw: { displayName: 'OpenClaw', skillsDir: 'skills', universal: false },
  cline: { displayName: 'Cline', skillsDir: CANONICAL_SKILLS_DIR, universal: true },
  'codearts-agent': {
    displayName: 'CodeArts Agent',
    skillsDir: '.codeartsdoer/skills',
    universal: false,
  },
  codebuddy: { displayName: 'CodeBuddy', skillsDir: '.codebuddy/skills', universal: false },
  codemaker: { displayName: 'Codemaker', skillsDir: '.codemaker/skills', universal: false },
  codestudio: { displayName: 'Code Studio', skillsDir: '.codestudio/skills', universal: false },
  codex: { displayName: 'Codex', skillsDir: CANONICAL_SKILLS_DIR, universal: true },
  'command-code': {
    displayName: 'Command Code',
    skillsDir: '.commandcode/skills',
    universal: false,
  },
  continue: { displayName: 'Continue', skillsDir: '.continue/skills', universal: false },
  cortex: { displayName: 'Cortex Code', skillsDir: '.cortex/skills', universal: false },
  crush: { displayName: 'Crush', skillsDir: '.crush/skills', universal: false },
  cursor: { displayName: 'Cursor', skillsDir: CANONICAL_SKILLS_DIR, universal: true },
  deepagents: { displayName: 'Deep Agents', skillsDir: CANONICAL_SKILLS_DIR, universal: true },
  devin: { displayName: 'Devin for Terminal', skillsDir: '.devin/skills', universal: false },
  dexto: { displayName: 'Dexto', skillsDir: CANONICAL_SKILLS_DIR, universal: true },
  droid: { displayName: 'Droid', skillsDir: '.factory/skills', universal: false },
  eve: { displayName: 'Eve', skillsDir: 'agent/skills', universal: false },
  firebender: { displayName: 'Firebender', skillsDir: CANONICAL_SKILLS_DIR, universal: true },
  forgecode: { displayName: 'ForgeCode', skillsDir: '.forge/skills', universal: false },
  'gemini-cli': { displayName: 'Gemini CLI', skillsDir: CANONICAL_SKILLS_DIR, universal: true },
  'github-copilot': {
    displayName: 'GitHub Copilot',
    skillsDir: CANONICAL_SKILLS_DIR,
    universal: true,
  },
  goose: { displayName: 'Goose', skillsDir: '.goose/skills', universal: false },
  'hermes-agent': { displayName: 'Hermes Agent', skillsDir: '.hermes/skills', universal: false },
  'inference-sh': {
    displayName: 'inference.sh',
    skillsDir: '.inferencesh/skills',
    universal: false,
  },
  jazz: { displayName: 'Jazz', skillsDir: '.jazz/skills', universal: false },
  junie: { displayName: 'Junie', skillsDir: '.junie/skills', universal: false },
  'iflow-cli': { displayName: 'iFlow CLI', skillsDir: '.iflow/skills', universal: false },
  kilo: { displayName: 'Kilo Code', skillsDir: '.kilocode/skills', universal: false },
  'kimi-code-cli': {
    displayName: 'Kimi Code CLI',
    skillsDir: CANONICAL_SKILLS_DIR,
    universal: true,
  },
  'kiro-cli': { displayName: 'Kiro CLI', skillsDir: '.kiro/skills', universal: false },
  kode: { displayName: 'Kode', skillsDir: '.kode/skills', universal: false },
  lingma: { displayName: 'Lingma', skillsDir: '.lingma/skills', universal: false },
  loaf: { displayName: 'Loaf', skillsDir: CANONICAL_SKILLS_DIR, universal: true },
  mcpjam: { displayName: 'MCPJam', skillsDir: '.mcpjam/skills', universal: false },
  'mistral-vibe': { displayName: 'Mistral Vibe', skillsDir: '.vibe/skills', universal: false },
  moxby: { displayName: 'Moxby', skillsDir: '.moxby/skills', universal: false },
  mux: { displayName: 'Mux', skillsDir: '.mux/skills', universal: false },
  opencode: { displayName: 'OpenCode', skillsDir: CANONICAL_SKILLS_DIR, universal: true },
  openhands: { displayName: 'OpenHands', skillsDir: '.openhands/skills', universal: false },
  ona: { displayName: 'Ona', skillsDir: '.ona/skills', universal: false },
  pi: { displayName: 'Pi', skillsDir: '.pi/skills', universal: false },
  qoder: { displayName: 'Qoder', skillsDir: '.qoder/skills', universal: false },
  'qoder-cn': { displayName: 'Qoder CN', skillsDir: '.qoder/skills', universal: false },
  'qwen-code': { displayName: 'Qwen Code', skillsDir: '.qwen/skills', universal: false },
  replit: { displayName: 'Replit', skillsDir: CANONICAL_SKILLS_DIR, universal: true },
  reasonix: { displayName: 'Reasonix', skillsDir: '.reasonix/skills', universal: false },
  roo: { displayName: 'Roo Code', skillsDir: '.roo/skills', universal: false },
  rovodev: { displayName: 'Rovo Dev', skillsDir: '.rovodev/skills', universal: false },
  'tabnine-cli': {
    displayName: 'Tabnine CLI',
    skillsDir: '.tabnine/agent/skills',
    universal: false,
  },
  terramind: { displayName: 'Terramind', skillsDir: '.terramind/skills', universal: false },
  tinycloud: { displayName: 'Tinycloud', skillsDir: '.tinycloud/skills', universal: false },
  trae: { displayName: 'Trae', skillsDir: '.trae/skills', universal: false },
  'trae-cn': { displayName: 'Trae CN', skillsDir: '.trae/skills', universal: false },
  warp: { displayName: 'Warp', skillsDir: CANONICAL_SKILLS_DIR, universal: true },
  windsurf: { displayName: 'Windsurf', skillsDir: '.windsurf/skills', universal: false },
  zed: { displayName: 'Zed', skillsDir: CANONICAL_SKILLS_DIR, universal: true },
  zcode: { displayName: 'ZCode', skillsDir: '.zcode/skills', universal: false },
  zencoder: { displayName: 'Zencoder', skillsDir: '.zencoder/skills', universal: false },
  zenflow: { displayName: 'Zenflow', skillsDir: '.zencoder/skills', universal: false },
  neovate: { displayName: 'Neovate', skillsDir: '.neovate/skills', universal: false },
  pochi: { displayName: 'Pochi', skillsDir: '.pochi/skills', universal: false },
  promptscript: { displayName: 'PromptScript', skillsDir: CANONICAL_SKILLS_DIR, universal: true },
  adal: { displayName: 'AdaL', skillsDir: '.adal/skills', universal: false },
};

/** Agent id type (one per TARGETS key). */
export type AgentTarget = keyof typeof TARGETS;

/**
 * Legacy short target names → canonical ids. These exist ONLY for backwards
 * compatibility with older scripts/docs that used the short names — prefer the
 * canonical id. Only mappings where the alias actually differs from the id are
 * listed: resolveTarget finds canonical ids directly, so an alias identical to
 * its id would be pointless.
 */
export const TARGET_ALIASES: Record<string, AgentTarget> = {
  claude: 'claude-code',
  kiro: 'kiro-cli',
  copilot: 'github-copilot',
};

/** Resolve a `--target` token (id or alias) to a canonical id, or null if unknown. */
export function resolveTarget(raw: string): AgentTarget | null {
  if (Object.prototype.hasOwnProperty.call(TARGETS, raw)) return raw as AgentTarget;
  return TARGET_ALIASES[raw] ?? null;
}

/** Every accepted `--target` token (ids + aliases), for help/error text. */
export function acceptedTargetTokens(): string[] {
  return [...Object.keys(TARGETS), ...Object.keys(TARGET_ALIASES)];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `.agents/skills/<skill>` — the real SKILL.md location every agent path resolves to. */
export function canonicalSkillDir(skill: string): string {
  return `${CANONICAL_SKILLS_DIR}/${skill}`;
}

/** `.agents/skills/<skill>/SKILL.md`. */
export function canonicalSkillFile(skill: string): string {
  return `${canonicalSkillDir(skill)}/SKILL.md`;
}

/** Directory the agent reads the skill from: canonical (universal) or a symlink to it. */
export function targetLandingDir(target: AgentTarget, skill: string): string {
  const spec = TARGETS[target]!;
  return spec.universal ? canonicalSkillDir(skill) : `${spec.skillsDir}/${skill}`;
}

/** SKILL.md path a given agent reads (canonical, or via the symlink for non-universal agents). */
export function pathFor(target: AgentTarget, skill: string): string {
  return `${targetLandingDir(target, skill)}/SKILL.md`;
}

// ---------------------------------------------------------------------------
// Install marker — lets `agent status` detect stale/edited installs.
// ---------------------------------------------------------------------------

const MARKER_HASH_HEX_LENGTH = 12;

const SKILL_MARKER_LINE_RE = new RegExp(
  `^<!-- testsprite-skill: (\\S+) v(\\S+) sha256:([0-9a-f]{${MARKER_HASH_HEX_LENGTH}}) -->$`,
);

/** First 12 hex chars of the SHA-256 of canonical SKILL.md content (the drift fingerprint). */
export function bodyHash12(canonicalContent: string): string {
  return createHash('sha256')
    .update(canonicalContent, 'utf8')
    .digest('hex')
    .slice(0, MARKER_HASH_HEX_LENGTH);
}

/** Build the provenance marker line embedded in each written SKILL.md. */
export function buildSkillMarker(skillName: string, canonicalContent: string): string {
  return `<!-- testsprite-skill: ${skillName} v${VERSION} sha256:${bodyHash12(canonicalContent)} -->`;
}

/** A marker line parsed back into its fields. */
export interface ParsedSkillMarker {
  skill: string;
  version: string;
  hash12: string;
  /** The exact marker line as found (trailing CR/whitespace stripped). */
  line: string;
}

/** Find and parse the first testsprite-skill marker line, or null if none. */
export function parseSkillMarker(content: string): ParsedSkillMarker | null {
  for (const rawLine of content.split('\n')) {
    const matched = SKILL_MARKER_LINE_RE.exec(rawLine.trimEnd());
    if (matched) {
      return {
        skill: matched[1]!,
        version: matched[2]!,
        hash12: matched[3]!,
        line: rawLine.trimEnd(),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Skill loading and rendering
// ---------------------------------------------------------------------------

type ReadFn = (url: URL) => string;

const defaultRead: ReadFn = (url: URL) => readFileSync(url, 'utf8');

/** Resolve a `skills/<file>` asset (ships verbatim via package.json `files`). */
function readSkillAsset(file: string, read: ReadFn): string {
  return read(new URL(`../../skills/${file}`, import.meta.url));
}

/** Parsed SKILL.md: frontmatter metadata plus the body that follows it. */
export interface ParsedSkill {
  name: string;
  description: string;
  /** Content after the closing `---` fence. */
  body: string;
  /** Entire file — the canonical SKILL.md bytes. */
  full: string;
}

/**
 * Parse a SKILL.md's frontmatter (name + description) and body, without a YAML
 * dependency. Our descriptions are single-line plain scalars, so a line-oriented
 * parse suffices.
 */
export function parseSkillFrontmatter(raw: string): {
  name: string;
  description: string;
  body: string;
} {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error('skill asset missing frontmatter (--- ... ---)');
  const fm = m[1]!;
  const name = fm.match(/^name:\s*(.*)$/m)?.[1]?.trim() ?? '';
  const description = fm.match(/^description:\s*(.*)$/m)?.[1]?.trim() ?? '';
  if (!name || !description) {
    throw new Error('skill frontmatter missing required name/description');
  }
  return { name, description, body: m[2] ?? '' };
}

/** Load and parse a skill. The registry id must match the frontmatter `name`. */
export function loadSkill(skill: string, read: ReadFn = defaultRead): ParsedSkill {
  const asset = SKILLS[skill];
  if (!asset) throw new Error(`unknown skill: ${skill}`);
  const full = readSkillAsset(asset.file, read);
  const { name, description, body } = parseSkillFrontmatter(full);
  if (name !== skill) {
    throw new Error(
      `skill id mismatch: registry "${skill}" vs frontmatter "${name}" in ${asset.file}`,
    );
  }
  return { name, description, body, full };
}

/** Canonical SKILL.md bytes (frontmatter + body), verbatim. */
export function loadSkillFull(skill: string, read: ReadFn = defaultRead): string {
  return loadSkill(skill, read).full;
}

/** Insert the marker line right after the closing `---` fence. */
function injectMarkerLine(skillMd: string, markerLine: string): string {
  const closingFence = '\n---\n';
  const at = skillMd.indexOf(closingFence) + closingFence.length;
  return `${skillMd.slice(0, at)}${markerLine}\n${skillMd.slice(at)}`;
}

/** Canonical SKILL.md bytes carrying a specific marker line (used by `agent status`). */
export function renderCanonicalWithMarker(
  skill: string,
  markerLine: string,
  read: ReadFn = defaultRead,
): string {
  if (!SKILLS[skill]) throw new Error(`unknown skill: ${skill}`);
  return injectMarkerLine(loadSkillFull(skill, read), markerLine);
}

/** Canonical SKILL.md bytes to write: the asset verbatim plus a provenance marker. */
export function renderCanonical(skill: string, read: ReadFn = defaultRead): string {
  return renderCanonicalWithMarker(
    skill,
    buildSkillMarker(skill, loadSkillFull(skill, read)),
    read,
  );
}
