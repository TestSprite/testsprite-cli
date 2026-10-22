/**
 * Shared polling utility for `test run --wait` and `test wait`.
 *
 * Polling protocol:
 *
 *  1. **Long-poll preferred** (server supports `?waitSeconds`):
 *     Pass `waitSeconds = min(remaining, 25)` on each GET. The server returns when
 *     the run is terminal OR after `waitSeconds` elapses with the latest row.
 *
 *  2. **Exponential backoff fallback** (server returns 400 VALIDATION_ERROR on
 *     `waitSeconds` — older backend / local emulator): backoff 2s→4s→8s→15s
 *     with ±20% jitter, capped at 15s. Honors `Retry-After` if returned.
 *
 *  404 `details.reason: "not_yet_visible"` → honor Retry-After 1s, retry once.
 *  404 `details.reason: "not_found"` → throw immediately (exit 4, no retry).
 *  429 RATE_LIMITED → honor Retry-After (server emits this code for the
 *  shared throttle envelope; LAMBDA_THROTTLED is the upstream NestJS
 *  exception class but the CLI wire-code is RATE_LIMITED per
 *  the CLI error spec). Up to 3 attempts via `http.ts`, then throw (exit 11).
 *  5xx → single retry honoring Retry-After, second 5xx throws (exit 9).
 *  Outage once the endpoint has answered (a `TransportError`, or a 503
 *  UNAVAILABLE, after `http.ts` spent its own retries) → re-read on the
 *  backoff schedule above, or after the server's Retry-After, until the
 *  deadline. The run keeps executing server-side, so a Wi-Fi roam, a VPN
 *  reconnect or a deploy window must not end the wait. The endpoint has
 *  answered once a read succeeds, or from the start when the command just
 *  triggered the run (every caller but `test wait`, see
 *  `PollOptions.isFirstContact`). Before that, the single-retry rule above
 *  keeps a wrong endpoint failing fast. 429 and INTERNAL keep their handling.
 *  Stalled read once the endpoint has answered (no answer within the
 *  long-poll window plus `READ_STALL_GRACE_MS`, counted again after each retry
 *  wait inside the read) → abort it and handle it as an outage, so the next
 *  read opens a fresh connection instead of waiting for undici's 300s headers
 *  timeout while the run may already be finished.
 *  Deadline exceeded → throw `TimeoutError` (exit 7), or
 *  `UnreachableAtDeadlineError` (exit 10) when the last read was still an
 *  outage.
 */

import { ApiError, InterruptError, TransportError } from './errors.js';
import { composeAbortSignals } from './http.js';
import type { ShutdownHandle } from './interrupt.js';
import { defaultSleep, isAbortError, sleepUnlessInterrupted } from './poll-support.js';
import type { RunResponse } from './runs.types.js';
import { isTerminalStatus } from './runs.types.js';

export { isTerminalStatus } from './runs.types.js';

/**
 * Minimal interface that `pollRunUntilTerminal` requires from the HTTP client.
 * Using a structural interface (rather than the concrete `HttpClient`) makes
 * it easy to supply a lightweight mock in tests without implementing the full
 * class.
 */
export interface RunClient {
  getRun(
    runId: string,
    options?: {
      waitSeconds?: number;
      signal?: AbortSignal;
      /** Called before each retry wait inside the read; see `RequestOptions.onRetryWait`. */
      onRetryWait?: (delayMs: number) => void;
    },
  ): Promise<RunResponse>;
}

/** Thrown when the polling deadline is hit. */
export class TimeoutError extends Error {
  readonly runId: string;
  constructor(runId: string, timeoutSeconds: number) {
    super(`Timed out after ${timeoutSeconds}s waiting for run ${runId}`);
    this.name = 'TimeoutError';
    this.runId = runId;
  }
}

/**
 * Thrown when the deadline passes while the API is still unreachable: the last
 * read was a network failure or a 503 after the endpoint had answered. It is
 * the UNAVAILABLE `ApiError` (exit 10) the wait would have ended with before
 * outages were waited out, so a caller that only knows `ApiError` keeps its
 * transport-failure handling. Single-run wait paths also print the
 * `{runId, status}` partial and the re-attach hint for it, as they do for
 * `TimeoutError`, since the run keeps executing server-side. Paths that own a
 * tunnel replace the hint: the tunnel closes with the process, so the run is
 * cancelled rather than resumable.
 */
export class UnreachableAtDeadlineError extends ApiError {
  readonly runId: string;
  constructor(runId: string, timeoutSeconds: number, lastFailure: ApiError) {
    super(
      {
        code: 'UNAVAILABLE',
        message:
          `Could not reach the TestSprite API when the ${timeoutSeconds}s --timeout ended ` +
          `(last error: ${lastFailure.message}).`,
        nextAction: `Run ${runId} keeps executing server-side. When the network is back, re-attach with: testsprite test wait ${runId}, or cancel it: testsprite test cancel ${runId}`,
        requestId: lastFailure.requestId,
        details: { runId, timeoutSeconds },
      },
      lastFailure.httpStatus,
    );
    this.name = 'UnreachableAtDeadlineError';
    this.runId = runId;
  }
}

/**
 * A poll read that got no answer within its stall budget: the connection most
 * likely died without an error (a Wi-Fi switch, a VPN reconnect, a laptop
 * sleep). A transport failure (UNAVAILABLE), so the loop handles it like any
 * other outage once the endpoint has answered.
 */
export class ReadStalledError extends TransportError {
  readonly budgetMs: number;
  constructor(budgetMs: number) {
    super(`no answer for ${Math.round(budgetMs / 1000)}s`);
    this.name = 'ReadStalledError';
    this.budgetMs = budgetMs;
  }
}

export interface PollOptions {
  /** Maximum number of seconds to wait for a terminal status. */
  timeoutSeconds: number;
  /** Called after every successful GET poll (terminal or not). */
  onTick?: (run: RunResponse, elapsedMs: number) => void;
  /**
   * Optional callback for user-relevant state transitions during polling.
   * Emits messages for polling-mode switches and "not yet visible" retries
   * without the full debug firehose. Wired to stderr at `--verbose` level.
   */
  onTransition?: (msg: string) => void;
  /**
   * Injectable sleep function. Defaults to `setTimeout`-based sleep.
   * Inject a mock in tests to avoid real delays.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional escape hatch invoked after every **non-terminal** run tick.
   * Lets the caller resolve a terminal `RunResponse` from an alternate
   * source when the run-surface row itself will never finalize.
   *
   * The motivating case: backend-test run rows are written
   * `queued` then orphaned server-side (`finalizeRun` is FE-only), so the
   * run-row poll would always hit `--timeout` → exit 7 even on a passing BE
   * test. The handler supplies a fallback that reads the testId-scoped
   * verdict (`GET /tests/{id}/result`) and returns a synthesized terminal
   * `RunResponse` once the test record reports terminal.
   *
   * Return a terminal `RunResponse` to finish the poll, or `null`/`undefined`
   * to keep polling the run row. Only ever called on non-terminal ticks, so
   * the FE path (where the run row finalizes normally) is unaffected.
   *
   * `signal` aborts at the remaining `--timeout`; thread it through any HTTP
   * the callback makes so a stalled alternate lookup can't overrun the
   * user's deadline (the per-request HTTP timeout is much larger).
   */
  resolveAlternate?: (
    run: RunResponse,
    elapsedMs: number,
    signal: AbortSignal,
  ) => Promise<RunResponse | null>;
  /**
   * Graceful-detach coordinator. While the poll runs, the
   * scope is armed: a SIGINT/SIGTERM aborts `shutdown.signal` with an
   * `InterruptError` instead of killing the process, and this loop surfaces
   * it immediately — the in-flight long-poll fetch aborts (composed into the
   * per-iteration signal) and every backoff/retry sleep bails early. The
   * caller's catch block renders the honest partial + re-attach hint.
   * Absent (tests, non-wait callers): behavior is unchanged.
   */
  shutdown?: ShutdownHandle;
  /**
   * True when this poll is the command's first request to the API
   * (`test wait <run-id>`): until one read succeeds, a network failure fails
   * fast, since the endpoint itself may be wrong. Every other caller polls a
   * run it just triggered, so the endpoint has answered and an outage is
   * waited out from the first read on. Defaults to false.
   */
  isFirstContact?: boolean;
}

const LONG_POLL_WAIT_SECONDS = 25;
/**
 * How long past its long-poll window a read may stay unanswered before it
 * counts as stalled (ms). The server answers a `waitSeconds` read when the
 * window ends, so 20s of silence beyond it (45s for the 25s window) means the
 * connection is gone rather than slow.
 */
const READ_STALL_GRACE_MS = 20_000;
/** Backoff schedule for the non-long-poll fallback path (ms). */
const BACKOFF_SCHEDULE_MS = [2000, 4000, 8000, 15000];

/**
 * Poll `GET /api/cli/v1/runs/{runId}` until the run reaches a terminal
 * status or the deadline is exceeded.
 *
 * @returns The final `RunResponse` when terminal.
 * @throws `TimeoutError` when `timeoutSeconds` elapses before terminal.
 * @throws `UnreachableAtDeadlineError` (exit 10) when it elapses during an
 *   outage.
 * @throws `ApiError` for `NOT_FOUND` (exit 4), `RATE_LIMITED` (exit 11),
 *   and unrecoverable server errors.
 */
export async function pollRunUntilTerminal(
  client: RunClient,
  runId: string,
  options: PollOptions,
): Promise<RunResponse> {
  // Arm the graceful-detach scope for the duration of the poll:
  // while armed, a termination signal aborts instead of hard-killing the
  // process, and the wait-path catch blocks own the honest detach UX.
  const disarm = options.shutdown?.arm();
  try {
    return await pollLoop(client, runId, options);
  } catch (err) {
    if (err instanceof InterruptError && options.shutdown?.signal.aborted) {
      err.runWaitContext = true;
    }
    throw err;
  } finally {
    disarm?.();
  }
}

async function pollLoop(
  client: RunClient,
  runId: string,
  options: PollOptions,
): Promise<RunResponse> {
  const { timeoutSeconds, resolveAlternate } = options;
  const shutdownSignal = options.shutdown?.signal;
  const rawSleep = options.sleep ?? defaultSleep;
  // Every sleep site (retryAfterSeconds, backoff schedule, not_yet_visible,
  // 5xx retry) bails immediately on interrupt — a Ctrl-C must not sit out a
  // 15s backoff before it is noticed.
  const sleep = (ms: number): Promise<void> => sleepUnlessInterrupted(rawSleep, ms, shutdownSignal);

  const startMs = Date.now();
  const deadlineMs = startMs + timeoutSeconds * 1000;

  // Hoisted ONCE per poll *session* rather than re-minted every iteration.
  // The abort target here — deadlineMs + a transport cushion — is a fixed
  // absolute instant that does not change from one iteration to the next
  // (remainingMs shrinks, but remainingMs + TRANSPORT_CUSHION_MS measured
  // from "now" always lands on the same deadlineMs + cushion point). Minting
  // a fresh AbortController + setTimeout + `AbortSignal.any` composite every
  // iteration was therefore pure churn with no behavioral purpose: on a
  // `--wait` fan-out over many concurrent runIds, each polling for many
  // iterations, this created thousands of composite signals per invocation.
  // Every `AbortSignal.any` call registers an internal dependency listener
  // on the long-lived `shutdownSignal`, tracked via a WeakRef +
  // FinalizationRegistry so the listener can be reclaimed once the derived
  // signal is garbage-collected without leaking on the long-lived source —
  // but under a high allocation rate with no macrotask yield between
  // iterations (`TestDeps.sleep` in tests resolves via a bare microtask),
  // V8 can fall behind on running that reclamation incrementally, and the
  // eventual cleanup pass then has to walk a large backlog in one go
  // (`JSFinalizationRegistry::Cleanup` → `KeepDuringJob` →
  // `OrderedHashSet::Add`), pegging the CPU for minutes. One controller,
  // one timer, and one composed signal — created once, reused for every
  // iteration and every retry, cleared once when the session ends —
  // removes that per-iteration scaling factor entirely; the deadline
  // semantics are unchanged, since the abort target was already the same
  // absolute instant on every iteration.
  const TRANSPORT_CUSHION_MS = 2000;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(),
    deadlineMs - startMs + TRANSPORT_CUSHION_MS,
  );
  const sessionSignal =
    shutdownSignal != null
      ? AbortSignal.any([deadlineController.signal, shutdownSignal])
      : deadlineController.signal;

  // Same hoisting rationale for the `resolveAlternate` abort target
  // (deadlineMs, no cushion — also a fixed absolute instant). Allocated
  // lazily so callers that never pass `resolveAlternate` pay nothing for it.
  let altAbort: AbortController | undefined;
  let altTimer: ReturnType<typeof setTimeout> | undefined;
  let altSignal: AbortSignal | undefined;
  if (resolveAlternate) {
    altAbort = new AbortController();
    const controller = altAbort;
    altTimer = setTimeout(() => controller.abort(), deadlineMs - startMs);
    altSignal =
      shutdownSignal != null ? AbortSignal.any([altAbort.signal, shutdownSignal]) : altAbort.signal;
  }

  try {
    return await pollIterations(client, runId, options, {
      startMs,
      deadlineMs,
      sessionSignal,
      altSignal,
      sleep,
    });
  } finally {
    clearTimeout(deadlineTimer);
    if (altTimer !== undefined) clearTimeout(altTimer);
  }
}

interface PollLoopContext {
  startMs: number;
  deadlineMs: number;
  /** Hoisted per-session signal for the run-row GET (deadline + cushion, composed with shutdown). */
  sessionSignal: AbortSignal;
  /** Hoisted per-session signal for `resolveAlternate` lookups (deadline, no cushion), if applicable. */
  altSignal: AbortSignal | undefined;
  sleep: (ms: number) => Promise<void>;
}

async function pollIterations(
  client: RunClient,
  runId: string,
  options: PollOptions,
  ctx: PollLoopContext,
): Promise<RunResponse> {
  const { timeoutSeconds, onTick, onTransition, resolveAlternate } = options;
  const shutdownSignal = options.shutdown?.signal;
  const { startMs, deadlineMs, sessionSignal, altSignal, sleep } = ctx;

  // Track whether the server supports ?waitSeconds. Start optimistic.
  let useBackoff = false;
  let backoffIndex = 0;
  let consecutiveErrors = 0;
  // 404 not_yet_visible retry budget (one soft retry per event).
  let notYetVisibleRetries = 0;
  // Once the endpoint has answered (the command's trigger reached it, or a
  // read succeeded), an UNAVAILABLE read is an outage to wait out rather than
  // a misconfiguration to report.
  let hasEndpointAnswered = options.isFirstContact !== true;
  // The current outage: the last read's failure (undefined once a read gets
  // any answer), when the outage began, and how many re-reads it has cost so
  // far (indexes the backoff schedule).
  let outageFailure: ApiError | undefined;
  let outageStartedMs: number | undefined;
  let outageRetries = 0;
  // The deadline outcome: exit 10 when the last read was still an outage,
  // exit 7 otherwise.
  const deadlineError = (): TimeoutError | UnreachableAtDeadlineError =>
    outageFailure !== undefined
      ? new UnreachableAtDeadlineError(runId, timeoutSeconds, outageFailure)
      : new TimeoutError(runId, timeoutSeconds);

  while (true) {
    // Interrupt outranks the deadline: a Ctrl-C that raced the timeout must
    // surface as the honest detach, not as a generic TimeoutError.
    if (shutdownSignal?.aborted) throw shutdownSignal.reason;
    const now = Date.now();
    if (now >= deadlineMs) {
      throw deadlineError();
    }

    const remainingMs = deadlineMs - now;
    const remainingSeconds = Math.ceil(remainingMs / 1000);

    const waitSeconds = useBackoff ? undefined : Math.min(remainingSeconds, LONG_POLL_WAIT_SECONDS);
    const readRun = (
      signal: AbortSignal,
      onRetryWait?: (delayMs: number) => void,
    ): Promise<RunResponse> =>
      client.getRun(runId, {
        ...(waitSeconds === undefined ? {} : { waitSeconds }),
        signal,
        ...(onRetryWait === undefined ? {} : { onRetryWait }),
      });

    let run: RunResponse;
    try {
      // The stall guard is armed once the endpoint has answered: before that,
      // a silent endpoint is a misconfiguration for the deadline to report.
      run = hasEndpointAnswered
        ? await readWithStallGuard(
            sessionSignal,
            (waitSeconds ?? 0) * 1000 + READ_STALL_GRACE_MS,
            readRun,
          )
        : await readRun(sessionSignal);
      // Successful GET resets the consecutive-error counter.
      consecutiveErrors = 0;
      notYetVisibleRetries = 0;
      hasEndpointAnswered = true;
      if (outageStartedMs !== undefined) {
        const outageSeconds = Math.round((Date.now() - outageStartedMs) / 1000);
        onTransition?.(`Reconnected after ${outageSeconds}s; still waiting for run ${runId}`);
      }
      outageFailure = undefined;
      outageStartedMs = undefined;
      outageRetries = 0;
    } catch (err) {
      // Interrupt classification precedes the timeout mapping: the composed
      // signal makes the fetch reject on Ctrl-C, and that abort must surface
      // as the InterruptError — not as a spurious TimeoutError.
      if (err instanceof InterruptError) throw err;
      if (shutdownSignal?.aborted) throw shutdownSignal.reason;
      // An AbortError from the session controller means the deadline passed
      // while the fetch was in flight: surface as the deadline outcome.
      if (isAbortError(err)) {
        throw deadlineError();
      }
      if (!(err instanceof ApiError)) throw err;

      // Outage after the endpoint has answered: re-read until the deadline.
      // The loop-top deadline check then ends a wait whose outage outlasts
      // --timeout as `UnreachableAtDeadlineError`.
      const isOutage = err.code === 'UNAVAILABLE' && hasEndpointAnswered;
      outageFailure = isOutage ? err : undefined;
      if (isOutage) {
        // A stalled read went quiet when it started, not when the guard fired.
        outageStartedMs ??= Date.now() - (err instanceof ReadStalledError ? err.budgetMs : 0);
        const delayMs = outageRetryDelay(err, outageRetries);
        outageRetries += 1;
        onTransition?.(
          `Cannot reach the TestSprite API (${err.message}); run ${runId} keeps executing ` +
            `server-side. Retrying in ${Math.round(delayMs / 1000)}s until the --timeout deadline`,
        );
        const remaining = deadlineMs - Date.now();
        await sleep(Math.min(delayMs, Math.max(0, remaining)));
        continue;
      }

      // 400 VALIDATION_ERROR on waitSeconds → fall back to backoff.
      if (err.code === 'VALIDATION_ERROR' && !useBackoff) {
        useBackoff = true;
        onTransition?.(
          `Server does not support long-poll (?waitSeconds) — switching to exponential backoff mode`,
        );
        // Retry immediately (no sleep) on the first switch.
        continue;
      }

      // 404 not_yet_visible → retry once after 1s (clamped to remaining deadline).
      if (
        err.code === 'NOT_FOUND' &&
        err.getDetail('reason') === 'not_yet_visible' &&
        notYetVisibleRetries === 0
      ) {
        notYetVisibleRetries += 1;
        onTransition?.(`Server reports run ${runId} not yet visible — retrying in 1s`);
        const remaining = deadlineMs - Date.now();
        await sleep(Math.min(1000, Math.max(0, remaining)));
        continue;
      }

      // 404 not_found (cross-tenant or stale runId) → exit immediately.
      if (err.code === 'NOT_FOUND') {
        throw err;
      }

      // RATE_LIMITED (429) — honor Retry-After; max 3 retries total from
      // the http.ts retry table, but we also want to track here so if
      // http.ts already exhausted retries and re-throws, we propagate.
      if (err.code === 'RATE_LIMITED') {
        throw err; // http.ts already honored Retry-After + capped at 3.
      }

      // 5xx (INTERNAL, or UNAVAILABLE before the endpoint has answered):
      // single retry.
      if (err.code === 'INTERNAL' || err.code === 'UNAVAILABLE') {
        consecutiveErrors += 1;
        if (consecutiveErrors >= 2) throw err; // second error propagates.
        // http.ts already applied one retry for INTERNAL/UNAVAILABLE;
        // if we reach here it means http.ts gave up. We absorb one
        // additional attempt at the polling layer.
        const retryAfterSec = err.getDetail<number>(
          'retryAfterSec',
          (v): v is number => typeof v === 'number',
        );
        const backoffMs = retryAfterSec !== undefined ? retryAfterSec * 1000 : 1000;
        const remaining = deadlineMs - Date.now();
        await sleep(Math.min(backoffMs, Math.max(0, remaining)));
        continue;
      }

      // Everything else propagates.
      throw err;
    }

    const elapsedMs = Date.now() - startMs;
    onTick?.(run, elapsedMs);

    if (isTerminalStatus(run.status)) {
      return run;
    }

    // Non-terminal run tick. Give the caller a chance to resolve a terminal
    // verdict from an alternate source (e.g. the backend testId-scoped
    // result when the run-surface row never finalizes).
    if (resolveAlternate) {
      // Bound the alternate lookup by the REMAINING --timeout (not the much
      // larger per-request HTTP timeout) so a stalled fallback read can't
      // overrun the user's deadline.
      const altRemainingMs = deadlineMs - Date.now();
      if (altRemainingMs <= 0) {
        throw new TimeoutError(runId, timeoutSeconds);
      }
      // The alternate lookup aborts on interrupt too; its errors are swallowed
      // by the fallback (best-effort), so the loop-top interrupt check above
      // surfaces the InterruptError on the next iteration. `altSignal` is the
      // hoisted per-session signal (allocated once, above, whenever
      // `resolveAlternate` is present) — reused across every non-terminal
      // tick rather than re-composed each time.
      const alternate = await resolveAlternate(run, elapsedMs, altSignal!);
      // Enforce the hard cap: reject a terminal alternate that only arrived
      // at/after the deadline, same as the run-row long-poll path below.
      if (Date.now() >= deadlineMs) {
        throw new TimeoutError(runId, timeoutSeconds);
      }
      if (alternate) {
        return alternate;
      }
    }

    // Honor server-supplied retryAfterSeconds when present.
    // Clamp to remaining deadline so --timeout is a hard cap even when the
    // server hint is larger than the time left.
    if (run.retryAfterSeconds !== undefined && run.retryAfterSeconds > 0) {
      const remaining = deadlineMs - Date.now();
      await sleep(Math.min(run.retryAfterSeconds * 1000, Math.max(0, remaining)));
      continue;
    }

    // Long-poll path: server already waited up to waitSeconds for us;
    // loop immediately (no extra client-side sleep).
    if (!useBackoff) {
      // Check deadline before looping.
      if (Date.now() >= deadlineMs) {
        throw new TimeoutError(runId, timeoutSeconds);
      }
      continue;
    }

    // Backoff fallback path. Clamp to remaining deadline so --timeout is a
    // hard cap even when the schedule delay exceeds the time left.
    const rawDelay = backoffScheduleDelay(backoffIndex);
    backoffIndex = Math.min(backoffIndex + 1, BACKOFF_SCHEDULE_MS.length - 1);
    const remaining = deadlineMs - Date.now();
    await sleep(Math.min(rawDelay, Math.max(0, remaining)));
  }
}

/** Returns a jittered delay from the backoff schedule (±20%). */
function backoffScheduleDelay(index: number): number {
  const base = BACKOFF_SCHEDULE_MS[Math.min(index, BACKOFF_SCHEDULE_MS.length - 1)]!;
  const jitter = base * 0.2 * (Math.random() * 2 - 1); // ±20%
  return Math.max(0, Math.round(base + jitter));
}

/**
 * How long to wait before the next read through an outage: the server's own
 * answer when a 503 says when to come back (the `Retry-After` header, already
 * clamped to [1s, 300s] by `http.ts`, or the envelope's `retryAfterSec`), the
 * backoff schedule otherwise. The caller caps the wait at the deadline.
 */
function outageRetryDelay(failure: ApiError, outageRetries: number): number {
  if (failure.retryAfterMs !== undefined) return failure.retryAfterMs;
  const retryAfterSec = failure.getDetail<number>(
    'retryAfterSec',
    (value): value is number => typeof value === 'number',
  );
  if (retryAfterSec !== undefined) return Math.max(0, retryAfterSec * 1000);
  return backoffScheduleDelay(outageRetries);
}

/**
 * Run one poll read that is aborted after `budgetMs` without an answer, on top
 * of the session signal (deadline and Ctrl-C). Without it, a read on a
 * connection that died silently waits for undici's 300s headers timeout,
 * because the wait client raises its own per-request timeout to cover
 * `--timeout`. A stall surfaces as `ReadStalledError`, so the loop handles it
 * as an outage and the next read opens a fresh connection. Each retry wait
 * inside the read (`onRetryWait`: a transport backoff, a 429's Retry-After)
 * restarts the budget after the wait, so the guard never cuts a retry short
 * and never retries faster than `http.ts`. Composed with listeners, not
 * `AbortSignal.any`, for the reason documented on `composeAbortSignals`.
 */
async function readWithStallGuard<T>(
  sessionSignal: AbortSignal,
  budgetMs: number,
  read: (signal: AbortSignal, onRetryWait: (delayMs: number) => void) => Promise<T>,
): Promise<T> {
  const stall = new AbortController();
  // Cleared in `finally` as soon as the read settles.
  let stallTimer = setTimeout(() => stall.abort(), budgetMs);
  const restartAfterRetryWait = (delayMs: number): void => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => stall.abort(), delayMs + budgetMs);
  };
  const readAbort = composeAbortSignals([sessionSignal, stall.signal]);
  try {
    return await read(readAbort.signal, restartAfterRetryWait);
  } catch (err) {
    // The session signal (deadline, Ctrl-C) keeps its own meaning.
    if (stall.signal.aborted && !sessionSignal.aborted) throw new ReadStalledError(budgetMs);
    throw err;
  } finally {
    clearTimeout(stallTimer);
    readAbort.cleanup();
  }
}
