/**
 * Smoke tests for the `/api/cli/v1` mock backend.
 *
 * These tests do not exercise the CLI — that's P1. They prove the MSW
 * skeleton is wired correctly and that every documented endpoint and
 * canonical error envelope from the CLI error spec §9 is reachable.
 *
 * The CLI's HTTP client tests (P1) reuse the same mock backend and
 * assert the consumer-side semantics (retry, exit codes, redaction).
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_URL,
  errorHandlers,
  failureContextFixture,
  failureContextNoAnalysisFixture,
  FIXTURE_PROJECT_ID,
  FIXTURE_TEST_ID_FAILED,
  FIXTURE_TEST_ID_LARGE_CODE,
  FIXTURE_TEST_ID_NO_ANALYSIS,
  FIXTURE_TEST_ID_PASSED,
  FIXTURE_TEST_ID_RUNNING,
  latestResultFailedFixture,
  latestResultPassedFixture,
  latestResultRunningFixture,
  meFixture,
  mockBackend,
  projectFixtures,
  testCodeFixture,
  testCodeLargeFixture,
  testFixtures,
  testStepsFixture,
} from './index.js';

mockBackend.installLifecycle();

// Deliberately NOT credential-shaped. This is a mock-backend header value, but
// `tsp_dev_…` matched the release LEAK_RE's membership-namespace pattern once
// that pattern learned `tsp_` — a false positive in the one scan whose whole
// job is to refuse to publish a real key. Renaming is better than adding an
// exception: an exception for `tsp_dev_*` would also mask a real credential
// that happened to start that way.
const VALID_KEY = 'mock-backend-accepts-any-key';

function get(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('x-api-key')) headers.set('x-api-key', VALID_KEY);
  return fetch(`${DEFAULT_BASE_URL}${path}`, { ...init, headers });
}

describe('mock-backend default handlers', () => {
  it('serves /me when an API key is present', async () => {
    const res = await get('/me');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(/^req_/);
    await expect(res.json()).resolves.toEqual(meFixture);
  });

  it('returns AUTH_REQUIRED when the API key is missing', async () => {
    const res = await fetch(`${DEFAULT_BASE_URL}/me`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; nextAction: string } };
    expect(body.error.code).toBe('AUTH_REQUIRED');
    expect(body.error.nextAction).toContain('testsprite auth configure');
  });

  it('lists projects with pagination defaults', async () => {
    const res = await get('/projects');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: typeof projectFixtures; nextToken: null };
    expect(body.items).toEqual(projectFixtures);
    expect(body.nextToken).toBeNull();
  });

  it('paginates projects when pageSize is small', async () => {
    const first = await get('/projects?pageSize=1');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      items: typeof projectFixtures;
      nextToken: string | null;
    };
    expect(firstBody.items).toHaveLength(1);
    expect(firstBody.nextToken).not.toBeNull();
    const second = await get(`/projects?pageSize=1&cursor=${firstBody.nextToken}`);
    const secondBody = (await second.json()) as {
      items: typeof projectFixtures;
      nextToken: string | null;
    };
    expect(secondBody.items).toHaveLength(1);
    expect(secondBody.nextToken).toBeNull();
  });

  it('caps pageSize at 100', async () => {
    const res = await get('/projects?pageSize=999');
    expect(res.status).toBe(200);
  });

  it('serves /projects/:id', async () => {
    const res = await get(`/projects/${FIXTURE_PROJECT_ID}`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(projectFixtures[0]);
  });

  it('returns NOT_FOUND for an unknown project id', async () => {
    const res = await get('/projects/project_missing');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; details: { id: string } } };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details.id).toBe('project_missing');
  });

  it('lists tests filtered by projectId', async () => {
    const res = await get(`/tests?projectId=${FIXTURE_PROJECT_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: typeof testFixtures };
    expect(body.items).toEqual(testFixtures);
  });

  it('returns VALIDATION_ERROR when projectId is missing on /tests', async () => {
    const res = await get('/tests');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { field: string } } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.field).toBe('projectId');
  });

  it('serves /tests/:id', async () => {
    const res = await get(`/tests/${FIXTURE_TEST_ID_FAILED}`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(testFixtures[0]);
  });

  it('serves /tests/:id/code (inline body)', async () => {
    const res = await get(`/tests/${FIXTURE_TEST_ID_FAILED}/code`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof testCodeFixture;
    expect(body).toEqual(testCodeFixture);
    expect(body.code.startsWith('https://')).toBe(false);
  });

  it('serves /tests/:id/code (presigned URL when source is large)', async () => {
    const res = await get(`/tests/${FIXTURE_TEST_ID_LARGE_CODE}/code`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof testCodeLargeFixture;
    expect(body).toEqual(testCodeLargeFixture);
    expect(body.code.startsWith('https://')).toBe(true);
  });

  it('serves /tests/:id/steps', async () => {
    const res = await get(`/tests/${FIXTURE_TEST_ID_FAILED}/steps`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: typeof testStepsFixture };
    expect(body.items).toEqual(testStepsFixture);
  });

  it('serves /tests/:id/result for the failed fixture', async () => {
    const res = await get(`/tests/${FIXTURE_TEST_ID_FAILED}/result`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(latestResultFailedFixture);
  });

  it('serves /tests/:id/result for the passed fixture', async () => {
    const res = await get(`/tests/${FIXTURE_TEST_ID_PASSED}/result`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(latestResultPassedFixture);
  });

  it('serves /tests/:id/result for an in-flight run', async () => {
    const res = await get(`/tests/${FIXTURE_TEST_ID_RUNNING}/result`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof latestResultRunningFixture;
    expect(body).toEqual(latestResultRunningFixture);
    expect(body.status).toBe('running');
    // §6.5: fields not backed by current data must be `null`, not omitted.
    expect(body.finishedAt).toBeNull();
    expect(body.videoUrl).toBeNull();
    expect(body.failureAnalysisUrl).toBeNull();
    expect(body.failedStepIndex).toBeNull();
    expect(body.failureKind).toBeNull();
  });

  it('serves /tests/:id/failure for the failed fixture', async () => {
    const res = await get(`/tests/${FIXTURE_TEST_ID_FAILED}/failure`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof failureContextFixture;
    expect(body).toEqual(failureContextFixture);

    // §3 atomicity: bundle snapshotId equals the embedded result.snapshotId.
    expect(body.snapshotId).toBe(body.result.snapshotId);
    // §3 atomicity: every step shares one runIdIfAvailable.
    const runIds = new Set(body.steps.map(s => s.runIdIfAvailable));
    expect(runIds.size).toBe(1);
    expect(runIds.has(body.result.runIdIfAvailable)).toBe(true);
    // §3 atomicity: every step shares the result's codeVersion.
    expect(body.steps.every(s => s.codeVersion === body.result.codeVersion)).toBe(true);
    expect(body.code.codeVersion).toBe(body.result.codeVersion);
    // §6.2: when evidence is non-empty, at least one entry covers the failed step.
    if (body.failure.evidence.length > 0) {
      expect(body.failure.evidence.some(e => e.stepIndex === body.result.failedStepIndex)).toBe(
        true,
      );
    }
    // Every evidence URL is presigned (https), never an opaque token.
    expect(body.failure.evidence.every(e => e.url.startsWith('https://'))).toBe(true);
  });

  it('serves /tests/:id/failure with null analysis when analysis is missing', async () => {
    const res = await get(`/tests/${FIXTURE_TEST_ID_NO_ANALYSIS}/failure`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as typeof failureContextNoAnalysisFixture;
    expect(body).toEqual(failureContextNoAnalysisFixture);
    expect(body.failure.rootCauseHypothesis).toBeNull();
    expect(body.failure.recommendedFixTarget.kind).toBe('unknown');
    expect(body.failure.evidence).toEqual([]);
    // §7.4: pre-step infra failure → empty steps[] is legal.
    expect(body.steps).toEqual([]);
    // Atomicity still applies: bundle snapshotId equals result.snapshotId.
    expect(body.snapshotId).toBe(body.result.snapshotId);
  });

  it('makes the no-analysis test discoverable via /tests/:id', async () => {
    const res = await get(`/tests/${FIXTURE_TEST_ID_NO_ANALYSIS}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe(FIXTURE_TEST_ID_NO_ANALYSIS);
    expect(body.status).toBe('failed');
  });

  it('returns 404 with reason "no_failing_run" when the test is currently passing', async () => {
    const res = await get(`/tests/${FIXTURE_TEST_ID_PASSED}/failure`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; details: { reason: string } };
    };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details.reason).toBe('no_failing_run');
  });
});

describe('mock-backend canonical error envelopes', () => {
  it('AUTH_INVALID — 401 with the documented nextAction', async () => {
    mockBackend.use(errorHandlers.authInvalid());
    const res = await get('/me');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; nextAction: string } };
    expect(body.error.code).toBe('AUTH_INVALID');
    expect(body.error.nextAction).toContain('Generate a new one');
  });

  it('AUTH_FORBIDDEN — 403 with the required scope in details', async () => {
    mockBackend.use(errorHandlers.authForbidden());
    const res = await get(`/projects/${FIXTURE_PROJECT_ID}`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; details: { requiredScope: string; reason: string } };
    };
    expect(body.error.code).toBe('AUTH_FORBIDDEN');
    expect(body.error.details.requiredScope).toBe('read:projects');
    expect(body.error.details.reason).toBe('scope');
  });

  it('NOT_FOUND — 404 with resource + id in details', async () => {
    const res = await get('/projects/project_definitely_missing');
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; details: { resource: string; id: string } };
    };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details.resource).toBe('project');
    expect(body.error.details.id).toBe('project_definitely_missing');
  });

  it('NOT_FOUND override — forces 404 regardless of id', async () => {
    mockBackend.use(errorHandlers.notFound());
    const res = await get(`/projects/${FIXTURE_PROJECT_ID}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; details: { resource: string; id: string } };
    };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details.id).toBe(FIXTURE_PROJECT_ID);
  });

  it('VALIDATION_ERROR override — forces 400 with the documented nextAction', async () => {
    mockBackend.use(errorHandlers.validationError());
    const res = await get(`/tests?projectId=${FIXTURE_PROJECT_ID}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; nextAction: string; details: { field: string } };
    };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.field).toBe('pageSize');
    expect(body.error.nextAction).toContain('between 1 and 100');
  });

  it('VALIDATION_ERROR — 400 with field name in details', async () => {
    const res = await get('/tests'); // missing projectId
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; details: { field: string; reason: string } };
    };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.field).toBe('projectId');
    expect(body.error.details.reason).toBe('required');
  });

  it('CONFLICT — 409 with snapshot_in_flight reason', async () => {
    mockBackend.use(errorHandlers.conflict());
    const res = await get(`/tests/${FIXTURE_TEST_ID_FAILED}/result`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details: { reason: string } };
    };
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.details.reason).toBe('snapshot_in_flight');
  });

  it('RATE_LIMITED — 429 with Retry-After and retryAfterSec details', async () => {
    mockBackend.use(errorHandlers.rateLimited());
    const res = await get('/projects');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
    const body = (await res.json()) as {
      error: { code: string; details: { retryAfterSec: number; scope: string } };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.details.retryAfterSec).toBe(2);
    expect(body.error.details.scope).toBe('key');
  });

  it('UNSUPPORTED — 501 with feature in details', async () => {
    mockBackend.use(errorHandlers.unsupported());
    const res = await get(`/tests/${FIXTURE_TEST_ID_FAILED}/failure`);
    expect(res.status).toBe(501);
    const body = (await res.json()) as {
      error: { code: string; details: { feature: string } };
    };
    expect(body.error.code).toBe('UNSUPPORTED');
    expect(body.error.details.feature).toBe('failure_bundle');
  });

  it('INTERNAL — 500 with empty details', async () => {
    mockBackend.use(errorHandlers.internal());
    const res = await get('/me');
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; details: object } };
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.details).toEqual({});
  });

  it('UNAVAILABLE — 503 with dependency in details', async () => {
    mockBackend.use(errorHandlers.unavailable());
    const res = await get('/me');
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; details: { dependency: string } };
    };
    expect(body.error.code).toBe('UNAVAILABLE');
    expect(body.error.details.dependency).toBe('ddb');
  });

  it('every error envelope carries a non-empty requestId', async () => {
    mockBackend.use(errorHandlers.internal());
    const res = await get('/me');
    const body = (await res.json()) as { error: { requestId: string } };
    expect(body.error.requestId).toMatch(/^req_/);
    expect(res.headers.get('x-request-id')).toBe(body.error.requestId);
  });
});
