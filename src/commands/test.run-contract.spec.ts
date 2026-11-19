import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resultLine } from '../../test/helpers/result-list.js';
import { runTestCancel, runTestWait, runTestRunAll } from './test.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const waitOptions = {
  profile: 'default',
  debug: false,
  output: 'json' as const,
  apiKey: 'key',
  endpoint: 'https://api.example.com',
  runIds: ['run-1'],
  timeoutSeconds: 30,
};
const options = { ...waitOptions, maxConcurrency: 2 };
function harness(answer: (path: URL, init?: RequestInit) => Response | Promise<Response>) {
  const calls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    calls,
    stdout,
    stderr,
    deps: {
      env: { TESTSPRITE_API_KEY: 'sk-user-test', TESTSPRITE_API_URL: 'https://api.example.com' },
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
      sleep: async (_ms: number): Promise<void> => undefined,
      fetchImpl: async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        return answer(url, init);
      },
    },
  };
}
const run = (status: string, cancelled = false) => ({
  runId: 'run-1',
  projectId: 'p1',
  status,
  cancelled,
  created: '2026-11-15T00:00:00Z',
  modified: '2026-11-15T00:00:00Z',
  targetUrl: null,
  dashboardUrl: null,
});

describe('whole-run command contract', () => {
  it.each(['json', 'text'] as const)(
    'reports failed and blocked results across two runs in %s',
    async output => {
      const h = harness(url => {
        const runId = url.searchParams.get('run')!;
        const statuses = runId === 'run-1' ? ['PASSED', 'FAILED', 'BLOCKED'] : ['BLOCKED'];
        return json({
          run: { ...run('finished'), runId },
          results: statuses.map(testStatus =>
            resultLine({
              runId,
              resultId: runId + testStatus,
              testStatus,
              error: testStatus === 'PASSED' || runId === 'run-2' ? null : 'result detail',
              blockedReason: runId === 'run-2' ? 'missing prerequisite' : null,
            }),
          ),
        });
      });
      await expect(
        runTestWait({ ...waitOptions, runIds: ['run-1', 'run-2'], output }, h.deps),
      ).rejects.toMatchObject({
        exitCode: 1,
        message: '3 results did not pass (1 failed, 2 blocked).',
      });
      if (output === 'json') {
        const report = JSON.parse(h.stdout.join(''));
        expect(report.runs).toHaveLength(2);
        expect(report.summary).toMatchObject({ total: 4, passed: 1, failed: 1, blocked: 2 });
        expect(
          report.results.filter((row: { status: string }) => row.status === 'blocked'),
        ).toEqual([
          expect.objectContaining({ errorCode: 'TEST_BLOCKED', error: 'result detail' }),
          expect.objectContaining({ errorCode: 'TEST_BLOCKED', error: 'missing prerequisite' }),
        ]);
        expect(
          report.results.find((row: { status: string }) => row.status === 'failed').errorCode,
        ).toBe('TEST_FAILED');
      } else {
        expect(h.stdout.join('')).toContain('1/4 passed, 1 failed, 2 blocked');
      }
    },
  );

  it('counts a cancelled result once when its execution was also cancelled', async () => {
    const h = harness(() =>
      json({
        run: run('finished', true),
        results: [
          resultLine({ runId: 'run-1', resultId: 'cancelled-result', testStatus: 'CANCELLED' }),
        ],
      }),
    );
    await expect(runTestWait(waitOptions, h.deps)).rejects.toMatchObject({ exitCode: 1 });
    expect(JSON.parse(h.stdout.join(''))).toMatchObject({
      summary: { total: 1, failed: 0, cancelled: 1 },
      runFailures: [{ runId: 'run-1', status: 'cancelled' }],
    });
  });
  it('waits through the integration gap and includes results added after the first listing', async () => {
    let reads = 0;
    const h = harness(url => {
      if (!url.pathname.endsWith('/results')) throw new Error(`unexpected per-result poll ${url}`);
      reads++;
      return json({
        run: run(reads < 3 ? 'running' : 'finished'),
        results: [
          resultLine({ resultId: 'unit', runId: 'run-1', testStatus: 'PASSED' }),
          ...(reads === 3
            ? [
                resultLine({
                  resultId: 'integration',
                  runId: 'run-1',
                  testStatus: 'PASSED',
                  created: '2026-11-16T00:00:00Z',
                }),
              ]
            : []),
        ],
      });
    });
    const result = await runTestWait(waitOptions, h.deps);
    expect(reads).toBe(3);
    expect(result.results.map(row => row.resultId)).toEqual(['unit', 'integration']);
    expect(result.summary).toMatchObject({ total: 2, passed: 2 });
    expect(JSON.parse(h.stdout.join('')).runs[0].runId).toBe('run-1');
  });

  it('does not pass a finished cancelled run with only passed results', async () => {
    const h = harness(() =>
      json({
        run: run('finished', true),
        results: [resultLine({ resultId: 'unit', runId: 'run-1', testStatus: 'PASSED' })],
      }),
    );
    await expect(runTestWait(waitOptions, h.deps)).rejects.toMatchObject({ exitCode: 1 });
    expect(JSON.parse(h.stdout.join('')).runs[0]).toMatchObject({
      runId: 'run-1',
      cancelled: true,
    });
  });

  it('cancels once per unique run without listing and retains failed refunds', async () => {
    const h = harness((url, init) => {
      expect(init?.method).toBe('POST');
      expect(url.pathname).toBe('/api/cli/v1/runs/run-1/cancel');
      return json({
        runId: 'run-1',
        alreadyCancelled: false,
        alreadyFinished: false,
        results: [
          {
            resultId: 'result-1',
            runId: 'run-1',
            testId: 'test-1',
            title: 'Test',
            status: 'cancelled',
            alreadyCancelled: false,
            alreadyFinished: false,
            refund: { status: 'failed' },
          },
        ],
      });
    });
    await runTestCancel({ ...options, runIds: ['run-1', 'run-1'] }, h.deps);
    expect(h.calls).toEqual(['POST /api/cli/v1/runs/run-1/cancel']);
    expect(JSON.parse(h.stdout.join('')).runs[0].results[0]).toMatchObject({
      resultId: 'result-1',
      refund: { status: 'failed' },
    });
  });
});

describe('project launch command contract', () => {
  it('sends 60 named tests in one strict project request', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `test-${i}`);
    const bodies: unknown[] = [];
    const h = harness((url, init) => {
      if (init?.method !== 'POST') return json({ environments: [] });
      bodies.push(JSON.parse(String(init.body)));
      expect(url.pathname).toBe('/api/cli/v1/projects/p1/runs');
      return json({
        runId: 'run-1',
        projectId: 'p1',
        total: 60,
        enqueuedAt: '2026-11-15T00:00:00Z',
        autoHeal: true,
        environment: null,
        targetUrl: null,
        blocked: [],
        held: [],
      });
    });
    await runTestRunAll(
      {
        ...options,
        testIds: ids,
        wait: false,
        noWait: true,
        knownTests: new Map(ids.map(id => [id, { projectId: 'p1', type: 'frontend' as const }])),
      },
      h.deps,
    );
    expect(bodies).toEqual([{ testIds: ids, maxConcurrency: 2 }]);
    expect(JSON.parse(h.stdout.join('')).runs[0]).toMatchObject({ runId: 'run-1', total: 60 });
    expect(JSON.parse(h.stdout.join('')).accepted).toBeUndefined();
  });
});

const launch = (overrides: Record<string, unknown> = {}) => ({
  runId: 'run-1',
  projectId: 'p1',
  total: 1,
  enqueuedAt: '2026-11-15T00:00:00Z',
  autoHeal: true,
  environment: null,
  targetUrl: null,
  blocked: [],
  held: [],
  ...overrides,
});

describe('project launch membership and errors', () => {
  it('lets the server select an unfiltered project without enumerating tests', async () => {
    const h = harness((url, init) => {
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ maxConcurrency: 2 });
        return json(launch());
      }
      expect(url.pathname).toBe('/api/cli/v1/projects/p1/env');
      return json({ environments: [] });
    });
    await runTestRunAll({ ...options, projectId: 'p1', wait: false }, h.deps);
    expect(h.calls.filter(row => row.startsWith('POST'))).toHaveLength(1);
  });

  it('launches one request for each project in a multi-project named selection', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `test-${i}`);
    const knownTests = new Map(
      ids.map((id, i) => [id, { projectId: i < 60 ? 'p1' : 'p2', type: 'frontend' as const }]),
    );
    const h = harness((url, init) => {
      if (init?.method !== 'POST') return json({ environments: [] });
      const projectId = url.pathname.split('/').at(-2)!;
      expect(JSON.parse(String(init.body)).testIds).toEqual(
        projectId === 'p1' ? ids.slice(0, 60) : ids.slice(60),
      );
      return json(launch({ runId: `run-${projectId}`, projectId, total: 60 }));
    });
    await runTestRunAll(
      { ...options, testIds: ids, knownTests, wait: false, noWait: true },
      h.deps,
    );
    expect(h.calls.filter(row => row.startsWith('POST'))).toEqual([
      'POST /api/cli/v1/projects/p1/runs',
      'POST /api/cli/v1/projects/p2/runs',
    ]);
  });

  it('rejects more than 5000 named IDs before dispatch rather than splitting the request', async () => {
    const ids = Array.from({ length: 5001 }, (_, i) => `test-${i}`);
    const h = harness(() => {
      throw new Error('no request permitted');
    });
    await expect(
      runTestRunAll(
        {
          ...options,
          testIds: ids,
          wait: false,
          knownTests: new Map(ids.map(id => [id, { projectId: 'p1', type: 'frontend' as const }])),
        },
        h.deps,
      ),
    ).rejects.toMatchObject({
      exitCode: 5,
      details: { field: 'test-id', reason: expect.stringContaining('5000') },
    });
    expect(h.calls).toEqual([]);
  });

  it('retains raw backend launch error message, nextAction and native details', async () => {
    const error = {
      code: 'CONFLICT',
      message: 'run raw-value is still active',
      nextAction: 'check raw-value unchanged',
      requestId: 'request-1',
      details: {
        currentRunId: 'raw-value',
        currentResultId: 'result-value',
        opaque: { runId: 'unchanged' },
      },
    };
    const h = harness((url, init) =>
      init?.method === 'POST' ? json({ error }, 409) : json({ environments: [] }),
    );
    await expect(
      runTestRunAll({ ...options, projectId: 'p1', wait: false }, h.deps),
    ).rejects.toMatchObject(error);
    expect(h.calls.filter(row => row.startsWith('POST'))).toHaveLength(1);
  });

  it('waits for the launched run through an integration gap and reports the late row', async () => {
    let reads = 0;
    const h = harness((url, init) => {
      if (init?.method === 'POST') return json(launch());
      if (url.pathname.endsWith('/env')) return json({ environments: [] });
      expect(url.pathname).toBe('/api/cli/v1/results');
      reads++;
      return json({
        run: run(reads < 3 ? 'running' : 'finished'),
        results: [
          resultLine({ resultId: 'unit', runId: 'run-1', caseKey: 'test-1', testStatus: 'PASSED' }),
          ...(reads === 3
            ? [
                resultLine({
                  resultId: 'integration',
                  runId: 'run-1',
                  testStatus: 'FAILED',
                  created: '2026-11-16T00:00:00Z',
                }),
              ]
            : []),
        ],
      });
    });
    await expect(
      runTestRunAll({ ...options, projectId: 'p1', wait: true }, h.deps),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(reads).toBe(3);
    const output = JSON.parse(h.stdout.join(''));
    expect(output.results.map((row: { resultId: string }) => row.resultId)).toEqual([
      'unit',
      'integration',
    ]);
    expect(output.summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(output).not.toHaveProperty('partial');
  });

  it('keeps a finished cancelled launch red even when all listed rows passed', async () => {
    const h = harness((url, init) =>
      init?.method === 'POST'
        ? json(launch())
        : url.pathname.endsWith('/env')
          ? json({ environments: [] })
          : json({
              run: run('finished', true),
              results: [resultLine({ resultId: 'unit', runId: 'run-1', testStatus: 'PASSED' })],
            }),
    );
    await expect(
      runTestRunAll({ ...options, projectId: 'p1', wait: true }, h.deps),
    ).rejects.toMatchObject({ exitCode: 1 });
  });

  it('preserves successful project receipts when a later project launch fails', async () => {
    const h = harness((url, init) => {
      if (init?.method !== 'POST') return json({ environments: [] });
      return url.pathname.includes('/p1/')
        ? json(launch())
        : json(
            {
              error: {
                code: 'RATE_LIMITED',
                message: 'busy',
                requestId: 'r',
                nextAction: 'retry later',
                details: {},
              },
            },
            429,
          );
    });
    await expect(
      runTestRunAll(
        {
          ...options,
          wait: false,
          noWait: true,
          testIds: ['one', 'two'],
          knownTests: new Map([
            ['one', { projectId: 'p1', type: 'frontend' }],
            ['two', { projectId: 'p2', type: 'frontend' }],
          ]),
        },
        h.deps,
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', exitCode: 11 });
    expect(JSON.parse(h.stdout.join(''))).toMatchObject({
      runs: [{ runId: 'run-1' }],
      notRunProjects: ['p2'],
    });
    expect(JSON.parse(h.stdout.join(''))).not.toHaveProperty('partial');
  });
});

it('publishes a cancelled execution failure to summary and JUnit without inventing a result ID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-cancelled-report-'));
  const reportFile = join(dir, 'junit.xml');
  const h = harness((url, init) =>
    init?.method === 'POST'
      ? json(launch())
      : url.pathname.endsWith('/env')
        ? json({ environments: [] })
        : json({
            run: run('finished', true),
            results: [
              resultLine({
                resultId: 'unit',
                runId: 'run-1',
                caseKey: 'test-1',
                testStatus: 'PASSED',
              }),
            ],
          }),
  );
  try {
    await expect(
      runTestRunAll(
        {
          ...options,
          projectId: 'p1',
          wait: true,
          report: 'junit',
          reportFile,
          ci: { executionReport: false },
        },
        h.deps,
      ),
    ).rejects.toMatchObject({ exitCode: 1 });
    const output = JSON.parse(h.stdout.join(''));
    expect(output.runFailures).toEqual([
      { runId: 'run-1', status: 'cancelled', message: 'Run run-1 was cancelled.' },
    ]);
    expect(output.summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(output.summary.results).toHaveLength(1);
    expect(output.results).toEqual([
      expect.objectContaining({ resultId: 'unit', status: 'passed' }),
    ]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed report filename inside this test's mkdtemp directory.
    const junit = readFileSync(reportFile, 'utf8');
    expect(junit).toContain('<failure');
    expect(junit).toContain('Run run-1 was cancelled.');
    expect(junit).not.toContain('resultId="run-1"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('project target override capability', () => {
  it.each(['frontend', 'backend'])(
    'reads %s project metadata without enumerating tests before one launch',
    async type => {
      let body: Record<string, unknown> | undefined;
      const h = harness((url, init) => {
        if (url.pathname.endsWith('/projects/p1')) return json({ id: 'p1', type });
        if (init?.method === 'POST' && url.pathname.endsWith('/projects/p1/runs')) {
          body = JSON.parse(String(init.body));
          return json({
            runId: 'run-1',
            projectId: 'p1',
            total: 2,
            enqueuedAt: '2026-11-15T00:00:00Z',
            autoHeal: true,
            environment: null,
            targetUrl: body?.targetUrl ?? null,
            blocked: [],
            held: [],
          });
        }
        throw new Error(`Unexpected metadata or enumeration request ${url}`);
      });
      await runTestRunAll(
        {
          ...options,
          wait: false,
          projectId: 'p1',
          targetUrl: 'https://preview.example.com',
          skipPreflight: true,
        },
        h.deps,
      );
      expect(h.calls).toEqual(['GET /api/cli/v1/projects/p1', 'POST /api/cli/v1/projects/p1/runs']);
      expect(body).not.toHaveProperty('testIds');
      expect(body?.targetUrl).toBe(type === 'frontend' ? 'https://preview.example.com' : undefined);
      expect(h.stderr.join('\n').includes('backend code uses its selected environment')).toBe(
        type === 'backend',
      );
    },
  );
  it('preserves project type authorization errors before any launch', async () => {
    const error = {
      code: 'AUTH_FORBIDDEN',
      message: 'Project scope denied',
      nextAction: 'Use the authorized key',
      requestId: 'req-project',
      details: { projectId: 'p1' },
    };
    const h = harness(() => json(error, 403));
    await expect(
      runTestRunAll(
        {
          ...options,
          wait: false,
          projectId: 'p1',
          targetUrl: 'https://preview.example.com',
          skipPreflight: true,
        },
        h.deps,
      ),
    ).rejects.toMatchObject({ ...error, exitCode: 3 });
    expect(h.calls).toEqual(['GET /api/cli/v1/projects/p1']);
  });
});

describe('unfinished execution artifacts', () => {
  it.each(['gap-timeout', 'read-error', 'empty-timeout'])(
    'keeps real verdicts and represents %s in CI summary and JUnit',
    async mode => {
      vi.useFakeTimers();
      const dir = mkdtempSync(join(tmpdir(), 'run-gap-report-'));
      const reportFile = join(dir, 'junit.xml');
      let reads = 0;
      const h = harness((url, init) => {
        if (init?.method === 'POST') return json(launch());
        if (url.pathname.endsWith('/env')) return json({ environments: [] });
        if (++reads > 1 && mode === 'read-error')
          return json(
            {
              error: {
                code: 'UNAVAILABLE',
                message: 'Original gap outage',
                nextAction: 'Server action',
                requestId: 'gap-error',
                details: { marker: 'raw' },
              },
            },
            503,
          );
        return json({
          run: run('running'),
          results:
            mode === 'empty-timeout'
              ? []
              : [
                  resultLine({
                    resultId: 'unit',
                    runId: 'run-1',
                    caseKey: 'test-1',
                    testStatus: 'PASSED',
                  }),
                ],
        });
      });
      h.deps.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      try {
        const pending = runTestRunAll(
          {
            ...options,
            timeoutSeconds: 6,
            projectId: 'p1',
            wait: true,
            report: 'junit',
            reportFile,
            ci: { executionReport: false },
          },
          h.deps,
        ).catch(e => e);
        await vi.advanceTimersByTimeAsync(8_001);
        const error = await pending;
        expect(error.exitCode).toBe(mode === 'read-error' ? 10 : 7);
        if (mode === 'read-error')
          expect(error).toMatchObject({
            message: 'Original gap outage',
            nextAction: 'Server action',
            details: { marker: 'raw' },
          });
        const output = JSON.parse(h.stdout.join(''));
        expect(output.summary).toMatchObject({
          total: mode === 'empty-timeout' ? 0 : 1,
          failed: 0,
          timedOut: 0,
        });
        expect(output.runFailures).toEqual([
          expect.objectContaining({
            runId: 'run-1',
            status: mode === 'read-error' ? 'error' : 'timeout',
          }),
        ]);
        expect(output.results).toEqual(
          mode === 'empty-timeout'
            ? []
            : [expect.objectContaining({ resultId: 'unit', status: 'passed' })],
        );
        if (mode !== 'read-error') expect(output.runs[0].timedOut).toBe(true);
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed report filename inside this test's mkdtemp directory.
        const junit = readFileSync(reportFile, 'utf8');
        expect(junit).toMatch(/<(failure|error)/);
        expect(junit).not.toContain('resultId="run-1"');
      } finally {
        vi.useRealTimers();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
