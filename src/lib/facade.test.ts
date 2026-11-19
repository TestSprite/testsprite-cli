import { afterEach, describe, expect, it, vi } from 'vitest';
import { FACADE_PATH, facadeBaseUrl, resolvePortalBase } from './facade.js';

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
    expect(resolvePortalBase('')).toBeUndefined();
  });

  it('uppercase scheme+host → case-normalised to prod portal', () => {
    expect(resolvePortalBase('HTTPS://API.testsprite.com')).toBe('https://www.testsprite.com');
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
});
