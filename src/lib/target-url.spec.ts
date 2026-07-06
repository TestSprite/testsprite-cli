/**
 * Unit tests for `assertNotLocal` — CLI-side target-url pre-flight guard.
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from './errors.js';
import { assertNotLocal } from './target-url.js';

/** Helper: assert that assertNotLocal throws VALIDATION_ERROR for `url`. */
function expectBlocked(url: string): void {
  expect(() => assertNotLocal(url)).toThrow(ApiError);
  try {
    assertNotLocal(url);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('VALIDATION_ERROR');
  }
}

/** Helper: assert that assertNotLocal succeeds (does not throw) for `url`. */
function expectAllowed(url: string): void {
  expect(() => assertNotLocal(url)).not.toThrow();
}

describe('assertNotLocal — scheme checks', () => {
  it('allows http:// scheme', () => {
    expectAllowed('http://example.com/app');
  });

  it('allows https:// scheme', () => {
    expectAllowed('https://example.com/app');
  });

  it('blocks ftp:// scheme', () => {
    expectBlocked('ftp://example.com/file');
  });

  it('blocks file:// scheme', () => {
    expectBlocked('file:///etc/passwd');
  });

  it('blocks ws:// scheme', () => {
    expectBlocked('ws://example.com');
  });

  it('blocks wss:// scheme', () => {
    expectBlocked('wss://example.com');
  });

  it('throws VALIDATION_ERROR for unparseable string', () => {
    expectBlocked('not-a-url');
  });

  it('throws VALIDATION_ERROR for empty string', () => {
    expectBlocked('');
  });
});

describe('assertNotLocal — localhost', () => {
  it('blocks http://localhost', () => {
    expectBlocked('http://localhost');
  });

  it('blocks http://localhost:3000', () => {
    expectBlocked('http://localhost:3000');
  });

  it('blocks http://localhost/path', () => {
    expectBlocked('http://localhost/path');
  });

  it('blocks http://0.0.0.0', () => {
    expectBlocked('http://0.0.0.0');
  });

  it('blocks http://0.0.0.0:8080', () => {
    expectBlocked('http://0.0.0.0:8080');
  });

  it('blocks http://[::1]', () => {
    expectBlocked('http://[::1]');
  });

  it('blocks http://[::1]:3000', () => {
    expectBlocked('http://[::1]:3000');
  });
});

describe('assertNotLocal — 127.x.x.x loopback range', () => {
  it('blocks http://127.0.0.1', () => {
    expectBlocked('http://127.0.0.1');
  });

  it('blocks http://127.0.0.1:8080', () => {
    expectBlocked('http://127.0.0.1:8080');
  });

  it('blocks http://127.1.2.3', () => {
    expectBlocked('http://127.1.2.3');
  });

  it('blocks http://127.255.255.255', () => {
    expectBlocked('http://127.255.255.255');
  });
});

describe('assertNotLocal — link-local (169.254.x)', () => {
  it('blocks http://169.254.169.254 (AWS IMDS)', () => {
    expectBlocked('http://169.254.169.254');
  });

  it('blocks http://169.254.0.1', () => {
    expectBlocked('http://169.254.0.1');
  });

  it('blocks http://169.254.255.255', () => {
    expectBlocked('http://169.254.255.255');
  });
});

describe('assertNotLocal — RFC1918 literal IPs', () => {
  // 10.0.0.0/8
  it('blocks http://10.0.0.1', () => {
    expectBlocked('http://10.0.0.1');
  });

  it('blocks http://10.255.255.255', () => {
    expectBlocked('http://10.255.255.255');
  });

  it('blocks http://10.1.2.3:8080', () => {
    expectBlocked('http://10.1.2.3:8080');
  });

  // 192.168.0.0/16
  it('blocks http://192.168.0.1', () => {
    expectBlocked('http://192.168.0.1');
  });

  it('blocks http://192.168.100.200', () => {
    expectBlocked('http://192.168.100.200');
  });

  // 172.16.0.0/12 range (172.16 to 172.31)
  it('blocks http://172.16.0.1', () => {
    expectBlocked('http://172.16.0.1');
  });

  it('blocks http://172.31.255.255', () => {
    expectBlocked('http://172.31.255.255');
  });

  it('blocks http://172.20.10.5', () => {
    expectBlocked('http://172.20.10.5');
  });

  // 172.15.x.x is NOT RFC1918 — it's below the 172.16 lower bound
  it('allows http://172.15.0.1 (outside RFC1918 /12 range)', () => {
    expectAllowed('http://172.15.0.1');
  });

  // 172.32.x.x is NOT RFC1918 — it's above the 172.31 upper bound
  it('allows http://172.32.0.1 (outside RFC1918 /12 range)', () => {
    expectAllowed('http://172.32.0.1');
  });
});

describe('assertNotLocal — IPv6 hardening (SSRF bypass guard)', () => {
  // IPv4-mapped IPv6 — Node normalizes `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`,
  // which a dotted-form-only check would miss. The whole class is rejected.
  it('blocks http://[::ffff:127.0.0.1] (IPv4-mapped loopback)', () => {
    expectBlocked('http://[::ffff:127.0.0.1]');
  });

  it('blocks http://[::ffff:10.0.0.1] (IPv4-mapped RFC1918)', () => {
    expectBlocked('http://[::ffff:10.0.0.1]');
  });

  it('blocks http://[::ffff:169.254.169.254] (IPv4-mapped AWS metadata)', () => {
    expectBlocked('http://[::ffff:169.254.169.254]');
  });

  it('blocks http://[::] (unspecified address)', () => {
    expectBlocked('http://[::]');
  });

  it('blocks http://[fe80::1] (IPv6 link-local)', () => {
    expectBlocked('http://[fe80::1]');
  });

  it('blocks http://[febf::1] (IPv6 link-local upper bound)', () => {
    expectBlocked('http://[febf::1]');
  });

  it('blocks http://[fc00::1] (IPv6 unique-local)', () => {
    expectBlocked('http://[fc00::1]');
  });

  it('blocks http://[fd12:3456:789a::1] (IPv6 unique-local fd)', () => {
    expectBlocked('http://[fd12:3456:789a::1]');
  });

  // Public IPv6 must still pass — no false positives.
  it('allows http://[2606:4700:4700::1111] (Cloudflare public IPv6)', () => {
    expectAllowed('http://[2606:4700:4700::1111]');
  });

  it('allows http://[2001:4860:4860::8888] (Google public IPv6)', () => {
    expectAllowed('http://[2001:4860:4860::8888]');
  });
});

describe('assertNotLocal — trailing-dot FQDN normalization (SSRF bypass guard)', () => {
  // `localhost.` is the fully-qualified form of `localhost` (RFC 6761 reserves
  // both to resolve to loopback). It previously bypassed the
  // `host === 'localhost'` check because the WHATWG URL parser keeps the
  // trailing dot on named hosts (IP literals are dot-normalized, named hosts
  // are not).
  it('blocks http://localhost. (trailing-dot loopback)', () => {
    expectBlocked('http://localhost.');
  });

  it('blocks http://localhost.:8080 (trailing-dot loopback with port)', () => {
    expectBlocked('http://localhost.:8080');
  });

  it('blocks http://localhost%2e (percent-encoded trailing dot)', () => {
    expectBlocked('http://localhost%2e');
  });

  // A legitimate public FQDN with a trailing dot must still be allowed
  // (no false positive from the dot strip).
  it('allows https://example.com. (public FQDN with trailing dot)', () => {
    expectAllowed('https://example.com.');
  });
});

describe('assertNotLocal — allowed public URLs', () => {
  it('allows https://example.com', () => {
    expectAllowed('https://example.com');
  });

  it('allows https://dev.example.com/app', () => {
    expectAllowed('https://dev.example.com/app');
  });

  it('allows https://api.example.com:443', () => {
    expectAllowed('https://api.example.com:443');
  });

  it('allows http://staging.example.com:8080/path?q=1', () => {
    expectAllowed('http://staging.example.com:8080/path?q=1');
  });

  // 11.x.x.x is public (not 10.x)
  it('allows http://11.0.0.1 (not RFC1918)', () => {
    expectAllowed('http://11.0.0.1');
  });

  // Hostnames that might resolve to RFC1918 are the backend's concern
  it('allows https://internal.example.com (hostname might resolve private — backend checks)', () => {
    expectAllowed('https://internal.example.com');
  });
});

describe('assertNotLocal — error details', () => {
  it('includes hint for localhost block', () => {
    try {
      assertNotLocal('http://localhost:3000');
    } catch (err) {
      const apiErr = err as ApiError;
      const details = apiErr.details as Record<string, unknown>;
      expect(details.hint).toContain('testsprite-mcp-plugin');
    }
  });

  it('error message mentions target-url field', () => {
    try {
      assertNotLocal('http://127.0.0.1');
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.message).toContain('target-url');
    }
  });

  it('error nextAction contains help reference', () => {
    try {
      assertNotLocal('http://10.0.0.1');
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.nextAction).toBeDefined();
      expect(typeof apiErr.nextAction).toBe('string');
    }
  });
});
