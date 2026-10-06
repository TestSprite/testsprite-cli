import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, InterruptError } from '../lib/errors.js';
import { ShutdownController, type ShutdownHandle } from '../lib/interrupt.js';
import { takeTelemetryExtras } from '../lib/telemetry.js';
import {
  createTestCommand,
  runTestRun,
  runTestRerun,
  runCreateBatch,
  runCreateFromPlan,
  runList,
  runCreate as runTestCreate,
  runTestRunLocalBatch,
  tunnelInterruptNextAction,
} from './test.js';
import { runTestlistRun } from './testlist.js';
import { assertLocalPortListening } from '../lib/local-target.js';
import type * as LocalTargetModule from '../lib/local-target.js';
import { ErrCode, type TunnelClientOptions } from '../vendor/tunnel-client/index.js';

vi.mock('../lib/local-target.js', async importOriginal => ({
  ...(await importOriginal<typeof LocalTargetModule>()),
  assertLocalPortListening: vi.fn(async () => {}),
}));

const clientId = '11111111-2222-3333-4444-555555555555';
const savedUrl = 'http://127.0.0.1:5173/';
const common = { profile: 'default', output: 'json' as const, debug: false };
function fixture(
  options: {
    url?: string;
    type?: 'frontend' | 'backend';
    envStatus?: number;
    echo?: boolean;
    mintStatus?: number;
    triggerStatus?: number;
    batchResponse?: (body: Record<string, unknown>) => Record<string, unknown>;
    envs?: Array<Record<string, unknown>>;
    envsByProject?: Record<string, Array<Record<string, unknown>>>;
    tests?: Array<Record<string, unknown>>;
    poll?: (id: string) => Record<string, unknown>;
    pollStatus?: number;
    shutdown?: ShutdownHandle;
    onTrigger?: () => void;
    start?: () => Promise<void>;
  } = {},
) {
  const credentialsPath = join(mkdtempSync(join(tmpdir(), 'env-tunnel-')), 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture-owned temporary directory.
  writeFileSync(
    credentialsPath,
    '[default]\napi_url = https://api.example.com\napi_key = sk-user-test\n',
  );
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const error = (status: number, reason: string) =>
    json(
      {
        error: {
          code: status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR',
          message: reason,
          nextAction: 'testsprite test run a --local 5173',
          requestId: 'r',
          details: { reason },
        },
      },
      status,
    );
  const url = options.url ?? savedUrl;
  const type = options.type ?? 'frontend';
  const test = (id: string) =>
    options.tests?.find(row => row.id === id) ?? {
      id,
      name: id,
      type,
      projectId: 'P',
      status: 'passed',
      createdFrom: 'cli',
      updatedAt: '2026-10-01',
    };
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const parsed = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const path = parsed.pathname.replace('/api/cli/v1', '');
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method, path, body });
    if (method === 'GET' && /^\/projects\/[^/]+\/env$/.test(path)) {
      if (options.envStatus) return error(options.envStatus, 'environments unavailable');
      return json({
        environments: options.envsByProject?.[path.split('/')[2]!] ??
          options.envs ?? [{ id: 'E', name: 'saved', url, isDefault: true, isTemporary: false }],
      });
    }
    if (method === 'GET' && path === '/tests')
      return json({ items: options.tests ?? [test('a'), test('b')], nextToken: null });
    if (method === 'GET' && /^\/tests\/[^/]+$/.test(path))
      return json(test(path.split('/').at(-1)!));
    if (method === 'GET' && path === '/testlist/L')
      return json({
        id: 'L',
        projectEnvironments: [{ projectId: 'P', environmentName: 'saved' }],
        cases: options.tests?.map(row => ({ ...row, testId: row.id })) ?? [
          { testId: 'a', type, projectId: 'P' },
        ],
      });
    if (method === 'POST' && path === '/tests')
      return json({
        testId: 'a',
        projectId: 'P',
        type: 'frontend',
        name: 'a',
        createdAt: '2026-10-01',
        createdFrom: 'cli',
      });
    if (method === 'POST' && path === '/tests/batch')
      return json({
        summary: { total: 2, created: 2, failed: 0 },
        results: [
          { specIndex: 0, status: 'created', testId: 'a' },
          { specIndex: 1, status: 'created', testId: 'b' },
        ],
      });
    if (method === 'POST' && path === '/tunnel')
      return options.mintStatus
        ? error(options.mintStatus, 'missing_scope')
        : json(
            {
              clientId,
              secret: 'fixture-secret',
              controlUrl: 'ws://tunnel.example/ws',
              tunnelAddr: 'tunnel.example:7400',
              expiresAt: '2026-10-02T00:00:00Z',
            },
            201,
          );
    if (method === 'DELETE' && path === `/tunnel/${clientId}`)
      return new Response(null, { status: 204 });
    if (method === 'POST' && path.endsWith('/cancel'))
      return json({
        runId: path.split('/')[2],
        testId: path.split('/')[2]!.replace('run_', ''),
        projectId: 'P',
        userId: 'U',
        status: 'cancelled',
        source: 'cli',
        createdAt: '2026-10-01',
        startedAt: null,
        finishedAt: null,
        codeVersion: 'v1',
        targetUrl: url,
        createdFrom: 'cli',
        failedStepIndex: null,
        failureKind: null,
        error: null,
        videoUrl: null,
        stepSummary: { total: 1, completed: 0, passedCount: 0, failedCount: 0 },
        alreadyCancelled: false,
      });
    if (
      method === 'POST' &&
      (path.endsWith('/runs') || path.endsWith('/rerun') || path.endsWith('/run'))
    ) {
      options.onTrigger?.();
      if (options.echo !== false && body.tunnelClientId && !body.targetUrl)
        return error(400, 'tunnel-target-required');
      if (options.triggerStatus) return error(options.triggerStatus, 'tunnel-public-environment');
      const echo = options.echo === false ? {} : { tunnelClientId: body.tunnelClientId };
      if (
        path === '/testlist/L/run' ||
        path === '/tests/batch/rerun' ||
        path === '/tests/batch/run'
      )
        return json({
          accepted: ((body.testIds as string[]) ?? ['a']).map(id => ({
            testId: id,
            runId: `run_${id}`,
            enqueuedAt: '2026-10-01T00:00:00Z',
          })),
          conflicts: [],
          deferred: [],
          closure: { byProject: [] },
          ...(path === '/tests/batch/run' ? { skippedFrontend: [], skippedIntegration: [] } : {}),
          ...echo,
          ...(options.batchResponse?.(body) ?? {}),
        });
      return json({
        runId: `run_${path.split('/')[2]}`,
        status: 'queued',
        enqueuedAt: '2026-10-01T00:00:00Z',
        codeVersion: 'v1',
        targetUrl: body.targetUrl ?? url,
        autoHeal: false,
        ...echo,
      });
    }
    if (method === 'GET' && path.startsWith('/runs/') && options.pollStatus)
      return error(options.pollStatus, 'not_found');
    if (method === 'GET' && path.startsWith('/runs/'))
      return json({
        runId: path.split('/')[2],
        testId: path.split('/')[2]!.replace('run_', ''),
        projectId: 'P',
        userId: 'U',
        status: 'passed',
        source: 'cli',
        createdAt: '2026-10-01T00:00:00Z',
        startedAt: '2026-10-01T00:00:01Z',
        finishedAt: '2026-10-01T00:00:02Z',
        codeVersion: 'v1',
        targetUrl: url,
        createdFrom: 'cli',
        failedStepIndex: null,
        failureKind: null,
        error: null,
        videoUrl: null,
        stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 },
        ...(options.poll?.(path.split('/')[2]!) ?? {}),
      });
    return error(404, 'missing route');
  });
  let tunnelOptions: TunnelClientOptions | undefined;
  const stop = vi.fn(async () => {});
  const deps = {
    credentialsPath,
    fetchImpl,
    shutdown: options.shutdown,
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    sleep: async () => {},
    createTunnelClient: (optionsForClient: TunnelClientOptions) => {
      tunnelOptions = optionsForClient;
      return { start: options.start ?? (async () => {}), stop };
    },
  };
  const run = (...args: string[]) =>
    new Command('testsprite')
      .option('--output <mode>')
      .addCommand(createTestCommand(deps))
      .parseAsync(['--output', 'json', 'test', ...args], { from: 'user' });
  return {
    calls,
    stdout,
    stderr,
    deps,
    stop,
    run,
    credentialsPath,
    failTunnel: () =>
      tunnelOptions?.onError?.({ code: ErrCode.AuthFailed, message: 'fixture revoked' }),
  };
}

afterEach(() => {
  vi.clearAllMocks();
  takeTelemetryExtras();
});

describe('environment tunnel resolution', () => {
  it('opens a tunnel for the default environment, preserves its URL verbatim and forces wait', async () => {
    const f = fixture();
    await runTestRun(
      { ...common, testId: 'a', wait: false, timeoutSeconds: 10, skipPreflight: false },
      f.deps,
    );
    expect(f.calls.find(c => c.path === '/tests/a/runs')?.body).toMatchObject({
      targetUrl: savedUrl,
      tunnelClientId: clientId,
    });
    expect(assertLocalPortListening).toHaveBeenCalledWith(
      '127.0.0.1',
      5173,
      expect.anything(),
      expect.anything(),
    );
    expect(f.calls.some(c => c.path === '/runs/run_a')).toBe(true);
    expect(f.calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/tunnel/${clientId}` });
    expect(f.stderr.some(line => line.includes('Environment "saved" is on this machine'))).toBe(
      true,
    );
    expect(f.stdout).toHaveLength(1);
  });
  it.each([403, 404])(
    'falls back without tunnel fields when env list returns %s',
    async envStatus => {
      const f = fixture({ envStatus });
      await runTestRun({ ...common, testId: 'a', wait: false, timeoutSeconds: 10 }, f.deps);
      expect(f.calls.find(c => c.path === '/tests/a/runs')?.body).toEqual({ source: 'cli' });
      expect(f.calls.some(c => c.path === '/tunnel')).toBe(false);
    },
  );
  it('keeps backend runs on the ordinary path', async () => {
    const f = fixture({ type: 'backend' });
    await runTestRun({ ...common, testId: 'a', wait: false, timeoutSeconds: 10 }, f.deps);
    expect(f.calls.find(c => c.path === '/tests/a/runs')?.body).toEqual({ source: 'cli' });
  });
  it('explicit --no-wait keeps the old path and gives a tunnel hint', async () => {
    const f = fixture();
    await f.run('run', 'a', '--no-wait');
    expect(f.calls.find(c => c.path === '/tests/a/runs')?.body).toEqual({ source: 'cli' });
    expect(f.stderr.join('\n')).toContain('drop --no-wait');
  });
  it('--local preserves the matching saved 127.0.0.1 host', async () => {
    const f = fixture();
    await f.run('run', 'a', '--local', '5173', '--skip-preflight');
    expect(f.calls.find(c => c.path === '/tests/a/runs')?.body.targetUrl).toBe(
      'http://127.0.0.1:5173',
    );
  });
  it('routes a loopback --target-url through the existing tunnel path', async () => {
    const f = fixture();
    await f.run('run', 'a', '--target-url', 'http://localhost:3000/', '--skip-preflight');
    expect(f.calls.find(c => c.path === '/tests/a/runs')?.body).toMatchObject({
      targetUrl: 'http://localhost:3000/',
      tunnelClientId: clientId,
    });
  });
  it('keeps a public target override on the ordinary path', async () => {
    const f = fixture();
    await f.run('run', 'a', '--target-url', 'https://preview.example.com', '--skip-preflight');
    expect(f.calls.find(c => c.path === '/tests/a/runs')?.body).toEqual({
      source: 'cli',
      targetUrl: 'https://preview.example.com',
    });
    expect(f.calls.some(c => c.path === '/tunnel')).toBe(false);
  });
  it('renders an old public-environment refusal and deletes its tunnel', async () => {
    const f = fixture({ url: 'https://example.com', triggerStatus: 400 });
    await expect(
      f.run('run', 'a', '--env', 'saved', '--local', '3000', '--skip-preflight'),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'tunnel-public-environment',
      nextAction: 'testsprite test run a --local 5173',
    });
    expect(f.calls.at(-1)?.method).toBe('DELETE');
  });
  it('several ids automatically share one tunnel', async () => {
    const f = fixture();
    await f.run('run', 'a', 'b', '--skip-preflight');
    expect(f.calls.filter(c => c.path === '/tunnel')).toHaveLength(1);
    expect(
      f.calls
        .filter(c => c.method === 'POST' && c.path.endsWith('/runs'))
        .map(c => c.body.tunnelClientId),
    ).toEqual([clientId, clientId]);
  });
  it('--all automatically uses the tunnel batch pool', async () => {
    const f = fixture();
    await f.run('run', '--all', '--project', 'P', '--skip-preflight');
    expect(f.calls.filter(c => c.path === '/tunnel')).toHaveLength(1);
    expect(f.calls.filter(c => c.method === 'POST' && c.path.endsWith('/runs'))).toHaveLength(2);
    expect(JSON.parse(f.stdout[0]!)).toMatchObject({ maxConcurrency: 5 });
  });
  it('rerun passes the tunnel and verifies the server echo', async () => {
    const f = fixture();
    await runTestRerun(
      {
        ...common,
        testIds: ['a'],
        all: false,
        wait: false,
        timeoutSeconds: 10,
        maxConcurrency: 5,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
      },
      f.deps,
    );
    expect(f.calls.find(c => c.path === '/tests/a/runs/rerun')?.body.tunnelClientId).toBe(clientId);
    expect(f.calls.at(-1)?.method).toBe('DELETE');
  });
  it('cancels an old-server rerun that omitted the tunnel echo', async () => {
    const f = fixture({ echo: false });
    await expect(
      runTestRerun(
        {
          ...common,
          testIds: ['a'],
          all: false,
          wait: false,
          timeoutSeconds: 10,
          maxConcurrency: 5,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
        },
        f.deps,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(f.calls.some(c => c.path === '/runs/run_a/cancel')).toBe(true);
    expect(f.calls.at(-1)?.method).toBe('DELETE');
  });
  it('testlist run opens the same tunnel for its bound environment', async () => {
    const f = fixture();
    await runTestlistRun(
      { ...common, listId: 'L', wait: false, timeoutSeconds: 10, maxConcurrency: 5 },
      f.deps,
    );
    expect(f.calls.find(c => c.path === '/testlist/L/run')?.body.tunnelClientId).toBe(clientId);
    expect(f.calls.at(-1)?.method).toBe('DELETE');
  });
  it('cancels old-server test-list runs missing the tunnel echo', async () => {
    const f = fixture({ echo: false });
    await expect(
      runTestlistRun(
        { ...common, listId: 'L', wait: false, timeoutSeconds: 10, maxConcurrency: 5 },
        f.deps,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(f.calls.some(c => c.path === '/runs/run_a/cancel')).toBe(true);
  });
  it('appends the environment column after the legacy test-list columns', async () => {
    const f = fixture({ url: 'https://example.com' });
    await runList({ ...common, output: 'text', projectId: 'P' }, f.deps);
    expect(f.stdout[0]!.split('\n')[0]!.trim().split(/\s+/)).toEqual([
      'ID',
      'NAME',
      'TYPE',
      'FROM',
      'STATUS',
      'UPDATED',
      'ENV',
    ]);
    const [header, row] = f.stdout[0]!.split('\n');
    expect(header!.indexOf('ENV')).toBe(row!.lastIndexOf('  -') + 2);
  });
  it('create from plan --run uses the saved environment tunnel and probes the port', async () => {
    const f = fixture();
    const planPath = join(mkdtempSync(join(tmpdir(), 'env-plan-')), 'plan.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture-owned temporary directory.
    writeFileSync(
      planPath,
      JSON.stringify({
        projectId: 'P',
        type: 'frontend',
        name: 'a',
        planSteps: [{ type: 'action', description: 'Open the app' }],
      }),
    );
    await runCreateFromPlan(
      { ...common, planFrom: planPath, run: true, wait: false, skipPreflight: false },
      f.deps,
    );
    expect(f.calls.find(c => c.path === '/tests/a/runs')?.body).toMatchObject({
      targetUrl: savedUrl,
      tunnelClientId: clientId,
    });
    expect(assertLocalPortListening).toHaveBeenCalledWith(
      '127.0.0.1',
      5173,
      expect.objectContaining({ skipPreflight: false, environmentName: 'saved' }),
      expect.anything(),
    );
    expect(f.stdout).toHaveLength(1);
  });
  it('create-batch --run shares a tunnel and preserves the results envelope', async () => {
    const f = fixture();
    const plans = join(mkdtempSync(join(tmpdir(), 'env-plans-')), 'plans.jsonl');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture-owned temporary directory.
    writeFileSync(
      plans,
      ['a', 'b']
        .map(name =>
          JSON.stringify({
            projectId: 'P',
            type: 'frontend',
            name,
            planSteps: [{ type: 'action', description: 'Open the app' }],
          }),
        )
        .join('\n'),
    );
    await runCreateBatch(
      { ...common, plans, run: true, wait: false, environment: ' saved ', skipPreflight: true },
      f.deps,
    );
    expect(f.calls.filter(c => c.path === '/tunnel')).toHaveLength(1);
    expect(
      f.calls
        .filter(c => c.method === 'POST' && c.path.endsWith('/runs'))
        .map(c => c.body.tunnelClientId),
    ).toEqual([clientId, clientId]);
    expect(JSON.parse(f.stdout[0]!)).toMatchObject({
      results: [
        { testId: 'a', status: 'passed' },
        { testId: 'b', status: 'passed' },
      ],
    });
  });

  it('records local only when this invocation opened a tunnel', async () => {
    const f = fixture();
    await f.run('run', 'a', '--skip-preflight');
    expect(takeTelemetryExtras()).toMatchObject({ local: true });
    const publicRun = fixture({ url: 'https://example.com' });
    await publicRun.run('run', 'a', '--skip-preflight');
    expect(takeTelemetryExtras().local).toBeUndefined();
  });
  it('a tunnel scope refusal names run:tunnel and starts no test', async () => {
    const f = fixture({ mintStatus: 403 });
    await expect(f.run('run', 'a', '--skip-preflight')).rejects.toMatchObject({
      nextAction: expect.stringContaining('run:tunnel'),
    });
    expect(f.calls.some(c => c.path.endsWith('/runs') && c.method === 'POST')).toBe(false);
  });
  it('--local-host overrides a saved host preference', async () => {
    const f = fixture();
    await f.run('run', 'a', '--local', '5173', '--local-host', '::1', '--skip-preflight');
    expect(f.calls.find(c => c.path === '/tests/a/runs')?.body.targetUrl).toBe('http://[::1]:5173');
  });
  it('an explicit loopback environment host wins even when the requested port differs', async () => {
    const f = fixture();
    await f.run('run', 'a', '--env', 'saved', '--local', '3000', '--skip-preflight');
    expect(f.calls.find(c => c.path === '/tests/a/runs')?.body).toMatchObject({
      targetUrl: 'http://127.0.0.1:3000',
      environment: 'saved',
    });
  });
  it('ambiguous saved hosts fall back to localhost without merging aliases', async () => {
    const f = fixture({
      envs: [
        { name: 'public', url: 'https://example.com', isDefault: true },
        { name: 'one', url: 'http://127.0.0.1:5173' },
        { name: 'two', url: 'http://[::1]:5173' },
      ],
    });
    await f.run('run', 'a', '--local', '5173', '--skip-preflight');
    expect(f.calls.find(c => c.path === '/tests/a/runs')?.body.targetUrl).toBe(
      'http://localhost:5173',
    );
  });
  it('batch rerun confirms the tunnel echo before polling', async () => {
    const f = fixture();
    await runTestRerun(
      {
        ...common,
        testIds: ['a', 'b'],
        all: false,
        wait: false,
        skipPreflight: true,
        timeoutSeconds: 10,
        maxConcurrency: 5,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
      },
      f.deps,
    );
    expect(f.calls.find(c => c.path === '/tests/batch/rerun')?.body.tunnelClientId).toBe(clientId);
    expect(f.calls.at(-1)?.method).toBe('DELETE');
  });
  it('old batch rerun missing echo cancels every accepted run', async () => {
    const f = fixture({ echo: false });
    await expect(
      runTestRerun(
        {
          ...common,
          testIds: ['a', 'b'],
          all: false,
          wait: false,
          skipPreflight: true,
          timeoutSeconds: 10,
          maxConcurrency: 5,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
        },
        f.deps,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(f.calls.filter(c => c.path.endsWith('/cancel')).map(c => c.path)).toEqual([
      '/runs/run_a/cancel',
      '/runs/run_b/cancel',
    ]);
  });
  it.each([403, 404])(
    'testlist run falls back when its environment list returns %s',
    async envStatus => {
      const f = fixture({ envStatus });
      await runTestlistRun(
        { ...common, listId: 'L', wait: false, timeoutSeconds: 10, maxConcurrency: 5 },
        f.deps,
      );
      expect(f.calls.find(c => c.path === '/testlist/L/run')?.body).toEqual({});
      expect(f.calls.some(c => c.path === '/tunnel')).toBe(false);
    },
  );

  it('prints automatic environment notice once for a shared batch', async () => {
    const f = fixture();
    await f.run('run', 'a', 'b', '--skip-preflight');
    expect(f.stderr.filter(line => line.startsWith('Environment "saved"'))).toHaveLength(1);
  });
  it('several-id automatic tunnel skips backend cases with an advisory', async () => {
    const f = fixture({
      tests: [
        { id: 'a', type: 'frontend', projectId: 'P' },
        { id: 'b', type: 'backend', projectId: 'P' },
      ],
    });
    await f.run('run', 'a', 'b', '--skip-preflight');
    expect(
      f.calls.filter(c => c.method === 'POST' && c.path.endsWith('/runs')).map(c => c.path),
    ).toEqual(['/tests/a/runs']);
    expect(f.stderr.join('\n')).toContain('1 backend test(s) skipped');
  });
  it('rerun --all keeps the batch envelope and emits one idempotency key', async () => {
    const f = fixture();
    await runTestRerun(
      {
        ...common,
        testIds: [],
        all: true,
        projectId: 'P',
        wait: false,
        skipPreflight: true,
        timeoutSeconds: 10,
        maxConcurrency: 5,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
      },
      f.deps,
    );
    expect(f.calls.find(c => c.path === '/tests/batch/rerun')?.body.tunnelClientId).toBe(clientId);
    expect(f.stderr.filter(line => line.startsWith('idempotency-key:'))).toHaveLength(1);
    expect(JSON.parse(f.stdout[0]!)).toHaveProperty('accepted');
  });
  it('interrupting an owned rerun cancels before closing without claiming it keeps running', async () => {
    const shutdown = new ShutdownController();
    const f = fixture({ shutdown, onTrigger: () => shutdown.interrupt('SIGINT') });
    const error = await runTestRerun(
      {
        ...common,
        testIds: ['a'],
        all: false,
        wait: false,
        timeoutSeconds: 10,
        maxConcurrency: 5,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
      },
      f.deps,
    ).catch(err => err);
    expect(error).toMatchObject({ signal: 'SIGINT', exitCode: 130 });
    expect(error.tunnelDetach).toMatchObject({
      runId: 'run_a',
      cancel: 'cancelled',
      nextAction: expect.stringContaining('testsprite test run a'),
    });
    expect(f.calls.some(c => c.path === '/runs/run_a/cancel')).toBe(true);
    expect(f.calls.at(-1)?.method).toBe('DELETE');
    expect(f.stderr.join('\n')).not.toContain('billing');
  });
  it.each(['rerun', 'testlist'])(
    'explicit no-wait preserves ordinary %s dispatch',
    async command => {
      const f = fixture();
      if (command === 'rerun')
        await runTestRerun(
          {
            ...common,
            testIds: ['a'],
            all: false,
            wait: false,
            noWait: true,
            timeoutSeconds: 10,
            maxConcurrency: 5,
            autoHeal: false,
            autoHealExplicit: false,
            skipDependencies: false,
          },
          f.deps,
        );
      else
        await runTestlistRun(
          {
            ...common,
            listId: 'L',
            wait: false,
            noWait: true,
            timeoutSeconds: 10,
            maxConcurrency: 5,
          },
          f.deps,
        );
      expect(f.calls.some(c => c.path === '/tunnel')).toBe(false);
      expect(f.stderr.join('\n')).toContain('drop --no-wait');
    },
  );
  it('automatic tunnels refuse concurrency above ten before minting', async () => {
    const f = fixture();
    await expect(
      f.run('run', 'a', 'b', '--max-concurrency', '11', '--skip-preflight'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(f.calls.some(c => c.path === '/tunnel')).toBe(false);
  });

  it('tracks a detached trigger while preserving its response after an interrupt', async () => {
    const shutdown = new ShutdownController();
    let tracked = false;
    const f = fixture({
      shutdown,
      onTrigger: () => {
        tracked = shutdown.hasCriticalOperations;
        shutdown.interrupt('SIGINT');
      },
    });
    await expect(
      runTestRerun(
        {
          ...common,
          testIds: ['a'],
          all: false,
          wait: false,
          timeoutSeconds: 10,
          maxConcurrency: 5,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
        },
        f.deps,
      ),
    ).rejects.toMatchObject({ signal: 'SIGINT' });
    expect(tracked).toBe(true);
    expect(f.calls.some(c => c.path === '/runs/run_a/cancel')).toBe(true);
  });
  it('interrupts a connecting replay tunnel promptly and deletes its minted binding', async () => {
    vi.useFakeTimers();
    const shutdown = new ShutdownController();
    const f = fixture({
      shutdown,
      start: async () => {
        shutdown.interrupt('SIGINT');
        await new Promise<void>(() => {});
      },
    });
    const pending = runTestRerun(
      {
        ...common,
        testIds: ['a'],
        all: false,
        wait: false,
        timeoutSeconds: 10,
        maxConcurrency: 5,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
      },
      f.deps,
    ).catch(err => err);
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(f.calls.some(c => c.method === 'DELETE' && c.path === `/tunnel/${clientId}`)).toBe(
        true,
      );
      expect(await pending).toMatchObject({ signal: 'SIGINT' });
    } finally {
      await vi.advanceTimersByTimeAsync(25_000);
      await pending;
      vi.useRealTimers();
    }
  });

  it('a public member of a mixed tunnel batch is not cancelled on timeout', async () => {
    const f = fixture({
      tests: [
        { id: 'a', type: 'frontend', projectId: 'P' },
        { id: 'b', type: 'frontend', projectId: 'Q' },
      ],
      envsByProject: { Q: [{ name: 'public', url: 'https://example.com', isDefault: true }] },
    });
    await expect(
      runTestRunLocalBatch(
        {
          ...common,
          testIds: ['a', 'b'],
          all: false,
          skipPreflight: true,
          cancelOnInterrupt: true,
          timeoutSeconds: 0,
          maxConcurrency: 5,
          allowEmpty: false,
        },
        f.deps,
      ),
    ).rejects.toMatchObject({ exitCode: 7 });
    expect(f.calls.filter(c => c.path.endsWith('/cancel')).map(c => c.path)).toEqual([
      '/runs/run_a/cancel',
    ]);
    expect(f.calls.find(c => c.path === '/tests/b/runs')?.body).toEqual({ source: 'cli' });
  });
  it('test create --run opens the same saved environment tunnel', async () => {
    const f = fixture();
    const codeFile = join(mkdtempSync(join(tmpdir(), 'env-code-')), 'test.py');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture-owned temporary directory.
    writeFileSync(codeFile, 'def test_app(page):\n    page.goto("https://example.com")\n');
    await runTestCreate(
      {
        ...common,
        projectId: 'P',
        type: 'frontend',
        name: 'a',
        codeFile,
        run: true,
        wait: false,
        skipPreflight: true,
      },
      f.deps,
    );
    expect(f.calls.find(c => c.path === '/tests/a/runs')?.body).toMatchObject({
      targetUrl: savedUrl,
      tunnelClientId: clientId,
    });
    expect(JSON.parse(f.stdout[0]!)).toHaveProperty('run');
  });

  it('ordinary several-id text output preserves the legacy refusal', async () => {
    const f = fixture({ url: 'https://example.com' });
    await expect(f.run('run', 'a', 'b', '--skip-preflight')).rejects.toMatchObject({
      exitCode: 5,
      details: { field: 'test-id' },
    });
    expect(f.calls.every(c => c.method === 'GET')).toBe(true);
    expect(f.stdout).toEqual([]);
  });
  it('an ad-hoc explicit loopback retry preserves the overriding port and host', () => {
    expect(
      tunnelInterruptNextAction(
        {
          runId: 'r',
          testId: 'a',
          localPort: 3000,
          localHost: '::1',
          reason: 'interrupt',
          cancel: 'cancelled',
        },
        new InterruptError('SIGINT'),
      ),
    ).toContain('testsprite test run a --local 3000 --local-host ::1');
  });

  it.each(['rerun', 'testlist'])(
    '%s partitions different saved loopback URLs without rebuilding them',
    async command => {
      const otherUrl = 'http://[::1]:3000/';
      const f = fixture({
        tests: [
          { id: 'a', type: 'frontend', projectId: 'P' },
          { id: 'b', type: 'frontend', projectId: 'Q' },
        ],
        envsByProject: { Q: [{ name: 'other', url: otherUrl, isDefault: true }] },
      });
      if (command === 'rerun')
        await runTestRerun(
          {
            ...common,
            testIds: ['a', 'b'],
            all: false,
            wait: false,
            timeoutSeconds: 10,
            maxConcurrency: 5,
            autoHeal: false,
            autoHealExplicit: false,
            skipDependencies: false,
          },
          f.deps,
        );
      else
        await runTestlistRun(
          { ...common, listId: 'L', wait: false, timeoutSeconds: 10, maxConcurrency: 5 },
          f.deps,
        );
      const dispatches = f.calls.filter(
        c =>
          c.method === 'POST' && (c.path === '/tests/batch/rerun' || c.path === '/testlist/L/run'),
      );
      expect(dispatches.map(c => c.body)).toEqual([
        {
          ...(command === 'rerun' ? { source: 'cli', autoHeal: false } : {}),
          testIds: ['a'],
          targetUrl: savedUrl,
          tunnelClientId: clientId,
        },
        {
          ...(command === 'rerun' ? { source: 'cli', autoHeal: false } : {}),
          testIds: ['b'],
          targetUrl: otherUrl,
          tunnelClientId: clientId,
        },
      ]);
    },
  );
  it('loopback target URL implies wait for CI summary flags', async () => {
    const f = fixture();
    const path = join(mkdtempSync(join(tmpdir(), 'env-summary-')), 'result.json');
    await f.run(
      'run',
      'a',
      '--target-url',
      'http://localhost:3000',
      '--summary-file',
      path,
      '--skip-preflight',
    );
    expect(f.calls.find(c => c.path === '/tests/a/runs')?.body.tunnelClientId).toBe(clientId);
  });
  it.each(['rerun', 'testlist'])('automatic %s wait satisfies JUnit validation', async command => {
    const f = fixture();
    const reportFile = join(mkdtempSync(join(tmpdir(), 'env-junit-')), 'result.xml');
    if (command === 'rerun')
      await runTestRerun(
        {
          ...common,
          testIds: ['a', 'b'],
          all: false,
          wait: false,
          timeoutSeconds: 10,
          maxConcurrency: 5,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          report: 'junit',
          reportFile,
        },
        f.deps,
      );
    else
      await runTestlistRun(
        {
          ...common,
          listId: 'L',
          wait: false,
          timeoutSeconds: 10,
          maxConcurrency: 5,
          report: 'junit',
          reportFile,
        },
        f.deps,
      );
    expect(f.calls.some(c => c.path === '/tunnel')).toBe(true);
  });

  it('automatic --all keeps the same default deadline as explicit local runs', async () => {
    let clock = 1_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let polls = 0;
    const f = fixture({
      poll: () => {
        polls += 1;
        if (polls === 1) {
          clock += 650_000;
          return { status: 'running' };
        }
        return { status: 'passed' };
      },
    });
    try {
      await f.run('run', '--all', '--project', 'P', '--skip-preflight');
      expect(JSON.parse(f.stdout[0]!)).toMatchObject({ summary: { passed: 2, timedOut: 0 } });
    } finally {
      now.mockRestore();
    }
  });
  it('owned replay interrupt advice preserves the selected nondefault environment', async () => {
    const shutdown = new ShutdownController();
    const f = fixture({
      shutdown,
      onTrigger: () => shutdown.interrupt('SIGINT'),
      envs: [
        { name: 'public', url: 'https://example.com', isDefault: true },
        { name: 'staging', url: savedUrl },
      ],
    });
    const error = await runTestRerun(
      {
        ...common,
        testIds: ['a'],
        all: false,
        environment: 'staging',
        wait: false,
        timeoutSeconds: 10,
        maxConcurrency: 5,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
      },
      f.deps,
    ).catch(err => err);
    expect(error.tunnelDetach.nextAction).toContain("testsprite test run a --env 'staging'");
  });
  it('test run help describes automatic tunnels and built dev servers', () => {
    const command = createTestCommand(fixture().deps).commands.find(
      command => command.name() === 'run',
    )!;
    const help = command.helpInformation();
    expect(help).toContain('automatically');
    expect(help).toContain('a minute per page');
    expect(help).toContain('npm run build');
  });

  it('automatic --all honors the explicit interrupt cancellation opt-out', async () => {
    const shutdown = new ShutdownController();
    const f = fixture({ shutdown, onTrigger: () => shutdown.interrupt('SIGINT') });
    await expect(
      f.run('run', '--all', '--project', 'P', '--no-cancel-on-interrupt', '--skip-preflight'),
    ).rejects.toMatchObject({ signal: 'SIGINT' });
    expect(f.calls.some(c => c.path.endsWith('/cancel'))).toBe(false);
    expect(f.calls.at(-1)?.method).toBe('DELETE');
  });

  it.each(['summary-file', 'report'])(
    'ordinary several-id %s refuses before dispatch rather than losing batch artifacts',
    async flag => {
      const f = fixture({ url: 'https://example.com' });
      const path = join(mkdtempSync(join(tmpdir(), 'env-artifact-')), 'artifact');
      const args =
        flag === 'report' ? ['--report', 'junit', '--report-file', path] : ['--summary-file', path];
      await expect(
        f.run('run', 'a', 'b', '--wait', '--skip-preflight', ...args),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(f.calls.some(c => c.method === 'POST')).toBe(false);
    },
  );

  it('owned rerun timeout advice quotes the environment as a literal shell argument', async () => {
    const name = '$(example)';
    const f = fixture({ envs: [{ name, url: savedUrl, isDefault: true }] });
    const error = await runTestRerun(
      {
        ...common,
        testIds: ['a'],
        all: false,
        environment: name,
        wait: false,
        timeoutSeconds: 0,
        maxConcurrency: 5,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
      },
      f.deps,
    ).catch(err => err);
    expect(error.nextAction).toContain("--env '$(example)'");
  });
  it('empty ordinary rerun keeps the legacy CI wait requirement before writing an artifact', async () => {
    const f = fixture({ url: 'https://example.com', tests: [] });
    const path = join(mkdtempSync(join(tmpdir(), 'env-empty-summary-')), 'result.json');
    await expect(
      f.run('rerun', '--all', '--project', 'P', '--allow-empty', '--summary-file', path),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(f.calls.some(c => c.method === 'POST')).toBe(false);
  });

  it.each(['poll', 'before-dispatch'])(
    'a public batch member ignores an unused tunnel failure during %s',
    async phase => {
      let publicPolls = 0;
      const f = fixture({
        tests: [
          { id: 'a', type: 'frontend', projectId: 'P' },
          { id: 'b', type: 'frontend', projectId: 'Q' },
        ],
        envsByProject: { Q: [{ name: 'public', url: 'https://example.com', isDefault: true }] },
        poll: id => {
          if (id === 'run_a' && phase === 'before-dispatch') f.failTunnel();
          if (id === 'run_b' && phase === 'poll' && publicPolls++ === 0) {
            f.failTunnel();
            return { status: 'running' };
          }
          return { status: 'passed' };
        },
      });
      await expect(
        runTestRunLocalBatch(
          {
            ...common,
            testIds: ['a', 'b'],
            all: false,
            skipPreflight: true,
            cancelOnInterrupt: true,
            timeoutSeconds: 10,
            maxConcurrency: 1,
            allowEmpty: false,
          },
          f.deps,
        ),
      ).resolves.toBeUndefined();
      expect(JSON.parse(f.stdout[0]!)).toMatchObject({ summary: { passed: 2 } });
      expect(f.calls.find(c => c.path === '/tests/b/runs')?.body).toEqual({ source: 'cli' });
    },
  );

  it.each(['rerun', 'testlist'])(
    'automatic %s releases a terminal slot before dispatching the next group',
    async command => {
      const f = fixture({
        tests: [
          { id: 'a', type: 'frontend', projectId: 'P' },
          { id: 'b', type: 'frontend', projectId: 'P' },
        ],
      });
      if (command === 'rerun')
        await runTestRerun(
          {
            ...common,
            testIds: ['a', 'b'],
            all: false,
            wait: false,
            timeoutSeconds: 10,
            maxConcurrency: 1,
            autoHeal: false,
            autoHealExplicit: false,
            skipDependencies: false,
          },
          f.deps,
        );
      else
        await runTestlistRun(
          { ...common, listId: 'L', wait: false, timeoutSeconds: 10, maxConcurrency: 1 },
          f.deps,
        );
      const dispatches = f.calls.filter(
        c =>
          c.method === 'POST' && (c.path === '/tests/batch/rerun' || c.path === '/testlist/L/run'),
      );
      expect(dispatches.map(c => c.body.testIds)).toEqual([['a'], ['b']]);
      expect(f.calls.findIndex(c => c.path === '/runs/run_a')).toBeLessThan(
        f.calls.indexOf(dispatches[1]!),
      );
    },
  );
  it.each(['rerun', 'testlist'])(
    'automatic %s preserves the first receipt and CI artifacts when capacity times out',
    async command => {
      let clock = 1_000;
      const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
      const f = fixture({
        tests: [
          { id: 'a', type: 'frontend', projectId: 'P' },
          { id: 'b', type: 'frontend', projectId: 'P' },
        ],
        poll: () => {
          clock += 11_000;
          return { status: 'running' };
        },
      });
      const path = join(mkdtempSync(join(tmpdir(), 'env-capacity-summary-')), 'result.json');
      try {
        const pending =
          command === 'rerun'
            ? runTestRerun(
                {
                  ...common,
                  testIds: ['a', 'b'],
                  all: false,
                  wait: false,
                  timeoutSeconds: 10,
                  maxConcurrency: 1,
                  autoHeal: false,
                  autoHealExplicit: false,
                  skipDependencies: false,
                  summaryFile: path,
                },
                f.deps,
              )
            : runTestlistRun(
                {
                  ...common,
                  listId: 'L',
                  wait: false,
                  timeoutSeconds: 10,
                  maxConcurrency: 1,
                  summaryFile: path,
                },
                f.deps,
              );
        await expect(pending).rejects.toMatchObject({ code: 'UNSUPPORTED' });
        expect(f.stdout).toHaveLength(1);
        expect(JSON.parse(f.stdout[0]!)).toMatchObject({
          accepted: [{ testId: 'a', runId: 'run_a' }],
          notRunTestIds: ['b'],
        });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture-owned temporary file.
        expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
          total: 2,
          timedOut: 1,
          skipped: 1,
        });
        expect(f.calls.some(c => c.path === '/runs/run_a/cancel')).toBe(true);
      } finally {
        now.mockRestore();
      }
    },
  );

  it('capacity polling preserves its NOT_FOUND error rather than claiming a rejected rerun dispatch', async () => {
    const f = fixture({ pollStatus: 404 });
    await expect(
      runTestRerun(
        {
          ...common,
          testIds: ['a', 'b'],
          all: false,
          wait: false,
          timeoutSeconds: 10,
          maxConcurrency: 1,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
        },
        f.deps,
      ),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'not_found',
      details: { reason: 'not_found' },
    });
    expect(JSON.parse(f.stdout[0]!)).toMatchObject({
      accepted: [{ testId: 'a', runId: 'run_a' }],
      notRunTestIds: ['b'],
    });
  });
  it('reports an old-server tunnel refusal when a deferred retry first accepts runs', async () => {
    let dispatches = 0;
    const f = fixture({
      echo: false,
      batchResponse: body => {
        if (++dispatches > 1) return {};
        return {
          accepted: [],
          deferred: (body.testIds as string[]).map(testId => ({ testId, reason: 'rate_limited' })),
        };
      },
    });
    const error = await runTestRerun(
      {
        ...common,
        testIds: ['a', 'b'],
        all: false,
        wait: true,
        timeoutSeconds: 600,
        maxConcurrency: 5,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
      },
      f.deps,
    ).catch(err => err);
    expect(error).toMatchObject({
      code: 'UNSUPPORTED',
      message: expect.stringContaining('server did not confirm tunnel use'),
    });
    expect(f.calls.filter(call => call.path.endsWith('/cancel')).map(call => call.path)).toEqual([
      '/runs/run_a/cancel',
      '/runs/run_b/cancel',
    ]);
    expect(f.stdout).toHaveLength(1);
    expect(JSON.parse(f.stdout[0]!)).toMatchObject({
      accepted: [
        { testId: 'a', runId: 'run_a' },
        { testId: 'b', runId: 'run_b' },
      ],
      deferred: [],
    });
    expect(f.calls.at(-1)?.method).toBe('DELETE');
  });

  it('keeps accepted retry run IDs when the following retry dispatch is interrupted', async () => {
    const interrupt = new InterruptError('SIGINT');
    let dispatches = 0;
    const f = fixture({
      tests: [
        { id: 'a', type: 'frontend', projectId: 'P' },
        { id: 'b', type: 'frontend', projectId: 'Q' },
      ],
      envsByProject: {
        P: [{ name: 'saved', url: savedUrl, isDefault: true }],
        Q: [{ name: 'saved', url: 'http://localhost:3000', isDefault: true }],
      },
      batchResponse: body => {
        dispatches++;
        if (dispatches === 4) throw interrupt;
        if (dispatches > 2) return {};
        return {
          accepted: [],
          deferred: (body.testIds as string[]).map(testId => ({ testId, reason: 'rate_limited' })),
        };
      },
    });
    const error = await runTestRerun(
      {
        ...common,
        testIds: ['a', 'b'],
        all: false,
        wait: true,
        timeoutSeconds: 600,
        maxConcurrency: 5,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
      },
      f.deps,
    ).catch(err => err);
    expect(error).toBe(interrupt);
    expect(f.stdout).toHaveLength(1);
    expect(JSON.parse(f.stdout[0]!)).toMatchObject({
      accepted: [{ testId: 'a', runId: 'run_a' }],
      deferred: [{ testId: 'b' }],
    });
    expect(f.calls.some(call => call.path === '/runs/run_a/cancel')).toBe(true);
  });

  it('stops queued create-batch tunnel runs when polling fails without a terminal verdict', async () => {
    const f = fixture({ pollStatus: 404 });
    const plans = join(mkdtempSync(join(tmpdir(), 'env-tunnel-capacity-')), 'plans.jsonl');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture-owned temporary file.
    writeFileSync(
      plans,
      [0, 1]
        .map(index =>
          JSON.stringify({
            projectId: 'P',
            type: 'frontend',
            name: `case ${index}`,
            planSteps: [{ type: 'action', description: 'Open the page' }],
          }),
        )
        .join('\n'),
    );
    await expect(
      runCreateBatch(
        { ...common, plans, run: true, wait: false, timeoutSeconds: 10, maxConcurrency: 1 },
        f.deps,
      ),
    ).rejects.toMatchObject({ exitCode: 4 });
    expect(
      f.calls.filter(call => call.method === 'POST' && /\/tests\/[^/]+\/runs$/.test(call.path)),
    ).toHaveLength(1);
    expect(f.calls.some(call => call.path === '/runs/run_a/cancel')).toBe(true);
    expect(JSON.parse(f.stdout[0]!)).toMatchObject({
      results: [
        { testId: 'a', runId: 'run_a', status: 'running' },
        { testId: 'b', status: 'not_dispatched' },
      ],
    });
  });

  it('uses distinct bounded idempotency keys for loopback test-list groups', async () => {
    const f = fixture({
      tests: [
        { id: 'a', type: 'frontend', projectId: 'P' },
        { id: 'b', type: 'frontend', projectId: 'Q' },
      ],
      envsByProject: {
        P: [{ name: 'saved', url: savedUrl, isDefault: true }],
        Q: [{ name: 'saved', url: 'http://localhost:3000', isDefault: true }],
      },
    });
    const keys: string[] = [];
    const original = f.deps.fetchImpl;
    f.deps.fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      if (String(input).endsWith('/testlist/L/run'))
        keys.push(new Headers(init?.headers).get('idempotency-key')!);
      return original(input, init);
    });
    await runTestlistRun(
      {
        ...common,
        listId: 'L',
        wait: false,
        timeoutSeconds: 10,
        maxConcurrency: 5,
        idempotencyKey: 'x'.repeat(249) + ':group1',
      },
      f.deps,
    );
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every(key => key.length <= 256)).toBe(true);
  });

  it('keeps run receipts when an owned rerun is interrupted during deferred backoff', async () => {
    const interrupt = new InterruptError('SIGINT');
    const f = fixture({
      batchResponse: () => ({
        accepted: [{ testId: 'a', runId: 'run_a', enqueuedAt: '2026-10-01T00:00:00Z' }],
        deferred: [{ testId: 'b', reason: 'rate_limited' }],
      }),
    });
    f.deps.sleep = async () => {
      throw interrupt;
    };
    const error = await runTestRerun(
      {
        ...common,
        testIds: ['a', 'b'],
        all: false,
        wait: true,
        timeoutSeconds: 600,
        maxConcurrency: 5,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
      },
      f.deps,
    ).catch(err => err);
    expect(error).toBe(interrupt);
    expect(f.stdout).toHaveLength(1);
    expect(JSON.parse(f.stdout[0]!)).toMatchObject({
      accepted: [{ testId: 'a', runId: 'run_a' }],
      deferred: [{ testId: 'b' }],
    });
    expect(f.calls.some(call => call.path === '/runs/run_a/cancel')).toBe(true);
  });

  it('drains concurrent create-batch triggers before printing receipts and closing the tunnel', async () => {
    const f = fixture({ pollStatus: 404 });
    const original = f.deps.fetchImpl;
    let releaseSecond!: () => void;
    const second = new Promise<void>(resolve => {
      releaseSecond = resolve;
    });
    f.deps.fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      if (String(input).endsWith('/tests/b/runs')) await second;
      return original(input, init);
    });
    const plans = join(mkdtempSync(join(tmpdir(), 'env-tunnel-drain-')), 'plans.jsonl');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture-owned temporary file.
    writeFileSync(
      plans,
      ['a', 'b']
        .map(name =>
          JSON.stringify({
            projectId: 'P',
            type: 'frontend',
            name,
            planSteps: [{ type: 'action', description: 'Open the page' }],
          }),
        )
        .join('\n'),
    );
    const pending = runCreateBatch(
      { ...common, plans, run: true, wait: false, timeoutSeconds: 10, maxConcurrency: 2 },
      f.deps,
    ).catch(err => err);
    await new Promise(resolve => setTimeout(resolve, 25));
    releaseSecond();
    await pending;
    // Drain the delayed fixture response even against the broken implementation.
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(f.calls.some(call => call.path === '/runs/run_b/cancel')).toBe(true);
    expect(JSON.parse(f.stdout[0]!)).toMatchObject({
      results: [
        { testId: 'a', runId: 'run_a' },
        { testId: 'b', runId: 'run_b' },
      ],
    });
    expect(f.calls.at(-1)?.method).toBe('DELETE');
  });

  it.each(['rerun', 'testlist'])(
    'keeps partial receipts and CI artifacts when owned %s polling loses its tunnel',
    async command => {
      const f = fixture({
        poll: () => {
          f.failTunnel();
          return { status: 'running' };
        },
      });
      const summaryFile = join(mkdtempSync(join(tmpdir(), 'env-poll-partial-')), 'summary.json');
      const opts = { ...common, wait: true, timeoutSeconds: 10, maxConcurrency: 5, summaryFile };
      const error = await (
        command === 'rerun'
          ? runTestRerun(
              {
                ...opts,
                testIds: ['a', 'b'],
                all: false,
                autoHeal: false,
                autoHealExplicit: false,
                skipDependencies: false,
              },
              f.deps,
            )
          : runTestlistRun({ ...opts, listId: 'L' }, f.deps)
      ).catch(err => err);
      expect(error).toMatchObject({ code: 'UNAVAILABLE', details: { runId: 'run_a' } });
      expect(f.stdout).toHaveLength(1);
      expect(JSON.parse(f.stdout[0]!).accepted).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ testId: 'a', runId: 'run_a', status: 'running' }),
        ]),
      );
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture-owned artifact path.
      expect(JSON.parse(readFileSync(summaryFile, 'utf8')).runs).toEqual(
        expect.arrayContaining([expect.objectContaining({ runId: 'run_a' })]),
      );
      expect(f.calls.some(call => call.path === '/runs/run_a/cancel')).toBe(true);
    },
  );
  it('keeps test-list run receipts when owned polling is interrupted', async () => {
    const interrupt = new InterruptError('SIGINT');
    const f = fixture({
      poll: () => {
        throw interrupt;
      },
    });
    const error = await runTestlistRun(
      { ...common, listId: 'L', wait: false, timeoutSeconds: 10, maxConcurrency: 5 },
      f.deps,
    ).catch(err => err);
    expect(error).toBe(interrupt);
    expect(f.stdout).toHaveLength(1);
    expect(JSON.parse(f.stdout[0]!)).toMatchObject({ accepted: [{ testId: 'a', runId: 'run_a' }] });
  });
});

describe('environment tunnel compatibility regressions', () => {
  it('refuses several public-target ids before any request with the legacy reason', async () => {
    const f = fixture({ url: 'https://example.com' });
    await expect(
      f.run('run', 'a', 'b', '--target-url', 'https://preview.example.com', '--skip-preflight'),
    ).rejects.toMatchObject({
      exitCode: 5,
      details: {
        field: 'test-id',
        reason:
          'several test ids run through one tunnel with --local <port>. For tests the runner can already reach, use `testsprite test run --all --project <id> [--filter <text>]`, or run them one at a time.',
      },
    });
    expect(f.calls).toEqual([]);
  });
  it('refuses several ids after public environment resolution without dispatch', async () => {
    const f = fixture({ url: 'https://example.com' });
    await expect(f.run('run', 'a', 'b', '--skip-preflight')).rejects.toMatchObject({
      exitCode: 5,
      details: { field: 'test-id' },
    });
    expect(f.calls.every(c => c.method === 'GET')).toBe(true);
    expect(f.stdout).toEqual([]);
  });
  it.each(['--tunnel-client', '--no-cancel-on-interrupt'])(
    'refuses inert %s before a public-target request',
    async flag => {
      const f = fixture();
      const args = flag === '--tunnel-client' ? [flag, clientId] : [flag];
      await expect(
        f.run(
          'run',
          'a',
          '--target-url',
          'https://preview.example.com',
          '--skip-preflight',
          ...args,
        ),
      ).rejects.toMatchObject({ exitCode: 5 });
      expect(f.calls).toEqual([]);
    },
  );
  it('reuses listing metadata for public rerun --all without test GET fan-out', async () => {
    const f = fixture({ url: 'https://example.com' });
    await f.run('rerun', '--all', '--project', 'P', '--wait');
    expect(f.calls.filter(c => /^\/tests\/[^/]+$/.test(c.path) && c.method === 'GET')).toEqual([]);
    expect(f.calls.filter(c => c.path === '/projects/P/env')).toHaveLength(1);
    expect(f.calls.filter(c => c.path === '/tests' && c.method === 'GET')).toHaveLength(1);
  });
  it('preserves legacy host when environment listing is unavailable', async () => {
    const f = fixture({ envStatus: 403 });
    await f.run('run', 'a', '--local', '5173', '--skip-preflight');
    expect(f.calls.find(c => c.path === '/tests/a/runs')?.body.targetUrl).toBe(
      'http://127.0.0.1:5173',
    );
  });
  it('preserves one agreed saved host across multiple environments on the port', async () => {
    const f = fixture({
      envs: [
        { name: 'dev', url: 'http://127.0.0.1:5173' },
        { name: 'qa', url: 'http://127.0.0.1:5173' },
      ],
    });
    await f.run('run', 'a', '--local', '5173', '--skip-preflight');
    expect(f.calls.find(c => c.path === '/tests/a/runs')?.body.targetUrl).toBe(
      'http://127.0.0.1:5173',
    );
  });
  it('dispatches a public backend test beside a loopback frontend in rerun', async () => {
    const f = fixture({
      tests: [
        { id: 'a', type: 'frontend', projectId: 'P' },
        { id: 'b', type: 'backend', projectId: 'Q' },
      ],
      envsByProject: {
        P: [{ name: 'saved', url: savedUrl, isDefault: true }],
        Q: [{ name: 'saved', url: 'https://example.com', isDefault: true }],
      },
    });
    await f.run('rerun', 'a', 'b', '--skip-preflight');
    const posts = f.calls.filter(c => c.path === '/tests/batch/rerun');
    expect(posts.map(c => c.body.testIds)).toContainEqual(['b']);
    expect(posts.find(c => (c.body.testIds as string[]).includes('b'))?.body).not.toHaveProperty(
      'tunnelClientId',
    );
    expect(
      JSON.parse(f.stdout[0]!)
        .accepted.map((r: { testId: string }) => r.testId)
        .sort(),
    ).toEqual(['a', 'b']);
  });
  it('reports only loopback backend tests as skipped in test-list JSON', async () => {
    const f = fixture({
      tests: [
        { id: 'a', type: 'frontend', projectId: 'P' },
        { id: 'b', type: 'backend', projectId: 'P' },
        { id: 'c', type: 'backend', projectId: 'Q' },
      ],
      envsByProject: {
        P: [{ name: 'saved', url: savedUrl, isDefault: true }],
        Q: [{ name: 'saved', url: 'https://example.com', isDefault: true }],
      },
    });
    await runTestlistRun(
      {
        ...common,
        listId: 'L',
        wait: false,
        timeoutSeconds: 10,
        maxConcurrency: 5,
        skipPreflight: true,
      },
      f.deps,
    );
    const payload = JSON.parse(f.stdout[0]!);
    expect(payload.skipped).toEqual([{ testId: 'b', reason: 'backend-test' }]);
    expect(payload.accepted.map((r: { testId: string }) => r.testId).sort()).toEqual(['a', 'c']);
  });
  it('deduplicates the no-wait hint per environment', async () => {
    const f = fixture();
    await runTestlistRun(
      { ...common, listId: 'L', wait: false, noWait: true, timeoutSeconds: 10, maxConcurrency: 5 },
      { ...f.deps, fetchImpl: f.deps.fetchImpl },
    );
    expect(f.stderr.filter(s => s.includes('drop --no-wait'))).toHaveLength(1);
  });
  it('announces public sign-in against the local origin once on stderr', async () => {
    const f = fixture({ url: 'https://example.com' });
    await f.run('run', 'a', 'b', '--env', 'saved', '--local', '5173', '--skip-preflight');
    expect(
      f.stderr.filter(s => s.includes('sign-in') && s.includes('http://localhost:5173')),
    ).toHaveLength(1);
    expect(f.stdout.join('')).not.toContain('sign-in');
  });
});

describe('creation tunnel preflight receipts', () => {
  function plansFile(types: Array<'frontend' | 'backend'> = ['frontend', 'frontend']) {
    const plans = join(mkdtempSync(join(tmpdir(), 'creation-preflight-')), 'plans.jsonl');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture-owned temporary directory.
    writeFileSync(
      plans,
      types
        .map((type, i) =>
          JSON.stringify({
            projectId: 'P',
            type,
            name: String(i),
            planSteps: [{ type: 'action', description: 'Open' }],
          }),
        )
        .join('\n'),
    );
    return plans;
  }
  it('probes before creating a single test', async () => {
    const f = fixture();
    const planFrom = plansFile();
    // Single-plan input, unlike JSONL batch input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture-owned temporary file.
    writeFileSync(
      planFrom,
      JSON.stringify({
        projectId: 'P',
        type: 'frontend',
        name: 'a',
        planSteps: [{ type: 'action', description: 'Open' }],
      }),
    );
    vi.mocked(assertLocalPortListening).mockRejectedValueOnce(
      new ApiError({
        code: 'VALIDATION_ERROR',
        message: 'dead port',
        nextAction: 'Start the app',
        requestId: 'local',
        details: { field: 'local', reason: 'local-port-not-listening' },
      }),
    );
    await expect(
      runCreateFromPlan({ ...common, planFrom, run: true }, f.deps),
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(f.calls.filter(c => c.method === 'POST' && c.path === '/tests')).toEqual([]);
  });
  it('mints and checks scope before creating a batch', async () => {
    const f = fixture({ mintStatus: 403 });
    await expect(
      runCreateBatch({ ...common, plans: plansFile(), run: true, skipPreflight: true }, f.deps),
    ).rejects.toMatchObject({ exitCode: 3 });
    expect(f.calls.filter(c => c.method === 'POST' && c.path === '/tests/batch')).toEqual([]);
  });
  it('reuses the environment list when a public create chains a run', async () => {
    const f = fixture({ url: 'https://example.com' });
    const planFrom = plansFile();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture-owned temporary file.
    writeFileSync(
      planFrom,
      JSON.stringify({
        projectId: 'P',
        type: 'frontend',
        name: 'a',
        planSteps: [{ type: 'action', description: 'Open' }],
      }),
    );
    await runCreateFromPlan({ ...common, planFrom, run: true }, f.deps);
    expect(f.calls.filter(c => c.path === '/projects/P/env')).toHaveLength(1);
    expect(f.calls.filter(c => c.path === '/tests/a' && c.method === 'GET')).toEqual([]);
  });
  it('preflights frontend creation even when a backend spec follows in the same project', async () => {
    const f = fixture({ mintStatus: 403 });
    await expect(
      runCreateBatch(
        { ...common, plans: plansFile(['frontend', 'backend']), run: true, skipPreflight: true },
        f.deps,
      ),
    ).rejects.toMatchObject({ exitCode: 3 });
    expect(f.calls.filter(c => c.method === 'POST' && c.path === '/tests/batch')).toEqual([]);
  });
  it('retains created ids and the original reason on a late run failure', async () => {
    const f = fixture({ triggerStatus: 403 });
    await expect(
      runCreateBatch({ ...common, plans: plansFile(), run: true, skipPreflight: true }, f.deps),
    ).rejects.toMatchObject({ exitCode: 3 });
    expect(f.stdout).toHaveLength(1);
    const payload = JSON.parse(f.stdout[0]!);
    expect(payload.results.map((r: { testId: string }) => r.testId)).toEqual(['a', 'b']);
    expect(
      payload.results.every(
        (r: { error: { details: { reason: string } } }) =>
          r.error.details.reason === 'tunnel-public-environment',
      ),
    ).toBe(true);
    expect(f.calls.findIndex(c => c.path === '/tunnel')).toBeLessThan(
      f.calls.findIndex(c => c.path === '/tests/batch'),
    );
  });
  it('retains and cancels a creation run accepted during an interrupt', async () => {
    const shutdown = new ShutdownController();
    const f = fixture({ shutdown, onTrigger: () => shutdown.interrupt('SIGINT') });
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await f.deps.fetchImpl(input, init);
      if (init?.signal?.aborted) throw init.signal.reason;
      return response;
    };
    await expect(
      runCreateBatch(
        { ...common, plans: plansFile(), run: true, skipPreflight: true },
        { ...f.deps, fetchImpl },
      ),
    ).rejects.toMatchObject({ exitCode: 130 });
    expect(f.calls.some(c => c.path === '/runs/run_a/cancel')).toBe(true);
    expect(f.stdout).toHaveLength(1);
    expect(JSON.parse(f.stdout[0]!).results).toEqual(
      expect.arrayContaining([expect.objectContaining({ testId: 'a', runId: 'run_a' })]),
    );
    expect(f.calls.at(-1)?.method).toBe('DELETE');
  });
});

describe('dry-run and tunnel batch accounting', () => {
  it('shows the automatic tunnel in a single dry run without writes', async () => {
    const f = fixture();
    await runTestRun(
      { ...common, dryRun: true, testId: 'a', wait: false, timeoutSeconds: 10 },
      f.deps,
    );
    expect(f.calls.every(c => c.method === 'GET')).toBe(true);
    expect(f.stderr.join('\n')).toContain(
      `Would open a tunnel to ${savedUrl} (environment "saved").`,
    );
    expect(JSON.parse(f.stdout[0]!).body).toMatchObject({
      targetUrl: savedUrl,
      tunnelClientId: '<minted at run time>',
    });
  });
  it('shows defined targets for an automatic multi-id dry run', async () => {
    const f = fixture();
    await new Command('testsprite')
      .option('--output <mode>')
      .option('--dry-run')
      .addCommand(createTestCommand(f.deps))
      .parseAsync(['--output', 'json', '--dry-run', 'test', 'run', 'a', 'b'], { from: 'user' });
    expect(f.calls.every(c => c.method === 'GET')).toBe(true);
    expect(
      JSON.parse(f.stdout[0]!).runs.every(
        (r: { body: { targetUrl: string } }) => r.body.targetUrl === savedUrl,
      ),
    ).toBe(true);
  });
  it('previews a public member beside a loopback member without an undefined target', async () => {
    const f = fixture({
      tests: [
        { id: 'a', type: 'frontend', projectId: 'P' },
        { id: 'b', type: 'frontend', projectId: 'Q' },
      ],
      envsByProject: { Q: [{ name: 'public', url: 'https://example.com', isDefault: true }] },
    });
    await new Command('testsprite')
      .option('--output <mode>')
      .option('--dry-run')
      .addCommand(createTestCommand(f.deps))
      .parseAsync(['--output', 'json', '--dry-run', 'test', 'run', 'a', 'b'], { from: 'user' });
    const runs = JSON.parse(f.stdout[0]!).runs;
    expect(runs[0].body).toMatchObject({
      targetUrl: savedUrl,
      tunnelClientId: '<minted at run time>',
    });
    expect(runs[1].body).toEqual({ source: 'cli' });
    expect(f.stdout.join('')).not.toContain('undefined');
  });
  it('previews automatic --all with a borrowed tunnel against its resolved origin', async () => {
    const f = fixture();
    await new Command('testsprite')
      .option('--output <mode>')
      .option('--dry-run')
      .addCommand(createTestCommand(f.deps))
      .parseAsync(
        [
          '--output',
          'json',
          '--dry-run',
          'test',
          'run',
          '--all',
          '--project',
          'P',
          '--tunnel-client',
          clientId,
        ],
        { from: 'user' },
      );
    expect(JSON.parse(f.stdout[0]!).runs[0].body).toMatchObject({
      targetUrl: savedUrl,
      tunnelClientId: clientId,
    });
    expect(JSON.parse(f.stdout[0]!)).not.toHaveProperty('precededBy');
    expect(f.calls.every(c => c.method === 'GET')).toBe(true);
  });
  it('rejects inert cancellation flags on public --all dry runs', async () => {
    const f = fixture({ url: 'https://example.com' });
    await expect(
      new Command('testsprite')
        .option('--output <mode>')
        .option('--dry-run')
        .addCommand(createTestCommand(f.deps))
        .parseAsync(
          [
            '--output',
            'json',
            '--dry-run',
            'test',
            'run',
            '--all',
            '--project',
            'P',
            '--no-cancel-on-interrupt',
          ],
          { from: 'user' },
        ),
    ).rejects.toMatchObject({ exitCode: 5, details: { field: 'cancel-on-interrupt' } });
    expect(f.calls.every(c => c.method === 'GET')).toBe(true);
  });
  it.each(['rerun', 'testlist'])('uses one deadline including %s capacity waits', async command => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const f = fixture({
      tests: [
        { id: 'a', type: 'frontend', projectId: 'P' },
        { id: 'b', type: 'frontend', projectId: 'P' },
      ],
      poll: () => {
        now += 2000;
        return {};
      },
    });
    try {
      const operation =
        command === 'rerun'
          ? f.run('rerun', 'a', 'b', '--max-concurrency', '1', '--timeout', '1', '--skip-preflight')
          : runTestlistRun(
              {
                ...common,
                listId: 'L',
                wait: false,
                timeoutSeconds: 1,
                maxConcurrency: 1,
                skipPreflight: true,
              },
              f.deps,
            );
      await expect(operation).rejects.toMatchObject({ exitCode: 7 });
      expect(
        f.calls.filter(
          c =>
            c.method === 'POST' &&
            (c.path === '/tests/batch/rerun' || c.path === '/testlist/L/run'),
        ),
      ).toHaveLength(1);
      expect(JSON.parse(f.stdout[0]!).notRunTestIds).toContain('b');
    } finally {
      clock.mockRestore();
    }
  });
  it.each(['rerun', 'testlist'])('reports no-echo cancelled %s runs honestly', async command => {
    const f = fixture({ echo: false });
    const operation =
      command === 'rerun'
        ? f.run('rerun', 'a', 'b', '--skip-preflight')
        : runTestlistRun(
            {
              ...common,
              listId: 'L',
              wait: false,
              timeoutSeconds: 10,
              maxConcurrency: 5,
              skipPreflight: true,
            },
            f.deps,
          );
    await expect(operation).rejects.toMatchObject({ exitCode: 7 });
    expect(
      JSON.parse(f.stdout[0]!).accepted.every((r: { status: string }) => r.status === 'cancelled'),
    ).toBe(true);
  });
});

describe('resolved batch request compatibility', () => {
  it('keeps the selected default loopback host on a shorthand override port', async () => {
    const f = fixture();
    await f.run('run', 'a', '--local', '3000', '--skip-preflight');
    expect(f.calls.find(c => c.path === '/tests/a/runs')?.body.targetUrl).toBe(
      'http://127.0.0.1:3000',
    );
  });
  it('preserves ordinary --all --wait dispatch and polling on a public environment', async () => {
    const f = fixture({ url: 'https://example.com' });
    await f.run('run', '--all', '--project', 'P', '--wait', '--skip-preflight');
    expect(f.calls.find(c => c.path === '/tests/batch/run')?.body).toEqual({
      projectId: 'P',
      source: 'cli',
    });
    expect(f.calls.some(c => c.path === '/runs/run_a')).toBe(true);
    expect(f.calls.filter(c => c.path === '/projects/P/env')).toHaveLength(1);
  });
  it('resolves create-batch public environments once without test GETs', async () => {
    const f = fixture({ url: 'https://example.com' });
    const plans = join(mkdtempSync(join(tmpdir(), 'creation-public-')), 'plans.jsonl');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixture-owned temporary file.
    writeFileSync(
      plans,
      ['a', 'b']
        .map(name =>
          JSON.stringify({
            projectId: 'P',
            type: 'frontend',
            name,
            planSteps: [{ type: 'action', description: 'Open' }],
          }),
        )
        .join('\n'),
    );
    await runCreateBatch({ ...common, plans, run: true, skipPreflight: true }, f.deps);
    expect(f.calls.filter(c => c.path === '/projects/P/env')).toHaveLength(1);
    expect(f.calls.filter(c => c.method === 'GET' && /^\/tests\/[^/]+$/.test(c.path))).toEqual([]);
  });
});
