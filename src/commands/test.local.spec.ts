/**
 * `test run <test-id> --local <port>` — DEV-747 piece 3.
 *
 * Every assertion here is about one of the two things that can silently cost a
 * user money: **charging for a run that was doomed before it started**, and
 * **telling them a doomed run is still fine**. The tunnel plumbing itself is
 * covered in `lib/tunnel-session.spec.ts`; this file covers the command's
 * contract with the wallet and with the truth.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, InterruptError, RequestTimeoutError } from '../lib/errors.js';
import { ShutdownController } from '../lib/interrupt.js';
import type { JUnitReportFlagOptions } from '../lib/junit-report.js';
import type { TunnelClientOptions } from '../vendor/tunnel-client/index.js';
import { ErrCode } from '../vendor/tunnel-client/index.js';
import type { RunResponse, TriggerRunResponse } from '../lib/runs.types.js';
import { createTestCommand, runTestRun } from './test.js';

type FetchInput = Parameters<typeof globalThis.fetch>[0];

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function makeCreds(apiKey = 'sk-user-test'): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-dev747-'));
  const credentialsPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    credentialsPath,
    `[default]\napi_url = http://localhost:13502\napi_key = ${apiKey}\n`,
    { mode: 0o600 },
  );
  return { credentialsPath };
}

const SECRET = 'tunnel-secret-DO-NOT-LEAK-2f8a';

const MINT_BODY = {
  clientId: '11111111-2222-3333-4444-555555555555',
  secret: SECRET,
  controlUrl: 'ws://tunnel.example:7300/ws',
  tunnelAddr: 'tunnel.example:7400',
  expiresAt: '2026-08-24T18:00:00.000Z',
};

function passedRun(targetUrl: string): RunResponse {
  return {
    runId: 'run_abc',
    testId: 'test_xyz',
    projectId: 'project_1',
    userId: 'user_1',
    status: 'passed',
    source: 'cli',
    createdAt: '2026-08-24T10:00:00.000Z',
    startedAt: '2026-08-24T10:00:01.000Z',
    finishedAt: '2026-08-24T10:00:30.000Z',
    codeVersion: 'v1',
    targetUrl,
    createdFrom: 'cli',
    failedStepIndex: null,
    failureKind: null,
    error: null,
    videoUrl: null,
    stepSummary: { total: 3, completed: 3, passedCount: 3, failedCount: 0 },
  };
}

function apiErrorResponse(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message,
        nextAction: 'retry',
        requestId: `r-${code.toLowerCase()}`,
        details,
      },
    }),
    {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    },
  );
}

/**
 * Records every request. `runStatus` controls what the poll returns, so a test
 * can keep a run non-terminal for as long as it needs.
 */
function makeRecordingFetch(opts: {
  calls: Call[];
  targetUrl: string;
  run?: () => RunResponse;
  mintStatus?: number;
  mintBody?: unknown;
  respond?: (call: Call, init: RequestInit) => Response | undefined | Promise<Response | undefined>;
}): typeof globalThis.fetch {
  return (async (input: FetchInput, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;
    const method = (init.method ?? 'GET').toUpperCase();
    const body =
      init.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body));
    const call = { method, url, body };
    opts.calls.push(call);

    const custom = await opts.respond?.(call, init);
    if (custom !== undefined) return custom;

    if (method === 'POST' && url.endsWith('/tunnel')) {
      return new Response(JSON.stringify(opts.mintBody ?? MINT_BODY), {
        status: opts.mintStatus ?? 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'DELETE' && url.includes('/tunnel/')) {
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && url.includes('/runs') && !url.includes('/cancel')) {
      const trigger: TriggerRunResponse = {
        runId: 'run_abc',
        status: 'queued',
        enqueuedAt: '2026-08-24T10:00:00.000Z',
        codeVersion: 'v1',
        targetUrl: opts.targetUrl,
      };
      return new Response(JSON.stringify(trigger), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'POST' && url.includes('/cancel')) {
      return new Response(
        JSON.stringify({
          ...passedRun(opts.targetUrl),
          status: 'cancelled',
          alreadyCancelled: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify(opts.run ? opts.run() : passedRun(opts.targetUrl)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

/** Stand-in for the vendored tunnel client. */
function fakeTunnel() {
  let captured: TunnelClientOptions | undefined;
  const calls = { start: 0, stop: 0 };
  return {
    calls,
    seen: () => captured,
    emitAuthFailure: () =>
      captured?.onError?.({ code: ErrCode.AuthFailed, message: 'Control authentication failed' }),
    factory: (options: TunnelClientOptions) => {
      captured = options;
      return {
        start: async () => {
          calls.start += 1;
        },
        stop: async () => {
          calls.stop += 1;
        },
      };
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Pre-charge guarantee
// ---------------------------------------------------------------------------

describe('test run --local — before anything is minted or charged', () => {
  it('refuses a dead port with NO mint and NO trigger', async () => {
    // Port 1 is not a valid application listener in the test environment and
    // avoids opening a real server (some CI sandboxes prohibit bind/listen).
    const port = 1;
    const calls: Call[] = [];
    let thrown: unknown;
    try {
      await runTestRun(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_xyz',
          localPort: port,
          localHost: '127.0.0.1',
          wait: true,
          timeoutSeconds: 30,
        },
        {
          ...makeCreds(),
          fetchImpl: makeRecordingFetch({ calls, targetUrl: `http://127.0.0.1:${port}` }),
          stderr: () => {},
          stdout: () => {},
          sleep: async () => {},
          createTunnelClient: fakeTunnel().factory,
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).code).toBe('VALIDATION_ERROR');
    // The whole point: no run row, no credit spend, no tunnel credential.
    expect(calls).toEqual([]);
  });

  it('refuses --local together with --target-url without touching the network', async () => {
    // This validation runs before the port probe. The exact `field` and
    // nextAction assertions below distinguish it from a dead-port refusal.
    const port = 5173;
    const calls: Call[] = [];
    let thrown: unknown;
    try {
      await runTestRun(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_xyz',
          localPort: port,
          localHost: '127.0.0.1',
          targetUrl: 'https://example.com',
          wait: true,
          timeoutSeconds: 30,
        },
        {
          ...makeCreds(),
          fetchImpl: makeRecordingFetch({ calls, targetUrl: 'x' }),
          stderr: () => {},
          stdout: () => {},
          sleep: async () => {},
          createTunnelClient: fakeTunnel().factory,
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    const err = thrown as ApiError;
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.getDetail('field', (v): v is string => typeof v === 'string')).toBe('local');
    expect(err.nextAction).toMatch(/mutually exclusive/i);
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Signal-safe lifecycle
// ---------------------------------------------------------------------------

describe('test run --local — signal-safe lifecycle', () => {
  it('stays armed from mint through cleanup and does not abort a charged trigger response', async () => {
    const port = 5173;
    const calls: Call[] = [];
    const target = `http://127.0.0.1:${port}`;
    const shutdown = new ShutdownController();
    const phases: Array<{ phase: string; armed: boolean; critical: boolean }> = [];
    let triggerSignalAborted: boolean | undefined;
    let thrown: unknown;

    try {
      await runTestRun(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_xyz',
          localPort: port,
          localHost: '127.0.0.1',
          wait: true,
          timeoutSeconds: 30,
          skipPreflight: true,
        },
        {
          ...makeCreds(),
          fetchImpl: makeRecordingFetch({
            calls,
            targetUrl: target,
            respond: async (call, init) => {
              if (call.method === 'POST' && call.url.endsWith('/tunnel')) {
                phases.push({
                  phase: 'mint',
                  armed: shutdown.isArmed,
                  critical: shutdown.hasCriticalOperations,
                });
              }
              if (
                call.method === 'POST' &&
                call.url.includes('/runs') &&
                !call.url.includes('/cancel')
              ) {
                phases.push({
                  phase: 'trigger',
                  armed: shutdown.isArmed,
                  critical: shutdown.hasCriticalOperations,
                });
                shutdown.interrupt('SIGINT');
                await Promise.resolve();
                triggerSignalAborted = init.signal?.aborted;
              }
              if (call.method === 'POST' && call.url.includes('/cancel')) {
                phases.push({
                  phase: 'cancel',
                  armed: shutdown.isArmed,
                  critical: shutdown.hasCriticalOperations,
                });
              }
              if (call.method === 'DELETE') {
                phases.push({
                  phase: 'delete',
                  armed: shutdown.isArmed,
                  critical: shutdown.hasCriticalOperations,
                });
              }
              return undefined;
            },
          }),
          stderr: () => {},
          stdout: () => {},
          sleep: async () => {},
          shutdown,
          createTunnelClient: options => ({
            start: async () => {
              phases.push({
                phase: 'connect',
                armed: shutdown.isArmed,
                critical: shutdown.hasCriticalOperations,
              });
              void options;
            },
            stop: async () => {},
          }),
        },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(InterruptError);
    expect(triggerSignalAborted).toBe(false);
    expect(phases).toEqual([
      { phase: 'mint', armed: true, critical: false },
      { phase: 'connect', armed: true, critical: false },
      { phase: 'trigger', armed: true, critical: false },
      { phase: 'cancel', armed: true, critical: true },
      { phase: 'delete', armed: true, critical: true },
    ]);
    expect(shutdown.isArmed).toBe(false);
  });

  it('bounds the trigger retry chain by one total deadline after Ctrl-C', async () => {
    vi.useFakeTimers();
    try {
      const shutdown = new ShutdownController();
      const calls: Call[] = [];
      const target = 'http://127.0.0.1:5173';
      const pending = runTestRun(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_xyz',
          localPort: 5173,
          localHost: '127.0.0.1',
          tunnelClientId: 'adopted-client-id',
          skipPreflight: true,
          wait: true,
          // Direct-call fixture: keeps resolveWaitRequestTimeoutMs at its
          // 1-second floor so fake time can prove the TOTAL request budget.
          timeoutSeconds: -4,
          requestTimeoutMs: 1_000,
        },
        {
          ...makeCreds(),
          fetchImpl: makeRecordingFetch({
            calls,
            targetUrl: target,
            respond: call => {
              if (
                call.method === 'POST' &&
                call.url.includes('/runs') &&
                !call.url.includes('/cancel')
              ) {
                shutdown.interrupt('SIGINT');
                return apiErrorResponse(503, 'UNAVAILABLE', 'trigger unavailable');
              }
              return undefined;
            },
          }),
          stdout: () => {},
          stderr: () => {},
          shutdown,
        },
      );
      const outcome = pending.catch((err: unknown) => err);
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_000);

      expect(settled).toBe(true);
      const error = await outcome;
      expect(error).toBeInstanceOf(RequestTimeoutError);
      expect(error).toMatchObject({ exitCode: 7, timeoutMs: 1_000 });
      expect(
        calls.filter(call => call.method === 'POST' && call.url.includes('/runs')).length,
      ).toBeGreaterThan(0);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('test run --local — happy path', () => {
  it('lets --local satisfy --wait for both --gh-output and --summary-file', async () => {
    const port = 5173;
    const calls: Call[] = [];
    const artifactDir = mkdtempSync(join(tmpdir(), 'cli-dev747-output-'));
    const summaryFile = join(artifactDir, 'summary.json');
    const target = `http://127.0.0.1:${port}`;
    const command = createTestCommand({
      ...makeCreds(),
      fetchImpl: makeRecordingFetch({ calls, targetUrl: target }),
      stdout: () => {},
      stderr: () => {},
      sleep: async () => {},
      createTunnelClient: fakeTunnel().factory,
    });

    await command.parseAsync(
      [
        'run',
        'test_xyz',
        '--local',
        String(port),
        '--local-host',
        '127.0.0.1',
        '--skip-preflight',
        '--gh-output',
        '--summary-file',
        summaryFile,
      ],
      { from: 'user' },
    );

    expect(calls.some(call => call.method === 'POST' && call.url.includes('/runs'))).toBe(true);
    expect(existsSync(summaryFile)).toBe(true);
    expect(JSON.parse(readFileSync(summaryFile, 'utf8'))).toMatchObject({
      total: 1,
      passed: 1,
    });
  });

  describe('the implied-wait advisory states a reason that is true on the path it is printed', () => {
    async function advisoryFor(extraArgs: string[]): Promise<string> {
      const port = 5173;
      const target = `http://127.0.0.1:${port}`;
      const lines: string[] = [];
      const command = createTestCommand({
        ...makeCreds(),
        fetchImpl: makeRecordingFetch({ calls: [], targetUrl: target }),
        stdout: () => {},
        stderr: line => lines.push(line),
        sleep: async () => {},
        createTunnelClient: fakeTunnel().factory,
      });

      await command.parseAsync(
        ['run', 'test_xyz', '--local', String(port), '--skip-preflight', ...extraArgs],
        { from: 'user' },
      );

      return lines.filter(line => line.includes('implies --wait')).join('\n');
    }

    it('says the tunnel closes with this command when the command minted it', async () => {
      const advisory = await advisoryFor([]);
      expect(advisory).toMatch(/tunnel closes when this command exits/);
    });

    it('does NOT claim to close a tunnel it merely borrowed', async () => {
      // An adopted tunnel outlives this process by design, so the self-minted
      // reason is not just imprecise here — it is the sentence a reader acts on
      // when deciding what happens to their own long-lived tunnel.
      const advisory = await advisoryFor(['--tunnel-client', 'cli_tunnel_abc']);
      expect(advisory).not.toMatch(/tunnel closes when this command exits/);
      expect(advisory).toMatch(/stays open|does not close it/i);
    });

    it('still announces the implied wait on the adopted path', async () => {
      // The conclusion is unchanged — only the reason differs — so a caller who
      // did not type --wait must still learn why the command is blocking.
      expect(await advisoryFor(['--tunnel-client', 'cli_tunnel_abc'])).toMatch(
        /--local implies --wait/,
      );
    });
  });

  it('passes the --local implied wait state to JUnit validation', async () => {
    const observed: unknown[] = [];
    vi.resetModules();
    vi.doMock('../lib/junit-report.js', async () => {
      const actual = await vi.importActual<
        Record<string, unknown> & {
          assertJUnitReportOptions: (options: JUnitReportFlagOptions) => void;
        }
      >('../lib/junit-report.js');
      return {
        ...actual,
        assertJUnitReportOptions: (options: JUnitReportFlagOptions) => {
          observed.push(options);
          actual.assertJUnitReportOptions(options);
        },
      };
    });

    try {
      const { createTestCommand: createFreshTestCommand } = await import('./test.js');
      const command = createFreshTestCommand({
        ...makeCreds(),
        stdout: () => {},
        stderr: () => {},
      });
      await expect(
        command.parseAsync(
          [
            'run',
            'test_xyz',
            '--local',
            '5173',
            '--skip-preflight',
            '--report',
            'junit',
            '--report-file',
            join(tmpdir(), 'unused-junit.xml'),
          ],
          { from: 'user' },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(observed).toContainEqual(
        expect.objectContaining({ report: 'junit', wait: true, batchPath: false }),
      );
    } finally {
      vi.doUnmock('../lib/junit-report.js');
      vi.resetModules();
    }
  });

  it('mints, connects, triggers with tunnelClientId and the loopback target, then deletes', async () => {
    const port = 5173;
    const calls: Call[] = [];
    const tunnel = fakeTunnel();
    const target = `http://127.0.0.1:${port}`;

    await runTestRun(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_xyz',
        localPort: port,
        localHost: '127.0.0.1',
        wait: true,
        timeoutSeconds: 30,
        skipPreflight: true,
      },
      {
        ...makeCreds(),
        fetchImpl: makeRecordingFetch({ calls, targetUrl: target }),
        stderr: () => {},
        stdout: () => {},
        sleep: async () => {},
        createTunnelClient: tunnel.factory,
      },
    );

    const mint = calls.find(c => c.method === 'POST' && c.url.endsWith('/tunnel'));
    const trigger = calls.find(c => c.method === 'POST' && c.url.includes('/runs'));
    const del = calls.find(c => c.method === 'DELETE' && c.url.includes('/tunnel/'));

    expect(mint).toBeDefined();
    expect(trigger?.body).toEqual({
      source: 'cli',
      targetUrl: target,
      tunnelClientId: MINT_BODY.clientId,
    });
    expect(del?.url).toContain(MINT_BODY.clientId);
    expect(tunnel.calls.start).toBe(1);
    expect(tunnel.calls.stop).toBe(1);
  });

  it('puts NO secret-shaped value anywhere in the trigger request, byte-level', async () => {
    const port = 5173;
    const calls: Call[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_xyz',
        localPort: port,
        localHost: '127.0.0.1',
        wait: true,
        timeoutSeconds: 30,
        skipPreflight: true,
      },
      {
        ...makeCreds(),
        fetchImpl: makeRecordingFetch({ calls, targetUrl: `http://127.0.0.1:${port}` }),
        stderr: () => {},
        stdout: () => {},
        sleep: async () => {},
        createTunnelClient: fakeTunnel().factory,
      },
    );
    const trigger = calls.find(c => c.method === 'POST' && c.url.includes('/runs'));
    expect(JSON.stringify(trigger?.body)).not.toContain(SECRET);
  });

  it('keeps the secret out of every emitted line, even at --debug', async () => {
    const port = 5173;
    const lines: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'text',
        debug: true,
        verbose: true,
        testId: 'test_xyz',
        localPort: port,
        localHost: '127.0.0.1',
        wait: true,
        timeoutSeconds: 30,
        skipPreflight: true,
      },
      {
        ...makeCreds(),
        fetchImpl: makeRecordingFetch({ calls: [], targetUrl: `http://127.0.0.1:${port}` }),
        stderr: line => lines.push(line),
        stdout: line => lines.push(line),
        sleep: async () => {},
        createTunnelClient: fakeTunnel().factory,
      },
    );
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(SECRET);
  });

  it('adopts a caller-supplied --tunnel-client without minting or deleting it', async () => {
    const port = 5173;
    const calls: Call[] = [];
    const tunnel = fakeTunnel();
    await runTestRun(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_xyz',
        localPort: port,
        localHost: '127.0.0.1',
        tunnelClientId: 'adopted-client-id',
        wait: true,
        timeoutSeconds: 30,
        skipPreflight: true,
      },
      {
        ...makeCreds(),
        fetchImpl: makeRecordingFetch({ calls, targetUrl: `http://127.0.0.1:${port}` }),
        stderr: () => {},
        stdout: () => {},
        sleep: async () => {},
        createTunnelClient: tunnel.factory,
      },
    );
    expect(calls.some(c => c.method === 'POST' && c.url.endsWith('/tunnel'))).toBe(false);
    expect(calls.some(c => c.method === 'DELETE' && c.url.includes('/tunnel/'))).toBe(false);
    expect(tunnel.calls.start).toBe(0);
    const trigger = calls.find(c => c.method === 'POST' && c.url.includes('/runs'));
    expect((trigger?.body as { tunnelClientId?: string }).tunnelClientId).toBe('adopted-client-id');
  });
});

// ---------------------------------------------------------------------------
// Teardown on every exit path
// ---------------------------------------------------------------------------

describe('test run --local — teardown', () => {
  it('deletes the binding when the run FAILS', async () => {
    const port = 5173;
    const calls: Call[] = [];
    const target = `http://127.0.0.1:${port}`;
    await expect(
      runTestRun(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_xyz',
          localPort: port,
          localHost: '127.0.0.1',
          wait: true,
          timeoutSeconds: 30,
          skipPreflight: true,
        },
        {
          ...makeCreds(),
          fetchImpl: makeRecordingFetch({
            calls,
            targetUrl: target,
            run: () => ({ ...passedRun(target), status: 'failed' }),
          }),
          stderr: () => {},
          stdout: () => {},
          sleep: async () => {},
          createTunnelClient: fakeTunnel().factory,
        },
      ),
    ).rejects.toBeDefined();
    expect(calls.some(c => c.method === 'DELETE' && c.url.includes('/tunnel/'))).toBe(true);
  });

  it('deletes the binding when the trigger itself throws', async () => {
    const port = 5173;
    const calls: Call[] = [];
    const fetchImpl = (async (input: FetchInput, init: RequestInit = {}) => {
      const url = String(input);
      const method = (init.method ?? 'GET').toUpperCase();
      calls.push({ method, url, body: undefined });
      if (method === 'POST' && url.endsWith('/tunnel')) {
        return new Response(JSON.stringify(MINT_BODY), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(
        JSON.stringify({
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: 'no credits',
            nextAction: 'top up',
            requestId: 'r1',
            details: {},
          },
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    await expect(
      runTestRun(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_xyz',
          localPort: port,
          localHost: '127.0.0.1',
          wait: true,
          timeoutSeconds: 30,
          skipPreflight: true,
        },
        {
          ...makeCreds(),
          fetchImpl,
          stderr: () => {},
          stdout: () => {},
          sleep: async () => {},
          createTunnelClient: fakeTunnel().factory,
        },
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
    expect(calls.some(c => c.method === 'DELETE' && c.url.includes('/tunnel/'))).toBe(true);
  });

  it('deletes the binding when the wait is interrupted', async () => {
    const port = 5173;
    const calls: Call[] = [];
    const target = `http://127.0.0.1:${port}`;
    const shutdown = new ShutdownController();
    await expect(
      runTestRun(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_xyz',
          localPort: port,
          localHost: '127.0.0.1',
          wait: true,
          timeoutSeconds: 30,
          skipPreflight: true,
        },
        {
          ...makeCreds(),
          fetchImpl: makeRecordingFetch({
            calls,
            targetUrl: target,
            run: () => {
              shutdown.interrupt('SIGINT');
              return { ...passedRun(target), status: 'running' };
            },
          }),
          stderr: () => {},
          stdout: () => {},
          sleep: async () => {},
          shutdown,
          createTunnelClient: fakeTunnel().factory,
        },
      ),
    ).rejects.toBeInstanceOf(InterruptError);
    expect(calls.some(c => c.method === 'DELETE' && c.url.includes('/tunnel/'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Honest detach — the message and the cancel
// ---------------------------------------------------------------------------

describe('test run --local — detaching from a tunnel run tells the truth', () => {
  async function interruptRun(overrides: Partial<Parameters<typeof runTestRun>[0]> = {}) {
    const port = 5173;
    const calls: Call[] = [];
    const lines: string[] = [];
    const target = `http://127.0.0.1:${port}`;
    const shutdown = new ShutdownController();
    let thrown: unknown;
    try {
      await runTestRun(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_xyz',
          localPort: port,
          localHost: '127.0.0.1',
          wait: true,
          timeoutSeconds: 30,
          skipPreflight: true,
          ...overrides,
        },
        {
          ...makeCreds(),
          fetchImpl: makeRecordingFetch({
            calls,
            targetUrl: target,
            run: () => {
              shutdown.interrupt('SIGINT');
              return { ...passedRun(target), status: 'running' };
            },
          }),
          stderr: line => lines.push(line),
          stdout: line => lines.push(line),
          sleep: async () => {},
          shutdown,
          createTunnelClient: fakeTunnel().factory,
        },
      );
    } catch (err) {
      thrown = err;
    }
    return { calls, lines, thrown };
  }

  it('does NOT claim the run keeps executing — the tunnel is closing with it', async () => {
    const { lines } = await interruptRun();
    const text = lines.join('\n');
    expect(text).not.toMatch(/keep running \(and billing\)/);
    expect(text).toMatch(/tunnel/i);
  });

  it('does NOT offer `test wait` as a re-attach — re-attaching cannot help', async () => {
    const { lines } = await interruptRun();
    expect(lines.join('\n')).not.toMatch(/testsprite test wait/);
  });

  it('cancels the run by default rather than paying for a guaranteed failure', async () => {
    const { calls, thrown } = await interruptRun();
    expect(calls.some(c => c.method === 'POST' && c.url.includes('/cancel'))).toBe(true);
    expect(thrown).toMatchObject({ signal: 'SIGINT', exitCode: 130 });
    const tunnelDetach = (
      thrown as InterruptError & {
        tunnelDetach?: { cancel: string; nextAction: string; runId: string };
      }
    ).tunnelDetach;
    expect(tunnelDetach).toMatchObject({ cancel: 'cancelled', runId: 'run_abc' });
    expect(tunnelDetach?.nextAction).not.toMatch(/keeps executing|billing|test wait/i);
    expect(tunnelDetach?.nextAction).toMatch(/cancelled|--local/i);
  });

  it('honours --no-cancel-on-interrupt', async () => {
    const { calls, lines } = await interruptRun({ cancelOnInterrupt: false });
    expect(calls.some(c => c.method === 'POST' && c.url.includes('/cancel'))).toBe(false);
    // Still honest: it must not silently look like a normal detach.
    expect(lines.join('\n')).toMatch(/tunnel/i);
  });

  it('treats an adopted tunnel interrupt as an ordinary detach', async () => {
    const port = 5173;
    const calls: Call[] = [];
    const lines: string[] = [];
    const target = `http://127.0.0.1:${port}`;
    const shutdown = new ShutdownController();
    let thrown: unknown;
    try {
      await runTestRun(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_xyz',
          localPort: port,
          localHost: '127.0.0.1',
          tunnelClientId: 'adopted-client-id',
          wait: true,
          timeoutSeconds: 30,
          skipPreflight: true,
        },
        {
          ...makeCreds(),
          fetchImpl: makeRecordingFetch({
            calls,
            targetUrl: target,
            respond: call => {
              if (
                call.method === 'POST' &&
                call.url.includes('/runs') &&
                !call.url.includes('/cancel')
              ) {
                shutdown.interrupt('SIGINT');
              }
              return undefined;
            },
          }),
          stderr: line => lines.push(line),
          stdout: line => lines.push(line),
          sleep: async () => {},
          shutdown,
        },
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(InterruptError);
    expect(calls.some(call => call.url.includes('/cancel'))).toBe(false);
    expect(lines.join('\n')).toMatch(/keep running \(and billing\)/);
    expect(lines.join('\n')).toContain('testsprite test wait run_abc');
    expect((thrown as InterruptError & { tunnelDetach?: unknown }).tunnelDetach).toBeUndefined();
  });

  it('leaves a NON-tunnel interrupt exactly as it was', async () => {
    const calls: Call[] = [];
    const lines: string[] = [];
    const shutdown = new ShutdownController();
    await expect(
      runTestRun(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_xyz',
          wait: true,
          timeoutSeconds: 30,
        },
        {
          ...makeCreds(),
          fetchImpl: makeRecordingFetch({
            calls,
            targetUrl: 'https://example.com',
            run: () => {
              shutdown.interrupt('SIGINT');
              return { ...passedRun('https://example.com'), status: 'running' };
            },
          }),
          stderr: line => lines.push(line),
          stdout: line => lines.push(line),
          sleep: async () => {},
          shutdown,
        },
      ),
    ).rejects.toBeInstanceOf(InterruptError);
    const text = lines.join('\n');
    expect(text).toMatch(/keep running \(and billing\)/);
    expect(text).toMatch(/testsprite test wait/);
    expect(calls.some(c => c.url.includes('/cancel'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Every non-terminal poll exit settles an owned tunnel run
// ---------------------------------------------------------------------------

describe('test run --local — every poll exit settles the charged run', () => {
  async function capturePollExit(options: {
    timeoutSeconds?: number;
    respond?: (
      call: Call,
      init: RequestInit,
    ) => Response | undefined | Promise<Response | undefined>;
  }) {
    const port = 5173;
    const calls: Call[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const target = `http://127.0.0.1:${port}`;
    let thrown: unknown;
    try {
      await runTestRun(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_xyz',
          localPort: port,
          localHost: '127.0.0.1',
          wait: true,
          timeoutSeconds: options.timeoutSeconds ?? 30,
          skipPreflight: true,
        },
        {
          ...makeCreds(),
          fetchImpl: makeRecordingFetch({
            calls,
            targetUrl: target,
            respond: options.respond,
          }),
          stdout: line => stdout.push(line),
          stderr: line => stderr.push(line),
          sleep: async () => {},
          createTunnelClient: fakeTunnel().factory,
        },
      );
    } catch (err) {
      thrown = err;
    }
    const partial =
      stdout.length > 0 ? (JSON.parse(stdout.join('\n')) as Record<string, unknown>) : {};
    return { calls, partial, stderr: stderr.join('\n'), thrown };
  }

  it('cancels and reports a partial on the polling TimeoutError path', async () => {
    const result = await capturePollExit({ timeoutSeconds: 0 });

    expect(result.calls.filter(call => call.url.includes('/cancel'))).toHaveLength(1);
    expect(result.partial).toMatchObject({ runId: 'run_abc', status: 'cancelled' });
    expect(result.stderr).toMatch(/Timed out waiting for run run_abc/i);
    expect(result.stderr).toMatch(/Cancelled it/i);
    expect(result.thrown).toMatchObject({ code: 'UNSUPPORTED', exitCode: 7 });
  });

  it('cancels and reports a partial on the polling RequestTimeoutError path', async () => {
    const original = new RequestTimeoutError(1_000, 'r-poll-timeout');
    const result = await capturePollExit({
      respond: call => {
        if (call.method === 'GET' && call.url.includes('/runs/')) throw original;
        return undefined;
      },
    });

    expect(result.calls.filter(call => call.url.includes('/cancel'))).toHaveLength(1);
    expect(result.partial).toMatchObject({ runId: 'run_abc', status: 'cancelled' });
    expect(result.stderr).toMatch(/Request timed out/i);
    expect(result.stderr).toMatch(/Cancelled it/i);
    expect(result.thrown).toBe(original);
    expect(result.thrown).toMatchObject({ exitCode: 7 });
  });

  it('cancels and reports a partial on the polling RATE_LIMITED path', async () => {
    const result = await capturePollExit({
      respond: call => {
        if (call.method === 'GET' && call.url.includes('/runs/')) {
          return apiErrorResponse(
            429,
            'RATE_LIMITED',
            'poll rate limit',
            {},
            { 'retry-after': '0' },
          );
        }
        return undefined;
      },
    });

    expect(result.calls.filter(call => call.url.includes('/cancel'))).toHaveLength(1);
    expect(result.partial).toMatchObject({ runId: 'run_abc', status: 'cancelled' });
    expect(result.stderr).toMatch(/Rate limited by the server/i);
    expect(result.stderr).toMatch(/Cancelled it/i);
    expect(result.thrown).toMatchObject({
      code: 'RATE_LIMITED',
      exitCode: 11,
      message: 'poll rate limit',
    });
  });

  it('also cancels and rethrows an unclassified exhausted 503 poll error unchanged', async () => {
    vi.useFakeTimers();
    try {
      const pending = capturePollExit({
        respond: call => {
          if (call.method === 'GET' && call.url.includes('/runs/')) {
            return apiErrorResponse(503, 'UNAVAILABLE', 'poll backend unavailable');
          }
          return undefined;
        },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(
        result.calls.filter(call => call.method === 'GET' && call.url.includes('/runs/')).length,
      ).toBeGreaterThanOrEqual(4);
      expect(result.calls.filter(call => call.url.includes('/cancel'))).toHaveLength(1);
      expect(result.partial).toMatchObject({ runId: 'run_abc', status: 'cancelled' });
      expect(result.stderr).toMatch(/Polling stopped/i);
      expect(result.stderr).toMatch(/Cancelled it/i);
      expect(result.thrown).toMatchObject({
        code: 'UNAVAILABLE',
        exitCode: 10,
        message: 'poll backend unavailable',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses details.status from a 409 cancel response in the partial', async () => {
    const original = new RequestTimeoutError(1_000, 'r-poll-timeout');
    const result = await capturePollExit({
      respond: call => {
        if (call.method === 'GET' && call.url.includes('/runs/')) throw original;
        if (call.method === 'POST' && call.url.includes('/cancel')) {
          return apiErrorResponse(409, 'CONFLICT', 'already terminal', { status: 'passed' });
        }
        return undefined;
      },
    });

    expect(result.partial).toMatchObject({ runId: 'run_abc', status: 'passed' });
    expect(result.stderr).toMatch(/already finished server-side/i);
    expect(result.thrown).toBe(original);
  });

  it('retries transient 429s for both cancel and binding deletion', async () => {
    vi.useFakeTimers();
    try {
      const port = 5173;
      const calls: Call[] = [];
      const target = `http://127.0.0.1:${port}`;
      const shutdown = new ShutdownController();
      let cancelCalls = 0;
      let deleteCalls = 0;
      const pending = runTestRun(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_xyz',
          localPort: port,
          localHost: '127.0.0.1',
          wait: true,
          timeoutSeconds: 30,
          skipPreflight: true,
        },
        {
          ...makeCreds(),
          fetchImpl: makeRecordingFetch({
            calls,
            targetUrl: target,
            respond: call => {
              if (
                call.method === 'POST' &&
                call.url.includes('/runs') &&
                !call.url.includes('/cancel')
              ) {
                shutdown.interrupt('SIGINT');
              }
              if (call.method === 'POST' && call.url.includes('/cancel')) {
                cancelCalls += 1;
                if (cancelCalls === 1) {
                  return apiErrorResponse(
                    429,
                    'RATE_LIMITED',
                    'cancel rate limit',
                    {},
                    { 'retry-after': '1' },
                  );
                }
              }
              if (call.method === 'DELETE') {
                deleteCalls += 1;
                if (deleteCalls === 1) {
                  return apiErrorResponse(
                    429,
                    'RATE_LIMITED',
                    'delete rate limit',
                    {},
                    { 'retry-after': '1' },
                  );
                }
              }
              return undefined;
            },
          }),
          stdout: () => {},
          stderr: () => {},
          sleep: async () => {},
          shutdown,
          createTunnelClient: fakeTunnel().factory,
        },
      );
      const outcome = pending.catch((err: unknown) => err);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(await outcome).toBeInstanceOf(InterruptError);
      expect.soft(cancelCalls).toBe(2);
      expect.soft(deleteCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the entire cancel retry chain to one 10 second deadline', async () => {
    vi.useFakeTimers();
    let pending: Promise<unknown> | undefined;
    try {
      const calls: Call[] = [];
      const target = 'http://127.0.0.1:5173';
      const shutdown = new ShutdownController();
      let cancelCalls = 0;
      pending = runTestRun(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_xyz',
          localPort: 5173,
          localHost: '127.0.0.1',
          wait: true,
          timeoutSeconds: 30,
          skipPreflight: true,
        },
        {
          ...makeCreds(),
          fetchImpl: makeRecordingFetch({
            calls,
            targetUrl: target,
            respond: (call, init) => {
              if (
                call.method === 'POST' &&
                call.url.includes('/runs') &&
                !call.url.includes('/cancel')
              ) {
                shutdown.interrupt('SIGINT');
              }
              if (call.method !== 'POST' || !call.url.includes('/cancel')) return undefined;
              cancelCalls += 1;
              return new Promise<Response>((resolve, reject) => {
                setTimeout(
                  () => resolve(apiErrorResponse(503, 'UNAVAILABLE', 'cancel unavailable')),
                  3_400,
                );
                const signal = init.signal;
                const rejectOnAbort = (): void =>
                  reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
                if (signal?.aborted) rejectOnAbort();
                else signal?.addEventListener('abort', rejectOnAbort, { once: true });
              });
            },
          }),
          stdout: () => {},
          stderr: () => {},
          sleep: async () => {},
          shutdown,
          createTunnelClient: fakeTunnel().factory,
        },
      ).catch((error: unknown) => error);

      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(await pending).toBeInstanceOf(InterruptError);
      expect(cancelCalls).toBeGreaterThan(1);
      expect(cancelCalls).toBeLessThan(4);
    } finally {
      await vi.runAllTimersAsync();
      await pending?.catch(() => {});
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Fatal tunnel loss mid-run
// ---------------------------------------------------------------------------

describe('test run --local — the tunnel dying mid-run', () => {
  it('keeps a terminal passed result when tunnel loss is recorded on the same tick', async () => {
    const port = 5173;
    const calls: Call[] = [];
    const target = `http://127.0.0.1:${port}`;
    const tunnel = fakeTunnel();

    const result = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_xyz',
        localPort: port,
        localHost: '127.0.0.1',
        wait: true,
        timeoutSeconds: 30,
        skipPreflight: true,
      },
      {
        ...makeCreds(),
        fetchImpl: makeRecordingFetch({
          calls,
          targetUrl: target,
          run: () => {
            tunnel.emitAuthFailure();
            return passedRun(target);
          },
        }),
        stderr: () => {},
        stdout: () => {},
        sleep: async () => {},
        createTunnelClient: tunnel.factory,
      },
    );

    expect(result.status).toBe('passed');
    expect(calls.some(call => call.url.includes('/cancel'))).toBe(false);
  });

  it('stops the run instead of polling a doomed run to its timeout', async () => {
    const port = 5173;
    const calls: Call[] = [];
    const lines: string[] = [];
    const target = `http://127.0.0.1:${port}`;
    const tunnel = fakeTunnel();
    let ticks = 0;
    let thrown: unknown;
    try {
      await runTestRun(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_xyz',
          localPort: port,
          localHost: '127.0.0.1',
          wait: true,
          timeoutSeconds: 600,
          skipPreflight: true,
        },
        {
          ...makeCreds(),
          fetchImpl: makeRecordingFetch({
            calls,
            targetUrl: target,
            run: () => {
              ticks += 1;
              if (ticks === 2) tunnel.emitAuthFailure();
              // Hard stop so a regression fails in a second instead of
              // spinning out the whole --timeout budget: a poll loop that
              // ignores a dead tunnel would otherwise HANG this suite rather
              // than turn it red, and a hang reads as flake, not as a bug.
              if (ticks > 20) throw new Error('poll kept going after the tunnel died');
              return { ...passedRun(target), status: 'running' };
            },
          }),
          stderr: line => lines.push(line),
          stdout: line => lines.push(line),
          sleep: async () => {},
          createTunnelClient: tunnel.factory,
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    // UNAVAILABLE (exit 10, "retry the command"), not a run failure: the test
    // did not fail, the transport under it did.
    expect((thrown as ApiError).code).toBe('UNAVAILABLE');
    expect(ticks).toBeLessThan(10);
    // A remint is impossible (the run's proxy string names the OLD clientId),
    // so exactly one mint must have happened — never a second.
    expect(calls.filter(c => c.method === 'POST' && c.url.endsWith('/tunnel')).length).toBe(1);
    expect(calls.some(c => c.method === 'POST' && c.url.includes('/cancel'))).toBe(true);
    expect(lines.join('\n')).toMatch(/redeploy|disconnected/i);
  });
});

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

describe('test run --local --dry-run', () => {
  it('makes zero network calls and never constructs a tunnel client', async () => {
    const fetchImpl = vi.fn();
    const tunnel = fakeTunnel();
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        testId: 'test_xyz',
        localPort: 5173,
        localHost: '127.0.0.1',
        wait: true,
        timeoutSeconds: 30,
      },
      {
        ...makeCreds(),
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
        stderr: () => {},
        stdout: () => {},
        sleep: async () => {},
        createTunnelClient: tunnel.factory,
      },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(tunnel.calls.start).toBe(0);
  });
});
