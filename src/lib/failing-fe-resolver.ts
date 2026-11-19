/**
 * Dev-e2e fixture resolver: confirms that the pinned `failingFrontendTestId`
 * from `fixtures.local.json` is still failing, by its latest result. The
 * suite's failing-path assertions need a test whose larun is red; a pin
 * that went green is reported, never silently used.
 *
 * `test list` says nothing about results, so there is no scan for "the
 * freshest failed test": the pin is the one source, as the README asks for a
 * dedicated, permanently-red fixture.
 */

import type { ResultList } from './result/types.js';

export interface ResolverOptions {
  /** Base URL for the CLI v1 API (e.g. https://api.testsprite.com/api/cli/v1) */
  baseUrl: string;
  /** API key sent as x-api-key header */
  apiKey: string;
  /** The static `failingFrontendTestId` from fixtures.local.json. */
  preferredId?: string;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
}

export interface ResolverResult {
  testId: string | null;
  reason: string;
}

/**
 * A test's newest result, as `result list --test <test-id> --limit 1` reads
 * it: newest first, cancelled results left out.
 */
export function latestResultPath(testId: string): string {
  return `/results?test=${encodeURIComponent(testId)}&limit=1`;
}

export async function resolveFailingFrontendTestId(opts: ResolverOptions): Promise<ResolverResult> {
  const { baseUrl, apiKey, preferredId } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!preferredId) {
    return { testId: null, reason: 'no failingFrontendTestId pinned in fixtures.local.json' };
  }
  const path = latestResultPath(preferredId);
  try {
    const resp = await fetchImpl(`${baseUrl}${path}`, {
      headers: {
        'x-api-key': apiKey,
        'x-request-id': `dev-e2e-resolver-${Date.now()}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      return {
        testId: null,
        reason: `GET ${path} returned HTTP ${resp.status}; static fixture used as-is`,
      };
    }
    const latest = ((await resp.json()) as Partial<ResultList>).results?.[0];
    if (!latest) {
      return {
        testId: null,
        reason: `pinned failingFrontendTestId (${preferredId}) has no result yet; run it, or re-pin a red fixture`,
      };
    }
    const status = latest.testStatus?.toLowerCase() ?? 'unknown';
    if (status === 'failed') {
      return {
        testId: preferredId,
        reason: `pinned failingFrontendTestId (${preferredId}) is still failing (latest result created ${latest.created ?? 'unknown'})`,
      };
    }
    return {
      testId: null,
      reason: `pinned failingFrontendTestId (${preferredId}) has latest result ${status}, not failed; re-pin a red fixture`,
    };
  } catch (err) {
    return {
      testId: null,
      reason: `probe of the pinned failingFrontendTestId failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
