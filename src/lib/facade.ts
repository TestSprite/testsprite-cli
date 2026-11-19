/**
 * The CLI talks to a single facade rooted under `/api/cli/v1`. Users
 * configure the endpoint as a host (e.g., `https://api.testsprite.com`);
 * the CLI prepends the facade path internally so we never store the path
 * in the credentials file.
 */
export const FACADE_PATH = '/api/cli/v1';

export function facadeBaseUrl(endpointUrl: string): string {
  const trimmed = endpointUrl.endsWith('/') ? endpointUrl.slice(0, -1) : endpointUrl;
  if (trimmed.endsWith(FACADE_PATH)) return trimmed;
  return `${trimmed}${FACADE_PATH}`;
}

/**
 * Map the configured API endpoint to the matching Portal origin (no path).
 * Returns undefined for unknown hosts so callers emit nothing rather than a
 * wrong-environment link.
 *
 * Mapping (match on normalized protocol, hostname, and port):
 *   TESTSPRITE_PORTAL_URL env var set → that origin verbatim (highest
 *     precedence; an invalid or non-http(s) value → undefined, so a typo
 *     never produces a wrong-environment link)
 *   https://api.testsprite.com        (port absent or 443) → https://www.testsprite.com
 *   anything else (unknown host, non-https on prod, parse failure) → undefined
 *
 * Normalization uses `new URL()` semantics: protocol and hostname are
 * lowercased, an explicit `:443` on https is the default port, trailing
 * slashes and the FACADE_PATH suffix are stripped before parsing, and a parse
 * failure → undefined (no crash).
 */
export function resolvePortalBase(apiUrl: string): string | undefined {
  // Operator override: lets any non-prod environment point dashboard links at
  // its own Portal without a code mapping. Set-but-invalid → undefined: when
  // the caller explicitly chose an origin, falling back to the host mapping
  // could emit a wrong-environment link, which is worse than none.
  const override = process.env.TESTSPRITE_PORTAL_URL?.trim();
  if (override !== undefined && override !== '') {
    try {
      const parsedOverride = new URL(override);
      if (parsedOverride.protocol === 'https:' || parsedOverride.protocol === 'http:') {
        return override.endsWith('/') ? override.slice(0, -1) : override;
      }
    } catch {
      // fall through to undefined below
    }
    return undefined;
  }

  // Strip trailing slash, then strip FACADE_PATH suffix if present so callers
  // can pass either the raw apiUrl or the result of facadeBaseUrl().
  let raw = apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl;
  if (raw.endsWith(FACADE_PATH)) {
    raw = raw.slice(0, -FACADE_PATH.length);
  }

  // Parse with URL() for case-normalisation and port canonicalisation.
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }

  const protocol = parsed.protocol; // already lowercase, ends with ':'
  const hostname = parsed.hostname.toLowerCase();
  // `URL.port` is '' when the port is the scheme default (443 for https,
  // 80 for http). An explicit ':443' on an https URL normalises to ''.
  const port = parsed.port;

  if (
    protocol === 'https:' &&
    hostname === 'api.testsprite.com' &&
    (port === '' || port === '443')
  ) {
    return 'https://www.testsprite.com';
  }
  return undefined;
}
