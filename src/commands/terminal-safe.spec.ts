import { projectRun, runListing } from '../../test/helpers/project-run.js';
/**
 * Server text on a terminal: every command family, in text mode, prints what
 * the server sent without an escape sequence or a control character, and a
 * one-line value the server split across lines stays on its line.
 *
 * This file runs the real program against a backend whose free text carries
 * a payload: a window-title OSC, an OSC 8 hyperlink, a clear-screen CSI, an
 * 8-bit CSI and OSC, a bidi override and a C1 control. Names and titles also
 * carry a line break followed by text that reads like a line of the CLI's own.
 * For each family it reads stdout and stderr and checks three things:
 *  1. no C0 (but tab and line feed), C1, DEL or bidi control is printed;
 *  2. the payload's visible text is printed, so the field was rendered;
 *  3. no printed line starts with the text after the server's line break.
 * In JSON mode the document is the server's text (the same JSON value) with
 * no raw DEL or C1 byte.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findSample } from '../lib/dry-run/samples.js';
import type * as InterruptModule from '../lib/interrupt.js';
import type * as PromptModule from '../lib/prompt.js';
import type * as TunnelClientModule from '../vendor/tunnel-client/index.js';
import { resultLine } from '../../test/helpers/result-list.js';

vi.mock('../lib/interrupt.js', async importOriginal => ({
  ...(await importOriginal<typeof InterruptModule>()),
  installSignalHandlers: vi.fn(),
  installBrokenPipeGuard: vi.fn(),
  armInterruptExitBackstop: vi.fn(),
}));
vi.mock('../lib/proxy.js', () => ({
  maybeInstallProxyAgent: vi.fn(),
  isProxyAgentActive: () => false,
}));

// ── the payload ──────────────────────────────────────────────────────────────

/**
 * Every escape a terminal acts on, between visible letters: OSC 8 (a link),
 * OSC 0 (the window title), CSI 2J (clear the screen), an 8-bit CSI, an 8-bit
 * OSC ended by the 8-bit ST, a bidi override and NEL (a C1 control).
 */
const ESCAPES =
  'A\u001b]8;;https://evil.example\u0007B\u001b]0;pwned\u0007C\u001b[2JD\u009b31mE\u009d0;x\u009cF\u202EG\u0085H';
/**
 * What a terminal-safe rendering of {@link ESCAPES} shows. The 8-bit OSC
 * introducer is removed alone, so the text after it is printed as text.
 */
const SHOWN = 'ABCDE0;xFGH';
/** A line break, then text that reads like one of the CLI's own lines. */
const FORGED = 'forged: line';

/** Any control character a terminal acts on: C0 but tab and line feed, DEL, C1, bidi. */
const CONTROL =
  // eslint-disable-next-line no-control-regex -- finding control characters is the point.
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
/** DEL and C1, the controls `JSON.stringify` leaves raw. */
const RAW_C1 = /[\u007F-\u009F]/;

/** Free text: the server's prose, which may run over several lines. */
const FREE_TEXT = new Set([
  'description',
  'text',
  'summary',
  'reply',
  'error',
  'cause',
  'fix',
  'narrative',
  'blockedReason',
  'detail',
  'applied',
  'rejected',
  'message',
]);
/** One-line values: a name, a title, a label. */
const ONE_LINE = new Set([
  'name',
  'title',
  'slug',
  'label',
  'testTitle',
  'projectName',
  'environmentName',
  'model',
  'plan',
  'role',
  'username',
  'category',
  'authMode',
  'url',
  'targetUrl',
  'resultUrl',
  'videoUrl',
  'timezone',
  'priority',
  'createdFrom',
  'keyId',
  'lastRunId',
  'scopes',
  'testIdAttributes',
  'released',
  'updatedFields',
]);

/**
 * `value` with the payload added to every free-text and one-line string in it.
 * A string in an array takes its array's key (`scopes: ['run:tunnel']`).
 */
function poisoned(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map(item => poisoned(item, key));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, poisoned(v, k)]));
  }
  if (typeof value !== 'string' || key === undefined) return value;
  if (ONE_LINE.has(key)) return `${value}${ESCAPES}\n${FORGED}`;
  if (FREE_TEXT.has(key)) return `${value}${ESCAPES}`;
  return value;
}

// ── the backend ──────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A result id the server sent with the payload in it: an id is printed inside
 * a line (a row, a hint), so it must stay on that line too.
 */
const RESULT_ID = `res_T${ESCAPES}\n${FORGED}`;
/** The launch the result is in, which hints name in a command (`run wait <run-id>`). */
const LAUNCH_ID = `run_T${ESCAPES}\n${FORGED}`;
/** A tunnel client: the command takes a UUID, the server's answer names it with the payload. */
const TUNNEL_UUID = '11111111-2222-3333-4444-555555555555';
const TUNNEL_ID = `${TUNNEL_UUID}${ESCAPES}\n${FORGED}`;

const FAILED_RUN = {
  resultId: RESULT_ID,
  runId: LAUNCH_ID,
  testId: 'T',
  projectId: 'P',
  userId: 'U',
  status: 'failed',
  source: 'cli',
  createdAt: '2026-11-01T00:00:00Z',
  startedAt: '2026-11-01T00:00:01Z',
  finishedAt: '2026-11-01T00:00:09Z',
  codeVersion: 'v1',
  targetUrl: `https://shop.example${ESCAPES}\n${FORGED}`,
  createdFrom: 'cli',
  failedStepIndex: 2,
  failureKind: 'assertion',
  error: `The cart total was wrong${ESCAPES}\nsecond line`,
  videoUrl: null,
  dashboardUrl: `https://portal.example/dashboard-v3/projects/P/tests/T${ESCAPES}\n${FORGED}`,
  executionUrl: `https://portal.example/dashboard-v3/projects/P/execution/run_T/test/res_T${ESCAPES}\n${FORGED}`,
  testTitle: `Checkout${ESCAPES}\n${FORGED}`,
  environment: { id: 'env_1', name: `staging${ESCAPES}\n${FORGED}` },
  stepSummary: { total: 3, completed: 3, passedCount: 2, failedCount: 1 },
};

const TESTLIST = {
  id: 'L',
  name: `Smoke${ESCAPES}\n${FORGED}`,
  orgId: 'org',
  caseCount: 1,
  projectEnvironments: [{ projectId: 'P', environmentName: `staging${ESCAPES}\n${FORGED}` }],
  lastRunId: null,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
};

const ENVIRONMENT = {
  id: 'env_1',
  name: 'staging',
  url: `https://shop.example${ESCAPES}`,
  isDefault: true,
  authMode: `account${ESCAPES}\n${FORGED}`,
  hasCredentials: true,
  username: `qa@shop.example${ESCAPES}\n${FORGED}`,
  enableOtp: false,
  updatedAt: '2026-11-01T00:00:00Z',
};

/** The project's local environment: a run on it opens a tunnel. Its name is typed as --env, so it is plain. */
const LOCAL_ENVIRONMENT = {
  id: 'env_2',
  name: 'local',
  url: 'http://localhost:5173',
  isDefault: false,
  authMode: 'public',
  hasCredentials: false,
  username: null,
  enableOtp: false,
  updatedAt: '2026-11-01T00:00:00Z',
};

/** A server value carrying the payload. */
const poison = (value: string): string => `${value}${ESCAPES}\n${FORGED}`;

/**
 * A backend environment's API sign-in under each kind of auth `get` renders
 * differently, and one the CLI does not know. Every value, a header's name
 * included, carries the payload.
 */
const API_AUTH_OF = {
  login: 'login',
  refresh: 'refresh-token',
  cognito: 'cognito',
  bearer: 'bearer',
  odd: poison('odd-auth'),
} as const;
function apiEnvironment(name: keyof typeof API_AUTH_OF) {
  return {
    ...ENVIRONMENT,
    name: poison(`api-${name}`),
    authMode: 'public',
    hasCredentials: false,
    username: null,
    api: {
      url: poison('https://api.shop.example'),
      auth: API_AUTH_OF[name],
      loginUrl: poison('https://api.shop.example/login'),
      loginMethod: poison('POST'),
      loginContentType: poison('json'),
      loginBody: poison('{"user":"{{username}}"}'),
      username: poison('qa'),
      tokenPath: poison('data.token'),
      tokenUrl: poison('https://auth.shop.example/token'),
      clientId: poison('client-1'),
      scope: poison('read'),
      region: poison('us-east-1'),
      inject: poison('bearer'),
      headers: { [poison('X-Tenant')]: poison('acme'), 'X-Api-Key': null },
      credentialSet: true,
      passwordSet: true,
      clientSecretSet: true,
      refreshTokenSet: true,
      authError: poison('Login endpoint returned 401'),
    },
  };
}

/** A manual (SSO) environment: its login and its Portal page are server values too. */
const MANUAL_ENVIRONMENT = {
  ...ENVIRONMENT,
  name: poison('sso'),
  authMode: 'manual',
  hasCredentials: false,
  username: null,
  portalUrl: poison('https://portal.shop.example/env'),
  manualLogin: {
    session: 'valid',
    capturedAt: '2026-11-01T00:00:00Z',
    expiresAt: poison('2026-11-01T01:00:00Z'),
    sessionReuseTtlSeconds: 3600,
  },
};

/** A preview `--target-url` names; a literal IP, so the preflight skips DNS. */
const PROTECTED_PREVIEW_HOST = '203.0.113.10';
/**
 * The payload as a header can carry it: no line break, nothing past Latin-1
 * (so no bidi control), the escapes and an 8-bit CSI kept.
 */
const HEADER_ESCAPES =
  'A\u001b]8;;https://evil.example\u0007B\u001b]0;pwned\u0007C\u001b[2JD\u009b31mE';
/** Plain text in the redirect, which a terminal-safe rendering would still show. */
const REDIRECT_TEXT = 'from-the-redirect';

/** The current contract, with the payload in every server string a person reads. */
async function backend(input: unknown, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const path = decodeURIComponent(url.pathname.replace('/api/cli/v1', ''));
  const method = init.method ?? 'GET';
  const route = `${method} ${path}`;
  const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;

  // The preflight's probe of a preview behind Vercel's login wall: the
  // redirect a visitor without a Vercel session gets, carrying the payload.
  if (url.hostname === PROTECTED_PREVIEW_HOST) {
    return new Response(null, {
      status: 302,
      headers: {
        location: `https://vercel.com/sso-api?url=${REDIRECT_TEXT}${HEADER_ESCAPES}&nonce=1`,
      },
    });
  }

  if (route === `GET /runs/${RESULT_ID}`) return json(FAILED_RUN);
  // A batch's results (`res_T…`, `res_U…`): failed, like FAILED_RUN.
  if (method === 'GET' && path.startsWith('/runs/res_')) {
    const resultId = path.slice('/runs/'.length);
    return json({ ...FAILED_RUN, runId: resultId, testId: resultId.slice(4, 5) });
  }
  if (method === 'POST' && path.startsWith('/runs/') && path.endsWith('/cancel'))
    return json({
      runId: path.slice(6, -7),
      alreadyCancelled: false,
      alreadyFinished: false,
      results: [
        {
          runId: path.slice(6, -7),
          resultId: RESULT_ID,
          testId: 'T',
          title: `Checkout${ESCAPES}\n${FORGED}`,
          status: 'cancelled',
          alreadyCancelled: false,
          alreadyFinished: false,
          refund: { status: 'refunded', amount: 1 },
        },
      ],
    });
  if (route === 'GET /results' && url.searchParams.has('run'))
    return json(
      runListing({ runId: url.searchParams.get('run')!, status: 'finished', cancelled: false }, [
        resultLine({
          resultId: RESULT_ID,
          runId: url.searchParams.get('run')!,
          caseKey: 'T',
          title: `Checkout${ESCAPES}\n${FORGED}`,
          testStatus: 'FAILED',
        }),
      ]),
    );
  if (route === 'GET /testlist') return json({ items: [TESTLIST] });
  if (route === 'GET /testlist/L') {
    return json({
      ...TESTLIST,
      cases: [
        {
          testId: 'T',
          type: 'frontend',
          projectId: 'P',
          projectName: `Shop${ESCAPES}\n${FORGED}`,
          title: `Checkout${ESCAPES}\n${FORGED}`,
          category: `Cart${ESCAPES}\n${FORGED}`,
          priority: 'high',
          modified: null,
          status: 'failed',
        },
      ],
      stats: { total: 1, passed: 0, failed: 1, blocked: 0, running: 0 },
      lastRunCreated: null,
    });
  }
  // The tests a batch names: the run reads which project they are in (P, whose
  // local environment opens the tunnel); the sample's own project is another.
  if (route === 'GET /tests/T' || route === 'GET /tests/U') {
    const sample = poisoned(findSample(method, url.toString())!.body()) as object;
    return json({ ...sample, id: path.slice('/tests/'.length), projectId: 'P', type: 'frontend' });
  }
  if (route === 'GET /tests/missing') {
    return json(
      {
        error: {
          code: 'NOT_FOUND',
          message: `Test missing not found${ESCAPES}\n${FORGED}`,
          nextAction: `Check the id${ESCAPES}`,
          requestId: `req_1${ESCAPES}\n${FORGED}`,
          details: {},
        },
      },
      404,
    );
  }
  if (route === 'GET /projects/P/conversations/c_pw') {
    // A card waiting on a password: the agent proposed the environment name.
    const conversation = poisoned(findSample(method, url.toString())!.body()) as object;
    return json({
      ...conversation,
      state: 'proposed',
      proposal: {
        id: 'card-1',
        kind: 'secret',
        summary: `The password of staging${ESCAPES}\n${FORGED}`,
        secret: { environment: `staging${ESCAPES}\n${FORGED}`, field: 'password' },
      },
    });
  }
  if (route === 'GET /projects/P/env')
    return json({ environments: [ENVIRONMENT, LOCAL_ENVIRONMENT] });
  // The full project card: every field it prints, the id included (a hint
  // names it in a command), carries the payload.
  if (route === 'GET /projects/P') {
    return json({
      id: `P${ESCAPES}\n${FORGED}`,
      name: `Shop${ESCAPES}\n${FORGED}`,
      type: 'frontend',
      createdFrom: `portal${ESCAPES}\n${FORGED}`,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-02T00:00:00Z',
      orgId: `org_1${ESCAPES}\n${FORGED}`,
      orgName: `Shop Inc${ESCAPES}\n${FORGED}`,
      defaultEnvironment: `staging${ESCAPES}\n${FORGED}`,
      environmentCount: 2,
      testIdAttributes: null,
    });
  }
  if (route === 'GET /tunnel') {
    return json({
      tunnels: [
        {
          clientId: TUNNEL_ID,
          status: 'online',
          createdAt: '2026-11-01T00:00:00Z',
          expiresAt: `2026-11-02T00:00:00Z${ESCAPES}\n${FORGED}`,
        },
      ],
    });
  }
  if (route === `GET /tunnel/${TUNNEL_UUID}`) {
    return json({
      clientId: TUNNEL_ID,
      status: 'online',
      expiresAt: `2026-11-02T00:00:00Z${ESCAPES}\n${FORGED}`,
    });
  }
  if (method === 'POST' && /^\/projects\/[^/]+\/runs$/.test(path)) {
    const request = body as {
      testIds?: string[];
      tunnelClientId?: string;
      targetUrl?: string;
      environment?: string;
      maxConcurrency?: number;
    };
    return json(
      projectRun({
        runId: LAUNCH_ID,
        projectId: path.split('/')[2],
        total: request.testIds?.length ?? 1,
        targetUrl: request.targetUrl ?? `https://shop.example${ESCAPES}\n${FORGED}`,
        dashboardUrl: FAILED_RUN.dashboardUrl ?? undefined,
        // The run confirms the environment it was asked for; the local one is plain.
        environment:
          request.environment === LOCAL_ENVIRONMENT.name
            ? { id: LOCAL_ENVIRONMENT.id, name: LOCAL_ENVIRONMENT.name }
            : (FAILED_RUN.environment ?? null),
        tunnelClientId: request.tunnelClientId,
        maxConcurrency: request.maxConcurrency,
      }),
    );
  }
  if (route === 'POST /tunnel') {
    return json(
      {
        clientId: TUNNEL_UUID,
        secret: 'tunnel-secret',
        controlUrl: 'ws://tunnel.example:7300/ws',
        tunnelAddr: 'tunnel.example:7400',
        expiresAt: `2026-11-02T00:00:00Z${ESCAPES}\n${FORGED}`,
      },
      201,
    );
  }
  if (route === `DELETE /tunnel/${TUNNEL_UUID}`) return new Response(null, { status: 204 });
  if (route === 'POST /testlist/L/run') {
    return json({
      accepted: [
        {
          testId: 'T',
          resultId: RESULT_ID,
          runId: LAUNCH_ID,
          enqueuedAt: '2026-11-01T00:00:00Z',
        },
      ],
      conflicts: [
        {
          testId: 'U',
          currentResultId: `res_U${ESCAPES}\n${FORGED}`,
          currentRunId: LAUNCH_ID,
          reason: 'already_in_flight',
          message: `Already running${ESCAPES}\n${FORGED}`,
        },
      ],
      deferred: [],
    });
  }
  if (route === 'GET /projects/P/env/staging') return json({ environment: ENVIRONMENT });
  if (route === 'GET /projects/P/env/sso') return json({ environment: MANUAL_ENVIRONMENT });
  if (route === 'POST /projects/P/env' && (body as { signIn?: string }).signIn === 'manual') {
    return json({ environment: MANUAL_ENVIRONMENT, created: true });
  }
  const apiEnv = /^GET \/projects\/P\/env\/api-(login|refresh|cognito|bearer|odd)$/.exec(route);
  if (apiEnv) {
    return json({ environment: apiEnvironment(apiEnv[1] as keyof typeof API_AUTH_OF) });
  }
  // A save that switched a sign-in on and came back with its trial login failed.
  const savesSignIn = (body as { autoAuth?: unknown } | undefined)?.autoAuth !== undefined;
  if (route === 'POST /projects/P/env' && savesSignIn) {
    return json({ environment: apiEnvironment('login'), created: true });
  }
  if (route === 'PATCH /projects/P/env/staging' && savesSignIn) {
    return json({ environment: apiEnvironment('login') });
  }

  const sample = findSample(method, url.toString(), body);
  if (sample) return json(poisoned(sample.body()));
  throw new Error(`Unexpected request: ${route}`);
}

// ── running the program ──────────────────────────────────────────────────────

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const dirs: string[] = [];
let stdout = '';
let stderr = '';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(line => {
    stdout += `${String(line)}\n`;
  });
  vi.spyOn(console, 'error').mockImplementation(line => {
    stderr += `${String(line)}\n`;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    stderr += String(chunk);
    return true;
  });
  vi.stubEnv('TESTSPRITE_API_KEY', 'sk-user-unit-test');
  vi.stubEnv('TESTSPRITE_API_URL', 'https://api.example.com');
  vi.stubEnv('TESTSPRITE_NO_SKILL_WARNING', '1');
  vi.stubEnv('TESTSPRITE_NO_UPDATE_CHECK', '1');
  vi.stubEnv('TESTSPRITE_NO_UPDATE_NOTIFIER', '1');
  vi.stubEnv('TESTSPRITE_NO_TELEMETRY', '1');
  vi.stubEnv('GITHUB_ACTIONS', '');
  vi.doMock('../vendor/tunnel-client/index.js', async importOriginal => ({
    ...(await importOriginal<typeof TunnelClientModule>()),
    TunnelClient: class {
      async start() {}
      async stop() {}
    },
  }));
});

afterEach(() => {
  vi.doUnmock('../vendor/tunnel-client/index.js');
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Printed {
  exit: number;
  stdout: string;
  stderr: string;
  /** The job summary the command wrote, when it wrote one (`--gh-output`). */
  jobSummary?: string;
}

/** Run the real program once, in process, in a directory of its own. */
async function cli(args: string[]): Promise<Printed> {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-safe-'));
  dirs.push(dir);
  vi.resetModules();
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  // The GitHub files go to this directory, never to the job running the suite.
  const jobSummary = join(dir, 'job-summary.md');
  vi.stubEnv('GITHUB_STEP_SUMMARY', jobSummary);
  vi.stubEnv('GITHUB_OUTPUT', join(dir, 'github-output'));
  vi.stubGlobal('fetch', vi.fn(backend));
  process.argv = ['node', 'testsprite', ...args];
  await import('../index.js');
  return {
    exit: Number(process.exitCode ?? 0),
    stdout,
    stderr,
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp dir.
    ...(existsSync(jobSummary) ? { jobSummary: readFileSync(jobSummary, 'utf8') } : {}),
  };
}

/**
 * The three checks on what a command printed in text mode. A JSON document
 * printed in text mode keeps the payload as escapes (`\u001b`, `\u202e`)
 * instead of dropping it, so for one the payload must show escaped on stdout,
 * and its stderr, which is text, gets the checks of any text.
 */
function expectTerminalSafe(printed: Printed, jsonDocument = false): void {
  const all = `${printed.stdout}${printed.stderr}`;
  const controls = all.split('\n').filter(line => CONTROL.test(line));
  expect(controls, 'a printed line carries a control character').toEqual([]);
  if (jsonDocument) {
    expect(printed.stdout, 'the payload was never printed').toContain('\\u001b]0;pwned');
    expect(printed.stdout).toContain('\\u202e');
  } else {
    expect(all, 'the payload was never printed, so nothing was checked').toContain(SHOWN);
  }
  const text = jsonDocument ? printed.stderr : all;
  expect(text).not.toContain('pwned');
  expect(text).not.toContain('evil.example');
  const forged = text.split('\n').filter(line => line.trimStart().startsWith(FORGED));
  expect(forged, 'a server line break started a line of its own').toEqual([]);
}

/**
 * Each family whose lines name a server value someone acts on. Lines that are
 * routed through the sanitiser but decide nothing (doctor, setup, the update
 * notices) have no case: the boundary layer alone keeps every escape out of them.
 */
const FAMILIES: ReadonlyArray<{
  family: string;
  args: string[];
  exit?: number;
  /** It prints a JSON document in text mode (no text renderer). */
  jsonDocument?: boolean;
  /** Its own stderr lines name a server value, so stderr alone must show the payload. */
  stderrShows?: boolean;
}> = [
  { family: 'test list', args: ['test', 'list', '--project', 'P'] },
  { family: 'test get', args: ['test', 'get', 'T'] },
  {
    family: 'run: the card and its stderr lines',
    args: ['run', 'T'],
    stderrShows: true,
  },
  {
    family: 'run --wait: the run card, progress and failure hint',
    args: ['run', 'T', '--wait', '--timeout', '30', '--skip-preflight'],
    exit: 1,
  },
  {
    family: 'run --wait --gh-output: the workflow-command annotation',
    args: ['run', 'T', '--wait', '--timeout', '30', '--skip-preflight', '--gh-output'],
    exit: 1,
  },
  { family: 'run <id> <id>: the batch rows', args: ['run', 'T', 'U'] },
  {
    family: 'run <id> <id> --env local: the rows and stderr lines of a run through a tunnel',
    args: ['run', 'T', 'U', '--env', 'local', '--skip-preflight', '--timeout', '30'],
    exit: 1,
    stderrShows: true,
  },
  {
    // No text renderer: the batch prints its JSON document in text mode too.
    family: 'run <id> <id> --wait: the JSON document a batch prints in text mode',
    args: ['run', 'T', 'U', '--wait', '--timeout', '30'],
    exit: 1,
  },
  { family: 'run cancel', args: ['run', 'cancel', 'E'] },
  { family: 'run wait', args: ['run', 'wait', 'E', '--timeout', '30'], exit: 1 },
  { family: 'project list', args: ['project', 'list'] },
  { family: 'project get', args: ['project', 'get', 'P'] },
  {
    family: 'project create: the card',
    args: ['project', 'create', '--type', 'frontend', '--name', 'Shop'],
  },
  { family: 'project update: the card', args: ['project', 'update', 'P', '--name', 'Shop'] },
  { family: 'project env list', args: ['project', 'env', 'list', 'P'] },
  { family: 'project env get', args: ['project', 'env', 'get', 'P', 'staging'] },
  {
    family: "project env get: a manual environment's login",
    args: ['project', 'env', 'get', 'P', 'sso'],
  },
  {
    family: 'project env create --sign-in manual: where to log in',
    args: [
      'project',
      'env',
      'create',
      'P',
      '--name',
      'sso',
      '--url',
      'https://shop.example',
      '--sign-in',
      'manual',
    ],
    stderrShows: true,
  },
  ...(['login', 'refresh', 'cognito', 'bearer', 'odd'] as const).map(name => ({
    family: `project env get: a backend environment's API sign-in (${name})`,
    args: ['project', 'env', 'get', 'P', `api-${name}`],
  })),
  { family: 'schedule list', args: ['schedule', 'list'] },
  { family: 'schedule get', args: ['schedule', 'get', 'sch_1'] },
  { family: 'testlist list', args: ['testlist', 'list'] },
  { family: 'testlist get', args: ['testlist', 'get', 'L'] },
  { family: 'run --testlist: the rows', args: ['run', '--testlist', 'L', '--no-wait'] },
  { family: 'tunnel list', args: ['tunnel', 'list'] },
  { family: 'tunnel status', args: ['tunnel', 'status', TUNNEL_UUID] },
  { family: 'usage', args: ['usage'] },
  { family: 'auth status', args: ['auth', 'status'] },
  {
    family: 'agent status (the conversation)',
    args: ['status', '--project', 'P', '--conversation', 'c1'],
  },
  {
    family: "plan: the agent's progress and reply it follows on stderr",
    args: ['plan', 'cover the coupons', '--project', 'P'],
    stderrShows: true,
  },
  { family: 'agent status --list', args: ['status', '--project', 'P', '--list'] },
  { family: 'result list', args: ['result', 'list', '--test', 'T'] },
  { family: 'result get', args: ['result', 'get', 'res_1'] },
  { family: 'the error a command exits with', args: ['test', 'get', 'missing'], exit: 4 },
];

describe('server text on a terminal, by command family', () => {
  it.each(FAMILIES)('$family', async ({ args, exit = 0, jsonDocument, stderrShows }) => {
    const printed = await cli([...args, '--output', 'text']);
    expect(printed.exit, printed.stderr).toBe(exit);
    expectTerminalSafe(printed, jsonDocument);
    if (stderrShows) expect(printed.stderr, 'no stderr line named a server value').toContain(SHOWN);
    // `--gh-output` writes its job summary into this test's own directory.
    if (args.includes('--gh-output')) expect(printed.jobSummary).toContain('## TestSprite results');
  });

  it.each([
    [
      'login',
      [
        'login-url:',
        'login-method:',
        'login-content-type:',
        'login-body:',
        'username:',
        'password:',
        'token-path:',
        'inject:',
      ],
    ],
    [
      'refresh',
      ['token-url:', 'client-id:', 'client-secret:', 'refresh-token:', 'scope:', 'inject:'],
    ],
    ['cognito', ['region:', 'client-id:', 'client-secret:', 'refresh-token:', 'inject:']],
    ['bearer', ['credential:']],
    ['odd', []],
  ] as const)(
    "project env get prints every line of a backend environment's API sign-in (%s), so each is checked",
    async (name, lines) => {
      const printed = await cli(['project', 'env', 'get', 'P', `api-${name}`, '--output', 'text']);
      expect(printed.exit, printed.stderr).toBe(0);
      const printedLines = printed.stdout.split('\n');
      const starts = [
        'name:',
        'auth:',
        ...lines,
        'auth-error:',
        'headers:     2',
        `  X-Tenant${SHOWN} ${FORGED}: acme${SHOWN} ${FORGED}`,
        '  X-Api-Key: <set>',
      ];
      for (const start of starts) {
        expect(
          printedLines.some(line => line.startsWith(start)),
          start,
        ).toBe(true);
      }
    },
  );

  it.each([
    [
      'create',
      ['project', 'env', 'create', 'P', '--name', 'api', '--url', 'https://api.shop.example'],
    ],
    ['update', ['project', 'env', 'update', 'P', 'staging']],
  ])(
    'project env %s: a failed trial login is reported on one line, with the server reason and the environment name',
    async (_verb, args) => {
      const dir = mkdtempSync(join(tmpdir(), 'terminal-safe-auth-'));
      dirs.push(dir);
      const config = join(dir, 'login.json');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp dir.
      writeFileSync(config, '{"method": "password", "inject": "bearer"}');
      const printed = await cli([...args, '--auto-auth-file', config, '--output', 'text']);
      expect(printed.exit, printed.stderr).toBe(0);
      expectTerminalSafe(printed);
      expect(printed.stderr).toContain(
        `trial login failed (Login endpoint returned 401${SHOWN} ${FORGED}).`,
      );
      expect(printed.stderr).toContain(
        `testsprite project env update P api-login${SHOWN} ${FORGED} --auto-auth-file <path>`,
      );
    },
  );

  it("project env get prints a manual environment's login and Portal lines, so each is checked", async () => {
    const printed = await cli(['project', 'env', 'get', 'P', 'sso', '--output', 'text']);
    expect(printed.exit, printed.stderr).toBe(0);
    const lines = printed.stdout.split('\n');
    for (const start of [
      `login:       signed in until 2026-11-01T01:00:00Z${SHOWN} ${FORGED}`,
      `portal:      https://portal.shop.example/env${SHOWN} ${FORGED}`,
    ]) {
      expect(
        lines.some(line => line.startsWith(start)),
        start,
      ).toBe(true);
    }
  });

  it("test get prints the case's own lines, so each is checked", async () => {
    const printed = await cli(['test', 'get', 'T', '--output', 'text']);
    expect(printed.exit, printed.stderr).toBe(0);
    const lines = printed.stdout.split('\n');
    for (const start of [
      `project:     Checkout${SHOWN} ${FORGED} (`,
      `slug:        CHECKOUT-001${SHOWN} ${FORGED}`,
      `title:       Checkout happy path${SHOWN} ${FORGED}`,
      `category:    Checkout${SHOWN} ${FORGED}`,
      `priority:    Medium${SHOWN} ${FORGED}`,
      `version:     v1.2${SHOWN} ${FORGED}`,
      'description: Pays for a cart with a saved card and lands on the confirmation page.' + SHOWN,
    ]) {
      expect(
        lines.some(line => line.startsWith(start)),
        start,
      ).toBe(true);
    }
  });

  it('project get prints its org, default environment and environment count lines, so they are checked too', async () => {
    const printed = await cli(['project', 'get', 'P', '--output', 'text']);
    expect(printed.exit, printed.stderr).toBe(0);
    const lines = printed.stdout.split('\n');
    for (const start of [
      `org:         Shop Inc${SHOWN} ${FORGED} (org_1${SHOWN} ${FORGED})`,
      `defaultEnv:  staging${SHOWN} ${FORGED}`,
      `envs:        2 (list with: testsprite project env list P${SHOWN} ${FORGED})`,
    ]) {
      expect(lines, start).toContain(start);
    }
  });
});

describe('a prompt that names a server value', () => {
  it('apply asks for the password of the environment the agent named on one safe line', async () => {
    // A person at a terminal; the prompt is recorded and printed as asked.
    const asked: string[] = [];
    vi.doMock('../lib/prompt.js', async importOriginal => ({
      ...(await importOriginal<typeof PromptModule>()),
      promptSecret: vi.fn(async (question: string) => {
        asked.push(question);
        process.stderr.write(question);
        return 's3cret';
      }),
    }));
    const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    try {
      const printed = await cli(['apply', '--project', 'P', '--conversation', 'c_pw']);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('Type the password of staging');
      expect(asked[0]).not.toMatch(CONTROL);
      expect(asked[0]).not.toContain('\n');
      expectTerminalSafe(printed);
    } finally {
      process.stdin.isTTY = tty.stdin;
      process.stdout.isTTY = tty.stdout;
      vi.doUnmock('../lib/prompt.js');
    }
  });
});

describe('a target the preflight probes', () => {
  it.each(['text', 'json'])(
    "a preview behind Vercel's login wall is refused (exit 5), and nothing from its redirect is printed (%s)",
    async output => {
      const printed = await cli([
        'ci',
        'run',
        '--project',
        'P',
        '--target-url',
        `http://${PROTECTED_PREVIEW_HOST}`,
        '--output',
        output,
      ]);
      expect(printed.exit, printed.stderr).toBe(5);
      expect(printed.stderr).toContain("Vercel's login wall");
      const all = `${printed.stdout}${printed.stderr}`;
      expect(all.split('\n').filter(line => CONTROL.test(line))).toEqual([]);
      expect(all).not.toContain(REDIRECT_TEXT);
      expect(all).not.toContain('pwned');
      expect(all).not.toContain('evil.example');
    },
  );
});

describe('server text in JSON', () => {
  it('is the same JSON value, with no raw DEL or C1 byte', async () => {
    const printed = await cli(['test', 'get', 'T', '--output', 'json']);
    expect(printed.exit, printed.stderr).toBe(0);
    expect(printed.stdout).not.toMatch(RAW_C1);
    expect(printed.stdout).toContain('\\u009b31m');
    const document = JSON.parse(printed.stdout) as { title: string };
    expect(document.title).toContain(ESCAPES);
  });

  it("the agent's progress on stderr is one escaped JSON value a line, the server's text", async () => {
    const printed = await cli(['plan', 'cover the coupons', '--project', 'P', '--output', 'json']);
    expect(printed.exit, printed.stderr).toBe(0);
    expect(printed.stderr).not.toMatch(CONTROL);
    const events = printed.stderr
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line) as { text?: string });
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(event => event.text?.includes(ESCAPES))).toBe(true);
  });

  it('an error envelope on stderr escapes them too', async () => {
    const printed = await cli(['test', 'get', 'missing', '--output', 'json']);
    expect(printed.exit).toBe(4);
    expect(printed.stderr).not.toMatch(RAW_C1);
    const envelope = JSON.parse(printed.stderr) as { error: { message: string } };
    expect(envelope.error.message).toContain(ESCAPES);
  });
});

describe("a command's own stderr lines", () => {
  /** The source files under `src/`, specs and the vendored tunnel client left out. */
  function sources(dir: string): string[] {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- walks this repo's own src/ tree.
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'vendor' ? [] : sources(path);
      return /\.ts$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name) ? [path] : [];
    });
  }

  /**
   * A line that writes to the terminal itself: `process.stdout/stderr.write`,
   * `writeSync` to their file descriptors (`process.stderr.fd`, 1 or 2), any
   * `console.*` method, a stream used as a writer (`?? process.stderr;`) or a
   * command's own stderr default (`deps.stderr ?? …`). Comments are skipped.
   */
  const WRITER =
    /process\.(?:stdout|stderr)\.write\(|\bwriteSync\(\s*(?:process\.(?:stdout|stderr)\.fd|[12])\b|\bconsole\.\w+\(|\?\?\s*process\.(?:stdout|stderr)\s*[;,)]|\b(?:deps|ctx|streams)\.stderr \?\?/;

  /**
   * The files allowed to write to a terminal themselves, how many such lines
   * each holds, and why each line is safe. Everything else writes through
   * Output (text through terminalSafe, JSON through jsonForTerminal) or a
   * stderr writer from terminalSafeWriter.
   */
  const ALLOWED: Record<string, { lines: number; why: string }> = {
    'index.ts': {
      lines: 16,
      why: 'the error renderer: each line is built with terminalSafe/terminalSafeLine, jsonForTerminal or a renderer that uses them; one --debug line names a local credentials error',
    },
    'lib/output.ts': {
      lines: 3,
      why: "Output's own writers: text through terminalSafe and JSON through jsonForTerminal",
    },
    'lib/terminal-text.ts': { lines: 1, why: "terminalSafeWriter's default target" },
    'lib/ticker.ts': {
      lines: 1,
      why: 'the ticker writes its own escape around a line it has made safe',
    },
    'lib/prompt.ts': { lines: 2, why: 'a question is written through terminalSafe' },
    'lib/interrupt.ts': {
      lines: 4,
      why: "the signal lines are the CLI's own words, written synchronously to fd 2 before an exit; the broken-pipe guard only watches the streams",
    },
    'lib/credentials.ts': { lines: 1, why: 'a warning about the local credentials file' },
    'commands/auth.ts': { lines: 1, why: 'the setup prelude names the profile the user gave' },
    'commands/conversation.ts': {
      lines: 1,
      why: "the agent's --output json progress, through jsonForTerminal",
    },
    'commands/completion.ts': { lines: 1, why: 'the shell script, built from the command tree' },
    'commands/test.ts': {
      lines: 3,
      why: 'stdout handed to the CI artifacts, whose workflow commands go through escapeCommandData',
    },
    'commands/testlist.ts': { lines: 2, why: 'the same CI-artifact stdout as test.ts' },
    'commands/ci.ts': {
      lines: 1,
      why: 'stdout given to Output, whose text goes through terminalSafe',
    },
    'commands/tunnel.ts': {
      lines: 1,
      why: 'stdout of `tunnel start`, which prints nothing through it',
    },
    'lib/environment-tunnel.ts': { lines: 1, why: 'the same CI-artifact stdout as test.ts' },
    'version-guard.ts': {
      lines: 1,
      why: "the CLI's own message that this Node version is too old, written to fd 2 before an exit",
    },
  };

  it('every line written to a terminal goes through the sanitiser, except in the files allowed', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    const found: Record<string, number> = {};
    for (const file of sources(src)) {
      // Forward slashes on every platform, so the names below hold on Windows.
      const name = relative(src, file).split(sep).join('/');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a source file of this repo.
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
        if (WRITER.test(line)) found[name] = (found[name] ?? 0) + 1;
      }
    }
    expect(found).toEqual(
      Object.fromEntries(Object.entries(ALLOWED).map(([name, { lines }]) => [name, lines])),
    );
  });
});
