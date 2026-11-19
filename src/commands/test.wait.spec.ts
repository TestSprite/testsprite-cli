import { describe, expect, it, vi } from 'vitest';
import { onFakeTimers } from '../../test/helpers/fake-timers.js';
import { resultLine } from '../../test/helpers/result-list.js';
import { InterruptError, RequestTimeoutError } from '../lib/errors.js';
import { ShutdownController } from '../lib/interrupt.js';
import { buildInterruptEnvelope } from '../lib/render-error.js';
import { runTestWait } from './test.js';

const json = (body: unknown, status = 200, headers = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const fail = (code: string, status: number, details: Record<string, unknown> = {}) =>
  json(
    {
      error: {
        code,
        message: `${code} from server`,
        nextAction: 'Server instruction.',
        requestId: 'server-id',
        details,
      },
    },
    status,
  );
const snapshot = (id: string, status = 'finished', statuses = ['PASSED']) => ({
  run: {
    runId: id,
    status,
    cancelled: false,
    projectId: 'p1',
    created: '2026-11-15T00:00:00Z',
    modified: '2026-11-15T00:00:00Z',
    targetUrl: null,
    dashboardUrl: 'https://portal.example/run',
  },
  results: statuses.map((testStatus, index) =>
    resultLine({
      resultId: `${id}-${index}`,
      runId: id,
      caseKey: `case-${index}`,
      testStatus,
      created: `2026-11-15T00:00:0${index}Z`,
    }),
  ),
});
type Answer = Response | 'hang' | 'request-timeout';
function harness(
  answer: (id: string, n: number, init: RequestInit) => Answer = id => json(snapshot(id)),
) {
  const calls: Array<{ id: string; query: URLSearchParams }> = [];
  const counts = new Map<string, number>();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const shutdown = new ShutdownController();
  const deps = {
    env: { TESTSPRITE_API_KEY: 'sk-user-test', TESTSPRITE_API_URL: 'https://api.example.com' },
    shutdown,
    stdout: (s: string) => stdout.push(s),
    stderr: (s: string) => stderr.push(s),
    fetchImpl: async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (init.method !== 'GET' || !url.pathname.endsWith('/results'))
        throw new Error(`unexpected request ${url}`);
      const id = url.searchParams.get('run')!;
      const n = (counts.get(id) ?? 0) + 1;
      counts.set(id, n);
      calls.push({ id, query: url.searchParams });
      const value = answer(id, n, init);
      if (value === 'request-timeout') throw new RequestTimeoutError(1000, 'request');
      if (value === 'hang')
        return new Promise<Response>((_resolve, reject) => {
          if (init.signal?.aborted) reject(init.signal.reason);
          else
            init.signal?.addEventListener('abort', () => reject(init.signal!.reason), {
              once: true,
            });
        });
      return value;
    },
  };
  return {
    calls,
    counts,
    stdout,
    stderr,
    shutdown,
    deps,
    wait: (ids = ['e1'], extra: Partial<Parameters<typeof runTestWait>[0]> = {}) =>
      runTestWait(
        {
          profile: 'default',
          debug: false,
          output: 'json',
          runIds: ids,
          timeoutSeconds: 6,
          ...extra,
        },
        deps,
      ),
    doc: () => JSON.parse(stdout.join('\n')),
  };
}
async function clock<T>(work: () => Promise<T>): Promise<T> {
  return onFakeTimers(async () => {
    const now = vi.spyOn(Date, 'now').mockImplementation(() => vi.getMockedSystemTime()!.getTime());
    try {
      return await work();
    } finally {
      now.mockRestore();
    }
  });
}

describe('run wait: native run snapshots', () => {
  it('requests every status including cancelled without polling result cards', async () => {
    const h = harness();
    await h.wait();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.query.get('status')).toBe('passed,failed,running,blocked,cancelled');
    expect(h.calls[0]!.query.has('waitSeconds')).toBe(false);
  });
  it('prints native run and result identities and server metadata', async () => {
    const h = harness();
    await h.wait();
    expect(h.doc().results).toEqual([
      expect.objectContaining({
        runId: 'e1',
        resultId: 'e1-0',
        testId: 'case-0',
        title: 'Test case-0',
        status: 'passed',
      }),
    ]);
    expect(h.doc().runs[0]).toMatchObject({
      runId: 'e1',
      status: 'finished',
      dashboardUrl: 'https://portal.example/run',
    });
    expect(h.doc().summary).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      timedOut: 0,
      skipped: 0,
    });
  });
  it("prints each run's Dashboard link under its results in the text card", async () => {
    const h = harness((id: string) => {
      const body = snapshot(id);
      return json({
        ...body,
        run: { ...body.run, dashboardUrl: `https://portal.example/run/${id}` },
      });
    });
    await h.wait(['e1', 'e2'], { output: 'text' });
    expect(h.stdout.join('\n').split('\n')).toEqual([
      'Run e1',
      '  e1-0  Test case-0  passed',
      '  Dashboard: https://portal.example/run/e1',
      'Run e2',
      '  e2-0  Test case-0  passed',
      '  Dashboard: https://portal.example/run/e2',
      '2/2 passed, 0 failed, 0 timed out',
    ]);
  });
  it('prints no Dashboard line for a run the server gave no link', async () => {
    const h = harness((id: string) => {
      const body = snapshot(id);
      return json({ ...body, run: { ...body.run, dashboardUrl: null } });
    });
    await h.wait(['e1'], { output: 'text' });
    expect(h.stdout.join('\n').split('\n')).toEqual([
      'Run e1',
      '  e1-0  Test case-0  passed',
      '1/1 passed, 0 failed, 0 timed out',
    ]);
  });
  it('previews each distinct read without fetching or simulating a verdict', async () => {
    const h = harness();
    await h.wait(['r/1', 'r/1', 'two'], { dryRun: true });
    expect(h.calls).toHaveLength(0);
    expect(h.doc()).toMatchObject({
      dryRun: true,
      runs: [],
      results: [],
      requests: [
        {
          method: 'GET',
          path: '/api/cli/v1/results?run=r%2F1&status=passed,failed,running,blocked,cancelled',
        },
        {
          method: 'GET',
          path: '/api/cli/v1/results?run=two&status=passed,failed,running,blocked,cancelled',
        },
      ],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, timedOut: 0 },
    });
    expect(h.doc().summary).not.toHaveProperty('results');
  });
  it('keeps input run order and deduplicates repeated runs', async () => {
    const h = harness();
    await h.wait(['e2', 'e1', 'e2']);
    expect(h.calls.map(c => c.id)).toEqual(['e2', 'e1']);
    expect(h.doc().runs.map((r: { runId: string }) => r.runId)).toEqual(['e2', 'e1']);
  });
  it('renders every result under its run in text', async () => {
    const h = harness(id => json(snapshot(id, 'finished', ['PASSED', 'PASSED'])));
    await h.wait(['e1'], { output: 'text' });
    expect(h.stdout.join('')).toContain(
      'Run e1\n  e1-0  Test case-0  passed\n  e1-1  Test case-1  passed',
    );
  });
  it('retains a result whose case key is unknown without inventing a test ID', async () => {
    const body = snapshot('e1');
    body.results[0]!.caseKey = null;
    const h = harness(() => json(body));
    const result = await h.wait();
    expect(result.results[0]).not.toHaveProperty('testId');
  });
  it('allows a finished run with no results', async () => {
    const h = harness(id => json(snapshot(id, 'finished', [])));
    expect((await h.wait()).summary.total).toBe(0);
  });
  it('does not finish when all unit results pass before integration is added', () =>
    clock(async () => {
      const h = harness((id, n) =>
        json(
          snapshot(id, n < 3 ? 'running' : 'finished', n < 3 ? ['PASSED'] : ['PASSED', 'PASSED']),
        ),
      );
      expect((await h.wait(['e1'], { timeoutSeconds: 20 })).summary.total).toBe(2);
      expect(h.counts.get('e1')).toBe(3);
    }));
  it('does not finish a running run with no result rows', () =>
    clock(async () => {
      const h = harness((id, n) =>
        json(snapshot(id, n === 1 ? 'running' : 'finished', n === 1 ? [] : ['PASSED'])),
      );
      expect((await h.wait()).summary.passed).toBe(1);
      expect(h.calls).toHaveLength(2);
    }));
  it.each(['FAILED', 'BLOCKED', 'CANCELLED'])('fails a terminal %s result', async status => {
    const h = harness(id => json(snapshot(id, 'finished', [status])));
    await expect(h.wait()).rejects.toMatchObject({ exitCode: 1 });
    expect(h.doc().results[0].status).toBe(status.toLowerCase());
    expect(h.doc()).not.toHaveProperty('partial');
  });
  it.each([[], ['PASSED']])(
    'fails run cancellation independently of result verdicts: %j',
    async (...statuses) => {
      const body = snapshot('e1', 'finished', statuses as string[]);
      body.run.cancelled = true;
      const h = harness(() => json(body));
      await expect(h.wait()).rejects.toMatchObject({ exitCode: 1 });
      expect(h.doc().runs[0].cancelled).toBe(true);
    },
  );
  it('refuses an older server with no authoritative run state', async () => {
    const h = harness(id => json({ results: snapshot(id).results }));
    await expect(h.wait()).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      exitCode: 7,
      details: { reason: 'run_status_missing' },
    });
  });
});

describe('run wait: shared deadlines and partial output', () => {
  it('keeps passed rows while timing out unfinished results', () =>
    clock(async () => {
      const h = harness(id => json(snapshot(id, 'running', ['PASSED', 'RUNNING'])));
      await expect(h.wait()).rejects.toMatchObject({
        exitCode: 7,
        details: { runIds: ['e1'], timedOutResultIds: ['e1-1'] },
      });
      expect(h.doc().partial).toBe(true);
      expect(h.doc().results.map((r: { status: string }) => r.status)).toEqual([
        'passed',
        'timeout',
      ]);
    }));
  it('takes one final listing when a result settles at the deadline', () =>
    clock(async () => {
      const start = Date.now();
      const h = harness(id =>
        json(
          snapshot(id, Date.now() - start >= 6000 ? 'finished' : 'running', [
            Date.now() - start >= 6000 ? 'PASSED' : 'RUNNING',
          ]),
        ),
      );
      expect((await h.wait()).summary.passed).toBe(1);
    }));
  it('cuts a hanging first read after the bounded grace and names the unlisted run', () =>
    clock(async () => {
      const start = Date.now();
      const h = harness(() => 'hang');
      await expect(h.wait()).rejects.toMatchObject({ exitCode: 7, details: { runIds: ['e1'] } });
      expect(Date.now() - start).toBeLessThanOrEqual(8100);
      expect(h.doc().runs[0]).toMatchObject({ runId: 'e1', listed: false, timedOut: true });
    }));
  it('keeps concurrent runs on the same deadline', () =>
    clock(async () => {
      const start = Date.now();
      const h = harness(() => 'hang');
      await expect(h.wait(['e1', 'e2'])).rejects.toMatchObject({
        exitCode: 7,
      });
      expect(Date.now() - start).toBeLessThanOrEqual(10200);
    }));
  it('starts one independent waiter for each run', () =>
    clock(async () => {
      let active = 0;
      let peak = 0;
      const h = harness((_id, _n, init) => {
        active++;
        peak = Math.max(peak, active);
        init.signal!.addEventListener('abort', () => active--);
        return 'hang';
      });
      await h.wait(['e1', 'e2', 'e3']).catch(() => undefined);
      expect(peak).toBe(3);
    }));
  it('names every timed-out run', () =>
    clock(async () => {
      const h = harness(id => json(snapshot(id, 'running', ['RUNNING'])));
      await expect(h.wait(['e1', 'e2'])).rejects.toMatchObject({
        exitCode: 7,
        details: { runId: null, runIds: ['e1', 'e2'] },
      });
    }));
  it('preserves a per-request timeout and earlier snapshots', () =>
    clock(async () => {
      const h = harness((id, n) =>
        n === 1 ? json(snapshot(id, 'running', ['PASSED', 'RUNNING'])) : 'request-timeout',
      );
      await expect(h.wait()).rejects.toBeInstanceOf(RequestTimeoutError);
      expect(h.doc().partial).toBe(true);
      expect(h.doc().results.map((r: { status: string }) => r.status)).toEqual([
        'passed',
        'running',
      ]);
    }));
  it('prints a parseable unlisted run on a first-request timeout', async () => {
    const h = harness(() => 'request-timeout');
    await expect(h.wait()).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(h.doc().runs[0]).toEqual({ runId: 'e1', listed: false });
  });
});

describe('run wait: errors, throttling and outages', () => {
  it.each([
    ['AUTH_INVALID', 401, 3],
    ['CLIENT_TOO_OLD', 426, 14],
    ['VALIDATION_ERROR', 400, 5],
    ['INSUFFICIENT_CREDITS', 402, 12],
    ['CONFLICT', 409, 6],
  ] as const)('keeps %s and its raw server fields', async (code, status, exitCode) => {
    const h = harness(() => fail(code, status));
    await expect(h.wait()).rejects.toMatchObject({
      code,
      exitCode,
      message: `${code} from server`,
      nextAction: 'Server instruction.',
    });
    expect(h.stdout).toHaveLength(1);
  });
  it('unknown run wins over a later request timeout', async () => {
    const h = harness(id =>
      id === 'e1' ? fail('NOT_FOUND', 404, { resource: 'run' }) : 'request-timeout',
    );
    await expect(h.wait(['e1', 'e2'])).rejects.toMatchObject({
      exitCode: 4,
    });
    expect(h.doc()).toMatchObject({
      partial: true,
      results: [],
      runs: [
        { runId: 'e1', error: { code: 'NOT_FOUND' } },
        { runId: 'e2', listed: false },
      ],
    });
  });
  it('unknown run wins over another run timeout', () =>
    clock(async () => {
      const h = harness(id => (id === 'e1' ? fail('NOT_FOUND', 404, { resource: 'run' }) : 'hang'));
      await expect(h.wait(['e1', 'e2'])).rejects.toMatchObject({ exitCode: 4 });
    }));
  it('reads through a transient rate limit to a verdict', () =>
    clock(async () => {
      const h = harness((id, n) => (n < 3 ? fail('RATE_LIMITED', 429) : json(snapshot(id))));
      expect((await h.wait()).summary.passed).toBe(1);
    }));
  it('persistent throttling at the deadline remains a timeout', () =>
    clock(async () => {
      const h = harness(() => fail('RATE_LIMITED', 429));
      await expect(h.wait()).rejects.toMatchObject({ exitCode: 7 });
    }));
  it('does not retry a standing rate limit', async () => {
    const h = harness(() => fail('RATE_LIMITED', 429, { reason: 'inflight_cap' }));
    await expect(h.wait()).rejects.toMatchObject({ exitCode: 11 });
  });
  it('recovers from an outage after a successful listing', () =>
    clock(async () => {
      const h = harness((id, n) =>
        n === 1
          ? json(snapshot(id, 'running', ['RUNNING']))
          : n < 4
            ? fail('UNAVAILABLE', 503)
            : json(snapshot(id)),
      );
      expect((await h.wait(['e1'], { timeoutSeconds: 20 })).summary.passed).toBe(1);
    }));
  it('an outage lasting through the deadline preserves exit 10 and raw server diagnostics', () =>
    clock(async () => {
      const h = harness(() => fail('UNAVAILABLE', 503));
      await expect(h.wait()).rejects.toMatchObject({
        exitCode: 10,
        message: 'UNAVAILABLE from server',
        nextAction: 'Server instruction.',
        details: {},
        requestId: 'server-id',
      });
    }));
  it('preserves completed rows when a later listing fails', () =>
    clock(async () => {
      const h = harness((id, n) =>
        n === 1 ? json(snapshot(id, 'running', ['PASSED', 'RUNNING'])) : fail('AUTH_INVALID', 401),
      );
      await expect(h.wait()).rejects.toMatchObject({ exitCode: 3 });
      expect(h.doc().results[0].status).toBe('passed');
      expect(h.doc().results[1]).toMatchObject({ status: 'error', errorCode: 'AUTH_INVALID' });
    }));
});

describe('run wait: signal ownership', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)('detaches on %s while a listing is outstanding', signal =>
    clock(async () => {
      const h = harness(() => 'hang');
      const pending = h.wait();
      setTimeout(() => h.shutdown.interrupt(signal), 100);
      const error = (await pending.catch(e => e)) as InterruptError;
      expect(error.exitCode).toBe(signal === 'SIGINT' ? 130 : 143);
      expect(h.doc().runs[0]).toEqual({ runId: 'e1', listed: false });
      expect(buildInterruptEnvelope(error).error.nextAction).toContain('testsprite run wait e1');
      expect(h.shutdown.isArmed).toBe(false);
    }),
  );
  it('interrupt during inter-read sleep retains passed rows', () =>
    clock(async () => {
      const h = harness(id => json(snapshot(id, 'running', ['PASSED', 'RUNNING'])));
      const pending = h.wait();
      setTimeout(() => h.shutdown.interrupt('SIGINT'), 100);
      await expect(pending).rejects.toBeInstanceOf(InterruptError);
      expect(h.doc().partial).toBe(true);
      expect(h.doc().results.map((r: { status: string }) => r.status)).toEqual([
        'passed',
        'running',
      ]);
    }));
  it('interrupt wins over a previously unknown run', () =>
    clock(async () => {
      const h = harness(id => (id === 'e1' ? fail('NOT_FOUND', 404, { resource: 'run' }) : 'hang'));
      const pending = h.wait(['e1', 'e2']);
      setTimeout(() => h.shutdown.interrupt('SIGINT'), 100);
      await expect(pending).rejects.toMatchObject({ exitCode: 130 });
    }));
  it('disarms once every run has finished', async () => {
    const h = harness();
    await h.wait();
    expect(h.shutdown.isArmed).toBe(false);
  });
});
