import { afterEach, describe, expect, it, vi } from 'vitest';
import { FACADE_PATH, facadeBaseUrl, resolvePortalBase, resolvePortalUrl } from './facade.js';

describe('facadeBaseUrl', () => {
  it('appends the facade path to a bare host', () => {
    expect(facadeBaseUrl('https://api.testsprite.com')).toBe(
      `https://api.testsprite.com${FACADE_PATH}`,
    );
    expect(facadeBaseUrl('https://api.example.com:8443')).toBe(
      `https://api.example.com:8443${FACADE_PATH}`,
    );
  });

  it('strips a trailing slash before appending', () => {
    expect(facadeBaseUrl('https://api.testsprite.com/')).toBe(
      `https://api.testsprite.com${FACADE_PATH}`,
    );
  });

  it('passes through a URL that already ends in the facade path', () => {
    const full = `https://api.testsprite.com${FACADE_PATH}`;
    expect(facadeBaseUrl(full)).toBe(full);
  });
});

describe('resolvePortalUrl', () => {
  const PROJECT = 'proj_abc';
  const TEST = 'test_xyz';

  it('prod API URL → www.testsprite.com deep-link', () => {
    expect(resolvePortalUrl('https://api.testsprite.com', PROJECT, TEST)).toBe(
      `https://www.testsprite.com/dashboard/tests/${PROJECT}/test/${TEST}`,
    );
  });

  it('custom-port API URL without override → undefined (no built-in non-prod mapping)', () => {
    expect(resolvePortalUrl('https://api.example.com:8443', PROJECT, TEST)).toBeUndefined();
  });

  it('strips FACADE_PATH suffix before matching', () => {
    expect(resolvePortalUrl(`https://api.testsprite.com${FACADE_PATH}`, PROJECT, TEST)).toBe(
      `https://www.testsprite.com/dashboard/tests/${PROJECT}/test/${TEST}`,
    );
  });

  it('unknown API URL → undefined (mapping not known)', () => {
    expect(resolvePortalUrl('https://localhost:3001', PROJECT, TEST)).toBeUndefined();
    expect(resolvePortalUrl('http://localhost:13503', PROJECT, TEST)).toBeUndefined();
  });

  // R2: URL-semantics normalisation cases
  it('trailing slash on prod URL → normalised to prod portal', () => {
    expect(resolvePortalUrl('https://api.testsprite.com/', PROJECT, TEST)).toBe(
      `https://www.testsprite.com/dashboard/tests/${PROJECT}/test/${TEST}`,
    );
  });

  it('uppercase scheme+host → case-normalised to prod portal', () => {
    expect(resolvePortalUrl('HTTPS://API.testsprite.com', PROJECT, TEST)).toBe(
      `https://www.testsprite.com/dashboard/tests/${PROJECT}/test/${TEST}`,
    );
  });

  it('explicit :443 on https → treated as default port → prod portal', () => {
    expect(resolvePortalUrl('https://api.testsprite.com:443', PROJECT, TEST)).toBe(
      `https://www.testsprite.com/dashboard/tests/${PROJECT}/test/${TEST}`,
    );
  });

  it('http scheme on prod hostname → undefined (non-https)', () => {
    expect(resolvePortalUrl('http://api.testsprite.com', PROJECT, TEST)).toBeUndefined();
  });

  it('garbage string → undefined (URL parse failure, no crash)', () => {
    expect(resolvePortalUrl('not-a-url', PROJECT, TEST)).toBeUndefined();
    expect(resolvePortalUrl('', PROJECT, TEST)).toBeUndefined();
  });

  // R4: path segments are encodeURIComponent-encoded
  it('encodes special characters in projectId and testId path segments', () => {
    const result = resolvePortalUrl('https://api.testsprite.com', 'proj/a b', 'test#1');
    expect(result).toBe('https://www.testsprite.com/dashboard/tests/proj%2Fa%20b/test/test%231');
  });
});

describe('resolvePortalBase', () => {
  it('prod API URL → www origin (no path)', () => {
    expect(resolvePortalBase('https://api.testsprite.com')).toBe('https://www.testsprite.com');
    expect(resolvePortalBase('https://api.testsprite.com:443/')).toBe('https://www.testsprite.com');
  });

  it('custom-port API URL without override → undefined (no built-in non-prod mapping)', () => {
    expect(resolvePortalBase('https://api.example.com:8443')).toBeUndefined();
  });

  it('strips FACADE_PATH suffix before matching', () => {
    expect(resolvePortalBase(`https://api.testsprite.com${FACADE_PATH}`)).toBe(
      'https://www.testsprite.com',
    );
  });

  it('unknown host / non-https / garbage → undefined', () => {
    expect(resolvePortalBase('http://localhost:13502')).toBeUndefined();
    expect(resolvePortalBase('http://api.testsprite.com')).toBeUndefined();
    expect(resolvePortalBase('not-a-url')).toBeUndefined();
  });
});

describe('TESTSPRITE_PORTAL_URL override', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('override set → returned for any API URL (highest precedence)', () => {
    vi.stubEnv('TESTSPRITE_PORTAL_URL', 'https://portal.internal.example.com');
    expect(resolvePortalBase('https://api.example.com:8443')).toBe(
      'https://portal.internal.example.com',
    );
    expect(resolvePortalBase('https://api.testsprite.com')).toBe(
      'https://portal.internal.example.com',
    );
  });

  it('trailing slash on the override is stripped', () => {
    vi.stubEnv('TESTSPRITE_PORTAL_URL', 'https://portal.internal.example.com/');
    expect(resolvePortalBase('https://api.example.com:8443')).toBe(
      'https://portal.internal.example.com',
    );
  });

  it('override flows through resolvePortalUrl deep-links', () => {
    vi.stubEnv('TESTSPRITE_PORTAL_URL', 'https://portal.internal.example.com');
    expect(resolvePortalUrl('https://api.example.com:8443', 'proj_abc', 'test_xyz')).toBe(
      'https://portal.internal.example.com/dashboard/tests/proj_abc/test/test_xyz',
    );
  });

  it('invalid or non-http(s) override → undefined, never a guessed link', () => {
    vi.stubEnv('TESTSPRITE_PORTAL_URL', 'not-a-url');
    expect(resolvePortalBase('https://api.testsprite.com')).toBeUndefined();
    vi.stubEnv('TESTSPRITE_PORTAL_URL', 'ftp://portal.example.com');
    expect(resolvePortalBase('https://api.testsprite.com')).toBeUndefined();
  });

  it('empty/whitespace override → ignored, host mapping applies', () => {
    vi.stubEnv('TESTSPRITE_PORTAL_URL', '   ');
    expect(resolvePortalBase('https://api.testsprite.com')).toBe('https://www.testsprite.com');
  });

  it('reports invalid override url on stderr only in debug mode without altering output', () => {
    vi.stubEnv('TESTSPRITE_PORTAL_URL', 'not-a-url');
    const stderrDebug: string[] = [];
    const stderrNormal: string[] = [];

    const resultDebug = resolvePortalBase('https://api.testsprite.com', {
      debug: true,
      stderr: line => stderrDebug.push(line),
    });
    const resultNormal = resolvePortalBase('https://api.testsprite.com', {
      debug: false,
      stderr: line => stderrNormal.push(line),
    });
    const resultDefault = resolvePortalBase('https://api.testsprite.com');

    expect(resultDebug).toBeUndefined();
    expect(resultNormal).toBeUndefined();
    expect(resultDefault).toBeUndefined();
    expect(resultNormal).toEqual(resultDefault);
    expect(stderrDebug.some(l => l.includes('[debug] portal override url parse failed:'))).toBe(
      true,
    );
    expect(stderrNormal).toEqual([]);
  });

  it('reports invalid api url on stderr only in debug mode without altering output', () => {
    const stderrDebug: string[] = [];
    const stderrNormal: string[] = [];

    const resultDebug = resolvePortalBase('not a valid url', {
      debug: true,
      stderr: line => stderrDebug.push(line),
    });
    const resultNormal = resolvePortalBase('not a valid url', {
      debug: false,
      stderr: line => stderrNormal.push(line),
    });
    const resultDefault = resolvePortalBase('not a valid url');

    expect(resultDebug).toBeUndefined();
    expect(resultNormal).toBeUndefined();
    expect(resultDefault).toBeUndefined();
    expect(resultNormal).toEqual(resultDefault);
    expect(stderrDebug.some(l => l.includes('[debug] portal api url parse failed:'))).toBe(true);
    expect(stderrNormal).toEqual([]);
  });
});
