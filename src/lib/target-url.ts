/**
 * CLI-side pre-flight guard for `--target-url`.
 *
 * Defense-in-depth: the backend is the trust boundary and performs DNS
 * resolution. `assertNotLocal` below does **string/literal-only** checks
 * to give a fast, friendly error before sending the request — it cannot by
 * itself detect DNS rebinding (a public hostname that resolves to a private
 * IP). That gap is closed one layer up: `target-url-preflight.ts` reuses
 * `disallowedIpReason` (exported below) against the actually-*resolved*
 * address before probing, so the same range list guards both the literal
 * string and the DNS answer — not two drifting copies of it.
 *
 * CLI-side target-url guard (exit 5 on any rejection):
 *  - Reject non-http(s) schemes
 *  - Reject `localhost`, `127.0.0.0/8`, `0.0.0.0`, and IPv6 loopback/unspecified (`::1`, `::`)
 *  - Reject `169.254.0.0/16` link-local and the `169.254.169.254` metadata address
 *  - Reject RFC1918 literal IPv4 (10.x, 172.16-31.x, 192.168.x)
 *  - Reject IPv4-mapped IPv6 (`::ffff:…`), IPv6 link-local (`fe80::/10`), unique-local (`fc00::/7`)
 */

import { ApiError } from './errors.js';

const LOCAL_DEV_HINT =
  'Local-dev tests are out of scope for the CLI; use testsprite-mcp-plugin for the local tunnel.';

/**
 * Throws a local `VALIDATION_ERROR` (exit 5) when `rawUrl` is a
 * disallowed target — localhost, RFC1918 literal IP, link-local, or
 * metadata-service address. Also rejects non-http(s) schemes.
 *
 * Silently returns on allowed URLs.
 */
export function assertNotLocal(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw localTargetError('target-url', 'must be a valid URL');
  }

  // Scheme check.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw localTargetError('target-url', 'must use http or https scheme');
  }

  // Normalize a single trailing dot in the hostname. `localhost.` is the
  // fully-qualified form of `localhost` (RFC 6761 reserves both to resolve to
  // loopback), so `http://localhost.` must be rejected just like
  // `http://localhost`. Without this strip, the trailing-dot form (also
  // reachable via `localhost%2e`) slips past the `host === 'localhost'` check.
  // IP literals are already dot-normalized by the WHATWG URL parser, so this
  // only affects named hosts.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');

  // 'localhost' is a name, not an IP literal, so it sits outside
  // `disallowedIpReason` below (which classifies IPv4/IPv6 address forms).
  if (host === 'localhost') {
    throw localTargetError('target-url', 'localhost targets are not allowed', LOCAL_DEV_HINT);
  }

  const reason = disallowedIpReason(host);
  if (reason !== undefined) {
    throw localTargetError('target-url', reason, LOCAL_DEV_HINT);
  }
}

/**
 * Classify a bare IP-address literal — IPv4 dotted form, or IPv6 optionally
 * wrapped in the `[...]` bracket notation `URL.hostname` uses — against the
 * private/loopback/link-local/metadata blocklist. Returns the disallowed
 * reason string, or `undefined` when the address is allowed.
 *
 * This is the single source of truth for the range list: `assertNotLocal`
 * calls it for the literal `--target-url` string above, and the reachability
 * preflight (`target-url-preflight.ts`) calls it again for a DNS-*resolved*
 * address — a public-looking hostname whose A/AAAA record actually points
 * at a private or metadata IP (DNS rebinding) is a distinct bypass from a
 * literal private IP typed on the command line, and both need the same
 * range list, not two drifting copies of it.
 */
export function disallowedIpReason(host: string): string | undefined {
  // IPv6 literals. Node's URL parser wraps IPv6 hosts in brackets and
  // normalizes IPv4-mapped forms to hex (`http://[::ffff:127.0.0.1]` →
  // hostname `[::ffff:7f00:1]`). A dotted-form string check alone would miss
  // the normalized variant, so we strip the brackets and classify the
  // address family explicitly. A DNS-resolved IPv6 address arrives
  // unbracketed already; stripping is a no-op for that shape.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare.includes(':')) {
    return disallowedIpv6Reason(bare);
  }

  // Unspecified.
  if (bare === '0.0.0.0') {
    return 'localhost targets are not allowed';
  }

  // 127.0.0.0/8 loopback range.
  if (/^127\.\d+\.\d+\.\d+$/.test(bare)) {
    return 'loopback addresses are not allowed';
  }

  // AWS instance-metadata service.
  if (bare === '169.254.169.254') {
    return '169.254.169.254 (AWS metadata service) is not allowed';
  }

  // 169.254.x.x link-local (IPv4).
  if (/^169\.254\.\d+\.\d+$/.test(bare)) {
    return 'link-local addresses are not allowed';
  }

  // RFC1918 literal IP addresses.
  if (isRfc1918Literal(bare)) {
    return 'private/RFC1918 addresses are not allowed';
  }

  return undefined;
}

function isRfc1918Literal(host: string): boolean {
  // 10.0.0.0/8
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  // 192.168.0.0/16
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  // 172.16.0.0/12 (172.16.x.x – 172.31.x.x)
  const m = host.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (m) {
    const second = parseInt(m[1]!, 10);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * Classify disallowed IPv6 literals: loopback (`::1`), unspecified (`::`),
 * IPv4-mapped (`::ffff:…`), link-local (`fe80::/10`), and unique-local
 * (`fc00::/7`). `inner` is the bracket-stripped host; callers are
 * responsible for lowercasing (the URL parser already lowercases hostnames,
 * a DNS-resolved address is emitted lowercase by Node).
 *
 * The IPv4-mapped class is rejected wholesale rather than decoding the
 * embedded v4 address: no legitimate target is expressed as a mapped
 * literal, and the hex-normalized form (`::ffff:7f00:1`) is error-prone to
 * decode. This closes the `http://[::ffff:127.0.0.1]` SSRF-guard bypass.
 */
function disallowedIpv6Reason(inner: string): string | undefined {
  // Loopback (::1) and unspecified (::).
  if (inner === '::1' || inner === '::') {
    return 'localhost targets are not allowed';
  }
  // IPv4-mapped IPv6 (`::ffff:a.b.c.d`, normalized to `::ffff:hhhh:hhhh`).
  if (inner.startsWith('::ffff:')) {
    return 'IPv4-mapped IPv6 addresses are not allowed; use the IPv4 form or a hostname';
  }
  // Link-local fe80::/10 (first hextet fe80–febf).
  if (/^fe[89ab][0-9a-f]:/.test(inner)) {
    return 'link-local addresses are not allowed';
  }
  // Unique-local fc00::/7 (first hextet fc00–fdff).
  if (/^f[cd][0-9a-f]{2}:/.test(inner)) {
    return 'unique-local (private) addresses are not allowed';
  }
  return undefined;
}

function localTargetError(field: string, reason: string, hint?: string): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'VALIDATION_ERROR',
      message: `Field \`${field}\` is invalid: ${reason}.`,
      nextAction: hint
        ? hint + ' See `testsprite test run --help` for accepted values.'
        : `See \`testsprite test run --help\` for accepted values.`,
      requestId: 'local',
      details: { field, reason, ...(hint ? { hint } : {}) },
    },
  });
}
