import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, RequestTimeoutError } from './errors.js';
import { HttpClient } from './http.js';
import { ShutdownController } from './interrupt.js';
import { assertLocalPortListening, parseLoopbackTargetUrl } from './local-target.js';
import { UnreachableAtDeadlineError } from './poll.js';
import {
  ENVIRONMENT_PREFLIGHT_TIMEOUT_MS,
  readEnvironmentPreflight,
  resolveEnvironmentRunTarget,
  withEnvironmentTunnel,
} from './environment-tunnel.js';

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
  it('uses localhost after a successful empty environment list', async () => {
    const f = resolver([]);
    expect(await resolveEnvironmentRunTarget({ ...f.args, localPort: 3000 })).toMatchObject({
      targetUrl: 'http://localhost:3000',
    });
  });
  it('does not use temporary environments to choose a shorthand host', async () => {
    const f = resolver([{ name: 'preview', url: 'http://127.0.0.1:3000', isTemporary: true }]);
    expect(await resolveEnvironmentRunTarget({ ...f.args, localPort: 3000 })).toMatchObject({
      targetUrl: 'http://localhost:3000',
    });
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
  it('keeps explicit local port refusal wording', async () => {
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
      nextAction: expect.stringContaining('point --local'),
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

describe('withEnvironmentTunnel: waiting for batch capacity', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exits 10 with the owned-tunnel hint when the API stays unreachable until the deadline', async () => {
    vi.useFakeTimers();
    const tunnelClientId = '11111111-2222-3333-4444-555555555555';
    const credentialsPath = join(
      mkdtempSync(join(tmpdir(), 'env-tunnel-capacity-')),
      'credentials',
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture-owned temporary file.
    writeFileSync(
      credentialsPath,
      '[default]\napi_url = https://api.example.com\napi_key = sk-user-test\n',
    );
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      const parsed = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const path = parsed.pathname.replace('/api/cli/v1', '');
      const method = init.method ?? 'GET';
      requests.push(`${method} ${path}`);
      if (method === 'POST' && path === '/tunnel')
        return json(
          {
            clientId: tunnelClientId,
            secret: 'fixture-secret',
            controlUrl: 'ws://tunnel.example/ws',
            tunnelAddr: 'tunnel.example:7400',
            expiresAt: '2026-10-02T00:00:00Z',
          },
          201,
        );
      if (method === 'DELETE' && path === `/tunnel/${tunnelClientId}`)
        return new Response(null, { status: 204 });
      if (method === 'POST' && path === '/runs/run_a/cancel')
        return json({ runId: 'run_a', status: 'cancelled', alreadyCancelled: false });
      // Every read of the run that holds the slot fails: the API is unreachable.
      if (method === 'GET' && path === '/runs/run_a')
        return json(
          {
            error: {
              code: 'UNAVAILABLE',
              message: 'poll backend unavailable',
              nextAction: 'retry',
              requestId: 'r-unavailable',
              details: {},
            },
          },
          503,
        );
      throw new Error(`unexpected request: ${method} ${path}`);
    });

    const pending = withEnvironmentTunnel(
      { profile: 'default', output: 'json', debug: false, maxConcurrency: 1, timeoutSeconds: 30 },
      {
        credentialsPath,
        fetchImpl,
        stderr: () => {},
        shutdown: new ShutdownController(),
        createTunnelClient: () => ({ start: async () => {}, stop: async () => {} }),
      },
      [],
      'test run',
      async context => {
        await context.confirm({ tunnelClientId: context.clientId }, ['run_a']);
        // One slot, held by run_a: the next dispatch waits for it to finish.
        await context.waitForCapacity(1);
      },
    ).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const { error } = await pending;

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(UnreachableAtDeadlineError);
    expect(error).toMatchObject({
      code: 'UNAVAILABLE',
      exitCode: 10,
      requestId: 'r-unavailable',
      details: { runId: 'run_a' },
    });
    const thrown = error as ApiError;
    expect(thrown.message).toContain('poll backend unavailable');
    // The tunnel closes with this process, so the hint is the owned-tunnel one,
    // never a re-attach with `test wait`.
    expect(thrown.nextAction).toBe(
      'The owned tunnel is closing; inspect cancellation with testsprite test cancel run_a.',
    );
    expect(requests).toContain('POST /runs/run_a/cancel');
  });
});
