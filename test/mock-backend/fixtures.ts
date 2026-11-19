/**
 * Deterministic fixtures for the `/api/cli/v1` mock backend.
 *
 * Mirrors the backend facade contract examples one-for-one — the smoke tests in
 * `handlers.smoke.test.ts` verify both ends agree.
 *
 * Why deterministic:
 * - Snapshot tests compare CLI output byte-for-byte, so timestamps,
 *   ids, and request ids must be stable across test runs.
 * - The `requestId` strings here are used by the error-envelope tests
 *   to verify the CLI forwards them to stderr verbatim.
 */

import type { ResultDetail, ResultLine, ResultStep } from '../../src/lib/result/types.js';

export const FIXTURE_DEV_USER_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_KEY_ID = 'key_2026_05_05_abc';

export const FIXTURE_PROJECT_ID = 'project_b3c91efa';
export const FIXTURE_PROJECT_ID_BACKEND = 'project_a47b2c11';
export const FIXTURE_TEST_ID_FAILED = 'test_8f2a4d10';
export const FIXTURE_TEST_ID_PASSED = 'test_3a91bb02';
export const FIXTURE_TEST_ID_NO_ANALYSIS = 'test_5d92e007';
export const FIXTURE_TEST_ID_RUNNING = 'test_running_77c2';
export const FIXTURE_TEST_ID_BLOCKED = 'test_blocked_4f7a';
export const FIXTURE_TEST_ID_LARGE_CODE = 'test_large_code_42b9';
export const FIXTURE_TEST_ID_NOT_FOUND = 'test_does_not_exist';
export const FIXTURE_TARGET_URL = 'https://staging.example.com/checkout';

export const meFixture = {
  userId: FIXTURE_DEV_USER_ID,
  keyId: FIXTURE_KEY_ID,
  scopes: ['read:projects', 'read:tests'] as const,
  env: 'development' as const,
};

export const projectFixtures = [
  {
    id: FIXTURE_PROJECT_ID,
    name: 'Checkout',
    type: 'frontend' as const,
    createdFrom: 'portal' as const,
    createdAt: '2026-04-15T10:23:00.000Z',
    updatedAt: '2026-05-05T08:12:00.000Z',
  },
  {
    id: FIXTURE_PROJECT_ID_BACKEND,
    name: 'Internal API',
    type: 'backend' as const,
    createdFrom: 'mcp' as const,
    createdAt: '2026-03-01T14:00:00.000Z',
    updatedAt: '2026-05-04T19:30:00.000Z',
  },
];

export const testFixtures = [
  {
    id: FIXTURE_TEST_ID_FAILED,
    projectId: FIXTURE_PROJECT_ID,
    projectName: 'Checkout',
    slug: 'CHECKOUT-001',
    title: 'Checkout happy path',
    description: null,
    type: 'frontend' as const,
    category: 'Checkout',
    priority: 'High',
    version: { hash: 'a3f9c2e1d4b7', label: 'v1.0' },
    stepCount: 6,
    createdAt: '2026-04-20T11:00:00.000Z',
    updatedAt: '2026-05-05T12:34:56.000Z',
  },
  {
    id: FIXTURE_TEST_ID_PASSED,
    projectId: FIXTURE_PROJECT_ID,
    projectName: 'Checkout',
    slug: 'CHECKOUT-002',
    title: 'Checkout — declined card',
    description: null,
    type: 'frontend' as const,
    category: 'Checkout',
    priority: null,
    version: { hash: '7c1e0b9a5d22', label: 'v1.0' },
    stepCount: 5,
    createdAt: '2026-04-20T11:00:00.000Z',
    updatedAt: '2026-05-05T08:00:00.000Z',
  },
  {
    id: FIXTURE_TEST_ID_NO_ANALYSIS,
    projectId: FIXTURE_PROJECT_ID,
    projectName: 'Checkout',
    slug: 'SMOKE-001',
    title: 'Smoke — health check',
    description: null,
    type: 'backend' as const,
    category: 'Smoke',
    priority: null,
    version: { hash: '0d1e2f3a4b5c', label: 'v1.0' },
    stepCount: null,
    createdAt: '2026-04-22T09:00:00.000Z',
    updatedAt: '2026-05-05T11:00:30.000Z',
  },
  {
    id: FIXTURE_TEST_ID_RUNNING,
    projectId: FIXTURE_PROJECT_ID,
    projectName: 'Checkout',
    slug: 'CHECKOUT-003',
    title: 'Checkout — concurrent users',
    description: null,
    type: 'frontend' as const,
    category: 'Checkout',
    priority: null,
    version: { hash: '6a7b8c9d0e1f', label: 'v1.0' },
    stepCount: 4,
    createdAt: '2026-04-25T15:00:00.000Z',
    updatedAt: '2026-05-05T12:34:00.000Z',
  },
  {
    id: FIXTURE_TEST_ID_BLOCKED,
    projectId: FIXTURE_PROJECT_ID,
    projectName: 'Checkout',
    slug: 'CHECKOUT-004',
    title: 'Checkout — coupon redemption',
    description: null,
    type: 'frontend' as const,
    category: 'Checkout',
    priority: null,
    version: { hash: 'e5d4c3b2a101', label: 'v1.0' },
    stepCount: 6,
    createdAt: '2026-04-21T09:00:00.000Z',
    updatedAt: '2026-05-05T13:01:12.000Z',
  },
  {
    id: FIXTURE_TEST_ID_LARGE_CODE,
    projectId: FIXTURE_PROJECT_ID,
    projectName: 'Checkout',
    slug: 'E2E-001',
    title: 'End-to-end suite — full',
    description: null,
    type: 'frontend' as const,
    category: 'End-to-end',
    priority: null,
    version: { hash: '1f2e3d4c5b6a', label: 'v1.0' },
    stepCount: 40,
    createdAt: '2026-04-28T09:00:00.000Z',
    updatedAt: '2026-05-04T18:00:00.000Z',
  },
];

// ---------------------------------------------------------------------------
// GET /results, GET /results/:resultId
// ---------------------------------------------------------------------------

/** One run with a passed, a failed, a blocked and a cancelled result. */
export const FIXTURE_RESULT_RUN_ID = 'exec_7c41d9e2';
/** An earlier run that holds one older result of the failed test. */
export const FIXTURE_RESULT_RUN_ID_EARLIER = 'exec_3b08aa15';
export const FIXTURE_RESULT_ID_PASSED = 'result_passed_01';
export const FIXTURE_RESULT_ID_FAILED = 'result_failed_02';
export const FIXTURE_RESULT_ID_BLOCKED = 'result_blocked_03';
/** Listed only when `status` names `cancelled`. */
export const FIXTURE_RESULT_ID_CANCELLED = 'result_cancelled_04';
export const FIXTURE_RESULT_ID_EARLIER = 'result_earlier_05';
/** The environment names `?test=…&env=` accepts; any other name is a 400. */
export const FIXTURE_RESULT_ENVIRONMENTS = ['staging', 'production'] as const;

/**
 * Every result the mock holds, newest first, as `GET /results` lists them.
 * A line's `caseKey` is the id of its test: the value `?test=` takes.
 */
export const resultLineFixtures: ResultLine[] = [
  {
    resultId: FIXTURE_RESULT_ID_CANCELLED,
    runId: FIXTURE_RESULT_RUN_ID,
    caseKey: FIXTURE_TEST_ID_RUNNING,
    title: 'Order history lists the last order',
    testStatus: 'CANCELLED',
    processStatus: 'Idle',
    error: null,
    blockedReason: null,
    environmentName: 'staging',
    created: '2026-05-05T12:34:03.000Z',
  },
  {
    resultId: FIXTURE_RESULT_ID_BLOCKED,
    runId: FIXTURE_RESULT_RUN_ID,
    caseKey: FIXTURE_TEST_ID_BLOCKED,
    title: 'Account page shows the current plan',
    testStatus: 'BLOCKED',
    processStatus: 'Idle',
    error: null,
    blockedReason: 'Sign-in failed, so the test never started.',
    environmentName: 'staging',
    created: '2026-05-05T12:34:02.000Z',
  },
  {
    resultId: FIXTURE_RESULT_ID_FAILED,
    runId: FIXTURE_RESULT_RUN_ID,
    caseKey: FIXTURE_TEST_ID_FAILED,
    title: 'Checkout shows the order confirmation',
    testStatus: 'FAILED',
    processStatus: 'Idle',
    error: 'Expected the order confirmation heading, but it never appeared.',
    blockedReason: null,
    environmentName: 'staging',
    created: '2026-05-05T12:34:01.000Z',
  },
  {
    resultId: FIXTURE_RESULT_ID_PASSED,
    runId: FIXTURE_RESULT_RUN_ID,
    caseKey: FIXTURE_TEST_ID_PASSED,
    title: 'Login with a valid account',
    testStatus: 'PASSED',
    processStatus: 'Idle',
    error: null,
    blockedReason: null,
    environmentName: 'staging',
    created: '2026-05-05T12:34:00.000Z',
  },
  {
    resultId: FIXTURE_RESULT_ID_EARLIER,
    runId: FIXTURE_RESULT_RUN_ID_EARLIER,
    caseKey: FIXTURE_TEST_ID_FAILED,
    title: 'Checkout shows the order confirmation',
    testStatus: 'PASSED',
    processStatus: 'Idle',
    error: null,
    blockedReason: null,
    environmentName: 'production',
    created: '2026-05-04T09:00:00.000Z',
  },
];

/** What a test's history reports about the plan's history window. */
export const resultHistoryWindowFixture = { hiddenRunCount: 2, retentionDays: 30 };

const resultStepFixtures: ResultStep[] = [
  {
    stepIndex: '1',
    type: 'action',
    action: 'click',
    description: 'Click the cart icon',
    status: 'passed',
    selector: '[data-testid="cart"]',
    url: FIXTURE_TARGET_URL,
    healed: false,
    screenshotSignedUrl: 'https://s3-presigned.example.com/snap/01.png?X-Amz-fixture',
    htmlSignedUrl: 'https://s3-presigned.example.com/snap/01.html?X-Amz-fixture',
  },
  {
    stepIndex: '2',
    type: 'action',
    action: 'click',
    description: 'Click the submit button',
    status: 'passed',
    selector: 'button[type="submit"]',
    url: FIXTURE_TARGET_URL,
    healed: true,
    screenshotSignedUrl: 'https://s3-presigned.example.com/snap/02.png?X-Amz-fixture',
    htmlSignedUrl: 'https://s3-presigned.example.com/snap/02.html?X-Amz-fixture',
  },
  {
    stepIndex: '3',
    type: 'assertion',
    action: 'expect',
    description: 'Expect the order confirmation heading',
    status: 'failed',
    selector: 'h1.confirmation',
    url: FIXTURE_TARGET_URL,
    healed: false,
    screenshotSignedUrl: 'https://s3-presigned.example.com/snap/03.png?X-Amz-fixture',
    htmlSignedUrl: 'https://s3-presigned.example.com/snap/03.html?X-Amz-fixture',
  },
];

/** The fields a detail shares with its line, plus the ones every fixture result has in common. */
function resultDetailBase(resultId: string) {
  const line = resultLineFixtures.find(r => r.resultId === resultId)!;
  return {
    resultId: line.resultId,
    runId: line.runId,
    caseKey: line.caseKey,
    caseHash: `case_${line.resultId}`,
    title: line.title,
    type: 'frontend',
    testStatus: line.testStatus,
    processStatus: line.processStatus,
    processErrorMessage: null,
    error: line.error,
    cause: null,
    fix: null,
    blockedReason: line.blockedReason,
    videoUrl: null,
    envId: line.environmentName === 'production' ? 'env_production_02' : 'env_staging_01',
    created: line.created,
    modified: line.created,
    failedStep: null,
    steps: [],
    signIn: null,
  } satisfies ResultDetail;
}

/** `GET /results/:resultId`, by result id. */
export const resultDetailFixtures: Record<string, ResultDetail> = {
  [FIXTURE_RESULT_ID_PASSED]: {
    ...resultDetailBase(FIXTURE_RESULT_ID_PASSED),
    videoUrl: 'https://s3-presigned.example.com/video/result_passed_01.mp4?X-Amz-fixture',
    modified: '2026-05-05T12:34:40.000Z',
    steps: resultStepFixtures.slice(0, 2),
  },
  [FIXTURE_RESULT_ID_FAILED]: {
    ...resultDetailBase(FIXTURE_RESULT_ID_FAILED),
    cause: 'The submit button stays disabled because the card field is empty.',
    fix: 'Fill the card field before submitting the form.',
    videoUrl: 'https://s3-presigned.example.com/video/result_failed_02.mp4?X-Amz-fixture',
    modified: '2026-05-05T12:34:58.000Z',
    failedStep: resultStepFixtures[2]!,
    steps: resultStepFixtures,
  },
  [FIXTURE_RESULT_ID_BLOCKED]: {
    ...resultDetailBase(FIXTURE_RESULT_ID_BLOCKED),
    modified: '2026-05-05T12:34:20.000Z',
    signIn: {
      id: 'auth_5e1c77a0',
      status: 'failed',
      videoUrl: 'https://s3-presigned.example.com/video/auth_5e1c77a0.mp4?X-Amz-fixture',
      finalUrl: 'https://staging.example.com/login',
      stepCount: 2,
      error: 'The sign-in page rejected the password.',
      steps: [
        {
          stepIndex: '1',
          type: 'action',
          action: 'fill',
          description: "Fill '***' into the password field",
          status: 'passed',
          selector: '#password',
          url: 'https://staging.example.com/login',
          healed: false,
          screenshotSignedUrl: null,
          htmlSignedUrl: 'https://s3-presigned.example.com/auth/01.html?X-Amz-fixture',
        },
        {
          stepIndex: '2',
          type: 'action',
          action: 'click',
          description: 'Click the sign-in button',
          status: 'failed',
          selector: 'button[type="submit"]',
          url: 'https://staging.example.com/login',
          healed: false,
          screenshotSignedUrl: null,
          htmlSignedUrl: 'https://s3-presigned.example.com/auth/02.html?X-Amz-fixture',
        },
      ],
    },
  },
  [FIXTURE_RESULT_ID_CANCELLED]: resultDetailBase(FIXTURE_RESULT_ID_CANCELLED),
  [FIXTURE_RESULT_ID_EARLIER]: {
    ...resultDetailBase(FIXTURE_RESULT_ID_EARLIER),
    modified: '2026-05-04T09:00:45.000Z',
    steps: resultStepFixtures.map(step => ({ ...step, status: 'passed' as const })),
  },
};
