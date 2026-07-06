/**
 * Process lifecycle hardening: graceful termination signals and broken-pipe.
 *
 * Termination signals: without a handler, Node terminates the process abruptly
 * with no output, so a user (Ctrl+C), a CI runner or `docker stop` (SIGTERM), or
 * a closed terminal/SSH session (SIGHUP) that interrupts a long
 * `test run --wait` is left unsure whether the run was cancelled or is still
 * executing server-side (it is: the CLI only polls; the run lives on the
 * backend). The handler prints a one-line explanation plus how to resume, then
 * exits with the conventional `128 + signal` code.
 *
 * Broken pipe: when output is piped to a reader that closes early
 * (`testsprite ... | head`), the kernel raises `EPIPE` on the next stdout write.
 * Node turns an `'error'` with no listener into an uncaughtException and dumps a
 * raw `write EPIPE` stack (exit 1). The guard swallows it and exits 0, the
 * conventional SIGPIPE-equivalent result for "the reader went away".
 *
 * `process` and the streams are injectable so the wiring is unit-testable
 * without spawning a subprocess or sending a real signal.
 */

import { writeSync } from 'node:fs';

/**
 * Termination signals handled, mapped to their conventional `128 + signum`
 * exit code. sourceRef: POSIX signal numbers (SIGHUP=1, SIGINT=2, SIGTERM=15).
 */
export const TERMINATION_EXIT_CODES = {
  SIGINT: 130, // 128 + 2
  SIGTERM: 143, // 128 + 15
  SIGHUP: 129, // 128 + 1
} as const;

export type TerminationSignal = keyof typeof TERMINATION_EXIT_CODES;

/** Back-compat alias: SIGINT's conventional exit code. */
export const SIGINT_EXIT_CODE = TERMINATION_EXIT_CODES.SIGINT;

export function formatInterruptMessage(signal: TerminationSignal = 'SIGINT'): string {
  return (
    `Interrupted (${signal}). Any run already started keeps executing on the server; ` +
    'check it with `testsprite test list` or `testsprite test wait <runId>`.'
  );
}

export interface InterruptDeps {
  /** Signal registrar. Defaults to `process.on`. */
  on?: (signal: TerminationSignal, handler: () => void) => void;
  /** Line-oriented stderr writer (appends a newline). */
  stderr?: (line: string) => void;
  /** Process exit. Defaults to `process.exit`. */
  exit?: (code: number) => void;
}

/**
 * Register handlers for SIGINT, SIGTERM and SIGHUP. Idempotent enough for a
 * single top-level call in `index.ts`; not designed to be installed twice.
 */
export function installSignalHandlers(deps: InterruptDeps = {}): void {
  const on =
    deps.on ??
    ((signal: TerminationSignal, handler: () => void) => {
      process.on(signal, handler);
    });
  const stderr =
    deps.stderr ??
    ((line: string) => {
      // A signal handler calls process.exit() right after writing, which can
      // truncate an async process.stderr.write() when stderr is a pipe. Write
      // synchronously so the interrupt hint is flushed before the process exits.
      try {
        writeSync(process.stderr.fd, `${line}\n`);
      } catch {
        // Best-effort: if stderr is already gone (EPIPE), still exit cleanly.
      }
    });
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  for (const signal of Object.keys(TERMINATION_EXIT_CODES) as TerminationSignal[]) {
    on(signal, () => {
      // Blank line first so the message starts on its own row rather than
      // trailing the progress ticker's in-place line.
      stderr('');
      stderr(formatInterruptMessage(signal));
      exit(TERMINATION_EXIT_CODES[signal]);
    });
  }
}

export interface BrokenPipeDeps {
  /** stdout stream. Defaults to `process.stdout`. */
  stdout?: NodeJS.EventEmitter;
  /** stderr stream. Defaults to `process.stderr`. */
  stderr?: NodeJS.EventEmitter;
  /** Process exit. Defaults to `process.exit`. */
  exit?: (code: number) => void;
}

/**
 * Guard against `EPIPE` on stdout/stderr so piping to a reader that closes
 * early (`testsprite ... | head`) exits cleanly instead of crashing with an
 * unhandled `write EPIPE` stack. Only `EPIPE` is swallowed; any other stream
 * error is left to surface normally.
 */
export function installBrokenPipeGuard(deps: BrokenPipeDeps = {}): void {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  stdout.on('error', (error: NodeJS.ErrnoException) => {
    // Reader went away (`| head`, `| less` then q): exit cleanly like SIGPIPE
    // rather than dumping an unhandled `write EPIPE` stack. Any other stdout
    // error is a genuine, actionable failure, so re-throw it (Node's default).
    if (error.code === 'EPIPE') {
      exit(0);
      return;
    }
    throw error;
  });
  stderr.on('error', (error: NodeJS.ErrnoException) => {
    // stderr closed: nothing can be reported over it, so swallow EPIPE. Any
    // other error re-throws so a genuine failure is not silently hidden.
    if (error.code === 'EPIPE') return;
    throw error;
  });
}
