import type { RunResponse } from './runs.types.js';
import type { Ticker } from './ticker.js';

/**
 * The in-place progress line for a polled run.
 *
 * Deliberately NO `completed/total` counter: on both the V2 and V3 read paths
 * `stepSummary.total` and `.completed` are computed from the same array of
 * already-finished step rows (a row is inserted only once its step has a
 * verdict), so the two can never differ — `0/0 steps` at the start and `N/N`
 * thereafter carried no information. Show the recorded count, or nothing.
 *
 * `tag` is inserted verbatim after the run id — the caller picks the bracket
 * style (`(testId)` for batch members, `[role]` for closure members) so the
 * two kinds of tag stay visually distinct.
 */
export function formatRunProgressLine(run: RunResponse, elapsedMs: number, tag?: string): string {
  const elapsed = Math.round(elapsedMs / 1000);
  const total = run.stepSummary?.total ?? 0;
  const head = tag === undefined ? `Run ${run.runId}` : `Run ${run.runId} ${tag}`;
  const steps = total > 0 ? ` · ${total} step${total === 1 ? '' : 's'}` : '';
  return `${head} — ${run.status}${steps} · ${elapsed}s`;
}

export interface LiveRunProgress {
  /** Feed a poll result; renders immediately and becomes the refresher's snapshot. */
  onTick(run: RunResponse, elapsedMs: number): void;
  /** Stop the 1s refresher. Idempotent; call before the ticker's final line. */
  stop(): void;
}

export interface LiveRunProgressOptions {
  /**
   * Whether to run the between-polls refresher. Defaults to
   * `ticker.redrawsInPlace` — a ticker that prints a NEW line per `update()`
   * (non-TTY, NO_COLOR) must not be redrawn once a second.
   */
  enabled?: boolean;
  intervalMs?: number;
  now?: () => number;
  setIntervalFn?: (cb: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
}

/**
 * Wraps a {@link Ticker} so the elapsed counter keeps moving between polls.
 * In long-poll mode a `getRun` returns every ~25s, so a ticker driven only by
 * `onTick` freezes for the whole wait; this re-renders the LAST snapshot
 * every second with the wall-clock time that has passed since it arrived.
 */
export function createLiveRunProgress(
  ticker: Ticker,
  opts: LiveRunProgressOptions = {},
  tag?: string,
): LiveRunProgress {
  const now = opts.now ?? Date.now;
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
  const enabled = opts.enabled ?? ticker.redrawsInPlace;
  let snapshot: { run: RunResponse; elapsedMs: number; at: number } | undefined;
  let handle: NodeJS.Timeout | undefined;

  if (enabled) {
    handle = setIntervalFn(() => {
      if (!snapshot) return;
      ticker.update(
        formatRunProgressLine(snapshot.run, snapshot.elapsedMs + (now() - snapshot.at), tag),
      );
    }, opts.intervalMs ?? 1000);
    // Never let the refresher keep the process alive on its own.
    (handle as { unref?: () => void }).unref?.();
  }

  return {
    onTick(run, elapsedMs) {
      snapshot = { run, elapsedMs, at: now() };
      ticker.update(formatRunProgressLine(run, elapsedMs, tag));
    },
    stop() {
      if (handle !== undefined) {
        clearIntervalFn(handle);
        handle = undefined;
      }
    },
  };
}
