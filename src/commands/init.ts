/**
 * `testsprite init` — one-shot onboarding orchestrator.
 *
 * Chains, in order:
 *   0. Agent-target resolution + confirmation prompt — the chosen install
 *      targets are settled here, before anything is written
 *   1. runConfigure  — writes the API-key profile (validates via GET /me first)
 *   2. runWhoami     — fetches identity for the post-configure banner
 *   3. runInstall    — installs the TestSprite verification-loop skill (unless --no-agent)
 *   4. Summary print — JSON object or human text block
 *
 * Hard constraint: orchestrate existing exported primitives; never fork them.
 */

import { Command } from 'commander';
import {
  parseRequestTimeoutFlag,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import { normalizeEnvVar } from '../lib/config.js';
import { emitDeprecationNotice } from '../lib/deprecate.js';
import { CLIError, localValidationError } from '../lib/errors.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode } from '../lib/output.js';
import type { AuthDeps, MeResponse } from './auth.js';
import { runConfigure, runWhoami } from './auth.js';
import type { AgentDeps, AgentFs, InstallResult } from './agent.js';
import { runInstall } from './agent.js';
import { TARGETS, DEFAULT_SKILLS, type AgentTarget } from '../lib/agent-targets.js';
import {
  FALLBACK_TARGET,
  resolveAgentTargets,
  type AgentDetection,
  type AgentResolution,
  type DetectAgentDeps,
} from '../lib/agent-detect.js';
import { promptText } from '../lib/prompt.js';
import type { FetchImpl } from '../lib/http.js';
import { readProfile } from '../lib/credentials.js';

/** Mirrors auth.ts's DEFAULT_API_URL (kept in sync; auth.ts owns the canonical value). */
const DEFAULT_API_URL = 'https://api.testsprite.com';

/**
 * Resolve the endpoint the summary should report, using the SAME precedence
 * `runConfigure` uses to pick (and persist) the endpoint:
 *   --endpoint-url  >  TESTSPRITE_API_URL env  >  existing profile apiUrl  >  prod default.
 * Reporting a flat prod default would falsely claim a prod target after
 * configuring staging/dev (codex). On the real path this runs AFTER the profile
 * is written, so the persisted apiUrl is reflected faithfully.
 */
function resolveReportedEndpoint(opts: InitOptions, deps: InitDeps): string {
  const env = deps.env ?? process.env;
  const envApiUrl = normalizeEnvVar(env.TESTSPRITE_API_URL);
  let existing: string | undefined;
  try {
    existing = readProfile(opts.profile, { path: deps.credentialsPath })?.apiUrl;
  } catch {
    existing = undefined;
  }
  return opts.endpointUrl ?? envApiUrl ?? existing ?? DEFAULT_API_URL;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CommonOptions = FactoryCommonOptions;

/**
 * InitDeps merges AuthDeps and AgentDeps. Because the `prompt` field differs
 * between them (`{secret: fn}` in AuthDeps vs a plain function in AgentDeps),
 * we compose manually and expose `agentPrompt` for the agent install step.
 */
export interface InitDeps {
  // Shared output/environment
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;

  // AuthDeps-specific
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  /** Injected for auth configure: { secret: (q) => Promise<string> } */
  prompt?: AuthDeps['prompt'];
  preludeWrite?: (chunk: string) => void;

  // AgentDeps-specific
  cwd?: string;
  fs?: AgentFs;
  isTTY?: boolean;
  /** Injected for agent install prompt (plain function, not {secret: fn}) */
  agentPrompt?: (question: string) => Promise<string>;

  /** Injected fs/env for caller detection; defaults to the real repo under `cwd`. */
  detect?: DetectAgentDeps;
}

interface InitOptions extends CommonOptions {
  apiKey?: string;
  fromEnv: boolean;
  /**
   * The target the caller explicitly chose. Absent means "decide from what this
   * repo shows", so it must stay unset unless `--agent` was really passed —
   * a default filled in here would suppress detection for every run.
   */
  agent?: AgentTarget;
  noAgent: boolean;
  force: boolean;
  dir?: string;
  yes: boolean;
  /**
   * When true and the active profile already has a saved API key, skip the
   * interactive key prompt. Forwarded verbatim to runConfigure. Has no
   * effect when --api-key or --from-env is also given.
   */
  skipIfConfigured?: boolean;
  /** Set by the command action when both --agent and --no-agent appear in rawArgs. */
  rawArgConflict?: boolean;
}

export interface InitSummary {
  profile: string;
  apiUrl: string;
  env: string;
  email?: string;
  scopes: string[];
  /**
   * Agent skill install outcome. `action` is an AGGREGATE across the installed
   * skills (setup installs {@link DEFAULT_SKILLS}); `skills` lists which skills
   * landed. `null` when --no-agent.
   *
   * `targets` holds every agent installed for; `target` repeats the first so a
   * reader of the single-target field keeps working.
   */
  agent: {
    target: string;
    targets: string[];
    /**
     * How the SET was arrived at: `flag` when `--agent` named it, `fallback`
     * when nothing was found, otherwise `detected`.
     *
     * Deliberately not `'env' | 'trace'`: resolution is a UNION of both
     * signals, so a single word would label a five-target set by whichever
     * signal happened to fire first. Per-target provenance lives in
     * `detections` below.
     */
    detectedBy: 'flag' | 'detected' | 'fallback';
    /**
     * One row per detected target, so a JSON consumer can tell which signal
     * produced which install. Empty for `flag` and `fallback`.
     */
    detections: Array<{ target: string; source: AgentDetection['source']; signal: string }>;
    action: string;
    skills?: string[];
  } | null;
  /**
   * Why `agent` is null: `flag` for `--no-agent`, `prompt` when the
   * confirmation prompt was answered `none`. Absent when skills were installed.
   */
  agentSkippedBy?: 'flag' | 'prompt';
  status: 'initialized';
}

/**
 * Provenance for the summary. `env` and `trace` both collapse to `detected`
 * because resolution is a union of the two signals — one word cannot honestly
 * label a set whose members came from different ones. The split is carried
 * per target in `detections`.
 */
function agentProvenance(
  r: AgentResolution,
): Pick<NonNullable<InitSummary['agent']>, 'detectedBy' | 'detections'> {
  return {
    detectedBy: r.source === 'flag' || r.source === 'fallback' ? r.source : 'detected',
    detections: r.detections.map(d => ({
      target: d.target,
      source: d.source,
      signal: d.signal,
    })),
  };
}

/**
 * Collapse the per-skill install actions into one representative action for the
 * init summary. Precedence: a real change (updated) outranks a fresh install,
 * which outranks a no-op. `blocked` never reaches here — runInstall throws first.
 */
function aggregateInstallAction(actions: string[]): string {
  if (actions.some(a => a === 'updated' || a === 'section-updated')) return 'updated';
  if (actions.some(a => a === 'written' || a === 'section-installed')) return 'installed';
  if (actions.some(a => a === 'dry-run')) return 'dry-run';
  return 'skipped'; // all skipped / section-unchanged
}

// ---------------------------------------------------------------------------
// Helpers to split deps into the two primitive shapes
// ---------------------------------------------------------------------------

/**
 * Build AuthDeps from InitDeps. `stdout` is intentionally suppressed here
 * because runInit owns the final output — runConfigure's success message
 * and runWhoami's identity block are replaced by the init summary.
 * stderr (advisory messages, errors) flows through.
 */
function toAuthDeps(deps: InitDeps, apiKey?: string, commandTag?: string): AuthDeps {
  return {
    env: deps.env,
    credentialsPath: deps.credentialsPath,
    fetchImpl: deps.fetchImpl,
    stdout: _suppressedStdout,
    stderr: deps.stderr,
    // Forward the preludeWrite so injected tests can capture the "Configuring
    // profile..." line, but default to a no-op so tests that don't care don't
    // see it on real process.stdout.
    preludeWrite: deps.preludeWrite ?? _suppressedStdout,
    // If an explicit API key was provided, override the prompt so configure
    // never actually prompts the user.
    prompt: apiKey ? { secret: async (_q: string) => apiKey } : deps.prompt,
    // Telemetry attribution for the configure-validate GET /me. Passed only for
    // the configure step (see runInit) — never whoami — so each init run emits
    // exactly one cli.initialized event on the backend.
    commandTag,
  };
}

/**
 * Build AgentDeps from InitDeps. `stdout` is suppressed for the same reason —
 * runInit owns output. The result is parsed from the captured JSON in the
 * caller, not forwarded to user stdout.
 */
function toAgentDeps(deps: InitDeps, captureStdout?: (line: string) => void): AgentDeps {
  return {
    cwd: deps.cwd,
    fs: deps.fs,
    stdout: captureStdout ?? _suppressedStdout,
    stderr: deps.stderr,
    isTTY: deps.isTTY,
    prompt: deps.agentPrompt,
  };
}

// Discards stdout lines from sub-commands so runInit owns the output surface.
function _suppressedStdout(_line: string): void {
  // intentionally empty
}

/**
 * Say which agents the install covers and why. Silent when `--agent` named one
 * (the caller already knows), and always says the fallback out loud — an
 * unannounced fallback is how skills land where the calling agent cannot read
 * them while the command still reports success.
 */
function emitAgentResolutionNotice(
  resolution: AgentResolution,
  stderrFn: (line: string) => void,
  willPrompt = false,
): void {
  if (resolution.source === 'flag') return;

  if (resolution.source === 'fallback') {
    stderrFn(
      `[info] no coding agent detected in this project; installing for ${FALLBACK_TARGET}. ` +
        `Pass --agent <target> to choose (${Object.keys(TARGETS).join(', ')}).`,
    );
    return;
  }

  const evidence = resolution.detections.map(d => `${d.target} (${d.signal})`).join(', ');
  // When a prompt follows, the install set is not decided yet — saying
  // "installing for X" here would read as a decision already taken.
  if (willPrompt) {
    stderrFn(`[info] detected ${evidence}`);
    return;
  }
  stderrFn(`[info] detected ${evidence}; installing skills for ${resolution.targets.join(', ')}`);
}

/** Whether `confirmDetectedTargets` will actually ask. */
function shouldConfirmTargets(
  resolution: AgentResolution,
  opts: { output?: string; yes?: boolean; dryRun?: boolean },
  isTTY: boolean,
): boolean {
  const fromDetection = resolution.source === 'env' || resolution.source === 'trace';
  return fromDetection && isTTY && !opts.yes && !opts.dryRun && opts.output !== 'json';
}

const CONFIRM_TARGETS_MAX_ATTEMPTS = 3;

/**
 * Let an operator see and edit the detected set before anything is written.
 *
 * Detection is a UNION of env and repo signals, so an ordinary repo carrying
 * `AGENTS.md` plus a couple of agent config roots resolves to five targets and
 * nine files — two of them shared, always-on rule files. `agent install`
 * already asks when it has to choose; setup asking too keeps the two commands
 * telling the same story.
 *
 * Returns the set to install, or `null` when the answer was `none` — the
 * prompt's equivalent of `--no-agent`. Asks nothing when `--agent` named it
 * (already explicit), on the fallback (one target, and the notice says so),
 * under `--yes`, under `--dry-run` (nothing is written), off a TTY, or in JSON
 * mode — a prompt there would corrupt the single-object stdout contract, the
 * same reason the API-key prompt is refused in that mode.
 *
 * An unrecognised name is refused here and asked again, a bounded number of
 * times. This runs before credentials are written, so a typo costs a retry
 * rather than a half-finished setup that exits 5 after the key was saved.
 */
async function confirmDetectedTargets(
  resolution: AgentResolution,
  opts: { output?: string; yes?: boolean; dryRun?: boolean },
  isTTY: boolean,
  stderrFn: (line: string) => void,
  promptFn?: (question: string) => Promise<string>,
): Promise<AgentTarget[] | null> {
  if (!shouldConfirmTargets(resolution, opts, isTTY)) {
    return [...resolution.targets];
  }

  const suggestion = resolution.targets.join(',');
  const validTargets = Object.keys(TARGETS) as AgentTarget[];
  const ask = promptFn ?? ((q: string) => promptText(q));

  for (let attempt = 1; attempt <= CONFIRM_TARGETS_MAX_ATTEMPTS; attempt++) {
    const answer = (
      await ask(`Install skills for (comma-separated, or "none" to skip) [${suggestion}]: `)
    ).trim();
    if (answer.toLowerCase() === 'none') return null;

    // Lower-cased for the same reason `none` is: every target name is lower
    // case, so `Claude` is a typo only in the sense that the shift key was
    // down. Refusing it while accepting `NONE` would be an inconsistency the
    // user has no way to predict.
    const chosen = (answer || suggestion)
      .split(',')
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean);
    // An answer of only separators ("," / ", ,") parses to nothing. Treat it as
    // the empty answer it effectively is rather than installing for no target.
    if (chosen.length === 0) return [...resolution.targets];

    const unknown = chosen.filter(t => !validTargets.includes(t as AgentTarget));
    if (unknown.length === 0) return [...new Set(chosen)] as AgentTarget[];

    stderrFn(
      `[warn] unknown target ${unknown.map(t => `"${t}"`).join(', ')}; ` +
        `supported: ${validTargets.join(', ')} (or "none" to skip)`,
    );
  }

  throw new CLIError(
    `No recognised agent target after ${CONFIRM_TARGETS_MAX_ATTEMPTS} attempts. ` +
      `Re-run with --agent <target> (${validTargets.join(', ')}) or --no-agent.`,
    5,
  );
}

// ---------------------------------------------------------------------------
// runInit
// ---------------------------------------------------------------------------

export async function runInit(opts: InitOptions, deps: InitDeps = {}): Promise<void> {
  const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const out = new Output(opts.output, { stdout: deps.stdout, stderr: deps.stderr });

  // An unknown --agent is refused here, before credentials are written. Left
  // to runInstall it surfaced as a `--target` error — a flag this command does
  // not have — after the key was already saved, with a hint echoing the bad
  // value back.
  const validTargets = Object.keys(TARGETS) as AgentTarget[];
  if (opts.agent !== undefined && !opts.noAgent && !validTargets.includes(opts.agent)) {
    throw localValidationError(
      'agent',
      `unknown target "${opts.agent}"; supported: ${validTargets.join(', ')}`,
    );
  }

  // -------------------------------------------------------------------------
  // Which agents to install for: an explicit --agent, else whatever this repo
  // shows, else the fallback. Resolved before any output so every branch below
  // (conflict warning, dry-run preview, real install) reports the same set.
  // -------------------------------------------------------------------------
  let resolution: AgentResolution | null = opts.noAgent
    ? null
    : resolveAgentTargets(opts.agent, opts.dir ?? deps.cwd ?? process.cwd(), {
        env: deps.env,
        ...deps.detect,
      });

  // -------------------------------------------------------------------------
  // Fix 5: emit conflict warning when both --agent and --no-agent were given
  // -------------------------------------------------------------------------
  if (opts.rawArgConflict) {
    const effectiveLabel = opts.noAgent
      ? '--no-agent'
      : `--agent ${opts.agent ?? resolution?.targets.join(',')}`;
    stderrFn(
      `[warn] both --no-agent and --agent supplied; using ${effectiveLabel} (last flag wins)`,
    );
  }

  // -------------------------------------------------------------------------
  // Non-interactive guard: no TTY + no key source → exit 5 immediately
  // -------------------------------------------------------------------------
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const hasKeySource = Boolean(opts.apiKey) || opts.fromEnv;
  // --skip-if-configured counts as a key source when a saved key already exists:
  // runConfigure will short-circuit before prompting, so no TTY is needed.
  const credentialsPath = deps.credentialsPath;
  const savedKey = credentialsPath
    ? readProfile(opts.profile, { path: credentialsPath })?.apiKey
    : readProfile(opts.profile)?.apiKey;
  const skipWillApply = Boolean(opts.skipIfConfigured) && Boolean(savedKey) && !hasKeySource;
  // Non-interactive guard: no TTY + no key source → exit 5. Skipped under
  // --dry-run, which is documented to work without credentials or network.
  if (!isTTY && !hasKeySource && !skipWillApply && !opts.dryRun) {
    throw new CLIError(
      'No API key available in non-interactive mode. ' +
        'Pass --api-key <key>, --from-env (reads TESTSPRITE_API_KEY), or run interactively.',
      5,
    );
  }
  // JSON-output guard: an interactive secret prompt writes to stdout and would
  // corrupt init's single-JSON-object output contract. In --output json mode
  // require a non-interactive key source. Skipped under --dry-run (never prompts).
  if (opts.output === 'json' && !hasKeySource && !skipWillApply && !opts.dryRun) {
    throw new CLIError(
      'Interactive API-key prompt is unavailable in --output json mode (it would corrupt JSON stdout). ' +
        'Pass --api-key <key> or --from-env.',
      5,
    );
  }

  // Announced only once the guards above have passed — otherwise a `--yes` with
  // no key source printed "detected …" and then exited 5, describing an install
  // that was never going to happen.
  let agentSkippedBy: InitSummary['agentSkippedBy'] = opts.noAgent ? 'flag' : undefined;
  if (resolution) {
    const willPrompt = shouldConfirmTargets(resolution, opts, isTTY);
    emitAgentResolutionNotice(resolution, stderrFn, willPrompt);

    // A detected set is confirmable before it lands; every other case passes
    // through untouched. Narrowed here so every downstream reader — the install
    // call, the summary, the failure hint — sees the set actually chosen.
    const confirmed = await confirmDetectedTargets(
      resolution,
      opts,
      isTTY,
      stderrFn,
      deps.agentPrompt,
    );
    if (confirmed === null) {
      stderrFn('[info] skipping the agent skill install (answered "none")');
      resolution = null;
      agentSkippedBy = 'prompt';
    } else {
      resolution = { ...resolution, targets: confirmed };
      if (willPrompt) stderrFn(`[info] installing skills for ${confirmed.join(', ')}`);
    }
  }

  // -------------------------------------------------------------------------
  // Dry-run: zero network + zero FS writes; print preview only
  // -------------------------------------------------------------------------
  if (opts.dryRun) {
    stderrFn('[dry-run] no writes or network calls — preview only');
    stderrFn(
      `[dry-run] would configure profile="${opts.profile}" (key source: ${
        opts.apiKey
          ? 'flag'
          : opts.fromEnv
            ? 'env'
            : opts.skipIfConfigured
              ? 'skip-if-configured'
              : 'prompt'
      })`,
    );

    if (resolution) {
      // Delegate to runInstall's own dry-run for the file-listing preview.
      // runInstall prints the would-write lines itself under dryRun.
      await runInstall(
        {
          ...opts,
          target: resolution.targets,
          force: opts.force,
          dir: opts.dir,
        },
        toAgentDeps(deps),
      );
    }

    const summary: InitSummary = {
      profile: opts.profile,
      apiUrl: resolveReportedEndpoint(opts, deps),
      env: 'development',
      scopes: [],
      agent: resolution
        ? {
            target: resolution.targets[0]!,
            targets: [...resolution.targets],
            ...agentProvenance(resolution),
            action: 'dry-run',
            skills: [...DEFAULT_SKILLS],
          }
        : null,
      status: 'initialized',
    };

    out.print(summary, renderInitText);
    return;
  }

  // -------------------------------------------------------------------------
  // Step 1: Configure — validates key via GET /me before writing the profile
  // -------------------------------------------------------------------------
  // --api-key takes precedence over --from-env: when an explicit key is supplied,
  // force fromEnv=false so runConfigure uses the injected key (toAuthDeps wires it
  // as the prompt) instead of reading TESTSPRITE_API_KEY from the environment (codex).
  await runConfigure(
    {
      ...opts,
      fromEnv: opts.apiKey ? false : opts.fromEnv,
      // --api-key always overwrites; skip only applies when no explicit key source was given.
      skipIfConfigured: opts.apiKey ? false : opts.skipIfConfigured,
    },
    // commandTag:'init' tags ONLY this configure-validate GET /me with
    // `X-CLI-Command: init` → counted as cli.initialized. The whoami banner call
    // below builds deps WITHOUT a tag, so init emits exactly one cli.initialized.
    toAuthDeps(deps, opts.apiKey, 'init'),
  );

  // -------------------------------------------------------------------------
  // Step 2: Whoami banner — for identity display only; not used for validation
  // -------------------------------------------------------------------------
  // runWhoami resolves its key via loadConfig (`env.TESTSPRITE_API_KEY ?? profile`).
  // When the user passed an explicit --api-key, that key was just written to the
  // profile above — but a STALE/different TESTSPRITE_API_KEY still in the environment
  // would WIN in loadConfig and make the banner read the wrong identity (a bogus key →
  // 401 → misleading `production`/no-email summary). Strip it for the whoami read so it
  // uses the profile we just wrote (E2E finding 2026-06-09). Only when --api-key was
  // given: a bare --from-env run legitimately relies on the env key.
  const whoamiDeps = toAuthDeps(deps);
  if (opts.apiKey) {
    const sanitizedEnv = { ...(deps.env ?? process.env) };
    delete sanitizedEnv.TESTSPRITE_API_KEY;
    whoamiDeps.env = sanitizedEnv;
  }
  let me: MeResponse;
  try {
    me = await runWhoami(opts, whoamiDeps);
  } catch (err) {
    // Whoami is display-only. If it fails after a successful configure,
    // continue with a minimal placeholder so the summary still prints.
    if (opts.debug) {
      const reason = err instanceof Error ? err.message : String(err);
      stderrFn(`[debug] setup identity lookup failed after configure: ${reason}`);
    }
    me = { userId: '', keyId: '', scopes: [], env: 'production' };
  }

  // -------------------------------------------------------------------------
  // Step 3: Agent skill install (unless --no-agent)
  // -------------------------------------------------------------------------
  let installedTargets: AgentTarget[] | null = null;
  let installedAction: string | null = null;
  let installedSkills: string[] = [];

  if (resolution) {
    // Run install in JSON mode internally so we can reliably parse the result
    // regardless of the outer --output flag. The stdout is captured here and
    // NOT forwarded — runInit owns the output surface. setup installs the full
    // DEFAULT_SKILLS set (runInstall's default), so several InstallResults come
    // back (one per own-file skill; one aggregate for codex).
    let capturedInstallResults: InstallResult[] = [];
    const captureStdout = (line: string) => {
      try {
        const parsed = JSON.parse(line) as InstallResult[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          capturedInstallResults = parsed;
        }
      } catch {
        // ignore non-JSON lines (shouldn't happen in json mode, but be safe)
      }
    };

    try {
      await runInstall(
        {
          ...opts,
          output: 'json', // parse the result; final summary is ours to print
          target: resolution.targets,
          // skills omitted → runInstall installs DEFAULT_SKILLS (verify + onboard)
          force: opts.force,
          dir: opts.dir,
        },
        toAgentDeps(deps, captureStdout),
      );

      installedTargets = [...resolution.targets];
      installedAction =
        capturedInstallResults.length > 0
          ? aggregateInstallAction(capturedInstallResults.map(r => r.action))
          : 'installed';
      // De-dupe skills across results, preserving first-seen order.
      installedSkills = [...new Set(capturedInstallResults.flatMap(r => r.skills ?? []))];
    } catch (installErr) {
      // Fix 6: credentials were already saved (Step 1+2 above succeeded).
      // Emit a clear summary line BEFORE re-throwing so the user knows their
      // API key was persisted — only the agent skill step failed (Fix 6).
      stderrFn(
        `[info] credentials saved for profile "${opts.profile}"; only the agent skill install failed — ` +
          `re-run 'testsprite agent install --target ${resolution.targets.join(',')}' after fixing the path`,
      );
      throw installErr;
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Summary
  // -------------------------------------------------------------------------
  const agentSummary: InitSummary['agent'] =
    resolution === null || installedTargets === null
      ? null
      : {
          target: installedTargets[0]!,
          targets: installedTargets,
          ...agentProvenance(resolution),
          action: installedAction ?? 'installed',
          skills: installedSkills.length > 0 ? installedSkills : [...DEFAULT_SKILLS],
        };

  const summary: InitSummary = {
    profile: opts.profile,
    // Resolved AFTER configure persists the profile → reflects the real endpoint
    // (staging/dev/prod), not a flat prod default (codex).
    apiUrl: resolveReportedEndpoint(opts, deps),
    env: me.env,
    email: me.email,
    scopes: me.scopes,
    agent: agentSummary,
    ...(agentSummary === null && agentSkippedBy ? { agentSkippedBy } : {}),
    status: 'initialized',
  };

  out.print(summary, renderInitText);
}

// ---------------------------------------------------------------------------
// Text renderer
// ---------------------------------------------------------------------------

function renderInitText(data: unknown): string {
  const s = data as InitSummary;
  const lines: string[] = [];

  lines.push('TestSprite initialized.');
  lines.push('');
  lines.push(`  profile:  ${s.profile}`);
  lines.push(`  endpoint: ${s.apiUrl}`);
  lines.push(`  env:      ${s.env}`);
  if (s.email) lines.push(`  email:    ${s.email}`);
  if (s.scopes.length > 0) lines.push(`  scopes:   ${s.scopes.join(', ')}`);
  lines.push('');
  if (s.agent) {
    const targets = s.agent.targets.length > 0 ? s.agent.targets : [s.agent.target];
    lines.push(`  agent:    ${targets.join(', ')} (${s.agent.action})`);
    if (s.agent.skills && s.agent.skills.length > 0) {
      lines.push(`  skills:   ${s.agent.skills.join(', ')}`);
    }
  } else {
    lines.push(
      s.agentSkippedBy === 'prompt'
        ? '  agent:    skipped (answered "none" at the prompt)'
        : '  agent:    skipped (--no-agent)',
    );
  }
  lines.push('');
  // DEV-279: an agent session already open when the skills landed won't re-read
  // them. `agent install` emits the same line on stderr; setup owns its summary,
  // so it goes here. Only when bytes actually changed — `aggregateInstallAction`
  // reports 'installed'/'updated' for that, 'dry-run'/'skipped' otherwise.
  if (s.agent && (s.agent.action === 'installed' || s.agent.action === 'updated')) {
    lines.push(
      `  [hint] Reopen (or restart) your coding agent (${s.agent.target}) so it picks up the newly installed TestSprite skill(s).`,
    );
    lines.push('');
  }
  lines.push('Next steps:');
  lines.push('  # 1. Create your first project (frontend example) — prints a projectId');
  lines.push(
    '  testsprite project create --type frontend --name "My App" --url https://your-app.com',
  );
  lines.push('');
  if (s.agent) {
    lines.push(
      '  # 2. Generate tests: ask your coding agent (the testsprite-onboard skill is installed),',
    );
    lines.push('  #    or create one yourself, then run them (use the projectId from step 1):');
    lines.push('  testsprite test run --all --project <projectId>');
    lines.push('');
    lines.push('  # Manage installed agent skills');
    lines.push('  testsprite agent list');
    lines.push(
      '  testsprite agent install --target=<t>   # re-install or install additional targets',
    );
  } else {
    lines.push('  # 2. Create a test, then run it (use the projectId from step 1):');
    lines.push('  testsprite test create --project <projectId> ...');
    lines.push('  testsprite test run --all --project <projectId>');
    lines.push(
      '  # Tip: `testsprite agent install` sets up the onboarding skill for your coding agent',
    );
    lines.push('');
    lines.push('  # Manage installed agent skills');
    lines.push('  testsprite agent list');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Command factory
// ---------------------------------------------------------------------------

function resolveCommonOptions(command: Command): CommonOptions {
  const globals = command.optsWithGlobals() as Partial<CommonOptions> & {
    requestTimeout?: string;
  };
  return {
    profile: globals.profile ?? 'default',
    output: resolveOutputMode(globals.output),
    endpointUrl: globals.endpointUrl,
    debug: globals.debug ?? false,
    verbose: globals.verbose ?? false,
    dryRun: globals.dryRun ?? false,
    requestTimeoutMs: parseRequestTimeoutFlag(globals.requestTimeout),
  };
}

const SETUP_DESCRIPTION =
  'Set up TestSprite: configure your API key and install the TestSprite agent skills for your coding agent';

/** Raw Commander options shared by `setup` and the deprecated `init`/`auth configure` aliases. */
export interface SetupCmdOpts {
  apiKey?: string;
  fromEnv?: boolean;
  /**
   * Commander sets `agent: false` (boolean) when `--no-agent` is given,
   * because `--no-agent` negates the `--agent <target>` option. Handle both
   * string and false shapes.
   */
  agent: string | false;
  noAgent?: boolean;
  force?: boolean;
  dir?: string;
  yes?: boolean;
  skipIfConfigured?: boolean;
}

/**
 * Attach the onboarding flags shared by `setup` and the `init`/`auth configure`
 * aliases. `--agent` deliberately carries NO default: its absence is the signal
 * that setup should detect the agent, and a default value here is
 * indistinguishable from the caller naming that same target.
 */
export function addSetupOptions(
  cmd: Command,
  validTargets: AgentTarget[],
  defaultAgent: AgentTarget,
): Command {
  return cmd
    .option('--api-key <key>', 'API key to configure (skips the interactive prompt)')
    .option(
      '--from-env',
      'Read TESTSPRITE_API_KEY from the environment instead of prompting',
      false,
    )
    .option(
      '--agent <target>',
      `Coding-agent target to install: ${validTargets.join(', ')} ` +
        `(default: every agent detected in this project, or ${defaultAgent} if none)`,
    )
    .option('--no-agent', 'Skip the agent skill install (configure credentials only)')
    .option('--force', 'Overwrite an existing skill file (a .bak backup is kept)')
    .option('--dir <path>', 'Project root for the skill install (default: current directory)')
    .option('-y, --yes', 'Non-interactive: accept all defaults, never prompt')
    .option(
      '--skip-if-configured',
      'Skip the API key prompt when credentials already exist for this profile (CI-safe idempotent re-run)',
    );
}

/** Build {@link InitOptions} from raw Commander opts + globals. */
function buildSetupOptions(cmdOpts: SetupCmdOpts, command: Command): InitOptions {
  const common = resolveCommonOptions(command);

  // Commander sets `agent: false` (boolean) when `--no-agent` is passed,
  // because `--no-agent` is the negation of `--agent <target>`.
  const isNoAgent = cmdOpts.noAgent === true || cmdOpts.agent === false;

  // Detect conflict when both --no-agent and --agent <target> appear in the raw
  // args. Commander only populates `rawArgs` on the ROOT command passed to
  // parseAsync; subcommands have an empty array. Walk up to the root so we
  // always inspect the full argv.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let root: any = command;
  while (root.parent) root = root.parent;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawArgs: string[] = (root as any).rawArgs ?? process.argv;
  const rawArgConflict =
    rawArgs.some((a: string) => a === '--no-agent') &&
    rawArgs.some((a: string) => a === '--agent' || a.startsWith('--agent='));

  // Only a real `--agent <target>` reaches runInit. Left undefined otherwise, so
  // setup detects instead of installing for a target nobody asked for.
  const chosenAgent =
    typeof cmdOpts.agent === 'string' && cmdOpts.agent ? (cmdOpts.agent as AgentTarget) : undefined;

  return {
    ...common,
    apiKey: cmdOpts.apiKey,
    fromEnv: Boolean(cmdOpts.fromEnv),
    agent: chosenAgent,
    noAgent: isNoAgent,
    force: Boolean(cmdOpts.force),
    dir: cmdOpts.dir,
    yes: Boolean(cmdOpts.yes),
    skipIfConfigured: Boolean(cmdOpts.skipIfConfigured),
    rawArgConflict,
  };
}

/** Shared action for `setup` and the deprecated `init` alias. */
async function runSetupAction(
  cmdOpts: SetupCmdOpts,
  command: Command,
  deps: InitDeps,
): Promise<void> {
  const opts = buildSetupOptions(cmdOpts, command);

  // When --yes is supplied without a key source, force isTTY=false so runInit
  // emits exit 5 with a clear message rather than hanging on a prompt in a
  // headless CI environment where a TTY fd happens to be open.
  const effectiveDeps: InitDeps = {
    ...deps,
    ...(opts.yes && !opts.apiKey && !opts.fromEnv ? { isTTY: false } : {}),
  };

  await runInit(opts, effectiveDeps);
}

export function createSetupCommand(deps: InitDeps = {}): Command {
  const validTargets = Object.keys(TARGETS) as AgentTarget[];
  const defaultAgent: AgentTarget = 'claude';

  return addSetupOptions(new Command('setup'), validTargets, defaultAgent)
    .description(SETUP_DESCRIPTION)
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts: SetupCmdOpts, command: Command) => {
      await runSetupAction(cmdOpts, command, deps);
    });
}

/**
 * Hidden, deprecated `init` alias → runs `setup`. Kept so existing scripts and
 * agents trained on the old command keep working; registered with
 * `{ hidden: true }` in index.ts (invisible to `--help`) and prints a
 * deprecation notice. (Setup consolidation.)
 */
export function createDeprecatedInitCommand(deps: InitDeps = {}): Command {
  const validTargets = Object.keys(TARGETS) as AgentTarget[];
  const defaultAgent: AgentTarget = 'claude';

  return addSetupOptions(new Command('init'), validTargets, defaultAgent)
    .description('(deprecated) alias for `setup`')
    .action(async (cmdOpts: SetupCmdOpts, command: Command) => {
      emitDeprecationNotice('init', 'setup', deps.stderr);
      await runSetupAction(cmdOpts, command, deps);
    });
}

/**
 * Entry for the hidden, deprecated `auth configure` alias. Per the setup
 * consolidation, `auth configure` now runs FULL setup (configure + install)
 * so an agent that reaches for the old command still ends up with the skill.
 * `setup` is the ONLY path that writes credentials.
 *
 * Accepts the SAME `SetupCmdOpts` shape `setup` does — the alias previously
 * only wired up `--from-env`, so README's "runs the full setup" claim didn't
 * hold: `--yes`/`--agent`/`--api-key`/`--force`/`--dir`/`--no-agent` were all
 * rejected as unknown options. `index.ts` attaches the full flag set via
 * `addSetupOptions` before wiring this action.
 */
export async function runConfigureViaSetup(
  command: Command,
  deps: InitDeps,
  cmdOpts: SetupCmdOpts,
): Promise<void> {
  await runSetupAction(cmdOpts, command, deps);
}
