import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as InterruptModule from './lib/interrupt.js';
import type * as TunnelClientModule from './vendor/tunnel-client/index.js';

// Keep the real parser, command, HTTP client, error renderer, and telemetry.
// Process-wide handlers are outside these in-process invocation tests.
vi.mock('./lib/interrupt.js', async importOriginal => ({
  ...(await importOriginal<typeof InterruptModule>()),
  installSignalHandlers: vi.fn(),
  installBrokenPipeGuard: vi.fn(),
  // The real backstop arms a process-wide exit timer that would fire into
  // later tests on a slow runner; the test that covers it opts back in.
  armInterruptExitBackstop: vi.fn(),
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

afterEach(async () => {
  // The backstop is normally a mock in this in-process CLI suite. Reset the
  // one test's real implementation before another invocation can arm it.
  const { armInterruptExitBackstop } = await import('./lib/interrupt.js');
  vi.mocked(armInterruptExitBackstop).mockReset();
  vi.clearAllTimers();
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('gives disarmed requests generic recovery guidance', async () => {
  const { globalShutdown } = await import('./lib/interrupt.js');
  const { InterruptError } = await import('./lib/errors.js');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      expect(globalShutdown.isArmed).toBe(false);
      throw new InterruptError('SIGINT');
    }),
  );
  process.argv = ['node', 'testsprite', 'auth', 'whoami', '--output', 'json'];
  await import('./index.js');
  expect(process.exitCode).toBe(130);
  const error = (
    JSON.parse(stderr.slice(stderr.indexOf('{'))) as {
      error: { code: string; nextAction: string; details: Record<string, unknown> };
    }
  ).error;
  expect(error.code).toBe('INTERRUPTED');
  expect(error.nextAction).toBe(
    'The request was interrupted. Check the current state before retrying; ' +
      'a multi-item command may have processed some items.',
  );
  expect(stdout).toBe('');
});

it('bounds a stranded interrupt after rendering its error', async () => {
  vi.useFakeTimers();
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const actual = await vi.importActual<typeof InterruptModule>('./lib/interrupt.js');
  const { armInterruptExitBackstop } = await import('./lib/interrupt.js');
  vi.mocked(armInterruptExitBackstop).mockImplementation(actual.armInterruptExitBackstop);
  const { InterruptError } = await import('./lib/errors.js');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new InterruptError('SIGINT');
    }),
  );
  process.argv = ['node', 'testsprite', 'auth', 'whoami'];
  await import('./index.js');

  expect(stderr).toContain('Error: Interrupted by SIGINT.');
  expect(process.exitCode).toBe(130);
  expect(exit).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(exit).toHaveBeenCalledOnce();
  expect(exit).toHaveBeenCalledWith(130);
  expect(vi.getTimerCount()).toBe(0);
});

it('disarms a pending hard-exit timer when the test scope ends', async () => {
  vi.useFakeTimers();
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  const actual = await vi.importActual<typeof InterruptModule>('./lib/interrupt.js');
  const { armInterruptExitBackstop } = await import('./lib/interrupt.js');
  vi.mocked(armInterruptExitBackstop).mockImplementation(actual.armInterruptExitBackstop);
  const { InterruptError } = await import('./lib/errors.js');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new InterruptError('SIGINT');
    }),
  );
  process.argv = ['node', 'testsprite', 'auth', 'whoami'];
  await import('./index.js');

  expect(process.exitCode).toBe(130);
  expect(vi.getTimerCount()).toBe(1);
  vi.clearAllTimers();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(exit).not.toHaveBeenCalled();
});

it.each(['create-batch', 'rerun'] as const)(
  'renders run recovery guidance for an interrupted %s fan-out',
  async command => {
    const { InterruptError } = await import('./lib/errors.js');
    const interruption = new InterruptError('SIGINT');
    const plansFile = join(mkdtempSync(join(tmpdir(), 'cli-index-interrupt-')), 'plans.jsonl');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture path built from this test's own mkdtempSync() dir, never user input
    writeFileSync(
      plansFile,
      JSON.stringify({
        projectId: 'project_alice',
        type: 'frontend',
        name: 'spec-one',
        planSteps: [{ type: 'action', description: 'navigate to home' }],
      }) + '\n',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Parameters<typeof fetch>[0]) => {
        const url = String(input);
        if (url.endsWith('/tests/batch/rerun')) {
          return new Response(
            JSON.stringify({
              accepted: [
                { testId: 'test_1', runId: 'run_b1', enqueuedAt: '2026-06-03T10:00:00.000Z' },
                { testId: 'test_2', runId: 'run_b2', enqueuedAt: '2026-06-03T10:00:00.000Z' },
              ],
              deferred: [],
              conflicts: [],
              closure: { byProject: [] },
            }),
            { status: 202 },
          );
        }
        if (url.endsWith('/tests/batch')) {
          return new Response(
            JSON.stringify({
              results: [{ specIndex: 0, testId: 'test_1', status: 'created' }],
              summary: { total: 1, created: 1, failed: 0 },
            }),
          );
        }
        if (url.endsWith('/tests/test_1/runs')) {
          return new Response(
            JSON.stringify({
              runId: 'run_b1',
              status: 'queued',
              enqueuedAt: '2026-06-03T10:00:00.000Z',
              codeVersion: 'v1',
              targetUrl: '',
            }),
          );
        }
        if (/\/tests\/[^/]+$/.test(url))
          return new Response(JSON.stringify({ type: 'frontend', projectId: 'project_alice' }));
        if (url.endsWith('/projects/project_alice/env'))
          return new Response(JSON.stringify({ environments: [] }));
        throw interruption;
      }),
    );
    process.argv =
      command === 'create-batch'
        ? [
            'node',
            'testsprite',
            'test',
            'create-batch',
            '--plans',
            plansFile,
            '--run',
            '--wait',
            '--output',
            'json',
          ]
        : ['node', 'testsprite', 'test', 'rerun', 'test_1', 'test_2', '--wait', '--output', 'json'];
    await import('./index.js');

    expect(process.exitCode).toBe(130);
    expect(stdout).toContain('run_b1');
    const envelope = JSON.parse(stderr.slice(stderr.lastIndexOf('{\n  "error"'))) as {
      error: { code: string; nextAction: string };
    };
    expect(envelope.error.code).toBe('INTERRUPTED');
    expect(envelope.error.nextAction).toBe(
      'The server-side run (if any) keeps executing and billing. ' +
        'Re-attach with: testsprite test wait <runId>, or stop it with: testsprite test cancel <runId> ' +
        '(runId is in the partial JSON on stdout).',
    );
  },
);

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
      // Explicit --local remains a local invocation with a borrowed tunnel.
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

describe('local telemetry through the entry point', () => {
  it.each([
    {
      args: ['test', 'run', 'test_abc', '--local', '5173', '--target-url', 'https://example.com'],
      command: 'test run',
      outcome: 'error',
      exitCode: 5,
    },
    {
      args: [
        'project',
        'create',
        '--type',
        'frontend',
        '--name',
        'local-app',
        '--local',
        '5173',
        '--skip-preflight',
      ],
      command: 'project create',
      outcome: 'success',
      exitCode: 0,
    },
  ])('records explicit --local for $command ($outcome)', async scenario => {
    vi.stubEnv('TESTSPRITE_NO_TELEMETRY', '0');
    vi.stubEnv('DO_NOT_TRACK', '0');
    const events: unknown[] = [];
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        requests.push(`${init?.method ?? 'GET'} ${path}`);
        if (path.endsWith('/telemetry')) {
          events.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 204 });
        }
        if (path.endsWith('/projects') && init?.method === 'POST')
          return new Response(
            JSON.stringify({
              projectId: 'project_local',
              type: 'frontend',
              name: 'local-app',
              targetUrl: 'http://localhost:5173',
              originMode: 'local',
              createdFrom: 'cli',
              createdAt: '2026-10-01T00:00:00Z',
              updatedAt: '2026-10-01T00:00:00Z',
            }),
            { status: 201 },
          );
        throw new Error(`Unexpected request: ${path}`);
      }),
    );
    process.argv = ['node', 'testsprite', ...scenario.args, '--output', 'json'];
    await import('./index.js');
    expect(process.exitCode ?? 0).toBe(scenario.exitCode);
    expect(events).toEqual([
      expect.objectContaining({
        command: scenario.command,
        outcome: scenario.outcome,
        exitCode: scenario.exitCode,
        local: true,
      }),
    ]);
    expect(requests).toEqual(
      scenario.exitCode === 0
        ? ['POST /api/cli/v1/projects', 'POST /api/cli/v1/telemetry']
        : ['POST /api/cli/v1/telemetry'],
    );
  });

  it('records an automatically opened saved-environment tunnel without a --local flag', async () => {
    vi.stubEnv('TESTSPRITE_NO_TELEMETRY', '0');
    vi.stubEnv('DO_NOT_TRACK', '0');
    vi.doMock('./vendor/tunnel-client/index.js', async importOriginal => ({
      ...(await importOriginal<typeof TunnelClientModule>()),
      TunnelClient: class {
        async start() {}
        async stop() {}
      },
    }));
    const events: unknown[] = [];
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? 'GET';
        requests.push(`${method} ${path}`);
        if (path.endsWith('/telemetry')) {
          events.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 204 });
        }
        if (path.endsWith('/tests/test_auto'))
          return new Response(
            JSON.stringify({
              id: 'test_auto',
              type: 'frontend',
              projectId: 'project_auto',
              name: 'auto-test',
            }),
          );
        if (path.endsWith('/projects/project_auto/env'))
          return new Response(
            JSON.stringify({
              environments: [
                {
                  id: 'env_auto',
                  name: 'local-app',
                  url: 'http://localhost:5173',
                  isDefault: true,
                },
              ],
            }),
          );
        if (method === 'POST' && path.endsWith('/tunnel'))
          return new Response(
            JSON.stringify({
              clientId: 'client_auto',
              secret: 'fixture-secret',
              controlUrl: 'ws://tunnel.example/control',
              tunnelAddr: 'tunnel.example:7400',
              expiresAt: '2026-10-02T00:00:00Z',
            }),
            { status: 201 },
          );
        if (method === 'DELETE' && path.endsWith('/tunnel/client_auto'))
          return new Response(null, { status: 204 });
        if (method === 'POST' && path.endsWith('/tests/test_auto/runs'))
          return new Response(
            JSON.stringify({
              runId: 'run_auto',
              status: 'queued',
              enqueuedAt: '2026-10-01T00:00:00Z',
              codeVersion: 'v1',
              targetUrl: 'http://localhost:5173',
              tunnelClientId: 'client_auto',
            }),
          );
        if (path.endsWith('/runs/run_auto'))
          return new Response(
            JSON.stringify({
              runId: 'run_auto',
              testId: 'test_auto',
              projectId: 'project_auto',
              userId: 'user_auto',
              status: 'passed',
              source: 'cli',
              createdAt: '2026-10-01T00:00:00Z',
              startedAt: null,
              finishedAt: '2026-10-01T00:00:01Z',
              codeVersion: 'v1',
              targetUrl: 'http://localhost:5173',
              createdFrom: 'cli',
              failedStepIndex: null,
              failureKind: null,
              error: null,
              videoUrl: null,
              stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 },
            }),
          );
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    process.argv = [
      'node',
      'testsprite',
      'test',
      'run',
      'test_auto',
      '--skip-preflight',
      '--output',
      'json',
    ];
    try {
      await import('./index.js');
      expect(process.exitCode ?? 0).toBe(0);
      expect(events).toEqual([
        expect.objectContaining({ command: 'test run', outcome: 'success', local: true }),
      ]);
      expect(requests).toContain('POST /api/cli/v1/tunnel');
      expect(requests).toContain('DELETE /api/cli/v1/tunnel/client_auto');
      expect(JSON.parse(stdout)).toMatchObject({ runId: 'run_auto', status: 'passed' });
    } finally {
      vi.doUnmock('./vendor/tunnel-client/index.js');
    }
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

describe('ApiError branch redacts secrets in the JSON error envelope', () => {
  it('error envelope redacts nested secrets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'VALIDATION_ERROR',
                message: 'Invalid request.',
                nextAction: 'Fix it.',
                requestId: 'req_redact',
                details: {
                  field: 'password',
                  echoedCredentials: {
                    password: 'hunter2-DO-NOT-PRINT',
                    apiKey: 'sk-should-not-leak',
                  },
                },
              },
            }),
            { status: 400 },
          ),
      ),
    );
    process.argv = ['node', 'testsprite', 'auth', 'whoami', '--output', 'json'];
    await import('./index.js');
    expect(process.exitCode).toBe(5);
    expect(stderr).not.toContain('hunter2-DO-NOT-PRINT');
    expect(stderr).not.toContain('sk-should-not-leak');
    const envelope = JSON.parse(stderr.slice(stderr.indexOf('{')));
    expect(envelope.error.details).toEqual({
      field: 'password',
      echoedCredentials: { password: '[REDACTED]', apiKey: '[REDACTED]' },
    });
  });
});
