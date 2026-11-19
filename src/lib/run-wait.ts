/**
 * Waiting on one run: re-read `GET /results?run=<runId>` every 3 s until the
 * server says the run has finished or the deadline passes, the way the Portal
 * polls one run. One request per read, whatever the run's size.
 *
 * The run's own `status`, not its results, says when it is done: a backend
 * run adds its integration results after its wave has settled, so "every
 * listed result has settled" can be true while the run still has work to
 * add. A listing without the run is from a server older than this CLI, and
 * the wait refuses it rather than guess.
 *
 * The waiter reports; it never prints or picks an exit code. Its outcome
 * says how the wait ended (`timedOut`, `error`) and holds the results as last
 * listed. {@link resolveRunWaitFailure} judges one or more outcomes the way
 * every `--wait` judges its results, including an ending no result carries (a
 * run that timed out, or a listing that failed, after every listed result had
 * settled); {@link toWaitMembers} gives the per-result rows it judges.
 *
 * Reads:
 *  - An outage (UNAVAILABLE) or a throttle (RATE_LIMITED) is read through
 *    until the deadline, from the first read on: the run keeps executing
 *    server-side. An outage still on at the deadline is the outcome's
 *    `error` (exit 10); a throttle still on is a plain timeout (exit 7). A
 *    429 for a standing condition (`isStandingRateLimit`) is no throttle and
 *    ends the wait like any other error.
 *  - A server error (INTERNAL) is read again once, as the run poller does.
 *  - Until a read has been answered, any other error is thrown as it is (a
 *    second server error in a row too): a 404 with `details.resource` is a
 *    run the server does not know, one without is a server without the
 *    route. A 404 is thrown even on the read at the deadline.
 *  - Once a read has been answered, a second server error in a row, or any
 *    other `ApiError`, ends the wait as the outcome's `error`.
 *  - An interrupt (`InterruptError`), an abort of `signal`, and anything that
 *    is not an `ApiError` (a per-request timeout, say) are thrown as they are.
 *
 * The deadline runs on timers set once per wait: one at the deadline ends the
 * sleep between reads, and one a grace later cuts a read still in flight.
 * After the deadline the waiter reads once more, one attempt within that
 * grace, so a result that finished during the last sleep gets its verdict.
 * That read can only bring verdicts: if it fails, the wait ends as it stood
 * (only a 404 before any answered read, or the failure of a first read made
 * at the deadline, is thrown).
 * A read cut by the grace (one in flight, or in the HTTP client's own retry
 * back-off) ends the wait with no read after it.
 *
 * The shutdown scope is armed for the whole wait, the sleeps and `onRead`
 * included, so a Ctrl-C between reads ends the wait at once instead of killing
 * the process.
 */

import { ApiError, CLIError, InterruptError } from './errors.js';
import { isStandingRateLimit, type HttpClient } from './http.js';
import type { ShutdownHandle } from './interrupt.js';
import { defaultSleep, isAbortError, sleepUnlessInterrupted } from './poll-support.js';
import { resultApi } from './result/api.js';
import {
  ALL_RESULT_STATUSES,
  isResultRunning,
  type ResultLine,
  type ResultList,
  type ResultRun,
} from './result/types.js';
import { launchIds } from './run-render.js';
import {
  resolveWaitFailure,
  unfinishedHint,
  WAIT_EXIT_PRIORITY,
  waitMemberError,
  type WaitMemberResult,
} from './wait-exit.js';

/** Time between two reads of a run. */
export const RUN_POLL_INTERVAL_MS = 3_000;

/**
 * How long past the deadline a read may still be answered: the read the
 * waiter makes at the deadline, or one already in flight then.
 */
export const RUN_WAIT_READ_GRACE_MS = 2_000;

/** One read of the run: the run and its results in scope, oldest first. */
export interface RunWaitSnapshot {
  run: ResultRun;
  results: ResultLine[];
}

export interface RunWaitOptions {
  /** When the wait gives up, in epoch ms: the command's one deadline. */
  deadline: number;
  /**
   * The command's shutdown handle. The wait arms it for its whole length, and
   * an interrupt ends the wait with its `InterruptError`.
   */
  shutdown?: ShutdownHandle;
  /**
   * Ends the wait at once when it aborts, with its reason thrown as it is (an
   * interrupt still outranks it): a reason the caller has for stopping, such
   * as a tunnel it found gone.
   */
  signal?: AbortSignal;
  /**
   * Wait only on these results of the run (a run another command started and
   * this one joined): the others are neither reported nor waited on, and the
   * wait ends once these have settled, or when the run finishes. Must name at
   * least one result. The outcome is then marked `joined`.
   */
  onlyResultIds?: readonly string[];
  /** Called once per result when it is first listed settled, a result first listed settled included. */
  onSettled?: (line: ResultLine) => void;
  /**
   * Called after every read the server answered, after that read's
   * `onSettled` calls, with its own copy of the results; the wait awaits it
   * before it sleeps, so its time adds to the interval. It runs on the read
   * that ends the wait too (the run finished, or the read at the deadline), so
   * a hook that throws there turns that ending into its error. `signal`
   * aborts on an interrupt, on the caller's `signal`, and when the deadline's
   * grace ends, not at the deadline itself. A throw ends the wait with that
   * error, thrown as it is (an interrupt or the caller's abort with their own
   * reasons); an abort at the end of the grace ends it on that read instead,
   * as a timeout unless the read finished the wait.
   */
  onRead?: (snapshot: RunWaitSnapshot, signal: AbortSignal) => void | Promise<void>;
  /** Where a `--debug` line goes. */
  debug?: (line: string) => void;
  /** Injectable sleep; defaults to a timer that ends when its signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RunWaitOutcome {
  /** The run waited on. */
  runId: string;
  /** The run as last read; null when no read was answered before the deadline. */
  run: ResultRun | null;
  /** The results in scope as last listed, oldest first. */
  results: ResultLine[];
  /** Results `onlyResultIds` names that the listing never showed. */
  missingResultIds: string[];
  /** The deadline passed before the run finished (or before the given results settled). */
  timedOut: boolean;
  /**
   * The wait was given `onlyResultIds`: the run is one this command joined and
   * did not start, so cancelling it stops tests it did not start.
   */
  joined?: true;
  /**
   * The listing error that ended the wait, or the outage still on at the
   * deadline. Absent when the wait ended on the run or on a plain timeout.
   */
  error?: ApiError;
}

/**
 * Wait on run `runId` until the server reports it finished (or, with
 * `onlyResultIds`, until those results have settled), or until the deadline.
 *
 * @throws An error before any read was answered, as it is, unless it is an
 *   outage, a throttle, or a first server error.
 * @throws `ApiError` UNSUPPORTED (exit 7) when a listing has no run object
 *   (the server is older than this CLI) or one without a readable `runId` and
 *   `status`.
 * @throws `InterruptError` on an interrupt, marked as a run wait's.
 * @throws The reason of `signal` when it aborts, and whatever `onRead` throws.
 */
export async function waitForRun(
  client: HttpClient,
  runId: string,
  opts: RunWaitOptions,
): Promise<RunWaitOutcome> {
  if (opts.onlyResultIds !== undefined && opts.onlyResultIds.length === 0) {
    throw new Error('waitForRun: onlyResultIds names no result');
  }
  const disarm = opts.shutdown?.arm();
  try {
    return await readUntilDone(client, runId, opts);
  } catch (err) {
    if (err instanceof InterruptError && opts.shutdown?.signal.aborted) {
      err.runWaitContext = true;
    }
    throw err;
  } finally {
    disarm?.();
  }
}

async function readUntilDone(
  client: HttpClient,
  runId: string,
  opts: RunWaitOptions,
): Promise<RunWaitOutcome> {
  const api = resultApi(client);
  const shutdownSignal = opts.shutdown?.signal;
  const callerSignal = opts.signal;
  const sleep = opts.sleep ?? defaultSleep;
  const only = opts.onlyResultIds !== undefined ? new Set(opts.onlyResultIds) : undefined;

  // One deadline, one grace, and their composed signals per wait, reused by
  // every read and every sleep.
  const remainingMs = Math.max(0, opts.deadline - Date.now());
  const deadline = new AbortController();
  const grace = new AbortController();
  const deadlineTimer = Number.isFinite(remainingMs)
    ? setTimeout(() => deadline.abort(), remainingMs)
    : undefined;
  const graceTimer = Number.isFinite(remainingMs)
    ? setTimeout(() => grace.abort(), remainingMs + RUN_WAIT_READ_GRACE_MS)
    : undefined;
  const withEnds = (timer: AbortSignal): AbortSignal => {
    const sources = [timer, shutdownSignal, callerSignal].filter(
      (source): source is AbortSignal => source !== undefined,
    );
    return sources.length === 1 ? timer : AbortSignal.any(sources);
  };
  const readSignal = withEnds(grace.signal);
  const sleepSignal = withEnds(deadline.signal);
  const pastDeadline = (): boolean => deadline.signal.aborted || Date.now() >= opts.deadline;

  /** An interrupt, then the caller's abort, ends the wait with its own reason. */
  const throwIfEnded = (): void => {
    if (shutdownSignal?.aborted) throw shutdownSignal.reason;
    if (callerSignal?.aborted) throw callerSignal.reason;
  };

  /** Sleep `ms`, or less when the deadline comes first. */
  const pause = async (ms: number): Promise<void> => {
    try {
      const clamped = Math.max(0, Math.min(ms, opts.deadline - Date.now()));
      await sleepUnlessInterrupted(sleep, clamped, sleepSignal);
    } catch (err) {
      throwIfEnded();
      if (deadline.signal.aborted) return;
      throw err;
    }
  };

  let run: ResultRun | null = null;
  let results: ResultLine[] = [];
  // The last read's failure, and how many reads in a row failed with a
  // server error; both cleared by a read the server answered.
  let lastFailure: ApiError | undefined;
  let serverErrors = 0;
  const settled = new Set<string>();

  const outcome = (timedOut: boolean): RunWaitOutcome => {
    const listed = new Set(results.map(line => line.resultId));
    // At the deadline only an outage is reported: a throttle or a server
    // error read again is a plain timeout.
    const error = !timedOut || lastFailure?.code === 'UNAVAILABLE' ? lastFailure : undefined;
    return {
      runId,
      run,
      results,
      missingResultIds: [...(only ?? [])].filter(resultId => !listed.has(resultId)),
      timedOut,
      ...(only !== undefined ? { joined: true as const } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  };

  const done = (current: ResultRun): boolean => {
    if (current.status === 'finished') return true;
    if (only === undefined) return false;
    const byId = new Map(results.map(line => [line.resultId, line]));
    return [...only].every(resultId => {
      const line = byId.get(resultId);
      return line !== undefined && !isResultRunning(line.testStatus);
    });
  };

  try {
    for (;;) {
      throwIfEnded();
      const final = pastDeadline();
      let listed: ResultList;
      try {
        // The read at the deadline is one attempt: a retry would spend the grace waiting.
        listed = await api.listByRun(runId, ALL_RESULT_STATUSES, {
          signal: readSignal,
          retry: final ? false : undefined,
        });
      } catch (err) {
        if (err instanceof InterruptError) throw err;
        throwIfEnded();
        // Cut at the end of the grace: the wait ends on what it read before.
        if (isAbortError(err) && grace.signal.aborted) return outcome(true);
        if (!(err instanceof ApiError)) throw err;
        // A 429 for a standing condition (a cap the caller must free) is no
        // passing throttle: waiting cannot clear it. (This read charges
        // nothing, so it never answers with a credit-depletion 429.)
        const transient =
          err.code === 'UNAVAILABLE' || (err.code === 'RATE_LIMITED' && !isStandingRateLimit(err));
        const unread = run === null;
        // No read has shown the run: a 404 says it does not exist, even at the deadline.
        if (unread && err.code === 'NOT_FOUND') throw err;
        if (final) {
          // A first read made at the deadline keeps the first read's rule.
          if (unread && lastFailure === undefined && !transient) throw err;
          // Otherwise the read at the deadline only brings verdicts: its
          // failure changes nothing, and an outage before it stays the outcome's.
          return outcome(true);
        }
        const readAgain = transient || (err.code === 'INTERNAL' && serverErrors === 0);
        if (err.code === 'INTERNAL') serverErrors += 1;
        if (!readAgain && unread) throw err;
        lastFailure = err;
        if (!readAgain) return outcome(false);
        await pause(Math.max(RUN_POLL_INTERVAL_MS, err.retryAfterMs ?? 0));
        continue;
      }
      if (listed.run === undefined) throw serverTooOld();
      if (listed.run === null) {
        opts.debug?.(
          `The listing of run ${runId} has a run object without a readable runId and status.`,
        );
        throw unreadableRun(runId);
      }
      lastFailure = undefined;
      serverErrors = 0;
      run = listed.run;
      results = inOrder(
        only === undefined
          ? listed.results
          : listed.results.filter(line => only.has(line.resultId)),
      );
      for (const line of results) {
        if (isResultRunning(line.testStatus) || settled.has(line.resultId)) continue;
        settled.add(line.resultId);
        opts.onSettled?.(line);
      }
      if (opts.onRead !== undefined) {
        try {
          await opts.onRead({ run, results: [...results] }, readSignal);
        } catch (err) {
          throwIfEnded();
          // Cut by the deadline grace: the wait ends on this read, as on a read cut there.
          if (isAbortError(err) && grace.signal.aborted) return outcome(!done(run));
          throw err;
        }
      }
      if (done(run)) return outcome(false);
      if (final) return outcome(true);
      await pause(RUN_POLL_INTERVAL_MS);
    }
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(graceTimer);
  }
}

/** Oldest first, then by id: the server lists newest first. */
function inOrder(lines: readonly ResultLine[]): ResultLine[] {
  return [...lines].sort(
    (a, b) =>
      Date.parse(a.created) - Date.parse(b.created) ||
      (a.resultId < b.resultId ? -1 : a.resultId > b.resultId ? 1 : 0),
  );
}

/** Exit 7: the listing has no run object, so the server cannot say when a run has finished. */
function serverTooOld(): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'UNSUPPORTED',
      message: 'This server does not say whether a run has finished, which waiting on a run needs.',
      nextAction:
        'The TestSprite service is older than this CLI: stay on CLI 0.16 until it is updated.',
      requestId: 'local',
      details: { reason: 'run_status_missing' },
    },
  });
}

/** Exit 7: the listing has a run object, but not one whose `runId` and `status` can be read. */
function unreadableRun(runId: string): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'UNSUPPORTED',
      message: `Whether run ${runId} has finished could not be read from the server's answer.`,
      nextAction:
        'Run the command again with --debug; if it persists, report it to support@testsprite.com.',
      requestId: 'local',
      details: { reason: 'run_status_unreadable', runId },
    },
  });
}

/** Results the CLI cancelled itself; see {@link RunWaitJudgeOptions.cancelledResultIds}. */
type CancelledResultIds = readonly string[] | ReadonlySet<string>;

/**
 * The rows `resolveWaitFailure` judges, one per result in the outcome:
 *  - a settled result has its status, lower-cased (`passed`, `failed`, …);
 *  - a result still running has the outcome's `error` when there is one,
 *    `timeout` when the wait timed out, and otherwise `running` (a finished
 *    run with a result still running, which is not a pass);
 *  - a given result the listing never showed is a timeout or the outcome's
 *    error like a running one, and NOT_FOUND (exit 4) when the run finished
 *    without it;
 *  - a result in `cancelledResultIds` that the listing does not show with a
 *    verdict (it reads cancelled, still running, or not at all) timed out and
 *    was cancelled (`cancel: 'cancelled'`).
 *
 * Rows carry the result id as `resultId` and the execution as `runId`, the names
 * `WaitMemberResult` reads them by, and `joined` when the outcome is. An
 * ending no row carries is judged by {@link resolveRunWaitFailure}, not here.
 */
export function toWaitMembers(
  outcome: RunWaitOutcome,
  opts: { cancelledResultIds?: CancelledResultIds } = {},
): Array<WaitMemberResult & { resultId: string; runId: string }> {
  const cancelled = new Set(opts.cancelledResultIds ?? []);
  const ids = (resultId: string) => ({
    resultId,
    runId: outcome.runId,
    ...(outcome.joined ? { joined: true } : {}),
  });
  const cancelledByCli = { status: 'timeout', cancel: 'cancelled' } as const;
  const unfinished = (): Pick<WaitMemberResult, 'status' | 'error'> | undefined =>
    outcome.error !== undefined
      ? { status: 'error', error: waitMemberError(outcome.error) }
      : outcome.timedOut
        ? { status: 'timeout' }
        : undefined;
  const listed = outcome.results.map(line => {
    const running = isResultRunning(line.testStatus);
    const verdict = !running && line.testStatus.toUpperCase() !== 'CANCELLED';
    return {
      ...ids(line.resultId),
      ...(line.caseKey !== null ? { testId: line.caseKey } : {}),
      ...(cancelled.has(line.resultId) && !verdict
        ? cancelledByCli
        : running
          ? (unfinished() ?? { status: 'running' })
          : { status: line.testStatus.toLowerCase() }),
    };
  });
  const missing = outcome.missingResultIds.map(resultId => ({
    ...ids(resultId),
    ...(cancelled.has(resultId)
      ? cancelledByCli
      : (unfinished() ?? {
          status: 'error',
          error: waitMemberError(notInRun(resultId, outcome.runId)),
        })),
  }));
  return [...listed, ...missing];
}

/** Exit 4: a result the wait was given that its finished run never listed. */
function notInRun(resultId: string, runId: string): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'NOT_FOUND',
      message: `result ${resultId} is not in run ${runId}`,
      nextAction: '',
      requestId: 'local',
      details: { resource: 'result', resultId, runId },
    },
  });
}

/** Where an exit code stands in the wait precedence; a code outside it is a generic failure. */
function rank(exitCode: number): number {
  const at = (WAIT_EXIT_PRIORITY as readonly number[]).indexOf(exitCode);
  return at === -1 ? (WAIT_EXIT_PRIORITY as readonly number[]).indexOf(1) : at;
}

export interface RunWaitJudgeOptions {
  timeoutSeconds: number;
  /**
   * Results the CLI cancelled itself when it stopped waiting for them (an
   * owned tunnel's per-test timeout). Each timed out and was cancelled unless
   * the listing shows it with a verdict, so the hints look it up by itself
   * instead of offering to resume it, as for any result the CLI cancelled.
   */
  cancelledResultIds?: CancelledResultIds;
}

/**
 * The failure a command exits with after waiting on these runs, or null when
 * every run finished and every result in them passed. The rows
 * ({@link toWaitMembers}) are judged by `resolveWaitFailure`, and with them,
 * by the same precedence, each run's own ending that no row carries:
 *  - a listing error after every listed result had settled (or before any
 *    was read) is that error, as it is: no result failed;
 *  - a run that timed out with no result still running (every listed one had
 *    settled, or none was ever read) is a timeout (exit 7), which outranks
 *    only a generic failure. One timeout names every run left unfinished.
 * On a tie the run's own ending wins: it says why the wait stopped. An outage
 * (exit 10) re-attaches to every result and run left unfinished.
 */
export function resolveRunWaitFailure(
  outcomes: readonly RunWaitOutcome[],
  opts: RunWaitJudgeOptions,
  requestFailure?: CLIError,
): CLIError | ApiError | null {
  const cancelledResultIds = new Set(opts.cancelledResultIds ?? []);
  const rows: WaitMemberResult[] = [];
  // A request timeout competes with completed sibling reads under the same
  // precedence; it must not mask an authorization or transport refusal.
  const runErrors: (CLIError | ApiError)[] = requestFailure ? [requestFailure] : [];
  // Runs left unfinished with no row to say so: timed out, or cut off by an outage.
  const unfinishedRuns: WaitMemberResult[] = [];
  for (const outcome of outcomes) {
    const members = toWaitMembers(outcome, { cancelledResultIds });
    rows.push(...members);
    // Cancellation can end an execution between unit and integration phases,
    // with every existing result passed. Borrowed subsets own only their results.
    if (outcome.run?.cancelled === true && !outcome.joined) {
      runErrors.push(new CLIError(`Run ${outcome.runId} was cancelled.`, 1));
    }
    const run: WaitMemberResult = {
      runId: outcome.runId,
      ...(outcome.joined ? { joined: true } : {}),
      status: 'timeout',
    };
    if (outcome.error !== undefined) {
      runErrors.push(outcome.error);
      if (outcome.error.code === 'UNAVAILABLE') {
        unfinishedRuns.push({ ...run, status: 'error', error: waitMemberError(outcome.error) });
      }
    } else if (
      outcome.timedOut &&
      !members.some(row => row.status === 'timeout' || row.status === 'error')
    ) {
      unfinishedRuns.push(run);
    }
  }
  const failure = resolveWaitFailure(rows, opts);
  if (runErrors.length === 0 && unfinishedRuns.length === 0) return failure;
  const timedOutRuns = unfinishedRuns.filter(run => run.status === 'timeout');
  const candidates: (CLIError | ApiError)[] = [
    ...(failure !== null ? [failure] : []),
    ...runErrors,
    ...(timedOutRuns.length > 0
      ? [runsTimedOut(failure, rows, timedOutRuns, opts.timeoutSeconds)]
      : []),
  ];
  const chosen = candidates.reduce((best, next) =>
    rank(next.exitCode) <= rank(best.exitCode) ? next : best,
  );
  return chosen;
}

/**
 * Exit 7 for runs that did not finish in time: the results that timed out,
 * whose own timeout (`rowFailure`, when it is one) speaks first, and the runs
 * that timed out with none of theirs still running. Its details and hint are
 * those of `resolveWaitFailure`'s own timeout, over both.
 */
function runsTimedOut(
  rowFailure: CLIError | ApiError | null,
  rows: readonly WaitMemberResult[],
  timedOutRuns: readonly WaitMemberResult[],
  timeoutSeconds: number,
): ApiError {
  const timedOutRows = rows.filter(row => row.status === 'timeout');
  const unfinished = [...timedOutRows, ...timedOutRuns];
  const runIds = launchIds(unfinished.filter(row => row.cancel !== 'cancelled'));
  const resultIds = timedOutRows
    .map(row => row.resultId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const named = timedOutRuns.map(run => run.runId).join(', ');
  const runs = `${timedOutRuns.length === 1 ? 'Run' : 'Runs'} ${named} had not finished when the --timeout ended.`;
  return ApiError.fromEnvelope({
    error: {
      code: 'UNSUPPORTED',
      message:
        timedOutRows.length > 0 && rowFailure?.exitCode === 7
          ? `${rowFailure.message} ${runs}`
          : runs,
      nextAction: unfinishedHint(unfinished),
      requestId: 'local',
      details: {
        runId: runIds.length === 1 ? runIds[0]! : null,
        runIds,
        timedOutResultIds: resultIds,
        timeoutSeconds,
      },
    },
  });
}
