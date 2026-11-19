import { describe, expect, it, vi } from 'vitest';
import { runTestRunAll, runTestWait } from './test.js';
import { runTestlistRun } from './testlist.js';
import { RequestTimeoutError } from '../lib/errors.js';
import { TunnelLostError } from '../lib/tunnel-session.js';
import { makeHttpClient } from '../lib/client-factory.js';
import type { EnvironmentTunnelContext } from '../lib/environment-tunnel.js';
import { ShutdownController } from '../lib/interrupt.js';
import { resultLine } from '../../test/helpers/result-list.js';
import { projectRun, runListing } from '../../test/helpers/project-run.js';

const options = { profile: 'default', debug: false, output: 'json' as const, timeoutSeconds: 30 };
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
const rows = (runId: string, count = 1) =>
  Array.from({ length: count }, (_, i) =>
    resultLine({
      runId,
      resultId: `${runId}-${i}`,
      caseKey: `${runId}-case-${i}`,
      testStatus: 'PASSED',
    }),
  );
const listing = (runId: string, status: 'running' | 'finished' = 'finished', count = 1) =>
  runListing({ runId, status, cancelled: false }, rows(runId, count));

/** Hold first reads until the assertion, then release even on a failed assertion. */
function firstReads() {
  const reads: string[] = [];
  const pending: Array<() => void> = [];
  let released = false;
  return {
    reads,
    fetch: (id: string) => {
      reads.push(id);
      if (released) return Promise.resolve(json(listing(id)));
      return new Promise<Response>(resolve => pending.push(() => resolve(json(listing(id)))));
    },
    release: () => {
      released = true;
      pending
        .splice(0)
        .reverse()
        .forEach(resolve => resolve());
    },
  };
}
function harness(answer: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const stdout: string[] = [];
  const shutdown = new ShutdownController();
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  return {
    stdout,
    shutdown,
    requests,
    deps: {
      env: { TESTSPRITE_API_KEY: 'sk-user-test', TESTSPRITE_API_URL: 'https://api.example.com' },
      shutdown,
      sleep: async () => {},
      stdout: (line: string) => {
        stdout.push(line);
      },
      stderr: () => {},
      fetchImpl: async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
        const url = new URL(String(input));
        requests.push({ url, init });
        return answer(url, init);
      },
    },
  };
}
const testlistResponse = {
  accepted: ['a', 'b', 'a'].map((id, i) => ({
    testId: `${id}-case-${i}`,
    resultId: `${id}-0`,
    runId: id,
    enqueuedAt: '2026-11-15T00:00:00Z',
  })),
  conflicts: [],
  deferred: [],
};
function listAnswer(url: URL): Response {
  if (url.pathname.endsWith('/run')) return json(testlistResponse);
  return json({ id: 'list-1', cases: [], projectEnvironments: [] });
}

describe('independent execution waits', () => {
  it('starts all 12 distinct explicit runs before any first read settles', async () => {
    const gate = firstReads();
    const ids = Array.from({ length: 12 }, (_, i) => `run-${i}`);
    const h = harness(url => {
      expect(url.pathname).toBe('/api/cli/v1/results');
      return gate.fetch(url.searchParams.get('run')!);
    });
    const pending = runTestWait({ ...options, runIds: [...ids, ids[0]!] }, h.deps);
    try {
      await vi.waitFor(() => expect(gate.reads).toEqual(ids), { timeout: 200, interval: 10 });
    } finally {
      gate.release();
      await pending;
    }
    expect(JSON.parse(h.stdout[0]!).runs.map((run: { runId: string }) => run.runId)).toEqual(ids);
  });

  it('reads 60 results through one execution stream including later integration', async () => {
    let reads = 0;
    const ids = Array.from({ length: 60 }, (_, i) => `case-${i}`);
    const h = harness((url, init) => {
      if (init.method === 'POST')
        return json(projectRun({ runId: 'run-1', projectId: 'p1', total: 60 }));
      if (url.pathname.endsWith('/env')) return json({ environments: [] });
      expect(url.pathname).toBe('/api/cli/v1/results');
      expect(url.searchParams.get('run')).toBe('run-1');
      expect(url.searchParams.get('status')).toBe('passed,failed,running,blocked,cancelled');
      reads++;
      return json(listing('run-1', reads === 1 ? 'running' : 'finished', reads === 1 ? 60 : 61));
    });
    await runTestRunAll(
      {
        ...options,
        testIds: ids,
        wait: true,
        maxConcurrency: 1,
        knownTests: new Map(ids.map(id => [id, { projectId: 'p1', type: 'frontend' as const }])),
      },
      h.deps,
    );
    expect(reads).toBe(2);
    expect(h.requests.filter(r => r.init.method === 'POST')).toHaveLength(1);
    expect(JSON.parse(h.stdout[0]!).results).toHaveLength(61);
  });

  it('starts both project waits while retaining server cap one on each launch', async () => {
    const gate = firstReads();
    const h = harness((url, init) => {
      if (init.method === 'POST') {
        expect(JSON.parse(String(init.body)).maxConcurrency).toBe(1);
        const projectId = url.pathname.split('/').at(-2)!;
        return json(projectRun({ runId: projectId, projectId }));
      }
      if (url.pathname.endsWith('/env')) return json({ environments: [] });
      expect(url.pathname).toBe('/api/cli/v1/results');
      return gate.fetch(url.searchParams.get('run')!);
    });
    const pending = runTestRunAll(
      {
        ...options,
        testIds: ['a', 'b'],
        wait: true,
        maxConcurrency: 1,
        knownTests: new Map(
          ['a', 'b'].map(id => [id, { projectId: id, type: 'frontend' as const }]),
        ),
      },
      h.deps,
    );
    try {
      await vi.waitFor(() => expect(gate.reads).toEqual(['a', 'b']), {
        timeout: 200,
        interval: 10,
      });
    } finally {
      gate.release();
      await pending;
    }
    expect(JSON.parse(h.stdout[0]!).results.map((row: { runId: string }) => row.runId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('starts both distinct test-list waits before either first read settles', async () => {
    const gate = firstReads();
    const h = harness((url, init) => {
      if (url.pathname.endsWith('/results')) return gate.fetch(url.searchParams.get('run')!);
      if (init.method === 'POST') expect(JSON.parse(String(init.body)).maxConcurrency).toBe(1);
      return listAnswer(url);
    });
    const pending = runTestlistRun(
      { ...options, listId: 'list-1', wait: true, maxConcurrency: 1 },
      h.deps,
    );
    try {
      await vi.waitFor(() => expect(gate.reads).toEqual(['a', 'b']), {
        timeout: 200,
        interval: 10,
      });
    } finally {
      gate.release();
      await pending;
    }
    expect(JSON.parse(h.stdout[0]!).results.map((row: { runId: string }) => row.runId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('retains another test-list snapshot when one execution fails with an API error', async () => {
    const gate = firstReads();
    const h = harness(url => {
      if (!url.pathname.endsWith('/results')) return listAnswer(url);
      const id = url.searchParams.get('run')!;
      if (id === 'a')
        return json({
          error: {
            code: 'AUTH_FORBIDDEN',
            message: 'Original refusal',
            nextAction: 'Original action',
            requestId: 'server-id',
            details: { marker: 'raw' },
          },
        });
      return gate.fetch(id);
    });
    // Set the error's HTTP status without changing the raw envelope.
    const fetchImpl = h.deps.fetchImpl;
    h.deps.fetchImpl = async (input, init) => {
      const response = await fetchImpl(input, init);
      return new URL(String(input)).searchParams.get('run') === 'a'
        ? new Response(await response.text(), { status: 403, headers: response.headers })
        : response;
    };
    const pending = runTestlistRun(
      { ...options, listId: 'list-1', wait: true, maxConcurrency: 1 },
      h.deps,
    ).catch(error => error);
    try {
      await vi.waitFor(() => expect(gate.reads).toEqual(['b']), { timeout: 200, interval: 10 });
    } finally {
      gate.release();
    }
    expect(await pending).toMatchObject({
      message: 'Original refusal',
      nextAction: 'Original action',
      details: { marker: 'raw' },
      exitCode: 3,
    });
    expect(JSON.parse(h.stdout[0]!).results).toContainEqual(
      expect.objectContaining({ runId: 'b', status: 'passed' }),
    );
  });

  it('aborts and settles all outstanding test-list reads before returning interrupt partials', async () => {
    const reads: string[] = [],
      settled: string[] = [];
    const h = harness((url, init) => {
      if (!url.pathname.endsWith('/results')) return listAnswer(url);
      const id = url.searchParams.get('run')!;
      reads.push(id);
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener(
          'abort',
          () => {
            settled.push(id);
            reject(init.signal!.reason);
          },
          { once: true },
        );
      });
    });
    const pending = runTestlistRun(
      { ...options, listId: 'list-1', wait: true, maxConcurrency: 1 },
      h.deps,
    ).catch(error => error);
    try {
      await vi.waitFor(() => expect(reads).toEqual(['a', 'b']), { timeout: 200, interval: 10 });
    } finally {
      h.shutdown.interrupt('SIGINT');
      await pending;
    }
    expect(await pending).toMatchObject({ exitCode: 130 });
    expect(settled.sort()).toEqual(['a', 'b']);
    expect(JSON.parse(h.stdout[0]!).results.map((r: { resultId: string }) => r.resultId)).toEqual([
      'a-0',
      'b-0',
    ]);
  });
  it.each(['wait', 'run', 'testlist'] as const)(
    '%s keeps an operational refusal ahead of a sibling request timeout',
    async command => {
      const h = harness((url, init) => {
        if (url.pathname.endsWith('/results')) {
          if (url.searchParams.get('run') === 'b') throw new RequestTimeoutError(1000, 'request');
          return new Response(
            JSON.stringify({
              error: {
                code: 'AUTH_FORBIDDEN',
                message: 'Original refusal',
                nextAction: 'Server instruction',
                requestId: 'server-id',
                details: { marker: 'raw' },
              },
            }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          );
        }
        if (command === 'testlist') return listAnswer(url);
        if (init.method === 'POST') {
          const projectId = url.pathname.split('/').at(-2)!;
          return json(projectRun({ runId: projectId, projectId }));
        }
        return json({ environments: [] });
      });
      const pending =
        command === 'wait'
          ? runTestWait({ ...options, runIds: ['a', 'b'] }, h.deps)
          : command === 'testlist'
            ? runTestlistRun(
                { ...options, listId: 'list-1', wait: true, maxConcurrency: 1 },
                h.deps,
              )
            : runTestRunAll(
                {
                  ...options,
                  testIds: ['a', 'b'],
                  wait: true,
                  maxConcurrency: 1,
                  knownTests: new Map(
                    ['a', 'b'].map(id => [id, { projectId: id, type: 'frontend' as const }]),
                  ),
                },
                h.deps,
              );
      await expect(pending).rejects.toMatchObject({
        exitCode: 3,
        message: 'Original refusal',
        nextAction: 'Server instruction',
        details: { marker: 'raw' },
      });
      expect(h.requests.filter(r => r.url.pathname.endsWith('/results'))).toHaveLength(2);
    },
  );

  it.each([
    ['testlist', 'auth-failed'],
    ['testlist', 'owner-gone'],
    ['run', 'auth-failed'],
    ['run', 'owner-gone'],
  ] as const)(
    '%s settles sibling reads before cleanup after tunnel %s',
    async (command, reason) => {
      const counts = new Map<string, number>();
      const events: string[] = [];
      let releaseHook: (() => void) | undefined;
      const failure = new TunnelLostError(reason, { runId: 'a' });
      const h = harness((url, init) => {
        if (init.method === 'POST') {
          if (command === 'testlist')
            return json({ ...testlistResponse, maxConcurrency: 1, tunnelClientId: 'tunnel-1' });
          const projectId = url.pathname.split('/').at(-2)!;
          return json(projectRun({ runId: projectId, projectId }));
        }
        if (!url.pathname.endsWith('/results')) return listAnswer(url);
        const id = url.searchParams.get('run')!;
        const n = (counts.get(id) ?? 0) + 1;
        counts.set(id, n);
        if (n === 1) return json(listing(id, 'running'));
        events.push(`reading:${id}`);
        releaseHook?.();
        return new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener(
            'abort',
            () => {
              events.push(`settled:${id}`);
              reject(init.signal!.reason);
            },
            { once: true },
          );
        });
      });
      const target = {
        host: 'localhost' as const,
        port: 3000,
        targetUrl: 'http://localhost:3000',
        automatic: true,
      };
      const cancelActive = vi.fn(async () => {
        expect(events).toContain('settled:b');
        events.push('cleanup');
      });
      const environmentTunnel: EnvironmentTunnelContext = {
        client: makeHttpClient(options, h.deps),
        clientId: 'tunnel-1',
        maxConcurrency: 1,
        targets: new Map([
          ['a', target],
          ['b', target],
        ]),
        deadlineMs: Date.now() + 30_000,
        session: { adopted: reason === 'owner-gone' } as EnvironmentTunnelContext['session'],
        cancellation: () => undefined,
        cancelActive,
        resultStatus: () => undefined,
        confirm: async () => {},
        onRead: async (snapshot, signal) => {
          if (snapshot.run.runId !== 'a') return;
          await new Promise<void>((resolve, reject) => {
            releaseHook = resolve;
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
          throw failure;
        },
      };
      const close = vi.fn(() => {
        expect(events).toContain('settled:b');
        events.push('close');
      });
      const operation =
        command === 'testlist'
          ? runTestlistRun(
              { ...options, listId: 'list-1', wait: true, maxConcurrency: 1 },
              { ...h.deps, environmentTunnel },
            )
          : runTestRunAll(
              {
                ...options,
                testIds: ['a', 'b'],
                wait: true,
                maxConcurrency: 1,
                knownTests: new Map(
                  ['a', 'b'].map(id => [id, { projectId: id, type: 'frontend' as const }]),
                ),
              },
              { ...h.deps, environmentTunnel },
            );
      const pending = operation.catch(error => error).finally(close);
      try {
        await vi.waitFor(() => expect(events).toContain('reading:b'), {
          timeout: 200,
          interval: 10,
        });
        await vi.waitFor(() => expect(events).toContain('settled:b'), {
          timeout: 200,
          interval: 10,
        });
        expect(await pending).toBe(failure);
      } finally {
        h.shutdown.interrupt('SIGINT');
        releaseHook?.();
        await pending;
      }
      expect(cancelActive).toHaveBeenCalledTimes(1);
      expect(events).toEqual(['reading:b', 'settled:b', 'cleanup', 'close']);
      expect(close).toHaveBeenCalledTimes(1);
      const partial = JSON.parse(h.stdout[0]!);
      expect(partial.runs.map((r: { runId: string }) => r.runId)).toEqual(['a', 'b']);
    },
  );
});
