/**
 * MSW handlers for the `/api/cli/v1` mock backend.
 *
 * Two layers:
 *
 *  1. {@link defaultHandlers} — all M2 endpoints serve the documented
 *     happy-path responses from the CLI OpenAPI spec. Use this when a
 *     test wants the server to "just work" so the test can focus on
 *     CLI behavior.
 *
 *  2. {@link errorHandlers} — per-code overrides that return canonical
 *     error envelopes from the CLI error spec §2. Use these via
 *     `server.use(errorHandlers.authInvalid)` to assert that the CLI
 *     exits and prints correctly for each error class.
 *
 * Both layers require an `x-api-key` header on every non-/me request;
 * the absence of a key short-circuits to `AUTH_REQUIRED` so the auth
 * loop is testable end-to-end without per-test boilerplate.
 *
 * The mock base URL is `https://api.testsprite.com/api/cli/v1`
 * (dev environment, per the OpenAPI server list). Tests that need a
 * different base URL should pass it through {@link buildHandlers}.
 */

import { http, HttpResponse } from 'msw';
import {
  FIXTURE_PROJECT_ID,
  FIXTURE_PROJECT_ID_BACKEND,
  FIXTURE_RESULT_ENVIRONMENTS,
  meFixture,
  projectFixtures,
  resultDetailFixtures,
  resultHistoryWindowFixture,
  resultLineFixtures,
  testFixtures,
} from './fixtures.js';
import { RESULT_STATUSES, requestedResultStatuses } from '../helpers/result-list.js';

export const DEFAULT_BASE_URL = 'https://api.testsprite.com/api/cli/v1';

/**
 * Canonical error code namespace, shared with the CLI error spec §2 and
 * the OpenAPI `ErrorCode` enum. Keep this list in lock-step with both —
 * adding a code here without updating the docs (or vice-versa) is a
 * contract bug, and the smoke test cross-checks the lists at runtime.
 */
export type ErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'AUTH_FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UNSUPPORTED'
  | 'INTERNAL'
  | 'UNAVAILABLE';

interface ErrorEnvelopeOptions {
  code: ErrorCode;
  message: string;
  nextAction: string;
  status: number;
  requestId?: string;
  details?: Record<string, unknown>;
  retryAfterSec?: number;
}

/**
 * Build a spec-conformant (§1) error envelope. Centralizing this here
 * means the CLI can assert against the shape, not handcraft it in every
 * test.
 */
export function errorEnvelope(opts: ErrorEnvelopeOptions): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-request-id': opts.requestId ?? `req_2026_05_05_${opts.code.toLowerCase()}`,
  };
  if (opts.retryAfterSec !== undefined) {
    headers['retry-after'] = String(opts.retryAfterSec);
  }
  const body = {
    error: {
      code: opts.code,
      message: opts.message,
      nextAction: opts.nextAction,
      requestId: headers['x-request-id'],
      details: opts.details ?? {},
    },
  };
  return new HttpResponse(JSON.stringify(body), {
    status: opts.status,
    headers,
  });
}

/**
 * Auth check shared by every endpoint other than `/me`'s
 * authentication-required envelope demonstration. Returns either
 * `null` (continue) or an early-return Response.
 */
function requireApiKey(request: Request): Response | null {
  const key = request.headers.get('x-api-key');
  if (!key) {
    return errorEnvelope({
      code: 'AUTH_REQUIRED',
      message: 'Authentication is required.',
      nextAction: 'Run `testsprite setup`, or set TESTSPRITE_API_KEY in the environment.',
      status: 401,
    });
  }
  return null;
}

/**
 * Construct the default-happy handler array. Pass a custom base URL
 * for tests that want to point the CLI at a different host (e.g.,
 * `--endpoint-url` validation).
 */
export function buildHandlers(baseUrl: string = DEFAULT_BASE_URL) {
  return [
    // /me — auth canary. No project filter; any key works.
    http.get(`${baseUrl}/me`, ({ request }) => {
      const earlyReturn = requireApiKey(request);
      if (earlyReturn) return earlyReturn;
      return HttpResponse.json(meFixture, {
        headers: { 'x-request-id': 'req_2026_05_05_me_ok' },
      });
    }),

    // /projects — list with pagination support.
    http.get(`${baseUrl}/projects`, ({ request }) => {
      const earlyReturn = requireApiKey(request);
      if (earlyReturn) return earlyReturn;
      const url = new URL(request.url);
      const pageSize = clampPageSize(url.searchParams.get('pageSize'));
      const cursor = url.searchParams.get('cursor');
      const startIdx = cursor ? Number(decodeCursor(cursor)) : 0;
      const slice = projectFixtures.slice(startIdx, startIdx + pageSize);
      const next =
        startIdx + pageSize < projectFixtures.length
          ? encodeCursor(String(startIdx + pageSize))
          : null;
      return HttpResponse.json(
        { items: slice, nextToken: next },
        { headers: { 'x-request-id': 'req_2026_05_05_projects_ok' } },
      );
    }),

    // /projects/:id
    http.get(`${baseUrl}/projects/:projectId`, ({ params, request }) => {
      const earlyReturn = requireApiKey(request);
      if (earlyReturn) return earlyReturn;
      const project = projectFixtures.find(p => p.id === params.projectId);
      if (!project) return notFoundEnvelope('project', String(params.projectId));
      return HttpResponse.json(project, {
        headers: { 'x-request-id': 'req_2026_05_05_project_ok' },
      });
    }),

    // /tests — list with required projectId and optional filters.
    http.get(`${baseUrl}/tests`, ({ request }) => {
      const earlyReturn = requireApiKey(request);
      if (earlyReturn) return earlyReturn;
      const url = new URL(request.url);
      const projectId = url.searchParams.get('projectId');
      if (!projectId) {
        return errorEnvelope({
          code: 'VALIDATION_ERROR',
          message: 'Invalid request.',
          nextAction:
            'Field `projectId` is invalid: required. See `testsprite test list --help` for accepted values.',
          status: 400,
          details: { field: 'projectId', reason: 'required' },
        });
      }
      if (projectId !== FIXTURE_PROJECT_ID && projectId !== FIXTURE_PROJECT_ID_BACKEND) {
        return notFoundEnvelope('project', projectId);
      }
      let items = testFixtures.filter(t => t.projectId === projectId);
      const type = url.searchParams.get('type');
      if (type) items = items.filter(t => t.type === type);
      return HttpResponse.json(
        { items, nextToken: null },
        { headers: { 'x-request-id': 'req_2026_05_05_tests_ok' } },
      );
    }),

    // /tests/:id
    http.get(`${baseUrl}/tests/:testId`, ({ params, request }) => {
      const earlyReturn = requireApiKey(request);
      if (earlyReturn) return earlyReturn;
      const t = testFixtures.find(t => t.id === params.testId);
      if (!t) return notFoundEnvelope('test', String(params.testId));
      return HttpResponse.json(t, {
        headers: { 'x-request-id': 'req_2026_05_05_test_ok' },
      });
    }),

    // /results — the results of one run (`run`) or one test's history (`test`).
    http.get(`${baseUrl}/results`, ({ request }) => {
      const earlyReturn = requireApiKey(request);
      if (earlyReturn) return earlyReturn;
      const query = new URL(request.url).searchParams;
      const run = query.get('run');
      const test = query.get('test');
      if (run !== null && test !== null) {
        return invalidResultQuery('run', 'pass either `run` or `test`, not both');
      }
      if (run === null && test === null) {
        return invalidResultQuery('run', 'pass one of `run` or `test`');
      }

      const statuses = requestedResultStatuses(query);
      if (statuses === undefined) return unknownResultStatus();
      const kept = resultLineFixtures.filter(line => statuses.includes(line.testStatus));

      if (run !== null) {
        for (const field of ['environment', 'limit']) {
          if (query.has(field)) {
            return invalidResultQuery(field, 'applies to `test`, not to `run`');
          }
        }
        if (!resultLineFixtures.some(line => line.runId === run)) {
          return notFoundEnvelope('run', run);
        }
        return HttpResponse.json(
          { results: kept.filter(line => line.runId === run) },
          { headers: { 'x-request-id': 'req_2026_05_05_results_run' } },
        );
      }

      const testId = String(test);
      const limit = query.has('limit') ? Number(query.get('limit')) : 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return invalidResultQuery('limit', 'limit must be an integer from 1 to 100');
      }
      // The test is looked up before the environment name is checked. A test
      // that exists but has never run has an empty history, not a 404.
      const lines = resultLineFixtures.filter(line => line.caseKey === testId);
      if (lines.length === 0 && !testFixtures.some(t => t.id === testId)) {
        return notFoundEnvelope('test', testId);
      }
      const env = query.get('environment');
      if (env !== null && !(FIXTURE_RESULT_ENVIRONMENTS as readonly string[]).includes(env)) {
        return invalidResultQuery(
          'environment',
          `no environment named "${env}"; this project has: ${FIXTURE_RESULT_ENVIRONMENTS.join(', ')}`,
        );
      }
      return HttpResponse.json(
        {
          results: kept
            .filter(line => line.caseKey === testId)
            .filter(line => env === null || line.environmentName === env)
            .slice(0, limit),
          ...resultHistoryWindowFixture,
          // A test that has never run has no runs to hold back.
          ...(lines.length === 0 ? { hiddenRunCount: 0 } : {}),
        },
        { headers: { 'x-request-id': 'req_2026_05_05_results_test' } },
      );
    }),

    // /results/:id — one result with its steps.
    http.get(`${baseUrl}/results/:resultId`, ({ params, request }) => {
      const earlyReturn = requireApiKey(request);
      if (earlyReturn) return earlyReturn;
      const detail = resultDetailFixtures[String(params.resultId)];
      if (!detail) return notFoundEnvelope('result', String(params.resultId));
      return HttpResponse.json(detail, {
        headers: { 'x-request-id': 'req_2026_05_05_result_detail' },
      });
    }),
  ];
}

/**
 * How the server refuses a `status` it does not know: its query validation
 * fails, so the reason is the message and nothing names the field.
 */
function unknownResultStatus(): Response {
  return errorEnvelope({
    code: 'VALIDATION_ERROR',
    message: `status must be one of ${RESULT_STATUSES.join(', ').toLowerCase()}`,
    nextAction: '',
    status: 400,
  });
}

/** How the server refuses the run, test, env or limit of a `/results` query. */
function invalidResultQuery(field: string, reason: string): Response {
  return errorEnvelope({
    code: 'VALIDATION_ERROR',
    message: 'Invalid request.',
    nextAction: `Field \`${field}\` is invalid: ${reason}. See \`testsprite result list --help\` for accepted values.`,
    status: 400,
    details: { field, reason },
  });
}

/** Default-happy handlers, bound to the dev base URL. */
export const defaultHandlers = buildHandlers();

/** Per-code error overrides keyed by URL pattern. */
export const errorHandlers = {
  /** Force every `/me` request to return `AUTH_INVALID`. */
  authInvalid: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/me`, () =>
      errorEnvelope({
        code: 'AUTH_INVALID',
        message: 'API key is invalid or revoked.',
        nextAction:
          'API key is invalid or revoked. Generate a new one at https://www.testsprite.com/settings/api-keys.',
        status: 401,
        details: { reason: 'revoked' },
      }),
    ),

  /** Force every `/projects/:id` request to return `AUTH_FORBIDDEN`. */
  authForbidden: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/projects/:projectId`, () =>
      errorEnvelope({
        code: 'AUTH_FORBIDDEN',
        message: 'API key does not grant the required scope.',
        nextAction:
          'This API key does not have the required scope. Ask your account owner to extend it.',
        status: 403,
        details: { requiredScope: 'read:projects', reason: 'scope' },
      }),
    ),

  /** Force every `/projects` list request to return `RATE_LIMITED`. */
  rateLimited: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/projects`, () =>
      errorEnvelope({
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded.',
        nextAction:
          'Wait `Retry-After` seconds and retry. Reduce concurrency, or contact support to raise the per-key limit.',
        status: 429,
        retryAfterSec: 2,
        details: { scope: 'key', retryAfterSec: 2 },
      }),
    ),

  /**
   * Synthetic envelope-shape fixture: force `/results/:resultId` to return
   * `CONFLICT`. The route is arbitrary (it is not documented to send a 409);
   * only the CONFLICT envelope is under test.
   */
  conflict: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/results/:resultId`, () =>
      errorEnvelope({
        code: 'CONFLICT',
        message: 'Conflict; retry shortly.',
        nextAction: 'Retry in a few seconds.',
        status: 409,
        details: { reason: 'synthetic_conflict' },
      }),
    ),

  /** Force every `/me` request to return `INTERNAL`. */
  internal: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/me`, () =>
      errorEnvelope({
        code: 'INTERNAL',
        message: 'Internal server error.',
        nextAction:
          'Server error. Retry once; if it persists, report the `requestId` to support@testsprite.com.',
        status: 500,
      }),
    ),

  /** Force every `/me` request to return `UNAVAILABLE`. */
  unavailable: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/me`, () =>
      errorEnvelope({
        code: 'UNAVAILABLE',
        message: 'Service temporarily unavailable.',
        nextAction:
          'Service is temporarily unavailable. The CLI retries with exponential backoff; if this persists, report it.',
        status: 503,
        details: { dependency: 'ddb' },
      }),
    ),

  /**
   * Synthetic envelope-shape fixture: force `/results` to return
   * `UNSUPPORTED`. The route is arbitrary (it is not documented to send a 501);
   * only the UNSUPPORTED envelope is under test.
   */
  unsupported: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/results`, () =>
      errorEnvelope({
        code: 'UNSUPPORTED',
        message: 'Operation not supported on this backend version.',
        nextAction:
          'This feature is not available on the current backend version. Upgrade the backend or use the documented fallback.',
        status: 501,
        details: { feature: 'synthetic_feature' },
      }),
    ),

  /**
   * Force every `/projects/:id` request to return `NOT_FOUND` regardless
   * of the id. Useful for testing the CLI's "check the id with `list`"
   * remediation path even on ids that the default handlers know about.
   */
  notFound: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/projects/:projectId`, ({ params }) =>
      errorEnvelope({
        code: 'NOT_FOUND',
        message: 'Resource not found.',
        nextAction:
          'Check the id with the corresponding `list` command, e.g. `testsprite test list --project <id>`.',
        status: 404,
        details: { resource: 'project', id: String(params.projectId) },
      }),
    ),

  /**
   * Force `/tests` to return `VALIDATION_ERROR` regardless of the query
   * string, so tests can assert `nextAction` and exit-code-5 mapping
   * without crafting a specifically-malformed request.
   */
  validationError: (baseUrl: string = DEFAULT_BASE_URL) =>
    http.get(`${baseUrl}/tests`, () =>
      errorEnvelope({
        code: 'VALIDATION_ERROR',
        message: 'Invalid request.',
        nextAction:
          'Field `pageSize` is invalid: must be between 1 and 100. See `testsprite test list --help` for accepted values.',
        status: 400,
        details: { field: 'pageSize', reason: 'must be between 1 and 100' },
      }),
    ),
} as const;

/**
 * Unmapped test ids (e.g. {@link FIXTURE_TEST_ID_NOT_FOUND from './fixtures.js'})
 * fall through every routed handler above and return `NOT_FOUND` via the
 * matching path's own logic. The fixture export is kept for tests that
 * need to reference an explicit "missing" id without inventing a string.
 */
function clampPageSize(raw: string | null): number {
  if (!raw) return 25;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 25;
  return Math.min(parsed, 100);
}

function decodeCursor(raw: string): string {
  return Buffer.from(raw, 'base64').toString('utf8');
}

function encodeCursor(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64');
}

function notFoundEnvelope(resource: string, id: string): Response {
  return errorEnvelope({
    code: 'NOT_FOUND',
    message: 'Resource not found.',
    nextAction:
      'Check the id with the corresponding `list` command, e.g. `testsprite test list --project <id>`.',
    status: 404,
    details: { resource, id },
  });
}
