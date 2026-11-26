/**
 * Fetch rejections that no retry can fix.
 *
 * Node's fetch reports almost every network problem as the same opaque
 * `TypeError: fetch failed`; the real reason lives on the `cause` chain. Two
 * causes are terminal: a TLS certificate the CLI does not trust (usually a
 * corporate proxy that re-signs HTTPS) and a proxy that demands credentials
 * (HTTP 407). Retrying re-sends the same request into the same wall, so the
 * caller fails on the first attempt with an error that names the fix.
 * Every other cause keeps the caller's normal retry handling.
 */

export interface FatalTransportFailure {
  /** The TLS code, or `PROXY_AUTHENTICATION_REQUIRED` for a proxy 407. */
  cause: string;
  message: string;
  nextAction: string;
}

const MAX_CAUSE_DEPTH = 6;

interface ErrorEvidence {
  codes: Set<string>;
  messages: string[];
}

/** Collect `code` values and messages from the whole `cause` / AggregateError graph. */
function collectErrorEvidence(error: unknown): ErrorEvidence {
  const codes = new Set<string>();
  const messages: string[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== 'object' || depth > MAX_CAUSE_DEPTH) return;
    if (seen.has(node)) return;
    seen.add(node);

    const record = node as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
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
  return candidates.find(candidate => codes.has(candidate));
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

/**
 * The two messages undici uses for a proxy 407: the CONNECT tunnel used for
 * HTTPS targets (`Proxy response (407) !== 200 when HTTP Tunneling`) and the
 * forwarding path (`Proxy Authentication Required (407)`).
 */
const PROXY_407_MESSAGES = [/Proxy response \(407\)/, /Proxy Authentication Required \(407\)/];

const TLS_NEXT_ACTION =
  "If your network re-signs TLS, set NODE_EXTRA_CA_CERTS to your organisation's CA bundle " +
  '(PEM), for example NODE_EXTRA_CA_CERTS=/path/to/ca.pem, then retry. Do not set ' +
  'NODE_TLS_REJECT_UNAUTHORIZED=0: it turns off certificate checks for requests that carry ' +
  'your API key.';

function hostOf(targetUrl: string): string {
  try {
    return new URL(targetUrl).host;
  } catch {
    return 'the API endpoint';
  }
}

/**
 * Return the terminal failure behind a fetch rejection, or `undefined` when
 * the cause is anything else (the caller keeps its retry handling).
 */
export function classifyFatalTransportFailure(
  error: unknown,
  targetUrl: string,
): FatalTransportFailure | undefined {
  const evidence = collectErrorEvidence(error);
  const host = hostOf(targetUrl);

  if (evidence.messages.some(message => PROXY_407_MESSAGES.some(re => re.test(message)))) {
    return {
      cause: 'PROXY_AUTHENTICATION_REQUIRED',
      message:
        `The HTTP proxy between this machine and ${host} answered 407 Proxy Authentication ` +
        'Required, so the request never reached TestSprite; the API key was not rejected.',
      nextAction:
        'Put the proxy credentials in HTTPS_PROXY (for example ' +
        'http://user:password@proxy.example:8080), or ask IT for a proxy that allows outbound ' +
        'HTTPS, then retry.',
    };
  }

  const untrusted = firstMatchingCode(evidence.codes, TLS_UNTRUSTED_CODES);
  if (untrusted !== undefined) {
    return {
      cause: untrusted,
      message:
        `TLS certificate verification failed for ${host} (${untrusted}): the certificate chain ` +
        'is not trusted. Corporate TLS interception is the usual cause; set NODE_EXTRA_CA_CERTS ' +
        "to your organisation's CA bundle if your network re-signs TLS.",
      nextAction: TLS_NEXT_ACTION,
    };
  }

  const expired = firstMatchingCode(evidence.codes, TLS_EXPIRED_CODES);
  if (expired !== undefined) {
    return {
      cause: expired,
      message:
        `TLS certificate verification failed for ${host} (${expired}): the certificate is ` +
        'expired or not yet valid. A wrong system clock or corporate TLS interception is the ' +
        "usual cause; set NODE_EXTRA_CA_CERTS to your organisation's CA bundle if your network " +
        're-signs TLS.',
      nextAction: `Check the system clock. ${TLS_NEXT_ACTION}`,
    };
  }

  const hostname = firstMatchingCode(evidence.codes, TLS_HOSTNAME_CODES);
  if (hostname !== undefined) {
    return {
      cause: hostname,
      message:
        `TLS certificate verification failed for ${host} (${hostname}): the certificate is not ` +
        'valid for that host. A wrong host or corporate TLS ' +
        "interception is the usual cause; set NODE_EXTRA_CA_CERTS to your organisation's CA " +
        'bundle if your network re-signs TLS.',
      nextAction: `Check that ${host} is the host you expect. ${TLS_NEXT_ACTION}`,
    };
  }

  return undefined;
}
