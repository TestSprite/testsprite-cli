import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runTestlistAdd,
  runTestlistCreate,
  runTestlistDelete,
  runTestlistGet,
  runTestlistList,
  runTestlistRemove,
  runTestlistRun,
  runTestlistUpdate,
  waitRequestTimeoutMs,
} from './testlist.js';
import { ApiError, InterruptError } from '../lib/errors.js';
import { ShutdownController } from '../lib/interrupt.js';
import { takeTelemetryExtras } from '../lib/telemetry.js';
import type { CliTestList, CliTestListDetail } from '../lib/testlist.types.js';
import type { CliTestListRunResponse } from '../lib/testlist.types.js';
import type { ResultList } from '../lib/result/types.js';
import { runListing } from '../../test/helpers/project-run.js';
import { resultLine } from '../../test/helpers/result-list.js';

/** Adapt a synchronous route fixture to fetch-compatible JSON responses. */
function makeFetch(
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

/** Provide isolated test credentials through the environment without disk writes. */
function makeCreds(
  apiKey = 'sk-user-test',
  apiUrl = 'http://localhost:13599',
): { env: NodeJS.ProcessEnv } {
  // Headless creds via env (no on-disk credentials file) — mirrors how CI runs
  // the CLI and keeps the test off the filesystem (no fs writes to lint).
  return { env: { TESTSPRITE_API_KEY: apiKey, TESTSPRITE_API_URL: apiUrl } };
}

const DETAIL: CliTestListDetail = {
  id: 'list-1',
  name: 'My list',
  orgId: 'org-1',
  caseCount: 1,
  projectEnvironments: [{ projectId: 'proj-a', environmentName: 'prod' }],
  lastRunId: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
  cases: [
    {
      testId: 'case-a',
      type: 'frontend',
      projectId: 'proj-a',
      projectName: 'Proj A',
      title: 'Login',
      category: null,
      priority: null,
      modified: null,
      status: 'passed',
    },
  ],
  stats: { total: 1, passed: 1, failed: 0, blocked: 0, running: 0 },
  lastRunCreated: null,
};

const base = {
  profile: 'default',
  output: 'json' as const,
  debug: false,
  verbose: false,
  dryRun: false,
};

/** Build a facade error response for command error and interruption assertions. */
function errorBody(code: string, status: number) {
  return { status, body: { error: { code, message: code, requestId: 'r', details: {} } } };
}

describe('testlist commands', () => {
  it('list → GET /testlist, returns items', async () => {
    const { env } = makeCreds();
    let seenUrl = '';
    const fetchImpl = makeFetch((url, init) => {
      seenUrl = url;
      expect(init.method ?? 'GET').toBe('GET');
      return { body: { items: [{ ...DETAIL }] } };
    });
    const stdout: string[] = [];
    const items = await runTestlistList(base, {
      env,
      fetchImpl,
      stdout: l => stdout.push(l),
    });
    expect(seenUrl).toContain('/api/cli/v1/testlist');
    expect(items).toHaveLength(1);
    expect(JSON.parse(stdout.join('\n'))).toHaveLength(1);
  });

  it('get → GET /testlist/:id', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch(url => {
      expect(url).toContain('/testlist/list-1');
      return { body: DETAIL };
    });
    const detail = await runTestlistGet(
      { ...base, listId: 'list-1' },
      { env, fetchImpl, stdout: () => {} },
    );
    expect(detail.cases[0]?.testId).toBe('case-a');
  });

  it('create → POST /testlist with idempotency-key + body, echoes the key to stderr', async () => {
    const { env } = makeCreds();
    let sentBody: unknown;
    let idemKey: string | null = null;
    const fetchImpl = makeFetch((url, init) => {
      expect(init.method).toBe('POST');
      sentBody = JSON.parse(init.body as string);
      idemKey = (init.headers as Record<string, string>)['idempotency-key'] ?? null;
      return { body: DETAIL };
    });
    const stderr: string[] = [];
    await runTestlistCreate(
      { ...base, name: 'My list', projectEnv: ['proj-a:prod'] },
      { env, fetchImpl, stdout: () => {}, stderr: l => stderr.push(l) },
    );
    expect(sentBody).toEqual({
      name: 'My list',
      projectEnvironments: [{ projectId: 'proj-a', environmentName: 'prod' }],
    });
    expect(idemKey).toMatch(/^cli-testlist-create-/);
    expect(stderr.join('\n')).toContain('idempotency-key:');
  });

  it('create without --name → VALIDATION_ERROR (exit 5)', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: DETAIL }));
    const err = (await runTestlistCreate(base, {
      env,
      fetchImpl,
      stdout: () => {},
    }).catch(e => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.exitCode).toBe(5);
  });

  it('create with a malformed --project-env → VALIDATION_ERROR', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: DETAIL }));
    const err = (await runTestlistCreate(
      { ...base, name: 'x', projectEnv: ['no-colon'] },
      { env, fetchImpl, stdout: () => {} },
    ).catch(e => e)) as ApiError;
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('add → POST /testlist/:id/cases with {testIds}', async () => {
    const { env } = makeCreds();
    let url = '';
    let body: unknown;
    const fetchImpl = makeFetch((u, init) => {
      url = u;
      body = JSON.parse(init.body as string);
      return { body: DETAIL };
    });
    await runTestlistAdd(
      { ...base, listId: 'list-1', testIds: ['a', 'b'] },
      { env, fetchImpl, stdout: () => {} },
    );
    expect(url).toContain('/testlist/list-1/cases');
    expect(body).toEqual({ testIds: ['a', 'b'] });
  });

  it('remove → POST /testlist/:id/cases/delete', async () => {
    const { env } = makeCreds();
    let url = '';
    const fetchImpl = makeFetch(u => {
      url = u;
      return { body: DETAIL };
    });
    await runTestlistRemove(
      { ...base, listId: 'list-1', testIds: ['a'] },
      { env, fetchImpl, stdout: () => {} },
    );
    expect(url).toContain('/testlist/list-1/cases/delete');
  });

  it('delete → DELETE /testlist/:id (with --confirm)', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch((url, init) => {
      expect(init.method).toBe('DELETE');
      expect(url).toContain('/testlist/list-1');
      return { body: { listId: 'list-1' } };
    });
    const res = await runTestlistDelete(
      { ...base, listId: 'list-1', confirm: true },
      { env, fetchImpl, stdout: () => {} },
    );
    expect(res.listId).toBe('list-1');
  });

  it('delete without --confirm → VALIDATION_ERROR (exit 5), no network', async () => {
    const { env } = makeCreds();
    let called = false;
    const fetchImpl = makeFetch(() => {
      called = true;
      return { body: { listId: 'list-1' } };
    });
    const err = (await runTestlistDelete(
      { ...base, listId: 'list-1' },
      { env, fetchImpl, stdout: () => {} },
    ).catch(e => e)) as ApiError;
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.exitCode).toBe(5);
    expect(called).toBe(false);
  });

  it('--dry-run returns a sample and never hits the network (list/get/create/delete)', async () => {
    const { env } = makeCreds();
    let called = false;
    const fetchImpl = makeFetch(() => {
      called = true;
      return { body: {} };
    });
    const d = { env, fetchImpl, stdout: () => {}, stderr: () => {} };
    const dry = { ...base, dryRun: true };
    await runTestlistList(dry, d);
    await runTestlistGet({ ...dry, listId: 'x' }, d);
    await runTestlistCreate({ ...dry, name: 'x' }, d);
    // delete --dry-run is exempt from --confirm
    const del = await runTestlistDelete({ ...dry, listId: 'x' }, d);
    expect(del.listId).toBe('x');
    expect(called).toBe(false);
  });

  it('update --clear-project-env sends an empty projectEnvironments (distinct from omit)', async () => {
    const { env } = makeCreds();
    let body: Record<string, unknown> = {};
    const fetchImpl = makeFetch((_url, init) => {
      body = JSON.parse(init.body as string);
      return { body: DETAIL };
    });
    await runTestlistUpdate(
      { ...base, listId: 'list-1', clearProjectEnv: true },
      { env, fetchImpl, stdout: () => {} },
    );
    expect(body.projectEnvironments).toEqual([]);
  });

  it('update --clear-project-env with --project-env → VALIDATION_ERROR', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: DETAIL }));
    const err = (await runTestlistUpdate(
      { ...base, listId: 'list-1', clearProjectEnv: true, projectEnv: ['p:e'] },
      { env, fetchImpl, stdout: () => {} },
    ).catch(e => e)) as ApiError;
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  // The wire names a list's last launch `lastExecutionId`; what is printed
  // calls it a run, like `schedule list` does.
  describe('the last run of a list', () => {
    const RAN = {
      ...DETAIL,
      lastRunId: 'exec_list_9',
      lastRunCreated: '2026-08-03T00:00:00.000Z',
    };
    // A row of `GET /testlist`: no cases, stats or creation time of the last
    // run, which only the detail carries.
    const RAN_ROW: CliTestList = {
      id: RAN.id,
      name: RAN.name,
      orgId: RAN.orgId,
      caseCount: RAN.caseCount,
      projectEnvironments: RAN.projectEnvironments,
      lastRunId: RAN.lastRunId,
      createdAt: RAN.createdAt,
      updatedAt: RAN.updatedAt,
    };
    const print = async (
      command: 'list' | 'get' | 'create' | 'update' | 'add' | 'remove',
      opts: Record<string, unknown> = {},
    ): Promise<string> => {
      const { env } = makeCreds();
      const fetchImpl = makeFetch(url =>
        url.endsWith('/testlist') && command === 'list'
          ? { body: { items: [RAN_ROW] } }
          : { body: RAN },
      );
      const stdout: string[] = [];
      const deps = { env, fetchImpl, stdout: (l: string) => stdout.push(l), stderr: () => {} };
      const common = { ...base, listId: 'list-1', name: 'My list', testIds: ['a'], ...opts };
      if (command === 'list') await runTestlistList(common, deps);
      else if (command === 'get') await runTestlistGet(common, deps);
      else if (command === 'create') await runTestlistCreate(common, deps);
      else if (command === 'update') await runTestlistUpdate(common, deps);
      else if (command === 'add') await runTestlistAdd(common, deps);
      else await runTestlistRemove(common, deps);
      return stdout.join('\n');
    };

    it('testlist list prints lastRunId under LAST RUN', async () => {
      const json = await print('list');
      expect(JSON.parse(json)[0]).toEqual({
        id: 'list-1',
        name: 'My list',
        orgId: 'org-1',
        caseCount: 1,
        projectEnvironments: [{ projectId: 'proj-a', environmentName: 'prod' }],
        lastRunId: 'exec_list_9',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-02T00:00:00.000Z',
      });
      expect(json).not.toContain('xecution');

      const text = await print('list', { output: 'text' });
      const [header, row] = text.split('\n');
      expect(header).toMatch(/^ID\s+NAME\s+CASES\s+LAST RUN\s+UPDATED$/);
      expect(row).toContain('exec_list_9');
      // The id sits under its header.
      expect(row!.indexOf('exec_list_9')).toBe(header!.indexOf('LAST RUN'));
    });

    it('--columns selects it by the key lastrun; the old key is gone', async () => {
      const text = await print('list', { output: 'text', columns: 'id,lastrun' });
      expect(text.split('\n')[0]).toMatch(/^ID\s+LAST RUN$/);
      expect(text).toContain('exec_list_9');
      const err = (await print('list', { output: 'text', columns: 'id,lastexec' }).catch(
        e => e,
      )) as ApiError;
      expect(err.exitCode).toBe(5);
      expect(JSON.stringify(err.details)).toContain('lastrun');
    });

    it.each(['get', 'create', 'update', 'add', 'remove'] as const)(
      'testlist %s prints lastRunId and when that run was created',
      async command => {
        const json = await print(command);
        expect(JSON.parse(json)).toMatchObject({
          lastRunId: 'exec_list_9',
          lastRunCreated: '2026-08-03T00:00:00.000Z',
        });
        expect(json).not.toContain('xecution');
        expect(await print(command, { output: 'text' })).toContain('Last run:  exec_list_9');
      },
    );

    it('a list that never ran: null in JSON, (none) in text', async () => {
      const { env } = makeCreds();
      const stdout: string[] = [];
      const deps = {
        env,
        fetchImpl: makeFetch(() => ({ body: DETAIL })),
        stdout: (l: string) => stdout.push(l),
      };
      await runTestlistGet({ ...base, listId: 'list-1' }, deps);
      expect(JSON.parse(stdout.join('\n'))).toMatchObject({
        lastRunId: null,
        lastRunCreated: null,
      });
      stdout.length = 0;
      await runTestlistGet({ ...base, output: 'text', listId: 'list-1' }, deps);
      expect(stdout.join('\n')).toContain('Last run:  (none)');
    });

    it('the dry-run samples use the same names', async () => {
      const stdout: string[] = [];
      const deps = { stdout: (l: string) => stdout.push(l), stderr: () => {} };
      await runTestlistList({ ...base, dryRun: true }, deps);
      await runTestlistGet({ ...base, dryRun: true, listId: 'list-1' }, deps);
      const printed = stdout.join('\n');
      expect(printed).toContain('"lastRunId": null');
      expect(printed).toContain('"lastRunCreated": null');
      expect(printed).not.toContain('xecution');
    });

    it('the functions still return the list as the backend sent it', async () => {
      const { env } = makeCreds();
      const detail = await runTestlistGet(
        { ...base, listId: 'list-1' },
        { env, fetchImpl: makeFetch(() => ({ body: RAN })), stdout: () => {} },
      );
      expect(detail.lastRunId).toBe('exec_list_9');
    });
  });

  it('list --columns with a bad key → VALIDATION_ERROR (validated up front)', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { items: [] } }));
    const err = (await runTestlistList(
      { ...base, output: 'text' as const, columns: 'nonsense' },
      { env, fetchImpl, stdout: () => {} },
    ).catch(e => e)) as ApiError;
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('update carries a --name-only change (no projectEnvironments key)', async () => {
    const { env } = makeCreds();
    let body: unknown;
    const fetchImpl = makeFetch((url, init) => {
      expect(init.method).toBe('PUT');
      body = JSON.parse(init.body as string);
      return { body: DETAIL };
    });
    await runTestlistUpdate(
      { ...base, listId: 'list-1', name: 'renamed' },
      { env, fetchImpl, stdout: () => {} },
    );
    expect(body).toEqual({ name: 'renamed' });
  });

  it('update parses --project-env pairs and sends them', async () => {
    const { env } = makeCreds();
    let body: unknown;
    const fetchImpl = makeFetch((_url, init) => {
      body = JSON.parse(init.body as string);
      return { body: DETAIL };
    });
    await runTestlistUpdate(
      { ...base, listId: 'list-1', projectEnv: ['proj-a:prod', 'proj-b:staging'] },
      { env, fetchImpl, stdout: () => {} },
    );
    expect(body).toEqual({
      projectEnvironments: [
        { projectId: 'proj-a', environmentName: 'prod' },
        { projectId: 'proj-b', environmentName: 'staging' },
      ],
    });
  });

  it('a FEATURE_GATED envelope maps to exit 13', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch(() => errorBody('FEATURE_GATED', 403));
    const err = (await runTestlistCreate(
      { ...base, name: 'x' },
      { env, fetchImpl, stdout: () => {} },
    ).catch(e => e)) as ApiError;
    expect(err.code).toBe('FEATURE_GATED');
    expect(err.exitCode).toBe(13);
  });

  it('a NOT_FOUND envelope maps to exit 4', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch(() => errorBody('NOT_FOUND', 404));
    const err = (await runTestlistGet(
      { ...base, listId: 'nope' },
      { env, fetchImpl, stdout: () => {} },
    ).catch(e => e)) as ApiError;
    expect(err.code).toBe('NOT_FOUND');
    expect(err.exitCode).toBe(4);
  });
});

const runBase = { ...base, listId: 'list-1', wait: false, timeoutSeconds: 60, maxConcurrency: 10 };
const RUN_ACCEPTED = {
  accepted: [
    {
      testId: 'case-a',
      resultId: 'result-a',
      runId: 'exec-list',
      enqueuedAt: '2026-08-01T00:00:00Z',
    },
  ],
  conflicts: [],
  deferred: [],
};
function nativeList(
  config: {
    response?: CliTestListRunResponse;
    listing?: () => ResultList;
    answer?: (url: URL, init: RequestInit) => { status?: number; body: unknown } | undefined;
    shutdown?: ShutdownController;
    sleep?: () => Promise<void>;
  } = {},
) {
  const stdout: string[] = [],
    stderr: string[] = [],
    calls: Array<{ url: URL; init: RequestInit }> = [];
  const deps = {
    ...makeCreds(),
    shutdown: config.shutdown,
    sleep: config.sleep ?? (async () => {}),
    stdout: (l: string) => {
      stdout.push(l);
    },
    stderr: (l: string) => {
      stderr.push(l);
    },
    fetchImpl: makeFetch((raw, init) => {
      const url = new URL(raw);
      calls.push({ url, init });
      const overridden = config.answer?.(url, init);
      if (overridden) return overridden;
      if (url.pathname.endsWith('/testlist/list-1')) return { body: { ...DETAIL, cases: [] } };
      if (url.pathname.endsWith('/testlist/list-1/run'))
        return { body: config.response ?? RUN_ACCEPTED };
      if (url.pathname.endsWith('/results'))
        return { body: config.listing?.() ?? listing('finished', false, 'PASSED') };
      throw new Error(`Unexpected ${init.method} ${url}`);
    }),
  };
  return { calls, stdout, stderr, deps, output: () => JSON.parse(stdout.join('\n')) };
}
function listing(
  status: 'running' | 'finished',
  cancelled: boolean,
  testStatus: 'PASSED' | 'FAILED' | 'RUNNING',
  late = false,
) {
  const rows = [
    resultLine({
      resultId: 'result-a',
      runId: 'exec-list',
      caseKey: 'case-a',
      title: 'Same title',
      testStatus,
    }),
  ];
  if (late)
    rows.push(
      resultLine({
        resultId: 'result-integration',
        runId: 'exec-list',
        caseKey: 'integration',
        title: 'Same title',
        testStatus: 'FAILED',
      }),
    );
  return runListing({ runId: 'exec-list', projectId: 'proj-a', status, cancelled }, rows);
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  takeTelemetryExtras();
});
describe('native test-list run contracts', () => {
  it.each(['json', 'text'] as const)(
    'non-wait keeps native IDs in %s and sends the selected IDs once',
    async output => {
      const h = nativeList();
      await runTestlistRun({ ...runBase, output, cases: ['case-a'], noWait: true }, h.deps);
      const post = h.calls.filter(c => c.init.method === 'POST');
      expect(post).toHaveLength(1);
      expect(JSON.parse(String(post[0]!.init.body))).toEqual({
        testIds: ['case-a'],
        maxConcurrency: 10,
      });
      expect(h.stdout.join('\n')).toContain('result-a');
      expect(h.stdout.join('\n')).toContain('exec-list');
      expect(h.calls.some(c => c.url.pathname.endsWith('/results'))).toBe(false);
    },
  );
  it('groups a dispatch receipt by run and prints one command to wait for every launch', async () => {
    const h = nativeList({
      response: {
        ...RUN_ACCEPTED,
        accepted: [
          { ...RUN_ACCEPTED.accepted[0]!, testTitle: 'Sign in' },
          {
            testId: 'case-b',
            resultId: 'result-b',
            runId: 'second',
            enqueuedAt: 'now',
            testTitle: 'Search',
          },
          { testId: 'case-c', resultId: 'result-c', runId: 'exec-list', enqueuedAt: 'now' },
        ],
      },
    });
    await runTestlistRun({ ...runBase, output: 'text', noWait: true }, h.deps);
    expect(h.stdout.join('\n').split('\n')).toEqual([
      'Run exec-list  (2 tests)',
      '  result-a  Sign in  dispatched',
      '  result-c  case-c  dispatched',
      'Run second  (1 test)',
      '  result-b  Search  dispatched',
      'testsprite run wait exec-list second',
    ]);
  });
  it("a no-wait receipt prints no Dashboard line: the server's link is on each result, not on the run", async () => {
    const h = nativeList({
      response: {
        ...RUN_ACCEPTED,
        accepted: [
          {
            ...RUN_ACCEPTED.accepted[0]!,
            testTitle: 'Sign in',
            dashboardUrl: 'https://portal.example/result-a',
          },
        ],
      },
    });
    await runTestlistRun({ ...runBase, output: 'text', noWait: true }, h.deps);
    expect(h.stdout.join('\n').split('\n')).toEqual([
      'Run exec-list  (1 test)',
      '  result-a  Sign in  dispatched',
      'testsprite run wait exec-list',
    ]);
  });
  it('waits across the integration gap and includes late same-title results in JUnit and summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-list-'));
    let reads = 0;
    try {
      const h = nativeList({
        listing: () =>
          ++reads === 1
            ? listing('running', false, 'PASSED')
            : listing('finished', false, 'PASSED', true),
      });
      await expect(
        runTestlistRun(
          {
            ...runBase,
            wait: true,
            report: 'junit',
            reportFile: join(dir, 'report.xml'),
            summaryFile: join(dir, 'summary.json'),
          },
          h.deps,
        ),
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(reads).toBe(2);
      expect(h.output().results.map((r: { resultId: string }) => r.resultId)).toEqual([
        'result-a',
        'result-integration',
      ]);
      expect(h.output().summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
      expect(h.output()).not.toHaveProperty('accepted');
      expect(h.output()).not.toHaveProperty('partial');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed report filename inside this test's mkdtemp directory.
      expect(readFileSync(join(dir, 'report.xml'), 'utf8').match(/<testcase /g)).toHaveLength(2);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed summary filename inside this test's mkdtemp directory.
      expect(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).failed).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('--wait text lists a refused member and counts it as not dispatched', async () => {
    const h = nativeList({
      response: {
        ...RUN_ACCEPTED,
        conflicts: [
          {
            testId: 'case-b',
            reason: 'error',
            message: 'Log in once in the Portal, then run again.',
          },
        ],
      },
    });
    await runTestlistRun({ ...runBase, output: 'text', wait: true }, h.deps);
    expect(h.stdout.join('\n').split('\n')).toEqual([
      'Run exec-list  https://example.com',
      '  result-a  Same title  passed',
      '(none)  case-b  Log in once in the Portal, then run again.',
      '1/2 passed, 0 failed, 0 timed out, 1 not dispatched',
    ]);
  });
  it('--wait text closes with the count when every member ran', async () => {
    const h = nativeList();
    await runTestlistRun({ ...runBase, output: 'text', wait: true }, h.deps);
    expect(h.stdout.join('\n').split('\n').at(-1)).toBe('1/1 passed, 0 failed, 0 timed out');
  });
  it('--wait text counts a member still running at an interrupt as running, not failed', async () => {
    const shutdown = new ShutdownController();
    const h = nativeList({
      shutdown,
      listing: () => listing('running', false, 'RUNNING'),
      sleep: async () => {
        shutdown.interrupt('SIGINT');
        throw shutdown.signal.reason;
      },
    });
    await expect(
      runTestlistRun({ ...runBase, output: 'text', wait: true }, h.deps),
    ).rejects.toBeInstanceOf(InterruptError);
    expect(h.stdout.join('\n').split('\n').at(-1)).toBe(
      '0/1 passed, 0 failed, 0 timed out, 1 still running',
    );
  });
  it('writes the last observed verdicts to every CI artifact when interrupted', async () => {
    const shutdown = new ShutdownController();
    const h = nativeList({
      shutdown,
      listing: () => listing('running', false, 'RUNNING', true),
      sleep: async () => {
        shutdown.interrupt('SIGTERM');
        throw shutdown.signal.reason;
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'interrupted-list-'));
    const reportFile = join(dir, 'report.xml');
    const summaryFile = join(dir, 'summary.json');
    const markdown = join(dir, 'job.md');
    try {
      await expect(
        runTestlistRun(
          { ...runBase, wait: true, report: 'junit', reportFile, summaryFile },
          {
            ...h.deps,
            env: { ...h.deps.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: markdown },
          },
        ),
      ).rejects.toMatchObject({ exitCode: 143 });
      const counts = { total: 2, passed: 0, running: 1, failed: 1, skipped: 0 };
      expect(h.output().summary).toMatchObject(counts);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed filenames in this test's temporary directory.
      expect(JSON.parse(readFileSync(summaryFile, 'utf8'))).toMatchObject(counts);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed filename in this test's temporary directory.
      expect(readFileSync(markdown, 'utf8')).toContain('1 still running');
      const annotations = h.stderr.filter(line => line.startsWith('::error'));
      expect(annotations).toHaveLength(1);
      expect(annotations[0]).toContain('status=failed');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed filename in this test's temporary directory.
      const xml = readFileSync(reportFile, 'utf8');
      expect(xml).toContain('tests="2" failures="1" errors="0" skipped="1"');
      expect(xml).toContain('<skipped message="Still running when the wait ended"/>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each([false, true])(
    'fails a cancelled execution with empty results=%s and reports an execution diagnostic',
    async empty => {
      const h = nativeList({
        listing: () => ({
          ...listing('finished', true, 'PASSED'),
          ...(empty ? { results: [] } : {}),
        }),
      });
      await expect(runTestlistRun({ ...runBase, wait: true }, h.deps)).rejects.toMatchObject({
        exitCode: 1,
      });
      expect(h.output().runFailures).toEqual([
        expect.objectContaining({ runId: 'exec-list', status: 'cancelled' }),
      ]);
      expect(h.output().runFailures[0]).not.toHaveProperty('resultId');
      expect(h.output().summary.total).toBe(h.output().results.length);
    },
  );
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'preserves the latest successful snapshot on %s',
    async signal => {
      const shutdown = new ShutdownController();
      const h = nativeList({
        shutdown,
        listing: () => listing('running', false, 'PASSED', true),
        sleep: async () => {
          shutdown.interrupt(signal);
          throw shutdown.signal.reason;
        },
      });
      await expect(runTestlistRun({ ...runBase, wait: true }, h.deps)).rejects.toBeInstanceOf(
        InterruptError,
      );
      expect(h.output()).toMatchObject({
        partial: true,
        results: [
          { resultId: 'result-a', status: 'passed' },
          { resultId: 'result-integration', status: 'failed' },
        ],
      });
      expect(h.stderr.join('\n')).toContain('run wait exec-list');
      expect(
        h.calls.some(c => c.init.method === 'POST' && c.url.pathname.endsWith('/cancel')),
      ).toBe(false);
    },
  );
  it.each([
    { code: 'AUTH_INVALID', status: 401, exitCode: 3 },
    { code: 'AUTH_FORBIDDEN', status: 403, exitCode: 3 },
    { code: 'NOT_FOUND', status: 404, exitCode: 4 },
    { code: 'RATE_LIMITED', status: 429, exitCode: 11 },
  ])(
    'preserves a standing $code failure and partial receipts',
    async ({ code, status, exitCode }) => {
      const raw = {
        code,
        message: 'original message',
        nextAction: 'original action',
        requestId: 'native-error',
        details: { resource: 'run', reason: 'inflight_cap', retryAfterSeconds: 0 },
      };
      const h = nativeList({
        answer: url => (url.pathname.endsWith('/results') ? { status, body: raw } : undefined),
      });
      const err = await runTestlistRun({ ...runBase, wait: true, timeoutSeconds: 0 }, h.deps).catch(
        e => e,
      );
      expect(err).toMatchObject({ exitCode, ...raw });
      expect(h.output()).not.toHaveProperty('partial');
    },
  );
  it('preserves the original outage envelope at the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const raw = {
      code: 'UNAVAILABLE',
      message: 'raw outage',
      nextAction: 'raw server next action',
      requestId: 'outage',
      details: { diagnostic: { runId: 'exec-list', resultId: 'result-a' } },
    };
    const h = nativeList({
      sleep: async () => {
        vi.setSystemTime(Date.now() + 1000);
      },
      answer: url => (url.pathname.endsWith('/results') ? { status: 503, body: raw } : undefined),
    });
    const pending = runTestlistRun({ ...runBase, wait: true, timeoutSeconds: 1 }, h.deps).catch(
      e => e,
    );
    await vi.advanceTimersByTimeAsync(3100);
    const err = await pending;
    expect(err).toMatchObject({ exitCode: 10, ...raw });
    expect(h.output().partial).toBe(true);
  });
  it('rejects an accepted result without its execution instead of polling a result ID', async () => {
    const h = nativeList({
      response: {
        ...RUN_ACCEPTED,
        accepted: [{ testId: 'case-a', resultId: 'result-a', enqueuedAt: 'now' }],
      },
    });
    await expect(runTestlistRun({ ...runBase, wait: true }, h.deps)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      exitCode: 7,
    });
    expect(h.calls.some(c => c.url.pathname.endsWith('/results'))).toBe(false);
  });
  it.each([false, true])(
    'all-conflict wait=%s keeps native resume guidance and exit 6',
    async wait => {
      const h = nativeList({
        response: {
          accepted: [],
          deferred: [],
          conflicts: [
            {
              testId: 'busy',
              currentRunId: 'exec-busy',
              currentResultId: 'result-busy',
              reason: 'in_flight',
            },
          ],
        },
      });
      const err = await runTestlistRun({ ...runBase, wait }, h.deps).catch(e => e);
      expect(err.exitCode).toBe(6);
      expect(err.message).toContain('exec-busy');
      expect(err.message).not.toContain('run wait result-busy');
    },
  );
  it.each([
    { reason: 'insufficient_credits', exitCode: 12 },
    { reason: 'billing_hold', exitCode: 13 },
  ] as const)('maps all $reason refusals', async ({ reason, exitCode }) => {
    const h = nativeList({
      response: { accepted: [], deferred: [], conflicts: [{ testId: 'busy', reason }] },
    });
    await expect(runTestlistRun({ ...runBase, wait: true }, h.deps)).rejects.toMatchObject({
      exitCode,
    });
  });
  it.each([false, true])(
    'partial not-found wait=%s retains accepted work and exits 4',
    async wait => {
      const h = nativeList({ response: { ...RUN_ACCEPTED, notFound: ['missing'] } });
      await expect(runTestlistRun({ ...runBase, wait }, h.deps)).rejects.toMatchObject({
        exitCode: 4,
      });
      expect(h.output().notFound).toEqual(['missing']);
    },
  );
  it.each([false, true])('deferred work wait=%s exits 7 without redispatch', async wait => {
    const h = nativeList({ response: { ...RUN_ACCEPTED, deferred: [{ testId: 'later' }] } });
    await expect(runTestlistRun({ ...runBase, wait }, h.deps)).rejects.toMatchObject({
      exitCode: 7,
    });
    expect(h.calls.filter(c => c.init.method === 'POST')).toHaveLength(1);
  });
  it('does not let report-write failure replace an owed run verdict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-list-report-'));
    const destination = join(dir, 'report.xml');
    try {
      const h = nativeList({
        listing: () => {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- creates a fixed report filename as a directory in this test's mkdtemp directory to simulate a write failure.
          mkdirSync(destination);
          return listing('finished', false, 'FAILED');
        },
      });
      await expect(
        runTestlistRun(
          { ...runBase, wait: true, report: 'junit', reportFile: destination },
          h.deps,
        ),
      ).rejects.toMatchObject({ exitCode: 1 });
      expect(h.stderr.join('\n')).toContain('report');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('a report-write failure cannot replace an all-conflict exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-list-conflict-'));
    const destination = join(dir, 'report.xml');
    try {
      const h = nativeList({
        answer: (url, init) => {
          if (init.method === 'POST' && url.pathname.endsWith('/run')) {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- creates a fixed report filename as a directory in this test's mkdtemp directory to simulate a write failure.
            mkdirSync(destination);
            return {
              body: {
                accepted: [],
                deferred: [],
                conflicts: [
                  {
                    testId: 'busy',
                    reason: 'in_flight',
                    currentRunId: 'exec-busy',
                    currentResultId: 'result-busy',
                  },
                ],
              },
            };
          }
        },
      });
      await expect(
        runTestlistRun(
          { ...runBase, wait: true, report: 'junit', reportFile: destination },
          h.deps,
        ),
      ).rejects.toMatchObject({ exitCode: 6 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('keeps Actions annotations off JSON stdout and records verdict telemetry', async () => {
    const h = nativeList({ listing: () => listing('finished', false, 'FAILED') });
    await expect(
      runTestlistRun(
        { ...runBase, wait: true, ghOutput: true },
        { ...h.deps, env: { ...h.deps.env, GITHUB_ACTIONS: 'true' } },
      ),
    ).rejects.toMatchObject({ exitCode: 1 });
    expect(h.output().summary.failed).toBe(1);
    expect(h.stderr.join('\n')).toContain('::error');
    expect(takeTelemetryExtras()).toMatchObject({ accepted: 1, failed: 1 });
  });
  it.each([true, false])(
    'an empty list is exit 5 after its zero summary is printed (wait=%s)',
    async wait => {
      const h = nativeList({
        response: { accepted: [], conflicts: [], deferred: [], reason: 'empty_list' },
      });
      const error = await runTestlistRun({ ...runBase, wait, noWait: !wait }, h.deps).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toMatchObject({
        exitCode: 5,
        message: expect.stringMatching(/the list is empty.*--allow-empty/),
      });
      expect(h.output()).toMatchObject({ runs: [], results: [], reason: 'empty_list' });
      if (wait) expect(h.output().summary.total).toBe(0);
    },
  );
  it.each([true, false])('--allow-empty keeps an empty list at exit 0 (wait=%s)', async wait => {
    const h = nativeList({
      response: { accepted: [], conflicts: [], deferred: [], reason: 'empty_list' },
    });
    await runTestlistRun({ ...runBase, wait, noWait: !wait, allowEmpty: true }, h.deps);
    expect(h.stderr.join('\n')).toContain('0 tests dispatched (the list is empty); --allow-empty');
  });
  it('a selection that matches nothing in the list is exit 5 too', async () => {
    const h = nativeList({
      response: { accepted: [], conflicts: [], deferred: [], reason: 'no_matching_cases' },
    });
    await expect(runTestlistRun({ ...runBase, wait: true }, h.deps)).rejects.toMatchObject({
      exitCode: 5,
      message: expect.stringContaining('no test in the list matched'),
    });
  });
  it('a case the list does not hold is still exit 4, ahead of the empty gate', async () => {
    const h = nativeList({
      response: { accepted: [], conflicts: [], deferred: [], notFound: ['case-x'] },
    });
    await expect(runTestlistRun({ ...runBase, wait: true }, h.deps)).rejects.toMatchObject({
      exitCode: 4,
    });
  });
  it('dry-run dispatches nothing and writes no report', async () => {
    const h = nativeList();
    await runTestlistRun({ ...runBase, dryRun: true, wait: true, cases: ['case-a'] }, h.deps);
    expect(h.calls).toEqual([]);
    expect(h.output()).toMatchObject({
      dryRun: true,
      runs: [],
      results: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, timedOut: 0 },
      requests: [
        { method: 'POST', path: '/api/cli/v1/testlist/list-1/run', body: { testIds: ['case-a'] } },
      ],
      thenPoll: '/api/cli/v1/results?run=<run-id>&status=passed,failed,running,blocked,cancelled',
    });
    expect(h.output().summary).not.toHaveProperty('results');
  });
  it.each([
    { reportFile: 'x' },
    { reportSuiteName: 'x' },
    { report: 'junit' as const },
    { ghOutput: true },
    { summaryFile: 'x' },
  ])('validates artifact options before dispatch: %j', async options => {
    const h = nativeList();
    await expect(
      runTestlistRun({ ...runBase, noWait: true, ...options }, h.deps),
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(h.calls).toEqual([]);
  });
  it('raises request timeout for the whole wait within the transport bound', () => {
    expect(waitRequestTimeoutMs({ ...runBase, wait: true, timeoutSeconds: 300 })).toBe(305000);
    expect(waitRequestTimeoutMs({ ...runBase, wait: true, timeoutSeconds: 900 })).toBe(600000);
  });
});

describe('test-list unfinished execution artifacts', () => {
  it.each(['gap-timeout', 'read-error', 'empty-timeout'])(
    'represents %s without changing real verdicts',
    async mode => {
      vi.useFakeTimers();
      const dir = mkdtempSync(join(tmpdir(), 'list-gap-report-'));
      const reportFile = join(dir, 'junit.xml');
      let reads = 0;
      const h = nativeList({
        sleep: () => new Promise(resolve => setTimeout(resolve, 3000)),
        answer: url => {
          if (!url.pathname.endsWith('/results')) return;
          if (++reads > 1 && mode === 'read-error')
            return {
              status: 503,
              body: {
                error: {
                  code: 'UNAVAILABLE',
                  message: 'Original list outage',
                  nextAction: 'Server action',
                  requestId: 'list-gap',
                  details: { marker: 'raw' },
                },
              },
            };
          return {
            body: {
              ...listing('running', false, 'PASSED'),
              ...(mode === 'empty-timeout' ? { results: [] } : {}),
            },
          };
        },
      });
      try {
        const pending = runTestlistRun(
          { ...runBase, wait: true, timeoutSeconds: 6, report: 'junit', reportFile },
          h.deps,
        ).catch(e => e);
        await vi.advanceTimersByTimeAsync(8_001);
        const error = await pending;
        expect(error.exitCode).toBe(mode === 'read-error' ? 10 : 7);
        if (mode === 'read-error')
          expect(error).toMatchObject({
            message: 'Original list outage',
            nextAction: 'Server action',
            details: { marker: 'raw' },
          });
        const output = h.output();
        expect(output.summary).toMatchObject({
          total: 1,
          failed: 0,
          timedOut: mode === 'empty-timeout' ? 1 : 0,
        });
        if (mode !== 'empty-timeout') {
          expect(output.results[0]).toMatchObject({ resultId: 'result-a', status: 'passed' });
          expect(output.runFailures).toEqual([
            expect.objectContaining({
              runId: 'exec-list',
              status: mode === 'read-error' ? 'error' : 'timeout',
            }),
          ]);
          expect(output.runFailures[0]).not.toHaveProperty('resultId');
        }
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed report filename inside this test's mkdtemp directory.
        expect(readFileSync(reportFile, 'utf8')).toMatch(/<(failure|error)/);
      } finally {
        vi.useRealTimers();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
