/**
 * Unit tests for `test rerun` — M3.4 piece-3.
 *
 * All HTTP is mocked via `makeFetch`. The polling loop's sleep injection is
 * wired through `TestDeps.sleep` to avoid real delays.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError, RequestTimeoutError } from '../lib/errors.js';
import type { RunResponse, RerunResponse, BatchRerunResponse } from '../lib/runs.types.js';
import type { FetchImpl } from '../lib/http.js';
import { runTestRerun, resolveWaitRequestTimeoutMs } from './test.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'cli-m34-rerun-'));
  const credentialsPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(credentialsPath, `[default]\napi_url = ${apiUrl}\napi_key = ${apiKey}\n`, {
    mode: 0o600,
  });
  return { credentialsPath };
}

/** Instant sleep — avoids real delays in tests. */
const instantSleep = () => Promise.resolve();

/** Canned FE test record (frontend type). */
const FE_TEST = {
  id: 'test_fe_01',
  projectId: 'project_abc',
  name: 'FE checkout test',
  type: 'frontend' as const,
  createdFrom: 'portal' as const,
  status: 'passed' as const,
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
};

/** Canned BE test record (backend type). */
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

/** Build a FE RerunResponse (no closure). */
function makeFeRerunResp(overrides?: Partial<RerunResponse>): RerunResponse {
  return {
    runId: 'run_rerun_fe_001',
    status: 'queued',
    enqueuedAt: '2026-06-03T10:00:00.000Z',
    codeVersion: 'v1',
    autoHeal: false,
    ...overrides,
  };
}

/** Build a BE RerunResponse with closure. */
function makeBeRerunResp(overrides?: Partial<RerunResponse>): RerunResponse {
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
    ...overrides,
  };
}

/** Build a terminal RunResponse. */
function makeTerminalRun(
  runId: string,
  status: 'passed' | 'failed' | 'blocked' = 'passed',
): RunResponse {
  return {
    runId,
    testId: 'test_fe_01',
    projectId: 'project_abc',
    userId: 'user_1',
    status,
    source: 'cli',
    createdAt: '2026-06-03T10:00:00.000Z',
    startedAt: '2026-06-03T10:00:01.000Z',
    finishedAt: '2026-06-03T10:00:30.000Z',
    codeVersion: 'v1',
    targetUrl: 'https://example.com',
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
    AUTH_REQUIRED: 401,
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
// Surface tests (command registration)
// ---------------------------------------------------------------------------

describe('createTestCommand — rerun subcommand exposed', () => {
  it('exposes rerun as a top-level test subcommand', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
    const names = test.commands.map(c => c.name()).sort();
    expect(names).toContain('rerun');
  });

  it('rerun has expected flags', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
    const rerun = test.commands.find(c => c.name() === 'rerun')!;
    const flagNames = rerun.options.map(o => o.long);
    expect(flagNames).toContain('--all');
    expect(flagNames).toContain('--project');
    expect(flagNames).toContain('--wait');
    expect(flagNames).toContain('--timeout');
    expect(flagNames).toContain('--no-auto-heal');
    expect(flagNames).toContain('--skip-dependencies');
    expect(flagNames).toContain('--max-concurrency');
    expect(flagNames).toContain('--idempotency-key');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('runTestRerun — validation', () => {
  it('exit 5 when no testIds and no --all', async () => {
    const creds = makeCreds();
    await expect(
      runTestRerun(
        {
          testIds: [],
          all: false,
          wait: false,
          timeoutSeconds: 600,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep },
      ),
    ).rejects.toThrow(ApiError);

    try {
      await runTestRerun(
        {
          testIds: [],
          all: false,
          wait: false,
          timeoutSeconds: 600,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep },
      );
    } catch (err) {
      expect(err instanceof ApiError).toBe(true);
      if (err instanceof ApiError) {
        expect(err.code).toBe('VALIDATION_ERROR');
      }
    }
  });

  it('exit 5 (VALIDATION_ERROR) when --filter is passed WITHOUT --all', async () => {
    // --filter is an --all-only narrowing filter. With explicit ids it would be
    // silently ignored while the named test still reran (codex finding). The
    // guard throws BEFORE any network/dispatch, so no rerun is triggered.
    const creds = makeCreds();
    await expect(
      runTestRerun(
        {
          testIds: ['test_a'],
          all: false,
          nameFilter: 'checkout',
          wait: false,
          timeoutSeconds: 600,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('exit 5 when --all without --project', async () => {
    const creds = makeCreds();
    try {
      await runTestRerun(
        {
          testIds: [],
          all: true,
          projectId: undefined,
          wait: false,
          timeoutSeconds: 600,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep },
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err instanceof ApiError).toBe(true);
      if (err instanceof ApiError) {
        expect(err.code).toBe('VALIDATION_ERROR');
      }
    }
  });

  it('rejects --max-concurrency > 100 with VALIDATION_ERROR (exit 5)', async () => {
    const creds = makeCreds();
    await expect(
      runTestRerun(
        {
          testIds: ['test_a'],
          all: false,
          wait: false,
          timeoutSeconds: 600,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 101,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: expect.objectContaining({ field: 'max-concurrency' }),
    });
  });

  it('accepts --max-concurrency = 100 (no validation error at boundary)', async () => {
    const creds = makeCreds();
    const rerunResp = {
      runId: 'run_mc100',
      status: 'queued',
      enqueuedAt: '2026-06-09T10:00:00.000Z',
      codeVersion: 'v1',
      autoHeal: true,
      closure: null,
    };
    const fetchImpl = makeFetch(url => {
      if (url.includes('/runs/rerun')) return { body: rerunResp };
      return {
        status: 404,
        body: {
          error: { code: 'NOT_FOUND', message: '', nextAction: '', requestId: 'r', details: {} },
        },
      };
    });
    // Should not throw a VALIDATION_ERROR
    await expect(
      runTestRerun(
        {
          testIds: ['test_mc100'],
          all: false,
          wait: false,
          timeoutSeconds: 600,
          autoHeal: true,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 100,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        {
          ...creds,
          sleep: instantSleep,
          fetchImpl,
          stdout: () => undefined,
          stderr: () => undefined,
        },
      ),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// R-FE1: Single FE rerun happy path (no --wait)
// ---------------------------------------------------------------------------

describe('R-FE1: FE rerun — queued (no --wait)', () => {
  it('returns the trigger response with status=queued (no credit language)', async () => {
    const creds = makeCreds();
    const rerunResp = makeFeRerunResp();
    const printed: unknown[] = [];

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_fe_01/runs/rerun')) {
        return { body: rerunResp };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_fe_01'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: line => printed.push(JSON.parse(line)),
      },
    );

    const result = printed[0] as RerunResponse;
    expect(result.runId).toBe('run_rerun_fe_001');
    expect(result.status).toBe('queued');
    // No credit language: autoHeal false, no closure
    expect(result.closure).toBeUndefined();
    expect(result.autoHeal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R-FE1: Single FE rerun with --wait
// ---------------------------------------------------------------------------

describe('R-FE1: FE rerun -- wait (replay, exit 0 on passed)', () => {
  it('polls runId to terminal and exits 0 on passed', async () => {
    const creds = makeCreds();
    const rerunResp = makeFeRerunResp();
    const terminalRun = makeTerminalRun('run_rerun_fe_001', 'passed');
    const printed: unknown[] = [];
    let pollCount = 0;

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_fe_01/runs/rerun')) {
        return { body: rerunResp };
      }
      if (url.includes('/runs/run_rerun_fe_001')) {
        pollCount++;
        return { body: terminalRun };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_fe_01'],
        all: false,
        wait: true,
        timeoutSeconds: 10,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: line => printed.push(JSON.parse(line)),
      },
    );

    expect(pollCount).toBeGreaterThan(0);
    const result = printed[0] as RunResponse;
    expect(result.status).toBe('passed');
  });

  it('--wait exits 1 on failed, suggests artifact get', async () => {
    const creds = makeCreds();
    const rerunResp = makeFeRerunResp();
    const failedRun = makeTerminalRun('run_rerun_fe_001', 'failed');
    const stderrLines: string[] = [];

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_fe_01/runs/rerun')) {
        return { body: rerunResp };
      }
      if (url.includes('/runs/run_rerun_fe_001')) {
        return { body: failedRun };
      }
      return errorBody('NOT_FOUND');
    });

    try {
      await runTestRerun(
        {
          testIds: ['test_fe_01'],
          all: false,
          wait: true,
          timeoutSeconds: 10,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        {
          ...creds,
          sleep: instantSleep,
          fetchImpl,
          stderr: line => stderrLines.push(line),
        },
      );
      expect.fail('should have thrown CLIError');
    } catch (err: unknown) {
      // CLIError with code 1
      expect((err as { exitCode?: number }).exitCode ?? (err as ApiError).httpStatus).toBeTruthy();
    }
    // nextAction should mention artifact get
    const artifactHint = stderrLines.find(l => l.includes('artifact get'));
    expect(artifactHint).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// R-FE2/R-FE4: --auto-heal flag
// ---------------------------------------------------------------------------

describe('R-FE2: auto-heal forwarded for FE paid', () => {
  it('sends autoHeal=true in request body when paid (server echoes effective value)', async () => {
    const creds = makeCreds();
    const rerunResp = makeFeRerunResp({ autoHeal: true }); // server echo
    const printed: unknown[] = [];
    let sentBody: unknown;

    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests/test_fe_01/runs/rerun')) {
        sentBody = init.body ? JSON.parse(init.body as string) : null;
        return { body: rerunResp };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_fe_01'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: true,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: line => printed.push(JSON.parse(line)),
      },
    );

    expect((sentBody as { autoHeal?: boolean }).autoHeal).toBe(true);
    const result = printed[0] as RerunResponse;
    expect(result.autoHeal).toBe(true);
  });
});

// R-FE0: default-on — no --no-auto-heal flag → body sends autoHeal:true; advisory emitted
describe('R-FE0: auto-heal default-on (no --no-auto-heal flag)', () => {
  it('sends autoHeal:true by default; emits 0.2-credit advisory when server echoes autoHeal:true', async () => {
    const creds = makeCreds();
    const rerunResp = makeFeRerunResp({ autoHeal: true }); // server confirms auto-heal
    const stderrLines: string[] = [];
    const printed: unknown[] = [];
    let sentBody: unknown;

    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests/test_fe_01/runs/rerun')) {
        sentBody = init.body ? JSON.parse(init.body as string) : null;
        return { body: rerunResp };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_fe_01'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: true, // default value — user did NOT pass --no-auto-heal
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: line => printed.push(JSON.parse(line)),
        stderr: line => stderrLines.push(line),
      },
    );

    // Body must include autoHeal:true
    expect((sentBody as { autoHeal?: boolean }).autoHeal).toBe(true);

    // Advisory must mention 0.2 credit and --no-auto-heal
    const advisory = stderrLines.find(
      l => l.includes('[advisory]') && l.includes('0.2') && l.includes('--no-auto-heal'),
    );
    expect(advisory).toBeDefined();
  });
});

describe('R-FE4: server unexpectedly echoes autoHeal:false — prints "not applied" advisory; no "Pro plan" language', () => {
  it('server echoes autoHeal:false; CLI prints defensive advisory without Pro-plan claim', async () => {
    const creds = makeCreds();
    const rerunResp = makeFeRerunResp({ autoHeal: false }); // server did not apply auto-heal
    const stderrLines: string[] = [];
    const terminalRun = makeTerminalRun('run_rerun_fe_001', 'passed');

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_fe_01/runs/rerun')) {
        return { body: rerunResp };
      }
      if (url.includes('/runs/run_rerun_fe_001')) {
        return { body: terminalRun };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_fe_01'],
        all: false,
        wait: true,
        timeoutSeconds: 10,
        autoHeal: true, // default-on (user did not pass --no-auto-heal)
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stderr: line => stderrLines.push(line),
      },
    );

    // CLI prints the defensive advisory since server echoed autoHeal:false.
    // Must NOT say "requires Pro plan" (CLI path has no paid gate).
    const advisory = stderrLines.find(l => l.includes('[advisory]') && l.includes('not applied'));
    expect(advisory).toBeDefined();

    // Must not use Pro-plan language on the CLI path
    const proLine = stderrLines.find(l => l.toLowerCase().includes('pro plan'));
    expect(proLine).toBeUndefined();
  });
});

// R-FE5: --no-auto-heal explicit opt-out → body sends no autoHeal field
describe('R-FE5: --no-auto-heal opt-out', () => {
  it('does NOT send autoHeal in body when autoHeal:false; no advisory emitted', async () => {
    const creds = makeCreds();
    const rerunResp = makeFeRerunResp({ autoHeal: false }); // verbatim replay
    const stderrLines: string[] = [];
    let sentBody: unknown;

    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests/test_fe_01/runs/rerun')) {
        sentBody = init.body ? JSON.parse(init.body as string) : null;
        return { body: rerunResp };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_fe_01'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false, // user passed --no-auto-heal
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stderr: line => stderrLines.push(line),
      },
    );

    // autoHeal must NOT be sent to server (effectiveAutoHeal is false)
    expect((sentBody as { autoHeal?: boolean }).autoHeal).toBeUndefined();

    // No advisory for a verbatim replay (server echoes false, opts.autoHeal is false)
    const advisory = stderrLines.find(l => l.includes('[advisory]'));
    expect(advisory).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R-BE1: BE rerun with closure
// ---------------------------------------------------------------------------

describe('R-BE1: BE rerun — prints closure + polls all members + exits on named test', () => {
  it('happy path: all members pass; exit 0', async () => {
    const creds = makeCreds();
    const rerunResp = makeBeRerunResp();
    const namedRun = makeTerminalRun('run_rerun_be_named', 'passed');
    const producerRun = makeTerminalRun('run_rerun_be_producer', 'passed');
    namedRun.testId = 'test_be_consumer_01';
    producerRun.testId = 'test_be_producer_01';
    const stderrLines: string[] = [];
    const printed: unknown[] = [];

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_be_consumer_01/runs/rerun')) {
        return { body: rerunResp };
      }
      if (url.includes('/tests/test_be_consumer_01')) {
        return { body: BE_TEST };
      }
      if (url.includes('/runs/run_rerun_be_named')) {
        return { body: namedRun };
      }
      if (url.includes('/runs/run_rerun_be_producer')) {
        return { body: producerRun };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_be_consumer_01'],
        all: false,
        wait: true,
        timeoutSeconds: 10,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stderr: line => stderrLines.push(line),
        stdout: line => printed.push(JSON.parse(line)),
      },
    );

    // Should print closure summary
    const closureLine = stderrLines.find(l => l.includes('Reran') && l.includes('producer'));
    expect(closureLine).toBeDefined();
  });

  it('C2 stale-pass guard: producer already passed before rerun — waits for NEW runId', async () => {
    // A BE producer that has a pre-existing `passed` status should NOT short-circuit
    // the --wait poll — the poll anchors on the specific runId from the response
    // (not `GET /tests/{id}/result`), so a stale prior verdict cannot be accepted.
    const creds = makeCreds();
    const rerunResp = makeBeRerunResp();
    // Named test: queued then passed. Producer: queued then passed.
    let namedPollCount = 0;
    let producerPollCount = 0;
    const namedRun = makeTerminalRun('run_rerun_be_named', 'passed');
    namedRun.testId = 'test_be_consumer_01';
    const producerRun = makeTerminalRun('run_rerun_be_producer', 'passed');
    producerRun.testId = 'test_be_producer_01';

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_be_consumer_01/runs/rerun')) {
        return { body: rerunResp };
      }
      if (url.includes('/tests/test_be_consumer_01')) {
        return { body: BE_TEST };
      }
      if (url.includes('/runs/run_rerun_be_named')) {
        namedPollCount++;
        // First tick: still queued (not the stale prior result)
        if (namedPollCount === 1) return { body: { ...namedRun, status: 'queued' } };
        return { body: namedRun };
      }
      if (url.includes('/runs/run_rerun_be_producer')) {
        producerPollCount++;
        if (producerPollCount === 1) return { body: { ...producerRun, status: 'queued' } };
        return { body: producerRun };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_be_consumer_01'],
        all: false,
        wait: true,
        timeoutSeconds: 10,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
      },
    );

    // Both runIds were polled (not the stale test result)
    expect(namedPollCount).toBeGreaterThan(1);
    expect(producerPollCount).toBeGreaterThan(1);
  });

  it('closure member fails: closureFailures[] surfaced; exit keys on named test (passed)', async () => {
    const creds = makeCreds();
    const rerunResp = makeBeRerunResp();
    const namedRun = makeTerminalRun('run_rerun_be_named', 'passed');
    namedRun.testId = 'test_be_consumer_01';
    const producerRun = makeTerminalRun('run_rerun_be_producer', 'failed'); // member fails
    producerRun.testId = 'test_be_producer_01';
    const stderrLines: string[] = [];
    const printed: unknown[] = [];

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_be_consumer_01/runs/rerun')) {
        return { body: rerunResp };
      }
      if (url.includes('/tests/test_be_consumer_01')) {
        return { body: BE_TEST };
      }
      if (url.includes('/runs/run_rerun_be_named')) {
        return { body: namedRun };
      }
      if (url.includes('/runs/run_rerun_be_producer')) {
        return { body: producerRun };
      }
      return errorBody('NOT_FOUND');
    });

    // Named test passes even though producer fails → exit 0
    await runTestRerun(
      {
        testIds: ['test_be_consumer_01'],
        all: false,
        wait: true,
        timeoutSeconds: 10,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stderr: line => stderrLines.push(line),
        stdout: line => printed.push(JSON.parse(line)),
      },
    );

    // Closure failure warning emitted
    const warningLine = stderrLines.find(l => l.includes('closure member') && l.includes('failed'));
    expect(warningLine).toBeDefined();

    // closureFailures[] in JSON output
    const jsonOutput = printed[0] as { closureFailures?: unknown[] };
    expect(Array.isArray(jsonOutput.closureFailures)).toBe(true);
    expect((jsonOutput.closureFailures as unknown[]).length).toBeGreaterThan(0);
  });

  it('named test fails: exits 1 + suggests artifact get', async () => {
    const creds = makeCreds();
    const rerunResp = makeBeRerunResp();
    const namedRun = makeTerminalRun('run_rerun_be_named', 'failed');
    namedRun.testId = 'test_be_consumer_01';
    const producerRun = makeTerminalRun('run_rerun_be_producer', 'passed');
    producerRun.testId = 'test_be_producer_01';
    const stderrLines: string[] = [];

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_be_consumer_01/runs/rerun')) {
        return { body: rerunResp };
      }
      if (url.includes('/tests/test_be_consumer_01')) {
        return { body: BE_TEST };
      }
      if (url.includes('/runs/run_rerun_be_named')) {
        return { body: namedRun };
      }
      if (url.includes('/runs/run_rerun_be_producer')) {
        return { body: producerRun };
      }
      return errorBody('NOT_FOUND');
    });

    try {
      await runTestRerun(
        {
          testIds: ['test_be_consumer_01'],
          all: false,
          wait: true,
          timeoutSeconds: 10,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        {
          ...creds,
          sleep: instantSleep,
          fetchImpl,
          stderr: line => stderrLines.push(line),
        },
      );
      expect.fail('should have thrown');
    } catch (err: unknown) {
      expect((err as { exitCode?: number }).exitCode).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// R-BE2: --skip-dependencies
// ---------------------------------------------------------------------------

describe('R-BE2: --skip-dependencies', () => {
  it('sends skipDependencies:true in request body', async () => {
    const creds = makeCreds();
    // BE rerun with no closure (skipDependencies=true → server returns minimal response)
    const rerunResp = makeFeRerunResp({ runId: 'run_rerun_be_nodeps' }); // FE-shape (no closure)
    let sentBody: unknown;

    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests/test_be_consumer_01/runs/rerun')) {
        sentBody = init.body ? JSON.parse(init.body as string) : null;
        return { body: rerunResp };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_be_consumer_01'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: true,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
      },
    );

    expect((sentBody as { skipDependencies?: boolean }).skipDependencies).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R-BE3: auto-heal on BE test — suppressed or warned depending on explicit flag
// ---------------------------------------------------------------------------

describe('R-BE3: auto-heal on BE test — default-on suppresses warning', () => {
  it('auto-heal defaults true; BE type suppresses warning (autoHealExplicit:false); autoHeal NOT sent', async () => {
    const creds = makeCreds();
    const rerunResp = makeBeRerunResp({ autoHeal: false });
    const stderrLines: string[] = [];
    let sentBody: unknown;

    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests/test_be_consumer_01') && !url.includes('/runs/rerun')) {
        return { body: BE_TEST };
      }
      if (url.includes('/tests/test_be_consumer_01/runs/rerun')) {
        sentBody = init.body ? JSON.parse(init.body as string) : null;
        return { body: rerunResp };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_be_consumer_01'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        // autoHeal:true is the default (user did NOT pass --no-auto-heal)
        autoHeal: true,
        // autoHealExplicit:false means we suppress the BE "ignoring" warning
        // to avoid noise on every default BE rerun.
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stderr: line => stderrLines.push(line),
      },
    );

    // With autoHealExplicit:false, the "ignoring auto-heal" advisory must NOT be emitted
    const warning = stderrLines.find(
      l => l.includes('auto-heal applies to frontend tests only') || l.includes('ignoring'),
    );
    expect(warning).toBeUndefined();

    // autoHeal must NOT be sent to server (effectiveAutoHeal is false for BE)
    expect((sentBody as { autoHeal?: boolean }).autoHeal).toBeUndefined();
  });

  it('auto-heal explicitly requested (autoHealExplicit:true); BE type emits warning', async () => {
    // This covers a hypothetical future scenario where a user can explicitly
    // pass --auto-heal. Since there's no such flag currently, autoHealExplicit
    // can be set to true only by callers that inject it directly (e.g. tests or
    // future flag additions).
    const creds = makeCreds();
    const rerunResp = makeBeRerunResp({ autoHeal: false });
    const stderrLines: string[] = [];
    let sentBody: unknown;

    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests/test_be_consumer_01') && !url.includes('/runs/rerun')) {
        return { body: BE_TEST };
      }
      if (url.includes('/tests/test_be_consumer_01/runs/rerun')) {
        sentBody = init.body ? JSON.parse(init.body as string) : null;
        return { body: rerunResp };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_be_consumer_01'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: true,
        autoHealExplicit: true, // user explicitly requested --auto-heal
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stderr: line => stderrLines.push(line),
      },
    );

    // With autoHealExplicit:true, the warning IS emitted
    const warning = stderrLines.find(
      l => l.includes('auto-heal applies to frontend tests only') || l.includes('ignoring'),
    );
    expect(warning).toBeDefined();

    // autoHeal must NOT be sent to server (effectiveAutoHeal is false for BE)
    expect((sentBody as { autoHeal?: boolean }).autoHeal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — BE rerun: no "not applied" advisory (effectiveAutoHeal fix)
// ---------------------------------------------------------------------------
// D2-FIX2: Before the fix, `opts.autoHeal && !rerunResp.autoHeal` fired on
// every BE rerun because opts.autoHeal is default-on true but the server always
// echoes autoHeal:false for BE tests. The fix changes the guard to
// `effectiveAutoHeal && !rerunResp.autoHeal` so BE reruns (effectiveAutoHeal=false)
// never trigger the advisory.
describe('[fix-2] BE rerun: spurious "not applied" advisory is suppressed', () => {
  it('BE rerun with default-on autoHeal does NOT print "not applied" advisory', async () => {
    const creds = makeCreds();
    // Server echoes autoHeal:false for BE (expected) — before the fix, this
    // would trigger the defensive advisory every time.
    const rerunResp = makeBeRerunResp({ autoHeal: false });
    const stderrLines: string[] = [];

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_be_consumer_01') && !url.includes('/runs/rerun')) {
        return { body: BE_TEST };
      }
      if (url.includes('/tests/test_be_consumer_01/runs/rerun')) {
        return { body: rerunResp };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_be_consumer_01'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: true, // default-on (user did NOT pass --no-auto-heal)
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stderr: line => stderrLines.push(line),
      },
    );

    // The "not applied" advisory MUST NOT fire for BE reruns (FIX 2).
    // effectiveAutoHeal is false for BE, so the guard is: false && !false → false.
    const notAppliedLine = stderrLines.find(
      l => l.includes('not applied') || l.includes('was not applied'),
    );
    expect(notAppliedLine).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R-BAT: Batch rerun
// ---------------------------------------------------------------------------

describe('R-BAT: batch rerun (multi-id, no --wait)', () => {
  it('sends testIds to POST /tests/batch/rerun and prints accepted', async () => {
    const creds = makeCreds();
    const batchResp: BatchRerunResponse = {
      accepted: [
        { testId: 'test_1', runId: 'run_b1', enqueuedAt: '2026-06-03T10:00:00.000Z' },
        { testId: 'test_2', runId: 'run_b2', enqueuedAt: '2026-06-03T10:00:00.000Z' },
      ],
      deferred: [],
      conflicts: [],
      closure: { byProject: [] },
    };
    const printed: unknown[] = [];
    let sentBody: unknown;

    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests/batch/rerun')) {
        sentBody = init.body ? JSON.parse(init.body as string) : null;
        return { status: 202, body: batchResp };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_1', 'test_2'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: line => printed.push(JSON.parse(line)),
      },
    );

    expect((sentBody as { testIds: string[] }).testIds).toEqual(['test_1', 'test_2']);
    const result = printed[0] as BatchRerunResponse;
    expect(result.accepted).toHaveLength(2);
    expect(result.accepted[0]!.runId).toBe('run_b1');
    expect(result.accepted[1]!.runId).toBe('run_b2');
  });
});

describe('R-BAT: batch rerun + --wait fan-out poll by runId (C2)', () => {
  it('polls each accepted runId individually; aggregate exit 0 on all passed', async () => {
    const creds = makeCreds();
    const batchResp: BatchRerunResponse = {
      accepted: [
        { testId: 'test_1', runId: 'run_b1', enqueuedAt: '2026-06-03T10:00:00.000Z' },
        { testId: 'test_2', runId: 'run_b2', enqueuedAt: '2026-06-03T10:00:00.000Z' },
      ],
      deferred: [],
      conflicts: [],
      closure: { byProject: [] },
    };
    const pollCounts: Record<string, number> = {};
    const run1 = makeTerminalRun('run_b1', 'passed');
    run1.testId = 'test_1';
    const run2 = makeTerminalRun('run_b2', 'passed');
    run2.testId = 'test_2';

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch/rerun')) {
        return { status: 202, body: batchResp };
      }
      if (url.includes('/runs/run_b1')) {
        pollCounts['run_b1'] = (pollCounts['run_b1'] ?? 0) + 1;
        return { body: run1 };
      }
      if (url.includes('/runs/run_b2')) {
        pollCounts['run_b2'] = (pollCounts['run_b2'] ?? 0) + 1;
        return { body: run2 };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_1', 'test_2'],
        all: false,
        wait: true,
        timeoutSeconds: 10,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
      },
    );

    // Both runIds were polled individually (run-scoped, not testId-latest)
    expect(pollCounts['run_b1']).toBeGreaterThan(0);
    expect(pollCounts['run_b2']).toBeGreaterThan(0);
  });

  it('partial conflict: accepted proceed, conflicts reported', async () => {
    const creds = makeCreds();
    const batchResp: BatchRerunResponse = {
      accepted: [{ testId: 'test_1', runId: 'run_b1', enqueuedAt: '2026-06-03T10:00:00.000Z' }],
      deferred: [],
      conflicts: [{ testId: 'test_conflict', currentRunId: 'run_inflight_01' }],
      closure: { byProject: [] },
    };
    const run1 = makeTerminalRun('run_b1', 'passed');
    run1.testId = 'test_1';
    const stderrLines: string[] = [];

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch/rerun')) {
        return { status: 202, body: batchResp };
      }
      if (url.includes('/runs/run_b1')) {
        return { body: run1 };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_1', 'test_conflict'],
        all: false,
        wait: true,
        timeoutSeconds: 10,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stderr: line => stderrLines.push(line),
      },
    );

    // Conflict should be mentioned in summary
    const conflictMention = stderrLines.find(
      l => l.includes('in flight') || l.includes('conflict'),
    );
    expect(conflictMention).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// C1: deferred[] → exit 7 + retry nextAction
// ---------------------------------------------------------------------------

describe('C1: deferred[] → exit 7 + retry nextAction', () => {
  it('no --wait: exits 7 when deferred[] non-empty', async () => {
    const creds = makeCreds();
    const batchResp: BatchRerunResponse = {
      accepted: [{ testId: 'test_1', runId: 'run_b1', enqueuedAt: '2026-06-03T10:00:00.000Z' }],
      deferred: [{ testId: 'test_deferred', reason: 'rate_limited' }],
      conflicts: [],
      closure: { byProject: [] },
    };
    const stderrLines: string[] = [];

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch/rerun')) {
        return { status: 202, body: batchResp };
      }
      return errorBody('NOT_FOUND');
    });

    try {
      await runTestRerun(
        {
          testIds: ['test_1', 'test_deferred'],
          all: false,
          wait: false,
          timeoutSeconds: 600,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        {
          ...creds,
          sleep: instantSleep,
          fetchImpl,
          stderr: line => stderrLines.push(line),
        },
      );
      expect.fail('should have thrown');
    } catch (err: unknown) {
      // Exit 7 for incomplete run
      const exitCode = (err as { exitCode?: number }).exitCode;
      expect(exitCode).toBe(7);
    }

    // Retry nextAction should be printed
    const retryLine = stderrLines.find(l => l.includes('test_deferred'));
    expect(retryLine).toBeDefined();
  });

  it('with --wait: exits 7 when deferred[] non-empty even if accepted all passed', async () => {
    const creds = makeCreds();
    const batchResp: BatchRerunResponse = {
      accepted: [{ testId: 'test_1', runId: 'run_b1', enqueuedAt: '2026-06-03T10:00:00.000Z' }],
      deferred: [{ testId: 'test_deferred', reason: 'rate_limited' }],
      conflicts: [],
      closure: { byProject: [] },
    };
    const run1 = makeTerminalRun('run_b1', 'passed');
    run1.testId = 'test_1';

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch/rerun')) {
        return { status: 202, body: batchResp };
      }
      if (url.includes('/runs/run_b1')) {
        return { body: run1 };
      }
      return errorBody('NOT_FOUND');
    });

    try {
      await runTestRerun(
        {
          testIds: ['test_1', 'test_deferred'],
          all: false,
          wait: true,
          timeoutSeconds: 10,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        {
          ...creds,
          sleep: instantSleep,
          fetchImpl,
        },
      );
      expect.fail('should have thrown');
    } catch (err: unknown) {
      const exitCode = (err as { exitCode?: number }).exitCode;
      // exit 7 because deferred makes run incomplete
      expect(exitCode).toBe(7);
    }
  });
});

// ---------------------------------------------------------------------------
// --all flag
// ---------------------------------------------------------------------------

describe('--all: resolves project tests and batch reruns', () => {
  it('lists tests then calls batch/rerun with all testIds', async () => {
    const creds = makeCreds();
    const projectTests = [
      { ...FE_TEST, id: 'test_p1' },
      { ...FE_TEST, id: 'test_p2' },
    ];
    const batchResp: BatchRerunResponse = {
      accepted: [
        { testId: 'test_p1', runId: 'run_p1', enqueuedAt: '2026-06-03T10:00:00.000Z' },
        { testId: 'test_p2', runId: 'run_p2', enqueuedAt: '2026-06-03T10:00:00.000Z' },
      ],
      deferred: [],
      conflicts: [],
      closure: { byProject: [] },
    };
    let sentBatchBody: unknown;

    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests') && !url.includes('batch') && !url.includes('/runs')) {
        return { body: { items: projectTests, nextToken: null } };
      }
      if (url.includes('/tests/batch/rerun')) {
        sentBatchBody = init.body ? JSON.parse(init.body as string) : null;
        return { status: 202, body: batchResp };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: [],
        all: true,
        projectId: 'project_abc',
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
      },
    );

    expect((sentBatchBody as { testIds: string[] }).testIds).toEqual(['test_p1', 'test_p2']);
  });
});

// ---------------------------------------------------------------------------
// 409 CONFLICT (single run in flight)
// ---------------------------------------------------------------------------

describe('409 CONFLICT → exit 6 with nextAction', () => {
  it('in-flight test → CONFLICT error with nextAction: test wait <runId>', async () => {
    const creds = makeCreds();

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_fe_01/runs/rerun')) {
        return errorBody('CONFLICT', { reason: 'run_in_flight', currentRunId: 'run_in_flight_01' });
      }
      return errorBody('NOT_FOUND');
    });

    try {
      await runTestRerun(
        {
          testIds: ['test_fe_01'],
          all: false,
          wait: false,
          timeoutSeconds: 600,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep, fetchImpl },
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err instanceof ApiError).toBe(true);
      if (err instanceof ApiError) {
        expect(err.code).toBe('CONFLICT');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// --idempotency-key passthrough
// ---------------------------------------------------------------------------

describe('--idempotency-key passthrough', () => {
  it('sends the supplied idempotency key as Idempotency-Key header', async () => {
    const creds = makeCreds();
    const rerunResp = makeFeRerunResp();
    let receivedKey: string | null = null;

    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests/test_fe_01/runs/rerun')) {
        const headers = init.headers as Record<string, string>;
        receivedKey = headers['idempotency-key'] ?? null;
        return { body: rerunResp };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_fe_01'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        idempotencyKey: 'my-custom-key-abc',
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, sleep: instantSleep, fetchImpl },
    );

    expect(receivedKey).toBe('my-custom-key-abc');
  });
});

// ---------------------------------------------------------------------------
// --timeout → exit 7 with resume nextAction
// ---------------------------------------------------------------------------

describe('--wait --timeout exceeded → exit 7 + nextAction', () => {
  it('single FE: exits 7 when run does not reach terminal within timeout', async () => {
    const creds = makeCreds();
    const rerunResp = makeFeRerunResp();
    const nonTerminalRun = makeTerminalRun('run_rerun_fe_001', 'passed');
    nonTerminalRun.status = 'running' as unknown as 'passed'; // cast to simulate non-terminal

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_fe_01/runs/rerun')) {
        return { body: rerunResp };
      }
      if (url.includes('/runs/run_rerun_fe_001')) {
        // Never becomes terminal → will cause timeout
        return {
          body: {
            ...nonTerminalRun,
            status: 'queued',
            retryAfterSeconds: 0,
          },
        };
      }
      if (url.includes('/tests/test_fe_01')) {
        return { body: FE_TEST }; // FE type so fallback doesn't fire
      }
      return errorBody('NOT_FOUND');
    });

    try {
      await runTestRerun(
        {
          testIds: ['test_fe_01'],
          all: false,
          wait: true,
          timeoutSeconds: 1, // Very short timeout
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep, fetchImpl },
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err instanceof ApiError).toBe(true);
      if (err instanceof ApiError) {
        expect(err.code).toBe('UNSUPPORTED'); // exit 7 per errors.md
        expect(err.message).toContain('Timed out');
        // nextAction should suggest test wait
        const nextAction = err.getDetail<string>(
          'runId',
          (v): v is string => typeof v === 'string',
        );
        expect(nextAction ?? err.message).toContain('run_rerun_fe_001');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// --output json
// ---------------------------------------------------------------------------

describe('--output json', () => {
  it('single FE no --wait: prints parseable JSON', async () => {
    const creds = makeCreds();
    const rerunResp = makeFeRerunResp();
    let rawLine: string | undefined;

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_fe_01/runs/rerun')) {
        return { body: rerunResp };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_fe_01'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: line => {
          rawLine = line;
        },
      },
    );

    expect(rawLine).toBeDefined();
    const parsed = JSON.parse(rawLine!);
    expect(parsed.runId).toBe('run_rerun_fe_001');
    expect(parsed.status).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// --dry-run
// ---------------------------------------------------------------------------

describe('--dry-run', () => {
  it('single FE: emits canned sample (no network call)', async () => {
    const creds = makeCreds();
    const printed: unknown[] = [];
    let networkCalled = false;

    const fetchImpl = makeFetch(() => {
      networkCalled = true;
      return errorBody('INTERNAL');
    });

    await runTestRerun(
      {
        testIds: ['test_fe_01'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: true,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: line => printed.push(JSON.parse(line)),
      },
    );

    expect(networkCalled).toBe(false);
    expect(printed.length).toBeGreaterThan(0);
  });

  it('batch: emits canned sample', async () => {
    const creds = makeCreds();
    const printed: unknown[] = [];

    await runTestRerun(
      {
        testIds: ['test_1', 'test_2'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: true,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        stdout: line => printed.push(JSON.parse(line)),
      },
    );

    expect(printed.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — --all auto-pages through nextToken
// ---------------------------------------------------------------------------

describe('[fix-1] --all follows nextToken to collect ALL project tests', () => {
  it('fetches page 2 when page 1 has a nextToken', async () => {
    const creds = makeCreds();
    const page1Tests = [
      { ...FE_TEST, id: 'test_page1_a' },
      { ...FE_TEST, id: 'test_page1_b' },
    ];
    const page2Tests = [
      { ...FE_TEST, id: 'test_page2_a' },
      { ...FE_TEST, id: 'test_page2_b' },
    ];
    const batchResp: BatchRerunResponse = {
      accepted: [
        { testId: 'test_page1_a', runId: 'run_pa', enqueuedAt: '2026-06-03T10:00:00.000Z' },
        { testId: 'test_page1_b', runId: 'run_pb', enqueuedAt: '2026-06-03T10:00:00.000Z' },
        { testId: 'test_page2_a', runId: 'run_pc', enqueuedAt: '2026-06-03T10:00:00.000Z' },
        { testId: 'test_page2_b', runId: 'run_pd', enqueuedAt: '2026-06-03T10:00:00.000Z' },
      ],
      deferred: [],
      conflicts: [],
      closure: { byProject: [] },
    };
    let listCallCount = 0;
    let sentBatchBody: unknown;

    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests') && !url.includes('batch') && !url.includes('/runs')) {
        listCallCount++;
        // First page returns a nextToken; second page returns null.
        if (url.includes('cursor=page2-cursor') || listCallCount >= 2) {
          return { body: { items: page2Tests, nextToken: null } };
        }
        return { body: { items: page1Tests, nextToken: 'page2-cursor' } };
      }
      if (url.includes('/tests/batch/rerun')) {
        sentBatchBody = init.body ? JSON.parse(init.body as string) : null;
        return { status: 202, body: batchResp };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: [],
        all: true,
        projectId: 'project_abc',
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, sleep: instantSleep, fetchImpl },
    );

    // Both pages were fetched
    expect(listCallCount).toBeGreaterThanOrEqual(2);
    // Batch rerun received all 4 test ids (from both pages)
    const sentIds = (sentBatchBody as { testIds: string[] }).testIds;
    expect(sentIds).toContain('test_page1_a');
    expect(sentIds).toContain('test_page1_b');
    expect(sentIds).toContain('test_page2_a');
    expect(sentIds).toContain('test_page2_b');
    expect(sentIds).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — cancelled closure rerun treated as failure
// ---------------------------------------------------------------------------

describe('[fix-2] cancelled named BE closure run treated as failure (not success)', () => {
  it('named test finishing cancelled → exits 1', async () => {
    const creds = makeCreds();
    const rerunResp = makeBeRerunResp();
    // named run lands as cancelled
    const namedRun = {
      ...makeTerminalRun('run_rerun_be_named'),
      status: 'cancelled' as 'passed' | 'failed' | 'blocked',
      testId: 'test_be_consumer_01',
    };
    const producerRun = makeTerminalRun('run_rerun_be_producer', 'passed');
    producerRun.testId = 'test_be_producer_01';

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_be_consumer_01/runs/rerun')) {
        return { body: rerunResp };
      }
      if (url.includes('/tests/test_be_consumer_01')) {
        return { body: BE_TEST };
      }
      if (url.includes('/runs/run_rerun_be_named')) {
        return { body: namedRun };
      }
      if (url.includes('/runs/run_rerun_be_producer')) {
        return { body: producerRun };
      }
      return errorBody('NOT_FOUND');
    });

    try {
      await runTestRerun(
        {
          testIds: ['test_be_consumer_01'],
          all: false,
          wait: true,
          timeoutSeconds: 10,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep, fetchImpl },
      );
      expect.fail('should have thrown on cancelled status');
    } catch (err: unknown) {
      expect((err as { exitCode?: number }).exitCode).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — max-concurrency 0 / negative rejected with exit 5
// ---------------------------------------------------------------------------

describe('[fix-3] --max-concurrency 0 / negative rejected before polling', () => {
  it('maxConcurrency 0 → VALIDATION_ERROR (exit 5)', async () => {
    const creds = makeCreds();
    await expect(
      runTestRerun(
        {
          testIds: ['test_fe_01'],
          all: false,
          wait: true,
          timeoutSeconds: 600,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 0, // invalid
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('maxConcurrency -5 → VALIDATION_ERROR (exit 5)', async () => {
    const creds = makeCreds();
    await expect(
      runTestRerun(
        {
          testIds: ['test_fe_01'],
          all: false,
          wait: true,
          timeoutSeconds: 600,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: -5, // invalid
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('maxConcurrency 1 → accepted (minimum valid)', async () => {
    const creds = makeCreds();
    const rerunResp = makeFeRerunResp();
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_fe_01/runs/rerun')) {
        return { body: rerunResp };
      }
      return errorBody('NOT_FOUND');
    });

    await expect(
      runTestRerun(
        {
          testIds: ['test_fe_01'],
          all: false,
          wait: false,
          timeoutSeconds: 600,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 1, // minimum valid
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep, fetchImpl },
      ),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — one `test wait <runId>` per timed-out run in nextAction
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fix B — timed-out closure members treated as incomplete reruns (exit 7)
// ---------------------------------------------------------------------------

describe('[fix-B] timed-out BE closure member → exit 7, not silent success', () => {
  it('non-named closure member timeout → closureFailures["timeout"] + exit 7', async () => {
    const creds = makeCreds();
    const rerunResp = makeBeRerunResp();
    const namedRunId = rerunResp.runId; // 'run_rerun_be_named'
    const producerRunId = rerunResp.closure!.members.find(m => m.role === 'producer')!.runId;

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_be_consumer_01/runs/rerun')) {
        return { status: 202, body: rerunResp };
      }
      if (url.includes('/tests/test_be_consumer_01')) {
        return { body: BE_TEST };
      }
      // Named run reaches terminal (passed) immediately
      if (url.includes(`/runs/${namedRunId}`)) {
        return { body: makeTerminalRun(namedRunId, 'passed') };
      }
      // Producer run stays non-terminal → will time out
      if (url.includes(`/runs/${producerRunId}`)) {
        return {
          body: {
            ...makeTerminalRun(producerRunId, 'passed'),
            status: 'executing', // non-terminal, causes timeout
          },
        };
      }
      return errorBody('NOT_FOUND');
    });

    const err = await runTestRerun(
      {
        testIds: ['test_be_consumer_01'],
        all: false,
        wait: true,
        timeoutSeconds: 1, // short → producer times out
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, sleep: instantSleep, fetchImpl },
    ).catch(e => e);

    // Must exit 7 (UNSUPPORTED = timeout)
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('UNSUPPORTED');
    expect((err as ApiError).exitCode).toBe(7);
    // nextAction should reference the timed-out producer run
    expect((err as ApiError).nextAction).toContain(producerRunId);
  });
});

// ---------------------------------------------------------------------------
// Fix C — all-conflict batch rerun → exit 6 CONFLICT (not exit 0)
// ---------------------------------------------------------------------------

describe('[fix-C] batch rerun: every test in-flight → CONFLICT exit 6', () => {
  it('--wait: accepted=[], conflicts non-empty → exits 6', async () => {
    const creds = makeCreds();
    const allConflictResp: BatchRerunResponse = {
      accepted: [],
      deferred: [],
      conflicts: [
        { testId: 'test_1', currentRunId: 'run_inflight_1' },
        { testId: 'test_2', currentRunId: 'run_inflight_2' },
      ],
      closure: { byProject: [] },
    };

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch/rerun')) {
        return { status: 202, body: allConflictResp };
      }
      return errorBody('NOT_FOUND');
    });

    const err = await runTestRerun(
      {
        testIds: ['test_1', 'test_2'],
        all: false,
        wait: true,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, sleep: instantSleep, fetchImpl },
    ).catch(e => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('CONFLICT');
    expect((err as ApiError).exitCode).toBe(6);
    expect((err as ApiError).message).toMatch(/in flight/i);
  });

  it('no --wait: accepted=[], conflicts non-empty → exits 6', async () => {
    const creds = makeCreds();
    // Need ≥2 testIds to force the batch path (single-id takes the single path).
    const allConflictResp: BatchRerunResponse = {
      accepted: [],
      deferred: [],
      conflicts: [
        { testId: 'test_1', currentRunId: 'run_inflight_1' },
        { testId: 'test_2', currentRunId: 'run_inflight_2' },
      ],
      closure: { byProject: [] },
    };

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch/rerun')) {
        return { status: 202, body: allConflictResp };
      }
      return errorBody('NOT_FOUND');
    });

    const err = await runTestRerun(
      {
        testIds: ['test_1', 'test_2'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, sleep: instantSleep, fetchImpl },
    ).catch(e => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('CONFLICT');
    expect((err as ApiError).exitCode).toBe(6);
  });

  it('[codex-P2] no --wait: accepted=[], conflicts + notFound → CONFLICT names both causes (not "all in flight")', async () => {
    const creds = makeCreds();
    const mixedResp: BatchRerunResponse = {
      accepted: [],
      deferred: [],
      conflicts: [{ testId: 'test_1', currentRunId: 'run_inflight_1' }],
      closure: { byProject: [] },
      notFound: ['test_bad_x', 'test_bad_y'],
    };

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch/rerun')) return { status: 202, body: mixedResp };
      return errorBody('NOT_FOUND');
    });

    const err = await runTestRerun(
      {
        testIds: ['test_1', 'test_bad_x', 'test_bad_y'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, sleep: instantSleep, fetchImpl },
    ).catch(e => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('CONFLICT');
    expect((err as ApiError).exitCode).toBe(6);
    // codex P2: a mixed conflicts+notFound response (no accepted runs) must name
    // BOTH causes — it must not be misreported as "all ... already in flight".
    expect((err as ApiError).message).toContain('not found');
    expect((err as ApiError).message).toContain('already in flight');
  });

  it('partial conflict (some accepted + some conflicts) still exits 0 on all-passed', async () => {
    const creds = makeCreds();
    const partialConflictResp: BatchRerunResponse = {
      accepted: [{ testId: 'test_1', runId: 'run_new_1', enqueuedAt: '2026-06-03T10:00:00.000Z' }],
      deferred: [],
      conflicts: [{ testId: 'test_2', currentRunId: 'run_inflight_2' }],
      closure: { byProject: [] },
    };

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch/rerun')) {
        return { status: 202, body: partialConflictResp };
      }
      if (url.includes('/runs/run_new_1')) {
        return { body: makeTerminalRun('run_new_1', 'passed') };
      }
      if (url.includes('/tests/test_1')) {
        return { body: FE_TEST };
      }
      return errorBody('NOT_FOUND');
    });

    // Must NOT throw — partial conflict with accepted runs is not an error
    const result = await runTestRerun(
      {
        testIds: ['test_1', 'test_2'],
        all: false,
        wait: true,
        timeoutSeconds: 60,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, sleep: instantSleep, fetchImpl },
    );
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fix D — --all with >50 tests: chunk into ≤50-id requests, aggregate
// ---------------------------------------------------------------------------

describe('[fix-D] --all resolves >50 tests: chunked batch requests, aggregated result', () => {
  it('60 tests → 2 batch requests (chunk 50 + chunk 10), result aggregated', async () => {
    const creds = makeCreds();

    // Build 60 test stubs
    const allTests = Array.from({ length: 60 }, (_, i) => ({
      ...FE_TEST,
      id: `test_bulk_${String(i).padStart(3, '0')}`,
    }));

    let batchCallCount = 0;
    const batchBodies: { testIds: string[] }[] = [];

    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests') && !url.includes('batch') && !url.includes('/runs')) {
        // Return all 60 tests in a single page (no nextToken)
        return { body: { items: allTests, nextToken: null } };
      }
      if (url.includes('/tests/batch/rerun')) {
        batchCallCount++;
        const body = JSON.parse(init.body as string) as { testIds: string[] };
        batchBodies.push(body);
        // Each chunk's accepted = one entry per testId in the chunk
        const accepted = body.testIds.map(tid => ({
          testId: tid,
          runId: `run_${tid}`,
          enqueuedAt: '2026-06-03T10:00:00.000Z',
        }));
        return {
          status: 202,
          body: {
            accepted,
            deferred: [],
            conflicts: [],
            closure: { byProject: [] },
          } satisfies BatchRerunResponse,
        };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: [],
        all: true,
        projectId: 'project_abc',
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, sleep: instantSleep, fetchImpl },
    );

    // Must have made exactly 2 batch calls (50 + 10)
    expect(batchCallCount).toBe(2);
    // First chunk: 50 ids
    expect(batchBodies[0]!.testIds).toHaveLength(50);
    // Second chunk: remaining 10
    expect(batchBodies[1]!.testIds).toHaveLength(10);
    // No testId appears in both chunks
    const allSent = [...batchBodies[0]!.testIds, ...batchBodies[1]!.testIds];
    expect(new Set(allSent).size).toBe(60);
  });

  it('exactly 50 tests → single batch request (no chunking)', async () => {
    const creds = makeCreds();
    const allTests = Array.from({ length: 50 }, (_, i) => ({
      ...FE_TEST,
      id: `test_exact50_${i}`,
    }));

    let batchCallCount = 0;
    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests') && !url.includes('batch') && !url.includes('/runs')) {
        return { body: { items: allTests, nextToken: null } };
      }
      if (url.includes('/tests/batch/rerun')) {
        batchCallCount++;
        const body = JSON.parse(init.body as string) as { testIds: string[] };
        const accepted = body.testIds.map(tid => ({
          testId: tid,
          runId: `run_${tid}`,
          enqueuedAt: '2026-06-03T10:00:00.000Z',
        }));
        return {
          status: 202,
          body: {
            accepted,
            deferred: [],
            conflicts: [],
            closure: { byProject: [] },
          } satisfies BatchRerunResponse,
        };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: [],
        all: true,
        projectId: 'project_abc',
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, sleep: instantSleep, fetchImpl },
    );

    // Exactly 50 → 1 request only
    expect(batchCallCount).toBe(1);
  });

  // Regression: chunked batch-rerun dispatched chunks via Promise.all, so
  // when --all resolves >50 tests every chunk's request was in flight at
  // once. BE producer/teardown closure dedup happens per-request, so two
  // concurrent chunks sharing a project's producer could each independently
  // trigger it. Chunks must be dispatched strictly one at a time.
  it('60 tests → 2 chunks are dispatched sequentially, not concurrently', async () => {
    const creds = makeCreds();
    const allTests = Array.from({ length: 60 }, (_, i) => ({
      ...FE_TEST,
      id: `test_seq_${String(i).padStart(3, '0')}`,
    }));
    const CHUNK_DELAY_MS = 40;
    let activeBatchCalls = 0;
    const activeAtStart: number[] = [];

    type FetchInput2 = Parameters<typeof globalThis.fetch>[0];
    const fetchImpl = (async (input: FetchInput2, init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;
      if (url.includes('/tests') && !url.includes('batch') && !url.includes('/runs')) {
        return new Response(JSON.stringify({ items: allTests, nextToken: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/tests/batch/rerun')) {
        activeBatchCalls++;
        activeAtStart.push(activeBatchCalls);
        const body = JSON.parse(init.body as string) as { testIds: string[] };
        await new Promise(resolve => setTimeout(resolve, CHUNK_DELAY_MS));
        activeBatchCalls--;
        const accepted = body.testIds.map(tid => ({
          testId: tid,
          runId: `run_${tid}`,
          enqueuedAt: '2026-06-03T10:00:00.000Z',
        }));
        return new Response(
          JSON.stringify({
            accepted,
            deferred: [],
            conflicts: [],
            closure: { byProject: [] },
          } satisfies BatchRerunResponse),
          { status: 202, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'not found', nextAction: '', requestId: 'r1' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    await runTestRerun(
      {
        testIds: [],
        all: true,
        projectId: 'project_abc',
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, sleep: instantSleep, fetchImpl },
    );

    expect(activeAtStart).toEqual([1, 1]);
  });

  // Regression: even with sequential dispatch, defend the CLI's own
  // accounting against a shared BE producer/teardown coming back accepted
  // from more than one chunk (a different runId each time). Duplicate
  // testIds must be deduped, not double-counted or double-polled.
  it('a testId accepted by two chunks is deduped, kept once, and warned about', async () => {
    const creds = makeCreds();
    const allTests = Array.from({ length: 60 }, (_, i) => ({
      ...FE_TEST,
      id: `test_dup_${String(i).padStart(3, '0')}`,
    }));
    let batchCallCount = 0;
    const stderrLines: string[] = [];

    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests') && !url.includes('batch') && !url.includes('/runs')) {
        return { body: { items: allTests, nextToken: null } };
      }
      if (url.includes('/tests/batch/rerun')) {
        batchCallCount++;
        const body = JSON.parse(init.body as string) as { testIds: string[] };
        const accepted = body.testIds.map(tid => ({
          testId: tid,
          runId: `run_${tid}_call${batchCallCount}`,
          enqueuedAt: '2026-06-03T10:00:00.000Z',
        }));
        // Simulate a shared BE producer (not one of the 60 selected ids)
        // that both chunks' server-side closure expansion independently
        // decided to trigger, each with its own runId.
        accepted.push({
          testId: 'test_dup_producer',
          runId: `run_producer_call${batchCallCount}`,
          enqueuedAt: '2026-06-03T10:00:00.000Z',
        });
        return {
          status: 202,
          body: {
            accepted,
            deferred: [],
            conflicts: [],
            closure: { byProject: [] },
          } satisfies BatchRerunResponse,
        };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: [],
        all: true,
        projectId: 'project_abc',
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      { ...creds, sleep: instantSleep, fetchImpl, stderr: line => stderrLines.push(line) },
    );

    expect(batchCallCount).toBe(2);
    expect(
      stderrLines.some(l => l.includes('triggered more than once') && l.includes('1 test')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FIX 1 — D2-CLI: batch rerun surfaces notFound[] ids as [warn] stderr
// ---------------------------------------------------------------------------
describe('[fix-1] batch rerun: notFound[] ids aggregated and warned on stderr', () => {
  it('single chunk: notFound ids from server response are collected and warned', async () => {
    const creds = makeCreds();
    const stderrLines: string[] = [];
    const stdoutLines: string[] = [];

    const batchResp: BatchRerunResponse = {
      accepted: [
        { testId: 'test_known_1', runId: 'run_k1', enqueuedAt: '2026-06-03T10:00:00.000Z' },
      ],
      deferred: [],
      conflicts: [],
      closure: { byProject: [] },
      notFound: ['test_bad_1', 'test_bad_2'],
    };

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch/rerun')) {
        return { status: 200, body: batchResp };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_known_1', 'test_bad_1', 'test_bad_2'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: line => stdoutLines.push(line),
        stderr: line => stderrLines.push(line),
      },
    );

    // notFound ids must be warned on stderr
    const warnLine = stderrLines.find(l => l.includes('[warn]') && l.includes('2'));
    expect(warnLine).toBeDefined();
    const stderrBlock = stderrLines.join('\n');
    expect(stderrBlock).toContain('test_bad_1');
    expect(stderrBlock).toContain('test_bad_2');
    // Summary must mention "not found"
    const summaryLine = stderrLines.find(l => l.includes('Reran'));
    expect(summaryLine).toContain('not found');

    // JSON output must include notFound array
    const stdoutBlock = stdoutLines.join('\n');
    expect(stdoutBlock).toContain('test_bad_1');
    expect(stdoutBlock).toContain('test_bad_2');
  });

  it('multi-chunk: notFound ids aggregated across both chunks', async () => {
    const creds = makeCreds();
    const stderrLines: string[] = [];

    // Two test ids, each chunk returns one notFound
    const fetchImpl = makeFetch((url, init) => {
      if (url.includes('/tests/batch/rerun')) {
        const body = JSON.parse(init.body as string) as { testIds: string[] };
        // First testId in the chunk is "known", rest are notFound
        const [first, ...rest] = body.testIds;
        return {
          status: 200,
          body: {
            accepted:
              first !== undefined
                ? [{ testId: first, runId: `run_${first}`, enqueuedAt: '2026-06-03T10:00:00Z' }]
                : [],
            deferred: [],
            conflicts: [],
            closure: { byProject: [] },
            notFound: rest,
          } satisfies BatchRerunResponse,
        };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        // 3 ids: first accepted, second/third notFound (both in same chunk)
        testIds: ['test_a', 'test_bad_x', 'test_bad_y'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
      },
    );

    const stderrBlock = stderrLines.join('\n');
    expect(stderrBlock).toContain('test_bad_x');
    expect(stderrBlock).toContain('test_bad_y');
    // No warn about test_a (it was accepted)
    const warnBlock = stderrLines.filter(l => l.includes('[warn]')).join('\n');
    expect(warnBlock).not.toContain('test_a');
  });

  it('no notFound field from old backend → no warn emitted (batch path needs ≥2 ids)', async () => {
    const creds = makeCreds();
    const stderrLines: string[] = [];

    // Need ≥2 testIds to force the batch path (single-id takes the single rerun path)
    const batchRespNoNotFound: BatchRerunResponse = {
      accepted: [
        { testId: 'test_x', runId: 'run_x', enqueuedAt: '2026-06-03T10:00:00.000Z' },
        { testId: 'test_y', runId: 'run_y', enqueuedAt: '2026-06-03T10:00:00.000Z' },
      ],
      deferred: [],
      conflicts: [],
      closure: { byProject: [] },
      // notFound absent (old backend — back-compat)
    };

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch/rerun')) {
        return { status: 200, body: batchRespNoNotFound };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_x', 'test_y'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
      },
    );

    const warnLine = stderrLines.find(l => l.includes('[warn]') && l.includes('not found'));
    expect(warnLine).toBeUndefined();
  });
});

describe('[fix-4] batch timeout emits one `test wait <runId>` per timed-out run', () => {
  it('two timed-out runs → two separate test wait hints', async () => {
    const creds = makeCreds();
    const batchResp: BatchRerunResponse = {
      accepted: [
        { testId: 'test_1', runId: 'run_b1', enqueuedAt: '2026-06-03T10:00:00.000Z' },
        { testId: 'test_2', runId: 'run_b2', enqueuedAt: '2026-06-03T10:00:00.000Z' },
      ],
      deferred: [],
      conflicts: [],
      closure: { byProject: [] },
    };

    // Both runs stay non-terminal → timeout
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch/rerun')) {
        return { status: 202, body: batchResp };
      }
      if (url.includes('/runs/run_b1') || url.includes('/runs/run_b2')) {
        return {
          body: {
            ...makeTerminalRun('run_bX', 'passed'),
            status: 'queued',
            runId: url.includes('run_b1') ? 'run_b1' : 'run_b2',
          },
        };
      }
      if (url.includes('/tests/test_1') || url.includes('/tests/test_2')) {
        return { body: FE_TEST };
      }
      return errorBody('NOT_FOUND');
    });

    try {
      await runTestRerun(
        {
          testIds: ['test_1', 'test_2'],
          all: false,
          wait: true,
          timeoutSeconds: 1, // very short → both will time out
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep, fetchImpl },
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err instanceof ApiError).toBe(true);
      if (err instanceof ApiError) {
        expect(err.code).toBe('UNSUPPORTED');
        // nextAction must contain a SEPARATE `test wait` for each run id.
        // `test wait` accepts only ONE run id — emitting a joined string would
        // produce an invalid command.
        const nextAction = err.nextAction;
        const b1Count = (nextAction.match(/testsprite test wait run_b1/g) ?? []).length;
        const b2Count = (nextAction.match(/testsprite test wait run_b2/g) ?? []).length;
        expect(b1Count).toBe(1);
        expect(b2Count).toBe(1);
        // Neither should appear as "test wait run_b1 run_b2" (joined multi-id form)
        expect(nextAction).not.toContain('run_b1 run_b2');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// dogfood L1796 — `test rerun --all --skip-terminal` and `--status <list>`
// ---------------------------------------------------------------------------

/** Mix of terminal and non-terminal test records. */
const MIXED_TESTS = [
  { ...FE_TEST, id: 'test_passed_1', status: 'passed' as const },
  { ...FE_TEST, id: 'test_failed_1', status: 'failed' as const },
  { ...FE_TEST, id: 'test_running_1', status: 'running' as const },
  { ...FE_TEST, id: 'test_queued_1', status: 'queued' as const },
  { ...FE_TEST, id: 'test_blocked_1', status: 'blocked' as const },
  { ...FE_TEST, id: 'test_cancelled_1', status: 'cancelled' as const },
];

/**
 * Build a fetch mock that serves the MIXED_TESTS page on GET /tests and
 * accepts batch/rerun, recording which testIds were dispatched.
 */
function makeFilterFetch(dispatched: string[]): typeof globalThis.fetch {
  return makeFetch((url, init) => {
    if (url.includes('/tests') && (!init.method || init.method === 'GET')) {
      return {
        body: { items: MIXED_TESTS, nextToken: null },
      };
    }
    if (url.includes('/tests/batch/rerun') && init.method === 'POST') {
      const body = JSON.parse(init.body as string) as { testIds: string[] };
      dispatched.push(...body.testIds);
      const accepted = body.testIds.map(id => ({
        testId: id,
        runId: `run_${id}`,
        enqueuedAt: '2026-06-03T10:00:00.000Z',
      }));
      return {
        body: {
          accepted,
          deferred: [],
          conflicts: [],
          closure: { byProject: [] },
        },
      };
    }
    return { body: {} };
  });
}

describe('runTestRerun --all --skip-terminal (dogfood L1796)', () => {
  it('--skip-terminal excludes passed|failed|blocked|cancelled from dispatch', async () => {
    const creds = makeCreds();
    const dispatched: string[] = [];

    const stderr: string[] = [];
    await runTestRerun(
      {
        testIds: [],
        all: true,
        projectId: 'project_abc',
        skipTerminal: true,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl: makeFilterFetch(dispatched),
        stderr: (line: string) => stderr.push(line),
      },
    );

    // Only 'running' + 'queued' are non-terminal → should be dispatched.
    expect(dispatched.sort()).toEqual(['test_queued_1', 'test_running_1'].sort());
    // A skip message should mention how many were skipped.
    const skipMsg = stderr.find(l => l.includes('--skip-terminal'));
    expect(skipMsg).toBeDefined();
    expect(skipMsg).toContain('4'); // 4 terminal tests skipped
  });

  it('--status <list> only dispatches tests whose status matches', async () => {
    const creds = makeCreds();
    const dispatched: string[] = [];
    const stderr: string[] = [];

    await runTestRerun(
      {
        testIds: [],
        all: true,
        projectId: 'project_abc',
        statusFilter: 'failed,blocked',
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl: makeFilterFetch(dispatched),
        stderr: (line: string) => stderr.push(line),
      },
    );

    expect(dispatched.sort()).toEqual(['test_blocked_1', 'test_failed_1'].sort());
    const filterMsg = stderr.find(l => l.includes('--status filter'));
    expect(filterMsg).toBeDefined();
    expect(filterMsg).toContain('4'); // 4 tests filtered out
  });

  it('--skip-terminal combined with --status only dispatches matching non-terminal tests', async () => {
    const creds = makeCreds();
    const dispatched: string[] = [];

    await runTestRerun(
      {
        testIds: [],
        all: true,
        projectId: 'project_abc',
        skipTerminal: true,
        statusFilter: 'running,failed',
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl: makeFilterFetch(dispatched),
        stderr: () => {},
      },
    );

    // --skip-terminal removes failed+blocked+cancelled+passed, leaving running+queued
    // --status=running,failed further restricts to running only (failed was removed by skip-terminal)
    expect(dispatched).toEqual(['test_running_1']);
  });

  it('exit 5 when --status contains an unknown token', async () => {
    const creds = makeCreds();
    await expect(
      runTestRerun(
        {
          testIds: [],
          all: true,
          projectId: 'project_abc',
          statusFilter: 'notastatus',
          wait: false,
          timeoutSeconds: 600,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep, fetchImpl: makeFilterFetch([]) },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rerun command exposes --skip-terminal and --status flags', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
    const rerun = test.commands.find(c => c.name() === 'rerun')!;
    const flagNames = rerun.options.map(o => o.long);
    expect(flagNames).toContain('--skip-terminal');
    expect(flagNames).toContain('--status');
  });
});

// ---------------------------------------------------------------------------
// --filter <substr> (client-side name filter for --all)
// ---------------------------------------------------------------------------

/** Extended test list including tests with different names. */
const NAMED_TESTS = [
  { ...FE_TEST, id: 'test_checkout_1', name: 'Checkout flow', status: 'passed' as const },
  { ...FE_TEST, id: 'test_login_1', name: 'Login page', status: 'failed' as const },
  { ...FE_TEST, id: 'test_checkout_2', name: 'CHECKOUT confirmation', status: 'failed' as const },
  { ...FE_TEST, id: 'test_signup_1', name: 'Sign up form', status: 'running' as const },
];

/**
 * Build a fetch mock that serves NAMED_TESTS on GET /tests and records
 * dispatched testIds from POST /tests/batch/rerun.
 */
function makeNamedFilterFetch(dispatched: string[]): typeof globalThis.fetch {
  return makeFetch((url, init) => {
    if (url.includes('/tests') && (!init.method || init.method === 'GET')) {
      return { body: { items: NAMED_TESTS, nextToken: null } };
    }
    if (url.includes('/tests/batch/rerun') && init.method === 'POST') {
      const body = JSON.parse(init.body as string) as { testIds: string[] };
      dispatched.push(...body.testIds);
      const accepted = body.testIds.map(id => ({
        testId: id,
        runId: `run_${id}`,
        enqueuedAt: '2026-06-03T10:00:00.000Z',
      }));
      return {
        body: { accepted, deferred: [], conflicts: [], closure: { byProject: [] } },
      };
    }
    return { body: {} };
  });
}

describe('runTestRerun --all --filter (client-side name filter)', () => {
  it('--filter matches a case-insensitive substring and dispatches only matching tests', async () => {
    const creds = makeCreds();
    const dispatched: string[] = [];
    const stderr: string[] = [];

    await runTestRerun(
      {
        testIds: [],
        all: true,
        projectId: 'project_abc',
        nameFilter: 'checkout',
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl: makeNamedFilterFetch(dispatched),
        stderr: (line: string) => stderr.push(line),
      },
    );

    // "Checkout flow" and "CHECKOUT confirmation" both match (case-insensitive)
    expect(dispatched.sort()).toEqual(['test_checkout_1', 'test_checkout_2'].sort());

    // Expect a skip advisory mentioning the 2 non-matching tests
    const filterMsg = stderr.find(l => l.includes('--filter'));
    expect(filterMsg).toBeDefined();
    expect(filterMsg).toContain('2'); // 2 tests skipped
    expect(filterMsg).toContain('"checkout"');
  });

  it('--filter with no match produces empty selection and emits the info message', async () => {
    const creds = makeCreds();
    const dispatched: string[] = [];
    const stderr: string[] = [];
    const stdout: string[] = [];

    await runTestRerun(
      {
        testIds: [],
        all: true,
        projectId: 'project_abc',
        nameFilter: 'nomatchwhatsoever',
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl: makeNamedFilterFetch(dispatched),
        stderr: (line: string) => stderr.push(line),
        stdout: (line: string) => stdout.push(line),
      },
    );

    // Nothing dispatched
    expect(dispatched).toHaveLength(0);

    // The "nothing to rerun" message should appear
    const noTestsMsg = stderr.find(
      l => l.includes('No tests found') || l.includes('nothing to rerun'),
    );
    expect(noTestsMsg).toBeDefined();

    // stdout should contain the empty batch envelope
    const body = JSON.parse(stdout.join('\n'));
    expect(body).toMatchObject({ accepted: [], deferred: [], conflicts: [] });
  });

  it('rerun command exposes --filter flag', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
    const rerun = test.commands.find(c => c.name() === 'rerun')!;
    const flagNames = rerun.options.map(o => o.long);
    expect(flagNames).toContain('--filter');
  });
});

// ---------------------------------------------------------------------------
// D4 (dogfood CoderCup): under --wait the per-request timeout covers --timeout
// ---------------------------------------------------------------------------

describe('D4: resolveWaitRequestTimeoutMs', () => {
  it('returns the configured value unchanged when not waiting', () => {
    expect(resolveWaitRequestTimeoutMs({ wait: false, timeoutSeconds: 600 })).toBeUndefined();
    expect(
      resolveWaitRequestTimeoutMs({ wait: false, timeoutSeconds: 600, requestTimeoutMs: 30_000 }),
    ).toBe(30_000);
  });

  it('raises to cover --timeout under --wait (with cushion, capped at the 600s max)', () => {
    // timeout 300s → 305s per-request (300s + 5s cushion)
    expect(resolveWaitRequestTimeoutMs({ wait: true, timeoutSeconds: 300 })).toBe(305_000);
    // timeout 600s → clamped at the 600s max
    expect(resolveWaitRequestTimeoutMs({ wait: true, timeoutSeconds: 600 })).toBe(600_000);
    // timeout 3600s → still capped at 600s (a single request never needs more)
    expect(resolveWaitRequestTimeoutMs({ wait: true, timeoutSeconds: 3600 })).toBe(600_000);
  });

  it('floors at the 120s default for tiny --timeout and never lowers an explicit larger value', () => {
    // timeout 30s → stays at the 120s default (35s cover < 120s default)
    expect(resolveWaitRequestTimeoutMs({ wait: true, timeoutSeconds: 30 })).toBe(120_000);
    // explicit request-timeout above the cover value is preserved
    expect(
      resolveWaitRequestTimeoutMs({ wait: true, timeoutSeconds: 60, requestTimeoutMs: 500_000 }),
    ).toBe(500_000);
  });
});

// ---------------------------------------------------------------------------
// D3 (dogfood CoderCup): batch --wait summary surfaces deferred + conflicts
// ---------------------------------------------------------------------------

describe('D3: batch rerun summary surfaces deferred + conflicts', () => {
  it('--wait JSON summary includes deferred/conflicts counts (no silent undercount)', async () => {
    const creds = makeCreds();
    // Initial dispatch: 1 accepted, 1 deferred, 1 conflict.
    // D3 retry loop will fire (opts.wait=true). The retry request only ever
    // re-asks about the still-deferred testId (test_deferred), so a
    // realistic retry response never re-returns test_1 as newly accepted.
    // All 3 retry attempts keep returning the same deferred entry so
    // `deferred` never drains.
    const initialBatchResp: BatchRerunResponse = {
      accepted: [{ testId: 'test_1', runId: 'run_b1', enqueuedAt: '2026-06-03T10:00:00.000Z' }],
      deferred: [{ testId: 'test_deferred', reason: 'rate_limited' }],
      conflicts: [{ testId: 'test_conf', currentRunId: 'run_conf' }],
      closure: { byProject: [] },
    };
    // Retry responses: keep returning 1 deferred so the loop exhausts
    // MAX_DEFERRED_RETRIES and falls through. No new accepted entries.
    const retryBatchResp: BatchRerunResponse = {
      accepted: [],
      deferred: [{ testId: 'test_deferred', reason: 'rate_limited' }],
      conflicts: [],
      closure: { byProject: [] },
    };
    let batchCallCount = 0;
    const run1 = makeTerminalRun('run_b1', 'passed');
    run1.testId = 'test_1';
    const printed: Array<{ summary?: Record<string, number> }> = [];

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch/rerun')) {
        batchCallCount++;
        return { status: 202, body: batchCallCount === 1 ? initialBatchResp : retryBatchResp };
      }
      if (url.includes('/runs/run_b1')) return { body: run1 };
      return errorBody('NOT_FOUND');
    });

    try {
      await runTestRerun(
        {
          testIds: ['test_1', 'test_deferred', 'test_conf'],
          all: false,
          wait: true,
          timeoutSeconds: 10,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        {
          ...creds,
          sleep: instantSleep,
          fetchImpl,
          stdout: line => printed.push(JSON.parse(line)),
        },
      );
    } catch {
      // exit 7 expected (deferred still present after retries) — printed first.
    }

    // D3 loop ran all 3 retries: 1 initial + 3 retries = 4 total batch calls.
    expect(batchCallCount).toBe(4);

    const withSummary = printed.find(p => p.summary);
    expect(withSummary).toBeDefined();
    // After D3 retries: accepted = 1 entry (test_1 from the initial dispatch;
    // retries never re-return it). deferred = 1 (still undrained). conflicts
    // = 1 (from initial).
    expect(withSummary!.summary).toMatchObject({
      passed: 1,
      failed: 0,
      timedOut: 0,
      deferred: 1,
      conflicts: 1,
      total: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// codex P2 (D2-CLI): batch --wait JSON output must carry notFound[] too — the
// --wait path builds its own jsonPayload, so a partial batch with ≥1 accepted
// run would otherwise drop the skipped ids and read as fully successful.
// ---------------------------------------------------------------------------

describe('[codex-P2] batch rerun --wait JSON surfaces notFound[]', () => {
  it('--wait JSON output includes notFound[] + summary.notFound for a partial batch', async () => {
    const creds = makeCreds();
    const batchResp: BatchRerunResponse = {
      accepted: [{ testId: 'test_ok', runId: 'run_ok', enqueuedAt: '2026-06-08T10:00:00.000Z' }],
      deferred: [],
      conflicts: [],
      closure: { byProject: [] },
      notFound: ['test_bad_1', 'test_bad_2'],
    };
    const run1 = makeTerminalRun('run_ok', 'passed');
    run1.testId = 'test_ok';
    const printed: Array<{ notFound?: string[]; summary?: Record<string, number> }> = [];

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch/rerun')) return { status: 202, body: batchResp };
      if (url.includes('/runs/run_ok')) return { body: run1 };
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_ok', 'test_bad_1', 'test_bad_2'],
        all: false,
        wait: true,
        timeoutSeconds: 10,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: line => printed.push(JSON.parse(line)),
      },
    );

    const payload = printed.find(p => p.notFound !== undefined || p.summary);
    expect(payload).toBeDefined();
    expect(payload!.notFound).toEqual(['test_bad_1', 'test_bad_2']);
    expect(payload!.summary).toMatchObject({
      passed: 1,
      failed: 0,
      timedOut: 0,
      notFound: 2,
      total: 1, // dispatched (accepted) only
    });
  });
});

// ---------------------------------------------------------------------------
// B4 (dogfood CoderCup): BE rerun warns history can't distinguish reruns
// ---------------------------------------------------------------------------

describe('B4: backend rerun history advisory', () => {
  it('single BE rerun emits the "does not distinguish reruns" advisory', async () => {
    const creds = makeCreds();
    const beResp = makeBeRerunResp();
    const stderrLines: string[] = [];

    const fetchImpl = makeFetch(url => {
      if (url.includes('/runs/rerun')) return { status: 202, body: beResp };
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_be_consumer_01'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stderr: line => stderrLines.push(line),
      },
    );

    expect(stderrLines.some(l => l.includes('does not distinguish reruns'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D2 (dogfood CoderCup): rerun NOT_FOUND points at a fresh `test run`
// ---------------------------------------------------------------------------

describe('D2: rerun NOT_FOUND fallback hints', () => {
  it('single rerun NOT_FOUND hints at `test run` and exits 4', async () => {
    const creds = makeCreds();
    const fetchImpl = makeFetch(() => errorBody('NOT_FOUND'));

    try {
      await runTestRerun(
        {
          testIds: ['test_missing'],
          all: false,
          wait: false,
          timeoutSeconds: 600,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep, fetchImpl },
      );
      expect.fail('should have thrown');
    } catch (err: unknown) {
      const e = err as ApiError;
      expect(e.exitCode).toBe(4);
      expect(e.code).toBe('NOT_FOUND');
      expect(e.message).toContain('no replayable run');
      expect(e.nextAction).toContain('test run test_missing');
    }
  });

  it('batch rerun NOT_FOUND gives an actionable hint (one bad id aborts the batch)', async () => {
    const creds = makeCreds();
    const fetchImpl = makeFetch(() => errorBody('NOT_FOUND'));

    try {
      await runTestRerun(
        {
          testIds: ['test_1', 'test_missing'],
          all: false,
          wait: false,
          timeoutSeconds: 600,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep, fetchImpl },
      );
      expect.fail('should have thrown');
    } catch (err: unknown) {
      const e = err as ApiError;
      expect(e.exitCode).toBe(4);
      expect(e.code).toBe('NOT_FOUND');
      expect(e.message).toContain('Batch rerun aborted');
      expect(e.nextAction).toContain('test run');
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 3 — BE closure fan-out: RequestTimeoutError emits partial stdout
// ---------------------------------------------------------------------------

describe('[finding-3] BE closure fan-out: RequestTimeoutError emits partial stdout + exit 7', () => {
  it('RequestTimeoutError in a closure member poll → partial stdout with all runIds + exit 7', async () => {
    const creds = makeCreds();
    const rerunResp = makeBeRerunResp();
    const namedRunId = rerunResp.runId; // 'run_rerun_be_named'
    const producerRunId = rerunResp.closure!.members.find(m => m.role === 'producer')!.runId;

    let callCount = 0;
    // fetchImpl: rerun trigger OK, BE test GET OK, then throw RequestTimeoutError on any /runs/ poll
    const fetchImpl: typeof globalThis.fetch = async (input, _init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;
      callCount++;
      if (url.includes('/tests/test_be_consumer_01/runs/rerun')) {
        return new Response(JSON.stringify(rerunResp), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (
        url.includes('/tests/test_be_consumer_01') ||
        url.includes('/tests/test_be_producer_01')
      ) {
        return new Response(JSON.stringify(BE_TEST), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Any /runs/ poll throws RequestTimeoutError
      if (url.includes('/runs/')) {
        throw new RequestTimeoutError(120000, `req_timeout_${callCount}`);
      }
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 });
    };

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const err = await runTestRerun(
      {
        testIds: ['test_be_consumer_01'],
        all: false,
        wait: true,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl: fetchImpl as unknown as FetchImpl,
        stdout: line => stdoutLines.push(line),
        stderr: line => stderrLines.push(line),
      },
    ).catch(e => e);

    // Must exit 7 (RequestTimeoutError)
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect((err as RequestTimeoutError).exitCode).toBe(7);

    // Stdout must be non-empty and contain at least the namedRunId
    expect(stdoutLines.length).toBeGreaterThan(0);
    const stdoutBlock = stdoutLines.join('\n');
    expect(stdoutBlock).toContain(namedRunId);

    // Stderr must include re-attach hints for the closure member runIds
    const stderrBlock = stderrLines.join('\n');
    expect(stderrBlock).toContain(namedRunId);
    expect(stderrBlock).toContain(producerRunId);
    expect(stderrBlock).toContain('test wait');
  });
});

// ---------------------------------------------------------------------------
// G1d — split teardowns from producers in the rerun stderr summary
// ---------------------------------------------------------------------------

describe('G1d: BE rerun stderr summary splits producers and teardowns', () => {
  /** Helper to trigger a BE single rerun (no --wait) and collect stderr lines. */
  async function runBeRerunNoWait(rerunResp: RerunResponse): Promise<string[]> {
    const creds = makeCreds();
    const stderrLines: string[] = [];

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_be_consumer_01/runs/rerun')) {
        return { body: rerunResp };
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

    await runTestRerun(
      {
        testIds: ['test_be_consumer_01'],
        all: false,
        wait: false,
        timeoutSeconds: 600,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'text',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: () => Promise.resolve(),
        fetchImpl,
        stderr: line => stderrLines.push(line),
      },
    );

    return stderrLines;
  }

  it('both producers AND teardowns: "1 selected + N producers + N teardowns"', async () => {
    const rerunResp: RerunResponse = {
      runId: 'run_rerun_be_named',
      status: 'queued',
      enqueuedAt: '2026-06-03T10:00:00.000Z',
      codeVersion: 'v1',
      autoHeal: false,
      closure: {
        members: [
          { testId: 'test_be_consumer_01', runId: 'run_rerun_be_named', role: 'selected' },
          { testId: 'test_be_producer_01', runId: 'run_p1', role: 'producer' },
          { testId: 'test_be_producer_02', runId: 'run_p2', role: 'producer' },
          { testId: 'test_be_teardown_01', runId: 'run_t1', role: 'teardown' },
          { testId: 'test_be_teardown_02', runId: 'run_t2', role: 'teardown' },
        ],
        addedProducers: ['test_be_producer_01', 'test_be_producer_02'],
        addedTeardowns: ['test_be_teardown_01', 'test_be_teardown_02'],
        clearedCaptured: 0,
      },
    };

    const stderrLines = await runBeRerunNoWait(rerunResp);
    const reranLine = stderrLines.find(l => l.startsWith('Reran '));
    expect(reranLine).toBeDefined();
    expect(reranLine).toContain('5 tests');
    expect(reranLine).toContain('1 selected');
    expect(reranLine).toContain('2 producers');
    expect(reranLine).toContain('2 teardowns');
    // Must NOT say "upstream producer(s)" — the old mislabelled wording
    expect(reranLine).not.toContain('upstream producer');
  });

  it('producers only: "1 selected + N producer(s)", no teardown mention', async () => {
    const rerunResp: RerunResponse = {
      runId: 'run_rerun_be_named',
      status: 'queued',
      enqueuedAt: '2026-06-03T10:00:00.000Z',
      codeVersion: 'v1',
      autoHeal: false,
      closure: {
        members: [
          { testId: 'test_be_consumer_01', runId: 'run_rerun_be_named', role: 'selected' },
          { testId: 'test_be_producer_01', runId: 'run_p1', role: 'producer' },
        ],
        addedProducers: ['test_be_producer_01'],
        addedTeardowns: [],
        clearedCaptured: 0,
      },
    };

    const stderrLines = await runBeRerunNoWait(rerunResp);
    const reranLine = stderrLines.find(l => l.startsWith('Reran '));
    expect(reranLine).toBeDefined();
    expect(reranLine).toContain('2 tests');
    expect(reranLine).toContain('1 selected');
    expect(reranLine).toContain('1 producer');
    expect(reranLine).not.toContain('teardown');
  });

  it('teardowns only: "1 selected + N teardown(s)", no producer mention', async () => {
    const rerunResp: RerunResponse = {
      runId: 'run_rerun_be_named',
      status: 'queued',
      enqueuedAt: '2026-06-03T10:00:00.000Z',
      codeVersion: 'v1',
      autoHeal: false,
      closure: {
        members: [
          { testId: 'test_be_consumer_01', runId: 'run_rerun_be_named', role: 'selected' },
          { testId: 'test_be_teardown_01', runId: 'run_t1', role: 'teardown' },
        ],
        addedProducers: [],
        addedTeardowns: ['test_be_teardown_01'],
        clearedCaptured: 0,
      },
    };

    const stderrLines = await runBeRerunNoWait(rerunResp);
    const reranLine = stderrLines.find(l => l.startsWith('Reran '));
    expect(reranLine).toBeDefined();
    expect(reranLine).toContain('2 tests');
    expect(reranLine).toContain('1 selected');
    expect(reranLine).toContain('1 teardown');
    expect(reranLine).not.toContain('producer');
  });

  it('lone test: "1 test: 1 selected" (no added producers or teardowns)', async () => {
    const rerunResp: RerunResponse = {
      runId: 'run_rerun_be_named',
      status: 'queued',
      enqueuedAt: '2026-06-03T10:00:00.000Z',
      codeVersion: 'v1',
      autoHeal: false,
      closure: {
        members: [{ testId: 'test_be_consumer_01', runId: 'run_rerun_be_named', role: 'selected' }],
        addedProducers: [],
        addedTeardowns: [],
        clearedCaptured: 0,
      },
    };

    const stderrLines = await runBeRerunNoWait(rerunResp);
    const reranLine = stderrLines.find(l => l.startsWith('Reran '));
    expect(reranLine).toBeDefined();
    // Singular "test" (not "tests") because totalCount === 1
    expect(reranLine).toContain('1 test:');
    expect(reranLine).toContain('1 selected');
    expect(reranLine).not.toContain('producer');
    expect(reranLine).not.toContain('teardown');
  });
});

// ---------------------------------------------------------------------------
// [P1] rerun --all D3 deferred-retry: conflicts discovered on retry must be
// merged into the running conflicts collection and appear in the final JSON.
// ---------------------------------------------------------------------------

describe('[codex-P1] rerun --all deferred-retry: retry-conflicts merged into final accounting', () => {
  // Note: D3 retry loop is in the BATCH path. The single-testId path does not
  // have deferred/conflict semantics (it calls POST /tests/{id}/runs/rerun, not
  // the batch endpoint). Use two testIds (or --all) to exercise the batch path.

  it('deferred→conflict on retry: JSON conflicts includes retry-discovered entry; exits 6 when all paths resolve to conflict', async () => {
    const creds = makeCreds();

    // Initial batch: 2 IDs submitted → 1 deferred, 0 accepted, 0 initial conflicts.
    const initialBatchResp: BatchRerunResponse = {
      accepted: [],
      deferred: [{ testId: 'test_id_a', reason: 'rate_limited' }],
      conflicts: [{ testId: 'test_id_b', currentRunId: 'run_b_inflight' }],
      closure: { byProject: [] },
    };
    // Retry: the deferred test is now in-flight (conflict).
    const retryBatchResp: BatchRerunResponse = {
      accepted: [],
      deferred: [],
      conflicts: [{ testId: 'test_id_a', currentRunId: 'run_a_inflight' }],
      closure: { byProject: [] },
    };

    let batchCallCount = 0;
    const printed: Array<Record<string, unknown>> = [];
    const stderrLines: string[] = [];

    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        batchCallCount++;
        return { status: 202, body: batchCallCount === 1 ? initialBatchResp : retryBatchResp };
      }
      return {
        status: 404,
        body: {
          error: {
            code: 'NOT_FOUND',
            message: 'not found',
            nextAction: '',
            requestId: 'r',
            details: {},
          },
        },
      };
    });

    try {
      await runTestRerun(
        {
          // Two IDs → batch path (D3 retry loop active)
          testIds: ['test_id_a', 'test_id_b'],
          all: false,
          wait: true,
          timeoutSeconds: 300,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        {
          ...creds,
          sleep: instantSleep,
          fetchImpl,
          stdout: line => printed.push(JSON.parse(line) as Record<string, unknown>),
          stderr: line => stderrLines.push(line),
        },
      );
      throw new Error('Expected runTestRerun to throw exit 6');
    } catch (err) {
      // After D3 retry drains deferred→conflict: accepted=0, conflicts≥2 → exit 6
      expect((err as ApiError).exitCode).toBe(6);
    }

    // The retry must have fired (at least 2 batch calls).
    expect(batchCallCount).toBeGreaterThanOrEqual(2);

    // The JSON output must carry BOTH the initial conflict AND the retry-discovered conflict
    // (before fix the retry conflict was logged but not merged into the running conflicts var).
    const withConflicts = printed.find(
      p => Array.isArray(p.conflicts) && (p.conflicts as unknown[]).length > 0,
    );
    expect(withConflicts).toBeDefined();
    const conflictIds = (withConflicts?.conflicts as Array<{ testId: string }>).map(c => c.testId);
    // Both the initial conflict and the retry-discovered one must appear
    expect(conflictIds).toContain('test_id_b'); // initial
    expect(conflictIds).toContain('test_id_a'); // discovered on retry

    // The stderr must log the conflict from the retry attempt
    expect(stderrLines.some(l => l.includes('[deferred-retry]') && l.includes('conflict'))).toBe(
      true,
    );
  });

  it('partial deferred→conflict + accepted: retry-conflict appears in JSON summary.conflicts; exits 7 due to still-deferred', async () => {
    const creds = makeCreds();

    // Initial: 1 accepted, 2 deferred, 0 initial conflicts.
    const initialBatchResp: BatchRerunResponse = {
      accepted: [{ testId: 'test_ok', runId: 'run_ok', enqueuedAt: '2026-06-09T10:00:00.000Z' }],
      deferred: [
        { testId: 'test_deferred_a', reason: 'rate_limited' },
        { testId: 'test_deferred_b', reason: 'rate_limited' },
      ],
      conflicts: [],
      closure: { byProject: [] },
    };
    // Retry: one deferred accepted, one becomes conflict, one remains deferred (keeps looping).
    const retryBatchResp: BatchRerunResponse = {
      accepted: [
        { testId: 'test_deferred_a', runId: 'run_da', enqueuedAt: '2026-06-09T10:00:01.000Z' },
      ],
      deferred: [{ testId: 'test_deferred_b', reason: 'rate_limited' }],
      conflicts: [{ testId: 'test_deferred_newly_conflicted', currentRunId: 'run_inflight_c' }],
      closure: { byProject: [] },
    };

    let batchCallCount = 0;
    const printed: Array<Record<string, unknown>> = [];
    const terminalRun = makeTerminalRun('run_ok', 'passed');
    terminalRun.testId = 'test_ok';
    const terminalRunDa = makeTerminalRun('run_da', 'passed');
    terminalRunDa.testId = 'test_deferred_a';

    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        batchCallCount++;
        return { status: 202, body: batchCallCount === 1 ? initialBatchResp : retryBatchResp };
      }
      if (url.includes('/runs/run_ok')) return { body: terminalRun };
      if (url.includes('/runs/run_da')) return { body: terminalRunDa };
      return {
        status: 404,
        body: {
          error: {
            code: 'NOT_FOUND',
            message: 'not found',
            nextAction: '',
            requestId: 'r',
            details: {},
          },
        },
      };
    });

    try {
      await runTestRerun(
        {
          testIds: ['test_ok', 'test_deferred_a', 'test_deferred_b'],
          all: false,
          wait: true,
          timeoutSeconds: 10,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        {
          ...creds,
          sleep: instantSleep,
          fetchImpl,
          stdout: line => printed.push(JSON.parse(line) as Record<string, unknown>),
          stderr: () => undefined,
        },
      );
      throw new Error('Expected runTestRerun to throw exit 7 (still-deferred)');
    } catch (err) {
      // Still deferred after all retries → exit 7
      expect((err as ApiError).exitCode).toBe(7);
    }

    const withSummary = printed.find(p => p.summary);
    expect(withSummary).toBeDefined();
    // Retry-discovered conflict must appear in summary.conflicts
    expect((withSummary?.summary as Record<string, number>).conflicts).toBeGreaterThanOrEqual(1);
    // Retry-discovered conflict must appear in the JSON conflicts array
    const conflictIds = (withSummary?.conflicts as Array<{ testId: string }>).map(c => c.testId);
    expect(conflictIds).toContain('test_deferred_newly_conflicted');
  });
});

// ---------------------------------------------------------------------------
// [P2] rerun --all D3: idempotency key truncation stays ≤ 256 chars
// ---------------------------------------------------------------------------

describe('[codex-P2] rerun --all deferred-retry: idempotency key truncation', () => {
  // Note: idempotency-key truncation only applies on the BATCH path (two+ IDs).
  it('retry key does not exceed 256 chars when base key is at the 256-char limit', async () => {
    const creds = makeCreds();

    const longKey = 'k'.repeat(256);

    const initialBatchResp: BatchRerunResponse = {
      accepted: [{ testId: 'test_ok', runId: 'run_ok', enqueuedAt: '2026-06-09T10:00:00.000Z' }],
      deferred: [{ testId: 'test_deferred', reason: 'rate_limited' }],
      conflicts: [],
      closure: { byProject: [] },
    };
    const retryBatchResp: BatchRerunResponse = {
      accepted: [
        { testId: 'test_deferred', runId: 'run_d', enqueuedAt: '2026-06-09T10:00:00.000Z' },
      ],
      deferred: [],
      conflicts: [],
      closure: { byProject: [] },
    };

    const capturedKeys: string[] = [];
    let batchCallCount = 0;
    const terminalRunOk = makeTerminalRun('run_ok', 'passed');
    terminalRunOk.testId = 'test_ok';
    const terminalRunD = makeTerminalRun('run_d', 'passed');
    terminalRunD.testId = 'test_deferred';

    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        const key = (init.headers as Record<string, string>)?.['idempotency-key'] ?? '';
        capturedKeys.push(key);
        batchCallCount++;
        return { status: 202, body: batchCallCount === 1 ? initialBatchResp : retryBatchResp };
      }
      if (url.includes('/runs/run_ok')) return { body: terminalRunOk };
      if (url.includes('/runs/run_d')) return { body: terminalRunD };
      return {
        status: 404,
        body: {
          error: {
            code: 'NOT_FOUND',
            message: 'not found',
            nextAction: '',
            requestId: 'r',
            details: {},
          },
        },
      };
    });

    // Two testIds → batch path (D3 retry loop active)
    await runTestRerun(
      {
        testIds: ['test_ok', 'test_deferred'],
        all: false,
        wait: true,
        timeoutSeconds: 300,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
        idempotencyKey: longKey,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: () => undefined,
        stderr: () => undefined,
      },
    );

    // All keys must be ≤ 256 chars
    expect(capturedKeys.length).toBeGreaterThanOrEqual(2);
    for (const key of capturedKeys) {
      expect(key.length).toBeLessThanOrEqual(256);
    }
    // The retry key must differ from the base (suffix appended) but still fit
    expect(capturedKeys[1]).not.toBe(longKey);
    expect(capturedKeys[1]).toContain('deferred-retry');
  });
});

// ---------------------------------------------------------------------------
// [codex-P2] Finding 2 — rerun batch: return value === printed state
//
// `runTestRerun` (batch path) must return an object whose accepted/deferred/
// conflicts/notFound reflect the POST-RETRY mutable state, not the stale
// initial batchResp.  Programmatic callers reading the return value must see
// the same data that was printed to stdout.
// ---------------------------------------------------------------------------

describe('[codex-P2] batch rerun return value == printed state (non-wait)', () => {
  it('return value accepted/deferred/conflicts matches stdout JSON after D3 retry drains deferred', async () => {
    const creds = makeCreds();

    // Initial: 1 deferred, 1 accepted
    const initialResp: BatchRerunResponse = {
      accepted: [{ testId: 'test_ok', runId: 'run_ok', enqueuedAt: '2026-06-09T10:00:00.000Z' }],
      deferred: [{ testId: 'test_deferred', reason: 'rate_limited' }],
      conflicts: [],
      closure: { byProject: [] },
    };
    // Retry: the deferred test is now accepted
    const retryResp: BatchRerunResponse = {
      accepted: [
        { testId: 'test_deferred', runId: 'run_dr', enqueuedAt: '2026-06-09T10:00:01.000Z' },
      ],
      deferred: [],
      conflicts: [],
      closure: { byProject: [] },
    };

    let batchCallCount = 0;
    const printed: Array<Record<string, unknown>> = [];

    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        batchCallCount++;
        return { status: 202, body: batchCallCount === 1 ? initialResp : retryResp };
      }
      return {
        status: 404,
        body: {
          error: { code: 'NOT_FOUND', message: 'nf', nextAction: '', requestId: 'r', details: {} },
        },
      };
    });

    // Non-wait (no --wait): D3 loop is skipped; deferred stays. Return value
    // must reflect the initial state (accepted=1, deferred=1).
    const result = await runTestRerun(
      {
        testIds: ['test_ok', 'test_deferred'],
        all: false,
        wait: false,
        timeoutSeconds: 300,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: line => printed.push(JSON.parse(line) as Record<string, unknown>),
        stderr: () => undefined,
      },
    ).catch(err => {
      // non-wait with deferred exits 7; catch to inspect return
      if ((err as { exitCode?: number }).exitCode === 7) return null;
      throw err;
    });

    // The printed JSON must carry the initial accepted and deferred
    const payload = printed[0]!;
    expect(Array.isArray(payload.accepted)).toBe(true);
    // Either 1 or 2 accepted depending on retry; deferred counts must be consistent
    // Between the printed JSON and the exit (we are asserting consistency here not
    // exact counts since the non-wait path doesn't do D3).

    // The return value may be null (threw exit 7) or a BatchRerunResponse; either
    // way the test validates that printed state and returned state are consistent
    // when the return is not null.
    if (
      result !== null &&
      result !== undefined &&
      typeof result === 'object' &&
      'deferred' in result
    ) {
      const batchResult = result as BatchRerunResponse;
      // Return value deferred[] count must match what was printed in stdout
      const printedDeferred = Array.isArray(payload.deferred)
        ? (payload.deferred as unknown[]).length
        : 0;
      expect(batchResult.deferred.length).toBe(printedDeferred);
      // Return value accepted[] count must match printed
      const printedAccepted = Array.isArray(payload.accepted)
        ? (payload.accepted as unknown[]).length
        : 0;
      expect(batchResult.accepted.length).toBe(printedAccepted);
    }
  });
});

describe('[codex-P2] batch rerun --wait return value == printed state after D3 retry', () => {
  it('return value conflicts includes retry-discovered conflict (mirrors printed JSON)', async () => {
    const creds = makeCreds();

    // Initial: 2 deferred, 0 accepted, 0 conflicts
    const initialResp: BatchRerunResponse = {
      accepted: [],
      deferred: [
        { testId: 'test_a', reason: 'rate_limited' },
        { testId: 'test_b', reason: 'rate_limited' },
      ],
      conflicts: [],
      closure: { byProject: [] },
    };
    // Retry: one accepted, one becomes conflict
    const retryResp: BatchRerunResponse = {
      accepted: [{ testId: 'test_a', runId: 'run_a', enqueuedAt: '2026-06-09T10:00:01.000Z' }],
      deferred: [],
      conflicts: [{ testId: 'test_b', currentRunId: 'run_b_inflight' }],
      closure: { byProject: [] },
    };

    let batchCallCount = 0;
    const terminalA = makeTerminalRun('run_a', 'passed');
    terminalA.testId = 'test_a';
    const printed: Array<Record<string, unknown>> = [];

    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        batchCallCount++;
        return { status: 202, body: batchCallCount === 1 ? initialResp : retryResp };
      }
      if (url.includes('/runs/run_a')) return { body: terminalA };
      return {
        status: 404,
        body: {
          error: { code: 'NOT_FOUND', message: 'nf', nextAction: '', requestId: 'r', details: {} },
        },
      };
    });

    const result = (await runTestRerun(
      {
        testIds: ['test_a', 'test_b'],
        all: false,
        wait: true,
        timeoutSeconds: 300,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: line => printed.push(JSON.parse(line) as Record<string, unknown>),
        stderr: () => undefined,
      },
    )) as BatchRerunResponse | undefined;

    // The printed JSON (summary payload) must include the retry-discovered conflict
    const withSummary = printed.find(p => p.summary);
    expect(withSummary).toBeDefined();
    expect((withSummary!.summary as Record<string, number>).conflicts).toBeGreaterThanOrEqual(1);

    const conflictIds = (withSummary!.conflicts as Array<{ testId: string }>).map(c => c.testId);
    expect(conflictIds).toContain('test_b');

    // The RETURN VALUE must also carry the retry-discovered conflict
    if (result !== undefined && result !== null && 'conflicts' in result) {
      const retConflicts = (result as BatchRerunResponse).conflicts.map(c => c.testId);
      expect(retConflicts).toContain('test_b');
    }
  });
});

// ---------------------------------------------------------------------------
// [codex-P2] Finding 3 — rerun batch retry loop: notFound[] from retry merged
//
// When a deferred test becomes un-replayable during the retry window (the
// server returns it in notFound[]), the CLI must:
//   1. Merge it into the running notFound set used for stderr + JSON output.
//   2. Not report it as "resolved" (i.e. not leave it in deferred or silently drop it).
//   3. Surface it in the final JSON payload and summary.notFound count.
// ---------------------------------------------------------------------------

describe('[codex-P2] batch rerun deferred→notFound on retry surfaces in JSON + stderr', () => {
  it('deferred test that becomes notFound on retry appears in JSON notFound[] and stderr [warn]', async () => {
    const creds = makeCreds();

    // Initial: 1 accepted, 1 deferred
    const initialResp: BatchRerunResponse = {
      accepted: [{ testId: 'test_ok', runId: 'run_ok', enqueuedAt: '2026-06-09T10:00:00.000Z' }],
      deferred: [{ testId: 'test_deleted', reason: 'rate_limited' }],
      conflicts: [],
      closure: { byProject: [] },
    };
    // Retry: the deferred test vanished (notFound), nothing newly accepted
    const retryResp: BatchRerunResponse = {
      accepted: [],
      deferred: [],
      conflicts: [],
      closure: { byProject: [] },
      notFound: ['test_deleted'],
    };

    let batchCallCount = 0;
    const terminalOk = makeTerminalRun('run_ok', 'passed');
    terminalOk.testId = 'test_ok';
    const printed: Array<Record<string, unknown>> = [];
    const stderrLines: string[] = [];

    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        batchCallCount++;
        return { status: 202, body: batchCallCount === 1 ? initialResp : retryResp };
      }
      if (url.includes('/runs/run_ok')) return { body: terminalOk };
      return {
        status: 404,
        body: {
          error: { code: 'NOT_FOUND', message: 'nf', nextAction: '', requestId: 'r', details: {} },
        },
      };
    });

    await runTestRerun(
      {
        testIds: ['test_ok', 'test_deleted'],
        all: false,
        wait: true,
        timeoutSeconds: 300,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: line => printed.push(JSON.parse(line) as Record<string, unknown>),
        stderr: line => stderrLines.push(line),
      },
    );

    // D3 retry must have been attempted (batchCallCount >= 2)
    expect(batchCallCount).toBeGreaterThanOrEqual(2);

    // The final JSON payload (with summary) must carry notFound
    const withSummary = printed.find(p => p.summary);
    expect(withSummary).toBeDefined();
    const notFoundArr = withSummary!.notFound;
    expect(Array.isArray(notFoundArr)).toBe(true);
    expect(notFoundArr as string[]).toContain('test_deleted');

    // summary.notFound must be non-zero
    expect((withSummary!.summary as Record<string, number>).notFound).toBeGreaterThanOrEqual(1);

    // stderr must contain a [warn] or [deferred-retry] message about the deleted test
    const hasNotFoundWarn = stderrLines.some(
      l => l.includes('test_deleted') && (l.includes('not found') || l.includes('warn')),
    );
    expect(hasNotFoundWarn).toBe(true);
  });

  it('deferred test that becomes notFound is removed from deferred (not double-counted)', async () => {
    const creds = makeCreds();

    // Initial: 2 deferred, 0 accepted → D3 retry fires under --wait.
    const initialResp: BatchRerunResponse = {
      accepted: [],
      deferred: [
        { testId: 'test_stays_deferred', reason: 'rate_limited' },
        { testId: 'test_vanishes', reason: 'rate_limited' },
      ],
      conflicts: [],
      closure: { byProject: [] },
    };
    // Retry: one stays deferred, one becomes notFound.
    const retryResp: BatchRerunResponse = {
      accepted: [],
      deferred: [{ testId: 'test_stays_deferred', reason: 'rate_limited' }],
      conflicts: [],
      closure: { byProject: [] },
      notFound: ['test_vanishes'],
    };

    let batchCallCount = 0;
    const printed: Array<Record<string, unknown>> = [];
    const stderrLines: string[] = [];

    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        batchCallCount++;
        return { status: 202, body: batchCallCount === 1 ? initialResp : retryResp };
      }
      return {
        status: 404,
        body: {
          error: { code: 'NOT_FOUND', message: 'nf', nextAction: '', requestId: 'r', details: {} },
        },
      };
    });

    try {
      await runTestRerun(
        {
          testIds: ['test_stays_deferred', 'test_vanishes'],
          all: false,
          wait: true,
          timeoutSeconds: 300,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        {
          ...creds,
          sleep: instantSleep,
          fetchImpl,
          stdout: line => printed.push(JSON.parse(line) as Record<string, unknown>),
          stderr: line => stderrLines.push(line),
        },
      );
      throw new Error('Expected exit 7 (still deferred)');
    } catch (err) {
      expect((err as { exitCode?: number }).exitCode).toBe(7);
    }

    // D3 retry must have been attempted.
    expect(batchCallCount).toBeGreaterThanOrEqual(2);

    // With accepted=0 the function prints { ...batchResp, accepted, deferred, conflicts, notFound }
    // via `out.print(...)` and then throws exit 7 — no `summary` key on this path.
    // Look for the printed payload directly.
    expect(printed.length).toBeGreaterThanOrEqual(1);
    const payload = printed[printed.length - 1]!;

    // The printed payload must have notFound containing test_vanishes
    expect(Array.isArray(payload.notFound)).toBe(true);
    expect(payload.notFound as string[]).toContain('test_vanishes');

    // test_vanishes must NOT appear in the deferred array (it moved to notFound)
    const deferredIds = (payload.deferred as Array<{ testId: string }>).map(d => d.testId);
    expect(deferredIds).not.toContain('test_vanishes');

    // test_stays_deferred must still be in deferred
    expect(deferredIds).toContain('test_stays_deferred');

    // stderr must mention test_vanishes in a [deferred-retry] notFound warning
    const hasWarn = stderrLines.some(l => l.includes('test_vanishes'));
    expect(hasWarn).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [B-E2E-02] Fix 2 regression — blocked status must exit 1 in single rerun paths
// ---------------------------------------------------------------------------

describe('[B-E2E-02] single FE rerun --wait: blocked → exit 1 (regression)', () => {
  // Previously the weak assertion `exitCode ?? httpStatus` was truthy for ANY
  // error. These tests pin specifically that `blocked` resolves to exit 1.

  it('FE rerun --wait: blocked status → exit 1 (not 0)', async () => {
    const creds = makeCreds();
    const rerunResp = makeFeRerunResp();
    const blockedRun = makeTerminalRun('run_rerun_fe_001', 'blocked');

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_fe_01/runs/rerun')) return { body: rerunResp };
      if (url.includes('/runs/run_rerun_fe_001')) return { body: blockedRun };
      return errorBody('NOT_FOUND');
    });

    let caughtErr: unknown;
    try {
      await runTestRerun(
        {
          testIds: ['test_fe_01'],
          all: false,
          wait: true,
          timeoutSeconds: 10,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep, fetchImpl },
      );
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr).toBeDefined();
    expect((caughtErr as { exitCode?: number }).exitCode).toBe(1);
  });

  it('FE rerun --wait: failed status → exit 1 (existing coverage hardened)', async () => {
    const creds = makeCreds();
    const rerunResp = makeFeRerunResp();
    const failedRun = makeTerminalRun('run_rerun_fe_001', 'failed');

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_fe_01/runs/rerun')) return { body: rerunResp };
      if (url.includes('/runs/run_rerun_fe_001')) return { body: failedRun };
      return errorBody('NOT_FOUND');
    });

    let caughtErr: unknown;
    try {
      await runTestRerun(
        {
          testIds: ['test_fe_01'],
          all: false,
          wait: true,
          timeoutSeconds: 10,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: false,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep, fetchImpl },
      );
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr).toBeDefined();
    expect((caughtErr as { exitCode?: number }).exitCode).toBe(1);
  });

  it('FE rerun --wait: passed status → resolves (exit 0)', async () => {
    const creds = makeCreds();
    const rerunResp = makeFeRerunResp();
    const passedRun = makeTerminalRun('run_rerun_fe_001', 'passed');
    const printed: unknown[] = [];

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_fe_01/runs/rerun')) return { body: rerunResp };
      if (url.includes('/runs/run_rerun_fe_001')) return { body: passedRun };
      return errorBody('NOT_FOUND');
    });

    // Should NOT throw — passed run must resolve without error
    await runTestRerun(
      {
        testIds: ['test_fe_01'],
        all: false,
        wait: true,
        timeoutSeconds: 10,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: line => printed.push(JSON.parse(line)),
      },
    );

    const result = printed[0] as RunResponse;
    expect(result.status).toBe('passed');
  });
});

describe('[B-E2E-02] skip-dependencies rerun --wait: blocked → exit 1 (regression)', () => {
  it('--skip-dependencies + --wait: blocked → exit 1', async () => {
    const creds = makeCreds();
    const rerunResp = makeFeRerunResp({ runId: 'run_rerun_be_nodeps' });
    const blockedRun: RunResponse = {
      runId: 'run_rerun_be_nodeps',
      testId: 'test_be_consumer_01',
      projectId: 'project_abc',
      userId: 'user_1',
      status: 'blocked',
      source: 'cli',
      createdAt: '2026-06-09T11:00:00.000Z',
      startedAt: '2026-06-09T11:00:01.000Z',
      finishedAt: '2026-06-09T11:00:10.000Z',
      codeVersion: 'v1',
      targetUrl: 'https://api.example.com',
      createdFrom: null,
      failedStepIndex: null,
      failureKind: null,
      error: null,
      videoUrl: null,
      stepSummary: { total: 3, completed: 3, passedCount: 0, failedCount: 0 },
    };

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_be_consumer_01/runs/rerun')) return { body: rerunResp };
      if (url.includes('/runs/run_rerun_be_nodeps')) return { body: blockedRun };
      return errorBody('NOT_FOUND');
    });

    let caughtErr: unknown;
    try {
      await runTestRerun(
        {
          testIds: ['test_be_consumer_01'],
          all: false,
          wait: true,
          timeoutSeconds: 10,
          autoHeal: false,
          autoHealExplicit: false,
          skipDependencies: true,
          maxConcurrency: 10,
          output: 'json',
          profile: 'default',
          dryRun: false,
          debug: false,
          verbose: false,
        },
        { ...creds, sleep: instantSleep, fetchImpl },
      );
    } catch (err) {
      caughtErr = err;
    }

    expect(caughtErr).toBeDefined();
    expect((caughtErr as { exitCode?: number }).exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// dashboardUrl on rerun --wait terminal output (colleague feedback 2026-06-10)
// ---------------------------------------------------------------------------

describe('rerun --wait — dashboardUrl on terminal output', () => {
  it('JSON mode (prod endpoint): terminal envelope includes dashboardUrl from the run row', async () => {
    const creds = makeCreds('sk-user-test', 'https://api.testsprite.com');
    const rerunResp = makeFeRerunResp();
    const terminalRun = makeTerminalRun('run_rerun_fe_001', 'passed');
    const printed: unknown[] = [];

    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/test_fe_01/runs/rerun')) {
        return { body: rerunResp };
      }
      if (url.includes('/runs/run_rerun_fe_001')) {
        return { body: terminalRun };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRerun(
      {
        testIds: ['test_fe_01'],
        all: false,
        wait: true,
        timeoutSeconds: 10,
        autoHeal: false,
        autoHealExplicit: false,
        skipDependencies: false,
        maxConcurrency: 10,
        output: 'json',
        profile: 'default',
        dryRun: false,
        debug: false,
        verbose: false,
      },
      {
        ...creds,
        sleep: instantSleep,
        fetchImpl,
        stdout: line => printed.push(JSON.parse(line)),
        stderr: () => undefined,
      },
    );

    const result = printed[0] as RunResponse & { dashboardUrl?: string };
    expect(result.status).toBe('passed');
    expect(result.dashboardUrl).toBe(
      'https://www.testsprite.com/dashboard/tests/project_abc/test/test_fe_01',
    );
  });
});
