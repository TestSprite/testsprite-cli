import { describe, expect, it } from 'vitest';
import { isValidRepoSlug, parseRepoSlug } from './ci-linkage.js';

describe('parseRepoSlug', () => {
  it('reads the three remote shapes a cloned repo actually carries', () => {
    expect(parseRepoSlug('git@github.com:acme/storefront.git')).toBe('acme/storefront');
    expect(parseRepoSlug('https://github.com/acme/storefront.git')).toBe('acme/storefront');
    expect(parseRepoSlug('ssh://git@github.com/acme/storefront')).toBe('acme/storefront');
    expect(parseRepoSlug('  https://github.com/acme/storefront/  \n')).toBe('acme/storefront');
    expect(parseRepoSlug('https://x-access-token:tok@github.com/acme/storefront.git')).toBe(
      'acme/storefront',
    );
  });

  it('returns null for non-GitHub remotes', () => {
    expect(parseRepoSlug('git@gitlab.com:acme/storefront.git')).toBeNull();
    expect(parseRepoSlug('https://bitbucket.org/acme/storefront.git')).toBeNull();
    expect(parseRepoSlug('')).toBeNull();
  });

  it('refuses a slug carrying path or flag syntax', () => {
    expect(parseRepoSlug('git@github.com:acme/store front.git')).toBeNull();
    expect(parseRepoSlug('https://github.com/acme/../../etc')).toBeNull();
  });
});

describe('isValidRepoSlug', () => {
  it('accepts what GitHub allows in owner/repo names', () => {
    expect(isValidRepoSlug('acme/storefront')).toBe(true);
    expect(isValidRepoSlug('acme-inc/store.front_2')).toBe(true);
  });

  it('refuses `.`/`..` segments the character class alone admits', () => {
    expect(isValidRepoSlug('../..')).toBe(false);
    expect(isValidRepoSlug('./repo')).toBe(false);
    expect(isValidRepoSlug('owner/..')).toBe(false);
  });

  it('refuses shapes that are not exactly owner/name', () => {
    expect(isValidRepoSlug('acme')).toBe(false);
    expect(isValidRepoSlug('acme/store/front')).toBe(false);
    expect(isValidRepoSlug('acme/store front')).toBe(false);
  });
});
