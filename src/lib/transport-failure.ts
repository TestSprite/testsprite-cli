/**
 * Named transport-failure classification for the shared HTTP layer.
 *
 * Node's fetch reports almost every network problem as the same opaque
 * `TypeError: fetch failed`; the real reason lives on the `cause` chain. When
 * the CLI surfaces only the outer message, a TLS-interception problem, a DNS
 * typo, a closed port and an authenticating proxy all read identically, and the
 * operator (or a coding agent) is sent to fix the wrong thing.
 *
 * This module walks that chain once and names the cause. Certificate failures
 * and proxy authentication are terminal: retrying re-sends the exact same
 * request into the exact same wall, so they must fail on the first attempt.
 * Other causes (DNS, refused, timeout, reset) keep the existing retry budget —
 * they can be transient — but the final error still names the cause.
 */
import { TransportError, type ApiError } from './errors.js';

/**
 * `details.reason` values that mean "the request never produced a TestSprite
 * API answer". `not_testsprite` is a response from something in the middle
 * (proxy/firewall/captive portal); the rest are failures before a response.
 */
export const TRANSPORT_FAILURE_REASONS = [
  'not_testsprite',
  'tls_untrusted',
  'tls_expired',
  'tls_hostname_mismatch',
  'dns',
  'connection_refused',
  'host_unreachable',
  'connection_reset',
  'timeout',
  'proxy_authentication',
] as const;

export type TransportFailureReason = (typeof TRANSPORT_FAILURE_REASONS)[number];

export interface TransportFailure {
  reason: Exclude<TransportFailureReason, 'not_testsprite'>;
  /** Node/undici code (or a short equivalent) safe to expose in details. */
  cause: string;
  /** Human-readable one-paragraph explanation, with the remedy inline. */
  message: string;
  /** Actionable remediation for the rendered `nextAction`. */
  nextAction: string;
  /** True when retrying the same request cannot succeed. */
  fatal: boolean;
}

/** True when `error` carries one of the named transport-failure reasons. */
export function isTransportFailure(error: ApiError): boolean {
  if (error.code !== 'UNAVAILABLE') return false;
  const reason = error.getDetail<string>('reason', (v): v is string => typeof v === 'string');
  return reason !== undefined && (TRANSPORT_FAILURE_REASONS as readonly string[]).includes(reason);
}

interface ErrorEvidence {
  codes: Set<string>;
  messages: string[];
}

const MAX_CAUSE_DEPTH = 6;

/** Collect `code` values and messages from the whole `cause`/AggregateError graph. */
function collectErrorEvidence(error: unknown): ErrorEvidence {
  const codes = new Set<string>();
  const messages: string[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number): void => {
    if (node === null || node === undefined || depth > MAX_CAUSE_DEPTH) return;
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    const record = node as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof record.code === 'string' && record.code.length > 0) codes.add(record.code);
    if (typeof record.message === 'string' && record.message.length > 0) {
      messages.push(record.message);
    }
    walk(record.cause, depth + 1);
    if (Array.isArray(record.errors)) {
      for (const nested of record.errors) walk(nested, depth + 1);
    }
  };

  walk(error, 0);
  return { codes, messages };
}

function firstMatchingCode(codes: Set<string>, candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (codes.has(candidate)) return candidate;
  }
  return undefined;
}

/** Short host for messages; falls back to a neutral phrase for a bad URL. */
function targetHost(targetUrl: string | undefined): string {
  if (targetUrl === undefined) return 'the API endpoint';
  try {
    return new URL(targetUrl).host;
  } catch {
    return 'the API endpoint';
  }
}

const TLS_UNTRUSTED_CODES = [
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'CERT_REVOKED',
  'INVALID_CA',
  'PATH_LENGTH_EXCEEDED',
] as const;

const TLS_EXPIRED_CODES = ['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID'] as const;

const TLS_HOSTNAME_CODES = ['ERR_TLS_CERT_ALTNAME_INVALID'] as const;

const DNS_CODES = ['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL', 'EAI_NODATA'] as const;

const TIMEOUT_CODES = [
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
] as const;

const RESET_CODES = [
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
] as const;

const UNREACHABLE_CODES = ['EHOSTUNREACH', 'ENETUNREACH'] as const;

const NODE_EXTRA_CA_HINT =
  'Node.js does not read the operating-system certificate store; set NODE_EXTRA_CA_CERTS to the PEM ' +
  'CA bundle that should be trusted.';

function proxyAuthenticationCode(evidence: ErrorEvidence): string | undefined {
  const proxyAuthMessage = evidence.messages.find(
    message =>
      /proxy authentication required/i.test(message) ||
      /proxy response \(407\)/i.test(message) ||
      /HTTP 407\b/i.test(message),
  );
  if (proxyAuthMessage === undefined) return undefined;
  return evidence.codes.has('UND_ERR_INVALID_ARG') ? 'UND_ERR_INVALID_ARG' : 'HTTP 407';
}

/**
 * Classify a fetch rejection. Returns `undefined` when nothing recognisable is
 * in the cause chain, so the caller keeps its historical generic handling.
 */
export function classifyFetchFailure(
  error: unknown,
  targetUrl?: string,
): TransportFailure | undefined {
  const evidence = collectErrorEvidence(error);
  const target = targetHost(targetUrl);

  const proxyCode = proxyAuthenticationCode(evidence);
  if (proxyCode !== undefined) {
    return {
      reason: 'proxy_authentication',
      cause: proxyCode,
      fatal: true,
      message:
        `The HTTP proxy in front of ${target} requires authentication (HTTP 407), so the request ` +
        'never reached TestSprite. The API key was not rejected.',
      nextAction:
        'Configure the proxy credentials in HTTPS_PROXY/HTTP_PROXY (for example ' +
        'https://user:password@proxy.example:8080), or ask IT for the proxy that allows outbound ' +
        'HTTPS. Then retry. Do not change the API key.',
    };
  }

  const untrusted = firstMatchingCode(evidence.codes, TLS_UNTRUSTED_CODES);
  if (untrusted !== undefined) {
    return {
      reason: 'tls_untrusted',
      cause: untrusted,
      fatal: true,
      message:
        `TLS certificate verification failed for ${target} (${untrusted}). The certificate chain ` +
        'is untrusted — usually a corporate proxy, antivirus, or self-signed certificate. ' +
        NODE_EXTRA_CA_HINT,
      nextAction:
        'Set NODE_EXTRA_CA_CERTS to the organisation PEM CA bundle that signs intercepted traffic ' +
        '(for example NODE_EXTRA_CA_CERTS=/path/to/corporate-root-ca.pem), then retry. Do not set ' +
        'NODE_TLS_REJECT_UNAUTHORIZED=0: it disables certificate checks for requests that carry ' +
        'your API key.',
    };
  }

  const expired = firstMatchingCode(evidence.codes, TLS_EXPIRED_CODES);
  if (expired !== undefined) {
    return {
      reason: 'tls_expired',
      cause: expired,
      fatal: true,
      message:
        `The TLS certificate for ${target} is expired or not yet valid (${expired}). Check the ` +
        'system clock. If a proxy re-signs HTTPS, ' +
        "set NODE_EXTRA_CA_CERTS to that proxy's PEM CA bundle so Node trusts it.",
      nextAction:
        'Correct the system clock, then retry. Behind a TLS-inspecting proxy, set NODE_EXTRA_CA_CERTS ' +
        'to the organisation PEM CA bundle. Do not disable certificate verification.',
    };
  }

  const hostname = firstMatchingCode(evidence.codes, TLS_HOSTNAME_CODES);
  if (hostname !== undefined) {
    return {
      reason: 'tls_hostname_mismatch',
      cause: hostname,
      fatal: true,
      message:
        `The TLS certificate presented for ${target} is not valid for that host (${hostname}). A ` +
        'proxy may be re-signing traffic for a different name, or --endpoint-url / ' +
        'TESTSPRITE_API_URL points at the wrong host. If a proxy re-signs HTTPS, ' +
        "set NODE_EXTRA_CA_CERTS to that proxy's PEM CA bundle.",
      nextAction:
        'Check --endpoint-url / TESTSPRITE_API_URL, then set NODE_EXTRA_CA_CERTS to the ' +
        'organisation PEM CA bundle when the network re-signs TLS. Do not disable certificate verification.',
    };
  }

  const dns = firstMatchingCode(evidence.codes, DNS_CODES);
  if (dns !== undefined) {
    return {
      reason: 'dns',
      cause: dns,
      fatal: false,
      message:
        `Could not resolve ${target} (${dns}). Check the --endpoint-url / TESTSPRITE_API_URL spelling ` +
        'and your DNS, VPN, or proxy configuration.',
      nextAction:
        'Correct the endpoint host or restore DNS/VPN connectivity, then retry. Run `testsprite doctor` ' +
        'to check the endpoint and credentials.',
    };
  }

  if (evidence.codes.has('ECONNREFUSED')) {
    return {
      reason: 'connection_refused',
      cause: 'ECONNREFUSED',
      fatal: false,
      message:
        `Connection refused by ${target} (ECONNREFUSED). Nothing is accepting connections on that ` +
        'host and port — the port may be closed, or the service may not be running.',
      nextAction:
        'Check the --endpoint-url host and port, and whether a local service or tunnel should be ' +
        'listening there. Then retry.',
    };
  }

  const unreachable = firstMatchingCode(evidence.codes, UNREACHABLE_CODES);
  if (unreachable !== undefined) {
    return {
      reason: 'host_unreachable',
      cause: unreachable,
      fatal: false,
      message:
        `Could not reach ${target} (${unreachable}). No route to that host — a VPN, firewall, or ` +
        'routing rule is likely blocking the connection.',
      nextAction:
        'Check the VPN, firewall and proxy configuration (and --endpoint-url / TESTSPRITE_API_URL), ' +
        'then retry.',
    };
  }

  const timeout = firstMatchingCode(evidence.codes, TIMEOUT_CODES);
  if (timeout !== undefined) {
    return {
      reason: 'timeout',
      cause: timeout,
      fatal: false,
      message:
        `The connection to ${target} timed out (${timeout}). A firewall, VPN, or proxy may be ` +
        'silently dropping the connection.',
      nextAction:
        'Check the network, VPN, firewall and proxy settings, then retry. If the backend is slow, ' +
        'raise the deadline with --request-timeout or TESTSPRITE_REQUEST_TIMEOUT_MS.',
    };
  }

  const reset = firstMatchingCode(evidence.codes, RESET_CODES);
  if (reset !== undefined) {
    return {
      reason: 'connection_reset',
      cause: reset,
      fatal: false,
      message:
        `The connection to ${target} was reset (${reset}). A proxy, firewall, or load balancer may ` +
        'be terminating the connection before the API answers.',
      nextAction:
        'Check the proxy/firewall logs, then retry. If it persists, report it with the requestId.',
    };
  }

  return undefined;
}

/** Build the typed (exit 10) error for a classified failure. */
export function transportFailureError(
  failure: TransportFailure,
  requestId: string,
): TransportError {
  return new TransportError(failure.message, requestId, {
    nextAction: failure.nextAction,
    details: { reason: failure.reason, cause: failure.cause },
  });
}
