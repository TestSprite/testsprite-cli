import { projectRun, runListing } from '../test/helpers/project-run.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as InterruptModule from './lib/interrupt.js';
import type * as TunnelClientModule from './vendor/tunnel-client/index.js';
import { resultLine } from '../test/helpers/result-list.js';

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
  process.argv = ['node', 'testsprite', 'auth', 'status', '--output', 'json'];
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
  process.argv = ['node', 'testsprite', 'auth', 'status'];
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
  process.argv = ['node', 'testsprite', 'auth', 'status'];
  await import('./index.js');

  expect(process.exitCode).toBe(130);
  expect(vi.getTimerCount()).toBe(1);
  vi.clearAllTimers();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(exit).not.toHaveBeenCalled();
});

describe('backend local unsupported rendering', () => {
  it.each([
    {
      output: 'text',
      reason: 'tunnel-unsupported-for-backend-test',
      message: 'Original backend message',
    },
    {
      output: 'json',
      reason: 'tunnel-unsupported-for-backend-test',
      message: 'Original backend message',
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

describe('whole-run timeout telemetry through the entry point', () => {
  it.each([
    { args: ['run', 'test_abc', '--wait'], timeout: true },
    { args: ['run', 'wait', 'exec_abc'], timeout: true },
    { args: ['run', 'wait', 'exec_abc', 'exec_other'], timeout: true },
    { args: ['run', '--project', 'project_abc', '--wait'], timeout: true },
    { args: ['run', 'wait', 'exec_abc'], timeout: true, rate: true },
    { args: ['run', 'test_abc', '--wait'], timeout: false },
  ])('reports the authoritative deadline for $args timeout=$timeout rate=$rate', async scenario => {
    vi.useFakeTimers();
    vi.stubEnv('TESTSPRITE_NO_TELEMETRY', '0');
    vi.stubEnv('DO_NOT_TRACK', '0');
    const events: unknown[] = [];
    let entered = () => {};
    const polling = new Promise<void>(resolve => {
      entered = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/telemetry')) {
          events.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 204 });
        }
        if (init?.method === 'POST')
          return new Response(
            JSON.stringify(projectRun({ runId: 'exec_abc', projectId: 'project_abc' })),
          );
        if (url.pathname.endsWith('/results')) {
          entered();
          if ('rate' in scenario)
            return new Response(
              JSON.stringify({
                code: 'RATE_LIMITED',
                message: 'per-minute limit exceeded',
                nextAction: 'retry later',
                requestId: 'rate',
                details: {},
              }),
              { status: 429, headers: { 'retry-after': '1' } },
            );
          return new Response(
            JSON.stringify(
              runListing(
                {
                  runId: url.searchParams.get('run')!,
                  status: scenario.timeout ? 'running' : 'finished',
                  cancelled: false,
                },
                [
                  resultLine({
                    resultId: 'result-a',
                    runId: url.searchParams.get('run')!,
                    testStatus: scenario.timeout ? 'RUNNING' : 'PASSED',
                  }),
                ],
              ),
            ),
          );
        }
        if (url.pathname.endsWith('/env'))
          return new Response(
            JSON.stringify({
              environments: [
                { id: 'env', name: 'default', url: 'https://example.com', isDefault: true },
              ],
            }),
          );
        return new Response(
          JSON.stringify({ id: 'test_abc', type: 'frontend', projectId: 'project_abc' }),
        );
      }),
    );
    process.argv = ['node', 'testsprite', ...scenario.args, '--timeout', '1', '--output', 'json'];
    const pending = import('./index.js');
    await Promise.race([
      polling,
      pending.then(() => {
        throw new Error(`Ended before wait: ${stderr}`);
      }),
    ]);
    await vi.advanceTimersByTimeAsync(3100);
    await pending;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(
      scenario.timeout
        ? {
            outcome: 'error',
            exitCode: 7,
            reason: 'wait_timeout',
            errorOrigin: 'client',
            timeoutSeconds: 1,
          }
        : { outcome: 'success', exitCode: 0 },
    );
    expect(JSON.parse(stdout)).toBeTruthy();
  });
});

describe('local telemetry through the entry point', () => {
  it.each([
    {
      args: ['run', 'test_abc', '--local', '5173', '--target-url', 'https://example.com'],
      command: 'run',
      outcome: 'error',
      exitCode: 5,
    },
    {
      args: [
        'project',
        'env',
        'create',
        'project_local',
        '--name',
        'local',
        '--local',
        '5173',
        '--skip-preflight',
      ],
      command: 'project env create',
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
        if (path.endsWith('/projects/project_local/env') && init?.method === 'POST')
          return new Response(
            JSON.stringify({
              environment: {
                id: 'env_local',
                name: 'local',
                url: 'http://localhost:5173',
                isDefault: true,
                authMode: 'public',
                hasCredentials: false,
                username: null,
                enableOtp: false,
                updatedAt: '2026-10-01T00:00:00Z',
              },
              created: true,
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
        ? ['POST /api/cli/v1/projects/project_local/env', 'POST /api/cli/v1/telemetry']
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
        if (method === 'POST' && path.endsWith('/projects/project_auto/runs'))
          return new Response(
            JSON.stringify({
              projectId: 'project_auto',
              total: 1,
              autoHeal: true,
              blocked: [],
              held: [],
              environment: { id: 'env_auto', name: 'local-app' },
              runId: 'exec_auto',
              status: 'queued',
              enqueuedAt: '2026-10-01T00:00:00Z',
              codeVersion: 'v1',
              targetUrl: 'http://localhost:5173',
              tunnelClientId: 'client_auto',
            }),
          );
        if (path.endsWith('/results'))
          return new Response(
            JSON.stringify(
              runListing({ runId: 'exec_auto', status: 'finished', cancelled: false }, [
                resultLine({
                  resultId: 'run_auto',
                  runId: 'exec_auto',
                  caseKey: 'test_auto',
                  testStatus: 'PASSED',
                }),
              ]),
            ),
          );
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
    process.argv = [
      'node',
      'testsprite',
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
        expect.objectContaining({ command: 'run', outcome: 'success', local: true }),
      ]);
      expect(requests).toContain('POST /api/cli/v1/tunnel');
      expect(requests).toContain('DELETE /api/cli/v1/tunnel/client_auto');
      expect(JSON.parse(stdout)).toMatchObject({
        runs: [{ runId: 'exec_auto' }],
        results: [{ resultId: 'run_auto', testId: 'test_auto', status: 'passed' }],
      });
      expect(stdout).not.toContain('executionId');
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
  it('`run wait` resolving to a failed run exits 1 with a full 5-key error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (new URL(url).pathname.endsWith('/results')) {
          return new Response(
            JSON.stringify(
              runListing({ runId: 'exec_abc', status: 'finished', cancelled: false }, [
                resultLine({ resultId: 'run_abc', runId: 'exec_abc', testStatus: 'FAILED' }),
              ]),
            ),
          );
        }
        if (url.includes('/runs/')) {
          return new Response(
            JSON.stringify({
              resultId: 'run_abc',
              runId: 'exec_abc',
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
    process.argv = ['node', 'testsprite', 'run', 'wait', 'exec_abc', '--output', 'json'];
    await import('./index.js');
    expect(process.exitCode).toBe(1);
    const envelope = JSON.parse(stderr.slice(stderr.indexOf('{')));
    expect(envelope).toEqual({
      error: {
        code: 'CLI_ERROR',
        message: '1 result failed.',
        nextAction: '',
        requestId: 'local',
        details: {},
      },
    });
  });
});

describe('native conflict envelopes through the entry point', () => {
  it.each(['json', 'text'])(
    'preserves backend message, hint and nested IDs in %s',
    async output => {
      const raw = {
        code: 'CONFLICT',
        message: 'Original run e1 conflict',
        // Older backend guidance remains server-owned, even after the CLI path moves.
        nextAction: 'Original action: testsprite test wait e1',
        requestId: 'raw-conflict',
        details: {
          currentRunId: 'e1',
          currentResultId: 'r1',
          nested: { runId: 'e2', resultId: 'r2' },
        },
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: unknown, init?: RequestInit) => {
          const path = new URL(String(input)).pathname;
          if (init?.method === 'POST') return new Response(JSON.stringify(raw), { status: 409 });
          if (path.endsWith('/env')) return new Response(JSON.stringify({ environments: [] }));
          return new Response(
            JSON.stringify({ id: 'test_busy', projectId: 'project_busy', type: 'frontend' }),
          );
        }),
      );
      process.argv = ['node', 'testsprite', 'run', 'test_busy', '--no-wait', '--output', output];
      await import('./index.js');
      expect(process.exitCode).toBe(6);
      if (output === 'json')
        expect(JSON.parse(stderr.slice(stderr.indexOf('{')))).toEqual({ error: raw });
      else {
        expect(stderr).toContain(raw.message);
        expect(stderr).toContain(raw.nextAction);
      }
    },
  );
});

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
    process.argv = ['node', 'testsprite', 'auth', 'status', '--output', 'json'];
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
