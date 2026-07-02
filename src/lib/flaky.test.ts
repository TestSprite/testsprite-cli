import { describe, expect, it } from 'vitest';
import { flakyExitCode, renderFlakyText, summarizeFlaky, type FlakyAttempt } from './flaky.js';

function pass(attempt: number): FlakyAttempt {
  return { attempt, runId: `run_${attempt}`, outcome: 'passed' };
}
function fail(attempt: number, failureKind = 'assertion'): FlakyAttempt {
  return { attempt, runId: `run_${attempt}`, outcome: 'failed', failureKind };
}

describe('summarizeFlaky', () => {
  it('reports STABLE when every attempt passed', () => {
    const report = summarizeFlaky('test_x', [pass(1), pass(2), pass(3)]);
    expect(report.verdict).toBe('stable');
    expect(report.runs).toBe(3);
    expect(report.passed).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.stableRatio).toBe(1);
    expect(report.failures).toEqual([]);
    expect(flakyExitCode(report)).toBe(0);
  });

  it('reports FLAKY on a mix of pass and fail', () => {
    const report = summarizeFlaky('test_x', [pass(1), fail(2), pass(3)]);
    expect(report.verdict).toBe('flaky');
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.stableRatio).toBe(0.6667);
    expect(report.failures).toEqual([
      { attempt: 2, runId: 'run_2', outcome: 'failed', failureKind: 'assertion' },
    ]);
    expect(flakyExitCode(report)).toBe(1);
  });

  it('reports FAILING when no attempt passed', () => {
    const report = summarizeFlaky('test_x', [fail(1), fail(2)]);
    expect(report.verdict).toBe('failing');
    expect(report.passed).toBe(0);
    expect(report.stableRatio).toBe(0);
    expect(flakyExitCode(report)).toBe(1);
  });

  it('treats an empty attempt list as FAILING with a 0 ratio', () => {
    const report = summarizeFlaky('test_x', []);
    expect(report.verdict).toBe('failing');
    expect(report.runs).toBe(0);
    expect(report.stableRatio).toBe(0);
    expect(flakyExitCode(report)).toBe(1);
  });

  it('counts timeout and error outcomes as non-passing', () => {
    const attempts: FlakyAttempt[] = [
      pass(1),
      { attempt: 2, runId: 'run_2', outcome: 'timeout' },
      { attempt: 3, runId: null, outcome: 'error', failureKind: 'UNAVAILABLE' },
    ];
    const report = summarizeFlaky('test_x', attempts);
    expect(report.verdict).toBe('flaky');
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(2);
    expect(report.failures.map(f => f.outcome)).toEqual(['timeout', 'error']);
    // error attempt with no runId is preserved as null in the report
    expect(report.failures[1]).toEqual({
      attempt: 3,
      runId: null,
      outcome: 'error',
      failureKind: 'UNAVAILABLE',
    });
  });

  it('rounds stableRatio to 4 decimal places', () => {
    const report = summarizeFlaky('test_x', [pass(1), pass(2), fail(3)]);
    expect(report.stableRatio).toBe(0.6667);
  });

  it('reflects a short-circuited (--until-fail) run — fewer runs than requested', () => {
    // Only two attempts were observed before the probe stopped at the failure.
    const report = summarizeFlaky('test_x', [pass(1), fail(2)]);
    expect(report.runs).toBe(2);
    expect(report.verdict).toBe('flaky');
  });
});

describe('renderFlakyText', () => {
  it('summarizes a stable run on one line with no failure list', () => {
    const text = renderFlakyText(summarizeFlaky('test_login', [pass(1), pass(2)]));
    expect(text).toBe('Ran test_login 2x — 2 passed, 0 failed → STABLE (100% stable)');
  });

  it('lists failing attempts with runId and failureKind', () => {
    const text = renderFlakyText(
      summarizeFlaky('test_login', [pass(1), fail(2, 'network_timeout')]),
    );
    expect(text).toContain('→ FLAKY (50% stable)');
    expect(text).toContain('failed attempts:');
    expect(text).toContain('#2  run_2  failed failureKind=network_timeout');
  });

  it('shows (no runId) when an errored attempt never got a runId', () => {
    const text = renderFlakyText(
      summarizeFlaky('test_login', [{ attempt: 1, runId: null, outcome: 'error' }]),
    );
    expect(text).toContain('#1  (no runId)  error');
  });
});
