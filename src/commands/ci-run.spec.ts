import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCiCommand, runCiRun, type CiRunOptions } from './ci.js';
import { InterruptError } from '../lib/errors.js';
import { takeTelemetryExtras } from '../lib/telemetry.js';
import { ShutdownController } from '../lib/interrupt.js';
import type { BatchRunFreshResponse, RunResponse, RunStatus } from '../lib/runs.types.js';
import type { CiSummary } from '../lib/gh-output.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function batch(overrides: Partial<BatchRunFreshResponse> = {}): BatchRunFreshResponse {
  return {
    accepted: [],
    conflicts: [],
    deferred: [],
    skippedFrontend: [],
    skippedIntegration: [],
    ...overrides,
  };
}

function accepted(testId: string, executionId?: string) {
  return {
    testId,
    runId: `run-${testId}`,
    enqueuedAt: '2026-09-18T00:00:00Z',
    ...(executionId !== undefined ? { executionId } : {}),
  };
}

/** A ready execution report in the server's shape, with the App's Markdown stand-in. */
function executionReport(executionId: string) {
  const resultUrl = `https://portal.example.com/dashboard-v3/o/org/projects/project-1/execution/${executionId}`;
  return {
    ready: true,
    report: {
      projectId: 'project-1',
      executionId,
      projectName: 'Shop',
      orgId: 'org',
      stats: { passed: 1, failed: 0, blocked: 0, total: 1 },
      allPassed: true,
      narrative: 'Everything passed.',
      whatCouldBeBetter: null,
      recommendedNextStep: null,
      tests: [
        {
          id: 'run-a',
          title: 'Checkout',
          slug: 'CHK-001',
          status: 'PASSED',
          screenshotUrl: null,
          error: null,
          fix: null,
          resultUrl: `${resultUrl}/test/run-a`,
        },
      ],
      resultUrl,
    },
    markdown: `> [!TIP]\n> ### All checks passed\n\n[View Full Report ↗](${resultUrl})\n`,
  };
}

function runResult(runId: string, status: RunStatus): RunResponse {
  return {
    runId,
    testId: runId.slice(4),
    testTitle: 'Checkout',
    projectId: 'project-1',
    userId: 'user-1',
    status,
    source: 'cli',
    createdFrom: 'cli',
    createdAt: '2026-09-18T00:00:00Z',
    startedAt: '2026-09-18T00:00:01Z',
    finishedAt: '2026-09-18T00:00:03Z',
    codeVersion: 'v1',
    targetUrl: 'https://preview.example.com',
    failedStepIndex: null,
    failureKind: null,
    error: status === 'failed' ? 'checkout failed' : null,
    videoUrl: null,
    stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 },
    dashboardUrl: 'https://portal.example.com/test',
    executionUrl: 'https://portal.example.com/run',
  };
}

function harness(
  responses = [batch({ accepted: [accepted('a')] })],
  status: RunStatus = 'passed',
  options: {
    /** Names the project's environment list answers with. */
    environments?: string[];
    /** A backend that read the CI fields echoes them; `false` plays an older one. */
    echo?: boolean;
    /** What GitHub answers for `GET /repos/{o}/{r}/commits/{sha}/pulls`. */
    pulls?: unknown;
    /**
     * Make the environment-list read fail: an HTTP status with an error
     * envelope, or a signal that interrupts the request mid-flight.
     */
    envList?: { status: number; code: string; details?: Record<string, unknown> } | 'interrupt';
    /**
     * What `GET /tests/executions/{id}/report` answers, per call (0-based);
     * a `Response` is returned verbatim (an older backend's 404). Absent ⇒
     * the route is unexpected, like any other unknown request.
     */
    report?: (call: number) => unknown;
    /** Override a `GET /runs/{id}` read; `undefined` keeps the default. */
    runRead?: (runId: string) => Response | undefined;
    /** Refuse the whole batch at `POST /tests/batch/run` with this error envelope. */
    batchRefusal?: { status: number; code: string; details?: Record<string, unknown> };
  } = {},
) {
  const environments = options.environments ?? ['default', 'pr-42', 'staging'];
  const echo = options.echo ?? true;
  const dir = mkdtempSync(join(tmpdir(), 'ci-run-'));
  dirs.push(dir);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  let post = 0;
  let reportCalls = 0;
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace('/api/cli/v1', '');
    const method = init.method ?? 'GET';
    if (url.hostname === 'api.github.com') {
      calls.push({ path: `github:${path}`, method });
      return new Response(JSON.stringify(options.pulls ?? []), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const body =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ path, method, body });
    let response: unknown;
    if (method === 'POST' && path === '/tests/batch/run') {
      if (options.batchRefusal) {
        return new Response(
          JSON.stringify({
            code: options.batchRefusal.code,
            message: `batch refused (${options.batchRefusal.code})`,
            nextAction: 'n/a',
            requestId: 'req-batch',
            details: options.batchRefusal.details ?? {},
          }),
          { status: options.batchRefusal.status, headers: { 'content-type': 'application/json' } },
        );
      }
      const base = responses[Math.min(post++, responses.length - 1)]!;
      response = echo
        ? {
            ...base,
            ...(body?.targetUrl !== undefined ? { targetUrl: body.targetUrl } : {}),
            ...(body?.admission !== undefined ? { admission: body.admission } : {}),
            ...(body?.previewName !== undefined ? { previewName: body.previewName } : {}),
          }
        : base;
    } else if (path.startsWith('/runs/')) {
      // The real long-poll consumes wall time even when it returns running.
      now += 1000;
      const overridden = options.runRead?.(path.slice('/runs/'.length).split('?')[0]!);
      if (overridden) return overridden;
      response = runResult(path.slice('/runs/'.length), status);
    } else if (/^\/tests\/executions\/[^/]+\/report$/.test(path) && options.report) {
      const answer = options.report(reportCalls++);
      if (answer instanceof Response) return answer;
      response = answer;
    } else if (path === '/tests')
      response = { items: [{ id: 'a', name: 'Checkout' }], nextToken: null };
    else if (path.startsWith('/tests/'))
      response = { id: path.slice('/tests/'.length), type: 'frontend', name: 'Checkout' };
    // 0.14.0 reads the project's environments before a batch (automatic
    // tunnel discovery; also under --dry-run). A public default needs none.
    else if (/^\/projects\/[^/]+\/env$/.test(path) && method === 'GET') {
      if (options.envList === 'interrupt') throw new InterruptError('SIGTERM');
      if (options.envList !== undefined) {
        return new Response(
          JSON.stringify({
            code: options.envList.code,
            message: `env list refused (${options.envList.code})`,
            nextAction: 'n/a',
            requestId: 'req-env',
            details: options.envList.details ?? {},
          }),
          { status: options.envList.status, headers: { 'content-type': 'application/json' } },
        );
      }
      response = {
        environments: environments.map((name, i) => ({
          id: `env-${i}`,
          name,
          url: 'https://app.example.com',
          isDefault: i === 0,
          authMode: 'account',
        })),
      };
    } else throw new Error(`Unexpected request: ${method} ${path}`);
    return new Response(JSON.stringify(response), {
      status: method === 'POST' ? 202 : 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const env = {
    TESTSPRITE_API_KEY: 'sk-user-test',
    TESTSPRITE_API_URL: 'http://localhost:13599',
    GITHUB_ACTIONS: 'true',
    GITHUB_OUTPUT: join(dir, 'outputs'),
    GITHUB_STEP_SUMMARY: join(dir, 'job.md'),
    // Set by the execution-report tests only; absent means "no RUNNER_TEMP".
    RUNNER_TEMP: undefined as string | undefined,
  };
  const opts: CiRunOptions = {
    profile: 'default',
    output: 'json',
    debug: false,
    projectId: 'project-1',
    timeoutSeconds: 180,
    maxConcurrency: 50,
    summaryFile: join(dir, 'summary.json'),
  };
  const deps = {
    env,
    fetchImpl,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  return {
    dir,
    opts,
    deps,
    stdout,
    stderr,
    calls,
    /** The batch dispatches only — metadata reads are not the contract under test. */
    dispatches: () => calls.filter(c => c.method === 'POST' && c.path === '/tests/batch/run'),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Harness-owned summary path under this test's mkdtemp directory; no external path input.
    summary: () => JSON.parse(readFileSync(opts.summaryFile!, 'utf8')) as CiSummary,
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Harness-owned output fixture under this test's mkdtemp directory, not the host GITHUB_OUTPUT.
    outputs: () => readFileSync(env.GITHUB_OUTPUT, 'utf8'),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Harness-owned job-summary fixture under this test's mkdtemp directory, not the host environment.
    job: () => readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'),
    json: () => JSON.parse(stdout.join('\n')) as { summary: CiSummary; accepted: unknown[] },
  };
}

// Shared by the pull-request-context and telemetry suites.
const SHA = 'a'.repeat(40);
const PREVIEW = 'https://gym-web-abc123-team.vercel.app';

function githubEnv(
  h: ReturnType<typeof harness>,
  event: string,
  payload: unknown,
  extra: Record<string, string> = {},
) {
  const eventPath = join(h.dir, 'event.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Harness-owned event fixture under this test's mkdtemp directory.
  writeFileSync(eventPath, JSON.stringify(payload));
  return {
    ...h.deps,
    env: {
      ...h.deps.env,
      GITHUB_EVENT_NAME: event,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'acme/storefront',
      ...extra,
    },
  };
}

describe('ci run', () => {
  it('dispatches all tests, waits, and publishes one consistent summary', async () => {
    const h = harness();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Seeds only the harness output file in its fresh mkdtemp directory.
    writeFileSync(h.deps.env.GITHUB_OUTPUT, 'previous=value\n');
    await runCiRun(h.opts, h.deps);
    expect(h.dispatches()[0]).toEqual({
      path: '/tests/batch/run',
      method: 'POST',
      body: { projectId: 'project-1', source: 'cli', admission: 'all' },
    });
    expect(h.calls.some(c => c.path === '/runs/run-a')).toBe(true);
    expect(h.summary()).toMatchObject({ total: 1, passed: 1, failed: 0, skipped: 0, timedOut: 0 });
    expect(h.json().summary).toEqual(h.summary());
    expect(h.outputs()).toBe(
      'previous=value\ntotal=1\npassed=1\nfailed=0\nskipped=0\ntimedOut=0\n',
    );
    expect(h.job()).toContain('[Checkout](https://portal.example.com/test)');
    expect(h.calls.every(c => c.method === 'GET' || c.path === '/tests/batch/run')).toBe(true);
  });

  it.each([false, true])('unifies all skipped buckets; strict=%s', async strict => {
    const h = harness([
      batch({
        accepted: [accepted('a')],
        deferred: [{ testId: 'later' }],
        conflicts: [{ testId: 'busy', currentRunId: 'other-deployment' }],
        skippedFrontend: ['fe'],
        skippedIntegration: [{ testId: 'integration' }],
      }),
      batch({ deferred: [{ testId: 'later' }] }),
    ]);
    const promise = runCiRun({ ...h.opts, failOnSkipped: strict }, h.deps);
    if (strict) await expect(promise).rejects.toMatchObject({ exitCode: 1 });
    else await promise;
    expect(h.summary()).toMatchObject({ total: 5, passed: 1, failed: 0, skipped: 4 });
    expect(h.json().summary).toEqual(h.summary());
    expect(h.outputs()).toContain('skipped=4\n');
    expect(h.job()).toContain('4 skipped');
    expect(h.stderr.filter(s => s.startsWith('::warning'))).toHaveLength(4);
    expect(h.stderr.filter(s => s.startsWith('::error'))).toHaveLength(0);
    expect(h.calls.some(c => c.path.includes('other-deployment'))).toBe(false);
  });

  it.each([
    ['empty project', batch()],
    ['all frontend', batch({ skippedFrontend: ['fe'] })],
    ['all integration', batch({ skippedIntegration: [{ testId: 'int' }] })],
    ['all conflicts', batch({ conflicts: [{ testId: 'busy', currentRunId: 'old-run' }] })],
    ['all deferred', batch({ deferred: [{ testId: 'later' }] })],
  ] as const)(
    '%s fails with 5 after publishing outputs, unless explicitly allowed',
    async (label, response) => {
      const h = harness([response]);
      await expect(runCiRun(h.opts, h.deps)).rejects.toMatchObject({ exitCode: 5 });
      expect(h.outputs()).toContain('passed=0\n');
      expect(h.summary().total).toBe(label === 'empty project' ? 0 : 1);
      await runCiRun({ ...h.opts, allowEmpty: true }, h.deps);
      expect(h.calls.some(c => c.path.startsWith('/runs/'))).toBe(false);
    },
  );

  it('--allow-empty does not override --fail-on-skipped', async () => {
    const h = harness([batch({ skippedFrontend: ['fe'] })]);
    await expect(
      runCiRun({ ...h.opts, allowEmpty: true, failOnSkipped: true }, h.deps),
    ).rejects.toMatchObject({ exitCode: 1 });
  });

  it.each([false, true])('missing ids always fail with 4 (allow-empty=%s)', async allowEmpty => {
    const h = harness([batch({ conflicts: [{ testId: 'gone', reason: 'not_found' }] })]);
    await expect(runCiRun({ ...h.opts, allowEmpty }, h.deps)).rejects.toMatchObject({
      exitCode: 4,
    });
    expect(h.summary()).toMatchObject({ failed: 0, skipped: 1 });
    expect(h.summary().runs[0]).toMatchObject({
      testId: 'gone',
      status: 'not_found',
      error: expect.stringContaining('not found'),
    });
    expect(h.outputs()).toContain('skipped=1');
  });

  it('missing ids also fail a partially passing batch', async () => {
    const h = harness([
      batch({ accepted: [accepted('a')], conflicts: [{ testId: 'gone', reason: 'not_found' }] }),
    ]);
    await expect(runCiRun(h.opts, h.deps)).rejects.toMatchObject({ exitCode: 4 });
    expect(h.summary()).toMatchObject({ total: 2, passed: 1, skipped: 1 });
  });

  it.each(['failed', 'blocked', 'cancelled'] as RunStatus[])(
    '%s results fail after writing every output',
    async status => {
      const h = harness(undefined, status);
      await expect(runCiRun(h.opts, h.deps)).rejects.toMatchObject({ exitCode: 1 });
      expect(h.summary()).toMatchObject({ total: 1, failed: 1, skipped: 0 });
      if (status === 'failed') expect(h.summary().runs[0]!.error).toBe('checkout failed');
      expect(h.json().summary).toEqual(h.summary());
      expect(h.outputs()).toContain('failed=1\n');
      expect(h.stderr.some(s => s.startsWith('::error'))).toBe(true);
    },
  );

  it('preserves batch environment rejections as skipped conflicts and gates zero dispatch', async () => {
    const message =
      "Field `environment` is invalid: unknown environment 'missing'; use one of: default.";
    // The list says the name exists and the server still refuses it: the
    // server-side refusal path (the client-side name check is tested below).
    const h = harness(
      [batch({ conflicts: [{ testId: 'a', reason: 'local_address', message }] })],
      'passed',
      { environments: ['default', 'missing'] },
    );
    await expect(runCiRun({ ...h.opts, environment: 'missing' }, h.deps)).rejects.toMatchObject({
      exitCode: 5,
    });
    expect(h.summary()).toMatchObject({ total: 1, passed: 0, failed: 0, skipped: 1 });
    expect(h.summary().runs[0]).toMatchObject({
      testId: 'a',
      status: 'conflict',
      error: `${message} (not dispatched)`,
    });
    expect(h.outputs()).toContain('skipped=1\n');
    expect(h.calls.filter(c => c.path.startsWith('/runs/'))).toEqual([]);
    expect(h.stderr.some(s => s.startsWith('::warning') && s.includes(message))).toBe(true);
  });

  it('passes the chosen environment on initial dispatch and every deferred retry', async () => {
    const h = harness([
      batch({ accepted: [accepted('a')], deferred: [{ testId: 'b' }] }),
      batch({ accepted: [accepted('b')] }),
    ]);
    await runCiRun({ ...h.opts, environment: 'pr-42' }, h.deps);
    const posts = h.calls.filter(c => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts.map(c => c.body?.environment)).toEqual(['pr-42', 'pr-42']);
    expect(posts[1]!.body?.testIds).toEqual(['b']);
    expect(h.summary()).toMatchObject({ total: 2, passed: 2, skipped: 0 });
  });

  it('reports timed-out accepted runs with exit 7, separately from deferred skips', async () => {
    const h = harness(
      [batch({ accepted: [accepted('a')], deferred: [{ testId: 'b' }] })],
      'running',
    );
    await expect(runCiRun({ ...h.opts, timeoutSeconds: 1 }, h.deps)).rejects.toMatchObject({
      exitCode: 7,
    });
    expect(h.summary()).toMatchObject({ total: 2, passed: 0, failed: 0, skipped: 1, timedOut: 1 });
    expect(h.outputs()).toContain('timedOut=1');
    expect(h.stderr.filter(s => s.startsWith('::error'))).toHaveLength(1);
    expect(h.stderr.filter(s => s.startsWith('::warning'))).toHaveLength(1);
  });

  it('honors the case-insensitive substring filter without counting excluded tests as skipped', async () => {
    const h = harness();
    await runCiRun({ ...h.opts, nameFilter: 'CHECK' }, h.deps);
    expect(h.calls.find(c => c.method === 'POST')?.body?.testIds).toEqual(['a']);
    expect(h.summary()).toMatchObject({ total: 1, passed: 1, skipped: 0 });
  });

  it('keeps skipped buckets returned during retries visible', async () => {
    const h = harness([
      batch({ accepted: [accepted('a')], deferred: [{ testId: 'b' }, { testId: 'c' }] }),
      batch({ skippedFrontend: ['b'], skippedIntegration: [{ testId: 'c' }] }),
    ]);
    await runCiRun(h.opts, h.deps);
    expect(h.summary()).toMatchObject({ total: 3, passed: 1, skipped: 2 });
  });

  it('retains operational poll errors and publishes their diagnostics', async () => {
    const h = harness();
    const original = h.deps.fetchImpl.getMockImplementation()!;
    h.deps.fetchImpl.mockImplementation(async (input, init) => {
      if (String(input).includes('/runs/')) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_INVALID',
              message: 'expired',
              nextAction: '',
              requestId: 'test',
              details: {},
            },
          }),
          { status: 401 },
        );
      }
      return original(input, init);
    });
    await expect(runCiRun(h.opts, h.deps)).rejects.toMatchObject({ exitCode: 3 });
    expect(h.summary().failed).toBe(1);
    expect(h.outputs()).toContain('failed=1');
  });

  it('does not turn a failed deferred dispatch into a passing CI run', async () => {
    const h = harness([batch({ accepted: [accepted('a')], deferred: [{ testId: 'b' }] })]);
    const original = h.deps.fetchImpl.getMockImplementation()!;
    let dispatches = 0;
    h.deps.fetchImpl.mockImplementation(async (input, init) => {
      if (init?.method === 'POST' && ++dispatches > 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_INVALID',
              message: 'expired',
              nextAction: '',
              requestId: 'test',
              details: {},
            },
          }),
          { status: 401 },
        );
      }
      return original(input, init);
    });
    await expect(runCiRun(h.opts, h.deps)).rejects.toMatchObject({ exitCode: 3 });
    expect(h.summary()).toMatchObject({ passed: 1, skipped: 1 });
    expect(h.outputs()).toContain('passed=1');
  });

  it('preserves auth errors when a slow retry leaves only the final bounded poll', async () => {
    const h = harness([
      batch({ accepted: [accepted('a')], deferred: [{ testId: 'b' }] }),
      batch({ accepted: [accepted('b')] }),
    ]);
    const original = h.deps.fetchImpl.getMockImplementation()!;
    let dispatches = 0;
    h.deps.fetchImpl.mockImplementation(async (input, init) => {
      if (init?.method === 'POST' && ++dispatches > 1) await h.deps.sleep(200_000);
      if (String(input).includes('/runs/')) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_INVALID',
              message: 'expired',
              nextAction: '',
              requestId: 'test',
              details: {},
            },
          }),
          { status: 401 },
        );
      }
      return original(input, init);
    });
    await expect(runCiRun(h.opts, h.deps)).rejects.toMatchObject({ exitCode: 3 });
    expect(h.summary()).toMatchObject({ failed: 2, timedOut: 0 });
  });

  it('an unmatched filter emits an empty summary without dispatching', async () => {
    const h = harness();
    await expect(
      runCiRun({ ...h.opts, nameFilter: 'does-not-exist' }, h.deps),
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(0);
    expect(h.summary()).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      timedOut: 0,
      runs: [],
    });
  });

  it('continues after artifact write failures without hiding a test failure', async () => {
    const h = harness(undefined, 'failed');
    h.deps.env.GITHUB_OUTPUT = h.dir;
    h.deps.env.GITHUB_STEP_SUMMARY = h.dir;
    await expect(runCiRun({ ...h.opts, summaryFile: h.dir }, h.deps)).rejects.toMatchObject({
      exitCode: 1,
    });
    expect(h.stderr.filter(s => s.includes('could not'))).toHaveLength(3);
    expect(h.json().summary.failed).toBe(1);
  });

  it('writes step outputs even outside Actions without other artifacts enabled', async () => {
    const h = harness();
    h.deps.env.GITHUB_ACTIONS = 'false';
    await runCiRun({ ...h.opts, summaryFile: undefined }, h.deps);
    expect(h.outputs()).toContain('passed=1');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Checks absence of the harness job-summary fixture under its own mkdtemp directory.
    expect(existsSync(h.deps.env.GITHUB_STEP_SUMMARY)).toBe(false);
  });

  it('writes opt-in JUnit before a failing gate', async () => {
    const h = harness(undefined, 'failed');
    const reportFile = join(h.dir, 'junit.xml');
    await expect(
      runCiRun({ ...h.opts, report: 'junit', reportFile }, h.deps),
    ).rejects.toMatchObject({ exitCode: 1 });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reportFile is the fixed junit.xml basename joined to this test's mkdtemp directory.
    expect(readFileSync(reportFile, 'utf8')).toContain('<testcase');
    expect(h.summary().failed).toBe(1);
  });

  it('an unwritable JUnit file cannot mask a failed gate or suppress summaries', async () => {
    const h = harness(undefined, 'failed');
    await expect(
      runCiRun({ ...h.opts, report: 'junit', reportFile: h.dir }, h.deps),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(h.summary().failed).toBe(1);
    expect(h.outputs()).toContain('failed=1');
  });

  it('dry-run neither dispatches nor writes artifacts, even with JUnit requested', async () => {
    const h = harness();
    const reportFile = join(h.dir, 'junit.xml');
    await runCiRun({ ...h.opts, dryRun: true, report: 'junit', reportFile }, h.deps);
    // A credentialed dry run may read environment metadata; it never dispatches.
    expect(h.dispatches()).toEqual([]);
    expect(h.calls.every(c => c.method === 'GET')).toBe(true);
    expect(JSON.parse(h.stdout.join('\n'))).toMatchObject({
      dryRun: true,
      body: { projectId: 'project-1' },
      thenPoll: '/api/cli/v1/runs/<run-id>?waitSeconds=25',
    });
    for (const path of [
      reportFile,
      h.opts.summaryFile!,
      h.deps.env.GITHUB_OUTPUT,
      h.deps.env.GITHUB_STEP_SUMMARY,
    ])
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- All four paths are harness-created artifact paths under the same fresh mkdtemp directory.
      expect(existsSync(path)).toBe(false);
  });

  it('requires a project before making any requests', async () => {
    const h = harness();
    await expect(runCiRun({ ...h.opts, projectId: undefined }, h.deps)).rejects.toMatchObject({
      exitCode: 5,
    });
    expect(h.deps.fetchImpl).not.toHaveBeenCalled();
  });

  it('an explicit project wins over TESTSPRITE_PROJECT_ID', async () => {
    const h = harness();
    await runCiRun(h.opts, { ...h.deps, env: { ...h.deps.env, TESTSPRITE_PROJECT_ID: 'other' } });
    expect(h.dispatches()[0]!.body?.projectId).toBe('project-1');
  });

  it.each([
    { timeoutSeconds: 0 },
    { timeoutSeconds: 3601 },
    { timeoutSeconds: Number.NaN },
    { maxConcurrency: 0 },
    { maxConcurrency: 101 },
    { maxConcurrency: 1.5 },
    { environment: '   ' },
    { reportFile: 'results.xml' },
  ])('rejects invalid options before dispatch: %j', async invalid => {
    const h = harness();
    await expect(runCiRun({ ...h.opts, ...invalid }, h.deps)).rejects.toMatchObject({
      exitCode: 5,
    });
    expect(h.deps.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([['unexpected'], [' --env', 'pr-415']])(
    'rejects extra positional arguments before dispatch: %j',
    async (...extra) => {
      const h = harness();
      const ci = createCiCommand(h.deps);
      ci.commands
        .find(command => command.name() === 'run')!
        .exitOverride()
        .configureOutput({ writeErr: () => {} });
      const program = new Command().addCommand(ci);
      await expect(
        program.parseAsync(['node', 'testsprite', 'ci', 'run', '--project', 'project-1', ...extra]),
      ).rejects.toMatchObject({ code: 'commander.excessArguments' });
      expect(h.deps.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('wires Commander options, globals, project env default, and implicit wait', async () => {
    const h = harness();
    const program = new Command().option('--output <mode>').addCommand(
      createCiCommand({
        ...h.deps,
        env: { ...h.deps.env, TESTSPRITE_PROJECT_ID: 'env-project' },
      }),
    );
    await program.parseAsync([
      'node',
      'testsprite',
      '--output',
      'json',
      'ci',
      'run',
      '--all',
      '--env',
      'pr-42',
      '--summary-file',
      h.opts.summaryFile!,
    ]);
    expect(h.dispatches()[0]!.body).toEqual({
      projectId: 'env-project',
      source: 'cli',
      environment: 'pr-42',
      admission: 'all',
    });
    expect(h.summary().passed).toBe(1);
    expect(h.json().summary).toEqual(h.summary());
  });
});

describe('ci run — pull request context and single-execution admission', () => {
  it('in a pull_request job, --env + --target-url runs in github-pr-<N>, stamped with the PR', async () => {
    const h = harness();
    const deps = githubEnv(h, 'pull_request', {
      pull_request: { number: 42, draft: false, head: { sha: SHA, ref: 'feat/x' } },
    });
    await runCiRun(
      { ...h.opts, environment: 'staging', targetUrl: PREVIEW, skipPreflight: true },
      deps,
    );
    expect(h.dispatches()[0]!.body).toEqual({
      projectId: 'project-1',
      source: 'cli',
      environment: 'staging',
      targetUrl: PREVIEW,
      admission: 'all',
      previewName: 'github-pr-42',
      githubTrigger: {
        repoOwner: 'acme',
        repoName: 'storefront',
        prNumber: 42,
        branchName: 'feat/x',
        commitSha: SHA,
      },
    });
    expect(h.summary()).toMatchObject({ total: 1, passed: 1 });
  });

  it('without --env the run is still stamped with the PR but asks for no preview environment', async () => {
    const h = harness();
    const deps = githubEnv(h, 'pull_request', { pull_request: { number: 42, head: { sha: SHA } } });
    await runCiRun({ ...h.opts, targetUrl: PREVIEW, skipPreflight: true }, deps);
    const body = h.dispatches()[0]!.body!;
    expect(body.previewName).toBeUndefined();
    expect(body.githubTrigger).toMatchObject({ prNumber: 42 });
    expect(body.admission).toBe('all');
  });

  it('skips a draft pull request with a notice and dispatches nothing', async () => {
    const h = harness();
    const deps = githubEnv(h, 'pull_request', {
      pull_request: { number: 7, draft: true, head: { sha: SHA } },
    });
    await runCiRun({ ...h.opts, environment: 'staging', targetUrl: PREVIEW }, deps);
    expect(h.dispatches()).toEqual([]);
    expect(h.stderr.some(s => s.startsWith('::notice') && s.includes('draft'))).toBe(true);
    // A later step reading `steps.<id>.outputs.passed` sees a number, not ''.
    expect(h.outputs()).toBe('total=0\npassed=0\nfailed=0\nskipped=0\ntimedOut=0\n');
    // Nothing ran, so nothing else describes a run.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Harness-owned summary path under this test's mkdtemp directory; no external path input.
    expect(existsSync(h.opts.summaryFile!)).toBe(false);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Harness-owned job-summary fixture under this test's mkdtemp directory, not the host environment.
    expect(existsSync(h.deps.env.GITHUB_STEP_SUMMARY)).toBe(false);
  });

  it('deployment_status: finds the PR by commit with GITHUB_TOKEN; none → notice, nothing to gate', async () => {
    const found = harness(undefined, 'passed', {
      pulls: [{ number: 7, state: 'open', draft: false, head: { sha: SHA, ref: 'feat/y' } }],
    });
    await runCiRun(
      { ...found.opts, environment: 'staging', targetUrl: PREVIEW, skipPreflight: true },
      githubEnv(
        found,
        'deployment_status',
        { deployment: { sha: SHA, ref: 'feat/y' } },
        {
          GITHUB_TOKEN: 'ghs_x',
        },
      ),
    );
    expect(
      found.calls.some(c => c.path === `github:/repos/acme/storefront/commits/${SHA}/pulls`),
    ).toBe(true);
    expect(found.dispatches()[0]!.body).toMatchObject({
      previewName: 'github-pr-7',
      githubTrigger: { prNumber: 7, commitSha: SHA, branchName: 'feat/y' },
    });

    const none = harness(undefined, 'passed', { pulls: [] });
    await runCiRun(
      { ...none.opts, environment: 'staging', targetUrl: PREVIEW },
      githubEnv(none, 'deployment_status', { deployment: { sha: SHA } }, { GITHUB_TOKEN: 'ghs_x' }),
    );
    expect(none.dispatches()).toEqual([]);
    expect(none.stderr.some(s => s.startsWith('::notice') && s.includes('nothing to gate'))).toBe(
      true,
    );
    expect(none.outputs()).toBe('total=0\npassed=0\nfailed=0\nskipped=0\ntimedOut=0\n');
  });

  it('a backend that does not echo the admission mode is refused with exit 7, after publishing', async () => {
    const h = harness(undefined, 'passed', { echo: false });
    await expect(runCiRun(h.opts, h.deps)).rejects.toMatchObject({
      exitCode: 7,
      details: { field: 'admission', reason: 'admission-not-honored' },
    });
    expect(h.summary().runs[0]).toMatchObject({ status: 'error' });
    expect(h.outputs()).toContain('failed=1\n');
  });

  it('an unknown --env is refused before anything dispatches, even with --allow-empty', async () => {
    const h = harness();
    await expect(
      runCiRun({ ...h.opts, environment: 'stagng', allowEmpty: true }, h.deps),
    ).rejects.toMatchObject({
      exitCode: 5,
      details: expect.objectContaining({
        field: 'env',
        reason: expect.stringContaining('available: default, pr-42, staging'),
      }),
    });
    expect(h.dispatches()).toEqual([]);
  });

  it('an environment list that cannot be read fails closed with that error, before any dispatch', async () => {
    // A bad key is the key's error, not a run that goes on to charge.
    const unauth = harness(undefined, 'passed', {
      envList: { status: 401, code: 'AUTH_INVALID' },
    });
    await expect(
      runCiRun({ ...unauth.opts, environment: 'staging' }, unauth.deps),
    ).rejects.toMatchObject({ exitCode: 3, code: 'AUTH_INVALID' });
    expect(unauth.dispatches()).toEqual([]);

    // A backend that is down is exit 10, after the client's own bounded retries.
    const down = harness(undefined, 'passed', {
      envList: { status: 503, code: 'UNAVAILABLE' },
    });
    await expect(
      runCiRun({ ...down.opts, environment: 'staging' }, down.deps),
    ).rejects.toMatchObject({ exitCode: 10, code: 'UNAVAILABLE' });
    expect(down.dispatches()).toEqual([]);
  });

  it('a backend with no environment surface for the project leaves --env to the batch', async () => {
    // A V2 project: the facade answers UNSUPPORTED — there is no list to
    // check against, so the batch's own validation is the only authority.
    const v2 = harness(undefined, 'passed', {
      envList: {
        status: 501,
        code: 'UNSUPPORTED',
        details: { field: 'projectId', reason: 'environments-unsupported-on-v2' },
      },
    });
    await runCiRun({ ...v2.opts, environment: 'staging' }, v2.deps);
    expect(v2.dispatches()[0]!.body).toMatchObject({ environment: 'staging' });
    expect(v2.summary()).toMatchObject({ total: 1, passed: 1 });

    // An older backend without the route at all answers 404 for it.
    const old = harness(undefined, 'passed', { envList: { status: 404, code: 'NOT_FOUND' } });
    await runCiRun({ ...old.opts, environment: 'staging' }, old.deps);
    expect(old.dispatches()[0]!.body).toMatchObject({ environment: 'staging' });
  });

  it('an interrupt during the environment read propagates as the signal, dispatching nothing', async () => {
    const h = harness(undefined, 'passed', { envList: 'interrupt' });
    await expect(runCiRun({ ...h.opts, environment: 'staging' }, h.deps)).rejects.toMatchObject({
      exitCode: 143,
      code: 'INTERRUPTED',
    });
    expect(h.dispatches()).toEqual([]);
  });

  it('a batch the backend refused is not "empty": --allow-empty still exits 5', async () => {
    const message = 'Field `environment` is invalid: unknown environment.';
    const h = harness(
      [batch({ conflicts: [{ testId: 'a', reason: 'error', message }] })],
      'passed',
      {
        environments: ['default', 'nope'],
      },
    );
    await expect(
      runCiRun({ ...h.opts, environment: 'nope', allowEmpty: true }, h.deps),
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(h.summary()).toMatchObject({ total: 1, skipped: 1 });
    expect(h.outputs()).toContain('skipped=1\n');
  });

  it('refuses an empty --target-url before any request', async () => {
    const h = harness();
    await expect(runCiRun({ ...h.opts, targetUrl: '   ' }, h.deps)).rejects.toMatchObject({
      exitCode: 5,
    });
    expect(h.deps.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a preview behind Vercel Deployment Protection before dispatching', async () => {
    const h = harness();
    // A literal IP skips the probe's DNS step. The redirect is what a
    // protected preview answers a visitor with no Vercel session.
    const protectedPreview = 'http://203.0.113.10';
    const original = h.deps.fetchImpl.getMockImplementation()!;
    h.deps.fetchImpl.mockImplementation(async (input, init) => {
      if (String(input) === protectedPreview) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://vercel.com/sso-api?url=preview&nonce=1' },
        });
      }
      return original(input, init);
    });
    await expect(
      runCiRun({ ...h.opts, targetUrl: protectedPreview }, h.deps),
    ).rejects.toMatchObject({ exitCode: 5, details: { reason: 'target-protected' } });
    expect(h.dispatches()).toEqual([]);
  });

  it('wires --target-url and --skip-preflight through Commander', async () => {
    const h = harness();
    const program = new Command().addCommand(createCiCommand(h.deps));
    await program.parseAsync([
      'node',
      'testsprite',
      'ci',
      'run',
      '--project',
      'project-1',
      '--env',
      'staging',
      '--target-url',
      PREVIEW,
      '--skip-preflight',
      '--summary-file',
      h.opts.summaryFile!,
    ]);
    expect(h.dispatches()[0]!.body).toMatchObject({
      environment: 'staging',
      targetUrl: PREVIEW,
      admission: 'all',
    });
  });
});

describe('ci run — execution report (the GitHub App comment content)', () => {
  it('fills the job summary with the server markdown and hands the report to later steps', async () => {
    const h = harness([batch({ accepted: [accepted('a', 'exec-1')] })], 'passed', {
      report: () => executionReport('exec-1'),
    });
    h.deps.env = { ...h.deps.env, RUNNER_TEMP: h.dir };
    await runCiRun(h.opts, h.deps);
    // The job summary IS the App's markdown, not the local table.
    expect(h.job()).toBe(executionReport('exec-1').markdown);
    expect(h.job()).not.toContain('TestSprite results');
    // The structured report rides the summary into --summary-file and --output json alike.
    expect(h.summary().executionReport).toMatchObject({ executionId: 'exec-1', allPassed: true });
    expect(h.json().summary).toEqual(h.summary());
    // Step outputs: the five counters first, then the two report files.
    const outputs = h.outputs();
    expect(outputs).toContain('total=1\npassed=1\nfailed=0\nskipped=0\ntimedOut=0\n');
    const jsonPath = /^execution-report-file=(.+)$/m.exec(outputs)?.[1];
    const mdPath = /^execution-report-markdown-file=(.+)$/m.exec(outputs)?.[1];
    expect(jsonPath).toBe(join(h.dir, 'testsprite-execution-report-exec-1.json'));
    expect(mdPath).toBe(join(h.dir, 'testsprite-execution-report-exec-1.md'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Harness-owned files under this test's mkdtemp RUNNER_TEMP.
    expect(JSON.parse(readFileSync(jsonPath!, 'utf8'))).toEqual(executionReport('exec-1').report);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Harness-owned files under this test's mkdtemp RUNNER_TEMP.
    expect(readFileSync(mdPath!, 'utf8')).toBe(executionReport('exec-1').markdown);
    expect(h.calls.filter(c => c.path === '/tests/executions/exec-1/report')).toHaveLength(1);
  });

  it('polls while the report is being built, honoring retryAfterSeconds', async () => {
    const h = harness([batch({ accepted: [accepted('a', 'exec-1')] })], 'passed', {
      report: n => (n < 2 ? { ready: false, retryAfterSeconds: 2 } : executionReport('exec-1')),
    });
    await runCiRun(h.opts, h.deps);
    expect(h.calls.filter(c => c.path === '/tests/executions/exec-1/report')).toHaveLength(3);
    expect(h.job()).toBe(executionReport('exec-1').markdown);
  });

  it('falls back to the local table when the report is not ready within --execution-report-timeout', async () => {
    const h = harness([batch({ accepted: [accepted('a', 'exec-1')] })], 'passed', {
      report: () => ({ ready: false, retryAfterSeconds: 5 }),
    });
    await runCiRun({ ...h.opts, executionReportTimeoutSeconds: 12 }, h.deps);
    // 12s budget, 5s between polls: polls at 0, 5, 10 — then the budget is gone.
    expect(h.calls.filter(c => c.path === '/tests/executions/exec-1/report')).toHaveLength(3);
    expect(h.job()).toContain('[Checkout](https://portal.example.com/test)');
    expect(h.summary().executionReport).toBeUndefined();
    expect(h.outputs()).not.toContain('execution-report-file=');
    expect(h.stderr.some(s => s.includes('execution report not ready within 12s'))).toBe(true);
  });

  it('an older backend (404 on the report) keeps the local table and the exit code', async () => {
    const h = harness([batch({ accepted: [accepted('a', 'exec-1')] })], 'passed', {
      report: () =>
        new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Cannot GET' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await runCiRun(h.opts, h.deps);
    expect(h.job()).toContain('TestSprite results');
    expect(h.summary().executionReport).toBeUndefined();
    expect(h.stderr.some(s => s.includes('execution report unavailable'))).toBe(true);
  });

  it('a report failure never hides a failing gate', async () => {
    const h = harness([batch({ accepted: [accepted('a', 'exec-1')] })], 'failed', {
      report: () => {
        throw new Error('boom');
      },
    });
    await expect(runCiRun(h.opts, h.deps)).rejects.toMatchObject({ exitCode: 1 });
    expect(h.json().summary.failed).toBe(1);
  });

  it('reads no report when the batch names no execution (older backend) or several', async () => {
    const none = harness([batch({ accepted: [accepted('a')] })]);
    await runCiRun(none.opts, none.deps);
    expect(none.calls.some(c => c.path.includes('/report'))).toBe(false);

    const several = harness([
      batch({ accepted: [accepted('a', 'exec-1'), accepted('b', 'exec-2')] }),
    ]);
    await runCiRun(several.opts, several.deps);
    expect(several.calls.some(c => c.path.includes('/report'))).toBe(false);
    expect(several.job()).toContain('TestSprite results');
  });

  it('a verdict the report does not carry is stated above it and its rows appended', async () => {
    // The run failed in the CLI's own poll, but the server's report (built
    // from the execution) says all passed — a red check must not get a green
    // summary.
    const h = harness([batch({ accepted: [accepted('a', 'exec-1')] })], 'failed', {
      report: () => executionReport('exec-1'),
    });
    await expect(runCiRun(h.opts, h.deps)).rejects.toMatchObject({ exitCode: 1 });
    const job = h.job();
    expect(
      job.startsWith(
        '> [!WARNING]\n> **CI gate: 0 of 1 passed, 1 failed, 0 skipped, 0 timed out.**',
      ),
    ).toBe(true);
    expect(job).toContain(executionReport('exec-1').markdown.trim());
    // run-a IS in the report (as PASSED), so no appendix row for it — the banner alone flags the disagreement.
    expect(job).not.toContain('### Not reflected in the execution report');
  });

  it('rows the report cannot contain (a run the CLI could not read) are appended under the report', async () => {
    const h = harness(
      [batch({ accepted: [accepted('a', 'exec-1'), accepted('b', 'exec-1')] })],
      'passed',
      {
        report: () => ({
          ...executionReport('exec-1'),
          report: {
            ...executionReport('exec-1').report,
            stats: { passed: 2, failed: 0, blocked: 0, total: 2 },
          },
        }),
        runRead: (runId: string) =>
          runId === 'run-b'
            ? new Response(JSON.stringify({ error: { code: 'INTERNAL', message: 'db down' } }), {
                status: 500,
                headers: { 'content-type': 'application/json' },
              })
            : undefined,
      },
    );
    await expect(runCiRun({ ...h.opts, timeoutSeconds: 30 }, h.deps)).rejects.toMatchObject({
      exitCode: expect.any(Number),
    });
    const job = h.job();
    expect(job.startsWith('> [!WARNING]')).toBe(true);
    expect(job).toContain('### Not reflected in the execution report');
    expect(job).toMatch(/\| b \| error \| db down \| run-b \|/);
  });

  it('a run that timed out means the execution is not finished: no report is read', async () => {
    const h = harness([batch({ accepted: [accepted('a', 'exec-1')] })], 'running', {
      report: () => executionReport('exec-1'),
    });
    await expect(runCiRun({ ...h.opts, timeoutSeconds: 2 }, h.deps)).rejects.toMatchObject({
      exitCode: 7,
    });
    expect(h.calls.some(c => c.path.includes('/report'))).toBe(false);
    expect(h.stderr.some(s => s.includes('a run timed out'))).toBe(true);
    expect(h.outputs()).toContain('timedOut=1\n');
  });

  it('an interrupt during the report request falls back — the finished batch still gets its summary and outputs, then the signal exits', async () => {
    const h = harness([batch({ accepted: [accepted('a', 'exec-1')] })], 'passed', {
      report: () => {
        throw new InterruptError('SIGINT');
      },
    });
    // The signal's exit code wins over the gate's 0, but only after the
    // summary and outputs are written.
    await expect(runCiRun(h.opts, h.deps)).rejects.toBeInstanceOf(InterruptError);
    expect(
      h.stderr.some(s => s.includes('interrupted while waiting for the execution report')),
    ).toBe(true);
    expect(h.job()).toContain('TestSprite results');
    expect(h.outputs()).toContain('passed=1\n');
  });

  it('an interrupt during the retry sleep is graceful: the scope is armed, the summary and outputs land, then the signal exits', async () => {
    // Every run poll has disarmed by the time the report is read, so without
    // an armed scope the signal handler's disarmed path would exit at once.
    const shutdown = new ShutdownController();
    const armedDuringSleep: boolean[] = [];
    const h = harness([batch({ accepted: [accepted('a', 'exec-1')] })], 'passed', {
      report: () => ({ ready: false, retryAfterSeconds: 2 }),
    });
    const deps = {
      ...h.deps,
      shutdown,
      sleep: async (ms: number) => {
        armedDuringSleep.push(shutdown.isArmed);
        shutdown.interrupt('SIGTERM');
        await h.deps.sleep(ms);
      },
    };
    await expect(runCiRun(h.opts, deps)).rejects.toMatchObject({ signal: 'SIGTERM' });
    expect(armedDuringSleep).toEqual([true]);
    expect(h.calls.filter(c => c.path.includes('/report'))).toHaveLength(1);
    expect(
      h.stderr.some(s => s.includes('interrupted while waiting for the execution report')),
    ).toBe(true);
    expect(h.job()).toContain('TestSprite results');
    expect(h.outputs()).toContain('passed=1\n');
    expect(shutdown.isArmed).toBe(false);
  });

  it('a red run whose failure the report also shows is byte for byte the App comment', async () => {
    const red = executionReport('exec-1');
    red.report.stats = { passed: 0, failed: 1, blocked: 0, total: 1 };
    red.report.allPassed = false;
    red.report.tests[0]!.status = 'FAILED';
    red.markdown = '> [!CAUTION]\n> ### 1 of 1 failed\n';
    const h = harness([batch({ accepted: [accepted('a', 'exec-1')] })], 'failed', {
      report: () => red,
    });
    await expect(runCiRun(h.opts, h.deps)).rejects.toMatchObject({ exitCode: 1 });
    expect(h.job()).toBe(red.markdown);
  });

  it('a batch whose rows do not all name the same execution reads no report (a partial report would read as the whole batch)', async () => {
    const mixed = harness(
      [batch({ accepted: [accepted('a', 'exec-1'), accepted('b')] })],
      'passed',
      {
        report: () => executionReport('exec-1'),
      },
    );
    await runCiRun(mixed.opts, mixed.deps);
    expect(mixed.calls.some(c => c.path.includes('/report'))).toBe(false);
    expect(mixed.job()).toContain('TestSprite results');
  });

  it("a report for another execution is not this batch's", async () => {
    const h = harness([batch({ accepted: [accepted('a', 'exec-1')] })], 'passed', {
      report: () => executionReport('exec-2'),
    });
    await runCiRun(h.opts, h.deps);
    expect(h.stderr.some(s => s.includes('names execution exec-2, not exec-1'))).toBe(true);
    expect(h.job()).toContain('TestSprite results');
    expect(h.summary().executionReport).toBeUndefined();
  });

  it('--no-execution-report: nothing is read, the job summary is the local table', async () => {
    const h = harness([batch({ accepted: [accepted('a', 'exec-1')] })], 'passed', {
      report: () => executionReport('exec-1'),
    });
    await runCiRun({ ...h.opts, executionReport: false }, h.deps);
    expect(h.calls.some(c => c.path.includes('/report'))).toBe(false);
    expect(h.job()).toContain('TestSprite results');
    expect(h.outputs()).not.toContain('execution-report-file=');
  });

  it('the report files are written owner-only (0600)', async () => {
    const h = harness([batch({ accepted: [accepted('a', 'exec-1')] })], 'passed', {
      report: () => executionReport('exec-1'),
    });
    h.deps.env = { ...h.deps.env, RUNNER_TEMP: h.dir };
    await runCiRun(h.opts, h.deps);
    const mdPath = /^execution-report-markdown-file=(.+)$/m.exec(h.outputs())?.[1];
    if (process.platform !== 'win32') {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Harness-owned file under this test's mkdtemp RUNNER_TEMP.
      expect(statSync(mdPath!).mode & 0o777).toBe(0o600);
    }
  });

  it('commander: --no-execution-report reaches the run as executionReport: false', async () => {
    const h = harness([batch({ accepted: [accepted('a', 'exec-1')] })], 'passed', {
      report: () => executionReport('exec-1'),
    });
    const program = new Command().addCommand(createCiCommand(h.deps));
    await program.parseAsync([
      'node',
      'testsprite',
      'ci',
      'run',
      '--project',
      'project-1',
      '--no-execution-report',
      '--summary-file',
      h.opts.summaryFile!,
    ]);
    expect(h.calls.some(c => c.path.includes('/report'))).toBe(false);
  });

  it('commander: --execution-report-timeout is validated like --timeout', async () => {
    const h = harness();
    const program = new Command().addCommand(createCiCommand(h.deps));
    await expect(
      program.parseAsync([
        'node',
        'testsprite',
        'ci',
        'run',
        '--project',
        'project-1',
        '--execution-report-timeout',
        '0',
      ]),
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(h.dispatches()).toHaveLength(0);
  });
});

// ── telemetry facts ──────────────────────────────────────────────────────────

describe('ci run telemetry facts', () => {
  const EXECUTION = '7ceab81a-a20a-4141-aa89-f6886bdbb11c';
  beforeEach(() => {
    takeTelemetryExtras();
  });
  afterEach(() => {
    takeTelemetryExtras();
  });

  it('a gated run names its outcome, the execution (a UUID) and that the report arrived', async () => {
    const h = harness([batch({ accepted: [accepted('a', EXECUTION)] })], 'passed', {
      report: () => executionReport(EXECUTION),
    });
    await runCiRun(h.opts, h.deps);
    expect(takeTelemetryExtras()).toMatchObject({
      ciRunOutcome: 'gated',
      executionId: EXECUTION,
      reportReady: true,
      accepted: 1,
      passed: 1,
    });
  });

  it('a gated run on a backend without the report route: reportReady:false, and a non-UUID id is dropped', async () => {
    const h = harness([batch({ accepted: [accepted('a', 'exec-1')] })], 'passed');
    await runCiRun(h.opts, h.deps);
    const facts = takeTelemetryExtras();
    expect(facts).toMatchObject({ ciRunOutcome: 'gated', reportReady: false });
    expect(facts.executionId).toBeUndefined();
  });

  it('a red gate is still `gated` — the exit code is the verdict, the outcome says the gate ran', async () => {
    const h = harness([batch({ accepted: [accepted('a', EXECUTION)] })], 'failed');
    await expect(runCiRun(h.opts, h.deps)).rejects.toMatchObject({ exitCode: 1 });
    expect(takeTelemetryExtras()).toMatchObject({ ciRunOutcome: 'gated', executionId: EXECUTION });
  });

  it('a draft pull request is skipped_draft; a deployment with no pull request is skipped_no_pr', async () => {
    const draft = harness();
    await runCiRun(
      { ...draft.opts, environment: 'staging', targetUrl: PREVIEW },
      githubEnv(draft, 'pull_request', {
        pull_request: { number: 7, draft: true, head: { sha: SHA } },
      }),
    );
    expect(takeTelemetryExtras()).toEqual({ ciRunOutcome: 'skipped_draft' });

    const none = harness(undefined, 'passed', { pulls: [] });
    await runCiRun(
      { ...none.opts, environment: 'staging', targetUrl: PREVIEW },
      githubEnv(none, 'deployment_status', { deployment: { sha: SHA } }, { GITHUB_TOKEN: 'ghs_x' }),
    );
    expect(takeTelemetryExtras()).toEqual({ ciRunOutcome: 'skipped_no_pr' });
  });

  it('an unknown --env is refused_env; a backend without the CI contract is refused_admission', async () => {
    const env = harness();
    await expect(runCiRun({ ...env.opts, environment: 'stagng' }, env.deps)).rejects.toMatchObject({
      exitCode: 5,
    });
    expect(takeTelemetryExtras()).toEqual({ ciRunOutcome: 'refused_env' });

    const old = harness(undefined, 'passed', { echo: false });
    await expect(runCiRun(old.opts, old.deps)).rejects.toMatchObject({ exitCode: 7 });
    expect(takeTelemetryExtras()).toMatchObject({ ciRunOutcome: 'refused_admission' });
  });

  it.each([
    [400, 'VALIDATION_ERROR', { reason: 'preview-name-taken' }, 'refused_preview_name'],
    [400, 'VALIDATION_ERROR', { reason: 'private-or-local' }, 'refused_loopback'],
    [400, 'VALIDATION_ERROR', { reason: 'frontend-auth-target-origin-mismatch' }, 'refused_other'],
    [402, 'INSUFFICIENT_CREDITS', {}, 'refused_billing'],
    [403, 'FEATURE_GATED', {}, 'refused_billing'],
    [429, 'RATE_LIMITED', {}, 'refused_other'],
    [401, 'AUTH_ERROR', {}, 'refused_other'],
  ] as const)('a whole-batch refusal %i %s %j is %s', async (status, code, details, outcome) => {
    const h = harness(undefined, 'passed', { batchRefusal: { status, code, details } });
    // (a 401's code is normalised by the client; the outcome is what matters here)
    await expect(runCiRun(h.opts, h.deps)).rejects.toMatchObject({ httpStatus: status });
    expect(takeTelemetryExtras()).toEqual({ ciRunOutcome: outcome });
  });

  it('a refusal at the environment pre-check gets the same mapping (402 → refused_billing)', async () => {
    const h = harness(undefined, 'passed', {
      envList: { status: 402, code: 'INSUFFICIENT_CREDITS' },
    });
    await expect(runCiRun({ ...h.opts, environment: 'staging' }, h.deps)).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
    });
    expect(takeTelemetryExtras()).toEqual({ ciRunOutcome: 'refused_billing' });
  });

  it('a gate cancelled mid-wait keeps `gated` and its execution id on the abort event', async () => {
    // Recorded right after the dispatch is confirmed, so a re-push cancel, a
    // manual cancel or the runner timeout still reports which execution keeps
    // running. No reportReady: the wait never finished.
    const shutdown = new ShutdownController();
    const h = harness([batch({ accepted: [accepted('a', EXECUTION)] })], 'passed', {
      // The signal lands while the first poll is in flight (the long-poll has
      // no sleep to hook), so the wait is interrupted, not timed out.
      runRead: runId => {
        shutdown.interrupt('SIGTERM');
        return new Response(JSON.stringify(runResult(runId, 'running')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const deps = { ...h.deps, shutdown };
    await expect(runCiRun(h.opts, deps)).rejects.toBeInstanceOf(InterruptError);
    const facts = takeTelemetryExtras();
    expect(facts).toMatchObject({ ciRunOutcome: 'gated', executionId: EXECUTION });
    expect(facts.reportReady).toBeUndefined();
  });

  it('a batch that selected nothing is `empty`, green or not', async () => {
    const red = harness([batch()]);
    await expect(runCiRun(red.opts, red.deps)).rejects.toMatchObject({ exitCode: 5 });
    expect(takeTelemetryExtras()).toMatchObject({ ciRunOutcome: 'empty' });

    const green = harness([batch()]);
    await runCiRun({ ...green.opts, allowEmpty: true }, green.deps);
    expect(takeTelemetryExtras()).toMatchObject({ ciRunOutcome: 'empty' });
  });
});
