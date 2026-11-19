import { describe, expect, test } from 'vitest';
import { resolveFailingFrontendTestId } from './failing-fe-resolver.js';

const BASE_OPTS = {
  baseUrl: 'https://api.example.com:8443/api/cli/v1',
  apiKey: 'sk-test-key',
  preferredId: 'test_pinned',
};

function fetchAnswering(status: number, body: unknown): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, urls };
}

/** A `GET /results?test=` answer whose newest result has this status. */
const latest = (testStatus: string) => ({
  results: [
    {
      resultId: 'res_1',
      runId: 'run_1',
      caseKey: 'test_pinned',
      title: 'Pinned',
      testStatus,
      processStatus: 'Idle',
      error: null,
      blockedReason: null,
      environmentName: 'default',
      created: '2026-11-01T00:00:00.000Z',
    },
  ],
});

describe('resolveFailingFrontendTestId', () => {
  test('confirms the pin through its newest result (result list) and reads nothing else', async () => {
    const api = fetchAnswering(200, latest('FAILED'));
    const result = await resolveFailingFrontendTestId({ ...BASE_OPTS, fetchImpl: api.impl });
    expect(result.testId).toBe('test_pinned');
    expect(result.reason).toContain('2026-11-01T00:00:00.000Z');
    expect(api.urls).toEqual([`${BASE_OPTS.baseUrl}/results?test=test_pinned&limit=1`]);
  });

  test('a pin that went green is reported, not used', async () => {
    const api = fetchAnswering(200, latest('PASSED'));
    const result = await resolveFailingFrontendTestId({ ...BASE_OPTS, fetchImpl: api.impl });
    expect(result.testId).toBeNull();
    expect(result.reason).toContain('passed');
  });

  test('a pin with no result yet is reported, not used', async () => {
    const api = fetchAnswering(200, { results: [], hiddenRunCount: 0, retentionDays: null });
    const result = await resolveFailingFrontendTestId({ ...BASE_OPTS, fetchImpl: api.impl });
    expect(result.testId).toBeNull();
    expect(result.reason).toContain('no result');
  });

  test('no pin, a non-OK answer and a thrown probe each come back null with the reason', async () => {
    expect(
      (await resolveFailingFrontendTestId({ ...BASE_OPTS, preferredId: undefined })).testId,
    ).toBeNull();
    const missing = fetchAnswering(404, { error: { code: 'NOT_FOUND' } });
    expect(
      (await resolveFailingFrontendTestId({ ...BASE_OPTS, fetchImpl: missing.impl })).reason,
    ).toContain('HTTP 404');
    const throwing = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    expect(
      (await resolveFailingFrontendTestId({ ...BASE_OPTS, fetchImpl: throwing })).reason,
    ).toContain('ECONNRESET');
  });
});
