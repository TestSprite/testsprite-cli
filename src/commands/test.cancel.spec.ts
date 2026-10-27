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
import { ApiError, InterruptError } from '../lib/errors.js';
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
  it('stops cancelling remaining runs after an interrupted request', async () => {
    const { credentialsPath } = makeCreds();
    const interruption = new InterruptError('SIGINT');
    const cancelled: string[] = [];
    const fetchImpl = makeFetch(url => {
      cancelled.push(url);
      if (cancelled.length === 1) throw interruption;
      return { body: makeCancelResponse('run_2') };
    });

    await expect(
      runTestCancel(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: false,
          runIds: ['run_1', 'run_2'],
        },
        { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
      ),
    ).rejects.toBe(interruption);
    expect(cancelled).toHaveLength(1);
  });

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
    expect(result.refunds).toEqual([]);
  });

  it.each(['json', 'text'] as const)(
    'preserves mixed refund outcomes in %s mode without failing successful cancellations',
    async output => {
      const { credentialsPath } = makeCreds();
      const refunds = {
        run_paid: { status: 'refunded', amount: 0 },
        run_free: { status: 'not_charged' },
        run_failed: { status: 'failed' },
        run_already_failed: { status: 'failed' },
      } satisfies Record<string, NonNullable<CancelRunResponse['refund']>>;
      const runIds = [...Object.keys(refunds), 'run_legacy'];
      const stdout: string[] = [];
      const stderr: string[] = [];
      const result = await runTestCancel(
        { profile: 'default', output, debug: false, dryRun: false, runIds },
        {
          credentialsPath,
          fetchImpl: makeFetch(url => {
            const runId = runIdFromCancelUrl(url)!;
            return {
              body: makeCancelResponse(runId, {
                ...(runId in refunds ? { refund: refunds[runId as keyof typeof refunds] } : {}),
                alreadyCancelled: runId === 'run_already_failed',
              }),
            };
          }),
          stdout: line => stdout.push(line),
          stderr: line => stderr.push(line),
        },
      );
      const expectedRefunds = Object.entries(refunds).map(([runId, refund]) => ({
        runId,
        ...refund,
      }));
      expect(result).toEqual({
        cancelled: ['run_paid', 'run_free', 'run_failed', 'run_legacy'],
        alreadyCancelled: ['run_already_failed'],
        conflicts: [],
        notFound: [],
        errors: [],
        refunds: expectedRefunds,
      });
      if (output === 'json') {
        expect(JSON.parse(stdout.join('\n'))).toEqual(result);
      } else {
        const text = stdout.join('\n');
        expect(text).toContain('run_paid  refund      credits returned: 0');
        expect(text).toContain('run_free  refund      run was never charged; nothing to return');
        for (const runId of ['run_failed', 'run_already_failed']) {
          expect(text).toContain(`${runId}  refund      failed — cancellation succeeded`);
        }
        expect(text).not.toContain('run_legacy  refund');
      }
      expect(stderr.filter(line => line.startsWith('[warning]'))).toEqual([
        '[warning] Refund failed for runs: run_failed run_already_failed; cancellation succeeded, but credits were not returned; contact TestSprite support.',
      ]);
    },
  );

  it.each([
    { output: 'json' as const, runIds: ['run_actual'] },
    { output: 'json' as const, runIds: ['run_actual', 'run_legacy'] },
    { output: 'text' as const, runIds: ['run_actual', 'run_legacy'] },
  ])(
    'keeps requested refund IDs authoritative for $runIds in $output mode',
    async ({ output, runIds }) => {
      const { credentialsPath } = makeCreds();
      const stdout: string[] = [];
      const stderr: string[] = [];
      // The response validator preserves unknown refund fields for forward compatibility.
      const refund = { status: 'failed' as const, runId: 'run_unrelated' };
      const result = await runTestCancel(
        { profile: 'default', output, debug: false, dryRun: false, runIds },
        {
          credentialsPath,
          fetchImpl: makeFetch(url => {
            const runId = runIdFromCancelUrl(url)!;
            return { body: makeCancelResponse(runId, runId === 'run_actual' ? { refund } : {}) };
          }),
          stdout: line => stdout.push(line),
          stderr: line => stderr.push(line),
        },
      );
      expect(stderr.join('\n')).toContain('Refund failed for runs: run_actual;');
      expect(stderr.join('\n')).not.toContain('run_unrelated');
      if (runIds.length > 1) {
        expect((result as CliCancelSummary).refunds).toEqual([
          { runId: 'run_actual', status: 'failed' },
        ]);
        expect(stdout.join('\n')).not.toContain('run_unrelated');
      }
    },
  );

  it.each([
    { code: 'NOT_FOUND', exitCode: 4 },
    { code: 'CONFLICT', exitCode: 6 },
    { code: 'AUTH_FORBIDDEN', exitCode: 1 },
  ])('warns about a failed refund before throwing exit $exitCode', async ({ code, exitCode }) => {
    const { credentialsPath } = makeCreds();
    const events: string[] = [];
    const stdout: string[] = [];
    await expect(
      runTestCancel(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: false,
          runIds: ['run_failed', 'run_error'],
        },
        {
          credentialsPath,
          fetchImpl: makeFetch(url =>
            runIdFromCancelUrl(url) === 'run_error'
              ? errorBody(code, { status: 'passed' })
              : { body: makeCancelResponse('run_failed', { refund: { status: 'failed' } }) },
          ),
          stdout: line => stdout.push(line),
          stderr: line => events.push(line),
        },
      ).catch((err: unknown) => {
        events.push('throw');
        throw err;
      }),
    ).rejects.toMatchObject({ exitCode });
    expect(JSON.parse(stdout.join('\n')).refunds).toEqual([
      { runId: 'run_failed', status: 'failed' },
    ]);
    const warningIndex = events.findIndex(line => line.startsWith('[warning]'));
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeLessThan(events.indexOf('throw'));
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
