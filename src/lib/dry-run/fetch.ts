/**
 * Dry-run fetch implementation. Drop-in `FetchImpl` that the
 * `client-factory` swaps in when `--dry-run` is set; the existing
 * `HttpClient` keeps its single retry / debug / error path and never
 * has to know dry-run exists.
 *
 * Behavior:
 *  - Looks up a canned sample by (method, path). Path lookup ignores
 *    the host and query string (auto-pagination's `cursor` query is a
 *    no-op in M2 dry-run; see {@link findSample}).
 *  - Returns 200 with the sample body and a stable `x-request-id` so
 *    the caller's debug output is deterministic.
 *  - Missing sample → 500 INTERNAL envelope. Loud-and-broken beats a
 *    silent dry-run that returns empty data; the test suite asserts
 *    every M2 endpoint resolves.
 */
import type { FetchImpl } from '../http.js';
import { findSample, SAMPLE_DRY_RUN_REQUEST_ID } from './samples.js';

const JSON_HEADERS = {
  'content-type': 'application/json',
  'x-request-id': SAMPLE_DRY_RUN_REQUEST_ID,
};

export function createDryRunFetch(): FetchImpl {
  return async (input, init) => {
    const url = resolveUrl(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    // Parse the request body so input-derived samples (updateTest,
    // putPlanSteps, createTestBatch) can echo the user's actual fields.
    let requestBody: unknown;
    if (init?.body != null) {
      try {
        // Treat the body as a string if possible; fall back to String()
        // for any other serialisable type (e.g. Uint8Array in Node 22
        // whose toString() gives a comma-joined byte list, but in
        // practice fetch bodies are always JSON strings here).
        const raw = typeof init.body === 'string' ? init.body : String(init.body);
        requestBody = JSON.parse(raw);
      } catch {
        // Unparseable body — leave requestBody undefined; samples fall
        // back to their no-input defaults.
      }
    }

    const sample = findSample(method, url, requestBody);
    if (sample === undefined) {
      const body = JSON.stringify({
        error: {
          code: 'INTERNAL',
          message: `No dry-run sample registered for ${method} ${url}`,
          nextAction: 'Add a sample to `src/lib/dry-run/samples.ts` and re-run.',
          requestId: SAMPLE_DRY_RUN_REQUEST_ID,
          details: { method, url },
        },
      });
      return new Response(body, { status: 500, headers: JSON_HEADERS });
    }
    return new Response(JSON.stringify(sample.body()), { status: 200, headers: JSON_HEADERS });
  };
}

/**
 * Wrap a dry-run fetch implementation so `onFirstResponse` fires exactly
 * once — after the first request actually returns a response. The client
 * factory applies this to whichever fetch is in use (the default canned
 * fetch or an injected test fetch), so the dry-run banner is announced
 * lazily: never at client construction, and never when local validation
 * fails before any dry-run response is produced. If the wrapped fetch
 * rejects, no banner fires.
 */
export function withDryRunBannerOnce(fetch: FetchImpl, onFirstResponse: () => void): FetchImpl {
  let fired = false;
  return async (input, init) => {
    const res = await fetch(input, init);
    if (!fired) {
      fired = true;
      onFirstResponse();
    }
    return res;
  };
}

function resolveUrl(input: Parameters<FetchImpl>[0]): string {
  if (typeof input === 'string') return input;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inp = input as any;
  if (inp?.href !== undefined) return inp.href; // URL instance
  return inp.url; // Request instance
}
