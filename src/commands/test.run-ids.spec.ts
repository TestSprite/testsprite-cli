/**
 * `test run <id> <id> ...` — several explicit ids dispatched through
 * `POST /tests/batch/run`, grouped per project and cut into 50-id requests.
 *
 * All HTTP is a scripted fetch; nothing here touches a real backend.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, InterruptError } from '../lib/errors.js';
import { takeTelemetryExtras } from '../lib/telemetry.js';
import { createTestCommand, runTestRun, runTestRunAll, runTestRunLocalBatch } from './test.js';

afterEach(() => {
  takeTelemetryExtras();
});

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  key: string | null;
}

interface HarnessOptions {
  /** testId → projectId; ids absent from the map answer 404. */
  projects?: Record<string, string>;
  /** Replace the answer to the n-th (0-based) POST /tests/batch/run. */
  batch?: (
    n: number,
    body: Record<string, unknown>,
  ) => Response | Promise<Response> | { throw: unknown } | { hang: true } | undefined;
  /** Extra fields merged into the default batch answer. */
  batchExtra?: (n: number, body: Record<string, unknown>) => Record<string, unknown>;
  /** Status every polled run reports (default `passed`). */
  runStatus?: string;
  /** Answer like a backend that predates `skipDependencies`: the key is never echoed. */
  noSkipDependenciesEcho?: boolean;
  /** The single-run trigger answers 409 run_in_flight for an existing run (auto-resume). */
  singleRunInFlight?: string;
  /** Listing for `GET /tests?projectId=`. */
  listing?: Array<{ id: string; name: string; projectId: string }>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function apiError(status: number, code: string, details: Record<string, unknown> = {}): Response {
  return json(
    {
      error: {
        code,
        message: `${code} from fixture`,
        nextAction: 'fixture next action',
        requestId: 'req_fixture',
        details,
      },
    },
    status,
  );
}

function harness(options: HarnessOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'run-ids-'));
  const credentialsPath = join(dir, 'credentials');

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp path, never user input.
  writeFileSync(
    credentialsPath,
    '[default]\napi_url = https://api.example.com\napi_key = sk-user-test\n',
    { mode: 0o600 },
  );
  const calls: Call[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  let batchCount = 0;
  const projectOf = (id: string): string | undefined =>
    options.projects ? options.projects[id] : 'P';
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const path = url.pathname.replace('/api/cli/v1', '');
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const key = new Headers(init.headers).get('idempotency-key');
    calls.push({ method, path, query: url.searchParams, body, key });
    if (method === 'GET' && /^\/tests\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.split('/')[2]!);
      const projectId = projectOf(id);
      if (projectId === undefined) return apiError(404, 'NOT_FOUND');
      return json({ id, name: id, type: 'backend', projectId, status: 'passed' });
    }
    if (method === 'GET' && path === '/tests') {
      const items = (options.listing ?? []).filter(
        row => row.projectId === url.searchParams.get('projectId'),
      );
      return json({ items, nextToken: null });
    }
    if (method === 'POST' && /^\/tests\/[^/]+\/runs$/.test(path)) {
      if (options.singleRunInFlight !== undefined) {
        return apiError(409, 'CONFLICT', {
          reason: 'run_in_flight',
          currentRunId: options.singleRunInFlight,
        });
      }
      return json({
        runId: `run_${path.split('/')[2]}`,
        status: 'queued',
        enqueuedAt: '2026-10-01T00:00:00Z',
        codeVersion: 'v1',
        targetUrl: 'https://example.com',
        ...(body.skipDependencies === true && !options.noSkipDependenciesEcho
          ? { skipDependencies: true }
          : {}),
      });
    }
    if (method === 'POST' && path === '/tests/batch/run') {
      const n = batchCount++;
      const override = options.batch?.(n, body);
      if (override && 'hang' in override && !(override instanceof Response)) {
        // Never answers: the client's own request timeout has to fire.
        await new Promise((_, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }
      if (override && 'throw' in override && !(override instanceof Response)) {
        throw (override as { throw: unknown }).throw;
      }
      if (override) return override as Response;
      // `--all` names no ids; the fixture project has one runnable test.
      const ids = (body.testIds as string[] | undefined) ?? ['t0'];
      return json({
        accepted: ids.map(id => ({
          testId: id,
          runId: `run_${id}`,
          enqueuedAt: '2026-10-01T00:00:00Z',
        })),
        conflicts: [],
        deferred: [],
        skippedFrontend: [],
        skippedIntegration: [],
        ...(body.skipDependencies === true && !options.noSkipDependenciesEcho
          ? { skipDependencies: true }
          : {}),
        ...(options.batchExtra?.(n, body) ?? {}),
      });
    }
    if (method === 'GET' && path.startsWith('/runs/')) {
      const runId = decodeURIComponent(path.split('/')[2]!);
      const testId = runId.replace(/^run_/, '');
      return json({
        runId,
        testId,
        projectId: projectOf(testId) ?? 'P',
        userId: 'U',
        status: options.runStatus ?? 'passed',
        source: 'cli',
        createdAt: '2026-10-01T00:00:00Z',
        startedAt: '2026-10-01T00:00:01Z',
        finishedAt: '2026-10-01T00:00:02Z',
        codeVersion: 'v1',
        targetUrl: 'https://example.com',
        createdFrom: 'cli',
        failedStepIndex: null,
        failureKind: null,
        error: null,
        videoUrl: null,
        stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 },
      });
    }
    return apiError(404, 'NOT_FOUND');
  }) as typeof fetch;
  const deps = {
    credentialsPath,
    fetchImpl,
    env: {} as NodeJS.ProcessEnv,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    sleep: async () => {},
  };
  const base = {
    profile: 'default',
    output: 'json' as const,
    debug: false,
    wait: false,
    timeoutSeconds: 600,
    maxConcurrency: 5,
  };
  const batchPosts = () => calls.filter(c => c.method === 'POST' && c.path === '/tests/batch/run');
  const cli = (...args: string[]) =>
    new Command('testsprite')
      .option('--output <mode>')
      .addCommand(createTestCommand(deps))
      .parseAsync(['--output', 'json', 'test', ...args], { from: 'user' });
  return { calls, stdout, stderr, deps, base, batchPosts, cli, dir };
}

const ids = (n: number, prefix = 't'): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('run <id> <id>: project grouping', () => {
  it('sends one request per project, each with its own projectId, in first-seen order', async () => {
    const h = harness({ projects: { a: 'P1', b: 'P2', c: 'P1' } });
    await runTestRunAll({ ...h.base, testIds: ['a', 'b', 'c'] }, h.deps);
    const posts = h.batchPosts();
    expect(posts.map(c => c.body.projectId)).toEqual(['P1', 'P2']);
    expect(posts.map(c => c.body.testIds)).toEqual([['a', 'c'], ['b']]);
    expect(posts.every(c => c.body.source === 'cli')).toBe(true);
    const out = JSON.parse(h.stdout[0]!) as { accepted: Array<{ testId: string }> };
    expect(out.accepted.map(a => a.testId)).toEqual(['a', 'c', 'b']);
  });

  it('an unknown id exits 4 before any batch request is sent', async () => {
    const h = harness({ projects: { a: 'P1' } });
    const err = await runTestRunAll({ ...h.base, testIds: ['a', 'ghost'] }, h.deps).catch(e => e);
    expect(err).toMatchObject({ exitCode: 4, code: 'NOT_FOUND' });
    expect(h.batchPosts()).toEqual([]);
  });

  it('an unknown id in a later chunk is found before the first chunk runs', async () => {
    const known = Object.fromEntries(ids(60).map(id => [id, 'P']));
    const h = harness({ projects: known });
    const err = await runTestRunAll({ ...h.base, testIds: [...ids(59), 'ghost'] }, h.deps).catch(
      e => e,
    );
    expect(err).toMatchObject({ exitCode: 4 });
    expect(h.batchPosts()).toEqual([]);
  });

  it('--dry-run makes no request and names the real ids', async () => {
    const h = harness();
    await runTestRunAll({ ...h.base, dryRun: true, testIds: ['a', 'b', 'c'] }, h.deps);
    expect(h.calls).toEqual([]);
    expect(JSON.parse(h.stdout[0]!)).toMatchObject({
      dryRun: true,
      path: '/api/cli/v1/tests/batch/run',
      body: { projectId: '<resolved per test>', testIds: ['a', 'b', 'c'] },
    });
  });

  it('duplicate ids are sent once', async () => {
    const h = harness();
    await runTestRunAll({ ...h.base, testIds: ['a', 'b', 'a'] }, h.deps);
    expect(h.batchPosts()[0]!.body.testIds).toEqual(['a', 'b']);
  });

  it('a backend-only set goes through batch/run even when the default environment is loopback', async () => {
    const h = harness();
    // The action resolves each test first; backend tests never use a tunnel.
    await h.cli('run', 'a', 'b', '--skip-preflight');
    expect(h.batchPosts()).toHaveLength(1);
    expect(h.calls.some(c => c.path === '/tunnel')).toBe(false);
  });

  it('--allow-empty still decides the exit of a several-id batch that dispatches nothing', async () => {
    // A single <test-id> refuses --allow-empty (#376); several ids are a batch,
    // and the flag turns its zero-dispatch exit 5 into exit 0.
    const skipAll = (_n: number, body: Record<string, unknown>) => ({
      accepted: [],
      skippedFrontend: body.testIds as string[],
    });
    const gated = harness({ batchExtra: skipAll });
    await expect(gated.cli('run', 'a', 'b', '--skip-preflight')).rejects.toMatchObject({
      exitCode: 5,
      message: expect.stringContaining('pass --allow-empty to exit 0 intentionally'),
    });
    const allowed = harness({ batchExtra: skipAll });
    await allowed.cli('run', 'a', 'b', '--skip-preflight', '--allow-empty');
    expect(allowed.batchPosts()).toHaveLength(1);
    expect(allowed.stderr.join('\n')).toContain('--allow-empty set — exiting 0');
  });
});

describe('run <id> ...: 50-id chunking', () => {
  it('splits 60 ids into 50 + 10 with distinct, suffixed idempotency keys', async () => {
    const h = harness();
    await runTestRunAll({ ...h.base, testIds: ids(60), idempotencyKey: 'base-key' }, h.deps);
    const posts = h.batchPosts();
    expect(posts.map(c => (c.body.testIds as string[]).length)).toEqual([50, 10]);
    expect(posts.map(c => c.key)).toEqual(['base-key:chunk0', 'base-key:chunk1']);
    const out = JSON.parse(h.stdout[0]!) as { accepted: unknown[] };
    expect(out.accepted).toHaveLength(60);
  });

  it.each([
    [50, [50]],
    [51, [50, 1]],
    [100, [50, 50]],
    [101, [50, 50, 1]],
  ])('cuts %i ids into request sizes %j', async (count, sizes) => {
    const h = harness();
    await runTestRunAll({ ...h.base, testIds: ids(count) }, h.deps);
    expect(h.batchPosts().map(c => (c.body.testIds as string[]).length)).toEqual(sizes);
  });

  it('a single chunk keeps the plain idempotency key', async () => {
    const h = harness();
    await runTestRunAll({ ...h.base, testIds: ids(3), idempotencyKey: 'base-key' }, h.deps);
    expect(h.batchPosts().map(c => c.key)).toEqual(['base-key']);
  });

  it('keeps a 256-char base key within the limit once the chunk suffix is added', async () => {
    const h = harness();
    await runTestRunAll({ ...h.base, testIds: ids(60), idempotencyKey: 'k'.repeat(256) }, h.deps);
    const keys = h.batchPosts().map(c => c.key!);
    expect(keys.every(k => k.length <= 256)).toBe(true);
    expect(keys[0]!.endsWith(':chunk0')).toBe(true);
    expect(keys[1]!.endsWith(':chunk1')).toBe(true);
  });

  it('keeps two long keys that differ only in their tail apart', async () => {
    const keysFor = async (key: string): Promise<string[]> => {
      const h = harness();
      await runTestRunAll({ ...h.base, testIds: ids(60), idempotencyKey: key }, h.deps);
      return h.batchPosts().map(c => c.key!);
    };
    const a = await keysFor('k'.repeat(255) + 'A');
    const b = await keysFor('k'.repeat(255) + 'B');
    expect(a.every(k => k.length <= 256)).toBe(true);
    expect(a[0]).not.toBe(b[0]);
    expect(a[1]).not.toBe(b[1]);
    expect(new Set(a).size).toBe(2);
  });

  it('leaves a key that already fits untouched', async () => {
    const h = harness();
    const key = 'k'.repeat(249);
    await runTestRunAll({ ...h.base, testIds: ids(60), idempotencyKey: key }, h.deps);
    expect(h.batchPosts().map(c => c.key)).toEqual([`${key}:chunk0`, `${key}:chunk1`]);
  });

  it('chunks a --filter match larger than 50 and still resolves one project listing', async () => {
    const listing = ids(60).map(id => ({ id, name: `match ${id}`, projectId: 'P' }));
    const h = harness({ listing });
    await runTestRunAll(
      { ...h.base, projectId: 'P', nameFilter: 'match', idempotencyKey: 'f-key' },
      h.deps,
    );
    expect(h.batchPosts().map(c => (c.body.testIds as string[]).length)).toEqual([50, 10]);
    expect(h.batchPosts().map(c => c.key)).toEqual(['f-key:chunk0', 'f-key:chunk1']);
  });

  it('--all without a filter stays one request with no testIds', async () => {
    const h = harness();
    await runTestRunAll({ ...h.base, projectId: 'P' }, h.deps);
    expect(h.batchPosts()).toHaveLength(1);
    expect('testIds' in h.batchPosts()[0]!.body).toBe(false);
  });

  it('a non-default --env rides on every chunk', async () => {
    const h = harness();
    await runTestRunAll({ ...h.base, testIds: ids(60), environment: 'staging' }, h.deps);
    expect(h.batchPosts().map(c => c.body.environment)).toEqual(['staging', 'staging']);
  });

  it('puts the environment on a two-id batch too', async () => {
    const h = harness();
    await h.cli('run', 'a', 'b', '--env', 'staging', '--skip-preflight');
    expect(h.batchPosts().map(c => c.body.environment)).toEqual(['staging']);
  });
});

describe('run <id> ...: a chunk that fails after others were accepted', () => {
  const sixty = ids(60);

  it.each([
    [402, 'INSUFFICIENT_CREDITS', 12],
    [429, 'RATE_LIMITED', 11],
    [500, 'INTERNAL', 1],
  ])('HTTP %i from chunk 2: one document, the failing exit code', async (status, code, exit) => {
    const h = harness({ batch: n => (n >= 1 ? apiError(status, code) : undefined) });
    const err = (await runTestRunAll({ ...h.base, testIds: sixty }, h.deps).catch(e => e)) as
      ApiError | undefined;
    expect(err).toBeInstanceOf(ApiError);
    expect(err!.exitCode).toBe(exit);
    expect(err!.code).toBe(code);
    // The failing chunk is not retried into a second document.
    expect(h.stdout).toHaveLength(1);
    const doc = JSON.parse(h.stdout[0]!) as {
      accepted: Array<{ runId: string }>;
      notRunTestIds: string[];
    };
    expect(doc.accepted.map(a => a.runId)).toEqual(sixty.slice(0, 50).map(id => `run_${id}`));
    expect(doc.notRunTestIds).toEqual(sixty.slice(50));
    expect(err!.nextAction).toContain('testsprite test wait run_t0');
    expect(err!.nextAction).toContain(sixty[59]!);
    // The accepted runs are left alone: no polling after a dispatch failure.
    expect(h.calls.some(c => c.path.startsWith('/runs/'))).toBe(false);
  });

  it('text mode lists the accepted runs', async () => {
    const h = harness({
      batch: n => (n >= 1 ? apiError(402, 'INSUFFICIENT_CREDITS') : undefined),
    });
    await runTestRunAll({ ...h.base, output: 'text', testIds: sixty }, h.deps).catch(() => {});
    expect(h.stdout).toHaveLength(1);
    expect(h.stdout[0]!.split('\n')).toHaveLength(50);
    expect(h.stdout[0]).toContain('run_t0  accepted');
    expect(h.stderr.join('\n')).toContain('10 tests were not dispatched');
  });

  it('a later chunk that omits the target-url echo still reports the earlier accepted ids', async () => {
    const h = harness({
      batchExtra: n => (n === 0 ? { targetUrl: 'https://app.example.com' } : {}),
    });
    const err = (await runTestRunAll(
      { ...h.base, testIds: ids(51), targetUrl: 'https://app.example.com', skipPreflight: true },
      h.deps,
    ).catch(e => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.details).toMatchObject({ field: 'targetUrl' });
    expect(h.stdout).toHaveLength(1);
    const doc = JSON.parse(h.stdout[0]!) as {
      accepted: Array<{ runId: string }>;
      notRunTestIds: string[];
    };
    expect(doc.accepted.map(a => a.runId)).toEqual(ids(50).map(id => `run_${id}`));
    expect(doc.notRunTestIds).toEqual(['t50']);
    expect(err.nextAction).toContain('testsprite test wait run_t0');
    // The chunk that did not confirm the URL is still cancelled.
    expect(h.calls.some(c => c.method === 'POST' && c.path === '/runs/run_t50/cancel')).toBe(true);
    expect(h.calls.some(c => c.method === 'GET' && c.path.startsWith('/runs/'))).toBe(false);
  });

  it('names a run the dedupe dropped from the partial report', async () => {
    const h = harness({
      batch: (n, body) => {
        if (n >= 2) return apiError(500, 'INTERNAL');
        if (n !== 1) return undefined;
        return json({
          accepted: [
            { testId: 't0', runId: 'run_dup', enqueuedAt: '2026-10-01T00:00:00Z' },
            ...(body.testIds as string[]).map(testId => ({
              testId,
              runId: `run_${testId}`,
              enqueuedAt: '2026-10-01T00:00:00Z',
            })),
          ],
          conflicts: [],
          deferred: [],
          skippedFrontend: [],
          skippedIntegration: [],
        });
      },
    });
    const err = (await runTestRunAll({ ...h.base, testIds: ids(101) }, h.deps).catch(
      e => e,
    )) as ApiError;
    expect(err.exitCode).toBe(1);
    expect(h.stderr.join('\n')).toContain('run_dup');
    expect(err.nextAction).toContain('run_dup');
  });

  it('a request timeout keeps its own exit code and the same partial document', async () => {
    const h = harness({
      batch: n => (n >= 1 ? { hang: true } : undefined),
    });
    const err = await runTestRunAll(
      { ...h.base, testIds: sixty, requestTimeoutMs: 50 },
      h.deps,
    ).catch(e => e);
    expect(err).toMatchObject({ exitCode: 7 });
    expect(h.stdout).toHaveLength(1);
    expect(JSON.parse(h.stdout[0]!).notRunTestIds).toEqual(sixty.slice(50));
  });

  it('writes the summary file and JUnit report with the undispatched ids as skipped rows', async () => {
    const h = harness({ batch: n => (n >= 1 ? apiError(500, 'INTERNAL') : undefined) });
    const summaryFile = join(h.dir, 'summary.json');
    const reportFile = join(h.dir, 'report.xml');
    await runTestRunAll(
      {
        ...h.base,
        wait: true,
        testIds: sixty,
        summaryFile,
        report: 'junit',
        reportFile,
      },
      h.deps,
    ).catch(() => {});

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp path, never user input.
    const summary = JSON.parse(readFileSync(summaryFile, 'utf8')) as {
      skipped: number;
      runs: Array<{ testId: string; status: string }>;
    };
    expect(summary.skipped).toBe(10);
    expect(summary.runs.filter(r => r.status === 'skipped').map(r => r.testId)).toEqual(
      sixty.slice(50),
    );

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp path, never user input.
    const xml = readFileSync(reportFile, 'utf8');
    expect(xml.match(/<skipped/g)).toHaveLength(10);
  });

  it('the first request failing still writes the artifacts and reports every id as not run', async () => {
    const h = harness({ batch: () => apiError(500, 'INTERNAL') });
    const summaryFile = join(h.dir, 'summary.json');
    const reportFile = join(h.dir, 'report.xml');
    const err = await runTestRunAll(
      { ...h.base, wait: true, testIds: sixty, summaryFile, report: 'junit', reportFile },
      h.deps,
    ).catch(e => e);
    expect(err).toMatchObject({ exitCode: 1 });
    expect(JSON.parse(h.stdout[0]!)).toMatchObject({ accepted: [], notRunTestIds: sixty });

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp path, never user input.
    expect(existsSync(summaryFile)).toBe(true);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp path, never user input.
    expect(readFileSync(reportFile, 'utf8').match(/<skipped/g)).toHaveLength(60);
  });

  it('an interrupt between chunks rethrows the same error after reporting what was accepted', async () => {
    const interrupt = new InterruptError('SIGINT');
    const h = harness({ batch: n => (n === 1 ? { throw: interrupt } : undefined) });
    const err = await runTestRunAll({ ...h.base, testIds: sixty }, h.deps).catch(e => e);
    expect(err).toBe(interrupt);
    expect(h.stdout).toHaveLength(1);
    expect(JSON.parse(h.stdout[0]!).notRunTestIds).toEqual(sixty.slice(50));
  });

  it('a single-request failure is rethrown untouched with nothing printed', async () => {
    const h = harness({ batch: () => apiError(500, 'INTERNAL') });
    const err = (await runTestRunAll({ ...h.base, testIds: ids(3) }, h.deps).catch(e => e)) as
      ApiError | undefined;
    expect(err!.nextAction).toBe('fixture next action');
    expect(h.stdout).toEqual([]);
  });
});

describe('run <id> ...: a request that fails mid-batch under --wait', () => {
  const sixty = ids(60);
  const chunk2Fails = (status: number, code: string) =>
    harness({ runStatus: 'failed', batch: n => (n >= 1 ? apiError(status, code) : undefined) });

  it('polls the accepted runs to real verdicts, names the ids never sent and exits with the failed request code', async () => {
    const h = chunk2Fails(429, 'RATE_LIMITED');
    const summaryFile = join(h.dir, 'summary.json');
    const reportFile = join(h.dir, 'report.xml');
    const err = (await runTestRunAll(
      { ...h.base, wait: true, testIds: sixty, summaryFile, report: 'junit', reportFile },
      h.deps,
    ).catch(e => e)) as ApiError;
    // The failed request outranks the failed verdicts (exit 1).
    expect(err).toBeInstanceOf(ApiError);
    expect(err.exitCode).toBe(11);
    expect(h.calls.filter(c => c.method === 'GET' && c.path.startsWith('/runs/'))).not.toHaveLength(
      0,
    );
    expect(h.stdout).toHaveLength(1);
    const doc = JSON.parse(h.stdout[0]!) as {
      accepted: Array<{ runId: string; status: string }>;
      notRunTestIds: string[];
    };
    expect(doc.accepted).toHaveLength(50);
    expect(doc.accepted.every(a => a.status === 'failed')).toBe(true);
    expect(doc.notRunTestIds).toEqual(sixty.slice(50));
    expect(h.stderr.join('\n')).toContain(
      `10 tests were not dispatched: ${sixty.slice(50).join(' ')}`,
    );
    expect(err.nextAction).toContain(sixty[59]!);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp path, never user input.
    const summary = JSON.parse(readFileSync(summaryFile, 'utf8')) as {
      failed: number;
      skipped: number;
      runs: Array<{ testId: string; status: string }>;
    };
    expect(summary.failed).toBe(50);
    expect(summary.skipped).toBe(10);
    expect(summary.runs.filter(r => r.status === 'skipped').map(r => r.testId)).toEqual(
      sixty.slice(50),
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp path, never user input.
    const xml = readFileSync(reportFile, 'utf8');
    expect(xml.match(/<skipped/g)).toHaveLength(10);
    expect(xml.match(/<failure/g)).toHaveLength(50);
  });

  it('a failed request outranks the credits exit and a rate-deferred id, and sends nothing further', async () => {
    const h = harness({
      batch: (n, body) => {
        if (n >= 1) return apiError(412, 'PRECONDITION_FAILED');
        const requested = body.testIds as string[];
        return json({
          accepted: requested.slice(1).map(testId => ({
            testId,
            runId: `run_${testId}`,
            enqueuedAt: '2026-10-01T00:00:00Z',
          })),
          conflicts: [],
          deferred: [{ testId: requested[0]! }],
          skippedFrontend: [],
          skippedIntegration: [],
        });
      },
    });
    const err = await runTestRunAll({ ...h.base, wait: true, testIds: sixty }, h.deps).catch(
      e => e,
    );
    expect(err).toMatchObject({ exitCode: 6, code: 'PRECONDITION_FAILED' });
    // No deferred retry follows a failed request.
    expect(h.batchPosts()).toHaveLength(2);
  });

  it('an unconfirmed target URL on a later chunk still polls the earlier chunk and exits 7', async () => {
    const h = harness({
      batchExtra: n => (n === 0 ? { targetUrl: 'https://app.example.com' } : {}),
    });
    const err = (await runTestRunAll(
      {
        ...h.base,
        wait: true,
        testIds: ids(51),
        targetUrl: 'https://app.example.com',
        skipPreflight: true,
      },
      h.deps,
    ).catch(e => e)) as ApiError;
    expect(err.details).toMatchObject({ field: 'targetUrl' });
    expect(err.exitCode).toBe(7);
    expect(h.calls.some(c => c.method === 'POST' && c.path === '/runs/run_t50/cancel')).toBe(true);
    expect(h.calls.some(c => c.method === 'GET' && c.path === '/runs/run_t0')).toBe(true);
    const doc = JSON.parse(h.stdout[0]!) as {
      accepted: Array<{ status: string }>;
      notRunTestIds: string[];
    };
    expect(doc.accepted.every(a => a.status === 'passed')).toBe(true);
    expect(doc.notRunTestIds).toEqual(['t50']);
  });

  it('names the ids never sent on stdout even when nothing was accepted before the failure', async () => {
    const h = harness({
      batch: (n, body) =>
        n >= 1
          ? apiError(503, 'UNAVAILABLE')
          : json({
              accepted: [],
              conflicts: [],
              deferred: (body.testIds as string[]).map(testId => ({ testId })),
              skippedFrontend: [],
              skippedIntegration: [],
            }),
    });
    const err = (await runTestRunAll({ ...h.base, wait: true, testIds: sixty }, h.deps).catch(
      e => e,
    )) as ApiError;
    expect(err.exitCode).toBe(10);
    expect(h.stdout).toHaveLength(1);
    expect(JSON.parse(h.stdout[0]!).notRunTestIds).toEqual(sixty.slice(50));
  });

  it('writes the artifacts when the earlier chunk only skipped tests and a later one fails', async () => {
    const h = harness({
      batch: (n, body) =>
        n >= 1
          ? apiError(503, 'UNAVAILABLE')
          : json({
              accepted: [],
              conflicts: [],
              deferred: [],
              skippedFrontend: body.testIds as string[],
              skippedIntegration: [],
            }),
    });
    const summaryFile = join(h.dir, 'summary.json');
    const err = (await runTestRunAll(
      { ...h.base, wait: true, testIds: sixty, summaryFile },
      h.deps,
    ).catch(e => e)) as ApiError;
    expect(err.exitCode).toBe(10);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp path, never user input.
    const summary = JSON.parse(readFileSync(summaryFile, 'utf8')) as {
      runs: Array<{ testId: string; status: string }>;
    };
    expect(summary.runs.filter(r => r.status === 'skipped').map(r => r.testId)).toEqual(
      expect.arrayContaining(sixty.slice(50)),
    );
  });

  it('without --wait the accepted runs are still listed and not awaited', async () => {
    const h = chunk2Fails(429, 'RATE_LIMITED');
    const err = (await runTestRunAll({ ...h.base, testIds: sixty }, h.deps).catch(
      e => e,
    )) as ApiError;
    expect(err.exitCode).toBe(11);
    expect(h.calls.some(c => c.path.startsWith('/runs/'))).toBe(false);
  });
});

describe('run <id> ...: reports', () => {
  it('writes a JUnit report even when nothing was accepted, with the skipped ids as rows', async () => {
    const h = harness({
      batchExtra: (_n, body) => ({
        accepted: [],
        skippedFrontend: body.testIds as string[],
      }),
    });
    const reportFile = join(h.dir, 'report.xml');
    const err = await runTestRunAll(
      { ...h.base, wait: true, testIds: ['a', 'b'], report: 'junit', reportFile },
      h.deps,
    ).catch(e => e);
    expect(err).toMatchObject({ exitCode: 5 });

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp path, never user input.
    const xml = readFileSync(reportFile, 'utf8');
    expect(xml).toContain('classname="P"');
    expect(xml.match(/<skipped/g)).toHaveLength(2);
  });

  it('folds frontend-skipped ids into the summary file on a mixed batch', async () => {
    const h = harness({
      batchExtra: (_n, body) => ({
        accepted: [
          {
            testId: (body.testIds as string[])[0],
            runId: 'run_a',
            enqueuedAt: '2026-10-01T00:00:00Z',
          },
        ],
        skippedFrontend: [(body.testIds as string[])[1]],
      }),
    });
    const summaryFile = join(h.dir, 'summary.json');
    await runTestRunAll({ ...h.base, wait: true, testIds: ['a', 'b'], summaryFile }, h.deps);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp path, never user input.
    expect(JSON.parse(readFileSync(summaryFile, 'utf8'))).toMatchObject({
      total: 2,
      passed: 1,
      skipped: 1,
    });
  });

  it('classnames each row with its own project when the ids span projects', async () => {
    const h = harness({ projects: { a: 'P1', b: 'P2' } });
    const reportFile = join(h.dir, 'report.xml');
    await runTestRunAll(
      { ...h.base, wait: true, testIds: ['a', 'b'], report: 'junit', reportFile },
      h.deps,
    );

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp path, never user input.
    const xml = readFileSync(reportFile, 'utf8');
    expect(xml).toMatch(/classname="P1" name="a"/);
    expect(xml).toMatch(/classname="P2" name="b"/);
    expect(xml).toContain('name="testsprite:multiple-projects"');
  });
});

describe('--skip-dependencies', () => {
  it('is sent on a single test run only when asked for', async () => {
    const h = harness();
    const trigger = { ...h.base, testId: 'a', skipPreflight: true };
    await runTestRun({ ...trigger }, h.deps);
    await runTestRun({ ...trigger, skipDependencies: true }, h.deps);
    const bodies = h.calls.filter(c => c.path === '/tests/a/runs').map(c => c.body);
    expect(bodies).toHaveLength(2);
    expect('skipDependencies' in bodies[0]!).toBe(false);
    expect(bodies[1]).toMatchObject({ skipDependencies: true });
  });

  it('a batch answer that does not echo skipDependencies is refused and its runs are cancelled', async () => {
    const h = harness({ noSkipDependenciesEcho: true });
    const err = (await runTestRunAll(
      { ...h.base, testIds: ['a', 'b'], skipDependencies: true },
      h.deps,
    ).catch(e => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.exitCode).toBe(7);
    expect(err.details).toMatchObject({
      field: 'skipDependencies',
      reason: 'skip-dependencies-not-honored',
    });
    expect(err.message).toBe(
      'This backend did not confirm --skip-dependencies, so the accepted runs may also include the test cases they depend on.',
    );
    expect(err.nextAction).not.toContain('rerun');
    // The cancel line names what was unconfirmed, not a target URL that was never sent.
    expect(h.stderr.join('\n')).toContain('cancelling 2 runs the backend did not confirm');
    for (const id of ['a', 'b']) {
      expect(h.calls.some(c => c.method === 'POST' && c.path === `/runs/run_${id}/cancel`)).toBe(
        true,
      );
    }
  });

  it('a batch answer that echoes skipDependencies is accepted, and nothing is checked when it was not sent', async () => {
    const echoed = harness();
    await runTestRunAll(
      { ...echoed.base, testIds: ['a', 'b'], skipDependencies: true },
      echoed.deps,
    );
    const plain = harness({ noSkipDependenciesEcho: true });
    await runTestRunAll({ ...plain.base, testIds: ['a', 'b'] }, plain.deps);
    expect(plain.calls.some(c => c.path.endsWith('/cancel'))).toBe(false);
  });

  it('a single run whose answer does not echo skipDependencies says so on stderr', async () => {
    const h = harness({ noSkipDependenciesEcho: true });
    await runTestRun(
      { ...h.base, testId: 'a', skipPreflight: true, skipDependencies: true },
      h.deps,
    );
    expect(h.stderr).toContain(
      '[advisory] This backend did not confirm --skip-dependencies, so the run may also include the test cases this one depends on, as a Portal run does.',
    );
    expect(h.stderr.join('\n')).not.toContain('closure');
    const ok = harness();
    await runTestRun(
      { ...ok.base, testId: 'a', skipPreflight: true, skipDependencies: true },
      ok.deps,
    );
    expect(ok.stderr.join('\n')).not.toContain('--skip-dependencies');
  });

  it('says nothing about the echo when the single run joined a run already in flight', async () => {
    const h = harness({ singleRunInFlight: 'run_a' });
    await runTestRun(
      { ...h.base, testId: 'a', wait: true, skipPreflight: true, skipDependencies: true },
      h.deps,
    );
    expect(h.stderr.join('\n')).toContain('Auto-resuming');
    expect(h.stderr.join('\n')).not.toContain('did not confirm --skip-dependencies');
  });

  it('is sent on --all and absent by default', async () => {
    const h = harness();
    await runTestRunAll({ ...h.base, projectId: 'P' }, h.deps);
    await runTestRunAll({ ...h.base, projectId: 'P', skipDependencies: true }, h.deps);
    const posts = h.batchPosts();
    expect('skipDependencies' in posts[0]!.body).toBe(false);
    expect(posts[1]!.body.skipDependencies).toBe(true);
  });

  it('shows up in the dry-run body', async () => {
    const h = harness();
    await runTestRunAll(
      { ...h.base, dryRun: true, testIds: ['a', 'b'], skipDependencies: true },
      h.deps,
    );
    expect(JSON.parse(h.stdout[0]!).body.skipDependencies).toBe(true);
  });

  it('parses --skip-dependencies on the run command', async () => {
    const h = harness();
    await h.cli('run', 'a', 'b', '--skip-dependencies', '--skip-preflight');
    expect(h.batchPosts()[0]!.body.skipDependencies).toBe(true);
  });
});

describe('run <id> <id> without a tunnel', () => {
  it('polls for the ordinary 600s default, not the tunnel default', async () => {
    const h = harness({ runStatus: 'running' });
    let nowMs = new Date('2026-10-01T00:00:00Z').getTime();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      // Every read of the clock is one second later, so the poll deadline arrives.
      nowMs += 1000;
      return nowMs;
    });
    try {
      await runTestRunLocalBatch(
        {
          ...h.base,
          testIds: ['a', 'b'],
          all: false,
          wait: true,
          timeoutSeconds: 1200,
          timeoutIsDefault: true,
          skipPreflight: true,
          cancelOnInterrupt: true,
          allowEmpty: false,
        },
        {
          ...h.deps,
          sleep: async () => {},
        },
      ).catch(() => {});
    } finally {
      nowSpy.mockRestore();
    }
    const doc = JSON.parse(h.stdout.at(-1)!) as {
      accepted: Array<{ status: string; error?: { message: string } }>;
    };
    expect(doc.accepted.map(a => a.error?.message)).toEqual([
      'Timed out after 600s',
      'Timed out after 600s',
    ]);
  });

  it.each([[[]], [['--no-wait']]])(
    'a summary file without --wait is refused before anything is dispatched (%j)',
    async extra => {
      const h = harness();
      const summary = join(h.dir, 'summary.json');
      await expect(
        h.cli('run', 'a', 'b', ...extra, '--summary-file', summary, '--skip-preflight'),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(h.calls.some(c => c.method === 'POST')).toBe(false);
    },
  );

  it('warns about, and polls once, a test two chunks both accepted', async () => {
    const h = harness({
      batch: (n, body) =>
        n === 1
          ? json({
              accepted: [
                { testId: 't0', runId: 'run_dup', enqueuedAt: '2026-10-01T00:00:00Z' },
                ...(body.testIds as string[]).map(testId => ({
                  testId,
                  runId: `run_${testId}`,
                  enqueuedAt: '2026-10-01T00:00:00Z',
                })),
              ],
              conflicts: [],
              deferred: [],
              skippedFrontend: [],
              skippedIntegration: [],
            })
          : undefined,
    });
    await runTestRunAll({ ...h.base, testIds: ids(60) }, h.deps);
    expect(h.stderr.join('\n')).toContain('duplicate dispatch');
    const doc = JSON.parse(h.stdout[0]!) as { accepted: Array<{ testId: string }> };
    expect(doc.accepted.filter(a => a.testId === 't0')).toHaveLength(1);
  });
});
