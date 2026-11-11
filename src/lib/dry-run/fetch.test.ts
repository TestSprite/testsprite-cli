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

  it('reports unparseable body on stderr only in debug mode without altering output', async () => {
    const stderrDebug: string[] = [];
    const stderrNormal: string[] = [];

    const fetchDebug = createDryRunFetch({
      debug: true,
      stderr: line => stderrDebug.push(line),
    });
    const fetchNormal = createDryRunFetch({
      debug: false,
      stderr: line => stderrNormal.push(line),
    });
    const fetchDefault = createDryRunFetch();

    const invalidBody = '{ invalid json';
    const resDebug = await fetchDebug('https://api.testsprite.com/api/cli/v1/projects', {
      method: 'POST',
      body: invalidBody,
    });
    const resNormal = await fetchNormal('https://api.testsprite.com/api/cli/v1/projects', {
      method: 'POST',
      body: invalidBody,
    });
    const resDefault = await fetchDefault('https://api.testsprite.com/api/cli/v1/projects', {
      method: 'POST',
      body: invalidBody,
    });

    const bodyDebug = await resDebug.text();
    const bodyNormal = await resNormal.text();
    const bodyDefault = await resDefault.text();

    expect(resDebug.status).toBe(200);
    expect(resNormal.status).toBe(200);
    expect(resDefault.status).toBe(200);
    expect(bodyNormal).toBe(bodyDefault);
    expect(bodyDebug).toBe(bodyDefault);
    expect(stderrDebug.some(l => l.includes('[debug] dry-run request body parse failed:'))).toBe(
      true,
    );
    expect(stderrNormal).toEqual([]);
  });
});
