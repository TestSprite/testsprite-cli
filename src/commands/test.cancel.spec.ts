/**
 * Unit tests for `test cancel <run-id...>`.
 *
 * Covers: single-id happy path (text + json), `alreadyCancelled` advisory,
 * multi-id mixed summary + exit precedence, 404, 409, dry-run.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DRY_RUN_BANNER, resetDryRunBannerForTesting } from '../lib/client-factory.js';
import { ApiError } from '../lib/errors.js';
import type { CancelRunResponse } from '../lib/runs.types.js';
import { runTestCancel, type CliCancelSummary } from './test.js';

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
  apiUrl = 'http://localhost:13503',
): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-cancel-'));
  const credentialsPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(credentialsPath, `[default]\napi_url = ${apiUrl}\napi_key = ${apiKey}\n`, {
    mode: 0o600,
  });
  return { credentialsPath };
}

function makeCancelResponse(
  runId: string,
  overrides: Partial<CancelRunResponse> = {},
): CancelRunResponse {
  return {
    runId,
    testId: 'test_xyz',
    projectId: 'project_1',
    userId: 'user_1',
    status: 'cancelled',
    source: 'cli',
    createdAt: '2026-05-15T10:00:00.000Z',
    startedAt: '2026-05-15T10:00:01.000Z',
    finishedAt: '2026-05-15T10:00:30.000Z',
    codeVersion: 'v1',
    targetUrl: 'https://example.com',
    createdFrom: 'cli',
    failedStepIndex: null,
    failureKind: null,
    error: null,
    videoUrl: null,
    stepSummary: { total: 5, completed: 2, passedCount: 2, failedCount: 0 },
    alreadyCancelled: false,
    ...overrides,
  };
}

function errorBody(code: string, details: Record<string, unknown> = {}) {
  const statusMap: Record<string, number> = {
    NOT_FOUND: 404,
    CONFLICT: 409,
    AUTH_FORBIDDEN: 403,
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

/** Extract the runId embedded in a `POST /runs/{runId}/cancel` URL. */
function runIdFromCancelUrl(url: string): string | undefined {
  const match = /\/runs\/([^/]+)\/cancel/.exec(url);
  return match?.[1];
}

// ---------------------------------------------------------------------------
// Single id — happy path
// ---------------------------------------------------------------------------

describe('runTestCancel — single id happy path', () => {
  it('CXL-1: fresh cancel of a queued/running run → 200, alreadyCancelled:false, no advisory', async () => {
    const { credentialsPath } = makeCreds();
    let seenUrl = '';
    let seenMethod = '';
    const fetchImpl = makeFetch((url, init) => {
      seenUrl = url;
      seenMethod = init.method ?? 'GET';
      return { body: makeCancelResponse('run_abc') };
    });
    const stderrLines: string[] = [];
    const result = (await runTestCancel(
      { profile: 'default', output: 'json', debug: false, dryRun: false, runIds: ['run_abc'] },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: line => stderrLines.push(line) },
    )) as CancelRunResponse;

    expect(seenMethod).toBe('POST');
    expect(runIdFromCancelUrl(seenUrl)).toBe('run_abc');
    expect(result.status).toBe('cancelled');
    expect(result.alreadyCancelled).toBe(false);
    expect(stderrLines.some(l => l.includes('already cancelled'))).toBe(false);
  });

  it('renders the run card in text mode with status cancelled', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: makeCancelResponse('run_abc') }));
    const stdoutLines: string[] = [];
    await runTestCancel(
      { profile: 'default', output: 'text', debug: false, dryRun: false, runIds: ['run_abc'] },
      { credentialsPath, fetchImpl, stdout: line => stdoutLines.push(line), stderr: () => {} },
    );
    const block = stdoutLines.join('\n');
    expect(block).toContain('run_abc');
    expect(block).toContain('status');
    expect(block).toContain('cancelled');
  });

  const baseText = (runId: string) =>
    [
      `runId       ${runId}`,
      'testId      test_xyz',
      'status      cancelled',
      'codeVersion v1',
      'targetUrl   https://example.com',
      'createdAt   2026-05-15T10:00:00.000Z',
      'startedAt   2026-05-15T10:00:01.000Z',
      'finishedAt  2026-05-15T10:00:30.000Z',
      'steps       2/5 (passed=2, failed=0)',
    ].join('\n');

  const refundCases: Array<{
    name: string;
    refund?: { status: 'refunded' | 'not_charged' | 'failed'; amount?: number };
    textLine?: string;
  }> = [
    {
      name: 'refunded with original amount',
      refund: { status: 'refunded', amount: 2.5 },
      textLine: 'refund      credits returned: 2.5',
    },
    {
      name: 'not charged',
      refund: { status: 'not_charged' },
      textLine: 'refund      run was never charged; nothing to return',
    },
    {
      name: 'refund failed',
      refund: { status: 'failed' },
      textLine:
        'refund      failed — cancellation succeeded, but credits were not returned; contact TestSprite support',
    },
    { name: 'refund field absent' },
  ];

  it.each(refundCases)('renders $name truthfully in text mode', async ({ refund, textLine }) => {
    const { credentialsPath } = makeCreds();
    const response = makeCancelResponse('run_refund', refund === undefined ? {} : { refund });
    const fetchImpl = makeFetch(() => ({ body: response }));
    const stdoutLines: string[] = [];

    await runTestCancel(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        runIds: ['run_refund'],
      },
      { credentialsPath, fetchImpl, stdout: line => stdoutLines.push(line), stderr: () => {} },
    );

    const expected = textLine ? `${baseText('run_refund')}\n${textLine}` : baseText('run_refund');
    expect(stdoutLines).toEqual([expected]);
  });

  it.each(refundCases)('passes $name through unchanged in JSON mode', async ({ refund }) => {
    const { credentialsPath } = makeCreds();
    const response = makeCancelResponse('run_refund', refund === undefined ? {} : { refund });
    const fetchImpl = makeFetch(() => ({ body: response }));
    const stdoutLines: string[] = [];

    await runTestCancel(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runIds: ['run_refund'],
      },
      { credentialsPath, fetchImpl, stdout: line => stdoutLines.push(line), stderr: () => {} },
    );

    const printed = JSON.parse(stdoutLines.join('\n')) as { refund?: unknown };
    if (refund === undefined) {
      expect('refund' in printed).toBe(false);
    } else {
      expect(printed.refund).toEqual(refund);
    }
  });

  it('rejects a malformed refund object at the HttpClient validation boundary', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { ...makeCancelResponse('run_refund'), refund: { amount: 2.5 } },
    }));

    const error = await runTestCancel(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runIds: ['run_refund'],
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'INTERNAL' });
    expect(JSON.stringify((error as ApiError).getDetail('issues'))).toContain('refund.status');
  });

  it('CXL-5: alreadyCancelled:true → [advisory] stderr line, still exit 0 (no throw)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: makeCancelResponse('run_abc', { alreadyCancelled: true }),
    }));
    const stderrLines: string[] = [];
    const result = (await runTestCancel(
      { profile: 'default', output: 'json', debug: false, dryRun: false, runIds: ['run_abc'] },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: line => stderrLines.push(line) },
    )) as CancelRunResponse;
    expect(result.alreadyCancelled).toBe(true);
    expect(stderrLines.some(l => l.includes('[advisory]') && l.includes('already cancelled'))).toBe(
      true,
    );
  });

  it('CXL-6: unknown/cross-tenant runId → 404 propagates as ApiError exit 4', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => errorBody('NOT_FOUND'));
    const err = await runTestCancel(
      { profile: 'default', output: 'json', debug: false, dryRun: false, runIds: ['run_ghost'] },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).exitCode).toBe(4);
  });

  it('CXL-4: already-terminal run → 409 propagates as ApiError exit 6', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => errorBody('CONFLICT', { status: 'passed' }));
    const err = await runTestCancel(
      { profile: 'default', output: 'json', debug: false, dryRun: false, runIds: ['run_done'] },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).exitCode).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Multi-id — summary + exit precedence (CXL-11)
// ---------------------------------------------------------------------------

describe('runTestCancel — multi-id summary + exit precedence (CXL-11)', () => {
  it('all cancelled/alreadyCancelled → exit 0, summary buckets correct', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(url => {
      const runId = runIdFromCancelUrl(url)!;
      if (runId === 'run_2') {
        return { body: makeCancelResponse(runId, { alreadyCancelled: true }) };
      }
      return { body: makeCancelResponse(runId) };
    });
    const result = (await runTestCancel(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runIds: ['run_1', 'run_2'],
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    )) as CliCancelSummary;
    expect(result.cancelled).toEqual(['run_1']);
    expect(result.alreadyCancelled).toEqual(['run_2']);
    expect(result.conflicts).toEqual([]);
    expect(result.notFound).toEqual([]);
    // Stable machine shape (codex finding 2): errors is ALWAYS present,
    // an empty array on full success — never an absent key.
    expect(result.errors).toEqual([]);
  });

  it('mixed: cancelled + conflict + notFound → notFound wins (exit 4), all buckets populated', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(url => {
      const runId = runIdFromCancelUrl(url)!;
      if (runId === 'run_conflict') return errorBody('CONFLICT', { status: 'failed' });
      if (runId === 'run_ghost') return errorBody('NOT_FOUND');
      return { body: makeCancelResponse(runId) };
    });
    const err = await runTestCancel(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runIds: ['run_ok', 'run_conflict', 'run_ghost'],
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    ).catch(e => e);
    expect(err.exitCode).toBe(4); // notFound outranks conflict
    expect(err.message).toContain('run_ghost');
  });

  it('cancelled + conflict, no notFound → conflict wins (exit 6)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(url => {
      const runId = runIdFromCancelUrl(url)!;
      if (runId === 'run_conflict') return errorBody('CONFLICT', { status: 'blocked' });
      return { body: makeCancelResponse(runId) };
    });
    const err = await runTestCancel(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runIds: ['run_ok', 'run_conflict'],
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    ).catch(e => e);
    expect(err.exitCode).toBe(6);
    expect(err.message).toContain('run_conflict');
    expect(err.message).toContain('blocked');
  });

  it('JSON summary shape carries the conflicting run status', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(url => {
      const runId = runIdFromCancelUrl(url)!;
      if (runId === 'run_conflict') return errorBody('CONFLICT', { status: 'passed' });
      return { body: makeCancelResponse(runId) };
    });
    const stdoutLines: string[] = [];
    await runTestCancel(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runIds: ['run_ok', 'run_conflict'],
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdoutLines.push(line),
        stderr: () => {},
      },
    ).catch(() => {});
    const summary = JSON.parse(stdoutLines.join('\n')) as CliCancelSummary;
    expect(summary.cancelled).toEqual(['run_ok']);
    expect(summary.conflicts).toEqual([{ runId: 'run_conflict', status: 'passed' }]);
  });
});

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

describe('runTestCancel — dry-run', () => {
  it('single id: prints the dry-run banner and a canned cancelled envelope, no real network', async () => {
    resetDryRunBannerForTesting();
    const stderrLines: string[] = [];
    const result = (await runTestCancel(
      { profile: 'default', output: 'json', debug: false, dryRun: true, runIds: ['run_dry'] },
      { stdout: () => {}, stderr: line => stderrLines.push(line) },
    )) as CancelRunResponse;
    expect(stderrLines.some(l => l.includes(DRY_RUN_BANNER))).toBe(true);
    expect(result.status).toBe('cancelled');
    expect(result.alreadyCancelled).toBe(false);
  });
});
