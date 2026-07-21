/**
 * Dedicated tests for the response schemas (issue #102): the schemas must be
 * loose (additive server fields pass), mirror nullability, and turn drift
 * into a typed INTERNAL envelope at the HttpClient boundary.
 */

import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { HttpClient } from './http.js';
import { RUN_RESPONSE_SCHEMA, TRIGGER_RUN_RESPONSE_SCHEMA } from './response-schemas.js';

const VALID_RUN = {
  runId: 'run_1',
  testId: 'test_1',
  projectId: 'p_1',
  userId: 'u_1',
  status: 'passed',
  source: 'cli',
  createdAt: '2026-06-01T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  codeVersion: 'v1',
  targetUrl: 'https://example.com',
  createdFrom: null,
  failedStepIndex: null,
  failureKind: null,
  error: null,
  videoUrl: null,
  stepSummary: { total: 0, completed: 0, passedCount: 0, failedCount: 0 },
};

function makeClient(fetchImpl: typeof fetch): HttpClient {
  return new HttpClient({
    baseUrl: 'https://api.example.com/api/cli/v1',
    apiKey: 'sk-test',
    fetchImpl,
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
}

describe('RUN_RESPONSE_SCHEMA', () => {
  it('accepts a valid run and preserves unknown extra keys (additive drift is non-breaking)', () => {
    const parsed = v.safeParse(RUN_RESPONSE_SCHEMA, {
      ...VALID_RUN,
      someFutureField: 'kept',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.output as { someFutureField?: string }).someFutureField).toBe('kept');
    }
  });

  it('rejects a run missing a required field, naming the path', () => {
    const withoutStatus: Record<string, unknown> = { ...VALID_RUN };
    delete withoutStatus.status;
    const parsed = v.safeParse(RUN_RESPONSE_SCHEMA, withoutStatus);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues.some(issue => v.getDotPath(issue) === 'status')).toBe(true);
    }
  });
});

describe('HttpClient schema hook', () => {
  it('getRun surfaces drift as a typed INTERNAL envelope with issue paths (never a blind cast)', async () => {
    const drifted: Record<string, unknown> = { ...VALID_RUN };
    delete drifted.status;
    const fetchImpl = (async () =>
      new Response(JSON.stringify(drifted), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const client = makeClient(fetchImpl);
    const rejection = await client.getRun('run_1').catch((error: unknown) => error);
    expect(rejection).toMatchObject({ code: 'INTERNAL' });
    const issues = (rejection as { getDetail: (key: string) => unknown }).getDetail('issues');
    expect(Array.isArray(issues)).toBe(true);
    expect(JSON.stringify(issues)).toContain('status');
  });

  it('a schemaless generic get still returns whatever JSON came back (unchanged behavior)', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ anything: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const client = makeClient(fetchImpl);
    await expect(client.get('/me')).resolves.toEqual({ anything: true });
  });
});

describe('TRIGGER_RUN_RESPONSE_SCHEMA', () => {
  it('accepts the queued-run envelope', () => {
    const parsed = v.safeParse(TRIGGER_RUN_RESPONSE_SCHEMA, {
      runId: 'run_1',
      status: 'queued',
      enqueuedAt: '2026-06-01T10:00:00.000Z',
      codeVersion: 'v1',
      targetUrl: 'https://example.com',
    });
    expect(parsed.success).toBe(true);
  });
});
