/**
 * Unit tests for `test result <test-id> --history` — M3.4 piece-5.
 *
 * Tests the `runResultHistory` function and the `parseDuration` helper.
 * All HTTP is mocked via injectable `TestDeps.fetchImpl`.
 *
 * Coverage targets:
 *  - history table rendering (text mode)
 *  - JSON output shape: `{ runs, nextCursor }`
 *  - pagination cursor round-trip
 *  - `--source` / `--since` filter forwarding
 *  - empty / pre-cutover note rendering
 *  - short-page hint when filtered page < pageSize but nextCursor non-null
 *  - `isRerun` column rendering
 *  - back-compat: bare `test result <id>` (no --history) returns M2 latest UNCHANGED
 *  - 404 cross-tenant/unknown test → exit 4
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, InterruptError, RequestTimeoutError } from '../lib/errors.js';
import { ShutdownController } from '../lib/interrupt.js';
import type { ListRunsResponse, RunHistoryItem } from '../lib/runs.types.js';
import type { CliLatestResult } from './test.js';
import { runResultHistory, runResult, runSteps, parseDuration, createTestCommand } from './test.js';

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
): {
  credentialsPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'cli-m34-hist-'));
  const credentialsPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(credentialsPath, `[default]\napi_url = ${apiUrl}\napi_key = ${apiKey}\n`, {
    mode: 0o600,
  });
  return { credentialsPath };
}

/** Build a canned RunHistoryItem. */
function makeHistoryItem(overrides?: Partial<RunHistoryItem>): RunHistoryItem {
  return {
    runId: 'run_hist_001',
    status: 'passed',
    source: 'cli',
    isRerun: false,
    createdFrom: null,
    createdAt: '2026-06-03T10:00:00.000Z',
    startedAt: '2026-06-03T10:00:05.000Z',
    finishedAt: '2026-06-03T10:02:00.000Z',
    codeVersion: 'v1',
    failureKind: null,
    ...overrides,
  };
}

/** Build a canned ListRunsResponse. */
function makeHistoryResp(
  items: RunHistoryItem[] = [makeHistoryItem()],
  nextCursor: string | null = null,
  meta: ListRunsResponse['meta'] = { testKind: 'frontend' },
): ListRunsResponse {
  return { runs: items, nextCursor, meta };
}

/** Canned M2 CliLatestResult. */
const CANNED_LATEST_RESULT: CliLatestResult = {
  testId: 'test_abc',
  status: 'passed',
  startedAt: '2026-06-03T10:00:00.000Z',
  finishedAt: '2026-06-03T10:02:00.000Z',
  videoUrl: null,
  failureAnalysisUrl: null,
  snapshotId: 'snap_001',
  runIdIfAvailable: 'run_001',
  codeVersion: 'v1',
  targetUrl: 'https://example.com',
  failedStepIndex: null,
  failureKind: null,
  verdict: 'passed',
  executionStatus: 'completed',
  summary: 'Test passed.',
};

function errorEnvelope(code: string): unknown {
  return {
    error: {
      code,
      message: `Error: ${code}`,
      nextAction: 'retry',
      requestId: 'req_test',
      details: {},
    },
  };
}

// ---------------------------------------------------------------------------
// parseDuration
// ---------------------------------------------------------------------------

describe('parseDuration', () => {
  const NOW = new Date('2026-06-03T12:00:00.000Z');

  it('24h → 24 hours before now', () => {
    const result = parseDuration('24h', NOW);
    expect(result).toBe('2026-06-02T12:00:00.000Z');
  });

  it('7d → 7 days before now', () => {
    const result = parseDuration('7d', NOW);
    expect(result).toBe('2026-05-27T12:00:00.000Z');
  });

  it('1h → 1 hour before now', () => {
    const result = parseDuration('1h', NOW);
    expect(result).toBe('2026-06-03T11:00:00.000Z');
  });

  it('30d → 30 days before now', () => {
    const result = parseDuration('30d', NOW);
    // 30 days before 2026-06-03 = 2026-05-04
    expect(result).toBe('2026-05-04T12:00:00.000Z');
  });

  it('ISO timestamp returned verbatim', () => {
    const iso = '2026-05-14T00:00:00.000Z';
    expect(parseDuration(iso, NOW)).toBe(iso);
  });

  it('epoch string returned verbatim', () => {
    expect(parseDuration('1748822400000', NOW)).toBe('1748822400000');
  });

  it('unknown string returned verbatim', () => {
    expect(parseDuration('yesterday', NOW)).toBe('yesterday');
  });

  it('case-insensitive hour suffix', () => {
    expect(parseDuration('24H', NOW)).toBe('2026-06-02T12:00:00.000Z');
  });

  it('case-insensitive day suffix', () => {
    expect(parseDuration('7D', NOW)).toBe('2026-05-27T12:00:00.000Z');
  });

  it('overflow hours throws VALIDATION_ERROR instead of crashing', () => {
    expect(() => parseDuration('99999999999h', NOW)).toThrow();
    try {
      parseDuration('99999999999h', NOW);
    } catch (err: unknown) {
      expect((err as { code?: string }).code).toBe('VALIDATION_ERROR');
    }
  });

  it('overflow days throws VALIDATION_ERROR instead of crashing', () => {
    expect(() => parseDuration('99999999999d', NOW)).toThrow();
    try {
      parseDuration('99999999999d', NOW);
    } catch (err: unknown) {
      expect((err as { code?: string }).code).toBe('VALIDATION_ERROR');
    }
  });
});

// ---------------------------------------------------------------------------
// runResultHistory — text mode
// ---------------------------------------------------------------------------

describe('runResultHistory — text mode', () => {
  it('renders a table with RUN ID, STATUS, SOURCE, RERUN?, WHEN, DURATION columns', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return { body: makeHistoryResp() };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    expect(output).toMatch(/RUN ID/);
    expect(output).toMatch(/STATUS/);
    expect(output).toMatch(/SOURCE/);
    expect(output).toMatch(/RERUN\?/);
    expect(output).toMatch(/WHEN/);
    expect(output).toMatch(/DURATION/);
  });

  it('selects/reorders columns and suppresses header/separator/detail sub-lines', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: makeHistoryResp([
            makeHistoryItem({
              runId: 'run_url_001',
              targetUrl: 'https://staging.example.com/checkout',
              targetUrlSource: 'run',
            }),
          ]),
        };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
        columns: 'status,runid',
        noHeader: true,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    expect(output.split('\n')[0]).toMatch(/^passed\s+run_url_001$/);
    expect(output).not.toMatch(/^RUN ID/m);
    expect(output).not.toMatch(/^-+$/m);
    expect(output).not.toContain('targetUrl:');
  });

  it('no-header suppresses only the history header and separator', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: makeHistoryResp([
            makeHistoryItem({
              runId: 'run_url_001',
              targetUrl: 'https://staging.example.com/checkout',
              targetUrlSource: 'run',
            }),
          ]),
        };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
        noHeader: true,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    expect(output).not.toMatch(/^RUN ID/m);
    expect(output).not.toMatch(/^-+$/m);
    expect(output).toContain('run_url_001');
    expect(output).toContain('targetUrl: https://staging.example.com/checkout');
  });

  it('rejects unknown history columns with VALIDATION_ERROR before auth/network access', async () => {
    await expect(
      runResultHistory(
        {
          output: 'text',
          testId: 'test_abc',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
          columns: 'bogus',
        },
        { stdout: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: { field: 'columns' },
    });
  });

  it('json mode ignores text-only history column flags', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return { body: makeHistoryResp() };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'json',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
        columns: 'bogus',
        noHeader: true,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const parsed = JSON.parse(lines.join('')) as { runs: Array<{ runId: string }> };
    expect(parsed.runs[0]?.runId).toBe('run_hist_001');
  });

  it('renders run_hist_001 row with status passed and source cli', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return { body: makeHistoryResp() };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    expect(output).toMatch(/run_hist_001/);
    expect(output).toMatch(/passed/);
    expect(output).toMatch(/cli/);
    // isRerun: false → "no" in the RERUN? column
    expect(output).toMatch(/\bno\b/);
  });

  it('RERUN? column shows "yes" when isRerun is true', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: makeHistoryResp([
            makeHistoryItem({
              runId: 'run_rerun_001',
              isRerun: true,
              createdFrom: 'rerun:run_hist_001',
            }),
          ]),
        };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    expect(output).toMatch(/\byes\b/);
  });

  // --rerun / --no-rerun client-side filter (asserted in JSON mode for exactness)
  const mixedRerunFetch = () =>
    makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: makeHistoryResp([
            makeHistoryItem({ runId: 'run_fresh', isRerun: false, createdFrom: null }),
            makeHistoryItem({ runId: 'run_rerun', isRerun: true, createdFrom: 'rerun:prior' }),
          ]),
        };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

  it('--rerun keeps only reruns in the JSON runs array', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    await runResultHistory(
      {
        output: 'json',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
        rerun: true,
      },
      { credentialsPath, fetchImpl: mixedRerunFetch(), stdout: line => lines.push(line) },
    );
    const parsed = JSON.parse(lines.join('')) as { runs: RunHistoryItem[] };
    expect(parsed.runs.map(r => r.runId)).toEqual(['run_rerun']);
  });

  it('--no-rerun keeps only fresh runs in the JSON runs array', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    await runResultHistory(
      {
        output: 'json',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
        rerun: false,
      },
      { credentialsPath, fetchImpl: mixedRerunFetch(), stdout: line => lines.push(line) },
    );
    const parsed = JSON.parse(lines.join('')) as { runs: RunHistoryItem[] };
    expect(parsed.runs.map(r => r.runId)).toEqual(['run_fresh']);
  });

  it('no rerun flag keeps every run (no filter)', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    await runResultHistory(
      {
        output: 'json',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl: mixedRerunFetch(), stdout: line => lines.push(line) },
    );
    const parsed = JSON.parse(lines.join('')) as { runs: RunHistoryItem[] };
    expect(parsed.runs.map(r => r.runId)).toEqual(['run_fresh', 'run_rerun']);
  });

  it('renders DURATION as "NmNs" when startedAt and finishedAt are present', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        // 2 minutes 30 seconds duration
        return {
          body: makeHistoryResp([
            makeHistoryItem({
              startedAt: '2026-06-03T10:00:00.000Z',
              finishedAt: '2026-06-03T10:02:30.000Z',
            }),
          ]),
        };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    expect(output).toMatch(/2m 30s/);
  });

  it('renders DURATION as "Ns" for sub-minute runs', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: makeHistoryResp([
            makeHistoryItem({
              startedAt: '2026-06-03T10:00:00.000Z',
              finishedAt: '2026-06-03T10:00:45.000Z',
            }),
          ]),
        };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    expect(output).toMatch(/45s/);
  });

  it('renders DURATION as "—" when startedAt is null', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: makeHistoryResp([makeHistoryItem({ startedAt: null, finishedAt: null })]),
        };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    expect(output).toMatch(/—/);
  });

  it('shows per-run detail footer pointing at test wait and test artifact get', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return { body: makeHistoryResp() };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    expect(output).toMatch(/test wait/);
    expect(output).toMatch(/test artifact get/);
  });
});

// ---------------------------------------------------------------------------
// runResultHistory — JSON mode
// ---------------------------------------------------------------------------

describe('runResultHistory — JSON mode', () => {
  it('emits { runs, nextCursor } envelope in JSON mode', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const resp = makeHistoryResp([makeHistoryItem()], 'cursor_xyz');
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return { body: resp };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'json',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const parsed = JSON.parse(lines.join('')) as { runs: unknown[]; nextCursor: string | null };
    expect(Array.isArray(parsed.runs)).toBe(true);
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.nextCursor).toBe('cursor_xyz');
  });

  it('JSON mode preserves the backend meta in the output envelope', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const resp = makeHistoryResp([makeHistoryItem()], null, { testKind: 'frontend' });
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return { body: resp };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'json',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const parsed = JSON.parse(lines.join('')) as Record<string, unknown>;
    expect(parsed.meta).toEqual(resp.meta);
  });
});

// ---------------------------------------------------------------------------
// Pagination cursor
// ---------------------------------------------------------------------------

describe('runResultHistory — pagination', () => {
  it('forwards --cursor to the request URL', async () => {
    const { credentialsPath } = makeCreds();
    let capturedUrl = '';
    const fetchImpl = makeFetch(url => {
      capturedUrl = url;
      return { body: makeHistoryResp() };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        cursor: 'cursor_abc123',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: () => {} },
    );

    expect(capturedUrl).toContain('cursor=cursor_abc123');
  });

  it('shows Next page hint when nextCursor is non-null', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return { body: makeHistoryResp([makeHistoryItem()], 'cursor_next_page') };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    expect(output).toMatch(/--cursor cursor_next_page/);
  });

  it('forwards --page-size to the request URL', async () => {
    const { credentialsPath } = makeCreds();
    let capturedUrl = '';
    const fetchImpl = makeFetch(url => {
      capturedUrl = url;
      return { body: makeHistoryResp() };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        pageSize: 5,
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: () => {} },
    );

    expect(capturedUrl).toContain('pageSize=5');
  });

  it('rejects fractional --page-size before making a request', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => {
      throw new Error('should not be called');
    });

    await expect(
      runResultHistory(
        {
          output: 'json',
          testId: 'test_abc',
          pageSize: 1.5,
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { credentialsPath, fetchImpl, stdout: () => {} },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: expect.objectContaining({ field: 'page-size' }),
    });
  });
});

// ---------------------------------------------------------------------------
// --source / --since filter forwarding
// ---------------------------------------------------------------------------

describe('runResultHistory — --source / --since filters', () => {
  it('forwards --source to the request URL', async () => {
    const { credentialsPath } = makeCreds();
    let capturedUrl = '';
    const fetchImpl = makeFetch(url => {
      capturedUrl = url;
      return { body: makeHistoryResp() };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        source: 'portal',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: () => {} },
    );

    expect(capturedUrl).toContain('source=portal');
  });

  it('forwards --since as ISO timestamp after parseDuration', async () => {
    const { credentialsPath } = makeCreds();
    let capturedUrl = '';
    const fetchImpl = makeFetch(url => {
      capturedUrl = url;
      return { body: makeHistoryResp() };
    });

    // We use an ISO timestamp directly (bypassing clock dependency).
    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        since: '2026-05-14T00:00:00.000Z',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: () => {} },
    );

    expect(capturedUrl).toContain('since=2026-05-14T00');
  });

  it('does NOT append source/since to URL when not provided', async () => {
    const { credentialsPath } = makeCreds();
    let capturedUrl = '';
    const fetchImpl = makeFetch(url => {
      capturedUrl = url;
      return { body: makeHistoryResp() };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: () => {} },
    );

    expect(capturedUrl).not.toContain('source=');
    expect(capturedUrl).not.toContain('since=');
  });
});

// ---------------------------------------------------------------------------
// Empty / pre-cutover note
// ---------------------------------------------------------------------------

describe('runResultHistory — empty / pre-cutover', () => {
  it('prints meta.note when runs array is empty', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: {
            runs: [],
            nextCursor: null,
            meta: {
              historyStartsAt: '2026-05-14',
              note: 'No CLI-tracked history before 2026-05-14; older runs are in the Portal.',
              portalUrl: 'https://app.testsprite.com/tests/test_abc',
            },
          } satisfies ListRunsResponse,
        };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    expect(output).toMatch(/No CLI-tracked history before 2026-05-14/);
  });

  it('prints default note when runs array is empty and meta.note is absent', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: {
            runs: [],
            nextCursor: null,
            meta: {},
          } satisfies ListRunsResponse,
        };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    expect(output).toMatch(/No CLI-tracked history/);
  });

  it('does NOT render a table when runs is empty (pre-cutover)', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: makeHistoryResp([], null, {
            note: 'empty pre-cutover',
          }),
        };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    // No table headers when empty
    expect(output).not.toMatch(/RUN ID.*STATUS/);
  });
});

// ---------------------------------------------------------------------------
// Fix A — empty filtered page with non-null nextCursor must NOT report
// "no CLI-tracked history" — it must surface the pagination cursor instead.
// ---------------------------------------------------------------------------

describe('[fix-A] empty filtered page + non-null nextCursor → paginatable (not pre-cutover)', () => {
  it('shows pagination prompt (not pre-cutover note) when runs=[] but nextCursor is non-null', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: {
            runs: [],
            nextCursor: 'cursor_next_page_abc',
            meta: { testKind: 'frontend' },
          } satisfies ListRunsResponse,
        };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        source: 'cli',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    // Must surface the cursor so the user can continue
    expect(output).toMatch(/--cursor cursor_next_page_abc/);
    // Must NOT claim there is no history
    expect(output).not.toMatch(/No CLI-tracked history/);
  });

  it('shows pre-cutover note when runs=[] AND nextCursor is null', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: {
            runs: [],
            nextCursor: null,
            meta: { testKind: 'frontend' },
          } satisfies ListRunsResponse,
        };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        source: 'cli',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    // Truly empty: should show the no-history note
    expect(output).toMatch(/No CLI-tracked history/);
    expect(output).not.toMatch(/--cursor/);
  });
});

// ---------------------------------------------------------------------------
// Short-page hint
// ---------------------------------------------------------------------------

describe('runResultHistory — short filtered page hint', () => {
  it('emits stderr hint when filtered page < pageSize but nextCursor is non-null', async () => {
    const { credentialsPath } = makeCreds();
    const stderrLines: string[] = [];
    // Return only 1 row but with a nextCursor → short-page scenario
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: makeHistoryResp([makeHistoryItem()], 'cursor_more_pages'),
        };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        pageSize: 20,
        source: 'portal', // filter that would cause short page
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
      },
    );

    const stderrOutput = stderrLines.join('\n');
    expect(stderrOutput).toMatch(/more may exist/);
    expect(stderrOutput).toMatch(/--cursor cursor_more_pages/);
  });

  it('does NOT emit hint when page is full even with nextCursor', async () => {
    const { credentialsPath } = makeCreds();
    const stderrLines: string[] = [];
    // Return exactly pageSize rows (1) with nextCursor — NOT a "short" page
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: makeHistoryResp([makeHistoryItem()], 'cursor_full'),
        };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        pageSize: 1, // pageSize = 1, returns exactly 1 → not short
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
      },
    );

    const stderrOutput = stderrLines.join('\n');
    expect(stderrOutput).not.toMatch(/more may exist/);
  });

  it('does NOT emit hint when nextCursor is null', async () => {
    const { credentialsPath } = makeCreds();
    const stderrLines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return { body: makeHistoryResp([makeHistoryItem()], null) };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        pageSize: 20,
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
      },
    );

    expect(stderrLines.join('\n')).not.toMatch(/more may exist/);
  });
});

// ---------------------------------------------------------------------------
// 404 handling
// ---------------------------------------------------------------------------

describe('runResultHistory — 404 (cross-tenant / unknown)', () => {
  it('propagates NOT_FOUND (404) → exit 4', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 404,
      body: errorEnvelope('NOT_FOUND'),
    }));

    const err = await runResultHistory(
      {
        output: 'text',
        testId: 'test_unknown',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: () => {} },
    ).catch(e => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('NOT_FOUND');
    expect((err as ApiError).exitCode).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Back-compat: bare `test result <id>` (no --history) is UNCHANGED (M2)
// ---------------------------------------------------------------------------

describe('runResult — back-compat (M2 latest result)', () => {
  it('calls /tests/{testId}/result (NOT /tests/{testId}/runs)', async () => {
    const { credentialsPath } = makeCreds();
    let calledUrl = '';
    const fetchImpl = makeFetch(url => {
      calledUrl = url;
      return { body: CANNED_LATEST_RESULT };
    });

    await runResult(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: () => {} },
    );

    expect(calledUrl).toContain('/tests/test_abc/result');
    expect(calledUrl).not.toContain('/runs');
  });

  it('returns the CliLatestResult shape (not ListRunsResponse)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: CANNED_LATEST_RESULT }));

    const result = await runResult(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: () => {} },
    );

    // runResult must return the M2 CliLatestResult shape
    expect(result.testId).toBe('test_abc');
    expect(result.snapshotId).toBeDefined();
    expect(result.summary).toBeDefined();
    // Must NOT have 'runs' or 'nextCursor' (those belong to ListRunsResponse)
    expect((result as unknown as { runs?: unknown }).runs).toBeUndefined();
    expect((result as unknown as { nextCursor?: unknown }).nextCursor).toBeUndefined();
  });

  it('renders status and snapshotId in text mode (not a history table)', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(() => ({ body: CANNED_LATEST_RESULT }));

    await runResult(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    // text mode now leads with verdict (outcome) instead of the
    // conflated status line.
    expect(output).toMatch(/verdict:\s+passed/);
    expect(output).toMatch(/snapshotId:\s+snap_001/);
    // Must NOT look like a history table (no RUN ID header)
    expect(output).not.toMatch(/RUN ID\s+STATUS/);
  });
});

// ---------------------------------------------------------------------------
// Multiple runs in history table
// ---------------------------------------------------------------------------

describe('runResultHistory — multiple rows', () => {
  it('renders multiple run rows', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: makeHistoryResp([
            makeHistoryItem({ runId: 'run_001', status: 'passed', isRerun: false }),
            makeHistoryItem({
              runId: 'run_002',
              status: 'failed',
              isRerun: true,
              createdFrom: 'rerun:run_001',
            }),
            makeHistoryItem({
              runId: 'run_003',
              status: 'blocked',
              source: 'portal',
              isRerun: false,
            }),
          ]),
        };
      }
      return { status: 404, body: errorEnvelope('NOT_FOUND') };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    expect(output).toMatch(/run_001/);
    expect(output).toMatch(/run_002/);
    expect(output).toMatch(/run_003/);
    expect(output).toMatch(/failed/);
    expect(output).toMatch(/blocked/);
    expect(output).toMatch(/portal/);
  });
});

// ---------------------------------------------------------------------------
// G1b — per-run targetUrl in history table
// ---------------------------------------------------------------------------

describe('runResultHistory — G1b targetUrl in history table (text mode)', () => {
  it('renders targetUrl sub-line when targetUrl is present and targetUrlSource is "run"', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: makeHistoryResp([
            makeHistoryItem({
              runId: 'run_url_001',
              targetUrl: 'https://staging.example.com/checkout',
              targetUrlSource: 'run',
            }),
          ]),
        };
      }
      return {
        status: 404,
        body: {
          error: {
            code: 'NOT_FOUND',
            message: 'nf',
            nextAction: 'retry',
            requestId: 'r',
            details: {},
          },
        },
      };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    expect(output).toMatch(/targetUrl: https:\/\/staging\.example\.com\/checkout/);
  });

  it('renders targetUrl: — when targetUrlSource is "unresolved"', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: makeHistoryResp([
            makeHistoryItem({
              runId: 'run_url_002',
              targetUrl: null,
              targetUrlSource: 'unresolved',
            }),
          ]),
        };
      }
      return {
        status: 404,
        body: {
          error: {
            code: 'NOT_FOUND',
            message: 'nf',
            nextAction: 'retry',
            requestId: 'r',
            details: {},
          },
        },
      };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    expect(output).toMatch(/targetUrl: —/);
  });

  it('omits targetUrl sub-line when targetUrl is absent (pre-G1b backend)', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        // makeHistoryItem() has no targetUrl field by default
        return { body: makeHistoryResp([makeHistoryItem()]) };
      }
      return {
        status: 404,
        body: {
          error: {
            code: 'NOT_FOUND',
            message: 'nf',
            nextAction: 'retry',
            requestId: 'r',
            details: {},
          },
        },
      };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    expect(output).not.toMatch(/targetUrl:/);
  });

  it('truncates a very long targetUrl to HISTORY_TARGET_URL_MAX chars', async () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(100);
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: makeHistoryResp([makeHistoryItem({ targetUrl: longUrl, targetUrlSource: 'run' })]),
        };
      }
      return {
        status: 404,
        body: {
          error: {
            code: 'NOT_FOUND',
            message: 'nf',
            nextAction: 'retry',
            requestId: 'r',
            details: {},
          },
        },
      };
    });

    await runResultHistory(
      {
        output: 'text',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const output = lines.join('\n');
    // Should contain truncation marker
    expect(output).toMatch(/targetUrl:.*…/);
    // The full URL should not appear verbatim
    expect(output).not.toContain(longUrl);
  });

  it('G1b: targetUrl passes through in --output json (RunHistoryItem fields)', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_abc/runs')) {
        return {
          body: makeHistoryResp([
            makeHistoryItem({
              targetUrl: 'https://example.com',
              targetUrlSource: 'run',
            }),
          ]),
        };
      }
      return {
        status: 404,
        body: {
          error: {
            code: 'NOT_FOUND',
            message: 'nf',
            nextAction: 'retry',
            requestId: 'r',
            details: {},
          },
        },
      };
    });

    await runResultHistory(
      {
        output: 'json',
        testId: 'test_abc',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );

    const parsed = JSON.parse(lines.join('')) as { runs: RunHistoryItem[] };
    const firstRun = parsed.runs[0];
    expect(firstRun).toBeDefined();
    expect(firstRun?.targetUrl).toBe('https://example.com');
    expect(firstRun?.targetUrlSource).toBe('run');
  });
});

// ---------------------------------------------------------------------------
// --rerun / --no-rerun parsing through Commander (the tri-state hop)
// ---------------------------------------------------------------------------

describe('createTestCommand — --rerun / --no-rerun parsing', () => {
  // The runResultHistory tests above call the function directly, so they never
  // exercise Commander's --rerun/--no-rerun parsing. This pins the tri-state:
  // undefined (no filter) | true | false. A silent default to true would filter
  // every `test result --history` to reruns only, unnoticed.
  async function parsedRerun(extraArgs: string[]): Promise<boolean | undefined> {
    const { credentialsPath } = makeCreds();
    // Benign history response so parseAsync's action completes without a real
    // network call — the assertion reads the parsed opts, not the output.
    const fetchImpl = makeFetch(() => ({ body: makeHistoryResp([]) }));
    const test = createTestCommand({
      credentialsPath,
      fetchImpl,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    await test.parseAsync(['result', 'test_abc', '--history', ...extraArgs], { from: 'user' });
    const resultCmd = test.commands.find(c => c.name() === 'result');
    return (resultCmd?.opts() as { rerun?: boolean }).rerun;
  }

  it('no flag → rerun is undefined (no filter)', async () => {
    expect(await parsedRerun([])).toBeUndefined();
  });

  it('--rerun → rerun is true', async () => {
    expect(await parsedRerun(['--rerun'])).toBe(true);
  });

  it('--no-rerun → rerun is false', async () => {
    expect(await parsedRerun(['--no-rerun'])).toBe(false);
  });
});

describe('empty latest steps history hint', () => {
  it.each([0, 5_000])(
    'does not retry a history 429 or leave live timers after %i ms',
    async elapsedMs => {
      vi.useFakeTimers();
      try {
        let historyCalls = 0;
        let settled = false;
        const stdout: string[] = [];
        const stderr: string[] = [];
        const pending = runSteps(
          { profile: 'default', output: 'json', debug: false, testId: 'test_abc' },
          {
            ...makeCreds(),
            stdout: line => stdout.push(line),
            stderr: line => stderr.push(line),
            fetchImpl: async input => {
              if (String(input).includes('/steps'))
                return new Response(JSON.stringify({ items: [], nextToken: null }));
              historyCalls++;
              return new Response(
                JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Try later' } }),
                { status: 429, headers: { 'retry-after': '60' } },
              );
            },
          },
        ).then(page => {
          settled = true;
          return page;
        });
        await vi.advanceTimersByTimeAsync(elapsedMs);
        expect(settled).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        expect(historyCalls).toBe(1);
        expect(await pending).toEqual({ items: [], nextToken: null });
        expect(stdout).toEqual([JSON.stringify({ items: [], nextToken: null }, null, 2)]);
        expect(stderr).toEqual([]);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each(['text', 'json'] as const)(
    'points at the nearest earlier terminal run in %s mode',
    async output => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const historyUrls: string[] = [];
      const page = await runSteps(
        { profile: 'default', output, debug: false, testId: 'test_abc' },
        {
          ...makeCreds(),
          stdout: line => stdout.push(line),
          stderr: line => stderr.push(line),
          fetchImpl: makeFetch(url => {
            if (url.includes('/steps')) return { body: { items: [], nextToken: null } };
            historyUrls.push(url);
            return {
              body: makeHistoryResp(
                [
                  makeHistoryItem({ runId: 'run_latest', status: 'blocked' }),
                  makeHistoryItem({ runId: 'run_active', status: 'running' }),
                  makeHistoryItem({ runId: 'run_prior', status: 'passed' }),
                  makeHistoryItem({ runId: 'run_oldest', status: 'failed' }),
                ],
                'more-history',
              ),
            };
          }),
        },
      );
      expect(stderr).toContain(
        'Latest run has no steps; inspect an earlier run: testsprite test steps test_abc --run-id run_prior',
      );
      expect(historyUrls).toHaveLength(1);
      expect(new URL(historyUrls[0]!).searchParams.get('pageSize')).toBe('20');
      expect(page).toEqual({ items: [], nextToken: null });
      expect(stdout).toEqual([output === 'json' ? JSON.stringify(page, null, 2) : 'No steps.']);
    },
  );

  it.each([{ runs: [] }, { runs: [makeHistoryItem({ runId: 'run_latest', status: 'passed' })] }])(
    'gives a neutral history pointer when there is no earlier run (%j)',
    async ({ runs }) => {
      const stderr: string[] = [];
      await runSteps(
        { profile: 'default', output: 'text', debug: false, testId: 'test_abc' },
        {
          ...makeCreds(),
          stdout: () => {},
          stderr: line => stderr.push(line),
          fetchImpl: makeFetch(url => ({
            body: url.includes('/steps') ? { items: [], nextToken: null } : makeHistoryResp(runs),
          })),
        },
      );
      expect(stderr).toEqual([
        'Latest run has no steps; inspect run history: testsprite test result test_abc --history',
      ]);
    },
  );

  it('swallows a failed lookup and still prints No steps', async () => {
    const stdout: string[] = [];
    let lookups = 0;
    const result = await runSteps(
      { profile: 'default', output: 'text', debug: false, testId: 'test_abc' },
      {
        ...makeCreds(),
        stdout: line => stdout.push(line),
        stderr: () => {},
        fetchImpl: makeFetch(url => {
          if (url.includes('/steps')) return { body: { items: [], nextToken: null } };
          lookups++;
          throw new RequestTimeoutError(1000);
        }),
      },
    );
    expect(lookups).toBe(1);
    expect(result).toEqual({ items: [], nextToken: null });
    expect(stdout).toEqual(['No steps.']);
  });

  it('bounds a stalled history lookup to five seconds', async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      let settled = false;
      const stdout: string[] = [];
      const pending = runSteps(
        { profile: 'default', output: 'text', debug: false, testId: 'test_abc' },
        {
          ...makeCreds(),
          stdout: line => stdout.push(line),
          stderr: () => {},
          fetchImpl: async (input, init) => {
            if (String(input).includes('/steps'))
              return new Response(JSON.stringify({ items: [], nextToken: null }));
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  reject(init.signal?.reason);
                },
                { once: true },
              );
            });
          },
        },
      ).then(result => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(aborted).toBe(true);
      await pending;
      expect(stdout).toEqual(['No steps.']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('describes latest-run steps and the run-id selector in help', () => {
    const steps = createTestCommand().commands.find(command => command.name() === 'steps')!;
    const help = steps.helpInformation().replace(/\s+/g, ' ');
    expect(help).toContain('steps of the latest run (use --run-id for a specific run)');
    expect(help).not.toContain('cumulative');
  });
});

// ---------------------------------------------------------------------------
// Environment on the history surface
// ---------------------------------------------------------------------------

describe('runResultHistory — environment', () => {
  const common = { profile: 'default', dryRun: false, debug: false, verbose: false } as const;

  it('renders an ENV column: the environment name, or — when the row names none', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(url =>
      url.includes('/tests/test_abc/runs')
        ? {
            body: makeHistoryResp([
              makeHistoryItem({
                runId: 'run_env',
                environment: { id: 'env_demo', name: 'demo' },
                targetUrl: 'https://demo.example.com',
                targetUrlSource: null,
              }),
              makeHistoryItem({
                runId: 'run_local',
                environment: { id: 'env_local', name: 'local-dev' },
                targetUrl: 'http://127.0.0.1:55015',
                targetUrlSource: null,
              }),
              makeHistoryItem({ runId: 'run_old' }),
            ]),
          }
        : { status: 404, body: errorEnvelope('NOT_FOUND') },
    );
    await runResultHistory(
      { ...common, output: 'text', testId: 'test_abc' },
      { credentialsPath, fetchImpl, stdout: line => lines.push(line) },
    );
    const output = lines.join('\n');
    expect(output).toMatch(/RUN ID\s+STATUS\s+SOURCE\s+ENV\s+RERUN\?/);
    expect(output).toMatch(/run_env\s+passed\s+cli\s+demo\s+/);
    // A run on a developer-machine environment is just that environment's
    // name: the address it went to is the environment's own, so there is no
    // second kind of row and nothing about credentials to add below it.
    expect(output).toMatch(/run_local\s+passed\s+cli\s+local-dev\s+/);
    expect(output).toMatch(/run_old\s+passed\s+cli\s+—\s+/);
    expect(output).toContain('targetUrl: http://127.0.0.1:55015\n');
    expect(output).toContain('targetUrl: https://demo.example.com\n');
  });

  it('--env forwards ?environment=<name> to the server', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: makeHistoryResp([]) };
    });
    await runResultHistory(
      { ...common, output: 'json', testId: 'test_abc', environment: 'local-dev' },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    );
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]!).searchParams.get('environment')).toBe('local-dev');
  });

  it('a whitespace-only --env is refused locally', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    await expect(
      runResultHistory(
        { ...common, output: 'json', testId: 'test_abc', environment: ' ' },
        {
          credentialsPath,
          fetchImpl: makeFetch(url => {
            seen.push(url);
            return { body: makeHistoryResp([]) };
          }),
          stdout: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(seen).toEqual([]);
  });

  it('`test result <id> --env x` without --history is a validation error (exit 5)', async () => {
    const test = createTestCommand();
    const disable = (c: { exitOverride: () => unknown; commands: Array<unknown> }) => {
      c.exitOverride();
      (c.commands as Array<{ exitOverride: () => unknown; commands: Array<unknown> }>).forEach(
        disable,
      );
    };
    disable(test as never);
    await expect(
      test.parseAsync(['result', 'test_abc', '--env', 'demo'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('history unknown env shows available names', async () => {
    const { credentialsPath } = makeCreds();
    const calls: string[] = [];
    const fetchImpl = makeFetch(url => {
      calls.push(url);
      return {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_ERROR',
            message: "Unknown environment 'bogus'.",
            nextAction: 'Unknown environment. Available environments: default, staging.',
            requestId: 'req_env',
            details: {
              field: 'environment',
              requested: 'bogus',
              available: ['default', 'staging'],
              accepted: ['default', 'staging'],
            },
          },
        },
      };
    });
    let thrown: unknown;
    try {
      await runResultHistory(
        { ...common, output: 'json', testId: 'test_abc', environment: 'bogus' },
        { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
      );
    } catch (e) {
      thrown = e;
    }
    expect(calls).toHaveLength(1);
    const err = thrown as ApiError;
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.exitCode).toBe(5);
    expect(err.nextAction).toContain('default');
    expect(err.nextAction).toContain('staging');
    expect(err.getDetail('available')).toEqual(['default', 'staging']);
  });

  it('history known env with no runs is empty', async () => {
    const { credentialsPath } = makeCreds();
    const lines: string[] = [];
    const fetchImpl = makeFetch(() => ({
      body: makeHistoryResp([], null, { testKind: 'frontend' }),
    }));
    const resp = await runResultHistory(
      { ...common, output: 'text', testId: 'test_abc', environment: 'production' },
      { credentialsPath, fetchImpl, stdout: l => lines.push(l), stderr: () => {} },
    );
    expect(resp.runs).toEqual([]);
    expect(lines.join('\n')).toContain('No CLI-tracked history');
  });

  it('v2 environment filter shows the unsupported next action', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 501,
      body: {
        error: {
          code: 'UNSUPPORTED',
          message: 'Environment filtering requires a V3 project.',
          nextAction: 'Use a V3 project to filter run history by environment.',
          requestId: 'req_v2',
          details: {},
        },
      },
    }));
    let thrown: unknown;
    try {
      await runResultHistory(
        { ...common, output: 'json', testId: 'test_abc', environment: 'production' },
        { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
      );
    } catch (e) {
      thrown = e;
    }
    const err = thrown as ApiError;
    expect(err.code).toBe('UNSUPPORTED');
    expect(err.exitCode).toBe(7);
    expect(err.nextAction).toBe('Use a V3 project to filter run history by environment.');
  });
});

describe('`test run list` — usage guard (not a positional test id)', () => {
  function commandWithExitOverride(
    fetchImpl: typeof globalThis.fetch,
  ): ReturnType<typeof createTestCommand> {
    const { credentialsPath } = makeCreds();
    const test = createTestCommand({ credentialsPath, fetchImpl });
    const disable = (c: { exitOverride: () => unknown; commands: Array<unknown> }) => {
      c.exitOverride();
      (c.commands as Array<{ exitOverride: () => unknown; commands: Array<unknown> }>).forEach(
        disable,
      );
    };
    disable(test as never);
    return test;
  }

  it('test run list points to test result --history', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not hit network — the guard must fire before any request');
    });
    const test = commandWithExitOverride(fetchImpl as unknown as typeof fetch);
    let thrown: unknown;
    try {
      await test.parseAsync(['run', 'list'], { from: 'user' });
    } catch (e) {
      thrown = e;
    }
    const err = thrown as ApiError;
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.exitCode).toBe(5);
    expect(err.nextAction).toContain('test result <test-id> --history');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('runResult — environment context', () => {
  const common = {
    profile: 'default',
    output: 'text' as const,
    dryRun: false,
    debug: false,
    verbose: false,
    testId: 'test_abc',
  };
  const projection = {
    projectId: 'project_abc',
    headlineEnvironment: { id: 'env_prod', name: 'sk-prod' },
    status: 'passed',
    statusByEnvironment: [
      { environmentId: 'env_alt', environmentName: 'alt', status: 'failed' },
      { environmentId: 'env_prod', environmentName: 'sk-prod', status: 'passed' },
    ],
  };

  async function show(
    environment: CliLatestResult['environment'],
    test: unknown,
    output: 'text' | 'json' = 'text',
    project: unknown = {
      environments: [
        { id: 'env_alt', name: 'alt', isDefault: false },
        { id: 'env_prod', name: 'sk-prod', isDefault: true },
      ],
    },
    status: CliLatestResult['status'] = 'passed',
  ) {
    const calls: string[] = [];
    const lines: string[] = [];
    const stderr: string[] = [];
    const result = {
      ...CANNED_LATEST_RESULT,
      environment,
      status,
      ...(status === 'cancelled' ? { verdict: null, executionStatus: 'cancelled' as const } : {}),
    };
    const returned = await runResult(
      { ...common, output },
      {
        ...makeCreds(),
        fetchImpl: makeFetch(url => {
          calls.push(url);
          if (url.endsWith('/result')) return { body: result };
          if (url.includes('/projects/'))
            return project === 'unavailable'
              ? { status: 500, body: errorEnvelope('INTERNAL') }
              : { body: project };
          if (test === 'unavailable') return { status: 500, body: errorEnvelope('INTERNAL') };
          return { body: test };
        }),
        stdout: line => lines.push(line),
        stderr: line => stderr.push(line),
      },
    );
    return { calls, lines, stderr, result, returned };
  }

  it('names the shown default environment without an extra status line', async () => {
    const f = await show({ id: 'env_prod', name: 'sk-prod' }, projection);
    expect(f.lines.join('\n')).toMatch(/environment:\s+sk-prod/);
    expect(f.lines.join('\n')).not.toContain('Default environment');
  });

  it('appends exactly one default status after a result from another environment', async () => {
    const f = await show({ id: 'env_alt', name: 'alt' }, projection);
    expect(f.lines.join('\n')).toMatch(/environment:\s+alt/);
    expect(
      f.lines
        .join('\n')
        .split('\n')
        .filter(line => line.startsWith('Default environment')),
    ).toEqual([
      "Default environment sk-prod: passed (testsprite test result test_abc --history --env 'sk-prod')",
    ]);
    expect(f.lines.join('\n')).toMatch(/summary:[\s\S]*Default environment/);
    expect(f.calls).toHaveLength(3);
  });

  it('omits the advisory on an old server with no per-environment statuses', async () => {
    const f = await show(
      { id: 'env_alt', name: 'alt' },
      { headlineEnvironment: projection.headlineEnvironment, status: 'passed' },
    );
    expect(f.returned).toEqual(f.result);
    expect(f.lines.join('\n')).not.toContain('Default environment');
    expect(f.calls).toHaveLength(2);
    expect(f.stderr).toEqual([]);
  });

  it('silently ignores a failed extra read without retrying or failing the result', async () => {
    const f = await show({ id: 'env_alt', name: 'alt' }, 'unavailable');
    expect(f.returned).toEqual(f.result);
    expect(f.lines.join('\n')).not.toContain('Default environment');
    expect(f.calls).toHaveLength(2);
    expect(f.stderr).toEqual([]);
  });

  it('does not guess the default when its status partition is absent', async () => {
    const f = await show(
      { id: 'env_alt', name: 'alt' },
      { ...projection, statusByEnvironment: projection.statusByEnvironment.slice(0, 1) },
    );
    expect(f.lines.join('\n')).not.toContain('Default environment');
  });

  it.each(['passed', 'cancelled'] as const)(
    'does not label a fallback headline as default for a latest %s run',
    async status => {
      const f = await show(
        { id: 'env_alt', name: 'alt' },
        {
          ...projection,
          headlineEnvironment: { id: 'env_other', name: 'other' },
          statusByEnvironment: [
            { environmentId: 'env_other', environmentName: 'other', status: 'passed' },
            { environmentId: 'env_alt', environmentName: 'alt', status: 'passed' },
          ],
        },
        'text',
        { environments: [{ id: 'env_prod', name: 'sk-prod', isDefault: true }] },
        status,
      );
      expect(f.lines.join('\n')).not.toContain('Default environment');
      expect(f.calls).toHaveLength(3);
    },
  );

  it.each(['unavailable', {}, { environments: [{ id: 'env_prod', name: 'sk-prod' }] }])(
    'omits context when the project default is unavailable: %s',
    async project => {
      const f = await show({ id: 'env_alt', name: 'alt' }, projection, 'text', project);
      expect(f.returned).toEqual(f.result);
      expect(f.lines.join('\n')).not.toContain('Default environment');
      expect(f.calls).toHaveLength(3);
      expect(f.stderr).toEqual([]);
    },
  );

  it.each([true, false])(
    'ignores a deleted environment with the same name as the default, default has run=%s',
    async hasDefaultRun => {
      const f = await show(
        { id: 'env_alt', name: 'alt' },
        {
          ...projection,
          statusByEnvironment: [
            { environmentId: 'env_deleted', environmentName: 'sk-prod', status: 'failed' },
            ...(hasDefaultRun ? [projection.statusByEnvironment[1]] : []),
            projection.statusByEnvironment[0],
          ],
        },
      );
      expect(f.lines.join('\n')).not.toContain('Default environment sk-prod: failed');
      if (hasDefaultRun)
        expect(f.lines.join('\n')).toContain('Default environment sk-prod: passed');
      else expect(f.lines.join('\n')).not.toContain('Default environment');
    },
  );

  it('keeps JSON byte-identical and performs no extra read', async () => {
    const f = await show({ id: 'env_alt', name: 'alt' }, projection, 'json');
    expect(f.lines).toEqual([JSON.stringify(f.result, null, 2)]);
    expect(f.calls).toHaveLength(1);
    expect(f.stderr).toEqual([]);
  });

  it('makes no extra read when an older result has no environment', async () => {
    const f = await show(undefined, projection);
    expect(f.calls).toHaveLength(1);
    expect(f.lines.join('\n')).not.toContain('Default environment');
  });

  it('shows the scheduled local environment reason carried by a blocked summary', async () => {
    const reason =
      'Environment local is on this machine (http://localhost:4900); scheduled runs execute in the cloud and cannot reach it. Run it from this machine with testsprite test run test_abc --env local.';
    const result: CliLatestResult = {
      ...CANNED_LATEST_RESULT,
      status: 'blocked',
      verdict: 'blocked',
      failureKind: 'infra',
      summary: `Blocked before a verdict could be produced: ${reason}`,
    };
    for (const output of ['text', 'json'] as const) {
      const lines: string[] = [];
      await runResult(
        { ...common, output },
        {
          ...makeCreds(),
          fetchImpl: makeFetch(() => ({ body: result })),
          stdout: line => lines.push(line),
          stderr: () => {},
        },
      );
      if (output === 'json') expect(lines).toEqual([JSON.stringify(result, null, 2)]);
      else {
        expect(lines.join('\n')).toContain(reason);
        expect(lines.join('\n')).toMatch(/failureKind:\s+infra/);
      }
    }
  });
});

it.each([
  ['SIGINT', 130, 2],
  ['SIGTERM', 143, 2],
  ['SIGINT', 130, 3],
  ['SIGTERM', 143, 3],
] as const)(
  'preserves interrupts during optional result context read: %s (exit %s, request %s)',
  async (signal, exitCode, interruptRequest) => {
    const shutdown = new ShutdownController();
    let calls = 0;
    const lines: string[] = [];
    await expect(
      runResult(
        { output: 'text', testId: 'test_abc', profile: 'default', debug: false },
        {
          ...makeCreds(),
          shutdown,
          fetchImpl: makeFetch(() => {
            calls++;
            if (calls === 1)
              return {
                body: { ...CANNED_LATEST_RESULT, environment: { id: 'env_alt', name: 'alt' } },
              };
            if (calls < interruptRequest)
              return {
                body: {
                  projectId: 'project_abc',
                  headlineEnvironment: { id: 'env_prod', name: 'sk-prod' },
                  statusByEnvironment: [
                    { environmentId: 'env_prod', environmentName: 'sk-prod', status: 'passed' },
                  ],
                },
              };
            shutdown.interrupt(signal);
            throw shutdown.signal.reason;
          }),
          stdout: line => lines.push(line),
          stderr: () => {},
        },
      ),
    ).rejects.toMatchObject({ signal, exitCode });
    expect(shutdown.signal.reason).toBeInstanceOf(InterruptError);
    // The already-fetched result is printed before the optional reads start.
    expect(lines.join('\n')).toContain('alt');
    expect(lines.join('\n')).not.toContain('Default environment');
  },
);
