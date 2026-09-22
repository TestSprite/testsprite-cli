/**
 * `HttpClient` tunnel-facade methods (`POST/GET/DELETE /api/cli/v1/tunnel`).
 *
 * The assertions that carry weight here are about custody, not plumbing: the
 * mint is the ONE response that ever contains a secret, and everything else
 * about the surface exists to keep that secret from being copied anywhere —
 * so these tests pin "no Idempotency-Key on the mint" (the idempotency store
 * would otherwise retain the response body for its whole replay window) and
 * "no request body on delete".
 */

import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors.js';
import { HttpClient } from './http.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function makeClient(fetchImpl: typeof fetch): HttpClient {
  return new HttpClient({
    baseUrl: 'https://api.example.com/api/cli/v1',
    apiKey: 'sk-test',
    fetchImpl,
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
}

const MINT_BODY = {
  clientId: '11111111-2222-3333-4444-555555555555',
  secret: '99999999-8888-7777-6666-555555555555',
  controlUrl: 'ws://tunnel.example:7300/ws',
  tunnelAddr: 'tunnel.example:7400',
  expiresAt: '2026-08-24T18:00:00.000Z',
};

describe('HttpClient 204 handling', () => {
  it('rejects a schema-less generic DELETE response with no JSON body', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const caught = await makeClient(fetchImpl as unknown as typeof fetch)
      .delete<{ deletedAt: string }>('/tests/t1')
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({
      code: 'INTERNAL',
      exitCode: 1,
      httpStatus: 204,
      details: { httpStatus: 204 },
    });
    expect((caught as ApiError).message).toContain('non-JSON response');
  });
});

describe('HttpClient.mintTunnel', () => {
  it('POSTs /tunnel and returns the parsed mint envelope', async () => {
    let url = '';
    let init: RequestInit | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, i?: RequestInit) => {
      url = input.toString();
      init = i;
      return jsonResponse(MINT_BODY, { status: 201 });
    });
    const result = await makeClient(fetchImpl as unknown as typeof fetch).mintTunnel({});
    expect(url).toBe('https://api.example.com/api/cli/v1/tunnel');
    expect(init?.method).toBe('POST');
    expect(result).toEqual(MINT_BODY);
  });

  it('sends ttlSeconds when supplied and omits it otherwise', async () => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));
      return jsonResponse(MINT_BODY, { status: 201 });
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.mintTunnel({ ttlSeconds: 900 });
    await client.mintTunnel({});
    expect(bodies[0]).toEqual({ ttlSeconds: 900 });
    expect(bodies[1]).toEqual({});
  });

  it('does NOT send an Idempotency-Key — the store would retain the secret', async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      );
      return jsonResponse(MINT_BODY, { status: 201 });
    });
    await makeClient(fetchImpl as unknown as typeof fetch).mintTunnel({});
    expect(Object.keys(headers)).not.toContain('idempotency-key');
  });
});

describe('HttpClient.getTunnelStatus', () => {
  it('GETs /tunnel/{clientId} with the id encoded', async () => {
    let url = '';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      url = input.toString();
      return jsonResponse({
        clientId: 'a/b',
        status: 'online',
        expiresAt: '2026-08-24T18:00:00.000Z',
      });
    });
    const result = await makeClient(fetchImpl as unknown as typeof fetch).getTunnelStatus('a/b');
    expect(url).toBe('https://api.example.com/api/cli/v1/tunnel/a%2Fb');
    expect(result.status).toBe('online');
  });

  it('passes an unknown status value through instead of rejecting the response', async () => {
    // Resilience rule 2: a new server enum member must degrade, not hard-fail.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ clientId: 'c1', status: 'draining', expiresAt: '2026-08-24T18:00:00.000Z' }),
    );
    const result = await makeClient(fetchImpl as unknown as typeof fetch).getTunnelStatus('c1');
    expect(result.status).toBe('draining');
  });
});

describe('HttpClient.deleteTunnel', () => {
  it('accepts the documented 204 and DELETEs /tunnel/{clientId} with no request body', async () => {
    let url = '';
    let init: RequestInit | undefined;
    const fetchImpl = vi.fn(async (input: string | URL | Request, i?: RequestInit) => {
      url = input.toString();
      init = i;
      return new Response(null, { status: 204 });
    });
    await expect(
      makeClient(fetchImpl as unknown as typeof fetch).deleteTunnel('c1'),
    ).resolves.toBeUndefined();
    expect(url).toBe('https://api.example.com/api/cli/v1/tunnel/c1');
    expect(init?.method).toBe('DELETE');
    expect(init?.body ?? null).toBeNull();
  });
});
