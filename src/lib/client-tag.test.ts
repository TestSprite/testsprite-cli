import { describe, expect, it } from 'vitest';
import { buildUserAgent, CLIENT_TAG_ENV, resolveClientTag } from './client-tag.js';
import { VERSION } from '../version.js';

describe('resolveClientTag', () => {
  it('accepts a well-formed <name>/<version> tag', () => {
    expect(resolveClientTag({ [CLIENT_TAG_ENV]: 'github-action/v1' })).toBe('github-action/v1');
    expect(resolveClientTag({ [CLIENT_TAG_ENV]: 'github-action/1.2.0' })).toBe(
      'github-action/1.2.0',
    );
    expect(resolveClientTag({ [CLIENT_TAG_ENV]: 'ci/abc123+build_7' })).toBe('ci/abc123+build_7');
  });

  it('returns undefined when the variable is unset', () => {
    expect(resolveClientTag({})).toBeUndefined();
  });

  it.each([
    ['', 'empty'],
    ['github-action', 'no slash'],
    ['Github-Action/v1', 'uppercase name'],
    ['github action/v1', 'space in name'],
    ['github-action/v 1', 'space in version'],
    ['github-action/v1)', 'header-breaking paren'],
    ['github-action/v1\n', 'trailing newline'],
    ['-github/v1', 'leading dash'],
    ['a/b/c', 'extra slash'],
    [`${'a'.repeat(33)}/v1`, 'name too long'],
    [`x/${'1'.repeat(41)}`, 'version too long'],
  ])('rejects %j (%s) silently', raw => {
    expect(resolveClientTag({ [CLIENT_TAG_ENV]: raw })).toBeUndefined();
  });

  it('accepts the maximum lengths exactly', () => {
    const tag = `${'a'.repeat(32)}/${'1'.repeat(40)}`;
    expect(resolveClientTag({ [CLIENT_TAG_ENV]: tag })).toBe(tag);
  });
});

describe('buildUserAgent', () => {
  it('is byte-identical to the historical UA when the tag is absent', () => {
    expect(buildUserAgent({})).toBe(`testsprite-cli/${VERSION}`);
  });

  it('appends the validated tag in parentheses', () => {
    expect(buildUserAgent({ [CLIENT_TAG_ENV]: 'github-action/v1' })).toBe(
      `testsprite-cli/${VERSION} (github-action/v1)`,
    );
  });

  it('ignores an invalid tag (UA unchanged, value never echoed)', () => {
    const ua = buildUserAgent({ [CLIENT_TAG_ENV]: 'evil (injected)' });
    expect(ua).toBe(`testsprite-cli/${VERSION}`);
    expect(ua).not.toContain('evil');
  });
});
