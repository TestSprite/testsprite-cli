import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as InterruptModule from './lib/interrupt.js';

// Keep the real parser, command, HTTP client, error renderer, and telemetry.
// Process-wide handlers are outside these in-process invocation tests.
vi.mock('./lib/interrupt.js', async importOriginal => ({
  ...(await importOriginal<typeof InterruptModule>()),
  installSignalHandlers: vi.fn(),
  installBrokenPipeGuard: vi.fn(),
}));
vi.mock('./lib/proxy.js', () => ({
  maybeInstallProxyAgent: vi.fn(),
  isProxyAgentActive: () => false,
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let stderr = '';
let stdout = '';

beforeEach(() => {
  vi.resetModules();
  stderr = '';
  stdout = '';
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(line => {
    stdout += `${String(line)}\n`;
  });
  vi.spyOn(console, 'error').mockImplementation(line => {
    stderr += `${String(line)}\n`;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    stdout += String(chunk);
    return true;
  });
  vi.stubEnv('TESTSPRITE_API_KEY', 'sk-user-unit-test');
  vi.stubEnv('TESTSPRITE_API_URL', 'https://api.example.com');
  vi.stubEnv('TESTSPRITE_NO_SKILL_WARNING', '1');
  vi.stubEnv('TESTSPRITE_NO_UPDATE_CHECK', '1');
  vi.stubEnv('TESTSPRITE_NO_TELEMETRY', '1');
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const LOCAL_UNSUPPORTED_MESSAGE =
  '--local only supports frontend tests today. Re-run without --local, or point the test at a reachable base URL.';

describe('backend local unsupported rendering', () => {
  it.each([
    {
      output: 'text',
      reason: 'tunnel-unsupported-for-backend-test',
      message: LOCAL_UNSUPPORTED_MESSAGE,
    },
    {
      output: 'json',
      reason: 'tunnel-unsupported-for-backend-test',
      message: LOCAL_UNSUPPORTED_MESSAGE,
    },
    { output: 'text', reason: 'another-unsupported-feature', message: 'Original backend message' },
    { output: 'json', reason: 'another-unsupported-feature', message: 'Original backend message' },
  ])(
    'renders $reason in $output mode without changing the error contract',
    async ({ output, reason, message }) => {
      const details = { reason, testId: 'test_backend', extra: 'preserved' };
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                error: {
                  code: 'UNSUPPORTED',
                  message: 'Original backend message',
                  nextAction: 'Original next action',
                  requestId: 'request-backend-501',
                  details,
                },
              }),
              { status: 501 },
            ),
        ),
      );
      process.argv = [
        'node',
        'testsprite',
        'test',
        'run',
        'test_backend',
        '--local',
        '5173',
        '--tunnel-client',
        'borrowed-client',
        '--skip-preflight',
        '--output',
        output,
      ];
      await import('./index.js');
      expect(process.exitCode).toBe(7);
      expect(stdout).toBe('');
      if (output === 'json') {
        // Prior diagnostic lines are on stderr too; the final object is the error envelope.
        const envelope = JSON.parse(stderr.slice(stderr.indexOf('{')));
        expect(envelope).toEqual({
          error: {
            code: 'UNSUPPORTED',
            message,
            nextAction: 'Original next action',
            requestId: 'request-backend-501',
            details,
          },
        });
      } else {
        expect(stderr).toContain(`Error: ${message}\n`);
        expect(stderr).toContain('requestId: request-backend-501');
      }
    },
  );
});

describe('wait timeout telemetry through the entry point', () => {
  it.each([
    { args: ['run', 'test_abc', '--wait'], local: false, timeout: true },
    {
      args: [
        'run',
        'test_abc',
        '--local',
        '5173',
        '--tunnel-client',
        'borrowed-client',
        '--skip-preflight',
      ],
      local: true,
      timeout: true,
    },
    { args: ['wait', 'run_abc'], local: false, timeout: true },
    // Multi-run `test wait <a> <b>` aggregates each member's own poll outcome
    // and, when one or more members time out, throws a plain summary
    // `CLIError` (see runMultiWait in commands/test.ts) — NOT the
    // ApiError/UNSUPPORTED conversion the single-run/rerun/batch paths use.
    // That's pre-existing, unrelated-to-this-patch behavior; the correct
    // classification for it is `errorCode: 'CLI_ERROR'` (the CLIError base
    // default) with no `timeoutSeconds` (a plain CLIError carries no details).
    {
      args: ['wait', 'run_abc', 'run_other'],
      local: false,
      timeout: true,
      errorCode: 'CLI_ERROR',
      expectTimeoutSeconds: false,
    },
    { args: ['rerun', 'test_abc', '--wait'], local: false, timeout: true },
    { args: ['run', '--all', '--project', 'project_abc', '--wait'], local: false, timeout: true },
    // The batch-rerun "deferred/timed-out" summary throw (commands/test.ts,
    // the combined `deferred.length > 0 || timedOut > 0` gate) builds its
    // `details` from `deferredTestIds`/`timedOutRunIds` only — it does not
    // (today) also echo `opts.timeoutSeconds`. Still a client-fabricated
    // UNSUPPORTED (requestId: 'local', no httpStatus), just without that one
    // optional detail.
    {
      args: ['rerun', '--all', '--project', 'project_abc', '--wait'],
      local: false,
      timeout: true,
      expectTimeoutSeconds: false,
    },
    {
      args: ['run', '--all', '--project', 'project_abc', '--wait'],
      local: false,
      timeout: true,
      lateConflict: true,
    },
    {
      args: ['wait', 'run_abc', 'run_other'],
      local: false,
      timeout: true,
      rateDeadline: true,
      errorCode: 'CLI_ERROR',
      expectTimeoutSeconds: false,
    },
    { args: ['run', 'test_abc', '--wait'], local: false, timeout: false },
  ])('reports a poll deadline for $args (timeout=$timeout)', async scenario => {
    const { args, local, timeout } = scenario;
    const errorCode = 'errorCode' in scenario ? scenario.errorCode : 'UNSUPPORTED';
    const expectTimeoutSeconds =
      'expectTimeoutSeconds' in scenario ? scenario.expectTimeoutSeconds : true;
    const lateConflict = 'lateConflict' in scenario;
    const rateDeadline = 'rateDeadline' in scenario;
    vi.useFakeTimers();
    vi.stubEnv('TESTSPRITE_NO_TELEMETRY', '0');
    vi.stubEnv('DO_NOT_TRACK', '0');
    const events: unknown[] = [];
    let pollEntered = () => {};
    const polling = new Promise<void>(resolve => {
      pollEntered = resolve;
    });
    const run = {
      runId: 'run_abc',
      testId: 'test_abc',
      projectId: 'project_abc',
      userId: 'user_abc',
      status: timeout ? 'running' : 'passed',
      source: 'cli',
      createdAt: '2026-09-09T00:00:00.000Z',
      startedAt: null,
      finishedAt: null,
      codeVersion: 'v1',
      targetUrl: 'https://example.com',
      createdFrom: null,
      failedStepIndex: null,
      failureKind: null,
      error: null,
      videoUrl: null,
      stepSummary: { total: 0, completed: 0, passedCount: 0, failedCount: 0 },
      retryAfterSeconds: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/telemetry')) {
          events.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 204 });
        }
        if (url.includes('/batch/'))
          return new Response(
            JSON.stringify({
              accepted: lateConflict
                ? []
                : [{ testId: 'test_abc', runId: 'run_abc', enqueuedAt: run.createdAt }],
              conflicts: lateConflict ? [{ testId: 'test_abc', currentRunId: 'run_abc' }] : [],
              deferred: [],
              skippedFrontend: [],
              skippedIntegration: [],
              closure: { byProject: [] },
            }),
          );
        if (init?.method === 'POST')
          return new Response(
            JSON.stringify({
              runId: 'run_abc',
              status: 'queued',
              enqueuedAt: run.createdAt,
              codeVersion: 'v1',
              targetUrl: 'https://example.com',
              autoHeal: true,
            }),
          );
        if (url.includes('/runs/')) {
          if (lateConflict && !new URL(url).searchParams.has('waitSeconds'))
            vi.setSystemTime(Date.now() + 2000);
          pollEntered();
          if (rateDeadline)
            return new Response(
              JSON.stringify({
                error: {
                  code: 'RATE_LIMITED',
                  message: 'per-minute limit exceeded',
                  details: { retryAfterSeconds: 1 },
                },
              }),
              { status: 429, headers: { 'retry-after': '1' } },
            );
          return new Response(JSON.stringify(run));
        }
        if (url.includes('/tunnel/')) return new Response(JSON.stringify({ status: 'online' }));
        if (new URL(url).pathname.endsWith('/tests'))
          return new Response(
            JSON.stringify({
              items: [{ testId: 'test_abc', type: 'frontend', name: 'Example' }],
              nextToken: null,
            }),
          );
        return new Response(JSON.stringify({ type: 'frontend' }));
      }),
    );
    process.argv = ['node', 'testsprite', 'test', ...args, '--timeout', '1', '--output', 'json'];
    const pending = import('./index.js');
    await Promise.race([
      polling,
      pending.then(() => {
        throw new Error(`Command ended before polling: ${stderr}`);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(rateDeadline ? 3000 : 1000);
    await pending;
    expect(events).toHaveLength(1);
    if (timeout) {
      expect(events[0]).toMatchObject({
        outcome: 'error',
        exitCode: 7,
        reason: 'wait_timeout',
        // This is the headline proof for the UNSUPPORTED client/server fix
        // — every one of these scenarios is a CLI-side --wait deadline
        // (never a genuine backend 501), so errorOrigin must ALWAYS read
        // 'client' regardless of which throw site produced the error
        // (UNSUPPORTED for the single-run/rerun/batch paths, or a plain
        // CLIError for multi-run `test wait`) — that's exactly the signal
        // that resolves the client/server over-count in prod telemetry.
        errorCode,
        errorOrigin: 'client',
        ...(expectTimeoutSeconds ? { timeoutSeconds: 1 } : {}),
        ...(local ? { local: true, cancelOutcome: 'skipped' } : {}),
      });
      if (!expectTimeoutSeconds) expect(events[0]).not.toHaveProperty('timeoutSeconds');
      if (!local) expect(events[0]).not.toHaveProperty('cancelOutcome');
      expect(process.exitCode).toBe(7);
    } else {
      expect(events[0]).toMatchObject({ outcome: 'success', exitCode: 0 });
      expect(events[0]).not.toHaveProperty('reason');
      expect(events[0]).not.toHaveProperty('cancelOutcome');
    }
    expect(JSON.parse(stdout)).toBeTruthy();
  });
});

// End-to-end proof that the plain-CLIError catch branch in
// index.ts now emits the same structured {error:{code,message,...}} envelope
// as the ApiError/InterruptError/RequestTimeoutError branches, instead of the
// bare `{"error":"<message>"}` string `output.error()` used to produce.
describe('CLIError branch renders a structured --output json envelope', () => {
  it('`test wait` resolving to a failed run exits 1 with a full 5-key error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('/runs/')) {
          return new Response(
            JSON.stringify({
              runId: 'run_abc',
              testId: 'test_abc',
              projectId: 'project_abc',
              userId: 'user_abc',
              status: 'failed',
              source: 'cli',
              createdAt: '2026-09-09T00:00:00.000Z',
              startedAt: '2026-09-09T00:00:01.000Z',
              finishedAt: '2026-09-09T00:00:02.000Z',
              codeVersion: 'v1',
              targetUrl: 'https://example.com',
              createdFrom: null,
              failedStepIndex: null,
              failureKind: null,
              error: null,
              videoUrl: null,
              stepSummary: { total: 1, completed: 0, passedCount: 0, failedCount: 1 },
            }),
          );
        }
        return new Response(JSON.stringify({ type: 'frontend' }));
      }),
    );
    process.argv = ['node', 'testsprite', 'test', 'wait', 'run_abc', '--output', 'json'];
    await import('./index.js');
    expect(process.exitCode).toBe(1);
    const envelope = JSON.parse(stderr.slice(stderr.indexOf('{')));
    expect(envelope).toEqual({
      error: {
        code: 'CLI_ERROR',
        message: 'Run run_abc finished with status: failed',
        nextAction: '',
        requestId: 'local',
        details: {},
      },
    });
  });
});

// Proves the discriminator's OTHER half — a genuine backend 501
// UNSUPPORTED response (real HTTP round trip, httpStatus set) must report
// errorOrigin: 'server', so it stays distinguishable from the client-side
// --wait-timeout→UNSUPPORTED conversions covered above.
describe('errorOrigin telemetry — server counterpart', () => {
  it('a real backend 501 UNSUPPORTED response reports errorOrigin: server', async () => {
    vi.stubEnv('TESTSPRITE_NO_TELEMETRY', '0');
    vi.stubEnv('DO_NOT_TRACK', '0');
    const events: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/telemetry')) {
          events.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 204 });
        }
        return new Response(
          JSON.stringify({
            error: {
              code: 'UNSUPPORTED',
              message: 'Original backend message',
              nextAction: 'Original next action',
              requestId: 'request-backend-501',
              details: { reason: 'another-unsupported-feature' },
            },
          }),
          { status: 501 },
        );
      }),
    );
    process.argv = [
      'node',
      'testsprite',
      'test',
      'run',
      'test_backend',
      '--local',
      '5173',
      '--tunnel-client',
      'borrowed-client',
      '--skip-preflight',
      '--output',
      'json',
    ];
    await import('./index.js');
    expect(process.exitCode).toBe(7);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ errorCode: 'UNSUPPORTED', errorOrigin: 'server' });
  });
});
