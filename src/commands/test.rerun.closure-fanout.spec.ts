/**
 * Closure fan-out partial-results tests for `test rerun --wait` (BE).
 *
 * Split out of `test.rerun.spec.ts` (which is already the largest rerun spec):
 * that file sits at the Windows-CI vitest reporter-RPC threshold, and growing
 * it tips the `onTaskUpdate` worker call into a timeout. These focused cases
 * live in their own small file so the big suite stays under that threshold.
 *
 * Behavior under test: one closure member's non-timeout poll error must NOT
 * reject the whole fan-out — siblings survive and the partial still prints.
 * The errored member is collected in `closureFailures[]` tagged `unobserved`,
 * which flips `--wait` to exit 7 (its verdict was never confirmed). The named
 * test's own error is re-thrown after the payload prints (real exit code
 * preserved). All HTTP is mocked; the polling loop's sleep is injected via
 * `TestDeps.sleep`.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/errors.js';
import type { RunResponse, RerunResponse } from '../lib/runs.types.js';
import { runTestRerun } from './test.js';

// ---------------------------------------------------------------------------
// Helpers (self-contained copies of the minimal set from test.rerun.spec.ts)
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
  apiUrl = 'http://localhost:13503',
): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-dev459-'));
  const credentialsPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(credentialsPath, `[default]\napi_url = ${apiUrl}\napi_key = ${apiKey}\n`, {
    mode: 0o600,
  });
  return { credentialsPath };
}

const instantSleep = () => Promise.resolve();

const BE_TEST = {
  id: 'test_be_consumer_01',
  projectId: 'project_abc',
  name: 'BE consumer test',
  type: 'backend' as const,
  createdFrom: 'portal' as const,
  status: 'passed' as const,
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
};

function makeBeRerunResp(): RerunResponse {
  return {
    runId: 'run_rerun_be_named',
    status: 'queued',
    enqueuedAt: '2026-06-03T10:00:00.000Z',
    codeVersion: 'v1',
    autoHeal: false,
    closure: {
      members: [
        { testId: 'test_be_consumer_01', runId: 'run_rerun_be_named', role: 'selected' },
        { testId: 'test_be_producer_01', runId: 'run_rerun_be_producer', role: 'producer' },
      ],
      addedProducers: ['test_be_producer_01'],
      addedTeardowns: [],
      clearedCaptured: 0,
    },
  };
}

function makeTerminalRun(
  runId: string,
  status: 'passed' | 'failed' | 'blocked' = 'passed',
): RunResponse {
  return {
    runId,
    testId: 'test_be_consumer_01',
    projectId: 'project_abc',
    userId: 'user_1',
    status,
    source: 'cli',
    createdAt: '2026-06-03T10:00:00.000Z',
    startedAt: '2026-06-03T10:00:01.000Z',
    finishedAt: '2026-06-03T10:00:30.000Z',
    codeVersion: 'v1',
    targetUrl: 'https://api.example.com',
    createdFrom: 'rerun:prior_run_01',
    failedStepIndex: status === 'passed' ? null : 2,
    failureKind: status === 'passed' ? null : 'assertion',
    error: null,
    videoUrl: null,
    stepSummary: {
      total: 5,
      completed: 5,
      passedCount: status === 'passed' ? 5 : 4,
      failedCount: status === 'passed' ? 0 : 1,
    },
  };
}

function errorBody(
  code: string,
  details: Record<string, unknown> = {},
): { status: number; body: unknown } {
  const statusMap: Record<string, number> = {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BE closure fan-out: a member poll error is classified (survives fan-out), flips exit 7', () => {
  const baseOpts = {
    all: false as const,
    wait: true as const,
    timeoutSeconds: 10,
    autoHeal: false,
    autoHealExplicit: false,
    skipDependencies: false,
    maxConcurrency: 10,
    output: 'json' as const,
    profile: 'default',
    dryRun: false,
    debug: false,
    verbose: false,
  };

  it('non-named member poll error → siblings survive + partial printed, then --wait exits 7 (unobserved)', async () => {
    const creds = makeCreds();
    const rerunResp = makeBeRerunResp();
    const namedRun = makeTerminalRun('run_rerun_be_named', 'passed');
    namedRun.testId = 'test_be_consumer_01';
    const stderrLines: string[] = [];
    const printed: unknown[] = [];

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_be_consumer_01/runs/rerun')) return { body: rerunResp };
      if (url.includes('/tests/test_be_consumer_01') || url.includes('/tests/test_be_producer_01'))
        return { body: BE_TEST };
      if (url.includes('/runs/run_rerun_be_named')) return { body: namedRun };
      // Producer member poll fails for the whole window — the fan-out still
      // completes and prints the partial, but the producer's verdict was never
      // observed, so --wait must exit 7 (not silently succeed as exit 0).
      return errorBody('UNAVAILABLE', { reason: 'upstream' });
    });

    const err = await runTestRerun(
      { ...baseOpts, testIds: ['test_be_consumer_01'] },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stderr: line => stderrLines.push(line),
        stdout: line => printed.push(JSON.parse(line)),
      },
    ).catch(e => e);

    // Unobserved dependency → exit 7, thrown AFTER the partial was printed.
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('UNSUPPORTED');
    expect((err as ApiError).exitCode).toBe(7);

    const json = printed[0] as {
      namedStatus?: string;
      closureFailures?: Array<{ testId: string; status: string; unobserved?: boolean }>;
    };
    // The named verdict survived (not discarded by the sibling error).
    expect(json.namedStatus).toBe('passed');
    // The errored member is surfaced in closureFailures[], tagged unobserved and
    // carrying its diagnostic code.
    expect(Array.isArray(json.closureFailures)).toBe(true);
    const producerFailure = json.closureFailures!.find(f => f.testId === 'test_be_producer_01');
    expect(producerFailure?.status).toBe('UNAVAILABLE');
    expect(producerFailure?.unobserved).toBe(true);
    expect(stderrLines.some(l => l.includes('closure member') && l.includes('UNAVAILABLE'))).toBe(
      true,
    );
  });

  it('named member poll throws → real error/exit preserved, partial stdout still written', async () => {
    const creds = makeCreds();
    const rerunResp = makeBeRerunResp();
    const producerRun = makeTerminalRun('run_rerun_be_producer', 'passed');
    producerRun.testId = 'test_be_producer_01';
    const stdoutLines: string[] = [];

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_be_consumer_01/runs/rerun')) return { body: rerunResp };
      if (url.includes('/tests/test_be_consumer_01') || url.includes('/tests/test_be_producer_01'))
        return { body: BE_TEST };
      if (url.includes('/runs/run_rerun_be_producer')) return { body: producerRun };
      // Named member poll fails.
      return errorBody('NOT_FOUND', { reason: 'not_found' });
    });

    const err = await runTestRerun(
      { ...baseOpts, testIds: ['test_be_consumer_01'] },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stderr: () => undefined,
        stdout: line => stdoutLines.push(line),
      },
    ).catch(e => e);

    // The named test's real error is surfaced (not masked as a timeout)...
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('NOT_FOUND');
    expect((err as ApiError).exitCode).toBe(4);
    // ...and a parseable partial was still written before the re-throw.
    expect(stdoutLines.length).toBeGreaterThan(0);
  });
});
