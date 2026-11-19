import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { ProxyAgent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TransportError } from './errors.js';
import { HttpClient } from './http.js';
import { classifyFatalTransportFailure } from './transport-failure.js';

const BASE_URL = 'https://api.example.com/api/cli/v1';

function makeClient(fetchImpl: typeof fetch, baseUrl = BASE_URL): HttpClient {
  return new HttpClient({
    baseUrl,
    apiKey: 'sk-test',
    fetchImpl,
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
}

/** The shape Node's fetch rejects with on a certificate failure. */
function tlsFailure(code: string): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(`certificate problem (${code})`), { code }),
  });
}

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe('HttpClient — TLS certificate failures', () => {
  it.each([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ])('%s fails after one attempt and names NODE_EXTRA_CA_CERTS', async code => {
    const fetchImpl = vi.fn(async () => {
      throw tlsFailure(code);
    });
    const err = await caught(makeClient(fetchImpl as unknown as typeof fetch).get('/me'));

    expect(err).toBeInstanceOf(TransportError);
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.exitCode).toBe(10);
    expect(err.message).toContain(code);
    expect(err.message).toContain('NODE_EXTRA_CA_CERTS');
    expect(err.nextAction).toContain('NODE_EXTRA_CA_CERTS');
    expect(err.nextAction).toContain('Do not set NODE_TLS_REJECT_UNAUTHORIZED=0');
    expect(err.details).toEqual({ cause: code });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('finds the certificate code inside an AggregateError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: new AggregateError([
          Object.assign(new Error('connect ECONNREFUSED ::1:443'), { code: 'ECONNREFUSED' }),
          Object.assign(new Error('self-signed certificate in certificate chain'), {
            code: 'SELF_SIGNED_CERT_IN_CHAIN',
          }),
        ]),
      });
    });
    const err = await caught(makeClient(fetchImpl as unknown as typeof fetch).get('/me'));

    expect(err.details).toEqual({ cause: 'SELF_SIGNED_CERT_IN_CHAIN' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails a keyed write after one attempt too', async () => {
    const fetchImpl = vi.fn(async () => {
      throw tlsFailure('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    });
    const err = await caught(
      makeClient(fetchImpl as unknown as typeof fetch).post('/tests', {
        body: {},
        headers: { 'Idempotency-Key': 'key-1' },
      }),
    );

    expect(err.details).toEqual({ cause: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Replay-safe cleanup calls may retry transport failures, so the
  // certificate check has to run before that retry decision.
  it('fails a replay-safe tunnel delete after one attempt', async () => {
    const fetchImpl = vi.fn(async () => {
      throw tlsFailure('SELF_SIGNED_CERT_IN_CHAIN');
    });
    const err = await caught(makeClient(fetchImpl as unknown as typeof fetch).deleteTunnel('c1'));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(err.details).toEqual({ cause: 'SELF_SIGNED_CERT_IN_CHAIN' });
  });

  it('fails a replay-safe run cancel after one attempt', async () => {
    const fetchImpl = vi.fn(async () => {
      throw tlsFailure('CERT_HAS_EXPIRED');
    });
    const err = await caught(makeClient(fetchImpl as unknown as typeof fetch).cancelRun('r1'));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(err.details).toEqual({ cause: 'CERT_HAS_EXPIRED' });
  });

  it('keeps the retry budget and the generic error for other network failures', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
          code: 'ECONNREFUSED',
        }),
      });
    });
    const err = await caught(makeClient(fetchImpl as unknown as typeof fetch).get('/me'));

    expect(err).toBeInstanceOf(TransportError);
    expect(err.message).toBe('fetch failed');
    expect(err.nextAction).toContain('Service is temporarily unavailable');
    expect(err.details).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe('HttpClient — proxy 407', () => {
  let proxy: Server | undefined;
  let agent: ProxyAgent | undefined;
  const sockets = new Set<Socket>();

  afterEach(async () => {
    await agent?.close();
    agent = undefined;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>(resolve => (proxy ? proxy.close(() => resolve()) : resolve()));
    proxy = undefined;
  });

  /** A real proxy that demands credentials on both the CONNECT and the forwarding path. */
  async function startProxy(): Promise<string> {
    proxy = createServer((_req, res) => {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="corp"' });
      res.end('proxy authentication required');
    });
    proxy.on('connection', socket => sockets.add(socket));
    proxy.on('connect', (_req, socket: Socket) => {
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\n' +
          'Proxy-Authenticate: Basic realm="corp"\r\nContent-Length: 0\r\n\r\n',
      );
    });
    await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  }

  function viaProxy(proxyAgent: ProxyAgent): ReturnType<typeof vi.fn> {
    return vi.fn((input: string | URL | Request, init?: RequestInit) =>
      fetch(input, { ...init, dispatcher: proxyAgent } as unknown as RequestInit),
    );
  }

  it('fails after one attempt when the HTTPS tunnel is refused with 407', async () => {
    agent = new ProxyAgent({ uri: await startProxy() });
    const fetchImpl = viaProxy(agent);
    const err = await caught(makeClient(fetchImpl as unknown as typeof fetch).get('/me'));

    expect(err).toBeInstanceOf(TransportError);
    expect(err.exitCode).toBe(10);
    expect(err.message).toContain('407 Proxy Authentication Required');
    expect(err.message).toContain('the API key was not rejected');
    expect(err.nextAction).toContain('HTTPS_PROXY');
    expect(err.details).toEqual({ cause: 'PROXY_AUTHENTICATION_REQUIRED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails after one attempt when a forwarding proxy answers 407', async () => {
    agent = new ProxyAgent({ uri: await startProxy(), proxyTunnel: false });
    const fetchImpl = viaProxy(agent);
    const err = await caught(
      makeClient(fetchImpl as unknown as typeof fetch, 'http://api.example.com/api/cli/v1').get(
        '/me',
      ),
    );

    expect(err.details).toEqual({ cause: 'PROXY_AUTHENTICATION_REQUIRED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('HttpClient — a 4xx whose body is not JSON', () => {
  const BLOCK_PAGE =
    '<!doctype html><html><head><title>Blocked by your organization</title></head></html>';

  it.each([
    [402, 'INSUFFICIENT_CREDITS'],
    [403, 'AUTH_FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [426, 'CLIENT_TOO_OLD'],
  ])('reports an HTML %d as a non-API answer, not %s', async (status, apiCode) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(BLOCK_PAGE, {
          status,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    );
    const err = await caught(makeClient(fetchImpl as unknown as typeof fetch).get('/tests/t1'));

    expect(err).toBeInstanceOf(TransportError);
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.code).not.toBe(apiCode);
    expect(err.exitCode).toBe(10);
    expect(err.message).toBe(
      `Something between this machine and the TestSprite API answered HTTP ${status} ` +
        '(content-type: text/html; charset=utf-8) instead of the API; the API key was not rejected.',
    );
    expect(err.nextAction).toContain('api.example.com');
    expect(err.details).toEqual({ httpStatus: status, contentType: 'text/html; charset=utf-8' });
    // The status belongs to whatever answered in front of the API.
    expect(err.httpStatus).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('treats an empty 4xx body the same way', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    const err = await caught(makeClient(fetchImpl as unknown as typeof fetch).get('/me'));

    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toContain('answered HTTP 401 (content-type: none)');
    expect(err.details).toEqual({ httpStatus: 401, contentType: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the status mapping for a JSON body, even a bare null', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('null', { status: 404, headers: { 'content-type': 'application/json' } }),
    );
    const err = await caught(makeClient(fetchImpl as unknown as typeof fetch).get('/tests/t1'));

    expect(err.code).toBe('NOT_FOUND');
    expect(err.exitCode).toBe(4);
    expect(err.httpStatus).toBe(404);
  });

  it('keeps a JSON 403 envelope as AUTH_FORBIDDEN', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_FORBIDDEN',
              message: 'Forbidden.',
              nextAction: 'Use a key with the right scope.',
              requestId: 'req_1',
              details: {},
            },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        ),
    );
    const err = await caught(makeClient(fetchImpl as unknown as typeof fetch).get('/me'));

    expect(err.code).toBe('AUTH_FORBIDDEN');
    expect(err.exitCode).toBe(3);
  });

  it('keeps the status mapping when a 4xx body fails to arrive', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('socket hang up'));
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 403 }));
    const err = await caught(makeClient(fetchImpl as unknown as typeof fetch).get('/me'));

    expect(err.code).toBe('AUTH_FORBIDDEN');
    expect(err).not.toBeInstanceOf(TransportError);
  });

  it('keeps retrying a non-JSON 429 as RATE_LIMITED', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('slow down', {
          status: 429,
          headers: { 'content-type': 'text/plain', 'retry-after': '1' },
        }),
    );
    const err = await caught(makeClient(fetchImpl as unknown as typeof fetch).get('/me'));

    expect(err.code).toBe('RATE_LIMITED');
    expect(err.exitCode).toBe(11);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('keeps retrying a non-JSON 408 as a transport failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('timeout', { status: 408 }));
    const err = await caught(makeClient(fetchImpl as unknown as typeof fetch).get('/me'));

    expect(err).toBeInstanceOf(TransportError);
    expect(err.message).toBe('HTTP 408 from https://api.example.com/api/cli/v1/me');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('leaves a non-JSON 500 on the server-error path', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>oops</html>', { status: 500 }));
    const err = await caught(makeClient(fetchImpl as unknown as typeof fetch).get('/me'));

    expect(err.code).toBe('INTERNAL');
    expect(err.message).not.toContain('Something between');
  });
});

describe('classifyFatalTransportFailure', () => {
  it('ignores failures that a retry can fix', () => {
    const reset = new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });
    expect(classifyFatalTransportFailure(reset, BASE_URL)).toBeUndefined();
    expect(classifyFatalTransportFailure('fetch failed', BASE_URL)).toBeUndefined();
  });

  it('survives a cyclic cause chain', () => {
    const err = new Error('fetch failed') as Error & { cause?: unknown };
    err.cause = err;
    expect(classifyFatalTransportFailure(err, BASE_URL)).toBeUndefined();
  });

  it('names the host, or a generic target when the URL does not parse', () => {
    expect(classifyFatalTransportFailure(tlsFailure('CERT_NOT_YET_VALID'), BASE_URL)).toMatchObject(
      {
        cause: 'CERT_NOT_YET_VALID',
        message: expect.stringContaining('api.example.com'),
      },
    );
    expect(classifyFatalTransportFailure(tlsFailure('CERT_REVOKED'), 'not a url')).toMatchObject({
      cause: 'CERT_REVOKED',
      message: expect.stringContaining('the API endpoint'),
    });
  });
});
