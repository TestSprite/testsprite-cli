/**
 * Which coding agents does this repo use?
 *
 * Two signal classes, kept apart because they answer different questions: `env`
 * is who is invoking the CLI now, `trace` is who has been used here. Only two
 * targets publish a usable env var, so traces cover the rest.
 */

import { join } from 'node:path';
import {
  existsSync as nodeExistsSync,
  readFileSync as nodeReadFileSync,
  readdirSync as nodeReaddirSync,
  statSync as nodeStatSync,
} from 'node:fs';
import { DEFAULT_SKILLS, TARGETS, pathFor, type AgentTarget } from './agent-targets.js';

export type DetectionSource = 'env' | 'trace';

export interface AgentDetection {
  target: AgentTarget;
  source: DetectionSource;
  /** What matched — an env var name or a repo path. Named in the stderr summary. */
  signal: string;
}

export interface DetectDeps {
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  readdirSync?: (path: string) => string[];
  isDirectory?: (path: string) => boolean;
}

/**
 * Environment variables that identify the invoking agent.
 *
 * Only add a variable that is observed or vendor-documented: a guessed name
 * never matches, so it degrades to the fallback instead of failing loudly.
 * The other six targets publish nothing usable — VSCODE_* and TERM_PROGRAM
 * name the editor, not the agent, and cannot separate cursor from windsurf.
 *
 * Presence is the signal, so a CI job that exports one of these is read as that
 * agent calling. The cost is bounded and one-directional: an extra skill file
 * installed, and `detected` rather than `fallback` in the summary. Pass
 * `--agent` to decide it explicitly, or `--no-agent` to install nothing.
 */
const ENV_SIGNALS: Partial<Record<AgentTarget, readonly string[]>> = {
  claude: ['CLAUDECODE'],
  cursor: ['CURSOR_AGENT'],
};

/**
 * Repo paths that show an agent has been used here.
 *
 * Each is the config root the agent itself owns, which is also where our skill
 * lands — so presence alone is not enough (see `hasForeignContent`).
 */
const TRACE_PATHS: Record<AgentTarget, string> = {
  claude: '.claude',
  antigravity: '.agents',
  cursor: '.cursor',
  cline: '.clinerules',
  kiro: '.kiro',
  windsurf: '.windsurf',
  copilot: '.github/instructions',
  codex: 'AGENTS.md',
};

const MAX_TRACE_DEPTH = 4;

function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

/**
 * Every relative path this CLI writes for a target, across all default skills.
 *
 * Includes the `.bak` sibling `agent install --force` leaves behind. Without
 * it one forced reinstall makes that target permanently "detected" from its
 * own backup — the self-reinforcement `hasForeignContent` exists to prevent,
 * just one file over.
 */
function ownPaths(target: AgentTarget): string[] {
  return DEFAULT_SKILLS.flatMap(skill => {
    const p = pathFor(target, skill).replace(/\\/g, '/');
    return [p, `${p}.bak`];
  });
}

/**
 * True when the trace holds something this CLI did not put there.
 *
 * Without this the fallback is self-reinforcing: a repo where nothing was
 * detected gets our own skill files written, and the next run reads those back
 * as evidence of the agent we guessed.
 */
function hasForeignContent(
  dir: string,
  target: AgentTarget,
  relRoot: string,
  deps: Required<Pick<DetectDeps, 'readdirSync' | 'isDirectory'>>,
): boolean {
  const mine = new Set(ownPaths(target));

  const walk = (rel: string, depth: number): boolean => {
    if (depth > MAX_TRACE_DEPTH) return true; // too deep to be only ours
    let entries: string[];
    try {
      entries = deps.readdirSync(join(dir, rel));
    } catch {
      return false; // unreadable → claim nothing
    }
    for (const entry of entries) {
      const childRel = `${rel}/${entry}`;
      if (mine.has(childRel)) continue;
      // A directory on the way to one of our files is not itself evidence.
      const isPrefix = [...mine].some(p => p.startsWith(`${childRel}/`));
      if (!isPrefix) return true;
      if (deps.isDirectory(join(dir, childRel)) && walk(childRel, depth + 1)) return true;
    }
    return false;
  };

  return walk(relRoot, 1);
}

/**
 * `AGENTS.md` is a cross-agent convention file, and this CLI creates it when
 * absent — so it counts as a codex trace only when it carries content beyond
 * our own managed section.
 */
function agentsFileHasForeignContent(content: string): boolean {
  const withoutSection = content.replace(
    /<!--\s*BEGIN TESTSPRITE AGENT SECTION[\s\S]*?END TESTSPRITE AGENT SECTION\s*-->/g,
    '',
  );
  return withoutSection.trim().length > 0;
}

export interface DetectAgentDeps extends DetectDeps {
  readFileSync?: (path: string) => string;
}

/**
 * Who is invoking the CLI right now, from the environment alone — no fs, no
 * repo history. This is the only signal that identifies the CALLER; a repo
 * trace only shows an agent was used here at some point.
 */
export function detectCallerFromEnv(env: NodeJS.ProcessEnv = process.env): AgentDetection[] {
  const out: AgentDetection[] = [];
  for (const [target, vars] of Object.entries(ENV_SIGNALS) as Array<
    [AgentTarget, readonly string[]]
  >) {
    const hit = vars.find(name => truthy(env[name]));
    if (hit) out.push({ target, source: 'env', signal: hit });
  }
  return out;
}

/**
 * Targets detected in `dir`, env signals first.
 *
 * Order is significant: `setup` reports these in order, so the strongest
 * evidence is named first. A target found by both appears once, as `env`.
 */
export function detectAgentTargets(dir: string, deps: DetectAgentDeps = {}): AgentDetection[] {
  const env = deps.env ?? process.env;
  const exists = deps.existsSync ?? nodeExistsSync;
  const readdir =
    deps.readdirSync ??
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path comes from this module's own TRACE_PATHS table joined to the caller's dir, never from user input.
    ((p: string) => nodeReaddirSync(p) as unknown as string[]);
  const isDir =
    deps.isDirectory ??
    ((p: string) => {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above.
        return nodeStatSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  const readFile =
    deps.readFileSync ??
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above.
    ((p: string) => nodeReadFileSync(p, 'utf8'));

  const out: AgentDetection[] = detectCallerFromEnv(env);
  const seen = new Set<AgentTarget>(out.map(d => d.target));

  for (const target of Object.keys(TARGETS) as AgentTarget[]) {
    if (seen.has(target)) continue;
    const rel = TRACE_PATHS[target];
    const full = join(dir, rel);
    if (!exists(full)) continue;

    if (TARGETS[target].mode === 'managed-section') {
      let content: string;
      try {
        content = readFile(full);
      } catch {
        continue; // unreadable → claim nothing
      }
      if (!agentsFileHasForeignContent(content)) continue;
    } else if (!hasForeignContent(dir, target, rel, { readdirSync: readdir, isDirectory: isDir })) {
      continue;
    }

    out.push({ target, source: 'trace', signal: rel });
    seen.add(target);
  }

  return out;
}

/** Just the targets, for callers that do not report the evidence. */
export function detectedTargets(dir: string, deps: DetectAgentDeps = {}): AgentTarget[] {
  return detectAgentTargets(dir, deps).map(d => d.target);
}

/** Installed when nothing is detected and the caller named no target. */
export const FALLBACK_TARGET: AgentTarget = 'claude';

export interface AgentResolution {
  targets: AgentTarget[];
  /** How `targets` was chosen — `flag` means the caller named it. */
  source: 'flag' | DetectionSource | 'fallback';
  /** Evidence behind a detected result; empty for `flag` and `fallback`. */
  detections: AgentDetection[];
}

/**
 * Which targets an install should cover: an explicit choice, else every agent
 * detected in `dir`, else {@link FALLBACK_TARGET}.
 */
export function resolveAgentTargets(
  explicit: AgentTarget | undefined,
  dir: string,
  deps: DetectAgentDeps = {},
): AgentResolution {
  if (explicit) return { targets: [explicit], source: 'flag', detections: [] };

  const detections = detectAgentTargets(dir, deps);
  if (detections.length === 0) {
    return { targets: [FALLBACK_TARGET], source: 'fallback', detections };
  }

  return {
    targets: detections.map(d => d.target),
    source: detections.some(d => d.source === 'env') ? 'env' : 'trace',
    detections,
  };
}
