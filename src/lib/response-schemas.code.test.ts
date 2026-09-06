import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { testCodeFixture, testCodeLargeFixture } from '../../test/mock-backend/fixtures.js';
import { CLI_TEST_CODE_SCHEMA } from './response-schemas.js';

describe('CLI_TEST_CODE_SCHEMA', () => {
  it.each([testCodeFixture, testCodeLargeFixture])('preserves a complete source fixture', body => {
    expect(v.parse(CLI_TEST_CODE_SCHEMA, body)).toEqual(body);
  });

  it('accepts an omitted framework on the code-put legacy auto-fetch shape', () => {
    const body = { testId: 'test_alpha', language: 'typescript', code: 'old', codeVersion: null };
    expect(v.parse(CLI_TEST_CODE_SCHEMA, body)).toEqual(body);
  });

  it('normalizes an absent legacy codeVersion to null without inventing an etag', () => {
    const body = { testId: 'test_alpha', language: 'python', code: '' };
    const parsed = v.parse(CLI_TEST_CODE_SCHEMA, body);
    expect(parsed.codeVersion).toBeNull();
    expect(parsed).not.toHaveProperty('etag');
    expect(parsed).not.toHaveProperty('framework');
  });

  it('preserves explicit null etag and code from a draft row', () => {
    const body = { ...testCodeFixture, code: null, etag: null };
    expect(v.parse(CLI_TEST_CODE_SCHEMA, body)).toEqual(body);
  });

  it.each([
    null,
    [],
    { ...testCodeFixture, testId: 7 },
    { ...testCodeFixture, language: false },
    { ...testCodeFixture, framework: [] },
    { ...testCodeFixture, code: undefined },
    { ...testCodeFixture, codeVersion: 7 },
    { ...testCodeFixture, etag: {} },
  ])('rejects an incompatible response shape', body => {
    expect(v.safeParse(CLI_TEST_CODE_SCHEMA, body).success).toBe(false);
  });
});
