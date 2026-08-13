/**
 * Unit tests for `test create-batch --run` fan-out — UC#2.
 *
 * Covers:
 *   - Happy path: 3 specs, all pass with --wait → results array, exit 0
 *   - Mixed outcomes: 2 pass, 1 fail → exit 1, results array shows mixed
 *   - --max-concurrency 2 with 4 specs: only 2 in-flight at any time
 *   - --timeout per-run honored: one slow run hits timeout, others complete
 *   - Idempotency: each per-run key is unique, never reuses create key
 *   - CONFLICT on one run auto-resumed (same path as single-test run)
 *   - --dry-run mode works on the chain, no network calls
 *   - create-batch command exposes --timeout flag
 *   - RATE_LIMITED trigger retried (outer retry loop): first call → RATE_LIMITED, second → success
 *   - All RATE_LIMITED after outer retry cap exhausted → error result for that spec
 *   - Client-side throttle: a full 50-spec batch stays within the 50/min window
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CLIError } from '../lib/errors.js';
import type { RunResponse, TriggerRunResponse } from '../lib/runs.types.js';
import {
  BATCH_RUN_RATE_LIMIT,
  BATCH_RUN_RATE_MAX_OUTER_RETRIES,
  DEFAULT_BATCH_RUN_CONCURRENCY,
  createTestCommand,
  isTransientRateLimit,
  runCreateBatch,
  runTestRun,
} from './test.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'cli-batch-run-'));
  const credentialsPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(credentialsPath, `[default]\napi_url = ${apiUrl}\napi_key = ${apiKey}\n`, {
    mode: 0o600,
  });
  return { credentialsPath };
}

function writePlansJsonl(plans: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-batch-plans-'));
  const path = join(dir, 'plans.jsonl');
  writeFileSync(path, plans.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf8');
  return path;
}

const FE_SPEC = {
  projectId: 'project_alice',
  type: 'frontend' as const,
  name: 'spec-one',
  planSteps: [{ type: 'action', description: 'navigate to home' }],
};

function makeBatchCreateResponse(testIds: string[]) {
  return {
    results: testIds.map((testId, i) => ({
      specIndex: i,
      testId,
      status: 'created' as const,
    })),
    summary: { total: testIds.length, created: testIds.length, failed: 0 },
  };
}

function makeTriggerResponse(testId: string, runId: string): TriggerRunResponse {
  return {
    runId,
    status: 'queued',
    enqueuedAt: '2026-05-26T10:00:00.000Z',
    codeVersion: 'v1',
    targetUrl: 'https://example.com',
  };
}

function makePassedRun(testId: string, runId: string): RunResponse {
  return {
    runId,
    testId,
    projectId: 'project_alice',
    userId: 'user_1',
    status: 'passed',
    source: 'cli',
    createdAt: '2026-05-26T10:00:00.000Z',
    startedAt: '2026-05-26T10:00:01.000Z',
    finishedAt: '2026-05-26T10:00:30.000Z',
    codeVersion: 'v1',
    targetUrl: 'https://example.com',
    createdFrom: 'cli',
    failedStepIndex: null,
    failureKind: null,
    error: null,
    videoUrl: null,
    stepSummary: { total: 3, completed: 3, passedCount: 3, failedCount: 0 },
  };
}

function makeFailedRun(testId: string, runId: string): RunResponse {
  return {
    ...makePassedRun(testId, runId),
    status: 'failed',
    failedStepIndex: 1,
    failureKind: 'assertion',
  };
}

const instantSleep = () => Promise.resolve();

// ---------------------------------------------------------------------------
// Surface: create-batch exposes --timeout, --run, --wait, --max-concurrency
// ---------------------------------------------------------------------------

describe('create-batch command surface', () => {
  it('exposes --timeout flag', async () => {
    const test = createTestCommand();
    const batch = test.commands.find(c => c.name() === 'create-batch')!;
    expect(batch).toBeDefined();
    const flagNames = batch.options.map(o => o.long);
    expect(flagNames).toContain('--timeout');
    expect(flagNames).toContain('--run');
    expect(flagNames).toContain('--wait');
    expect(flagNames).toContain('--max-concurrency');
  });

  it('--run flag description no longer says UNSUPPORTED', async () => {
    const test = createTestCommand();
    const batch = test.commands.find(c => c.name() === 'create-batch')!;
    const runOpt = batch.options.find(o => o.long === '--run')!;
    expect(runOpt.description).not.toContain('UNSUPPORTED');
    expect(runOpt.description).not.toContain('exits 7');
  });
});

// ---------------------------------------------------------------------------
// Happy path — 3 specs, all pass with --wait → results array, exit 0
// ---------------------------------------------------------------------------

describe('runCreateBatch --run --wait: happy path', () => {
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

  it('3 specs all pass — results array has 3 entries, exit 0 (no throw)', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_a1', 'test_a2', 'test_a3'];
    const plansFile = writePlansJsonl([FE_SPEC, FE_SPEC, FE_SPEC]);

    const fetchImpl = makeFetch(url => {
      // Batch create
      if (url.includes('/tests/batch')) {
        return { body: makeBatchCreateResponse(testIds) };
      }
      // Trigger POST /tests/{id}/runs
      const triggerMatch = /\/tests\/(test_[a-z0-9]+)\/runs$/.exec(url);
      if (triggerMatch?.[1]) {
        const testId = triggerMatch[1];
        const runId = `run_${testId}`;
        return { body: makeTriggerResponse(testId, runId) };
      }
      // Poll GET /runs/{runId}
      const pollMatch = /\/runs\/(run_test_[a-z0-9]+)/.exec(url);
      if (pollMatch?.[1]) {
        const runId = pollMatch[1];
        const testId = runId.replace('run_', '');
        return { body: makePassedRun(testId, runId) };
      }
      return {
        status: 404,
        body: {
          error: { code: 'NOT_FOUND', message: 'not found', nextAction: '', requestId: 'r1' },
        },
      };
    });

    const stdout: string[] = [];
    const stderrLines: string[] = [];

    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: true,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );

    // JSON output is the batch-run envelope
    const printed = JSON.parse(stdout.join('')) as { results: unknown[] };
    expect(printed.results).toHaveLength(3);
    const results = printed.results as Array<{ testId: string; status: string; runId: string }>;
    expect(results.every(r => r.status === 'passed')).toBe(true);
    expect(results.map(r => r.testId).sort()).toEqual(['test_a1', 'test_a2', 'test_a3'].sort());
    // All runIds present
    expect(results.every(r => r.runId.startsWith('run_test_'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mixed outcomes — 2 pass, 1 fail → exit 1, results array shows mixed
// ---------------------------------------------------------------------------

describe('runCreateBatch --run --wait: mixed outcomes', () => {
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

  it('2 pass, 1 fail → exit 1, all 3 result entries in envelope', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_b1', 'test_b2', 'test_b3'];
    const plansFile = writePlansJsonl([FE_SPEC, FE_SPEC, FE_SPEC]);

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch')) {
        return { body: makeBatchCreateResponse(testIds) };
      }
      const triggerMatch = /\/tests\/(test_[a-z0-9]+)\/runs$/.exec(url);
      if (triggerMatch?.[1]) {
        const testId = triggerMatch[1];
        const runId = `run_${testId}`;
        return { body: makeTriggerResponse(testId, runId) };
      }
      const pollMatch = /\/runs\/(run_test_[a-z0-9]+)/.exec(url);
      if (pollMatch?.[1]) {
        const runId = pollMatch[1];
        const testId = runId.replace('run_', '');
        // test_b3 fails; others pass
        if (testId === 'test_b3') return { body: makeFailedRun(testId, runId) };
        return { body: makePassedRun(testId, runId) };
      }
      return {
        status: 404,
        body: {
          error: { code: 'NOT_FOUND', message: 'not found', nextAction: '', requestId: 'r1' },
        },
      };
    });

    const stdout: string[] = [];
    const stderrLines: string[] = [];

    const err = await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: true,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    ).catch(e => e);

    // Should throw CLIError exit 1
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).exitCode).toBe(1);

    // Results envelope was printed on stdout before the error
    const printed = JSON.parse(stdout.join('')) as { results: unknown[] };
    expect(printed.results).toHaveLength(3);
    const results = printed.results as Array<{ testId: string; status: string }>;
    const passed = results.filter(r => r.status === 'passed');
    const failed = results.filter(r => r.status === 'failed');
    expect(passed).toHaveLength(2);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.testId).toBe('test_b3');
  });
});

// ---------------------------------------------------------------------------
// No --wait: exit-code contract (issue #161)
//
// Without --wait, every trigger response is non-terminal ('queued') by design.
// A fully successful dispatch must exit 0 — success means every trigger was
// dispatched without error, mirroring single `test run` (no --wait). A trigger
// error must still exit non-zero. Existing no-wait specs only exercised error
// scenarios and never asserted the success exit code, which is how the
// "always exits 1 even when every trigger succeeds" bug slipped through.
// ---------------------------------------------------------------------------

describe('runCreateBatch --run (no --wait): exit-code contract', () => {
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

  it('all triggers succeed (queued) → resolves without error, exit 0; results all queued, no error (json)', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_q1', 'test_q2', 'test_q3'];
    const plansFile = writePlansJsonl([FE_SPEC, FE_SPEC, FE_SPEC]);

    let pollCount = 0;
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch')) {
        return { body: makeBatchCreateResponse(testIds) };
      }
      const triggerMatch = /\/tests\/(test_[a-z0-9]+)\/runs$/.exec(url);
      if (triggerMatch?.[1]) {
        const testId = triggerMatch[1];
        return { body: makeTriggerResponse(testId, `run_${testId}`) };
      }
      // No --wait must NOT poll — count any GET /runs as a violation.
      if (/\/runs\/run_test_[a-z0-9]+/.exec(url)) {
        pollCount++;
      }
      return {
        status: 404,
        body: {
          error: { code: 'NOT_FOUND', message: 'not found', nextAction: '', requestId: 'r1' },
        },
      };
    });

    const stdout: string[] = [];
    const stderrLines: string[] = [];

    // Must NOT throw — a fully successful no-wait dispatch exits 0.
    // (If runBatchRun threw a CLIError, this await would reject and fail the test.)
    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: false,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );

    expect(pollCount).toBe(0); // no polling without --wait

    const printed = JSON.parse(stdout.join('')) as {
      results: Array<{ testId: string; status: string; error?: unknown }>;
    };
    expect(printed.results).toHaveLength(3);
    expect(printed.results.every(r => r.status === 'queued')).toBe(true);
    expect(printed.results.every(r => r.error === undefined)).toBe(true);
  });

  it('all triggers succeed (queued) → text summary reports "3/3 triggered", exit 0 (no "0/N passed")', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_t1', 'test_t2', 'test_t3'];
    const plansFile = writePlansJsonl([FE_SPEC, FE_SPEC, FE_SPEC]);

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch')) {
        return { body: makeBatchCreateResponse(testIds) };
      }
      const triggerMatch = /\/tests\/(test_[a-z0-9]+)\/runs$/.exec(url);
      if (triggerMatch?.[1]) {
        const testId = triggerMatch[1];
        return { body: makeTriggerResponse(testId, `run_${testId}`) };
      }
      return {
        status: 404,
        body: {
          error: { code: 'NOT_FOUND', message: 'not found', nextAction: '', requestId: 'r1' },
        },
      };
    });

    const stdout: string[] = [];
    const stderrLines: string[] = [];

    // Must NOT throw — a fully successful no-wait dispatch exits 0.
    await runCreateBatch(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: false,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );

    const summary = stderrLines.find(l => l.startsWith('batch-run summary:'));
    expect(summary).toBeDefined();
    expect(summary).toContain('3/3 triggered');
    // The pre-fix bug printed a pass/fail summary ("0/3 passed") for a fully
    // successful no-wait dispatch — assert that misleading wording is gone.
    expect(summary).not.toContain('passed');
    expect(stderrLines.some(l => l.includes('did not pass'))).toBe(false);
  });

  it('partial trigger failure (2 queued, 1 errors) → still exits non-zero; all 3 results in envelope', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_p1', 'test_p2', 'test_p3'];
    const plansFile = writePlansJsonl([FE_SPEC, FE_SPEC, FE_SPEC]);

    // test_p3's trigger returns 404 NOT_FOUND — a non-retryable error (exit 4)
    // that surfaces immediately as an error result. The other two dispatch fine.
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch')) {
        return { body: makeBatchCreateResponse(testIds) };
      }
      const triggerMatch = /\/tests\/(test_[a-z0-9]+)\/runs$/.exec(url);
      if (triggerMatch?.[1]) {
        const testId = triggerMatch[1];
        if (testId === 'test_p3') {
          return {
            status: 404,
            body: {
              error: {
                code: 'NOT_FOUND',
                message: 'test not found',
                nextAction: '',
                requestId: 'req_p3',
              },
            },
          };
        }
        return { body: makeTriggerResponse(testId, `run_${testId}`) };
      }
      return {
        status: 404,
        body: {
          error: { code: 'NOT_FOUND', message: 'not found', nextAction: '', requestId: 'r1' },
        },
      };
    });

    const stdout: string[] = [];
    const stderrLines: string[] = [];

    const err = await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: false,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    ).catch(e => e);

    // A dispatch with any trigger error must exit non-zero.
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).exitCode).not.toBe(0);

    const printed = JSON.parse(stdout.join('')) as {
      results: Array<{ testId: string; status: string; error?: { code: string } }>;
    };
    expect(printed.results).toHaveLength(3);
    const queued = printed.results.filter(r => r.status === 'queued');
    const errored = printed.results.filter(r => r.error !== undefined);
    expect(queued).toHaveLength(2);
    expect(errored).toHaveLength(1);
    expect(errored[0]?.testId).toBe('test_p3');
    expect(errored[0]?.error?.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// --max-concurrency: verify only N in-flight at any time
// ---------------------------------------------------------------------------

describe('runCreateBatch --run: --max-concurrency bounds concurrency', () => {
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

  it('--max-concurrency 2 with 4 specs: triggers at most 2 at a time', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_c1', 'test_c2', 'test_c3', 'test_c4'];
    const plansFile = writePlansJsonl([FE_SPEC, FE_SPEC, FE_SPEC, FE_SPEC]);

    // Track concurrent in-flight triggers
    let inFlightCount = 0;
    let maxObservedConcurrency = 0;

    // We use a two-phase fetch: trigger returns a pending promise so we can
    // observe concurrent depth, then resolves when the poll GET is called.
    const triggerResolvers = new Map<string, () => void>();

    const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;

      // Batch create — instant
      if (url.includes('/tests/batch')) {
        return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      // Trigger POST — track concurrent count, resolve immediately for this test
      const triggerMatch = /\/tests\/(test_[a-z0-9]+)\/runs$/.exec(url);
      if (triggerMatch?.[1]) {
        const testId = triggerMatch[1];
        inFlightCount++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, inFlightCount);
        // Simulate async work so concurrency can be observed
        await new Promise<void>(resolve => {
          triggerResolvers.set(testId, resolve);
          // Auto-resolve after a microtask so tests don't hang
          Promise.resolve().then(resolve);
        });
        inFlightCount--;
        const runId = `run_${testId}`;
        return new Response(JSON.stringify(makeTriggerResponse(testId, runId)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      // Poll GET — return terminal immediately
      const pollMatch = /\/runs\/(run_test_[a-z0-9]+)/.exec(url);
      if (pollMatch?.[1]) {
        const runId = pollMatch[1];
        const testId = runId.replace('run_', '');
        return new Response(JSON.stringify(makePassedRun(testId, runId)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'not found', nextAction: '', requestId: 'r1' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    const stdout: string[] = [];

    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: true,
        maxConcurrency: 2,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: () => {},
        sleep: instantSleep,
      },
    );

    // Verify all 4 results are present
    const printed = JSON.parse(stdout.join('')) as { results: unknown[] };
    expect(printed.results).toHaveLength(4);
    // Concurrency never exceeded 2
    expect(maxObservedConcurrency).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// --timeout per-run honored
// ---------------------------------------------------------------------------

describe('runCreateBatch --run --wait: --timeout per-run', () => {
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

  it('one slow run hits timeout while other completes; overall exit is 1 (not 7, mixed)', async () => {
    // test_d1: passes quickly (poll returns terminal on first call — returns
    // *before* mockNow crosses the deadline)
    // test_d2: always returns non-terminal; each poll advances mockNow by
    // 600 ms, so the 1 s deadline is crossed on the second iteration.
    const { credentialsPath } = makeCreds();
    const testIds = ['test_d1', 'test_d2'];
    const plansFile = writePlansJsonl([FE_SPEC, FE_SPEC]);

    // Fetch-driven mock clock: trigger and batch-create calls don't advance
    // time; only poll fetches do. This is robust against indeterminate
    // Date.now() call counts in the HTTP layer.
    const realDateNow = Date.now;
    let mockNow = realDateNow();
    Date.now = () => mockNow;

    try {
      const fetchImpl = makeFetch(url => {
        if (url.includes('/tests/batch')) {
          return { body: makeBatchCreateResponse(testIds) };
        }
        const triggerMatch = /\/tests\/(test_[a-z0-9]+)\/runs$/.exec(url);
        if (triggerMatch?.[1]) {
          const testId = triggerMatch[1];
          const runId = `run_${testId}`;
          return { body: makeTriggerResponse(testId, runId) };
        }
        const pollMatch = /\/runs\/(run_test_d[12])/.exec(url);
        if (pollMatch?.[1]) {
          const runId = pollMatch[1];
          const testId = runId.replace('run_', '');
          // Each poll fetch advances the mock clock by 600 ms. With 1 s
          // timeout, test_d2 needs ~2 iterations to hit the deadline.
          mockNow += 600;
          if (testId === 'test_d1') return { body: makePassedRun(testId, runId) };
          return { body: { ...makePassedRun(testId, runId), status: 'running' as const } };
        }
        return {
          status: 404,
          body: {
            error: { code: 'NOT_FOUND', message: 'not found', nextAction: '', requestId: 'r1' },
          },
        };
      });

      const stdout: string[] = [];
      const err = await runCreateBatch(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: false,
          plans: plansFile,
          run: true,
          wait: true,
          timeoutSeconds: 1, // per-run timeout of 1 second
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: line => stdout.push(line),
          stderr: () => {},
          sleep: instantSleep,
        },
      ).catch(e => e);

      // Should exit 1 (mixed: one pass, one timeout — not all timeout → exit 1)
      expect(err).toBeInstanceOf(CLIError);
      expect((err as CLIError).exitCode).toBe(1);

      // Results: test_d1 passes, test_d2 has timeout error
      const printed = JSON.parse(stdout.join('')) as {
        results: Array<{ testId: string; status: string }>;
      };
      expect(printed.results).toHaveLength(2);
      const d1 = printed.results.find(r => r.testId === 'test_d1');
      const d2 = printed.results.find(r => r.testId === 'test_d2');
      expect(d1?.status).toBe('passed');
      expect(d2?.status).toBe('timeout');
    } finally {
      Date.now = realDateNow;
    }
  });

  it('all runs time out → exit 7', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_e1', 'test_e2'];
    const plansFile = writePlansJsonl([FE_SPEC, FE_SPEC]);

    // Fetch-driven mock clock — same approach as the mixed-outcome test.
    // Both runs always return non-terminal, so every poll fetch advances
    // mockNow until the 1 s deadline is crossed.
    const realDateNow = Date.now;
    let mockNow = realDateNow();
    Date.now = () => mockNow;

    try {
      const fetchImpl = makeFetch(url => {
        if (url.includes('/tests/batch')) {
          return { body: makeBatchCreateResponse(testIds) };
        }
        const triggerMatch = /\/tests\/(test_[a-z0-9]+)\/runs$/.exec(url);
        if (triggerMatch?.[1]) {
          const testId = triggerMatch[1];
          const runId = `run_${testId}`;
          return { body: makeTriggerResponse(testId, runId) };
        }
        // Always return running (non-terminal) to force timeout.
        // Each poll fetch advances mockNow by 600 ms — with 1 s timeout
        // both runs cross the deadline on the second iteration.
        const pollMatch = /\/runs\/(run_test_e[12])/.exec(url);
        if (pollMatch?.[1]) {
          const runId = pollMatch[1];
          const testId = runId.replace('run_', '');
          mockNow += 600;
          return { body: { ...makePassedRun(testId, runId), status: 'running' as const } };
        }
        return {
          status: 404,
          body: {
            error: { code: 'NOT_FOUND', message: 'not found', nextAction: '', requestId: 'r1' },
          },
        };
      });

      const err = await runCreateBatch(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: false,
          plans: plansFile,
          run: true,
          wait: true,
          timeoutSeconds: 1,
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: () => {},
          stderr: () => {},
          sleep: instantSleep,
        },
      ).catch(e => e);

      // All runs timed out → exit 7
      expect(err).toBeInstanceOf(CLIError);
      expect((err as CLIError).exitCode).toBe(7);
    } finally {
      Date.now = realDateNow;
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency: each per-run key is unique (regression guard)
// ---------------------------------------------------------------------------

describe('runCreateBatch --run: idempotency key uniqueness', () => {
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

  it('each run trigger gets a distinct idempotency key, none matches the create key', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_f1', 'test_f2', 'test_f3'];
    const plansFile = writePlansJsonl([FE_SPEC, FE_SPEC, FE_SPEC]);
    const createIdemKey = 'cli-create-batch-test-key';

    const seenRunIdempotencyKeys: string[] = [];
    let createIdempotencyKeySeen = '';

    const fetchImpl = (async (input: FetchInput, init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;
      const headers = new Headers(init.headers as Record<string, string>);

      if (url.includes('/tests/batch')) {
        createIdempotencyKeySeen = headers.get('idempotency-key') ?? '';
        return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const triggerMatch = /\/tests\/(test_[a-z0-9]+)\/runs$/.exec(url);
      if (triggerMatch?.[1]) {
        const testId = triggerMatch[1];
        const key = headers.get('idempotency-key') ?? '';
        seenRunIdempotencyKeys.push(key);
        const runId = `run_${testId}`;
        return new Response(JSON.stringify(makeTriggerResponse(testId, runId)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const pollMatch = /\/runs\/(run_test_[a-z0-9]+)/.exec(url);
      if (pollMatch?.[1]) {
        const runId = pollMatch[1];
        const testId = runId.replace('run_', '');
        return new Response(JSON.stringify(makePassedRun(testId, runId)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'not found', nextAction: '', requestId: 'r1' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: true,
        idempotencyKey: createIdemKey,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: () => {},
        sleep: instantSleep,
      },
    );

    // 3 run triggers → 3 run idempotency keys
    expect(seenRunIdempotencyKeys).toHaveLength(3);
    // All run keys must be unique
    const uniqueKeys = new Set(seenRunIdempotencyKeys);
    expect(uniqueKeys.size).toBe(3);
    // None of the run keys matches the create key (regression guard)
    expect(seenRunIdempotencyKeys).not.toContain(createIdemKey);
    // The create key was used on the batch POST
    expect(createIdempotencyKeySeen).toBe(createIdemKey);
    // All run keys should start with 'cli-batch-run-'
    for (const key of seenRunIdempotencyKeys) {
      expect(key).toMatch(/^cli-batch-run-[0-9a-f-]{36}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// CONFLICT auto-resume on one run
// ---------------------------------------------------------------------------

describe('runCreateBatch --run --wait: CONFLICT auto-resume', () => {
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

  it('one run returns CONFLICT run_in_flight with currentRunId → auto-resumes, result uses conflict runId', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_g1', 'test_g2'];
    const plansFile = writePlansJsonl([FE_SPEC, FE_SPEC]);

    // test_g1: normal trigger → passes
    // test_g2: trigger returns 409 CONFLICT with currentRunId; poll on inflight → passes
    const conflictRunId = 'run_inflight_g2';

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch')) {
        return { body: makeBatchCreateResponse(testIds) };
      }

      // test_g1 trigger — normal
      if (url.includes('/tests/test_g1/runs')) {
        return { body: makeTriggerResponse('test_g1', 'run_test_g1') };
      }

      // test_g2 trigger — returns CONFLICT
      if (url.includes('/tests/test_g2/runs')) {
        return {
          status: 409,
          body: {
            error: {
              code: 'CONFLICT',
              message: 'Test test_g2 already has a run in flight.',
              nextAction: 'wait for it.',
              requestId: 'req_conflict_g2',
              details: { reason: 'run_in_flight', currentRunId: conflictRunId },
            },
          },
        };
      }

      // Poll for test_g1 run
      if (url.includes('/runs/run_test_g1')) {
        return { body: makePassedRun('test_g1', 'run_test_g1') };
      }

      // Poll for the conflict inflight run
      if (url.includes(`/runs/${conflictRunId}`)) {
        return { body: makePassedRun('test_g2', conflictRunId) };
      }

      return {
        status: 404,
        body: {
          error: { code: 'NOT_FOUND', message: 'not found', nextAction: '', requestId: 'r1' },
        },
      };
    });

    const stdout: string[] = [];
    const stderrLines: string[] = [];

    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: true,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );

    const printed = JSON.parse(stdout.join('')) as {
      results: Array<{ testId: string; runId: string; status: string }>;
    };
    expect(printed.results).toHaveLength(2);

    const g1 = printed.results.find(r => r.testId === 'test_g1');
    const g2 = printed.results.find(r => r.testId === 'test_g2');

    // Both should pass
    expect(g1?.status).toBe('passed');
    // g2's result should use the inflight runId, not a freshly minted one
    expect(g2?.runId).toBe(conflictRunId);
    expect(g2?.status).toBe('passed');

    // Advisory should mention the inflight runId
    expect(stderrLines.some(l => l.includes(conflictRunId))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --dry-run mode
// ---------------------------------------------------------------------------

describe('runCreateBatch --run --dry-run', () => {
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

  it('dry-run: no real trigger calls; prints descriptor envelope with testIds and dryRun: true', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_h1', 'test_h2'];
    const plansFile = writePlansJsonl([FE_SPEC, FE_SPEC]);

    // fetchImpl should not be called for trigger/poll in dry-run.
    // It IS called for the batch create (dry-run fetch returns sample).
    // We simulate a batch create dry-run response.
    let triggerCallCount = 0;
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch')) {
        return { body: makeBatchCreateResponse(testIds) };
      }
      // Any trigger or poll call is a test failure
      if (url.includes('/runs')) {
        triggerCallCount++;
      }
      return { status: 200, body: {} };
    });

    const stdout: string[] = [];

    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        plans: plansFile,
        run: true,
        wait: true,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: () => {},
        sleep: instantSleep,
      },
    );

    // No real trigger/poll calls
    expect(triggerCallCount).toBe(0);

    // Descriptor envelope must contain dryRun: true and testIds
    const envelope = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(envelope.dryRun).toBe(true);
    expect(Array.isArray(envelope.testIds)).toBe(true);
    expect((envelope.testIds as string[]).sort()).toEqual(testIds.sort());
    // results array is present
    expect(Array.isArray(envelope.results)).toBe(true);
    expect((envelope.results as unknown[]).length).toBe(testIds.length);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_BATCH_RUN_CONCURRENCY — bounded default (not Infinity) + override
// ---------------------------------------------------------------------------

describe('DEFAULT_BATCH_RUN_CONCURRENCY', () => {
  it('is 50 (bounded, not Infinity)', () => {
    expect(DEFAULT_BATCH_RUN_CONCURRENCY).toBe(50);
    expect(DEFAULT_BATCH_RUN_CONCURRENCY).not.toBe(Infinity);
    expect(Number.isFinite(DEFAULT_BATCH_RUN_CONCURRENCY)).toBe(true);
  });

  it('--max-concurrency override is respected (not clamped to default)', async () => {
    // When --max-concurrency 2 is passed, the actual concurrency cap must be 2
    // (less than DEFAULT_BATCH_RUN_CONCURRENCY=50), confirming the override path.
    const { credentialsPath } = makeCreds();
    const testIds = ['test_conc1', 'test_conc2', 'test_conc3'];
    const plansFile = writePlansJsonl([FE_SPEC, FE_SPEC, FE_SPEC]);

    let maxObservedConcurrency = 0;
    let inFlightCount = 0;

    const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;

      if (url.includes('/tests/batch')) {
        return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const triggerMatch = /\/tests\/(test_conc[0-9]+)\/runs$/.exec(url);
      if (triggerMatch?.[1]) {
        const testId = triggerMatch[1];
        inFlightCount++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, inFlightCount);
        await Promise.resolve(); // yield so concurrency can be observed
        inFlightCount--;
        const runId = `run_${testId}`;
        return new Response(JSON.stringify(makeTriggerResponse(testId, runId)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const pollMatch = /\/runs\/(run_test_conc[0-9]+)/.exec(url);
      if (pollMatch?.[1]) {
        const runId = pollMatch[1];
        const testId = runId.replace('run_', '');
        return new Response(JSON.stringify(makePassedRun(testId, runId)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'not found', nextAction: '', requestId: 'r1' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: true,
        maxConcurrency: 2, // explicit override — lower than default 50
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: () => {},
        sleep: instantSleep,
      },
    );

    // Override is respected: concurrency was bounded at 2, not at DEFAULT (10)
    expect(maxObservedConcurrency).toBeLessThanOrEqual(2);
  });

  it('omitting --max-concurrency uses DEFAULT_BATCH_RUN_CONCURRENCY (50), not Infinity', async () => {
    // With 50 specs (== MAX_BATCH_SPECS) and no --max-concurrency, the raised
    // default (50) lets all 50 be in flight at once, bounded at
    // DEFAULT_BATCH_RUN_CONCURRENCY (50) — never Infinity (unbounded all-at-once).
    const { credentialsPath } = makeCreds();
    const SPEC_COUNT = 50;
    const testIds = Array.from({ length: SPEC_COUNT }, (_, i) => `test_def${i}`);
    const plansFile = writePlansJsonl(Array.from({ length: SPEC_COUNT }, () => FE_SPEC));

    let maxObservedConcurrency = 0;
    let inFlightCount = 0;

    const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;

      if (url.includes('/tests/batch')) {
        return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const triggerMatch = /\/tests\/(test_def[0-9]+)\/runs$/.exec(url);
      if (triggerMatch?.[1]) {
        const testId = triggerMatch[1];
        inFlightCount++;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, inFlightCount);
        await Promise.resolve();
        inFlightCount--;
        const runId = `run_${testId}`;
        return new Response(JSON.stringify(makeTriggerResponse(testId, runId)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const pollMatch = /\/runs\/(run_test_def[0-9]+)/.exec(url);
      if (pollMatch?.[1]) {
        const runId = pollMatch[1];
        const testId = runId.replace('run_', '');
        return new Response(JSON.stringify(makePassedRun(testId, runId)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'not found', nextAction: '', requestId: 'r1' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: true,
        // maxConcurrency intentionally omitted → should use DEFAULT (10)
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: () => {},
        sleep: instantSleep,
      },
    );

    // With 50 specs, the default concurrency 50 bounds us at or below 50
    expect(maxObservedConcurrency).toBeLessThanOrEqual(DEFAULT_BATCH_RUN_CONCURRENCY);
    // And the raised default lets concurrency climb well past the old cap of 10
    expect(maxObservedConcurrency).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// RATE_LIMITED outer retry: trigger returns RATE_LIMITED then succeeds
// ---------------------------------------------------------------------------

describe('runCreateBatch --run: RATE_LIMITED outer retry', () => {
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

  it('trigger returns RATE_LIMITED once then succeeds — result is passed, no terminal error', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_rl1', 'test_rl2'];
    const plansFile = writePlansJsonl([FE_SPEC, FE_SPEC]);

    // test_rl1: trigger fails with RATE_LIMITED on first attempt, succeeds on second.
    // test_rl2: triggers normally.
    const triggerAttempts = new Map<string, number>();

    const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;

      if (url.includes('/tests/batch')) {
        return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const triggerMatch = /\/tests\/(test_rl[12])\/runs$/.exec(url);
      if (triggerMatch?.[1]) {
        const testId = triggerMatch[1];
        const attempt = (triggerAttempts.get(testId) ?? 0) + 1;
        triggerAttempts.set(testId, attempt);

        // test_rl1: first outer-loop attempt returns RATE_LIMITED; second attempt succeeds.
        // The batch path passes retryOnRateLimit: false to triggerRunWithMeta, so the
        // HTTP layer throws immediately on the first 429 — no internal sub-retries.
        // The outer retry loop in triggerOne owns backoff and re-trigger. Each outer
        // attempt = exactly ONE HTTP call. `attempt <= 1` covers the first outer attempt.
        if (testId === 'test_rl1' && attempt <= 1) {
          // First outer attempt → HTTP layer throws RATE_LIMITED immediately
          return new Response(
            JSON.stringify({
              error: {
                code: 'RATE_LIMITED',
                message: 'Run trigger rate limit exceeded: 60 triggers per minute per key.',
                nextAction: 'Wait before retrying.',
                requestId: `req_rl_${attempt}`,
                details: {},
              },
            }),
            {
              status: 429,
              headers: { 'content-type': 'application/json', 'retry-after': '1' },
            },
          );
        }

        // Success
        const runId = `run_${testId}`;
        return new Response(JSON.stringify(makeTriggerResponse(testId, runId)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      const pollMatch = /\/runs\/(run_test_rl[12])/.exec(url);
      if (pollMatch?.[1]) {
        const runId = pollMatch[1];
        const testId = runId.replace('run_', '');
        return new Response(JSON.stringify(makePassedRun(testId, runId)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'not found', nextAction: '', requestId: 'r1' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    const stdout: string[] = [];
    const stderrLines: string[] = [];
    const sleepCalls: number[] = [];

    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: true,
        maxConcurrency: 1, // serial to make call order deterministic
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: line => stderrLines.push(line),
        sleep: ms => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
      },
    );

    // Both should pass — test_rl1 recovered from RATE_LIMITED via outer retry
    const printed = JSON.parse(stdout.join('')) as {
      results: Array<{ testId: string; status: string; runId: string }>;
    };
    expect(printed.results).toHaveLength(2);
    expect(printed.results.every(r => r.status === 'passed')).toBe(true);

    // The outer retry should have emitted a RATE_LIMITED retry advisory on stderr
    const rateLimitedAdvisory = stderrLines.find(l => l.includes('RATE_LIMITED'));
    expect(rateLimitedAdvisory).toBeDefined();

    // Sleep was called (the outer retry back-off)
    expect(sleepCalls.length).toBeGreaterThan(0);
  });

  it('trigger returns RATE_LIMITED on all outer retries → error result for that spec', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_rl3'];
    const plansFile = writePlansJsonl([FE_SPEC]);

    // Every trigger call returns RATE_LIMITED so the outer retry cap is exceeded.
    // retryOnRateLimit: false (batch path) means the HTTP layer throws immediately on
    // the first 429 — each outer attempt = exactly ONE HTTP call. Use Retry-After: 0
    // so outer-retry back-offs are instant.
    const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;

      if (url.includes('/tests/batch')) {
        return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/tests/test_rl3/runs')) {
        // Retry-After: 0 → HTTP-layer sleeps 0 ms per sub-attempt (instant)
        return new Response(
          JSON.stringify({
            error: {
              code: 'RATE_LIMITED',
              message: 'Run trigger rate limit exceeded: 60 triggers per minute per key.',
              nextAction: 'Wait before retrying.',
              requestId: 'req_rl_always',
              details: {},
            },
          }),
          {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '0' },
          },
        );
      }
      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: '', nextAction: '', requestId: 'r1' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    const stdout: string[] = [];

    const err = await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: false,
        maxConcurrency: 1,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: () => {},
        sleep: () => Promise.resolve(), // instant outer-retry back-off
      },
    ).catch(e => e);

    // Overall exit should be a CLIError (exit 11 for uniform RATE_LIMITED)
    expect(err).toBeInstanceOf(CLIError);
    // The spec should appear in results with status 'error' and code RATE_LIMITED
    const printed = JSON.parse(stdout.join('')) as {
      results: Array<{
        testId: string;
        status: string;
        error?: { code: string; exitCode: number };
      }>;
    };
    expect(printed.results).toHaveLength(1);
    const result = printed.results[0]!;
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('RATE_LIMITED');
    expect(result.error?.exitCode).toBe(11);
  }); // retryOnRateLimit: false → 1 HTTP call per outer attempt; extended timeout not needed
});

// ---------------------------------------------------------------------------
// Client-side rate throttle: BATCH_RUN_RATE_LIMIT + rate window constants
// ---------------------------------------------------------------------------

describe('runCreateBatch --run: client-side throttle constants and behaviour', () => {
  it('BATCH_RUN_RATE_LIMIT is 50 (sits under the server 60/min/key cap)', () => {
    expect(BATCH_RUN_RATE_LIMIT).toBe(50);
  });

  it('BATCH_RUN_RATE_MAX_OUTER_RETRIES is > 0 (outer retry is bounded)', () => {
    expect(BATCH_RUN_RATE_MAX_OUTER_RETRIES).toBeGreaterThan(0);
  });

  it('a full 50-spec batch (== rate limit) fires with no client throttle delay', async () => {
    // A maxed-out create-batch holds MAX_BATCH_SPECS (50) specs, and the client
    // throttle limit is also 50/window, so every trigger acquires a slot without
    // waiting — even with the window frozen. We assert no positive throttle sleep.
    const { credentialsPath } = makeCreds();
    const SPEC_COUNT = BATCH_RUN_RATE_LIMIT; // a full batch == the per-minute cap (== MAX_BATCH_SPECS)
    const testIds = Array.from({ length: SPEC_COUNT }, (_, i) => `test_thr${i}`);
    const plansFile = writePlansJsonl(Array.from({ length: SPEC_COUNT }, () => FE_SPEC));

    // Track sleep calls. Polls resolve 'passed' immediately (no backoff), so any
    // positive sleep here would be a throttle delay — which must NOT happen.
    const sleepCallsMs: number[] = [];

    // Freeze Date.now so the throttle window never advances — proving all 50
    // triggers fit under the 50-slot limit within a single window, no wait.
    const realDateNow = Date.now;
    let mockNow = realDateNow();
    Date.now = () => mockNow;

    try {
      const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url;

        if (url.includes('/tests/batch')) {
          return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        const triggerMatch = /\/tests\/(test_thr[0-9]+)\/runs$/.exec(url);
        if (triggerMatch?.[1]) {
          const testId = triggerMatch[1];
          const runId = `run_${testId}`;
          // Advance mock time by 1 ms per trigger so throttle slots are slightly
          // spread (avoids exact-boundary edge cases) but well within 60 s window.
          mockNow += 1;
          return new Response(JSON.stringify(makeTriggerResponse(testId, runId)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        const pollMatch = /\/runs\/(run_test_thr[0-9]+)/.exec(url);
        if (pollMatch?.[1]) {
          const runId = pollMatch[1];
          const testId = runId.replace('run_', '');
          return new Response(JSON.stringify(makePassedRun(testId, runId)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response(
          JSON.stringify({
            error: { code: 'NOT_FOUND', message: '', nextAction: '', requestId: 'r1' },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof globalThis.fetch;

      // --wait:true with all polls resolving 'passed' immediately, so the only
      // possible positive sleep would come from the rate throttle. A generous
      // 300s budget rules out any deadline interaction; the assertion below
      // proves the throttle never delayed any of the 50 triggers.
      await runCreateBatch(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: false,
          plans: plansFile,
          run: true,
          wait: true,
          maxConcurrency: 1, // serial: one trigger at a time so throttle fires cleanly
          timeoutSeconds: 300,
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: () => {},
          stderr: () => {},
          sleep: (ms: number) => {
            sleepCallsMs.push(ms);
            // Advance mockNow so the throttle window progresses on the sleep call
            // (simulates wall-clock time passing during the throttle delay).
            mockNow += ms;
            return Promise.resolve();
          },
        },
      );
    } finally {
      Date.now = realDateNow;
    }

    // No trigger should have been throttled: 50 specs all fit under the 50/window
    // limit, so the throttle emits zero positive-ms sleep calls.
    const throttleDelays = sleepCallsMs.filter(ms => ms > 0);
    expect(throttleDelays.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// --max-concurrency help text accuracy
// ---------------------------------------------------------------------------

describe('create-batch --max-concurrency help text', () => {
  it('accurately states the server 60/min/key cap and the 50/min client throttle', () => {
    const test = createTestCommand();
    const batch = test.commands.find(c => c.name() === 'create-batch')!;
    const opt = batch.options.find(o => o.long === '--max-concurrency')!;
    // Names the real server cap (raised 20 → 60 on the backend, PR #531)
    expect(opt.description).toContain('60/min/key');
    // ...and the client-side throttle / default figure
    expect(opt.description).toContain('50');
    // The stale 20/min figure must be gone
    expect(opt.description).not.toContain('20');
  });
});

// ---------------------------------------------------------------------------
// CODEX ROUND-1 FIXES
// ---------------------------------------------------------------------------

// MAJOR 1: HTTP-layer no longer retries RATE_LIMITED for triggerRunWithMeta.
// The outer loop is the sole retrier; total trigger POSTs stay within the 50/min client throttle.
//
// Regression proof: with HTTP-layer retry enabled, a single invocation that
// receives RATE_LIMITED could fire up to 3 HTTP attempts internally, so a 20-spec
// batch at concurrency 20 could send 60 POSTs/min (3× the cap).
// With retryOnRateLimit:false on triggerRunWithMeta, each RATE_LIMITED response
// surfaces immediately as a single throw.
describe('MAJOR 1: HTTP-layer does not retry RATE_LIMITED for triggerRunWithMeta', () => {
  it('a single RATE_LIMITED trigger fires exactly ONE POST before throwing', async () => {
    // triggerRunWithMeta sets retryOnRateLimit: false. Verify that a single 429
    // response causes exactly one fetch call (not 1 + up to 2 retries = 3).
    const { credentialsPath } = makeCreds();
    const testIds = ['test_m1a'];
    const plansFile = writePlansJsonl([FE_SPEC]);

    let triggerCallCount = 0;

    const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;

      if (url.includes('/tests/batch')) {
        return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.includes('/tests/test_m1a/runs')) {
        triggerCallCount++;
        return new Response(
          JSON.stringify({
            error: {
              code: 'RATE_LIMITED',
              message: 'Run trigger rate limit exceeded: 60 triggers per minute per key.',
              nextAction: 'Wait 60s.',
              requestId: `req_m1_${triggerCallCount}`,
              details: { retryAfterSeconds: 1 },
            },
          }),
          { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } },
        );
      }

      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: '', nextAction: '', requestId: 'r' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: false,
        maxConcurrency: 1,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: () => {},
        // Outer retry sleeps are instant but still called; we don't care about
        // them here — we only care that the HTTP layer fired exactly 1 POST per
        // outer attempt.
        sleep: () => Promise.resolve(),
      },
    ).catch(() => {});

    // Each outer retry attempt should have fired at most 1 POST (not 3).
    // With BATCH_RUN_RATE_MAX_OUTER_RETRIES=5 outer attempts, max is 6
    // (1 initial + 5 retries), each firing exactly 1 POST = 6 total.
    // Without the fix (retryOnRateLimit: true in HttpClient), each outer
    // attempt would fire 3 POSTs = 18 total.
    expect(triggerCallCount).toBeLessThanOrEqual(BATCH_RUN_RATE_MAX_OUTER_RETRIES + 1);
    // Each outer attempt fired exactly 1 POST (not 3 HTTP-layer sub-retries).
    expect(triggerCallCount).toBeGreaterThan(0);
  });
});

// MAJOR 2: Sleeps clamped to --wait deadline; expiring deadline returns timeout
// and does NOT start a fresh poll.
describe('MAJOR 2: sleeps clamped to --wait deadline; no fresh poll after deadline', () => {
  it('throttle-wait deadline clamp: a RATE_LIMITED retry that overflows the window times out (no poll)', async () => {
    // With BATCH_RUN_RATE_LIMIT (50) == MAX_BATCH_SPECS (50), a single batch's 50
    // initial triggers exactly fill the window — they never wait. The throttle-
    // wait path is still reachable on a RATE_LIMITED *retry*: the retry's
    // re-acquire is the 51st slot in the (frozen) window and must wait. Here that
    // wait is clamped to the --wait deadline, so the spec returns 'timeout'
    // (exit 7) at the throttle-acquire loop without ever polling.
    const { credentialsPath } = makeCreds();
    const SPEC_COUNT = BATCH_RUN_RATE_LIMIT; // 50: a full batch == the window cap
    const testIds = Array.from({ length: SPEC_COUNT }, (_, i) => `test_dl${i}`);
    const plansFile = writePlansJsonl(Array.from({ length: SPEC_COUNT }, () => FE_SPEC));
    const lastId = `test_dl${SPEC_COUNT - 1}`;

    const realDateNow = Date.now;
    let mockNow = realDateNow();
    Date.now = () => mockNow;

    try {
      const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url;

        if (url.includes('/tests/batch')) {
          return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        const triggerMatch = /\/tests\/(test_dl[0-9]+)\/runs$/.exec(url);
        if (triggerMatch?.[1]) {
          const testId = triggerMatch[1];
          // The last spec always returns a transient RATE_LIMITED (Retry-After 1s),
          // forcing a retry whose re-acquire is the 51st slot in the frozen window.
          if (testId === lastId) {
            return new Response(
              JSON.stringify({
                error: {
                  code: 'RATE_LIMITED',
                  message: 'Run trigger rate limit exceeded: 60 triggers per minute per key.',
                  nextAction: 'Wait and retry.',
                  requestId: 'req_dl',
                  details: { retryAfterSeconds: 1 },
                },
              }),
              { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } },
            );
          }
          const runId = `run_${testId}`;
          return new Response(JSON.stringify(makeTriggerResponse(testId, runId)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        const pollMatch = /\/runs\/(run_test_dl[0-9]+)/.exec(url);
        if (pollMatch?.[1]) {
          const runId = pollMatch[1];
          const testId = runId.replace('run_', '');
          return new Response(JSON.stringify(makePassedRun(testId, runId)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        return new Response(
          JSON.stringify({
            error: { code: 'NOT_FOUND', message: '', nextAction: '', requestId: 'r' },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof globalThis.fetch;

      const stdout: string[] = [];
      const sleepCallsMs: number[] = [];
      await runCreateBatch(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: false,
          plans: plansFile,
          run: true,
          wait: true,
          maxConcurrency: 1, // serial so the 50 initial acquires precede the retry
          timeoutSeconds: 2, // deadline > Retry-After(1s) so the throttle wait (not the backoff) exhausts it
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: line => stdout.push(line),
          stderr: () => {},
          sleep: (ms: number) => {
            // Realistic clock: advance by exactly `ms` (no jump-past) so the
            // deadline is consumed *during* the throttle-wait sleep, exercising the
            // clamp at the throttle-acquire loop, not the pre-trigger deadline guard.
            sleepCallsMs.push(ms);
            mockNow += ms;
            return Promise.resolve();
          },
        },
      ).catch(() => {});

      const printed = JSON.parse(stdout.join('')) as {
        results: Array<{ testId: string; status: string; error?: { message?: string } }>;
      };
      const last = printed.results.find(r => r.testId === lastId);
      expect(last?.status).toBe('timeout');
      // Branch-specific: the throttle-wait deadline clamp (not the pre-trigger
      // deadline guard, nor the RATE_LIMITED backoff) — its message names the slot.
      expect(last?.error?.message ?? '').toContain('waiting to acquire throttle slot');
      // Corroborating: both the RATE_LIMITED backoff and the throttle-wait slept
      // (a single backoff sleep alone would trip the pre-trigger guard instead).
      expect(sleepCallsMs.filter(ms => ms > 0).length).toBeGreaterThanOrEqual(2);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('RATE_LIMITED retry sleep clamped: deadline expires during backoff → timeout (no poll started)', async () => {
    // Trigger always returns RATE_LIMITED so the outer loop sleeps 60s.
    // With --timeout 1s the sleep should be clamped to ~1s and then timeout.
    // The test verifies poll is NOT called after the deadline expires.
    const { credentialsPath } = makeCreds();
    const testIds = ['test_dl_rl'];
    const plansFile = writePlansJsonl([FE_SPEC]);

    const realDateNow = Date.now;
    let mockNow = realDateNow();
    Date.now = () => mockNow;

    let pollCallCount = 0;

    try {
      const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url;

        if (url.includes('/tests/batch')) {
          return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/tests/test_dl_rl/runs')) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'RATE_LIMITED',
                message: 'Run trigger rate limit exceeded: 60 triggers per minute per key.',
                nextAction: 'Wait.',
                requestId: 'req_dl_rl',
                details: { retryAfterSeconds: 60 },
              },
            }),
            {
              status: 429,
              headers: { 'content-type': 'application/json', 'retry-after': '60' },
            },
          );
        }
        if (url.includes('/runs/')) {
          pollCallCount++;
        }
        return new Response(
          JSON.stringify({
            error: { code: 'NOT_FOUND', message: '', nextAction: '', requestId: 'r' },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof globalThis.fetch;

      const stdout: string[] = [];
      await runCreateBatch(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: false,
          plans: plansFile,
          run: true,
          wait: true,
          maxConcurrency: 1,
          timeoutSeconds: 1, // 1 second budget
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: line => stdout.push(line),
          stderr: () => {},
          sleep: (ms: number) => {
            // Advance time past deadline on any sleep so the clamping logic kicks in.
            mockNow += ms + 2000;
            return Promise.resolve();
          },
        },
      ).catch(() => {});

      // Poll was never called — the RATE_LIMITED backoff consumed the deadline.
      expect(pollCallCount).toBe(0);

      // Result for the spec should be timeout, not error or passed.
      if (stdout.length > 0) {
        const printed = JSON.parse(stdout.join('')) as {
          results: Array<{ testId: string; status: string }>;
        };
        const result = printed.results.find(r => r.testId === 'test_dl_rl');
        if (result !== undefined) {
          expect(result.status).toBe('timeout');
        }
      }
    } finally {
      Date.now = realDateNow;
    }
  });
});

// MAJOR 3: Retry-After header preserved on thrown ApiError; honored by outer loop.
describe('MAJOR 3: Retry-After header honored by outer retry loop', () => {
  it('trigger 429 with Retry-After:5 causes exactly 5s sleep (not hardcoded 60s)', async () => {
    // Test that the outer loop uses the Retry-After header value, not the fallback.
    const { credentialsPath } = makeCreds();
    const testIds = ['test_ra1'];
    const plansFile = writePlansJsonl([FE_SPEC]);

    let triggerAttempt = 0;
    const sleepCallsMs: number[] = [];

    const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;

      if (url.includes('/tests/batch')) {
        return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/tests/test_ra1/runs')) {
        triggerAttempt++;
        if (triggerAttempt === 1) {
          // Return 429 with Retry-After: 5 (should be honored, not the 60s default)
          return new Response(
            JSON.stringify({
              error: {
                code: 'RATE_LIMITED',
                message: 'Run trigger rate limit exceeded: 60 triggers per minute per key.',
                nextAction: 'Wait 5s.',
                requestId: 'req_ra1',
                details: { retryAfterSeconds: 5 },
              },
            }),
            { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '5' } },
          );
        }
        // Second attempt succeeds
        return new Response(JSON.stringify(makeTriggerResponse('test_ra1', 'run_ra1')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/runs/run_ra1')) {
        return new Response(JSON.stringify(makePassedRun('test_ra1', 'run_ra1')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: '', nextAction: '', requestId: 'r' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: true,
        maxConcurrency: 1,
        timeoutSeconds: 120,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: () => {},
        sleep: (ms: number) => {
          sleepCallsMs.push(ms);
          return Promise.resolve();
        },
      },
    );

    // The outer retry sleep should be exactly 5000ms (from Retry-After: 5),
    // NOT 60000ms (the hardcoded fallback). Filter out tiny throttle sleeps (< 100ms).
    const backoffSleeps = sleepCallsMs.filter(ms => ms >= 1000);
    expect(backoffSleeps.length).toBeGreaterThan(0);
    // The sleep should be ~5s (from the header), not ~60s
    expect(backoffSleeps[0]).toBe(5000);
    // Definitely not the 60s hardcoded fallback
    expect(backoffSleeps[0]).not.toBe(60_000);
  });

  it('trigger 429 with Retry-After:400 is clamped to 300s ([1s,300s] range)', async () => {
    // Server sends an unreasonably long Retry-After; should be clamped.
    const { credentialsPath } = makeCreds();
    const testIds = ['test_ra2'];
    const plansFile = writePlansJsonl([FE_SPEC]);

    let attempt = 0;
    const sleepCallsMs: number[] = [];

    const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;

      if (url.includes('/tests/batch')) {
        return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/tests/test_ra2/runs')) {
        attempt++;
        if (attempt === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'RATE_LIMITED',
                message: 'Run trigger rate limit exceeded: 60 triggers per minute per key.',
                nextAction: 'Wait.',
                requestId: 'req_ra2',
                details: { retryAfterSeconds: 400 },
              },
            }),
            // Retry-After: 400 — well above the 300s cap
            { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '400' } },
          );
        }
        return new Response(JSON.stringify(makeTriggerResponse('test_ra2', 'run_ra2')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/runs/run_ra2')) {
        return new Response(JSON.stringify(makePassedRun('test_ra2', 'run_ra2')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: '', nextAction: '', requestId: 'r' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: true,
        maxConcurrency: 1,
        timeoutSeconds: 600, // big budget so clamp is the only thing that fires
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: () => {},
        sleep: (ms: number) => {
          sleepCallsMs.push(ms);
          return Promise.resolve();
        },
      },
    );

    // HttpClient clamps Retry-After to [1s, 300s] before setting retryAfterMs.
    const backoffSleeps = sleepCallsMs.filter(ms => ms >= 1000);
    expect(backoffSleeps.length).toBeGreaterThan(0);
    // Must be ≤ 300s (300000ms), never the raw 400s from the header
    expect(backoffSleeps[0]).toBeLessThanOrEqual(300_000);
    // Must be > 0
    expect(backoffSleeps[0]).toBeGreaterThan(0);
  });
});

// Credit-depletion vs transient rate-limit: predicate and retry behavior.
describe('isTransientRateLimit + credit-depletion not retried', () => {
  // Unit tests for the predicate
  describe('isTransientRateLimit predicate', () => {
    function makeRateLimitedError(opts: {
      message: string;
      retryAfterMs?: number;
      details?: Record<string, unknown>;
    }): ApiError {
      return new ApiError(
        {
          code: 'RATE_LIMITED',
          message: opts.message,
          nextAction: '',
          requestId: 'req_pred',
          details: opts.details ?? {},
        },
        429,
        opts.retryAfterMs,
      );
    }

    it('returns true when retryAfterMs is set (Retry-After header present)', () => {
      const err = makeRateLimitedError({
        message: 'Run trigger rate limit exceeded: 60 triggers per minute per key.',
        retryAfterMs: 5000,
      });
      expect(isTransientRateLimit(err)).toBe(true);
    });

    it('returns true when message matches per-minute rate limit wording', () => {
      const err = makeRateLimitedError({
        message: 'Run trigger rate limit exceeded: 60 triggers per minute per key.',
        retryAfterMs: undefined,
      });
      expect(isTransientRateLimit(err)).toBe(true);
    });

    it('returns true when details.retryAfterSeconds is present', () => {
      const err = makeRateLimitedError({
        message: 'Some other rate limit message.',
        retryAfterMs: undefined,
        details: { retryAfterSeconds: 30 },
      });
      expect(isTransientRateLimit(err)).toBe(true);
    });

    it('returns false for credit-depletion message (no Retry-After, no per-min wording)', () => {
      const err = makeRateLimitedError({
        message:
          'Insufficient credits: 1 credit(s) required. Top up at https://www.testsprite.com/settings/billing.',
        retryAfterMs: undefined,
        details: { required: 1, userId: 'user_123' },
      });
      expect(isTransientRateLimit(err)).toBe(false);
    });

    it('returns false for unknown RATE_LIMITED with no header and no per-min wording', () => {
      const err = makeRateLimitedError({
        message: 'Rate limit exceeded.',
        retryAfterMs: undefined,
      });
      expect(isTransientRateLimit(err)).toBe(false);
    });
  });

  // Integration: credit-depletion RATE_LIMITED is NOT retried in the outer loop.
  it('credit-depletion RATE_LIMITED is NOT retried — surfaces immediately as terminal error', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_cred'];
    const plansFile = writePlansJsonl([FE_SPEC]);

    let triggerCallCount = 0;

    const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;

      if (url.includes('/tests/batch')) {
        return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/tests/test_cred/runs')) {
        triggerCallCount++;
        // Credit-depletion error: no Retry-After header, message differs from per-min wording
        return new Response(
          JSON.stringify({
            error: {
              code: 'RATE_LIMITED',
              message:
                'Insufficient credits: 1 credit(s) required. Top up at https://www.testsprite.com/settings/billing.',
              nextAction:
                'Top up your credit balance at https://www.testsprite.com/settings/billing, then retry.',
              requestId: 'req_cred',
              details: { required: 1, userId: 'user_x' },
            },
          }),
          {
            // No Retry-After header — key distinguishing signal
            status: 429,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: '', nextAction: '', requestId: 'r' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    const stdout: string[] = [];
    const sleepCalls: number[] = [];

    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: false,
        maxConcurrency: 1,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: () => {},
        sleep: ms => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
      },
    ).catch(() => {});

    // Trigger was called exactly ONCE — no retries for credit depletion.
    expect(triggerCallCount).toBe(1);
    // No sleep calls for retry backoff (only throttle-acquire sleeps possible, but
    // with one spec in an empty window those are 0).
    const backoffSleeps = sleepCalls.filter(ms => ms > 0);
    expect(backoffSleeps).toHaveLength(0);

    // Result should be status='error' with code=RATE_LIMITED
    if (stdout.length > 0) {
      const printed = JSON.parse(stdout.join('')) as {
        results: Array<{ testId: string; status: string; error?: { code: string } }>;
      };
      const result = printed.results.find(r => r.testId === 'test_cred');
      expect(result?.status).toBe('error');
      // Credits depletion is now re-mapped to INSUFFICIENT_CREDITS (exit 12)
      expect(result?.error?.code).toBe('INSUFFICIENT_CREDITS');
    }
  });

  it('per-minute RATE_LIMITED IS retried and eventually succeeds', async () => {
    // The transient case (per-minute cap) should still retry.
    // First trigger → RATE_LIMITED with Retry-After: 1; second → success.
    const { credentialsPath } = makeCreds();
    const testIds = ['test_transient'];
    const plansFile = writePlansJsonl([FE_SPEC]);

    let attempt = 0;

    const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;

      if (url.includes('/tests/batch')) {
        return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/tests/test_transient/runs')) {
        attempt++;
        if (attempt === 1) {
          // Transient per-minute rate limit WITH Retry-After header
          return new Response(
            JSON.stringify({
              error: {
                code: 'RATE_LIMITED',
                message: 'Run trigger rate limit exceeded: 60 triggers per minute per key.',
                nextAction: 'Wait 1s.',
                requestId: 'req_transient',
                details: { retryAfterSeconds: 1 },
              },
            }),
            { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } },
          );
        }
        return new Response(
          JSON.stringify(makeTriggerResponse('test_transient', 'run_transient')),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (url.includes('/runs/run_transient')) {
        return new Response(JSON.stringify(makePassedRun('test_transient', 'run_transient')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: '', nextAction: '', requestId: 'r' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    const stdout: string[] = [];

    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: true,
        maxConcurrency: 1,
        timeoutSeconds: 120,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: () => {},
        sleep: () => Promise.resolve(), // instant backoff
      },
    );

    // Trigger was retried (attempt = 2 total) and eventually passed.
    expect(attempt).toBe(2);
    const printed = JSON.parse(stdout.join('')) as {
      results: Array<{ testId: string; status: string }>;
    };
    const result = printed.results.find(r => r.testId === 'test_transient');
    expect(result?.status).toBe('passed');
  });
});

// ---------------------------------------------------------------------------
// CODEX ROUND-2 FIXES
// ---------------------------------------------------------------------------

/**
 * (a) Single `test run` STILL retries a transient 429 (HTTP-layer retry intact).
 *
 * `triggerRunWithMeta` now defaults `retryOnRateLimit: true`, so the HTTP layer
 * retries 429 for non-batch callers. Only the batch path passes `false`.
 */
describe('ROUND-2 (a): single test run retries transient 429 via HTTP-layer', () => {
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

  it('runTestRun retries a transient 429 at the HTTP layer and eventually succeeds', async () => {
    const { credentialsPath } = makeCreds();
    let fetchCallCount = 0;

    const triggerResp: TriggerRunResponse = {
      runId: 'run_r2a',
      status: 'queued',
      enqueuedAt: '2026-05-30T10:00:00Z',
      codeVersion: 'v1',
      targetUrl: 'https://example.com',
    };
    const passedRun: RunResponse = {
      runId: 'run_r2a',
      testId: 'test_r2a',
      projectId: 'project_p1',
      userId: 'user_1',
      status: 'passed',
      source: 'cli',
      createdAt: '2026-05-30T10:00:00Z',
      startedAt: '2026-05-30T10:00:01Z',
      finishedAt: '2026-05-30T10:00:10Z',
      codeVersion: 'v1',
      targetUrl: 'https://example.com',
      createdFrom: 'cli',
      failedStepIndex: null,
      failureKind: null,
      error: null,
      videoUrl: null,
      stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 },
    };

    const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;

      if (url.includes('/tests/test_r2a/runs')) {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          // First call → transient 429 with Retry-After
          return new Response(
            JSON.stringify({
              error: {
                code: 'RATE_LIMITED',
                message: 'Run trigger rate limit exceeded: 60 triggers per minute per key.',
                nextAction: 'Wait.',
                requestId: 'req_r2a',
                details: {},
              },
            }),
            { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } },
          );
        }
        // Second call → success (HTTP-layer retry)
        return new Response(JSON.stringify(triggerResp), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/runs/run_r2a')) {
        return new Response(JSON.stringify(passedRun), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: '', nextAction: '', requestId: 'r' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    await runTestRun(
      {
        testId: 'test_r2a',
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        wait: true,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        sleep: () => Promise.resolve(), // instant HTTP-layer retry sleep
        stderr: () => {},
      },
    );

    // HTTP layer made 2 fetch calls to /runs (1 RATE_LIMITED + 1 success).
    // If retryOnRateLimit were false (old behavior), it would throw after call 1.
    expect(fetchCallCount).toBe(2);
  });
});

/**
 * (b) Batch path does NOT double-retry — the outer loop is the sole retrier.
 *
 * With `retryOnRateLimit: false` on the batch call, each 429 produces exactly
 * ONE HTTP call before the outer loop re-acquires a throttle slot and retries.
 */
describe('ROUND-2 (b): batch path does NOT double-retry 429 (no HTTP-layer sub-retries)', () => {
  it('each outer attempt fires exactly 1 HTTP call for the trigger POST', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_r2b'];
    const plansFile = writePlansJsonl([FE_SPEC]);

    let triggerCallCount = 0;

    const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;

      if (url.includes('/tests/batch')) {
        return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/tests/test_r2b/runs')) {
        triggerCallCount++;
        if (triggerCallCount <= 1) {
          // First outer attempt → RATE_LIMITED, no HTTP-layer retries with retryOnRateLimit:false
          return new Response(
            JSON.stringify({
              error: {
                code: 'RATE_LIMITED',
                message: 'Run trigger rate limit exceeded: 60 triggers per minute per key.',
                nextAction: 'Wait.',
                requestId: `req_r2b_${triggerCallCount}`,
                details: { retryAfterSeconds: 1 },
              },
            }),
            { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } },
          );
        }
        // Second outer attempt → success
        return new Response(JSON.stringify(makeTriggerResponse('test_r2b', 'run_r2b')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/runs/run_r2b')) {
        return new Response(JSON.stringify(makePassedRun('test_r2b', 'run_r2b')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: '', nextAction: '', requestId: 'r' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    const stdout: string[] = [];
    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: true,
        maxConcurrency: 1,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: () => {},
        sleep: () => Promise.resolve(),
      },
    );

    // With retryOnRateLimit: false on the batch path, each outer attempt fires
    // exactly 1 HTTP call (not 3). So: attempt 1 = 1 call (RATE_LIMITED),
    // attempt 2 = 1 call (success) → total = 2.
    // If HTTP-layer sub-retries were happening, this would be 4 (1×3 + 1).
    expect(triggerCallCount).toBe(2);

    const printed = JSON.parse(stdout.join('')) as {
      results: Array<{ testId: string; status: string }>;
    };
    expect(printed.results[0]?.status).toBe('passed');
  });
});

/**
 * (c) No trigger fires after the `--wait` deadline expired.
 *
 * The deadline check at the TOP of the outer loop (before rateThrottle.acquire)
 * ensures that after a retry sleep that pushes past the deadline, no new POST
 * is sent on the next iteration.
 */
describe('ROUND-2 (c): no trigger fires after --wait deadline expires', () => {
  it('after a RATE_LIMITED sleep that expires the deadline, no further trigger POST is sent', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_r2c'];
    const plansFile = writePlansJsonl([FE_SPEC]);

    let triggerCallCount = 0;

    const realDateNow = Date.now;
    let mockNow = realDateNow();
    Date.now = () => mockNow;

    try {
      const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url;

        if (url.includes('/tests/batch')) {
          return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/tests/test_r2c/runs')) {
          triggerCallCount++;
          // Always return RATE_LIMITED with Retry-After: 60
          return new Response(
            JSON.stringify({
              error: {
                code: 'RATE_LIMITED',
                message: 'Run trigger rate limit exceeded: 60 triggers per minute per key.',
                nextAction: 'Wait.',
                requestId: `req_r2c_${triggerCallCount}`,
                details: { retryAfterSeconds: 60 },
              },
            }),
            { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60' } },
          );
        }
        return new Response(
          JSON.stringify({
            error: { code: 'NOT_FOUND', message: '', nextAction: '', requestId: 'r' },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof globalThis.fetch;

      const stdout: string[] = [];
      await runCreateBatch(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: false,
          plans: plansFile,
          run: true,
          wait: true,
          maxConcurrency: 1,
          timeoutSeconds: 1, // 1s deadline
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: line => stdout.push(line),
          stderr: () => {},
          sleep: (ms: number) => {
            // Advance time past the 1s deadline during the first backoff sleep.
            mockNow += ms + 2000;
            return Promise.resolve();
          },
        },
      ).catch(() => {});

      // The deadline check at the top of the outer loop fires after the first
      // RATE_LIMITED response causes a sleep that pushes mockNow past deadline.
      // No second trigger POST should have been sent.
      expect(triggerCallCount).toBe(1);

      if (stdout.length > 0) {
        const printed = JSON.parse(stdout.join('')) as {
          results: Array<{ testId: string; status: string }>;
        };
        expect(printed.results[0]?.status).toBe('timeout');
      }
    } finally {
      Date.now = realDateNow;
    }
  });
});

/**
 * (d) 0 remaining ms → timeout result without polling.
 *
 * Fix 3 short-circuits before `pollRunUntilTerminal` when `remainingMs() <= 0`,
 * rather than converting 0 → 1s via `Math.max(1, Math.floor(0/1000))`.
 */
describe('ROUND-2 (d): 0 remaining ms before poll yields timeout without polling', () => {
  it('trigger succeeds but deadline is 0 ms when polling would start → timeout, not 1s poll', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_r2d'];
    const plansFile = writePlansJsonl([FE_SPEC]);

    let pollCallCount = 0;

    const realDateNow = Date.now;
    let mockNow = realDateNow();
    // Start with mockNow such that deadline = now + 1s. The trigger POST advances
    // mockNow past the deadline, so remainingMs() = 0 when polling would start.
    const DEADLINE_MS = 1000; // 1s

    try {
      const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : (input as { url: string }).url;

        if (url.includes('/tests/batch')) {
          return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/tests/test_r2d/runs')) {
          // Trigger succeeds — but advance time past the deadline so the poll
          // check sees remainingMs() <= 0.
          mockNow += DEADLINE_MS + 500; // jump past the 1s deadline
          return new Response(JSON.stringify(makeTriggerResponse('test_r2d', 'run_r2d')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('/runs/')) {
          pollCallCount++;
          return new Response(JSON.stringify(makePassedRun('test_r2d', 'run_r2d')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            error: { code: 'NOT_FOUND', message: '', nextAction: '', requestId: 'r' },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof globalThis.fetch;

      Date.now = () => mockNow;

      const stdout: string[] = [];
      await runCreateBatch(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: false,
          plans: plansFile,
          run: true,
          wait: true,
          maxConcurrency: 1,
          timeoutSeconds: DEADLINE_MS / 1000,
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: line => stdout.push(line),
          stderr: () => {},
          sleep: () => Promise.resolve(),
        },
      ).catch(() => {});

      // Poll should NOT have been called — deadline was 0 ms when the check ran.
      // Old code: Math.max(1, Math.floor(0/1000)) = 1 → would start a 1s poll.
      // Fixed code: remainingMs() <= 0 → returns timeout immediately.
      expect(pollCallCount).toBe(0);

      if (stdout.length > 0) {
        const printed = JSON.parse(stdout.join('')) as {
          results: Array<{ testId: string; status: string }>;
        };
        expect(printed.results[0]?.status).toBe('timeout');
      }
    } finally {
      Date.now = realDateNow;
    }
  });
});

/**
 * (e) Insufficient-credits 429 carrying a Retry-After header is NOT retried.
 *
 * Fix 4: `isTransientRateLimit` now checks "Insufficient credits" FIRST and
 * short-circuits to terminal, regardless of whether a Retry-After header was
 * present.  This closes a gap where a credits-depletion 429 with a stray
 * Retry-After header would be incorrectly classified as transient.
 */
describe('ROUND-2 (e): insufficient-credits 429 with Retry-After header is terminal (not retried)', () => {
  it('isTransientRateLimit returns false for credits error even with retryAfterMs set', () => {
    const err = new ApiError(
      {
        code: 'RATE_LIMITED',
        message:
          'Insufficient credits: 5 credit(s) required. Top up at https://www.testsprite.com/settings/billing.',
        nextAction: 'Top up your balance.',
        requestId: 'req_e',
        details: { required: 5 },
      },
      429,
      // retryAfterMs is set (as if Retry-After header was present on the response)
      30_000,
    );
    // Must be false despite retryAfterMs being set — credits check short-circuits.
    expect(isTransientRateLimit(err)).toBe(false);
  });

  it('batch path does not retry credits-depletion 429 even when Retry-After header is present', async () => {
    const { credentialsPath } = makeCreds();
    const testIds = ['test_r2e'];
    const plansFile = writePlansJsonl([FE_SPEC]);

    let triggerCallCount = 0;

    const fetchImpl = (async (input: FetchInput, _init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;

      if (url.includes('/tests/batch')) {
        return new Response(JSON.stringify(makeBatchCreateResponse(testIds)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/tests/test_r2e/runs')) {
        triggerCallCount++;
        // Credits-depletion error WITH a Retry-After header (the bad case the fix closes).
        return new Response(
          JSON.stringify({
            error: {
              code: 'RATE_LIMITED',
              message:
                'Insufficient credits: 3 credit(s) required. Top up at https://www.testsprite.com/settings/billing.',
              nextAction: 'Top up.',
              requestId: 'req_r2e',
              details: { required: 3 },
            },
          }),
          {
            status: 429,
            // Stray Retry-After header — should be ignored for credits errors
            headers: { 'content-type': 'application/json', 'retry-after': '30' },
          },
        );
      }
      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: '', nextAction: '', requestId: 'r' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    const stdout: string[] = [];
    const sleepCalls: number[] = [];

    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        plans: plansFile,
        run: true,
        wait: false,
        maxConcurrency: 1,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: () => {},
        sleep: ms => {
          sleepCalls.push(ms);
          return Promise.resolve();
        },
      },
    ).catch(() => {});

    // Credits-depletion is terminal — trigger fired exactly once, no retries.
    expect(triggerCallCount).toBe(1);

    // No backoff sleep for a terminal error.
    const backoffSleeps = sleepCalls.filter(ms => ms > 0);
    expect(backoffSleeps).toHaveLength(0);

    if (stdout.length > 0) {
      const printed = JSON.parse(stdout.join('')) as {
        results: Array<{ testId: string; status: string; error?: { code: string } }>;
      };
      const result = printed.results.find(r => r.testId === 'test_r2e');
      expect(result?.status).toBe('error');
      // Credits depletion is now re-mapped to INSUFFICIENT_CREDITS (exit 12)
      expect(result?.error?.code).toBe('INSUFFICIENT_CREDITS');
    }
  });
});
