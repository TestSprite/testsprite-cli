/**
 * Subprocess test that builds the CLI binary and runs it as a real child
 * process against an in-memory HTTP server. Catches packaging / ESM /
 * shebang issues that unit tests cannot see.
 *
 * Per design.md §12.4 hard gate: a subprocess test that builds the binary
 * and runs `auth status` against the mock.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertFreshBuild } from './helpers/assertFreshBuild.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

const ME_BODY = {
  userId: 'u-subproc',
  keyId: 'k-subproc',
  scopes: ['read:projects', 'read:tests'],
  env: 'development',
};

let server: Server;
let baseUrl: string;
let tmpHome: string;
let requestCount = 0;
const businessRequests: Array<{ method: string; url: string }> = [];
const launchBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
const executionReads = new Map<string, number>();

function readFixtureBody(
  req: IncomingMessage,
  onBody: (body: Record<string, unknown>) => void,
): void {
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', () => onBody(JSON.parse(body) as Record<string, unknown>));
}

function fixtureResult(runId: string, testId: string) {
  return {
    resultId: `result_${testId}`,
    runId,
    caseKey: testId,
    title: testId,
    testStatus: 'PASSED',
    processStatus: 'FINISHED',
    error: null,
    blockedReason: null,
    environmentName: 'staging',
    created: '2026-11-16T00:00:00.000Z',
  };
}

beforeAll(async () => {
  // The build now happens exactly once in `test/global-setup.ts`, before any
  // test file runs — no per-file rebuild here, so this suite can
  // never race a concurrent rebuild for access to `dist/`. Fail fast (missing
  // OR stale relative to src/, e.g. watch-mode reruns) instead of silently
  // spawning a binary that isn't the code under test.
  assertFreshBuild(REPO_ROOT, BIN_PATH);
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCount++;
    const url = req.url ?? '/';
    businessRequests.push({ method: req.method ?? 'GET', url });
    if (req.method === 'POST' && url === '/api/cli/v1/projects/project_subproc/runs') {
      readFixtureBody(req, body => {
        launchBodies.push({ url, body });
        executionReads.set('run_project_launch_subproc', 0);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            runId: 'run_project_launch_subproc',
            projectId: 'project_subproc',
            total: 2,
            enqueuedAt: '2026-11-16T00:00:00.000Z',
            autoHeal: true,
            environment: { id: 'env_subproc', name: 'staging' },
            targetUrl: 'https://example.com',
            blocked: [],
            held: [],
          }),
        );
      });
      return;
    }
    if (url === '/api/cli/v1/testlist/list_launch_subproc') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'list_launch_subproc',
          name: 'Subprocess list',
          orgId: 'org_subproc',
          caseCount: 2,
          lastRunId: null,
          lastRunCreated: null,
          createdAt: '2026-11-16T00:00:00.000Z',
          updatedAt: '2026-11-16T00:00:00.000Z',
          projectEnvironments: [
            { projectId: 'project_list_a', environmentName: 'staging' },
            { projectId: 'project_list_b', environmentName: 'review' },
          ],
          cases: ['a', 'b'].map(id => ({
            testId: `list_case_${id}`,
            type: 'frontend',
            projectId: `project_list_${id}`,
            projectName: `List project ${id}`,
            title: `List case ${id}`,
            category: null,
            priority: null,
            modified: null,
            status: null,
          })),
          stats: { total: 2, passed: 0, failed: 0, blocked: 0, running: 0 },
        }),
      );
      return;
    }
    const listProject = /^\/api\/cli\/v1\/projects\/project_list_([ab])\/env$/.exec(url);
    if (listProject) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          environments: [
            { name: 'default', url: 'http://127.0.0.1:9', isDefault: true },
            {
              name: listProject[1] === 'a' ? 'staging' : 'review',
              url: 'https://example.com',
              isDefault: false,
            },
          ],
        }),
      );
      return;
    }
    if (req.method === 'POST' && url === '/api/cli/v1/testlist/list_launch_subproc/run') {
      readFixtureBody(req, body => {
        launchBodies.push({ url, body });
        const selected = Array.isArray(body.testIds)
          ? (body.testIds as string[])
          : ['list_case_a', 'list_case_b'];
        const accepted = selected
          .filter(id => id === 'list_case_a' || id === 'list_case_b')
          .map(testId => ({
            testId,
            resultId: `result_${testId}`,
            runId: `run_${testId}`,
            enqueuedAt: '2026-11-16T00:00:00.000Z',
          }));
        const notFound = selected.filter(id => id !== 'list_case_a' && id !== 'list_case_b');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            accepted,
            conflicts: [],
            deferred: [],
            ...(notFound.length ? { notFound } : {}),
          }),
        );
      });
      return;
    }
    if (url.startsWith('/api/cli/v1/results?')) {
      const runId = new URLSearchParams(url.split('?')[1]).get('run');
      if (
        runId === 'run_project_launch_subproc' ||
        runId === 'run_list_case_a' ||
        runId === 'run_list_case_b'
      ) {
        const reads = (executionReads.get(runId) ?? 0) + 1;
        executionReads.set(runId, reads);
        const project = runId === 'run_project_launch_subproc';
        const testIds = project
          ? reads === 1
            ? ['project_unit_a', 'project_unit_b']
            : ['project_unit_a', 'project_unit_b', 'project_integration']
          : [runId.replace('run_', '')];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            run: {
              runId,
              status: project && reads === 1 ? 'running' : 'finished',
              cancelled: false,
            },
            results: testIds.map(testId => fixtureResult(runId, testId)),
          }),
        );
        return;
      }
      if (
        runId === 'run_subproc' ||
        runId === 'run_other_subproc' ||
        runId === 'run_timeout_subproc'
      ) {
        const running = runId === 'run_timeout_subproc';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            run: { runId, status: running ? 'running' : 'finished', cancelled: false },
            results: [
              {
                resultId: `result_${runId}`,
                runId,
                caseKey: `test_${runId}`,
                title: 'Subprocess lifecycle fixture',
                testStatus: running ? 'RUNNING' : 'PASSED',
                created: '2026-11-16T00:00:00.000Z',
              },
            ],
          }),
        );
        return;
      }
    }
    const cancel = /^\/api\/cli\/v1\/runs\/(run_subproc|run_other_subproc)\/cancel$/.exec(url);
    if (req.method === 'POST' && cancel) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          runId: cancel[1],
          alreadyCancelled: false,
          alreadyFinished: false,
          results: [],
        }),
      );
      return;
    }
    if (url.startsWith('/api/cli/v1/projects/')) {
      const id = url.replace('/api/cli/v1/projects/', '').split('?')[0]!;
      const apiKey = req.headers['x-api-key'];
      if (typeof apiKey !== 'string' || apiKey === '') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'AUTH_REQUIRED',
              message: 'Authentication is required.',
              nextAction: '',
              requestId: 'req_subproc',
              details: {},
            },
          }),
        );
        return;
      }
      if (id === 'project_subproc') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'project_subproc',
            name: 'Subproc Fixture',
            type: 'frontend',
            createdFrom: 'portal',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-05T00:00:00.000Z',
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'NOT_FOUND',
            message: 'Resource not found.',
            nextAction: '',
            requestId: 'req_subproc',
            details: { resource: 'project', id },
          },
        }),
      );
      return;
    }
    if (url.startsWith('/api/cli/v1/tests/')) {
      const tail = url.replace('/api/cli/v1/tests/', '').split('?')[0]!;
      const apiKey = req.headers['x-api-key'];
      if (typeof apiKey !== 'string' || apiKey === '') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'AUTH_REQUIRED',
              message: 'Authentication is required.',
              nextAction: '',
              requestId: 'req_subproc',
              details: {},
            },
          }),
        );
        return;
      }
      const segments = tail.split('/');
      const testId = segments[0]!;
      const subPath = segments[1];
      if (testId === 'test_subproc' && subPath === undefined) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'test_subproc',
            projectId: 'project_subproc',
            slug: 'SUBPROC-001',
            title: 'Subproc test fixture',
            type: 'frontend',
            version: { hash: 'a3f9c2e1', label: 'v1.0' },
            stepCount: 0,
            steps: [],
            createdAt: '2026-04-20T11:00:00.000Z',
            updatedAt: '2026-05-05T12:34:56.000Z',
          }),
        );
        return;
      }
      if (testId === 'test_ambiguous_org' && subPath === undefined) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'CONFLICT',
              message:
                'Test id "test_ambiguous_org" resolves in more than one of your organizations.',
              nextAction:
                'This id is ambiguous across your organizations. Open the specific project in the ' +
                'Portal to act on it, or contact support — uuid-derived ids should not normally collide.',
              requestId: 'req_subproc_ambiguous',
              details: {
                reason: 'ambiguous_org',
                testId: 'test_ambiguous_org',
                candidates: [
                  { projectId: 'project_a', orgId: 'org_a' },
                  { projectId: 'project_b', orgId: 'org_b' },
                ],
              },
            },
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'NOT_FOUND',
            message: 'Resource not found.',
            nextAction: '',
            requestId: 'req_subproc',
            details: { resource: 'test', id: tail },
          },
        }),
      );
      return;
    }
    if (url.startsWith('/api/cli/v1/tests')) {
      const apiKey = req.headers['x-api-key'];
      if (typeof apiKey !== 'string' || apiKey === '') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'AUTH_REQUIRED',
              message: 'Authentication is required.',
              nextAction: 'Run `testsprite setup`.',
              requestId: 'req_subproc',
              details: {},
            },
          }),
        );
        return;
      }
      const params = new URLSearchParams(url.split('?')[1] ?? '');
      const projectId = params.get('projectId');
      if (!projectId) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid request.',
              nextAction: 'Field `projectId` is required.',
              requestId: 'req_subproc',
              details: { field: 'projectId', reason: 'required' },
            },
          }),
        );
        return;
      }
      const items = [
        {
          id: 'test_subproc',
          projectId: 'project_subproc',
          slug: 'SUBPROC-001',
          title: 'Subproc test fixture',
          type: 'frontend' as const,
          version: { hash: 'a3f9c2e1', label: 'v1.0' },
          stepCount: 0,
          createdAt: '2026-04-20T11:00:00.000Z',
          updatedAt: '2026-05-05T12:34:56.000Z',
        },
      ];
      const typeFilter = params.get('type');
      const filtered = typeFilter ? items.filter(t => t.type === typeFilter) : items;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: filtered, nextToken: null }));
      return;
    }
    if (url.startsWith('/api/cli/v1/projects')) {
      const apiKey = req.headers['x-api-key'];
      if (typeof apiKey !== 'string' || apiKey === '') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'AUTH_REQUIRED',
              message: 'Authentication is required.',
              nextAction: 'Run `testsprite setup`.',
              requestId: 'req_subproc',
              details: {},
            },
          }),
        );
        return;
      }
      // Single-project listing — enough to exercise text+json paths.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          items: [
            {
              id: 'project_subproc',
              name: 'Subproc Fixture',
              type: 'frontend',
              createdFrom: 'portal',
              createdAt: '2026-05-01T00:00:00.000Z',
              updatedAt: '2026-05-05T00:00:00.000Z',
            },
          ],
          nextToken: null,
        }),
      );
      return;
    }
    if (url === '/api/cli/v1/me') {
      const apiKey = req.headers['x-api-key'];
      if (typeof apiKey !== 'string' || apiKey === '') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'AUTH_REQUIRED',
              message: 'Authentication is required.',
              nextAction: 'Run `testsprite setup`.',
              requestId: 'req_subproc',
              details: {},
            },
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ME_BODY));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          code: 'NOT_FOUND',
          message: 'Not found.',
          nextAction: '',
          requestId: 'req_subproc',
          details: {},
        },
      }),
    );
  });
  await new Promise<void>(resolveListen => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('server.address() did not return an AddressInfo');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  tmpHome = mkdtempSync(join(tmpdir(), 'testsprite-subproc-'));
}, 60_000);

afterAll(async () => {
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  // tmpHome accumulates a real (if fake-valued) credentials file across this
  // suite's `setup` runs — remove it so the suite doesn't
  // leave one directory behind per test run. Guarded: if `beforeAll` threw
  // before assigning it, there is nothing to remove.
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  envOverrides: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<SpawnResult> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn('node', [BIN_PATH, ...args], {
      cwd: REPO_ROOT,
      // A failed parser regression must not leave a 600-second polling child alive.
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        // os.homedir() reads HOME on POSIX but USERPROFILE on Windows —
        // set both so the child never sees the real ~/.testsprite.
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        TESTSPRITE_API_KEY: undefined,
        TESTSPRITE_API_URL: undefined,
        ...envOverrides,
      } as NodeJS.ProcessEnv,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk.toString()));
    child.stderr.on('data', chunk => (stderr += chunk.toString()));
    child.on('error', rejectResult);
    child.on('close', code => resolveResult({ exitCode: code ?? -1, stdout, stderr }));
  });
}

describe('single root run subprocess contract', () => {
  const isolatedEnv = () => ({
    TESTSPRITE_API_KEY: 'sk-user-subproc',
    TESTSPRITE_API_URL: baseUrl,
    TESTSPRITE_NO_TELEMETRY: '1',
    TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
    TESTSPRITE_NO_SKILL_WARNING: '1',
    TESTSPRITE_PROJECT_ID: '',
  });

  it.each([
    ['run', '--', '--project', 'project_subproc', '--no-wait'],
    ['run', '--', '--testlist', 'list_subproc', '--no-wait'],
    ['run', '--output', 'json', '--', '--project', 'project_subproc', '--no-wait'],
  ])('preserves literal arguments after the option terminator: %j', async (...args) => {
    const before = businessRequests.length;
    const result = await runCli(['--output', 'json', ...args], isolatedEnv());
    expect(result.exitCode, result.stderr).toBe(4);
    const requests = businessRequests.slice(before);
    expect(requests.some(request => request.method === 'POST')).toBe(false);
    expect(requests.some(request => /\/tests\/(--project|--testlist)/.test(request.url))).toBe(
      true,
    );
  });

  it('keeps an option terminator used as a required global value distinct from a literal boundary', async () => {
    const before = launchBodies.length;
    const result = await runCli(
      ['--profile', '--', '--output', 'json', 'run', '--project', 'project_subproc', '--no-wait'],
      isolatedEnv(),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(launchBodies.slice(before)).toEqual([
      { url: '/api/cli/v1/projects/project_subproc/runs', body: { maxConcurrency: 50 } },
    ]);
  });

  it('previews an unfiltered project from the root without business requests', async () => {
    const before = requestCount;
    const result = await runCli(
      [
        '--dry-run',
        '--output',
        'json',
        'run',
        '--project',
        'project_subproc',
        '--target-url',
        'https://example.com',
        '--skip-preflight',
      ],
      isolatedEnv(),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      requests: [{ method: 'POST', path: '/api/cli/v1/projects/project_subproc/runs' }],
    });
    const preview = JSON.parse(result.stdout);
    expect(preview.requests).toHaveLength(1);
    expect(preview.requests[0].body).not.toHaveProperty('testIds');
    expect(requestCount).toBe(before);
  }, 30_000);

  it('previews a saved list from the root without business requests', async () => {
    const before = requestCount;
    const result = await runCli(
      ['--dry-run', '--output', 'json', 'run', '--testlist', 'list_subproc'],
      isolatedEnv(),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      runs: [],
      results: [],
      requests: [{ method: 'POST', path: '/api/cli/v1/testlist/list_subproc/run' }],
    });
    expect(requestCount).toBe(before);
  }, 30_000);

  it('launches one whole-project execution and waits for its late integration result', async () => {
    const before = businessRequests.length;
    const bodiesBefore = launchBodies.length;
    const result = await runCli(
      [
        '--output',
        'json',
        'run',
        '--project',
        'project_subproc',
        '--target-url',
        'https://example.com',
        '--skip-preflight',
        '--wait',
        '--timeout',
        '10',
      ],
      isolatedEnv(),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.runs).toEqual([
      expect.objectContaining({
        runId: 'run_project_launch_subproc',
        projectId: 'project_subproc',
        total: 2,
      }),
    ]);
    expect(parsed.results.map((row: { resultId: string }) => row.resultId).sort()).toEqual([
      'result_project_integration',
      'result_project_unit_a',
      'result_project_unit_b',
    ]);
    expect(parsed.summary).toMatchObject({ total: 3, passed: 3, failed: 0, timedOut: 0 });
    expect(executionReads.get('run_project_launch_subproc')).toBe(2);
    expect(launchBodies.slice(bodiesBefore)).toEqual([
      {
        url: '/api/cli/v1/projects/project_subproc/runs',
        body: expect.objectContaining({ maxConcurrency: 50, targetUrl: 'https://example.com' }),
      },
    ]);
    expect(launchBodies[bodiesBefore]!.body).not.toHaveProperty('testIds');
    const requests = businessRequests.slice(before);
    expect(requests.filter(row => row.method === 'POST')).toEqual([
      { method: 'POST', url: '/api/cli/v1/projects/project_subproc/runs' },
    ]);
    expect(requests.some(row => new URL(row.url, baseUrl).pathname === '/api/cli/v1/tests')).toBe(
      false,
    );
    expect(requests.some(row => row.url.startsWith('/api/cli/v1/tests/'))).toBe(false);
  }, 30_000);

  it('launches a whole saved list with pinned project environments and its native receipt', async () => {
    const before = businessRequests.length;
    const bodiesBefore = launchBodies.length;
    const result = await runCli(
      ['--output', 'json', 'run', '--testlist', 'list_launch_subproc', '--wait', '--timeout', '10'],
      isolatedEnv(),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.results).toEqual([
      expect.objectContaining({
        testId: 'list_case_a',
        resultId: 'result_list_case_a',
        runId: 'run_list_case_a',
        status: 'passed',
      }),
      expect.objectContaining({
        testId: 'list_case_b',
        resultId: 'result_list_case_b',
        runId: 'run_list_case_b',
        status: 'passed',
      }),
    ]);
    expect(parsed.conflicts).toEqual([]);
    expect(parsed.deferred).toEqual([]);
    expect(parsed.summary).toMatchObject({ total: 2, passed: 2, failed: 0 });
    expect(launchBodies.slice(bodiesBefore)).toEqual([
      {
        url: '/api/cli/v1/testlist/list_launch_subproc/run',
        body: { maxConcurrency: 10 },
      },
    ]);
    const requests = businessRequests.slice(before);
    expect(requests.filter(row => row.url.endsWith('/env')).map(row => row.url)).toEqual([
      '/api/cli/v1/projects/project_list_a/env',
      '/api/cli/v1/projects/project_list_b/env',
    ]);
    expect(requests.filter(row => row.method === 'POST')).toEqual([
      { method: 'POST', url: '/api/cli/v1/testlist/list_launch_subproc/run' },
    ]);
    expect(requests.some(row => row.url.includes('/tests'))).toBe(false);
  }, 30_000);

  it('passes a positional list subset unchanged and waits before reporting non-members', async () => {
    const before = businessRequests.length;
    const bodiesBefore = launchBodies.length;
    const result = await runCli(
      [
        '--output',
        'json',
        'run',
        'list_case_b',
        'missing_case',
        '--testlist',
        'list_launch_subproc',
        '--wait',
        '--timeout',
        '10',
      ],
      isolatedEnv(),
    );
    expect(result.exitCode, result.stderr).toBe(4);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.results).toEqual([
      expect.objectContaining({
        testId: 'list_case_b',
        resultId: 'result_list_case_b',
        runId: 'run_list_case_b',
        status: 'passed',
      }),
    ]);
    expect(parsed.notFound).toEqual(['missing_case']);
    expect(parsed.conflicts).toEqual([]);
    expect(parsed.deferred).toEqual([]);
    expect(parsed.summary.passed).toBe(1);
    expect(launchBodies.slice(bodiesBefore)).toEqual([
      {
        url: '/api/cli/v1/testlist/list_launch_subproc/run',
        body: { testIds: ['list_case_b', 'missing_case'], maxConcurrency: 10 },
      },
    ]);
    const requests = businessRequests.slice(before);
    expect(requests.filter(row => row.url.endsWith('/env')).map(row => row.url)).toEqual([
      '/api/cli/v1/projects/project_list_b/env',
    ]);
    expect(
      requests.filter(row => new URL(row.url, baseUrl).pathname === '/api/cli/v1/results'),
    ).toEqual([{ method: 'GET', url: expect.stringContaining('run=run_list_case_b') }]);
    expect(requests.filter(row => row.method === 'POST')).toHaveLength(1);
    expect(result.stderr).toContain('missing_case');
  }, 30_000);

  it.each(['wait', 'cancel'])('root run %s help exits 0', async child => {
    const result = await runCli(['run', child, '--help'], isolatedEnv());
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Usage: testsprite run ${child} [options] <run-id...>`);
  });

  it.each([
    ['test', 'run', ['test_subproc'], 'testsprite run'],
    ['test', 'wait', ['run_subproc'], 'testsprite run wait'],
    ['test', 'cancel', ['run_subproc'], 'testsprite run cancel'],
    ['testlist', 'run', ['list_subproc'], 'testsprite run'],
  ] as const)(
    'refuses retired %s %s paths and help forms before business work',
    async (group, name, ids, pointer) => {
      const artifactDir = mkdtempSync(join(tmpHome, 'retired-run-'));
      const report = join(artifactDir, 'report.xml');
      const summary = join(artifactDir, 'summary.json');
      const githubOutput = join(artifactDir, 'github-output');
      const before = requestCount;
      const invocations = [
        [group, name, ...ids],
        [
          group,
          name,
          ...ids,
          '--wait',
          '--report',
          'junit',
          '--report-file',
          report,
          '--summary-file',
          summary,
        ],
        [group, name, ...ids, '--dry-run', ...(name === 'wait' ? ['--timeout', '1'] : [])],
        [group, name, '--help'],
        [group, name, '-h'],
        [group, '--help', name],
        ['--help', group, name],
        ['help', group, name],
        [group, 'help', name],
      ];
      for (const output of ['text', 'json']) {
        for (const args of invocations) {
          const result = await runCli(['--output', output, ...args], {
            ...isolatedEnv(),
            GITHUB_OUTPUT: githubOutput,
            GITHUB_STEP_SUMMARY: summary,
          });
          expect(result.exitCode, `${args.join(' ')}: ${result.stderr}`).toBe(5);
          expect(result.stdout).toBe('');
          if (output === 'json') {
            const parsed = JSON.parse(result.stderr);
            expect(parsed.error.code).toBe('VALIDATION_ERROR');
            expect(parsed.error.message).toContain(`unknown command '${name}'`);
            expect(parsed.error.nextAction).toContain(pointer);
            if (group === 'testlist') expect(parsed.error.nextAction).toContain('--testlist');
          } else {
            expect(result.stderr).toContain(`unknown command '${name}'`);
            expect(result.stderr).toContain(pointer);
            if (group === 'testlist') expect(result.stderr).toContain('--testlist');
          }
          expect(requestCount).toBe(before);
          expect(existsSync(report)).toBe(false);
          expect(existsSync(summary)).toBe(false);
          expect(existsSync(githubOutput)).toBe(false);
        }
      }
    },
    30_000,
  );

  it.each([
    [['run', '--all', '--project', 'project_subproc'], '--all'],
    [['run', '--testlist', 'list_subproc', '--case', 'test_subproc'], '--case'],
  ])('rejects retired selector %j before business work', async (args, option) => {
    const before = requestCount;
    const result = await runCli(['--output', 'json', ...args], isolatedEnv());
    expect(result.exitCode, result.stderr).toBe(5);
    expect(result.stdout).toBe('');
    const parsed = JSON.parse(result.stderr);
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
    expect(parsed.error.message).toContain(`unknown option '${option}'`);
    expect(requestCount).toBe(before);
  });

  it.each([
    ['run', 'test_subproc', '--project', 'project_subproc'],
    ['run', '--project', 'project_subproc', '--testlist', 'list_subproc'],
    ['run', '--project', ''],
    ['run', '--project', '   '],
    ['run', '--testlist', ''],
    ['run', '--testlist', '   '],
    ['run', '--testlist', 'list_subproc', '--env', 'staging'],
    ['run', '--testlist', 'list_subproc', '--target-url', 'https://example.com'],
    ['run', '--testlist', 'list_subproc', '--local', '3000'],
    ['run', '--testlist', 'list_subproc', '--local-host', 'localhost'],
    ['run', '--testlist', 'list_subproc', '--tunnel-client', 'tunnel_subproc'],
    ['run', '--testlist', 'list_subproc', '--no-cancel-on-interrupt'],
    ['run', '--testlist', 'list_subproc', '--skip-dependencies'],
    ['run', '--testlist', 'list_subproc', '--filter', 'fixture'],
    ['run', '--testlist', 'list_subproc', '--allow-empty'],
  ])('refuses invalid root selectors/options %j without requests or artifacts', async (...args) => {
    const artifactDir = mkdtempSync(join(tmpHome, 'invalid-run-'));
    const report = join(artifactDir, 'report.xml');
    const summary = join(artifactDir, 'summary.json');
    const before = requestCount;
    const result = await runCli(
      [
        '--output',
        'json',
        ...args,
        '--wait',
        '--report',
        'junit',
        '--report-file',
        report,
        '--summary-file',
        summary,
      ],
      { ...isolatedEnv(), TESTSPRITE_PROJECT_ID: 'context_project' },
    );
    expect(result.exitCode, result.stderr).toBe(5);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).error.code).toBe('VALIDATION_ERROR');
    expect(requestCount).toBe(before);
    expect(existsSync(report)).toBe(false);
    expect(existsSync(summary)).toBe(false);
  });

  it.each([['run'], ['run', 'list']])(
    'rejects a missing selector or run-list guess %j locally',
    async (...args) => {
      const before = requestCount;
      const result = await runCli(['--output', 'json', ...args], isolatedEnv());
      expect(result.exitCode, result.stderr).toBe(5);
      expect(result.stdout).toBe('');
      const parsed = JSON.parse(result.stderr);
      expect(parsed.error.code).toBe('VALIDATION_ERROR');
      if (args[1] === 'list') {
        expect(parsed.error.message + parsed.error.nextAction).toContain('testsprite result list');
      }
      expect(requestCount).toBe(before);
    },
  );

  it('allows root-global options before wait and reads each distinct run without launching', async () => {
    const before = businessRequests.length;
    const result = await runCli(
      [
        'run',
        '--output',
        'json',
        '--profile',
        'run-contract',
        '--endpoint-url',
        baseUrl,
        'wait',
        'run_subproc',
        'run_other_subproc',
        'run_subproc',
        '--timeout',
        '17',
      ],
      isolatedEnv(),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.runs.map((run: { runId: string }) => run.runId)).toEqual([
      'run_subproc',
      'run_other_subproc',
    ]);
    expect(parsed.summary).toMatchObject({ total: 2, passed: 2, failed: 0, timedOut: 0 });
    const requests = businessRequests.slice(before);
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    expect(
      requests.map(request => new URL(request.url, baseUrl).searchParams.get('run')).sort(),
    ).toEqual(['run_other_subproc', 'run_subproc']);
    for (const request of requests) {
      const url = new URL(request.url, baseUrl);
      expect(url.pathname).toBe('/api/cli/v1/results');
      expect(url.searchParams.get('status')).toBe('passed,failed,running,blocked,cancelled');
    }
  }, 30_000);

  it('assigns a trailing timeout to wait rather than the parent launch', async () => {
    const before = businessRequests.length;
    const result = await runCli(
      ['--output', 'json', 'run', 'wait', 'run_timeout_subproc', '--timeout', '1'],
      isolatedEnv(),
      5_000,
    );
    expect(result.exitCode, result.stderr).toBe(7);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.runs).toEqual([expect.objectContaining({ runId: 'run_timeout_subproc' })]);
    expect(parsed.summary.timedOut).toBe(1);
    expect(businessRequests.slice(before).length).toBeGreaterThan(0);
    expect(
      businessRequests
        .slice(before)
        .every(
          request =>
            request.method === 'GET' &&
            new URL(request.url, baseUrl).pathname === '/api/cli/v1/results',
        ),
    ).toBe(true);
  }, 10_000);

  it('cancels each distinct run once without enumerating members or launching', async () => {
    const before = businessRequests.length;
    const result = await runCli(
      ['--output', 'json', 'run', 'cancel', 'run_subproc', 'run_other_subproc', 'run_subproc'],
      isolatedEnv(),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.cancelled).toEqual(['run_subproc', 'run_other_subproc']);
    expect(parsed.runs.map((run: { runId: string }) => run.runId)).toEqual([
      'run_subproc',
      'run_other_subproc',
    ]);
    expect(businessRequests.slice(before)).toEqual([
      { method: 'POST', url: '/api/cli/v1/runs/run_subproc/cancel' },
      { method: 'POST', url: '/api/cli/v1/runs/run_other_subproc/cancel' },
    ]);
  }, 30_000);

  it('retains global dry-run and output options before a lifecycle child', async () => {
    const before = requestCount;
    const result = await runCli(
      [
        'run',
        '--dry-run',
        '--output',
        'json',
        '--profile',
        'run-contract',
        'cancel',
        'run_subproc',
      ],
      isolatedEnv(),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).runs).toHaveLength(1);
    expect(result.stderr).toContain('[dry-run]');
    expect(requestCount).toBe(before);
  });

  it.each([
    ['--project', 'project_subproc'],
    ['--testlist', 'list_subproc'],
    ['--env', 'staging'],
    ['--timeout', '17'],
    ['--max-concurrency', '2'],
    ['--no-wait'],
  ])('rejects explicit parent launch flags %j before lifecycle dispatch', async (...options) => {
    const before = requestCount;
    for (const child of ['wait', 'cancel']) {
      const result = await runCli(
        ['--output', 'json', 'run', ...options, child, 'run_subproc'],
        isolatedEnv(),
      );
      expect(result.exitCode, result.stderr).toBe(5);
      expect(result.stdout).toBe('');
      const parsed = JSON.parse(result.stderr);
      expect(parsed.error.code).toBe('VALIDATION_ERROR');
      expect(parsed.error.message + parsed.error.nextAction).toContain(options[0]);
      expect(requestCount).toBe(before);
    }
  });
});

describe('auth status subprocess', () => {
  it('prints JSON me and exits 0 against the local server', async () => {
    const result = await runCli(['auth', 'status', '--output', 'json'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual(ME_BODY);
    expect(result.stderr).toBe('');
  }, 30_000);

  it('exits 3 with AUTH_REQUIRED when no key is configured (text mode)', async () => {
    const result = await runCli(['auth', 'status'], {
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('Authentication is required.');
    expect(result.stderr).toContain('testsprite setup');
  }, 30_000);

  it('--output json emits a parseable error envelope on AUTH_REQUIRED', async () => {
    const result = await runCli(['--output', 'json', 'auth', 'status'], {
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(3);
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; nextAction: string; requestId: string };
    };
    expect(parsed.error.code).toBe('AUTH_REQUIRED');
    expect(parsed.error.nextAction).toContain('testsprite setup');
  }, 30_000);

  it('text mode renders userId/scopes legibly', async () => {
    const result = await runCli(['auth', 'status'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('userId: u-subproc');
    expect(result.stdout).toContain('scopes: read:projects, read:tests');
  }, 30_000);

  it('--debug emits structured debug events to stderr without leaking the key', async () => {
    const result = await runCli(['--debug', 'auth', 'status', '--output', 'json'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc-secret',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('"kind":"request"');
    expect(result.stderr).toContain('"kind":"response"');
    expect(result.stderr).not.toContain('sk-user-subproc-secret');
    expect(result.stderr).not.toContain('x-api-key');
  }, 30_000);
});

describe('project list subprocess', () => {
  it('--output json returns the §6.1 ProjectList shape', async () => {
    const result = await runCli(['--output', 'json', 'project', 'list'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].id).toBe('project_subproc');
    expect(parsed.nextToken).toBeNull();
  }, 30_000);

  it('text output renders a header row and the project name', async () => {
    const result = await runCli(['project', 'list'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ID');
    expect(result.stdout).toContain('NAME');
    expect(result.stdout).toContain('Subproc Fixture');
  }, 30_000);

  it('--help prints flag documentation for pagination', async () => {
    const result = await runCli(['project', 'list', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--page-size');
    expect(result.stdout).toContain('--starting-token');
    expect(result.stdout).toContain('--max-items');
  }, 30_000);

  it('--page-size 0 exits 5 (VALIDATION_ERROR), not 1 (generic)', async () => {
    const result = await runCli(['--output', 'json', 'project', 'list', '--page-size', '0'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(5);
    const parsed = JSON.parse(result.stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  }, 30_000);

  it('--page-size 101 exits 5 (VALIDATION_ERROR) — upper-bound enforced client-side', async () => {
    // Previously silently clamped to 100; now rejected at exit 5 so callers
    // get fast feedback that the value is out of range (Fix 7 — B-E2E-01 wave).
    const result = await runCli(['--output', 'json', 'project', 'list', '--page-size', '101'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(5);
    const parsed = JSON.parse(result.stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  }, 30_000);

  it('--request-timeout 30s exits 5 (VALIDATION_ERROR), not a silent fallback to 120s', async () => {
    // Previously an invalid flag value resolved to `undefined` and the command
    // silently ran with the default 120s deadline — the operator believed they
    // had set a timeout but had not. Now the explicit flag is validated like
    // every other flag.
    const result = await runCli(
      ['--output', 'json', '--request-timeout', '30s', 'project', 'list'],
      {
        TESTSPRITE_API_KEY: 'sk-user-subproc',
        TESTSPRITE_API_URL: baseUrl,
      },
    );
    expect(result.exitCode).toBe(5);
    const parsed = JSON.parse(result.stderr) as { error: { code: string; nextAction: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
    expect(parsed.error.nextAction).toContain('request-timeout');
  }, 30_000);
});

describe('malformed --endpoint-url is rejected (exit 5), not retried as a network error', () => {
  // Previously: a malformed endpoint surfaced either as an opaque `Invalid URL`
  // (exit 1) or, for a missing/wrong scheme, as a `fetch failed` UNAVAILABLE
  // only after a full retry-and-backoff cycle. Both are misleading config
  // errors. Validation throws before any fetch, so no network is hit here even
  // though a (dummy) key is configured.

  it('an unparseable endpoint exits 5 with a VALIDATION_ERROR naming endpoint-url', async () => {
    const result = await runCli(
      ['--output', 'json', '--endpoint-url', 'not a url', 'project', 'list'],
      { TESTSPRITE_API_KEY: 'sk-user-subproc' },
    );
    expect(result.exitCode).toBe(5);
    const parsed = JSON.parse(result.stderr) as { error: { code: string; nextAction: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
    expect(parsed.error.nextAction).toContain('endpoint-url');
  }, 30_000);

  it('a non-http(s) scheme exits 5 instead of being retried as a network failure', async () => {
    const result = await runCli(
      ['--output', 'json', '--endpoint-url', 'ftp://example.com', 'project', 'list'],
      { TESTSPRITE_API_KEY: 'sk-user-subproc' },
    );
    expect(result.exitCode).toBe(5);
    const parsed = JSON.parse(result.stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  }, 30_000);
});

describe('invalid --output is rejected uniformly (exit 5)', () => {
  // Regression: previously only `test` and `project` validated `--output`;
  // `auth`, `usage`, `agent`, and `init` silently coerced an unknown value to
  // text mode. An agent that asked for `--output json` but mistyped it then
  // received a text payload it could not parse, with no signal as to why. Every
  // command group now routes through resolveOutputMode (exit 5 on bad input).

  // Note: when `--output` itself is the invalid value, the requested mode is
  // unusable for the error envelope, so it is rendered in text mode (the catch
  // block in index.ts falls back to text for an unrecognised --output).

  it('agent list --output josn exits 5 with an actionable message (offline command)', async () => {
    const result = await runCli(['--output', 'josn', 'agent', 'list'], {});
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain('must be one of: json, text');
  }, 30_000);

  it('auth status --output yaml exits 5 before any network call', async () => {
    const result = await runCli(['--output', 'yaml', 'auth', 'status'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain('must be one of: json, text');
  }, 30_000);
});

describe('a malformed --profile is rejected (exit 5), not silently corrupting credentials', () => {
  // A profile name becomes an INI section header (`[name]`). `prod]` would
  // serialise to `[prod]]`, which the parser cannot read back — `setup` would
  // report success while the key silently fails to persist. The guard fires on
  // any credential read/write path.
  it('exits 5 with a VALIDATION_ERROR naming the profile flag', async () => {
    const result = await runCli(['--output', 'json', '--profile', 'prod]', 'project', 'list'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(5);
    const parsed = JSON.parse(result.stderr) as { error: { code: string; nextAction: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
    expect(parsed.error.nextAction).toContain('profile');
  }, 30_000);
});

describe('project get subprocess', () => {
  it('--output json returns the §6.1 Project shape', async () => {
    const result = await runCli(['--output', 'json', 'project', 'get', 'project_subproc'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.id).toBe('project_subproc');
    expect(parsed.type).toBe('frontend');
    expect(parsed.createdFrom).toBe('portal');
  }, 30_000);

  it('text output prints the labeled fields block', async () => {
    const result = await runCli(['project', 'get', 'project_subproc'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('id:          project_subproc');
    expect(result.stdout).toContain('createdFrom: portal');
  }, 30_000);

  it('exits 4 (NOT_FOUND) for an unknown project id', async () => {
    const result = await runCli(['--output', 'json', 'project', 'get', 'project_does_not_exist'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(4);
    const parsed = JSON.parse(result.stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('NOT_FOUND');
  }, 30_000);
});

describe('test list subprocess', () => {
  it('--output json returns the §6.2 TestList shape', async () => {
    const result = await runCli(
      ['--output', 'json', 'test', 'list', '--project', 'project_subproc'],
      {
        TESTSPRITE_API_KEY: 'sk-user-subproc',
        TESTSPRITE_API_URL: baseUrl,
      },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].id).toBe('test_subproc');
    expect(parsed.items[0].title).toBe('Subproc test fixture');
    expect(parsed.items[0]).not.toHaveProperty('status');
    expect(parsed.nextToken).toBeNull();
  }, 30_000);

  it('--type frontend filter is forwarded to the facade', async () => {
    const result = await runCli(
      ['--output', 'json', 'test', 'list', '--project', 'project_subproc', '--type', 'frontend'],
      {
        TESTSPRITE_API_KEY: 'sk-user-subproc',
        TESTSPRITE_API_URL: baseUrl,
      },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.items[0].type).toBe('frontend');
  }, 30_000);

  it('--type backend with no matching rows returns empty list', async () => {
    const result = await runCli(
      ['--output', 'json', 'test', 'list', '--project', 'project_subproc', '--type', 'backend'],
      {
        TESTSPRITE_API_KEY: 'sk-user-subproc',
        TESTSPRITE_API_URL: baseUrl,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).items).toEqual([]);
  }, 30_000);

  it('text output renders header + the case columns', async () => {
    const result = await runCli(['test', 'list', '--project', 'project_subproc'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ID');
    expect(result.stdout).toContain('TITLE');
    expect(result.stdout).toContain('VERSION');
    expect(result.stdout).not.toContain('STATUS');
    expect(result.stdout).toContain('SUBPROC-001');
    expect(result.stdout).toContain('Subproc test fixture');
    expect(result.stdout).toContain('v1.0');
  }, 30_000);

  it('--help prints filter and pagination flags', async () => {
    const result = await runCli(['test', 'list', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--project');
    expect(result.stdout).toContain('--type');
    expect(result.stdout).not.toContain('--status');
    expect(result.stdout).toContain('--page-size');
  }, 30_000);

  it('missing --project exits 5 with VALIDATION_ERROR (typed envelope)', async () => {
    const result = await runCli(['--output', 'json', 'test', 'list'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    // Per the CLI error spec §2 ("missing required field" → VALIDATION_ERROR)
    // and §6 (VALIDATION_ERROR → exit 5), so JSON consumers can branch on
    // `error.code` instead of a generic Commander exit-1 string.
    expect(result.exitCode).toBe(5);
    const parsed = JSON.parse(result.stderr) as {
      error: { code: string; details: { field: string } };
    };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
    expect(parsed.error.details.field).toBe('project');
  }, 30_000);

  it('--type=junk exits 5 with VALIDATION_ERROR (local validation)', async () => {
    const result = await runCli(
      ['--output', 'json', 'test', 'list', '--project', 'project_subproc', '--type', 'junk'],
      { TESTSPRITE_API_KEY: 'sk-user-subproc', TESTSPRITE_API_URL: baseUrl },
    );
    expect(result.exitCode).toBe(5);
    const parsed = JSON.parse(result.stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  }, 30_000);
});

describe('test get subprocess', () => {
  it('--output json returns the §6.2 Test shape', async () => {
    const result = await runCli(['--output', 'json', 'test', 'get', 'test_subproc'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.id).toBe('test_subproc');
    expect(parsed.type).toBe('frontend');
    expect(parsed.title).toBe('Subproc test fixture');
    expect(parsed.version).toEqual({ hash: 'a3f9c2e1', label: 'v1.0' });
    expect(parsed).not.toHaveProperty('status');
  }, 30_000);

  it('text output prints the labeled fields block', async () => {
    const result = await runCli(['test', 'get', 'test_subproc'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('id:          test_subproc');
    expect(result.stdout).toContain('slug:        SUBPROC-001');
    expect(result.stdout).toContain('title:       Subproc test fixture');
    expect(result.stdout).toContain('version:     v1.0');
    expect(result.stdout).not.toContain('status:');
  }, 30_000);

  it('exits 4 (NOT_FOUND) for an unknown test id', async () => {
    const result = await runCli(['--output', 'json', 'test', 'get', 'test_does_not_exist'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(4);
    const parsed = JSON.parse(result.stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('NOT_FOUND');
  }, 30_000);
});

describe('AMBIGUOUS_ORG conflict rendering (test get)', () => {
  it('text mode: exit 6, prints one candidate line per colliding project + a --project hint', async () => {
    const result = await runCli(['test', 'get', 'test_ambiguous_org'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain('resolves in more than one of your organizations');
    expect(result.stderr).toContain('candidate: project project_a (org org_a)');
    expect(result.stderr).toContain('candidate: project project_b (org org_b)');
    expect(result.stderr).toContain('--project <id>');
  }, 30_000);

  it('--output json: exit 6, error envelope carries code + candidates verbatim', async () => {
    const result = await runCli(['--output', 'json', 'test', 'get', 'test_ambiguous_org'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(6);
    const parsed = JSON.parse(result.stderr) as {
      error: {
        code: string;
        details: { reason: string; candidates: Array<{ projectId: string; orgId: string }> };
      };
    };
    expect(parsed.error.code).toBe('AMBIGUOUS_ORG');
    expect(parsed.error.details.reason).toBe('ambiguous_org');
    expect(parsed.error.details.candidates).toEqual([
      { projectId: 'project_a', orgId: 'org_a' },
      { projectId: 'project_b', orgId: 'org_b' },
    ]);
  }, 30_000);
});

describe('auth remove subprocess', () => {
  it('removes the profile file entry and exits 0', async () => {
    // First configure a profile (via the consolidated `setup` path)
    const configureResult = await runCli(['setup', '--from-env', '--no-agent'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(configureResult.exitCode).toBe(0);

    const removeResult = await runCli(['auth', 'remove']);
    expect(removeResult.exitCode).toBe(0);
    expect(removeResult.stdout).toContain('Removed credentials');
  }, 30_000);
});

describe('setup --from-env subprocess', () => {
  it('writes the credentials file with mode 0600', async () => {
    const result = await runCli(['setup', '--from-env', '--no-agent'], {
      TESTSPRITE_API_KEY: 'sk-user-mode-test',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(0);
    const credentialsPath = join(tmpHome, '.testsprite', 'credentials');
    expect(existsSync(credentialsPath)).toBe(true);
    // POSIX file modes don't exist on Windows (stat reports 0666).
    if (process.platform !== 'win32') {
      expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
    }
  }, 30_000);

  it('exits 5 with VALIDATION_ERROR when --from-env is set without TESTSPRITE_API_KEY', async () => {
    // Explicitly do not pass TESTSPRITE_API_KEY
    const result = await runCli(['setup', '--from-env', '--no-agent'], {
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain('TESTSPRITE_API_KEY');
  }, 30_000);
});

/**
 * P6 dry-run smoke. Each command must run end-to-end without an API
 * key, without network access (the local server is up but we never
 * point at it), and without writing to disk. Stdout is the canned
 * sample envelope; stderr carries the dry-run banner and any
 * "would write" annotations.
 */
describe('--dry-run subprocess smoke', () => {
  it('project list --dry-run returns canned ProjectList without auth', async () => {
    const result = await runCli(['project', 'list', '--dry-run', '--output', 'json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { items: unknown[]; nextToken: null };
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(parsed.nextToken).toBeNull();
    expect(result.stderr).toContain('[dry-run] sample response');
  }, 30_000);

  it('project get --dry-run returns canned Project without auth', async () => {
    const result = await runCli([
      'project',
      'get',
      'proj_anything',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { id: string };
    expect(parsed.id).toBeTruthy();
  }, 30_000);

  it('test list --dry-run returns canned TestList', async () => {
    const result = await runCli([
      'test',
      'list',
      '--project',
      'proj_anything',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { items: unknown[] };
    expect(parsed.items.length).toBeGreaterThan(0);
  }, 30_000);

  it('setup --dry-run does NOT prompt and does NOT write credentials', async () => {
    // No TESTSPRITE_API_KEY in env; if dry-run actually called the prompt
    // path the subprocess would block waiting on stdin and the test would
    // time out. The fact that it exits 0 within the timeout proves it
    // skipped the prompt.
    const credPath = join(tmpHome, '.testsprite', 'credentials');
    // Make sure any previous test didn't leave one behind.
    rmSync(credPath, { force: true });
    const result = await runCli(['setup', '--dry-run', '--no-agent', '--output', 'json']);
    expect(result.exitCode).toBe(0);
    expect(existsSync(credPath)).toBe(false);
    expect(result.stderr).toContain('[dry-run]');
    expect(result.stderr).toContain('would configure profile');
  }, 30_000);

  it('auth status --dry-run returns canned MeResponse without auth', async () => {
    const result = await runCli(['auth', 'status', '--dry-run', '--output', 'json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { userId: string; scopes: string[] };
    expect(parsed.userId).toBeTruthy();
    expect(parsed.scopes.length).toBeGreaterThan(0);
  }, 30_000);

  it('auth remove --dry-run does NOT delete credentials', async () => {
    // First configure a real profile so there's something to (not) delete.
    await runCli(['setup', '--from-env', '--no-agent'], {
      TESTSPRITE_API_KEY: 'sk-user-keep-me',
      TESTSPRITE_API_URL: baseUrl,
    });
    const credPath = join(tmpHome, '.testsprite', 'credentials');
    expect(existsSync(credPath)).toBe(true);

    const result = await runCli(['auth', 'remove', '--dry-run']);
    expect(result.exitCode).toBe(0);
    expect(existsSync(credPath)).toBe(true);
    expect(result.stderr).toContain('[dry-run]');
    expect(result.stderr).toContain('would remove credentials');
  }, 30_000);
});

/**
 * `result list` / `result get` replaced the six read commands outright: an old
 * invocation gets Commander's own `unknown command` (exit 5) in both output
 * modes, with no hidden alias, and one more line (in JSON, the envelope's
 * `nextAction`) that says where the command went.
 */
describe('the removed read commands are unknown commands', () => {
  const key = () => ({ TESTSPRITE_API_KEY: 'sk-user-subproc', TESTSPRITE_API_URL: baseUrl });

  it.each([
    ['result', ['test_x']],
    ['result', ['test_x', '--history']],
    ['steps', ['test_x']],
    ['diff', ['run_a', 'run_b']],
    ['failure', ['get', 'test_x']],
    ['failure', ['summary', 'test_x']],
    ['failure', ['test_x']],
    ['artifact', ['get', 'run_x']],
    ['artifact', ['run_x']],
  ])(
    'testsprite test %s %j exits 5 as an unknown command that says where it went',
    async (name, rest) => {
      const pointer = `\`test ${name}\` was removed in 0.17.0; ${
        name === 'diff'
          ? 'there is no replacement; compare two `result get` outputs'
          : 'read results with: testsprite result list --test <test-id> | --run <run-id>, and testsprite result get <result-id>'
      }`;
      const text = await runCli(['test', name, ...rest], key());
      expect(text.exitCode, text.stderr).toBe(5);
      expect(text.stdout).toBe('');
      expect(text.stderr).toBe(`error: unknown command '${name}'\n${pointer}\n`);

      const json = await runCli(['--output', 'json', 'test', name, ...rest], key());
      expect(json.exitCode, json.stderr).toBe(5);
      expect(json.stdout).toBe('');
      const envelope = JSON.parse(json.stderr) as {
        error: { code: string; message: string; nextAction: string };
      };
      expect(envelope.error.code).toBe('VALIDATION_ERROR');
      expect(envelope.error.message).toContain(`unknown command '${name}'`);
      expect(envelope.error.nextAction).toBe(pointer);
    },
    30_000,
  );
});

/**
 * The other commands and options removed in 0.17.0 are refused the same way:
 * exit 5, nothing on stdout, no request, and one line saying where each went.
 */
describe('the other removed commands and options say where they went', () => {
  const key = () => ({ TESTSPRITE_API_KEY: 'sk-user-subproc', TESTSPRITE_API_URL: baseUrl });

  it.each([
    [
      ['test', 'create', '--project', 'p_x', '--name', 'n'],
      "unknown command 'create'",
      /testsprite plan .*then testsprite apply$/,
    ],
    [
      ['test', 'rerun', 'test_x', '--wait'],
      "unknown command 'rerun'",
      /testsprite run <test-id\.\.\.>/,
    ],
    [['project', 'sign-in', 'get', 'p_x'], "unknown command 'sign-in'", /project env create/],
    [['ci', 'doctor'], "unknown command 'doctor'", /there is no replacement/],
    [['init'], "unknown command 'init'", /testsprite setup$/],
    [
      ['run', '--all', '--project', 'p_x'],
      "unknown option '--all'",
      /testsprite run --project <project-id>$/,
    ],
    [
      ['project', 'update', 'p_x', '--password=hunter2'],
      "unknown option '--password=[REDACTED]'",
      /testsprite project env update <project-id> <name>/,
    ],
    [
      ['project', 'create', '--name', 'n', '--url=https://u:hunter2@host.example/x'],
      "unknown option '--url=[REDACTED]'",
      /testsprite project env create <project-id>/,
    ],
    [
      ['run', '--project', 'p_x', '--status', 'failed'],
      "unknown option '--status'",
      /testsprite result list --run <run-id> --status failed,blocked lists$/,
    ],
  ])(
    'testsprite %j exits 5 with a pointer',
    async (args, message, pointer) => {
      const before = requestCount;
      const text = await runCli(args, key());
      expect(text.exitCode, text.stderr).toBe(5);
      expect(text.stdout).toBe('');
      const lines = text.stderr.trimEnd().split('\n');
      expect(lines[0]).toBe(`error: ${message}`);
      expect(lines.at(-1)).toMatch(pointer);
      expect(text.stderr).not.toContain('hunter2');

      const json = await runCli(['--output', 'json', ...args], key());
      expect(json.exitCode, json.stderr).toBe(5);
      expect(json.stdout).toBe('');
      const envelope = JSON.parse(json.stderr) as {
        error: { code: string; message: string; nextAction: string };
      };
      expect(envelope.error.code).toBe('VALIDATION_ERROR');
      expect(envelope.error.message).toContain(message);
      expect(envelope.error.nextAction).toBe(lines.at(-1));
      expect(json.stderr).not.toContain('hunter2');
      expect(requestCount).toBe(before);
    },
    30_000,
  );
});

/**
 * [Fix 5] Commander argument/option parse errors → exit 5 (VALIDATION_ERROR family).
 *
 *   - Missing required argument  → exit 5
 *   - Unknown option             → exit 5 (was exit 1 via Commander default before this fix)
 *   - --help / -h                → exit 0  (user requested help — no error)
 *   - --version                  → exit 0  (user requested version — no error)
 */
describe('removed code and schedule read commands', () => {
  it.each([
    ['test', ['code', 'get', 'test_subproc']],
    ['schedule', ['run', 'list', 'schedule_subproc']],
  ] as const)(
    '%s %j is refused before any request or file write',
    async (group, tail) => {
      const destination = join(tmpHome, 'removed-code-output.ts');
      const calls = [
        [group, ...tail, ...(group === 'test' ? ['--out', destination] : [])],
        [group, ...tail, '--dry-run'],
        [group, ...tail, '--help'],
        ['help', group, ...tail],
        [group, '--help', ...tail],
      ];
      const before = requestCount;
      for (const args of calls) {
        for (const mode of ['text', 'json']) {
          const result = await runCli(['--output', mode, ...args], {
            TESTSPRITE_API_KEY: 'sk-user-subproc',
            TESTSPRITE_API_URL: baseUrl,
          });
          expect(result.exitCode, result.stderr).toBe(5);
          expect(result.stdout).toBe('');
          if (mode === 'json') {
            const envelope = JSON.parse(result.stderr);
            expect(envelope.error.code).toBe('VALIDATION_ERROR');
            expect(envelope.error.message).toContain('unknown command');
            expect(envelope.error.nextAction).toMatch(/portal/i);
          } else {
            expect(result.stderr).toContain('unknown command');
            expect(result.stderr).toMatch(/portal/i);
          }
        }
      }
      expect(requestCount).toBe(before);
      expect(existsSync(destination)).toBe(false);
    },
    30_000,
  );
});

describe('[fix-5] Commander parse errors → exit 5; help/version → exit 0', () => {
  it('`test get` with no test-id argument exits 5', async () => {
    const result = await runCli(['test', 'get'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    // Missing required argument is a VALIDATION_ERROR family error → exit 5.
    expect(result.exitCode).toBe(5);
    // Commander writes the error to stderr; it should mention the missing arg.
    expect(result.stderr).toContain('test-id');
  }, 30_000);

  it('`testsprite --help` exits 0', async () => {
    const result = await runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('testsprite');
  }, 30_000);

  it('`testsprite test get --help` exits 0', async () => {
    const result = await runCli(['test', 'get', '--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('test-id');
  }, 30_000);

  it('`testsprite --version` exits 0', async () => {
    const result = await runCli(['--version']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBeTruthy(); // version string on stdout
  }, 30_000);

  it('--output json: missing required arg emits JSON VALIDATION_ERROR envelope, not plain text', async () => {
    // `test get` requires a positional <test-id>. With --output json, the
    // CommanderError must be rendered as a machine-readable JSON envelope so
    // a coding agent parsing stderr does not receive an unexpected plain-text
    // error and crash its JSON.parse.
    const result = await runCli(['--output', 'json', 'test', 'get'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(5);
    let parsed: { error: { code: string; message: string; requestId: string } };
    expect(() => {
      parsed = JSON.parse(result.stderr) as typeof parsed;
    }).not.toThrow();
    expect(parsed!.error.code).toBe('VALIDATION_ERROR');
    expect(parsed!.error.requestId).toBe('local');
    expect(parsed!.error.message).toBeTruthy();
  }, 30_000);

  it('--output json: unknown subcommand emits JSON envelope (--output before bad arg)', async () => {
    // --output json appears before the unknown subcommand, so Commander parses
    // it and program.opts().output is 'json' when the error fires.
    const result = await runCli(['--output', 'json', 'test', 'not-a-real-subcommand'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(5);
    let parsed: { error: { code: string } };
    expect(() => {
      parsed = JSON.parse(result.stderr) as typeof parsed;
    }).not.toThrow();
    expect(parsed!.error.code).toBe('VALIDATION_ERROR');
  }, 30_000);

  it('--output json after bad arg: argv fallback detects json mode and emits envelope', async () => {
    // The error fires before --output json is parsed, so program.opts().output
    // is the default 'text'. The argv fallback scan must still detect json mode.
    const result = await runCli(['test', 'not-a-real-subcommand', '--output', 'json'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(5);
    let parsed: { error: { code: string } };
    expect(() => {
      parsed = JSON.parse(result.stderr) as typeof parsed;
    }).not.toThrow();
    expect(parsed!.error.code).toBe('VALIDATION_ERROR');
  }, 30_000);

  it('text mode: Commander parse error still emits plain text (no regression)', async () => {
    const result = await runCli(['test', 'get'], {
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: baseUrl,
    });
    expect(result.exitCode).toBe(5);
    // Must NOT be a JSON envelope in text mode.
    expect(() => JSON.parse(result.stderr)).toThrow();
    expect(result.stderr).toContain('test-id');
  }, 30_000);
});
