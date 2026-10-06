import { describe, expect, it } from 'vitest';
import { REDACTED, redactDeep } from './redact.js';

describe('redactDeep', () => {
  it('redacts a top-level secret key', () => {
    expect(redactDeep({ password: 'hunter2' })).toEqual({ password: REDACTED });
  });

  it('redacts nested secret keys at any depth, arrays included', () => {
    const input = {
      ok: true,
      credentials: { password: 'hunter2', apiKey: 'sk-live-should-not-leak' },
      rows: [{ token: 'tok_1' }, { authorization: 'Bearer abc.def.ghi' }],
    };
    expect(redactDeep(input)).toEqual({
      ok: true,
      credentials: { password: REDACTED, apiKey: REDACTED },
      rows: [{ token: REDACTED }, { authorization: REDACTED }],
    });
  });

  it('matches password/token/secret/apiKey/api_key/authorization/cookie/credential case-insensitively', () => {
    const input = {
      Password: 'a',
      TOKEN: 'b',
      Secret: 'c',
      apiKey: 'd',
      api_key: 'e',
      Authorization: 'f',
      Cookie: 'g',
      Credential: 'h',
    };
    for (const value of Object.values(redactDeep(input))) {
      expect(value).toBe(REDACTED);
    }
  });

  it('matches realistic compound key names (suffix match)', () => {
    expect(redactDeep({ refreshToken: 'rt-1', clientSecret: 'cs-1', 'x-api-key': 'k-1' })).toEqual({
      refreshToken: REDACTED,
      clientSecret: REDACTED,
      'x-api-key': REDACTED,
    });
  });

  it('does not redact username or environment names', () => {
    const input = { username: 'qa+demo@example.com', environment: { name: 'production' } };
    expect(redactDeep(input)).toEqual(input);
  });

  it('does not redact a boolean presence flag even though its name contains "credentials"', () => {
    // CliProjectEnvironment.hasCredentials is a presence flag, not a secret.
    expect(redactDeep({ hasCredentials: true })).toEqual({ hasCredentials: true });
  });

  it('does not redact a structured object under a `secret`-named key — only string leaves', () => {
    // `ci init`'s JSON output shape: `secret: {name, attempted, set, reason}`
    // describes metadata ABOUT a secret, never its value.
    const input = {
      secret: { name: 'TESTSPRITE_API_KEY', attempted: true, set: true, reason: null },
    };
    expect(redactDeep(input)).toEqual(input);
  });

  it('does not redact a path or URL field that merely contains the word "token"', () => {
    expect(redactDeep({ tokenPath: '/tmp/token.txt', tokenEndpoint: 'https://x/token' })).toEqual({
      tokenPath: '/tmp/token.txt',
      tokenEndpoint: 'https://x/token',
    });
  });

  it('does not redact details.field even when its value is literally "password"', () => {
    // localValidationError's convention: details.field names WHICH flag failed.
    // The key ("field") doesn't match, so the value must survive regardless
    // of what it happens to say.
    expect(redactDeep({ field: 'password' })).toEqual({ field: 'password' });
  });

  it('redacts a Bearer token embedded in a free-form string regardless of key name', () => {
    const input = { message: 'Rejected: Authorization Bearer abc123XYZ_token was invalid' };
    const result = redactDeep(input) as { message: string };
    expect(result.message).not.toContain('abc123XYZ_token');
    expect(result.message).toContain(`Bearer ${REDACTED}`);
  });

  it('does not redact pagination continuation handles that happen to end in "Token"', () => {
    // `nextToken` / `startingToken` are opaque pagination cursors (`test
    // list`, `project list`), not auth tokens. A bare suffix match on
    // "token" would blank them — this caught a real regression in
    // `project.test.ts` (`nextToken: still-more` became `[REDACTED]`).
    const input = { nextToken: 'still-more', startingToken: 'abc', nextCursor: 'xyz' };
    expect(redactDeep(input)).toEqual(input);
  });

  it('does not redact prose that mentions Bearer authentication', () => {
    const text = 'Verify the request includes a Bearer authentication header and returns 200';
    expect(redactDeep({ description: text })).toEqual({ description: text });
  });

  it('does not redact a hyphenated non-token phrase with a separator but no digit', () => {
    // The lookahead used to accept ANY separator (a hyphen, a dot, …) as
    // proof of a token-shaped run, so "token-based" (all letters + one
    // hyphen, no digit) matched the {8,} scan and swallowed the whole
    // word — see the digit-only assertion below and `BEARER_TOKEN_RE`'s
    // own doc comment.
    const text = 'Set the header to Bearer token-based auth.';
    expect(redactDeep({ message: text })).toEqual({ message: text });
  });

  it('keeps user-defined environment variables verbatim, whatever their names', () => {
    const variables = {
      DB_PASSWORD: 'fixture-pw',
      API_SECRET: 'abc',
      SESSION_TOKEN: 'z',
      REGION: 'west',
    };
    expect(redactDeep({ environment: { name: 'staging', variables } })).toEqual({
      environment: { name: 'staging', variables },
    });
  });

  it('never mutates the input', () => {
    const input = { password: 'hunter2' };
    redactDeep(input);
    expect(input).toEqual({ password: 'hunter2' });
  });
});
