/**
 * Unit tests for the failing-FE-test auto-resolver.
 *
 * All network calls are replaced with a `fetchImpl` injection so no real
 * dev backend is needed. Runs via `npm test` (vitest.config.ts) — excluded
 * from the live-dev suite (vitest.dev-e2e.config.ts).
 */

import { describe, expect, test } from 'vitest';
import { resolveFailingFrontendTestId } from './failing-fe-resolver.js';
import type { TestListItem } from './failing-fe-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_OPTS = {
  baseUrl: 'https://api.example.com:8443/api/cli/v1',
  apiKey: 'sk-test-key',
  projectId: 'proj_abc123',
};

function makeFetchReturning(
  pages: Array<{ items: TestListItem[]; nextToken: string | null }>,
): typeof fetch {
  let call = 0;
  return async (_url: string | URL | Request, _init?: RequestInit) => {
    const page = pages[call] ?? { items: [], nextToken: null };
    call++;
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function makeItem(
  id: string,
  updatedAt: string,
  type: 'frontend' | 'backend' = 'frontend',
  status = 'failed',
): TestListItem {
  return { id, type, status, updatedAt };
}

/**
 * URL-routing fetch stub for the preferredId direct-probe path:
 * `GET /tests/{id}` (no query string) is answered from `preferred`;
 * `GET /tests?...` list calls are answered from `pages` in order.
 * Call counts are exposed so tests can assert which endpoints were hit.
 */
function makeRoutedFetch(opts: {
  preferred?: { status: number; body: unknown };
  preferredThrows?: boolean;
  pages: Array<{ items: TestListItem[]; nextToken: string | null }>;
}) {
  let listCalls = 0;
  let preferredCalls = 0;
  const impl = (async (url: string | URL | Request) => {
    const u = String(url);
    if (/\/tests\/[^/?]+$/.test(u)) {
      preferredCalls++;
      if (opts.preferredThrows) throw new Error('ECONNRESET (direct probe)');
      const p = opts.preferred ?? { status: 404, body: { error: 'not found' } };
      return new Response(JSON.stringify(p.body), {
        status: p.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const page = opts.pages[listCalls] ?? { items: [], nextToken: null };
    listCalls++;
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, counts: () => ({ listCalls, preferredCalls }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveFailingFrontendTestId', () => {
  test('returns null when API responds with non-ok status', async () => {
    const fetchImpl = async () => new Response('{"error":"unauthorized"}', { status: 401 });
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBeNull();
    expect(result.reason).toContain('HTTP 401');
  });

  test('returns null when items array is missing from response', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ notItems: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBeNull();
    expect(result.reason).toContain('items array');
  });

  test('returns null when no failed frontend tests exist', async () => {
    const fetchImpl = makeFetchReturning([{ items: [], nextToken: null }]);
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBeNull();
    expect(result.reason).toContain('No frontend tests');
  });

  test('returns the single failed frontend test when there is exactly one', async () => {
    const item = makeItem('test_abc', '2026-05-15T10:00:00Z');
    const fetchImpl = makeFetchReturning([{ items: [item], nextToken: null }]);
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBe('test_abc');
  });

  test('picks the most recently updated item across multiple candidates', async () => {
    const older = makeItem('test_old', '2026-05-01T00:00:00Z');
    const newer = makeItem('test_new', '2026-05-15T22:00:00Z');
    const middle = makeItem('test_mid', '2026-05-10T12:00:00Z');
    const fetchImpl = makeFetchReturning([{ items: [older, newer, middle], nextToken: null }]);
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBe('test_new');
  });

  test('filters out backend-type items even when they have status=failed', async () => {
    const beTtest = makeItem('test_be', '2026-05-20T00:00:00Z', 'backend', 'failed');
    const feTest = makeItem('test_fe', '2026-05-01T00:00:00Z', 'frontend', 'failed');
    const fetchImpl = makeFetchReturning([{ items: [beTtest, feTest], nextToken: null }]);
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    // Must pick the frontend test, not the newer backend one
    expect(result.testId).toBe('test_fe');
  });

  test('filters out non-failed items even when they are frontend type', async () => {
    const passed = makeItem('test_passed', '2026-05-20T00:00:00Z', 'frontend', 'passed');
    const failed = makeItem('test_failed', '2026-05-01T00:00:00Z', 'frontend', 'failed');
    const fetchImpl = makeFetchReturning([{ items: [passed, failed], nextToken: null }]);
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBe('test_failed');
  });

  test('follows pagination across multiple pages and picks freshest overall', async () => {
    const page1Item = makeItem('test_p1', '2026-05-10T00:00:00Z');
    const page2Item = makeItem('test_p2', '2026-05-20T00:00:00Z');
    const fetchImpl = makeFetchReturning([
      { items: [page1Item], nextToken: 'cursor_abc' },
      { items: [page2Item], nextToken: null },
    ]);
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBe('test_p2');
  });

  test('stops pagination at maxPages and still returns best candidate so far', async () => {
    const item = makeItem('test_p1', '2026-05-10T00:00:00Z');
    // Provide 3 pages but cap at maxPages=1
    const fetchImpl = makeFetchReturning([
      { items: [item], nextToken: 'cursor_1' },
      { items: [makeItem('test_p2', '2026-05-20T00:00:00Z')], nextToken: 'cursor_2' },
      { items: [makeItem('test_p3', '2026-05-25T00:00:00Z')], nextToken: null },
    ]);
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
      maxPages: 1,
    });
    // Only page 1 was fetched
    expect(result.testId).toBe('test_p1');
  });

  test('returns null with a reason when fetch throws a network error', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBeNull();
    expect(result.reason).toContain('ECONNREFUSED');
  });

  test('includes updatedAt in the reason string for auditing', async () => {
    const item = makeItem('test_abc', '2026-05-27T09:00:00Z');
    const fetchImpl = makeFetchReturning([{ items: [item], nextToken: null }]);
    const result = await resolveFailingFrontendTestId({
      ...BASE_OPTS,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.testId).toBe('test_abc');
    expect(result.reason).toContain('2026-05-27T09:00:00Z');
  });

  // A dedicated pinned fixture must win over a fresher incidental failure —
  // live-reproduced 2026-07-16 (a passingFrontendTestId fresh-run flip
  // immediately outranked a dedicated "always red" fixture by updatedAt).
  // See ResolverOptions.preferredId doc comment.
  describe('preferredId (pinned-fixture preference)', () => {
    test('prefers the pinned id over a fresher candidate when the direct probe is non-ok', async () => {
      // Probe answers HTTP 500 (not ok, no throw) → falls through to the list
      // scan, where the in-candidates preference must still pick the pinned id.
      const routed = makeRoutedFetch({
        preferred: { status: 500, body: { error: 'internal' } },
        pages: [
          {
            items: [
              makeItem('test_pinned', '2026-05-01T00:00:00Z'),
              makeItem('test_incidental', '2026-05-20T00:00:00Z'),
            ],
            nextToken: null,
          },
        ],
      });
      const result = await resolveFailingFrontendTestId({
        ...BASE_OPTS,
        fetchImpl: routed.impl,
        preferredId: 'test_pinned',
      });
      expect(result.testId).toBe('test_pinned');
      expect(result.reason).toContain('Preferred pinned');
      expect(routed.counts()).toEqual({ listCalls: 1, preferredCalls: 1 });
    });

    test('falls back to freshest when the pinned id is not in the failed set', async () => {
      // Probe returns 200 with a malformed body (no type/status fields) →
      // falls through; pinned is absent from the list → freshest wins.
      const routed = makeRoutedFetch({
        preferred: { status: 200, body: {} },
        pages: [{ items: [makeItem('test_incidental', '2026-05-20T00:00:00Z')], nextToken: null }],
      });
      const result = await resolveFailingFrontendTestId({
        ...BASE_OPTS,
        fetchImpl: routed.impl,
        preferredId: 'test_pinned_but_now_passing',
      });
      expect(result.testId).toBe('test_incidental');
    });

    test('behaves exactly as before when preferredId is not supplied', async () => {
      const older = makeItem('test_old', '2026-05-01T00:00:00Z');
      const newer = makeItem('test_new', '2026-05-20T00:00:00Z');
      const fetchImpl = makeFetchReturning([{ items: [older, newer], nextToken: null }]);
      const result = await resolveFailingFrontendTestId({
        ...BASE_OPTS,
        fetchImpl: fetchImpl as typeof fetch,
      });
      expect(result.testId).toBe('test_new');
    });

    // The direct probe makes the preference immune to the maxPages
    // list-scan cap — a pinned fixture beyond the last scanned page must
    // still win, without any list call at all on the happy path.
    test('direct probe wins without any list call when the pinned test is failed', async () => {
      const routed = makeRoutedFetch({
        preferred: {
          status: 200,
          body: {
            ...makeItem('test_pinned', '2026-05-01T00:00:00Z'),
            projectId: BASE_OPTS.projectId,
          },
        },
        pages: [{ items: [makeItem('test_incidental', '2026-05-20T00:00:00Z')], nextToken: null }],
      });
      const result = await resolveFailingFrontendTestId({
        ...BASE_OPTS,
        fetchImpl: routed.impl,
        preferredId: 'test_pinned',
        maxPages: 1,
      });
      expect(result.testId).toBe('test_pinned');
      expect(result.reason).toContain('direct GET');
      expect(routed.counts()).toEqual({ listCalls: 0, preferredCalls: 1 });
    });

    test('direct probe on a now-passing pinned test falls through to freshest', async () => {
      const routed = makeRoutedFetch({
        preferred: {
          status: 200,
          body: {
            ...makeItem('test_pinned', '2026-05-25T00:00:00Z', 'frontend', 'passed'),
            projectId: BASE_OPTS.projectId,
          },
        },
        pages: [{ items: [makeItem('test_incidental', '2026-05-20T00:00:00Z')], nextToken: null }],
      });
      const result = await resolveFailingFrontendTestId({
        ...BASE_OPTS,
        fetchImpl: routed.impl,
        preferredId: 'test_pinned',
      });
      expect(result.testId).toBe('test_incidental');
      expect(routed.counts()).toEqual({ listCalls: 1, preferredCalls: 1 });
    });

    test('direct probe error falls through to the list scan, where the pinned id still wins', async () => {
      const routed = makeRoutedFetch({
        preferredThrows: true,
        pages: [
          {
            items: [
              makeItem('test_pinned', '2026-05-01T00:00:00Z'),
              makeItem('test_incidental', '2026-05-20T00:00:00Z'),
            ],
            nextToken: null,
          },
        ],
      });
      const result = await resolveFailingFrontendTestId({
        ...BASE_OPTS,
        fetchImpl: routed.impl,
        preferredId: 'test_pinned',
      });
      expect(result.testId).toBe('test_pinned');
      expect(result.reason).toContain('Preferred pinned');
      expect(routed.counts()).toEqual({ listCalls: 1, preferredCalls: 1 });
    });

    test('direct probe on a pinned test from a DIFFERENT project falls through', async () => {
      // The pin points at a genuinely failed FE test — but in another
      // project. The old list scan (projectId-filtered server-side) would
      // never have returned it, so the direct probe must not let it win.
      const routed = makeRoutedFetch({
        preferred: {
          status: 200,
          body: { ...makeItem('test_pinned', '2026-05-01T00:00:00Z'), projectId: 'proj_OTHER' },
        },
        pages: [{ items: [makeItem('test_incidental', '2026-05-20T00:00:00Z')], nextToken: null }],
      });
      const result = await resolveFailingFrontendTestId({
        ...BASE_OPTS,
        fetchImpl: routed.impl,
        preferredId: 'test_pinned',
      });
      expect(result.testId).toBe('test_incidental');
      expect(routed.counts()).toEqual({ listCalls: 1, preferredCalls: 1 });
    });

    test('direct probe 404 falls through and freshest wins when pinned is absent everywhere', async () => {
      const routed = makeRoutedFetch({
        preferred: { status: 404, body: { error: 'not found' } },
        pages: [{ items: [makeItem('test_incidental', '2026-05-20T00:00:00Z')], nextToken: null }],
      });
      const result = await resolveFailingFrontendTestId({
        ...BASE_OPTS,
        fetchImpl: routed.impl,
        preferredId: 'test_pinned_deleted',
      });
      expect(result.testId).toBe('test_incidental');
      expect(routed.counts()).toEqual({ listCalls: 1, preferredCalls: 1 });
    });
  });
});
