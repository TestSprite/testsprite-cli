import { describe, expect, it } from 'vitest';
import { createDryRunFetch } from './fetch.js';

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

  it('fires onFirstRequest exactly once, on the first request', async () => {
    let calls = 0;
    const cbFetch = createDryRunFetch(() => {
      calls += 1;
    });
    expect(calls).toBe(0);
    await cbFetch('https://api.testsprite.com/api/cli/v1/me');
    expect(calls).toBe(1);
    await cbFetch('https://api.testsprite.com/api/cli/v1/projects');
    expect(calls).toBe(1);
  });
});
