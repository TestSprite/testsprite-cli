/**
 * Unit tests for `assertNotLocal` — CLI-side target-url pre-flight guard.
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from './errors.js';
import { assertNotLocal, disallowedIpReason } from './target-url.js';

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

describe('assertNotLocal — backend-reserved IPv4 ranges', () => {
  it.each([
    ['0.1.2.3', 'this-network 0.0.0.0/8'],
    ['100.64.0.1', 'carrier-grade NAT 100.64.0.0/10'],
    ['224.0.0.1', 'multicast 224.0.0.0/4'],
    ['240.0.0.1', 'class E 240.0.0.0/4'],
    ['255.255.255.255', 'limited broadcast'],
  ])('blocks http://%s (%s)', address => {
    expectBlocked(`http://${address}`);
  });

  it.each(['100.63.255.255', '100.128.0.1', '223.255.255.255'])(
    'allows http://%s (adjacent public boundary)',
    address => {
      expectAllowed(`http://${address}`);
    },
  );
});

describe('assertNotLocal — IPv6 hardening (SSRF bypass guard)', () => {
  // IPv4-mapped IPv6 — Node normalizes `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`,
  // which a dotted-form-only check would miss. The embedded IPv4 is decoded and
  // classified through the same IPv4 rules.
  it('blocks http://[::ffff:127.0.0.1] (IPv4-mapped loopback)', () => {
    expectBlocked('http://[::ffff:127.0.0.1]');
  });

  it('blocks http://[::ffff:10.0.0.1] (IPv4-mapped RFC1918)', () => {
    expectBlocked('http://[::ffff:10.0.0.1]');
  });

  it('blocks http://[::ffff:169.254.169.254] (IPv4-mapped AWS metadata)', () => {
    expectBlocked('http://[::ffff:169.254.169.254]');
  });

  // NAT64 (#342 review): 64:ff9b::a9fe:a9fe IS 169.254.169.254 through the
  // RFC 6052 well-known prefix — the same embedded-IPv4 trick as the mapped
  // class, previously unhandled.
  it('blocks http://[64:ff9b::a9fe:a9fe] (NAT64 AWS metadata)', () => {
    expectBlocked('http://[64:ff9b::a9fe:a9fe]');
  });

  it('blocks http://[64:ff9b::7f00:1] (NAT64 loopback)', () => {
    expectBlocked('http://[64:ff9b::7f00:1]');
  });

  it('blocks http://[64:ff9b:1::a9fe:a9fe] (RFC 8215 local-use NAT64)', () => {
    expectBlocked('http://[64:ff9b:1::a9fe:a9fe]');
  });

  // IPv4-compatible IPv6 (#342 review): the deprecated ::/96 form embeds an
  // IPv4 address the same way ::ffff: does — [::169.254.169.254] normalizes to
  // [::a9fe:a9fe] — and was previously the closest unhandled sibling to the
  // cases the guard did block.
  it('blocks http://[::169.254.169.254] (IPv4-compatible AWS metadata)', () => {
    expectBlocked('http://[::169.254.169.254]');
  });

  it('blocks http://[::127.0.0.1] (IPv4-compatible loopback)', () => {
    expectBlocked('http://[::127.0.0.1]');
  });

  it('blocks http://[::a9fe:a9fe] (IPv4-compatible metadata, hex form)', () => {
    expectBlocked('http://[::a9fe:a9fe]');
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

  it('blocks http://[fec0::1] (deprecated IPv6 site-local)', () => {
    expectBlocked('http://[fec0::1]');
  });

  it('blocks http://[feff::1] (deprecated IPv6 site-local upper bound)', () => {
    expectBlocked('http://[feff::1]');
  });

  // Public IPv6 must still pass — no false positives.
  it('allows http://[2606:4700:4700::1111] (Cloudflare public IPv6)', () => {
    expectAllowed('http://[2606:4700:4700::1111]');
  });

  it('allows http://[2001:4860:4860::8888] (Google public IPv6)', () => {
    expectAllowed('http://[2001:4860:4860::8888]');
  });
});

// The standard embedded-IPv4 prefixes are identified structurally with
// `net.BlockList`, then their low 32 bits are decoded and re-classified through
// the IPv4 rules. Every case below is the RAW string a caller would type; the
// comment states what `new URL('http://[' + raw + ']').hostname` actually
// produces, since that parsed form — not the raw string — is what the literal
// path sees. The direct-call tests below cover the DNS path's unnormalised form.
describe('assertNotLocal — embedded-IPv4 family (structural net.BlockList rule)', () => {
  it('blocks http://[::ffff:169.254.169.254] (IPv4-mapped AWS metadata, dotted tail)', () => {
    // new URL(...).hostname -> [::ffff:a9fe:a9fe] (dotted tail hex-normalized)
    expectBlocked('http://[::ffff:169.254.169.254]');
  });

  it('blocks http://[::ffff:a9fe:a9fe] (IPv4-mapped AWS metadata, hex tail)', () => {
    // new URL(...).hostname -> [::ffff:a9fe:a9fe] (already canonical, unchanged)
    expectBlocked('http://[::ffff:a9fe:a9fe]');
  });

  it('blocks http://[0:0:0:0:0:ffff:a9fe:a9fe] (fully-expanded mapped form)', () => {
    // new URL(...).hostname -> [::ffff:a9fe:a9fe] (COMPRESSED — the parser
    // collapses the leading all-zero run into `::`)
    expectBlocked('http://[0:0:0:0:0:ffff:a9fe:a9fe]');
  });

  it('blocks http://[::ffff:0:a9fe:a9fe] ("IPv4-translated" form)', () => {
    // new URL(...).hostname -> [::ffff:0:a9fe:a9fe] (PRESERVED verbatim — the
    // parser does NOT compress this shape, unlike the fully-expanded form
    // above; a check tuned to the compressed shape alone misses this one)
    expectBlocked('http://[::ffff:0:a9fe:a9fe]');
  });

  it('blocks http://[::ffff:0:0:a9fe:a9fe] (zero-padded mapped form)', () => {
    // new URL(...).hostname -> [::ffff:0:0:a9fe:a9fe] (also PRESERVED verbatim)
    expectBlocked('http://[::ffff:0:0:a9fe:a9fe]');
  });

  it('blocks http://[::ffff:ffff:a9fe:a9fe] (repeated-ffff embedded head)', () => {
    expectBlocked('http://[::ffff:ffff:a9fe:a9fe]');
  });

  it('blocks http://[::0:ffff:a9fe:a9fe] (explicit leading-zero mapped form)', () => {
    // new URL(...).hostname -> [::ffff:a9fe:a9fe] (COMPRESSED, same target as
    // the fully-expanded case above)
    expectBlocked('http://[::0:ffff:a9fe:a9fe]');
  });

  it('blocks http://[64:ff9b::a9fe:a9fe] (NAT64, hex tail — the case that motivated this fix)', () => {
    // new URL(...).hostname -> [64:ff9b::a9fe:a9fe] (unchanged)
    expectBlocked('http://[64:ff9b::a9fe:a9fe]');
  });

  it('blocks http://[64:ff9b::169.254.169.254] (NAT64, dotted tail)', () => {
    // new URL(...).hostname -> [64:ff9b::a9fe:a9fe] (dotted tail hex-normalized)
    expectBlocked('http://[64:ff9b::169.254.169.254]');
  });

  it('blocks http://[64:ff9b:1::a9fe:a9fe] (NAT64 RFC 8215 /48 extension)', () => {
    // new URL(...).hostname -> [64:ff9b:1::a9fe:a9fe] (unchanged) — refused
    // wholesale by prefix match, never arithmetically decoded (RFC 6052's
    // embedded-address bit offset varies with prefix length).
    expectBlocked('http://[64:ff9b:1::a9fe:a9fe]');
  });

  it('blocks http://[::169.254.169.254] (IPv4-compatible, deprecated form — same family, found alongside NAT64)', () => {
    // new URL(...).hostname -> [::a9fe:a9fe] — this deprecated form was ALSO
    // unrejected before this fix, not just NAT64; the structural rule closes
    // both at once instead of adding a second one-off branch.
    expectBlocked('http://[::169.254.169.254]');
  });

  // These addresses sit outside the standard embedded-IPv4 prefixes. Their low
  // 32 bits are ordinary IPv6 interface bits and must not be decoded.
  it('allows http://[::1:2:3:4:5:6] (outside IPv4-compatible ::/96)', () => {
    expectAllowed('http://[::1:2:3:4:5:6]');
  });

  it('allows http://[64:ff9b:ffff::a9fe:a9fe] (outside both IANA NAT64 prefixes)', () => {
    expectAllowed('http://[64:ff9b:ffff::a9fe:a9fe]');
  });

  it('blocks http://[::] (unspecified — pre-existing exact-match case, confirmed unaffected)', () => {
    expectBlocked('http://[::]');
  });

  it('blocks http://[::1] (loopback — pre-existing exact-match case, confirmed unaffected)', () => {
    expectBlocked('http://[::1]');
  });

  it('blocks http://[::ffff:127.0.0.1] (IPv4-mapped loopback — pre-existing case, confirmed unaffected)', () => {
    expectBlocked('http://[::ffff:127.0.0.1]');
  });

  it('blocks http://[::ffff:10.0.0.5] (IPv4-mapped RFC1918 — pre-existing case, confirmed unaffected)', () => {
    expectBlocked('http://[::ffff:10.0.0.5]');
  });

  it.each([
    ['http://[::ffff:8.8.8.8]', 'IPv4-mapped public address'],
    ['http://[::ffff:ffff:808:808]', 'repeated-ffff head to a public address'],
    ['http://[64:ff9b::808:808]', 'NAT64 well-known prefix to a public address'],
    ['http://[::8.8.8.8]', 'IPv4-compatible public address'],
    ['http://[::ffff:1234:a9fe:a9fe]', 'non-embedded group in the IPv6 interface id'],
  ])('allows %s (%s)', url => {
    expectAllowed(url);
  });

  it('pins WHATWG dotted-tail normalization to the hex form the literal path receives', () => {
    expect(new URL('http://[::ffff:169.254.169.254]/').hostname).toBe('[::ffff:a9fe:a9fe]');
  });

  // Positive controls: an over-matching structural rule is worse than the
  // hole it closes, and only a positive control catches over-matching.
  // 2001:db8::/32 is the IPv6 documentation prefix (RFC 3849) — its low 32
  // bits are ordinary interface bits, not an embedded IPv4 address, and nine
  // of this family's hex tails happen to look exactly like one
  // (`a9fe:a9fe`). It must stay allowed.
  it('allows http://[2001:db8::a9fe:a9fe] (documentation prefix, NOT an embedded IPv4 address)', () => {
    // new URL(...).hostname -> [2001:db8::a9fe:a9fe] (unchanged)
    expectAllowed('http://[2001:db8::a9fe:a9fe]');
  });

  it('allows http://[2606:4700:4700::1111] (real public IPv6 — Cloudflare)', () => {
    expectAllowed('http://[2606:4700:4700::1111]');
  });

  it('allows https://example.com (ordinary public hostname)', () => {
    expectAllowed('https://example.com');
  });

  const DECODED_REJECTIONS: ReadonlyArray<
    readonly [string, string, 'loopback' | 'private', string]
  > = [
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]', 'loopback', '127.0.0.1'],
    ['IPv4-mapped metadata', 'http://[::ffff:169.254.169.254]', 'private', '169.254.169.254'],
    ['NAT64 private', 'http://[64:ff9b::10.0.0.5]', 'private', '10.0.0.5'],
  ];

  for (const [label, url, hintKind, decodedAddress] of DECODED_REJECTIONS) {
    it(`${label} rejection inherits the decoded IPv4 classification and hint`, () => {
      const classification = disallowedIpReason(new URL(url).hostname);
      expect(classification?.hintKind).toBe(hintKind);
      expect(classification?.reason).toContain(decodedAddress);

      try {
        assertNotLocal(url);
        throw new Error('expected assertNotLocal to throw');
      } catch (err) {
        const apiErr = err as ApiError;
        const details = apiErr.details as Record<string, unknown>;
        expect(details.reason).toContain(decodedAddress);
        expect(details.hint).toBeDefined();
      }
    });
  }

  it('keeps RFC 8215 NAT64 local-use refusal undecided and hintless', () => {
    const url = 'http://[64:ff9b:1::a9fe:a9fe]';
    expect(disallowedIpReason(new URL(url).hostname)?.hintKind).toBe('undecided');
    try {
      assertNotLocal(url);
      throw new Error('expected assertNotLocal to throw');
    } catch (err) {
      const details = (err as ApiError).details as Record<string, unknown>;
      expect(details.hint).toBeUndefined();
      expect('hint' in details).toBe(false);
    }
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
  it('uses the caller-provided field and help command in the rejection envelope', () => {
    try {
      assertNotLocal('http://localhost:3000', {
        field: 'url',
        helpCommand: 'testsprite project create',
        hintContext: 'bootstrap',
      });
      throw new Error('expected assertNotLocal to throw');
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.message).toBe('Field `url` is invalid: localhost targets are not allowed.');
      expect(apiErr.nextAction).toContain('See `testsprite project create --help`');
      expect(apiErr.nextAction).not.toContain('testsprite test run --help');
      expect(apiErr.details).toMatchObject({
        field: 'url',
        reason: 'localhost targets are not allowed',
      });
    }
  });

  it('includes a --local hint for localhost block', () => {
    try {
      assertNotLocal('http://localhost:3000');
    } catch (err) {
      const apiErr = err as ApiError;
      const details = apiErr.details as Record<string, unknown>;
      expect(details.hint).toContain('--local');
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

  // A loopback IP literal (not just the `localhost` name) gets the same
  // --local hint — `--local`'s tunnel reaches exactly this address class.
  it('includes a --local hint for a loopback IP literal (127.0.0.1)', () => {
    try {
      assertNotLocal('http://127.0.0.1');
    } catch (err) {
      const apiErr = err as ApiError;
      const details = apiErr.details as Record<string, unknown>;
      expect(details.hint).toContain('--local');
    }
  });

  // The discriminating regression case: 127.0.0.2 is loopback-RANGE, but
  // --local-host accepts only the EXACT literal 127.0.0.1 — an app bound to
  // 127.0.0.2 does not answer on 127.0.0.1, so recommending --local here
  // would tell the user to run a command that cannot reach the address it
  // was just told about. Must NOT get the plain --local hint.
  it('does NOT hint --local for a non-127.0.0.1 loopback-range address (127.0.0.2)', () => {
    try {
      assertNotLocal('http://127.0.0.2');
      throw new Error('expected assertNotLocal to throw');
    } catch (err) {
      const apiErr = err as ApiError;
      const details = apiErr.details as Record<string, unknown>;
      expect(details.reason).toBe('loopback addresses are not allowed');
      expect(details.hint).toBeUndefined();
      expect('hint' in details).toBe(false);
    }
  });

  // A private/RFC1918 address is not reachable via --local at all (its
  // tunnel only ever dials this machine's own loopback address), so its
  // hint must not dangle a false promise of a tunnel escape hatch.
  // The hint is ALLOWED to name --local while explaining its exact limits
  // (that is factual, not a suggestion) — what it must never do is recommend
  // RUNNING --local against this address, since --local cannot reach it.
  it('does NOT recommend running --local for a private RFC1918 address (10.0.0.5), only states its limits', () => {
    try {
      assertNotLocal('http://10.0.0.5');
    } catch (err) {
      const apiErr = err as ApiError;
      const details = apiErr.details as Record<string, unknown>;
      const hint = details.hint as string;
      expect(hint).toBeDefined();
      expect(hint).not.toContain('test run <test-id> --local');
      expect(hint.toLowerCase()).toContain('cannot');
    }
  });

  // The hint must not claim the address is simply unreachable from this
  // machine — a LAN/VPN address usually IS reachable; only TestSprite's
  // execution modes cannot target it.
  //
  // Asserted POSITIVELY, and that matters: the original form of this test only
  // checked that the hint did NOT contain "cannot be reached from this machine
  // at all" — which the pre-fix generic hint also did not contain, so it passed
  // against the very state it existed to rule out. It also had no "expected to
  // throw", so it would have passed had the address stopped being rejected
  // altogether. Both are fixed here.
  it('says TestSprite cannot target a private address, not that the machine cannot reach it', () => {
    try {
      assertNotLocal('http://10.0.0.5');
      throw new Error('expected assertNotLocal to throw');
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe('VALIDATION_ERROR');
      const details = apiErr.details as Record<string, unknown>;
      const hint = details.hint as string;
      expect(hint).toContain('TestSprite cannot use it as --target-url');
      expect(hint).toContain('--local only');
      expect(hint).not.toContain('cannot be reached from this machine at all');
    }
  });

  // The mapped address is decoded, so its loopback classification is known
  // and gets the same usable --local hint as the plain IPv4 form.
  it('includes the loopback --local hint for decoded ::ffff:127.0.0.1', () => {
    try {
      assertNotLocal('http://[::ffff:127.0.0.1]');
      throw new Error('expected assertNotLocal to throw');
    } catch (err) {
      const apiErr = err as ApiError;
      const details = apiErr.details as Record<string, unknown>;
      expect(details.reason).toContain('127.0.0.1');
      expect(details.hint).toContain('test run <test-id> --local');
      expect(apiErr.nextAction).toContain('--local');
    }
  });
});

/**
 * These call `disallowedIpReason` DIRECTLY, with no `new URL()` in front of it.
 *
 * That is not a stylistic choice — it is the only way this file can detect a
 * revert of the structural rule. Every other case in the embedded-IPv4 describe
 * goes through `assertNotLocal`, so the WHATWG parser canonicalises the literal
 * before the classifier ever sees it (`0:0:0:0:0:ffff:a9fe:a9fe` becomes
 * `::ffff:a9fe:a9fe`), which lands it back on a shape the old `startsWith`
 * checks matched too. A mutation run proved the point: swapping the blocklists
 * back for the string checks left all of those cases green.
 *
 * It is also the real second caller's shape. `target-url-preflight.ts` passes
 * DNS-resolved addresses straight to `disallowedIpReason` — nothing normalises
 * those on the way in.
 */
describe('disallowedIpReason — called directly, as the DNS path calls it', () => {
  const EXPANDED_REJECTIONS: ReadonlyArray<readonly [string, string]> = [
    ['mapped, fully expanded', '0:0:0:0:0:ffff:a9fe:a9fe'],
    ['mapped, expanded + uppercase', '0000:0000:0000:0000:0000:FFFF:A9FE:A9FE'],
    ['translated, expanded + uppercase', '0000:0000:0000:0000:FFFF:0000:A9FE:A9FE'],
    ['NAT64, expanded + uppercase', '0064:FF9B:0000:0000:0000:0000:A9FE:A9FE'],
    ['zero-padded mapped, fully expanded', '0000:0000:0000:FFFF:0000:0000:A9FE:A9FE'],
    ['compatible, fully expanded', '0:0:0:0:0:0:A9FE:A9FE'],
  ];

  for (const [label, address] of EXPANDED_REJECTIONS) {
    it(`refuses ${label} (${address})`, () => {
      const classification = disallowedIpReason(address);
      expect(classification).toBeDefined();
      expect(classification?.reason).toContain('169.254.169.254');
      expect(classification?.hintKind).toBe('private');
    });
  }

  it('refuses dotted and hex mapped tails identically', () => {
    expect(disallowedIpReason('::ffff:169.254.169.254')).toEqual(
      disallowedIpReason('::ffff:a9fe:a9fe'),
    );
  });

  // The two regex rules are lowercase; the two blocklist families are binary and
  // never were case-sensitive. `disallowedIpReason` lowercases on the way in so
  // the regexes cannot be the weak link — before that, an uppercase literal on
  // the DNS path was classified as allowed by every version of this file.
  it.each([
    ['FE80::1', 'link-local addresses are not allowed'],
    ['FEBF::1', 'link-local addresses are not allowed'],
    ['FC00::1', 'unique-local (private) addresses are not allowed'],
    ['FD12:3456:789A::1', 'unique-local (private) addresses are not allowed'],
  ])('refuses uppercase %s the same as its lowercase spelling', (address, reason) => {
    expect(disallowedIpReason(address)).toEqual({ reason, hintKind: 'private' });
    expect(disallowedIpReason(address.toLowerCase())).toEqual({ reason, hintKind: 'private' });
  });

  // Positive controls for the direct path too: an over-matching rule reached
  // this way would refuse a customer's real target after DNS resolution, where
  // there is no `--target-url` string for them to look at and correct.
  it.each([
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '2001:db8::a9fe:a9fe',
    '8.8.8.8',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '::ffff:ffff:808:808',
    '64:ff9b::808:808',
    '::8.8.8.8',
    '::ffff:1234:a9fe:a9fe',
  ])('allows %s', address => {
    expect(disallowedIpReason(address)).toBeUndefined();
  });
});
