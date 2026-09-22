import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveRunProgress, formatRunProgressLine } from './run-progress.js';
import type { Ticker } from './ticker.js';
import type { RunResponse } from './runs.types.js';

function makeRun(overrides: Partial<RunResponse> = {}): RunResponse {
  return {
    runId: 'run_1',
    testId: 'test_1',
    status: 'running',
    stepSummary: { total: 0, completed: 0, passedCount: 0, failedCount: 0 },
    ...overrides,
  } as RunResponse;
}

function makeTicker(redrawsInPlace = true): Ticker & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    redrawsInPlace,
    update: (line: string) => {
      lines.push(line);
    },
    finalize: () => undefined,
  };
}

const steps = (n: number) => ({ total: n, completed: n, passedCount: n, failedCount: 0 });

describe('formatRunProgressLine', () => {
  it('omits the step counter entirely when no steps have been recorded', () => {
    // A brand-new run has zero step rows; "0/0 steps" is the false-progress
    // line this formatter exists to remove.
    expect(formatRunProgressLine(makeRun(), 12_000)).toBe('Run run_1 — running · 12s');
  });

  it('shows the recorded step count without a denominator', () => {
    // total === completed by construction (a step row exists only once the
    // step has finished), so "3/3" carries no information — show "3 steps".
    const line = formatRunProgressLine(makeRun({ stepSummary: steps(3) }), 14_400);
    expect(line).toBe('Run run_1 — running · 3 steps · 14s');
  });

  it('uses the singular for one step', () => {
    const line = formatRunProgressLine(makeRun({ stepSummary: steps(1) }), 3_000);
    expect(line).toBe('Run run_1 — running · 1 step · 3s');
  });

  it('inserts a caller-formatted tag verbatim after the run id', () => {
    // Batch tickers tag with "(testId)", closure tickers with "[role]" — the
    // bracket style is the caller's to choose, so the tag is not re-wrapped.
    expect(formatRunProgressLine(makeRun(), 5_000, '(test_abc)')).toBe(
      'Run run_1 (test_abc) — running · 5s',
    );
    expect(formatRunProgressLine(makeRun(), 5_000, '[producer]')).toBe(
      'Run run_1 [producer] — running · 5s',
    );
  });

  it('renders tag, step count and elapsed together in that order', () => {
    const line = formatRunProgressLine(makeRun({ stepSummary: steps(3) }), 5_000, '(test_abc)');
    expect(line).toBe('Run run_1 (test_abc) — running · 3 steps · 5s');
  });

  it('tolerates a run with no stepSummary at all', () => {
    const run = makeRun({ stepSummary: undefined });
    expect(formatRunProgressLine(run, 1_000)).toBe('Run run_1 — running · 1s');
  });
});

describe('createLiveRunProgress', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the progress line on a poll tick', () => {
    const ticker = makeTicker();
    const live = createLiveRunProgress(ticker, {
      now: () => 0,
      setIntervalFn: () => ({}) as NodeJS.Timeout,
      clearIntervalFn: () => undefined,
    });
    live.onTick(makeRun(), 2_000);
    expect(ticker.lines).toEqual(['Run run_1 — running · 2s']);
    live.stop();
  });

  it('with no injection, a real 1s setInterval drives the refresher and stop() ends it', () => {
    // The production wiring (setInterval / clearInterval / Date.now / 1000ms)
    // is what ships; every other case injects fakes, so this one must not.
    vi.useFakeTimers({ now: 0 });
    const ticker = makeTicker();
    const live = createLiveRunProgress(ticker);
    live.onTick(makeRun(), 0);
    vi.advanceTimersByTime(2_000);
    expect(ticker.lines).toEqual([
      'Run run_1 — running · 0s',
      'Run run_1 — running · 1s',
      'Run run_1 — running · 2s',
    ]);
    live.stop();
    vi.advanceTimersByTime(5_000);
    expect(ticker.lines).toHaveLength(3);
  });

  it('keeps the elapsed counter moving between polls from the LATEST snapshot', () => {
    // Long-poll returns every ~25s; without this the elapsed seconds freeze.
    // A second poll must replace the first — the interval renders the newest
    // status and step count, never the stale first one.
    let clock = 0;
    let intervalCb: (() => void) | undefined;
    const ticker = makeTicker();
    const live = createLiveRunProgress(ticker, {
      now: () => clock,
      setIntervalFn: (cb: () => void) => {
        intervalCb = cb;
        return {} as NodeJS.Timeout;
      },
      clearIntervalFn: () => undefined,
    });
    clock = 10_000;
    live.onTick(makeRun({ stepSummary: steps(2) }), 10_000);
    clock = 11_000;
    intervalCb?.();
    clock = 12_000;
    live.onTick(makeRun({ status: 'passed', stepSummary: steps(4) }), 12_000);
    clock = 13_000;
    intervalCb?.();
    expect(ticker.lines).toEqual([
      'Run run_1 — running · 2 steps · 10s',
      'Run run_1 — running · 2 steps · 11s',
      'Run run_1 — passed · 4 steps · 12s',
      'Run run_1 — passed · 4 steps · 13s',
    ]);
    live.stop();
  });

  it('does not render anything from the interval before the first tick', () => {
    let intervalCb: (() => void) | undefined;
    const ticker = makeTicker();
    const live = createLiveRunProgress(ticker, {
      now: () => 0,
      setIntervalFn: (cb: () => void) => {
        intervalCb = cb;
        return {} as NodeJS.Timeout;
      },
      clearIntervalFn: () => undefined,
    });
    intervalCb?.();
    expect(ticker.lines).toEqual([]);
    live.stop();
  });

  it('arms the interval at 1000ms', () => {
    const setIntervalFn = vi.fn(() => ({}) as NodeJS.Timeout);
    const live = createLiveRunProgress(makeTicker(), {
      now: () => 0,
      setIntervalFn,
      clearIntervalFn: () => undefined,
    });
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 1000);
    live.stop();
  });

  it('stop() clears the interval exactly once, even when called twice', () => {
    const handle = {} as NodeJS.Timeout;
    const clearIntervalFn = vi.fn();
    const live = createLiveRunProgress(makeTicker(), {
      now: () => 0,
      setIntervalFn: () => handle,
      clearIntervalFn,
    });
    live.stop();
    live.stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(clearIntervalFn).toHaveBeenCalledWith(handle);
  });

  it('defaults `enabled` to the ticker: a ticker that does not redraw in place gets no interval', () => {
    // NO_COLOR and non-TTY tickers print a NEW line per update() rather than
    // redrawing — a 1s refresher there would spam a line per second. Ticks
    // still render (the ticker itself decides whether that is a no-op).
    const setIntervalFn = vi.fn(() => ({}) as NodeJS.Timeout);
    const clearIntervalFn = vi.fn();
    const ticker = makeTicker(false);
    const live = createLiveRunProgress(ticker, {
      now: () => 0,
      setIntervalFn,
      clearIntervalFn,
    });
    live.onTick(makeRun(), 4_000);
    live.stop();
    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(clearIntervalFn).not.toHaveBeenCalled();
    expect(ticker.lines).toEqual(['Run run_1 — running · 4s']);
  });

  it('an explicit `enabled` overrides the ticker default', () => {
    const setIntervalFn = vi.fn(() => ({}) as NodeJS.Timeout);
    const live = createLiveRunProgress(makeTicker(true), {
      enabled: false,
      now: () => 0,
      setIntervalFn,
      clearIntervalFn: () => undefined,
    });
    expect(setIntervalFn).not.toHaveBeenCalled();
    live.stop();
  });

  it('unrefs the interval handle when the runtime offers it', () => {
    const unref = vi.fn();
    const live = createLiveRunProgress(makeTicker(), {
      now: () => 0,
      setIntervalFn: () => ({ unref }) as unknown as NodeJS.Timeout,
      clearIntervalFn: () => undefined,
    });
    expect(unref).toHaveBeenCalled();
    live.stop();
  });
});
