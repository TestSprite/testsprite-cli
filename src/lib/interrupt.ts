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
 * raw `write EPIPE` stack (exit 1). The guard swallows only this broken-pipe
 * error and lets the command finish normally, preserving its eventual verdict
 * and exit code. EPIPE must not abort an armed wait or tunnel lifetime.
 *
 * `process` and the streams are injectable so the wiring is unit-testable
 * without spawning a subprocess or sending a real signal.
 */

import { setMaxListeners } from 'node:events';
import { writeSync } from 'node:fs';
import { InterruptError, TERMINATION_EXIT_CODES, type TerminationSignal } from './errors.js';

export { TERMINATION_EXIT_CODES, type TerminationSignal } from './errors.js';

/** Back-compat alias: SIGINT's conventional exit code. */
export const SIGINT_EXIT_CODE = TERMINATION_EXIT_CODES.SIGINT;

export const INTERRUPT_EXIT_BACKSTOP_MS = 3_000;

export function armInterruptExitBackstop(
  code: number,
  deps: {
    setTimer?: (callback: () => void, delayMs: number) => Pick<NodeJS.Timeout, 'unref'>;
    exit?: (code: number) => void;
  } = {},
): void {
  const timer = (deps.setTimer ?? setTimeout)(
    () => (deps.exit ?? process.exit)(code),
    INTERRUPT_EXIT_BACKSTOP_MS,
  );
  timer.unref();
}

/**
 * Structural view of {@link ShutdownController} threaded through the DI
 * surfaces (`TestDeps`, `PollOptions`) — commands and the polling loop need
 * only these members, and tests can supply a lightweight fake.
 */
export interface ShutdownHandle {
  /** Aborts with the graceful-stop reason when a termination signal arrives while armed. */
  readonly signal: AbortSignal;
  /** Enter a graceful-detach scope. Returns the disposer that leaves it. */
  arm(): () => void;
  /** Run and track work that a repeated signal may briefly wait for. */
  runCriticalOperation<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Process-lifetime coordinator between the signal handler and the `--wait`
 * polling paths.
 *
 * Two modes, chosen by whether a graceful-detach scope is armed when the
 * signal arrives:
 *
 * - **Armed** (inside `pollRunUntilTerminal` or a tunnel lifetime): the handler only aborts
 *   `signal` with an `InterruptError` — no I/O, no exit. The in-flight fetch
 *   and every backoff sleep bail immediately; the `--wait` catch blocks own
 *   the cleanup (finalize the ticker, print the honest partial envelope +
 *   re-attach hint, rethrow to `index.ts` → exit 130/143/129).
 * - **Disarmed** (no wait in progress — prompts, one-shot commands, local
 *   FS work): the handler prints the generic explanation. An in-flight HTTP
 *   request can unwind through the top-level catch; idle work such as a
 *   readline prompt exits immediately because it cannot observe the abort.
 *
 * A repeated signal still provides a bounded escape hatch: the second waits
 * briefly when cleanup or an HTTP request is in flight, and the third exits at once.
 */
export class ShutdownController {
  private readonly controller = new AbortController();
  private readonly criticalOperations = new Set<Promise<unknown>>();
  private armedCount = 0;
  private receivedCause: TerminationSignal | null = null;

  constructor() {
    // Every fetch and every poll iteration composes this signal via
    // AbortSignal.any — a 50-run batch fan-out legitimately holds >10
    // concurrent listeners, so silence Node's MaxListeners warning.
    setMaxListeners(0, this.controller.signal);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The first graceful-shutdown cause received, or null if none yet. */
  get received(): TerminationSignal | null {
    return this.receivedCause;
  }

  get isArmed(): boolean {
    return this.armedCount > 0;
  }

  /**
   * Enter a graceful-detach scope (re-entrant: fan-out members overlap).
   * Returns an idempotent disposer.
   */
  arm(): () => void {
    this.armedCount += 1;
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.armedCount -= 1;
    };
  }

  /** Whether cleanup or an HTTP request is in flight and needs time to settle. */
  get hasCriticalOperations(): boolean {
    return this.criticalOperations.size > 0;
  }

  /**
   * Register an operation before it starts and remove it automatically when it
   * settles. Rejections retain their original semantics for the caller.
   */
  runCriticalOperation<T>(operation: () => Promise<T>): Promise<T> {
    const started = Promise.resolve().then(operation);
    const tracked = started.finally(() => {
      this.criticalOperations.delete(tracked);
    });
    this.criticalOperations.add(tracked);
    return tracked;
  }

  /** Wait until all current and directly chained tracked work settles. */
  async waitForCriticalOperations(): Promise<void> {
    while (this.criticalOperations.size > 0) {
      await Promise.allSettled([...this.criticalOperations]);
    }
  }

  /** Record the signal and abort with an `InterruptError` carrying it. */
  interrupt(signal: TerminationSignal): void {
    this.receivedCause = signal;
    this.controller.abort(new InterruptError(signal));
  }


}

/**
 * The process-wide instance: `index.ts` hands it to `installSignalHandlers`,
 * and it is the default `shutdown` for `TestDeps` / `PollOptions` /
 * `ClientFactoryDeps`, so production wiring is automatic. Tests inject their
 * own `ShutdownController` (or a `ShutdownHandle` fake) instead.
 */
export const globalShutdown = new ShutdownController();

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
  /** Set the exit code while allowing in-flight work to drain. */
  setExitCode?: (code: number) => void;
  /** Shutdown coordinator. Defaults to {@link globalShutdown}. */
  shutdown?: ShutdownController;
}

const CRITICAL_OPERATION_GRACE_MS = 2_000;
/** How often the grace period re-checks whether tracked work is still running. */
const CRITICAL_OPERATION_POLL_MS = 10;

function afterDelay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function waitForCriticalOperationsWithGrace(shutdown: ShutdownController): Promise<void> {
  const graceExpired = afterDelay(CRITICAL_OPERATION_GRACE_MS);
  const teardownFinished = (async () => {
    // An armed scope is the honest signal that teardown has not finished. On a
    // tunnel run it spans the whole unwind — cancel, then close, then the
    // credential delete — and those register one at a time with gaps between
    // them, so "no critical operation right now" does not mean "done". A fixed
    // settle window is the wrong shape: measured against the real command, the
    // first registration lands well after any window short enough to keep the
    // escape hatch snappy. Waiting for the scope to close instead tracks the
    // actual work, and the caller's overall cap keeps it bounded.
    while (shutdown.isArmed) {
      if (shutdown.hasCriticalOperations) {
        await shutdown.waitForCriticalOperations();
      } else {
        await afterDelay(CRITICAL_OPERATION_POLL_MS);
      }
    }
    await shutdown.waitForCriticalOperations();
  })();
  await Promise.race([graceExpired, teardownFinished]);
}

/**
 * Register handlers for SIGINT, SIGTERM and SIGHUP. Idempotent enough for a
 * single top-level call in `index.ts`; not designed to be installed twice.
 *
 * First signal, armed scope: abort-only — the `--wait` catch paths own the
 * honest-detach UX and the exit (Ctrl-C detaches; it never cancels the run).
 * First signal, disarmed: print the generic explanation, then drain an in-flight
 * request or exit `128+signum` immediately when idle.
 * Second signal: exit immediately unless cleanup or a request is registered;
 * when it is, wait at most two seconds before exiting. Third signal: always exit
 * immediately, including while that grace period is active.
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
      // An idle or repeated signal can call process.exit() right after writing,
      // truncating an async stderr write when stderr is a pipe.
      try {
        writeSync(process.stderr.fd, `${line}\n`);
      } catch {
        // Best-effort: if stderr is already gone (EPIPE), still exit cleanly.
      }
    });
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const setExitCode =
    deps.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  const shutdown = deps.shutdown ?? globalShutdown;
  let signalCount = 0;
  let graceGeneration = 0;

  for (const signal of Object.keys(TERMINATION_EXIT_CODES) as TerminationSignal[]) {
    on(signal, () => {
      signalCount += 1;
      if (signalCount >= 3) {
        // Invalidate any second-signal grace continuation before hard exit.
        graceGeneration += 1;
        exit(TERMINATION_EXIT_CODES[signal]);
        return;
      }
      if (signalCount === 2) {
        // `isArmed` matters as much as an already-registered operation: on a
        // tunnel run the lifecycle scope stays armed across teardown, and the
        // credential delete is registered only after the poll loop unwinds. A
        // second signal that arrives in between — which is what a reflexive
        // double Ctrl-C actually does — would otherwise hard-exit and strand a
        // live inbound credential until its TTL. An ordinary in-flight request
        // is registered too, so it gets the same bounded grace period.
        if (!shutdown.hasCriticalOperations && !shutdown.isArmed) {
          exit(TERMINATION_EXIT_CODES[signal]);
          return;
        }
        const generation = ++graceGeneration;
        void waitForCriticalOperationsWithGrace(shutdown).then(() => {
          // A third signal already took the immediate path.
          if (graceGeneration !== generation) return;
          exit(TERMINATION_EXIT_CODES[signal]);
        });
        return;
      }
      if (shutdown.isArmed) {
        // Graceful detach: abort only (sync, signal-safe — no I/O here so a
        // pending stdout `drain` wait can settle); the armed catch paths
        // finalize the ticker, print the partial + re-attach hint, and exit
        // via index.ts with this signal's code.
        shutdown.interrupt(signal);
        return;
      }
      // Record the signal first so a second one takes the escalation path.
      shutdown.interrupt(signal);
      // Blank line first so the message starts on its own row rather than
      // trailing the progress ticker's in-place line.
      stderr('');
      stderr(formatInterruptMessage(signal));
      if (shutdown.hasCriticalOperations) {
        setExitCode(TERMINATION_EXIT_CODES[signal]);
        return;
      }
      exit(TERMINATION_EXIT_CODES[signal]);
    });
  }
}

export interface BrokenPipeDeps {
  /** stdout stream. Defaults to `process.stdout`. */
  stdout?: NodeJS.EventEmitter;
  /** stderr stream. Defaults to `process.stderr`. */
  stderr?: NodeJS.EventEmitter;
}

/**
 * Guard against `EPIPE` on stdout/stderr so piping to a reader that closes
 * early (`testsprite ... | head`) does not produce an unhandled `write EPIPE`
 * stack. A broken pipe only means output can no longer be delivered; it must
 * not terminate or abort the command. The command must finish normally because
 * its final exit code may not be known when EPIPE arrives (for example, a test
 * run can still be resolving to failed). Only `EPIPE` is swallowed; any other
 * stream error is left to surface normally.
 */
export function installBrokenPipeGuard(deps: BrokenPipeDeps = {}): void {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  let stdoutBroken = false;
  stdout.on('error', (error: NodeJS.ErrnoException) => {
    // Reader went away (`| head`, `| less` then q). Once stdout has failed,
    // later stream errors are consequences of the same closed pipe and cannot
    // be reported to the reader either.
    if (stdoutBroken) return;
    if (error.code === 'EPIPE') {
      // Do not exit or abort the shutdown signal here. The command must
      // continue through normal cleanup and verdict handling; process.exitCode
      // may only be assigned after async work and telemetry complete.
      stdoutBroken = true;
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
