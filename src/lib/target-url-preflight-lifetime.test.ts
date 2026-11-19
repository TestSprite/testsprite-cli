import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterruptError } from './errors.js';
import { ShutdownController } from './interrupt.js';
import { probeTargetUrl } from './target-url-preflight.js';

/** Lets tests settle DNS after a chosen deadline or interruption. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('target URL preflight lifetime', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    'bounds a stalled DNS lookup to 8s (proxy active: %s)',
    async proxyActive => {
      const shutdown = new ShutdownController();
      const dnsLookup = vi.fn(() => new Promise<unknown>(() => {}));
      const fetchImpl = vi.fn();
      const settled = vi.fn();
      const pending = probeTargetUrl('https://example.test', {
        dnsLookup,
        fetchImpl,
        proxyActive,
        shutdown,
        shutdownSignal: shutdown.signal,
      }).then(settled);

      await vi.advanceTimersByTimeAsync(7_999);
      expect(dnsLookup).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();
      const trackedDuringDns = shutdown.hasCriticalOperations;

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledWith({
        verdict: 'warn',
        reason: expect.stringMatching(/DNS.*8s/),
      });
      await pending;
      expect(trackedDuringDns).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(shutdown.hasCriticalOperations).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'propagates %s immediately while DNS is pending',
    async signal => {
      const shutdown = new ShutdownController();
      const fetchImpl = vi.fn();
      const rejected = vi.fn();
      const pending = probeTargetUrl('https://example.test', {
        dnsLookup: () => new Promise(() => {}),
        fetchImpl,
        proxyActive: false,
        shutdown,
        shutdownSignal: shutdown.signal,
      }).catch(rejected);

      await vi.advanceTimersByTimeAsync(0);
      const trackedDuringDns = shutdown.hasCriticalOperations;
      shutdown.interrupt(signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(rejected).toHaveBeenCalledWith(shutdown.signal.reason);
      await pending;
      expect(trackedDuringDns).toBe(true);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(shutdown.hasCriticalOperations).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['https://example.test', 'https://93.184.216.34', 'https://[2606:4700::1111]'])(
    'does no DNS or HTTP work for an already-aborted signal (%s)',
    async url => {
      const controller = new AbortController();
      const reason = new InterruptError('SIGINT');
      controller.abort(reason);
      const dnsLookup = vi.fn().mockResolvedValue({ address: '93.184.216.34' });
      const fetchImpl = vi.fn().mockResolvedValue(new Response(null));
      await expect(
        probeTargetUrl(url, { dnsLookup, fetchImpl, shutdownSignal: controller.signal }),
      ).rejects.toBe(reason);
      expect(dnsLookup).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('propagates an InterruptError from the DNS hook without an advisory', async () => {
    const reason = new InterruptError('SIGINT');
    const fetchImpl = vi.fn();
    await expect(
      probeTargetUrl('https://example.test', {
        dnsLookup: () => Promise.reject(reason),
        fetchImpl,
      }),
    ).rejects.toBe(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('checks interruption again when DNS resolves in the same turn', async () => {
    const lookup = deferred<unknown>();
    const shutdown = new ShutdownController();
    const fetchImpl = vi.fn();
    const rejected = vi.fn();
    const pending = probeTargetUrl('https://example.test', {
      dnsLookup: () => lookup.promise,
      fetchImpl,
      shutdownSignal: shutdown.signal,
    }).catch(rejected);
    await vi.advanceTimersByTimeAsync(0);
    lookup.resolve({ address: '93.184.216.34' });
    shutdown.interrupt('SIGINT');
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected).toHaveBeenCalledWith(shutdown.signal.reason);
    await pending;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['timeout', 'resolve'],
    ['timeout', 'reject'],
    ['interrupt', 'resolve'],
    ['interrupt', 'reject'],
  ] as const)('ignores a late DNS %s/%s without starting HTTP', async (stop, completion) => {
    const lookup = deferred<unknown>();
    const shutdown = new ShutdownController();
    const fetchImpl = vi.fn();
    const resolved = vi.fn();
    const rejected = vi.fn();
    const pending = probeTargetUrl('https://example.test', {
      dnsLookup: () => lookup.promise,
      fetchImpl,
      shutdown,
      shutdownSignal: shutdown.signal,
    }).then(resolved, rejected);

    await vi.advanceTimersByTimeAsync(0);
    if (stop === 'timeout') await vi.advanceTimersByTimeAsync(8_000);
    else shutdown.interrupt('SIGINT');
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved.mock.calls.length + rejected.mock.calls.length).toBe(1);
    await pending;

    if (completion === 'resolve') lookup.resolve({ address: '93.184.216.34' });
    else lookup.reject(Object.assign(new Error('late DNS failure'), { code: 'ENOTFOUND' }));
    // A late rejection is also observed by Vitest's unhandled-rejection guard.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolved.mock.calls.length + rejected.mock.calls.length).toBe(1);
    expect(shutdown.hasCriticalOperations).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares one 8s budget between DNS and HTTP', async () => {
    const lookup = deferred<unknown>();
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_input: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
          once: true,
        });
      });
    });
    const settled = vi.fn();
    const pending = probeTargetUrl('https://example.test', {
      dnsLookup: () => lookup.promise,
      fetchImpl,
    }).then(settled);

    await vi.advanceTimersByTimeAsync(6_000);
    lookup.resolve({ address: '93.184.216.34' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(requestSignal?.aborted).toBe(true);
    expect(settled).toHaveBeenCalledWith({
      verdict: 'warn',
      reason: expect.stringContaining('8s'),
    });
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['success', 'DNS refusal', 'DNS advisory', 'HTTP refusal'])(
    'cleans up its timer and DNS abort listener after %s',
    async outcome => {
      const shutdown = new ShutdownController();
      const addListener = vi.spyOn(AbortSignal.prototype, 'addEventListener');
      const dnsLookup = vi.fn(async () => {
        if (outcome.startsWith('DNS')) {
          throw Object.assign(new Error('DNS failure'), {
            code: outcome === 'DNS refusal' ? 'ENOTFOUND' : 'EAI_AGAIN',
          });
        }
        return { address: '93.184.216.34' };
      });
      const result = await probeTargetUrl('https://example.test', {
        dnsLookup,
        fetchImpl: vi
          .fn()
          .mockResolvedValue(
            new Response(null, { status: outcome === 'HTTP refusal' ? 503 : 200 }),
          ),
        shutdown,
        shutdownSignal: shutdown.signal,
      });
      expect(result.verdict).toBe(
        outcome === 'success' ? 'ok' : outcome === 'DNS advisory' ? 'warn' : 'refuse',
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(shutdown.hasCriticalOperations).toBe(false);
      for (const signal of addListener.mock.instances) {
        expect(getEventListeners(signal as AbortSignal, 'abort')).toHaveLength(0);
      }
    },
  );
});
