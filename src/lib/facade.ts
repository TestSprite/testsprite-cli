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
 * Resolve the Portal dashboard deep-link for a test, given the API endpoint URL
 * already known to the CLI (from the user's credential profile).
 *
 * Coverage rule: only emit a dashboardUrl where BOTH projectId AND testId are
 * already known client-side from the create/run response — no extra network calls.
 * Currently covered commands:
 *   - `test create` / `test create-batch` (projectId from opts/spec — or, on the
 *     `--plan-from` path, from the validated plan body; testId from response).
 *   - `test run --wait`, `test wait`, `test rerun --wait` terminal output —
 *     `GET /runs/{runId}` carries both projectId and testId on the wire.
 *   - `test run --all` accepted items (projectId from opts, testId per item).
 * NOT covered (wire gap, no lookup round-trip allowed): no-wait `test run` /
 * `test rerun` trigger output (TriggerRunResponse lacks projectId) and
 * `test result` (CliLatestResult lacks projectId).
 *
 * Normalization uses `new URL()` semantics (R2):
 *   - Protocol and hostname are lowercased.
 *   - An explicit `:443` on https is treated as the default port (omitted).
 *   - Trailing slashes and FACADE_PATH suffix are stripped before parsing.
 *   - URL parse failures → undefined (no crash).
 *
 * Mapping (match on normalized protocol, hostname, and port):
 *   TESTSPRITE_PORTAL_URL env var set → that origin verbatim (highest
 *     precedence; an invalid or non-http(s) value → undefined, so a typo
 *     never produces a wrong-environment link)
 *   https://api.testsprite.com        (port absent or 443) → https://www.testsprite.com
 *   anything else (unknown host, non-https on prod, parse failure) → undefined
 *
 * Deep-link path: {portalBase}/dashboard/tests/{projectId}/test/{testId}
 */
export interface ResolvePortalOptions {
  debug?: boolean;
  stderr?: (line: string) => void;
}

export function resolvePortalUrl(
  apiUrl: string,
  projectId: string,
  testId: string,
  opts?: ResolvePortalOptions,
): string | undefined {
  const portalBase = resolvePortalBase(apiUrl, opts);
  if (portalBase === undefined) return undefined;

  // R4: encode path segments so future opaque ids (e.g. containing '#' or '?')
  // produce a valid URL without breaking the path structure.
  return `${portalBase}/dashboard/tests/${encodeURIComponent(projectId)}/test/${encodeURIComponent(testId)}`;
}

/**
 * Map the configured API endpoint to the matching Portal origin (no path).
 * Honors the TESTSPRITE_PORTAL_URL override first; otherwise same
 * normalization and host mapping as `resolvePortalUrl` (which delegates
 * here); returns undefined for unknown hosts so callers emit nothing rather
 * than a wrong-environment link.
 */
export function resolvePortalBase(apiUrl: string, opts?: ResolvePortalOptions): string | undefined {
  const stderrFn = opts?.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
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
    } catch (err) {
      if (opts?.debug) {
        const reason = err instanceof Error ? err.message : String(err);
        stderrFn(`[debug] portal override url parse failed: ${reason}`);
      }
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
  } catch (err) {
    if (opts?.debug) {
      const reason = err instanceof Error ? err.message : String(err);
      stderrFn(`[debug] portal api url parse failed: ${reason}`);
    }
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
