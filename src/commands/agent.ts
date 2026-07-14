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
  TARGETS,
  SKILLS,
  DEFAULT_SKILLS,
  MARKER_SKILL_SEPARATOR,
  pathFor,
  loadSkillBodyFor,
  bodyHash12,
  compactBodyFor,
  buildCodexAggregate,
  buildSkillMarker,
  parseSkillMarker,
  renderForTarget,
  renderOwnFileWithMarker,
  MANAGED_SECTION_BEGIN,
  MANAGED_SECTION_END,
} from '../lib/agent-targets.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Codex loads AGENTS.md files lazily and has a documented 32 KiB load budget
 * per file. Content beyond that offset is silently truncated. We warn (but do
 * not refuse to write) when a managed-section write would produce a file larger
 * than this threshold so operators have early visibility.
 */
export const AGENTS_MD_CODEX_BUDGET_BYTES = 32768; // 32 KiB

// ---------------------------------------------------------------------------
// Filesystem port (injectable for tests)
// ---------------------------------------------------------------------------

export interface AgentFs {
  // lstat semantics: does NOT follow symlinks (null = ENOENT). Critical for the
  // path-safety walk — fs writes follow symlinks, so we must be able to see them.
  lstat(p: string): Promise<{ isFile: boolean; isSymbolicLink: boolean } | null>;
  readFile(p: string): Promise<string>;
  // exclusive: fail with EEXIST if the path already exists. O_EXCL|O_CREAT does
  // not follow a final symlink, so exclusive writes never clobber or traverse a
  // planted symlink — used for backups and fresh installs.
  writeFile(p: string, data: string, opts?: { exclusive?: boolean }): Promise<void>;
  mkdir(p: string): Promise<void>; // recursive
}

const defaultAgentFs: AgentFs = {
  async lstat(p: string): Promise<{ isFile: boolean; isSymbolicLink: boolean } | null> {
    try {
      const s = await fs.lstat(p);
      return { isFile: s.isFile(), isSymbolicLink: s.isSymbolicLink() };
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  },
  async readFile(p: string): Promise<string> {
    return fs.readFile(p, 'utf8');
  },
  async writeFile(p: string, data: string, opts?: { exclusive?: boolean }): Promise<void> {
    await fs.writeFile(p, data, { encoding: 'utf8', flag: opts?.exclusive ? 'wx' : 'w' });
  },
  async mkdir(p: string): Promise<void> {
    await fs.mkdir(p, { recursive: true });
  },
};

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Walk each component of `relPath` beneath `root`, refusing to traverse or
 * write through a symlink. `fs.mkdir`/`writeFile` follow symlinks, so a planted
 * symlink at any existing path component (e.g. `.claude` -> /etc, or the final
 * `SKILL.md` -> ~/.bashrc) could place or clobber files outside `--dir`. The
 * lexical containment guard in `runInstall` is a string compare and cannot see
 * this; only an `lstat`-per-component walk can. Fail-closed: any symlink is
 * rejected (exit 5).
 *
 * Returns the target's `{ isFile }` when it already exists, or `null` when it
 * (or any ancestor) does not yet exist — in which case the missing tail is
 * created fresh and cannot be a pre-planted symlink. A small TOCTOU window
 * remains between this check and the write; that is acceptable for a local,
 * single-user CLI and avoids non-portable O_NOFOLLOW / rename gymnastics.
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
    if (ls === null) {
      // This component and everything below it does not exist yet.
      return null;
    }
    if (ls.isSymbolicLink) {
      const shown = segments.slice(0, i + 1).join('/');
      throw new CLIError(
        `refusing to write through a symlink: "${shown}" — installing here could place files outside --dir. Remove the symlink or choose a different --dir.`,
        5,
      );
    }
    if (i < segments.length - 1 && ls.isFile) {
      const shown = segments.slice(0, i + 1).join('/');
      throw new CLIError(`cannot create ${relPath}: "${shown}" exists and is not a directory.`, 5);
    }
    finalIsFile = ls.isFile;
  }
  return { isFile: finalIsFile };
}

/**
 * Back up the current bytes at `abs` next to it without clobbering any existing
 * backup or writing through a symlink. Exclusive create (`wx`) fails with
 * EEXIST on an existing regular file OR symlink, so we walk `.bak`, `.bak.1`,
 * `.bak.2`, … until a free slot is found. Returns the absolute path used.
 */
async function writeBackup(agentFs: AgentFs, abs: string, existing: string): Promise<string> {
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? `${abs}.bak` : `${abs}.bak.${n}`;
    try {
      await agentFs.writeFile(candidate, existing, { exclusive: true });
      return candidate;
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      throw err;
    }
  }
  throw new CLIError(
    `refusing to back up ${path.basename(abs)}: too many existing .bak files — clean them up and re-run.`,
    6,
  );
}

// ---------------------------------------------------------------------------
// Managed-section helpers (codex target)
// ---------------------------------------------------------------------------

/**
 * Build the section block to inject (sentinels + marker + body + trailing
 * newline). The provenance marker line sits just inside the BEGIN sentinel so
 * `agent status` can fingerprint the section. The same skill set + CLI version
 * + body always produce byte-identical output, so the classifySection
 * 'unchanged' fast-path keeps working across re-installs.
 * Uses \n throughout; the caller handles CRLF normalisation.
 */
function buildSection(body: string, markerLine: string): string {
  return `${MANAGED_SECTION_BEGIN}\n${markerLine}\n${body.trimEnd()}\n${MANAGED_SECTION_END}\n`;
}

/**
 * Managed-section install result — what happened to AGENTS.md.
 *
 * 'create'  — file did not exist; write the section as a new file.
 * 'append'  — file exists, no sentinels; append section at end.
 * 'replace' — file exists with sentinels; replace section content in-place.
 * 'unchanged' — file exists with sentinels and content is byte-identical.
 * 'corrupt' — BEGIN sentinel without matching END; refuse to touch the file.
 */
type SectionState =
  | { kind: 'create' }
  | { kind: 'append'; existing: string }
  | { kind: 'replace'; existing: string; before: string; after: string }
  | { kind: 'unchanged' }
  | { kind: 'corrupt' };

/**
 * Inspect an existing AGENTS.md and classify the managed-section state.
 *
 * Sentinel-matching rules (P2 hardening):
 *  - Only STANDALONE sentinel lines count (a line that consists solely of the
 *    marker, optionally followed by whitespace/CR before the LF). This prevents
 *    inline mentions in prose (e.g. documentation quoting the markers) from
 *    being mis-classified as a managed block.
 *  - Multiple standalone BEGIN or END lines → ambiguous → corrupt (exit 5).
 *  - CRLF files are handled by stripping trailing \r from each line before
 *    comparison.
 */
function classifySection(existing: string, section: string): SectionState {
  // Split on LF; strip trailing CR so CRLF files normalise correctly.
  const lines = existing.split('\n');

  // Collect line INDICES (0-based) where the sentinel appears as the whole line
  // (trimEnd removes trailing CR and spaces).
  const beginLines: number[] = [];
  const endLines: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const stripped = (lines[i] ?? '').trimEnd();
    if (stripped === MANAGED_SECTION_BEGIN) beginLines.push(i);
    else if (stripped === MANAGED_SECTION_END) endLines.push(i);
  }

  const hasBegin = beginLines.length > 0;
  const hasEnd = endLines.length > 0;

  if (!hasBegin && !hasEnd) {
    // No standalone sentinels — append path.
    return { kind: 'append', existing };
  }

  // Duplicate standalone sentinels are ambiguous — treat as corrupt.
  if (beginLines.length > 1) {
    return { kind: 'corrupt' };
  }
  if (endLines.length > 1) {
    return { kind: 'corrupt' };
  }

  if (hasBegin && !hasEnd) {
    // BEGIN present but no standalone END — corrupt.
    return { kind: 'corrupt' };
  }

  if (!hasBegin && hasEnd) {
    // END present but no standalone BEGIN — corrupt.
    return { kind: 'corrupt' };
  }

  const beginLineIdx = beginLines[0]!;
  const endLineIdx = endLines[0]!;

  if (endLineIdx < beginLineIdx) {
    // END appears before BEGIN — corrupt.
    return { kind: 'corrupt' };
  }

  // Both sentinels present, in the right order, with no duplicates.
  // Reconstruct byte offsets from line positions so we can slice the original
  // string (preserving its exact byte content for the before/after split).
  //
  // lineStart[i] = byte offset of the first character of line i.
  let byteOffset = 0;
  const lineStart: number[] = [];
  for (const line of lines) {
    lineStart.push(byteOffset);
    byteOffset += line.length + 1; // +1 for the '\n' that split() removed
  }

  const beginByteIdx = lineStart[beginLineIdx]!;

  // The END sentinel line ends at: lineStart[endLineIdx] + raw line length.
  // We want to include the trailing '\n' after END when present.
  const endLineRawLength = (lines[endLineIdx] ?? '').length;
  const endOfEndByte = lineStart[endLineIdx]! + endLineRawLength;
  // Include one trailing newline after END if present.
  const charAfterEnd = existing[endOfEndByte];
  const trailingNewline = charAfterEnd === '\n' ? 1 : charAfterEnd === '\r' ? 2 : 0;

  const before = existing.slice(0, beginByteIdx);
  const after = existing.slice(endOfEndByte + trailingNewline);
  const currentSection = existing.slice(beginByteIdx, endOfEndByte + trailingNewline);

  if (currentSection === section) {
    return { kind: 'unchanged' };
  }

  return { kind: 'replace', existing, before, after };
}

/**
 * Compose the new AGENTS.md content for the 'append' and 'replace' paths.
 *
 * 'append': ensure a single blank line separator between existing content
 *   and the section (but don't add two blank lines if the file already ends
 *   with one).
 * 'replace': splice the new section between `before` and `after`.
 */
function composeManagedFile(
  state: SectionState & { kind: 'append' | 'replace' },
  section: string,
): string {
  if (state.kind === 'append') {
    const existing = state.existing;
    const sep = existing.length === 0 || existing.endsWith('\n\n') ? '' : '\n';
    return `${existing}${sep}${section}`;
  }
  // replace
  return `${state.before}${section}${state.after}`;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface AgentDeps {
  cwd?: string;
  fs?: AgentFs;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  isTTY?: boolean;
  prompt?: (question: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type InstallAction =
  | 'written'
  | 'skipped'
  | 'blocked'
  | 'updated'
  | 'dry-run'
  | 'section-installed'
  | 'section-updated'
  | 'section-unchanged';

export interface InstallResult {
  target: AgentTarget;
  path: string; // repo-relative matrix path
  action: InstallAction;
  /**
   * Skill(s) this result covers. Own-file targets produce one result per skill
   * (`[skill]`); the codex managed-section target produces ONE result whose
   * section aggregates every installed skill (`[...skills]`).
   */
  skills: string[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

type CommonOptions = FactoryCommonOptions;

interface InstallOptions extends CommonOptions {
  target: string[];
  /** Skill subset to install; empty/absent → {@link DEFAULT_SKILLS}. */
  skills?: string[];
  dir?: string;
  force: boolean;
}

// ---------------------------------------------------------------------------
// runInstall
// ---------------------------------------------------------------------------

export async function runInstall(opts: InstallOptions, deps: AgentDeps = {}): Promise<void> {
  const agentFs = deps.fs ?? defaultAgentFs;
  const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const out = makeOutput(opts.output, deps);

  // 1. Parse targets
  const rawTargets = opts.target
    .flatMap(s => s.split(','))
    .map(s => s.trim())
    .filter(Boolean);

  let resolvedTargetStrings: string[];

  if (rawTargets.length === 0) {
    const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
    if (!isTTY) {
      stderrFn(
        '[info] --target not specified; defaulting to claude. Pass --target=<target> to select a different agent.',
      );
      resolvedTargetStrings = ['claude'];
    } else {
      const promptFn = deps.prompt ?? ((q: string) => promptText(q));
      const answer = (await promptFn('Targets to install (comma-separated) [claude]: ')).trim();
      const defaulted = answer || 'claude';
      resolvedTargetStrings = defaulted
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    }
  } else {
    resolvedTargetStrings = rawTargets;
  }

  // 2. Validate targets
  const validTargets = Object.keys(TARGETS) as AgentTarget[];
  for (const t of resolvedTargetStrings) {
    if (!validTargets.includes(t as AgentTarget)) {
      throw localValidationError(
        'target',
        `unknown target "${t}"; supported: ${validTargets.join(', ')}`,
      );
    }
  }

  // De-duplicate while preserving first-seen order
  const seen = new Set<string>();
  const targets = resolvedTargetStrings.filter(t => {
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  }) as AgentTarget[];

  // 2b. Resolve + validate the skill set (empty/absent → DEFAULT_SKILLS).
  // Accepts comma-separated or repeated --skill values, same shape as --target.
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
  const seenSkill = new Set<string>();
  const skills = (rawSkills.length > 0 ? rawSkills : [...DEFAULT_SKILLS]).filter(s => {
    if (seenSkill.has(s)) return false;
    seenSkill.add(s);
    return true;
  });

  // 3. Resolve dir
  const dir = opts.dir ?? deps.cwd ?? process.cwd();
  const root = path.resolve(dir);

  // 4. Lazy asset loaders — only touch disk if a target actually needs it.
  // own-file bodies are per-skill (cached); the codex section aggregates EVERY
  // installed skill's contribution into ONE managed section.
  const skillBodyCache = new Map<string, string>();
  const bodyForSkill = (skill: string): string => {
    let b = skillBodyCache.get(skill);
    if (b === undefined) {
      b = loadSkillBodyFor(skill);
      skillBodyCache.set(skill, b);
    }
    return b;
  };
  // Budget-capped own-file targets (e.g. windsurf) render the compact per-skill
  // body so the rule file isn't truncated by the agent. Cached separately; must
  // match renderForTarget's default selection so written bytes equal the asserted
  // render.
  const compactBodyCache = new Map<string, string>();
  const compactBodyForSkill = (skill: string): string => {
    let b = compactBodyCache.get(skill);
    if (b === undefined) {
      b = compactBodyFor(skill);
      compactBodyCache.set(skill, b);
    }
    return b;
  };
  const ownFileBodyFor = (t: AgentTarget, skill: string): string =>
    TARGETS[t].compactBody ? compactBodyForSkill(skill) : bodyForSkill(skill);
  let codexSectionCache: string | undefined;
  const getCodexSection = (): string => {
    if (codexSectionCache === undefined) {
      const aggregate = buildCodexAggregate(skills);
      // ONE marker for the whole managed section: it names every aggregated
      // skill ('+'-joined) and hashes the canonical aggregate body, so
      // `agent status` can attribute and fingerprint the section per skill.
      codexSectionCache = buildSection(
        aggregate,
        buildSkillMarker(skills.join(MARKER_SKILL_SEPARATOR), aggregate),
      );
    }
    return codexSectionCache;
  };

  const results: InstallResult[] = [];

  // Track bytes for dry-run output
  const dryRunLines: { abs: string; bytes: number; note: string }[] = [];

  // 5. Process each target
  for (const t of targets) {
    const spec = TARGETS[t];

    // -----------------------------------------------------------------------
    // managed-section mode (codex target) — ONE section aggregating all skills
    // -----------------------------------------------------------------------
    if (spec.mode === 'managed-section') {
      const relPath = spec.path; // 'AGENTS.md' — skill-independent (all skills merge here)
      const abs = path.resolve(root, relPath);
      // Path safety: ensure abs is inside root (defense against .. in relPath or dir)
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        throw new CLIError(`refusing to write outside --dir: ${relPath}`, 5);
      }
      const section = getCodexSection();

      if (opts.dryRun) {
        // Dry-run: report what would happen without writing disk.
        //
        // [P2] Apply the SAME symlink fail-close guard as the real install path.
        // Without this, a symlinked AGENTS.md gets followed in dry-run even
        // though the real install would refuse (exit 5). Run inspectTargetPath
        // first; only lstat-check the final file (not write) after that.
        const dryRunSt = await inspectTargetPath(agentFs, root, relPath);
        if (dryRunSt !== null && !dryRunSt.isFile) {
          throw new CLIError(
            `${relPath} exists but is not a regular file — remove it and re-run.`,
            5,
          );
        }

        // We DO read the existing file (if present) to compute the
        // would-be byte count and emit the 32 KiB budget warning — without
        // this the warning was silently absent on --dry-run runs (Fix 4).
        //
        // [P3 round-2] Measure the ACTUAL composed result via the same
        // classifySection + composeManagedFile pipeline the real install
        // uses — `existing + section` double-counts the old block on the
        // replace path and misses the append separator. Read failures other
        // than ENOENT are surfaced (EACCES/EIO must not read as "absent" —
        // absence is already represented by dryRunSt === null).
        const bytes = Buffer.byteLength(section, 'utf8');
        let wouldBeContent = section;
        if (dryRunSt !== null) {
          let existing: string | null = null;
          try {
            existing = await agentFs.readFile(abs);
          } catch (err) {
            if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
              existing = null; // raced away between lstat and read → would-be = create
            } else {
              throw new CLIError(
                `cannot read ${relPath} for dry-run: ${err instanceof Error ? err.message : String(err)}`,
                5,
              );
            }
          }
          if (existing !== null) {
            const state = classifySection(existing, section);
            if (state.kind === 'corrupt') {
              // The real install would refuse with exit 5 — dry-run reports
              // the same outcome rather than a misleading success.
              throw new CLIError(
                `${relPath} contains a malformed TestSprite sentinel (BEGIN without END or vice-versa). ` +
                  `Manually remove the partial sentinel block and re-run.`,
                5,
              );
            }
            wouldBeContent =
              state.kind === 'unchanged'
                ? existing
                : state.kind === 'create'
                  ? section
                  : composeManagedFile(state, section);
          }
        }
        const wouldBeBytes = Buffer.byteLength(wouldBeContent, 'utf8');
        if (wouldBeBytes > AGENTS_MD_CODEX_BUDGET_BYTES) {
          stderrFn(
            `[warn] ${relPath} will be ${wouldBeBytes} bytes after this write — Codex may not load content beyond its 32 KiB (${AGENTS_MD_CODEX_BUDGET_BYTES} byte) budget. Trim AGENTS.md to stay within the limit.`,
          );
        }
        dryRunLines.push({ abs, bytes, note: 'managed section' });
        results.push({ target: t, path: relPath, action: 'dry-run', skills: [...skills] });
        continue;
      }

      // Inspect the target path via lstat walk (symlink-safe, same as own-file).
      const st = await inspectTargetPath(agentFs, root, relPath);

      if (st !== null && !st.isFile) {
        throw new CLIError(
          `${relPath} exists but is not a regular file — remove it and re-run.`,
          5,
        );
      }

      /**
       * [P2] Emit a stderr warn when the would-be file content exceeds Codex's
       * 32 KiB load budget. We still write — this is a warn, not a refusal —
       * but the operator needs early visibility so they can trim AGENTS.md.
       */
      function warnIfOverBudget(wouldBeContent: string): void {
        const byteLen = Buffer.byteLength(wouldBeContent, 'utf8');
        if (byteLen > AGENTS_MD_CODEX_BUDGET_BYTES) {
          stderrFn(
            `[warn] ${relPath} will be ${byteLen} bytes after this write — Codex may not load content beyond its 32 KiB (${AGENTS_MD_CODEX_BUDGET_BYTES} byte) budget. Trim AGENTS.md to stay within the limit.`,
          );
        }
      }

      if (st === null) {
        // File absent → create AGENTS.md containing just the section.
        warnIfOverBudget(section);
        await agentFs.mkdir(path.dirname(abs));
        try {
          await agentFs.writeFile(abs, section, { exclusive: true });
        } catch (err) {
          if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new CLIError(
              `${relPath} appeared after the path check — re-run, or pass --force to overwrite.`,
              6,
            );
          }
          throw err;
        }
        results.push({
          target: t,
          path: relPath,
          action: 'section-installed',
          skills: [...skills],
        });
      } else {
        const existing = await agentFs.readFile(abs);
        const state = classifySection(existing, section);

        if (state.kind === 'corrupt') {
          // BEGIN without matching END (or vice-versa) — never destroy user content.
          throw new CLIError(
            `${relPath} contains a malformed TestSprite sentinel (BEGIN without END or vice-versa). ` +
              `Manually remove the partial sentinel block and re-run.`,
            5,
          );
        }

        if (state.kind === 'unchanged') {
          results.push({
            target: t,
            path: relPath,
            action: 'section-unchanged',
            skills: [...skills],
          });
        } else if (state.kind === 'create') {
          // Shouldn't happen (st !== null means file exists), but guard anyway.
          warnIfOverBudget(section);
          await agentFs.writeFile(abs, section);
          results.push({
            target: t,
            path: relPath,
            action: 'section-installed',
            skills: [...skills],
          });
        } else {
          // 'append' or 'replace' — write the new content.
          // --force has no special meaning for managed-section: we always merge
          // rather than replacing the whole file, so force is effectively always
          // on for the section (user content is never at risk).
          const newContent = composeManagedFile(state, section);
          warnIfOverBudget(newContent);
          await agentFs.writeFile(abs, newContent);
          const action: InstallAction =
            state.kind === 'append' ? 'section-installed' : 'section-updated';
          results.push({ target: t, path: relPath, action, skills: [...skills] });
        }
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // own-file mode (all other targets) — one file per skill
    // -----------------------------------------------------------------------
    for (const skill of skills) {
      const relPath = pathFor(t, skill);
      const abs = path.resolve(root, relPath);
      // Path safety: ensure abs is inside root (defense against .. in relPath or dir)
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        throw new CLIError(`refusing to write outside --dir: ${relPath}`, 5);
      }
      const content = renderForTarget(t, skill, ownFileBodyFor(t, skill)).content;

      if (opts.dryRun) {
        // Apply the SAME symlink fail-close guard as the real install path
        // below (the codex managed-section branch already does this). Without
        // it, dry-run reports success for a planted symlink that the real
        // install would refuse with exit 5.
        const dryRunSt = await inspectTargetPath(agentFs, root, relPath);
        if (dryRunSt !== null && !dryRunSt.isFile) {
          throw new CLIError(
            `${relPath} exists but is not a regular file — remove it and re-run.`,
            5,
          );
        }
        const bytes = Buffer.byteLength(content, 'utf8');
        dryRunLines.push({ abs, bytes, note: '' });
        results.push({ target: t, path: relPath, action: 'dry-run', skills: [skill] });
        continue;
      }

      // Inspect the target path: refuse to traverse or write through a symlink
      // (fs writes follow symlinks, which would let a planted symlink escape
      // --dir), and reject a non-regular-file landing path. The lexical guard
      // above is necessary but not sufficient — it cannot see symlinks.
      const st = await inspectTargetPath(agentFs, root, relPath);

      if (st !== null && !st.isFile) {
        throw new CLIError(
          `${relPath} exists but is not a regular file — remove it and re-run.`,
          5,
        );
      }

      if (st === null) {
        // Path does not exist — create it. inspectTargetPath verified every
        // existing ancestor is a real directory; exclusive create (wx) then
        // ensures a file or symlink that races in after the check is not followed
        // or silently overwritten.
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
        results.push({ target: t, path: relPath, action: 'written', skills: [skill] });
      } else {
        const existing = await agentFs.readFile(abs);
        if (existing === content) {
          // Byte-identical — skip
          results.push({ target: t, path: relPath, action: 'skipped', skills: [skill] });
        } else if (!opts.force) {
          // Differs and no --force → blocked
          results.push({ target: t, path: relPath, action: 'blocked', skills: [skill] });
        } else {
          // Differs and --force → back up the current bytes to a fresh slot
          // (never clobbering an existing backup or following a symlink), then
          // overwrite. The overwrite itself can follow a symlink swapped in after
          // the check — an accepted TOCTOU residual for a local, single-user CLI.
          const backupPath = await writeBackup(agentFs, abs, existing);
          await agentFs.writeFile(abs, content);
          if (opts.output === 'text') {
            stderrFn(`backed up ${relPath} to ${path.relative(root, backupPath)}`);
          }
          results.push({ target: t, path: relPath, action: 'updated', skills: [skill] });
        }
      }
    }
  }

  // 6. Dry-run output
  if (opts.dryRun) {
    stderrFn('[dry-run] no files written — preview only');
    for (const { abs, bytes, note } of dryRunLines) {
      const suffix = note ? ` (${note}, ${bytes} bytes)` : ` (${bytes} bytes)`;
      stderrFn(`[dry-run] would write ${abs}${suffix}`);
    }
  }

  // 7. Blocked hints
  for (const r of results) {
    if (r.action === 'blocked') {
      stderrFn(
        `${r.path} exists and differs from the canonical skill — re-run with --force to overwrite (the existing file is backed up to .bak).`,
      );
    }
  }

  // 8. Print results
  out.print(results, data => {
    const items = data as InstallResult[];
    return items.map(r => `${r.target.padEnd(12)} ${r.action.padEnd(12)} ${r.path}`).join('\n');
  });

  // 9. Exit with 6 if any blocked
  if (results.some(r => r.action === 'blocked')) {
    throw new CLIError(
      'one or more targets already exist and differ; re-run with --force to overwrite (a .bak is kept).',
      6,
    );
  }
}

// ---------------------------------------------------------------------------
// runList
// ---------------------------------------------------------------------------

export interface ListResult {
  target: AgentTarget;
  skill: string;
  status: string;
  mode: string;
  path: string;
}

export async function runList(opts: CommonOptions, deps: AgentDeps = {}): Promise<void> {
  const out = makeOutput(opts.output, deps);

  // One row per (target × default skill). Own-file targets land each skill at a
  // distinct path; the codex managed-section target merges all skills into the
  // single AGENTS.md (so every codex row shares that path — truthful, since both
  // skills' content lands there).
  const results: ListResult[] = [];
  for (const [t, spec] of Object.entries(TARGETS) as [
    AgentTarget,
    { status: string; mode: string },
  ][]) {
    for (const skill of DEFAULT_SKILLS) {
      results.push({
        target: t,
        skill,
        status: spec.status,
        mode: spec.mode,
        path: pathFor(t, skill),
      });
    }
  }

  out.print(results, data => {
    const items = data as ListResult[];
    const header = `${'TARGET'.padEnd(14)} ${'SKILL'.padEnd(20)} ${'STATUS'.padEnd(12)} ${'MODE'.padEnd(18)} PATH`;
    const rows = items.map(
      r =>
        `${r.target.padEnd(14)} ${r.skill.padEnd(20)} ${r.status.padEnd(12)} ${r.mode.padEnd(18)} ${r.path}`,
    );
    return [header, ...rows].join('\n');
  });
}

// ---------------------------------------------------------------------------
// runStatus (issue #123: detect silently stale installed skill files)
// ---------------------------------------------------------------------------

/**
 * Health of one installed skill artifact, as reported by `agent status`.
 *
 * Decision order (first match wins):
 *  - 'absent'   : nothing at the landing path (codex: no managed section,
 *                 including an AGENTS.md that exists without our sentinels).
 *  - 'corrupt'  : codex only. Dangling or duplicated sentinels, the same
 *                 classification `agent install` refuses on; status REPORTS it
 *                 instead of refusing.
 *  - 'unmarked' : artifact present but carries no testsprite-skill marker
 *                 (installed before markers existed), or the landing path is
 *                 occupied by a non-regular file (never followed).
 *  - 'stale'    : marker present, but its hash differs from the current
 *                 canonical body: a re-install would change the content. Edits
 *                 on top of an OLD install also read stale (older renders
 *                 cannot be reproduced); the remedy is the same re-install.
 *  - 'modified' : marker hash matches the current body, but the artifact bytes
 *                 differ from the canonical render carrying that same marker
 *                 line: the user edited the artifact after install.
 *  - 'ok'       : marker hash matches and the bytes equal the canonical render
 *                 with the file's own marker line (a version-string-only lag
 *                 with an unchanged body still reads ok).
 *
 * For the codex managed section, ONE marker names every aggregated skill
 * ('+'-joined); skills not named by the marker report 'absent'.
 */
export type SkillArtifactState = 'ok' | 'stale' | 'modified' | 'unmarked' | 'absent' | 'corrupt';

export interface StatusResult {
  target: AgentTarget;
  skill: string;
  path: string;
  state: SkillArtifactState;
}

interface StatusOptions extends CommonOptions {
  dir?: string;
}

/**
 * Classify one own-file artifact per the {@link SkillArtifactState} contract.
 * Comparisons are byte-exact, matching the installer's own skipped/blocked
 * comparison for own-file targets.
 */
async function classifyOwnFileState(
  agentFs: AgentFs,
  abs: string,
  target: AgentTarget,
  skill: string,
  bodyForSkill: (skill: string) => string,
): Promise<SkillArtifactState> {
  const stat = await agentFs.lstat(abs);
  if (stat === null) return 'absent';
  // Occupied by a directory or symlink: not something our installer wrote, and
  // never followed (mirrors the installer's fail-closed stance on symlinks).
  if (!stat.isFile) return 'unmarked';

  const existing = await agentFs.readFile(abs);
  const marker = parseSkillMarker(existing);
  if (marker === null) return 'unmarked';

  const canonicalBody = bodyForSkill(skill);
  if (marker.hash12 !== bodyHash12(canonicalBody)) return 'stale';

  // Hash matches the current body: pristine iff the file equals the canonical
  // render carrying its own marker line, so a marker whose version string lags
  // behind an unchanged body still reads ok.
  const reRender = renderOwnFileWithMarker(target, skill, marker.line, canonicalBody);
  return existing === reRender ? 'ok' : 'modified';
}

/**
 * Classify the codex managed section per skill. The section is ONE artifact
 * carrying ONE marker that names every aggregated skill, so a single
 * inspection answers all skill rows; the returned function maps a skill name
 * to its state. Comparisons are CRLF-insensitive on the section bytes.
 */
async function classifyManagedSectionStates(
  agentFs: AgentFs,
  abs: string,
): Promise<(skill: string) => SkillArtifactState> {
  const constantState =
    (state: SkillArtifactState): ((skill: string) => SkillArtifactState) =>
    () =>
      state;

  const stat = await agentFs.lstat(abs);
  if (stat === null) return constantState('absent');
  // Occupied by a directory or symlink: never followed (fail-closed).
  if (!stat.isFile) return constantState('unmarked');

  const existing = await agentFs.readFile(abs);

  // Current canonical section for the default skill set. classifySection's
  // 'unchanged' answers the common all-defaults-fresh case; its
  // corrupt/append classification is reused verbatim for status verdicts.
  const defaultAggregate = buildCodexAggregate(DEFAULT_SKILLS);
  const defaultSection = buildSection(
    defaultAggregate,
    buildSkillMarker(DEFAULT_SKILLS.join(MARKER_SKILL_SEPARATOR), defaultAggregate),
  );
  const sectionState = classifySection(existing, defaultSection);

  if (sectionState.kind === 'corrupt') return constantState('corrupt');
  // No standalone sentinels anywhere: the managed section is not installed.
  if (sectionState.kind === 'append') return constantState('absent');
  if (sectionState.kind === 'unchanged') {
    // Byte-identical to today's default install.
    return skill => ((DEFAULT_SKILLS as readonly string[]).includes(skill) ? 'ok' : 'absent');
  }
  if (sectionState.kind !== 'replace') {
    // 'create' is unreachable when the file exists; treat defensively as absent.
    return constantState('absent');
  }

  // Sentinels are present but the section differs from today's default
  // canonical: slice the live section bytes out of the file and inspect its
  // own marker (before/after are exact byte prefix/suffix around the section).
  const sectionContent = existing.slice(
    sectionState.before.length,
    existing.length - sectionState.after.length,
  );
  const marker = parseSkillMarker(sectionContent);
  if (marker === null) return constantState('unmarked');

  const installedSkills = marker.skill.split(MARKER_SKILL_SEPARATOR);
  const coversSkill = (skill: string): boolean => installedSkills.includes(skill);

  // A marker naming a skill this CLI does not ship cannot be re-rendered;
  // report the named skills stale (a re-install refreshes the section).
  if (installedSkills.some(name => SKILLS[name] === undefined)) {
    return skill => (coversSkill(skill) ? 'stale' : 'absent');
  }

  const canonicalAggregate = buildCodexAggregate(installedSkills);
  if (marker.hash12 !== bodyHash12(canonicalAggregate)) {
    return skill => (coversSkill(skill) ? 'stale' : 'absent');
  }

  // Hash matches the current aggregate: the section is pristine iff its bytes
  // equal a re-render carrying its own marker line (version-string-only lag
  // with an unchanged body still reads ok).
  const pristine =
    sectionContent.replace(/\r\n/g, '\n') === buildSection(canonicalAggregate, marker.line);
  return skill => (coversSkill(skill) ? (pristine ? 'ok' : 'modified') : 'absent');
}

/**
 * `agent status`: one row per (target × default skill), each classified per
 * the {@link SkillArtifactState} contract. Exit contract: returns normally
 * (exit 0) when every row is 'ok' or 'absent'; throws CLIError exit 1 when any
 * row is stale/modified/unmarked/corrupt, so the command can gate CI.
 */
export async function runStatus(opts: StatusOptions, deps: AgentDeps = {}): Promise<void> {
  const agentFs = deps.fs ?? defaultAgentFs;
  const out = makeOutput(opts.output, deps);

  // An explicit but empty --dir must not silently resolve to cwd
  // (path.resolve('') === cwd).
  if (opts.dir !== undefined && opts.dir.trim() === '') {
    throw localValidationError('dir', 'must not be empty');
  }
  const dir = opts.dir !== undefined ? opts.dir.trim() : (deps.cwd ?? process.cwd());
  const root = path.resolve(dir);

  // Canonical own-file bodies, read once per skill (same lazy caching pattern
  // as runInstall's bodyForSkill).
  const skillBodyCache = new Map<string, string>();
  const bodyForSkill = (skill: string): string => {
    let cachedBody = skillBodyCache.get(skill);
    if (cachedBody === undefined) {
      cachedBody = loadSkillBodyFor(skill);
      skillBodyCache.set(skill, cachedBody);
    }
    return cachedBody;
  };

  const results: StatusResult[] = [];
  for (const [target, spec] of Object.entries(TARGETS) as [
    AgentTarget,
    { mode: string; path: string },
  ][]) {
    if (spec.mode === 'managed-section') {
      const stateFor = await classifyManagedSectionStates(agentFs, path.resolve(root, spec.path));
      for (const skill of DEFAULT_SKILLS) {
        results.push({ target, skill, path: spec.path, state: stateFor(skill) });
      }
      continue;
    }
    for (const skill of DEFAULT_SKILLS) {
      const relPath = pathFor(target, skill);
      results.push({
        target,
        skill,
        path: relPath,
        state: await classifyOwnFileState(
          agentFs,
          path.resolve(root, relPath),
          target,
          skill,
          bodyForSkill,
        ),
      });
    }
  }

  out.print(results, data => {
    const items = data as StatusResult[];
    const header = `${'TARGET'.padEnd(14)} ${'SKILL'.padEnd(20)} ${'STATE'.padEnd(10)} PATH`;
    const rows = items.map(
      row => `${row.target.padEnd(14)} ${row.skill.padEnd(20)} ${row.state.padEnd(10)} ${row.path}`,
    );
    return [header, ...rows].join('\n');
  });

  const needingAttention = results.filter(
    result => result.state !== 'ok' && result.state !== 'absent',
  );
  if (needingAttention.length > 0) {
    throw new CLIError(
      `${needingAttention.length} skill artifact(s) need attention (stale/modified/unmarked/corrupt); re-run \`testsprite agent install\` (add --force for own-file targets) to refresh them.`,
      1,
    );
  }
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

function collect(v: string, prev: string[]): string[] {
  return prev.concat(v);
}

export function createAgentCommand(deps: AgentDeps = {}): Command {
  const agent = new Command('agent').description(
    'Install TestSprite guidance into coding-agent config (Claude Code, Cursor, Cline, Antigravity, Kiro, Windsurf, Copilot, Codex)',
  );

  agent
    .command('install')
    .description(
      'Write the TestSprite agent skills (verification loop + first-run onboarding) into a project for a coding agent',
    )
    .option(
      '--target <t>',
      'Agent target(s): claude, cursor, cline, antigravity, kiro, windsurf, copilot, codex (comma-separated or repeated)',
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
      'For own-file targets: overwrite existing file (a .bak backup is kept). ' +
        'For codex (managed-section): replaces the section unconditionally; user content outside the section is never destroyed.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (
        cmdOpts: { target: string[]; skill: string[]; dir?: string; force?: boolean },
        command: Command,
      ) => {
        await runInstall(
          {
            ...resolveCommonOptions(command),
            target: cmdOpts.target,
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
    .description('List supported agent targets and skills, their status, and landing paths')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (_o, command: Command) => {
      await runList(resolveCommonOptions(command), deps);
    });

  agent
    .command('status')
    .description(
      'Check installed TestSprite skill files against this CLI version: ok, stale, modified, unmarked, absent, or corrupt (exits 1 when anything needs attention, so it can gate CI)',
    )
    .option('--dir <path>', 'Project root to inspect (default: cwd)')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts: { dir?: string }, command: Command) => {
      await runStatus({ ...resolveCommonOptions(command), dir: cmdOpts.dir }, deps);
    });

  return agent;
}

// ---------------------------------------------------------------------------
// Per-file helpers (per convention: copy from auth.ts)
// ---------------------------------------------------------------------------

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
