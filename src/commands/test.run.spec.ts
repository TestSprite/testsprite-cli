/**
 * Unit tests for `test run <test-id>` — M3.3 piece-3.
 *
 * All HTTP is mocked via `makeFetch` / `makeCreds`. The polling loop's
 * sleep injection is wired through `TestDeps.sleep` to avoid real delays.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, RequestTimeoutError } from '../lib/errors.js';
import { DRY_RUN_BANNER, resetDryRunBannerForTesting } from '../lib/client-factory.js';
import type { FetchImpl } from '../lib/http.js';
import type { RunResponse, TriggerRunResponse, BatchRunFreshResponse } from '../lib/runs.types.js';
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

const TRIGGER_RESP: TriggerRunResponse = {
  runId: 'run_abc',
  status: 'queued',
  enqueuedAt: '2026-05-15T10:00:00.000Z',
  codeVersion: 'v1',
  targetUrl: 'https://example.com',
};

function makePassedRun(): RunResponse {
  return {
    runId: 'run_abc',
    testId: 'test_xyz',
    projectId: 'project_1',
    userId: 'user_1',
    status: 'passed',
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
    stepSummary: { total: 5, completed: 5, passedCount: 5, failedCount: 0 },
  };
}

function makeFailedRun(): RunResponse {
  return { ...makePassedRun(), status: 'failed', failedStepIndex: 2, failureKind: 'assertion' };
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

describe('createTestCommand — run + wait subcommands exposed', () => {
  it('exposes run and wait as top-level subcommands', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
    const names = test.commands.map(c => c.name()).sort();
    expect(names).toContain('run');
    expect(names).toContain('wait');
  });

  it('run subcommand has --wait, --timeout, --target-url, --idempotency-key flags', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
    const run = test.commands.find(c => c.name() === 'run')!;
    const flagNames = run.options.map(o => o.long);
    expect(flagNames).toContain('--wait');
    expect(flagNames).toContain('--timeout');
    expect(flagNames).toContain('--target-url');
    expect(flagNames).toContain('--idempotency-key');
  });

  it('wait subcommand has --timeout flag', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
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

  it('happy path — fires trigger, returns TriggerRunResponse, exit 0 (no throw)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(url => {
      if (url.includes('/runs')) return { body: TRIGGER_RESP };
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
        wait: false,
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: line => stdout.push(line), sleep: instantSleep },
    );
    // Should return TriggerRunResponse (not RunResponse)
    expect(result).toMatchObject({ runId: 'run_abc', status: 'queued' });
    expect(stdout.join('')).toContain('run_abc');
  });

  it('no-wait path sends POST to /tests/{testId}/runs', async () => {
    const { credentialsPath } = makeCreds();
    const seenUrls: string[] = [];
    const fetchImpl = makeFetch(url => {
      seenUrls.push(url);
      return { body: TRIGGER_RESP };
    });
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
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
    expect(seenUrls.some(u => u.includes('/tests/test_xyz/runs'))).toBe(true);
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
      return new Response(JSON.stringify(TRIGGER_RESP), {
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
    const fetchImpl = makeFetch(() => ({ body: TRIGGER_RESP }));
    const stdout: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: false,
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: line => stdout.push(line), sleep: instantSleep },
    );
    const parsed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(parsed.runId).toBe('run_abc');
    expect(parsed.status).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// runTestRun — --wait path
// ---------------------------------------------------------------------------

describe('runTestRun — with --wait', () => {
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

  it('polls until passed and returns RunResponse, exit 0 (no throw)', async () => {
    const { credentialsPath } = makeCreds();
    let getCount = 0;
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/') && url.includes('/runs') && !url.includes('/runs/run_abc')) {
        return { body: TRIGGER_RESP };
      }
      getCount++;
      if (getCount < 2) return { body: { ...makePassedRun(), status: 'running' as const } };
      return { body: makePassedRun() };
    });
    const stdout: string[] = [];
    const stderrLines: string[] = [];
    const result = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
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
    expect(result).toMatchObject({ runId: 'run_abc', status: 'passed' });
    const printed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(printed.status).toBe('passed');
  });

  it('wait path — failed status → throws CLIError with exitCode 1', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/') && url.includes('/runs') && !url.includes('/runs/run_abc')) {
        return { body: TRIGGER_RESP };
      }
      return { body: makeFailedRun() };
    });
    const err = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
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
    expect(err).toBeDefined();
    expect(err.exitCode).toBe(1);
    expect(err.name).toBe('CLIError');
  });

  it('wait timeout → UNSUPPORTED error (exit 7) with nextAction containing run-id', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/') && url.includes('/runs') && !url.includes('/runs/run_abc')) {
        return { body: TRIGGER_RESP };
      }
      // Always return non-terminal to force timeout
      return { body: { ...makePassedRun(), status: 'running' as const } };
    });

    // Mock Date.now to force timeout after first check
    let callCount = 0;
    const base = Date.now();
    const realDateNow = Date.now;
    Date.now = () => (callCount++ > 4 ? base + 2000 : base);

    try {
      const err = await runTestRun(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: false,
          testId: 'test_xyz',
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
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('UNSUPPORTED');
      expect((err as ApiError).exitCode).toBe(7);
      expect((err as ApiError).nextAction).toContain('test wait');
    } finally {
      Date.now = realDateNow;
    }
  });

  it('wait path — --output json disables ticker (stderr stays clean)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/') && url.includes('/runs') && !url.includes('/runs/run_abc')) {
        return { body: TRIGGER_RESP };
      }
      return { body: makePassedRun() };
    });
    const stderrLines: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'json', // disables ticker
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    // With --output json, no ticker noise goes to stderr
    // (artifact hint still goes to stderr if non-passed, but passed = no hint)
    const hasAnsiEscape = stderrLines.some(l => l.includes('\x1b['));
    expect(hasAnsiEscape).toBe(false);
  });

  it('blocked status → CLIError exit 1 with artifact hint on stderr', async () => {
    const { credentialsPath } = makeCreds();
    const blockedRun = { ...makePassedRun(), status: 'blocked' as const };
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/') && url.includes('/runs') && !url.includes('/runs/run_abc')) {
        return { body: TRIGGER_RESP };
      }
      return { body: blockedRun };
    });
    const stderrLines: string[] = [];
    const err = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
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
    expect(err.exitCode).toBe(1);
    expect(stderrLines.some(l => l.includes('artifact'))).toBe(true);
  });

  // B3 — cancelled must NOT emit the artifact hint (no artifacts to download)
  it('B3 — cancelled status → CLIError exit 1 with NO artifact hint on stderr', async () => {
    const { credentialsPath } = makeCreds();
    const cancelledRun = { ...makePassedRun(), status: 'cancelled' as const };
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/') && url.includes('/runs') && !url.includes('/runs/run_abc')) {
        return { body: TRIGGER_RESP };
      }
      return { body: cancelledRun };
    });
    const stderrLines: string[] = [];
    const err = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
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
    // Must still exit 1
    expect(err.exitCode).toBe(1);
    expect(err.name).toBe('CLIError');
    // Must NOT emit artifact hint for cancelled (no artifacts were captured)
    expect(stderrLines.some(l => l.includes('artifact'))).toBe(false);
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

  it('--target-url localhost rejected client-side (no network call)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn(async () => {
      throw new Error('network should not be hit');
    });
    const err = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: false,
        timeoutSeconds: 60,
        targetUrl: 'http://localhost:3000',
      },
      {
        credentialsPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        stdout: () => {},
        sleep: instantSleep,
      },
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('VALIDATION_ERROR');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('--target-url 10.x rejected client-side (RFC1918)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not reach network');
    });
    const err = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: false,
        timeoutSeconds: 60,
        targetUrl: 'http://10.0.0.1',
      },
      {
        credentialsPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        stdout: () => {},
        sleep: instantSleep,
      },
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('VALIDATION_ERROR');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runTestRun — dry-run path
// ---------------------------------------------------------------------------

describe('runTestRun — dry-run', () => {
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

  // P3-14: test run --dry-run now emits a TriggerRunResponse shape (same as
  // a real trigger response) rather than the HTTP-descriptor envelope. This
  // makes `test run --dry-run --output json` consistent with `test rerun --dry-run`.

  it('dry-run: no network call; prints TriggerRunResponse shape', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not hit network');
    });
    const stdout: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        testId: 'test_xyz',
        wait: false,
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
    const response = JSON.parse(stdout.join('')) as Record<string, unknown>;
    // Dry-run now returns TriggerRunResponse shape (runId, status, enqueuedAt)
    // rather than the HTTP-descriptor envelope (method, path, body).
    expect(response.runId).toBeDefined();
    expect(response.status).toBeDefined();
  });

  it('dry-run with --target-url: does not throw on valid public URL', async () => {
    const { credentialsPath } = makeCreds();
    const stdout: string[] = [];
    // With the new sample-based dry-run, --target-url is validated (must be
    // a public URL) but is not reflected in the canned sample response.
    await expect(
      runTestRun(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: true,
          testId: 'test_xyz',
          wait: false,
          timeoutSeconds: 60,
          targetUrl: 'https://staging.example.com',
        },
        {
          credentialsPath,
          fetchImpl: makeFetch(() => ({ body: {} })),
          stdout: line => stdout.push(line),
          sleep: instantSleep,
        },
      ),
    ).resolves.toBeDefined();
  });

  it('dry-run with --wait: emits the descriptor envelope with a thenPoll hint (codex #128 P2-A)', async () => {
    const { credentialsPath } = makeCreds();
    const stdout: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        testId: 'test_xyz',
        wait: true,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(() => ({ body: {} })),
        stdout: line => stdout.push(line),
        sleep: instantSleep,
      },
    );
    const response = JSON.parse(stdout.join('')) as Record<string, unknown>;
    // With --wait, dry-run falls through to the descriptor envelope so the
    // requested wait/poll is represented honestly — a queued TriggerRunResponse
    // sample would hide it. The envelope carries method/path + a thenPoll hint.
    expect(response.method).toBe('POST');
    expect(response.path).toBe('/api/cli/v1/tests/test_xyz/runs');
    expect(response.thenPoll).toBeDefined();
    // Not the queued-trigger sample shape.
    expect(response.runId).toBeUndefined();
  });

  it('dry-run chained (createContext set): merges created-test fields with the run sample (codex #128 P2-A)', async () => {
    const { credentialsPath } = makeCreds();
    const stdout: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        testId: 'test_xyz',
        wait: false,
        timeoutSeconds: 60,
        createContext: {
          testId: 'test_xyz',
          type: 'frontend',
          codeVersion: 'v1',
          createdAt: '2026-05-13T00:00:00.000Z',
        },
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(() => ({ body: {} })),
        stdout: line => stdout.push(line),
        sleep: instantSleep,
      },
    );
    const response = JSON.parse(stdout.join('')) as Record<string, unknown>;
    // The merged chain envelope keeps the created-test fields at top level
    // (these would be dropped if the dry-run sample short-circuited
    // printRunOrChain) and nests the run sample under `run`.
    expect(response.testId).toBe('test_xyz');
    expect(response.codeVersion).toBe('v1');
    const run = response.run as Record<string, unknown> | undefined;
    expect(run).toBeDefined();
    expect(run?.runId).toBeDefined();
  });

  it('dry-run: response has runId and status fields', async () => {
    const { credentialsPath } = makeCreds();
    const stdout: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        testId: 'test_xyz',
        wait: false,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(() => ({ body: {} })),
        stdout: line => stdout.push(line),
        sleep: instantSleep,
      },
    );
    const response = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(typeof response.runId).toBe('string');
    expect(typeof response.status).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// runTestRun — target-url with allowed values
// ---------------------------------------------------------------------------

describe('runTestRun — target-url guard: allowed URLs pass through', () => {
  it('allows https://example.com (public URL)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: TRIGGER_RESP }));
    const result = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: false,
        timeoutSeconds: 60,
        targetUrl: 'https://example.com',
      },
      { credentialsPath, fetchImpl, stdout: () => {}, sleep: instantSleep },
    );
    expect(result).toMatchObject({ runId: 'run_abc' });
  });
});

// ---------------------------------------------------------------------------
// runTestRun — Bug 2 dogfood round-4 2026-05-17
// CONFLICT + --wait auto-resume on currentRunId
// ---------------------------------------------------------------------------

describe('runTestRun — CONFLICT + --wait auto-resume (dogfood round-4)', () => {
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

  it('--wait + CONFLICT with currentRunId: auto-resumes polling, no CONFLICT envelope emitted', async () => {
    // The POST /run returns 409 CONFLICT with currentRunId=run_inflight.
    // With --wait, the CLI should silently attach to run_inflight's poll
    // loop rather than surfacing exit 6.
    const { credentialsPath } = makeCreds();
    const conflictBody = {
      error: {
        code: 'CONFLICT',
        message: 'Test test_xyz already has run run_inflight in flight.',
        nextAction: 'Wait for the run to finish.',
        requestId: 'req_conflict',
        details: { reason: 'run_in_flight', currentRunId: 'run_inflight' },
      },
    };
    const inflightRun: ReturnType<typeof makePassedRun> = {
      ...makePassedRun(),
      runId: 'run_inflight',
    };
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/') && url.includes('/runs')) {
        return { status: 409, body: conflictBody };
      }
      // GET /runs/run_inflight — return terminal
      return { body: inflightRun };
    });
    const stdout: string[] = [];
    const stderrLines: string[] = [];
    const result = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
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
    // Should resolve successfully — no CONFLICT exit 6
    expect(result).toMatchObject({ runId: 'run_inflight', status: 'passed' });
    // Advisory must mention the in-flight runId on stderr
    expect(stderrLines.some(l => l.includes('run_inflight'))).toBe(true);
    // Stdout should carry the final run result, not an error envelope
    const printed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(printed.runId).toBe('run_inflight');
    expect(printed.status).toBe('passed');
  });

  it('--wait + CONFLICT without currentRunId: surfaces exit 6 (cannot auto-resume without a target runId)', async () => {
    const { credentialsPath } = makeCreds();
    const conflictBodyNoRunId = {
      error: {
        code: 'CONFLICT',
        message: 'Test test_xyz already has a run in flight.',
        nextAction: 'Wait for the run to finish.',
        requestId: 'req_conflict2',
        details: { reason: 'run_in_flight' }, // no currentRunId
      },
    };
    const fetchImpl = makeFetch(() => ({ status: 409, body: conflictBodyNoRunId }));
    const err = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
        timeoutSeconds: 60,
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {}, sleep: instantSleep },
    ).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('CONFLICT');
    expect((err as ApiError).exitCode).toBe(6);
  });

  it('no --wait + CONFLICT: always surfaces exit 6 (auto-resume is wait-only behavior)', async () => {
    // Without --wait, CONFLICT should always propagate — the caller
    // explicitly did not ask for polling.
    const { credentialsPath } = makeCreds();
    const conflictBody = {
      error: {
        code: 'CONFLICT',
        message: 'Test test_xyz already has run run_existing in flight.',
        nextAction: 'Check currentRunId.',
        requestId: 'req_c3',
        details: { reason: 'run_in_flight', currentRunId: 'run_existing' },
      },
    };
    const fetchImpl = makeFetch(() => ({ status: 409, body: conflictBody }));
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

  it('--wait + CONFLICT auto-resume: polling loop uses the conflict currentRunId, not a stale one', async () => {
    const { credentialsPath } = makeCreds();
    const seenGetRunIds: string[] = [];
    const inflightPassedRun: ReturnType<typeof makePassedRun> = {
      ...makePassedRun(),
      runId: 'run_specific_inflight',
    };
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/') && url.includes('/runs')) {
        return {
          status: 409,
          body: {
            error: {
              code: 'CONFLICT',
              message: 'in flight',
              nextAction: '',
              requestId: 'r1',
              details: { reason: 'run_in_flight', currentRunId: 'run_specific_inflight' },
            },
          },
        };
      }
      // Extract runId from GET /runs/<runId>
      const match = /\/runs\/([^?/]+)/.exec(url);
      if (match?.[1]) seenGetRunIds.push(match[1]);
      return { body: inflightPassedRun };
    });
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
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
    // All GET calls must be on run_specific_inflight (not some stale uuid)
    expect(seenGetRunIds.length).toBeGreaterThan(0);
    expect(seenGetRunIds.every(id => id === 'run_specific_inflight')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CONFLICT target-URL verification (codex round-1 finding 3)
// ---------------------------------------------------------------------------

describe('runTestRun — CONFLICT target-URL verification (codex round-1 finding-3)', () => {
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

  it('CONFLICT reason=run_in_flight + --target-url matching in-flight run → auto-resume succeeds', async () => {
    // Arrange: POST → 409 run_in_flight; GET /runs/run_inflight → targetUrl matches
    const { credentialsPath } = makeCreds();
    const conflictBody = {
      error: {
        code: 'CONFLICT',
        message: 'Test already has a run in flight.',
        nextAction: '',
        requestId: 'req_c10',
        details: { reason: 'run_in_flight', currentRunId: 'run_inflight_url_match' },
      },
    };
    const inFlightRun: RunResponse = {
      ...makePassedRun(),
      runId: 'run_inflight_url_match',
      targetUrl: 'https://staging.example.com',
    };
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/') && url.includes('/runs')) {
        return { status: 409, body: conflictBody };
      }
      // GET /runs/run_inflight_url_match  (fetch for URL verification + poll)
      return { body: inFlightRun };
    });
    const stderrLines: string[] = [];
    const result = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
        targetUrl: 'https://staging.example.com', // matches in-flight
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    expect(result).toMatchObject({ runId: 'run_inflight_url_match', status: 'passed' });
    // Advisory should be emitted and mention the runId
    expect(stderrLines.some(l => l.includes('run_inflight_url_match'))).toBe(true);
  });

  it('CONFLICT reason=run_in_flight + --target-url X but in-flight runs against Y → exit 6, no poll', async () => {
    // Arrange: POST → 409 run_in_flight; GET /runs/run_inflight → different targetUrl
    const { credentialsPath } = makeCreds();
    const conflictBody = {
      error: {
        code: 'CONFLICT',
        message: 'Test already has a run in flight.',
        nextAction: '',
        requestId: 'req_c11',
        details: { reason: 'run_in_flight', currentRunId: 'run_inflight_url_mismatch' },
      },
    };
    const inFlightRun: RunResponse = {
      ...makePassedRun(),
      runId: 'run_inflight_url_mismatch',
      targetUrl: 'https://prod.other-team.example.com', // different from requested
    };
    const seenGetRunIds: string[] = [];
    // Track which run IDs the poll loop hits (should be none for this case)
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/') && url.includes('/runs')) {
        return { status: 409, body: conflictBody };
      }
      // GET /runs/run_inflight_url_mismatch — for URL verification only
      const match = /\/runs\/([^?/]+)/.exec(url);
      if (match?.[1]) seenGetRunIds.push(match[1]);
      return { body: inFlightRun };
    });
    const err = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
        targetUrl: 'https://my-staging.example.com', // mismatches in-flight
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
    // Must exit 6 with a CONFLICT error, not auto-resume
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('CONFLICT');
    expect((err as ApiError).exitCode).toBe(6);
    // Message must mention the mismatch
    expect((err as ApiError).message).toContain('different target URL');
    expect((err as ApiError).message).toContain('prod.other-team.example.com');
    // nextAction must point at 'test wait <runId>'
    expect((err as ApiError).nextAction).toContain('run_inflight_url_mismatch');
    // The poll loop must NOT have been entered (only the URL-verification GET)
    // seenGetRunIds has exactly one entry (the verification GET), not multiple polls
    expect(seenGetRunIds).toHaveLength(1);
    expect(seenGetRunIds[0]).toBe('run_inflight_url_mismatch');
  });

  it('CONFLICT reason=idempotency_body_mismatch → exit 6, never auto-resume', async () => {
    // IDEMPOTENCY_BODY_MISMATCH uses code 'IDEMPOTENCY_BODY_MISMATCH' (409),
    // and must never trigger auto-resume regardless of --wait.
    const { credentialsPath } = makeCreds();
    const mismatchBody = {
      error: {
        code: 'IDEMPOTENCY_BODY_MISMATCH',
        message: 'Idempotency key reused with a different request body.',
        nextAction: 'Mint a new idempotency key and retry.',
        requestId: 'req_c12',
        details: { reason: 'body_hash_mismatch' },
      },
    };
    const fetchImpl = makeFetch(() => ({ status: 409, body: mismatchBody }));
    const err = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
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
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('IDEMPOTENCY_BODY_MISMATCH');
    expect((err as ApiError).exitCode).toBe(6);
  });

  it('CONFLICT reason=run_in_flight + no --target-url → auto-resume, fetches real targetUrl from in-flight run', async () => {
    // Finding D (codex round-2): when --target-url is not supplied, the CLI now
    // fetches GET /runs/{currentRunId} to bind the REAL targetUrl to the
    // synthesised triggerResponse (instead of ''). The advisory must include the
    // actual target URL and the cancel hint.
    const { credentialsPath } = makeCreds();
    const conflictBody = {
      error: {
        code: 'CONFLICT',
        message: 'Test already has a run in flight.',
        nextAction: '',
        requestId: 'req_c13',
        details: { reason: 'run_in_flight', currentRunId: 'run_default_target' },
      },
    };
    const inFlightRun: RunResponse = {
      ...makePassedRun(),
      runId: 'run_default_target',
      targetUrl: 'https://default.example.com',
    };
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/') && url.includes('/runs')) {
        return { status: 409, body: conflictBody };
      }
      return { body: inFlightRun };
    });
    const stderrLines: string[] = [];
    const result = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
        // No targetUrl supplied
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    expect(result).toMatchObject({ runId: 'run_default_target', status: 'passed' });
    // Advisory must mention the actual target URL (not '') and the cancel hint
    const advisory = stderrLines.join(' ');
    expect(advisory).toContain('run_default_target');
    expect(advisory).toContain('https://default.example.com');
    expect(advisory).toContain('--target-url');
  });
});

// ---------------------------------------------------------------------------
// Backend testId fallback (dogfood L1888)
//
// BE run rows never finalize server-side, so `test run --wait` falls back to
// the testId-scoped verdict so a passing BE test exits 0 instead of timing out.
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
    testId: 'test_be',
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

function beRunRouter(args: {
  type?: string;
  runStatus?: RunResponse['status'];
  result: () => BeResult;
}) {
  const counts = { trigger: 0, type: 0, result: 0, run: 0 };
  const handler = (url: string) => {
    if (url.includes('/tests/test_be/runs')) {
      counts.trigger += 1;
      return { body: TRIGGER_RESP };
    }
    if (url.includes('/tests/test_be/result')) {
      counts.result += 1;
      return { body: args.result() };
    }
    if (url.includes('/runs/run_abc')) {
      counts.run += 1;
      // A realistic BE run row: real correlation metadata (testId === the
      // triggered test, project/user populated) but stuck non-terminal.
      return {
        body: {
          ...makePassedRun(),
          testId: 'test_be',
          projectId: 'project_be',
          userId: 'user_be',
          status: args.runStatus ?? 'running',
          finishedAt: null,
        },
      };
    }
    if (url.includes('/tests/test_be')) {
      counts.type += 1;
      return {
        body: {
          id: 'test_be',
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
    return { status: 404, body: {} };
  };
  return { handler, counts };
}

describe('runTestRun — backend testId fallback (L1888)', () => {
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

  it('passing backend test resolves via testId result (exit 0) + advisory', async () => {
    const { credentialsPath } = makeCreds();
    const router = beRunRouter({ result: () => makeBeResult({ status: 'passed' }) });
    const stderr: string[] = [];
    const result = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_be',
        wait: true,
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
    const run = result as RunResponse;
    expect(run.status).toBe('passed');
    expect(router.counts.type).toBeGreaterThan(0);
    expect(router.counts.result).toBeGreaterThan(0);
    expect(stderr.join(' ')).toContain('test record');
    // codex round-2: real correlation metadata from the polled run row is
    // preserved (not fabricated blank).
    expect(run.runId).toBe('run_abc');
    expect(run.testId).toBe('test_be');
    expect(run.projectId).toBe('project_be');
    expect(run.userId).toBe('user_be');
  });

  it('failing backend test resolves via fallback (CLIError exit 1) + testId artifact hint', async () => {
    const { credentialsPath } = makeCreds();
    const router = beRunRouter({
      result: () =>
        makeBeResult({
          status: 'failed',
          failureKind: 'assertion',
          failedStepIndex: 1,
          summary: { passed: 0, failed: 1, skipped: 0 },
        }),
    });
    const stderr: string[] = [];
    const err = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_be',
        wait: true,
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
    expect(stderr.join(' ')).toContain('test failure get test_be');
  });

  it('frontend test is untouched — terminal run row resolves with zero testId lookups', async () => {
    const { credentialsPath } = makeCreds();
    const router = beRunRouter({
      type: 'frontend',
      runStatus: 'passed',
      result: () => makeBeResult(),
    });
    // run row reports terminal on the first poll → fallback never engaged.
    const handler = (url: string) => {
      if (url.includes('/tests/test_be/runs')) return { body: TRIGGER_RESP };
      if (url.includes('/runs/run_abc')) return { body: makePassedRun() };
      if (url.includes('/tests/test_be/result')) {
        router.counts.result += 1;
        return { body: makeBeResult() };
      }
      if (url.includes('/tests/test_be')) {
        router.counts.type += 1;
        return { body: { id: 'test_be', type: 'frontend' } };
      }
      return { status: 404, body: {} };
    };
    const result = await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_be',
        wait: true,
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
    expect((result as RunResponse).status).toBe('passed');
    expect(router.counts.type).toBe(0);
    expect(router.counts.result).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C2 — BE steps text renders as n/a (backend)
// ---------------------------------------------------------------------------

describe('C2 — backend run renders steps: n/a (backend) in text mode', () => {
  it('renders "steps: n/a (backend)" when the BE fallback resolved the run', async () => {
    // Simulates a backend test where:
    //  - the run row stays non-terminal (orphaned, dogfood L1888)
    //  - the testId result row becomes terminal → fallback fires
    const { credentialsPath } = makeCreds();
    const beResult = {
      testId: 'test_be_c2',
      status: 'passed',
      startedAt: '2026-05-15T10:00:01.000Z',
      finishedAt: '2026-05-15T10:00:10.000Z',
      videoUrl: null,
      failureAnalysisUrl: null,
      snapshotId: 'snap_c2',
      runIdIfAvailable: 'run_c2',
      codeVersion: 'v1',
      targetUrl: 'https://example.com',
      failedStepIndex: null,
      failureKind: null,
      summary: { passed: 1, failed: 0, skipped: 0 },
    };
    const handler = (url: string) => {
      if (url.includes('/tests/test_be_c2/runs')) {
        return {
          body: {
            runId: 'run_c2',
            status: 'queued',
            enqueuedAt: '2026-05-15T10:00:00.000Z',
            codeVersion: 'v1',
            targetUrl: 'https://example.com',
          },
        };
      }
      if (url.includes('/runs/run_c2')) {
        // Return non-terminal so the fallback reads the result instead
        return {
          body: {
            runId: 'run_c2',
            testId: 'test_be_c2',
            projectId: 'p1',
            userId: 'u1',
            status: 'queued',
            source: 'cli',
            createdAt: '2026-05-15T10:00:00.000Z',
            startedAt: null,
            finishedAt: null,
            codeVersion: 'v1',
            targetUrl: 'https://example.com',
            createdFrom: null,
            failedStepIndex: null,
            failureKind: null,
            videoUrl: null,
            stepSummary: { total: 0, completed: 0, passedCount: 0, failedCount: 0 },
          },
        };
      }
      if (url.includes('/tests/test_be_c2/result')) {
        // Return terminal result so fallback resolves
        return { body: beResult };
      }
      if (url.includes('/tests/test_be_c2')) {
        return { body: { id: 'test_be_c2', type: 'backend' } };
      }
      return { status: 404, body: {} };
    };
    const stdoutLines: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        testId: 'test_be_c2',
        wait: true,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(handler),
        stdout: line => stdoutLines.push(line),
        stderr: () => {},
        sleep: instantSleep,
      },
    );
    const out = stdoutLines.join('\n');
    // BE fallback used → steps line should be n/a (backend)
    expect(out).toContain('steps       n/a (backend)');
    // Must NOT show confusing "0/0 (passed=0, failed=0)"
    expect(out).not.toContain('0/0');
  });

  it('FE terminal run row still renders real step counts', async () => {
    const { credentialsPath } = makeCreds();
    const feRun: RunResponse = {
      runId: 'run_fe_c2',
      testId: 'test_fe_c2',
      projectId: 'p1',
      userId: 'u1',
      status: 'passed',
      source: 'cli',
      createdAt: '2026-05-15T10:00:00.000Z',
      startedAt: '2026-05-15T10:00:01.000Z',
      finishedAt: '2026-05-15T10:00:30.000Z',
      codeVersion: 'v1',
      targetUrl: 'https://example.com',
      createdFrom: null,
      failedStepIndex: null,
      failureKind: null,
      error: null,
      videoUrl: null,
      stepSummary: { total: 3, completed: 3, passedCount: 3, failedCount: 0 },
    };
    const handler = (url: string) => {
      if (url.includes('/tests/test_fe_c2/runs')) {
        return {
          body: {
            runId: 'run_fe_c2',
            status: 'queued',
            enqueuedAt: '2026-05-15T10:00:00.000Z',
            codeVersion: 'v1',
            targetUrl: 'https://example.com',
          },
        };
      }
      if (url.includes('/runs/run_fe_c2')) return { body: feRun };
      return { status: 404, body: {} };
    };
    const stdoutLines: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        testId: 'test_fe_c2',
        wait: true,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(handler),
        stdout: line => stdoutLines.push(line),
        stderr: () => {},
        sleep: instantSleep,
      },
    );
    const out = stdoutLines.join('\n');
    // FE run: real step counts rendered
    expect(out).toContain('steps       3/3 (passed=3, failed=0)');
    // Not the backend placeholder
    expect(out).not.toContain('n/a (backend)');
  });

  it('BE run terminal on first poll (opts.type=backend) renders steps: n/a via type hint (Fix 2)', async () => {
    // Simulates a fast backend run that is already terminal on the FIRST poll,
    // so `beFallbackUsed` is false (resolveAlternate is never called).
    // The only BE signal is `opts.type === 'backend'` from the create-chain.
    const { credentialsPath } = makeCreds();
    const passedBeRun: RunResponse = {
      runId: 'run_fast_be',
      testId: 'test_fast_be',
      projectId: 'p1',
      userId: 'u1',
      status: 'passed',
      source: 'cli',
      createdAt: '2026-05-15T10:00:00.000Z',
      startedAt: '2026-05-15T10:00:01.000Z',
      finishedAt: '2026-05-15T10:00:02.000Z',
      codeVersion: 'v1',
      targetUrl: 'https://example.com',
      createdFrom: null,
      failedStepIndex: null,
      failureKind: null,
      error: null,
      videoUrl: null,
      // RunResponse has no per-step breakdown for BE runs; backend may send zeros.
      stepSummary: { total: 0, completed: 0, passedCount: 0, failedCount: 0 },
    };
    const handler = (url: string) => {
      if (url.includes('/tests/test_fast_be/runs')) {
        return {
          body: {
            runId: 'run_fast_be',
            status: 'queued',
            enqueuedAt: '2026-05-15T10:00:00.000Z',
            codeVersion: 'v1',
            targetUrl: 'https://example.com',
          },
        };
      }
      // Run row is terminal on first GET — resolveAlternate never fires.
      if (url.includes('/runs/run_fast_be')) return { body: passedBeRun };
      return { status: 404, body: {} };
    };
    const stdoutLines: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        testId: 'test_fast_be',
        // type hint supplied by the create-chain (or the caller when type is known)
        type: 'backend',
        wait: true,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(handler),
        stdout: line => stdoutLines.push(line),
        stderr: () => {},
        sleep: instantSleep,
      },
    );
    const out = stdoutLines.join('\n');
    // Fast BE: type hint → n/a (backend) even though beFallbackUsed is false
    expect(out).toContain('steps       n/a (backend)');
    expect(out).not.toContain('0/0');
  });
});

// ---------------------------------------------------------------------------
// C3 — requestId: trailer gated behind --verbose / --debug
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fix 3 — test run idempotency-key emitted under --verbose (was --debug only)
// ---------------------------------------------------------------------------

describe('Fix 3 — test run idempotency-key emission', () => {
  it('does NOT emit idempotency-key by default (text mode, no --verbose/--debug)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: TRIGGER_RESP }));
    const stderrLines: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        verbose: false,
        dryRun: false,
        testId: 'test_idem',
        wait: false,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    expect(stderrLines.some(l => l.startsWith('idempotency-key:'))).toBe(false);
  });

  it('emits idempotency-key under --verbose', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: TRIGGER_RESP }));
    const stderrLines: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        verbose: true,
        dryRun: false,
        testId: 'test_idem',
        wait: false,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    expect(stderrLines.some(l => l.startsWith('idempotency-key:'))).toBe(true);
  });

  it('emits idempotency-key in JSON output mode (Fix 1: JSON-mode regression)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: TRIGGER_RESP }));
    const stderrLines: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        verbose: false,
        dryRun: false,
        testId: 'test_idem',
        wait: false,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    // JSON mode: idempotency-key must still appear on stderr (stderr is never
    // the JSON stream; suppressing it was a silent regression).
    expect(stderrLines.some(l => l.startsWith('idempotency-key:'))).toBe(true);
  });
});

describe('C3 — requestId trailer gated behind --verbose', () => {
  it('does NOT emit requestId to stderr by default (no-wait path)', async () => {
    const { credentialsPath } = makeCreds();
    // Inject a request-id header in the response so the CLI can surface it.
    const fetchImpl: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          runId: 'run_c3',
          status: 'queued',
          enqueuedAt: '2026-05-15T10:00:00.000Z',
          codeVersion: 'v1',
          targetUrl: 'https://example.com',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req_c3_hidden' },
        },
      );
    const stderrLines: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        verbose: false,
        dryRun: false,
        testId: 'test_c3',
        wait: false,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: fetchImpl as unknown as FetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    expect(stderrLines.some(l => l.startsWith('requestId:'))).toBe(false);
  });

  it('emits requestId to stderr under --verbose (no-wait path)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          runId: 'run_c3',
          status: 'queued',
          enqueuedAt: '2026-05-15T10:00:00.000Z',
          codeVersion: 'v1',
          targetUrl: 'https://example.com',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-request-id': 'req_c3_visible' },
        },
      );
    const stderrLines: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        verbose: true,
        dryRun: false,
        testId: 'test_c3',
        wait: false,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: fetchImpl as unknown as FetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    expect(stderrLines.some(l => l.startsWith('requestId:'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — D4: RequestTimeoutError under --wait emits partial stdout + exit 7
// ---------------------------------------------------------------------------

describe('runTestRun --wait: Fix 3 — RequestTimeoutError writes partial JSON to stdout', () => {
  it('exit 7 AND stdout contains {runId, status:"running"} when poll throws RequestTimeoutError', async () => {
    const { credentialsPath } = makeCreds();
    let callCount = 0;
    const fetchImpl: typeof globalThis.fetch = async (_input, _init) => {
      callCount += 1;
      if (callCount === 1) {
        // Trigger succeeds
        return new Response(JSON.stringify(TRIGGER_RESP), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Polling call throws RequestTimeoutError (simulates per-request timeout)
      throw new RequestTimeoutError(120000, 'req_timeout_test');
    };

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    await expect(
      runTestRun(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          verbose: false,
          dryRun: false,
          testId: 'test_xyz',
          wait: true,
          timeoutSeconds: 600,
        },
        {
          credentialsPath,
          fetchImpl: fetchImpl as unknown as FetchImpl,
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
      targetUrl: string;
    };
    expect(stdoutJson.runId).toBe(TRIGGER_RESP.runId);
    expect(stdoutJson.status).toBe('running');
    expect(stdoutJson.targetUrl).toBe(TRIGGER_RESP.targetUrl);

    // Stderr should mention the runId and suggest test wait
    const stderrBlock = stderrLines.join('\n');
    expect(stderrBlock).toContain(TRIGGER_RESP.runId);
    expect(stderrBlock).toContain('test wait');
  });
});

// ---------------------------------------------------------------------------
// TimeoutError on --wait: partial stdout + exit 7
// ---------------------------------------------------------------------------

describe('runTestRun --wait: TimeoutError writes partial JSON to stdout', () => {
  it('exit 7 AND stdout contains {runId, status:"running"} when --timeout polling deadline is exceeded', async () => {
    const { credentialsPath } = makeCreds();
    let dateCallCount = 0;
    let fetchCallCount = 0;
    const base = Date.now();
    const realDateNow = Date.now;
    Date.now = () => (++dateCallCount > 6 ? base + 2000 : base);

    try {
      const fetchImpl: typeof globalThis.fetch = async () => {
        ++fetchCallCount;
        if (fetchCallCount === 1) {
          return new Response(JSON.stringify(TRIGGER_RESP), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        const runningRun: RunResponse = { ...makePassedRun(), status: 'running' };
        return new Response(JSON.stringify(runningRun), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      await expect(
        runTestRun(
          {
            profile: 'default',
            output: 'json',
            debug: false,
            verbose: false,
            dryRun: false,
            testId: 'test_xyz',
            wait: true,
            timeoutSeconds: 1,
          },
          {
            credentialsPath,
            fetchImpl: fetchImpl as unknown as FetchImpl,
            stdout: line => stdoutLines.push(line),
            stderr: line => stderrLines.push(line),
            sleep: instantSleep,
          },
        ),
      ).rejects.toMatchObject({ exitCode: 7 });

      const stdoutJson = JSON.parse(stdoutLines.join('\n')) as {
        runId: string;
        status: string;
        targetUrl: string;
      };
      expect(stdoutJson.runId).toBe(TRIGGER_RESP.runId);
      expect(stdoutJson.status).toBe('running');
      expect(stdoutJson.targetUrl).toBe(TRIGGER_RESP.targetUrl);
    } finally {
      Date.now = realDateNow;
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 5 — B2(c): --timeout hint fires on default, not on explicit timeout
// ---------------------------------------------------------------------------

describe('runTestRun --wait: Fix 5 — first-run timeout hint', () => {
  function makeTriggerThenPassedFetch(): typeof globalThis.fetch {
    let callCount = 0;
    return (async (_input, _init) => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify(TRIGGER_RESP), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(makePassedRun()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
  }

  it('emits the hint to stderr when timeoutIsDefault is true and output=text', async () => {
    const { credentialsPath } = makeCreds();
    const stderrLines: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        verbose: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
        timeoutSeconds: 600,
        timeoutIsDefault: true,
      },
      {
        credentialsPath,
        fetchImpl: makeTriggerThenPassedFetch() as unknown as FetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    expect(stderrLines.some(l => l.includes('[hint]') && l.includes('--timeout'))).toBe(true);
  });

  it('does NOT emit the hint when timeoutIsDefault is false (explicit --timeout)', async () => {
    const { credentialsPath } = makeCreds();
    const stderrLines: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        verbose: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
        timeoutSeconds: 600,
        timeoutIsDefault: false,
      },
      {
        credentialsPath,
        fetchImpl: makeTriggerThenPassedFetch() as unknown as FetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    expect(stderrLines.some(l => l.includes('[hint]') && l.includes('--timeout'))).toBe(false);
  });

  it('does NOT emit the hint in json output mode', async () => {
    const { credentialsPath } = makeCreds();
    const stderrLines: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        verbose: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
        timeoutSeconds: 600,
        timeoutIsDefault: true,
      },
      {
        credentialsPath,
        fetchImpl: makeTriggerThenPassedFetch() as unknown as FetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    expect(stderrLines.some(l => l.includes('[hint]') && l.includes('--timeout'))).toBe(false);
  });
});

// Note: Finding B (advisory dup-name lookup short deadline) tests live in
// test.test.ts which has the makeFetch + runCreate helpers needed for
// lightweight code-file-based create tests without OOM-prone AbortController
// race setups.

// ---------------------------------------------------------------------------
// Finding C (codex round-2) — timeout partial routes through renderer
// ---------------------------------------------------------------------------

describe('[finding-C] runTestRun --wait RequestTimeoutError — text mode renders human-readable', () => {
  it('text mode: stdout contains runId label line (not raw JSON) on RequestTimeoutError', async () => {
    const { credentialsPath } = makeCreds();
    let callCount = 0;
    const fetchImpl: typeof globalThis.fetch = async (_input, _init) => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify(TRIGGER_RESP), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new RequestTimeoutError(120000, 'req_c_test');
    };

    const stdoutLines: string[] = [];

    await expect(
      runTestRun(
        {
          profile: 'default',
          output: 'text', // TEXT MODE — the fix ensures this renders readable
          debug: false,
          verbose: false,
          dryRun: false,
          testId: 'test_xyz',
          wait: true,
          timeoutSeconds: 600,
        },
        {
          credentialsPath,
          fetchImpl: fetchImpl as unknown as FetchImpl,
          stdout: line => stdoutLines.push(line),
          stderr: () => {},
          sleep: instantSleep,
        },
      ),
    ).rejects.toMatchObject({ exitCode: 7 });

    const stdoutBlock = stdoutLines.join('\n');
    // Must contain the human-readable label (not '{"runId":')
    expect(stdoutBlock).toContain('runId');
    expect(stdoutBlock).toContain('running');
    expect(stdoutBlock).not.toMatch(/^\{/); // not a raw JSON object at the start
  });

  it('json mode: stdout has merged create-chain envelope when createContext supplied', async () => {
    const { credentialsPath } = makeCreds();
    let callCount = 0;
    const fetchImpl: typeof globalThis.fetch = async (_input, _init) => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify(TRIGGER_RESP), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new RequestTimeoutError(120000, 'req_c_chain_test');
    };

    const stdoutLines: string[] = [];
    const createContext = {
      testId: 'test_c_chain',
      codeVersion: 'v1',
      createdAt: '2026-06-07T00:00:00.000Z',
      projectId: 'project_abc',
      type: 'frontend' as const,
      name: 'Chain Test',
    };

    await expect(
      runTestRun(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          verbose: false,
          dryRun: false,
          testId: 'test_xyz',
          wait: true,
          timeoutSeconds: 600,
          createContext,
        },
        {
          credentialsPath,
          fetchImpl: fetchImpl as unknown as FetchImpl,
          stdout: line => stdoutLines.push(line),
          stderr: () => {},
          sleep: instantSleep,
        },
      ),
    ).rejects.toMatchObject({ exitCode: 7 });

    const stdoutJson = JSON.parse(stdoutLines.join('\n')) as {
      testId: string;
      run: { runId: string; status: string };
    };
    // Merged envelope: create context + run partial
    expect(stdoutJson.testId).toBe('test_c_chain');
    expect(stdoutJson.run.runId).toBe(TRIGGER_RESP.runId);
    expect(stdoutJson.run.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// Finding D (codex round-2) — 409 conflict auto-resume without --target-url
//   → timeout partial carries the real in-flight targetUrl (not '')
// ---------------------------------------------------------------------------

describe('[finding-D] 409 conflict auto-resume no --target-url + RequestTimeoutError → partial has real targetUrl', () => {
  it('timeout partial carries in-flight run targetUrl (not null or "")', async () => {
    // Regression: before the fix, the synthesised triggerResponse.targetUrl was ''
    // (empty string) when no --target-url was supplied. The timeout partial then
    // published '' as the environment provenance. After the fix, the CLI fetches
    // GET /runs/{currentRunId} and binds the real URL.
    const { credentialsPath } = makeCreds();
    const conflictBody = {
      error: {
        code: 'CONFLICT',
        message: 'Run already in flight.',
        nextAction: '',
        requestId: 'req_d01',
        details: { reason: 'run_in_flight', currentRunId: 'run_inflight_d01' },
      },
    };
    const inFlightRun: RunResponse = {
      ...makePassedRun(),
      runId: 'run_inflight_d01',
      targetUrl: 'https://real-env.example.com',
      status: 'running' as const,
    };

    // Track which calls have been made so each call serves a distinct role.
    const calls: string[] = [];
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${url}`);

      // First call: trigger POST /tests/{id}/runs → 409 conflict
      if (method === 'POST' && url.includes('/tests/') && url.endsWith('/runs')) {
        return new Response(JSON.stringify(conflictBody), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Second call: GET /runs/{id} (getRun to fetch in-flight run details)
      // This is used BOTH by the 409 handler (to get targetUrl) and by polling.
      // We differentiate: the first GET /runs/{id} is the advisory lookup;
      // subsequent GET /runs/{id} calls are polling → throw RequestTimeoutError.
      if (method === 'GET' && url.includes('/runs/run_inflight_d01')) {
        const runGetCalls = calls.filter(
          c => c === `GET ${url.split('?')[0]}` || c.startsWith(`GET ${url.split('?')[0]}`),
        ).length;
        if (runGetCalls <= 1) {
          // First GET /runs/{id} — advisory lookup
          return new Response(JSON.stringify(inFlightRun), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        // Second+ GET /runs/{id} — polling → simulate per-request timeout
        throw new RequestTimeoutError(120000, 'req_d_timeout');
      }
      // Any other call → timeout
      throw new RequestTimeoutError(120000, 'req_d_fallback');
    };

    const stdoutLines: string[] = [];

    await expect(
      runTestRun(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          verbose: false,
          dryRun: false,
          testId: 'test_xyz',
          wait: true,
          timeoutSeconds: 600,
          // No --target-url supplied
        },
        {
          credentialsPath,
          fetchImpl: fetchImpl as unknown as FetchImpl,
          stdout: line => stdoutLines.push(line),
          stderr: () => {},
          sleep: instantSleep,
        },
      ),
    ).rejects.toMatchObject({ exitCode: 7 });

    const stdoutJson = JSON.parse(stdoutLines.join('\n')) as {
      runId: string;
      status: string;
      targetUrl: string | null;
    };

    // The partial must carry the REAL in-flight targetUrl — not '' or null.
    expect(stdoutJson.runId).toBe('run_inflight_d01');
    expect(stdoutJson.status).toBe('running');
    expect(stdoutJson.targetUrl).toBe('https://real-env.example.com');
    expect(stdoutJson.targetUrl).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// M4 piece-2 — `test run --all --project <id>` (fresh wave-ordered batch run)
// ---------------------------------------------------------------------------

describe('runTestRunAll — batch fresh run', () => {
  const BATCH_FRESH_RESP: BatchRunFreshResponse = {
    accepted: [
      { testId: 'test_be_01', runId: 'run_fresh_01', enqueuedAt: '2026-06-09T10:00:00.000Z' },
      { testId: 'test_be_02', runId: 'run_fresh_02', enqueuedAt: '2026-06-09T10:00:01.000Z' },
    ],
    conflicts: [],
    deferred: [],
    skippedFrontend: [],
    skippedIntegration: [],
  };

  function makePassedRun(runId: string, testId: string): RunResponse {
    return {
      runId,
      testId,
      projectId: 'project_be',
      userId: 'user_1',
      status: 'passed',
      source: 'cli',
      createdAt: '2026-06-09T10:00:00.000Z',
      startedAt: '2026-06-09T10:00:01.000Z',
      finishedAt: '2026-06-09T10:00:30.000Z',
      codeVersion: 'v1',
      targetUrl: 'https://api.example.com',
      createdFrom: 'cli',
      failedStepIndex: null,
      failureKind: null,
      error: null,
      videoUrl: null,
      stepSummary: { total: 3, completed: 3, passedCount: 3, failedCount: 0 },
    };
  }

  it('routes to POST /tests/batch/run with correct body shape (projectId + source)', async () => {
    const { credentialsPath } = makeCreds();
    type Captured = { url: string; method: string; body: unknown };
    const captured: Captured[] = [];
    const fetchImpl = makeFetch((url, init) => {
      captured.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      return { body: BATCH_FRESH_RESP };
    });
    const out: string[] = [];
    await runTestRunAll(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_be',
        wait: false,
        timeoutSeconds: 600,
        maxConcurrency: 10,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => out.push(line),
        stderr: () => undefined,
        sleep: instantSleep,
      },
    );
    const post = captured.find(c => c.method === 'POST' && (c.url as string).includes('batch/run'));
    expect(post).toBeDefined();
    expect(post!.body).toMatchObject({ projectId: 'project_be', source: 'cli' });
    // No testIds field when --filter is absent (run all)
    expect((post!.body as Record<string, unknown>).testIds).toBeUndefined();
  });

  it('includes testIds when --filter is set (resolves via GET /tests then filters)', async () => {
    const { credentialsPath } = makeCreds();
    const allTests = [
      {
        id: 'test_a',
        name: 'Create user',
        type: 'backend',
        status: 'ready',
        projectId: 'project_be',
        createdFrom: 'cli',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'test_b',
        name: 'Read user',
        type: 'backend',
        status: 'ready',
        projectId: 'project_be',
        createdFrom: 'cli',
        createdAt: '',
        updatedAt: '',
      },
      {
        id: 'test_c',
        name: 'Delete user',
        type: 'backend',
        status: 'ready',
        projectId: 'project_be',
        createdFrom: 'cli',
        createdAt: '',
        updatedAt: '',
      },
    ];
    type Captured = { url: string; body: unknown };
    const captured: Captured[] = [];
    const fetchImpl = makeFetch((url, init) => {
      const method = init.method ?? 'GET';
      captured.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
      if (method === 'GET') return { body: { items: allTests, nextToken: null } };
      return {
        body: {
          accepted: [{ testId: 'test_b', runId: 'run_b', enqueuedAt: '...' }],
          conflicts: [],
          deferred: [],
          skippedFrontend: [],
          skippedIntegration: [],
        } satisfies BatchRunFreshResponse,
      };
    });
    const stderrLines: string[] = [];
    await runTestRunAll(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_be',
        nameFilter: 'read', // case-insensitive → matches 'Read user'
        wait: false,
        timeoutSeconds: 600,
        maxConcurrency: 10,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    const post = captured.find(c => (c.url as string).includes('batch/run') && c.body);
    expect(post).toBeDefined();
    expect((post!.body as Record<string, unknown>).testIds).toEqual(['test_b']);
    // Should report the filter skip count on stderr
    expect(stderrLines.some(l => l.includes('--filter'))).toBe(true);
  });

  it('positional <test-id> + --all → exit 5 mutual exclusion (via command wiring)', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
    disableExits(test);
    await expect(
      test.parseAsync(['run', 'test_xyz', '--all', '--project', 'proj_1'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('missing both positional and --all → exit 5', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
    disableExits(test);
    await expect(test.parseAsync(['run'], { from: 'user' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
    });
  });

  it('--all without --project → exit 5', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
    disableExits(test);
    await expect(test.parseAsync(['run', '--all'], { from: 'user' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
    });
  });

  it('--all --target-url → exit 5 (target-url has no effect on BE-only batch)', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
    disableExits(test);
    await expect(
      test.parseAsync(
        ['run', '--all', '--project', 'proj_1', '--target-url', 'https://example.com'],
        { from: 'user' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('<test-id> --filter (without --all) → exit 5 (filter is --all-only)', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
    disableExits(test);
    await expect(
      test.parseAsync(['run', 'test_xyz', '--filter', 'login'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('--wait polls each accepted runId and returns on all-pass (exit 0)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch((url, init) => {
      const method = init.method ?? 'GET';
      if (method === 'POST') return { body: BATCH_FRESH_RESP };
      // Poll GET /runs/<runId>
      const runId = url.split('/runs/')[1]?.split('?')[0] ?? 'run_unknown';
      return { body: makePassedRun(runId, runId === 'run_fresh_01' ? 'test_be_01' : 'test_be_02') };
    });
    const out: string[] = [];
    await runTestRunAll(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_be',
        wait: true,
        timeoutSeconds: 60,
        maxConcurrency: 5,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => out.push(line),
        stderr: () => undefined,
        sleep: instantSleep,
      },
    );
    const payload = JSON.parse(out.join('\n')) as { accepted: Array<{ status: string }> };
    expect(payload.accepted.every(r => r.status === 'passed')).toBe(true);
  });

  it('run --all --wait: does not start a fresh poll for a queued run after the shared deadline expired', async () => {
    const { credentialsPath } = makeCreds();
    const baseNow = new Date('2026-06-09T10:00:00.000Z').getTime();
    let nowMs = baseNow;
    const runFetches: string[] = [];
    const stdoutLines: string[] = [];
    let caughtError: unknown;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const fetchImpl = makeFetch((url, init) => {
      const method = init.method ?? 'GET';
      if (method === 'POST') return { body: BATCH_FRESH_RESP };

      const runId = url.split('/runs/')[1]?.split('?')[0] ?? 'run_unknown';
      runFetches.push(runId);
      if (runId === 'run_fresh_01') {
        nowMs = baseNow + 2000;
        return { body: makePassedRun(runId, 'test_be_01') };
      }
      return { body: makePassedRun(runId, 'test_be_02') };
    });

    try {
      await runTestRunAll(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_be',
          wait: true,
          timeoutSeconds: 1,
          maxConcurrency: 1,
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: line => stdoutLines.push(line),
          stderr: () => undefined,
          sleep: instantSleep,
        },
      );
    } catch (err) {
      caughtError = err;
    } finally {
      nowSpy.mockRestore();
    }

    const payload = JSON.parse(stdoutLines.join('\n')) as {
      accepted: Array<{ runId: string; status: string }>;
    };
    expect(runFetches).toEqual(['run_fresh_01']);
    expect(payload.accepted.find(r => r.runId === 'run_fresh_02')?.status).toBe('timeout');
    expect((caughtError as { exitCode?: number } | undefined)?.exitCode).toBe(7);
  });

  it('--wait with a failed run → exit 1', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch((url, init) => {
      const method = init.method ?? 'GET';
      if (method === 'POST') return { body: BATCH_FRESH_RESP };
      const runId = url.split('/runs/')[1]?.split('?')[0] ?? 'run_unknown';
      const run = makePassedRun(runId, 'test_be_01');
      if (runId === 'run_fresh_01')
        return { body: { ...run, status: 'failed', failureKind: 'assertion' } };
      return { body: run };
    });
    await expect(
      runTestRunAll(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_be',
          wait: true,
          timeoutSeconds: 60,
          maxConcurrency: 5,
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: () => undefined,
          stderr: () => undefined,
          sleep: instantSleep,
        },
      ),
    ).rejects.toMatchObject({ exitCode: 1 });
  });

  it('skippedFrontend[] reported on stderr as advisory', async () => {
    const { credentialsPath } = makeCreds();
    const respWithSkipped: BatchRunFreshResponse = {
      accepted: [{ testId: 'test_be_01', runId: 'run_01', enqueuedAt: '2026-06-09T10:00:00.000Z' }],
      conflicts: [],
      deferred: [],
      skippedFrontend: ['test_fe_01', 'test_fe_02'],
      skippedIntegration: [],
    };
    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { body: { items: [], nextToken: null } };
      return { body: respWithSkipped };
    });
    const stderrLines: string[] = [];
    await runTestRunAll(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_be',
        wait: false,
        timeoutSeconds: 600,
        maxConcurrency: 10,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    expect(stderrLines.some(l => l.includes('[advisory]') && l.includes('frontend'))).toBe(true);
    expect(stderrLines.some(l => l.includes('2'))).toBe(true);
  });

  it('deferred[] (rate-limited) forces exit 7 with a retry hint (non-wait)', async () => {
    const { credentialsPath } = makeCreds();
    const respWithDeferred: BatchRunFreshResponse = {
      accepted: [{ testId: 'test_be_01', runId: 'run_01', enqueuedAt: '2026-06-09T10:00:00.000Z' }],
      conflicts: [],
      deferred: [{ testId: 'test_be_02' }, { testId: 'test_be_03' }],
      skippedFrontend: [],
      skippedIntegration: [],
    };
    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { body: { items: [], nextToken: null } };
      return { body: respWithDeferred };
    });
    const stderrLines: string[] = [];
    await expect(
      runTestRunAll(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_be',
          wait: false,
          timeoutSeconds: 600,
          maxConcurrency: 10,
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: () => undefined,
          stderr: line => stderrLines.push(line),
          sleep: instantSleep,
        },
      ),
    ).rejects.toMatchObject({ exitCode: 7 });
    expect(stderrLines.some(l => l.toLowerCase().includes('rate-deferred'))).toBe(true);
  });

  it('all-conflict, nothing accepted → CONFLICT (exit 6)', async () => {
    const { credentialsPath } = makeCreds();
    const respAllConflict: BatchRunFreshResponse = {
      accepted: [],
      conflicts: [{ testId: 'test_be_01' }],
      deferred: [],
      skippedFrontend: [],
      skippedIntegration: [],
    };
    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { body: { items: [], nextToken: null } };
      return { body: respAllConflict };
    });
    await expect(
      runTestRunAll(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_be',
          wait: false,
          timeoutSeconds: 600,
          maxConcurrency: 10,
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: () => undefined,
          stderr: () => undefined,
          sleep: instantSleep,
        },
      ),
    ).rejects.toMatchObject({ exitCode: 6 });
  });

  it('skippedIntegration[] reported on stderr as advisory', async () => {
    const { credentialsPath } = makeCreds();
    const respWithIntegration: BatchRunFreshResponse = {
      accepted: [{ testId: 'test_be_01', runId: 'run_01', enqueuedAt: '2026-06-09T10:00:00.000Z' }],
      conflicts: [],
      deferred: [],
      skippedFrontend: [],
      skippedIntegration: [{ testId: 'test_be_integ_01' }],
    };
    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { body: { items: [], nextToken: null } };
      return { body: respWithIntegration };
    });
    const stderrLines: string[] = [];
    await runTestRunAll(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_be',
        wait: false,
        timeoutSeconds: 600,
        maxConcurrency: 10,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    expect(
      stderrLines.some(l => l.includes('[advisory]') && l.toLowerCase().includes('integration')),
    ).toBe(true);
  });

  it('--dry-run returns sample without network call', async () => {
    resetDryRunBannerForTesting();
    const fetchImpl = vi.fn() as unknown as FetchImpl;
    const out: string[] = [];
    const err: string[] = [];
    await runTestRunAll(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        projectId: 'project_be',
        wait: false,
        timeoutSeconds: 600,
        maxConcurrency: 10,
      },
      {
        fetchImpl,
        stdout: line => out.push(line),
        stderr: line => err.push(line),
        sleep: instantSleep,
      },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    // Should print a non-empty JSON body (sample or envelope)
    expect(out.length).toBeGreaterThan(0);
    // DEV-247: the canned sample must carry the "not from the server" banner.
    expect(err).toContain(DRY_RUN_BANNER);
  });

  it('--wait with timeout → exit 7', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'POST') return { body: BATCH_FRESH_RESP };
      // Always return running so we hit timeout
      return {
        body: {
          runId: 'run_fresh_01',
          testId: 'test_be_01',
          projectId: 'project_be',
          userId: 'u1',
          status: 'running',
          source: 'cli',
          createdAt: '2026-06-09T10:00:00.000Z',
          startedAt: '2026-06-09T10:00:01.000Z',
          finishedAt: null,
          codeVersion: 'v1',
          targetUrl: 'https://api.example.com',
          createdFrom: 'cli',
          failedStepIndex: null,
          failureKind: null,
          error: null,
          videoUrl: null,
          stepSummary: { total: 3, completed: 1, passedCount: 0, failedCount: 0 },
        } satisfies RunResponse,
      };
    });
    await expect(
      runTestRunAll(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_be',
          wait: true,
          timeoutSeconds: 1,
          maxConcurrency: 5,
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: () => undefined,
          stderr: () => undefined,
          sleep: instantSleep,
        },
      ),
    ).rejects.toMatchObject({ exitCode: 7 });
  });
});

// ---------------------------------------------------------------------------
// [P1] D3 deferred-retry: conflicts discovered during retries must be merged
// into the running conflicts collection and appear in the final summary/JSON.
// Without the fix the code only logged them; the final accounting still showed
// only initial conflicts → everything-deferred→retried→conflicted would exit 0
// with zero accepted/deferred/conflicts reported.
// ---------------------------------------------------------------------------

describe('[codex-P1] run --all deferred-retry: retry-conflicts merged into final accounting', () => {
  it('deferred→conflict on retry: summary.conflicts reflects retry-returned conflicts; exits 6 when all paths resolve to conflict', async () => {
    const { credentialsPath } = makeCreds();

    // Initial dispatch: 1 deferred, 0 accepted, 0 initial conflicts.
    const initialResp: BatchRunFreshResponse = {
      accepted: [],
      deferred: [{ testId: 'test_deferred' }],
      conflicts: [],
      skippedFrontend: [],
      skippedIntegration: [],
    };
    // Retry response: the deferred test is now in-flight (conflict).
    const retryResp: BatchRunFreshResponse = {
      accepted: [],
      deferred: [],
      conflicts: [{ testId: 'test_deferred' }],
      skippedFrontend: [],
      skippedIntegration: [],
    };

    let batchCallCount = 0;
    const printed: Array<Record<string, unknown>> = [];
    const stderrLines: string[] = [];

    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        batchCallCount++;
        return { body: batchCallCount === 1 ? initialResp : retryResp };
      }
      return errorBody('NOT_FOUND');
    });

    try {
      await runTestRunAll(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_be',
          wait: true,
          timeoutSeconds: 300,
          maxConcurrency: 5,
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: line => printed.push(JSON.parse(line) as Record<string, unknown>),
          stderr: line => stderrLines.push(line),
          sleep: instantSleep,
        },
      );
      // Should not reach here: exit 6 because accepted=0 and conflicts>0 after retry
      throw new Error('Expected runTestRunAll to throw');
    } catch (err) {
      // After D3 retries drain deferred→conflict: accepted=0, conflicts=[test_deferred]
      // The code should throw CONFLICT (exit 6) because accepted=0 and conflicts>0.
      expect((err as ApiError).exitCode).toBe(6);
    }

    // The retry must have fired (initial + 1 retry = 2 calls, since deferred drains)
    expect(batchCallCount).toBeGreaterThanOrEqual(2);

    // The final JSON payload must include the retry-discovered conflict, not just the initial []
    const withConflicts = printed.find(
      p => Array.isArray(p.conflicts) && (p.conflicts as unknown[]).length > 0,
    );
    expect(withConflicts).toBeDefined();
    expect(
      (withConflicts?.conflicts as Array<{ testId: string }>).some(
        c => c.testId === 'test_deferred',
      ),
    ).toBe(true);
  });

  it('deferred→partially-conflict on retry: retry-conflicts appear in JSON summary; exit 0 for accepted portion', async () => {
    const { credentialsPath } = makeCreds();

    // Initial dispatch: 2 deferred, 1 accepted.
    const initialResp: BatchRunFreshResponse = {
      accepted: [{ testId: 'test_ok', runId: 'run_ok', enqueuedAt: '2026-06-09T10:00:00.000Z' }],
      deferred: [{ testId: 'test_deferred_a' }, { testId: 'test_deferred_b' }],
      conflicts: [],
      skippedFrontend: [],
      skippedIntegration: [],
    };
    // Retry: one accepted, one becomes conflict.
    const retryResp: BatchRunFreshResponse = {
      accepted: [
        {
          testId: 'test_deferred_a',
          runId: 'run_deferred_a',
          enqueuedAt: '2026-06-09T10:00:01.000Z',
        },
      ],
      deferred: [],
      conflicts: [{ testId: 'test_deferred_b' }],
      skippedFrontend: [],
      skippedIntegration: [],
    };

    let batchCallCount = 0;
    const printed: Array<Record<string, unknown>> = [];

    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        batchCallCount++;
        return { body: batchCallCount === 1 ? initialResp : retryResp };
      }
      // Poll: both accepted runs return passed
      if (url.includes('/runs/run_ok')) {
        return {
          body: {
            runId: 'run_ok',
            testId: 'test_ok',
            projectId: 'project_be',
            userId: 'u1',
            status: 'passed',
            source: 'cli',
            createdAt: '2026-06-09T10:00:00.000Z',
            startedAt: '2026-06-09T10:00:01.000Z',
            finishedAt: '2026-06-09T10:00:30.000Z',
            codeVersion: 'v1',
            targetUrl: 'https://api.example.com',
            createdFrom: 'cli',
            failedStepIndex: null,
            failureKind: null,
            error: null,
            videoUrl: null,
            stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 },
          } satisfies RunResponse,
        };
      }
      if (url.includes('/runs/run_deferred_a')) {
        return {
          body: {
            runId: 'run_deferred_a',
            testId: 'test_deferred_a',
            projectId: 'project_be',
            userId: 'u1',
            status: 'passed',
            source: 'cli',
            createdAt: '2026-06-09T10:00:00.000Z',
            startedAt: '2026-06-09T10:00:01.000Z',
            finishedAt: '2026-06-09T10:00:30.000Z',
            codeVersion: 'v1',
            targetUrl: 'https://api.example.com',
            createdFrom: 'cli',
            failedStepIndex: null,
            failureKind: null,
            error: null,
            videoUrl: null,
            stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 },
          } satisfies RunResponse,
        };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRunAll(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_be',
        wait: true,
        timeoutSeconds: 300,
        maxConcurrency: 5,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => printed.push(JSON.parse(line) as Record<string, unknown>),
        stderr: () => undefined,
        sleep: instantSleep,
      },
    );

    // summary must include the retry-discovered conflict in the conflicts count
    const withSummary = printed.find(p => p.summary);
    expect(withSummary).toBeDefined();
    expect((withSummary?.summary as Record<string, number>).conflicts).toBe(1);
    expect((withSummary?.summary as Record<string, number>).passed).toBe(2); // both accepted runs passed
    expect(
      (withSummary?.conflicts as Array<{ testId: string }>).some(
        c => c.testId === 'test_deferred_b',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [P2] D3 idempotency key truncation: derived retry keys stay ≤ 256 chars
// ---------------------------------------------------------------------------

describe('[codex-P2] run --all deferred-retry: idempotency key truncation', () => {
  it('retry idempotency key does not exceed 256 chars when base key is at the 256-char limit', async () => {
    const { credentialsPath } = makeCreds();

    // A caller-supplied key exactly at the 256-char limit
    const longKey = 'k'.repeat(256);

    const initialResp: BatchRunFreshResponse = {
      accepted: [],
      deferred: [{ testId: 'test_deferred' }],
      conflicts: [],
      skippedFrontend: [],
      skippedIntegration: [],
    };
    const retryResp: BatchRunFreshResponse = {
      accepted: [
        { testId: 'test_deferred', runId: 'run_d', enqueuedAt: '2026-06-09T10:00:00.000Z' },
      ],
      deferred: [],
      conflicts: [],
      skippedFrontend: [],
      skippedIntegration: [],
    };

    const capturedIdempotencyKeys: string[] = [];
    let batchCallCount = 0;

    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'POST') {
        const key = (init.headers as Record<string, string>)?.['idempotency-key'] ?? '';
        capturedIdempotencyKeys.push(key);
        batchCallCount++;
        return { body: batchCallCount === 1 ? initialResp : retryResp };
      }
      if (url.includes('/runs/run_d')) {
        return {
          body: {
            runId: 'run_d',
            testId: 'test_deferred',
            projectId: 'project_be',
            userId: 'u1',
            status: 'passed',
            source: 'cli',
            createdAt: '2026-06-09T10:00:00.000Z',
            startedAt: '2026-06-09T10:00:01.000Z',
            finishedAt: '2026-06-09T10:00:30.000Z',
            codeVersion: 'v1',
            targetUrl: 'https://api.example.com',
            createdFrom: 'cli',
            failedStepIndex: null,
            failureKind: null,
            error: null,
            videoUrl: null,
            stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 },
          } satisfies RunResponse,
        };
      }
      return errorBody('NOT_FOUND');
    });

    await runTestRunAll(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_be',
        wait: true,
        timeoutSeconds: 300,
        maxConcurrency: 5,
        idempotencyKey: longKey,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: () => undefined,
        sleep: instantSleep,
      },
    );

    // All captured keys must be ≤ 256 chars
    for (const key of capturedIdempotencyKeys) {
      expect(key.length).toBeLessThanOrEqual(256);
    }
    // The retry key must differ from the base key (suffix was appended)
    expect(capturedIdempotencyKeys.length).toBeGreaterThanOrEqual(2);
    expect(capturedIdempotencyKeys[1]).not.toBe(longKey);
    expect(capturedIdempotencyKeys[1]).toContain('deferred-retry');
  });
});

// ---------------------------------------------------------------------------
// [B-E2E-01] Fix 1 regression — blocked/failed runs must exit 1 under --wait
// ---------------------------------------------------------------------------

describe('[B-E2E-01] runTestRunAll --wait: non-passed runs must exit 1 (regression)', () => {
  // The unit tests below pin the post-retry exit-code path so any future
  // refactor that accidentally drops the `if (failed > 0) throw CLIError(…, 1)`
  // guard is caught immediately (blocked status had no dedicated test before).

  const BATCH_RESP_BLOCKED: BatchRunFreshResponse = {
    accepted: [
      { testId: 'test_be_01', runId: 'run_blocked_01', enqueuedAt: '2026-06-09T11:00:00.000Z' },
      { testId: 'test_be_02', runId: 'run_passed_02', enqueuedAt: '2026-06-09T11:00:01.000Z' },
    ],
    conflicts: [],
    deferred: [],
    skippedFrontend: [],
    skippedIntegration: [],
  };

  function makeTerminalRun(runId: string, testId: string, status: string): RunResponse {
    return {
      runId,
      testId,
      projectId: 'project_be',
      userId: 'user_1',
      status: status as RunResponse['status'],
      source: 'cli',
      createdAt: '2026-06-09T11:00:00.000Z',
      startedAt: '2026-06-09T11:00:01.000Z',
      finishedAt: '2026-06-09T11:00:30.000Z',
      codeVersion: 'v1',
      targetUrl: 'https://api.example.com',
      createdFrom: 'cli',
      failedStepIndex: null,
      failureKind: null,
      error: null,
      videoUrl: null,
      stepSummary: {
        total: 3,
        completed: 3,
        passedCount: status === 'passed' ? 3 : 0,
        failedCount: 0,
      },
    };
  }

  it('--wait with a blocked run → exit 1 (not 0)', async () => {
    // Regression test: before the fix, 51 blocked/failed runs could exit 0.
    // Specifically test `blocked` status which had no dedicated coverage.
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'POST') return { body: BATCH_RESP_BLOCKED };
      const runId = url.split('/runs/')[1]?.split('?')[0] ?? '';
      if (runId === 'run_blocked_01')
        return { body: makeTerminalRun('run_blocked_01', 'test_be_01', 'blocked') };
      if (runId === 'run_passed_02')
        return { body: makeTerminalRun('run_passed_02', 'test_be_02', 'passed') };
      return errorBody('NOT_FOUND');
    });
    await expect(
      runTestRunAll(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_be',
          wait: true,
          timeoutSeconds: 60,
          maxConcurrency: 5,
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: () => undefined,
          stderr: () => undefined,
          sleep: instantSleep,
        },
      ),
    ).rejects.toMatchObject({ exitCode: 1 });
  });

  it('--wait all blocked (51 blocked out of 51) → exit 1, not 0', async () => {
    // Mirrors the live E2E observation: 51 blocked/failed in a 100-run batch.
    // Uses a smaller batch (3 blocked) to keep the test fast.
    const { credentialsPath } = makeCreds();
    const allBlocked: BatchRunFreshResponse = {
      accepted: [
        { testId: 'test_1', runId: 'run_b1', enqueuedAt: '2026-06-09T11:00:00.000Z' },
        { testId: 'test_2', runId: 'run_b2', enqueuedAt: '2026-06-09T11:00:01.000Z' },
        { testId: 'test_3', runId: 'run_b3', enqueuedAt: '2026-06-09T11:00:02.000Z' },
      ],
      conflicts: [],
      deferred: [],
      skippedFrontend: [],
      skippedIntegration: [],
    };
    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'POST') return { body: allBlocked };
      const runId = url.split('/runs/')[1]?.split('?')[0] ?? '';
      return { body: makeTerminalRun(runId, 'test_x', 'blocked') };
    });
    await expect(
      runTestRunAll(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_be',
          wait: true,
          timeoutSeconds: 60,
          maxConcurrency: 5,
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: () => undefined,
          stderr: () => undefined,
          sleep: instantSleep,
        },
      ),
    ).rejects.toMatchObject({ exitCode: 1 });
  });

  it('--wait mixed blocked+failed → exit 1 with summary.failed = 2', async () => {
    const { credentialsPath } = makeCreds();
    const mixedBatch: BatchRunFreshResponse = {
      accepted: [
        { testId: 'test_p', runId: 'run_p', enqueuedAt: '2026-06-09T11:00:00.000Z' },
        { testId: 'test_b', runId: 'run_b', enqueuedAt: '2026-06-09T11:00:01.000Z' },
        { testId: 'test_f', runId: 'run_f', enqueuedAt: '2026-06-09T11:00:02.000Z' },
      ],
      conflicts: [],
      deferred: [],
      skippedFrontend: [],
      skippedIntegration: [],
    };
    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'POST') return { body: mixedBatch };
      const runId = url.split('/runs/')[1]?.split('?')[0] ?? '';
      if (runId === 'run_p') return { body: makeTerminalRun('run_p', 'test_p', 'passed') };
      if (runId === 'run_b') return { body: makeTerminalRun('run_b', 'test_b', 'blocked') };
      if (runId === 'run_f') return { body: makeTerminalRun('run_f', 'test_f', 'failed') };
      return errorBody('NOT_FOUND');
    });

    const stdoutLines: string[] = [];
    let caughtError: unknown;
    try {
      await runTestRunAll(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_be',
          wait: true,
          timeoutSeconds: 60,
          maxConcurrency: 5,
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: line => stdoutLines.push(line),
          stderr: () => undefined,
          sleep: instantSleep,
        },
      );
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeDefined();
    expect((caughtError as { exitCode?: number }).exitCode).toBe(1);

    // The JSON payload (written to stdout before throwing) must contain
    // summary.failed = 2 (1 blocked + 1 failed).
    const payload = JSON.parse(stdoutLines.join('\n')) as {
      summary: { passed: number; failed: number };
    };
    expect(payload.summary.passed).toBe(1);
    expect(payload.summary.failed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runTestRunAll — --max-concurrency upper bound (Fix 2)
// ---------------------------------------------------------------------------

describe('runTestRunAll — --max-concurrency validation', () => {
  it('rejects --max-concurrency > 100 with VALIDATION_ERROR (exit 5)', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runTestRunAll(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_be',
          wait: false,
          timeoutSeconds: 600,
          maxConcurrency: 101,
        },
        { credentialsPath, sleep: () => Promise.resolve() },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: expect.objectContaining({ field: 'max-concurrency' }),
    });
  });

  it('accepts --max-concurrency = 100 (boundary value, no validation error)', async () => {
    const { credentialsPath } = makeCreds();
    const BATCH_FRESH_RESP: BatchRunFreshResponse = {
      accepted: [],
      conflicts: [],
      deferred: [],
      skippedFrontend: [],
      skippedIntegration: [],
    };
    const fetchImpl = makeFetch(() => ({ body: BATCH_FRESH_RESP }));
    // Should resolve without VALIDATION_ERROR
    await expect(
      runTestRunAll(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_be',
          wait: false,
          timeoutSeconds: 600,
          maxConcurrency: 100,
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: () => undefined,
          stderr: () => undefined,
          sleep: () => Promise.resolve(),
        },
      ),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// dashboardUrl on run completion (colleague feedback 2026-06-10): terminal
// run output carries a Portal deep link — projectId+testId come from the
// GET /runs/{runId} wire row (single run) or opts+item (run --all).
// ---------------------------------------------------------------------------

describe('dashboardUrl on run completion', () => {
  const PROD_API = 'https://api.testsprite.com';

  function triggerThenTerminal(run: RunResponse): typeof globalThis.fetch {
    return makeFetch(url => {
      if (url.includes('/tests/') && url.includes('/runs') && !url.includes('/runs/run_abc')) {
        return { body: TRIGGER_RESP };
      }
      return { body: run };
    });
  }

  it('run --wait (JSON, prod endpoint): final envelope includes dashboardUrl', async () => {
    const { credentialsPath } = makeCreds('sk-user-test', PROD_API);
    const stdout: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: triggerThenTerminal(makePassedRun()),
        stdout: line => stdout.push(line),
        stderr: () => undefined,
        sleep: instantSleep,
      },
    );
    const printed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(printed.dashboardUrl).toBe(
      'https://www.testsprite.com/dashboard/tests/project_1/test/test_xyz',
    );
  });

  it('run --wait (text, prod endpoint): card ends with dashboard line', async () => {
    const { credentialsPath } = makeCreds('sk-user-test', PROD_API);
    const stdout: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: triggerThenTerminal(makePassedRun()),
        stdout: line => stdout.push(line),
        stderr: () => undefined,
        sleep: instantSleep,
      },
    );
    expect(stdout.join('\n')).toContain(
      'dashboard   https://www.testsprite.com/dashboard/tests/project_1/test/test_xyz',
    );
  });

  it('run --wait (unknown API host): no dashboardUrl field', async () => {
    const { credentialsPath } = makeCreds(); // localhost default
    const stdout: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: triggerThenTerminal(makePassedRun()),
        stdout: line => stdout.push(line),
        stderr: () => undefined,
        sleep: instantSleep,
      },
    );
    const printed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(printed.dashboardUrl).toBeUndefined();
  });

  it('run --wait: empty projectId on the run row → no dashboardUrl (BE fallback guard)', async () => {
    const { credentialsPath } = makeCreds('sk-user-test', PROD_API);
    const stdout: string[] = [];
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_xyz',
        wait: true,
        timeoutSeconds: 60,
      },
      {
        credentialsPath,
        fetchImpl: triggerThenTerminal({ ...makePassedRun(), projectId: '' }),
        stdout: line => stdout.push(line),
        stderr: () => undefined,
        sleep: instantSleep,
      },
    );
    const printed = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(printed.dashboardUrl).toBeUndefined();
  });

  it('run --all no-wait (prod endpoint): accepted items carry dashboardUrl; text has project line', async () => {
    const { credentialsPath } = makeCreds('sk-user-test', PROD_API);
    const batchResp: BatchRunFreshResponse = {
      accepted: [
        { testId: 'test_be_01', runId: 'run_f_01', enqueuedAt: '2026-06-10T10:00:00.000Z' },
        { testId: 'test_be_02', runId: 'run_f_02', enqueuedAt: '2026-06-10T10:00:01.000Z' },
      ],
      conflicts: [],
      deferred: [],
      skippedFrontend: [],
      skippedIntegration: [],
    };
    const jsonOut: string[] = [];
    await runTestRunAll(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_be',
        wait: false,
        timeoutSeconds: 600,
        maxConcurrency: 10,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(() => ({ body: batchResp })),
        stdout: line => jsonOut.push(line),
        stderr: () => undefined,
        sleep: instantSleep,
      },
    );
    const printed = JSON.parse(jsonOut.join('')) as {
      accepted: Array<{ testId: string; dashboardUrl?: string }>;
    };
    expect(printed.accepted[0]!.dashboardUrl).toBe(
      'https://www.testsprite.com/dashboard/tests/project_be/test/test_be_01',
    );
    expect(printed.accepted[1]!.dashboardUrl).toBe(
      'https://www.testsprite.com/dashboard/tests/project_be/test/test_be_02',
    );

    const textOut: string[] = [];
    await runTestRunAll(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_be',
        wait: false,
        timeoutSeconds: 600,
        maxConcurrency: 10,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(() => ({ body: batchResp })),
        stdout: line => textOut.push(line),
        stderr: () => undefined,
        sleep: instantSleep,
      },
    );
    expect(textOut.join('\n')).toContain(
      'dashboard     https://www.testsprite.com/dashboard/tests/project_be',
    );
  });

  it('run --all: emits the auto-minted idempotency-key on stderr in JSON output mode (parity with test run)', async () => {
    const { credentialsPath } = makeCreds('sk-user-test', PROD_API);
    const batchResp: BatchRunFreshResponse = {
      accepted: [
        { testId: 'test_be_01', runId: 'run_f_01', enqueuedAt: '2026-06-10T10:00:00.000Z' },
      ],
      conflicts: [],
      deferred: [],
      skippedFrontend: [],
      skippedIntegration: [],
    };
    const stderrLines: string[] = [];
    await runTestRunAll(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_be',
        wait: false,
        timeoutSeconds: 600,
        maxConcurrency: 10,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(() => ({ body: batchResp })),
        stdout: () => undefined,
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    expect(stderrLines.some(l => l.startsWith('idempotency-key:'))).toBe(true);
  });

  it('run --all --wait (prod endpoint): summary items carry dashboardUrl + stderr Dashboard line', async () => {
    const { credentialsPath } = makeCreds('sk-user-test', PROD_API);
    const batchResp: BatchRunFreshResponse = {
      accepted: [
        { testId: 'test_be_01', runId: 'run_f_01', enqueuedAt: '2026-06-10T10:00:00.000Z' },
      ],
      conflicts: [],
      deferred: [],
      skippedFrontend: [],
      skippedIntegration: [],
    };
    const terminal: RunResponse = {
      runId: 'run_f_01',
      testId: 'test_be_01',
      projectId: 'project_be',
      userId: 'user_1',
      status: 'passed',
      source: 'cli',
      createdAt: '2026-06-10T10:00:00.000Z',
      startedAt: '2026-06-10T10:00:01.000Z',
      finishedAt: '2026-06-10T10:00:05.000Z',
      codeVersion: 'v1',
      targetUrl: 'https://api.example.com',
      createdFrom: 'cli',
      failedStepIndex: null,
      failureKind: null,
      error: null,
      videoUrl: null,
      stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 },
    };
    const jsonOut: string[] = [];
    const stderrLines: string[] = [];
    await runTestRunAll(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_be',
        wait: true,
        timeoutSeconds: 600,
        maxConcurrency: 10,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(url => {
          if (url.includes('batch/run')) return { body: batchResp };
          return { body: terminal };
        }),
        stdout: line => jsonOut.push(line),
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );
    const printed = JSON.parse(jsonOut.join('')) as {
      accepted: Array<{ testId: string; dashboardUrl?: string }>;
    };
    expect(printed.accepted[0]!.dashboardUrl).toBe(
      'https://www.testsprite.com/dashboard/tests/project_be/test/test_be_01',
    );
    expect(
      stderrLines.some(l =>
        l.includes('Dashboard: https://www.testsprite.com/dashboard/tests/project_be'),
      ),
    ).toBe(true);
  });
});

describe('runTestRunAll — JUnit report export', () => {
  const BATCH_FRESH_RESP: BatchRunFreshResponse = {
    accepted: [
      { testId: 'test_be_01', runId: 'run_fresh_01', enqueuedAt: '2026-06-09T10:00:00.000Z' },
      { testId: 'test_be_02', runId: 'run_fresh_02', enqueuedAt: '2026-06-09T10:00:01.000Z' },
    ],
    conflicts: [],
    deferred: [],
    skippedFrontend: [],
    skippedIntegration: [],
  };

  function makeTerminalRun(runId: string, testId: string, status: string): RunResponse {
    return {
      runId,
      testId,
      projectId: 'project_be',
      userId: 'user_1',
      status: status as RunResponse['status'],
      source: 'cli',
      createdAt: '2026-06-09T10:00:00.000Z',
      startedAt: '2026-06-09T10:00:01.000Z',
      finishedAt: '2026-06-09T10:00:30.000Z',
      codeVersion: 'v1',
      targetUrl: 'https://api.example.com',
      createdFrom: 'cli',
      failedStepIndex: null,
      failureKind: null,
      error: null,
      videoUrl: null,
      stepSummary: {
        total: 3,
        completed: 3,
        passedCount: status === 'passed' ? 3 : 0,
        failedCount: 0,
      },
    };
  }

  it('--wait --report junit writes XML after polling', async () => {
    const { credentialsPath } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'junit-run-all-'));
    const reportPath = join(dir, 'results.xml');
    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'POST') return { body: BATCH_FRESH_RESP };
      const runId = url.split('/runs/')[1]?.split('?')[0] ?? '';
      if (runId === 'run_fresh_01')
        return { body: makeTerminalRun('run_fresh_01', 'test_be_01', 'passed') };
      if (runId === 'run_fresh_02')
        return { body: makeTerminalRun('run_fresh_02', 'test_be_02', 'passed') };
      return errorBody('NOT_FOUND');
    });

    await runTestRunAll(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_be',
        wait: true,
        timeoutSeconds: 60,
        maxConcurrency: 5,
        report: 'junit',
        reportFile: reportPath,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: () => undefined,
        sleep: instantSleep,
      },
    );

    const xml = readFileSync(reportPath, 'utf8');
    expect(xml).toContain('<testsuite name="testsprite:project_be"');
    expect(xml).toContain('name="test_be_01"');
    expect(xml).toContain('name="test_be_02"');
    expect(xml).toContain('failures="0"');
  });

  it('--wait --report junit writes XML even when batch exits 1', async () => {
    const { credentialsPath } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'junit-run-fail-'));
    const reportPath = join(dir, 'results.xml');
    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'POST') return { body: BATCH_FRESH_RESP };
      const runId = url.split('/runs/')[1]?.split('?')[0] ?? '';
      if (runId === 'run_fresh_01')
        return { body: makeTerminalRun('run_fresh_01', 'test_be_01', 'passed') };
      if (runId === 'run_fresh_02')
        return { body: makeTerminalRun('run_fresh_02', 'test_be_02', 'failed') };
      return errorBody('NOT_FOUND');
    });

    await expect(
      runTestRunAll(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_be',
          wait: true,
          timeoutSeconds: 60,
          maxConcurrency: 5,
          report: 'junit',
          reportFile: reportPath,
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: () => undefined,
          stderr: () => undefined,
          sleep: instantSleep,
        },
      ),
    ).rejects.toMatchObject({ exitCode: 1 });

    const xml = readFileSync(reportPath, 'utf8');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('name="test_be_02"');
  });

  it('rejects --report without --wait', async () => {
    await expect(
      runTestRunAll(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_be',
          wait: false,
          timeoutSeconds: 60,
          maxConcurrency: 5,
          report: 'junit',
          reportFile: './results.xml',
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('rejects --report-suite-name without --report', async () => {
    await expect(
      runTestRunAll(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_be',
          wait: true,
          timeoutSeconds: 60,
          maxConcurrency: 5,
          reportSuiteName: 'orphan-suite',
        },
        {},
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('--dry-run --report junit writes canned sample XML', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'junit-run-dry-'));
    const reportPath = join(dir, 'results.xml');

    await runTestRunAll(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        projectId: 'project_be',
        wait: true,
        timeoutSeconds: 60,
        maxConcurrency: 5,
        report: 'junit',
        reportFile: reportPath,
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
      },
    );

    const xml = readFileSync(reportPath, 'utf8');
    expect(xml).toContain('name="test_fresh_wave_01"');
    expect(xml).toContain('failures="1"');
  });

  it('--dry-run --report junit --report-suite-name overrides canned suite name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'junit-run-dry-suite-'));
    const reportPath = join(dir, 'results.xml');

    await runTestRunAll(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        projectId: 'project_be',
        wait: true,
        timeoutSeconds: 60,
        maxConcurrency: 5,
        report: 'junit',
        reportFile: reportPath,
        reportSuiteName: 'ci-checkout-suite',
      },
      {
        stdout: () => undefined,
        stderr: () => undefined,
      },
    );

    const xml = readFileSync(reportPath, 'utf8');
    expect(xml).toContain('<testsuite name="ci-checkout-suite"');
    expect(xml).not.toContain('testsprite:project_be');
  });
});
