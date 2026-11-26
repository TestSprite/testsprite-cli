import {
  projectRun,
  runListing,
  projectHarness,
  resultCard,
} from '../../test/helpers/project-run.js';
import { resultLine } from '../../test/helpers/result-list.js';
/**
 * Unit tests for `run <test-id>` — M3.3 piece-3.
 *
 * All HTTP is mocked via `makeFetch` / `makeCreds`. The polling loop's
 * sleep injection is wired through `TestDeps.sleep` to avoid real delays.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, InterruptError, RequestTimeoutError } from '../lib/errors.js';
import { ShutdownController } from '../lib/interrupt.js';
import { buildInterruptEnvelope } from '../lib/render-error.js';
import type { RunResponse } from '../lib/runs.types.js';
import { runTestRun, runTestRunAll } from './test.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function makeFetch(
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
): typeof globalThis.fetch {
  return (async (input: FetchInput, init: RequestInit = {}) => {
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
  apiUrl = 'http://localhost:13502',
): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-m33-run-'));
  const credentialsPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(credentialsPath, `[default]\napi_url = ${apiUrl}\napi_key = ${apiKey}\n`, {
    mode: 0o600,
  });
  return { credentialsPath };
}

const CURRENT_DEFAULT_ENVIRONMENTS = {
  environments: [
    { id: 'env_default', name: 'default', url: 'https://example.com', isDefault: true },
  ],
};

// Discovery reads must not consume the trigger/poll timing of ordinary-run fixtures.
function ordinaryRunDiscoveryResponse(
  input: FetchInput,
  init: RequestInit = {},
): Response | undefined {
  if ((init.method ?? 'GET') !== 'GET') return undefined;
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as { url: string }).url;
  const path = new URL(url).pathname;
  const body = /\/tests\/[^/]+$/.test(path)
    ? { type: 'frontend', projectId: 'project_1' }
    : /\/projects\/[^/]+\/env$/.test(path)
      ? CURRENT_DEFAULT_ENVIRONMENTS
      : undefined;
  return body === undefined
    ? undefined
    : new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
}

function errorBody(
  code: string,
  details: Record<string, unknown> = {},
): {
  status: number;
  body: unknown;
} {
  const statusMap: Record<string, number> = {
    AUTH_REQUIRED: 401,
    AUTH_FORBIDDEN: 403,
    NOT_FOUND: 404,
    VALIDATION_ERROR: 400,
    CONFLICT: 409,
    RATE_LIMITED: 429,
    INTERNAL: 500,
    UNAVAILABLE: 503,
  };
  return {
    status: statusMap[code] ?? 400,
    body: {
      error: {
        code,
        message: `Error: ${code}`,
        nextAction: 'do something',
        requestId: 'req_test',
        details,
      },
    },
  };
}

const instantSleep = () => Promise.resolve();

function disableExits(cmd: Command): void {
  cmd.exitOverride();
  cmd.commands.forEach(disableExits);
}

// ---------------------------------------------------------------------------
// Surface test
// ---------------------------------------------------------------------------

describe('createRunCommand — run + wait subcommands exposed', () => {
  it('exposes run and wait as top-level subcommands', async () => {
    const { createRunCommand } = await import('./test.js');
    const test = createRunCommand();
    const names = test.commands.map(c => c.name()).sort();
    expect(test.name()).toBe('run');
    expect(names).toContain('cancel');
    expect(names).toContain('wait');
  });

  it('run subcommand has --wait, --timeout, --idempotency-key flags and no --target-url', async () => {
    const { createRunCommand } = await import('./test.js');
    const test = createRunCommand();
    const run = test;
    const flagNames = run.options.map(o => o.long);
    expect(flagNames).toContain('--wait');
    expect(flagNames).toContain('--timeout');
    expect(flagNames).not.toContain('--target-url');
    expect(flagNames).toContain('--idempotency-key');
  });

  it('wait subcommand has --timeout flag', async () => {
    const { createRunCommand } = await import('./test.js');
    const test = createRunCommand();
    const wait = test.commands.find(c => c.name() === 'wait')!;
    const flagNames = wait.options.map(o => o.long);
    expect(flagNames).toContain('--timeout');
  });
});

// ---------------------------------------------------------------------------
// runTestRun — no-wait path (fire and return)
// ---------------------------------------------------------------------------

describe('runTestRun — no-wait (fire and return)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('happy path — fires trigger, returns the project launch receipt, exit 0 (no throw)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(url => {
      if (url.includes('/runs')) return { body: projectRun() };
      return { status: 404, body: {} };
    });
    const stdout: string[] = [];
    const result = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        knownTest: { projectId: 'project_1', type: 'frontend' as const },
        wait: false,
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: line => stdout.push(line), sleep: instantSleep },
    );
    // Should return TriggerRunResponse (not RunResponse)
    expect(result).toMatchObject({ runs: [{ runId: 'exec_abc', total: 1 }] });
    expect(stdout.join('')).toContain('exec_abc');
  });

  it('honours TESTSPRITE_REQUEST_TIMEOUT_MS for an ordinary non-wait trigger', async () => {
    vi.useFakeTimers();
    try {
      const { credentialsPath } = makeCreds();
      let abortedAt1250Ms = false;
      const fetchImpl = (async (input: FetchInput, init: RequestInit = {}) => {
        const discovery = ordinaryRunDiscoveryResponse(input, init);
        if (discovery) return discovery;
        return new Promise<Response>((resolve, reject) => {
          const signal = init.signal;
          setTimeout(() => {
            abortedAt1250Ms = signal?.aborted === true;
            resolve(
              new Response(JSON.stringify(projectRun()), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            );
          }, 1_250);
          const rejectOnAbort = (): void =>
            reject(signal?.reason ?? new DOMException('aborted', 'AbortError'));
          if (signal?.aborted) rejectOnAbort();
          else signal?.addEventListener('abort', rejectOnAbort, { once: true });
        });
      }) as typeof globalThis.fetch;

      const outcomePromise = runTestRun(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_xyz',
          knownTest: { projectId: 'project_1', type: 'frontend' as const },
          wait: false,
          timeoutSeconds: 60,
        },
        {
          credentialsPath,
          env: { TESTSPRITE_REQUEST_TIMEOUT_MS: '1000' },
          fetchImpl,
          stdout: () => {},
          stderr: () => {},
        },
      ).then(
        value => ({ status: 'resolved' as const, value }),
        error => ({ status: 'rejected' as const, error: error as unknown }),
      );

      await vi.advanceTimersByTimeAsync(1_250);
      const outcome = await outcomePromise;
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(outcome.error).toBeInstanceOf(RequestTimeoutError);
        expect(outcome.error).toMatchObject({ timeoutMs: 1_000, exitCode: 7 });
      }
      expect(abortedAt1250Ms).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no-wait path sends POST to /projects/{projectId}/runs', async () => {
    const { credentialsPath } = makeCreds();
    const seenUrls: string[] = [];
    const fetchImpl = makeFetch(url => {
      seenUrls.push(url);
      return { body: projectRun() };
    });
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        knownTest: { projectId: 'project_1', type: 'frontend' as const },
        wait: false,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        sleep: instantSleep,
      },
    );
    expect(seenUrls.some(u => u.includes('/projects/project_1/runs'))).toBe(true);
  });

  it('sends correct idempotency key header when provided', async () => {
    const { credentialsPath } = makeCreds();
    const seenHeaders: Record<string, string>[] = [];
    const fetchImpl = (async (_input: FetchInput, init: RequestInit = {}) => {
      const h = new Headers(init.headers);
      const entry: Record<string, string> = {};
      h.forEach((v, k) => {
        entry[k] = v;
      });
      seenHeaders.push(entry);
      return new Response(JSON.stringify(projectRun()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        knownTest: { projectId: 'project_1', type: 'frontend' as const },
        wait: false,
        timeoutSeconds: 60,
        idempotencyKey: 'test-idem-key-001',
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        sleep: instantSleep,
      },
    );
    const triggerHeaders = seenHeaders.find(h => h['idempotency-key']);
    expect(triggerHeaders?.['idempotency-key']).toBe('test-idem-key-001');
  });

  it('--output json prints JSON envelope on stdout', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: projectRun() }));
    const stdout: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        knownTest: { projectId: 'project_1', type: 'frontend' as const },
        wait: false,
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: line => stdout.push(line), sleep: instantSleep },
    );
    const parsed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    // The launch is `runId`; this test's part of it is `resultId`.
    expect(parsed.runs).toEqual([projectRun()]);
    expect(parsed).not.toHaveProperty('accepted');
    expect(parsed).not.toHaveProperty('resultId');
    expect(stdout.join('')).not.toContain('executionId');
  });
});

// ---------------------------------------------------------------------------
// runTestRun — --wait path
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The auto-heal field on the fresh-run wire
//
// The CLI never sends it: omission is how the server's protected default
// ("heal, but replay a user-authored body rather than rewriting it") is
// requested, and an explicit `true` would mean something different and worse —
// an unconditional heal that re-authors code the user wrote.
// ---------------------------------------------------------------------------
describe('runTestRun / runTestRunAll — autoHeal on the wire', () => {
  function captureBody(bodies: Record<string, unknown>[], resp: unknown): typeof globalThis.fetch {
    return makeFetch((url, init) => {
      if (init.body) bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      if (url.includes('/runs') || url.includes('/batch/run')) return { body: resp };
      return { status: 404, body: {} };
    });
  }

  const EMPTY_BATCH = projectRun({ projectId: 'project_x', total: 0 });

  const baseOpts = {
    profile: 'default' as const,
    output: 'json' as const,
    debug: false,
    dryRun: false,
    wait: false,
    timeoutSeconds: 60,
  };

  it('omits autoHeal entirely by default — absence IS the request', async () => {
    const { credentialsPath } = makeCreds();
    const bodies: Record<string, unknown>[] = [];
    await runTestRun(
      {
        ...baseOpts,
        testId: 'test_xyz',
        knownTest: { projectId: 'project_1', type: 'frontend' as const },
      },
      {
        credentialsPath,
        fetchImpl: captureBody(bodies, projectRun()),
        stdout: () => undefined,
        sleep: instantSleep,
      },
    );
    expect(bodies[0]).not.toHaveProperty('autoHeal');
  });

  // `--all --wait` must resolve the server-controlled default identically.
  it('omits autoHeal on the --all batch dispatch by default', async () => {
    const { credentialsPath } = makeCreds();
    const bodies: Record<string, unknown>[] = [];
    await runTestRunAll(
      { ...baseOpts, projectId: 'project_x', maxConcurrency: 5 },
      {
        credentialsPath,
        fetchImpl: captureBody(bodies, EMPTY_BATCH),
        stdout: () => undefined,
        stderr: () => undefined,
        env: {} as NodeJS.ProcessEnv,
        sleep: instantSleep,
      },
    ).catch(() => undefined);
    expect(bodies[0]).not.toHaveProperty('autoHeal');
  });
});

// ---------------------------------------------------------------------------
// The server's heal decision comes back with the launch
// ---------------------------------------------------------------------------
describe('runTestRun — the autoHeal echo', () => {
  const baseOpts = {
    profile: 'default' as const,
    output: 'json' as const,
    debug: false,
    dryRun: false,
    wait: false,
    timeoutSeconds: 60,
    testId: 'test_xyz',
    knownTest: { projectId: 'project_1', type: 'frontend' as const },
  };

  function run(respExtra: Record<string, unknown>) {
    const { credentialsPath } = makeCreds();
    const stderr: string[] = [];
    const fetchImpl = makeFetch(url =>
      url.includes('/runs')
        ? { body: { ...projectRun(), ...respExtra } }
        : { status: 404, body: {} },
    );
    return runTestRun(baseOpts, {
      credentialsPath,
      fetchImpl,
      stdout: () => undefined,
      stderr: line => stderr.push(line),
      sleep: instantSleep,
    }).then(() => stderr.join('\n'));
  }

  // An older backend: the field never comes back at all. The remedy is a
  // different one (upgrade the endpoint), so the message says so.
  it('rejects a project launch response missing its required autoHeal decision', async () => {
    await expect(run({ autoHeal: undefined })).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('says nothing about healing, whatever the server decided', async () => {
    expect(await run({ autoHeal: true })).not.toContain('auto-heal');
    expect(await run({ autoHeal: false })).not.toContain('auto-heal');
  });
});

describe('runTestRun — with --wait', () => {
  const opts = {
    profile: 'default',
    output: 'json' as const,
    debug: false,
    testId: 'test_xyz',
    wait: true,
    timeoutSeconds: 30,
  };
  const line = (testStatus: string) =>
    resultLine({ resultId: 'run_abc', runId: 'exec_abc', caseKey: 'test_xyz', testStatus });

  it('polls until the execution finishes and returns its native results', async () => {
    let reads = 0;
    const h = projectHarness({
      listing: () =>
        runListing({ status: ++reads < 2 ? 'running' : 'finished', cancelled: false }, [
          line(reads < 2 ? 'RUNNING' : 'PASSED'),
        ]),
    });
    const result = await runTestRun(opts, h.deps);
    expect(reads).toBe(2);
    expect(result).toMatchObject({
      runs: [{ runId: 'exec_abc' }],
      results: [{ resultId: 'run_abc', runId: 'exec_abc', status: 'passed' }],
      summary: { total: 1, passed: 1 },
    });
  });

  it('keeps an unfinished result separate from failures on interrupt', async () => {
    const shutdown = new ShutdownController();
    const h = projectHarness({
      listing: () => runListing({ status: 'running', cancelled: false }, [line('RUNNING')]),
    });
    await expect(
      runTestRun(
        { ...opts, output: 'text' },
        {
          ...h.deps,
          shutdown,
          sleep: async () => {
            shutdown.interrupt('SIGINT');
            throw shutdown.signal.reason;
          },
        },
      ),
    ).rejects.toMatchObject({ exitCode: 130 });
    expect(h.stdout.join('\n')).toContain('0/1 passed, 0 failed, 0 timed out, 1 still running');
  });

  it('refuses a summary file in a missing directory before dispatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-summary-path-'));
    const h = projectHarness();
    try {
      await expect(
        runTestRun({ ...opts, summaryFile: join(dir, 'missing', 'summary.json') }, h.deps),
      ).rejects.toMatchObject({ exitCode: 5, details: { field: 'summary-file' } });
      expect(h.calls.filter(call => call.method === 'POST')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['FAILED', 'BLOCKED', 'CANCELLED'])(
    'keeps terminal %s results red with native result IDs',
    async status => {
      const h = projectHarness({
        listing: () => runListing({ status: 'finished', cancelled: false }, [line(status)]),
      });
      await expect(runTestRun(opts, h.deps)).rejects.toMatchObject({ exitCode: 1 });
      expect(JSON.parse(h.stdout.join('')).results).toMatchObject([
        { resultId: 'run_abc', runId: 'exec_abc', status: status.toLowerCase() },
      ]);
      if (status === 'CANCELLED') expect(h.stderr.join('\n')).not.toContain('result get');
      else expect(h.stderr.join('\n')).toContain('testsprite result get run_abc');
    },
  );

  it('refuses a backend without execution metadata instead of polling a result as a run', async () => {
    const h = projectHarness({ listing: () => ({ results: [line('PASSED')] }) });
    await expect(runTestRun(opts, h.deps)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      exitCode: 7,
    });
    expect(h.calls.some(call => /\/runs\/run_abc/.test(call.url.pathname))).toBe(false);
  });

  it('rejects an older launch shape without inventing an execution identity', async () => {
    const h = projectHarness({
      answer: (_url, init) =>
        init.method === 'POST'
          ? new Response(JSON.stringify({ resultId: 'old-result', status: 'queued' }), {
              headers: { 'content-type': 'application/json' },
            })
          : undefined,
    });
    await expect(runTestRun(opts, h.deps)).rejects.toMatchObject({ code: 'INTERNAL', exitCode: 1 });
    expect(h.calls.filter(call => call.url.pathname === '/api/cli/v1/results')).toEqual([]);
    expect(h.stdout.join('')).not.toContain('old-result');
  });

  it.each(['json', 'text'] as const)(
    'reports an outage past the deadline honestly in %s output',
    async output => {
      vi.useFakeTimers();
      try {
        const h = projectHarness({
          answer: url => {
            if (url.pathname.endsWith('/results')) throw new TypeError('fetch failed');
            return undefined;
          },
        });
        const pending = runTestRun({ ...opts, output }, { ...h.deps, sleep: undefined }).catch(
          err => err,
        );
        await vi.advanceTimersByTimeAsync(35_000);
        const failure = await pending;
        expect(failure).toMatchObject({ code: 'UNAVAILABLE', exitCode: 10 });
        expect(failure.nextAction).toContain('Service is temporarily unavailable');
        expect(h.stderr.join('\n')).toContain('testsprite run wait exec_abc');
        expect(h.stderr.join('\n')).toContain('Run exec_abc');
        if (output === 'json')
          expect(JSON.parse(h.stdout.join(''))).toMatchObject({
            runs: [{ runId: 'exec_abc' }],
            partial: true,
          });
        else expect(h.stdout.join('\n')).toContain('exec_abc');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('a deadline preserves run IDs and offers whole-run wait/cancel commands', async () => {
    vi.useFakeTimers();
    try {
      const h = projectHarness({
        listing: () => runListing({ status: 'running', cancelled: false }, [line('RUNNING')]),
      });
      const pending = runTestRun(
        { ...opts, timeoutSeconds: 1 },
        { ...h.deps, sleep: undefined },
      ).catch(err => err);
      await vi.advanceTimersByTimeAsync(5_000);
      const failure = await pending;
      expect(failure).toMatchObject({ code: 'UNSUPPORTED', exitCode: 7 });
      expect(failure.nextAction).toContain('testsprite run wait exec_abc');
      expect(h.stderr.join('\n')).toContain('testsprite run wait exec_abc');
      expect(failure.nextAction).toContain('testsprite run cancel exec_abc');
      expect(JSON.parse(h.stdout.join('')).results).toMatchObject([
        { resultId: 'run_abc', runId: 'exec_abc', status: 'timeout' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('JSON output keeps ANSI ticker sequences off stderr', async () => {
    const h = projectHarness({
      listing: () => runListing({ status: 'finished', cancelled: false }, [line('PASSED')]),
    });
    await runTestRun(opts, h.deps);
    expect(h.stderr.join('\n')).not.toContain('\x1b[');
  });
});

// ---------------------------------------------------------------------------
// runTestRun — error scenarios
// ---------------------------------------------------------------------------

describe('runTestRun — error scenarios', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('409 CONFLICT → throws ApiError exit 6 (already running)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => errorBody('CONFLICT', { currentRunId: 'run_existing' }));
    const err = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: false,
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: () => {}, sleep: instantSleep },
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('CONFLICT');
    expect((err as ApiError).exitCode).toBe(6);
  });

  it('403 AUTH_FORBIDDEN → throws ApiError exit 3', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => errorBody('AUTH_FORBIDDEN'));
    const err = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: false,
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: () => {}, sleep: instantSleep },
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).exitCode).toBe(3);
  });

  it('400 VALIDATION_ERROR from server → throws ApiError exit 5', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => errorBody('VALIDATION_ERROR'));
    const err = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: false,
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: () => {}, sleep: instantSleep },
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('VALIDATION_ERROR');
    expect((err as ApiError).exitCode).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// runTestRun — dry-run path
// ---------------------------------------------------------------------------

describe('runTestRun — dry-run', () => {
  it('keeps credentialless previews offline and prints the strict project descriptor', async () => {
    const stdout: string[] = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error('must remain offline');
    });
    await runTestRun(
      { ...heldRunOptions, dryRun: true, wait: false },
      {
        credentialsPath: join(mkdtempSync(join(tmpdir(), 'run-dry-no-creds-')), 'missing'),
        env: {},
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: () => {},
      },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      dryRun: true,
      requests: [
        {
          method: 'POST',
          path: '/api/cli/v1/projects/%3Cproject-id%3E/runs',
          body: { testIds: ['test_xyz'], maxConcurrency: 5 },
        },
      ],
    });
  });
  it('describes whole-run polling when --wait is requested', async () => {
    const h = projectHarness();
    await runTestRun({ ...heldRunOptions, dryRun: true }, h.deps);
    expect(JSON.parse(h.stdout.join(''))).toMatchObject({
      dryRun: true,
      thenPoll: '/api/cli/v1/results?run=<run-id>&status=passed,failed,running,blocked,cancelled',
    });
    expect(h.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('does not invent dispatched execution or result IDs', async () => {
    const h = projectHarness();
    await runTestRun({ ...heldRunOptions, dryRun: true, wait: false }, h.deps);
    const output = JSON.parse(h.stdout.join(''));
    expect(output.runId).toBeUndefined();
    expect(output.resultId).toBeUndefined();
    expect(output.requests).toHaveLength(1);
    expect(output).toMatchObject({ runs: [], results: [] });
    expect(output).not.toHaveProperty('summary');
  });
});

// ---------------------------------------------------------------------------
// runTestRun — Bug 2 dogfood round-4 2026-05-17
// CONFLICT + --wait auto-resume on currentRunId
// ---------------------------------------------------------------------------

const heldRunOptions = {
  profile: 'default',
  output: 'json' as const,
  debug: false,
  testId: 'test_xyz',
  wait: true,
  timeoutSeconds: 30,
};
function heldRunHarness(
  config: {
    card?: Partial<RunResponse>;
    conflicts?: unknown[];
    multiple?: boolean;
    reason?: string;
    status?: string;
    cancelled?: boolean;
    environments?: unknown[];
    environmentStatus?: number;
    interruptAt?: 'card' | 'environment' | 'listing';
    shutdown?: ShutdownController;
  } = {},
) {
  const error = {
    code: 'CONFLICT',
    message: config.multiple
      ? 'A run is already in flight for 2 of the targeted test cases.'
      : 'Test case test_xyz already has run exec_held in flight.',
    nextAction:
      'Another run is already in flight. Poll it with: testsprite run wait exec_held — or wait for it to finish before triggering again. Do not retry immediately; the trigger will keep being refused until the run completes.',
    requestId: 'req-held',
    details: {
      reason: config.reason ?? 'run_in_flight',
      projectId: 'project_1',
      currentRunId: 'exec_held',
      currentResultId: 'result_held',
      conflicts: config.conflicts ?? [
        {
          testId: 'test_xyz',
          currentRunId: 'exec_held',
          currentResultId: 'result_held',
        },
        ...(config.multiple
          ? [{ testId: 'test_second', currentRunId: 'exec_held', currentResultId: 'result_second' }]
          : []),
      ],
    },
  };
  let launched = false;
  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const interrupt = (stage: 'card' | 'environment' | 'listing') => {
    if (stage === config.interruptAt && config.shutdown) {
      config.shutdown.interrupt('SIGINT');
      throw config.shutdown.signal.reason;
    }
  };
  const h = projectHarness({
    answer: (url, init) => {
      if (init.method === 'POST') {
        launched = true;
        return answer({ error }, 409);
      }
      if (url.pathname.endsWith('/tests/test_second'))
        return answer({ id: 'test_second', type: 'frontend', projectId: 'project_1' });
      if (url.pathname.endsWith('/runs/result_second'))
        return answer(
          resultCard({
            resultId: 'result_second',
            runId: 'exec_held',
            testId: 'test_second',
            ...config.card,
          }),
        );
      if (url.pathname.endsWith('/runs/result_held')) {
        interrupt('card');
        return answer(resultCard({ resultId: 'result_held', runId: 'exec_held', ...config.card }));
      }
      if (url.pathname.endsWith('/env')) {
        if (launched) interrupt('environment');
        return config.environmentStatus
          ? answer({ error: { ...error, code: 'AUTH_FORBIDDEN' } }, config.environmentStatus)
          : answer({
              environments: config.environments ?? CURRENT_DEFAULT_ENVIRONMENTS.environments,
            });
      }
      return undefined;
    },
    listing: () => {
      interrupt('listing');
      return runListing(
        {
          runId: 'exec_held',
          status: config.cancelled ? 'finished' : 'running',
          cancelled: config.cancelled ?? false,
        },
        [
          resultLine({
            runId: 'exec_held',
            resultId: 'result_held',
            caseKey: 'test_xyz',
            testStatus: config.status ?? 'PASSED',
          }),
          ...(config.multiple
            ? [
                resultLine({
                  runId: 'exec_held',
                  resultId: 'result_second',
                  caseKey: 'test_second',
                  testStatus: config.status ?? 'PASSED',
                }),
              ]
            : []),
          resultLine({
            runId: 'exec_held',
            resultId: 'unrelated',
            caseKey: 'other',
            testStatus: 'FAILED',
          }),
        ],
      );
    },
  });
  return { ...h, error };
}

describe('actual all-held project contract', () => {
  const bulk = { ...heldRunOptions, projectId: 'project_1', maxConcurrency: 2 };
  it.each([false, true])('joins all-held bulk work without allow-empty (named=%s)', async named => {
    const h = heldRunHarness({ multiple: named });
    await runTestRunAll(
      { ...bulk, ...(named ? { testIds: ['test_xyz', 'test_second'] } : {}) },
      h.deps,
    );
    const output = JSON.parse(h.stdout.join(''));
    expect(output).toMatchObject({
      runs: [{ runId: 'exec_held', joined: true }],
      joinedRuns: [
        {
          runId: 'exec_held',
          resultIds: named ? ['result_held', 'result_second'] : ['result_held'],
        },
      ],
      summary: { passed: named ? 2 : 1, failed: 0 },
    });
    expect(h.calls.filter(c => c.method === 'POST')).toHaveLength(1);
    expect(h.calls.some(c => c.url.pathname.endsWith('/cancel'))).toBe(false);
    expect(output).not.toHaveProperty('partial');
  });
  it('retains a failed joined bulk verdict', async () => {
    const h = heldRunHarness({ status: 'FAILED' });
    await expect(runTestRunAll(bulk, h.deps)).rejects.toMatchObject({ exitCode: 1 });
    expect(JSON.parse(h.stdout.join('')).summary.failed).toBe(1);
  });
  it.each([
    { allowEmpty: false, failOnSkipped: false, exitCode: 5 },
    { allowEmpty: true, failOnSkipped: false, exitCode: 0 },
    { allowEmpty: true, failOnSkipped: true, exitCode: 1 },
  ])(
    'keeps incompatible-only gates $allowEmpty/$failOnSkipped',
    async ({ allowEmpty, failOnSkipped, exitCode }) => {
      const h = heldRunHarness({ card: { projectId: 'other-project' } });
      const error = await runTestRunAll(
        { ...bulk, allowEmpty, ci: { executionReport: false, failOnSkipped } },
        h.deps,
      ).then(
        () => undefined,
        e => e,
      );
      expect(error?.exitCode ?? 0).toBe(exitCode);
      const output = JSON.parse(h.stdout.join(''));
      expect(output.skipped).toHaveLength(1);
      expect(output).not.toHaveProperty('joinedRuns');
      expect(h.calls.some(c => c.url.pathname.endsWith('/results'))).toBe(false);
    },
  );
  it.each([false, true])('keeps truly empty project policy allowEmpty=%s', async allowEmpty => {
    const h = projectHarness({
      launch: projectRun({ total: 0 }),
      listing: () => runListing({ status: 'finished', cancelled: false }, []),
    });
    const error = await runTestRunAll({ ...bulk, allowEmpty }, h.deps).then(
      () => undefined,
      e => e,
    );
    expect(error?.exitCode ?? 0).toBe(allowEmpty ? 0 : 5);
    expect(JSON.parse(h.stdout.join('')).summary.total).toBe(0);
  });
  it('refuses an unrelated top-level conflict without rewriting its envelope', async () => {
    const h = heldRunHarness({ reason: 'idempotency_body_mismatch' });
    await expect(runTestRunAll(bulk, h.deps)).rejects.toMatchObject(h.error);
    expect(h.calls.some(c => c.url.pathname.endsWith('/runs/result_held'))).toBe(false);
  });
});

describe('runTestRun — CONFLICT + --wait auto-resume (dogfood round-4)', () => {
  it('joins the native held result in its execution without launching again', async () => {
    const h = heldRunHarness();
    const result = await runTestRun(heldRunOptions, h.deps);
    expect(result).toMatchObject({
      runs: [{ runId: 'exec_held', joined: true }],
      joinedRuns: [{ runId: 'exec_held', resultIds: ['result_held'] }],
      results: [{ resultId: 'result_held', runId: 'exec_held', status: 'passed' }],
    });
    expect(h.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(h.stderr.join('\n')).toContain('joined');
  });
  it.each([
    {
      label: 'missing test ID',
      conflicts: [{ currentRunId: 'exec_held', currentResultId: 'result_held' }],
    },
    {
      label: 'non-string execution ID',
      conflicts: [{ testId: 'test_xyz', currentRunId: 42, currentResultId: 'result_held' }],
    },
    { label: 'null conflict row', conflicts: [null] },
    {
      label: 'missing execution ID',
      conflicts: [{ testId: 'test_xyz', reason: 'in_flight', currentResultId: 'result_held' }],
    },
    {
      label: 'missing result ID',
      conflicts: [{ testId: 'test_xyz', reason: 'in_flight', currentRunId: 'exec_held' }],
    },
    {
      label: 'unrelated conflict reason',
      reason: 'idempotency_body_mismatch',
      conflicts: [
        {
          testId: 'test_xyz',
          reason: 'idempotency_body_mismatch',
          currentRunId: 'exec_held',
          currentResultId: 'result_held',
        },
      ],
    },
  ])('does not join a conflict with $label', async ({ conflicts, reason }) => {
    const h = heldRunHarness({ conflicts, reason });
    await expect(runTestRun(heldRunOptions, h.deps)).rejects.toMatchObject({
      code: 'CONFLICT',
      exitCode: 6,
    });
    expect(h.calls.some(call => call.url.pathname.endsWith('/results'))).toBe(false);
  });
  it('does not join without --wait and preserves the entire server error', async () => {
    const h = heldRunHarness();
    await expect(runTestRun({ ...heldRunOptions, wait: false }, h.deps)).rejects.toMatchObject(
      h.error,
    );
    expect(h.calls.some(call => call.url.pathname.endsWith('/runs/result_held'))).toBe(false);
  });
  it('uses the conflict execution and result IDs instead of the usual fixture launch IDs', async () => {
    const h = heldRunHarness();
    await runTestRun(heldRunOptions, h.deps);
    const reads = h.calls.filter(call => call.url.pathname.endsWith('/results'));
    expect(reads.map(call => call.url.searchParams.get('run'))).toEqual(['exec_held']);
    expect(JSON.parse(h.stdout.join('')).results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// CONFLICT target-URL verification (codex round-1 finding 3)
// ---------------------------------------------------------------------------

describe('runTestRun — CONFLICT held-run verification (codex round-1 finding-3)', () => {
  it.each([
    { label: 'different environment', environment: { id: 'env_other', name: 'other' } },
    { label: 'missing environment', environment: undefined },
    { label: 'null environment', environment: null },
    { label: 'empty environment identity', environment: { id: '', name: 'default' } },
    {
      label: 'deleted and recreated environment name',
      environment: { id: 'env_deleted', name: 'default' },
    },
  ])('refuses $label without substituting another run verdict', async ({ environment }) => {
    const h = heldRunHarness({ card: { environment } });
    await expect(runTestRun(heldRunOptions, h.deps)).rejects.toMatchObject(h.error);
    expect(h.calls.some(call => call.url.pathname.endsWith('/results'))).toBe(false);
  });
  it.each([undefined, null])(
    'fails closed on environment %s when --env is explicit',
    async environment => {
      const h = heldRunHarness({ card: { environment } });
      await expect(
        runTestRun({ ...heldRunOptions, environment: 'default' }, h.deps),
      ).rejects.toMatchObject({ exitCode: 6 });
    },
  );
  it.each([
    {
      label: 'default environment changed',
      environments: [
        { id: 'env_new', name: 'default', url: 'https://example.com', isDefault: true },
      ],
    },
    {
      label: 'current environment ID missing',
      environments: [{ id: '', name: 'default', url: 'https://example.com', isDefault: true }],
    },
    { label: 'environment list empty', environments: [] },
  ])('fails closed when $label', async ({ environments }) => {
    const h = heldRunHarness({ environments });
    await expect(runTestRun(heldRunOptions, h.deps)).rejects.toMatchObject(h.error);
    expect(h.calls.some(call => call.url.pathname.endsWith('/results'))).toBe(false);
  });
  it('preserves an authentication failure during environment verification', async () => {
    const h = heldRunHarness({ environmentStatus: 403 });
    await expect(runTestRun(heldRunOptions, h.deps)).rejects.toMatchObject({
      code: 'AUTH_FORBIDDEN',
      exitCode: 3,
    });
  });
  it.each([
    'staging',
    'QA West',
    "Owner's QA",
    'local-dev',
    'local-http',
    'local-ipv6',
    'local-https',
  ])('joins the requested %s environment only when its current ID matches', async name => {
    const h = heldRunHarness({
      card: { environment: { id: 'env_named', name } },
      environments: [{ id: 'env_named', name, url: 'https://example.com', isDefault: false }],
    });
    await runTestRun(
      {
        ...heldRunOptions,
        environment: name,
        skipPreflight: true,
      },
      h.deps,
    );
    expect(JSON.parse(h.stdout.join('')).results).toMatchObject([
      { resultId: 'result_held', status: 'passed' },
    ]);
  });
  it('uses the currently listed default when no environment name was requested', async () => {
    const h = heldRunHarness();
    await runTestRun(heldRunOptions, h.deps);
    expect(JSON.parse(h.stdout.join('')).summary).toMatchObject({ total: 1, passed: 1 });
  });
  it('preserves a held failure verdict while excluding unrelated results', async () => {
    const h = heldRunHarness({ status: 'FAILED' });
    await expect(runTestRun(heldRunOptions, h.deps)).rejects.toMatchObject({ exitCode: 1 });
    expect(JSON.parse(h.stdout.join('')).results).toHaveLength(1);
  });
  it('scopes a joined wait to its held result even if the execution was cancelled', async () => {
    const h = heldRunHarness({ cancelled: true });
    await runTestRun(heldRunOptions, h.deps);
    expect(JSON.parse(h.stdout.join('')).summary).toMatchObject({ total: 1, passed: 1 });
  });
  it.each(['card', 'environment'] as const)(
    'preserves interrupt during the held %s read',
    async interruptAt => {
      const shutdown = new ShutdownController();
      const h = heldRunHarness({ interruptAt, shutdown });
      await expect(runTestRun(heldRunOptions, { ...h.deps, shutdown })).rejects.toBeInstanceOf(
        InterruptError,
      );
      expect(h.calls.some(call => call.url.pathname.endsWith('/cancel'))).toBe(false);
    },
  );
  it('an interrupted joined wait warns that whole-run cancellation stops borrowed work', async () => {
    const shutdown = new ShutdownController();
    const h = heldRunHarness({ interruptAt: 'listing', shutdown });
    const error = await runTestRun(heldRunOptions, { ...h.deps, shutdown }).catch(err => err);
    expect(error).toBeInstanceOf(InterruptError);
    expect(buildInterruptEnvelope(error).error.nextAction).toContain('joined');
    expect(h.calls.some(call => call.url.pathname.endsWith('/cancel'))).toBe(false);
  });
  it('an interrupted owned wait offers plain whole-run commands', async () => {
    const shutdown = new ShutdownController();
    const h = projectHarness({
      listing: () => {
        shutdown.interrupt('SIGINT');
        throw shutdown.signal.reason;
      },
    });
    const error = await runTestRun(heldRunOptions, { ...h.deps, shutdown }).catch(err => err);
    const hint = buildInterruptEnvelope(error).error.nextAction;
    expect(hint).toContain('testsprite run wait exec_abc');
    expect(hint).not.toContain('joined');
  });
});

describe('runTestRun — backend runs resolve from their own execution listing', () => {
  const options = {
    profile: 'default',
    output: 'json' as const,
    debug: false,
    testId: 'test_xyz',
    wait: true,
    timeoutSeconds: 1,
  };
  it.each(['backend', 'frontend'] as const)(
    'a passing %s execution never reads the latest test result',
    async type => {
      const h = projectHarness({
        answer: url =>
          url.pathname.endsWith('/tests/test_xyz')
            ? new Response(JSON.stringify({ id: 'test_xyz', projectId: 'project_1', type }))
            : undefined,
        listing: () =>
          runListing({ status: 'finished', cancelled: false }, [
            resultLine({
              runId: 'exec_abc',
              resultId: 'result_current',
              caseKey: 'test_xyz',
              testStatus: 'PASSED',
            }),
          ]),
      });
      const result = await runTestRun(options, h.deps);
      expect(result.results).toMatchObject([
        { resultId: 'result_current', runId: 'exec_abc', status: 'passed' },
      ]);
      expect(h.calls.some(call => call.url.pathname.endsWith('/result'))).toBe(false);
    },
  );
  it('an execution that never finalizes times out instead of borrowing a latest test verdict', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const h = projectHarness({
      listing: () => {
        now += 1000;
        return runListing({ status: 'running', cancelled: false }, [
          resultLine({
            runId: 'exec_abc',
            resultId: 'result_current',
            caseKey: 'test_xyz',
            testStatus: 'PASSED',
          }),
        ]);
      },
    });
    await expect(runTestRun(options, h.deps)).rejects.toMatchObject({ exitCode: 7 });
    expect(h.calls.some(call => call.url.pathname.endsWith('/result'))).toBe(false);
  });
  it('a failed execution result exits 1 without reading the latest test verdict', async () => {
    const h = projectHarness({
      listing: () =>
        runListing({ status: 'finished', cancelled: false }, [
          resultLine({
            runId: 'exec_abc',
            resultId: 'result_current',
            caseKey: 'test_xyz',
            testStatus: 'FAILED',
          }),
        ]),
    });
    await expect(runTestRun(options, h.deps)).rejects.toMatchObject({ exitCode: 1 });
    expect(h.calls.some(call => call.url.pathname.endsWith('/result'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C3 — requestId: trailer gated behind --verbose / --debug
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fix 3 — run idempotency-key emitted under --verbose (was --debug only)
// ---------------------------------------------------------------------------

describe('run request metadata diagnostics', () => {
  it.each([
    ['text', false, false],
    ['text', true, true],
    ['json', false, true],
  ] as const)(
    'idempotency key is visible for output=%s verbose=%s',
    async (output, verbose, visible) => {
      const h = projectHarness();
      await runTestRun(
        { ...heldRunOptions, wait: false, output, verbose, idempotencyKey: 'stable-key' },
        h.deps,
      );
      expect(h.stderr.some(line => line === 'idempotency-key: stable-key')).toBe(visible);
      expect(h.calls.find(call => call.method === 'POST')?.headers.get('idempotency-key')).toBe(
        'stable-key',
      );
    },
  );
});

describe('requestId trailer gated behind verbose', () => {
  it.each([false, true])('request ID is visible only with verbose=%s', async verbose => {
    const h = projectHarness({
      answer: (_url, init) =>
        init.method === 'POST'
          ? new Response(JSON.stringify(projectRun()), {
              headers: { 'x-request-id': 'req-visible' },
            })
          : undefined,
    });
    await runTestRun({ ...heldRunOptions, wait: false, output: 'text', verbose }, h.deps);
    expect(
      h.stderr.some(
        line =>
          line ===
          `requestId: ${h.calls.find(call => call.method === 'POST')?.headers.get('x-request-id')}`,
      ),
    ).toBe(verbose);
  });
});

describe('run --gh-output / --summary-file still require --wait (Gap A guard)', () => {
  it('--gh-output without --wait → exit 5', async () => {
    const { createRunCommand } = await import('./test.js');
    const test = createRunCommand();
    disableExits(test);
    await expect(
      test.parseAsync(['test_xyz', '--gh-output'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('--summary-file without --wait → exit 5', async () => {
    const { createRunCommand } = await import('./test.js');
    const test = createRunCommand();
    disableExits(test);
    const summaryDir = mkdtempSync(join(tmpdir(), 'cli-run-summary-'));
    const summaryFile = join(summaryDir, 'x.json');
    await expect(test.parseAsync(['test_xyz', '--summary-file', summaryFile], { from: 'user' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 })
      .finally(() => rmSync(summaryDir, { recursive: true, force: true }));
  });
});
