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
import type {
  CliProject,
  CliCreateProjectResponse,
  CliUpdateProjectResponse,
  CliDeleteProjectResponse,
} from '../../commands/project.js';
import type { CliTest } from '../../commands/test.js';
import type { MeResponse } from '../../commands/auth.js';
import type { CliSchedule } from '../../commands/schedule.js';
import { buildJUnitReport } from '../junit-report.js';
import type { Page } from '../pagination.js';
import type {
  TriggerRunResponse,
  RunResponse,
  BatchRunFreshResponse,
  CancelRunResponse,
  ExecutionReportResponse,
} from '../runs.types.js';
import type { TunnelListResponse, TunnelStatusResponse } from '../tunnel.types.js';
import type { ResultDetail, ResultList, ResultStep } from '../result/types.js';

const SAMPLE_USER_ID = '11111111-1111-4111-8111-111111111111';
const SAMPLE_KEY_ID = 'key_dryrun_2026';

const SAMPLE_PROJECT_ID = 'project_b3c91efa';
const SAMPLE_CONVERSATION_ID = 'conv_dryrun_2026';
const SAMPLE_CONVERSATION_URL = `https://portal.dry-run.invalid/dashboard-v3/projects/${SAMPLE_PROJECT_ID}/agent/${SAMPLE_CONVERSATION_ID}`;
const SAMPLE_PROJECT_ID_BACKEND = 'project_a47b2c11';
const SAMPLE_TEST_ID_FAILED = 'test_8f2a4d10';
const SAMPLE_TEST_ID_PASSED = 'test_3a91bb02';
const SAMPLE_TEST_ID_BLOCKED = 'test_blocked_4f7a';
const SAMPLE_TEST_ID_RUNNING = 'test_running_6c1e';
/**
 * The sample run (one launch) and its results, one per test. Result ids start
 * `res_` and run ids `run_`, so a dry run never shows one under the other's
 * name.
 */
const SAMPLE_RUN_ID = 'run_dryrun0001';
const SAMPLE_RESULT_ID = 'res_dryrun0001';
const SAMPLE_RESULT_ID_PASSED = 'res_dryrun0002';
const SAMPLE_RESULT_ID_BLOCKED = 'res_dryrun0003';
const SAMPLE_RESULT_ID_RUNNING = 'res_dryrun0004';
const SAMPLE_SCHEDULE_ID = 'sch_7d21ac48';
const SAMPLE_SCHEDULE_RUN_ID = 'run_dryrun0002';
const SAMPLE_TUNNEL_ID_1 = '00000000-0000-4000-8000-000000000001';
const SAMPLE_TUNNEL_ID_2 = '00000000-0000-4000-8000-000000000002';
// A result id `GET /runs/{id}` answers with the failed sample: keeps wait
// flows on the default passed sample while still demonstrating a failed
// result offline.
const SAMPLE_FAILED_RESULT_ID = 'res_failed_sample';
// The results a fresh batch run starts, in the sample run.
const SAMPLE_BATCH_FRESH_RESULT_ID_1 = 'res_dryrun0005';
const SAMPLE_BATCH_FRESH_RESULT_ID_2 = 'res_dryrun0006';
const SAMPLE_TEST_ID_FRESH_1 = 'test_fresh_wave_01';
const SAMPLE_TEST_ID_FRESH_2 = 'test_fresh_wave_02';
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
        resultId: SAMPLE_BATCH_FRESH_RESULT_ID_1,
        runId: SAMPLE_RUN_ID,
        status: 'passed',
      },
      {
        testId: SAMPLE_TEST_ID_FRESH_2,
        resultId: SAMPLE_BATCH_FRESH_RESULT_ID_2,
        runId: SAMPLE_RUN_ID,
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
  activeOrg: {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Dry Run Workspace',
    plan: 'Standard',
    role: 'owner',
    remaining: 1650,
    includedCredits: 1600,
    seats: 1,
  },
};

const checkoutProject: CliProject = {
  id: SAMPLE_PROJECT_ID,
  name: 'Checkout',
  type: 'frontend',
  createdFrom: 'portal',
  createdAt: '2026-04-15T10:23:00.000Z',
  updatedAt: '2026-05-05T08:12:00.000Z',
};

const projects: CliProject[] = [
  checkoutProject,
  {
    id: SAMPLE_PROJECT_ID_BACKEND,
    name: 'Internal API',
    type: 'backend',
    createdFrom: 'mcp',
    createdAt: '2026-03-01T14:00:00.000Z',
    updatedAt: '2026-05-04T19:30:00.000Z',
  },
];

const schedule: CliSchedule = {
  scheduleId: SAMPLE_SCHEDULE_ID,
  name: 'Nightly checkout',
  enabled: true,
  targetType: 'project',
  targetId: SAMPLE_PROJECT_ID,
  environment: null,
  environmentMode: 'inherit',
  cron: '0 3 * * *',
  timezone: 'UTC',
  startAt: '2026-05-01T00:00:00.000Z',
  endAt: null,
  sendTo: null,
  autoPausedAt: null,
  lastRunId: SAMPLE_SCHEDULE_RUN_ID,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-02T00:00:00.000Z',
};

const tests: CliTest[] = [
  {
    id: SAMPLE_TEST_ID_FAILED,
    projectId: SAMPLE_PROJECT_ID,
    projectName: 'Checkout',
    slug: 'CHECKOUT-001',
    title: 'Checkout happy path',
    description: 'Pays for a cart with a saved card and lands on the confirmation page.',
    type: 'frontend',
    isIntegration: false,
    category: 'Checkout',
    priority: 'Medium',
    version: { hash: 'a3f9c2e1d4b7', label: 'v1.2' },
    stepCount: 8,
    createdAt: '2026-04-20T11:00:00.000Z',
    updatedAt: '2026-05-05T12:34:56.000Z',
  },
  {
    id: SAMPLE_TEST_ID_PASSED,
    projectId: SAMPLE_PROJECT_ID,
    projectName: 'Checkout',
    slug: 'CHECKOUT-002',
    title: 'Checkout — declined card',
    description: null,
    type: 'frontend',
    isIntegration: false,
    category: 'Checkout',
    priority: null,
    version: { hash: '7c1e0b9a5d22', label: 'v1.0' },
    stepCount: 5,
    createdAt: '2026-04-20T11:00:00.000Z',
    updatedAt: '2026-05-05T08:00:00.000Z',
  },
  {
    id: SAMPLE_TEST_ID_BLOCKED,
    projectId: SAMPLE_PROJECT_ID,
    projectName: 'Checkout',
    slug: 'CHECKOUT-003',
    title: 'Checkout — coupon redemption',
    description: null,
    type: 'frontend',
    isIntegration: false,
    category: 'Checkout',
    priority: null,
    version: { hash: 'e5d4c3b2a101', label: 'v1.0' },
    stepCount: 6,
    createdAt: '2026-04-21T09:00:00.000Z',
    updatedAt: '2026-05-05T13:01:12.000Z',
  },
  {
    // Still running in the sample run, so a dry run of `run wait` / `test
    // cancel` on that run shows the poll and the cancel request it would send.
    id: SAMPLE_TEST_ID_RUNNING,
    projectId: SAMPLE_PROJECT_ID,
    projectName: 'Checkout',
    slug: 'CHECKOUT-004',
    title: 'Checkout — saved address',
    description: null,
    type: 'frontend',
    isIntegration: false,
    category: 'Checkout',
    priority: null,
    version: { hash: '9b8a7f6e5d4c', label: 'v1.0' },
    stepCount: 4,
    createdAt: '2026-04-22T10:00:00.000Z',
    updatedAt: '2026-05-05T12:34:03.000Z',
  },
];

// The failed result of the sample run: the checkout happy path, failing
// because the card field is empty.
const SAMPLE_RESULT_ERROR = 'AssertionError: expected the order confirmation heading to be visible';
const SAMPLE_RESULT_CAUSE =
  "The submit button stays disabled: the checkout form's `isFormValid` is false because the card field is empty.";
const SAMPLE_RESULT_FIX = 'Fill the card number before submitting the checkout form.';

/**
 * The results of the sample run, newest first: one still running, the failed
 * and the passed test of the report below, and the blocked test, which never
 * got past sign-in.
 * Each line names its test by the id and title `test list` prints for it, as
 * a line from the backend does. The two history-window fields are sent for a
 * test's history only, so a run's listing leaves them out.
 */
const resultListSample: ResultList = {
  results: [
    {
      resultId: SAMPLE_RESULT_ID_RUNNING,
      runId: SAMPLE_RUN_ID,
      caseKey: SAMPLE_TEST_ID_RUNNING,
      title: 'Checkout — saved address',
      testStatus: 'RUNNING',
      processStatus: 'Executing',
      error: null,
      blockedReason: null,
      environmentName: 'staging',
      created: '2026-05-05T12:34:03.000Z',
    },
    {
      resultId: SAMPLE_RESULT_ID_BLOCKED,
      runId: SAMPLE_RUN_ID,
      caseKey: SAMPLE_TEST_ID_BLOCKED,
      title: 'Checkout — coupon redemption',
      testStatus: 'BLOCKED',
      processStatus: 'Idle',
      error: null,
      blockedReason: 'Sign-in failed, so the test never started.',
      environmentName: 'staging',
      created: '2026-05-05T12:34:02.000Z',
    },
    {
      resultId: SAMPLE_RESULT_ID_PASSED,
      runId: SAMPLE_RUN_ID,
      caseKey: SAMPLE_TEST_ID_PASSED,
      title: 'Checkout — declined card',
      testStatus: 'PASSED',
      processStatus: 'Idle',
      error: null,
      blockedReason: null,
      environmentName: 'staging',
      created: '2026-05-05T12:34:01.000Z',
    },
    {
      resultId: SAMPLE_RESULT_ID,
      runId: SAMPLE_RUN_ID,
      caseKey: SAMPLE_TEST_ID_FAILED,
      title: 'Checkout happy path',
      testStatus: 'FAILED',
      processStatus: 'Idle',
      error: SAMPLE_RESULT_ERROR,
      blockedReason: null,
      environmentName: 'staging',
      created: '2026-05-05T12:34:00.000Z',
    },
  ],
  hiddenRunCount: 4,
  retentionDays: 30,
};

const resultFailedStepSample: ResultStep = {
  stepIndex: '3',
  type: 'assertion',
  action: 'visible',
  description: 'Expect the order confirmation heading',
  status: 'failed',
  selector: '[data-testid="order-confirmation"]',
  url: SAMPLE_TARGET_URL,
  healed: false,
  screenshotSignedUrl: 'https://s3-presigned.example.com/snap/03.png?X-Amz-dryrun',
  htmlSignedUrl: 'https://s3-presigned.example.com/snap/03.html?X-Amz-dryrun',
};

/** The failed result of the sample run, with its steps. */
const resultDetailSample: ResultDetail = {
  resultId: SAMPLE_RESULT_ID,
  runId: SAMPLE_RUN_ID,
  caseKey: SAMPLE_TEST_ID_FAILED,
  caseHash: 'case_dryrun0001',
  title: 'Checkout happy path',
  type: 'FRONTEND',
  testStatus: 'FAILED',
  processStatus: 'Idle',
  processErrorMessage: null,
  error: SAMPLE_RESULT_ERROR,
  cause: SAMPLE_RESULT_CAUSE,
  fix: SAMPLE_RESULT_FIX,
  blockedReason: null,
  // A frontend test has no traceback or captured output.
  trace: null,
  apiOutput: null,
  videoUrl: 'https://s3-presigned.example.com/video/res_dryrun0001.mp4?X-Amz-dryrun',
  envId: 'env_dryrun0001',
  created: '2026-05-05T12:34:00.000Z',
  modified: '2026-05-05T12:34:58.000Z',
  failedStep: resultFailedStepSample,
  steps: [
    {
      stepIndex: '1',
      type: 'action',
      action: 'click',
      description: 'Click the cart icon',
      status: 'passed',
      selector: '[data-testid="cart"]',
      url: SAMPLE_TARGET_URL,
      healed: false,
      screenshotSignedUrl: 'https://s3-presigned.example.com/snap/01.png?X-Amz-dryrun',
      htmlSignedUrl: 'https://s3-presigned.example.com/snap/01.html?X-Amz-dryrun',
    },
    {
      stepIndex: '2',
      type: 'action',
      action: 'fill',
      description: 'Fill the shipping address',
      status: 'passed',
      selector: '#address',
      url: SAMPLE_TARGET_URL,
      healed: true,
      screenshotSignedUrl: 'https://s3-presigned.example.com/snap/02.png?X-Amz-dryrun',
      htmlSignedUrl: 'https://s3-presigned.example.com/snap/02.html?X-Amz-dryrun',
    },
    resultFailedStepSample,
  ],
  signIn: null,
};

/** A ready execution report: one failed and one passed row, the App's Markdown shape in miniature. */
const executionReportSample: ExecutionReportResponse = {
  ready: true,
  report: {
    projectId: SAMPLE_PROJECT_ID,
    runId: SAMPLE_RUN_ID,
    projectName: 'Sample project',
    orgId: null,
    stats: { passed: 1, failed: 1, blocked: 0, total: 2 },
    allPassed: false,
    narrative: 'Dry-run sample: the checkout happy path regressed; the declined-card test passed.',
    whatCouldBeBetter: 'Add coverage for password reset.',
    recommendedNextStep: 'Fill the card number in the checkout test and rerun.',
    tests: [
      {
        id: SAMPLE_RESULT_ID,
        title: 'Checkout happy path',
        slug: 'CHK-001',
        status: 'FAILED',
        screenshotUrl: null,
        error: SAMPLE_RESULT_ERROR,
        fix: SAMPLE_RESULT_FIX,
      },
      {
        id: SAMPLE_RESULT_ID_PASSED,
        title: 'Checkout — declined card',
        slug: 'CHK-002',
        status: 'PASSED',
        screenshotUrl: null,
        error: null,
        fix: null,
      },
    ],
    resultUrl: `https://www.testsprite.com/dashboard-v3/projects/${SAMPLE_PROJECT_ID}/execution/${SAMPLE_RUN_ID}`,
  },
  markdown:
    '> [!WARNING]\n> ### Ran into trouble — 1 failed\n>\n> Dry-run sample: the checkout happy path regressed; the declined-card test passed.\n',
};

// Modern wire samples use native runId (execution) and resultId (result).
const passedRunSample: RunResponse = {
  resultId: SAMPLE_RESULT_ID,
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
    total: 2,
    completed: 2,
    passedCount: 2,
    failedCount: 0,
  },
};

const failedRunSample: RunResponse = {
  resultId: SAMPLE_FAILED_RESULT_ID,
  runId: SAMPLE_RUN_ID,
  testId: SAMPLE_TEST_ID_FAILED,
  projectId: SAMPLE_PROJECT_ID,
  userId: SAMPLE_USER_ID,
  status: 'failed',
  source: 'cli',
  createdAt: '2026-05-15T19:32:00.000Z',
  startedAt: '2026-05-15T19:32:05.000Z',
  finishedAt: '2026-05-15T19:34:00.000Z',
  codeVersion: 'v1',
  targetUrl: SAMPLE_TARGET_URL,
  createdFrom: null,
  failedStepIndex: 3,
  failureKind: 'assertion',
  error: 'Expected billing status badge to be visible, but it was not found.',
  videoUrl: null,
  stepSummary: {
    total: 3,
    completed: 3,
    passedCount: 2,
    failedCount: 1,
  },
};

/**
 * Dry-run sample lookup keyed by OpenAPI operationId. Order matters in
 * {@link findSample}: more specific patterns must precede their generic
 * siblings (e.g. `/projects/{id}/env` before `/projects/{id}`).
 */
/**
 * HTTP methods accepted by the dry-run registry.
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
   * argument. A read whose answer depends on its query (`GET /results`)
   * receives the query too; the query never takes part in matching.
   */
  body: (requestBody?: unknown, query?: URLSearchParams) => unknown;
}

const PATH_PREFIX = '/api/cli/v1';

// Regex metacharacters that must be escaped when a literal string is spliced
// into a `new RegExp(...)` source string, so the literal matches only itself.
const REGEXP_METACHAR = /[.*+?^${}()|[\]\\]/g;

function escapeRegExpLiteral(literal: string): string {
  return literal.replace(REGEXP_METACHAR, '\\$&');
}

/**
 * Build the matcher RegExp for a route template, e.g.
 * `/results/{resultId}` → /^\/results\/[^/]+$/. Splits on the
 * `{param}` placeholders first, then regex-escapes every literal segment in
 * between (including any literal backslash) so a route literal containing a
 * regex metacharacter is matched literally instead of being reinterpreted as
 * part of the pattern.
 */
function buildPathPattern(pathTemplate: string): RegExp {
  const regexSrc = pathTemplate
    .split(/(\{[^}]+\})/g)
    .map(part => (/^\{[^}]+\}$/.test(part) ? '[^/]+' : escapeRegExpLiteral(part)))
    .join('');
  return new RegExp(`^${regexSrc}$`);
}

const ENTRIES: DryRunSampleEntry[] = [
  entry('whoami', 'GET', '/me', me),
  entry('listProjects', 'GET', '/projects', pageOf(projects)),
  entry('startConversation', 'POST', '/projects/{projectId}/conversations', {
    id: SAMPLE_CONVERSATION_ID,
    url: SAMPLE_CONVERSATION_URL,
    model: 'claude-opus-5-5',
  }),
  entry('listConversations', 'GET', '/projects/{projectId}/conversations', {
    conversations: [
      {
        id: SAMPLE_CONVERSATION_ID,
        title: 'Cover the new coupon rules',
        state: 'proposed',
        lastMessageAt: '2026-01-01T00:12:00.000Z',
        url: SAMPLE_CONVERSATION_URL,
      },
    ],
  }),
  entry('getConversation', 'GET', '/projects/{projectId}/conversations/{conversationId}', {
    id: SAMPLE_CONVERSATION_ID,
    projectId: SAMPLE_PROJECT_ID,
    title: 'Cover the new coupon rules',
    url: SAMPLE_CONVERSATION_URL,
    state: 'proposed',
    model: 'claude-opus-5-5',
    lastSeq: 42,
    events: [
      {
        seq: 40,
        at: '2026-01-01T00:11:00.000Z',
        kind: 'activity',
        text: 'Opening staging.example.com/cart',
      },
      {
        seq: 41,
        at: '2026-01-01T00:11:30.000Z',
        kind: 'activity',
        text: 'Saving test cases to TestSprite',
      },
      {
        seq: 42,
        at: '2026-01-01T00:12:00.000Z',
        kind: 'message',
        from: 'agent',
        text: 'Two new tests for the coupon rules and one fix. The second-coupon limit comes from the PRD; whether coupons apply to sale items is only what the app does today.',
      },
    ],
    proposal: {
      id: '00000000-0000-4000-8000-0000000000c1',
      kind: 'plan',
      summary: '2 new tests, 1 changed',
      plan: {
        added: [
          {
            ref: '1',
            useCase: 'Checkout',
            title: 'A second percent-off coupon replaces the first',
            priority: 'High',
            description:
              'Expected from the PRD (docs/coupons-prd.md): one percent-off coupon per order.',
            steps: [
              { type: 'action', description: 'Add the Desk Lamp to the cart and open the cart' },
              { type: 'action', description: 'Apply SAVE10, then WELCOME15' },
              {
                type: 'assertion',
                description: 'Only WELCOME15 is listed and the total is $35.70',
              },
            ],
          },
          {
            ref: '2',
            useCase: 'Checkout',
            title: 'An expired coupon is refused',
            priority: 'Medium',
            description: 'Expected from what the app does today; not confirmed.',
            steps: [
              { type: 'action', description: 'Apply OLD20 in the cart' },
              {
                type: 'assertion',
                description: 'The message "This code has expired" shows and the total is unchanged',
              },
            ],
          },
        ],
        changed: [{ ref: 'CHK-002', title: 'Pay by card', priority: 'High' }],
        removed: [],
      },
    },
    reply:
      'Two new tests for the coupon rules and one fix. The second-coupon limit comes from the PRD; whether coupons apply to sale items is only what the app does today.',
  }),
  entry(
    'conversationFileUrl',
    'POST',
    '/projects/{projectId}/conversations/{conversationId}/files',
    {
      uploadUrl:
        'https://s3.dry-run.invalid/testsprite-usercontent/u_dryrun/chat/change.patch?X-Amz-Signature=dryrun',
      name: 'change.patch',
    },
  ),
  entry(
    'sendConversationMessage',
    'POST',
    '/projects/{projectId}/conversations/{conversationId}/messages',
    {
      seq: 1,
    },
  ),
  entry(
    'applyConversationProposal',
    'POST',
    '/projects/{projectId}/conversations/{conversationId}/apply',
    {
      applied: '2 new tests, 1 changed',
      ok: true,
      saved: [
        { path: '/test-cases/coupon-replace.md', detail: 'created CHK-011' },
        { path: '/test-cases/coupon-expired.md', detail: 'created CHK-012' },
        { path: '/test-cases/CHK-002.md', detail: 'updated CHK-002' },
      ],
      failed: [],
      tests: ['tc_dryrun_011', 'tc_dryrun_012', 'tc_dryrun_002'],
    },
  ),
  entry(
    'rejectConversationProposal',
    'POST',
    '/projects/{projectId}/conversations/{conversationId}/reject',
    {
      rejected: '2 new tests, 1 changed',
    },
  ),
  entry('stopConversation', 'POST', '/projects/{projectId}/conversations/{conversationId}/stop', {
    ok: true,
  }),
  entry(
    'discardConversation',
    'POST',
    '/projects/{projectId}/conversations/{conversationId}/discard',
    {
      discarded: '00000000-0000-4000-8000-0000000000a1',
      released: ['/test-cases/CHK-002.md'],
    },
  ),
  // The single-project read carries the project-level test-id attribute list
  // (present-and-null contract, see `CliProject.testIdAttributes`); the list
  // row above deliberately omits it.
  entry('getProject', 'GET', '/projects/{projectId}', {
    ...checkoutProject,
    instruction: 'Use the staging account for checkout tests.',
    testIdAttributes: ['data-element', 'data-testid'],
  } satisfies CliProject),
  // P6 — POST /projects (create project). The id uses a stable dry-run
  // sentinel so agents can see a coherent field shape without a real key.
  // Both `projectId` (the live field) and `id` (legacy/
  // fallback) are shown — see `CliCreateProjectResponse`.
  entry('createProject', 'POST', '/projects', {
    projectId: 'p_dryrun_create_2026',
    id: 'p_dryrun_create_2026',
    type: 'frontend',
    name: 'Dry-run project',
    createdFrom: 'cli',
    createdAt: '2026-05-16T00:00:00.000Z',
    updatedAt: '2026-05-16T00:00:00.000Z',
  } satisfies CliCreateProjectResponse),
  // P7 — PATCH /projects/{id} (update project). Both id
  // field names shown — see `CliUpdateProjectResponse`.
  entry('updateProject', 'PATCH', '/projects/{projectId}', {
    projectId: SAMPLE_PROJECT_ID,
    id: SAMPLE_PROJECT_ID,
    updatedFields: ['name'],
    updatedAt: '2026-05-16T00:00:00.000Z',
  } satisfies CliUpdateProjectResponse),
  // DELETE /projects/{id} (cascade delete project + tests + fixtures).
  entry('deleteProject', 'DELETE', '/projects/{projectId}', {
    projectId: SAMPLE_PROJECT_ID,
    deletedAt: '2026-05-16T00:00:00.000Z',
  } satisfies CliDeleteProjectResponse),
  entry('listTests', 'GET', '/tests', pageOf(tests)),
  // Execution report — static `executions/` prefix, four segments, so no
  // `/tests/{testId}/…` pattern can shadow it; kept beside the other reads.
  entry('getExecutionReport', 'GET', '/tests/executions/{runId}/report', executionReportSample),
  // `getTest` is the catch-all for `/tests/{id}` — must appear AFTER the
  // `/tests/{id}/{...}` siblings so the more specific patterns win.
  entry('getTest', 'GET', '/tests/{testId}', tests[0]),
  // M3.3 piece-3 — POST /tests/{testId}/runs (trigger run).
  // **MUST appear before `/tests` and `/tests/{testId}` generic matchers**
  // so the more-specific runs path wins. Canned response shape per the
  // runs-trigger design spec.
  entry('triggerRun', 'POST', '/tests/{testId}/runs', (req?: unknown): TriggerRunResponse => ({
    resultId: SAMPLE_RESULT_ID,
    runId: SAMPLE_RUN_ID,
    status: 'queued',
    enqueuedAt: '2026-05-15T19:32:00.000Z',
    codeVersion: 'v1',
    targetUrl: SAMPLE_TARGET_URL,
    ...echoSkipDependencies(req),
  })),
  // M4 piece-2 — POST /tests/batch/run (fresh wave-ordered batch run).
  // Shows `accepted[]` with per-test runIds + `skippedFrontend[]` so dry-run
  // learners see both shapes.
  entry(
    'triggerBatchRunFresh',
    'POST',
    '/tests/batch/run',
    (req?: unknown) =>
      ({
        accepted: [
          {
            runId: SAMPLE_RUN_ID,
            testId: SAMPLE_TEST_ID_FRESH_1,
            resultId: SAMPLE_BATCH_FRESH_RESULT_ID_1,
            enqueuedAt: '2026-06-09T10:00:00.000Z',
          },
          {
            runId: SAMPLE_RUN_ID,
            testId: SAMPLE_TEST_ID_FRESH_2,
            resultId: SAMPLE_BATCH_FRESH_RESULT_ID_2,
            enqueuedAt: '2026-06-09T10:00:00.000Z',
          },
        ],
        conflicts: [],
        deferred: [],
        skippedFrontend: [],
        skippedIntegration: [],
        ...echoSkipDependencies(req),
      }) satisfies BatchRunFreshResponse,
  ),
  // One entry answers `?run=` and `?test=`; only a test's history carries the
  // plan's history window.
  entry('listResults', 'GET', '/results', (_req?: unknown, query?: URLSearchParams) =>
    query?.has('run')
      ? {
          run: {
            runId: query.get('run')!,
            projectId: SAMPLE_PROJECT_ID,
            status: 'finished',
            cancelled: false,
            created: '2026-11-15T00:00:00Z',
            modified: '2026-11-15T00:00:00Z',
            targetUrl: SAMPLE_TARGET_URL,
            dashboardUrl: null,
          },
          results: resultListSample.results,
        }
      : resultListSample,
  ),
  entry('getResult', 'GET', '/results/{resultId}', resultDetailSample),
  // M3.3 piece-3 — GET /runs/{runId} (live status / long-poll).
  // A terminal `passed` row is the most useful dry-run shape: agents see
  // what a completed run looks like, and `--wait` terminates immediately.
  // fix(2026-05-21): a duplicate failed-shape entry that appeared before
  // this entry was removed; findSample first-match-wins was always
  // returning status: "failed" for `run wait --dry-run`.
  entry('getRun', 'GET', `/runs/${SAMPLE_FAILED_RESULT_ID}`, failedRunSample),
  entry('getRun', 'GET', '/runs/{runId}', passedRunSample),
  // POST /runs/{runId}/cancel. Method-guarded in
  // `findSample` (POST vs `getRun`'s GET), so this can't be shadowed by the
  // broader `/runs/{runId}` pattern above despite sharing its path prefix.
  // `alreadyCancelled: false` — a fresh cancel is the more instructive shape
  // for a dry-run learner than the idempotent no-op.
  entry('cancelRun', 'POST', '/runs/{runId}/cancel', {
    runId: SAMPLE_RUN_ID,
    alreadyCancelled: false,
    alreadyFinished: false,
    results: [
      {
        resultId: SAMPLE_RESULT_ID,
        runId: SAMPLE_RUN_ID,
        testId: SAMPLE_TEST_ID_PASSED,
        title: 'Sample test',
        status: 'cancelled',
        alreadyCancelled: false,
        alreadyFinished: false,
      },
    ],
  } satisfies CancelRunResponse),
  entry('listSchedules', 'GET', '/schedules', { schedules: [schedule] }),
  // `schedule create --dry-run` exits before the HTTP client is built, so this
  // sample is not fetched. Registered as a shape-guard only, same as
  // `deleteBatch` above.
  entry('createSchedule', 'POST', '/schedules', { scheduleId: 'sch_dryrun_2026' }),
  entry('getSchedule', 'GET', '/schedules/{scheduleId}', schedule),
  // Echoes the requested change so a caller can confirm the flags they passed
  // reached the body, rather than showing an unrelated canned schedule.
  entry('updateSchedule', 'PATCH', '/schedules/{scheduleId}', (req?: unknown) => {
    const patch = req != null && typeof req === 'object' ? (req as Record<string, unknown>) : {};
    const parseIso = (val: unknown): string | null | undefined => {
      if (val === null) return null;
      if (typeof val !== 'string') return undefined;
      const d = new Date(val);
      return Number.isNaN(d.getTime()) ? val : d.toISOString();
    };
    const startAt = parseIso(patch.startAt);
    const endAt = parseIso(patch.endAt);
    return {
      ...schedule,
      ...(typeof patch.name === 'string' ? { name: patch.name } : {}),
      ...(typeof patch.environment === 'string'
        ? { environment: patch.environment, environmentMode: 'pinned' as const }
        : {}),
      ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
      ...(typeof patch.cron === 'string' ? { cron: patch.cron } : {}),
      ...(typeof patch.timezone === 'string' ? { timezone: patch.timezone } : {}),
      ...(startAt !== undefined ? { startAt } : {}),
      ...(endAt !== undefined ? { endAt } : {}),
      ...(typeof patch.sendTo === 'string' ? { sendTo: patch.sendTo } : {}),
      updatedAt: '2026-05-16T00:00:00.000Z',
    };
  }),
  entry('deleteSchedule', 'DELETE', '/schedules/{scheduleId}', {
    scheduleId: SAMPLE_SCHEDULE_ID,
  }),
  entry('listTunnels', 'GET', '/tunnel', {
    tunnels: [
      {
        clientId: SAMPLE_TUNNEL_ID_1,
        status: 'online',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T01:00:00.000Z',
      },
      {
        clientId: SAMPLE_TUNNEL_ID_2,
        status: 'offline',
        createdAt: null,
        expiresAt: '2026-01-01T02:00:00.000Z',
      },
    ],
  } satisfies TunnelListResponse),
  entry('getTunnelStatus', 'GET', '/tunnel/{clientId}', {
    clientId: SAMPLE_TUNNEL_ID_1,
    status: 'online',
    expiresAt: '2026-01-01T01:00:00.000Z',
  } satisfies TunnelStatusResponse),
];

/** What a backend that handles the field answers: `true` when asked, otherwise the key is omitted. */
function echoSkipDependencies(req: unknown): { skipDependencies?: true } {
  return req != null &&
    typeof req === 'object' &&
    (req as Record<string, unknown>).skipDependencies === true
    ? { skipDependencies: true }
    : {};
}

function entry(
  operationId: string,
  method: DryRunMethod,
  pathTemplate: string,
  body: unknown | DryRunSampleEntry['body'],
): DryRunSampleEntry {
  const bodyFn = typeof body === 'function' ? (body as DryRunSampleEntry['body']) : () => body;
  return {
    operationId,
    method,
    pathTemplate,
    pattern: buildPathPattern(pathTemplate),
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

export function findSample(
  method: string,
  url: string,
  requestBody?: unknown,
): DryRunSampleEntry | undefined {
  const upper = method.toUpperCase();
  const pathOnly = extractPath(url);
  for (const e of ENTRIES) {
    if (e.method === upper && e.pattern.test(pathOnly)) {
      // Rebind body so downstream code can call `e.body` as before while
      // still preserving the original lazy factory semantics.
      return { ...e, body: () => e.body(requestBody, queryOf(url)) };
    }
  }
  return undefined;
}

/** The query of `url`, absolute or not. */
function queryOf(url: string): URLSearchParams {
  const queryIdx = url.indexOf('?');
  return new URLSearchParams(queryIdx >= 0 ? url.slice(queryIdx + 1) : '');
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

/** Test-only export so `samples.test.ts` can verify the route-template matcher directly. */
export const buildDryRunPathPattern = buildPathPattern;
