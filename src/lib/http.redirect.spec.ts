import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { createMockBackend } from '../../test/mock-backend/server.js';
import { ApiError, RequestTimeoutError, TransportError } from './errors.js';
import { HttpClient } from './http.js';

const origin = 'https://api.example.com';
const start = `${origin}/api/cli/v1/start`;
const apiKey = 'synthetic-redirect-test-key';
const backend = createMockBackend([]);
backend.installLifecycle();

function client() {
  const sleep = vi.fn(async () => {});
  return {
    sleep,
    client: new HttpClient({ baseUrl: `${origin}/api/cli/v1`, apiKey, sleep }),
  };
}

describe('authenticated HTTP redirects', () => {
  it.each([301, 302, 303, 307, 308] as const)(
    'never sends the key across a %i redirect',
    async status => {
      const destination = vi.fn(() => HttpResponse.json({ leaked: true }));
      backend.use(
        http.get(start, () => HttpResponse.redirect('https://other.example.com/collect', status)),
        http.all('https://other.example.com/collect', destination),
      );
      const { client: api, sleep } = client();
      const error: unknown = await api.get('/start').catch((error: unknown) => error);

      expect(destination).not.toHaveBeenCalled();
      expect(error).toBeInstanceOf(TransportError);
      expect(error).toMatchObject({ code: 'UNAVAILABLE' });
      expect((error as Error).message).toContain(origin);
      expect((error as Error).message).toContain('https://other.example.com');
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it.each(['http://api.example.com/collect', 'https://api.example.com:8443/collect'])(
    'rejects an origin change to %s even with the same hostname',
    async target => {
      const destination = vi.fn(() => HttpResponse.json({ leaked: true }));
      backend.use(
        http.get(start, () => HttpResponse.redirect(target, 302)),
        http.get(target, destination),
      );
      await expect(client().client.get('/start')).rejects.toBeInstanceOf(TransportError);
      expect(destination).not.toHaveBeenCalled();
    },
  );

  it('checks later hops and omits credentials, paths and queries from the redirect error', async () => {
    const destination = vi.fn(() => HttpResponse.json({ leaked: true }));
    backend.use(
      http.get(start, () => HttpResponse.redirect(`${origin}/next`, 302)),
      http.get(`${origin}/next`, () =>
        HttpResponse.redirect('https://user:password@other.example.com/private?token=secret', 302),
      ),
      http.get('https://other.example.com/private', destination),
    );
    const error: unknown = await client()
      .client.get('/start')
      .catch((error: unknown) => error);
    expect(destination).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).toContain('https://other.example.com');
    for (const secret of [apiKey, 'user', 'password', '/private', 'token', 'secret']) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it.each([301, 302, 303, 307, 308] as const)(
    'follows same-origin %i redirects with the key',
    async status => {
      backend.use(
        http.get(start, () => new HttpResponse(null, { status, headers: { location: '/next' } })),
        http.get(`${origin}/next`, ({ request }) =>
          HttpResponse.json({ key: request.headers.get('x-api-key') }),
        ),
      );
      await expect(client().client.get('/start')).resolves.toEqual({ key: apiKey });
    },
  );

  it.each([
    { method: 'POST', status: 301, expected: 'GET' },
    { method: 'POST', status: 302, expected: 'GET' },
    { method: 'POST', status: 303, expected: 'GET' },
    { method: 'PATCH', status: 303, expected: 'GET' },
    { method: 'post', status: 302, expected: 'GET' },
    { method: 'PATCH', status: 301, expected: 'PATCH' },
    { method: 'POST', status: 307, expected: 'POST' },
    { method: 'PATCH', status: 308, expected: 'PATCH' },
  ])('preserves fetch semantics for $method with $status', async ({ method, status, expected }) => {
    backend.use(
      http.all(start, () => new HttpResponse(null, { status, headers: { location: 'next' } })),
      http.all(`${origin}/api/cli/v1/next`, async ({ request }) =>
        HttpResponse.json({
          method: request.method,
          body: await request.text(),
          contentType: request.headers.get('content-type'),
          key: request.headers.get('x-api-key'),
          idempotencyKey: request.headers.get('idempotency-key'),
        }),
      ),
    );
    const body = { message: 'synthetic' };
    await expect(
      client().client.request(method, '/start', {
        body,
        headers: { 'idempotency-key': 'synthetic-operation' },
      }),
    ).resolves.toEqual({
      method: expected,
      body: expected === 'GET' ? '' : JSON.stringify(body),
      contentType: expected === 'GET' ? null : 'application/json',
      key: apiKey,
      idempotencyKey: 'synthetic-operation',
    });
  });

  it('bounds same-origin redirect loops without retrying', async () => {
    const redirect = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: start } }),
    );
    const sleep = vi.fn(async () => {});
    const api = new HttpClient({
      baseUrl: `${origin}/api/cli/v1`,
      apiKey,
      sleep,
      fetchImpl: redirect,
    });
    await expect(api.get('/start')).rejects.toBeInstanceOf(TransportError);
    expect(redirect).toHaveBeenCalledTimes(21);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects an invalid redirect target without retrying or echoing it', async () => {
    backend.use(
      http.get(
        start,
        () => new HttpResponse(null, { status: 302, headers: { location: 'https://[' } }),
      ),
    );
    const { client: api, sleep } = client();
    const error: unknown = await api.get('/start').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).not.toContain('https://[');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects same-origin URL credentials without forwarding or disclosing them', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://user:password@api.example.com/next' },
        }),
    );
    const api = new HttpClient({ baseUrl: origin, apiKey, fetchImpl });
    const error: unknown = await api.get('/start').catch((error: unknown) => error);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).toBe(`Refused redirect containing credentials at ${origin}.`);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('releases intermediate bodies and preserves request identity and signal across hops', async () => {
    const response = new Response('discard this redirect body', {
      status: 302,
      headers: { location: '/next' },
    });
    const cancel = vi.spyOn(response.body!, 'cancel');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const api = new HttpClient({ baseUrl: origin, apiKey, fetchImpl });
    await expect(api.get('/start', { requestId: 'synthetic-request' })).resolves.toEqual({
      ok: true,
    });
    expect(cancel).toHaveBeenCalledOnce();
    const initial = fetchImpl.mock.calls[0]![1]!;
    const next = fetchImpl.mock.calls[1]![1]!;
    expect(initial.redirect).toBe('manual');
    expect(next.redirect).toBe('manual');
    expect(next.signal).toBe(initial.signal);
    expect(new Headers(next.headers).get('x-request-id')).toBe('synthetic-request');
  });

  it('preserves a caller abort between redirect hops without retrying', async () => {
    const abort = new DOMException('Stopped', 'AbortError');
    const controller = new AbortController();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/next' } }))
      .mockImplementationOnce(async () => {
        controller.abort(abort);
        throw abort;
      });
    const sleep = vi.fn(async () => {});
    const api = new HttpClient({ baseUrl: origin, apiKey, fetchImpl, sleep });
    await expect(api.get('/start', { signal: controller.signal })).rejects.toBe(abort);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keeps timeout classification on a redirected request', async () => {
    const timeout = new RequestTimeoutError(1000, 'synthetic-request');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: '/next' } }))
      .mockRejectedValueOnce(timeout);
    const sleep = vi.fn(async () => {});
    const api = new HttpClient({ baseUrl: origin, apiKey, fetchImpl, sleep });
    await expect(api.get('/start')).rejects.toBe(timeout);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retains existing error handling for a redirect without a Location header', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302 }));
    const api = new HttpClient({ baseUrl: origin, apiKey, fetchImpl });
    const error: unknown = await api
      .get('/start', { retry: false })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ httpStatus: 302 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
