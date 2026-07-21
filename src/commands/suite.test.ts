import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/errors.js';
import type { FetchImpl } from '../lib/http.js';
import {
  buildSuiteGraph,
  loadSuiteManifest,
  runSuiteApply,
  runSuitePlan,
  type SuiteManifest,
} from './suite.js';

function writeSuite(
  tests: Array<Record<string, unknown>>,
  projectId = 'proj_suite_1',
): { dir: string; manifestPath: string; lockPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'testsprite-suite-'));
  for (const test of tests) {
    const codeFile = String(test.codeFile);
    writeFileSync(
      join(dir, codeFile),
      `def test_${String(test.key).replace(/\W/g, '_')}():\n    assert True\n`,
    );
  }
  const manifestPath = join(dir, 'testsprite.suite.json');
  writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, projectId, tests }, null, 2));
  return { dir, manifestPath, lockPath: join(dir, 'testsprite.suite.lock.json') };
}

function common(fetchImpl?: FetchImpl) {
  return {
    profile: 'default',
    output: 'json' as const,
    dryRun: false,
    debug: false,
    verbose: false,
    endpointUrl: 'https://api.example.test',
    fetchImpl,
    env: { TESTSPRITE_API_KEY: 'sk-suite-test' },
    stdout: () => undefined,
    stderr: () => undefined,
    now: () => new Date('2026-07-21T12:00:00.000Z'),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_suite_test' },
  });
}

describe('Suitefile validation and graph compilation', () => {
  it('compiles producer, consumer, and teardown tests into stable waves', () => {
    const { manifestPath } = writeSuite([
      { key: 'auth', name: 'Auth setup', codeFile: 'auth.py', produces: ['token'] },
      {
        key: 'checkout',
        name: 'Checkout',
        codeFile: 'checkout.py',
        consumes: ['token'],
        produces: ['order'],
      },
      {
        key: 'cleanup',
        name: 'Cleanup',
        codeFile: 'cleanup.py',
        consumes: ['order'],
        category: 'teardown',
      },
    ]);

    const loaded = loadSuiteManifest(manifestPath);

    expect(loaded.graph.waves).toEqual([
      { wave: 1, tests: ['auth'] },
      { wave: 2, tests: ['checkout'] },
      { wave: 3, tests: ['cleanup'] },
    ]);
    expect(loaded.graph.edges).toEqual([
      { from: 'auth', to: 'checkout', variable: 'token' },
      { from: 'auth', to: 'cleanup', variable: '$teardown' },
      { from: 'checkout', to: 'cleanup', variable: '$teardown' },
      { from: 'checkout', to: 'cleanup', variable: 'order' },
    ]);
    expect(loaded.graph.producers).toEqual({ order: 'checkout', token: 'auth' });
  });

  it('rejects missing and ambiguous producers before any network access', () => {
    const manifest: SuiteManifest = {
      schemaVersion: 1,
      projectId: 'proj_graph',
      tests: [
        {
          key: 'a',
          name: 'A',
          codeFile: 'a.py',
          produces: ['token'],
          consumes: [],
        },
        {
          key: 'b',
          name: 'B',
          codeFile: 'b.py',
          produces: ['token'],
          consumes: [],
        },
        {
          key: 'c',
          name: 'C',
          codeFile: 'c.py',
          produces: [],
          consumes: ['missing'],
        },
      ],
    };

    try {
      buildSuiteGraph(manifest);
      throw new Error('expected graph validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).nextAction).toMatch(
        /ambiguous producers.*no suite test produces/s,
      );
    }
  });

  it('rejects code paths that escape the Suitefile directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'testsprite-suite-escape-'));
    const manifestPath = join(dir, 'suite.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        projectId: 'proj_escape',
        tests: [{ key: 'escape', name: 'Escape', codeFile: '../secret.py' }],
      }),
    );

    try {
      loadSuiteManifest(manifestPath);
      throw new Error('expected path validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).nextAction).toContain('escapes the Suitefile directory');
    }
  });

  it.runIf(process.platform !== 'win32')('rejects code-file symlinks that escape the suite', () => {
    const parent = mkdtempSync(join(tmpdir(), 'testsprite-suite-symlink-'));
    const suiteDir = join(parent, 'suite');
    mkdirSync(suiteDir);
    writeFileSync(join(parent, 'outside.py'), 'SECRET = True\n');
    symlinkSync(join(parent, 'outside.py'), join(suiteDir, 'linked.py'));
    const manifestPath = join(suiteDir, 'suite.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        projectId: 'proj_escape',
        tests: [{ key: 'escape', name: 'Escape', codeFile: 'linked.py' }],
      }),
    );

    expect(() => loadSuiteManifest(manifestPath)).toThrowError(
      expect.objectContaining({ nextAction: expect.stringContaining('symlink escape') }),
    );
  });

  it('rejects unknown fields instead of silently ignoring manifest typos', () => {
    const { manifestPath } = writeSuite([
      {
        key: 'health',
        name: 'Health',
        codeFile: 'health.py',
        consume: ['misspelled-consumes'],
      },
    ]);

    expect(() => loadSuiteManifest(manifestPath)).toThrowError(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        nextAction: expect.stringContaining('tests[0].consume is not supported'),
      }),
    );
  });
});

describe('suite plan', () => {
  it('provides an offline dry-run plan without credentials or network', async () => {
    const { manifestPath } = writeSuite([{ key: 'health', name: 'Health', codeFile: 'health.py' }]);
    const plan = await runSuitePlan(
      {
        profile: 'default',
        output: 'json',
        dryRun: true,
        debug: false,
        verbose: false,
        manifestPath,
      },
      { stdout: () => undefined, stderr: () => undefined },
    );

    expect(plan.dryRun).toBe(true);
    expect(plan.summary).toEqual({ create: 1, update: 0, noop: 0, conflict: 0 });
  });

  it('plans an update from live metadata and code drift', async () => {
    const { manifestPath } = writeSuite([
      {
        key: 'auth',
        testId: 'test_auth',
        name: 'Auth current',
        codeFile: 'auth.py',
        priority: 'p0',
        produces: ['token'],
      },
    ]);
    const fetchImpl: FetchImpl = async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/tests')) {
        return json({
          items: [
            {
              id: 'test_auth',
              projectId: 'proj_suite_1',
              name: 'Auth old',
              type: 'backend',
              createdFrom: 'cli',
              status: 'ready',
              priority: 'p1',
              produces: [],
              consumes: [],
              category: null,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          nextToken: null,
        });
      }
      if (url.pathname.endsWith('/tests/test_auth/code')) {
        return json({
          testId: 'test_auth',
          language: 'python',
          framework: 'pytest',
          code: 'def test_old():\n    assert False\n',
          codeVersion: 'v7',
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    const plan = await runSuitePlan({ ...common(fetchImpl), manifestPath }, common(fetchImpl));

    expect(plan.summary).toEqual({ create: 0, update: 1, noop: 0, conflict: 0 });
    expect(plan.items[0]).toMatchObject({
      key: 'auth',
      testId: 'test_auth',
      action: 'update',
      changes: ['name', 'priority', 'produces', 'code'],
    });
  });

  it('refuses an implicit adoption when an unmanaged remote test has the same name', async () => {
    const { manifestPath } = writeSuite([{ key: 'health', name: 'Health', codeFile: 'health.py' }]);
    const fetchImpl: FetchImpl = async () =>
      json({
        items: [
          {
            id: 'test_existing',
            projectId: 'proj_suite_1',
            name: 'Health',
            type: 'backend',
            createdFrom: 'portal',
            status: 'ready',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        nextToken: null,
      });

    const plan = await runSuitePlan({ ...common(fetchImpl), manifestPath }, common(fetchImpl));

    expect(plan.items[0]).toMatchObject({ action: 'conflict' });
    expect(plan.items[0]?.reason).toContain('add testId');
  });

  it('times out stalled presigned code downloads using the configured request deadline', async () => {
    const { manifestPath } = writeSuite([
      { key: 'slow', testId: 'test_slow', name: 'Slow', codeFile: 'slow.py' },
    ]);
    const fetchImpl: FetchImpl = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/tests')) {
        return json({
          items: [
            {
              id: 'test_slow',
              projectId: 'proj_suite_1',
              name: 'Slow',
              type: 'backend',
              createdFrom: 'cli',
              status: 'ready',
              produces: [],
              consumes: [],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          nextToken: null,
        });
      }
      if (url.pathname.endsWith('/tests/test_slow/code')) {
        return json({
          testId: 'test_slow',
          language: 'python',
          framework: 'pytest',
          code: 'https://storage.example.test/slow.py',
          codeVersion: 'v1',
        });
      }
      if (url.hostname === 'storage.example.test') {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error('expected a request timeout signal'));
            return;
          }
          const rejectFromAbort = () => reject(signal.reason);
          if (signal.aborted) rejectFromAbort();
          else signal.addEventListener('abort', rejectFromAbort, { once: true });
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };

    await expect(
      runSuitePlan({ ...common(fetchImpl), manifestPath, requestTimeoutMs: 1 }, common(fetchImpl)),
    ).rejects.toMatchObject({ name: 'RequestTimeoutError', timeoutMs: 1_000 });
  });
});

describe('suite apply', () => {
  it('updates an existing test, creates a new test, and writes an atomic lockfile', async () => {
    const { manifestPath, lockPath } = writeSuite([
      {
        key: 'auth',
        testId: 'test_auth',
        name: 'Auth current',
        codeFile: 'auth.py',
        produces: ['token'],
      },
      {
        key: 'checkout',
        name: 'Checkout',
        codeFile: 'checkout.py',
        consumes: ['token'],
      },
    ]);
    const requests: Array<{
      method: string;
      path: string;
      body: unknown;
      idempotencyKey: string | null;
    }> = [];
    const fetchImpl: FetchImpl = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({
        method,
        path: url.pathname,
        body,
        idempotencyKey: headers.get('idempotency-key'),
      });
      if (method === 'GET' && url.pathname.endsWith('/tests')) {
        return json({
          items: [
            {
              id: 'test_auth',
              projectId: 'proj_suite_1',
              name: 'Auth old',
              type: 'backend',
              createdFrom: 'cli',
              status: 'ready',
              produces: [],
              consumes: [],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          nextToken: null,
        });
      }
      if (method === 'GET' && url.pathname.endsWith('/tests/test_auth/code')) {
        return json({
          testId: 'test_auth',
          language: 'python',
          framework: 'pytest',
          code: 'old code',
          codeVersion: 'v2',
        });
      }
      if (method === 'PUT' && url.pathname.endsWith('/tests/test_auth')) {
        return json({ testId: 'test_auth', updatedFields: ['name', 'produces'], updatedAt: 'now' });
      }
      if (method === 'PUT' && url.pathname.endsWith('/tests/test_auth/code')) {
        return json({ testId: 'test_auth', codeVersion: 'v3', updatedAt: 'now' });
      }
      if (method === 'POST' && url.pathname.endsWith('/tests')) {
        return json({
          testId: 'test_checkout',
          type: 'backend',
          codeVersion: 'v1',
          createdAt: 'now',
        });
      }
      throw new Error(`unexpected request: ${method} ${url.pathname}`);
    };

    const result = await runSuiteApply(
      { ...common(fetchImpl), manifestPath, confirm: true },
      common(fetchImpl),
    );

    expect('summary' in result && result.summary).toEqual({ created: 1, updated: 1, unchanged: 0 });
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      entries: Record<string, { testId: string; codeVersion: string }>;
    };
    expect(lock.entries.auth).toMatchObject({ testId: 'test_auth', codeVersion: 'v3' });
    expect(lock.entries.checkout).toMatchObject({ testId: 'test_checkout', codeVersion: 'v1' });
    const mutationKeys = requests
      .filter(request => request.method !== 'GET')
      .map(request => request.idempotencyKey);
    expect(mutationKeys).toHaveLength(3);
    expect(mutationKeys.every(key => key?.startsWith('cli-suite-v1-'))).toBe(true);
  });

  it('requires explicit confirmation before remote mutation', async () => {
    const { manifestPath } = writeSuite([{ key: 'health', name: 'Health', codeFile: 'health.py' }]);
    const fetchImpl: FetchImpl = async () => json({ items: [], nextToken: null });

    await expect(
      runSuiteApply({ ...common(fetchImpl), manifestPath, confirm: false }, common(fetchImpl)),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      nextAction: expect.stringContaining('required to apply 1 suite mutation'),
    });
  });

  it('refuses to apply a plan containing conflicts without sending mutations', async () => {
    const { manifestPath } = writeSuite([{ key: 'health', name: 'Health', codeFile: 'health.py' }]);
    let mutations = 0;
    const fetchImpl: FetchImpl = async (_input, init) => {
      if ((init?.method ?? 'GET') !== 'GET') mutations += 1;
      return json({
        items: [
          {
            id: 'test_existing',
            projectId: 'proj_suite_1',
            name: 'Health',
            type: 'backend',
            createdFrom: 'portal',
            status: 'ready',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        nextToken: null,
      });
    };

    await expect(
      runSuiteApply({ ...common(fetchImpl), manifestPath, confirm: true }, common(fetchImpl)),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      nextAction: expect.stringContaining('plan contains 1 conflict'),
    });
    expect(mutations).toBe(0);
  });

  it('does not churn an unchanged lock entry timestamp on repeated apply', async () => {
    const { manifestPath, lockPath } = writeSuite([
      { key: 'health', name: 'Health', codeFile: 'health.py' },
    ]);
    const createFetch: FetchImpl = async (input, init) => {
      const url = new URL(String(input));
      if ((init?.method ?? 'GET') === 'GET' && url.pathname.endsWith('/tests')) {
        return json({ items: [], nextToken: null });
      }
      if ((init?.method ?? 'GET') === 'POST' && url.pathname.endsWith('/tests')) {
        return json({
          testId: 'test_health',
          type: 'backend',
          codeVersion: 'v1',
          createdAt: 'now',
        });
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url.pathname}`);
    };
    await runSuiteApply(
      { ...common(createFetch), manifestPath, confirm: true },
      common(createFetch),
    );
    const before = readFileSync(lockPath, 'utf8');

    const noopFetch: FetchImpl = async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/tests')) {
        return json({
          items: [
            {
              id: 'test_health',
              projectId: 'proj_suite_1',
              name: 'Health',
              type: 'backend',
              createdFrom: 'cli',
              status: 'ready',
              produces: [],
              consumes: [],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          nextToken: null,
        });
      }
      if (url.pathname.endsWith('/tests/test_health/code')) {
        return json({
          testId: 'test_health',
          language: 'python',
          framework: 'pytest',
          code: 'def test_health():\n    assert True\n',
          codeVersion: 'v1',
        });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    const later = {
      ...common(noopFetch),
      now: () => new Date('2026-07-22T12:00:00.000Z'),
    };
    const result = await runSuiteApply({ ...later, manifestPath, confirm: true }, later);

    expect('summary' in result && result.summary).toEqual({
      created: 0,
      updated: 0,
      unchanged: 1,
    });
    expect(readFileSync(lockPath, 'utf8')).toBe(before);
  });

  it('resumes an unchanged pending create and conflicts if its definition drifted', async () => {
    const { manifestPath, lockPath, dir } = writeSuite([
      { key: 'health', name: 'Health', codeFile: 'health.py' },
    ]);
    const createFetch: FetchImpl = async (input, init) => {
      const url = new URL(String(input));
      if ((init?.method ?? 'GET') === 'GET' && url.pathname.endsWith('/tests')) {
        return json({ items: [], nextToken: null });
      }
      if ((init?.method ?? 'GET') === 'POST' && url.pathname.endsWith('/tests')) {
        return json({
          testId: 'test_health',
          type: 'backend',
          codeVersion: 'v1',
          createdAt: 'now',
        });
      }
      throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url.pathname}`);
    };
    await runSuiteApply(
      { ...common(createFetch), manifestPath, confirm: true },
      common(createFetch),
    );

    const completed = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      entries: Record<string, { desiredHash: string; updatedAt: string }>;
    };
    completed.entries.health = {
      desiredHash: completed.entries.health!.desiredHash,
      createKey: 'cli-suite-v1-create-pending',
      updatedAt: completed.entries.health!.updatedAt,
    } as { desiredHash: string; updatedAt: string };
    writeFileSync(lockPath, JSON.stringify(completed, null, 2));

    const emptyRemote: FetchImpl = async () => json({ items: [], nextToken: null });
    const resumed = await runSuitePlan(
      { ...common(emptyRemote), manifestPath },
      common(emptyRemote),
    );
    expect(resumed.items[0]).toMatchObject({
      action: 'create',
      changes: ['resume pending idempotent create'],
    });

    writeFileSync(join(dir, 'health.py'), 'def test_health():\n    assert False\n');
    const drifted = await runSuitePlan(
      { ...common(emptyRemote), manifestPath },
      common(emptyRemote),
    );
    expect(drifted.items[0]).toMatchObject({ action: 'conflict' });
    expect(drifted.items[0]?.reason).toContain('changed after a create request became pending');
  });
});
