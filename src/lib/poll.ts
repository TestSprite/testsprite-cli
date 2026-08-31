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
 *  Deadline exceeded → throw `TimeoutError`.
 */

import { ApiError, InterruptError } from './errors.js';
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
    options?: { waitSeconds?: number; signal?: AbortSignal },
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
   * The motivating case (dogfood L1888): backend-test run rows are written
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
   * Graceful-detach coordinator (DEV-331 piece 1). While the poll runs, the
   * scope is armed: a SIGINT/SIGTERM aborts `shutdown.signal` with an
   * `InterruptError` instead of killing the process, and this loop surfaces
   * it immediately — the in-flight long-poll fetch aborts (composed into the
   * per-iteration signal) and every backoff/retry sleep bails early. The
   * caller's catch block renders the honest partial + re-attach hint.
   * Absent (tests, non-wait callers): behavior is unchanged.
   */
  shutdown?: ShutdownHandle;
}

const LONG_POLL_WAIT_SECONDS = 25;
/** Backoff schedule for the non-long-poll fallback path (ms). */
const BACKOFF_SCHEDULE_MS = [2000, 4000, 8000, 15000];

/**
 * Poll `GET /api/cli/v1/runs/{runId}` until the run reaches a terminal
 * status or the deadline is exceeded.
 *
 * @returns The final `RunResponse` when terminal.
 * @throws `TimeoutError` when `timeoutSeconds` elapses before terminal.
 * @throws `ApiError` for `NOT_FOUND` (exit 4), `RATE_LIMITED` (exit 11),
 *   and unrecoverable server errors.
 */
export async function pollRunUntilTerminal(
  client: RunClient,
  runId: string,
  options: PollOptions,
): Promise<RunResponse> {
  // Arm the graceful-detach scope for the duration of the poll (DEV-331):
  // while armed, a termination signal aborts instead of hard-killing the
  // process, and the wait-path catch blocks own the honest detach UX.
  const disarm = options.shutdown?.arm();
  try {
    return await pollLoop(client, runId, options);
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

  while (true) {
    // Interrupt outranks the deadline: a Ctrl-C that raced the timeout must
    // surface as the honest detach, not as a generic TimeoutError.
    if (shutdownSignal?.aborted) throw shutdownSignal.reason;
    const now = Date.now();
    if (now >= deadlineMs) {
      throw new TimeoutError(runId, timeoutSeconds);
    }

    const remainingMs = deadlineMs - now;
    const remainingSeconds = Math.ceil(remainingMs / 1000);

    let run: RunResponse;
    try {
      if (useBackoff) {
        run = await client.getRun(runId, { signal: sessionSignal });
      } else {
        const waitSeconds = Math.min(remainingSeconds, LONG_POLL_WAIT_SECONDS);
        run = await client.getRun(runId, { waitSeconds, signal: sessionSignal });
      }
      // Successful GET resets the consecutive-error counter.
      consecutiveErrors = 0;
      notYetVisibleRetries = 0;
    } catch (err) {
      // Interrupt classification precedes the timeout mapping: the composed
      // signal makes the fetch reject on Ctrl-C, and that abort must surface
      // as the InterruptError — not as a spurious TimeoutError.
      if (err instanceof InterruptError) throw err;
      if (shutdownSignal?.aborted) throw shutdownSignal.reason;
      // An AbortError from the session controller means the deadline passed
      // while the fetch was in flight — surface as TimeoutError.
      if (isAbortError(err)) {
        throw new TimeoutError(runId, timeoutSeconds);
      }
      if (!(err instanceof ApiError)) throw err;

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

      // 5xx (INTERNAL / UNAVAILABLE) — single retry.
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
    // result when the run-surface row never finalizes — dogfood L1888).
    if (resolveAlternate) {
      // Bound the alternate lookup by the REMAINING --timeout (not the much
      // larger per-request HTTP timeout) so a stalled fallback read can't
      // overrun the user's deadline (codex round-2).
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
