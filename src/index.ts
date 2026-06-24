#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { createAgentCommand } from './commands/agent.js';
import { createAuthCommand } from './commands/auth.js';
import {
  createDeprecatedInitCommand,
  createSetupCommand,
  runConfigureViaSetup,
} from './commands/init.js';
import { createProjectCommand } from './commands/project.js';
import { createTestCommand } from './commands/test.js';
import { createUsageCommand } from './commands/usage.js';
import { ApiError, CLIError, RequestTimeoutError } from './lib/errors.js';
import { Output, isOutputMode, type OutputMode } from './lib/output.js';
import { rephraseUnknownOption } from './lib/render-error.js';
import { maybeEmitSkillNudge } from './lib/skill-nudge.js';
import { VERSION } from './version.js';

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
    'Skip the network, credentials, and filesystem; emit a canned sample matching the OpenAPI contract. Useful for learning the CLI surface without an API key.',
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
const authCommand = createAuthCommand();
authCommand
  .command('configure', { hidden: true })
  .option(
    '--from-env',
    'Read TESTSPRITE_API_KEY (and optionally TESTSPRITE_API_URL) from the environment instead of prompting',
    false,
  )
  .action(async (cmdOpts: { fromEnv?: boolean }, command: Command) => {
    process.stderr.write(
      '[deprecated] `testsprite auth configure` now runs full setup (configure + skill install) — ' +
        'use `testsprite setup` (add --no-agent to skip the skill).\n',
    );
    await runConfigureViaSetup(command, {}, Boolean(cmdOpts.fromEnv));
  });
program.addCommand(authCommand);

program.addCommand(createProjectCommand({}));
program.addCommand(createTestCommand());
program.addCommand(createAgentCommand({}));
program.addCommand(createUsageCommand());

// Propagate exitOverride to every subcommand in the tree.
// Commander's addCommand() does NOT inherit exitOverride from the parent,
// so commands built externally (createTestCommand, createProjectCommand, …)
// and attached via addCommand() still have _exitCallback = null and call
// process.exit directly. Recursively set exitOverride so CommanderError
// bubbles up to our catch block for every leaf subcommand.
function applyExitOverrideDeep(cmd: Command): void {
  cmd.exitOverride();
  for (const child of cmd.commands) {
    applyExitOverrideDeep(child);
  }
}
applyExitOverrideDeep(program);

/**
 * Resolve the requested `--output` mode directly from argv.
 *
 * We cannot rely on `program.opts()` for this: a parse error can be thrown
 * before Commander binds the global `--output` option (e.g. an unknown command,
 * or `--output` placed after the failing token), yet the error renderer below
 * runs at exactly that point. Scanning argv is order-independent and always
 * reflects what the caller asked for.
 */
function outputModeFromArgv(argv: readonly string[]): OutputMode {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break; // end-of-options marker
    if (a === '--output') return isOutputMode(argv[i + 1]) ? (argv[i + 1] as OutputMode) : 'text';
    if (a?.startsWith('--output=')) {
      const v = a.slice('--output='.length);
      return isOutputMode(v) ? v : 'text';
    }
  }
  return 'text';
}
const requestedMode = outputModeFromArgv(process.argv.slice(2));

// Commander writes parse errors (unknown option/command, missing argument,
// excess arguments) via `outputError` BEFORE throwing the CommanderError our
// catch block sees. In `--output json` mode we suppress that plain-text write
// and let the catch emit a JSON envelope instead, so EVERY error path honors
// the JSON contract a machine consumer relies on. Text mode keeps the friendly
// rephrasing. Applied to every command in the tree because subcommands do not
// inherit the root's output configuration.
function configureErrorOutput(cmd: Command): void {
  cmd.configureOutput({
    outputError(str, write) {
      if (requestedMode === 'json') return; // the catch block emits a JSON envelope
      const rephrased = rephraseUnknownOption(str);
      write(rephrased !== null ? `${rephrased}\n` : str);
    },
  });
  for (const child of cmd.commands) {
    configureErrorOutput(child);
  }
}
configureErrorOutput(program);

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

// Best-effort onboarding nudge (see lib/skill-nudge.ts): when a configured
// caller drives a verify-loop command in a project with no installed skill,
// point it at `testsprite setup`. A preAction hook runs before every leaf
// action; the helper self-gates (text-only, non-dry-run, a small command
// allowlist, opt-out via TESTSPRITE_NO_SKILL_WARNING) and never throws.
program.hook('preAction', (_thisCommand, actionCommand) => {
  const globals = actionCommand.optsWithGlobals() as {
    output?: string;
    profile?: string;
    dryRun?: boolean;
  };
  maybeEmitSkillNudge({
    commandPath: commandPathOf(actionCommand),
    output: isOutputMode(globals.output) ? globals.output : 'text',
    dryRun: globals.dryRun ?? false,
    profile: globals.profile ?? 'default',
    cwd: process.cwd(),
    env: process.env,
  });
});

try {
  await program.parseAsync(process.argv);
} catch (err) {
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
    }
    process.exit(err.exitCode);
  }
  const output = new Output(mode);
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
    process.exit(err.exitCode);
  }
  if (err instanceof CommanderError) {
    // Commander already wrote the error message (via configureOutput) or the
    // help/version text to stdout. Map exit codes per the CLI taxonomy:
    //   help / version  → 0  (user asked for it — no error)
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
      process.exit(0);
    }
    // JSON mode: the plain-text write was suppressed in `configureErrorOutput`,
    // so emit a structured envelope here. Parse errors are the VALIDATION_ERROR
    // family (exit 5). `err.message` is the bare reason (e.g. "unknown option
    // '--foo'"); strip any leading "error: " Commander may have prefixed.
    if (requestedMode === 'json') {
      const envelope = {
        error: {
          code: 'VALIDATION_ERROR',
          message: err.message.replace(/^error:\s*/i, ''),
          nextAction: 'Run `testsprite --help`, or `testsprite <command> --help`, for usage.',
          requestId: 'local',
          details: { commanderCode: err.code },
        },
      };
      process.stderr.write(`${JSON.stringify(envelope, null, 2)}\n`);
    }
    process.exit(5);
  }
  if (err instanceof CLIError) {
    output.error(err.message);
    process.exit(err.exitCode);
  }
  output.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
