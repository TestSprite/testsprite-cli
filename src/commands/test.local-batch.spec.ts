import { afterEach, describe, expect, it, vi } from 'vitest';
import { runListing } from '../../test/helpers/project-run.js';
import { resultLine } from '../../test/helpers/result-list.js';
import { ShutdownController } from '../lib/interrupt.js';
import { InterruptError } from '../lib/errors.js';
import { takeTelemetryExtras } from '../lib/telemetry.js';

import { fixture, cases, json } from '../../test/helpers/local-project.js';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('native local project launches', () => {
  it('sends 60 named tests in one project request, owns one run, and closes one tunnel', async () => {
    const tests = cases(60);
    const h = fixture(tests);
    await h.run([...tests.map(test => test.id), '--local', '5173']);
    expect(h.launches()).toHaveLength(1);
    expect(h.launches()[0]!.body).toMatchObject({
      testIds: tests.map(test => test.id),
      maxConcurrency: 5,
      tunnelClientId: 'client-local',
    });
    expect(h.output()).toMatchObject({
      runs: [{ runId: 'exec-P' }],
      summary: { total: 60, passed: 60 },
    });
    expect(h.stops()).toBe(1);
    expect(h.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  });
  it('sends one stable independently keyed request per project without dividing the server cap', async () => {
    const h = fixture([
      { id: 'a', projectId: 'P', type: 'frontend' },
      { id: 'b', projectId: 'Q', type: 'frontend' },
    ]);
    await h.run([
      'a',
      'b',
      '--local',
      '5173',
      '--max-concurrency',
      '7',
      '--idempotency-key',
      'same-key',
    ]);
    const first = h.launches().map(call => ({ key: call.key, body: call.body }));
    await h.run([
      'a',
      'b',
      '--local',
      '5173',
      '--max-concurrency',
      '7',
      '--idempotency-key',
      'same-key',
    ]);
    expect(
      h
        .launches()
        .slice(2)
        .map(call => ({ key: call.key, body: call.body })),
    ).toEqual(first);
    expect(new Set(first.map(call => call.key)).size).toBe(2);
    expect(first.every(call => call.body?.maxConcurrency === 7)).toBe(true);
  });
  it('distinguishes an unconfirmed launch from projects never attempted after a transport outage', async () => {
    const raw = {
      code: 'UNAVAILABLE',
      message: 'original dispatch outage',
      nextAction: 'original server action',
      requestId: 'dispatch-outage',
      details: { marker: 'preserved' },
    };
    const h = fixture(
      [
        { id: 'a', projectId: 'P', type: 'frontend' },
        { id: 'b', projectId: 'Q', type: 'frontend' },
        { id: 'c', projectId: 'R', type: 'frontend' },
      ],
      {
        environmentUrl: () => 'https://public.example',
        answer: call =>
          call.url.pathname.endsWith('/projects/Q/runs') ? json(raw, 503) : undefined,
      },
    );
    await expect(
      h.run(['a', 'b', 'c', '--no-wait', '--idempotency-key', 'recover-key']),
    ).rejects.toMatchObject(raw);
    expect(h.output()).toMatchObject({
      runs: [{ runId: 'exec-P' }],
      notRunProjects: ['R'],
      unconfirmedProjects: [{ projectId: 'Q', idempotencyKey: 'recover-keyQ' }],
      retryIdempotencyKey: 'recover-key',
    });
    expect(h.stderr.join('\n')).toContain('reuse this --idempotency-key value: recover-key');
  });
  it.each([undefined, 'k'.repeat(256)])(
    'replays both project requests with the command key printed to stderr (supplied key: %s)',
    async suppliedKey => {
      const h = fixture(
        [
          { id: 'a', projectId: 'P', type: 'backend' },
          { id: 'b', projectId: 'Q', type: 'backend' },
        ],
        { environmentUrl: () => 'https://example.com' },
      );
      const args = ['a', 'b', '--no-wait'];
      await h.run([...args, ...(suppliedKey ? ['--idempotency-key', suppliedKey] : [])]);
      const prefix = 'idempotency-key: ';
      const printed = h.stderr
        .filter(line => line.startsWith(prefix))
        .map(line => line.slice(prefix.length));
      expect(printed).toHaveLength(1);
      const key = printed[0]!;
      expect(key).toEqual(suppliedKey ?? expect.stringMatching(/^[0-9a-f-]{36}$/));

      await h.run([...args, '--idempotency-key', key]);
      const requests = h.launches().map(call => [call.url.pathname, call.body, call.key]);
      expect(requests).toHaveLength(4);
      expect(requests.slice(2)).toEqual(requests.slice(0, 2));
      expect(h.launches()[0]!.key).not.toBe(h.launches()[1]!.key);
    },
  );
  it('deduplicates named IDs in first occurrence order', async () => {
    const h = fixture(cases(2));
    await h.run(['test-1', 'test-0', 'test-1', '--local', '5173']);
    expect(h.launches()[0]!.body?.testIds).toEqual(['test-1', 'test-0']);
  });
  it('opens one automatic tunnel for a saved loopback environment', async () => {
    const h = fixture(cases(2));
    await h.run(['test-0', 'test-1']);
    expect(h.launches()).toHaveLength(1);
    expect(h.output().summary.passed).toBe(2);
    expect(h.stops()).toBe(1);
  });
  it('keeps public project ownership outside the shared tunnel cleanup', async () => {
    const shutdown = new ShutdownController();
    const h = fixture(
      [
        { id: 'a', projectId: 'P', type: 'frontend' },
        { id: 'b', projectId: 'Q', type: 'frontend' },
      ],
      {
        shutdown,
        environmentUrl: p => (p === 'P' ? 'http://127.0.0.1:5173' : 'https://example.com'),
        answer: call => {
          if (call.url.pathname.endsWith('/results')) {
            shutdown.interrupt('SIGINT');
            throw shutdown.signal.reason;
          }
        },
      },
    );
    await expect(h.run(['a', 'b', '--wait'])).rejects.toBeInstanceOf(InterruptError);
    expect(
      h.calls.filter(call => call.url.pathname.endsWith('/cancel')).map(call => call.url.pathname),
    ).toEqual(['/api/cli/v1/runs/exec-P/cancel']);
    expect(h.output()).toMatchObject({
      partial: true,
      runs: [{ runId: 'exec-P' }, { runId: 'exec-Q' }],
    });
  });
  it('retains confirmed earlier receipts when a later project request is refused', async () => {
    const h = fixture(
      [
        { id: 'a', projectId: 'P', type: 'frontend' },
        { id: 'b', projectId: 'Q', type: 'frontend' },
      ],
      {
        answer: call =>
          call.method === 'POST' && call.url.pathname.endsWith('/projects/Q/runs')
            ? json(
                {
                  code: 'AUTH_FORBIDDEN',
                  message: 'No project Q',
                  nextAction: 'Use permitted project',
                  requestId: 'q-refused',
                  details: { projectId: 'Q' },
                },
                403,
              )
            : undefined,
      },
    );
    await expect(h.run(['a', 'b', '--local', '5173'])).rejects.toMatchObject({
      code: 'AUTH_FORBIDDEN',
      message: 'No project Q',
      nextAction: 'Use permitted project',
    });
    expect(h.output()).toMatchObject({
      runs: [{ runId: 'exec-P' }],
      notRunProjects: ['Q'],
    });
    expect(h.calls.filter(call => call.url.pathname.endsWith('/cancel'))).toHaveLength(1);
  });
  it('rejects explicitly named backend cases before opening a local tunnel', async () => {
    const h = fixture([
      { id: 'a', projectId: 'P', type: 'frontend' },
      { id: 'b', projectId: 'P', type: 'backend' },
    ]);
    await expect(h.run(['a', 'b', '--local', '5173'])).rejects.toMatchObject({ exitCode: 5 });
    expect(h.calls.some(call => call.method === 'POST')).toBe(false);
  });
  it('all-local filters frontend cases and retains backend skip diagnostics', async () => {
    const h = fixture([
      { id: 'a', projectId: 'P', type: 'frontend' },
      { id: 'b', projectId: 'P', type: 'backend' },
    ]);
    await h.run(['--project', 'P', '--local', '5173']);
    expect(h.launches()[0]!.body?.testIds).toEqual(['a']);
    expect(h.output()).toMatchObject({
      skipped: [{ testId: 'b', reason: 'backend-test' }],
      summary: { passed: 1, skipped: 1 },
    });
  });
  it.each([false, true])(
    'all-backend local selection dispatches nothing, allow-empty=%s',
    async allowEmpty => {
      const h = fixture([{ id: 'b', projectId: 'P', type: 'backend' }]);
      const pending = h.run([
        '--project',
        'P',
        '--local',
        '5173',
        ...(allowEmpty ? ['--allow-empty'] : []),
      ]);
      if (allowEmpty) await pending;
      else await expect(pending).rejects.toMatchObject({ exitCode: 5 });
      expect(h.calls.some(call => call.method === 'POST')).toBe(false);
    },
  );
  it('records the server limit without inventing the deleted dispatcher peak', async () => {
    takeTelemetryExtras();
    const h = fixture(cases(2));
    await h.run(['test-0', 'test-1', '--local', '5173']);
    const extras = takeTelemetryExtras();
    expect(extras).toMatchObject({ local: true, localConcurrencyLimit: 5 });
    expect(extras).not.toHaveProperty('localPeakInFlight');
  });
});

describe('automatic local selection', () => {
  it('skips backend cases in an automatic mixed selection and retains frontend work', async () => {
    const h = fixture([
      { id: 'a', projectId: 'P', type: 'frontend' },
      { id: 'b', projectId: 'P', type: 'backend' },
    ]);
    await h.run(['a', 'b']);
    expect(h.launches()[0]!.body?.testIds).toEqual(['a']);
    expect(h.output()).toMatchObject({
      skipped: [{ testId: 'b', reason: 'backend-test' }],
      summary: { passed: 1, skipped: 1 },
    });
  });
  it('does not tunnel a backend-only selection even when its environment is loopback', async () => {
    const h = fixture([{ id: 'b', projectId: 'P', type: 'backend' }]);
    await h.run(['b', '--wait']);
    expect(h.launches()[0]!.body).not.toHaveProperty('tunnelClientId');
    expect(h.calls.some(call => call.url.pathname.endsWith('/tunnel'))).toBe(false);
  });
  it('uses the 1200-second default for automatic project tunnels', async () => {
    vi.useFakeTimers();
    const h = fixture(cases(1), {
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      answer: call =>
        call.url.pathname.endsWith('/results')
          ? json(
              runListing({ runId: 'exec-P', projectId: 'P', status: 'running', cancelled: false }, [
                resultLine({
                  resultId: 'result-test-0',
                  runId: 'exec-P',
                  caseKey: 'test-0',
                  testStatus: 'RUNNING',
                }),
              ]),
            )
          : undefined,
    });
    let ended = false;
    const pending = h
      .run(['test-0'])
      .catch(error => error)
      .then(result => {
        ended = true;
        return result;
      });
    await vi.advanceTimersByTimeAsync(600_001);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(599_999);
    expect((await pending).exitCode).toBe(7);
  });
});

describe('Commander public multi-ID timeout defaults', () => {
  it.each([undefined, '12'])(
    'uses the public 600-second default or explicit %s timeout',
    async explicit => {
      vi.useFakeTimers();
      const h = fixture(cases(2), {
        environmentUrl: () => 'https://public.example',
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        answer: call =>
          call.url.pathname.endsWith('/results')
            ? json(
                runListing(
                  { runId: 'exec-P', projectId: 'P', status: 'running', cancelled: false },
                  [],
                ),
              )
            : undefined,
      });
      let ended = false;
      const pending = h
        .run(['test-0', 'test-1', '--wait', ...(explicit ? ['--timeout', explicit] : [])])
        .catch(e => e)
        .then(e => {
          ended = true;
          return e;
        });
      await vi.advanceTimersByTimeAsync((explicit ? 12 : 600) * 1000 + 2001);
      expect(ended).toBe(true);
      expect((await pending).exitCode).toBe(7);
    },
  );
});
