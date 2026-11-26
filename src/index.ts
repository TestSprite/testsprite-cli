#!/usr/bin/env node

import { Command, CommanderError, Option } from 'commander';
import { createAgentCommand } from './commands/agent.js';
import { createAuthCommand } from './commands/auth.js';
import { createCiCommand } from './commands/ci.js';
import { createConversationCommands } from './commands/conversation.js';
import { createCompletionCommand, type CompletionSpec } from './commands/completion.js';
import { createDoctorCommand } from './commands/doctor.js';
import { createSetupCommand } from './commands/init.js';
import { createProjectCommand } from './commands/project.js';
import { createResultCommand } from './commands/result.js';
import { createScheduleCommand } from './commands/schedule.js';
import { createTunnelCommand } from './commands/tunnel.js';
import { createTestCommand, createRunCommand } from './commands/test.js';
import { createTestListCommand } from './commands/testlist.js';
import { createUsageCommand } from './commands/usage.js';
import { resolveProfileName } from './lib/config.js';
import { classifyBillingRefusal } from './lib/billing-refusal.js';
import { validatePositionalArgs } from './lib/args.js';
import {
  ApiError,
  CLIError,
  InterruptError,
  RequestTimeoutError,
  extractNodeErrorCode,
} from './lib/errors.js';
import {
  armInterruptExitBackstop,
  installBrokenPipeGuard,
  installSignalHandlers,
} from './lib/interrupt.js';
import { Output, isOutputMode } from './lib/output.js';
import { maybeInstallProxyAgent } from './lib/proxy.js';
import { redactDeep } from './lib/redact.js';
import { removedCommandPointer, removedOptionPointer } from './lib/removed-commands.js';
import { jsonForTerminal, terminalSafe, terminalSafeLine } from './lib/terminal-text.js';
import {
  buildInterruptEnvelope,
  renderAmbiguousOrgCandidates,
  renderTunnelBindingLimitIds,
  redactUnknownOptionValue,
  renderCommanderError,
  rephraseUnknownOption,
} from './lib/render-error.js';
import { maybeEmitSkillNudge } from './lib/skill-nudge.js';
import {
  classifyCliError,
  isTelemetryOptedOut,
  recordOutcome,
  recordTelemetryExtras,
  tryResolveTelemetryAuth,
  type ResolvedTelemetryAuth,
  type WaitTimeoutTelemetry,
} from './lib/telemetry.js';
import { maybeNotifyUpdate } from './lib/update-check.js';
import { VERSION } from './version.js';
import { rejectUnsupportedNodeVersion } from './version-guard.js';

// Guard: exit early with a clear message on unsupported Node.js versions,
// rather than failing later with a cryptic ESM/runtime error.
rejectUnsupportedNodeVersion(process.versions.node);

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
  // For TestSprite's own use (pointing the CLI at a non-production API): it
  // works, and no help page, completion script or "did you mean" names it.
  .addOption(new Option('--endpoint-url <url>', 'API base URL (a full http(s) URL)').hideHelp())
  .option(
    '--verbose',
    'Log HTTP retry / backoff / polling transitions to stderr (lighter than --debug)',
  )
  .option('--debug', 'Print HTTP method/path, request id, latency, retry decisions to stderr')
  .option(
    '--dry-run',
    'Skip the network and credentials; emit a canned sample matching the OpenAPI contract. Exception: run launches (`run --project`, `run <test-id...>`, `run --testlist`) with credentials and no explicit target may make read-only GETs to preview an automatic tunnel target; nothing is created or started.',
  )
  .option(
    '--request-timeout <seconds>',
    'Per-request timeout in seconds (default 120; range 1–600, values outside are clamped). ' +
      'Does not affect the --timeout polling ceiling for `run` or `run wait`.',
  );

// `setup` is the primary onboarding command, listed FIRST in --help so a coding
// agent reaches it before anything else.
program.addCommand(createSetupCommand({}));

// The project's agent: the same conversations, cards and memory the portal has.
for (const command of createConversationCommands()) program.addCommand(command);

program.addCommand(createAuthCommand());

program.addCommand(createProjectCommand({}));
let waitTimeoutTelemetry: Partial<WaitTimeoutTelemetry> = {};
program.addCommand(
  createRunCommand({
    onWaitTimeout: context => {
      waitTimeoutTelemetry = context;
    },
  }),
);
program.addCommand(createTestCommand());
program.addCommand(createResultCommand());
program.addCommand(createTestListCommand());
program.addCommand(
  createCiCommand({
    onWaitTimeout: context => {
      waitTimeoutTelemetry = context;
    },
  }),
);
program.addCommand(createScheduleCommand({}));
program.addCommand(createTunnelCommand({}));
program.addCommand(createAgentCommand({}));
program.addCommand(createUsageCommand());
program.addCommand(createDoctorCommand());
program.addCommand(createCompletionCommand(() => buildCompletionSpec()));

// The root accepts global flags anywhere. Its ordinary parser also collects
// child operands before the first unknown option. Feed the whole run tail to
// the hybrid parser together, so it can stop at wait/cancel before consuming
// their flags. Other groups retain Commander's existing parsing behavior.
const parseRootOptions = program.parseOptions.bind(program);
program.parseOptions = args => {
  const parsed = parseRootOptions(args);
  if (parsed.operands[0] !== 'run') return parsed;
  const tail = [...parsed.operands.slice(1), ...parsed.unknown];
  // Commander consumes a terminator encountered before any unknown option.
  // Reinsert it before reprocessing operands, so literal IDs cannot turn into
  // project/list launch flags. A required global option may itself take `--`
  // as its value; that occurrence is not an option terminator.
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      if (parsed.unknown.length === 0) {
        const literalCount = args.length - index - 1;
        tail.splice(Math.max(0, parsed.operands.length - 1 - literalCount), 0, '--');
      }
      break;
    }
    const option = program.options.find(option => option.long === arg || option.short === arg);
    if (option?.required) index++;
  }
  return { operands: ['run'], unknown: tail };
};

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
    .filter(option => !option.hidden)
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
// is eval'd by shells) is kept off the beacon, same as the update notice. Set by
// the preAction hook.
let telemetryEmit = false;

// Auth resolved in the preAction hook, before the command's action runs, so
// `auth remove` (which deletes the profile) is still reported on the key it used.
let telemetryAuth: ResolvedTelemetryAuth | undefined;

// Local project admission failures must exit without any TestSprite HTTP,
// including telemetry.
let telemetryLocalProject = false;

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
      const safe = redactUnknownOptionValue(str);
      const rephrased = rephraseUnknownOption(safe);
      pendingCommanderErrorMsg = rephrased !== null ? `${rephrased}\n` : safe;
    },
  });
  for (const child of cmd.commands) {
    applyExitOverrideDeep(child);
  }
}
applyExitOverrideDeep(program);

/** The subcommand of `group` that `name` names, by name or alias. */
function subcommandNamed(group: Command, name: string): Command | undefined {
  return group.commands.find(
    command => command.name() === name || command.aliases().includes(name),
  );
}

/**
 * Commander checks its implicit help option before reporting an unknown
 * command, at every level: `<group> <unknown> --help` prints the group's
 * help, and `help <group> <unknown>` or `<group> help <unknown>` fall back to
 * it too.
 * Walk the command names the program was given, from the root down, while
 * help is being rendered: the first name that is not a subcommand of the
 * group before it is the unknown command, and that error wins before any
 * misleading help is written. Only groups are walked; a leaf's arguments
 * are its own. `-h` / `--help` is skipped wherever it stands, so the order of
 * the words does not matter; the walk stops at any other option, so a flag's
 * value is never read as a command. Returns the unknown name and the group it
 * was looked up in; the error handler walks the same way to name where a
 * removed command went.
 */
function unknownCommandIn(args: readonly string[]): { group: Command; name: string } | undefined {
  let group: Command = program;
  // `help <name>…` at the root names the path to describe.
  let explicitHelpPath = args[0] === 'help';
  for (const name of explicitHelpPath ? args.slice(1) : args) {
    if (group.commands.length === 0) return undefined;
    // The help flag asks for help wherever it stands; the names after it still
    // have to exist (`test --help result`).
    if (name === '-h' || name === '--help') continue;
    if (name.startsWith('-')) return undefined;
    // A group's own `help` subcommand: the name after it is its subcommand.
    if (name === 'help') {
      explicitHelpPath = true;
      continue;
    }
    const next = subcommandNamed(group, name);
    if (next === undefined) {
      if (group.name() === 'run' && group.parent === program && !explicitHelpPath) return undefined;
      return { group, name };
    }
    group = next;
  }
  return undefined;
}

/**
 * The command the leading names reach, which is the one that parses the
 * options after them. The walk stops at the first option or the first word
 * that is not a subcommand (an argument), like the walk above.
 */
function commandNamedBy(args: readonly string[]): Command {
  let command: Command = program;
  for (const name of args) {
    const next = name.startsWith('-') ? undefined : subcommandNamed(command, name);
    if (next === undefined) break;
    command = next;
  }
  return command;
}

program.addHelpText(
  'after',
  '\nEnvironment:\n' +
    '  TESTSPRITE_API_KEY (overrides stored credentials), TESTSPRITE_NO_UPDATE_NOTIFIER (disables\n' +
    '  the version check); TESTSPRITE_PROFILE and TESTSPRITE_REQUEST_TIMEOUT_MS (milliseconds)\n' +
    '  mirror --profile and --request-timeout.',
);

program.addHelpText('beforeAll', () => {
  const unknownCommand = unknownCommandIn(program.args)?.name;
  if (unknownCommand) {
    program.error(`error: unknown command '${unknownCommand}'`, {
      code: 'commander.unknownCommand',
    });
  }
  return '';
});

/**
 * Render a leaf command's full path (group + leaf), e.g. `run` /
 * `auth status`, by walking parents up to (but not including) the root program.
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
  const commandPath = commandPathOf(actionCommand);
  // Record which leaf command ran, for the telemetry emit around parseAsync.
  ranCommandPath = commandPath;

  const globals = actionCommand.optsWithGlobals() as {
    output?: string;
    profile?: string;
    endpointUrl?: string;
    dryRun?: boolean;
    debug?: boolean;
    local?: string;
    localHost?: string;
  };
  // Preserve explicit --local attempts (project env create), including refusals;
  // only flag presence is recorded. Automatic tunnel paths record the same fact.
  if (globals.local !== undefined) recordTelemetryExtras({ local: true });
  telemetryLocalProject =
    commandPath === 'project create' &&
    (globals.local !== undefined || globals.localHost !== undefined);
  // Telemetry gate, same reason as the update notice below: skip `completion`
  // (its stdout is eval'd by shells). Resolve auth now, before the command's
  // action runs, so `auth remove` still reports on the key it used; skip the
  // read for opt-out / dry-run.
  telemetryEmit = commandPath !== 'completion';

  // Refuse an empty or whitespace-only positional before the action runs.
  // This sits below the telemetry gate so the refusal is still reported as a
  // VALIDATION_ERROR outcome, as it was when each command checked for itself,
  // and above the auth read so a bad profile cannot replace this error.
  validatePositionalArgs(actionCommand);

  // The auth read is best-effort: an unreadable credentials file must not end
  // the process here, before the command could run — `doctor` exists to
  // diagnose exactly that, and offline commands never need the key. On failure
  // the command runs as if telemetry were off (no event, and no fallback read
  // at exit either).
  if (telemetryEmit && !isTelemetryOptedOut(process.env) && globals.dryRun !== true) {
    telemetryAuth = tryResolveTelemetryAuth(
      { profile: globals.profile, endpointUrl: globals.endpointUrl },
      {
        onError: globals.debug
          ? error =>
              process.stderr.write(
                `[debug] telemetry skipped: ${error instanceof Error ? error.message : String(error)}\n`,
              )
          : undefined,
      },
    );
    if (telemetryAuth === undefined) telemetryEmit = false;
  }
  maybeEmitSkillNudge({
    commandPath,
    output: isOutputMode(globals.output) ? globals.output : 'text',
    dryRun: globals.dryRun ?? false,
    profile: resolveProfileName(globals.profile),
    cwd: process.cwd(),
    env: process.env,
    debug: globals.debug ?? false,
  });

  // Best-effort update notice (see lib/update-check.ts): self-gates on the
  // opt-out env, CI, TTY, and a 24h cache; the wiring adds the flag-level
  // gates the lib cannot see. Skipped for `completion` (its stdout is eval'd
  // by shells), under --output json and under --dry-run. Deliberately not
  // awaited: an advisory must never delay the real command.
  if (globals.output !== 'json' && globals.dryRun !== true && commandPath !== 'completion') {
    void maybeNotifyUpdate();
  }
});

// Clean process lifecycle (errors.md §8.1): during a `--wait`
// poll the scope is armed — the first SIGINT/SIGTERM/SIGHUP aborts gracefully
// and the wait path prints an honest partial (the run KEEPS executing and
// billing server-side) + re-attach hint before exiting 128+signum; a second
// signal hard-exits. Outside an armed scope: a clear one-line message, then
// drain an in-flight request or exit immediately when idle. Plus an EPIPE guard
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
  const localProjectAdmissionFailure =
    telemetryLocalProject &&
    err instanceof ApiError &&
    err.code === 'VALIDATION_ERROR' &&
    err.requestId === 'local';
  // Flush the outcome AFTER the error is rendered to stderr below (via each
  // branch's `flushThenSetExitCode`), so a slow backend never delays the
  // user's error. The classification mirrors the exit-code mapping the
  // branches apply.
  //
  // SET `process.exitCode` and let the event loop drain instead of
  // forcing `process.exit()`. A forced exit tears the process down while the
  // just-completed HTTPS request's TLS socket is still mid-close; on Windows
  // libuv asserts on the half-closed handle (src/win/async.c) and the process
  // dies with 0xC0000409 (-1073740791) — overwriting the mapped exit code
  // with a crash code and voiding the documented exit-code contract for every
  // script/CI/agent that branches on it. Draining takes milliseconds and is
  // exactly how the success path above already exits.
  const flushThenSetExitCode = async (code: number): Promise<void> => {
    if (telemetryEmit && !localProjectAdmissionFailure) {
      await recordOutcome(
        {
          command: ranCommandPath,
          outcome: telemetryOutcome.outcome,
          exitCode: telemetryOutcome.exitCode,
          errorCode: telemetryOutcome.errorCode,
          errorOrigin: telemetryOutcome.errorOrigin,
          timeoutSeconds: telemetryOutcome.timeoutSeconds,
          ...waitTimeoutTelemetry,
          durationMs: Date.now() - telemetryStartedAt,
          ...telemetryGlobals(),
        },
        { resolvedAuth: telemetryAuth },
      );
    }
    process.exitCode = code;
  };

  const rawMode = program.opts<{ output?: string }>().output;
  const mode = isOutputMode(rawMode) ? rawMode : 'text';
  const output = new Output(mode);
  if (err instanceof ApiError) {
    const billingRefusal = classifyBillingRefusal(err);
    const { message, nextAction, details } = err;
    if (mode === 'json') {
      const envelope = {
        error: {
          code: err.code,
          message,
          nextAction,
          requestId: err.requestId,
          // `err.details` is already redacted at ApiError construction (see
          // `errors.ts`); redacting again here is defence in depth for this
          // hand-built envelope specifically, independent of that.
          details: redactDeep(details),
          ...(billingRefusal ? { links: billingRefusal.links } : {}),
        },
      };
      process.stderr.write(`${jsonForTerminal(envelope, 2)}\n`);
    } else {
      // Server text on a terminal: escape sequences and other control
      // characters are removed, and the message and request id stay on their
      // own line, so the server cannot write a line of its own beneath them.
      // The JSON envelope above keeps what the server sent.
      process.stderr.write(`Error: ${terminalSafeLine(message)}\n`);
      if (nextAction) process.stderr.write(`${terminalSafe(nextAction)}\n`);
      if (billingRefusal) {
        for (const line of billingRefusal.lines) process.stderr.write(`${line}\n`);
      }
      if (err.requestId && err.requestId !== 'local')
        process.stderr.write(`requestId: ${terminalSafeLine(err.requestId)}\n`);
      // C1: surface requiredScopes / grantedScopes on AUTH_FORBIDDEN
      if (err.code === 'AUTH_FORBIDDEN') {
        const required = err.getDetail('requiredScopes');
        const granted = err.getDetail('grantedScopes');
        if (Array.isArray(required) && required.length > 0) {
          process.stderr.write(`  required: ${terminalSafeLine(required.join(', '))}\n`);
        }
        if (Array.isArray(granted)) {
          process.stderr.write(`  granted:  ${terminalSafeLine(granted.join(', '))}\n`);
        }
      }
      // Surface the version gap on CLIENT_TOO_OLD so the user sees exactly what
      // moved without parsing the message string. (No "latest" line — the npm
      // update-notice is the single source of truth for the newest release.)
      if (err.code === 'CLIENT_TOO_OLD') {
        const your = err.getDetail('yourVersion');
        const min = err.getDetail('minVersion');
        if (typeof your === 'string' && typeof min === 'string') {
          process.stderr.write(
            `  your version: ${terminalSafeLine(your)}, minimum supported: ${terminalSafeLine(min)}\n`,
          );
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
      if (err.code === 'RATE_LIMITED' && err.getDetail('reason') === 'tunnel_binding_limit') {
        for (const line of renderTunnelBindingLimitIds(err.getDetail('clientIds'))) {
          process.stderr.write(`${line}\n`);
        }
      }
    }
    await flushThenSetExitCode(err.exitCode);
  } else if (err instanceof InterruptError) {
    // A run wait may already have printed a partial result and re-attach hint.
    // A disarmed request has no run ID, so its JSON hint describes checking
    // current state before retrying. Both use the conventional 128+signum code.
    if (mode === 'json') {
      process.stderr.write(`${jsonForTerminal(buildInterruptEnvelope(err), 2)}\n`);
    } else {
      process.stderr.write(`Error: ${terminalSafeLine(err.message)}\n`);
    }
    await flushThenSetExitCode(err.exitCode);
    armInterruptExitBackstop(err.exitCode);
  } else if (err instanceof RequestTimeoutError) {
    // Structured rendering for per-request timeouts: JSON mode emits a
    // machine-readable envelope; text mode emits the message with a hint.
    if (mode === 'json') {
      const envelope = {
        error: {
          code: 'REQUEST_TIMEOUT',
          message: err.message,
          nextAction:
            err.nextAction ??
            'Increase --request-timeout <seconds> or set TESTSPRITE_REQUEST_TIMEOUT_MS. ' +
              'Check that the backend is reachable and not overloaded.',
          requestId: err.requestId,
          details: { timeoutMs: err.timeoutMs },
        },
      };
      process.stderr.write(`${jsonForTerminal(envelope, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${terminalSafeLine(err.message)}\n`);
    }
    await flushThenSetExitCode(err.exitCode);
  } else if (err instanceof CommanderError) {
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
    // to fall through to the generic `process.exit(5)` branch.
    if (
      err.code === 'commander.helpDisplayed' ||
      err.code === 'commander.help' ||
      err.code === 'commander.version'
    ) {
      await flushThenSetExitCode(0);
    } else {
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
      // A removed command also says where it went, by the
      // same walk that found the unknown name (Commander's own error and the
      // one raised before a group's help both arrive here). A removed option
      // does too, from the command the arguments name and the message it wrote.
      const unknown =
        err.code === 'commander.unknownCommand' ? unknownCommandIn(program.args) : undefined;
      const removedPointer =
        unknown !== undefined
          ? removedCommandPointer(commandPathOf(unknown.group), unknown.name)
          : err.code === 'commander.unknownOption'
            ? removedOptionPointer(commandPathOf(commandNamedBy(program.args)), err.message)
            : undefined;
      process.stderr.write(
        renderCommanderError(pendingCommanderErrorMsg, err.message, commanderMode, removedPointer),
      );
      await flushThenSetExitCode(5);
    }
  } else if (err instanceof CLIError) {
    // Same 5-key envelope shape as the ApiError/InterruptError/
    // RequestTimeoutError branches above — `err.code` defaults to the
    // out-of-catalog 'CLI_ERROR' bucket for a plain CLIError (see errors.ts).
    output.error({ code: err.code, message: err.message });
    await flushThenSetExitCode(err.exitCode);
  } else {
    // Genuinely uncaught, non-CLIError exception. Prefer a real Node error
    // code (ENOENT, ECONNREFUSED, …) when one is present; otherwise fall
    // back to the same 'UNCAUGHT_EXCEPTION' bucket classifyCliError() uses,
    // so the JSON envelope's code and the telemetry errorCode always agree.
    const message = err instanceof Error ? err.message : String(err);
    output.error({ code: extractNodeErrorCode(err) ?? 'UNCAUGHT_EXCEPTION', message });
    await flushThenSetExitCode(1);
  }
}
