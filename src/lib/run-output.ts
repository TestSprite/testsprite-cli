import { InterruptError, RequestTimeoutError } from './errors.js';
import { formatFailureCounts, summarizeRunRows, type CiSummary } from './gh-output.js';
import { ALL_RESULT_STATUSES, isResultRunning, type ResultRun } from './result/types.js';
import type { ProjectRunResponse } from './runs.types.js';
import type { CliTestListRunAccepted } from './testlist.types.js';
import { toWaitMembers, type RunWaitOutcome } from './run-wait.js';
import { waitCommand } from './run-render.js';
import { terminalSafeLine } from './terminal-text.js';
import { waitMemberError, type WaitMemberResult } from './wait-exit.js';

export type RunReceipt = { runId: string } & Partial<ResultRun> &
  Partial<Omit<ProjectRunResponse, keyof ResultRun>> & { joined?: boolean; cancel?: string };

interface RunMember extends WaitMemberResult {
  resultId: string;
  title?: string;
  enqueuedAt?: string;
  createdAt?: string;
  dashboardUrl?: string;
  executionUrl?: string;
}

export type RunResult = Omit<RunMember, 'error'> & {
  error?: string;
  errorCode?: string;
};

interface RunOutputOptions {
  receipts: readonly RunReceipt[];
  outcomes?: ReadonlyMap<string, RunWaitOutcome>;
  joinedScopes?: ReadonlyMap<string, readonly string[] | undefined>;
  /** Results known at dispatch, including list members that have not been listed yet. */
  dispatched?: readonly RunMember[];
  buckets?: Parameters<typeof summarizeRunRows>[1];
  notFoundNote?: string;
  foldSkippedBuckets?: boolean;
  wait: boolean;
  failure?: unknown;
  requestTimedOut?: boolean;
  incompleteDispatch?: boolean;
  cancellation?: (runId: string) => string | undefined;
}

/** Normalize the saved-list wire receipt before combining it with listed results. */
export function listResultReceipt(row: CliTestListRunAccepted): RunMember {
  return {
    testId: row.testId,
    resultId: row.resultId,
    runId: row.runId,
    enqueuedAt: row.enqueuedAt,
    status: 'dispatched',
    ...(typeof row.testTitle === 'string' ? { title: row.testTitle } : {}),
    ...(typeof row.dashboardUrl === 'string' ? { dashboardUrl: row.dashboardUrl } : {}),
    ...(typeof row.executionUrl === 'string' ? { executionUrl: row.executionUrl } : {}),
  };
}

function runDiagnostic(outcome: RunWaitOutcome, statuses: ReadonlySet<string> | undefined) {
  const { runId } = outcome;
  if (outcome.run?.cancelled && !outcome.joined)
    return {
      runId,
      status: 'cancelled' as const,
      error: { code: 'RUN_CANCELLED', message: `Run ${runId} was cancelled.`, exitCode: 1 },
    };
  if (outcome.error && !statuses?.has('error'))
    return { runId, status: 'error' as const, error: waitMemberError(outcome.error) };
  if (outcome.timedOut && !outcome.error && !statuses?.has('timeout'))
    return {
      runId,
      status: 'timeout' as const,
      error: {
        code: 'TIMEOUT',
        message: `Run ${runId} did not finish before the deadline.`,
        exitCode: 7,
      },
    };
  return undefined;
}

function resultErrorCode(status: string): string {
  switch (status) {
    case 'failed':
      return 'TEST_FAILED';
    case 'blocked':
      return 'TEST_BLOCKED';
    case 'cancelled':
      return 'TEST_CANCELLED';
    default:
      return 'RESULT_ERROR';
  }
}

/** Project launches, saved lists and reattached waits share one native output contract. */
export function buildRunOutput(opts: RunOutputOptions) {
  const outcomes = opts.outcomes ?? new Map<string, RunWaitOutcome>();
  const runs = opts.receipts.map(receipt => {
    const outcome = outcomes.get(receipt.runId);
    const cancel = opts.cancellation?.(receipt.runId);
    return {
      ...outcome?.run,
      ...receipt,
      ...(outcome?.run ? { status: outcome.run.status, cancelled: outcome.run.cancelled } : {}),
      ...(opts.wait && !outcome?.run ? { listed: false } : {}),
      ...(outcome?.timedOut ? { timedOut: true } : {}),
      ...(outcome?.error ? { error: waitMemberError(outcome.error) } : {}),
      ...(cancel ? { cancel } : {}),
    };
  });

  const receipts = new Map(opts.dispatched?.map(row => [row.resultId, row]));
  const observed: RunMember[] = [];
  for (const outcome of outcomes.values()) {
    const lines = new Map(outcome.results.map(line => [line.resultId, line]));
    const cancel = opts.cancellation?.(outcome.runId);
    for (const member of toWaitMembers(outcome)) {
      const line = lines.get(member.resultId);
      const receipt = receipts.get(member.resultId);
      const receiptError = receipt?.status === member.status ? receipt.error : undefined;
      const detail = line?.error || (member.status === 'blocked' ? line?.blockedReason : null);
      const error =
        member.error ??
        (detail
          ? {
              code: receiptError?.code ?? resultErrorCode(member.status),
              message: detail,
              exitCode: 1,
            }
          : receiptError);
      observed.push({
        ...receipt,
        ...member,
        ...(line ? { title: line.title, createdAt: line.created } : {}),
        error,
        ...(cancel ? { cancel } : {}),
      });
      receipts.delete(member.resultId);
    }
  }
  for (const row of receipts.values()) {
    const outcome = row.runId ? outcomes.get(row.runId) : undefined;
    const cancel = row.runId ? opts.cancellation?.(row.runId) : undefined;
    observed.push({
      ...row,
      ...(opts.wait && row.status === 'dispatched'
        ? { status: outcome?.timedOut ? 'timeout' : 'running' }
        : {}),
      ...(cancel ? { cancel } : {}),
    });
  }

  const results: RunResult[] = observed.map(({ error, ...row }) => ({
    ...row,
    ...(error ? { error: error.message, errorCode: error.code } : {}),
  }));
  const statusesByRun = new Map<string, Set<string>>();
  for (const row of results) {
    if (!row.runId) continue;
    const statuses = statusesByRun.get(row.runId) ?? new Set<string>();
    statuses.add(row.status);
    statusesByRun.set(row.runId, statuses);
  }
  const diagnosticRows = [...outcomes.values()].flatMap(outcome => {
    const row = runDiagnostic(outcome, statusesByRun.get(outcome.runId));
    return row ? [{ ...row, testId: `(run ${row.runId})`, name: row.error.message }] : [];
  });
  const members = observed.map(row => ({
    ...row,
    testId: row.testId ?? '(integration)',
    name: row.title,
  }));
  const summary = summarizeRunRows(results, opts.buckets, {
    notFoundNote: opts.notFoundNote,
    foldSkippedBuckets: opts.foldSkippedBuckets,
  });
  if (diagnosticRows.length)
    summary.runFailures = diagnosticRows.map(({ runId, status, error }) => ({
      runId,
      status,
      message: error.message,
    }));

  const stopped =
    opts.failure instanceof InterruptError ||
    opts.failure instanceof RequestTimeoutError ||
    opts.requestTimedOut;
  const incompleteWait = (run: RunReceipt) => {
    if (run.status === 'finished' || outcomes.get(run.runId)?.error?.code === 'NOT_FOUND')
      return false;
    const joinedIds = opts.joinedScopes?.get(run.runId);
    if (!joinedIds) return true;
    const settled = new Set(
      outcomes
        .get(run.runId)
        ?.results.filter(line => !isResultRunning(line.testStatus))
        .map(line => line.resultId),
    );
    return joinedIds.some(id => !settled.has(id));
  };
  const unfinishedRuns = runs.filter(incompleteWait);
  const partial =
    [...outcomes.values()].some(outcome => outcome.timedOut) ||
    (stopped && (opts.incompleteDispatch || (opts.wait && unfinishedRuns.length > 0)));

  return {
    output: {
      runs,
      results,
      ...(opts.wait ? { summary: runCounts(summary) } : {}),
      ...(summary.runFailures ? { runFailures: summary.runFailures } : {}),
      ...(partial ? { partial: true as const } : {}),
    },
    summary,
    members,
    // JUnit needs a synthetic testcase only when no result already reports this failure.
    diagnosticRows: diagnosticRows.filter(row => !statusesByRun.get(row.runId)?.has(row.status)),
    unfinishedRuns,
  };
}

export type RunCounts = Omit<CiSummary, 'results' | 'runFailures' | 'executionReport'>;
export function runCounts({
  results: _results,
  runFailures: _runFailures,
  executionReport: _executionReport,
  ...counts
}: CiSummary): RunCounts {
  return counts;
}

/** The poll descriptor used by all run previews. Only supplied ids need escaping. */
export function runListingPath(runId?: string): string {
  return `/api/cli/v1/results?run=${runId === undefined ? '<run-id>' : encodeURIComponent(runId)}&status=${ALL_RESULT_STATUSES.join(',')}`;
}

export function previewRun(
  requests: Array<{
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    idempotencyKey?: string;
  }>,
  wait: boolean,
  thenPoll = false,
) {
  const { output } = buildRunOutput({ receipts: [], wait });
  return { ...output, dryRun: true, requests, ...(thenPoll ? { thenPoll: runListingPath() } : {}) };
}

function renderRunCounts(summary: CiSummary): string {
  return [
    `${summary.passed}/${summary.total} passed`,
    formatFailureCounts(summary),
    `${summary.timedOut} timed out`,
    ...(summary.running ? [`${summary.running} still running`] : []),
    ...(summary.skipped ? [`${summary.skipped} not dispatched`] : []),
  ].join(', ');
}

export function renderRunResults(
  runs: readonly RunReceipt[],
  results: readonly RunResult[],
  summary?: CiSummary,
  notes: readonly string[] = [],
): string {
  const rows = new Map<string | undefined, string[]>();
  for (const result of results) {
    const group = rows.get(result.runId) ?? [];
    group.push(
      `  ${terminalSafeLine(result.resultId)}  ${terminalSafeLine(result.title?.trim() || result.testId || '-')}  ${terminalSafeLine(result.status)}`,
    );
    rows.set(result.runId, group);
  }
  const wait = summary ? undefined : waitCommand(runs.filter(run => !run.joined));
  const lines = runs.flatMap(run => {
    const members = rows.get(run.runId) ?? [];
    const count = run.total ?? members.length;
    const header = [
      `Run ${terminalSafeLine(run.runId)}${run.cancelled ? ' — cancelled' : ''}`,
      ...(run.targetUrl ? [terminalSafeLine(run.targetUrl)] : []),
      ...(!summary ? [`(${count} test${count === 1 ? '' : 's'})`] : []),
    ].join('  ');
    return [
      header,
      ...members,
      // The run's page in the Portal, on a launch receipt and a waited card alike.
      ...(run.dashboardUrl ? [`  Dashboard: ${terminalSafeLine(run.dashboardUrl)}`] : []),
    ];
  });
  lines.push(...(rows.get(undefined) ?? []));
  for (const failure of summary?.runFailures ?? []) lines.push(terminalSafeLine(failure.message));
  lines.push(...notes);
  if (summary) lines.push(renderRunCounts(summary));
  if (wait) lines.push(wait);
  return lines.length ? lines.join('\n') : 'No runs dispatched.';
}
