/**
 * `testsprite init` — one-shot onboarding orchestrator.
 *
 * Chains, in order:
 *   1. runConfigure  — writes the API-key profile (validates via GET /me first)
 *   2. runWhoami     — fetches identity for the post-configure banner
 *   3. runInstall    — installs the TestSprite verification-loop skill (unless --no-agent)
 *   4. Summary print — JSON object or human text block
 *
 * Hard constraint: orchestrate existing exported primitives; never fork them.
 */

import { Command } from 'commander';
import type { CommonOptions as FactoryCommonOptions } from '../lib/client-factory.js';
import { emitDeprecationNotice } from '../lib/deprecate.js';
import { CLIError } from '../lib/errors.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode } from '../lib/output.js';
import type { AuthDeps, MeResponse } from './auth.js';
import { runConfigure, runWhoami } from './auth.js';
import type { AgentDeps, AgentFs, InstallResult } from './agent.js';
import { runInstall } from './agent.js';
import { TARGETS, DEFAULT_SKILLS, type AgentTarget } from '../lib/agent-targets.js';
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
  const envApiUrl = env.TESTSPRITE_API_URL?.trim() || undefined;
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
}

interface InitOptions extends CommonOptions {
  apiKey?: string;
  fromEnv: boolean;
  agent: string;
  noAgent: boolean;
  force: boolean;
  dir?: string;
  yes: boolean;
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
   */
  agent: { target: string; action: string; skills?: string[] } | null;
  status: 'initialized';
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

// ---------------------------------------------------------------------------
// runInit
// ---------------------------------------------------------------------------

export async function runInit(opts: InitOptions, deps: InitDeps = {}): Promise<void> {
  const stderrFn = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const out = new Output(opts.output, { stdout: deps.stdout, stderr: deps.stderr });

  // -------------------------------------------------------------------------
  // Fix 5: emit conflict warning when both --agent and --no-agent were given
  // -------------------------------------------------------------------------
  if (opts.rawArgConflict) {
    const effectiveLabel = opts.noAgent ? '--no-agent' : `--agent ${opts.agent}`;
    stderrFn(
      `[warn] both --no-agent and --agent supplied; using ${effectiveLabel} (last flag wins)`,
    );
  }

  // -------------------------------------------------------------------------
  // Non-interactive guard: no TTY + no key source → exit 5 immediately
  // -------------------------------------------------------------------------
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const hasKeySource = Boolean(opts.apiKey) || opts.fromEnv;
  // Non-interactive guard: no TTY + no key source → exit 5. Skipped under
  // --dry-run, which is documented to work without credentials or network.
  if (!isTTY && !hasKeySource && !opts.dryRun) {
    throw new CLIError(
      'No API key available in non-interactive mode. ' +
        'Pass --api-key <key>, --from-env (reads TESTSPRITE_API_KEY), or run interactively.',
      5,
    );
  }
  // JSON-output guard: an interactive secret prompt writes to stdout and would
  // corrupt init's single-JSON-object output contract. In --output json mode
  // require a non-interactive key source. Skipped under --dry-run (never prompts).
  if (opts.output === 'json' && !hasKeySource && !opts.dryRun) {
    throw new CLIError(
      'Interactive API-key prompt is unavailable in --output json mode (it would corrupt JSON stdout). ' +
        'Pass --api-key <key> or --from-env.',
      5,
    );
  }

  // -------------------------------------------------------------------------
  // Dry-run: zero network + zero FS writes; print preview only
  // -------------------------------------------------------------------------
  if (opts.dryRun) {
    stderrFn('[dry-run] no writes or network calls — preview only');
    stderrFn(
      `[dry-run] would configure profile="${opts.profile}" (key source: ${
        opts.apiKey ? 'flag' : opts.fromEnv ? 'env' : 'prompt'
      })`,
    );

    const agentTarget = opts.noAgent ? null : opts.agent;

    if (!opts.noAgent) {
      // Delegate to runInstall's own dry-run for the file-listing preview.
      // runInstall prints the would-write lines itself under dryRun.
      await runInstall(
        {
          ...opts,
          target: [agentTarget!],
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
      agent: agentTarget
        ? { target: agentTarget, action: 'dry-run', skills: [...DEFAULT_SKILLS] }
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
    { ...opts, fromEnv: opts.apiKey ? false : opts.fromEnv },
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
  } catch {
    // Whoami is display-only. If it fails after a successful configure,
    // continue with a minimal placeholder so the summary still prints.
    me = { userId: '', keyId: '', scopes: [], env: 'production' };
  }

  // -------------------------------------------------------------------------
  // Step 3: Agent skill install (unless --no-agent)
  // -------------------------------------------------------------------------
  let installedTarget: string | null = null;
  let installedAction: string | null = null;
  let installedSkills: string[] = [];

  if (!opts.noAgent) {
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
          target: [opts.agent],
          // skills omitted → runInstall installs DEFAULT_SKILLS (verify + onboard)
          force: opts.force,
          dir: opts.dir,
        },
        toAgentDeps(deps, captureStdout),
      );

      installedTarget = opts.agent;
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
          `re-run 'testsprite agent install --target ${opts.agent}' after fixing the path`,
      );
      throw installErr;
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Summary
  // -------------------------------------------------------------------------
  const agentSummary: InitSummary['agent'] =
    opts.noAgent || installedTarget === null
      ? null
      : {
          target: installedTarget,
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
    lines.push(`  agent:    ${s.agent.target} (${s.agent.action})`);
    if (s.agent.skills && s.agent.skills.length > 0) {
      lines.push(`  skills:   ${s.agent.skills.join(', ')}`);
    }
  } else {
    lines.push('  agent:    skipped (--no-agent)');
  }
  lines.push('');
  lines.push('Next steps:');
  lines.push('  testsprite test list            # list tests in the current project');
  lines.push('  testsprite agent list           # check installed agent targets');
  if (s.agent) {
    lines.push(
      '  testsprite agent install --target=<t>  # re-install or install additional targets',
    );
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

function parseRequestTimeoutFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 1000);
}

const SETUP_DESCRIPTION =
  'Set up TestSprite: configure your API key and install the TestSprite agent skills for your coding agent';

/** Raw Commander options shared by `setup` and the deprecated `init` alias. */
interface SetupCmdOpts {
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
}

/** Attach the onboarding flags shared by `setup` and the `init` alias. */
function addSetupOptions(
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
      `Coding-agent target to install: ${validTargets.join(', ')} (default: ${defaultAgent})`,
      defaultAgent,
    )
    .option('--no-agent', 'Skip the agent skill install (configure credentials only)')
    .option('--force', 'Overwrite an existing skill file (a .bak backup is kept)')
    .option('--dir <path>', 'Project root for the skill install (default: current directory)')
    .option('-y, --yes', 'Non-interactive: accept all defaults, never prompt');
}

/** Build {@link InitOptions} from raw Commander opts + globals. */
function buildSetupOptions(
  cmdOpts: SetupCmdOpts,
  command: Command,
  defaultAgent: AgentTarget,
): InitOptions {
  const common = resolveCommonOptions(command);

  // Commander sets `agent: false` (boolean) when `--no-agent` is passed,
  // because `--no-agent` is the negation of `--agent <target>`. Guard against
  // this: if agent is falsy (false or empty string) default to the CLI default
  // so runInstall never receives a non-string target.
  const resolvedAgent =
    cmdOpts.agent && typeof cmdOpts.agent === 'string' ? cmdOpts.agent : defaultAgent;
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

  return {
    ...common,
    apiKey: cmdOpts.apiKey,
    fromEnv: Boolean(cmdOpts.fromEnv),
    agent: resolvedAgent,
    noAgent: isNoAgent,
    force: Boolean(cmdOpts.force),
    dir: cmdOpts.dir,
    yes: Boolean(cmdOpts.yes),
    rawArgConflict,
  };
}

/** Shared action for `setup` and the deprecated `init` alias. */
async function runSetupAction(
  cmdOpts: SetupCmdOpts,
  command: Command,
  deps: InitDeps,
  defaultAgent: AgentTarget,
): Promise<void> {
  const opts = buildSetupOptions(cmdOpts, command, defaultAgent);

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
      await runSetupAction(cmdOpts, command, deps, defaultAgent);
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
      await runSetupAction(cmdOpts, command, deps, defaultAgent);
    });
}

/**
 * Entry for the hidden, deprecated `auth configure` alias. Per the setup
 * consolidation, `auth configure` now runs FULL setup (configure + install)
 * so an agent that reaches for the old command still ends up with the skill.
 * `setup` is the ONLY path that writes credentials.
 */
export async function runConfigureViaSetup(
  command: Command,
  deps: InitDeps,
  fromEnv: boolean,
): Promise<void> {
  await runSetupAction({ agent: 'claude', fromEnv }, command, deps, 'claude');
}
