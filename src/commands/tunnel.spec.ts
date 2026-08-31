import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/errors.js';
import { ShutdownController } from '../lib/interrupt.js';
import { ErrCode } from '../vendor/tunnel-client/index.js';
import type { TunnelClientOptions } from '../vendor/tunnel-client/index.js';
import { runTunnelStart, runTunnelStatus, runTunnelStop } from './tunnel.js';

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function makeCreds(): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-tunnel-cmd-'));
  const credentialsPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
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
  expiresAt: '2026-08-24T18:00:00.000Z',
};

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
    emitAuthFailure: () =>
      captured?.onError?.({ code: ErrCode.AuthFailed, message: 'auth failed' }),
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
    expect(text).not.toContain(MINT_BODY.secret);
    expect(seen.some(call => call.startsWith('DELETE'))).toBe(true);
    expect(tunnel.calls.stop).toBe(1);
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
});

describe('tunnel status', () => {
  it('reports online for a live client', async () => {
    const lines: string[] = [];
    const result = await runTunnelStatus(
      { profile: 'default', output: 'text', debug: false, clientId: 'c-1111' },
      {
        ...makeCreds(),
        fetchImpl: makeFetch(() => ({
          body: { clientId: 'c-1111', status: 'online', expiresAt: MINT_BODY.expiresAt },
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
        { profile: 'default', output: 'text', debug: false, clientId: 'c-1111' },
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
        { profile: 'default', output: 'text', debug: false, clientId: 'nope' },
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
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
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
      { profile: 'default', output: 'text', debug: false, clientId: 'c-1111' },
      { ...makeCreds(), fetchImpl, stdout: line => lines.push(line), stderr: () => {} },
    );
    await runTunnelStop(
      { profile: 'default', output: 'text', debug: false, clientId: 'c-1111' },
      { ...makeCreds(), fetchImpl, stdout: () => {}, stderr: () => {} },
    );
    expect(seen.filter(c => c.startsWith('DELETE')).length).toBe(2);
    expect(lines.join('\n')).toContain('c-1111');
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
