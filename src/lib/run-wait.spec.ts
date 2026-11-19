import { afterEach, describe, expect, it, vi } from 'vitest';
import { onFakeTimers } from '../../test/helpers/fake-timers.js';
import { resultLine } from '../../test/helpers/result-list.js';
import { ApiError, CLIError, InterruptError } from './errors.js';
import { HttpClient, type FetchImpl } from './http.js';
import { ShutdownController } from './interrupt.js';
import { defaultSleep } from './poll-support.js';
import type { ResultLine, ResultRun } from './result/types.js';
import {
  RUN_POLL_INTERVAL_MS,
  resolveRunWaitFailure,
  toWaitMembers,
  waitForRun,
  type RunWaitOptions,
  type RunWaitOutcome,
} from './run-wait.js';
import { resolveWaitFailure } from './wait-exit.js';

const BASE = 'https://api.example.com/api/cli/v1';

/** The run `runId` as its listing names it. */
function runOf(status: ResultRun['status'], runId = 'e1'): ResultRun {
  return {
    runId,
    projectId: 'p1',
    status,
    cancelled: false,
    created: '2026-11-13T08:00:00.000Z',
    modified: '2026-11-13T08:00:00.000Z',
    targetUrl: 'https://staging.example.com',
    dashboardUrl: null,
  };
}

/** A result of run `runId`; `minute` orders it: the server lists newest first. */
function line(resultId: string, testStatus: string, minute = 0, runId = 'e1'): ResultLine {
  const at = `2026-11-13T08:0${minute}:00.000Z`;
  return resultLine({
    resultId,
    runId,
    caseKey: `case_${resultId}`,
    testStatus,
    processStatus: testStatus === 'RUNNING' ? 'Executing' : 'Idle',
    created: at,
    modified: at,
  });
}

/** A run's listing, newest first as the server sends it. */
function listing(status: ResultRun['status'], lines: ResultLine[]): Answer {
  return { body: { run: runOf(status), results: [...lines].reverse() } };
}

function failure(
  status: number,
  code: string,
  details: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Answer {
  return {
    status,
    headers,
    body: { error: { code, message: `${code} from the server`, requestId: 'req_1', details } },
  };
}

type Answer =
  /** `delayMs`: answered that long after it was sent. */
  | { body: unknown; status?: number; headers?: Record<string, string>; delayMs?: number }
  /** The request is never answered; it ends only when its signal aborts. */
  | 'hang';

/** `answer`, sent `delayMs` after the request. */
function delayed(answer: Answer, delayMs: number): Answer {
  return answer === 'hang' ? answer : { ...answer, delayMs };
}

/** Resolve after `ms` of fake time, or reject with the signal's reason when it aborts first. */
function after(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return defaultSleep(ms, signal ?? undefined);
}

/**
 * A server that answers request n with `answers[n]` (the last one from then
 * on) and records each request: its query and when, in fake time since the
 * wait began, it was sent.
 */
function serverAnswering(answers: Answer[], opts: { clientSleep?: 'instant' | 'timers' } = {}) {
  const requests: { at: number; query: URLSearchParams; path: string }[] = [];
  let startedAt = 0;
  const fakeNow = (): number => vi.getMockedSystemTime()?.getTime() ?? Date.now();
  const fetchImpl: FetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({
      at: fakeNow() - startedAt,
      query: url.searchParams,
      path: url.pathname.slice(new URL(BASE).pathname.length),
    });
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)]!;
    if (answer === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    if (answer.delayMs !== undefined) await after(answer.delayMs, init.signal);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json', ...answer.headers },
    });
  };
  const client = new HttpClient({
    baseUrl: BASE,
    apiKey: 'sk-user-abc',
    fetchImpl,
    // By default the client's own retry back-off takes no time, so the
    // waiter's pace is what is measured; `timers` puts it on the fake clock.
    sleep: opts.clientSleep === 'timers' ? defaultSleep : () => Promise.resolve(),
    random: () => 0,
  });
  return {
    client,
    requests,
    /** When the requests were sent, in ms since the wait began. */
    times: () => requests.map(request => request.at),
    /** Call when the wait begins. */
    start: () => {
      startedAt = fakeNow();
    },
  };
}

/** How many timers the last wait on fake timers left behind; checked after every spec. */
let timersLeft: number | undefined;
afterEach(() => {
  const left = timersLeft;
  timersLeft = undefined;
  if (left !== undefined) expect(left, 'timers the wait left behind').toBe(0);
});

/**
 * Run `work` on fake timers and count the timers it leaves behind. `clock`
 * says what `Date.now()` reads: the fake clock (`fake`, so a deadline set from
 * it falls exactly where the timers put it), or whatever the spec spies on.
 */
function onFakeClock<T>(work: () => Promise<T>, clock: 'fake' | 'spec' = 'fake'): Promise<T> {
  return onFakeTimers(async () => {
    const spy =
      clock === 'fake'
        ? vi.spyOn(Date, 'now').mockImplementation(() => vi.getMockedSystemTime()!.getTime())
        : undefined;
    try {
      return await work();
    } finally {
      timersLeft = vi.getTimerCount();
      spy?.mockRestore();
    }
  });
}

/** Judge outcomes the way a command does, with a 60 s `--timeout`. */
const judge = (...outcomes: RunWaitOutcome[]) =>
  resolveRunWaitFailure(outcomes, { timeoutSeconds: 60 });

/** Wait on run `e1` on the fake clock, with the deadline `deadlineInMs` from now. */
async function waitOn(
  server: ReturnType<typeof serverAnswering>,
  opts: Partial<RunWaitOptions> & { deadlineInMs?: number } = {},
) {
  const { deadlineInMs = 60_000, ...rest } = opts;
  return onFakeClock(async () => {
    server.start();
    const outcome = await waitForRun(server.client, 'e1', {
      deadline: Date.now() + deadlineInMs,
      ...rest,
    });
    return { outcome };
  });
}

const statuses = (lines: readonly ResultLine[]): string[] =>
  lines.map(l => `${l.resultId}:${l.testStatus}`);

describe('waitForRun', () => {
  it('reads the run with every status every 3 s until the run is finished', async () => {
    const server = serverAnswering([
      listing('running', [line('r1', 'RUNNING')]),
      listing('running', [line('r1', 'RUNNING')]),
      listing('finished', [line('r1', 'PASSED')]),
    ]);

    const { outcome } = await waitOn(server);

    expect(RUN_POLL_INTERVAL_MS).toBe(3_000);
    expect(server.times()).toEqual([0, 3_000, 6_000]);
    for (const request of server.requests) {
      expect(request.path).toBe('/results');
      expect(request.query.get('run')).toBe('e1');
      expect(request.query.get('status')).toBe('passed,failed,running,blocked,cancelled');
    }
    expect(outcome).toEqual({
      runId: 'e1',
      run: runOf('finished'),
      results: [line('r1', 'PASSED')],
      missingResultIds: [],
      timedOut: false,
    });
    expect(judge(outcome)).toBeNull();
  });

  it('waits for the run to finish, not for the results it lists, and takes the results it adds later', async () => {
    // A backend run's wave has settled; its integration phase adds a result
    // after that, and only then does the run finish.
    const server = serverAnswering([
      listing('running', [line('r1', 'PASSED', 0)]),
      listing('running', [line('r1', 'PASSED', 0)]),
      listing('running', [line('r1', 'PASSED', 0), line('r2', 'RUNNING', 1)]),
      listing('finished', [line('r1', 'PASSED', 0), line('r2', 'FAILED', 1)]),
    ]);

    const { outcome } = await waitOn(server);

    expect(server.times()).toEqual([0, 3_000, 6_000, 9_000]);
    expect(outcome.timedOut).toBe(false);
    // Oldest first, though the server lists newest first.
    expect(statuses(outcome.results)).toEqual(['r1:PASSED', 'r2:FAILED']);
    expect(toWaitMembers(outcome)).toEqual([
      { resultId: 'r1', runId: 'e1', testId: 'case_r1', status: 'passed' },
      { resultId: 'r2', runId: 'e1', testId: 'case_r2', status: 'failed' },
    ]);
    expect(judge(outcome)?.exitCode).toBe(1);
  });

  it('gives onRead a copy of the results, so sorting it there does not reorder the outcome', async () => {
    const server = serverAnswering([
      listing('finished', [line('r1', 'PASSED', 0), line('r2', 'PASSED', 1)]),
    ]);

    const { outcome } = await waitOn(server, { onRead: ({ results }) => void results.reverse() });

    expect(statuses(outcome.results)).toEqual(['r1:PASSED', 'r2:PASSED']);
  });

  describe('the deadline', () => {
    it('reads once more at the deadline and reports the results still running as timed out', async () => {
      const server = serverAnswering([
        listing('running', [line('r1', 'PASSED', 0), line('r2', 'RUNNING', 1)]),
      ]);

      const { outcome } = await waitOn(server, { deadlineInMs: 10_000 });

      expect(server.times()).toEqual([0, 3_000, 6_000, 9_000, 10_000]);
      expect(outcome.timedOut).toBe(true);
      expect(outcome.error).toBeUndefined();
      expect(toWaitMembers(outcome)).toEqual([
        { resultId: 'r1', runId: 'e1', testId: 'case_r1', status: 'passed' },
        { resultId: 'r2', runId: 'e1', testId: 'case_r2', status: 'timeout' },
      ]);
      const failure = judge(outcome);
      expect(failure?.exitCode).toBe(7);
      expect(failure).toMatchObject({ details: { runId: 'e1', timedOutResultIds: ['r2'] } });
    });

    it.each([
      ['a server error', failure(500, 'INTERNAL')],
      ['an outage', failure(503, 'UNAVAILABLE')],
    ])('a read at the deadline that fails with %s leaves the timeout as it is', async (_, last) => {
      const server = serverAnswering([
        ...Array.from({ length: 4 }, () => listing('running', [line('r1', 'RUNNING')])),
        last,
      ]);

      const { outcome } = await waitOn(server, { deadlineInMs: 10_000 });

      expect(server.times()).toEqual([0, 3_000, 6_000, 9_000, 10_000]);
      expect(outcome.timedOut).toBe(true);
      expect(outcome.error).toBeUndefined();
      expect(toWaitMembers(outcome).map(m => m.status)).toEqual(['timeout']);
      expect(judge(outcome)?.exitCode).toBe(7);
    });

    it('a run that the read at the deadline finds finished has not timed out', async () => {
      const server = serverAnswering([
        ...Array.from({ length: 4 }, () => listing('running', [line('r1', 'RUNNING')])),
        listing('finished', [line('r1', 'PASSED')]),
      ]);

      const { outcome } = await waitOn(server, { deadlineInMs: 10_000 });

      expect(server.times()).toEqual([0, 3_000, 6_000, 9_000, 10_000]);
      expect(outcome.timedOut).toBe(false);
      expect(statuses(outcome.results)).toEqual(['r1:PASSED']);
    });

    it('reads once more after a read the server answered past the deadline', async () => {
      const server = serverAnswering([
        ...Array.from({ length: 3 }, () => listing('running', [line('r1', 'RUNNING')])),
        // Sent at 9 s, answered at 10.5 s, within the grace.
        delayed(listing('running', [line('r1', 'RUNNING')]), 1_500),
        listing('finished', [line('r1', 'PASSED')]),
      ]);

      const { outcome } = await waitOn(server, { deadlineInMs: 10_000 });

      expect(server.times()).toEqual([0, 3_000, 6_000, 9_000, 10_500]);
      expect(outcome.timedOut).toBe(false);
      expect(statuses(outcome.results)).toEqual(['r1:PASSED']);
    });

    it('times out a run whose listed results have all settled but which has not finished: exit 7', async () => {
      const server = serverAnswering([listing('running', [line('r1', 'PASSED')])]);

      const { outcome } = await waitOn(server, { deadlineInMs: 10_000 });

      // No result carries the timeout: the outcome does, and the judge reads it.
      expect(outcome.timedOut).toBe(true);
      expect(toWaitMembers(outcome).map(m => m.status)).toEqual(['passed']);
      const failure = judge(outcome);
      expect(failure?.exitCode).toBe(7);
      expect(failure).toMatchObject({
        code: 'UNSUPPORTED',
        details: { runId: 'e1', runIds: ['e1'], timedOutResultIds: [], timeoutSeconds: 60 },
      });
      expect(failure?.message).toContain('e1');
      expect((failure as ApiError).nextAction).toContain('testsprite run wait e1');
    });

    it('cuts a read still unanswered when the deadline grace ends, and reports what it read before', async () => {
      const server = serverAnswering([listing('running', [line('r1', 'RUNNING')]), 'hang']);

      const { outcome } = await waitOn(server, { deadlineInMs: 10_000 });

      // The second read is never answered, so no read follows it.
      expect(server.times()).toEqual([0, 3_000]);
      expect(outcome.timedOut).toBe(true);
      expect(outcome.run).toEqual(runOf('running'));
      expect(toWaitMembers(outcome).map(m => m.status)).toEqual(['timeout']);
    });

    it("cuts a read still in the client's own retry back-off when the grace ends, with no read after it", async () => {
      // Sent at 9 s; the 429 asks for 5 s, so the client's retry would come at
      // 14 s, past the grace at 12 s.
      const server = serverAnswering(
        [
          ...Array.from({ length: 3 }, () => listing('running', [line('r1', 'RUNNING')])),
          failure(429, 'RATE_LIMITED', {}, { 'retry-after': '5' }),
        ],
        { clientSleep: 'timers' },
      );

      const { outcome } = await waitOn(server, { deadlineInMs: 10_000 });

      expect(server.times()).toEqual([0, 3_000, 6_000, 9_000]);
      expect(outcome.timedOut).toBe(true);
      expect(outcome.error).toBeUndefined();
      expect(judge(outcome)?.exitCode).toBe(7);
    });

    it('ends on its timers when Date.now() stands still', async () => {
      const server = serverAnswering([listing('running', [line('r1', 'RUNNING')])]);

      const outcome = await onFakeClock(async () => {
        const frozen = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(frozen);
        server.start();
        return waitForRun(server.client, 'e1', { deadline: frozen + 10_000 });
      }, 'spec');

      expect(server.times()).toEqual([0, 3_000, 6_000, 9_000, 10_000]);
      expect(outcome.timedOut).toBe(true);
    });

    it('ends on Date.now() when an injected sleep takes no time', async () => {
      // A command's injected sleep returns at once; its specs move the clock instead.
      const server = serverAnswering([listing('running', [line('r1', 'RUNNING')])]);
      const slept: number[] = [];

      const outcome = await onFakeClock(async () => {
        let now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        return waitForRun(server.client, 'e1', {
          deadline: now + 10_000,
          sleep: async ms => {
            // A wait that misses the deadline would otherwise read for ever.
            if (slept.length >= 10) throw new Error('the wait slept past its deadline');
            slept.push(ms);
            now += ms;
          },
        });
      }, 'spec');

      // The last sleep ends at the deadline, not 3 s after the read before it.
      expect(slept).toEqual([3_000, 3_000, 3_000, 1_000]);
      expect(server.requests).toHaveLength(5);
      expect(outcome.timedOut).toBe(true);
    });

    it('a first read cut at the deadline grace reports a run it never read, which is no success', async () => {
      const server = serverAnswering(['hang']);

      const { outcome } = await waitOn(server, { deadlineInMs: 10_000 });

      expect(outcome).toEqual({
        runId: 'e1',
        run: null,
        results: [],
        missingResultIds: [],
        timedOut: true,
      });
      expect(judge(outcome)?.exitCode).toBe(7);
    });
  });

  describe('a held run', () => {
    it('waits only on the given results and stops once they have settled', async () => {
      const server = serverAnswering([
        listing('running', [line('r_other', 'RUNNING', 0), line('r_held', 'RUNNING', 1)]),
        listing('running', [line('r_other', 'RUNNING', 0), line('r_held', 'PASSED', 1)]),
      ]);
      const settled: string[] = [];

      const { outcome } = await waitOn(server, {
        onlyResultIds: ['r_held'],
        onSettled: l => settled.push(l.resultId),
      });

      expect(server.times()).toEqual([0, 3_000]);
      expect(outcome.timedOut).toBe(false);
      expect(statuses(outcome.results)).toEqual(['r_held:PASSED']);
      expect(settled).toEqual(['r_held']);
      expect(outcome.joined).toBe(true);
      expect(toWaitMembers(outcome)).toEqual([
        {
          resultId: 'r_held',
          runId: 'e1',
          testId: 'case_r_held',
          status: 'passed',
          joined: true,
        },
      ]);
      expect(judge(outcome)).toBeNull();
    });

    it("is a run this command joined: a timeout's cancel hint says so, as today's", async () => {
      const server = serverAnswering([
        listing('running', [line('r_other', 'RUNNING', 0), line('r_held', 'RUNNING', 1)]),
      ]);

      const { outcome } = await waitOn(server, {
        onlyResultIds: ['r_held'],
        deadlineInMs: 10_000,
      });

      expect(outcome.timedOut).toBe(true);
      const failure = judge(outcome);
      expect(failure?.exitCode).toBe(7);
      expect((failure as ApiError).nextAction).toBe(
        'Resume: testsprite run wait e1\n' +
          'Cancel: testsprite run cancel e1 (cancelling e1 stops every test in that run, ' +
          'which this command joined and did not start)',
      );
    });

    it('does not stop while a given result has not been listed', async () => {
      const server = serverAnswering([
        listing('running', [line('r_a', 'PASSED', 0)]),
        listing('running', [line('r_a', 'PASSED', 0), line('r_b', 'PASSED', 1)]),
      ]);

      const { outcome } = await waitOn(server, { onlyResultIds: ['r_a', 'r_b'] });

      expect(server.times()).toEqual([0, 3_000]);
      expect(statuses(outcome.results)).toEqual(['r_a:PASSED', 'r_b:PASSED']);
      expect(outcome.missingResultIds).toEqual([]);
    });

    it('reports a given result that a finished run never listed as not found', async () => {
      const server = serverAnswering([listing('finished', [line('r_a', 'PASSED')])]);

      const { outcome } = await waitOn(server, { onlyResultIds: ['r_a', 'r_gone'] });

      expect(outcome.timedOut).toBe(false);
      expect(outcome.missingResultIds).toEqual(['r_gone']);
      expect(toWaitMembers(outcome).map(m => [m.resultId, m.status])).toEqual([
        ['r_a', 'passed'],
        ['r_gone', 'error'],
      ]);
      expect(judge(outcome)?.exitCode).toBe(4);
    });

    it('refuses a list that names no result', async () => {
      const server = serverAnswering([listing('running', [line('r1', 'RUNNING')])]);

      await expect(waitOn(server, { onlyResultIds: [] })).rejects.toThrow(/no result/);
      expect(server.requests).toEqual([]);
    });
  });

  it('emits a settle event once per result, a result first listed settled included', async () => {
    const server = serverAnswering([
      listing('running', [line('r1', 'PASSED', 0), line('r2', 'RUNNING', 1)]),
      listing('running', [line('r1', 'PASSED', 0), line('r2', 'RUNNING', 1)]),
      listing('running', [line('r1', 'PASSED', 0), line('r2', 'FAILED', 1)]),
      listing('finished', [
        line('r1', 'PASSED', 0),
        line('r2', 'FAILED', 1),
        line('r3', 'BLOCKED', 2),
      ]),
    ]);
    const settled: string[] = [];
    const reads: string[][] = [];

    await waitOn(server, {
      onSettled: l => settled.push(`${l.resultId}:${l.testStatus}`),
      onRead: ({ run, results }) => void reads.push([run.status, ...statuses(results)]),
    });

    expect(settled).toEqual(['r1:PASSED', 'r2:FAILED', 'r3:BLOCKED']);
    expect(reads).toEqual([
      ['running', 'r1:PASSED', 'r2:RUNNING'],
      ['running', 'r1:PASSED', 'r2:RUNNING'],
      ['running', 'r1:PASSED', 'r2:FAILED'],
      ['finished', 'r1:PASSED', 'r2:FAILED', 'r3:BLOCKED'],
    ]);
  });

  describe('onRead', () => {
    it('is awaited, with a live signal, before the sleep that follows its read', async () => {
      const server = serverAnswering([
        listing('running', [line('r1', 'RUNNING')]),
        listing('running', [line('r1', 'RUNNING')]),
        listing('finished', [line('r1', 'PASSED')]),
      ]);
      const signals: boolean[] = [];

      const { outcome } = await waitOn(server, {
        // A per-read check that takes a second, such as a liveness read.
        onRead: async (_, signal) => {
          signals.push(signal.aborted);
          await after(1_000, signal);
        },
      });

      expect(server.times()).toEqual([0, 4_000, 8_000]);
      expect(signals).toEqual([false, false, false]);
      expect(outcome.timedOut).toBe(false);
    });

    it('cut by the deadline grace, ends the wait as a timeout rather than with its abort', async () => {
      const server = serverAnswering([listing('running', [line('r1', 'RUNNING')])]);

      const { outcome } = await waitOn(server, {
        deadlineInMs: 10_000,
        // A per-read check slower than the time left: the grace cuts it.
        onRead: async (_, signal) => after(60_000, signal),
      });

      expect(server.times()).toEqual([0]);
      expect(outcome.timedOut).toBe(true);
      expect(judge(outcome)?.exitCode).toBe(7);
    });

    it('ends the wait with the error it throws, and leaves the shutdown scope disarmed', async () => {
      const server = serverAnswering([listing('running', [line('r1', 'RUNNING')])]);
      const shutdown = new ShutdownController();
      const lost = new Error('the tunnel closed');
      let reads = 0;

      const error = await waitOn(server, {
        shutdown,
        onRead: async () => {
          reads += 1;
          if (reads === 2) throw lost;
        },
      }).catch((err: unknown) => err);

      expect(error).toBe(lost);
      expect(server.times()).toEqual([0, 3_000]);
      expect(shutdown.isArmed).toBe(false);
    });
  });

  describe('ending early', () => {
    it('stops at once when interrupted in the sleep between reads, armed throughout', async () => {
      const server = serverAnswering([listing('running', [line('r1', 'RUNNING')])]);
      const shutdown = new ShutdownController();
      const armedAtRead: boolean[] = [];

      const ended = await onFakeClock(async () => {
        server.start();
        const startedAt = Date.now();
        const error = await waitForRun(server.client, 'e1', {
          deadline: Date.now() + 60_000,
          shutdown,
          onRead: () => {
            armedAtRead.push(shutdown.isArmed);
            // Ctrl-C one second into the sleep that follows this read.
            setTimeout(() => shutdown.interrupt('SIGINT'), 1_000);
          },
        }).catch((err: unknown) => err);
        return { error, afterMs: Date.now() - startedAt };
      });

      expect(ended.error).toBeInstanceOf(InterruptError);
      expect((ended.error as InterruptError).runWaitContext).toBe(true);
      expect(ended.afterMs).toBe(1_000);
      expect(server.times()).toEqual([0]);
      expect(armedAtRead).toEqual([true]);
      expect(shutdown.isArmed).toBe(false);
    });

    it('stops at once when interrupted during a read', async () => {
      const server = serverAnswering([listing('running', [line('r1', 'RUNNING')]), 'hang']);
      const shutdown = new ShutdownController();

      const ended = await onFakeClock(async () => {
        server.start();
        const startedAt = Date.now();
        // Ctrl-C one second into the second read, which is never answered.
        setTimeout(() => shutdown.interrupt('SIGINT'), 4_000);
        const error = await waitForRun(server.client, 'e1', {
          deadline: Date.now() + 60_000,
          shutdown,
        }).catch((err: unknown) => err);
        return { error, afterMs: Date.now() - startedAt };
      });

      expect(ended.error).toBeInstanceOf(InterruptError);
      expect((ended.error as InterruptError).runWaitContext).toBe(true);
      expect(ended.afterMs).toBe(4_000);
      expect(server.times()).toEqual([0, 3_000]);
      expect(shutdown.isArmed).toBe(false);
    });

    it.each([
      ['in the sleep between reads', [listing('running', [line('r1', 'RUNNING')])], 1_000],
      ['during a read', [listing('running', [line('r1', 'RUNNING')]), 'hang' as const], 4_000],
    ])('ends with the reason of its signal at once when it aborts %s', async (_, answers, at) => {
      const server = serverAnswering(answers);
      const abort = new AbortController();
      const gone = new Error('the borrowed tunnel is gone');

      const ended = await onFakeClock(async () => {
        server.start();
        const startedAt = Date.now();
        setTimeout(() => abort.abort(gone), at);
        const error = await waitForRun(server.client, 'e1', {
          deadline: Date.now() + 60_000,
          signal: abort.signal,
        }).catch((err: unknown) => err);
        return { error, afterMs: Date.now() - startedAt };
      });

      expect(ended.error).toBe(gone);
      expect(ended.afterMs).toBe(at);
    });
  });

  describe('a listing error', () => {
    it('ends the wait after the first read, and each result still running carries it into resolveWaitFailure', async () => {
      const server = serverAnswering([
        listing('running', [line('r1', 'PASSED', 0), line('r2', 'RUNNING', 1)]),
        failure(401, 'AUTH_INVALID'),
      ]);

      const { outcome } = await waitOn(server);

      expect(outcome.timedOut).toBe(false);
      expect(outcome.error).toBeInstanceOf(ApiError);
      expect(outcome.error?.code).toBe('AUTH_INVALID');
      const members = toWaitMembers(outcome);
      expect(members).toMatchObject([
        { resultId: 'r1', status: 'passed' },
        { resultId: 'r2', status: 'error', error: { code: 'AUTH_INVALID', exitCode: 3 } },
      ]);
      expect(resolveWaitFailure(members, { timeoutSeconds: 60 })?.exitCode).toBe(3);
      expect(judge(outcome)?.exitCode).toBe(3);
    });

    it.each([
      ['a run the server no longer knows', failure(404, 'NOT_FOUND', { resource: 'run' }), 4],
      ['a credential that stopped working', failure(401, 'AUTH_INVALID'), 3],
      ['two server errors in a row', failure(500, 'INTERNAL'), 1],
    ])('once every listed result has settled is still judged: %s', async (_, answer, exitCode) => {
      const server = serverAnswering([listing('running', [line('r1', 'PASSED')]), answer]);

      const { outcome } = await waitOn(server);

      // No result carries the error: the outcome does, and the judge reads it.
      expect(outcome.timedOut).toBe(false);
      expect(server.times()[1]).toBe(3_000);
      const failure = judge(outcome);
      expect(failure?.exitCode).toBe(exitCode);
      // The listing error speaks for itself: no result failed, so no count of failed ones.
      expect(failure).toBe(outcome.error);
      expect(failure?.message).not.toMatch(/\bfailed\b/);
    });

    it.each([
      [
        'an unknown run',
        failure(404, 'NOT_FOUND', { resource: 'run' }),
        { code: 'NOT_FOUND', httpStatus: 404, exitCode: 4, details: { resource: 'run' } },
      ],
      [
        'a server without the route',
        failure(404, 'NOT_FOUND'),
        { code: 'NOT_FOUND', httpStatus: 404, exitCode: 4, details: {} },
      ],
      [
        'a refused credential',
        failure(401, 'AUTH_INVALID'),
        { code: 'AUTH_INVALID', httpStatus: 401, exitCode: 3 },
      ],
    ])('on the first read is thrown as it is: %s', async (name, answer, expected) => {
      const server = serverAnswering([answer]);

      const error = await waitOn(server).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject(expected);
      if (name === 'a server without the route') {
        expect((error as ApiError).details).not.toHaveProperty('resource');
      }
      expect(server.times()).toEqual([0]);
    });

    it('a server error on the first read is read again once', async () => {
      // The client retries a 500 once itself, so one failed read is two requests.
      const server = serverAnswering([
        failure(500, 'INTERNAL'),
        failure(500, 'INTERNAL'),
        listing('finished', [line('r1', 'PASSED')]),
      ]);

      const { outcome } = await waitOn(server);

      expect(server.times()).toEqual([0, 0, 3_000]);
      expect(outcome.timedOut).toBe(false);
      expect(outcome.error).toBeUndefined();
    });

    it('a server error on the first two reads is thrown as it is', async () => {
      const server = serverAnswering([failure(500, 'INTERNAL')]);

      const error = await waitOn(server).catch((err: unknown) => err);

      expect(error).toMatchObject({ code: 'INTERNAL' });
      expect(server.times()).toEqual([0, 0, 3_000, 3_000]);
    });

    it.each([
      ['a server error', failure(500, 'INTERNAL')],
      ['a standing 429', failure(429, 'RATE_LIMITED', { reason: 'inflight_cap' })],
    ])(
      'after an outage on every read, %s on the read at the deadline ends the wait on the outage',
      async (_, last) => {
        // Reads at 0, 3, 6 and 9 s are four requests each; the read at 10 s is one.
        const server = serverAnswering([
          ...Array.from({ length: 16 }, () => failure(503, 'UNAVAILABLE')),
          last,
        ]);

        const { outcome } = await waitOn(server, { deadlineInMs: 10_000 });

        expect(server.requests.at(-1)?.at).toBe(10_000);
        expect(outcome).toMatchObject({ run: null, results: [], timedOut: true });
        expect(outcome.error?.code).toBe('UNAVAILABLE');
        expect(judge(outcome)?.exitCode).toBe(10);
      },
    );

    it('a 404 on the read at the deadline after an outage on every read is still thrown: no read showed the run', async () => {
      const server = serverAnswering([
        ...Array.from({ length: 16 }, () => failure(503, 'UNAVAILABLE')),
        failure(404, 'NOT_FOUND', { resource: 'run' }),
      ]);

      const error = await waitOn(server, { deadlineInMs: 10_000 }).catch((err: unknown) => err);

      expect(error).toMatchObject({ code: 'NOT_FOUND', exitCode: 4 });
    });

    it('does not end the wait while the API is unreachable; an outage still on at the deadline is reported', async () => {
      const server = serverAnswering([
        listing('running', [line('r1', 'RUNNING')]),
        failure(503, 'UNAVAILABLE'),
      ]);

      const { outcome } = await waitOn(server, { deadlineInMs: 10_000 });

      expect(outcome.timedOut).toBe(true);
      expect(outcome.error?.code).toBe('UNAVAILABLE');
      expect(toWaitMembers(outcome)).toMatchObject([
        { resultId: 'r1', status: 'error', error: { code: 'UNAVAILABLE' } },
      ]);
      expect(judge(outcome)?.exitCode).toBe(10);
    });

    it('reads through an outage on the first read too', async () => {
      // The client tries four times per read: the first read fails, the second
      // gets through on its second try.
      const server = serverAnswering([
        ...Array.from({ length: 5 }, () => failure(503, 'UNAVAILABLE')),
        listing('finished', [line('r1', 'PASSED')]),
      ]);

      const { outcome } = await waitOn(server);

      expect(outcome.timedOut).toBe(false);
      expect(outcome.error).toBeUndefined();
      expect(statuses(outcome.results)).toEqual(['r1:PASSED']);
      expect(server.requests.at(-1)?.at).toBe(3_000);
    });

    it('a first-read outage that lasts past the deadline is reported with no run read', async () => {
      const server = serverAnswering([failure(503, 'UNAVAILABLE')]);

      const { outcome } = await waitOn(server, { deadlineInMs: 10_000 });

      expect(outcome).toMatchObject({ run: null, results: [], timedOut: true });
      expect(outcome.error?.code).toBe('UNAVAILABLE');
      expect(judge(outcome)?.exitCode).toBe(10);
    });

    it('a first-read throttle that lasts past the deadline is a timeout', async () => {
      const server = serverAnswering([failure(429, 'RATE_LIMITED')]);

      const { outcome } = await waitOn(server, { deadlineInMs: 10_000 });

      expect(outcome).toMatchObject({ run: null, results: [], timedOut: true });
      expect(outcome.error).toBeUndefined();
      expect(judge(outcome)?.exitCode).toBe(7);
    });

    it('a run read again after an outage finishes as usual', async () => {
      const server = serverAnswering([
        listing('running', [line('r1', 'RUNNING')]),
        failure(503, 'UNAVAILABLE'),
        failure(503, 'UNAVAILABLE'),
        failure(503, 'UNAVAILABLE'),
        failure(503, 'UNAVAILABLE'),
        listing('finished', [line('r1', 'PASSED')]),
      ]);

      const { outcome } = await waitOn(server);

      expect(outcome.timedOut).toBe(false);
      expect(outcome.error).toBeUndefined();
      expect(statuses(outcome.results)).toEqual(['r1:PASSED']);
    });

    it('a 429 for a standing condition ends the wait: waiting cannot clear it', async () => {
      const server = serverAnswering([
        listing('running', [line('r1', 'RUNNING')]),
        failure(429, 'RATE_LIMITED', { reason: 'inflight_cap' }),
      ]);

      const { outcome } = await waitOn(server, { deadlineInMs: 10_000 });

      expect(server.times()).toEqual([0, 3_000]);
      expect(outcome.timedOut).toBe(false);
      expect(outcome.error?.code).toBe('RATE_LIMITED');
      expect(judge(outcome)?.exitCode).toBe(11);
    });

    it('a throttled read is retried, and a throttle still on at the deadline is a timeout', async () => {
      const server = serverAnswering([
        listing('running', [line('r1', 'RUNNING')]),
        failure(429, 'RATE_LIMITED'),
      ]);

      const { outcome } = await waitOn(server, { deadlineInMs: 10_000 });

      expect(outcome.timedOut).toBe(true);
      expect(outcome.error).toBeUndefined();
      expect(toWaitMembers(outcome).map(m => m.status)).toEqual(['timeout']);
      expect(judge(outcome)?.exitCode).toBe(7);
    });

    describe('a server error after the first read', () => {
      it('is read again once', async () => {
        // The client retries a 500 once itself, so one failed read is two requests.
        const server = serverAnswering([
          listing('running', [line('r1', 'RUNNING')]),
          failure(500, 'INTERNAL'),
          failure(500, 'INTERNAL'),
          listing('finished', [line('r1', 'PASSED')]),
        ]);

        const { outcome } = await waitOn(server);

        expect(server.times()).toEqual([0, 3_000, 3_000, 6_000]);
        expect(outcome.timedOut).toBe(false);
        expect(outcome.error).toBeUndefined();
      });

      it('ends the wait on the second failed read in a row', async () => {
        const server = serverAnswering([
          listing('running', [line('r1', 'RUNNING')]),
          failure(500, 'INTERNAL'),
        ]);

        const { outcome } = await waitOn(server);

        expect(server.times()).toEqual([0, 3_000, 3_000, 6_000, 6_000]);
        expect(outcome.timedOut).toBe(false);
        expect(outcome.error?.code).toBe('INTERNAL');
        expect(judge(outcome)?.exitCode).toBe(1);
      });

      it('read again at the deadline leaves a plain timeout', async () => {
        const server = serverAnswering([
          ...Array.from({ length: 3 }, () => listing('running', [line('r1', 'RUNNING')])),
          failure(500, 'INTERNAL'),
        ]);

        const { outcome } = await waitOn(server, { deadlineInMs: 10_000 });

        expect(outcome.timedOut).toBe(true);
        expect(outcome.error).toBeUndefined();
        expect(judge(outcome)?.exitCode).toBe(7);
      });
    });
  });

  describe('the run in the listing', () => {
    it('fails closed when the listing has no run: the server is too old', async () => {
      const server = serverAnswering([{ body: { results: [line('r1', 'RUNNING')] } }]);

      const error = await waitOn(server).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ code: 'UNSUPPORTED', exitCode: 7 });
      expect((error as ApiError).message).toMatch(/server/i);
      expect((error as ApiError).nextAction).toMatch(/CLI 0\.16/);
      expect(server.times()).toEqual([0]);
    });

    it('fails closed on a run it cannot read, says so in its own words, and logs it under --debug', async () => {
      const server = serverAnswering([
        { body: { run: { runId: 'e1', status: 7 }, results: [line('r1', 'RUNNING')] } },
      ]);
      const debug: string[] = [];

      const error = await waitOn(server, { debug: l => void debug.push(l) }).catch(
        (err: unknown) => err,
      );

      expect(error).toMatchObject({ code: 'UNSUPPORTED', exitCode: 7 });
      expect((error as ApiError).message).not.toMatch(/does not say/);
      expect((error as ApiError).message).toMatch(/could not be read/);
      expect((error as ApiError).nextAction).not.toMatch(/CLI 0\.16/);
      expect(debug).toHaveLength(1);
      expect(debug[0]).toMatch(/run e1/);
      expect(server.times()).toEqual([0]);
    });

    it('waits on a run that names only its id and status', async () => {
      const server = serverAnswering([
        { body: { run: { runId: 'e1', status: 'finished' }, results: [line('r1', 'PASSED')] } },
      ]);

      const { outcome } = await waitOn(server);

      expect(outcome.timedOut).toBe(false);
      expect(outcome.run).toMatchObject({ runId: 'e1', status: 'finished' });
    });
  });

  it('reports a result still running in a finished run as running, which is not a pass', async () => {
    const server = serverAnswering([listing('finished', [line('r1', 'RUNNING')])]);

    const { outcome } = await waitOn(server);

    expect(outcome.timedOut).toBe(false);
    expect(toWaitMembers(outcome).map(m => m.status)).toEqual(['running']);
    expect(judge(outcome)?.exitCode).toBe(1);
  });
});

describe('resolveRunWaitFailure', () => {
  it('preserves the original API error over a request failure of the same rank', () => {
    const error = ApiError.fromEnvelope({
      error: {
        code: 'UNAVAILABLE',
        message: 'Original outage',
        nextAction: 'Original server instruction',
        requestId: 'server-id',
        details: { marker: 'raw' },
      },
    });
    expect(
      resolveRunWaitFailure(
        [{ runId: 'a', run: null, results: [], timedOut: false, missingResultIds: [], error }],
        { timeoutSeconds: 600 },
        new CLIError('Local request failure', 10),
      ),
    ).toBe(error);
  });

  /** An outcome of run `runId` with the given lines and ending. */
  function outcomeOf(
    runId: string,
    status: ResultRun['status'],
    lines: ResultLine[],
    end: Partial<Pick<RunWaitOutcome, 'timedOut' | 'error'>> = {},
  ): RunWaitOutcome {
    return {
      runId,
      run: runOf(status, runId),
      results: lines,
      missingResultIds: [],
      timedOut: false,
      ...end,
    };
  }

  it('is null when every run finished and every result passed', () => {
    expect(
      judge(
        outcomeOf('e1', 'finished', [line('r1', 'PASSED', 0, 'e1')]),
        outcomeOf('e2', 'finished', [line('r2', 'PASSED', 0, 'e2')]),
      ),
    ).toBeNull();
  });

  it.each([{ results: [] }, { results: [line('r1', 'PASSED')] }])(
    'fails a cancelled whole run even when every listed result passed: %j',
    ({ results }) => {
      const outcome = outcomeOf('e1', 'finished', results);
      outcome.run!.cancelled = true;
      expect(judge(outcome)).toMatchObject({ exitCode: 1, message: 'Run e1 was cancelled.' });
    },
  );

  it('keeps a joined passed subset successful when unrelated run work was cancelled', () => {
    const outcome = outcomeOf('e1', 'finished', [line('r1', 'PASSED')]);
    outcome.run!.cancelled = true;
    outcome.joined = true;
    expect(judge(outcome)).toBeNull();
  });

  it('keeps operational failures above whole-run cancellation', () => {
    const cancelled = outcomeOf('e1', 'finished', [line('r1', 'PASSED')]);
    cancelled.run!.cancelled = true;
    const unavailable = ApiError.fromEnvelope({
      error: {
        code: 'AUTH_INVALID',
        message: 'server auth error',
        requestId: 'req',
        nextAction: '',
      },
    });
    expect(judge(cancelled, outcomeOf('e2', 'running', [], { error: unavailable }))).toMatchObject({
      exitCode: 3,
    });
  });

  it('a run that timed out with every result settled outranks a failed result elsewhere: exit 7 naming that run', () => {
    const failure = judge(
      outcomeOf('e1', 'finished', [line('r1', 'FAILED', 0, 'e1')]),
      outcomeOf('e2', 'running', [line('r2', 'PASSED', 0, 'e2')], { timedOut: true }),
    );

    expect(failure?.exitCode).toBe(7);
    expect(failure).toMatchObject({ details: { runId: 'e2', runIds: ['e2'] } });
  });

  it('one timeout names every run left unfinished, those with a result still running and those without', () => {
    const failure = judge(
      outcomeOf('e1', 'running', [line('r1', 'RUNNING', 0, 'e1')], { timedOut: true }),
      outcomeOf('e2', 'running', [line('r2', 'PASSED', 0, 'e2')], { timedOut: true }),
    );

    expect(failure?.exitCode).toBe(7);
    expect(failure).toMatchObject({
      details: { runId: null, runIds: ['e1', 'e2'], timedOutResultIds: ['r1'] },
    });
    expect((failure as ApiError).nextAction).toContain('testsprite run wait e1 e2');
  });

  it.each([
    ['a result still running', 'RUNNING'],
    ['every result settled', 'PASSED'],
  ])(
    "a run's listing error outranks a timeout of another run with %s, by the usual precedence",
    (_, otherStatus) => {
      const auth = ApiError.fromEnvelope({
        error: {
          code: 'AUTH_INVALID',
          message: 'bad key',
          nextAction: '',
          requestId: 'r',
          details: {},
        },
      });

      const failure = judge(
        outcomeOf('e1', 'running', [line('r1', 'PASSED', 0, 'e1')], { error: auth }),
        outcomeOf('e2', 'running', [line('r2', otherStatus, 0, 'e2')], { timedOut: true }),
      );

      expect(failure?.exitCode).toBe(3);
    },
  );

  it.each([
    ['a run that finished', 'finished', 'CANCELLED', false],
    ['a run that timed out before the cancel showed', 'running', 'RUNNING', true],
  ])(
    'a result the CLI cancelled when it stopped waiting, in %s, timed out and was cancelled, as today',
    (_, runStatus, listedStatus, timedOut) => {
      const failure = resolveRunWaitFailure(
        [
          outcomeOf(
            'e1',
            runStatus,
            [line('r1', listedStatus, 0, 'e1'), line('r2', 'PASSED', 1, 'e1')],
            { timedOut },
          ),
        ],
        { timeoutSeconds: 60, cancelledResultIds: ['r1'] },
      );

      expect(failure?.exitCode).toBe(7);
      expect(failure?.message).toBe('1 result timed out and was cancelled.');
      // Cancelled, it cannot be resumed: it is looked up by itself.
      expect((failure as ApiError).nextAction).toBe(
        'Check the verdict later with: testsprite result get r1',
      );
      expect(failure).toMatchObject({ details: { runIds: [], timedOutResultIds: ['r1'] } });
    },
  );

  it('a result the CLI cancelled that the listing shows with a verdict keeps the verdict', () => {
    const failure = resolveRunWaitFailure(
      [outcomeOf('e1', 'finished', [line('r1', 'PASSED', 0, 'e1')])],
      { timeoutSeconds: 60, cancelledResultIds: ['r1'] },
    );

    expect(failure).toBeNull();
  });

  it.each([
    [
      'run e1 never read',
      { runId: 'e1', run: null, results: [], missingResultIds: [], timedOut: true },
    ],
    [
      'a result of run e1 still running',
      {
        runId: 'e1',
        run: runOf('running', 'e1'),
        results: [line('r1', 'RUNNING', 0, 'e1')],
        missingResultIds: [],
        timedOut: true,
      },
    ],
  ])(
    'an outage still on at the deadline, on %s, preserves the original API envelope beside other unfinished runs',
    (_, outageOutcome) => {
      const outage = ApiError.fromEnvelope({
        error: {
          code: 'UNAVAILABLE',
          message: 'down',
          nextAction: 'Use server run e1 instructions verbatim',
          requestId: 'r',
          details: { runId: 'e1', resultId: 'r1', nested: { reason: 'upstream-unavailable' } },
        },
      });

      const failure = judge(
        { ...outageOutcome, error: outage },
        outcomeOf('e2', 'running', [line('r2', 'PASSED', 0, 'e2')], { timedOut: true }),
      );

      expect(failure?.exitCode).toBe(10);
      expect(failure).toBe(outage);
      expect((failure as ApiError).nextAction).toBe('Use server run e1 instructions verbatim');
      expect((failure as ApiError).details).toEqual({
        runId: 'e1',
        resultId: 'r1',
        nested: { reason: 'upstream-unavailable' },
      });
    },
  );

  it('an outage still on at the deadline of a run never read is exit 10, with the run to re-attach to', () => {
    const outage = ApiError.fromEnvelope({
      error: { code: 'UNAVAILABLE', message: 'down', nextAction: '', requestId: 'r', details: {} },
    });

    const failure = judge({
      runId: 'e1',
      run: null,
      results: [],
      missingResultIds: [],
      timedOut: true,
      error: outage,
    });

    expect(failure?.exitCode).toBe(10);
    expect((failure as ApiError).nextAction).toBe('');
  });
});
