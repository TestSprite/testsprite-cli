import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShutdownController } from '../lib/interrupt.js';
import { InterruptError } from '../lib/errors.js';
import { sanitizeTelemetryExtras, takeTelemetryExtras } from '../lib/telemetry.js';
import type { TunnelClientOptions } from '../vendor/tunnel-client/index.js';
import { ErrCode } from '../vendor/tunnel-client/index.js';
import type { RunResponse } from '../lib/runs.types.js';
import { createTestCommand } from './test.js';

type Call = {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  idempotencyKey?: string | null;
};

function fixture(
  ids: string[],
  options: {
    onCall?: (
      call: Call,
      init: RequestInit,
    ) => Response | undefined | Promise<Response | undefined>;
    shutdown?: ShutdownController;
    tunnelFactory?: (options: TunnelClientOptions) => {
      start(): Promise<void>;
      stop(): Promise<void>;
    };
    sleep?: (ms: number) => Promise<void>;
    onStderr?: (line: string) => void;
  } = {},
) {
  const credentialsPath = join(mkdtempSync(join(tmpdir(), 'local-batch-')), 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture path inside this test's own mkdtempSync-created temp dir, not user input.
  writeFileSync(
    credentialsPath,
    '[default]\napi_url = http://localhost:13502\napi_key = sk-user-test\n',
  );
  const calls: Call[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const terminal: string[] = [];
  const clientId = '11111111-2222-3333-4444-555555555555';
  const targetUrl = 'http://127.0.0.1:5173';
  const fetchImpl = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init: RequestInit = {},
  ) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init.method ?? 'GET';
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const idempotencyKey = new Headers(init.headers).get('Idempotency-Key');
    calls.push({ method, url, body, idempotencyKey });
    const override = await options.onCall?.({ method, url, body, idempotencyKey }, init);
    if (override) return override;
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (method === 'GET' && url.endsWith('/projects/P/env'))
      return json({
        environments: [{ name: 'saved', url: targetUrl, isDefault: true, isTemporary: false }],
      });
    if (method === 'GET' && url.includes('/tests?'))
      return json({
        items: ids.map(id => ({ id, name: id, type: 'frontend', projectId: 'P' })),
        nextToken: null,
      });
    if (method === 'POST' && url.endsWith('/tunnel'))
      return json(
        {
          clientId,
          secret: 'fixture-secret',
          controlUrl: 'ws://tunnel.example:7300/ws',
          tunnelAddr: 'tunnel.example:7400',
          expiresAt: '2026-09-23T00:00:00.000Z',
        },
        201,
      );
    if (method === 'DELETE' && url.includes('/tunnel/')) return new Response(null, { status: 204 });
    if (method === 'POST' && url.endsWith('/cancel')) return json({ status: 'cancelled' });
    if (method === 'GET' && /\/tests\/[^/?]+$/.test(url))
      return json({ type: 'frontend', projectId: 'P' });
    const trigger = /\/tests\/([^/]+)\/runs(?:\?|$)/.exec(url);
    if (method === 'POST' && trigger)
      return json({
        runId: `run_${trigger[1]}`,
        status: 'queued',
        enqueuedAt: '2026-09-22T00:00:00.000Z',
        codeVersion: 'v1',
        targetUrl,
      });
    const poll = /\/runs\/run_([^/?]+)/.exec(url);
    if (method === 'GET' && poll) {
      const testId = poll[1]!;
      terminal.push(testId);
      return json({
        runId: `run_${testId}`,
        testId,
        projectId: 'P',
        userId: 'U',
        status: 'passed',
        source: 'cli',
        createdAt: '2026-09-22T00:00:00.000Z',
        startedAt: '2026-09-22T00:00:01.000Z',
        finishedAt: '2026-09-22T00:00:02.000Z',
        codeVersion: 'v1',
        targetUrl,
        createdFrom: 'cli',
        failedStepIndex: null,
        failureKind: null,
        error: null,
        videoUrl: null,
        stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 },
      } satisfies RunResponse);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  }) as typeof globalThis.fetch;
  const createTunnelClient =
    options.tunnelFactory ??
    ((_options: TunnelClientOptions) => ({
      start: async () => {},
      stop: async () => {},
    }));
  const run = (...args: string[]) =>
    new Command('testsprite')
      .option('--output <mode>')
      .option('--dry-run')
      .addCommand(
        createTestCommand({
          credentialsPath,
          fetchImpl,
          createTunnelClient,
          shutdown: options.shutdown,
          stdout: line => stdout.push(line),
          stderr: line => {
            stderr.push(line);
            options.onStderr?.(line);
          },
          sleep: options.sleep ?? (async () => {}),
        }),
      )
      .parseAsync(
        [
          '--output',
          args.includes('--text-output') ? 'text' : 'json',
          ...(args.includes('--dry-run') ? ['--dry-run'] : []),
          'test',
          'run',
          ...args.filter(arg => arg !== '--dry-run' && arg !== '--text-output'),
        ],
        { from: 'user' },
      );
  return { ids, calls, stdout, stderr, terminal, clientId, targetUrl, run };
}

function runningResponse(testId: string): Response {
  return new Response(
    JSON.stringify({
      runId: `run_${testId}`,
      testId,
      projectId: 'P',
      userId: 'U',
      status: 'running',
      source: 'cli',
      createdAt: '2026-09-22T00:00:00.000Z',
      startedAt: '2026-09-22T00:00:01.000Z',
      finishedAt: null,
      codeVersion: 'v1',
      targetUrl: 'http://127.0.0.1:5173',
      createdFrom: 'cli',
      failedStepIndex: null,
      failureKind: null,
      error: null,
      videoUrl: null,
      stepSummary: { total: 1, completed: 0, passedCount: 0, failedCount: 0 },
      retryAfterSeconds: 25,
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  takeTelemetryExtras();
});

describe('test run local batch', () => {
  it('keeps the paused-workspace envelope when every local trigger is refused', async () => {
    const f = fixture(['a', 'b'], {
      onCall: call =>
        call.method === 'POST' && /\/tests\/[^/]+\/runs$/.test(call.url)
          ? new Response(
              JSON.stringify({
                error: {
                  code: 'FEATURE_GATED',
                  message: 'Workspace paused.',
                  nextAction: '',
                  requestId: 'req_hold',
                  details: { reason: 'billing_hold', state: 'paused', orgId: 'org-1' },
                },
              }),
              { status: 403, headers: { 'content-type': 'application/json' } },
            )
          : undefined,
    });
    const err = await f.run('a', 'b', '--local', '5173', '--skip-preflight').catch(e => e);
    expect(err).toMatchObject({
      code: 'FEATURE_GATED',
      exitCode: 13,
      requestId: 'req_hold',
      details: { reason: 'billing_hold', state: 'paused', orgId: 'org-1' },
    });
    expect(err.nextAction).toContain('/dashboard-v3/o/org-1/settings/billing');
  });

  it('refuses a target URL with local mode before network access', async () => {
    const f = fixture(['a', 'b']);
    await expect(
      f.run('a', 'b', '--local', '5173', '--target-url', 'https://example.com'),
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(f.stderr.join('\n')).not.toContain('--target-url is deprecated');
    expect(f.calls).toEqual([]);
  });

  it('refuses an explicit backend test before minting a shared tunnel', async () => {
    const f = fixture(['frontend', 'backend'], {
      onCall: call =>
        call.method === 'GET' && call.url.endsWith('/tests/backend')
          ? new Response(JSON.stringify({ type: 'backend', projectId: 'P' }), {
              headers: { 'content-type': 'application/json' },
            })
          : call.method === 'GET' && call.url.endsWith('/tests/frontend')
            ? new Response(JSON.stringify({ type: 'frontend', projectId: 'P' }), {
                headers: { 'content-type': 'application/json' },
              })
            : undefined,
    });
    await expect(
      f.run('frontend', 'backend', '--local', '5173', '--skip-preflight'),
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(f.calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('runs through a tunnel using a public named environment sign-in config', async () => {
    const f = fixture(['a', 'b'], {
      onCall: call => {
        if (call.method === 'GET' && /\/tests\/(a|b)$/.test(call.url))
          return new Response(JSON.stringify({ type: 'frontend', projectId: 'P' }), {
            headers: { 'content-type': 'application/json' },
          });
        if (call.method === 'GET' && call.url.endsWith('/projects/P/env'))
          return new Response(
            JSON.stringify({
              environments: [{ id: 'E', name: 'staging', url: 'https://example.com' }],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        return undefined;
      },
    });
    await f.run('a', 'b', '--local', '5173', '--env', 'staging', '--skip-preflight');
    expect(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/runs'))).toHaveLength(2);
    expect(f.calls.at(-1)?.method).toBe('DELETE');
  });

  it('all-local runs can use a public named environment', async () => {
    const f = fixture([], {
      onCall: call => {
        if (call.method === 'GET' && call.url.includes('/tests?'))
          return new Response(
            JSON.stringify({ items: [{ id: 'a', name: 'A', type: 'frontend' }], nextToken: null }),
            { headers: { 'content-type': 'application/json' } },
          );
        if (call.method === 'GET' && call.url.endsWith('/projects/P/env'))
          return new Response(
            JSON.stringify({
              environments: [{ id: 'E', name: 'staging', url: 'https://example.com' }],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        return undefined;
      },
    });
    await f.run(
      '--all',
      '--project',
      'P',
      '--local',
      '5173',
      '--env',
      'staging',
      '--skip-preflight',
    );
    expect(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/runs'))).toHaveLength(1);
    expect(f.calls.at(-1)?.method).toBe('DELETE');
  });

  it('uses one binding for three tests and reports results in input order', async () => {
    const f = fixture(['a', 'b', 'c']);
    await f.run('a', 'b', 'c', '--local', '5173', '--skip-preflight');
    const triggers = f.calls.filter(c => c.method === 'POST' && /\/tests\/[^/]+\/runs/.test(c.url));
    expect(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/tunnel'))).toHaveLength(1);
    expect(triggers.map(c => c.body?.tunnelClientId)).toEqual([f.clientId, f.clientId, f.clientId]);
    expect(f.calls.filter(c => c.method === 'DELETE' && c.url.includes('/tunnel/'))).toHaveLength(
      1,
    );
    expect(f.calls.findIndex(c => c.method === 'DELETE')).toBeGreaterThan(
      f.calls.reduce(
        (last, c, index) => (c.method === 'GET' && c.url.includes('/runs/') ? index : last),
        -1,
      ),
    );
    expect(JSON.parse(f.stdout.join('')).results.map((r: { testId: string }) => r.testId)).toEqual(
      f.ids,
    );
  });

  it('bounds in-flight triggers at two and waits for a slot before the third', async () => {
    const release = new Map<string, () => void>();
    const held = new Map<string, Promise<void>>();
    for (const id of ['a', 'b', 'c', 'd', 'e'])
      held.set(id, new Promise(resolve => release.set(id, resolve)));
    const f = fixture(['a', 'b', 'c', 'd', 'e'], {
      onCall: async call => {
        const id = /\/tests\/([^/]+)\/runs/.exec(call.url)?.[1];
        if (call.method === 'POST' && id) await held.get(id);
        return undefined;
      },
    });
    const pending = f.run(
      'a',
      'b',
      'c',
      'd',
      'e',
      '--local',
      '5173',
      '--skip-preflight',
      '--max-concurrency',
      '2',
    );
    await expect
      .poll(
        () => f.calls.filter(c => c.method === 'POST' && /\/tests\/[^/]+\/runs/.test(c.url)).length,
      )
      .toBe(2);
    expect(f.calls.some(c => c.url.includes('/tests/c/runs'))).toBe(false);
    release.get('a')!();
    await expect.poll(() => f.calls.some(c => c.url.includes('/tests/c/runs'))).toBe(true);
    release.get('b')!();
    release.get('c')!();
    release.get('d')!();
    release.get('e')!();
    await pending;
    expect(JSON.parse(f.stdout.join('')).summary.passed).toBe(5);
  });

  it('defaults to five local slots', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const f = fixture(ids, {
      onCall: async call => {
        if (call.method === 'POST' && /\/tests\/[^/]+\/runs/.test(call.url)) await gate;
        return undefined;
      },
    });
    const pending = f.run(...ids, '--local', '5173', '--skip-preflight');
    await expect
      .poll(
        () => f.calls.filter(c => c.method === 'POST' && /\/tests\/[^/]+\/runs/.test(c.url)).length,
      )
      .toBe(5);
    expect(f.calls.some(c => c.url.includes('/tests/f/runs'))).toBe(false);
    release();
    await pending;
    expect(JSON.parse(f.stdout.join('')).maxConcurrency).toBe(5);
  });

  it.each(['11', '0', 'abc'])('rejects local concurrency %s before any request', async value => {
    const f = fixture(['a', 'b']);
    await expect(
      f.run('a', 'b', '--local', '5173', '--max-concurrency', value, '--skip-preflight'),
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(f.calls).toEqual([]);
  });

  it('accepts ten local slots', async () => {
    const f = fixture(['a', 'b']);
    await f.run('a', 'b', '--local', '5173', '--max-concurrency', '10', '--skip-preflight');
    expect(JSON.parse(f.stdout.join('')).maxConcurrency).toBe(10);
  });

  it('mints and deletes once after twenty runs finish', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const f = fixture(ids);
    await f.run(...ids, '--local', '5173', '--skip-preflight');
    expect(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/tunnel'))).toHaveLength(1);
    const deletes = f.calls.filter(c => c.method === 'DELETE' && c.url.includes('/tunnel/'));
    expect(deletes).toHaveLength(1);
    expect(f.terminal).toHaveLength(20);
    expect(f.calls.indexOf(deletes[0]!)).toBeGreaterThan(
      f.calls.reduce(
        (last, c, i) => (c.method === 'GET' && c.url.includes('/runs/') ? i : last),
        -1,
      ),
    );
  });

  it('several ids use a saved loopback environment automatically', async () => {
    const f = fixture(['a', 'b']);
    await f.run('a', 'b', '--skip-preflight');
    expect(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/runs'))).toHaveLength(2);
  });

  it('deduplicates ids in first occurrence order and advises for each duplicate', async () => {
    const f = fixture(['a', 'b']);
    await f.run('a', 'b', 'a', 'b', '--local', '5173', '--skip-preflight');
    expect(JSON.parse(f.stdout.join('')).results.map((r: { testId: string }) => r.testId)).toEqual([
      'a',
      'b',
    ]);
    expect(f.stderr.filter(line => line.includes('ignoring duplicate test id'))).toEqual([
      '[advisory] ignoring duplicate test id a',
      '[advisory] ignoring duplicate test id b',
    ]);
  });

  it('prints a zero-network dry-run envelope', async () => {
    const f = fixture(['a', 'b']);
    await f.run('a', 'b', '--local', '5173', '--dry-run');
    expect(f.calls).toEqual([]);
    expect(JSON.parse(f.stdout.join(''))).toMatchObject({
      dryRun: true,
      precededBy: 'POST /api/cli/v1/tunnel',
      maxConcurrency: 5,
      followedBy: 'DELETE /api/cli/v1/tunnel/<client-id>',
      runs: [
        { path: '/api/cli/v1/tests/a/runs', body: { tunnelClientId: '<minted at run time>' } },
        { path: '/api/cli/v1/tests/b/runs' },
      ],
    });
  });

  it('describes all-local borrowed dry-run without mint or project reads', async () => {
    const f = fixture([]);
    await f.run(
      '--all',
      '--project',
      'P',
      '--local',
      '5173',
      '--tunnel-client',
      f.clientId,
      '--dry-run',
    );
    expect(f.calls).toEqual([]);
    const payload = JSON.parse(f.stdout.join(''));
    expect(payload.precededBy).toBeUndefined();
    expect(payload.followedBy).toBeUndefined();
    expect(payload.runs).toEqual([
      {
        method: 'POST',
        path: '/api/cli/v1/tests/<each frontend test in the project>/runs',
        body: { source: 'cli', targetUrl: 'http://localhost:5173', tunnelClientId: f.clientId },
      },
    ]);
  });

  it('paginates all tests, filters names and reports backend skips', async () => {
    const f = fixture(['a', 'b'], {
      onCall: call => {
        if (call.method !== 'GET' || !call.url.includes('/tests?')) return undefined;
        const second = call.url.includes('cursor=next');
        return new Response(
          JSON.stringify(
            second
              ? { items: [{ id: 'b', name: 'login second', type: 'frontend' }], nextToken: null }
              : {
                  items: [
                    { id: 'a', name: 'login first', type: 'frontend' },
                    { id: 'backend', name: 'login API', type: 'backend' },
                    { id: 'other', name: 'checkout', type: 'frontend' },
                  ],
                  nextToken: 'next',
                },
          ),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await f.run(
      '--all',
      '--project',
      'P',
      '--local',
      '5173',
      '--filter',
      'LOGIN',
      '--skip-preflight',
    );
    const payload = JSON.parse(f.stdout.join(''));
    expect(payload.results.map((r: { testId: string }) => r.testId)).toEqual(['a', 'b']);
    expect(payload.skipped).toEqual([{ testId: 'backend', reason: 'backend-test' }]);
    expect(f.stderr.join('\n')).toContain('1 backend test(s) skipped');
    expect(f.calls.filter(c => c.method === 'GET' && c.url.includes('/tests?'))).toHaveLength(2);
  });

  it('does not mint when every project test is backend', async () => {
    const f = fixture([], {
      onCall: call =>
        call.method === 'GET' && call.url.includes('/tests?')
          ? new Response(
              JSON.stringify({
                items: [{ id: 'backend', name: 'API', type: 'backend' }],
                nextToken: null,
              }),
              { headers: { 'content-type': 'application/json' } },
            )
          : undefined,
    });
    await expect(
      f.run('--all', '--project', 'P', '--local', '5173', '--skip-preflight'),
    ).rejects.toMatchObject({ exitCode: 5 });
    expect(f.calls.some(c => c.method === 'POST' && c.url.endsWith('/tunnel'))).toBe(false);
    expect(JSON.parse(f.stdout.join('')).skipped).toEqual([
      { testId: 'backend', reason: 'backend-test' },
    ]);
  });

  it.each([
    ['SIGINT', false, 130],
    ['SIGINT', true, 130],
    ['SIGTERM', false, 143],
    ['SIGTERM', true, 143],
  ] as const)(
    'handles %s without dequeuing and no-cancel=%s',
    async (signal, noCancel, exitCode) => {
      const shutdown = new ShutdownController();
      let interrupted = false;
      const f = fixture(['a', 'b', 'c', 'd'], {
        shutdown,
        onCall: call => {
          if (call.method === 'GET' && /\/runs\/run_[ab]/.test(call.url)) {
            if (!interrupted) {
              interrupted = true;
              shutdown.interrupt(signal);
            }
            return runningResponse(/run_([ab])/.exec(call.url)![1]!);
          }
          return undefined;
        },
      });
      const args = [
        'a',
        'b',
        'c',
        'd',
        '--local',
        '5173',
        '--skip-preflight',
        '--max-concurrency',
        '2',
      ];
      if (noCancel) args.push('--no-cancel-on-interrupt');
      await expect(f.run(...args)).rejects.toMatchObject({ exitCode, signal });
      const triggerIds = f.calls
        .filter(c => c.method === 'POST' && /\/tests\/[^/]+\/runs/.test(c.url))
        .map(c => /\/tests\/([^/]+)\/runs/.exec(c.url)![1]);
      expect(triggerIds).toEqual(['a', 'b']);
      expect(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/cancel'))).toHaveLength(
        noCancel ? 0 : 2,
      );
      expect(f.calls.filter(c => c.method === 'DELETE' && c.url.includes('/tunnel/'))).toHaveLength(
        1,
      );
      if (noCancel) {
        expect(f.stderr.join('\n')).toContain('still billed');
        expect(f.stderr.join('\n')).toContain('steps that still need your machine will fail');
        expect(f.stderr.join('\n')).toContain('can still pass');
        expect(f.stderr.join('\n')).toContain('testsprite test result a');
        expect(f.stderr.join('\n')).toContain('testsprite test wait run_a');
      }
      const payload = JSON.parse(f.stdout.join(''));
      expect(payload.results.map((r: { status: string }) => r.status)).toEqual([
        noCancel ? 'running' : 'cancelled',
        noCancel ? 'running' : 'cancelled',
        'not-run',
        'not-run',
      ]);
    },
  );

  it('aborts on tunnel client auth failure and cancels in-flight runs', async () => {
    let tunnelOptions: TunnelClientOptions | undefined;
    const f = fixture(['a', 'b', 'c'], {
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      tunnelFactory: options => {
        tunnelOptions = options;
        return { start: async () => {}, stop: async () => {} };
      },
      onCall: call => {
        if (call.method === 'GET' && call.url.includes('/runs/run_')) {
          tunnelOptions?.onError?.({
            code: ErrCode.AuthFailed,
            message: 'Control authentication failed',
          });
          return runningResponse(/run_([^/?]+)/.exec(call.url)![1]!);
        }
        return undefined;
      },
    });
    await expect(
      f.run(
        'a',
        'b',
        'c',
        '--local',
        '5173',
        '--skip-preflight',
        '--max-concurrency',
        '2',
        '--timeout',
        '1',
      ),
    ).rejects.toMatchObject({ exitCode: 10 });
    expect(f.calls.some(c => c.url.includes('/tests/c/runs'))).toBe(false);
    expect(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/cancel'))).toHaveLength(2);
    expect(JSON.parse(f.stdout.join('')).results[2].status).toBe('not-run');
  });

  it('detects tunnel loss on a nonterminal poll tick', async () => {
    let tunnelOptions: TunnelClientOptions | undefined;
    const f = fixture(['a', 'b'], {
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      tunnelFactory: options => {
        tunnelOptions = options;
        return { start: async () => {}, stop: async () => {} };
      },
      onCall: call => {
        if (call.method === 'GET' && call.url.includes('/runs/run_')) {
          tunnelOptions?.onError?.({
            code: ErrCode.AuthFailed,
            message: 'Control authentication failed',
          });
          return runningResponse(/run_([^/?]+)/.exec(call.url)![1]!);
        }
        return undefined;
      },
    });
    await expect(
      f.run(
        'a',
        'b',
        '--local',
        '5173',
        '--skip-preflight',
        '--max-concurrency',
        '2',
        '--timeout',
        '1',
      ),
    ).rejects.toMatchObject({ exitCode: 10 });
    expect(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/cancel'))).toHaveLength(2);
  });

  it('aborts other in-flight polls after tunnel loss', async () => {
    let tunnelOptions: TunnelClientOptions | undefined;
    let signalHeldPollStarted!: () => void;
    const heldPollStarted = new Promise<void>(resolve => {
      signalHeldPollStarted = resolve;
    });
    let heldPollAborted = false;
    const f = fixture(['a', 'b'], {
      tunnelFactory: options => {
        tunnelOptions = options;
        return { start: async () => {}, stop: async () => {} };
      },
      onCall: async (call, init) => {
        if (call.method === 'GET' && call.url.includes('/runs/run_b')) {
          signalHeldPollStarted();
          if (init.signal?.aborted) {
            heldPollAborted = true;
            throw init.signal.reason;
          }
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              'abort',
              () => {
                heldPollAborted = true;
                reject(init.signal?.reason);
              },
              { once: true },
            );
          });
        }
        if (call.method === 'GET' && call.url.includes('/runs/run_a')) {
          await heldPollStarted;
          tunnelOptions?.onError?.({
            code: ErrCode.AuthFailed,
            message: 'Control authentication failed',
          });
          return runningResponse('a');
        }
        return undefined;
      },
    });
    const startedAt = Date.now();
    await expect(
      f.run('a', 'b', '--local', '5173', '--skip-preflight', '--max-concurrency', '2'),
    ).rejects.toMatchObject({ exitCode: 10 });
    expect(heldPollAborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 15_000);

  it.each([false, true])(
    'borrows one tunnel without mint or delete and keeps runs on interrupt, no-cancel=%s',
    async noCancel => {
      const shutdown = new ShutdownController();
      const f = fixture(['a', 'b', 'c'], {
        shutdown,
        onCall: call => {
          if (call.method === 'GET' && call.url.includes('/runs/run_')) {
            shutdown.interrupt('SIGINT');
            return runningResponse(/run_([^/?]+)/.exec(call.url)![1]!);
          }
          return undefined;
        },
      });
      await expect(
        f.run(
          'a',
          'b',
          'c',
          '--local',
          '5173',
          '--skip-preflight',
          '--max-concurrency',
          '2',
          '--tunnel-client',
          f.clientId,
          ...(noCancel ? ['--no-cancel-on-interrupt'] : []),
        ),
      ).rejects.toBeInstanceOf(InterruptError);
      expect(f.calls.some(c => c.url.endsWith('/tunnel'))).toBe(false);
      expect(f.calls.some(c => c.method === 'DELETE')).toBe(false);
      expect(f.calls.some(c => c.url.endsWith('/cancel'))).toBe(false);
      expect(f.stderr.join('\n')).toContain(
        `[tunnel] Reaching ${f.targetUrl} through TestSprite (client ${f.clientId}).`,
      );
      expect(f.stderr.join('\n')).toContain('testsprite test wait run_');
      expect(f.stderr.join('\n')).not.toContain('The tunnel is closed');
    },
  );

  it('treats a borrowed owner 404 as tunnel loss and shares liveness checks', async () => {
    const f = fixture(['a', 'b', 'c'], {
      onCall: call => {
        if (call.method === 'GET' && call.url.includes('/runs/run_'))
          return runningResponse(/run_([^/?]+)/.exec(call.url)![1]!);
        if (call.method === 'GET' && call.url.includes('/tunnel/'))
          return new Response(
            JSON.stringify({
              error: {
                code: 'NOT_FOUND',
                message: 'gone',
                nextAction: '',
                requestId: 'r1',
                details: {},
              },
            }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          );
        return undefined;
      },
    });
    await expect(
      f.run(
        'a',
        'b',
        'c',
        '--local',
        '5173',
        '--skip-preflight',
        '--max-concurrency',
        '2',
        '--tunnel-client',
        f.clientId,
      ),
    ).rejects.toMatchObject({ exitCode: 10 });
    expect(f.calls.filter(c => c.method === 'GET' && c.url.includes('/tunnel/'))).toHaveLength(1);
    expect(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/cancel'))).toHaveLength(2);
    expect(f.calls.some(c => c.method === 'DELETE')).toBe(false);
  });

  it.each([
    [409, 'CONFLICT', 6],
    [404, 'NOT_FOUND', 4],
  ] as const)(
    'records a %i trigger error and continues the pool',
    async (status, code, exitCode) => {
      const f = fixture(['a', 'b'], {
        onCall: call =>
          call.method === 'POST' && call.url.includes('/tests/a/runs')
            ? new Response(
                JSON.stringify({
                  error: { code, message: 'refused', nextAction: '', requestId: 'r1', details: {} },
                }),
                { status, headers: { 'content-type': 'application/json' } },
              )
            : undefined,
      });
      await expect(f.run('a', 'b', '--local', '5173', '--skip-preflight')).rejects.toMatchObject({
        exitCode,
      });
      const payload = JSON.parse(f.stdout.join(''));
      expect(payload.results.map((r: { status: string }) => r.status)).toEqual(['error', 'passed']);
      expect(payload.results[0].error.code).toBe(code);
    },
  );

  it('keeps an in-flight conflict separate from runs accepted by this batch', async () => {
    const f = fixture(['a', 'b'], {
      onCall: call =>
        call.method === 'POST' && call.url.includes('/tests/a/runs')
          ? new Response(
              JSON.stringify({
                error: {
                  code: 'CONFLICT',
                  message: 'another run is in flight',
                  nextAction: 'Wait for the current run.',
                  requestId: 'r1',
                  details: { reason: 'run_in_flight', currentRunId: 'run_existing' },
                },
              }),
              { status: 409, headers: { 'content-type': 'application/json' } },
            )
          : undefined,
    });
    await expect(f.run('a', 'b', '--local', '5173', '--skip-preflight')).rejects.toMatchObject({
      exitCode: 6,
    });
    const payload = JSON.parse(f.stdout.join(''));
    expect(payload.results[0]).toMatchObject({ testId: 'a', status: 'error' });
    expect(payload.results[0].runId).toBeUndefined();
    expect(payload.results[1]).toMatchObject({ testId: 'b', runId: 'run_b', status: 'passed' });
    expect(f.calls.some(c => c.url.includes('run_existing'))).toBe(false);
  });

  it('counts a refused trigger without a run id as skipped in CI output', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'local-batch-refusal-')), 'summary.json');
    const f = fixture(['a', 'b'], {
      onCall: call =>
        call.method === 'POST' && call.url.includes('/tests/a/runs')
          ? new Response(
              JSON.stringify({
                error: {
                  code: 'CONFLICT',
                  message: 'in flight',
                  nextAction: '',
                  requestId: 'r1',
                  details: {},
                },
              }),
              { status: 409, headers: { 'content-type': 'application/json' } },
            )
          : undefined,
    });
    await expect(
      f.run('a', 'b', '--local', '5173', '--skip-preflight', '--summary-file', path),
    ).rejects.toMatchObject({ exitCode: 6 });
    expect(JSON.parse(f.stdout.join('')).results[0].status).toBe('error');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture path inside this test's own mkdtempSync-created temp dir, not user input.
    const summary = JSON.parse(readFileSync(path, 'utf8'));
    expect(summary).toMatchObject({ total: 2, passed: 1, failed: 0, skipped: 1 });
    expect(summary.runs[0].status).toBe('skipped');
  });

  it.each([
    [412, 'PRECONDITION_FAILED', 'tunnel-offline', 10],
    [403, 'AUTH_FORBIDDEN', '', 3],
  ] as const)('aborts on fatal trigger %s', async (status, code, reason, exitCode) => {
    const f = fixture(['a', 'b', 'c'], {
      onCall: call =>
        call.method === 'POST' && call.url.includes('/tests/a/runs')
          ? new Response(
              JSON.stringify({
                error: {
                  code,
                  message: 'refused',
                  nextAction: '',
                  requestId: 'r1',
                  details: { reason },
                },
              }),
              { status, headers: { 'content-type': 'application/json' } },
            )
          : undefined,
    });
    await expect(
      f.run('a', 'b', 'c', '--local', '5173', '--skip-preflight', '--max-concurrency', '1'),
    ).rejects.toMatchObject({ exitCode });
    expect(f.calls.some(c => c.url.includes('/tests/b/runs'))).toBe(false);
    const results = JSON.parse(f.stdout.join('')).results;
    expect(results[0]).toMatchObject({ status: 'error', error: { code } });
    expect(results[1].status).toBe('not-run');
  });

  it('keeps local count telemetry and drops negative values', async () => {
    const f = fixture(['a', 'b', 'c']);
    await f.run('a', 'b', 'c', '--local', '5173', '--skip-preflight', '--max-concurrency', '2');
    expect(takeTelemetryExtras()).toMatchObject({ localConcurrencyLimit: 2, localPeakInFlight: 2 });
    expect(sanitizeTelemetryExtras({ localConcurrencyLimit: 5, localPeakInFlight: -1 })).toEqual({
      localConcurrencyLimit: 5,
    });
  });

  it.each([false, true])('times out one %s borrowed run and continues', async borrowed => {
    const f = fixture(['a', 'b'], {
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      onCall: call => {
        if (call.method === 'GET' && call.url.includes('/runs/run_a')) return runningResponse('a');
        if (call.method === 'GET' && call.url.includes('/tunnel/'))
          return new Response(
            JSON.stringify({
              clientId: '11111111-2222-3333-4444-555555555555',
              status: 'Online',
              expiresAt: '2026-09-23T00:00:00.000Z',
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        return undefined;
      },
    });
    const args = ['a', 'b', '--local', '5173', '--skip-preflight', '--timeout', '1'];
    if (borrowed) args.push('--tunnel-client', f.clientId);
    await expect(f.run(...args)).rejects.toMatchObject({ exitCode: 7 });
    expect(JSON.parse(f.stdout.join('')).results.map((r: { status: string }) => r.status)).toEqual([
      'timeout',
      'passed',
    ]);
    expect(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/cancel'))).toHaveLength(
      borrowed ? 0 : 1,
    );
  });

  it('does not cancel a timed-out owned run under --no-cancel-on-interrupt', async () => {
    const f = fixture(['a', 'b'], {
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      onCall: call =>
        call.method === 'GET' && call.url.includes('/runs/run_a')
          ? runningResponse('a')
          : undefined,
    });
    await expect(
      f.run(
        'a',
        'b',
        '--local',
        '5173',
        '--skip-preflight',
        '--timeout',
        '1',
        '--no-cancel-on-interrupt',
      ),
    ).rejects.toMatchObject({ exitCode: 7 });
    expect(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/cancel'))).toHaveLength(0);
    expect(JSON.parse(f.stdout.join('')).results[0]).toMatchObject({
      status: 'timeout',
      cancel: 'skipped',
    });
  });

  it('counts only dispatched runs as accepted in telemetry', async () => {
    const f = fixture(['a', 'b', 'c'], {
      onCall: call =>
        call.method === 'POST' && call.url.includes('/tests/b/runs')
          ? new Response(
              JSON.stringify({
                error: {
                  code: 'NOT_FOUND',
                  message: 'no such test',
                  nextAction: '',
                  requestId: 'r',
                  details: {},
                },
              }),
              { status: 404, headers: { 'content-type': 'application/json' } },
            )
          : undefined,
    });
    await expect(f.run('a', 'b', 'c', '--local', '5173', '--skip-preflight')).rejects.toMatchObject(
      {
        exitCode: 4,
      },
    );
    expect(takeTelemetryExtras()).toMatchObject({ accepted: 2 });
  });

  it('tells a JSON caller what an interrupt did to the batch, not that runs keep billing', async () => {
    const shutdown = new ShutdownController();
    let interrupted = false;
    const f = fixture(['a', 'b'], {
      shutdown,
      onCall: call => {
        if (call.method === 'GET' && /\/runs\/run_[ab]/.test(call.url)) {
          if (!interrupted) {
            interrupted = true;
            shutdown.interrupt('SIGINT');
          }
          return runningResponse(/run_([ab])/.exec(call.url)![1]!);
        }
        return undefined;
      },
    });
    const err = (await f
      .run('a', 'b', '--local', '5173', '--skip-preflight')
      .catch((e: unknown) => e)) as InterruptError & { tunnelDetach?: { nextAction: string } };
    expect(err).toBeInstanceOf(InterruptError);
    expect(err.tunnelDetach?.nextAction).toContain('cancelled');
    expect(err.tunnelDetach?.nextAction).not.toContain('keeps executing');
  });

  it('preserves a signal raised while emitting CI output after tunnel loss', async () => {
    let tunnelOptions: TunnelClientOptions | undefined;
    const f = fixture(['a', 'b'], {
      tunnelFactory: options => {
        tunnelOptions = options;
        return { start: async () => {}, stop: async () => {} };
      },
      onCall: call => {
        if (call.method === 'GET' && call.url.includes('/runs/run_a')) {
          tunnelOptions?.onError?.({ code: ErrCode.AuthFailed, message: 'auth failed' });
          return runningResponse('a');
        }
        return undefined;
      },
      onStderr: line => {
        if (line.startsWith('::error')) throw new InterruptError('SIGTERM');
      },
    });
    await expect(
      f.run(
        'a',
        'b',
        '--local',
        '5173',
        '--skip-preflight',
        '--max-concurrency',
        '1',
        '--gh-output',
      ),
    ).rejects.toMatchObject({ code: 'INTERRUPTED', exitCode: 143 });
  });

  it('cancels a run whose trigger was still pending when the batch aborted', async () => {
    // The trigger is uninterruptible (it may already have been charged), so an
    // abort must wait for it and cancel what it returns before the tunnel goes.
    const shutdown = new ShutdownController();
    const f = fixture(['a', 'b'], {
      shutdown,
      onCall: async call => {
        if (call.method === 'POST' && call.url.includes('/tests/a/runs')) {
          shutdown.interrupt('SIGINT');
          await new Promise(resolve => setTimeout(resolve, 10_500));
        }
        if (call.method === 'GET' && call.url.includes('/runs/run_a')) return runningResponse('a');
        return undefined;
      },
    });
    await expect(
      f.run('a', 'b', '--local', '5173', '--skip-preflight', '--max-concurrency', '1'),
    ).rejects.toBeInstanceOf(InterruptError);
    const order = f.calls
      .filter(
        c =>
          c.url.endsWith('/runs/run_a/cancel') ||
          (c.method === 'DELETE' && c.url.includes('/tunnel/')),
      )
      .map(c => (c.method === 'DELETE' ? 'delete' : 'cancel'));
    expect(order).toEqual(['cancel', 'delete']);
    expect(JSON.parse(f.stdout.join('')).results[0]).toMatchObject({
      runId: 'run_a',
      status: 'cancelled',
    });
  }, 20_000);

  it('aborts the batch when a poll says the credential is unusable', async () => {
    const f = fixture(['a', 'b', 'c'], {
      onCall: call =>
        call.method === 'GET' && call.url.includes('/runs/run_a')
          ? new Response(
              JSON.stringify({
                error: {
                  code: 'AUTH_FORBIDDEN',
                  message: 'key revoked',
                  nextAction: '',
                  requestId: 'r',
                  details: {},
                },
              }),
              { status: 403, headers: { 'content-type': 'application/json' } },
            )
          : undefined,
    });
    await expect(
      f.run('a', 'b', 'c', '--local', '5173', '--skip-preflight', '--max-concurrency', '1'),
    ).rejects.toMatchObject({ exitCode: 3 });
    const triggered = f.calls
      .filter(c => c.method === 'POST' && /\/tests\/[^/]+\/runs/.test(c.url))
      .map(c => /\/tests\/([^/]+)\/runs/.exec(c.url)![1]);
    expect(triggered).toEqual(['a']);
    // The accepted run is still owned by this tunnel: it is cancelled before the
    // tunnel goes, even though its row reports the poll error.
    const order = f.calls
      .filter(
        c =>
          c.url.endsWith('/runs/run_a/cancel') ||
          (c.method === 'DELETE' && c.url.includes('/tunnel/')),
      )
      .map(c => (c.method === 'DELETE' ? 'delete' : 'cancel'));
    expect(order).toEqual(['cancel', 'delete']);
    expect(JSON.parse(f.stdout.join('')).results[0]).toMatchObject({
      runId: 'run_a',
      status: 'error',
      cancel: 'cancelled',
    });
  });

  it('refuses a dead local port for --all --local before any write', async () => {
    const f = fixture([]);
    // Port 9 (discard) is essentially never listening on a developer machine.
    await expect(f.run('--all', '--project', 'P', '--local', '9')).rejects.toMatchObject({
      exitCode: 5,
    });
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('honours --allow-empty for an empty project even when the local port is dead', async () => {
    const f = fixture([], {
      onCall: call =>
        call.method === 'GET' && call.url.includes('/tests?')
          ? new Response(JSON.stringify({ items: [], nextToken: null }), {
              headers: { 'content-type': 'application/json' },
            })
          : undefined,
    });
    await f.run('--all', '--project', 'P', '--local', '9', '--allow-empty');
    expect(JSON.parse(f.stdout.join('')).results).toEqual([]);
    expect(f.calls.some(c => c.method === 'POST')).toBe(false);
  });

  it('reports zero peak in flight when every trigger is refused', async () => {
    const f = fixture(['a', 'b'], {
      onCall: call =>
        call.method === 'POST' && /\/tests\/[^/]+\/runs/.test(call.url)
          ? new Response(
              JSON.stringify({
                error: {
                  code: 'NOT_FOUND',
                  message: 'gone',
                  nextAction: '',
                  requestId: 'r',
                  details: {},
                },
              }),
              { status: 404, headers: { 'content-type': 'application/json' } },
            )
          : undefined,
    });
    await expect(f.run('a', 'b', '--local', '5173', '--skip-preflight')).rejects.toMatchObject({
      exitCode: 4,
    });
    expect(takeTelemetryExtras()).toMatchObject({ localConcurrencyLimit: 5, localPeakInFlight: 0 });
  });

  it('prints one partial JSON object when interrupted while the tunnel is being minted', async () => {
    const shutdown = new ShutdownController();
    const f = fixture(['a', 'b'], {
      shutdown,
      onCall: call => {
        if (call.method === 'POST' && call.url.endsWith('/tunnel')) shutdown.interrupt('SIGINT');
        return undefined;
      },
    });
    await expect(f.run('a', 'b', '--local', '5173', '--skip-preflight')).rejects.toBeInstanceOf(
      InterruptError,
    );
    const payload = JSON.parse(f.stdout.join(''));
    expect(payload.results.map((r: { status: string }) => r.status)).toEqual([
      'not-run',
      'not-run',
    ]);
    expect(f.calls.filter(c => c.method === 'POST' && /\/tests\//.test(c.url))).toHaveLength(0);
  });

  it('starts each timeout when its trigger request begins', async () => {
    const f = fixture(['a', 'b'], {
      onCall: async call => {
        if (call.method === 'POST' && call.url.includes('/tests/a/runs')) {
          await new Promise(resolve => setTimeout(resolve, 1100));
        }
        return undefined;
      },
    });
    await expect(
      f.run(
        'a',
        'b',
        '--local',
        '5173',
        '--skip-preflight',
        '--timeout',
        '1',
        '--max-concurrency',
        '1',
      ),
    ).rejects.toMatchObject({ exitCode: 7 });
    expect(JSON.parse(f.stdout.join('')).results.map((r: { status: string }) => r.status)).toEqual([
      'timeout',
      'passed',
    ]);
  });

  it('uses distinct bounded per-test keys from a supplied base', async () => {
    const f = fixture(['a', 'b']);
    const base = 'k'.repeat(256);
    await f.run('a', 'b', '--local', '5173', '--skip-preflight', '--idempotency-key', base);
    const keys = f.calls
      .filter(c => c.method === 'POST' && /\/tests\/[^/]+\/runs/.test(c.url))
      .map(c => c.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys.map(key => key?.length)).toEqual([256, 256]);
    expect(keys[0]).toMatch(/:a$/);
    expect(keys[1]).toMatch(/:b$/);
    // A caller-supplied key is the caller's secret-ish handle: never echoed.
    expect(f.stderr.filter(line => line.startsWith('idempotency-key:'))).toEqual([]);
  });

  it('prints the first automatic trigger key once', async () => {
    const f = fixture(['a', 'b']);
    await f.run('a', 'b', '--local', '5173', '--skip-preflight');
    const keys = f.calls
      .filter(c => c.method === 'POST' && /\/tests\/[^/]+\/runs/.test(c.url))
      .map(c => c.idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
    expect(f.stderr.filter(line => line.startsWith('idempotency-key:'))).toEqual([
      `idempotency-key: ${keys[0]}`,
    ]);
  });

  it('prints the text table without inventing a project dashboard link', async () => {
    vi.stubEnv('TESTSPRITE_PORTAL_URL', 'https://app.testsprite.com');
    const f = fixture(['a', 'b']);
    await f.run('a', 'b', '--local', '5173', '--skip-preflight', '--project', 'P', '--text-output');
    expect(f.stdout.join('\n')).toContain('TEST ID');
    expect(f.stdout.join('\n')).not.toContain('/dashboard/tests/P');
  });

  it('shows a client-measured duration when the run has no server timestamps', async () => {
    const f = fixture(['a', 'b'], {
      onCall: call => {
        if (call.method !== 'GET' || !/\/runs\/run_/.test(call.url)) return undefined;
        const testId = /run_([^/?]+)/.exec(call.url)![1]!;
        return new Response(
          JSON.stringify({
            runId: `run_${testId}`,
            testId,
            projectId: 'P',
            userId: 'U',
            status: 'passed',
            source: 'cli',
            createdAt: '2026-09-22T00:00:00.000Z',
            startedAt: null,
            finishedAt: null,
            codeVersion: 'v1',
            targetUrl: 'http://127.0.0.1:5173',
            createdFrom: 'cli',
            failedStepIndex: null,
            failureKind: null,
            error: null,
            videoUrl: null,
            stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await f.run('a', 'b', '--local', '5173', '--skip-preflight', '--text-output');
    const rows = f.stdout
      .join('\n')
      .split('\n')
      .filter(line => line.startsWith('a ') || line.startsWith('b '));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.trim()).toMatch(/\d+s$/);
  });

  it('writes not-run rows as skipped in the CI summary on interrupt', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'local-batch-summary-')), 'summary.json');
    const shutdown = new ShutdownController();
    const f = fixture(['a', 'b'], {
      shutdown,
      onCall: call => {
        if (call.method === 'GET' && call.url.includes('/runs/run_a')) {
          shutdown.interrupt('SIGINT');
          return runningResponse('a');
        }
        return undefined;
      },
    });
    await expect(
      f.run(
        'a',
        'b',
        '--local',
        '5173',
        '--skip-preflight',
        '--max-concurrency',
        '1',
        '--summary-file',
        path,
      ),
    ).rejects.toBeInstanceOf(InterruptError);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture path inside this test's own mkdtempSync-created temp dir, not user input.
    const summary = JSON.parse(readFileSync(path, 'utf8'));
    expect(summary).toMatchObject({ total: 2, skipped: 1 });
    expect(summary.runs.map((r: { status: string }) => r.status)).toEqual(['cancelled', 'skipped']);
  });

  it('writes never-started tests as skipped JUnit cases on interrupt', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'local-batch-junit-int-')), 'results.xml');
    const shutdown = new ShutdownController();
    let interrupted = false;
    const f = fixture(['a', 'b'], {
      shutdown,
      onCall: call => {
        if (call.method === 'GET' && call.url.includes('/runs/run_a')) {
          if (!interrupted) {
            interrupted = true;
            shutdown.interrupt('SIGINT');
          }
          return runningResponse('a');
        }
        return undefined;
      },
    });
    await expect(
      f.run(
        'a',
        'b',
        '--local',
        '5173',
        '--skip-preflight',
        '--max-concurrency',
        '1',
        '--report',
        'junit',
        '--report-file',
        path,
        '--project',
        'P',
      ),
    ).rejects.toBeInstanceOf(InterruptError);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture path inside this test's own mkdtempSync-created temp dir, not user input.
    const xml = readFileSync(path, 'utf8');
    const caseB =
      /<testcase\b[^>]*name="b"[\s\S]*?<\/testcase>|<testcase\b[^>]*name="b"[^>]*\/>/.exec(
        xml,
      )?.[0] ?? '';
    expect(caseB).toContain('<skipped');
  });

  it('still exits with the interrupt when the JUnit report cannot be written', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'local-batch-junit-noproj-')), 'results.xml');
    const shutdown = new ShutdownController();
    let interrupted = false;
    const f = fixture(['a', 'b'], {
      shutdown,
      onCall: call => {
        if (call.method === 'GET' && call.url.includes('/runs/run_a')) {
          if (!interrupted) {
            interrupted = true;
            shutdown.interrupt('SIGINT');
          }
          return runningResponse('a');
        }
        return undefined;
      },
    });
    await expect(
      f.run(
        'a',
        'b',
        '--local',
        '5173',
        '--skip-preflight',
        '--max-concurrency',
        '1',
        '--report',
        'junit',
        '--report-file',
        path,
      ),
    ).rejects.toBeInstanceOf(InterruptError);
    expect(f.calls.filter(c => c.url.endsWith('/runs/run_a/cancel'))).toHaveLength(1);
  });

  it('writes a JUnit case for every local test', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'local-batch-junit-')), 'results.xml');
    const f = fixture(['a', 'b']);
    await f.run(
      'a',
      'b',
      '--local',
      '5173',
      '--skip-preflight',
      '--report',
      'junit',
      '--report-file',
      path,
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture path inside this test's own mkdtempSync-created temp dir, not user input.
    const xml = readFileSync(path, 'utf8');
    expect(xml.match(/<testcase\b/g)).toHaveLength(2);
    expect(xml).toContain('name="a"');
    expect(xml).toContain('name="b"');
  });

  it('records a poll API error, cancels the doomed owned run and continues', async () => {
    const f = fixture(['a', 'b'], {
      onCall: call =>
        call.method === 'GET' && call.url.includes('/runs/run_a')
          ? new Response(
              JSON.stringify({
                error: {
                  code: 'NOT_FOUND',
                  message: 'run missing',
                  nextAction: '',
                  requestId: 'r1',
                  details: {},
                },
              }),
              { status: 404, headers: { 'content-type': 'application/json' } },
            )
          : undefined,
    });
    await expect(f.run('a', 'b', '--local', '5173', '--skip-preflight')).rejects.toMatchObject({
      exitCode: 4,
    });
    expect(JSON.parse(f.stdout.join('')).results.map((r: { status: string }) => r.status)).toEqual([
      'error',
      'passed',
    ]);
    expect(f.calls.filter(c => c.method === 'POST' && c.url.endsWith('/cancel'))).toHaveLength(1);
  });

  it('clears the bounded abort-wait timer when the workers settle promptly', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const abortWaitTimers: ReturnType<typeof setTimeout>[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, ms, ...args) => {
      const timer = realSetTimeout(handler, ms, ...args);
      if (ms === 10_000) abortWaitTimers.push(timer);
      return timer;
    });
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const shutdown = new ShutdownController();
    const f = fixture(['a', 'b'], {
      shutdown,
      onCall: call => {
        if (call.method === 'GET' && call.url.includes('/runs/run_a')) {
          shutdown.interrupt('SIGINT');
          return runningResponse('a');
        }
        return undefined;
      },
    });
    try {
      await expect(
        f.run('a', 'b', '--local', '5173', '--skip-preflight', '--max-concurrency', '1'),
      ).rejects.toBeInstanceOf(InterruptError);
      expect(abortWaitTimers.length).toBeGreaterThan(0);
      expect(clear).toHaveBeenCalledWith(abortWaitTimers[0]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('allows an empty all-local frontend set when requested', async () => {
    const f = fixture([], {
      onCall: call =>
        call.method === 'GET' && call.url.includes('/tests?')
          ? new Response(
              JSON.stringify({
                items: [{ id: 'backend', name: 'API', type: 'backend' }],
                nextToken: null,
              }),
              { headers: { 'content-type': 'application/json' } },
            )
          : undefined,
    });
    await f.run('--all', '--project', 'P', '--local', '5173', '--allow-empty');
    expect(f.calls.some(c => c.method === 'POST')).toBe(false);
    expect(JSON.parse(f.stdout.join('')).results).toEqual([]);
  });
});

it('uses createdAt for local batch JUnit when the poll has no startedAt', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'local-batch-junit-timing-')), 'results.xml');
  const f = fixture(['a', 'b'], {
    onCall: call =>
      call.method === 'GET' && call.url.includes('/runs/run_a')
        ? new Response(
            JSON.stringify({
              runId: 'run_a',
              testId: 'a',
              projectId: 'P',
              userId: 'U',
              status: 'passed',
              source: 'cli',
              createdAt: '2026-09-22T00:00:00.000Z',
              startedAt: null,
              finishedAt: '2026-09-22T00:00:12.500Z',
              codeVersion: 'v1',
              targetUrl: 'http://localhost:5173',
              createdFrom: 'cli',
              failedStepIndex: null,
              failureKind: null,
              error: null,
              videoUrl: null,
              stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        : undefined,
  });
  await f.run(
    'a',
    'b',
    '--local',
    '5173',
    '--skip-preflight',
    '--report',
    'junit',
    '--report-file',
    path,
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads the JUnit report this test wrote to its own temp dir, never user input
  const xml = readFileSync(path, 'utf8');
  expect(xml).toContain('skipped="0" time="13.5">');
  expect(xml).toContain('runId="run_a" time="12.5">');
});
