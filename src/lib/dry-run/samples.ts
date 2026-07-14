/**
 * Canned sample responses for `--dry-run`. One entry per M2 endpoint;
 * shapes match the backend facade contract and the MSW happy-path fixtures
 * in `test/mock-backend/fixtures.ts` so an agent that learned the surface
 * via dry-run sees the same wire shape it would in a real call.
 *
 * Why duplicate the test fixtures here instead of importing them:
 *  - Test files (`test/**`) are excluded from the published artifact via
 *    `package.json#files` (`["dist"]`). Anything under `src/lib/**` ships;
 *    anything under `test/**` does not. Dry-run must work for installed
 *    users, so its data has to live in `src/`.
 *  - `samples.test.ts` cross-checks this file against
 *    `test/mock-backend/fixtures.ts` shape-for-shape so drift between the
 *    two surfaces fails the build.
 *
 * If the CLI OpenAPI spec changes, both this file AND
 * `test/mock-backend/fixtures.ts` must be updated in the same PR.
 */
import type { CliProject, CliUpdateProjectResponse } from '../../commands/project.js';
import type {
  CliBulkDeleteSummary,
  CliFailureContext,
  CliFailureSummary,
  CliLatestResult,
  CliTest,
  CliTestCode,
  CliTestStep,
} from '../../commands/test.js';
import type { MeResponse } from '../../commands/auth.js';
import { buildJUnitReport } from '../junit-report.js';
import type { Page } from '../pagination.js';
import type {
  TriggerRunResponse,
  RunResponse,
  RerunResponse,
  BatchRerunResponse,
  BatchRunFreshResponse,
  ListRunsResponse,
} from '../runs.types.js';

const SAMPLE_USER_ID = '11111111-1111-4111-8111-111111111111';
const SAMPLE_KEY_ID = 'key_dryrun_2026';

const SAMPLE_PROJECT_ID = 'project_b3c91efa';
const SAMPLE_PROJECT_ID_BACKEND = 'project_a47b2c11';
const SAMPLE_TEST_ID_FAILED = 'test_8f2a4d10';
const SAMPLE_TEST_ID_PASSED = 'test_3a91bb02';
const SAMPLE_TEST_ID_BLOCKED = 'test_blocked_4f7a';
export const SAMPLE_RUN_ID = 'run_abc';
// M3.4 rerun dry-run sample IDs
const SAMPLE_RERUN_ID_BE_NAMED = 'run_rerun_be_named';
const SAMPLE_RERUN_ID_BE_PRODUCER = 'run_rerun_be_producer';
const SAMPLE_TEST_ID_BE_CONSUMER = 'test_be_consumer_01';
const SAMPLE_TEST_ID_BE_PRODUCER = 'test_be_producer_01';
const SAMPLE_RERUN_BATCH_ID_1 = 'run_batch_rerun_001';
const SAMPLE_RERUN_BATCH_ID_2 = 'run_batch_rerun_002';
const SAMPLE_TEST_ID_BATCH_1 = 'test_batch_01';
const SAMPLE_TEST_ID_BATCH_2 = 'test_batch_02';
const SAMPLE_TEST_ID_DEFERRED = 'test_deferred_01';
// M4 piece-2 — batch fresh run sample IDs
const SAMPLE_BATCH_FRESH_RUN_ID_1 = 'run_fresh_batch_001';
const SAMPLE_BATCH_FRESH_RUN_ID_2 = 'run_fresh_batch_002';
const SAMPLE_TEST_ID_FRESH_1 = 'test_fresh_wave_01';
const SAMPLE_TEST_ID_FRESH_2 = 'test_fresh_wave_02';
const SAMPLE_SNAPSHOT_ID = 'snap_2026_05_05_b2f9a1c8';
const SAMPLE_TARGET_URL = 'https://staging.example.com/checkout';
const SAMPLE_REQUEST_ID = 'req_dry-run';

export const SAMPLE_DRY_RUN_REQUEST_ID = SAMPLE_REQUEST_ID;

/**
 * Canned JUnit XML for batch `--wait --report junit --dry-run`. Mirrors the
 * fresh batch-run sample ids so agents can learn the sidecar shape offline.
 */
export function sampleJUnitReportXml(
  projectId: string = SAMPLE_PROJECT_ID,
  reportSuiteName?: string,
): string {
  return buildJUnitReport({
    suiteName: reportSuiteName ?? `testsprite:${projectId}`,
    classname: projectId,
    results: [
      {
        testId: SAMPLE_TEST_ID_FRESH_1,
        runId: SAMPLE_BATCH_FRESH_RUN_ID_1,
        status: 'passed',
      },
      {
        testId: SAMPLE_TEST_ID_FRESH_2,
        runId: SAMPLE_BATCH_FRESH_RUN_ID_2,
        status: 'failed',
        error: {
          code: 'ASSERTION',
          message: 'Expected checkout heading to be visible',
          exitCode: 1,
        },
      },
    ],
  });
}

const me: MeResponse = {
  userId: SAMPLE_USER_ID,
  keyId: SAMPLE_KEY_ID,
  scopes: ['read:projects', 'read:tests', 'write:tests', 'run:tests'],
  env: 'development',
};

const projects: CliProject[] = [
  {
    id: SAMPLE_PROJECT_ID,
    name: 'Checkout',
    type: 'frontend',
    createdFrom: 'portal',
    createdAt: '2026-04-15T10:23:00.000Z',
    updatedAt: '2026-05-05T08:12:00.000Z',
  },
  {
    id: SAMPLE_PROJECT_ID_BACKEND,
    name: 'Internal API',
    type: 'backend',
    createdFrom: 'mcp',
    createdAt: '2026-03-01T14:00:00.000Z',
    updatedAt: '2026-05-04T19:30:00.000Z',
  },
];

const tests: CliTest[] = [
  {
    id: SAMPLE_TEST_ID_FAILED,
    projectId: SAMPLE_PROJECT_ID,
    name: 'Checkout happy path',
    type: 'frontend',
    createdFrom: 'portal',
    status: 'failed',
    // G1a — priority label shown on one row so dry-run learners see the field.
    priority: 'p1',
    createdAt: '2026-04-20T11:00:00.000Z',
    updatedAt: '2026-05-05T12:34:56.000Z',
    details: {
      processingStatus: 'Idle',
      testStatus: 'Failed',
      rawStatus: 'ps=Idle; ts=Failed',
    },
  },
  {
    id: SAMPLE_TEST_ID_PASSED,
    projectId: SAMPLE_PROJECT_ID,
    name: 'Checkout — declined card',
    type: 'frontend',
    createdFrom: 'portal',
    status: 'passed',
    priority: null,
    createdAt: '2026-04-20T11:00:00.000Z',
    updatedAt: '2026-05-05T08:00:00.000Z',
    details: {
      processingStatus: 'Idle',
      testStatus: 'Passed',
      rawStatus: 'ps=Idle; ts=Passed',
    },
  },
  {
    // M2.1 piece 1: distinct `blocked` status surfaces here so a
    // dry-run learner sees how blocked rows render. Pre-M2.1 this
    // would have shown up as `failed` and would have been
    // indistinguishable from the row above.
    id: SAMPLE_TEST_ID_BLOCKED,
    projectId: SAMPLE_PROJECT_ID,
    name: 'Checkout — coupon redemption',
    type: 'frontend',
    createdFrom: 'portal',
    status: 'blocked',
    priority: null,
    createdAt: '2026-04-21T09:00:00.000Z',
    updatedAt: '2026-05-05T13:01:12.000Z',
    details: {
      processingStatus: 'Idle',
      testStatus: 'Blocked',
      rawStatus: 'ps=Idle; ts=Blocked',
    },
  },
];

const testCode: CliTestCode = {
  testId: SAMPLE_TEST_ID_FAILED,
  language: 'python',
  framework: 'playwright',
  // TestSprite test code is Python: frontend tests are Playwright
  // (`playwright.async_api`); backend tests use `requests` + assertions.
  code: [
    'import asyncio',
    'from playwright.async_api import async_playwright, expect',
    '',
    '',
    'async def run_test():',
    '    async with async_playwright() as pw:',
    '        browser = await pw.chromium.launch(headless=True)',
    '        context = await browser.new_context()',
    '        page = await context.new_page()',
    '        try:',
    '            await page.goto("https://example.com")  # target URL injected by the runner',
    '            await page.click(\'[data-testid="cart"]\')',
    '            await page.click(\'[data-testid="submit"]\')',
    '            await expect(page.get_by_role("heading", name="Order placed")).to_be_visible()',
    '        finally:',
    '            await context.close()',
    '            await browser.close()',
    '',
    '',
    'asyncio.run(run_test())',
    '',
  ].join('\n'),
  codeVersion: 'v3',
  etag: 'sha256:c7c4a4f6c1b8c2e5',
};

// Sample step list. Includes both `outcomeContributesToFailure` per-step
// flags (M2.1 piece 4) and the synthetic terminal "assertion" row
// (piece-4 follow-up — also surfaced on `/steps`, not just `/failure`).
// Step 5 is a real per-step failure → flag `true` only on that row;
// step 7 is the synthesizer's fallback for assertion-level failures
// where no per-step row caught the verdict, so dry-run learners see
// both shapes in one fixture rather than only the per-step case.
const testSteps: CliTestStep[] = [
  {
    testId: SAMPLE_TEST_ID_FAILED,
    stepIndex: 4,
    action: 'click',
    description: 'Click the cart icon',
    status: 'passed',
    screenshotUrl: 'https://s3-presigned.example.com/snap/04.png?X-Amz-dryrun',
    htmlSnapshotUrl: 'https://s3-presigned.example.com/snap/04.html?X-Amz-dryrun',
    runIdIfAvailable: SAMPLE_RUN_ID,
    codeVersion: 'v3',
    capturedAt: '2026-05-05T12:34:55.000Z',
    updatedAt: '2026-05-05T12:34:56.000Z',
    outcomeContributesToFailure: false,
  },
  {
    testId: SAMPLE_TEST_ID_FAILED,
    stepIndex: 5,
    action: 'click',
    description: 'Click the submit button',
    status: 'failed',
    screenshotUrl: 'https://s3-presigned.example.com/snap/05.png?X-Amz-dryrun',
    htmlSnapshotUrl: 'https://s3-presigned.example.com/snap/05.html?X-Amz-dryrun',
    runIdIfAvailable: SAMPLE_RUN_ID,
    codeVersion: 'v3',
    capturedAt: '2026-05-05T12:34:56.000Z',
    updatedAt: '2026-05-05T12:34:56.000Z',
    outcomeContributesToFailure: true,
  },
  {
    testId: SAMPLE_TEST_ID_FAILED,
    stepIndex: 6,
    action: 'expect',
    description: 'Expect order confirmation heading',
    status: null,
    screenshotUrl: null,
    htmlSnapshotUrl: null,
    runIdIfAvailable: SAMPLE_RUN_ID,
    codeVersion: 'v3',
    capturedAt: null,
    updatedAt: '2026-05-05T12:34:58.000Z',
    outcomeContributesToFailure: false,
  },
];

const latestResult: CliLatestResult = {
  testId: SAMPLE_TEST_ID_FAILED,
  status: 'failed',
  startedAt: '2026-05-05T12:34:00.000Z',
  finishedAt: '2026-05-05T12:34:58.000Z',
  videoUrl: 'https://s3-presigned.example.com/video/run_abc.mp4?X-Amz-dryrun',
  failureAnalysisUrl: 'https://s3-presigned.example.com/analysis/run_abc.json?X-Amz-dryrun',
  snapshotId: SAMPLE_SNAPSHOT_ID,
  runIdIfAvailable: SAMPLE_RUN_ID,
  codeVersion: 'v3',
  targetUrl: SAMPLE_TARGET_URL,
  targetUrlSource: 'run',
  failedStepIndex: 5,
  failureKind: 'assertion',
  verdict: 'failed',
  executionStatus: 'completed',
  summary: 'Failed (assertion) on step 5: expected cart badge to show 1 item, but it was empty.',
};

const failureContext: CliFailureContext = {
  snapshotId: SAMPLE_SNAPSHOT_ID,
  testId: SAMPLE_TEST_ID_FAILED,
  projectId: SAMPLE_PROJECT_ID,
  result: latestResult,
  steps: testSteps,
  code: testCode,
  failure: {
    rootCauseHypothesis:
      'Submit button has `opacity: 0.4` and is rendered as disabled. The checkout ' +
      "form's `isFormValid` predicate evaluates to false because the credit-card " +
      'field is empty.',
    recommendedFixTarget: {
      kind: 'code',
      reference: 'src/components/CheckoutForm.tsx:412',
      rationale:
        'The disabled state originates from `isFormValid()` in CheckoutForm.tsx; the ' +
        'submit button only enables when `card.number.length === 16`. The test fixture ' +
        'leaves the card field empty.',
    },
    evidence: [
      {
        kind: 'screenshot',
        stepIndex: 5,
        url: 'https://s3-presigned.example.com/evidence/run_abc/05.png?X-Amz-dryrun',
        summary:
          'Submit button has `opacity: 0.4` and is rendered as disabled. Credit-card ' +
          'field is empty. No visible error message.',
      },
      {
        kind: 'snapshot',
        stepIndex: 5,
        url: 'https://s3-presigned.example.com/evidence/run_abc/05.html?X-Amz-dryrun',
        summary:
          '`<button data-testid="submit" disabled aria-disabled="true" ' +
          'style="pointer-events:none;opacity:0.4">`. DOM diff vs. step 4 shows the ' +
          "`disabled` attribute being added by the form's onChange handler.",
      },
    ],
  },
};

/**
 * §5.2 / M2.1 piece 3 — sample for `GET /tests/{testId}/failure/summary`.
 * Mirrors the analysis fields in `failureContext.failure` so a learner
 * comparing dry-run outputs sees the same hypothesis on both surfaces.
 */
const failureSummary: CliFailureSummary = {
  testId: SAMPLE_TEST_ID_FAILED,
  status: 'failed',
  failureKind: 'assertion',
  snapshotId: SAMPLE_SNAPSHOT_ID,
  rootCauseHypothesis: failureContext.failure.rootCauseHypothesis,
  recommendedFixTarget: failureContext.failure.recommendedFixTarget,
};

/**
 * Dry-run sample lookup keyed by OpenAPI operationId. Order matters in
 * {@link findSample}: more specific patterns must precede their generic
 * siblings (e.g. `/tests/{id}/code` before `/tests/{id}`).
 */
/**
 * HTTP methods accepted by the dry-run registry. GET covered the M2
 * read surface; POST landed with M3.2 piece-2 (`POST /api/cli/v1/tests`)
 * and gained `/tests/batch` with M3.2 piece-5; PUT + DELETE landed with
 * M3.2 piece-3 (`PUT/DELETE /api/cli/v1/tests/{id}`); piece-4 added
 * `PUT /api/cli/v1/tests/{id}/code`; piece-6 added
 * `PUT /api/cli/v1/tests/{id}/plan-steps`. The list grows as new
 * mutation routes ship.
 */
export type DryRunMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface DryRunSampleEntry {
  operationId: string;
  method: DryRunMethod;
  /** Path under the `/api/cli/v1` prefix. Templated with `{name}` markers. */
  pathTemplate: string;
  /** Compiled regex matching the path (no leading prefix). */
  pattern: RegExp;
  /**
   * Response body factory. When the entry is input-derived (e.g.
   * `updateTest`, `putPlanSteps`, `createTestBatch`) the function
   * receives the parsed request body so the sample can echo back the
   * user's actual field values instead of a static canned placeholder.
   * Simple read-only endpoints use a zero-arity factory that ignores the
   * argument.
   */
  body: (requestBody?: unknown) => unknown;
}

const PATH_PREFIX = '/api/cli/v1';

const ENTRIES: DryRunSampleEntry[] = [
  entry('whoami', 'GET', '/me', me),
  entry('listProjects', 'GET', '/projects', pageOf(projects)),
  entry('getProject', 'GET', '/projects/{projectId}', projects[0]),
  // P6 — POST /projects (create project). The id uses a stable dry-run
  // sentinel so agents can see a coherent field shape without a real key.
  entry('createProject', 'POST', '/projects', {
    id: 'p_dryrun_create_2026',
    type: 'frontend',
    name: 'Dry-run project',
    createdFrom: 'cli',
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
  } satisfies CliProject),
  // P7 — PATCH /projects/{id} (update project).
  entry('updateProject', 'PATCH', '/projects/{projectId}', {
    id: SAMPLE_PROJECT_ID,
    updatedFields: ['name'],
    updatedAt: '2026-05-16T00:00:00.000Z',
  } satisfies CliUpdateProjectResponse),
  entry('listTests', 'GET', '/tests', pageOf(tests)),
  entry('getTestCode', 'GET', '/tests/{testId}/code', testCode),
  entry('listTestSteps', 'GET', '/tests/{testId}/steps', pageOf(testSteps)),
  entry('getTestResult', 'GET', '/tests/{testId}/result', latestResult),
  // `/failure/summary` MUST come before `/failure` so the regex matcher
  // doesn't shadow it with the bundle endpoint.
  entry('getTestFailureSummary', 'GET', '/tests/{testId}/failure/summary', failureSummary),
  entry('getTestFailure', 'GET', '/tests/{testId}/failure', failureContext),
  // M3.4 piece-5 — GET /tests/{testId}/runs (run-history list).
  // **MUST appear BEFORE the `/tests/{testId}` catch-all** so the more
  // specific `/runs` suffix wins the regex match. Shows two rows
  // (fresh + rerun) so dry-run learners see both `isRerun: false` and
  // `isRerun: true` shapes in one fixture.
  entry('listTestRuns', 'GET', '/tests/{testId}/runs', {
    runs: [
      {
        // G1b — fresh run with a real targetUrl stamped at trigger time.
        runId: SAMPLE_RUN_ID,
        status: 'passed',
        source: 'cli',
        isRerun: false,
        createdFrom: null,
        createdAt: '2026-06-03T10:00:00.000Z',
        startedAt: '2026-06-03T10:00:05.000Z',
        finishedAt: '2026-06-03T10:02:00.000Z',
        codeVersion: 'v1',
        failureKind: null,
        targetUrl: SAMPLE_TARGET_URL,
        targetUrlSource: 'run',
      },
      {
        // G1b — rerun row where the URL could not be resolved (shows null shape).
        runId: 'run_rerun_history_01',
        status: 'failed',
        source: 'cli',
        isRerun: true,
        createdFrom: `rerun:${SAMPLE_RUN_ID}`,
        createdAt: '2026-06-02T14:30:00.000Z',
        startedAt: '2026-06-02T14:30:10.000Z',
        finishedAt: '2026-06-02T14:32:45.000Z',
        codeVersion: 'v1',
        failureKind: 'assertion',
        targetUrl: null,
        targetUrlSource: 'unresolved',
      },
    ],
    nextCursor: null,
    meta: { testKind: 'frontend' },
  } satisfies ListRunsResponse),
  // `getTest` is the catch-all for `/tests/{id}` — must appear AFTER the
  // `/tests/{id}/{...}` siblings so the more specific patterns win.
  entry('getTest', 'GET', '/tests/{testId}', tests[0]),
  // M3.3 piece-4 — GET /runs/{runId}/failure (run-scoped artifact bundle).
  // Must appear BEFORE the /runs/{runId} catch-all so the more specific
  // /failure path wins the regex match.
  entry('getRunFailure', 'GET', '/runs/{runId}/failure', failureContext),
  // M3.2 piece-5 — POST /tests/batch (FE-only plan-steps batch create).
  // **MUST appear before `/tests`** so the more-specific path wins the
  // regex match. Input-derived response: one result per supplied spec so
  // the caller can verify their JSONL file was parsed as the right count.
  // FE specs are echoed as `created`; backend specs (which the live route
  // rejects per `runCreateBatch`'s stderr advisory) are echoed as
  // `validation_error` so a mixed-batch dry-run doesn't teach a
  // false-positive contract (codex-review P2, 2026-05-28).
  entry('createTestBatch', 'POST', '/tests/batch', (req?: unknown) => {
    const body = req != null && typeof req === 'object' ? (req as Record<string, unknown>) : {};
    const tests = Array.isArray(body.tests) ? body.tests : [];
    const count = tests.length;
    if (count === 0) {
      // No input detected — fall back to the illustrative 3-entry sample
      // (2 created + 1 validation_error) so dry-run learners still see
      // the mixed-status shape when run without body context.
      return {
        results: [
          { specIndex: 0, testId: 'test_dryrun_batch_0', status: 'created' as const },
          { specIndex: 1, testId: 'test_dryrun_batch_1', status: 'created' as const },
          {
            specIndex: 2,
            status: 'validation_error' as const,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'planSteps[0].type must be one of: "action", "assertion"',
              field: 'planSteps[0].type',
            },
          },
        ],
        summary: { total: 3, created: 2, failed: 1 },
      };
    }
    // Mirror runCreateBatch's real behavior — backend specs are rejected
    // with `validation_error`, FE specs are created. A mixed-batch dry-run
    // that marks BE specs as `created` would teach agents a false-positive
    // contract (codex-review P2, 2026-05-28).
    const results = tests.map((spec, i) => {
      if (spec && typeof spec === 'object' && (spec as { type?: unknown }).type === 'backend') {
        return {
          specIndex: i,
          testId: null,
          status: 'validation_error' as const,
          error: {
            code: 'VALIDATION_ERROR',
            message: `spec[${i}]: backend specs are not supported on POST /tests/batch — use 'test create --type backend --code-file' instead.`,
            field: 'type',
          },
        };
      }
      return {
        specIndex: i,
        testId: `test_dryrun_batch_${i}`,
        status: 'created' as const,
      };
    });
    const created = results.filter(r => r.status === 'created').length;
    const failed = results.filter(r => r.status === 'validation_error').length;
    return {
      results,
      summary: { total: count, created, failed },
    };
  }),
  // M3.2 piece-2 — POST /tests (code-based create). Input-derived response
  // so the `type` field reflects what the caller actually passed (P3-12 fix:
  // previously hardcoded to `"frontend"`, hiding BE test dry-run behaviour).
  // The `planSteps` echo a real plan-from response would carry is omitted —
  // agents see testId/codeVersion/createdAt which is enough to confirm shape.
  entry('createTestFromCode', 'POST', '/tests', (req?: unknown) => {
    const body = req != null && typeof req === 'object' ? (req as Record<string, unknown>) : {};
    const type = body.type === 'backend' ? 'backend' : 'frontend';
    return {
      testId: 'test_dryrun_create_2026',
      type,
      codeVersion: 'v1',
      createdAt: '2026-05-13T00:00:00.000Z',
    };
  }),
  // M3.2 piece-6 — PUT /tests/{id}/plan-steps (FE plan replace).
  // Input-derived response: `stepCount` reflects the actual number of
  // steps the caller supplied so they can verify their file was parsed
  // correctly. `planStepsHash` stays canned (sha256 is not worth
  // recomputing in dry-run).
  entry('putPlanSteps', 'PUT', '/tests/{testId}/plan-steps', (req?: unknown) => {
    const body = req != null && typeof req === 'object' ? (req as Record<string, unknown>) : {};
    const planSteps = Array.isArray(body.planSteps) ? body.planSteps : [];
    return {
      testId: 'test_dryrun_plan_put_2026',
      planStepsHash: 'sha256:dryrun-plan-steps-hash',
      stepCount: planSteps.length > 0 ? planSteps.length : 3,
      updatedAt: '2026-05-14T00:00:00.000Z',
    };
  }),
  // M3.2 piece-4 — PUT /tests/{id}/code (etag-guarded replace). Canned
  // response shape per the code-put design spec. The
  // `codeVersion` here is the bumped value (v3 → v4) so an agent
  // dry-running the chain sees a coherent progression: the sample
  // testCode.codeVersion is `v3`, so `put` advances to `v4`.
  entry('putTestCode', 'PUT', '/tests/{testId}/code', {
    testId: 'test_dryrun_code_put_2026',
    codeVersion: 'v4',
    updatedAt: '2026-05-13T00:00:00.000Z',
  }),
  // PUT /tests/{id} (metadata update). Input-derived response: `updatedFields`
  // echoes the keys the caller actually passed so an agent can confirm their
  // flags landed in the right fields. OpenAPI spec does not define either PATCH
  // or PUT for this path; the wire truth is whatever the backend implements
  // (currently PUT).
  entry('updateTest', 'PUT', '/tests/{testId}', (req?: unknown) => {
    const body = req != null && typeof req === 'object' ? (req as Record<string, unknown>) : {};
    const updatedFields = Object.keys(body).filter(k => body[k] !== undefined);
    return {
      testId: 'test_dryrun_update_2026',
      updatedFields: updatedFields.length > 0 ? updatedFields : ['name', 'description'],
      updatedAt: '2026-05-13T00:00:00.000Z',
    };
  }),
  // delete-batch (DELETE /tests/<id> × N). The batch sub-command dispatches
  // one DELETE /tests/{testId} per test (no batch endpoint) and aggregates
  // results into CliBulkDeleteSummary. Under --dry-run the function has an
  // inline early-exit (no network calls), so this sample is not consumed by
  // the dry-run runner itself. It is registered here as documentation of the
  // wire shape for agents learning the surface via `--dry-run --output json`,
  // and it participates in the samples.test.ts shape-guard so drift against
  // CliBulkDeleteSummary fails the build.
  //
  // **MUST appear before deleteTest** — `/tests/batch` is a literal path that
  // would otherwise match the `/tests/{testId}` wildcard (first-match-wins).
  entry('deleteBatch', 'DELETE', '/tests/batch', {
    results: [
      {
        testId: 'test_dryrun_delete_2026',
        status: 'deleted',
        deletedAt: '2026-05-13T00:00:00.000Z',
      },
      { testId: 'test_dryrun_skip_2026', status: 'skipped', error: 'not found (already deleted?)' },
    ],
    summary: { total: 2, deleted: 1, skipped: 1, failed: 0 },
  } satisfies CliBulkDeleteSummary),
  // M3.2 piece-3 — DELETE /tests/{id} (permanent hard-delete). Canned
  // response shape per the update/delete design spec.
  // `deletedAt` is the delete-time ack (no restore window). Stable
  // strings here so a `--dry-run` capture stays diff-able across runs.
  entry('deleteTest', 'DELETE', '/tests/{testId}', {
    testId: 'test_dryrun_delete_2026',
    deletedAt: '2026-05-13T00:00:00.000Z',
  }),
  // M3.3 piece-3 — POST /tests/{testId}/runs (trigger run).
  // **MUST appear before `/tests` and `/tests/{testId}` generic matchers**
  // so the more-specific runs path wins. Canned response shape per the
  // runs-trigger design spec.
  entry('triggerRun', 'POST', '/tests/{testId}/runs', {
    runId: SAMPLE_RUN_ID,
    status: 'queued',
    enqueuedAt: '2026-05-15T19:32:00.000Z',
    codeVersion: 'v1',
    targetUrl: SAMPLE_TARGET_URL,
  } satisfies TriggerRunResponse),
  // M3.4 piece-3 — POST /tests/{testId}/runs/rerun (single rerun).
  // **MUST appear before `/tests/{testId}/runs` and `/tests/{testId}`** so the
  // more-specific `/runs/rerun` path wins over the generic runs trigger.
  // Two shapes are possible (FE / BE). The sample shows a BE shape (with
  // closure) so dry-run learners see the richer response; FE callers get the
  // same response minus `closure`.
  entry('triggerRerun', 'POST', '/tests/{testId}/runs/rerun', {
    runId: SAMPLE_RERUN_ID_BE_NAMED,
    status: 'queued',
    enqueuedAt: '2026-06-03T10:00:00.000Z',
    codeVersion: 'v1',
    autoHeal: true,
    closure: {
      members: [
        { testId: SAMPLE_TEST_ID_BE_CONSUMER, runId: SAMPLE_RERUN_ID_BE_NAMED, role: 'selected' },
        {
          testId: SAMPLE_TEST_ID_BE_PRODUCER,
          runId: SAMPLE_RERUN_ID_BE_PRODUCER,
          role: 'producer',
        },
      ],
      addedProducers: [SAMPLE_TEST_ID_BE_PRODUCER],
      addedTeardowns: [],
      clearedCaptured: 0,
    },
  } satisfies RerunResponse),
  // M4 piece-2 — POST /tests/batch/run (fresh wave-ordered batch run).
  // **MUST appear before `/tests/batch/rerun` and `/tests/batch` (create)**
  // so the more-specific `/batch/run` path wins. Shows `accepted[]` with
  // per-test runIds + `skippedFrontend[]` so dry-run learners see both shapes.
  entry('triggerBatchRunFresh', 'POST', '/tests/batch/run', {
    accepted: [
      {
        testId: SAMPLE_TEST_ID_FRESH_1,
        runId: SAMPLE_BATCH_FRESH_RUN_ID_1,
        enqueuedAt: '2026-06-09T10:00:00.000Z',
      },
      {
        testId: SAMPLE_TEST_ID_FRESH_2,
        runId: SAMPLE_BATCH_FRESH_RUN_ID_2,
        enqueuedAt: '2026-06-09T10:00:00.000Z',
      },
    ],
    conflicts: [],
    deferred: [],
    skippedFrontend: [],
    skippedIntegration: [],
  } satisfies BatchRunFreshResponse),
  // M3.4 piece-3 — POST /tests/batch/rerun (batch rerun).
  // **MUST appear before `/tests/batch` (create)** so the more-specific
  // `/batch/rerun` path wins. Shows `accepted[]` with per-test runIds (C2)
  // plus a `deferred[]` example (C1) so dry-run learners see both shapes.
  entry('triggerBatchRerun', 'POST', '/tests/batch/rerun', {
    accepted: [
      {
        testId: SAMPLE_TEST_ID_BATCH_1,
        runId: SAMPLE_RERUN_BATCH_ID_1,
        enqueuedAt: '2026-06-03T10:00:00.000Z',
      },
      {
        testId: SAMPLE_TEST_ID_BATCH_2,
        runId: SAMPLE_RERUN_BATCH_ID_2,
        enqueuedAt: '2026-06-03T10:00:00.000Z',
      },
    ],
    deferred: [{ testId: SAMPLE_TEST_ID_DEFERRED, reason: 'rate_limited' }],
    conflicts: [],
    closure: {
      byProject: [
        {
          projectId: SAMPLE_PROJECT_ID_BACKEND,
          testIds: [SAMPLE_TEST_ID_BATCH_2],
          addedProducers: [],
          addedTeardowns: [],
          clearedCaptured: 0,
        },
      ],
    },
  } satisfies BatchRerunResponse),
  // M3.3 piece-3 — GET /runs/{runId} (live status / long-poll).
  // A terminal `passed` row is the most useful dry-run shape: agents see
  // what a completed run looks like, and `--wait` terminates immediately.
  // fix(2026-05-21): a duplicate failed-shape entry that appeared before
  // this entry was removed; findSample first-match-wins was always
  // returning status: "failed" for `test wait --dry-run`.
  entry('getRun', 'GET', '/runs/{runId}', {
    runId: SAMPLE_RUN_ID,
    testId: SAMPLE_TEST_ID_PASSED,
    projectId: SAMPLE_PROJECT_ID,
    userId: SAMPLE_USER_ID,
    status: 'passed',
    source: 'cli',
    createdAt: '2026-05-15T19:32:00.000Z',
    startedAt: '2026-05-15T19:32:05.000Z',
    finishedAt: '2026-05-15T19:34:00.000Z',
    codeVersion: 'v1',
    targetUrl: SAMPLE_TARGET_URL,
    createdFrom: null,
    failedStepIndex: null,
    failureKind: null,
    error: null,
    videoUrl: null,
    stepSummary: {
      total: 8,
      completed: 8,
      passedCount: 8,
      failedCount: 0,
    },
    // Representative per-run steps so `test steps --run-id <id> --dry-run`
    // demonstrates real output instead of an empty list (the generic
    // `/runs/{runId}` sample is also used by `test wait`, which ignores steps).
    steps: [
      {
        stepIndex: '0001',
        type: 'action',
        action: 'navigate',
        status: 'passed',
        description: 'Open the target URL',
        error: null,
        screenshotUrl: null,
        htmlSnapshotUrl: null,
        createdAt: '2026-05-15T19:32:10.000Z',
      },
      {
        stepIndex: '0002',
        type: 'assertion',
        action: 'assert_visible',
        status: 'passed',
        description: 'Dashboard heading is visible',
        error: null,
        screenshotUrl: null,
        htmlSnapshotUrl: null,
        createdAt: '2026-05-15T19:32:20.000Z',
      },
    ],
  } satisfies RunResponse),
];

function entry(
  operationId: string,
  method: DryRunMethod,
  pathTemplate: string,
  body: unknown | ((requestBody?: unknown) => unknown),
): DryRunSampleEntry {
  // Convert `/tests/{testId}/code` → /^\/tests\/[^/]+\/code$/
  const regexSrc = pathTemplate.replace(/\{[^}]+\}/g, '[^/]+').replace(/\//g, '\\/');
  const bodyFn =
    typeof body === 'function' ? (body as (requestBody?: unknown) => unknown) : () => body;
  return {
    operationId,
    method,
    pathTemplate,
    pattern: new RegExp(`^${regexSrc}$`),
    body: bodyFn,
  };
}

function pageOf<T>(items: T[]): Page<T> {
  // M2 dry-run always returns one page with `nextToken: null`. Auto-pagination
  // therefore terminates after the first sample. If a future piece wants to
  // exercise the cursor path in dry-run, branch on `cursor` query param in the
  // fetch impl and return a synthetic next-page on the second call.
  return { items, nextToken: null };
}

/**
 * Resolve a fetch URL to its canned sample. Matches against the path
 * portion only (query string is ignored — auto-pagination's `cursor`
 * query is intentionally a no-op in M2 dry-run; see {@link pageOf}).
 *
 * Returns `undefined` when no pattern matches; the caller (the dry-run
 * fetch impl) surfaces this as a 500 INTERNAL envelope so a missing
 * sample is loud, not silent.
 *
 * `requestBody` is forwarded to input-derived entries (`updateTest`,
 * `putPlanSteps`, `createTestBatch`) so their responses reflect the
 * user's actual flags rather than static canned values.
 */
export function findSample(
  method: string,
  url: string,
  requestBody?: unknown,
): DryRunSampleEntry | undefined {
  const upper = method.toUpperCase();
  const pathOnly = extractPath(url);
  for (const e of ENTRIES) {
    if (e.method === upper && e.pattern.test(pathOnly)) {
      // Rebind body so callers get the resolved value, not the factory.
      // We return a new object with `body` already applied so downstream
      // code can keep calling `e.body` as-before (no API break for tests
      // that call `findSample` directly).
      return { ...e, body: () => e.body(requestBody) };
    }
  }
  return undefined;
}

function extractPath(url: string): string {
  // Strip protocol+host, then strip the `/api/cli/v1` facade prefix.
  let path = url;
  const protoIdx = path.indexOf('://');
  if (protoIdx >= 0) {
    const slashIdx = path.indexOf('/', protoIdx + 3);
    path = slashIdx >= 0 ? path.slice(slashIdx) : '/';
  }
  const queryIdx = path.indexOf('?');
  if (queryIdx >= 0) path = path.slice(0, queryIdx);
  if (path.startsWith(PATH_PREFIX)) path = path.slice(PATH_PREFIX.length) || '/';
  return path;
}

/** Test-only export so `samples.test.ts` can iterate the catalog. */
export const DRY_RUN_SAMPLE_ENTRIES: ReadonlyArray<DryRunSampleEntry> = ENTRIES;
