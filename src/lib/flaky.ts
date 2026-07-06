/**
 * Pure aggregation + rendering for `test flaky` — the repeat-run flaky-test
 * detector. This module performs no I/O: the orchestrator in
 * `commands/test.ts` feeds it the per-attempt outcomes, and it returns a
 * machine-readable stability report plus the text rendering and exit code.
 *
 * Keeping the scoring logic pure makes it trivially unit-testable in isolation
 * (deterministic, no network / credentials), matching the repo's mock-based
 * test convention.
 */

/**
 * Outcome of a single flaky-detector attempt. The first four mirror the
 * terminal `RunStatus` values; `timeout` and `error` are orchestration
 * outcomes (per-attempt deadline exceeded, or a non-fatal trigger/transport
 * error that was recorded rather than aborting the whole probe).
 */
export type FlakyOutcome = 'passed' | 'failed' | 'blocked' | 'cancelled' | 'timeout' | 'error';

/** Overall stability verdict across all observed attempts. */
export type FlakyVerdict = 'stable' | 'flaky' | 'failing';

/** One recorded attempt in a flaky run. */
export interface FlakyAttempt {
  /** 1-based attempt index. */
  attempt: number;
  /** The runId of this attempt, or `null` when the trigger never returned one. */
  runId: string | null;
  outcome: FlakyOutcome;
  /**
   * Server `failureKind` for non-passing runs (or the error code for `error`
   * outcomes). `null` / omitted when the attempt passed or the kind is unknown.
   */
  failureKind?: string | null;
}

/** A single non-passing attempt as surfaced in the report. */
export interface FlakyFailure {
  attempt: number;
  runId: string | null;
  outcome: FlakyOutcome;
  failureKind: string | null;
}

/**
 * Machine-readable stability report. This is also the exact `--output json`
 * shape, so dashboards / agents / CI can consume it directly.
 */
export interface FlakyReport {
  testId: string;
  /**
   * Attempts actually observed. May be fewer than requested when
   * `--until-fail` short-circuits on the first non-passing attempt.
   */
  runs: number;
  passed: number;
  failed: number;
  /** `passed / runs`, rounded to 4 decimal places. `0` when `runs === 0`. */
  stableRatio: number;
  verdict: FlakyVerdict;
  /** Non-passing attempts, in attempt order. */
  failures: FlakyFailure[];
}

/**
 * Aggregate per-attempt outcomes into a stability report.
 *
 * Verdict rules:
 *   - every attempt passed        → `stable`
 *   - no attempt passed           → `failing`
 *   - a mix of pass and non-pass  → `flaky`
 * An empty attempt list (no runs observed) is reported as `failing` with a
 * `0` ratio — there is no evidence the test is stable.
 */
export function summarizeFlaky(testId: string, attempts: FlakyAttempt[]): FlakyReport {
  const runs = attempts.length;
  const passed = attempts.filter(a => a.outcome === 'passed').length;
  const failed = runs - passed;
  const stableRatio = runs === 0 ? 0 : Math.round((passed / runs) * 10000) / 10000;
  const verdict: FlakyVerdict =
    runs > 0 && passed === runs ? 'stable' : passed === 0 ? 'failing' : 'flaky';
  const failures: FlakyFailure[] = attempts
    .filter(a => a.outcome !== 'passed')
    .map(a => ({
      attempt: a.attempt,
      runId: a.runId,
      outcome: a.outcome,
      failureKind: a.failureKind ?? null,
    }));
  return { testId, runs, passed, failed, stableRatio, verdict, failures };
}

/**
 * Exit code for the command: `0` only when the verdict is `stable` (every
 * observed attempt passed). Anything else is non-zero so CI can gate a merge
 * on flakiness (`testsprite test flaky <id> --runs 5 || exit 1`).
 */
export function flakyExitCode(report: FlakyReport): number {
  return report.verdict === 'stable' ? 0 : 1;
}

/** Human-readable label for a verdict. */
function verdictLabel(verdict: FlakyVerdict): string {
  switch (verdict) {
    case 'stable':
      return 'STABLE';
    case 'flaky':
      return 'FLAKY';
    case 'failing':
      return 'FAILING';
  }
}

/**
 * Render a report to human-readable text. JSON-mode callers ship the report
 * verbatim via `out.print`; this is the text-mode rendering.
 */
export function renderFlakyText(report: FlakyReport): string {
  const pct = Math.round(report.stableRatio * 100);
  const lines: string[] = [
    `Ran ${report.testId} ${report.runs}x — ${report.passed} passed, ${report.failed} failed → ` +
      `${verdictLabel(report.verdict)} (${pct}% stable)`,
  ];
  if (report.failures.length > 0) {
    lines.push('  failed attempts:');
    for (const f of report.failures) {
      const kind = f.failureKind ? ` failureKind=${f.failureKind}` : '';
      const rid = f.runId ?? '(no runId)';
      lines.push(`    #${f.attempt}  ${rid}  ${f.outcome}${kind}`);
    }
  }
  return lines.join('\n');
}
