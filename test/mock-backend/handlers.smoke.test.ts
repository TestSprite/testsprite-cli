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
  FIXTURE_PROJECT_ID,
  FIXTURE_RESULT_ENVIRONMENTS,
  FIXTURE_RESULT_ID_BLOCKED,
  FIXTURE_RESULT_ID_CANCELLED,
  FIXTURE_RESULT_ID_FAILED,
  FIXTURE_RESULT_ID_EARLIER,
  FIXTURE_RESULT_ID_PASSED,
  FIXTURE_RESULT_RUN_ID,
  FIXTURE_TEST_ID_BLOCKED,
  FIXTURE_TEST_ID_FAILED,
  FIXTURE_TEST_ID_LARGE_CODE,
  FIXTURE_TEST_ID_NO_ANALYSIS,
  FIXTURE_TEST_ID_PASSED,
  FIXTURE_TEST_ID_RUNNING,
  meFixture,
  mockBackend,
  projectFixtures,
  resultDetailFixtures,
  resultHistoryWindowFixture,
  resultLineFixtures,
  testFixtures,
} from './index.js';
import { RESULT_DETAIL_SCHEMA, RESULT_LIST_SCHEMA } from '../../src/lib/response-schemas.js';
import * as v from 'valibot';

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
    expect(body.error.nextAction).toContain('testsprite setup');
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

  it('makes the no-analysis test discoverable via /tests/:id', async () => {
    const res = await get(`/tests/${FIXTURE_TEST_ID_NO_ANALYSIS}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; title: string };
    expect(body.id).toBe(FIXTURE_TEST_ID_NO_ANALYSIS);
    expect(body.title).toBe('Smoke — health check');
    // The case alone: its results are read from `/results?test=`.
    expect(body).not.toHaveProperty('status');
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

  it('CONFLICT — 409 with a reason in details', async () => {
    mockBackend.use(errorHandlers.conflict());
    const res = await get(`/results/${FIXTURE_RESULT_ID_FAILED}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details: { reason: string } };
    };
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.details.reason).toBe('synthetic_conflict');
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
    const res = await get(`/results?run=${FIXTURE_RESULT_RUN_ID}`);
    expect(res.status).toBe(501);
    const body = (await res.json()) as {
      error: { code: string; details: { feature: string } };
    };
    expect(body.error.code).toBe('UNSUPPORTED');
    expect(body.error.details.feature).toBe('synthetic_feature');
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

describe('mock-backend result routes', () => {
  const idsOf = async (res: Response): Promise<string[]> =>
    ((await res.json()) as { results: Array<{ resultId: string }> }).results.map(r => r.resultId);

  const details = new Map(Object.entries(resultDetailFixtures));
  const detailOf = (resultId: string) => details.get(resultId);

  const errorOf = async (res: Response) =>
    (
      (await res.json()) as {
        error: { code: string; message: string; details: Record<string, unknown> };
      }
    ).error;

  describe('GET /results?run=', () => {
    it('lists the passed, failed and blocked results of the run, and not the cancelled one', async () => {
      const res = await get(`/results?run=${FIXTURE_RESULT_RUN_ID}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { results: Array<{ resultId: string; runId: string }> };
      expect(body.results.map(r => r.resultId)).toEqual([
        FIXTURE_RESULT_ID_BLOCKED,
        FIXTURE_RESULT_ID_FAILED,
        FIXTURE_RESULT_ID_PASSED,
      ]);
      expect(body.results.every(r => r.runId === FIXTURE_RESULT_RUN_ID)).toBe(true);
      // A run's listing carries no history fields.
      expect(Object.keys(body)).toEqual(['results']);
      expect(v.safeParse(RESULT_LIST_SCHEMA, body).success).toBe(true);
    });

    it('returns each line exactly as the fixture holds it', async () => {
      const res = await get(`/results?run=${FIXTURE_RESULT_RUN_ID}&status=failed`);
      const body = (await res.json()) as { results: unknown[] };
      expect(body.results).toEqual([
        resultLineFixtures.find(r => r.resultId === FIXTURE_RESULT_ID_FAILED),
      ]);
    });

    it('refuses a status it does not know as the server does: the reason as the message, no details', async () => {
      const res = await get(`/results?run=${FIXTURE_RESULT_RUN_ID}&status=failed,finished`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; message: string; nextAction: string; details: unknown };
      };
      expect(body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'status must be one of passed, failed, running, blocked, cancelled',
        nextAction: '',
      });
      // Strict: a nested `{}` under toMatchObject would match any details.
      expect(body.error.details).toEqual({});
    });

    it('lists the cancelled result only when status names it', async () => {
      const only = await get(`/results?run=${FIXTURE_RESULT_RUN_ID}&status=cancelled`);
      expect(await idsOf(only)).toEqual([FIXTURE_RESULT_ID_CANCELLED]);
      const every = await get(
        `/results?run=${FIXTURE_RESULT_RUN_ID}&status=passed,failed,running,blocked,cancelled`,
      );
      expect(await idsOf(every)).toEqual([
        FIXTURE_RESULT_ID_CANCELLED,
        FIXTURE_RESULT_ID_BLOCKED,
        FIXTURE_RESULT_ID_FAILED,
        FIXTURE_RESULT_ID_PASSED,
      ]);
    });

    it('reads status as a comma-separated list in any case', async () => {
      const res = await get(`/results?run=${FIXTURE_RESULT_RUN_ID}&status=Failed,%20BLOCKED`);
      expect(await idsOf(res)).toEqual([FIXTURE_RESULT_ID_BLOCKED, FIXTURE_RESULT_ID_FAILED]);
    });

    it.each(['environment=staging', 'limit=5'])('refuses %s on a run', async param => {
      const res = await get(`/results?run=${FIXTURE_RESULT_RUN_ID}&${param}`);
      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details.field).toBe(param.split('=')[0]);
    });

    it('answers NOT_FOUND for a run it does not have', async () => {
      const res = await get('/results?run=exec_missing');
      expect(res.status).toBe(404);
      expect((await errorOf(res)).details).toEqual({ resource: 'run', id: 'exec_missing' });
    });
  });

  describe('GET /results?test=', () => {
    it("lists a test's results newest first, with the history window", async () => {
      const res = await get(`/results?test=${FIXTURE_TEST_ID_FAILED}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        results: Array<{ resultId: string }>;
        hiddenRunCount: number;
        retentionDays: number | null;
      };
      expect(body.results.map(r => r.resultId)).toEqual([
        FIXTURE_RESULT_ID_FAILED,
        FIXTURE_RESULT_ID_EARLIER,
      ]);
      expect(body.hiddenRunCount).toEqual(expect.any(Number));
      expect(body).toHaveProperty('retentionDays');
      expect(v.safeParse(RESULT_LIST_SCHEMA, body).success).toBe(true);
    });

    it('takes the caseKey of any line as the test id and answers with that test only', async () => {
      const run = await get(
        `/results?run=${FIXTURE_RESULT_RUN_ID}&status=passed,failed,running,blocked,cancelled`,
      );
      const { results } = (await run.json()) as { results: Array<{ caseKey: string }> };
      const caseKeys = [...new Set(results.map(r => r.caseKey))];
      expect(caseKeys.sort()).toEqual(
        [
          FIXTURE_TEST_ID_PASSED,
          FIXTURE_TEST_ID_FAILED,
          FIXTURE_TEST_ID_BLOCKED,
          FIXTURE_TEST_ID_RUNNING,
        ].sort(),
      );
      for (const caseKey of caseKeys) {
        const res = await get(
          `/results?test=${caseKey}&status=passed,failed,running,blocked,cancelled`,
        );
        expect(res.status).toBe(200);
        const history = (await res.json()) as { results: Array<{ caseKey: string }> };
        expect(history.results.length).toBeGreaterThan(0);
        expect(history.results.every(r => r.caseKey === caseKey)).toBe(true);
      }
    });

    it('narrows by environment, by status and by limit', async () => {
      const [earlierEnv] = FIXTURE_RESULT_ENVIRONMENTS.filter(
        name =>
          name !==
          resultLineFixtures.find(r => r.resultId === FIXTURE_RESULT_ID_FAILED)?.environmentName,
      );
      const byEnv = await get(`/results?test=${FIXTURE_TEST_ID_FAILED}&environment=${earlierEnv}`);
      expect(await idsOf(byEnv)).toEqual([FIXTURE_RESULT_ID_EARLIER]);
      const byStatus = await get(`/results?test=${FIXTURE_TEST_ID_FAILED}&status=passed`);
      expect(await idsOf(byStatus)).toEqual([FIXTURE_RESULT_ID_EARLIER]);
      const byLimit = await get(`/results?test=${FIXTURE_TEST_ID_FAILED}&limit=1`);
      expect(await idsOf(byLimit)).toEqual([FIXTURE_RESULT_ID_FAILED]);
    });

    it('leaves a cancelled result out of a history unless status names it', async () => {
      const plain = await get(`/results?test=${FIXTURE_TEST_ID_RUNNING}`);
      expect(await idsOf(plain)).toEqual([]);
      const named = await get(`/results?test=${FIXTURE_TEST_ID_RUNNING}&status=cancelled`);
      expect(await idsOf(named)).toEqual([FIXTURE_RESULT_ID_CANCELLED]);
    });

    it('refuses an environment the project does not have, listing the ones it has', async () => {
      const res = await get(`/results?test=${FIXTURE_TEST_ID_FAILED}&environment=nope`);
      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details.field).toBe('environment');
      for (const name of FIXTURE_RESULT_ENVIRONMENTS) {
        expect(String(error.details.reason)).toContain(name);
      }
    });

    it.each(['limit=0', 'limit=101', 'limit=abc'])('refuses %s, naming the field', async param => {
      const res = await get(`/results?test=${FIXTURE_TEST_ID_FAILED}&${param}`);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).details.field).toBe('limit');
    });

    it('refuses status=flaky with the reason as the message and no details', async () => {
      const res = await get(`/results?test=${FIXTURE_TEST_ID_FAILED}&status=flaky`);
      expect(res.status).toBe(400);
      const error = await errorOf(res);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.message).toBe(
        'status must be one of passed, failed, running, blocked, cancelled',
      );
      expect(error.details).toEqual({});
    });

    it('answers a test that exists but has never run with an empty list, not NOT_FOUND', async () => {
      const res = await get(`/results?test=${FIXTURE_TEST_ID_LARGE_CODE}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown;
      expect(body).toEqual({
        results: [],
        hiddenRunCount: 0,
        retentionDays: resultHistoryWindowFixture.retentionDays,
      });
      expect(v.safeParse(RESULT_LIST_SCHEMA, body).success).toBe(true);
    });

    it('answers NOT_FOUND for a test it does not have', async () => {
      const res = await get('/results?test=test_missing');
      expect(res.status).toBe(404);
      expect((await errorOf(res)).details).toEqual({ resource: 'test', id: 'test_missing' });
    });

    it('looks the test up before the environment, so an unknown test with an unknown env is NOT_FOUND', async () => {
      const res = await get('/results?test=test_missing&environment=nope');
      expect(res.status).toBe(404);
      expect((await errorOf(res)).details).toEqual({ resource: 'test', id: 'test_missing' });
    });
  });

  it.each([
    ['both run and test', `/results?run=${FIXTURE_RESULT_RUN_ID}&test=${FIXTURE_TEST_ID_FAILED}`],
    ['neither run nor test', '/results'],
  ])('refuses %s', async (_what, path) => {
    const res = await get(path);
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details.field).toBe('run');
  });

  it('requires an API key on both routes', async () => {
    for (const path of [`/results?run=${FIXTURE_RESULT_RUN_ID}`, '/results/anything']) {
      const res = await fetch(`${DEFAULT_BASE_URL}${path}`);
      expect(res.status).toBe(401);
    }
  });

  describe('GET /results/:resultId', () => {
    it.each([
      FIXTURE_RESULT_ID_PASSED,
      FIXTURE_RESULT_ID_FAILED,
      FIXTURE_RESULT_ID_BLOCKED,
      FIXTURE_RESULT_ID_CANCELLED,
      FIXTURE_RESULT_ID_EARLIER,
    ])('serves %s in the shape the CLI reads', async resultId => {
      const res = await get(`/results/${resultId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(detailOf(resultId));
      // The fixture spells out every field, so parsing must change nothing.
      const parsed = v.safeParse(RESULT_DETAIL_SCHEMA, body);
      expect(parsed.success).toBe(true);
      expect(parsed.output).toEqual(body);
    });

    it('agrees with the listing about each result', () => {
      for (const line of resultLineFixtures) {
        expect(detailOf(line.resultId)).toMatchObject({
          resultId: line.resultId,
          runId: line.runId,
          caseKey: line.caseKey,
          title: line.title,
          testStatus: line.testStatus,
          error: line.error,
          blockedReason: line.blockedReason,
          created: line.created,
        });
      }
    });

    it('names the first failed step of the failed result', () => {
      const failed = detailOf(FIXTURE_RESULT_ID_FAILED)!;
      expect(failed.failedStep).toEqual(failed.steps.find(s => s.status === 'failed'));
      expect(failed.failedStep).not.toBeNull();
      expect(failed.signIn).toBeNull();
    });

    it('carries the sign-in run on the blocked result only', () => {
      for (const [resultId, detail] of Object.entries(resultDetailFixtures)) {
        if (resultId === FIXTURE_RESULT_ID_BLOCKED) {
          expect(detail.signIn?.steps.length).toBeGreaterThan(0);
          // A sign-in step has a page snapshot and no screenshot.
          expect(detail.signIn?.steps.every(s => s.screenshotSignedUrl === null)).toBe(true);
        } else {
          expect(detail.signIn).toBeNull();
        }
      }
    });

    it('answers NOT_FOUND for a result it does not have', async () => {
      const res = await get('/results/result_missing');
      expect(res.status).toBe(404);
      expect((await errorOf(res)).details).toEqual({ resource: 'result', id: 'result_missing' });
    });
  });
});
