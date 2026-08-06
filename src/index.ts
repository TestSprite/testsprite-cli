#!/usr/bin/env node

import { Command, CommanderError } from 'commander';
import { createAgentCommand } from './commands/agent.js';
import { createAuthCommand } from './commands/auth.js';
import { createCompletionCommand, type CompletionSpec } from './commands/completion.js';
import { createDoctorCommand } from './commands/doctor.js';
import {
  addSetupOptions,
  createDeprecatedInitCommand,
  createSetupCommand,
  runConfigureViaSetup,
  type SetupCmdOpts,
} from './commands/init.js';
import { createProjectCommand } from './commands/project.js';
import { createTestCommand } from './commands/test.js';
import { createUsageCommand } from './commands/usage.js';
import { TARGETS, type AgentTarget } from './lib/agent-targets.js';
import { ApiError, CLIError, InterruptError, RequestTimeoutError } from './lib/errors.js';
import { installBrokenPipeGuard, installSignalHandlers } from './lib/interrupt.js';
import { Output, isOutputMode } from './lib/output.js';
import { maybeInstallProxyAgent } from './lib/proxy.js';
import {
  renderAmbiguousOrgCandidates,
  renderCommanderError,
  rephraseUnknownOption,
} from './lib/render-error.js';
import { isPlanTemplateInvocation, maybeEmitSkillNudge } from './lib/skill-nudge.js';
import {
  classifyCliError,
  isTelemetryOptedOut,
  recordOutcome,
  resolveTelemetryAuth,
  type ResolvedTelemetryAuth,
} from './lib/telemetry.js';
import { maybeNotifyUpdate } from './lib/update-check.js';
import { VERSION } from './version.js';
import { shouldRejectNodeVersion } from './version-guard.js';

// Guard: exit early with a clear message on unsupported Node.js versions,
// rather than failing later with a cryptic ESM/runtime error.
if (shouldRejectNodeVersion(process.versions.node)) {
  process.stderr.write(
    `Error: testsprite requires Node.js >= 20 (found ${process.versions.node}).\nInstall the latest LTS from https://nodejs.org\n`,
  );
  process.exit(1);
}

const program = new Command();

// exitOverride() causes Commander to throw CommanderError instead of calling
// process.exit() directly, giving our catch block a chance to remap error
// exit codes (e.g. missing-argument → exit 5 per taxonomy).
program.exitOverride();

program
  .name('testsprite')
  .description('Official TestSprite command-line interface')
  .version(VERSION)
  .option('--output <mode>', 'Output format (json|text)', 'text')
  .option('--profile <name>', 'Configuration profile to use')
  .option('--endpoint-url <url>', 'Override the API endpoint host')
  .option(
    '--verbose',
    'Emit human-readable HTTP retry / backoff / polling-mode transitions to stderr. Less noisy than --debug; useful for diagnosing hangs without the full trace.',
  )
  .option('--debug', 'Print HTTP method/path, request id, latency, retry decisions to stderr')
  .option(
    '--dry-run',
    'Skip the network and credentials; emit a canned sample matching the OpenAPI contract. Useful for learning the CLI surface without an API key. Note: file inputs you pass (--plan-from/--plans/--steps) are still read and validated locally; only --code-file uses a placeholder.',
  )
  .option(
    '--request-timeout <seconds>',
    'Client-side per-request timeout in seconds (default: 120). Aborts any single fetch that does not complete within this deadline. ' +
      'Override via TESTSPRITE_REQUEST_TIMEOUT_MS env var (milliseconds). ' +
      'Range: 1–600. Does not affect the --timeout polling ceiling for `test run/wait`.',
  );

// `setup` is the primary onboarding command, listed FIRST in --help so a coding
// agent reaches it before anything else. `init` is kept as a hidden, deprecated
// alias (invisible to --help; still works for existing scripts/agents).
program.addCommand(createSetupCommand({}));
program.addCommand(createDeprecatedInitCommand({}), { hidden: true });

// `auth configure` is a hidden, deprecated alias that runs FULL `setup`
// (configure + skill install), so an agent reaching for the old command still
// ends up with the skill. `setup` remains the ONLY path that writes credentials.
// Attach the SAME flag set `setup` has (previously only
// `--from-env` was wired up, so README's "runs the full setup" claim didn't
// hold — `--yes`/`--agent`/`--api-key`/`--force`/`--dir`/`--no-agent` were all
// rejected as `unknown option`).
const authCommand = createAuthCommand();
const authConfigureValidTargets = Object.keys(TARGETS) as AgentTarget[];
addSetupOptions(
  authCommand.command('configure', { hidden: true }),
  authConfigureValidTargets,
  'claude',
).action(async (cmdOpts: SetupCmdOpts, command: Command) => {
  process.stderr.write(
    '[deprecated] `testsprite auth configure` now runs full setup (configure + skill install) — ' +
      'use `testsprite setup` (add --no-agent to skip the skill).\n',
  );
  await runConfigureViaSetup(command, {}, cmdOpts);
});
program.addCommand(authCommand);

program.addCommand(createProjectCommand({}));
program.addCommand(createTestCommand());
program.addCommand(createAgentCommand({}));
program.addCommand(createUsageCommand());
program.addCommand(createDoctorCommand());
program.addCommand(createCompletionCommand(() => buildCompletionSpec()));

// Derive the shell-completion spec from the fully-assembled command tree at call
// time (not module-load), so `testsprite completion` can never drift from the
// real commands, subcommands, and global flags.
function buildCompletionSpec(): CompletionSpec {
  const subcommands: Record<string, string[]> = {};
  for (const command of program.commands) {
    const subs = command.commands.map(sub => sub.name()).filter(name => name !== 'help');
    if (subs.length > 0) subcommands[command.name()] = subs;
  }
  const flags = program.options
    .map(option => option.long)
    .filter((long): long is string => typeof long === 'string');
  if (!flags.includes('--help')) flags.push('--help');
  return {
    program: 'testsprite',
    commands: [...new Set([...program.commands.map(command => command.name()), 'help'])],
    subcommands,
    globalFlags: flags,
  };
}

// Buffer Commander error messages instead of writing immediately. The catch
// block re-emits in the correct format (JSON or text) once the requested
// output mode is known. Safe because applyExitOverrideDeep ensures every
// command throws CommanderError rather than calling process.exit directly.
let pendingCommanderErrorMsg: string | null = null;

// Leaf command path that actually reached an action (set by the preAction hook
// below). Empty when no action ran (bare `--help`, parse error) — telemetry
// skips those. Read by the success + error telemetry emits around parseAsync.
let ranCommandPath = '';

// Whether the command that ran should emit telemetry. `completion` (its stdout
// is eval'd by shells) and `--plan-template` (pure-local) are kept off the
// beacon, same as the update notice. Set by the preAction hook.
let telemetryEmit = false;

// Auth resolved in the preAction hook, before the command's action runs, so
// `auth remove` (which deletes the profile) is still reported on the key it used.
let telemetryAuth: ResolvedTelemetryAuth | undefined;

// Propagate exitOverride AND the buffered outputError config to every
// subcommand in the tree. Commander's addCommand() does NOT inherit either
// from the parent, so commands built externally (createTestCommand, etc.) and
// attached via addCommand() still have _exitCallback = null and a default
// outputError that writes immediately. Both must be applied after the full
// command tree is assembled so every leaf subcommand behaves consistently.
function applyExitOverrideDeep(cmd: Command): void {
  cmd.exitOverride();
  cmd.configureOutput({
    outputError(str, _write) {
      const rephrased = rephraseUnknownOption(str);
      pendingCommanderErrorMsg = rephrased !== null ? `${rephrased}\n` : str;
    },
  });
  for (const child of cmd.commands) {
    applyExitOverrideDeep(child);
  }
}
applyExitOverrideDeep(program);

/**
 * Render a leaf command's full path (group + leaf), e.g. `test run` /
 * `auth whoami`, by walking parents up to (but not including) the root program.
 */
function commandPathOf(cmd: Command): string {
  const names: string[] = [];
  let cur: Command | null = cmd;
  while (cur && cur.parent) {
    names.unshift(cur.name());
    cur = cur.parent;
  }
  return names.join(' ');
}

/** Global flags the telemetry emit needs (config resolution + context). */
function telemetryGlobals(): {
  profile?: string;
  endpointUrl?: string;
  output?: string;
  dryRun?: boolean;
} {
  const g = program.opts<{
    profile?: string;
    endpointUrl?: string;
    output?: string;
    dryRun?: boolean;
  }>();
  return { profile: g.profile, endpointUrl: g.endpointUrl, output: g.output, dryRun: g.dryRun };
}

// Best-effort onboarding nudge (see lib/skill-nudge.ts): when a configured
// caller drives a verify-loop command in a project with no installed skill,
// point it at `testsprite setup`. A preAction hook runs before every leaf
// action; the helper self-gates (text-only, non-dry-run, a small command
// allowlist, opt-out via TESTSPRITE_NO_SKILL_WARNING) and never throws.
program.hook('preAction', (_thisCommand, actionCommand) => {
  const globals = actionCommand.optsWithGlobals() as {
    output?: string;
    profile?: string;
    endpointUrl?: string;
    dryRun?: boolean;
    planTemplate?: boolean;
  };
  const commandPath = commandPathOf(actionCommand);
  // Record which leaf command ran, for the telemetry emit around parseAsync.
  ranCommandPath = commandPath;
  // See `isPlanTemplateInvocation` for why this one case is
  // filtered here rather than in skill-nudge.ts / update-check.ts.
  const isPlanTemplate = isPlanTemplateInvocation(commandPath, globals.planTemplate);

  // Telemetry gate, same reasons as the update notice below: skip `completion`
  // (its stdout is eval'd by shells) and `--plan-template` (pure-local). Resolve
  // auth now, before the command's action runs, so `auth remove` still reports
  // on the key it used; skip the read for opt-out / dry-run.
  telemetryEmit = commandPath !== 'completion' && !isPlanTemplate;
  if (telemetryEmit && !isTelemetryOptedOut(process.env) && globals.dryRun !== true) {
    telemetryAuth = resolveTelemetryAuth({
      profile: globals.profile,
      endpointUrl: globals.endpointUrl,
    });
  }
  if (!isPlanTemplate) {
    maybeEmitSkillNudge({
      commandPath,
      output: isOutputMode(globals.output) ? globals.output : 'text',
      dryRun: globals.dryRun ?? false,
      profile: globals.profile ?? 'default',
      cwd: process.cwd(),
      env: process.env,
    });
  }

  // Best-effort update notice (see lib/update-check.ts): self-gates on the
  // opt-out env, CI, TTY, and a 24h cache; the wiring adds the flag-level
  // gates the lib cannot see. Skipped for `completion` (its stdout is eval'd
  // by shells), under --output json, under --dry-run, and for
  // `--plan-template` (pure-local — this check hits the npm registry over
  // the network and writes ~/.testsprite/update-check.json, both of which
  // contradict "no network" for this flag). Deliberately not awaited: an
  // advisory must never delay the real command.
  if (
    globals.output !== 'json' &&
    globals.dryRun !== true &&
    commandPath !== 'completion' &&
    !isPlanTemplate
  ) {
    void maybeNotifyUpdate();
  }
});

// Clean process lifecycle (DEV-331 piece 1, errors.md §8.1): during a `--wait`
// poll the scope is armed — the first SIGINT/SIGTERM/SIGHUP aborts gracefully
// and the wait path prints an honest partial (the run KEEPS executing and
// billing server-side) + re-attach hint before exiting 128+signum; a second
// signal hard-exits. Outside an armed scope: a clear one-line message +
// immediate exit (instead of Node's silent abrupt kill). Plus an EPIPE guard
// so piping to a reader that closes early (`| head`) exits cleanly instead of
// dumping a raw `write EPIPE` stack.
installSignalHandlers();
installBrokenPipeGuard();

// Corporate/CI proxies: honor HTTPS_PROXY/HTTP_PROXY/NO_PROXY (Node's fetch
// ignores them by default). No-op when no proxy variable is set.
maybeInstallProxyAgent();

const telemetryStartedAt = Date.now();
try {
  await program.parseAsync(process.argv);
  // Flush a success outcome event before the process exits 0. Bounded +
  // best-effort (see lib/telemetry.ts); skips when no command ran / no key
  // configured / opted out / --dry-run.
  if (telemetryEmit) {
    await recordOutcome(
      {
        command: ranCommandPath,
        outcome: 'success',
        exitCode: 0,
        durationMs: Date.now() - telemetryStartedAt,
        ...telemetryGlobals(),
      },
      { resolvedAuth: telemetryAuth },
    );
  }
} catch (err) {
  const telemetryOutcome = classifyCliError(err);
  // Flush the outcome AFTER the error is rendered to stderr below (via each
  // branch's `flushThenExit`), so a slow backend never delays the user's error.
  // The classification mirrors the exit-code mapping the branches apply.
  const flushThenExit = async (code: number): Promise<never> => {
    if (telemetryEmit) {
      await recordOutcome(
        {
          command: ranCommandPath,
          outcome: telemetryOutcome.outcome,
          exitCode: telemetryOutcome.exitCode,
          errorCode: telemetryOutcome.errorCode,
          durationMs: Date.now() - telemetryStartedAt,
          ...telemetryGlobals(),
        },
        { resolvedAuth: telemetryAuth },
      );
    }
    process.exit(code);
  };

  const rawMode = program.opts<{ output?: string }>().output;
  const mode = isOutputMode(rawMode) ? rawMode : 'text';
  if (err instanceof ApiError) {
    if (mode === 'json') {
      const envelope = {
        error: {
          code: err.code,
          message: err.message,
          nextAction: err.nextAction,
          requestId: err.requestId,
          details: err.details,
        },
      };
      process.stderr.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${err.message}\n`);
      if (err.nextAction) process.stderr.write(`${err.nextAction}\n`);
      if (err.requestId && err.requestId !== 'local')
        process.stderr.write(`requestId: ${err.requestId}\n`);
      // C1: surface requiredScopes / grantedScopes on AUTH_FORBIDDEN
      if (err.code === 'AUTH_FORBIDDEN') {
        const required = err.getDetail('requiredScopes');
        const granted = err.getDetail('grantedScopes');
        if (Array.isArray(required) && required.length > 0) {
          process.stderr.write(`  required: ${(required as string[]).join(', ')}\n`);
        }
        if (Array.isArray(granted)) {
          process.stderr.write(`  granted:  ${(granted as string[]).join(', ')}\n`);
        }
      }
      // Surface the version gap on CLIENT_TOO_OLD so the user sees exactly what
      // moved without parsing the message string. (No "latest" line — the npm
      // update-notice is the single source of truth for the newest release.)
      if (err.code === 'CLIENT_TOO_OLD') {
        const your = err.getDetail('yourVersion');
        const min = err.getDetail('minVersion');
        if (typeof your === 'string' && typeof min === 'string') {
          process.stderr.write(`  your version: ${your}, minimum supported: ${min}\n`);
        }
      }
      // AMBIGUOUS_ORG: the same testId resolved inside more than one of the
      // caller's organizations. List each colliding candidate plus a hint to
      // disambiguate, mirroring the AUTH_FORBIDDEN required/granted pattern above.
      if (err.code === 'AMBIGUOUS_ORG') {
        for (const line of renderAmbiguousOrgCandidates(err.getDetail('candidates'))) {
          process.stderr.write(`${line}\n`);
        }
      }
    }
    await flushThenExit(err.exitCode);
  }
  const output = new Output(mode);
  if (err instanceof InterruptError) {
    // Graceful detach (DEV-331 piece 1, errors.md §8.1): the wait-path catch
    // block already printed the honest partial + re-attach hint. Exit with
    // the conventional 128+signum code; `INTERRUPTED` is deliberately outside
    // the error catalog. Note: Ctrl-C does NOT cancel the server-side run.
    if (mode === 'json') {
      const envelope = {
        error: {
          code: 'INTERRUPTED',
          message: err.message,
          nextAction:
            'The server-side run (if any) keeps executing and billing. ' +
            'Re-attach with: testsprite test wait <runId>, or stop it with: testsprite test cancel <runId> ' +
            '(runId is in the partial JSON on stdout).',
          requestId: 'local',
          details: { signal: err.signal },
        },
      };
      process.stderr.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${err.message}\n`);
    }
    await flushThenExit(err.exitCode);
  }
  if (err instanceof RequestTimeoutError) {
    // Structured rendering for per-request timeouts: JSON mode emits a
    // machine-readable envelope; text mode emits the message with a hint.
    if (mode === 'json') {
      const envelope = {
        error: {
          code: 'REQUEST_TIMEOUT',
          message: err.message,
          nextAction:
            'Increase --request-timeout <seconds> or set TESTSPRITE_REQUEST_TIMEOUT_MS. ' +
            'Check that the backend is reachable and not overloaded.',
          requestId: err.requestId,
          details: { timeoutMs: err.timeoutMs },
        },
      };
      process.stderr.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${err.message}\n`);
    }
    await flushThenExit(err.exitCode);
  }
  if (err instanceof CommanderError) {
    // Map exit codes per the CLI taxonomy:
    //   help / version  → 0  (user asked for it; Commander already wrote the text)
    //   parse errors    → 5  (VALIDATION_ERROR family: missing arg, invalid
    //                         option, unknown command, etc.)
    //
    // Two distinct help codes exist in Commander 12:
    //   'commander.helpDisplayed' — thrown by `-h/--help` flag handler
    //   'commander.help'          — thrown by the built-in `help [command]`
    //                               subcommand (used by `test help`, `project
    //                               help`, `help test`, etc.)
    // Both are user-initiated "show me help" requests and must exit 0 per the
    // AWS-CLI convention. Failing to map 'commander.help' caused these paths
    // to fall through to the generic `process.exit(5)` branch (dogfood P1-4).
    if (
      err.code === 'commander.helpDisplayed' ||
      err.code === 'commander.help' ||
      err.code === 'commander.version'
    ) {
      await flushThenExit(0);
    }
    // For parse errors, write the buffered message in the correct format.
    // rawMode from program.opts() is reliable when --output was parsed before
    // the error. When the error occurs first (e.g. `testsprite badcmd --output
    // json`), rawMode is the default 'text'; scan argv as a best-effort
    // fallback so machine consumers still receive a JSON envelope.
    const commanderMode = (() => {
      if (rawMode === 'json') return 'json' as const;
      for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i]!;
        if (arg === '--output' && process.argv[i + 1] === 'json') return 'json' as const;
        if (arg === '--output=json') return 'json' as const;
      }
      return mode;
    })();
    process.stderr.write(
      renderCommanderError(pendingCommanderErrorMsg, err.message, commanderMode),
    );
    await flushThenExit(5);
  }
  if (err instanceof CLIError) {
    output.error(err.message);
    await flushThenExit(err.exitCode);
  }
  output.error(err instanceof Error ? err.message : String(err));
  await flushThenExit(1);
}
