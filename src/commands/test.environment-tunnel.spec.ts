import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixture, cases, json } from '../../test/helpers/local-project.js';
import { runListing } from '../../test/helpers/project-run.js';
import { resultLine } from '../../test/helpers/result-list.js';
import { runTestlistRun } from './testlist.js';
import { ShutdownController } from '../lib/interrupt.js';
import { takeTelemetryExtras } from '../lib/telemetry.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  takeTelemetryExtras();
});
describe('automatic environment project dispatch', () => {
  it('selects frontend members for automatic project selection only after finding a loopback environment', async () => {
    const h = fixture([...cases(2), { id: 'backend', projectId: 'P', type: 'backend' }]);
    await h.run(['--project', 'P']);
    expect(h.launches()[0]!.body?.testIds).toEqual(['test-0', 'test-1']);
    expect(h.output().skipped).toEqual([{ testId: 'backend', reason: 'backend-test' }]);
  });
  it('keeps backend-only automatic project selection on the ordinary path', async () => {
    const h = fixture([{ id: 'backend', projectId: 'P', type: 'backend' }]);
    await h.run(['--project', 'P']);
    expect(h.launches()[0]!.body).not.toHaveProperty('tunnelClientId');
    expect(h.stops()).toBe(0);
  });
  it.each([{ args: ['test-0'] }, { args: ['--project', 'P'] }])(
    'explicit --no-wait leaves %j on the ordinary path',
    async ({ args }) => {
      const h = fixture(cases(1));
      await h.run([...args, '--no-wait']);
      expect(h.launches()).toHaveLength(1);
      expect(h.launches()[0]!.body).not.toHaveProperty('tunnelClientId');
      expect(h.stops()).toBe(0);
      expect(h.stderr.join('\n')).toContain('no-wait');
    },
  );
  it('public project selection has no test enumeration and no tunnel', async () => {
    const h = fixture(cases(1), { environmentUrl: () => 'https://public.example' });
    await h.run(['--project', 'P', '--wait']);
    expect(h.launches()[0]!.body).not.toHaveProperty('testIds');
    expect(h.calls.some(c => c.url.pathname.endsWith('/tests'))).toBe(false);
    expect(h.stops()).toBe(0);
  });
  it('sends the exact saved loopback origin including its slash', async () => {
    const h = fixture(cases(1), { environmentUrl: () => 'http://localhost:5173/' });
    await h.run(['test-0']);
    expect(h.launches()[0]!.body?.targetUrl).toBe('http://localhost:5173/');
  });
  it('preserves raw tunnel scope refusal without launching tests', async () => {
    const raw = {
      code: 'AUTH_FORBIDDEN',
      message: 'original run:tunnel message',
      nextAction: 'original action',
      requestId: 'scope',
      details: { scope: 'run:tunnel' },
    };
    const h = fixture(cases(1), {
      answer: call => (call.url.pathname.endsWith('/tunnel') ? json(raw, 403) : undefined),
    });
    await expect(h.run(['test-0'])).rejects.toMatchObject(raw);
    expect(h.launches()).toEqual([]);
  });
  it('automatic project selection cancellation opt-out closes the tunnel without cancelling the run', async () => {
    const shutdown = new ShutdownController();
    const h = fixture(cases(1), {
      shutdown,
      answer: call => {
        if (call.url.pathname.endsWith('/results')) {
          shutdown.interrupt('SIGINT');
          throw shutdown.signal.reason;
        }
      },
    });
    await expect(h.run(['--project', 'P', '--no-cancel-on-interrupt'])).rejects.toMatchObject({
      exitCode: 130,
    });
    expect(h.calls.some(c => c.url.pathname.endsWith('/cancel'))).toBe(false);
    expect(h.stops()).toBe(1);
  });
  it('configured automatic dry-run describes targets without writes', async () => {
    const h = fixture(cases(1));
    await h.run(['--project', 'P', '--dry-run']);
    expect(h.calls.every(c => c.method === 'GET')).toBe(true);
    expect(h.output()).toMatchObject({
      requests: [
        expect.objectContaining({
          path: '/api/cli/v1/projects/P/runs',
          body: expect.objectContaining({ maxConcurrency: 5 }),
        }),
      ],
    });
    expect(JSON.stringify(h.output())).toContain('127.0.0.1:5173');
  });
});

const listOpts = {
  profile: 'default',
  output: 'json' as const,
  debug: false,
  listId: 'L',
  wait: false,
  timeoutSeconds: 60,
  maxConcurrency: 5,
  skipPreflight: true,
};
function listFixture(
  config: {
    count?: number;
    split?: boolean;
    missingEcho?: boolean;
    missingCap?: boolean;
    effectiveCap?: number;
    interrupt?: boolean;
    secondFailure?: boolean;
  } = {},
) {
  const tests = cases(config.count ?? 2);
  const shutdown = new ShutdownController();
  let launches = 0;
  const h = fixture(tests, {
    shutdown,
    answer: call => {
      const path = call.url.pathname;
      if (path.endsWith('/testlist/L'))
        return json({
          id: 'L',
          cases: tests.map((t, i) => ({
            testId: t.id,
            type: t.type,
            projectId: config.split && i % 2 ? 'Q' : 'P',
          })),
          projectEnvironments: [],
        });
      if (path.endsWith('/projects/Q/env'))
        return json({
          environments: [
            { id: 'env-Q', name: 'default', url: 'http://localhost:5174/', isDefault: true },
          ],
        });
      if (path.endsWith('/testlist/L/run')) {
        launches++;
        if (config.secondFailure && launches === 2)
          return json(
            {
              code: 'AUTH_FORBIDDEN',
              message: 'raw later refusal',
              requestId: 'later',
              nextAction: 'raw action',
              details: {},
            },
            403,
          );
        return json({
          ...(config.missingEcho ? {} : { tunnelClientId: 'client-local' }),
          ...(config.missingCap
            ? {}
            : { maxConcurrency: config.effectiveCap ?? call.body?.maxConcurrency }),
          accepted: (call.body!.testIds as string[]).map(testId => ({
            testId,
            resultId: `result-${testId}`,
            runId: `list-exec-${launches}`,
            enqueuedAt: '2026-11-15T00:00:00Z',
          })),
          conflicts: [],
          deferred: [],
        });
      }
      if (path.endsWith('/results')) {
        if (config.interrupt) {
          shutdown.interrupt('SIGTERM');
          throw shutdown.signal.reason;
        }
        const runId = call.url.searchParams.get('run')!;
        const post = h.calls.filter(c => c.url.pathname.endsWith('/testlist/L/run'))[
          Number(runId.split('-').at(-1)) - 1
        ]!;
        return json(
          runListing(
            { runId, status: 'finished', cancelled: false },
            (post.body!.testIds as string[]).map(testId =>
              resultLine({
                resultId: `result-${testId}`,
                runId,
                caseKey: testId,
                testStatus: 'PASSED',
              }),
            ),
          ),
        );
      }
    },
  });
  return h;
}
describe('native automatic test-list tunnel launches', () => {
  it('passes the requested cap unchanged to every distinct target execution and accepts a lower effective cap', async () => {
    const h = listFixture({ count: 4, split: true, effectiveCap: 2 });
    await runTestlistRun({ ...listOpts, maxConcurrency: 3 }, h.deps);
    expect(
      h.calls
        .filter(c => c.url.pathname.endsWith('/testlist/L/run'))
        .map(c => c.body?.maxConcurrency),
    ).toEqual([3, 3]);
  });
  it.each([{ missingCap: true }, { effectiveCap: 6 }, { effectiveCap: 0 }])(
    'refuses an unconfirmed tunnel dispatch cap %j and cancels its owned execution once',
    async config => {
      const h = listFixture(config);
      await expect(runTestlistRun(listOpts, h.deps)).rejects.toMatchObject({
        code: 'UNSUPPORTED',
        exitCode: 7,
        details: { field: 'maxConcurrency' },
      });
      expect(h.calls.filter(c => c.url.pathname.endsWith('/cancel'))).toHaveLength(1);
      expect(h.output().results[0]).toMatchObject({
        runId: 'list-exec-1',
        resultId: 'result-test-0',
      });
      expect(h.stops()).toBe(1);
    },
  );
  it('sends 60 same-origin members in one request without a hidden chunker', async () => {
    const h = listFixture({ count: 60 });
    await runTestlistRun(listOpts, h.deps);
    const posts = h.calls.filter(c => c.url.pathname.endsWith('/testlist/L/run'));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body?.testIds).toHaveLength(60);
    expect(h.output().summary.passed).toBe(60);
    expect(h.stops()).toBe(1);
  });
  it('groups only distinct saved target URLs with stable bounded distinct idempotency keys', async () => {
    const h = listFixture({ count: 4, split: true });
    await runTestlistRun({ ...listOpts, idempotencyKey: 'k'.repeat(256) }, h.deps);
    const posts = h.calls.filter(c => c.url.pathname.endsWith('/testlist/L/run'));
    expect(posts).toHaveLength(2);
    expect(posts.map(c => c.body?.targetUrl)).toEqual([
      'http://127.0.0.1:5173',
      'http://localhost:5174/',
    ]);
    expect(new Set(posts.map(c => c.key)).size).toBe(2);
    expect(posts.every(c => c.key!.length <= 256)).toBe(true);
  });
  it('missing tunnel echo cancels the known execution once and retains receipt', async () => {
    const h = listFixture({ missingEcho: true });
    await expect(runTestlistRun(listOpts, h.deps)).rejects.toMatchObject({ exitCode: 7 });
    expect(
      h.calls.filter(c => c.url.pathname.endsWith('/cancel')).map(c => c.url.pathname),
    ).toEqual(['/api/cli/v1/runs/list-exec-1/cancel']);
    expect(h.output().results[0]).toMatchObject({
      runId: 'list-exec-1',
      resultId: 'result-test-0',
    });
  });
  it('interruption retains receipts and cancels each owned execution once', async () => {
    const h = listFixture({ split: true, interrupt: true });
    await expect(runTestlistRun(listOpts, h.deps)).rejects.toMatchObject({ exitCode: 143 });
    expect(h.output()).toMatchObject({ partial: true });
    expect(h.calls.filter(c => c.url.pathname.endsWith('/cancel'))).toHaveLength(2);
    expect(h.stops()).toBe(1);
  });
  it('a later group refusal preserves first receipts and cleans up only acknowledged owned runs', async () => {
    const h = listFixture({ split: true, secondFailure: true });
    await expect(runTestlistRun(listOpts, h.deps)).rejects.toMatchObject({
      message: 'raw later refusal',
      nextAction: 'raw action',
      exitCode: 3,
    });
    expect(h.output().results[0]).toMatchObject({ runId: 'list-exec-1' });
    expect(h.calls.filter(c => c.url.pathname.endsWith('/cancel'))).toHaveLength(1);
  });
  it('explicit no-wait avoids automatic tunnels', async () => {
    const h = listFixture();
    await runTestlistRun({ ...listOpts, noWait: true, cases: ['test-0'] }, h.deps);
    expect(h.stops()).toBe(0);
    expect(h.calls.some(c => c.url.pathname.endsWith('/results'))).toBe(false);
  });
});
