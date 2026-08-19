import path from 'node:path';
import fs from 'node:fs/promises';
import { Command } from 'commander';
import type { CommonOptions as FactoryCommonOptions } from '../lib/client-factory.js';
import { CLIError, localValidationError } from '../lib/errors.js';
import type { OutputMode } from '../lib/output.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode } from '../lib/output.js';
import { promptText } from '../lib/prompt.js';
import {
  type AgentTarget,
  type LegacyOwnFileSpec,
  DEFAULT_SKILLS,
  LEGACY_OWN_FILE_TARGETS,
  SKILLS,
  TARGETS,
  acceptedTargetTokens,
  bodyHash12,
  buildSkillMarker,
  canonicalSkillDir,
  canonicalSkillFile,
  findManagedSectionBounds,
  legacyOwnFilePath,
  loadSkillFull,
  parseSkillMarker,
  pathFor,
  renderCanonicalWithMarker,
  resolveTarget,
  targetLandingDir,
} from '../lib/agent-targets.js';

// ---------------------------------------------------------------------------
// Filesystem port (injectable for tests)
// ---------------------------------------------------------------------------

/** lstat does not follow symlinks (null = ENOENT), so the safety walk can see them. */
export interface AgentFs {
  lstat(p: string): Promise<{ isFile: boolean; isSymbolicLink: boolean } | null>;
  readFile(p: string): Promise<string>;
  /** With `exclusive`, fail with EEXIST if the path exists (never clobbering or following a symlink). */
  writeFile(p: string, data: string, opts?: { exclusive?: boolean }): Promise<void>;
  mkdir(p: string): Promise<void>; // recursive
  /** Read a symlink's stored target (null when not a symlink / ENOENT). */
  readlink(p: string): Promise<string | null>;
  symlink(target: string, linkPath: string): Promise<void>;
  unlink(p: string): Promise<void>;
  /** Remove a file, symlink, or (recursively) a directory. */
  rm(p: string): Promise<void>;
  /** List the direct children of a directory (entry names only). Throws on ENOENT. */
  readdir(p: string): Promise<string[]>;
}

const defaultAgentFs: AgentFs = {
  async lstat(p) {
    try {
      const s = await fs.lstat(p);
      return { isFile: s.isFile(), isSymbolicLink: s.isSymbolicLink() };
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  async readFile(p) {
    return fs.readFile(p, 'utf8');
  },
  async writeFile(p, data, opts) {
    await fs.writeFile(p, data, { encoding: 'utf8', flag: opts?.exclusive ? 'wx' : 'w' });
  },
  async mkdir(p) {
    await fs.mkdir(p, { recursive: true });
  },
  async readlink(p) {
    try {
      return await fs.readlink(p);
    } catch (err: unknown) {
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      if (code === 'ENOENT' || code === 'EINVAL') return null; // missing, or not a symlink
      throw err;
    }
  },
  async symlink(target, linkPath) {
    // Windows directory symlinks need a junction to work without Developer Mode/Admin
    // rights; junctions require an absolute target. Everywhere else, store a portable
    // relative target.
    if (process.platform === 'win32') {
      // `target` is relative to the link's directory (see linkOrCopy), so resolve
      // it against that directory — path.resolve(target) alone would resolve
      // against process.cwd() and point the junction at the wrong place
      // whenever --dir is not the cwd.
      await fs.symlink(path.resolve(path.dirname(linkPath), target), linkPath, 'junction');
    } else {
      await fs.symlink(target, linkPath);
    }
  },
  async unlink(p) {
    await fs.unlink(p);
  },
  async rm(p) {
    await fs.rm(p, { recursive: true, force: true });
  },
  async readdir(p) {
    return fs.readdir(p);
  },
};

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Walk each component of `relPath` beneath `root`, rejecting any symlink so a
 * planted symlink can't redirect a write outside `--dir` (fs writes follow
 * symlinks). Returns `{ isFile }` of the final component, or null if it (or an
 * ancestor) doesn't exist yet.
 */
async function inspectTargetPath(
  agentFs: AgentFs,
  root: string,
  relPath: string,
): Promise<{ isFile: boolean } | null> {
  const segments = relPath.split(/[/\\]+/).filter(Boolean);
  let current = root;
  let finalIsFile = false;
  for (const [i, seg] of segments.entries()) {
    current = path.join(current, seg);
    const ls = await agentFs.lstat(current);
    if (ls === null) return null;
    if (ls.isSymbolicLink) {
      throw new CLIError(refusesSymlink(segments.slice(0, i + 1).join('/')), 5);
    }
    if (i < segments.length - 1 && ls.isFile) {
      throw new CLIError(
        `cannot create ${relPath}: "${segments.slice(0, i + 1).join('/')}" exists and is not a directory.`,
        5,
      );
    }
    finalIsFile = ls.isFile;
  }
  return { isFile: finalIsFile };
}

/**
 * Walk the ancestors of `relPath`, rejecting symlinks, and return the lstat of
 * the final component (or null if absent). The final component is allowed to be
 * a symlink — for symlink landings that's our own link.
 */
async function inspectAncestors(
  agentFs: AgentFs,
  root: string,
  relPath: string,
): Promise<{ isFile: boolean; isSymbolicLink: boolean } | null> {
  const segments = relPath.split(/[/\\]+/).filter(Boolean);
  const ancestors = segments.slice(0, -1);
  let current = root;
  for (const [i, seg] of ancestors.entries()) {
    current = path.join(current, seg);
    const ls = await agentFs.lstat(current);
    if (ls === null) break;
    if (ls.isSymbolicLink)
      throw new CLIError(refusesSymlink(ancestors.slice(0, i + 1).join('/')), 5);
    if (ls.isFile) {
      throw new CLIError(
        `cannot create ${relPath}: "${ancestors.slice(0, i + 1).join('/')}" exists and is not a directory.`,
        5,
      );
    }
  }
  return agentFs.lstat(path.resolve(root, ...segments));
}

function refusesSymlink(shown: string): string {
  return `refusing to write through a symlink: "${shown}" — installing here could place files outside --dir. Remove the symlink or choose a different --dir.`;
}

/** Back up `existing` next to `abs` without clobbering a prior backup; return the path used. */
async function writeBackup(agentFs: AgentFs, abs: string, existing: string): Promise<string> {
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? `${abs}.bak` : `${abs}.bak.${n}`;
    try {
      await agentFs.writeFile(candidate, existing, { exclusive: true });
      return candidate;
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new CLIError(
    `refusing to back up ${path.basename(abs)}: too many existing .bak files — clean them up and re-run.`,
    6,
  );
}

// ---------------------------------------------------------------------------
// Deps / result types / options
// ---------------------------------------------------------------------------

export interface AgentDeps {
  cwd?: string;
  fs?: AgentFs;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  isTTY?: boolean;
  prompt?: (question: string) => Promise<string>;
}

export type InstallAction =
  'written' | 'skipped' | 'blocked' | 'updated' | 'migrated' | 'dry-run' | 'copy-fallback';

export interface InstallResult {
  target: string;
  /** Repo-relative SKILL.md the agent reads. */
  path: string;
  action: InstallAction;
  skills: string[];
  /** 'canonical' = real file at .agents/skills; 'symlink' = linked/copied into the agent's own dir. */
  mode: 'canonical' | 'symlink';
}

type CommonOptions = FactoryCommonOptions;

interface InstallOptions extends CommonOptions {
  target: string[];
  skills?: string[];
  dir?: string;
  force: boolean;
}

/** Action ensureCanonical can return (canonical writes never copy-fallback). */
type CanonicalAction = Exclude<InstallAction, 'copy-fallback'>;

// ---------------------------------------------------------------------------
// Canonical write + per-agent link
// ---------------------------------------------------------------------------

/**
 * Write or refresh the canonical `.agents/skills/<skill>/SKILL.md` — the single
 * source of truth every agent reads. Path-safe, idempotent, and backs up before
 * a `--force` overwrite.
 */
async function ensureCanonical(
  agentFs: AgentFs,
  root: string,
  skill: string,
  content: string,
  force: boolean,
  dryRun: boolean,
  stderr: (line: string) => void,
): Promise<CanonicalAction> {
  const relPath = canonicalSkillFile(skill);
  const abs = path.resolve(root, relPath);

  const st = await inspectTargetPath(agentFs, root, relPath);
  if (st !== null && !st.isFile) {
    throw new CLIError(`${relPath} exists but is not a regular file — remove it and re-run.`, 5);
  }
  if (dryRun) return 'dry-run';

  if (st === null) {
    await agentFs.mkdir(path.dirname(abs));
    try {
      await agentFs.writeFile(abs, content, { exclusive: true });
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new CLIError(
          `${relPath} appeared after the path check — re-run, or pass --force to overwrite.`,
          6,
        );
      }
      throw err;
    }
    return 'written';
  }

  const existing = await agentFs.readFile(abs);
  if (existing === content) return 'skipped';
  if (!force) return 'blocked';

  const backupPath = await writeBackup(agentFs, abs, existing);
  await agentFs.writeFile(abs, content);
  stderr(`backed up ${relPath} to ${path.relative(root, backupPath)}`);
  return 'updated';
}

/** After removing a wrong link and recreating it, the action is 'updated', not 'written'. */
function upgraded(action: InstallAction): InstallAction {
  return action === 'written' ? 'updated' : action;
}

/** Create the symlink `linkAbs` → `canonicalAbs`, falling back to a copy if symlinks are unavailable. */
async function linkOrCopy(
  agentFs: AgentFs,
  linkAbs: string,
  canonicalAbs: string,
  landingRel: string,
  content: string,
  stderr: (line: string) => void,
): Promise<InstallAction> {
  const relativeTarget = path.relative(path.dirname(linkAbs), canonicalAbs);
  try {
    await agentFs.symlink(relativeTarget, linkAbs);
    return 'written';
  } catch {
    // Symlinks unavailable (e.g. Windows without Developer Mode): write a real
    // SKILL.md so the agent still discovers the skill.
    await agentFs.mkdir(linkAbs);
    await agentFs.writeFile(path.join(linkAbs, 'SKILL.md'), content);
    stderr(
      `[info] could not symlink ${landingRel} → .agents/skills (symlinks unavailable here) — copied instead.`,
    );
    return 'copy-fallback';
  }
}

/**
 * Create or refresh a non-universal agent's symlink `<skillsDir>/<skill>` →
 * canonical. Idempotent; `--force` replaces a link/file that points elsewhere.
 */
async function ensureAgentLink(
  agentFs: AgentFs,
  root: string,
  target: AgentTarget,
  skill: string,
  content: string,
  force: boolean,
  dryRun: boolean,
  stderr: (line: string) => void,
): Promise<InstallAction> {
  const landingRel = targetLandingDir(target, skill);
  const landingAbs = path.resolve(root, landingRel);
  const canonicalAbs = path.resolve(root, canonicalSkillDir(skill));

  const st = await inspectAncestors(agentFs, root, landingRel);
  if (dryRun) {
    if (st === null) return 'dry-run';
    if (st.isSymbolicLink) {
      const resolved = await resolveLink(agentFs, landingAbs);
      return resolved === canonicalAbs ? 'skipped' : 'dry-run';
    }
    return 'dry-run';
  }

  await agentFs.mkdir(path.dirname(landingAbs));

  if (st === null) {
    return linkOrCopy(agentFs, landingAbs, canonicalAbs, landingRel, content, stderr);
  }

  if (st.isSymbolicLink) {
    const resolved = await resolveLink(agentFs, landingAbs);
    if (resolved === canonicalAbs) return 'skipped';
    if (!force) return 'blocked';
    await agentFs.rm(landingAbs);
    return upgraded(
      await linkOrCopy(agentFs, landingAbs, canonicalAbs, landingRel, content, stderr),
    );
  }

  if (st.isFile) {
    if (!force) return 'blocked';
    const existing = await agentFs.readFile(landingAbs);
    const backupPath = await writeBackup(agentFs, landingAbs, existing);
    stderr(`backed up ${landingRel} to ${path.relative(root, backupPath)}`);
    await agentFs.unlink(landingAbs);
    return upgraded(
      await linkOrCopy(agentFs, landingAbs, canonicalAbs, landingRel, content, stderr),
    );
  }

  // Directory at the landing: a previous copy-fallback. Refresh the SKILL.md inside.
  const skillMdAbs = path.join(landingAbs, 'SKILL.md');
  const mdStat = await agentFs.lstat(skillMdAbs);
  if (mdStat === null) {
    await agentFs.writeFile(skillMdAbs, content);
    return 'written';
  }
  if (!mdStat.isFile) return 'blocked';
  const existing = await agentFs.readFile(skillMdAbs);
  if (existing === content) return 'skipped';
  // A real folder with a provenance marker is a legacy skill.
  // Under --force migration already handled it; refuse without --force.
  if (parseSkillMarker(existing) !== null && !force) {
    throw new CLIError(
      `${landingRel} is a legacy TestSprite skill folder that must be ` +
        `replaced by a symlink to ${canonicalSkillDir(skill)}. Re-run with --force to back it up ` +
        `to ${landingRel}.bak and link to the canonical skill.`,
      6,
    );
  }
  if (!force) return 'blocked';
  const backupPath = await writeBackup(agentFs, skillMdAbs, existing);
  stderr(`backed up ${path.relative(root, skillMdAbs)} to ${path.relative(root, backupPath)}`);
  await agentFs.writeFile(skillMdAbs, content);
  return 'updated';
}

/** Resolve a symlink to an absolute path (null if not a link / unreadable). */
async function resolveLink(agentFs: AgentFs, linkAbs: string): Promise<string | null> {
  const target = await agentFs.readlink(linkAbs);
  return target !== null ? path.resolve(path.dirname(linkAbs), target) : null;
}

// ---------------------------------------------------------------------------
// runInstall
// ---------------------------------------------------------------------------

export async function runInstall(opts: InstallOptions, deps: AgentDeps = {}): Promise<void> {
  const agentFs = deps.fs ?? defaultAgentFs;
  const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const out = makeOutput(opts.output, deps);

  // 1. Resolve targets (aliases → canonical ids).
  const rawTargets = opts.target
    .flatMap(s => s.split(','))
    .map(s => s.trim())
    .filter(Boolean);
  let resolvedTargetStrings: string[];
  if (rawTargets.length === 0) {
    if (deps.isTTY ?? Boolean(process.stdin.isTTY)) {
      const promptFn = deps.prompt ?? ((q: string) => promptText(q));
      const answer = (
        await promptFn('Targets to install (comma-separated) [claude-code]: ')
      ).trim();
      resolvedTargetStrings = (answer || 'claude-code')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    } else {
      stderrFn(
        '[info] --target not specified; defaulting to claude-code. Pass --target=<target> to select a different agent.',
      );
      resolvedTargetStrings = ['claude-code'];
    }
  } else {
    resolvedTargetStrings = rawTargets;
  }

  const targets: AgentTarget[] = [];
  for (const t of resolvedTargetStrings) {
    const r = resolveTarget(t);
    if (r === null) {
      throw localValidationError(
        'target',
        `unknown target "${t}"; supported: ${acceptedTargetTokens().join(', ')}`,
      );
    }
    targets.push(r);
  }
  const dedupedTargets = [...new Set(targets)];

  // 2. Resolve skills (default: DEFAULT_SKILLS).
  const rawSkills = (opts.skills ?? [])
    .flatMap(s => s.split(','))
    .map(s => s.trim())
    .filter(Boolean);
  const validSkills = Object.keys(SKILLS);
  for (const s of rawSkills) {
    if (!validSkills.includes(s)) {
      throw localValidationError(
        'skill',
        `unknown skill "${s}"; supported: ${validSkills.join(', ')}`,
      );
    }
  }
  const skills = rawSkills.length > 0 ? [...new Set(rawSkills)] : [...DEFAULT_SKILLS];

  const root = path.resolve(opts.dir ?? deps.cwd ?? process.cwd());

  // 3. Cached canonical content (raw asset, and rendered with the marker).
  const rawCache = new Map<string, string>();
  const rawContent = (skill: string): string => cached(rawCache, skill, () => loadSkillFull(skill));
  const renderCache = new Map<string, string>();
  const installContent = (skill: string): string =>
    cached(renderCache, skill, () =>
      renderCanonicalWithMarker(skill, buildSkillMarker(skill, rawContent(skill))),
    );

  // Under --force, retire legacy artifacts FIRST so the canonical/symlink
  // phases land on a clean tree.
  const migrated = new Set<string>();
  if (opts.force) {
    const migration = await migrateLegacyArtifacts(
      agentFs,
      root,
      dedupedTargets,
      skills,
      Boolean(opts.dryRun),
    );
    if (migration.length > 0) {
      printMigrationSummary(migration, stderrFn);
      // Report each migrated (target, skill) as 'migrated' rather than 'skipped'.
      for (const r of migration) {
        if (r.skill !== null) {
          migrated.add(`${r.targetId}\0${r.skill}`);
        } else {
          // codex managed section covers every skill.
          for (const s of skills) migrated.add(`${r.targetId}\0${s}`);
        }
      }
    }
  }

  const results: InstallResult[] = [];
  const dryRunLines: { rel: string; bytes: number; note: string }[] = [];

  // 4. Write the canonical file once per skill. A blocked canonical blocks every
  //    target for that skill (the source of truth couldn't be written).
  const canonicalAction = new Map<string, CanonicalAction>();
  for (const skill of skills) {
    const content = installContent(skill);
    const action = await ensureCanonical(
      agentFs,
      root,
      skill,
      content,
      opts.force,
      Boolean(opts.dryRun),
      stderrFn,
    );
    canonicalAction.set(skill, action);
    if (opts.dryRun) {
      dryRunLines.push({
        rel: canonicalSkillFile(skill),
        bytes: Buffer.byteLength(content, 'utf8'),
        note: 'canonical',
      });
    }
  }

  // 5. Per-target landing: universal targets read canonical; others get a symlink/copy.
  for (const t of dedupedTargets) {
    const spec = TARGETS[t]!;
    for (const skill of skills) {
      const cAction = canonicalAction.get(skill)!;
      const mode: 'canonical' | 'symlink' = spec.universal ? 'canonical' : 'symlink';

      if (cAction === 'blocked') {
        results.push({
          target: t,
          path: pathFor(t, skill),
          action: 'blocked',
          skills: [skill],
          mode,
        });
        continue;
      }

      if (opts.dryRun) {
        if (!spec.universal) {
          const action = await ensureAgentLink(
            agentFs,
            root,
            t,
            skill,
            installContent(skill),
            opts.force,
            true,
            stderrFn,
          );
          dryRunLines.push({
            rel: targetLandingDir(t, skill),
            bytes: 0,
            note: `symlink → ${canonicalSkillDir(skill)} (${action})`,
          });
        }
        results.push({
          target: t,
          path: pathFor(t, skill),
          action: 'dry-run',
          skills: [skill],
          mode,
        });
        continue;
      }

      if (spec.universal) {
        // canonical already correct → 'skipped'; migration upgrades it.
        let action: InstallAction = cAction;
        if (action === 'skipped' && migrated.has(`${t}\0${skill}`)) action = 'migrated';
        results.push({
          target: t,
          path: pathFor(t, skill),
          action,
          skills: [skill],
          mode,
        });
      } else {
        let action = await ensureAgentLink(
          agentFs,
          root,
          t,
          skill,
          installContent(skill),
          opts.force,
          false,
          stderrFn,
        );
        // The agent reads canonical THROUGH its link, so a canonical refresh this
        // run is a content change for this target even when the link was already correct.
        if (action === 'skipped' && (cAction === 'written' || cAction === 'updated'))
          action = 'updated';
        if (action === 'skipped' && migrated.has(`${t}\0${skill}`)) action = 'migrated';
        results.push({ target: t, path: pathFor(t, skill), action, skills: [skill], mode });
      }
    }
  }

  if (opts.dryRun) {
    stderrFn('[dry-run] no files written — preview only');
    for (const { rel, bytes, note } of dryRunLines) {
      stderrFn(`[dry-run] would write ${rel} (${note}${bytes > 0 ? `, ${bytes} bytes` : ''})`);
    }
  }

  for (const r of results) {
    if (r.action === 'blocked') {
      stderrFn(
        `${r.path} exists and differs from the canonical skill — re-run with --force to overwrite (a .bak is kept).`,
      );
    }
  }

  out.print(results, data => {
    const items = data as InstallResult[];
    return items
      .map(r => `${r.target.padEnd(16)} ${r.mode.padEnd(10)} ${r.action.padEnd(13)} ${r.path}`)
      .join('\n');
  });

  if (results.some(r => r.action === 'blocked')) {
    throw new CLIError(
      'one or more targets already exist and differ; re-run with --force to overwrite (a .bak is kept).',
      6,
    );
  }
}

/** Memoize a per-skill computation. */
function cached(cache: Map<string, string>, skill: string, compute: () => string): string {
  let value = cache.get(skill);
  if (value === undefined) {
    value = compute();
    cache.set(skill, value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// runList
// ---------------------------------------------------------------------------

export interface ListResult {
  target: string;
  displayName: string;
  mode: 'universal' | 'symlink';
  skillsDir: string;
  /** Example landing path for testsprite-verify. */
  path: string;
}

export async function runList(opts: CommonOptions, deps: AgentDeps = {}): Promise<void> {
  const out = makeOutput(opts.output, deps);
  const results: ListResult[] = (Object.keys(TARGETS) as AgentTarget[]).map(t => {
    const spec = TARGETS[t]!;
    return {
      target: t,
      displayName: spec.displayName,
      mode: spec.universal ? 'universal' : 'symlink',
      skillsDir: spec.skillsDir,
      path: pathFor(t, 'testsprite-verify'),
    };
  });

  out.print(results, data => {
    const items = data as ListResult[];
    const header = `${'TARGET'.padEnd(18)} ${'MODE'.padEnd(10)} ${'SKILLS_DIR'.padEnd(22)} PATH`;
    const rows = items.map(
      r => `${r.target.padEnd(18)} ${r.mode.padEnd(10)} ${r.skillsDir.padEnd(22)} ${r.path}`,
    );
    return [header, ...rows].join('\n');
  });
}

// ---------------------------------------------------------------------------
// runStatus
// ---------------------------------------------------------------------------

/**
 * Health of one installed skill, reported by `agent status`:
 * absent / unmarked (no marker) / stale (marker hash differs) / modified (bytes
 * differ from the canonical render) / ok. `agent status` emits only non-absent
 * rows and exits 1 when any row needs attention, so it can gate CI.
 */
export type SkillArtifactState = 'ok' | 'stale' | 'modified' | 'unmarked' | 'absent';

export interface StatusResult {
  target: string;
  skill: string;
  path: string;
  state: SkillArtifactState;
}

interface StatusOptions extends CommonOptions {
  dir?: string;
}

/** Classify a SKILL.md (canonical or copy-fallback) against the shipped content. */
async function classifySkillFile(
  agentFs: AgentFs,
  abs: string,
  skill: string,
  contentForSkill: (skill: string) => string,
): Promise<SkillArtifactState> {
  const stat = await agentFs.lstat(abs);
  if (stat === null) return 'absent';
  if (!stat.isFile) return 'unmarked';
  const existing = await agentFs.readFile(abs);
  const marker = parseSkillMarker(existing);
  if (marker === null) return 'unmarked';
  if (marker.hash12 !== bodyHash12(contentForSkill(skill))) return 'stale';
  return existing === renderCanonicalWithMarker(skill, marker.line) ? 'ok' : 'modified';
}

/** Classify a non-universal landing: a symlink to canonical, a copy-fallback dir, or absent. */
async function classifySymlinked(
  agentFs: AgentFs,
  root: string,
  target: AgentTarget,
  skill: string,
  contentForSkill: (skill: string) => string,
): Promise<SkillArtifactState> {
  const landingAbs = path.resolve(root, targetLandingDir(target, skill));
  const stat = await agentFs.lstat(landingAbs);
  if (stat === null) return 'absent';
  if (stat.isSymbolicLink) {
    const resolved = await resolveLink(agentFs, landingAbs);
    if (resolved !== path.resolve(root, canonicalSkillDir(skill))) return 'modified';
    return classifySkillFile(
      agentFs,
      path.resolve(root, canonicalSkillFile(skill)),
      skill,
      contentForSkill,
    );
  }
  if (stat.isFile) return 'unmarked';
  return classifySkillFile(agentFs, path.join(landingAbs, 'SKILL.md'), skill, contentForSkill);
}

export async function runStatus(opts: StatusOptions, deps: AgentDeps = {}): Promise<void> {
  const agentFs = deps.fs ?? defaultAgentFs;
  const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const out = makeOutput(opts.output, deps);

  if (opts.dir !== undefined && opts.dir.trim() === '') {
    throw localValidationError('dir', 'must not be empty');
  }
  const root = path.resolve(opts.dir !== undefined ? opts.dir.trim() : (deps.cwd ?? process.cwd()));

  const contentCache = new Map<string, string>();
  const contentForSkill = (skill: string): string =>
    cached(contentCache, skill, () => loadSkillFull(skill));

  const results: StatusResult[] = [];
  for (const target of Object.keys(TARGETS) as AgentTarget[]) {
    const spec = TARGETS[target]!;
    for (const skill of DEFAULT_SKILLS) {
      const state = spec.universal
        ? await classifySkillFile(
            agentFs,
            path.resolve(root, canonicalSkillFile(skill)),
            skill,
            contentForSkill,
          )
        : await classifySymlinked(agentFs, root, target, skill, contentForSkill);
      if (state === 'absent') continue;
      results.push({ target, skill, path: pathFor(target, skill), state });
    }
  }

  // Advisory: surface a scoped --force hint for any legacy artifacts (stderr
  // only, never changes exit code).
  const legacyTargets = await detectLegacyTargets(agentFs, root);
  if (legacyTargets.length > 0) {
    const list = legacyTargets.join(',');
    stderrFn(
      `[info] found legacy installs for: ${legacyTargets.join(', ')}. ` +
        `Run \`testsprite agent install --force --target ${list}\` to back them up and migrate them (*.bak kept).`,
    );
  }

  out.print(results, data => {
    const items = data as StatusResult[];
    if (items.length === 0) return 'No TestSprite skill artifacts installed in this project.';
    const header = `${'TARGET'.padEnd(18)} ${'SKILL'.padEnd(20)} ${'STATE'.padEnd(10)} PATH`;
    const rows = items.map(
      row => `${row.target.padEnd(18)} ${row.skill.padEnd(20)} ${row.state.padEnd(10)} ${row.path}`,
    );
    return [header, ...rows].join('\n');
  });

  const needingAttention = results.filter(r => r.state !== 'ok');
  if (needingAttention.length > 0) {
    throw new CLIError(
      `${needingAttention.length} skill artifact(s) need attention (stale/modified/unmarked); re-run \`testsprite agent install\` (add --force for symlink/copy targets) to refresh them.`,
      1,
    );
  }
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

/** One legacy artifact retired by `agent install --force` (stderr summary only). */
interface MigrationRow {
  /** 'own-file' = a legacy per-target skill file/folder; 'managed-section' = the codex AGENTS.md block. */
  kind: 'own-file' | 'managed-section';
  targetId: AgentTarget;
  /** Legacy target id (own-file) or 'codex' (managed-section) — messaging only. */
  legacyTarget: string;
  /** null for the codex managed section (it aggregated skills). */
  skill: string | null;
  from: string;
  backup: string;
  to: string;
}

/**
 * Read a legacy own-file artifact, or null when none is present. Requires a
 * file at the legacy path AND a provenance marker inside it (so user-authored
 * files are never touched). A 'dir'-kind symlink landing is the new format, not
 * a legacy artifact, and is skipped.
 */
async function readLegacyOwnFile(
  agentFs: AgentFs,
  root: string,
  spec: LegacyOwnFileSpec,
  skill: string,
): Promise<{ path: string; content: string } | null> {
  const rel = legacyOwnFilePath(spec, skill);
  if (spec.kind === 'dir') {
    const skillDirRel = rel.slice(0, rel.length - '/SKILL.md'.length);
    const skillDirStat = await agentFs.lstat(path.resolve(root, skillDirRel));
    if (skillDirStat === null) return null;
    if (skillDirStat.isSymbolicLink) return null;
    const fileStat = await agentFs.lstat(path.resolve(root, rel));
    if (fileStat === null || !fileStat.isFile) return null;
    const content = await agentFs.readFile(path.resolve(root, rel));
    return parseSkillMarker(content) === null ? null : { path: rel, content };
  }
  const abs = path.resolve(root, rel);
  const st = await agentFs.lstat(abs);
  if (st === null || !st.isFile) return null;
  const content = await agentFs.readFile(abs);
  return parseSkillMarker(content) === null ? null : { path: rel, content };
}

/** Targets that have a legacy artifact under `root` (for the status nudge). */
async function detectLegacyTargets(agentFs: AgentFs, root: string): Promise<AgentTarget[]> {
  const found = new Set<AgentTarget>();
  for (const spec of LEGACY_OWN_FILE_TARGETS) {
    for (const skill of Object.keys(SKILLS)) {
      if ((await readLegacyOwnFile(agentFs, root, spec, skill)) !== null) {
        found.add(spec.newTarget);
        break; // one artifact is enough to know this target has legacy
      }
    }
  }
  const agentsStat = await agentFs.lstat(path.resolve(root, 'AGENTS.md'));
  if (agentsStat !== null && agentsStat.isFile) {
    const existing = await agentFs.readFile(path.resolve(root, 'AGENTS.md'));
    if (findManagedSectionBounds(existing).state === 'present') found.add('codex');
  }
  return [...found];
}

/**
 * Retire legacy artifacts for the REQUESTED targets (scoped). Idempotent.
 *
 * 'file'-kind → backed up to `<path>.bak` and unlinked.
 * 'dir'-kind  → folder backed up to `<folder>.bak/` and removed (install phase
 *               plants the symlink in its place).
 * codex       → the AGENTS.md managed section is removed in place.
 *
 * Malformed sentinels or non-file entries in a 'dir'-kind folder throw (exit 5).
 */
async function migrateLegacyArtifacts(
  agentFs: AgentFs,
  root: string,
  targets: readonly AgentTarget[],
  skills: readonly string[],
  dryRun: boolean,
): Promise<MigrationRow[]> {
  const rows: MigrationRow[] = [];

  // codex: the AGENTS.md managed section (one section, aggregates skills) — retire once.
  if (targets.includes('codex')) {
    const agentsMdRel = 'AGENTS.md';
    const agentsMdAbs = path.resolve(root, agentsMdRel);
    const agentsStat = await agentFs.lstat(agentsMdAbs);
    if (agentsStat !== null && agentsStat.isFile) {
      const existing = await agentFs.readFile(agentsMdAbs);
      const bounds = findManagedSectionBounds(existing);
      if (bounds.state === 'corrupt') {
        throw new CLIError(
          `${agentsMdRel} contains a malformed TestSprite sentinel block (${bounds.reason}). ` +
            `Manually remove the partial sentinel lines and re-run.`,
          5,
        );
      }
      if (bounds.state === 'present') {
        let backupRel: string;
        if (dryRun) {
          backupRel = path.relative(root, `${agentsMdAbs}.bak`);
        } else {
          const backupAbs = await writeBackup(agentFs, agentsMdAbs, existing);
          backupRel = path.relative(root, backupAbs);
          const next = existing.slice(0, bounds.start) + existing.slice(bounds.end);
          await agentFs.writeFile(agentsMdAbs, next);
        }
        rows.push({
          kind: 'managed-section',
          targetId: 'codex',
          legacyTarget: 'codex',
          skill: null,
          from: agentsMdRel,
          backup: backupRel,
          to: canonicalSkillFile('testsprite-verify'),
        });
      }
    }
  }

  for (const target of targets) {
    const spec = LEGACY_OWN_FILE_TARGETS.find(s => s.newTarget === target);
    if (spec === undefined) continue; // target has no legacy format (e.g. amp, antigravity)
    for (const skill of skills) {
      const hit = await readLegacyOwnFile(agentFs, root, spec, skill);
      if (hit === null) continue;
      const legacyAbs = path.resolve(root, hit.path);
      let backupRel: string;
      if (spec.kind === 'dir') {
        const dirRel = hit.path.slice(0, -'/SKILL.md'.length);
        backupRel = await backupLegacyDir(agentFs, root, dirRel, dryRun);
        if (!dryRun) await agentFs.rm(path.resolve(root, dirRel));
      } else {
        if (dryRun) {
          backupRel = path.relative(root, `${legacyAbs}.bak`);
        } else {
          const backupAbs = await writeBackup(agentFs, legacyAbs, hit.content);
          backupRel = path.relative(root, backupAbs);
          await agentFs.unlink(legacyAbs);
        }
      }
      rows.push({
        kind: 'own-file',
        targetId: spec.newTarget,
        legacyTarget: spec.legacyTarget,
        skill,
        from: hit.path,
        backup: backupRel,
        to: pathFor(spec.newTarget, skill),
      });
    }
  }

  return rows;
}

/**
 * Back up a legacy 'dir'-kind folder to a non-clobbering sibling `<folder>.bak[.N]/`.
 * Refuses (exit 5) on nested dirs/symlinks — only `SKILL.md` is expected.
 */
async function backupLegacyDir(
  agentFs: AgentFs,
  root: string,
  dirRel: string,
  dryRun: boolean,
): Promise<string> {
  if (dryRun) return `${dirRel}.bak`;
  const dirAbs = path.resolve(root, dirRel);
  const baseRel = `${dirRel}.bak`;
  const baseAbs = path.resolve(root, baseRel);
  let backupAbs = baseAbs;
  let n = 0;
  while ((await agentFs.lstat(backupAbs)) !== null) {
    n += 1;
    backupAbs = `${baseAbs}.${n}`;
  }
  const entries = await agentFs.readdir(dirAbs);
  await agentFs.mkdir(backupAbs);
  for (const name of entries) {
    const childAbs = path.join(dirAbs, name);
    const cst = await agentFs.lstat(childAbs);
    if (cst === null) continue;
    if (!cst.isFile) {
      throw new CLIError(
        `${dirRel} contains a non-file entry "${name}" (old installs only wrote SKILL.md). ` +
          `Remove it manually and re-run.`,
        5,
      );
    }
    await agentFs.writeFile(path.join(backupAbs, name), await agentFs.readFile(childAbs), {
      exclusive: true,
    });
  }
  return n === 0 ? baseRel : `${baseRel}.${n}`;
}

/**
 * Emit the per-row summary and the *.bak cleanup tip (stderr only).
 * 'dir'-kind (claude/kiro): "converted" (folder → symlink, from === to).
 * 'file'-kind: "migrated" (obsolete file → canonical/symlink path).
 * codex managed section: "migrated" (removed from AGENTS.md).
 */
function printMigrationSummary(rows: MigrationRow[], stderr: (line: string) => void): void {
  for (const r of rows) {
    if (r.kind === 'managed-section') {
      stderr(`migrated codex managed section in ${r.from} → ${r.to} (backup: ${r.backup})`);
    } else if (r.from === r.to) {
      // In-place: the folder at the agent's own skills path became a symlink.
      stderr(
        `converted ${r.legacyTarget} skill at ${r.from} (folder → symlink; backup: ${r.backup})`,
      );
    } else {
      stderr(`migrated ${r.legacyTarget} skill at ${r.from} → ${r.to} (backup: ${r.backup})`);
    }
  }
  stderr(
    'tip: a backup of each converted legacy artifact was kept as *.bak. Once you have confirmed ' +
      'everything looks correct, you can delete them — for example: ' +
      'find . -name "*.bak" -prune -exec rm -rf {} +.',
  );
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

function collect(v: string, prev: string[]): string[] {
  return prev.concat(v);
}

export function createAgentCommand(deps: AgentDeps = {}): Command {
  const agent = new Command('agent').description(
    'Install TestSprite skills into each coding agent (Claude Code, Codex, Cursor, Cline, Gemini CLI, Copilot, and 60+ more)',
  );

  agent
    .command('install [targets...]')
    .description(
      'Write the TestSprite agent skills (verification loop + first-run onboarding) into a project for a coding agent. ' +
        'Target(s) may be given positionally (e.g. `agent install cursor codex`) and/or via --target; the two are merged.',
    )
    .option(
      '--target <t>',
      'Agent target(s): claude-code, codex, cursor, gemini-cli, github-copilot, kiro-cli, windsurf, cline, antigravity (comma-separated or repeated). Merged with any positional target(s).',
      collect,
      [],
    )
    .option(
      '--skill <name>',
      `Skill(s) to install: ${Object.keys(SKILLS).join(', ')} (comma-separated or repeated; default: all)`,
      collect,
      [],
    )
    .option('--dir <path>', 'Project root to write into (default: cwd)')
    .option(
      '--force',
      'Overwrite an existing canonical file or landing, and migrate any legacy ' +
        'artifacts found in the repo (originals kept as *.bak).',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (
        // Positional targets: `agent install cursor` previously parsed
        // as zero targets (Commander silently drops undeclared positionals),
        // silently falling through to the non-TTY default-to-claude path — so
        // 7 of the 8 documented one-liners installed the WRONG agent's skill
        // with zero signal. Declaring `[targets...]` captures them; they are
        // merged with `--target` (order: positional first, then flag values)
        // and flow through runInstall's existing parse/validate/dedupe pipeline
        // unchanged, so an unknown name (positional or flag) still rejects with
        // exit 5 instead of silently defaulting.
        positionalTargets: string[],
        cmdOpts: { target: string[]; skill: string[]; dir?: string; force?: boolean },
        command: Command,
      ) => {
        await runInstall(
          {
            ...resolveCommonOptions(command),
            target: [...positionalTargets, ...cmdOpts.target],
            skills: cmdOpts.skill,
            dir: cmdOpts.dir,
            force: Boolean(cmdOpts.force),
          },
          deps,
        );
      },
    );

  agent
    .command('list')
    .description(
      'List supported agent targets, their skill folder, and whether they read .agents/skills directly (universal) or via symlink',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (_o, command: Command) => {
      await runList(resolveCommonOptions(command), deps);
    });

  agent
    .command('status')
    .description(
      'Check installed TestSprite skills against this CLI version (ok/stale/modified/unmarked). Universal agents share one canonical skill file (installing for any one serves all); symlinked agents appear only when their own landing exists. Exits 1 when any need attention, so it can gate CI',
    )
    .option('--dir <path>', 'Project root to inspect (default: cwd)')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts: { dir?: string }, command: Command) => {
      await runStatus({ ...resolveCommonOptions(command), dir: cmdOpts.dir }, deps);
    });

  return agent;
}

function resolveCommonOptions(command: Command): CommonOptions {
  const globals = command.optsWithGlobals() as Partial<CommonOptions>;
  return {
    profile: globals.profile ?? 'default',
    output: resolveOutputMode(globals.output),
    endpointUrl: globals.endpointUrl,
    debug: globals.debug ?? false,
    verbose: globals.verbose ?? false,
    dryRun: globals.dryRun ?? false,
  };
}

function makeOutput(mode: OutputMode, deps: AgentDeps): Output {
  return new Output(mode, { stdout: deps.stdout, stderr: deps.stderr });
}
