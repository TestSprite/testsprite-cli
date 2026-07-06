/**
 * Unit tests for `test wait <run-id>` — M3.3 piece-3.
 *
 * Behavior matrix is identical to `--wait` path of `test run` except
 * there is no trigger step.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRY_RUN_BANNER, resetDryRunBannerForTesting } from '../lib/client-factory.js';
import { ApiError, RequestTimeoutError } from '../lib/errors.js';
import type { RunResponse } from '../lib/runs.types.js';
import { runTestWait } from './test.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'cli-m33-wait-'));
  const credentialsPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(credentialsPath, `[default]\napi_url = ${apiUrl}\napi_key = ${apiKey}\n`, {
    mode: 0o600,
  });
  return { credentialsPath };
}

function makeRun(status: RunResponse['status']): RunResponse {
  return {
    runId: 'run_abc',
    testId: 'test_xyz',
    projectId: 'project_1',
    userId: 'user_1',
    status,
    source: 'cli',
    createdAt: '2026-05-15T10:00:00.000Z',
    startedAt: status !== 'queued' ? '2026-05-15T10:00:01.000Z' : null,
    finishedAt: status !== 'queued' && status !== 'running' ? '2026-05-15T10:00:30.000Z' : null,
    codeVersion: 'v1',
    targetUrl: 'https://example.com',
    createdFrom: 'cli',
    failedStepIndex: null,
    failureKind: null,
    error: null,
    videoUrl: null,
    stepSummary: { total: 5, completed: 5, passedCount: 5, failedCount: 0 },
  };
}

function errorBody(code: string, details: Record<string, unknown> = {}) {
  const statusMap: Record<string, number> = {
    AUTH_REQUIRED: 401,
    AUTH_FORBIDDEN: 403,
    NOT_FOUND: 404,
    VALIDATION_ERROR: 400,
    CONFLICT: 409,
    RATE_LIMITED: 429,
    INTERNAL: 500,
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

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('runTestWait — happy paths', () => {
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

  it('returns passed RunResponse, exit 0 (no throw)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: makeRun('passed') }));
    const stdout: string[] = [];
    const result = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: line => stdout.push(line), sleep: instantSleep },
    );
    expect(result.status).toBe('passed');
    expect(result.runId).toBe('run_abc');
    const printed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(printed.status).toBe('passed');
  });

  it('polls multiple times before reaching terminal', async () => {
    const { credentialsPath } = makeCreds();
    let getCount = 0;
    const fetchImpl = makeFetch(() => {
      getCount++;
      if (getCount < 3) return { body: makeRun('running') };
      return { body: makeRun('passed') };
    });
    const result = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: () => {}, sleep: instantSleep },
    );
    expect(result.status).toBe('passed');
    expect(getCount).toBe(3);
  });

  it('sends GET to /runs/{runId}', async () => {
    const { credentialsPath } = makeCreds();
    const seenUrls: string[] = [];
    const fetchImpl = makeFetch(url => {
      seenUrls.push(url);
      return { body: makeRun('passed') };
    });
    await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: () => {}, sleep: instantSleep },
    );
    expect(seenUrls.some(u => u.includes('/runs/run_abc'))).toBe(true);
  });

  it('uses long-poll (waitSeconds param)', async () => {
    const { credentialsPath } = makeCreds();
    const seenUrls: string[] = [];
    const fetchImpl = makeFetch(url => {
      seenUrls.push(url);
      return { body: makeRun('passed') };
    });
    await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: () => {}, sleep: instantSleep },
    );
    expect(seenUrls.some(u => u.includes('waitSeconds'))).toBe(true);
  });

  it('--output json prints JSON RunResponse on stdout', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: makeRun('passed') }));
    const stdout: string[] = [];
    await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: line => stdout.push(line), sleep: instantSleep },
    );
    const parsed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(parsed.runId).toBe('run_abc');
    expect(parsed.status).toBe('passed');
  });
});

// ---------------------------------------------------------------------------
// Non-passed terminal states
// ---------------------------------------------------------------------------

describe('runTestWait — non-passed terminal states', () => {
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

  it('failed status → CLIError exit 1', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: makeRun('failed') }));
    const err = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: () => {},
        sleep: instantSleep,
      },
    ).catch(e => e);
    expect(err.exitCode).toBe(1);
    expect(err.name).toBe('CLIError');
  });

  it('blocked status → CLIError exit 1', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: makeRun('blocked') }));
    const err = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: () => {},
        sleep: instantSleep,
      },
    ).catch(e => e);
    expect(err.exitCode).toBe(1);
  });

  it('cancelled status → CLIError exit 1', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: makeRun('cancelled') }));
    const err = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: () => {},
        sleep: instantSleep,
      },
    ).catch(e => e);
    expect(err.exitCode).toBe(1);
  });

  it('non-passed prints artifact hint to stderr', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: makeRun('failed') }));
    const stderrLines: string[] = [];
    await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    ).catch(() => {});
    expect(stderrLines.some(l => l.includes('artifact'))).toBe(true);
    expect(stderrLines.some(l => l.includes('run_abc'))).toBe(true);
  });

  // B3 — cancelled must NOT emit the artifact hint (no artifacts were captured)
  it('B3 — cancelled status → CLIError exit 1 with NO artifact hint', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: makeRun('cancelled') }));
    const stderrLines: string[] = [];
    const err = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    ).catch(e => e);
    // Exit 1, but no artifact hint — cancelled runs have no failure bundle
    expect(err.exitCode).toBe(1);
    expect(stderrLines.some(l => l.includes('artifact'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error scenarios
// ---------------------------------------------------------------------------

describe('runTestWait — error scenarios', () => {
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

  it('404 NOT_FOUND → ApiError exit 4 (cross-tenant runId)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => errorBody('NOT_FOUND', { reason: 'not_found' }));
    const err = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: () => {}, sleep: instantSleep },
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('NOT_FOUND');
    expect((err as ApiError).exitCode).toBe(4);
  });

  it('timeout → UNSUPPORTED error exit 7 with nextAction containing run-id', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: makeRun('running') }));

    let callCount = 0;
    const base = Date.now();
    const realDateNow = Date.now;
    Date.now = () => (callCount++ > 4 ? base + 2000 : base);

    try {
      const err = await runTestWait(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: false,
          runId: 'run_abc',
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
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('UNSUPPORTED');
      expect((err as ApiError).exitCode).toBe(7);
      expect((err as ApiError).nextAction).toContain('run_abc');
    } finally {
      Date.now = realDateNow;
    }
  });

  it('403 AUTH_FORBIDDEN → ApiError exit 3', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => errorBody('AUTH_FORBIDDEN'));
    const err = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: () => {}, sleep: instantSleep },
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).exitCode).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Dry-run
// ---------------------------------------------------------------------------

describe('runTestWait — dry-run', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetDryRunBannerForTesting();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('dry-run: no network call; prints envelope with method=GET and run-id in path', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not hit network');
    });
    const stdout: string[] = [];
    await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        stdout: line => stdout.push(line),
        sleep: instantSleep,
      },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    const envelope = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(envelope.method).toBe('GET');
    expect(envelope.path as string).toContain('run_abc');
    expect(envelope.path as string).toContain('waitSeconds=25');
  });

  it('dry-run: timeoutSeconds in envelope', async () => {
    const { credentialsPath } = makeCreds();
    const stdout: string[] = [];
    await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        runId: 'run_abc',
        timeoutSeconds: 300,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(() => ({ body: {} })),
        stdout: line => stdout.push(line),
        sleep: instantSleep,
      },
    );
    const envelope = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(envelope.timeoutSeconds).toBe(300);
  });

  it('dry-run: exit 0 (no throw)', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runTestWait(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: true,
          runId: 'run_abc',
          timeoutSeconds: 60,
        },
        {
          credentialsPath,
          fetchImpl: makeFetch(() => ({ body: {} })),
          stdout: () => {},
          sleep: instantSleep,
        },
      ),
    ).resolves.toBeDefined();
  });

  // defect-2 fix: dry-run getRun sample must return status: "passed".
  // Prior to fix, a duplicate failed-shape getRun entry appeared before
  // the passed-shape entry in samples.ts; findSample's first-match-wins
  // always returned status: "failed" for `test wait --dry-run`.
  //
  // In dry-run mode, runTestWait emits a describe-only envelope
  // { method, path, timeoutSeconds } and exits 0. The canned sample is
  // not actually fetched — the important invariant is that the command
  // completes without throwing (exit 0) even though no real run is
  // resolved. The getRun sample correctness is asserted separately in
  // samples.test.ts ("GET /runs/{runId} resolves to the passed-shape…").
  it('dry-run: command exits 0 and envelope contains GET path for run-id', async () => {
    const { credentialsPath } = makeCreds();
    const stdout: string[] = [];
    const result = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        runId: 'run_xyz',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(() => ({ body: {} })),
        stdout: line => stdout.push(line),
        sleep: instantSleep,
      },
    );
    // runTestWait in dry-run mode returns the describe envelope — not a real RunResponse
    const envelope = result as unknown as Record<string, unknown>;
    expect(envelope.method).toBe('GET');
    expect(envelope.path as string).toContain('run_xyz');
    // The command must not throw (exit 0 — verifies defect-2 regression:
    // prior to fix, a duplicate failed getRun sample caused `test wait --dry-run`
    // to emit the wrong happy-path response)
    expect(stdout.length).toBeGreaterThan(0);
    const printed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(printed.method).toBe('GET');
  });

  // L1782 banner fix: test wait --dry-run must write the [dry-run] banner
  // to stderr (like test run --dry-run and test artifact get --dry-run do),
  // while the canned envelope stays on stdout only.
  it('dry-run: emits [dry-run] banner to stderr and canned envelope to stdout, exit 0', async () => {
    const { credentialsPath } = makeCreds();
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const result = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        runId: 'run_banner',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(() => ({ body: {} })),
        stdout: line => stdoutLines.push(line),
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    // Banner must appear on stderr
    expect(stderrLines).toContain(DRY_RUN_BANNER);
    // Envelope must appear on stdout and be parseable
    const envelope = JSON.parse(stdoutLines.join('')) as Record<string, unknown>;
    expect(envelope.method).toBe('GET');
    expect(envelope.path as string).toContain('run_banner');
    // Return value must be defined (exit 0 — no throw)
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Backoff fallback path (VALIDATION_ERROR on waitSeconds)
// ---------------------------------------------------------------------------

describe('runTestWait — backoff fallback', () => {
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

  it('400 VALIDATION_ERROR on waitSeconds → switches to backoff path and eventually succeeds', async () => {
    const { credentialsPath } = makeCreds();
    let callCount = 0;
    const fetchImpl = makeFetch(url => {
      callCount++;
      // First call with waitSeconds → returns VALIDATION_ERROR
      if (callCount === 1 && url.includes('waitSeconds')) {
        return errorBody('VALIDATION_ERROR');
      }
      return { body: makeRun('passed') };
    });
    const result = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
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
    expect(result.status).toBe('passed');
  });
});

// ---------------------------------------------------------------------------
// Backend testId fallback (dogfood L1888)
//
// Backend run-surface rows never finalize server-side, so the run-row poll
// would always hit --timeout (exit 7) even on a passing BE test. `test wait`
// falls back to the testId-scoped verdict (GET /tests/{id}/result) once it is
// terminal for this run.
// ---------------------------------------------------------------------------

interface BeResult {
  testId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  videoUrl: string | null;
  failureAnalysisUrl: string | null;
  snapshotId: string;
  runIdIfAvailable: string | null;
  codeVersion: string | null;
  targetUrl: string | null;
  failedStepIndex: number | null;
  failureKind: string | null;
  summary: { passed: number; failed: number; skipped: number };
}

function makeBeResult(overrides: Partial<BeResult> = {}): BeResult {
  return {
    testId: 'test_xyz',
    status: 'passed',
    startedAt: '2026-05-15T10:00:01.000Z',
    finishedAt: '2026-05-15T10:00:30.000Z',
    videoUrl: null,
    failureAnalysisUrl: null,
    snapshotId: 'snap_1',
    runIdIfAvailable: 'run_abc',
    codeVersion: 'v1',
    targetUrl: 'https://example.com',
    failedStepIndex: null,
    failureKind: null,
    summary: { passed: 1, failed: 0, skipped: 0 },
    ...overrides,
  };
}

function beWaitRouter(args: {
  type?: string;
  runStatus?: RunResponse['status'] | (() => RunResponse['status']);
  result: () => BeResult;
}) {
  const counts = { type: 0, result: 0, run: 0 };
  const handler = (url: string) => {
    if (url.includes('/tests/test_xyz/result')) {
      counts.result += 1;
      return { body: args.result() };
    }
    if (url.includes('/tests/test_xyz')) {
      counts.type += 1;
      return {
        body: {
          id: 'test_xyz',
          projectId: 'p1',
          name: 'BE test',
          type: args.type ?? 'backend',
          createdFrom: 'mcp',
          status: 'running',
          createdAt: '2026-05-15T10:00:00.000Z',
          updatedAt: '2026-05-15T10:00:00.000Z',
        },
      };
    }
    counts.run += 1;
    const rs =
      typeof args.runStatus === 'function' ? args.runStatus() : (args.runStatus ?? 'running');
    return { body: makeRun(rs) };
  };
  return { handler, counts };
}

describe('runTestWait — backend testId fallback (L1888)', () => {
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

  it('passing backend test resolves via testId result (exit 0) + emits advisory', async () => {
    const { credentialsPath } = makeCreds();
    const router = beWaitRouter({ result: () => makeBeResult({ status: 'passed' }) });
    const stderr: string[] = [];
    const result = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(router.handler),
        stdout: () => {},
        stderr: l => stderr.push(l),
        sleep: instantSleep,
      },
    );
    expect(result.status).toBe('passed');
    expect(result.testId).toBe('test_xyz');
    expect(router.counts.type).toBeGreaterThan(0);
    expect(router.counts.result).toBeGreaterThan(0);
    expect(stderr.join(' ')).toContain('test record');
  });

  it('failing backend test resolves via fallback (CLIError exit 1) + testId artifact hint', async () => {
    const { credentialsPath } = makeCreds();
    const router = beWaitRouter({
      result: () =>
        makeBeResult({
          status: 'failed',
          failureKind: 'assertion',
          failedStepIndex: 1,
          summary: { passed: 0, failed: 1, skipped: 0 },
        }),
    });
    const stderr: string[] = [];
    const err = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(router.handler),
        stdout: () => {},
        stderr: l => stderr.push(l),
        sleep: instantSleep,
      },
    ).catch(e => e);
    expect(err.exitCode).toBe(1);
    expect(err.name).toBe('CLIError');
    expect(stderr.join(' ')).toContain('test failure get test_xyz');
  });

  it('frontend test is untouched — terminal run row resolves with zero testId lookups', async () => {
    const { credentialsPath } = makeCreds();
    const router = beWaitRouter({
      type: 'frontend',
      runStatus: 'passed',
      result: () => makeBeResult(),
    });
    const result = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(router.handler),
        stdout: () => {},
        stderr: () => {},
        sleep: instantSleep,
      },
    );
    expect(result.status).toBe('passed');
    expect(router.counts.type).toBe(0);
    expect(router.counts.result).toBe(0);
  });

  it('frontend test with a non-terminal tick resolves via the run row, never the result endpoint', async () => {
    const { credentialsPath } = makeCreds();
    let runCall = 0;
    const router = beWaitRouter({
      type: 'frontend',
      runStatus: () => (++runCall >= 2 ? 'passed' : 'running'),
      result: () => makeBeResult(),
    });
    const result = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(router.handler),
        stdout: () => {},
        stderr: () => {},
        sleep: instantSleep,
      },
    );
    expect(result.status).toBe('passed');
    // The fallback probed the type once (FE) but never read the result endpoint.
    expect(router.counts.type).toBe(1);
    expect(router.counts.result).toBe(0);
  });

  it('a transient type-probe error does not permanently disable the fallback (retries next tick)', async () => {
    const { credentialsPath } = makeCreds();
    let typeCalls = 0;
    const handler = (url: string) => {
      if (url.includes('/tests/test_xyz/result')) {
        return { body: makeBeResult({ status: 'passed' }) };
      }
      if (url.includes('/tests/test_xyz')) {
        typeCalls += 1;
        // First probe 500s (transient); second succeeds as backend.
        if (typeCalls === 1) return { status: 500, body: { error: { code: 'INTERNAL' } } };
        return {
          body: {
            id: 'test_xyz',
            projectId: 'p1',
            name: 'BE',
            type: 'backend',
            createdFrom: 'mcp',
            status: 'running',
            createdAt: '2026-05-15T10:00:00.000Z',
            updatedAt: '2026-05-15T10:00:00.000Z',
          },
        };
      }
      return { body: makeRun('running') };
    };
    const result = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(handler),
        stdout: () => {},
        stderr: () => {},
        sleep: instantSleep,
      },
    );
    // Despite the first probe failing, a later tick re-probed → backend → resolved.
    expect(result.status).toBe('passed');
    expect(typeCalls).toBeGreaterThanOrEqual(2);
  });

  it('rejects a stale prior-run verdict, then accepts the matching one', async () => {
    const { credentialsPath } = makeCreds();
    let call = 0;
    const router = beWaitRouter({
      result: () => {
        call += 1;
        // First result names a DIFFERENT run (stale) → must be rejected; the
        // next names this run → accepted.
        return call === 1
          ? makeBeResult({ status: 'passed', runIdIfAvailable: 'run_OLD' })
          : makeBeResult({ status: 'passed', runIdIfAvailable: 'run_abc' });
      },
    });
    const result = await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(router.handler),
        stdout: () => {},
        stderr: () => {},
        sleep: instantSleep,
      },
    );
    expect(result.status).toBe('passed');
    expect(router.counts.result).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — D4: RequestTimeoutError under test wait emits partial stdout + exit 7
// ---------------------------------------------------------------------------

describe('runTestWait: Fix 3 — RequestTimeoutError writes partial JSON to stdout', () => {
  it('exit 7 AND stdout contains {runId, status:"running"} when poll throws RequestTimeoutError', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl: typeof globalThis.fetch = async () => {
      throw new RequestTimeoutError(120000, 'req_timeout_wait_test');
    };

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    await expect(
      runTestWait(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: false,
          runId: 'run_abc',
          timeoutSeconds: 600,
        },
        {
          credentialsPath,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          stdout: line => stdoutLines.push(line),
          stderr: line => stderrLines.push(line),
          sleep: instantSleep,
        },
      ),
    ).rejects.toMatchObject({ exitCode: 7 });

    // Stdout must contain the partial object with runId + status:"running"
    const stdoutJson = JSON.parse(stdoutLines.join('\n')) as {
      runId: string;
      status: string;
    };
    expect(stdoutJson.runId).toBe('run_abc');
    expect(stdoutJson.status).toBe('running');

    // Stderr should mention the runId and suggest test wait
    const stderrBlock = stderrLines.join('\n');
    expect(stderrBlock).toContain('run_abc');
    expect(stderrBlock).toContain('test wait');
  });
});

// ---------------------------------------------------------------------------
// TimeoutError on test wait: partial stdout + exit 7
// ---------------------------------------------------------------------------

describe('runTestWait: TimeoutError writes partial JSON to stdout', () => {
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

  it('exit 7 AND stdout contains {runId, status:"running"} when --timeout polling deadline is exceeded', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: makeRun('running') }));

    let callCount = 0;
    const base = Date.now();
    const realDateNow = Date.now;
    Date.now = () => (callCount++ > 4 ? base + 2000 : base);

    try {
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      await expect(
        runTestWait(
          {
            profile: 'default',
            output: 'json',
            debug: false,
            dryRun: false,
            runId: 'run_abc',
            timeoutSeconds: 1,
          },
          {
            credentialsPath,
            fetchImpl,
            stdout: line => stdoutLines.push(line),
            stderr: line => stderrLines.push(line),
            sleep: instantSleep,
          },
        ),
      ).rejects.toMatchObject({ exitCode: 7 });

      const stdoutJson = JSON.parse(stdoutLines.join('\n')) as {
        runId: string;
        status: string;
      };
      expect(stdoutJson.runId).toBe('run_abc');
      expect(stdoutJson.status).toBe('running');
    } finally {
      Date.now = realDateNow;
    }
  });
});

// ---------------------------------------------------------------------------
// FIX 4 — D5-UX: text mode shows the `error` string for failed/blocked runs
// ---------------------------------------------------------------------------
describe('[fix-4-ux] runTestWait — text mode shows error string for failed/blocked runs', () => {
  it('failed run with error string renders "error <msg>" line in text mode', async () => {
    const { credentialsPath } = makeCreds();
    const run: RunResponse = {
      ...makeRun('failed'),
      failureKind: 'assertion',
      error: 'Element not found: .checkout-button',
    };
    const stdoutLines: string[] = [];

    const fetchImpl = makeFetch(() => ({ body: run }));

    await runTestWait(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdoutLines.push(line),
        stderr: () => {},
        sleep: instantSleep,
      },
    ).catch(() => {
      // exit 1 (failed run) — we only care about stdout
    });

    const stdoutBlock = stdoutLines.join('\n');
    // Must include the error line
    expect(stdoutBlock).toContain('error');
    expect(stdoutBlock).toContain('Element not found: .checkout-button');
  });

  it('failed run with multi-line error shows first line truncated to 200 chars', async () => {
    const { credentialsPath } = makeCreds();
    const longFirstLine = 'A'.repeat(250);
    const run: RunResponse = {
      ...makeRun('failed'),
      failureKind: 'assertion',
      error: `${longFirstLine}\nsecond line`,
    };
    const stdoutLines: string[] = [];

    const fetchImpl = makeFetch(() => ({ body: run }));

    await runTestWait(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdoutLines.push(line),
        stderr: () => {},
        sleep: instantSleep,
      },
    ).catch(() => {
      // exit 1
    });

    const stdoutBlock = stdoutLines.join('\n');
    // First line truncated to 200 chars + ellipsis
    expect(stdoutBlock).toContain('error');
    expect(stdoutBlock).toContain('A'.repeat(200));
    expect(stdoutBlock).toContain('…');
    // Second line should NOT appear
    expect(stdoutBlock).not.toContain('second line');
  });

  it('passed run with null error does NOT render error line', async () => {
    const { credentialsPath } = makeCreds();
    const run: RunResponse = { ...makeRun('passed'), error: null };
    const stdoutLines: string[] = [];

    const fetchImpl = makeFetch(() => ({ body: run }));

    await runTestWait(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdoutLines.push(line),
        stderr: () => {},
        sleep: instantSleep,
      },
    );

    const stdoutBlock = stdoutLines.join('\n');
    // Must NOT include an "error" line for a passing run
    expect(stdoutBlock).not.toMatch(/^error\s+/m);
  });

  it('JSON mode does NOT change: error field passes through wire envelope unchanged', async () => {
    const { credentialsPath } = makeCreds();
    const run: RunResponse = {
      ...makeRun('failed'),
      failureKind: 'assertion',
      error: 'Something went wrong',
    };
    const stdoutLines: string[] = [];

    const fetchImpl = makeFetch(() => ({ body: run }));

    await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdoutLines.push(line),
        stderr: () => {},
        sleep: instantSleep,
      },
    ).catch(() => {
      // exit 1
    });

    // JSON mode: parse stdout and verify error field is present
    const parsed = JSON.parse(stdoutLines.join('')) as RunResponse;
    expect(parsed.error).toBe('Something went wrong');
  });
});

// ---------------------------------------------------------------------------
// dashboardUrl on terminal output (colleague feedback 2026-06-10) — the
// GET /runs/{runId} wire row carries projectId+testId, so `test wait`
// closes with a Portal deep link on known API hosts.
// ---------------------------------------------------------------------------

describe('runTestWait — dashboardUrl on terminal output', () => {
  it('JSON mode (prod endpoint): terminal envelope includes dashboardUrl', async () => {
    const { credentialsPath } = makeCreds('sk-user-test', 'https://api.testsprite.com');
    const fetchImpl = makeFetch(() => ({ body: makeRun('passed') }));
    const stdout: string[] = [];
    await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: line => stdout.push(line), sleep: instantSleep },
    );
    const printed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(printed.dashboardUrl).toBe(
      'https://www.testsprite.com/dashboard/tests/project_1/test/test_xyz',
    );
  });

  it('text mode (TESTSPRITE_PORTAL_URL override): card ends with the overridden dashboard line', async () => {
    vi.stubEnv('TESTSPRITE_PORTAL_URL', 'https://portal.internal.example.com');
    try {
      const { credentialsPath } = makeCreds('sk-user-test', 'https://api.example.com:8443');
      const fetchImpl = makeFetch(() => ({ body: makeRun('passed') }));
      const stdout: string[] = [];
      await runTestWait(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          dryRun: false,
          runId: 'run_abc',
          timeoutSeconds: 60,
        },
        { credentialsPath, fetchImpl, stdout: line => stdout.push(line), sleep: instantSleep },
      );
      expect(stdout.join('\n')).toContain(
        'dashboard   https://portal.internal.example.com/dashboard/tests/project_1/test/test_xyz',
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('unknown API host (localhost): no dashboardUrl field', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: makeRun('passed') }));
    const stdout: string[] = [];
    await runTestWait(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        runId: 'run_abc',
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: line => stdout.push(line), sleep: instantSleep },
    );
    const printed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(printed.dashboardUrl).toBeUndefined();
  });
});
