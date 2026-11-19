import { describe, expect, it } from 'vitest';
import { createDryRunFetch, withDryRunBannerOnce } from './fetch.js';

describe('createDryRunFetch', () => {
  const fetch = createDryRunFetch();

  it('returns 200 + JSON for a known endpoint', async () => {
    const res = await fetch('https://api.testsprite.com/api/cli/v1/me');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-request-id')).toBe('req_dry-run');
    const body = (await res.json()) as { userId: string };
    expect(body.userId).toBeTruthy();
  });

  it('returns 500 INTERNAL envelope for an unknown endpoint', async () => {
    const res = await fetch('https://api.testsprite.com/api/cli/v1/nope');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; nextAction: string } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.nextAction).toContain('samples.ts');
  });

  it('accepts a Request object as input', async () => {
    const req = new Request('https://api.testsprite.com/api/cli/v1/projects');
    const res = await fetch(req);
    expect(res.status).toBe(200);
  });

  it('accepts a URL object as input', async () => {
    const url = new URL('https://api.testsprite.com/api/cli/v1/projects');
    const res = await fetch(url);
    expect(res.status).toBe(200);
  });

  it('routes by method (POST /projects returns 200 because createProject sample exists)', async () => {
    const res = await fetch('https://api.testsprite.com/api/cli/v1/projects', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  it('routes by method (DELETE /projects returns 500 because no sample exists)', async () => {
    const res = await fetch('https://api.testsprite.com/api/cli/v1/projects', {
      method: 'DELETE',
    });
    expect(res.status).toBe(500);
  });

  it('ignores query strings when matching', async () => {
    const res = await fetch('https://api.testsprite.com/api/cli/v1/projects?pageSize=2');
    expect(res.status).toBe(200);
  });

  it('withDryRunBannerOnce fires exactly once, after the first returned response', async () => {
    // Issue #360: the banner must print the first time a dry-run request
    // actually returns a canned sample — not at client setup, and at most
    // once per command run.
    let calls = 0;
    const wrapped = withDryRunBannerOnce(createDryRunFetch(), () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    const first = await wrapped('https://api.testsprite.com/api/cli/v1/me');
    expect(first.status).toBe(200);
    expect(calls).toBe(1);
    await wrapped('https://api.testsprite.com/api/cli/v1/projects');
    expect(calls).toBe(1);
  });

  it('withDryRunBannerOnce wraps an injected fetch the same way', async () => {
    // An injected test fetch must announce the dry-run just like the
    // default canned fetch does.
    let calls = 0;
    const injected = async () => new Response('{"ok":true}', { status: 200 });
    const wrapped = withDryRunBannerOnce(injected as typeof fetch, () => {
      calls += 1;
    });
    const res = await wrapped('https://example.test/anything');
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
    await wrapped('https://example.test/anything-else');
    expect(calls).toBe(1);
  });

  it('withDryRunBannerOnce does not fire when the wrapped fetch rejects', async () => {
    // A failed request produces no dry-run response, so nothing is announced.
    let calls = 0;
    const failing = async () => {
      throw new Error('boom');
    };
    const wrapped = withDryRunBannerOnce(failing as typeof fetch, () => {
      calls += 1;
    });
    await expect(wrapped('https://example.test/anything')).rejects.toThrow('boom');
    expect(calls).toBe(0);
  });
});
