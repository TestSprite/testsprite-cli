/**
 * `test run --all --status`: selection by the latest status of each test case
 * (never an environment-specific one), and the empty-selector usage error
 * shared with `test rerun`.
 * All HTTP goes through an injected fetch; nothing here reaches a real API.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import type { BatchRunFreshResponse } from '../lib/runs.types.js';
import { runTestRerun, runTestRunAll } from './test.js';

function makeCreds(): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-run-status-'));
  const credentialsPath = join(dir, 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp path, never user input.
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp path, never user input.
  writeFileSync(
    credentialsPath,
    '[default]\napi_url = http://localhost:13502\napi_key = sk-user-test\n',
    { mode: 0o600 },
  );
  return { credentialsPath };
}

function disableExits(cmd: Command): void {
  cmd.exitOverride();
  cmd.commands.forEach(disableExits);
}

const EMPTY_BATCH: BatchRunFreshResponse = {
  accepted: [],
  conflicts: [],
  deferred: [],
  skippedFrontend: [],
  skippedIntegration: [],
};

function row(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Test ${id}`,
    projectId: 'project_p',
    type: 'frontend',
    status,
    createdFrom: 'cli',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/** GET /tests answers with `rows(url)`; POST /tests/batch/run accepts every id sent. */
function makeApi(rows: (url: string) => unknown[], respond?: (call: Call) => Response | undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : String((input as URL).toString());
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      ...(init.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
    };
    calls.push(call);
    const custom = respond?.(call);
    if (custom) return custom;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (call.method === 'POST' && url.includes('/tests/batch/run')) {
      const ids = (call.body?.testIds as string[] | undefined) ?? [];
      return json({
        ...EMPTY_BATCH,
        accepted: ids.map(testId => ({
          testId,
          runId: `run_${testId}`,
          enqueuedAt: '2026-01-01T00:00:00.000Z',
        })),
      });
    }
    return json({ items: rows(url), nextToken: null });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const getsOfTests = (calls: Call[]) =>
  calls.filter(c => c.method === 'GET' && new URL(c.url).pathname.endsWith('/tests'));
const batchPosts = (calls: Call[]) => calls.filter(c => c.method === 'POST');

function runOpts(over: Record<string, unknown> = {}) {
  return {
    profile: 'default',
    output: 'json',
    debug: false,
    dryRun: false,
    projectId: 'project_p',
    wait: false,
    timeoutSeconds: 600,
    maxConcurrency: 10,
    ...over,
  } as never;
}

function quiet(stderr: string[] = []) {
  return { stdout: () => undefined, stderr: (l: string) => stderr.push(l), sleep: async () => {} };
}

describe('empty --status selector is a usage error', () => {
  const EMPTY_SELECTORS = ['', '  ', ',', ' , '];

  for (const statusFilter of EMPTY_SELECTORS) {
    it(`test run --all rejects ${JSON.stringify(statusFilter)} before any request`, async () => {
      const { credentialsPath } = makeCreds();
      const api = makeApi(() => []);
      await expect(
        runTestRunAll(runOpts({ statusFilter }), {
          credentialsPath,
          fetchImpl: api.fetchImpl,
          ...quiet(),
        }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        exitCode: 5,
        nextAction: expect.stringContaining('--status needs at least one status'),
        details: expect.objectContaining({ field: 'status' }),
      });
      expect(api.calls).toEqual([]);
    });

    it(`test rerun --all rejects ${JSON.stringify(statusFilter)} before any request`, async () => {
      const { credentialsPath } = makeCreds();
      const api = makeApi(() => []);
      await expect(
        runTestRerun(
          {
            testIds: [],
            all: true,
            projectId: 'project_p',
            statusFilter,
            wait: false,
            timeoutSeconds: 600,
            autoHeal: false,
            autoHealExplicit: false,
            skipDependencies: false,
            maxConcurrency: 10,
            output: 'json',
            profile: 'default',
            dryRun: false,
            debug: false,
            verbose: false,
          },
          { credentialsPath, fetchImpl: api.fetchImpl, ...quiet() },
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        exitCode: 5,
        details: expect.objectContaining({ field: 'status' }),
      });
      expect(api.calls).toEqual([]);
    });
  }

  it('is checked ahead of --dry-run on run and on rerun', async () => {
    const { credentialsPath } = makeCreds();
    const api = makeApi(() => []);
    await expect(
      runTestRunAll(
        runOpts({ statusFilter: ' , ', dryRun: true, targetUrl: 'https://x.example' }),
        {
          credentialsPath,
          fetchImpl: api.fetchImpl,
          ...quiet(),
        },
      ),
    ).rejects.toMatchObject({ exitCode: 5 });
    await expect(
      runTestRerun(
        {
          testIds: [],
          all: true,
          projectId: 'project_p',
          statusFilter: '',
          wait: false,
          timeoutSeconds: 600,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: true,
          debug: false,
          verbose: false,
        },
        { credentialsPath, fetchImpl: api.fetchImpl, ...quiet() },
      ),
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(api.calls).toEqual([]);
  });

  it('the CLI exits 5 for an empty --status on run --all and on rerun --all', async () => {
    const { credentialsPath } = makeCreds();
    const api = makeApi(() => []);
    for (const argv of [
      ['run', '--all', '--project', 'project_p', '--status', ''],
      ['run', '--all', '--project', 'project_p', '--status', ' , '],
      ['rerun', '--all', '--project', 'project_p', '--status', ''],
    ]) {
      const { createTestCommand } = await import('./test.js');
      const test = createTestCommand({ credentialsPath, fetchImpl: api.fetchImpl, ...quiet() });
      disableExits(test);
      await expect(test.parseAsync(argv, { from: 'user' })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        exitCode: 5,
      });
    }
    expect(api.calls).toEqual([]);
  });
});

describe('test run --status guards', () => {
  it('rejects --status without --all, with and without --local, before any request', async () => {
    const { credentialsPath } = makeCreds();
    const api = makeApi(() => []);
    for (const argv of [
      ['run', 'test_x', '--status', 'failed'],
      ['run', 'test_x', '--status', 'failed', '--local', '3000'],
    ]) {
      const { createTestCommand } = await import('./test.js');
      const test = createTestCommand({ credentialsPath, fetchImpl: api.fetchImpl, ...quiet() });
      disableExits(test);
      await expect(test.parseAsync(argv, { from: 'user' })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        exitCode: 5,
        details: expect.objectContaining({ field: 'status' }),
      });
    }
    expect(api.calls).toEqual([]);
  });

  it('rejects an unknown status token before any request', async () => {
    const { credentialsPath } = makeCreds();
    const api = makeApi(() => []);
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand({ credentialsPath, fetchImpl: api.fetchImpl, ...quiet() });
    disableExits(test);
    await expect(
      test.parseAsync(['run', '--all', '--project', 'project_p', '--status', 'bogus'], {
        from: 'user',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(api.calls).toEqual([]);
  });
});

describe('test run --status takes the latest-status vocabulary', () => {
  for (const token of ['draft', 'ready', 'queued', 'running', 'unknown']) {
    it(`rejects ${token} with exit 5 and points at not_run, before any request`, async () => {
      const { credentialsPath } = makeCreds();
      const api = makeApi(() => []);
      const { createTestCommand } = await import('./test.js');
      const test = createTestCommand({ credentialsPath, fetchImpl: api.fetchImpl, ...quiet() });
      disableExits(test);
      await expect(
        test.parseAsync(['run', '--all', '--project', 'project_p', '--status', token], {
          from: 'user',
        }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        exitCode: 5,
        details: expect.objectContaining({ field: 'status' }),
        nextAction: expect.stringContaining('not_run'),
      });
      await expect(
        runTestRunAll(runOpts({ statusFilter: token }), {
          credentialsPath,
          fetchImpl: api.fetchImpl,
          ...quiet(),
        }),
      ).rejects.toMatchObject({
        exitCode: 5,
        nextAction: expect.stringContaining('latest result'),
      });
      expect(api.calls).toEqual([]);
    });
  }

  it('accepts passed, failed, blocked, cancelled and not_run', async () => {
    const { credentialsPath } = makeCreds();
    const api = makeApi(() => []);
    await runTestRunAll(
      runOpts({
        statusFilter: 'passed,failed,blocked,cancelled,not_run',
        dryRun: true,
        targetUrl: 'https://preview.example.com',
        skipPreflight: true,
      }),
      { credentialsPath, fetchImpl: api.fetchImpl, ...quiet() },
    );
    expect(api.calls).toEqual([]);
  });

  it('rerun --status keeps the full public set', async () => {
    const { credentialsPath } = makeCreds();
    const api = makeApi(() => [row('a', 'draft'), row('b', 'queued'), row('c', 'passed')]);
    await runTestRerun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testIds: [],
        all: true,
        projectId: 'project_p',
        statusFilter: 'draft,queued',
        wait: false,
        timeoutSeconds: 600,
        maxConcurrency: 10,
      } as never,
      { credentialsPath, fetchImpl: api.fetchImpl, ...quiet() },
    ).catch(() => undefined);
    const gets = getsOfTests(api.calls);
    expect(gets).toHaveLength(1);
    expect(new URL(gets[0]!.url).searchParams.has('environment')).toBe(false);
    const posts = batchPosts(api.calls);
    expect(JSON.stringify(posts.map(c => c.body))).toContain('"a"');
    expect(JSON.stringify(posts.map(c => c.body))).toContain('"b"');
    expect(JSON.stringify(posts.map(c => c.body))).not.toContain('"c"');
  });
});

describe('test run --all --status selection', () => {
  it('dispatches only the matching ids, resolved by listing the project', async () => {
    const { credentialsPath } = makeCreds();
    const api = makeApi(() => [row('a', 'failed'), row('b', 'passed'), row('c', 'failed')]);
    const stderr: string[] = [];
    await runTestRunAll(runOpts({ statusFilter: 'failed' }), {
      credentialsPath,
      fetchImpl: api.fetchImpl,
      ...quiet(stderr),
    });
    expect(batchPosts(api.calls).map(c => c.body?.testIds)).toEqual([['a', 'c']]);
    expect(stderr.some(l => l.includes('--status filter: skipped 1 test'))).toBe(true);
    // Without an environment the listing request is unchanged.
    expect(getsOfTests(api.calls).every(c => !c.url.includes('environment='))).toBe(true);
  });

  it('still names the ids when every test matches', async () => {
    const { credentialsPath } = makeCreds();
    const api = makeApi(() => [row('a', 'failed'), row('b', 'failed')]);
    await runTestRunAll(runOpts({ statusFilter: 'failed' }), {
      credentialsPath,
      fetchImpl: api.fetchImpl,
      ...quiet(),
    });
    expect(batchPosts(api.calls).map(c => c.body?.testIds)).toEqual([['a', 'b']]);
  });

  it('with --env, lists without environment and selects by the headline status', async () => {
    const { credentialsPath } = makeCreds();
    // --env only picks where to run; the status read ignores it.
    const api = makeApi(() => [
      row('a', 'failed', {
        statusByEnvironment: [
          { environmentId: 'env_s', environmentName: 'staging', status: 'passed' },
        ],
        headlineEnvironment: { id: 'env_d', name: 'default' },
      }),
      row('b', 'passed', {
        statusByEnvironment: [
          { environmentId: 'env_s', environmentName: 'staging', status: 'failed' },
        ],
        headlineEnvironment: { id: 'env_d', name: 'default' },
      }),
    ]);
    await runTestRunAll(runOpts({ statusFilter: 'failed', environment: 'staging' }), {
      credentialsPath,
      fetchImpl: api.fetchImpl,
      ...quiet(),
    });
    const gets = getsOfTests(api.calls);
    expect(gets).toHaveLength(1);
    expect(new URL(gets[0]!.url).searchParams.has('environment')).toBe(false);
    expect(batchPosts(api.calls).map(c => c.body)).toEqual([
      expect.objectContaining({ testIds: ['a'], environment: 'staging' }),
    ]);
  });

  it('not_run selects the tests that never produced a result (draft and ready)', async () => {
    const { credentialsPath } = makeCreds();
    const api = makeApi(() => [
      row('a', 'draft'),
      row('b', 'ready'),
      row('c', 'passed'),
      row('d', 'failed'),
      row('e', 'queued'),
      row('f', 'running'),
      row('g', 'unknown'),
    ]);
    const stderr: string[] = [];
    await runTestRunAll(runOpts({ statusFilter: 'not_run' }), {
      credentialsPath,
      fetchImpl: api.fetchImpl,
      ...quiet(stderr),
    });
    expect(batchPosts(api.calls).map(c => c.body?.testIds)).toEqual([['a', 'b']]);
    expect(stderr.some(l => l.includes('latest status'))).toBe(true);
  });

  it('not_run combines with other latest statuses', async () => {
    const { credentialsPath } = makeCreds();
    const api = makeApi(() => [row('a', 'draft'), row('b', 'blocked'), row('c', 'passed')]);
    await runTestRunAll(runOpts({ statusFilter: 'blocked,not_run' }), {
      credentialsPath,
      fetchImpl: api.fetchImpl,
      ...quiet(),
    });
    expect(batchPosts(api.calls).map(c => c.body?.testIds)).toEqual([['a', 'b']]);
  });

  it('does not add environment to the listing when no status is selected', async () => {
    const { credentialsPath } = makeCreds();
    const api = makeApi(() => [row('a', 'failed'), row('b', 'passed')]);
    await runTestRunAll(runOpts({ nameFilter: 'Test a', environment: 'staging' }), {
      credentialsPath,
      fetchImpl: api.fetchImpl,
      ...quiet(),
    });
    expect(getsOfTests(api.calls).every(c => !c.url.includes('environment='))).toBe(true);
  });

  it('a --status that matches nothing exits 5, is not an empty project, and sends no batch', async () => {
    const { credentialsPath } = makeCreds();
    const api = makeApi(() => [row('a', 'passed')]);
    const stderr: string[] = [];
    await expect(
      runTestRunAll(runOpts({ statusFilter: 'failed' }), {
        credentialsPath,
        fetchImpl: api.fetchImpl,
        ...quiet(stderr),
      }),
    ).rejects.toMatchObject({
      exitCode: 5,
      message: expect.stringContaining('--status failed'),
    });
    expect(batchPosts(api.calls)).toEqual([]);
    expect(stderr.join('\n')).not.toContain('plan generate');
  });

  it('exits 0 for a --status that matches nothing under --allow-empty', async () => {
    const { credentialsPath } = makeCreds();
    const api = makeApi(() => [row('a', 'passed')]);
    await expect(
      runTestRunAll(runOpts({ statusFilter: 'failed', allowEmpty: true }), {
        credentialsPath,
        fetchImpl: api.fetchImpl,
        ...quiet(),
      }),
    ).resolves.toBeUndefined();
    expect(batchPosts(api.calls)).toEqual([]);
  });

  it('does not list the project under --dry-run', async () => {
    const { credentialsPath } = makeCreds();
    const api = makeApi(() => []);
    const out: string[] = [];
    await runTestRunAll(
      runOpts({
        statusFilter: 'failed',
        dryRun: true,
        targetUrl: 'https://preview.example.com',
        skipPreflight: true,
      }),
      {
        credentialsPath,
        fetchImpl: api.fetchImpl,
        stdout: l => out.push(l),
        stderr: () => undefined,
        sleep: async () => {},
      },
    );
    expect(api.calls).toEqual([]);
    expect(JSON.parse(out.join('')).body.testIds).toEqual(['<filtered by --filter/--status>']);
  });
});

describe('help names the five latest statuses and the spec nouns', () => {
  async function helpOf(name: string): Promise<string> {
    const { createTestCommand } = await import('./test.js');
    const cmd = createTestCommand().commands.find(c => c.name() === name)!;
    let out = '';
    cmd.configureOutput({ writeOut: text => (out += text) });
    cmd.outputHelp();
    return out;
  }

  for (const name of ['list', 'delete-batch', 'run']) {
    it(`test ${name} --status lists passed, failed, blocked, cancelled and not_run only`, async () => {
      const lines = (await helpOf(name)).split('\n');
      const start = lines.findIndex(l => /^\s+--status <list>/.test(l));
      const end = lines.findIndex((l, i) => i > start && /^\s+-/.test(l));
      const status = lines.slice(start, end).join(' ');
      for (const value of ['passed', 'failed', 'blocked', 'cancelled', 'not_run']) {
        expect(status).toContain(value);
      }
      for (const old of ['draft', 'ready', 'queued', 'running', 'unknown']) {
        expect(status).not.toMatch(new RegExp(`\\b${old}\\b`));
      }
    });
  }

  it('test run describes --skip-dependencies and queueing with run and result', async () => {
    const help = (await helpOf('run')).replace(/\s+/g, ' ');
    expect(help).toContain(
      '--skip-dependencies Backend test cases only: run without the test cases they depend on',
    );
    expect(help).toContain(
      'Each request starts one run; its results show queued until they start, as in the Portal.',
    );
    expect(help).not.toMatch(/execution|closure/);
  });
});
