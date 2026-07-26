/**
 * Dedicated tests for the response schemas (issue #102): the schemas must be
 * loose (additive server fields pass), mirror nullability, and turn drift
 * into a typed INTERNAL envelope at the HttpClient boundary.
 */

import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { HttpClient } from './http.js';
import {
  ME_IDENTITY_SCHEMA,
  ME_RESPONSE_SCHEMA,
  RUN_RESPONSE_SCHEMA,
  TRIGGER_RUN_RESPONSE_SCHEMA,
  USAGE_RESPONSE_SCHEMA,
} from './response-schemas.js';

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

// ---------------------------------------------------------------------------
// Account surfaces (issue #277): GET /me and its usage projection.
// ---------------------------------------------------------------------------

const VALID_ME = {
  userId: 'u_1',
  keyId: 'k_1',
  scopes: ['read:projects', 'read:tests'],
  env: 'development',
};

describe('ME_RESPONSE_SCHEMA', () => {
  it('accepts the minimal /me body and preserves unknown extra keys', () => {
    const parsed = v.safeParse(ME_RESPONSE_SCHEMA, { ...VALID_ME, plan: 'Pro' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.output as { plan?: string }).plan).toBe('Pro');
    }
  });

  it('accepts an unknown env value (a new deployment tier must not hard-fail)', () => {
    expect(v.safeParse(ME_RESPONSE_SCHEMA, { ...VALID_ME, env: 'sandbox' }).success).toBe(true);
  });

  it('leaves the absent-safe identity fields absent rather than defaulting them', () => {
    const parsed = v.safeParse(ME_RESPONSE_SCHEMA, VALID_ME);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('email' in parsed.output).toBe(false);
      expect('displayName' in parsed.output).toBe(false);
      expect('v3Enabled' in parsed.output).toBe(false);
    }
  });

  it('rejects a /me body without scopes, naming the path', () => {
    const withoutScopes: Record<string, unknown> = { ...VALID_ME };
    delete withoutScopes.scopes;
    const parsed = v.safeParse(ME_RESPONSE_SCHEMA, withoutScopes);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues.some(issue => v.getDotPath(issue) === 'scopes')).toBe(true);
    }
  });
});

describe('ME_IDENTITY_SCHEMA', () => {
  it("accepts doctor's partial identity projection (connectivity must not fail on it)", () => {
    expect(v.safeParse(ME_IDENTITY_SCHEMA, { userId: 'u-doc', keyId: 'k-doc' }).success).toBe(true);
  });

  it('carries v3Enabled through so the routing advisory still fires', () => {
    const parsed = v.safeParse(ME_IDENTITY_SCHEMA, { ...VALID_ME, v3Enabled: true });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.v3Enabled).toBe(true);
    }
  });

  it('rejects a wrongly-typed identity field', () => {
    expect(v.safeParse(ME_IDENTITY_SCHEMA, { userId: 42 }).success).toBe(false);
  });
});

describe('USAGE_RESPONSE_SCHEMA', () => {
  it("accepts today's /me body, which carries no credits fields at all", () => {
    const parsed = v.safeParse(USAGE_RESPONSE_SCHEMA, VALID_ME);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output.credits).toBeUndefined();
      // `scopes` is not part of the usage projection but must survive as an
      // unknown extra key so `--output json` stays byte-faithful.
      expect((parsed.output as { scopes?: string[] }).scopes).toEqual(VALID_ME.scopes);
    }
  });

  it('accepts the future body with credits, plan and per-run cost', () => {
    const parsed = v.safeParse(USAGE_RESPONSE_SCHEMA, {
      ...VALID_ME,
      credits: 100,
      subPlan: 'Standard',
      creditsPerRun: 2,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non-numeric credit balance instead of rendering NaN math', () => {
    const parsed = v.safeParse(USAGE_RESPONSE_SCHEMA, { ...VALID_ME, credits: '100' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.issues.some(issue => v.getDotPath(issue) === 'credits')).toBe(true);
    }
  });
});
