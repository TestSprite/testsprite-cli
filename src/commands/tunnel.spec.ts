import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/errors.js';
import { writeProfile } from '../lib/credentials.js';
import { ShutdownController } from '../lib/interrupt.js';
import { ErrCode } from '../vendor/tunnel-client/index.js';
import type { TunnelClientOptions } from '../vendor/tunnel-client/index.js';
import { createTunnelCommand, runTunnelStart, runTunnelStatus, runTunnelStop } from './tunnel.js';

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function makeCreds(): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-tunnel-cmd-'));
  const credentialsPath = join(dir, 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- creates this suite's own mkdtempSync temp dir, never user input
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- writes the fixture credentials body into this suite's own mkdtempSync temp dir, never user input
  writeFileSync(
    credentialsPath,
    '[default]\napi_url = http://localhost:13502\napi_key = sk-user-test\n',
    { mode: 0o600 },
  );
  return { credentialsPath };
}

const MINT_BODY = {
  clientId: 'c-1111',
  secret: 'secret-never-printed-4a7b',
  controlUrl: 'ws://tunnel.example:7300/ws',
  tunnelAddr: 'tunnel.example:7400',
  tunnelTlsAddr: 'data.tun.testsprite.com:443',
  expiresAt: '2026-08-24T18:00:00.000Z',
};
const PLAINTEXT_MINT_BODY = {
  clientId: MINT_BODY.clientId,
  secret: MINT_BODY.secret,
  controlUrl: MINT_BODY.controlUrl,
  tunnelAddr: MINT_BODY.tunnelAddr,
  expiresAt: MINT_BODY.expiresAt,
};
const VALID_CLIENT_ID = 'cf6e0843-9166-4eaa-918e-f085407eaca5';
const INVALID_CLIENT_ID_MESSAGE =
  "Tunnel client id must be a UUID (see 'testsprite tunnel status'/'tunnel start' output).";

function makeFetch(
  handler: (
    method: string,
    url: string,
  ) => { status?: number; body?: unknown; headers?: Record<string, string> },
): typeof globalThis.fetch {
  return (async (input: FetchInput, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const { status = 200, body, headers } = handler(method, url);
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as typeof globalThis.fetch;
}

function fakeTunnel() {
  let captured: TunnelClientOptions | undefined;
  const calls = { start: 0, stop: 0 };
  return {
    calls,
    emitAuthFailure: (message = 'auth failed') =>
      captured?.onError?.({ code: ErrCode.AuthFailed, message }),
    emitDataPlaneFailure: (message: string) =>
      captured?.onError?.({ code: ErrCode.DataPlaneUnreachable, message }),
    seen: () => captured,
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

describe('tunnel start', () => {
  it('reports a credential revoked during authentication as exit 10', async () => {
    const methods: string[] = [];
    const stdout: string[] = [];
    const stopped = vi.fn(async () => {});
    const error = await runTunnelStart(
      { profile: 'default', output: 'json', debug: false },
      {
        ...makeCreds(),
        fetchImpl: makeFetch(method => {
          methods.push(method);
          return method === 'POST' ? { status: 201, body: MINT_BODY } : { status: 204 };
        }),
        shutdown: new ShutdownController(),
        stdout: line => stdout.push(line),
        stderr: () => {},
        createTunnelClient: options => ({
          start: async () => {
            options.onError?.({ code: ErrCode.AuthFailed, message: 'tunnel credential revoked' });
            throw new Error('Control websocket closed before authentication was acknowledged');
          },
          stop: stopped,
        }),
      },
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      exitCode: 10,
      message: 'Tunnel credential c-1111 was revoked, expired, or taken over by another process.',
      details: { reason: 'credential-revoked' },
    });
    expect(stdout).toEqual([]);
    expect(methods).toEqual(['POST', 'DELETE']);
    expect(stopped).toHaveBeenCalledOnce();
  });

  it('is armed before mint and treats Ctrl-C during connect as a clean stop', async () => {
    const shutdown = new ShutdownController();
    const armedStates: Array<{ phase: string; armed: boolean; critical: boolean }> = [];
    const seen: string[] = [];
    let rejectStart: ((reason: Error) => void) | undefined;
    let markStartEntered: (() => void) | undefined;
    const startEntered = new Promise<void>(resolve => {
      markStartEntered = resolve;
    });

    const promise = runTunnelStart(
      { profile: 'default', output: 'text', debug: false },
      {
        ...makeCreds(),
        fetchImpl: makeFetch((method, url) => {
          seen.push(`${method} ${url}`);
          armedStates.push({
            phase: method === 'POST' ? 'mint' : 'delete',
            armed: shutdown.isArmed,
            critical: shutdown.hasCriticalOperations,
          });
          if (method === 'POST') return { status: 201, body: MINT_BODY };
          return { status: 204 };
        }),
        stdout: () => {},
        stderr: () => {},
        shutdown,
        createTunnelClient: () => ({
          start: () =>
            new Promise<void>((_resolve, reject) => {
              rejectStart = reject;
              armedStates.push({
                phase: 'connect',
                armed: shutdown.isArmed,
                critical: shutdown.hasCriticalOperations,
              });
              markStartEntered?.();
            }),
          stop: async () => {
            rejectStart?.(new Error('connect stopped'));
          },
        }),
      },
    );

    await startEntered;
    shutdown.interrupt('SIGINT');
    // Unblock the pre-fix implementation too, so its failure is immediate
    // rather than the tunnel session's 20-second connect timeout.
    rejectStart?.(new Error('connect interrupted'));

    await expect(promise).resolves.toBeUndefined();
    expect(armedStates).toEqual([
      { phase: 'mint', armed: true, critical: false },
      { phase: 'connect', armed: true, critical: false },
      { phase: 'delete', armed: true, critical: true },
    ]);
    expect(seen.filter(call => call.startsWith('DELETE'))).toHaveLength(1);
    expect(shutdown.isArmed).toBe(false);
  });

  it('prints the client id and NEVER the secret, then tears down on Ctrl-C', async () => {
    const lines: string[] = [];
    const shutdown = new ShutdownController();
    const seen: string[] = [];
    const tunnel = fakeTunnel();

    const promise = runTunnelStart(
      { profile: 'default', output: 'text', debug: false },
      {
        ...makeCreds(),
        fetchImpl: makeFetch((method, url) => {
          seen.push(`${method} ${url}`);
          if (method === 'POST') return { status: 201, body: MINT_BODY };
          return { status: 204 };
        }),
        stdout: line => lines.push(line),
        stderr: line => lines.push(line),
        shutdown,
        createTunnelClient: tunnel.factory,
      },
    );
    // Give the mint + connect a turn, then interrupt as a user would.
    await new Promise(resolve => setTimeout(resolve, 5));
    shutdown.interrupt('SIGINT');
    await promise;

    const text = lines.join('\n');
    expect(text).toContain('c-1111');
    expect(text).toContain('transport   tls');
    expect(text).toContain(
      "Stop it: press Ctrl-C here, or run 'testsprite tunnel stop c-1111' from another terminal",
    );
    expect(text).not.toContain(MINT_BODY.secret);
    expect(seen.some(call => call.startsWith('DELETE'))).toBe(true);
    expect(tunnel.calls.stop).toBe(1);
  });

  it('reports plaintext in the JSON receipt for an old backend', async () => {
    const stdout: string[] = [];
    const shutdown = new ShutdownController();
    const tunnel = fakeTunnel();
    const promise = runTunnelStart(
      { profile: 'default', output: 'json', debug: false },
      {
        ...makeCreds(),
        fetchImpl: makeFetch(method =>
          method === 'POST' ? { status: 201, body: PLAINTEXT_MINT_BODY } : { status: 204 },
        ),
        stdout: line => stdout.push(line),
        stderr: () => {},
        shutdown,
        createTunnelClient: tunnel.factory,
      },
    );
    await new Promise(resolve => setTimeout(resolve, 5));
    shutdown.interrupt('SIGINT');
    await promise;

    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toEqual({
      clientId: PLAINTEXT_MINT_BODY.clientId,
      expiresAt: PLAINTEXT_MINT_BODY.expiresAt,
      status: 'online',
      transport: 'plaintext',
    });
  });

  it('retries one transient rate-limited cleanup DELETE and removes the binding', async () => {
    vi.useFakeTimers();
    try {
      const shutdown = new ShutdownController();
      const tunnel = fakeTunnel();
      let deleteCalls = 0;
      const promise = runTunnelStart(
        { profile: 'default', output: 'text', debug: false },
        {
          ...makeCreds(),
          fetchImpl: makeFetch((method, url) => {
            if (method === 'POST' && url.endsWith('/tunnel')) {
              return { status: 201, body: MINT_BODY };
            }
            deleteCalls += 1;
            return deleteCalls === 1
              ? {
                  status: 429,
                  headers: { 'retry-after': '1' },
                  body: {
                    error: {
                      code: 'RATE_LIMITED',
                      message: 'slow down',
                      nextAction: 'retry later',
                      requestId: 'r-delete-rate',
                      details: {},
                    },
                  },
                }
              : {
                  status: 204,
                  body: undefined,
                };
          }),
          stdout: () => {},
          stderr: () => {},
          shutdown,
          createTunnelClient: tunnel.factory,
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      shutdown.interrupt('SIGINT');
      await vi.advanceTimersByTimeAsync(1_000);
      await promise;

      expect(deleteCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the entire cleanup DELETE retry chain to one 10 second deadline', async () => {
    vi.useFakeTimers();
    let pending: Promise<void> | undefined;
    try {
      const shutdown = new ShutdownController();
      let deleteCalls = 0;
      let markStarted!: () => void;
      const started = new Promise<void>(resolve => {
        markStarted = resolve;
      });
      const fetchImpl = (async (input: FetchInput, init: RequestInit = {}) => {
        const url = String(input);
        const method = (init.method ?? 'GET').toUpperCase();
        if (method === 'POST' && url.endsWith('/tunnel')) {
          return new Response(JSON.stringify(MINT_BODY), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        deleteCalls += 1;
        return new Promise<Response>((resolve, reject) => {
          setTimeout(
            () =>
              resolve(
                new Response(
                  JSON.stringify({
                    error: {
                      code: 'UNAVAILABLE',
                      message: 'delete unavailable',
                      nextAction: 'retry',
                      requestId: 'r-delete-unavailable',
                      details: {},
                    },
                  }),
                  { status: 503, headers: { 'content-type': 'application/json' } },
                ),
              ),
            3_400,
          );
          const signal = init.signal;
          const rejectOnAbort = (): void =>
            reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
          if (signal?.aborted) rejectOnAbort();
          else signal?.addEventListener('abort', rejectOnAbort, { once: true });
        });
      }) as typeof globalThis.fetch;

      pending = runTunnelStart(
        { profile: 'default', output: 'text', debug: false },
        {
          ...makeCreds(),
          fetchImpl,
          stdout: () => {},
          stderr: () => {},
          shutdown,
          createTunnelClient: () => ({
            start: async () => {
              markStarted();
            },
            stop: async () => {},
          }),
        },
      );
      await started;
      shutdown.interrupt('SIGINT');

      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await pending;
      expect(deleteCalls).toBeGreaterThan(1);
      expect(deleteCalls).toBeLessThan(4);
    } finally {
      await vi.runAllTimersAsync();
      await pending?.catch(() => {});
      vi.useRealTimers();
    }
  });

  it('exits with UNAVAILABLE when the tunnel service disconnects it', async () => {
    const shutdown = new ShutdownController();
    const tunnel = fakeTunnel();
    const promise = runTunnelStart(
      { profile: 'default', output: 'text', debug: false },
      {
        ...makeCreds(),
        fetchImpl: makeFetch(method =>
          method === 'POST' ? { status: 201, body: MINT_BODY } : { status: 204 },
        ),
        stdout: () => {},
        stderr: () => {},
        shutdown,
        createTunnelClient: tunnel.factory,
      },
    );
    await new Promise(resolve => setTimeout(resolve, 5));
    tunnel.emitAuthFailure();
    await expect(promise).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(tunnel.calls.stop).toBe(1);
  });

  it('exits 10 with TLS remediation after the data plane retry window expires', async () => {
    const shutdown = new ShutdownController();
    const tunnel = fakeTunnel();
    const promise = runTunnelStart(
      { profile: 'default', output: 'text', debug: false },
      {
        ...makeCreds(),
        fetchImpl: makeFetch(method =>
          method === 'POST' ? { status: 201, body: MINT_BODY } : { status: 204 },
        ),
        stdout: () => {},
        stderr: () => {},
        shutdown,
        createTunnelClient: tunnel.factory,
      },
    );
    await new Promise(resolve => setTimeout(resolve, 5));
    tunnel.emitDataPlaneFailure(
      'Data plane tls at data.tun.testsprite.com:443 is unreachable after 60000ms: ' +
        'unable to verify the first certificate',
    );

    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    if (!settled) shutdown.interrupt('SIGINT');
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'UNAVAILABLE',
      exitCode: 10,
      details: { reason: 'data-plane-unreachable', clientId: MINT_BODY.clientId },
    });
    expect((error as Error).message).toContain('data.tun.testsprite.com:443');
    expect((error as Error).message).toContain('could not be established for 60s');
    expect((error as Error).message).toContain(
      'last error: unable to verify the first certificate',
    );
    expect((error as Error).message).toContain('NODE_EXTRA_CA_CERTS');
    expect((error as ApiError).nextAction).toMatch(/network.*fixed|fix.*network/i);
    expect(tunnel.seen()?.dataPlaneRetryDeadlineMs).toBe(60_000);
    expect(tunnel.calls.stop).toBe(1);
  });

  it('exits 10 with plaintext self-hosted remediation and no TLS advice', async () => {
    const shutdown = new ShutdownController();
    const tunnel = fakeTunnel();
    const promise = runTunnelStart(
      { profile: 'default', output: 'text', debug: false },
      {
        ...makeCreds(),
        fetchImpl: makeFetch(method =>
          method === 'POST' ? { status: 201, body: PLAINTEXT_MINT_BODY } : { status: 204 },
        ),
        stdout: () => {},
        stderr: () => {},
        shutdown,
        createTunnelClient: tunnel.factory,
      },
    );
    await new Promise(resolve => setTimeout(resolve, 5));
    tunnel.emitDataPlaneFailure(
      'Data plane plaintext at tunnel.example:7400 is unreachable after 60000ms: ECONNREFUSED',
    );

    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    if (!settled) shutdown.interrupt('SIGINT');
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'UNAVAILABLE',
      exitCode: 10,
      details: { reason: 'data-plane-unreachable', clientId: PLAINTEXT_MINT_BODY.clientId },
    });
    expect((error as Error).message).toContain('tunnel.example:7400');
    expect((error as Error).message).toMatch(/self-hosted tunnel service/i);
    expect((error as Error).message).toMatch(/egress firewall/i);
    expect((error as Error).message).not.toContain('NODE_EXTRA_CA_CERTS');
    expect((error as Error).message).not.toContain('port 443');
    expect((error as ApiError).nextAction).toContain('tunnel.example:7400');
    expect((error as ApiError).nextAction).toMatch(/self-hosted tunnel service/i);
    expect((error as ApiError).nextAction).toMatch(/egress firewall/i);
    expect((error as ApiError).nextAction).not.toContain('TLS');
    expect((error as ApiError).nextAction).not.toContain('NODE_EXTRA_CA_CERTS');
    expect(tunnel.calls.stop).toBe(1);
  });
});

describe('tunnel start credential observation', () => {
  it.each(['poll', 'cleanup'] as const)(
    'uses the original profile endpoint and API key for %s after a profile change during connect',
    async phase => {
      vi.useFakeTimers();
      const shutdown = new ShutdownController();
      const { credentialsPath } = makeCreds();
      const requests: Array<{ method: string; url: string; apiKey: string | null }> = [];
      const stderr: string[] = [];
      let settled = false;
      let error: unknown;
      const stop = vi.fn(async () => {});
      const done = runTunnelStart(
        { profile: 'default', output: 'json', debug: false },
        {
          credentialsPath,
          env: {},
          shutdown,
          stdout: () => {},
          stderr: line => stderr.push(line),
          fetchImpl: async (input, init = {}) => {
            const request = {
              method: init.method ?? 'GET',
              url: String(input),
              apiKey: new Headers(init.headers).get('x-api-key'),
            };
            requests.push(request);
            if (request.method === 'POST')
              return new Response(JSON.stringify(MINT_BODY), { status: 201 });
            if (request.method === 'DELETE') return new Response(null, { status: 204 });
            return request.apiKey === 'sk-user-test' &&
              request.url.startsWith('http://localhost:13502/')
              ? new Response(JSON.stringify({ ...MINT_BODY, status: 'online' }))
              : new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 });
          },
          createTunnelClient: () => ({
            start: async () => {
              // Another setup replaces this profile while the tunnel is connecting.
              writeProfile(
                'default',
                { apiKey: 'sk-user-other-owner', apiUrl: 'https://other-api.example.com' },
                { path: credentialsPath },
              );
            },
            stop,
          }),
        },
      ).then(
        () => {
          settled = true;
        },
        caught => {
          settled = true;
          error = caught;
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(requests).toEqual([
          {
            method: 'POST',
            url: 'http://localhost:13502/api/cli/v1/tunnel',
            apiKey: 'sk-user-test',
          },
        ]);
        if (phase === 'poll') {
          await vi.advanceTimersByTimeAsync(15_000);
          expect(requests.filter(request => request.method === 'GET')).toEqual([
            {
              method: 'GET',
              url: `http://localhost:13502/api/cli/v1/tunnel/${MINT_BODY.clientId}`,
              apiKey: 'sk-user-test',
            },
          ]);
          expect(settled).toBe(false);
          expect(stop).not.toHaveBeenCalled();
          expect(stderr.join('\n')).not.toContain('revoked');
        }
        shutdown.interrupt('SIGINT');
        await vi.advanceTimersByTimeAsync(0);
        await done;
        expect(error).toBeUndefined();
        expect(requests.filter(request => request.method === 'DELETE')).toEqual([
          {
            method: 'DELETE',
            url: `http://localhost:13502/api/cli/v1/tunnel/${MINT_BODY.clientId}`,
            apiKey: 'sk-user-test',
          },
        ]);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        shutdown.interrupt('SIGINT');
        await vi.advanceTimersByTimeAsync(0);
        await done;
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  function holdTunnel(observe: typeof globalThis.fetch) {
    const shutdown = new ShutdownController();
    const tunnel = fakeTunnel();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const reads: number[] = [];
    let deletes = 0;
    let settled = false;
    let error: unknown;
    const fetchImpl: typeof globalThis.fetch = async (input, init = {}) => {
      if (init.method === 'POST') {
        return new Response(JSON.stringify(MINT_BODY), { status: 201 });
      }
      expect(String(input)).toBe(`http://localhost:13502/api/cli/v1/tunnel/${MINT_BODY.clientId}`);
      if (init.method === 'DELETE') {
        deletes += 1;
        return new Response(null, { status: 204 });
      }
      expect(init.method).toBe('GET');
      reads.push(Date.now());
      return observe(input, init);
    };
    const done = runTunnelStart(
      { profile: 'default', output: 'json', debug: false },
      {
        ...makeCreds(),
        shutdown,
        createTunnelClient: tunnel.factory,
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: line => stderr.push(line),
      },
    ).then(
      () => {
        settled = true;
      },
      caught => {
        settled = true;
        error = caught;
      },
    );
    return {
      shutdown,
      tunnel,
      stdout,
      stderr,
      reads,
      done,
      get deletes() {
        return deletes;
      },
      get settled() {
        return settled;
      },
      get error() {
        return error;
      },
      async cleanup() {
        shutdown.interrupt('SIGINT');
        await vi.advanceTimersByTimeAsync(0);
        await done;
        vi.useRealTimers();
      },
    };
  }

  it.each(['tunnel credential revoked', 'tunnel connection superseded or credential revoked'])(
    'exits 10 immediately on %s without waiting for the poll',
    async message => {
      vi.useFakeTimers();
      const held = holdTunnel(makeFetch(() => ({ body: { ...MINT_BODY, status: 'online' } })));
      try {
        await vi.advanceTimersByTimeAsync(0);
        held.tunnel.emitAuthFailure(message);
        await vi.advanceTimersByTimeAsync(0);
        expect(held.settled).toBe(true);
        expect(held.error).toMatchObject({
          code: 'UNAVAILABLE',
          exitCode: 10,
          message:
            'Tunnel credential c-1111 was revoked, expired, or taken over by another process.',
          details: { reason: 'credential-revoked' },
        });
        expect(held.stderr).toContain(
          'Tunnel credential c-1111 was revoked, expired, or taken over by another process.',
        );
        expect(held.stdout).toHaveLength(1);
        expect(JSON.parse(held.stdout[0]!)).toEqual({
          clientId: MINT_BODY.clientId,
          expiresAt: MINT_BODY.expiresAt,
          status: 'online',
          transport: 'tls',
        });
        expect(held.deletes).toBe(1);
        expect(held.tunnel.calls.stop).toBe(1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(held.reads).toHaveLength(0);
        expect(held.deletes).toBe(1);
      } finally {
        await held.cleanup();
      }
    },
  );

  it('exits 10 after external deletion with one teardown and a revocation message', async () => {
    vi.useFakeTimers();
    const held = holdTunnel(makeFetch(() => ({ status: 404 })));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(held.stdout).toHaveLength(1);
      expect(JSON.parse(held.stdout[0]!)).toEqual({
        clientId: MINT_BODY.clientId,
        expiresAt: MINT_BODY.expiresAt,
        status: 'online',
        transport: 'tls',
      });
      await vi.advanceTimersByTimeAsync(14_999);
      expect(held.reads).toHaveLength(0);
      expect(held.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(held.settled).toBe(true);
      expect(held.error).toMatchObject({ code: 'UNAVAILABLE', exitCode: 10 });
      expect(held.stderr).toContain(
        'Tunnel credential c-1111 was revoked, expired, or taken over by another process.',
      );
      expect(held.tunnel.calls.stop).toBe(1);
      expect(held.deletes).toBe(1);
      expect(held.shutdown.isArmed).toBe(false);
      held.tunnel.emitAuthFailure();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(held.reads).toHaveLength(1);
      expect(held.deletes).toBe(1);
      expect(held.tunnel.calls.stop).toBe(1);
    } finally {
      await held.cleanup();
    }
  });

  it.each(['503', '429', 'network', '503 with NOT_FOUND'])(
    'keeps holding through %s with one warning per outage and no retry burst',
    async failure => {
      vi.useFakeTimers();
      let recovered = false;
      const held = holdTunnel(
        makeFetch(() => {
          if (recovered) return { body: { ...MINT_BODY, status: 'online' } };
          if (failure === 'network') throw new TypeError('fetch failed');
          return {
            status: failure === '429' ? 429 : 503,
            body: {
              error: { code: failure === '503 with NOT_FOUND' ? 'NOT_FOUND' : 'UNAVAILABLE' },
            },
          };
        }),
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        const startedAt = Date.now();
        await vi.advanceTimersByTimeAsync(45_000);
        expect(held.reads).toEqual([startedAt + 15_000, startedAt + 30_000, startedAt + 45_000]);
        expect(held.settled).toBe(false);
        expect(held.tunnel.calls.stop).toBe(0);
        expect(held.deletes).toBe(0);
        expect(held.stderr).toHaveLength(1);
        expect(held.stderr[0]).toMatch(/could not check.*credential.*continuing/i);
        recovered = true;
        await vi.advanceTimersByTimeAsync(15_000);
        recovered = false;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(held.stderr).toHaveLength(2);
        expect(held.settled).toBe(false);
      } finally {
        await held.cleanup();
      }
    },
  );

  it('keeps an offline credential and preserves clean Ctrl-C without further reads', async () => {
    vi.useFakeTimers();
    const held = holdTunnel(makeFetch(() => ({ body: { ...MINT_BODY, status: 'offline' } })));
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(held.reads).toHaveLength(2);
      expect(held.settled).toBe(false);
      expect(held.stderr).toEqual([]);
      held.shutdown.interrupt('SIGINT');
      await vi.advanceTimersByTimeAsync(0);
      await held.done;
      expect(held.error).toBeUndefined();
      expect(held.tunnel.calls.stop).toBe(1);
      expect(held.deletes).toBe(1);
      expect(held.stderr).toContain('Tunnel c-1111 closed.');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(held.reads).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await held.cleanup();
    }
  });

  it.each(['interrupt', 'auth failure'])('aborts an in-flight observation on %s', async cause => {
    vi.useFakeTimers();
    let aborted = false;
    const held = holdTunnel(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    );
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(held.reads).toHaveLength(1);
      if (cause === 'interrupt') held.shutdown.interrupt('SIGINT');
      else held.tunnel.emitAuthFailure();
      await vi.advanceTimersByTimeAsync(0);
      await held.done;
      expect(aborted).toBe(true);
      if (cause === 'interrupt') expect(held.error).toBeUndefined();
      else expect(held.error).toMatchObject({ code: 'UNAVAILABLE', exitCode: 10 });
      expect(held.tunnel.calls.stop).toBe(1);
      expect(held.deletes).toBe(1);
      expect(held.stderr.join('\n')).not.toMatch(/could not check|revoked/i);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await held.cleanup();
    }
  });

  it('explains that credential revocation stops the foreground owner', () => {
    const command = createTunnelCommand().commands.find(command => command.name() === 'stop');
    const lines: string[] = [];
    command?.configureOutput({ writeOut: line => lines.push(line) });
    command?.outputHelp();
    expect(lines.join('')).toContain('also makes a running `tunnel start` exit within ~15 s');
  });
});

describe('tunnel status', () => {
  it('reports online for a live client', async () => {
    const lines: string[] = [];
    const result = await runTunnelStatus(
      { profile: 'default', output: 'text', debug: false, clientId: VALID_CLIENT_ID },
      {
        ...makeCreds(),
        fetchImpl: makeFetch(() => ({
          body: { clientId: VALID_CLIENT_ID, status: 'online', expiresAt: MINT_BODY.expiresAt },
        })),
        stdout: line => lines.push(line),
        stderr: () => {},
      },
    );
    expect(result.status).toBe('online');
    expect(lines.join('\n')).toContain('online');
  });

  /**
   * The load-bearing one, and the reason `getClientV2` was given a three-state
   * contract in backend-v2.0 #1068: "the tunnel is not connected" and "we could
   * not reach TestSprite to ask" are different answers. Rendering the second as
   * `offline` sends the user to restart a tunnel that was never the problem.
   */
  it('does NOT render an unreachable API as `offline`', async () => {
    const lines: string[] = [];
    let thrown: unknown;
    try {
      await runTunnelStatus(
        { profile: 'default', output: 'text', debug: false, clientId: VALID_CLIENT_ID },
        {
          ...makeCreds(),
          fetchImpl: makeFetch(() => ({
            status: 503,
            body: {
              error: {
                code: 'UNAVAILABLE',
                message: 'upstream down',
                nextAction: 'retry',
                requestId: 'r1',
                details: {},
              },
            },
          })),
          stdout: line => lines.push(line),
          stderr: line => lines.push(line),
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).code).toBe('UNAVAILABLE');
    expect(lines.join('\n')).not.toMatch(/offline/i);
  });

  it('surfaces an unknown or other-tenant id as NOT_FOUND, not as offline', async () => {
    await expect(
      runTunnelStatus(
        { profile: 'default', output: 'text', debug: false, clientId: VALID_CLIENT_ID },
        {
          ...makeCreds(),
          fetchImpl: makeFetch(() => ({
            status: 404,
            body: {
              error: {
                code: 'NOT_FOUND',
                message: 'no such tunnel',
                nextAction: 'check the id',
                requestId: 'r1',
                details: {},
              },
            },
          })),
          stdout: () => {},
          stderr: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', exitCode: 4, httpStatus: 404 });
  });
});

describe('tunnel stop', () => {
  it('deletes the binding and is idempotent', async () => {
    const seen: string[] = [];
    const fetchImpl = makeFetch((method, url) => {
      seen.push(`${method} ${url}`);
      return { status: 204 };
    });
    const lines: string[] = [];
    await runTunnelStop(
      { profile: 'default', output: 'text', debug: false, clientId: VALID_CLIENT_ID },
      { ...makeCreds(), fetchImpl, stdout: line => lines.push(line), stderr: () => {} },
    );
    await runTunnelStop(
      { profile: 'default', output: 'text', debug: false, clientId: VALID_CLIENT_ID },
      { ...makeCreds(), fetchImpl, stdout: () => {}, stderr: () => {} },
    );
    expect(seen.filter(c => c.startsWith('DELETE')).length).toBe(2);
    expect(lines).toEqual([`Tunnel credential ${VALID_CLIENT_ID} revoked (or already absent).`]);
  });

  it('preserves the idempotent JSON result for an uppercase UUID', async () => {
    const clientId = 'CF6E0843-9166-4EAA-918E-F085407EACA5';
    const lines: string[] = [];
    const requests: string[] = [];
    const deps = {
      ...makeCreds(),
      fetchImpl: makeFetch((method, url) => {
        requests.push(`${method} ${url}`);
        return { status: 204 };
      }),
      stdout: (line: string) => lines.push(line),
      stderr: () => {},
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await runTunnelStop({ profile: 'default', output: 'json', debug: false, clientId }, deps);
    }
    expect(lines.map(line => JSON.parse(line))).toEqual([
      { clientId, deleted: true },
      { clientId, deleted: true },
    ]);
    expect(requests).toEqual([
      `DELETE http://localhost:13502/api/cli/v1/tunnel/${clientId}`,
      `DELETE http://localhost:13502/api/cli/v1/tunnel/${clientId}`,
    ]);
  });
});

describe.each([
  { name: 'status', run: runTunnelStatus },
  { name: 'stop', run: runTunnelStop },
])('tunnel $name UUID validation', ({ name, run }) => {
  describe.each(['text', 'json'] as const)('%s output', output => {
    it.each([
      '',
      'c-1111',
      'not-a-uuid',
      'cf6e084391664eaa918ef085407eaca5',
      'cf6e0843-9166-4eaa-918e-f085407eacaZ',
      'cf6e0843-9166-4eaa-918e-f085407eaca',
      'cf6e0843-9166-4eaa-918e-f085407eaca5 ',
      '{cf6e0843-9166-4eaa-918e-f085407eaca5}',
    ])('rejects malformed id %j before any request', async clientId => {
      const fetchImpl = vi.fn(
        makeFetch(method =>
          method === 'DELETE'
            ? { status: 204 }
            : { body: { clientId, status: 'online', expiresAt: MINT_BODY.expiresAt } },
        ),
      );
      const stdout = vi.fn();
      await expect(
        run(
          { profile: 'default', output, debug: false, clientId },
          { ...makeCreds(), fetchImpl, stdout, stderr: () => {} },
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        exitCode: 5,
        message: INVALID_CLIENT_ID_MESSAGE,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(stdout).not.toHaveBeenCalled();
    });

    it('validates before credentials are required', async () => {
      const fetchImpl = vi.fn(makeFetch(() => ({ status: 204 })));
      await expect(
        run(
          { profile: 'default', output, debug: false, clientId: 'bad-id' },
          { env: {}, credentialsPath: '/nonexistent/tunnel-validation-credentials', fetchImpl },
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        exitCode: 5,
        message: INVALID_CLIENT_ID_MESSAGE,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('renders the local error and exits 5 in the built CLI, including dry run', () => {
      const result = spawnSync(
        process.execPath,
        ['dist/index.js', '--dry-run', '--output', output, 'tunnel', name, 'bad-id'],
        { encoding: 'utf8', env: { ...process.env, TESTSPRITE_TELEMETRY: 'off' } },
      );
      expect(result.status).toBe(5);
      expect(result.stdout).toBe('');
      if (output === 'json') {
        expect(JSON.parse(result.stderr)).toMatchObject({
          error: {
            code: 'VALIDATION_ERROR',
            message: INVALID_CLIENT_ID_MESSAGE,
            requestId: 'local',
          },
        });
      } else {
        expect(result.stderr).toContain(`Error: ${INVALID_CLIENT_ID_MESSAGE}`);
      }
    });
  });
});

describe('tunnel — dry run', () => {
  it('makes no network calls and constructs no client', async () => {
    const fetchImpl = vi.fn();
    const tunnel = fakeTunnel();
    await runTunnelStart(
      { profile: 'default', output: 'json', debug: false, dryRun: true },
      {
        ...makeCreds(),
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
        stdout: () => {},
        stderr: () => {},
        createTunnelClient: tunnel.factory,
      },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(tunnel.calls.start).toBe(0);
  });
});
