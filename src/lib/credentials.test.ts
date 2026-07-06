import { mkdtempSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROFILE,
  assertValidProfileName,
  defaultCredentialsPath,
  deleteProfile,
  ensureRestrictiveMode,
  parseCredentials,
  readCredentialsFile,
  readProfile,
  serializeCredentials,
  writeProfile,
} from './credentials.js';
import { ApiError } from './errors.js';

let tmpRoot: string;
let credentialsPath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'testsprite-creds-'));
  credentialsPath = join(tmpRoot, 'credentials');
});

afterEach(() => {
  // mkdtempSync directory is small and short-lived; OS cleans it up.
  // Tests intentionally do not rely on cleanup ordering.
});

describe('parseCredentials', () => {
  it('returns empty for empty input', () => {
    expect(parseCredentials('')).toEqual({});
  });

  it('parses a single profile', () => {
    const file = parseCredentials(`[default]\napi_key = sk-test\napi_url = https://example.com\n`);
    expect(file).toEqual({
      default: { apiKey: 'sk-test', apiUrl: 'https://example.com' },
    });
  });

  it('parses multiple profiles and ignores comments and blanks', () => {
    const content = `
# top-level comment
[default]
api_key = sk-default

; semicolon comment
[dev]
api_key = sk-dev
api_url = https://api.example.com:8443
`;
    expect(parseCredentials(content)).toEqual({
      default: { apiKey: 'sk-default' },
      dev: { apiKey: 'sk-dev', apiUrl: 'https://api.example.com:8443' },
    });
  });

  it('ignores unknown keys and key-value lines outside any section', () => {
    const content = `
api_key = orphan
[default]
api_key = sk-real
unknown_key = ignored
`;
    expect(parseCredentials(content)).toEqual({ default: { apiKey: 'sk-real' } });
  });
});

describe('serializeCredentials', () => {
  it('round-trips with default profile first', () => {
    const file = {
      zeta: { apiKey: 'sk-z' },
      default: { apiKey: 'sk-d', apiUrl: 'https://example.com' },
      alpha: { apiKey: 'sk-a' },
    };
    const text = serializeCredentials(file);
    expect(text.startsWith('[default]')).toBe(true);
    expect(text).toContain('[alpha]');
    expect(text).toContain('[zeta]');
    expect(parseCredentials(text)).toEqual(file);
  });

  it('omits empty fields', () => {
    const text = serializeCredentials({ default: { apiKey: 'sk', apiUrl: '' } });
    expect(text).toContain('api_key = sk');
    expect(text).not.toContain('api_url');
  });

  it('strips newline characters from values to prevent INI injection', () => {
    // A malicious apiUrl with embedded newlines could inject new key-value
    // pairs or section headers into the credentials file. The serializer
    // must strip \n and \r so the written file has exactly one value per
    // field and no injected content parsed as separate keys/sections.
    const malicious = 'https://evil.com\napi_key = sk-HIJACKED\n[admin]\napi_key = sk-admin';
    const text = serializeCredentials({ default: { apiKey: 'sk-real', apiUrl: malicious } });
    // The output must NOT contain a standalone [admin] section header
    // (it would be on its own line if injection succeeded)
    const lines = text.split('\n');
    // Only one section header exists: [default]
    const sectionHeaders = lines.filter(l => /^\[.+\]$/.test(l.trim()));
    expect(sectionHeaders).toEqual(['[default]']);
    // Only one api_key line exists (the real one, not an injected duplicate)
    const apiKeyLines = lines.filter(l => l.trim().startsWith('api_key'));
    expect(apiKeyLines).toHaveLength(1);
    expect(apiKeyLines[0]).toContain('sk-real');
    // Round-trip: reading back must return only the real key, not the injected one
    const parsed = parseCredentials(text);
    expect(parsed['default']?.apiKey).toBe('sk-real');
    expect(parsed['admin']).toBeUndefined();
  });

  it('strips \\r\\n (CRLF) injection from values', () => {
    const text = serializeCredentials({ default: { apiUrl: 'https://x.com\r\napi_key = pwned' } });
    const parsed = parseCredentials(text);
    // The injected api_key must NOT be parsed as a real key
    expect(parsed['default']?.apiKey).toBeUndefined();
    // The api_url value is on one line (newlines stripped)
    expect(parsed['default']?.apiUrl).toContain('https://x.com');
  });
});

describe('readCredentialsFile / readProfile', () => {
  it('returns empty when file is missing', () => {
    expect(readCredentialsFile({ path: credentialsPath })).toEqual({});
    expect(readProfile('default', { path: credentialsPath })).toBeUndefined();
  });

  it('reads an existing file', () => {
    mkdirSync(tmpRoot, { recursive: true });
    writeFileSync(credentialsPath, '[default]\napi_key = sk-x\n');
    expect(readProfile('default', { path: credentialsPath })).toEqual({ apiKey: 'sk-x' });
  });
});

describe('writeProfile', () => {
  it('creates the file with mode 0600 and writes the profile', () => {
    writeProfile(DEFAULT_PROFILE, { apiKey: 'sk-new' }, { path: credentialsPath });
    expect(existsSync(credentialsPath)).toBe(true);
    const mode = statSync(credentialsPath).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readProfile(DEFAULT_PROFILE, { path: credentialsPath })).toEqual({ apiKey: 'sk-new' });
  });

  it('preserves other profiles when updating one', () => {
    writeProfile('default', { apiKey: 'sk-d' }, { path: credentialsPath });
    writeProfile('dev', { apiKey: 'sk-dev', apiUrl: 'https://dev' }, { path: credentialsPath });
    writeProfile('default', { apiUrl: 'https://prod' }, { path: credentialsPath });

    const file = readCredentialsFile({ path: credentialsPath });
    expect(file.default).toEqual({ apiKey: 'sk-d', apiUrl: 'https://prod' });
    expect(file.dev).toEqual({ apiKey: 'sk-dev', apiUrl: 'https://dev' });
  });

  it('does not leak the api key into the on-disk file format aside from the value itself', () => {
    writeProfile('default', { apiKey: 'sk-secret-12345' }, { path: credentialsPath });
    const onDisk = readFileSync(credentialsPath, 'utf-8');
    expect(onDisk).toContain('api_key = sk-secret-12345');
    expect(onDisk.split('\n').filter(line => line.includes('sk-secret-12345'))).toHaveLength(1);
  });
});

describe('deleteProfile', () => {
  it('returns false when the profile is missing', () => {
    expect(deleteProfile('nope', { path: credentialsPath })).toBe(false);
  });

  it('removes the named profile and leaves others intact', () => {
    writeProfile('default', { apiKey: 'sk-d' }, { path: credentialsPath });
    writeProfile('dev', { apiKey: 'sk-dev' }, { path: credentialsPath });
    expect(deleteProfile('dev', { path: credentialsPath })).toBe(true);
    expect(readProfile('dev', { path: credentialsPath })).toBeUndefined();
    expect(readProfile('default', { path: credentialsPath })).toEqual({ apiKey: 'sk-d' });
  });

  it('leaves an empty file when the last profile is removed', () => {
    writeProfile('default', { apiKey: 'sk-d' }, { path: credentialsPath });
    expect(deleteProfile('default', { path: credentialsPath })).toBe(true);
    expect(readCredentialsFile({ path: credentialsPath })).toEqual({});
    expect(existsSync(credentialsPath)).toBe(true);
  });
});

describe('ensureRestrictiveMode', () => {
  it('is a no-op when the file is missing', () => {
    expect(() => ensureRestrictiveMode(credentialsPath)).not.toThrow();
  });

  it('downgrades over-permissive modes', () => {
    mkdirSync(tmpRoot, { recursive: true });
    writeFileSync(credentialsPath, 'data', { mode: 0o644 });
    ensureRestrictiveMode(credentialsPath);
    const mode = statSync(credentialsPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('defaultCredentialsPath', () => {
  it('points at ~/.testsprite/credentials', () => {
    expect(defaultCredentialsPath().endsWith('/.testsprite/credentials')).toBe(true);
  });
});

describe('assertValidProfileName / profile-name guard', () => {
  it('accepts conventional profile names', () => {
    for (const name of ['default', 'dev', 'prod', 'ci-staging', 'team.qa', 'a_b', 'P1']) {
      expect(() => assertValidProfileName(name)).not.toThrow();
    }
  });

  it('rejects names that would corrupt the INI file, with a VALIDATION_ERROR (exit 5)', () => {
    // `prod]` -> `[prod]]` (unreadable); newline splits the header; padded
    // names do not round-trip (the parser trims section names); empty is not a
    // valid section.
    for (const name of ['prod]', '[weird', 'a\nb', '  spaced  ', 'has space', '', 'a/b']) {
      let caught: unknown;
      try {
        assertValidProfileName(name);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      const apiErr = caught as ApiError;
      expect(apiErr.code).toBe('VALIDATION_ERROR');
      expect(apiErr.exitCode).toBe(5);
      expect(apiErr.nextAction).toContain('profile');
    }
  });

  it('writeProfile rejects a malformed name and does NOT create the file', () => {
    expect(() => writeProfile('prod]', { apiKey: 'sk-1' }, { path: credentialsPath })).toThrow(
      ApiError,
    );
    expect(existsSync(credentialsPath)).toBe(false);
  });

  it('readProfile and deleteProfile reject a malformed name', () => {
    expect(() => readProfile('a\nb', { path: credentialsPath })).toThrow(ApiError);
    expect(() => deleteProfile('a\nb', { path: credentialsPath })).toThrow(ApiError);
  });
});
