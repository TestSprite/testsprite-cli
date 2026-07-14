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
import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/errors.js';
import type { ListRunsResponse, RunHistoryItem } from '../lib/runs.types.js';
import type { CliLatestResult } from './test.js';
import { runResultHistory, runResult, parseDuration } from './test.js';

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

  it('JSON mode does not include meta in output envelope', async () => {
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
    // The JSON output shape is { runs, nextCursor } — not the full wire envelope.
    expect('meta' in parsed).toBe(false);
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
