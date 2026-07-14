/**
 * CLI-side pre-flight guard for `--target-url`.
 *
 * Defense-in-depth: the backend is the trust boundary and performs DNS
 * resolution. This guard does **string/literal-only** checks to give a
 * fast, friendly error before sending the request. It cannot detect
 * DNS rebinding (a public hostname that resolves to a private IP) — the
 * backend catches that.
 *
 * CLI-side target-url guard (exit 5 on any rejection):
 *  - Reject non-http(s) schemes
 *  - Reject `localhost`, `127.0.0.0/8`, `0.0.0.0`, and IPv6 loopback/unspecified (`::1`, `::`)
 *  - Reject `169.254.0.0/16` link-local and the `169.254.169.254` metadata address
 *  - Reject RFC1918 literal IPv4 (10.x, 172.16-31.x, 192.168.x)
 *  - Reject IPv4-mapped IPv6 (`::ffff:…`), IPv6 link-local (`fe80::/10`), unique-local (`fc00::/7`)
 *  - Hostnames that resolve to private IPs are the backend's concern.
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

  // Loopback / unspecified.
  if (host === 'localhost' || host === '0.0.0.0') {
    throw localTargetError('target-url', 'localhost targets are not allowed', LOCAL_DEV_HINT);
  }
  // IPv6 literals. Node's URL parser wraps IPv6 hosts in brackets and
  // normalizes IPv4-mapped forms to hex (`http://[::ffff:127.0.0.1]` →
  // hostname `[::ffff:7f00:1]`). A dotted-form string check alone would miss
  // the normalized variant, so we strip the brackets and classify the
  // address family explicitly.
  if (host.startsWith('[') && host.endsWith(']')) {
    assertNotLocalIpv6(host.slice(1, -1));
  }

  // 127.0.0.0/8 loopback range.
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) {
    throw localTargetError('target-url', 'loopback addresses are not allowed', LOCAL_DEV_HINT);
  }

  // AWS instance-metadata service (168 and 169 prefixes used for IMDS).
  if (host === '169.254.169.254') {
    throw localTargetError(
      'target-url',
      '169.254.169.254 (AWS metadata service) is not allowed',
      LOCAL_DEV_HINT,
    );
  }

  // 169.254.x.x link-local (IPv4).
  if (/^169\.254\.\d+\.\d+$/.test(host)) {
    throw localTargetError('target-url', 'link-local addresses are not allowed', LOCAL_DEV_HINT);
  }

  // RFC1918 literal IP addresses only — hostnames that resolve to private
  // IPs are the backend's concern (DNS resolution is expensive CLI-side).
  if (isRfc1918Literal(host)) {
    throw localTargetError(
      'target-url',
      'private/RFC1918 addresses are not allowed',
      LOCAL_DEV_HINT,
    );
  }
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
 * Reject disallowed IPv6 literals: loopback (`::1`), unspecified (`::`),
 * IPv4-mapped (`::ffff:…`), link-local (`fe80::/10`), and unique-local
 * (`fc00::/7`). `inner` is the bracket-stripped, lowercased host.
 *
 * The IPv4-mapped class is rejected wholesale rather than decoding the
 * embedded v4 address: no legitimate target is expressed as a mapped
 * literal, and the hex-normalized form (`::ffff:7f00:1`) is error-prone to
 * decode. This closes the `http://[::ffff:127.0.0.1]` SSRF-guard bypass.
 */
function assertNotLocalIpv6(inner: string): void {
  // Loopback (::1) and unspecified (::).
  if (inner === '::1' || inner === '::') {
    throw localTargetError('target-url', 'localhost targets are not allowed', LOCAL_DEV_HINT);
  }
  // IPv4-mapped IPv6 (`::ffff:a.b.c.d`, normalized to `::ffff:hhhh:hhhh`).
  if (inner.startsWith('::ffff:')) {
    throw localTargetError(
      'target-url',
      'IPv4-mapped IPv6 addresses are not allowed; use the IPv4 form or a hostname',
      LOCAL_DEV_HINT,
    );
  }
  // Link-local fe80::/10 (first hextet fe80–febf).
  if (/^fe[89ab][0-9a-f]:/.test(inner)) {
    throw localTargetError('target-url', 'link-local addresses are not allowed', LOCAL_DEV_HINT);
  }
  // Unique-local fc00::/7 (first hextet fc00–fdff).
  if (/^f[cd][0-9a-f]{2}:/.test(inner)) {
    throw localTargetError(
      'target-url',
      'unique-local (private) addresses are not allowed',
      LOCAL_DEV_HINT,
    );
  }
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
