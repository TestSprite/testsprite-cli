import { describe, expect, it } from 'vitest';
import { createRedactor, redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  describe('API keys (sk- prefix)', () => {
    it('redacts TestSprite API keys', () => {
      const input = 'Using key sk-abcdef1234567890abcdef';
      expect(redactSecrets(input)).toBe('Using key [REDACTED:api-key]');
    });

    it('redacts API keys embedded in config lines', () => {
      const input = 'api_key = sk-abcdef1234567890abcdef1234';
      expect(redactSecrets(input)).toBe('api_key = [REDACTED:api-key]');
    });

    it('does not redact short sk- prefixes (< 20 chars)', () => {
      const input = 'sk-short';
      expect(redactSecrets(input)).toBe('sk-short');
    });

    it('redacts multiple keys in one string', () => {
      const input = 'key1=sk-aaaabbbbccccddddeeeeffffgggg key2=sk-11112222333344445555666677778888';
      const result = redactSecrets(input);
      expect(result).not.toContain('sk-aaaa');
      expect(result).not.toContain('sk-1111');
      expect(result.match(/\[REDACTED:api-key\]/g)).toHaveLength(2);
    });
  });

  describe('bearer tokens', () => {
    it('redacts Bearer authorization headers', () => {
      const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
      expect(redactSecrets(input)).toBe('Authorization: [REDACTED:bearer-token]');
    });

    it('is case-insensitive for bearer keyword', () => {
      const input = 'bearer abcdefghijklmnopqrstuvwxyz1234';
      expect(redactSecrets(input)).toBe('[REDACTED:bearer-token]');
    });
  });

  describe('token patterns', () => {
    it('redacts token= assignments', () => {
      const input = 'token=abc123def456ghi789jkl012mno345';
      expect(redactSecrets(input)).toBe('[REDACTED:token]');
    });

    it('redacts access_token values', () => {
      const input = 'access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"';
      expect(redactSecrets(input)).toBe('[REDACTED:token]');
    });

    it('redacts refresh_token values', () => {
      const input = "refresh_token='abc123def456ghi789jkl012mno345pqr'";
      expect(redactSecrets(input)).toBe('[REDACTED:token]');
    });
  });

  describe('URL passwords', () => {
    it('redacts password in URL while preserving structure', () => {
      const input = 'https://admin:supersecretpassword@db.example.com:5432/mydb';
      const result = redactSecrets(input);
      expect(result).toContain('admin');
      expect(result).toContain('[REDACTED:url-password]');
      expect(result).toContain('db.example.com');
      expect(result).not.toContain('supersecretpassword');
    });

    it('redacts password in multiple URLs', () => {
      const input = 'db=postgres://user:pass123@host1 cache=redis://app:secret456@host2';
      const result = redactSecrets(input);
      expect(result).not.toContain('pass123');
      expect(result).not.toContain('secret456');
    });

    it('handles username that is a substring of the password pattern', () => {
      const input = 'redis://adminpass:realpassword@cache.internal:6379';
      const result = redactSecrets(input);
      expect(result).toContain('adminpass');
      expect(result).toContain('[REDACTED:url-password]');
      expect(result).not.toContain('realpassword');
    });
  });

  describe('AWS keys', () => {
    it('redacts AWS access key IDs', () => {
      const input = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
      expect(redactSecrets(input)).toBe('AWS_ACCESS_KEY_ID=[REDACTED:aws-key]');
    });
  });

  describe('GitHub tokens', () => {
    it('redacts ghp_ personal access tokens', () => {
      const input = 'GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn';
      expect(redactSecrets(input)).toBe('GITHUB_TOKEN=[REDACTED:github-token]');
    });

    it('redacts gho_ OAuth tokens', () => {
      const input = 'token=gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn';
      // token= pattern may match first, but the key point is no token leaks
      const result = redactSecrets(input);
      expect(result).not.toContain('gho_ABCDEF');
    });
  });

  describe('hex secrets', () => {
    it('redacts 32+ char hex strings', () => {
      const input = 'hash=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
      expect(redactSecrets(input)).toContain('[REDACTED:hex-secret]');
    });

    it('does not redact short hex strings', () => {
      const input = 'short=abcdef123456';
      expect(redactSecrets(input)).toBe('short=abcdef123456');
    });

    it('redacts uppercase hex strings', () => {
      const input = 'hash=A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4';
      expect(redactSecrets(input)).toContain('[REDACTED:hex-secret]');
    });

    it('redacts mixed-case hex strings', () => {
      const input = 'hash=a1B2c3D4e5F6a1B2c3D4e5F6a1B2c3D4';
      expect(redactSecrets(input)).toContain('[REDACTED:hex-secret]');
    });
  });

  describe('edge cases', () => {
    it('returns empty string unchanged', () => {
      expect(redactSecrets('')).toBe('');
    });

    it('returns non-secret text unchanged', () => {
      const input = 'Running test suite for project checkout-flow...';
      expect(redactSecrets(input)).toBe(input);
    });

    it('is idempotent — redacting twice gives the same result', () => {
      const input = 'key=sk-abcdef1234567890abcdef';
      const once = redactSecrets(input);
      const twice = redactSecrets(once);
      expect(twice).toBe(once);
    });

    it('handles multiline input', () => {
      const input = [
        'config loaded',
        'api_key = sk-abcdef1234567890abcdef',
        'endpoint = https://api.testsprite.com',
      ].join('\n');
      const result = redactSecrets(input);
      expect(result).toContain('[REDACTED:api-key]');
      expect(result).toContain('https://api.testsprite.com');
    });
  });
});

describe('createRedactor', () => {
  it('applies custom patterns before defaults', () => {
    const redact = createRedactor([{ name: 'internal-key', regex: /\bINT-[A-Za-z0-9]{24,}\b/g }]);
    const input = 'key=INT-abcdefghijklmnopqrstuvwx';
    expect(redact(input)).toBe('key=[REDACTED:internal-key]');
  });

  it('still applies default patterns', () => {
    const redact = createRedactor([]);
    const input = 'key=sk-abcdef1234567890abcdef';
    expect(redact(input)).toBe('key=[REDACTED:api-key]');
  });

  it('custom patterns take priority over defaults', () => {
    const redact = createRedactor([{ name: 'custom-sk', regex: /\bsk-[A-Za-z0-9]+\b/g }]);
    // Custom runs first and catches the key
    const input = 'key=sk-abcdef1234567890abcdef';
    expect(redact(input)).toBe('key=[REDACTED:custom-sk]');
  });
});
