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
 * raw `write EPIPE` stack (exit 1). Outside an armed lifetime the guard exits
 * 0 immediately, the conventional SIGPIPE-equivalent result. While armed it
 * first requests coordinated shutdown so tunnel cleanup can finish, then the
 * same synthetic interrupt reason preserves exit 0.
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

/**
 * Structural view of {@link ShutdownController} threaded through the DI
 * surfaces (`TestDeps`, `PollOptions`) — commands and the polling loop need
 * only these members, and tests can supply a lightweight fake.
 */
export interface ShutdownHandle {
  /** Aborts with the graceful-stop reason when a signal/EPIPE arrives while armed. */
  readonly signal: AbortSignal;
  /** Enter a graceful-detach scope. Returns the disposer that leaves it. */
  arm(): () => void;
  /** Run and track cleanup that a repeated signal may briefly wait for. */
  runCriticalOperation<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Process-lifetime coordinator between the signal handler and the `--wait`
 * polling paths (DEV-331 piece 1).
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
 *   FS work): the handler prints the generic explanation and exits
 *   immediately, preserving the pre-DEV-331 behavior. An abort nobody
 *   observes must never leave the process hanging at e.g. a readline prompt.
 *
 * A repeated signal still provides a bounded escape hatch: the second waits
 * briefly only when critical cleanup is in flight, and the third exits at once.
 */
export class ShutdownController {
  private readonly controller = new AbortController();
  private readonly criticalOperations = new Set<Promise<unknown>>();
  private armedCount = 0;
  private receivedCause: TerminationSignal | 'EPIPE' | null = null;

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
  get received(): TerminationSignal | 'EPIPE' | null {
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

  /** Whether teardown currently has work whose abrupt loss is security-sensitive. */
  get hasCriticalOperations(): boolean {
    return this.criticalOperations.size > 0;
  }

  /**
   * Register cleanup before it starts and remove it automatically when it
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

  /** Wait until all current and directly chained critical cleanup settles. */
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

  /**
   * Abort an armed lifetime after stdout's reader closes. The InterruptError
   * subtype deliberately keeps the existing graceful-detach catch paths in
   * play (including tunnel cancellation), while its exit code stays the
   * SIGPIPE-equivalent success code 0.
   */
  brokenPipe(): void {
    if (this.receivedCause !== null) return;
    this.receivedCause = 'EPIPE';
    this.controller.abort(new BrokenPipeInterruptError());
  }
}

class BrokenPipeInterruptError extends InterruptError {
  override readonly exitCode = 0;

  constructor() {
    // Existing graceful-detach consumers read `.signal` to render their
    // partial status. The distinct name/message and exitCode carry the real
    // cause without widening the OS-signal contract in errors.ts.
    super('SIGINT');
    this.name = 'BrokenPipeInterruptError';
    this.message = 'Output pipe closed.';
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
  /** Shutdown coordinator. Defaults to {@link globalShutdown}. */
  shutdown?: ShutdownController;
}

const CRITICAL_OPERATION_GRACE_MS = 2_000;
/** How often the grace period re-checks whether teardown is still running. */
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
 * honest-detach UX and the exit (DEV-331 D1: Ctrl-C = detach, never cancel).
 * First signal, disarmed: print the generic explanation + exit `128+signum`.
 * Second signal: exit immediately unless critical cleanup is registered; when
 * it is, wait at most two seconds before exiting. Third signal: always exit
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
        // live inbound credential until its TTL, the exact outcome the grace
        // period exists to prevent.
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
      // Disarmed (no --wait in progress): legacy immediate exit. Record the
      // signal first so a second one takes the hard-exit branch even when
      // `exit` is injected and does not terminate (unit tests).
      shutdown.interrupt(signal);
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
  /** Shutdown coordinator. Defaults to {@link globalShutdown}. */
  shutdown?: ShutdownController;
}

/**
 * Guard against `EPIPE` on stdout/stderr so piping to a reader that closes
 * early (`testsprite ... | head`) exits cleanly instead of crashing with an
 * unhandled `write EPIPE` stack. An armed stdout path requests graceful
 * shutdown before exiting 0; a disarmed one exits 0 immediately. Only `EPIPE`
 * is swallowed; any other stream error is left to surface normally.
 */
export function installBrokenPipeGuard(deps: BrokenPipeDeps = {}): void {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const shutdown = deps.shutdown ?? globalShutdown;

  stdout.on('error', (error: NodeJS.ErrnoException) => {
    // Reader went away (`| head`, `| less` then q): exit cleanly like SIGPIPE
    // rather than dumping an unhandled `write EPIPE` stack. Any other stdout
    // error is a genuine, actionable failure, so re-throw it (Node's default).
    if (error.code === 'EPIPE') {
      if (shutdown.isArmed) {
        // A tunnel lifetime owns credential teardown in its `finally`. Abort
        // through the same coordinator as the first signal and let that
        // cleanup finish; the synthetic reason exits 0 once it propagates.
        shutdown.brokenPipe();
        return;
      }
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
