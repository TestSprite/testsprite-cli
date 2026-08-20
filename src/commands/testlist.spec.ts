import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
import { ApiError, CLIError } from '../lib/errors.js';
import type { CliTestListDetail } from '../lib/testlist.types.js';
import type { RunResponse } from '../lib/runs.types.js';

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
  lastExecutionId: null,
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
  lastExecutionCreated: null,
};

const base = {
  profile: 'default',
  output: 'json' as const,
  debug: false,
  verbose: false,
  dryRun: false,
};

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

// ── run ──────────────────────────────────────────────────────────────────────

const instantSleep = () => Promise.resolve();

function makeRun(status: string): RunResponse {
  return {
    runId: 'run_abc',
    testId: 'case-a',
    projectId: 'proj-a',
    userId: 'user_1',
    status,
    source: 'cli',
    createdAt: '2026-08-01T00:00:00.000Z',
    startedAt: '2026-08-01T00:00:01.000Z',
    finishedAt: '2026-08-01T00:00:30.000Z',
    codeVersion: 'v1',
    targetUrl: 'https://example.com',
    createdFrom: 'cli',
    failedStepIndex: status === 'failed' ? 2 : null,
    failureKind: status === 'failed' ? 'assertion' : null,
    error: null,
    videoUrl: null,
    stepSummary: { total: 5, completed: 5, passedCount: 5, failedCount: 0 },
    dashboardUrl: 'https://dash.example/o/org-1/projects/proj-a/test-cases/case-a',
  } as RunResponse;
}

const RUN_ACCEPTED = {
  accepted: [{ testId: 'case-a', runId: 'run_abc', enqueuedAt: '2026-08-01T00:00:00.000Z' }],
  conflicts: [] as Array<{ testId: string; currentRunId?: string }>,
  deferred: [] as Array<{ testId: string }>,
};

const runBase = { ...base, wait: false, timeoutSeconds: 600, maxConcurrency: 10 };

describe('testlist run', () => {
  it('non-wait → POST /testlist/:id/run, prints accepted, no --case → empty body', async () => {
    const { env } = makeCreds();
    let seenUrl = '';
    let sentBody: unknown;
    const fetchImpl = makeFetch((url, init) => {
      seenUrl = url;
      expect(init.method).toBe('POST');
      sentBody = JSON.parse(init.body as string);
      return { body: RUN_ACCEPTED };
    });
    const stdout: string[] = [];
    const res = await runTestlistRun(
      { ...runBase, output: 'json' as const, listId: 'list-1' },
      { env, fetchImpl, stdout: l => stdout.push(l) },
    );
    expect(seenUrl).toContain('/testlist/list-1/run');
    expect(sentBody).toEqual({});
    expect(res.accepted).toHaveLength(1);
  });

  it('--case filters send a testIds body', async () => {
    const { env } = makeCreds();
    let sentBody: unknown;
    const fetchImpl = makeFetch((_url, init) => {
      sentBody = JSON.parse(init.body as string);
      return { body: RUN_ACCEPTED };
    });
    await runTestlistRun(
      { ...runBase, listId: 'list-1', cases: ['case-a', 'case-b'] },
      { env, fetchImpl, stdout: () => {} },
    );
    expect(sentBody).toEqual({ testIds: ['case-a', 'case-b'] });
  });

  it('a PARTIAL --case miss dispatches the matched subset, warns on stderr, and exits 4', async () => {
    const { env } = makeCreds();
    const stderr: string[] = [];
    const fetchImpl = makeFetch(() => ({
      body: { ...RUN_ACCEPTED, notFound: ['ghost', 'gone'] },
    }));
    const err = (await runTestlistRun(
      { ...runBase, output: 'json' as const, listId: 'list-1', cases: ['case-a', 'ghost', 'gone'] },
      { env, fetchImpl, stdout: () => {}, stderr: l => stderr.push(l) },
    ).catch(e => e)) as CLIError;
    // The matched case still dispatched (warned on stderr), but the run did not
    // cover every requested id → exit 4 so a mistyped/renamed case fails CI
    // instead of passing green.
    expect(stderr.join('\n')).toContain('2 --case id(s) not in this list, skipped: ghost gone');
    expect(err).toBeInstanceOf(CLIError);
    expect(err.exitCode).toBe(4);
  });

  it('non-wait all-conflict (nothing dispatched) → exit 6', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: {
        accepted: [],
        conflicts: [{ testId: 'case-a', currentRunId: 'run_prev' }],
        deferred: [],
      },
    }));
    const err = (await runTestlistRun(
      { ...runBase, listId: 'list-1' },
      { env, fetchImpl, stdout: () => {} },
    ).catch(e => e)) as CLIError;
    expect(err).toBeInstanceOf(CLIError);
    expect(err.exitCode).toBe(6);
  });

  it('nothing dispatched (empty list) returns without throwing', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { accepted: [], conflicts: [], deferred: [], reason: 'empty_list' },
    }));
    const res = await runTestlistRun(
      { ...runBase, listId: 'list-1' },
      { env, fetchImpl, stdout: () => {} },
    );
    expect(res.reason).toBe('empty_list');
  });

  it('--wait all-conflict (nothing dispatched) → exit 6 (the gate is not skipped under --wait)', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch((_url, init) => {
      // POST returns all-conflict; there is no runId to poll.
      expect(init.method ?? 'GET').toBe('POST');
      return {
        body: {
          accepted: [],
          conflicts: [{ testId: 'case-a', currentRunId: 'run_prev' }],
          deferred: [],
        },
      };
    });
    const err = (await runTestlistRun(
      { ...runBase, listId: 'list-1', wait: true },
      { env, fetchImpl, stdout: () => {}, sleep: instantSleep },
    ).catch(e => e)) as CLIError;
    expect(err).toBeInstanceOf(CLIError);
    expect(err.exitCode).toBe(6);
  });

  it('gh-output: an all-conflict --wait run emits annotations + summary before exiting 6', async () => {
    const { env } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-testlist-conflict-'));
    const summaryFile = join(dir, 'summary.json');
    const stdout: string[] = [];
    const fetchImpl = makeFetch(() => ({
      body: {
        accepted: [],
        conflicts: [{ testId: 'case-a', currentRunId: 'run_prev' }],
        deferred: [],
      },
    }));
    const err = (await runTestlistRun(
      {
        ...runBase,
        output: 'text' as const,
        listId: 'list-1',
        wait: true,
        ghOutput: true,
        summaryFile,
      },
      { env, fetchImpl, stdout: l => stdout.push(l), stderr: () => {}, sleep: instantSleep },
    ).catch(e => e)) as CLIError;
    expect(err.exitCode).toBe(6);
    // The exit-6 is surfaced in CI (annotation + summary file), not a bare throw.
    expect(stdout.some(l => l.startsWith('::error') && l.includes('case-a'))).toBe(true);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads this test's own mkdtempSync temp file, never user input.
    const artifact = JSON.parse(readFileSync(summaryFile, 'utf8')) as {
      total: number;
      passed: number;
      failed: number;
      runs: { testId: string; status: string }[];
    };
    expect(artifact).toMatchObject({ total: 1, passed: 0, failed: 1 });
    expect(artifact.runs.some(r => r.testId === 'case-a' && r.status === 'conflict')).toBe(true);
  });

  it('gh-output: all-conflict + a partial --case miss reports BOTH the conflict and the notFound in the artifact', async () => {
    const { env } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-testlist-conflict-nf-'));
    const summaryFile = join(dir, 'summary.json');
    const stdout: string[] = [];
    // Mixed --case: one matched id already in flight (conflict), one id not in
    // the list (notFound). Nothing dispatched → exit 6, but the CI artifact must
    // still name the full requested set, not just the conflict.
    const fetchImpl = makeFetch(() => ({
      body: {
        accepted: [],
        conflicts: [{ testId: 'case-a', currentRunId: 'run_prev' }],
        deferred: [],
        notFound: ['ghost'],
      },
    }));
    const err = (await runTestlistRun(
      {
        ...runBase,
        output: 'text' as const,
        listId: 'list-1',
        cases: ['case-a', 'ghost'],
        wait: true,
        ghOutput: true,
        summaryFile,
      },
      { env, fetchImpl, stdout: l => stdout.push(l), stderr: () => {}, sleep: instantSleep },
    ).catch(e => e)) as CLIError;
    expect(err.exitCode).toBe(6);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads this test's own mkdtempSync temp file, never user input.
    const artifact = JSON.parse(readFileSync(summaryFile, 'utf8')) as {
      total: number;
      failed: number;
      runs: { testId: string; status: string }[];
    };
    // Both non-dispatched members appear as non-passed rows (conflict + not_found).
    expect(artifact).toMatchObject({ total: 2, failed: 2 });
    expect(artifact.runs.some(r => r.testId === 'case-a' && r.status === 'conflict')).toBe(true);
    expect(artifact.runs.some(r => r.testId === 'ghost' && r.status === 'not_found')).toBe(true);
    expect(stdout.some(l => l.startsWith('::error') && l.includes('ghost'))).toBe(true);
  });

  it('all-conflict WITHOUT --wait under GITHUB_ACTIONS: emits nothing (the all-conflict emit is --wait-gated)', async () => {
    const { env } = makeCreds();
    // Auto-enable is on, but the run is non-wait: the all-conflict emit is
    // guarded by `if (opts.wait)`, so it must stay silent — the "non-wait never
    // emits CI artifacts" rule, on the branch this PR adds.
    env.GITHUB_ACTIONS = 'true';
    const stdout: string[] = [];
    const stderr: string[] = [];
    const fetchImpl = makeFetch(() => ({
      body: {
        accepted: [],
        conflicts: [{ testId: 'case-a', currentRunId: 'run_prev' }],
        deferred: [],
      },
    }));
    const err = (await runTestlistRun(
      { ...runBase, output: 'text' as const, listId: 'list-1' }, // runBase.wait is false
      {
        env,
        fetchImpl,
        stdout: l => stdout.push(l),
        stderr: l => stderr.push(l),
        sleep: instantSleep,
      },
    ).catch(e => e)) as CLIError;
    expect(err.exitCode).toBe(6);
    expect(stdout.some(l => l.startsWith('::error'))).toBe(false);
    expect(stderr.some(l => l.startsWith('::error'))).toBe(false);
  });

  it('--wait on an empty list flows through the tail (emits the summary, exit 0) — artifacts not skipped', async () => {
    const { env } = makeCreds();
    const stderr: string[] = [];
    const fetchImpl = makeFetch(() => ({
      body: { accepted: [], conflicts: [], deferred: [], reason: 'empty_list' },
    }));
    const res = await runTestlistRun(
      { ...runBase, listId: 'list-1', wait: true },
      { env, fetchImpl, stdout: () => {}, stderr: l => stderr.push(l), sleep: instantSleep },
    );
    // Reaching the fan-out/summary tail (not the old early-return) is what makes
    // a requested --report junit emit an empty-suite report.
    expect(stderr.join('\n')).toContain('Test-list run complete: 0/0 passed');
    expect(res.reason).toBe('empty_list');
  });

  it('--wait polls each runId to terminal; all passed → returns, no throw', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'POST') return { body: RUN_ACCEPTED };
      expect(url).toContain('/runs/run_abc');
      return { body: makeRun('passed') };
    });
    const res = await runTestlistRun(
      { ...runBase, listId: 'list-1', wait: true },
      { env, fetchImpl, stdout: () => {}, sleep: instantSleep },
    );
    expect(res.accepted).toHaveLength(1);
  });

  it('--wait with a failed run → exit 1', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'POST') return { body: RUN_ACCEPTED };
      return { body: makeRun('failed') };
    });
    const err = (await runTestlistRun(
      { ...runBase, listId: 'list-1', wait: true },
      { env, fetchImpl, stdout: () => {}, sleep: instantSleep },
    ).catch(e => e)) as CLIError;
    expect(err).toBeInstanceOf(CLIError);
    expect(err.exitCode).toBe(1);
  });

  it('gh-output: under Actions with --output json, ::error:: goes to stderr, stdout stays parseable JSON', async () => {
    const { env } = makeCreds();
    env.GITHUB_ACTIONS = 'true';
    const stdout: string[] = [];
    const stderr: string[] = [];
    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'POST') return { body: RUN_ACCEPTED };
      return { body: makeRun('failed') };
    });
    const err = (await runTestlistRun(
      { ...runBase, output: 'json' as const, listId: 'list-1', wait: true },
      {
        env,
        fetchImpl,
        stdout: l => stdout.push(l),
        stderr: l => stderr.push(l),
        sleep: instantSleep,
      },
    ).catch(e => e)) as CLIError;
    expect(err.exitCode).toBe(1);
    // The machine envelope on stdout stays parseable; annotations divert to stderr.
    const payload = JSON.parse(stdout.join('\n')) as { accepted?: unknown[] };
    expect(Array.isArray(payload.accepted)).toBe(true);
    expect(stdout.some(l => l.startsWith('::error'))).toBe(false);
    const annotations = stderr.filter(l => l.startsWith('::error'));
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toContain('case-a');
  });

  it('gh-output: --gh-output --summary-file writes the reduced artifact + step-summary table (with the dashboard link) even though the gate exits 1', async () => {
    const { env } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-testlist-gh-'));
    const summaryFile = join(dir, 'summary.json');
    // Pin the $GITHUB_STEP_SUMMARY sink end-to-end: without this the whole
    // job-summary-table half of the flag is unexercised (a no-op appendFile
    // keeps the suite green).
    const stepSummary = join(dir, 'step-summary.md');
    env.GITHUB_STEP_SUMMARY = stepSummary;
    const stdout: string[] = [];
    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'POST') return { body: RUN_ACCEPTED };
      return { body: makeRun('failed') };
    });
    const err = (await runTestlistRun(
      {
        ...runBase,
        output: 'text' as const,
        listId: 'list-1',
        wait: true,
        ghOutput: true,
        summaryFile,
      },
      { env, fetchImpl, stdout: l => stdout.push(l), stderr: () => {}, sleep: instantSleep },
    ).catch(e => e)) as CLIError;
    expect(err.exitCode).toBe(1);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads this test's own mkdtempSync-created temp file, never user input.
    const artifact = JSON.parse(readFileSync(summaryFile, 'utf8')) as {
      total: number;
      passed: number;
      failed: number;
      runs: { dashboardUrl?: string }[];
    };
    expect(artifact).toMatchObject({ total: 1, passed: 0, failed: 1 });
    // The run's dashboard link is carried through to the reduced summary row.
    expect(artifact.runs[0]?.dashboardUrl).toBe(
      'https://dash.example/o/org-1/projects/proj-a/test-cases/case-a',
    );
    // Forced annotations (off-Actions) land on the text stdout, carrying the link.
    expect(stdout.some(l => l.startsWith('::error') && l.includes('dash.example'))).toBe(true);
    // The job-summary markdown table landed at $GITHUB_STEP_SUMMARY (the sink that
    // was otherwise never asserted), with the dashboard link in its Run column.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads this test's own mkdtempSync-created temp file, never user input.
    const stepMd = readFileSync(stepSummary, 'utf8');
    expect(stepMd).toContain('dash.example');
    expect(stepMd).toMatch(/\|/);
  });

  it('--report junit without --wait → VALIDATION_ERROR', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: RUN_ACCEPTED }));
    const err = (await runTestlistRun(
      { ...runBase, listId: 'list-1', report: 'junit', reportFile: '/tmp/x.xml' },
      { env, fetchImpl, stdout: () => {} },
    ).catch(e => e)) as ApiError;
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('--gh-output without --wait → VALIDATION_ERROR, no network (silent no-op is the bug it prevents)', async () => {
    const { env } = makeCreds();
    let called = false;
    const fetchImpl = makeFetch(() => {
      called = true;
      return { body: RUN_ACCEPTED };
    });
    const err = (await runTestlistRun(
      { ...runBase, listId: 'list-1', ghOutput: true },
      { env, fetchImpl, stdout: () => {} },
    ).catch(e => e)) as ApiError;
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(called).toBe(false);
  });

  it('--summary-file without --wait → VALIDATION_ERROR, no network', async () => {
    const { env } = makeCreds();
    let called = false;
    const fetchImpl = makeFetch(() => {
      called = true;
      return { body: RUN_ACCEPTED };
    });
    const err = (await runTestlistRun(
      { ...runBase, listId: 'list-1', summaryFile: '/tmp/x.json' },
      { env, fetchImpl, stdout: () => {} },
    ).catch(e => e)) as ApiError;
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(called).toBe(false);
  });

  it('GITHUB_ACTIONS auto-enable without --wait stays silent — only the EXPLICIT flags are gated', async () => {
    const { env } = makeCreds();
    env.GITHUB_ACTIONS = 'true';
    const stdout: string[] = [];
    const fetchImpl = makeFetch(() => ({ body: RUN_ACCEPTED }));
    // No --wait and no explicit --gh-output: the auto-enable must NOT trip the
    // guard (mirrors `test run`, whose auto-enable is silent without --wait).
    const res = await runTestlistRun(
      { ...runBase, output: 'json' as const, listId: 'list-1' },
      { env, fetchImpl, stdout: l => stdout.push(l) },
    );
    expect(res.accepted).toHaveLength(1);
    expect(stdout.some(l => l.startsWith('::error'))).toBe(false);
  });

  it('gh-output: a not-found --case member is folded into the CI summary (not "1/1 passed")', async () => {
    const { env } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-testlist-nf-'));
    const summaryFile = join(dir, 'summary.json');
    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'POST')
        return { body: { ...RUN_ACCEPTED, notFound: ['ghost'] } };
      return { body: makeRun('passed') };
    });
    const err = (await runTestlistRun(
      {
        ...runBase,
        output: 'text' as const,
        listId: 'list-1',
        cases: ['case-a', 'ghost'],
        wait: true,
        ghOutput: true,
        summaryFile,
      },
      { env, fetchImpl, stdout: () => {}, stderr: () => {}, sleep: instantSleep },
    ).catch(e => e)) as CLIError;
    // The dispatched case passed, but the not-found member is not lost: it folds
    // into the summary as a non-passed row and the run still exits 4.
    expect(err).toBeInstanceOf(CLIError);
    expect(err.exitCode).toBe(4);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads this test's own mkdtempSync temp file, never user input.
    const artifact = JSON.parse(readFileSync(summaryFile, 'utf8')) as {
      total: number;
      passed: number;
      failed: number;
      runs: { testId: string; status: string; error?: string }[];
    };
    expect(artifact).toMatchObject({ total: 2, passed: 1, failed: 1 });
    const notFoundRow = artifact.runs.find(r => r.testId === 'ghost');
    expect(notFoundRow?.status).toBe('not_found');
    // The cause is testlist-specific — NOT `test rerun`'s "no replayable run".
    expect(notFoundRow?.error).toBe('not a member of this list (not dispatched)');
  });

  it('--dry-run never hits the network', async () => {
    const { env } = makeCreds();
    let called = false;
    const fetchImpl = makeFetch(() => {
      called = true;
      return { body: RUN_ACCEPTED };
    });
    await runTestlistRun(
      { ...runBase, dryRun: true, listId: 'list-1' },
      { env, fetchImpl, stdout: () => {}, stderr: () => {} },
    );
    expect(called).toBe(false);
  });

  it('a NOT_FOUND envelope maps to exit 4', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch(() => errorBody('NOT_FOUND', 404));
    const err = (await runTestlistRun(
      { ...runBase, listId: 'nope' },
      { env, fetchImpl, stdout: () => {} },
    ).catch(e => e)) as ApiError;
    expect(err.code).toBe('NOT_FOUND');
    expect(err.exitCode).toBe(4);
  });

  it('non-wait with deferred members → exit 7 (incomplete batch, not a silent success)', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: {
        accepted: [{ testId: 'case-a', runId: 'run_a', enqueuedAt: 't' }],
        conflicts: [],
        deferred: [{ testId: 'case-b' }],
      },
    }));
    const err = (await runTestlistRun(
      { ...runBase, listId: 'list-1' },
      { env, fetchImpl, stdout: () => {} },
    ).catch(e => e)) as CLIError;
    expect(err).toBeInstanceOf(CLIError);
    expect(err.exitCode).toBe(7);
  });

  it('--wait with deferred members → exit 7 (checked before the pass/fail gates)', async () => {
    const { env } = makeCreds();
    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        return {
          body: {
            accepted: [{ testId: 'case-a', runId: 'run_abc', enqueuedAt: 't' }],
            conflicts: [],
            deferred: [{ testId: 'case-b' }],
          },
        };
      }
      return { body: makeRun('passed') };
    });
    const err = (await runTestlistRun(
      { ...runBase, listId: 'list-1', wait: true },
      { env, fetchImpl, stdout: () => {}, sleep: instantSleep },
    ).catch(e => e)) as CLIError;
    expect(err).toBeInstanceOf(CLIError);
    expect(err.exitCode).toBe(7);
  });

  it('waitRequestTimeoutMs raises the request timeout to cover --timeout under --wait', () => {
    // Non-wait: unchanged (no raise).
    expect(waitRequestTimeoutMs({ wait: false, timeoutSeconds: 600 })).toBeUndefined();
    // --wait: covers timeoutSeconds*1000 + 5s cushion, above the 120s default.
    expect(waitRequestTimeoutMs({ wait: true, timeoutSeconds: 300 })).toBe(305_000);
    // Capped at the 600s request-timeout max.
    expect(waitRequestTimeoutMs({ wait: true, timeoutSeconds: 600 })).toBe(600_000);
    // A small --timeout floors at the 120s default (never lowers it).
    expect(waitRequestTimeoutMs({ wait: true, timeoutSeconds: 30 })).toBe(120_000);
  });
});
