import { describe, expect, it, vi } from 'vitest';
import { ApiError, RequestTimeoutError, TransportError } from './errors.js';
import type { DebugEvent } from './http.js';
import { HttpClient, REQUEST_TIMEOUT_DEFAULT_MS, buildUrl, parseRetryAfter } from './http.js';
import { VERSION } from '../version.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function errorEnvelopeResponse(status: number, code: string, init: ResponseInit = {}): Response {
  return jsonResponse(
    {
      error: {
        code,
        message: `Error ${code}`,
        nextAction: 'do something',
        requestId: 'req_1',
        details: {},
      },
    },
    { status, ...init },
  );
}

function makeClient(
  fetchImpl: typeof fetch,
  options: { apiKey?: string | null; onDebug?: (e: DebugEvent) => void } = {},
): HttpClient {
  const apiKey = 'apiKey' in options ? (options.apiKey ?? undefined) : 'sk-test';
  return new HttpClient({
    baseUrl: 'https://api.example.com/api/cli/v1',
    apiKey,
    fetchImpl,
    sleep: () => Promise.resolve(),
    random: () => 0,
    onDebug: options.onDebug,
  });
}

describe('buildUrl', () => {
  it('handles trailing slashes and absolute paths', () => {
    expect(buildUrl('https://api.example.com/api/cli/v1', '/me')).toBe(
      'https://api.example.com/api/cli/v1/me',
    );
    expect(buildUrl('https://api.example.com/api/cli/v1/', 'me')).toBe(
      'https://api.example.com/api/cli/v1/me',
    );
  });

  it('serializes query params and skips undefined values', () => {
    const url = buildUrl('https://api.example.com/api/cli/v1', '/tests', {
      pageSize: 50,
      cursor: undefined,
      type: 'frontend',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('pageSize')).toBe('50');
    expect(parsed.searchParams.get('cursor')).toBeNull();
    expect(parsed.searchParams.get('type')).toBe('frontend');
  });
});

describe('parseRetryAfter', () => {
  it('returns undefined for null/empty headers', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
  });

  it('parses integer seconds', () => {
    expect(parseRetryAfter('5')).toBe(5);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('parses HTTP-date headers (positive)', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const value = parseRetryAfter(future);
    expect(value).toBeGreaterThanOrEqual(9);
    expect(value).toBeLessThanOrEqual(11);
  });

  it('clamps past dates to 0', () => {
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });

  it('returns undefined for unparseable headers', () => {
    expect(parseRetryAfter('not-a-thing')).toBeUndefined();
  });
});

describe('HttpClient happy path', () => {
  it('returns parsed JSON and propagates x-api-key + x-request-id', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-api-key')).toBe('sk-test');
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('x-request-id')).toMatch(/^cli_/);
      expect(input.toString()).toBe('https://api.example.com/api/cli/v1/me');
      return jsonResponse({ userId: 'u1' });
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const body = await client.get<{ userId: string }>('/me');
    expect(body.userId).toBe('u1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends User-Agent header as testsprite-cli/<version>', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('user-agent')).toBe(`testsprite-cli/${VERSION}`);
      expect(headers.get('user-agent')).toMatch(/^testsprite-cli\/\S+$/);
      return jsonResponse({});
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.get('/me');
  });

  it('honors a caller-supplied requestId', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-request-id')).toBe('caller-supplied');
      return jsonResponse({});
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.get('/me', { requestId: 'caller-supplied' });
  });

  it('throws AUTH_REQUIRED locally when no key is configured', async () => {
    const fetchImpl = vi.fn();
    const client = makeClient(fetchImpl as unknown as typeof fetch, { apiKey: null });
    await expect(client.get('/me')).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      exitCode: 3,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('HttpClient — 200 response with a non-JSON body', () => {
  function htmlResponse(status = 200): Response {
    return new Response('<!DOCTYPE html><html><body>Login</body></html>', {
      status,
      headers: { 'content-type': 'text/html' },
    });
  }

  it('throws a typed INTERNAL ApiError (not a raw SyntaxError) with the requestId and details', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse());
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    let caught: unknown;
    try {
      await client.get('/me');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const apiErr = caught as ApiError;
    expect(apiErr.code).toBe('INTERNAL');
    expect(apiErr.exitCode).toBe(1);
    expect(apiErr.requestId).toMatch(/^cli_/);
    expect(apiErr.message).toContain('non-JSON response');
    expect(apiErr.nextAction).toContain('TESTSPRITE_API_URL');
    expect(apiErr.details).toMatchObject({ httpStatus: 200, contentType: 'text/html' });
    expect(String(apiErr.details.parseError)).toContain('JSON');
  });

  it('does not retry a malformed 200 body (single fetch call)', async () => {
    const fetchImpl = vi.fn(async () => htmlResponse());
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.get('/me')).rejects.toBeInstanceOf(ApiError);
    // A non-JSON success body is a hard config error, not a transient transport
    // failure — it must not burn the retry budget.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('handles an empty 200 body the same way', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.get('/me')).rejects.toMatchObject({ code: 'INTERNAL', exitCode: 1 });
  });
});

describe('HttpClient error mapping', () => {
  it('does not retry AUTH_INVALID and exits 3', async () => {
    const fetchImpl = vi.fn(async () => errorEnvelopeResponse(401, 'AUTH_INVALID'));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.get('/me')).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry NOT_FOUND', async () => {
    const fetchImpl = vi.fn(async () => errorEnvelopeResponse(404, 'NOT_FOUND'));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.get('/projects/x')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      exitCode: 4,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries CONFLICT once then propagates', async () => {
    const fetchImpl = vi.fn(async () => errorEnvelopeResponse(409, 'CONFLICT'));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.get('/me')).rejects.toMatchObject({ code: 'CONFLICT', exitCode: 6 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries INTERNAL once then propagates', async () => {
    const fetchImpl = vi.fn(async () => errorEnvelopeResponse(500, 'INTERNAL'));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.get('/me')).rejects.toMatchObject({ code: 'INTERNAL', exitCode: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries RATE_LIMITED up to 3 times honoring Retry-After', async () => {
    const sleepCalls: number[] = [];
    const fetchImpl = vi.fn(async () =>
      errorEnvelopeResponse(429, 'RATE_LIMITED', { headers: { 'retry-after': '2' } }),
    );
    const client = new HttpClient({
      baseUrl: 'https://api.example.com/api/cli/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: ms => {
        sleepCalls.push(ms);
        return Promise.resolve();
      },
    });
    await expect(client.get('/me')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      exitCode: 11,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepCalls).toEqual([2000, 2000]);
  });

  it('retries UNAVAILABLE up to 4 times with bounded backoff', async () => {
    const fetchImpl = vi.fn(async () => errorEnvelopeResponse(503, 'UNAVAILABLE'));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.get('/me')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      exitCode: 10,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('retries transport errors then propagates as TransportError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.get('/me')).rejects.toBeInstanceOf(TransportError);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('does not retry AbortError', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.get('/me')).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to INTERNAL for malformed error bodies', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 500 }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.get('/me')).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});

describe('HttpClient debug events', () => {
  it('emits request → response on success', async () => {
    const events: DebugEvent[] = [];
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchImpl as unknown as typeof fetch, {
      onDebug: e => events.push(e),
    });
    await client.get('/me');
    expect(events.map(e => e.kind)).toEqual(['request', 'response']);
    expect(events[0]?.method).toBe('GET');
    expect(events[1]?.status).toBe(200);
  });

  it('emits error → retry → request → error sequence on retry', async () => {
    const events: DebugEvent[] = [];
    let count = 0;
    const fetchImpl = vi.fn(async () => {
      count += 1;
      if (count === 1) return errorEnvelopeResponse(500, 'INTERNAL');
      return jsonResponse({ ok: true });
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch, {
      onDebug: e => events.push(e),
    });
    await client.get('/me');
    expect(events.map(e => e.kind)).toEqual(['request', 'error', 'retry', 'request', 'response']);
  });

  it('debug events never include the api key', async () => {
    const events: DebugEvent[] = [];
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchImpl as unknown as typeof fetch, {
      apiKey: 'sk-secret-0123456789',
      onDebug: e => events.push(e),
    });
    await client.get('/me');
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('x-api-key');
  });
});

describe('HttpClient transport-edge statuses', () => {
  it.each([408, 502, 504] as const)(
    '%d with no envelope retries up to MAX_ATTEMPTS_TRANSPORT and propagates as TransportError',
    async status => {
      const fetchImpl = vi.fn(async () => new Response('proxy gateway html', { status }));
      const client = makeClient(fetchImpl as unknown as typeof fetch);
      await expect(client.get('/me')).rejects.toBeInstanceOf(TransportError);
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    },
  );

  it('502 carrying our envelope still maps to its catalog code', async () => {
    const body = {
      error: {
        code: 'INTERNAL',
        message: 'oops',
        nextAction: 'retry',
        requestId: 'req',
        details: {},
      },
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.get('/me')).rejects.toMatchObject({ code: 'INTERNAL' });
    // INTERNAL retries once → two attempts total
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Per-request timeout tests
// ---------------------------------------------------------------------------

describe('HttpClient per-request timeout', () => {
  /**
   * Make a client whose fetch never resolves (stalled TCP simulation).
   * We set a short requestTimeoutMs so the test completes quickly.
   */
  function makeTimingClient(requestTimeoutMs: number): HttpClient {
    const fetchImpl = vi.fn(async (_input: unknown, init?: { signal?: AbortSignal }) => {
      // Simulate a stalled connection: wait for the abort signal to fire.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          const reason = signal.reason;
          // AbortSignal.timeout() sets reason to a DOMException with name 'TimeoutError'
          const err = new Error(reason?.message ?? 'aborted');
          err.name = reason?.name ?? 'TimeoutError';
          reject(err);
          return;
        }
        signal?.addEventListener('abort', () => {
          const reason = signal.reason;
          const err = new Error(reason?.message ?? 'aborted');
          err.name = reason?.name ?? 'TimeoutError';
          reject(err);
        });
      });
    });
    return new HttpClient({
      baseUrl: 'https://api.example.com/api/cli/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
      requestTimeoutMs,
    });
  }

  it('throws RequestTimeoutError when fetch stalls past the per-request timeout', async () => {
    const client = makeTimingClient(50); // 50ms timeout for fast test
    await expect(client.get('/me')).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it('RequestTimeoutError has exit code 7 and the timeout in the message', async () => {
    const client = makeTimingClient(50);
    const err = await client.get('/me').catch(e => e);
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect((err as RequestTimeoutError).exitCode).toBe(7);
    expect((err as RequestTimeoutError).message).toContain('timed out');
    expect((err as RequestTimeoutError).message).toContain('--request-timeout');
    expect((err as RequestTimeoutError).timeoutMs).toBe(50);
  });

  it('does NOT retry when the per-request timeout fires (stall is treated like a one-shot abort)', async () => {
    // A stalled fetch aborts; unlike a transport error, the per-request
    // timeout should NOT trigger the transport-retry budget (the connection
    // is still stalled — retrying won't help in the same second).
    let callCount = 0;
    const fetchImpl = vi.fn(async (_input: unknown, init?: { signal?: AbortSignal }) => {
      callCount += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        if (signal?.aborted) {
          const reason = signal.reason;
          const err = new Error(reason?.message ?? 'aborted');
          err.name = reason?.name ?? 'TimeoutError';
          reject(err);
          return;
        }
        signal?.addEventListener('abort', () => {
          const reason = signal.reason;
          const err = new Error(reason?.message ?? 'aborted');
          err.name = reason?.name ?? 'TimeoutError';
          reject(err);
        });
      });
    });
    const client = new HttpClient({
      baseUrl: 'https://api.example.com/api/cli/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
      requestTimeoutMs: 50, // 50ms timeout
    });
    const err = await client.get('/me').catch(e => e);
    expect(err).toBeInstanceOf(RequestTimeoutError);
    // The timeout fires on the first attempt; no retries should occur because
    // the abort is re-thrown as RequestTimeoutError, not as a TransportError.
    expect(callCount).toBe(1);
  });

  it('caller-supplied AbortSignal still propagates as AbortError (not RequestTimeoutError)', async () => {
    const controller = new AbortController();
    // Abort immediately
    controller.abort();
    const fetchImpl = vi.fn(async (_input: unknown, init?: { signal?: AbortSignal }) => {
      if (init?.signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return new Response('{}', { status: 200 });
    });
    const client = new HttpClient({
      baseUrl: 'https://api.example.com/api/cli/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
      requestTimeoutMs: 120_000,
    });
    const err = await client.get('/me', { signal: controller.signal }).catch(e => e);
    // Should propagate as AbortError, NOT RequestTimeoutError
    expect(err).not.toBeInstanceOf(RequestTimeoutError);
    expect((err as Error).name).toBe('AbortError');
  });

  it('defaults to REQUEST_TIMEOUT_DEFAULT_MS when no requestTimeoutMs is supplied', () => {
    // Verify the default is wired without actually waiting 120s.
    // We test via the exported constant rather than exercising the stall.
    expect(REQUEST_TIMEOUT_DEFAULT_MS).toBe(120_000);
    const client = new HttpClient({
      baseUrl: 'https://api.example.com/api/cli/v1',
      apiKey: 'sk-test',
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    // Access the private field via cast to verify it was set correctly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).requestTimeoutMs).toBe(REQUEST_TIMEOUT_DEFAULT_MS);
  });

  it('polling path: caller-supplied short-lived signal fires as AbortError, not RequestTimeoutError', async () => {
    // Simulate the polling-path pattern: caller creates a short-deadline
    // AbortController (like poll.ts does per iteration), http client has a
    // long requestTimeoutMs. The caller abort fires first and should NOT
    // be repackaged as RequestTimeoutError.
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_input: unknown, init?: { signal?: AbortSignal }) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const reason = init.signal?.reason;
          const err = new Error(reason?.message ?? 'caller-aborted');
          err.name = reason?.name ?? 'AbortError';
          reject(err);
        });
        // Abort after 10ms (simulating poll's iteration deadline firing first)
        setTimeout(() => controller.abort(), 10);
      });
    });
    const client = new HttpClient({
      baseUrl: 'https://api.example.com/api/cli/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
      requestTimeoutMs: 120_000, // long per-request timeout — should not fire
    });
    const err = await client.get('/me', { signal: controller.signal }).catch(e => e);
    expect(err).not.toBeInstanceOf(RequestTimeoutError);
    expect((err as Error).name).toBe('AbortError');
  });

  it('classifies a timeout during body read (OK response) as RequestTimeoutError', async () => {
    const timeoutErr = Object.assign(new Error('body stalled'), { name: 'TimeoutError' });
    const fetchImpl = vi.fn(async () => {
      // Resolve the fetch only after the (1ms) per-request timeout has fired, then
      // reject the body read — exercises the post-fetch classification path that
      // previously let the raw abort escape unclassified.
      await new Promise(r => setTimeout(r, 15));
      return {
        ok: true,
        status: 200,
        json: () => Promise.reject(timeoutErr),
      } as unknown as Response;
    });
    const client = new HttpClient({
      baseUrl: 'https://api.example.com/api/cli/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
      requestTimeoutMs: 1,
    });
    const err = await client.get('/me').catch(e => e);
    expect(err).toBeInstanceOf(RequestTimeoutError);
  });

  it('classifies a timeout during body read (non-OK response) as RequestTimeoutError', async () => {
    const timeoutErr = Object.assign(new Error('body stalled'), { name: 'TimeoutError' });
    const fetchImpl = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 15));
      return {
        ok: false,
        status: 500,
        headers: new Headers(),
        json: () => Promise.reject(timeoutErr),
      } as unknown as Response;
    });
    const client = new HttpClient({
      baseUrl: 'https://api.example.com/api/cli/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
      requestTimeoutMs: 1,
    });
    const err = await client.get('/me').catch(e => e);
    expect(err).toBeInstanceOf(RequestTimeoutError);
  });
});
