import { resultLine } from '../../test/helpers/result-list.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, RequestTimeoutError } from './errors.js';
import { HttpClient } from './http.js';
import { ShutdownController } from './interrupt.js';
import { assertLocalPortListening, parseLoopbackTargetUrl } from './local-target.js';
import {
  ENVIRONMENT_PREFLIGHT_TIMEOUT_MS,
  readEnvironmentPreflight,
  resolveEnvironmentRunTarget,
  withEnvironmentTunnel,
} from './environment-tunnel.js';
import { terminalSafeWriter } from './terminal-text.js';

function resolver(environments: unknown) {
  const get = vi.fn(async () => ({ environments }));
  const stderr = vi.fn();
  return {
    get,
    stderr,
    args: {
      client: { get } as unknown as Pick<HttpClient, 'get'>,
      knownTest: { type: 'frontend' as const, projectId: 'P' },
      stderr,
    },
  };
}

describe('a line that names an environment', () => {
  // A server name with a line break: printed as it came, the text after the
  // break would start a line that reads like one of the CLI's own.
  const name = 'stg\nforged: line';
  const announced = async (
    environment: { name: string; url: string },
    more: Record<string, unknown>,
  ): Promise<string[]> => {
    const f = resolver([{ ...environment, isDefault: true }]);
    const lines: string[] = [];
    await resolveEnvironmentRunTarget({
      ...f.args,
      stderr: terminalSafeWriter(line => lines.push(line)),
      ...more,
    });
    return lines.flatMap(line => line.split('\n'));
  };

  it('keeps the name on the line that opens a tunnel', async () => {
    const local = { name, url: 'http://localhost:3000' };
    expect(await announced(local, {})).toEqual([
      'Environment "stg forged: line" is on this machine (http://localhost:3000) — opening a tunnel.',
    ]);
    expect(await announced(local, { dryRun: true })).toEqual([
      'Would open a tunnel to http://localhost:3000 (environment "stg forged: line").',
    ]);
  });

  it('says nothing for a run aimed at an address of its own (a CI preview)', async () => {
    const local = { name, url: 'http://localhost:3000' };
    expect(await announced(local, { targetUrl: 'https://preview.example' })).toEqual([]);
  });
});

describe('environment preflight and diagnostics', () => {
  it('bounds advisory reads to five seconds without retries', async () => {
    const get = vi.fn(async (_path, options) => {
      expect(options.retry).toBe(false);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return {};
    });
    await readEnvironmentPreflight({ get } as unknown as Pick<HttpClient, 'get'>, '/tests/a');
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('classifies a stalled preflight read as REQUEST_TIMEOUT (exit 7), not a raw abort', async () => {
    vi.useFakeTimers();
    try {
      const get = vi.fn((_path: string, options: { signal: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason));
        });
      });
      const promise = readEnvironmentPreflight(
        { get } as unknown as Pick<HttpClient, 'get'>,
        '/tests/a',
      );
      const assertion = expect(promise).rejects.toBeInstanceOf(RequestTimeoutError);
      await vi.advanceTimersByTimeAsync(ENVIRONMENT_PREFLIGHT_TIMEOUT_MS);
      await assertion;
      const err = (await promise.catch(e => e)) as RequestTimeoutError;
      expect(err.code).toBe('REQUEST_TIMEOUT');
      expect(err.exitCode).toBe(7);
      expect(err.timeoutMs).toBe(ENVIRONMENT_PREFLIGHT_TIMEOUT_MS);
      // The 5s preflight deadline is fixed; the guidance must name the
      // preflight read and never point at --request-timeout, which does
      // not govern it.
      expect(err.message).toContain('Environment preflight read timed out');
      expect(err.message).not.toContain('--request-timeout');
      expect(err.nextAction).toContain('environment preflight read');
      expect(err.nextAction).not.toContain('--request-timeout');
    } finally {
      vi.useRealTimers();
    }
  });
  it('passes the preflight REQUEST_TIMEOUT through a real HttpClient untouched', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      });
      const client = new HttpClient({
        baseUrl: 'https://api.example.com/api/cli/v1',
        apiKey: '<redacted>',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: () => Promise.resolve(),
        random: () => 0,
        requestTimeoutMs: 120_000,
      });
      const promise = readEnvironmentPreflight(client, '/tests/a');
      const assertion = expect(promise).rejects.toBeInstanceOf(RequestTimeoutError);
      await vi.advanceTimersByTimeAsync(ENVIRONMENT_PREFLIGHT_TIMEOUT_MS);
      await assertion;
      const err = (await promise.catch(e => e)) as RequestTimeoutError;
      expect(err.code).toBe('REQUEST_TIMEOUT');
      expect(err.exitCode).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });
  it('falls back after a failed test read without reading environments', async () => {
    const get = vi.fn(async (_path: string, _options: unknown) => {
      throw new Error('unavailable');
    });
    expect(
      await resolveEnvironmentRunTarget({
        client: { get } as unknown as Pick<HttpClient, 'get'>,
        testId: 'a',
        stderr: vi.fn(),
      }),
    ).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[1]).toMatchObject({ retry: false, signal: expect.any(AbortSignal) });
  });
  it('deduplicates no-wait hints by environment', async () => {
    const f = resolver([{ name: 'dev', url: 'http://localhost:3000', isDefault: true }]);
    const cache = new Map();
    await resolveEnvironmentRunTarget({ ...f.args, cache, noWait: true });
    await resolveEnvironmentRunTarget({ ...f.args, cache, noWait: true });
    expect(f.stderr).toHaveBeenCalledTimes(1);
    expect(f.get).toHaveBeenCalledTimes(1);
  });
  it('describes an automatic dry-run tunnel without minting', async () => {
    const f = resolver([{ name: 'dev', url: 'http://localhost:3000', isDefault: true }]);
    expect(await resolveEnvironmentRunTarget({ ...f.args, dryRun: true })).toMatchObject({
      targetUrl: 'http://localhost:3000',
      automatic: true,
    });
    expect(f.stderr).toHaveBeenCalledWith(
      'Would open a tunnel to http://localhost:3000 (environment "dev").',
    );
  });
  it('names the environment on automatic port refusal and preserves classification', async () => {
    await expect(
      assertLocalPortListening('localhost', 3000, { environmentName: 'dev' }, vi.fn(), {
        resolveCandidates: async () => [{ host: '127.0.0.1', port: 3000 }],
        connect: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).rejects.toMatchObject({
      exitCode: 5,
      code: 'VALIDATION_ERROR',
      message:
        'Nothing is listening on localhost:3000 (environment "dev"). Start your app or run with --skip-preflight.',
      details: { field: 'local', reason: 'local-port-not-listening' },
    });
  });
  it('keeps the explicit port refusal wording', async () => {
    await expect(
      assertLocalPortListening('127.0.0.1', 3000, {}, vi.fn(), {
        resolveCandidates: async () => [{ host: '127.0.0.1', port: 3000 }],
        connect: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    ).rejects.toMatchObject({
      message:
        'Nothing is listening on 127.0.0.1:3000, so a tunnel run would fail after being billed.',
      nextAction: expect.stringContaining('point the environment at the port'),
    });
  });
  it.each([
    'http://127.1:3000',
    'http://2130706433:3000',
    'http://[0:0:0:0:0:0:0:1]:3000',
    'HTTP://LOCALHOST:3000',
  ])('names accepted canonical forms for %s', url => {
    let error: unknown;
    try {
      parseLoopbackTargetUrl(url);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).nextAction).toContain('http://localhost:<port>');
    expect((error as ApiError).nextAction).toContain('http://127.0.0.1:<port>');
    expect((error as ApiError).nextAction).toContain('http://[::1]:<port>');
  });
});

describe('withEnvironmentTunnel: execution ownership', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const clientId = '11111111-2222-3333-4444-555555555555';
  function harness(options: { adopted?: boolean; cancelledRefund?: boolean } = {}) {
    const calls: string[] = [];
    const stderr: string[] = [];
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const deps = {
      env: { TESTSPRITE_API_KEY: 'sk-user-test', TESTSPRITE_API_URL: 'https://api.example.com' },
      stderr: (line: string) => {
        stderr.push(line);
      },
      shutdown: new ShutdownController(),
      createTunnelClient: () => ({ start: async () => {}, stop: async () => {} }),
      fetchImpl: async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        const path = url.pathname.replace('/api/cli/v1', '');
        calls.push(`${init.method ?? 'GET'} ${path}`);
        if (init.method === 'POST' && path === '/tunnel')
          return json(
            {
              clientId,
              secret: 'fixture-secret',
              controlUrl: 'ws://tunnel.example/ws',
              tunnelAddr: 'tunnel.example:7400',
              expiresAt: '2026-11-15T00:00:00Z',
            },
            201,
          );
        if (init.method === 'DELETE') return new Response(null, { status: 204 });
        if (init.method === 'POST' && path === '/runs/exec_a/cancel')
          return json({
            runId: 'exec_a',
            alreadyCancelled: false,
            alreadyFinished: false,
            results: [
              {
                runId: 'exec_a',
                resultId: 'result_a',
                testId: 'test_a',
                title: 'Test',
                status: 'cancelled',
                alreadyCancelled: false,
                alreadyFinished: false,
                refund: { status: options.cancelledRefund ? 'failed' : 'refunded' },
              },
            ],
          });
        if (path === `/tunnel/${clientId}`)
          return json({ clientId, status: 'online', expiresAt: '2026-11-15T00:00:00Z' });
        throw new Error(`Unexpected request: ${init.method ?? 'GET'} ${path}`);
      },
    };
    const opts = {
      profile: 'default',
      output: 'json' as const,
      debug: false,
      maxConcurrency: 1,
      timeoutSeconds: 30,
      ...(options.adopted ? { tunnelClientId: clientId } : {}),
    };
    return { calls, stderr, deps, opts };
  }
  it.each(['UNAVAILABLE', 'UNSUPPORTED'] as const)(
    'cleans up the owned execution once after %s without rewriting its error',
    async code => {
      const h = harness();
      const failure = new ApiError(
        {
          code,
          message: 'Original backend message.',
          nextAction: 'Original backend next action.',
          requestId: 'req-original',
          details: { opaque: 'value' },
        },
        code === 'UNAVAILABLE' ? 503 : undefined,
      );
      await expect(
        withEnvironmentTunnel(h.opts, h.deps, [], 'run', async context => {
          await context.confirm({ tunnelClientId: clientId }, ['exec_a']);
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(failure).toMatchObject({
        message: 'Original backend message.',
        nextAction: 'Original backend next action.',
        details: { opaque: 'value' },
      });
      expect(h.calls.filter(call => call.endsWith('/cancel'))).toEqual([
        'POST /runs/exec_a/cancel',
      ]);
      expect(h.calls.at(-1)).toBe(`DELETE /tunnel/${clientId}`);
    },
  );
  it('does not release ownership just because the current results have all passed', async () => {
    const h = harness();
    await withEnvironmentTunnel(h.opts, h.deps, [], 'run', async context => {
      await context.confirm({ tunnelClientId: clientId }, ['exec_a']);
      await context.onRead(
        {
          run: {
            runId: 'exec_a',
            projectId: 'P',
            status: 'running',
            cancelled: false,
            created: null,
            modified: null,
            targetUrl: null,
            dashboardUrl: null,
          },
          results: [resultLine({ runId: 'exec_a', resultId: 'result_a', testStatus: 'PASSED' })],
        },
        new AbortController().signal,
      );
    });
    expect(h.calls.filter(call => call.endsWith('/cancel'))).toEqual(['POST /runs/exec_a/cancel']);
  });
  it('releases ownership only when the execution is finished', async () => {
    const h = harness();
    await withEnvironmentTunnel(h.opts, h.deps, [], 'run', async context => {
      await context.confirm({ tunnelClientId: clientId }, ['exec_a']);
      await context.onRead(
        {
          run: {
            runId: 'exec_a',
            projectId: 'P',
            status: 'finished',
            cancelled: false,
            created: null,
            modified: null,
            targetUrl: null,
            dashboardUrl: null,
          },
          results: [],
        },
        new AbortController().signal,
      );
    });
    expect(h.calls.some(call => call.endsWith('/cancel'))).toBe(false);
  });
  it('never cancels or deletes a live adopted tunnel on detach', async () => {
    const h = harness({ adopted: true });
    await withEnvironmentTunnel(h.opts, h.deps, [], 'run', async context => {
      await context.confirm({ tunnelClientId: clientId }, ['exec_a']);
    });
    expect(h.calls).toEqual([]);
  });
  it('cancels an unconfirmed started execution before closing the owned tunnel', async () => {
    const h = harness();
    await expect(
      withEnvironmentTunnel(h.opts, h.deps, [], 'run', context => context.confirm({}, ['exec_a'])),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED', exitCode: 7 });
    expect(h.calls.filter(call => call.endsWith('/cancel'))).toEqual(['POST /runs/exec_a/cancel']);
  });
  it('keeps cancellation cleanup independent from the interrupted process signal', async () => {
    const h = harness();
    await expect(
      withEnvironmentTunnel(h.opts, h.deps, [], 'run', async context => {
        await context.confirm({ tunnelClientId: clientId }, ['exec_a']);
        h.deps.shutdown.interrupt('SIGINT');
        throw h.deps.shutdown.signal.reason;
      }),
    ).rejects.toMatchObject({ exitCode: 130 });
    expect(h.calls.filter(call => call.endsWith('/cancel'))).toEqual(['POST /runs/exec_a/cancel']);
    expect(h.calls.at(-1)).toBe(`DELETE /tunnel/${clientId}`);
  });
  it('respects the explicit cancellation opt-out while closing its owned tunnel', async () => {
    const h = harness();
    await withEnvironmentTunnel(
      { ...h.opts, cancelOnInterrupt: false },
      h.deps,
      [],
      'run',
      async context => {
        await context.confirm({ tunnelClientId: clientId }, ['exec_a']);
      },
    );
    expect(h.calls.some(call => call.endsWith('/cancel'))).toBe(false);
    expect(h.calls.at(-1)).toBe(`DELETE /tunnel/${clientId}`);
  });
});
