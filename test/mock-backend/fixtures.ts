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

export const FIXTURE_DEV_USER_ID = '11111111-1111-4111-8111-111111111111';
export const FIXTURE_KEY_ID = 'key_2026_05_05_abc';

export const FIXTURE_PROJECT_ID = 'project_b3c91efa';
export const FIXTURE_PROJECT_ID_BACKEND = 'project_a47b2c11';
export const FIXTURE_TEST_ID_FAILED = 'test_8f2a4d10';
export const FIXTURE_TEST_ID_PASSED = 'test_3a91bb02';
export const FIXTURE_TEST_ID_NO_FAILURE = 'test_3a91bb02';
export const FIXTURE_TEST_ID_NO_ANALYSIS = 'test_5d92e007';
export const FIXTURE_TEST_ID_RUNNING = 'test_running_77c2';
export const FIXTURE_TEST_ID_BLOCKED = 'test_blocked_4f7a';
export const FIXTURE_TEST_ID_LARGE_CODE = 'test_large_code_42b9';
export const FIXTURE_TEST_ID_NOT_FOUND = 'test_does_not_exist';
export const FIXTURE_RUN_ID = 'run_abc';
export const FIXTURE_SNAPSHOT_ID = 'snap_2026_05_05_b2f9a1c8';
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
    name: 'Checkout happy path',
    type: 'frontend' as const,
    createdFrom: 'portal' as const,
    status: 'failed' as const,
    createdAt: '2026-04-20T11:00:00.000Z',
    updatedAt: '2026-05-05T12:34:56.000Z',
    details: {
      processingStatus: 'Idle',
      testStatus: 'Failed',
      rawStatus: 'ps=Idle; ts=Failed',
    },
  },
  {
    id: FIXTURE_TEST_ID_PASSED,
    projectId: FIXTURE_PROJECT_ID,
    name: 'Checkout — declined card',
    type: 'frontend' as const,
    createdFrom: 'portal' as const,
    status: 'passed' as const,
    createdAt: '2026-04-20T11:00:00.000Z',
    updatedAt: '2026-05-05T08:00:00.000Z',
    details: {
      processingStatus: 'Idle',
      testStatus: 'Passed',
      rawStatus: 'ps=Idle; ts=Passed',
    },
  },
  {
    id: FIXTURE_TEST_ID_NO_ANALYSIS,
    projectId: FIXTURE_PROJECT_ID,
    name: 'Smoke — health check',
    type: 'backend' as const,
    createdFrom: 'mcp' as const,
    status: 'failed' as const,
    createdAt: '2026-04-22T09:00:00.000Z',
    updatedAt: '2026-05-05T11:00:30.000Z',
    details: {
      processingStatus: null,
      testStatus: 'FAILED',
      rawStatus: 'ts=FAILED',
    },
  },
  {
    id: FIXTURE_TEST_ID_RUNNING,
    projectId: FIXTURE_PROJECT_ID,
    name: 'Checkout — concurrent users',
    type: 'frontend' as const,
    createdFrom: 'portal' as const,
    status: 'running' as const,
    createdAt: '2026-04-25T15:00:00.000Z',
    updatedAt: '2026-05-05T12:34:00.000Z',
    details: {
      processingStatus: 'Executing',
      testStatus: null,
      rawStatus: 'ps=Executing; ts=null',
    },
  },
  {
    // M2.1 piece 1: distinct `blocked` row. Pre-M2.1 this fixture
    // would have collapsed to `failed`; the dedicated row keeps the
    // mock-backend handler tests honest about the new public value.
    id: FIXTURE_TEST_ID_BLOCKED,
    projectId: FIXTURE_PROJECT_ID,
    name: 'Checkout — coupon redemption',
    type: 'frontend' as const,
    createdFrom: 'portal' as const,
    status: 'blocked' as const,
    createdAt: '2026-04-21T09:00:00.000Z',
    updatedAt: '2026-05-05T13:01:12.000Z',
    details: {
      processingStatus: 'Idle',
      testStatus: 'Blocked',
      rawStatus: 'ps=Idle; ts=Blocked',
    },
  },
  {
    id: FIXTURE_TEST_ID_LARGE_CODE,
    projectId: FIXTURE_PROJECT_ID,
    name: 'End-to-end suite — full',
    type: 'frontend' as const,
    createdFrom: 'portal' as const,
    status: 'ready' as const,
    createdAt: '2026-04-28T09:00:00.000Z',
    updatedAt: '2026-05-04T18:00:00.000Z',
    details: {
      processingStatus: 'Idle',
      testStatus: null,
      rawStatus: 'ps=Idle; ts=null',
    },
  },
];

export const testCodeFixture = {
  testId: FIXTURE_TEST_ID_FAILED,
  language: 'typescript' as const,
  framework: 'playwright' as const,
  code: [
    "import { test, expect } from '@playwright/test';",
    "test('checkout happy path', async ({ page }) => {",
    '  await page.goto(process.env.TARGET_URL!);',
    '  await page.click(\'[data-testid="cart"]\');',
    '  await page.click(\'[data-testid="submit"]\');',
    "  await expect(page.getByRole('heading', { name: 'Order placed' })).toBeVisible();",
    '});',
    '',
  ].join('\n'),
  codeVersion: 'v3',
  etag: 'sha256:c7c4a4f6c1b8c2e5',
};

/**
 * Presigned-URL variant of the code endpoint, returned by the facade
 * when the source is >= 100 KB. The `code` field carries an `https://`
 * URL instead of the source body.
 */
export const testCodeLargeFixture = {
  testId: FIXTURE_TEST_ID_LARGE_CODE,
  language: 'typescript' as const,
  framework: 'playwright' as const,
  code: 'https://s3-presigned.example.com/codes/test_large_code_42b9?X-Amz-fixture',
  codeVersion: 'v1',
  etag: 'sha256:9182a0bd71f4c85c',
};

export const testStepsFixture = [
  {
    testId: FIXTURE_TEST_ID_FAILED,
    stepIndex: 4,
    action: 'click',
    description: 'Click the cart icon',
    status: 'passed' as const,
    screenshotUrl: 'https://s3-presigned.example.com/snap/04.png?X-Amz-fixture',
    htmlSnapshotUrl: 'https://s3-presigned.example.com/snap/04.html?X-Amz-fixture',
    runIdIfAvailable: FIXTURE_RUN_ID,
    codeVersion: 'v3',
    capturedAt: '2026-05-05T12:34:55.000Z',
    updatedAt: '2026-05-05T12:34:56.000Z',
  },
  {
    testId: FIXTURE_TEST_ID_FAILED,
    stepIndex: 5,
    action: 'click',
    description: 'Click the submit button',
    status: 'failed' as const,
    screenshotUrl: 'https://s3-presigned.example.com/snap/05.png?X-Amz-fixture',
    htmlSnapshotUrl: 'https://s3-presigned.example.com/snap/05.html?X-Amz-fixture',
    runIdIfAvailable: FIXTURE_RUN_ID,
    codeVersion: 'v3',
    capturedAt: '2026-05-05T12:34:56.000Z',
    updatedAt: '2026-05-05T12:34:56.000Z',
  },
  {
    testId: FIXTURE_TEST_ID_FAILED,
    stepIndex: 6,
    action: 'expect',
    description: 'Expect order confirmation heading',
    status: null,
    screenshotUrl: null,
    htmlSnapshotUrl: null,
    runIdIfAvailable: FIXTURE_RUN_ID,
    codeVersion: 'v3',
    capturedAt: null,
    updatedAt: '2026-05-05T12:34:58.000Z',
  },
];

/**
 * In-flight result. Returned by `/tests/{id}/result` when a run is
 * mid-flight. `finishedAt`, `videoUrl`, and `failureAnalysisUrl` are
 * `null` (not omitted) so clients can distinguish "no data yet" from
 * "did not ask".
 */
export const latestResultRunningFixture = {
  testId: FIXTURE_TEST_ID_RUNNING,
  status: 'running' as const,
  startedAt: '2026-05-05T12:34:00.000Z',
  finishedAt: null,
  videoUrl: null,
  failureAnalysisUrl: null,
  snapshotId: 'snap_2026_05_05_runn1ng9',
  runIdIfAvailable: 'run_running',
  codeVersion: 'v1',
  targetUrl: FIXTURE_TARGET_URL,
  failedStepIndex: null,
  failureKind: null,
  verdict: null,
  executionStatus: 'running' as const,
  summary: 'Run is still in progress.',
};

export const latestResultPassedFixture = {
  testId: FIXTURE_TEST_ID_PASSED,
  status: 'passed' as const,
  startedAt: '2026-05-05T07:59:30.000Z',
  finishedAt: '2026-05-05T08:00:12.000Z',
  videoUrl: 'https://s3-presigned.example.com/video/run_xyz.mp4?X-Amz-fixture',
  failureAnalysisUrl: null,
  snapshotId: 'snap_2026_05_05_e1b9c2a4',
  runIdIfAvailable: 'run_xyz',
  codeVersion: 'v2',
  targetUrl: FIXTURE_TARGET_URL,
  targetUrlSource: 'run' as const,
  failedStepIndex: null,
  failureKind: null,
  verdict: 'passed' as const,
  executionStatus: 'completed' as const,
  summary: 'Passed all 8 steps.',
};

export const latestResultFailedFixture = {
  testId: FIXTURE_TEST_ID_FAILED,
  status: 'failed' as const,
  startedAt: '2026-05-05T12:34:00.000Z',
  finishedAt: '2026-05-05T12:34:58.000Z',
  videoUrl: 'https://s3-presigned.example.com/video/run_abc.mp4?X-Amz-fixture',
  failureAnalysisUrl: 'https://s3-presigned.example.com/analysis/run_abc.json?X-Amz-fixture',
  snapshotId: FIXTURE_SNAPSHOT_ID,
  runIdIfAvailable: FIXTURE_RUN_ID,
  codeVersion: 'v3',
  targetUrl: FIXTURE_TARGET_URL,
  targetUrlSource: 'run' as const,
  failedStepIndex: 5,
  failureKind: 'assertion' as const,
  verdict: 'failed' as const,
  executionStatus: 'completed' as const,
  summary: 'Failed (assertion) on step 5: expected cart badge to show 1 item, but it was empty.',
};

export const failureContextFixture = {
  snapshotId: FIXTURE_SNAPSHOT_ID,
  testId: FIXTURE_TEST_ID_FAILED,
  projectId: FIXTURE_PROJECT_ID,
  result: latestResultFailedFixture,
  steps: testStepsFixture,
  code: testCodeFixture,
  failure: {
    rootCauseHypothesis:
      'Submit button has `opacity: 0.4` and is rendered as disabled. The checkout ' +
      "form's `isFormValid` predicate evaluates to false because the credit-card " +
      'field is empty. Selector `[data-testid="submit"]` matches the element but ' +
      'the click does not fire the navigation because the button has ' +
      '`pointer-events: none`.',
    recommendedFixTarget: {
      kind: 'code' as const,
      reference: 'src/components/CheckoutForm.tsx:412',
      rationale:
        'The disabled state originates from `isFormValid()` in CheckoutForm.tsx; ' +
        'the submit button only enables when `card.number.length === 16`. The ' +
        'test fixture leaves the card field empty.',
    },
    evidence: [
      {
        kind: 'screenshot' as const,
        stepIndex: 5,
        url: 'https://s3-presigned.example.com/evidence/run_abc/05.png?X-Amz-fixture',
        summary:
          'Submit button has `opacity: 0.4` and is rendered as disabled. ' +
          'Credit-card field is empty. No visible error message. Cart icon ' +
          'shows `1 item` in the top-right.',
      },
      {
        kind: 'snapshot' as const,
        stepIndex: 5,
        url: 'https://s3-presigned.example.com/evidence/run_abc/05.html?X-Amz-fixture',
        summary:
          '`<button data-testid="submit" disabled aria-disabled="true" ' +
          'style="pointer-events:none;opacity:0.4">`. The DOM diff vs. step 4 ' +
          "shows the `disabled` attribute being added by the form's onChange " +
          'handler.',
      },
      {
        kind: 'console' as const,
        stepIndex: 5,
        url: 'https://s3-presigned.example.com/evidence/run_abc/05-console.json?X-Amz-fixture',
        summary:
          'No errors logged at the time of click. One earlier warning: ' +
          '`[warn] CheckoutForm: card.number is empty; submit disabled`.',
      },
    ],
  },
};

export const failureContextNoAnalysisFixture = {
  snapshotId: 'snap_2026_05_05_44ab12cd',
  testId: FIXTURE_TEST_ID_NO_ANALYSIS,
  projectId: FIXTURE_PROJECT_ID,
  result: {
    testId: FIXTURE_TEST_ID_NO_ANALYSIS,
    status: 'failed' as const,
    startedAt: '2026-05-05T11:00:00.000Z',
    finishedAt: '2026-05-05T11:00:30.000Z',
    videoUrl: null,
    failureAnalysisUrl: null,
    snapshotId: 'snap_2026_05_05_44ab12cd',
    runIdIfAvailable: null,
    codeVersion: null,
    targetUrl: 'https://staging.example.com/',
    failedStepIndex: 2,
    failureKind: 'unknown' as const,
    verdict: 'failed' as const,
    executionStatus: 'completed' as const,
    summary: 'Failed with no detailed analysis available.',
  },
  steps: [],
  code: {
    testId: FIXTURE_TEST_ID_NO_ANALYSIS,
    language: 'python' as const,
    framework: 'pytest' as const,
    code: [
      'def test_smoke(client):',
      "    response = client.get('/health')",
      '    assert response.status_code == 200',
      '',
    ].join('\n'),
    codeVersion: null,
    etag: null,
  },
  failure: {
    rootCauseHypothesis: null,
    recommendedFixTarget: { kind: 'unknown' as const, reference: null, rationale: null },
    evidence: [],
  },
};
