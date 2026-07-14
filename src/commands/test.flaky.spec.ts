/**
 * Unit tests for `test flaky` — the repeat-run flaky-test detector.
 *
 * All HTTP is mocked via `makeFlakyFetch`. The polling loop's sleep is injected
 * through `TestDeps.sleep` to avoid real delays. Each rerun POST returns a
 * unique runId; each run GET returns a terminal status scripted per attempt,
 * so a test can assert stable / flaky / failing verdicts deterministically.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIError, ApiError } from '../lib/errors.js';
import type { FlakyReport } from '../lib/flaky.js';
import type { FetchImpl } from '../lib/http.js';
import { runFlaky } from './test.js';

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type RunStatus = 'passed' | 'failed' | 'blocked' | 'cancelled';

function urlOf(input: FetchInput): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : (input as { url: string }).url;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Build a fetch that:
 *  - GET  /tests/{id}                → the test record ('frontend' | 'backend')
 *  - POST /tests/{id}/runs/rerun     → a queued rerun with runId run_<n> (n increments)
 *  - GET  /runs/run_<k>              → a terminal run with statuses[k-1]
 *
 * `notFoundOnTrigger` makes the rerun POST return 404 (no replayable run).
 */
function makeFlakyFetch(opts: {
  statuses: RunStatus[];
  testType?: 'frontend' | 'backend';
  notFoundOnTrigger?: boolean;
}): { fetchImpl: FetchImpl; triggerCount: () => number } {
  let triggers = 0;
  const testType = opts.testType ?? 'frontend';
  const fetchImpl = (async (input: FetchInput, init: RequestInit = {}) => {
    const url = urlOf(input);
    const method = (init.method ?? 'GET').toUpperCase();

    if (method === 'GET' && /\/tests\/[^/]+$/.test(url.split('?')[0]!)) {
      return jsonResponse(200, {
        id: 'test_x',
        projectId: 'project_abc',
        name: 'sample',
        type: testType,
        createdFrom: 'portal',
        status: 'passed',
        createdAt: '2026-06-01T10:00:00.000Z',
        updatedAt: '2026-06-01T10:00:00.000Z',
      });
    }

    if (method === 'POST' && url.includes('/runs/rerun')) {
      if (opts.notFoundOnTrigger) {
        return jsonResponse(404, {
          error: {
            code: 'NOT_FOUND',
            message: 'no replayable run',
            nextAction: 'run it',
            requestId: 'req_1',
            details: {},
          },
        });
      }
      triggers += 1;
      return jsonResponse(200, {
        runId: `run_${triggers}`,
        status: 'queued',
        enqueuedAt: '2026-06-03T10:00:00.000Z',
        codeVersion: 'v1',
        autoHeal: false,
      });
    }

    const runMatch = /\/runs\/(run_\d+)/.exec(url);
    if (method === 'GET' && runMatch) {
      const runId = runMatch[1]!;
      const idx = Number(runId.replace('run_', '')) - 1;
      const status = opts.statuses[idx] ?? 'passed';
      return jsonResponse(200, {
        runId,
        testId: 'test_x',
        projectId: 'project_abc',
        userId: 'user_1',
        status,
        source: 'cli',
        createdAt: '2026-06-03T10:00:00.000Z',
        startedAt: '2026-06-03T10:00:01.000Z',
        finishedAt: '2026-06-03T10:00:30.000Z',
        codeVersion: 'v1',
        targetUrl: 'https://example.com',
        createdFrom: 'rerun:prior',
        failedStepIndex: status === 'passed' ? null : 2,
        failureKind: status === 'passed' ? null : 'assertion',
        error: null,
        videoUrl: null,
        stepSummary: { total: 5, completed: 5, passedCount: 5, failedCount: 0 },
      });
    }

    return jsonResponse(404, {
      error: { code: 'NOT_FOUND', message: 'unmatched', requestId: 'x', details: {} },
    });
  }) as FetchImpl;

  return { fetchImpl, triggerCount: () => triggers };
}

function makeCreds(): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-flaky-'));
  const credentialsPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    credentialsPath,
    `[default]\napi_url = http://localhost:13509\napi_key = sk-user-test\n`,
    {
      mode: 0o600,
    },
  );
  return { credentialsPath };
}

const instantSleep = (): Promise<void> => Promise.resolve();

function makeDeps(fetchImpl: FetchImpl): {
  deps: {
    credentialsPath: string;
    fetchImpl: FetchImpl;
    sleep: () => Promise<void>;
    stdout: (l: string) => void;
    stderr: (l: string) => void;
  };
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const { credentialsPath } = makeCreds();
  return {
    deps: {
      credentialsPath,
      fetchImpl,
      sleep: instantSleep,
      stdout: (l: string) => stdout.push(l),
      stderr: (l: string) => stderr.push(l),
    },
    stdout,
    stderr,
  };
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

describe('createTestCommand — flaky subcommand exposed', () => {
  it('exposes flaky with its flags', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
    const flaky = test.commands.find(c => c.name() === 'flaky');
    expect(flaky).toBeDefined();
    const flagNames = flaky!.options.map(o => o.long);
    expect(flagNames).toContain('--runs');
    expect(flagNames).toContain('--until-fail');
    expect(flagNames).toContain('--timeout');
  });
});

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

describe('runFlaky', () => {
  it('reports STABLE and exits 0 when every attempt passes', async () => {
    const { fetchImpl, triggerCount } = makeFlakyFetch({
      statuses: ['passed', 'passed', 'passed'],
    });
    const { deps } = makeDeps(fetchImpl);
    const report = (await runFlaky(
      {
        profile: 'default',
        output: 'text',
        dryRun: false,
        debug: false,
        verbose: false,
        testId: 'test_x',
        runs: 3,
        untilFail: false,
        timeoutSeconds: 600,
      },
      deps,
    )) as FlakyReport;
    expect(report.verdict).toBe('stable');
    expect(report.runs).toBe(3);
    expect(triggerCount()).toBe(3);
  });

  it('reports FLAKY and throws exit 1 on a mix of pass/fail', async () => {
    const { fetchImpl } = makeFlakyFetch({ statuses: ['passed', 'failed', 'passed'] });
    const { deps } = makeDeps(fetchImpl);
    const err = await runFlaky(
      {
        profile: 'default',
        output: 'text',
        dryRun: false,
        debug: false,
        verbose: false,
        testId: 'test_x',
        runs: 3,
        untilFail: false,
        timeoutSeconds: 600,
      },
      deps,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).exitCode).toBe(1);
    expect((err as CLIError).message).toContain('flaky');
  });

  it('reports FAILING and throws exit 1 when no attempt passes', async () => {
    const { fetchImpl } = makeFlakyFetch({ statuses: ['failed', 'failed'] });
    const { deps } = makeDeps(fetchImpl);
    const err = await runFlaky(
      {
        profile: 'default',
        output: 'text',
        dryRun: false,
        debug: false,
        verbose: false,
        testId: 'test_x',
        runs: 2,
        untilFail: false,
        timeoutSeconds: 600,
      },
      deps,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CLIError);
    expect((err as CLIError).message).toContain('failing');
  });

  it('--until-fail stops at the first non-passing attempt', async () => {
    const { fetchImpl, triggerCount } = makeFlakyFetch({
      statuses: ['passed', 'failed', 'passed', 'passed', 'passed'],
    });
    const { deps } = makeDeps(fetchImpl);
    const err = await runFlaky(
      {
        profile: 'default',
        output: 'text',
        dryRun: false,
        debug: false,
        verbose: false,
        testId: 'test_x',
        runs: 5,
        untilFail: true,
        timeoutSeconds: 600,
      },
      deps,
    ).catch((e: unknown) => e);
    // Stopped after attempt 2 (the failure) — only 2 triggers fired.
    expect(triggerCount()).toBe(2);
    expect(err).toBeInstanceOf(CLIError);
  });

  it('prints a backend credit advisory to stderr', async () => {
    const { fetchImpl } = makeFlakyFetch({ statuses: ['passed', 'passed'], testType: 'backend' });
    const { deps, stderr } = makeDeps(fetchImpl);
    await runFlaky(
      {
        profile: 'default',
        output: 'text',
        dryRun: false,
        debug: false,
        verbose: false,
        testId: 'test_x',
        runs: 2,
        untilFail: false,
        timeoutSeconds: 600,
      },
      deps,
    );
    expect(stderr.some(l => l.includes('backend test') && l.includes('credits'))).toBe(true);
  });

  it('emits a machine-readable JSON stability report', async () => {
    const { fetchImpl } = makeFlakyFetch({ statuses: ['passed', 'failed', 'passed'] });
    const { deps, stdout } = makeDeps(fetchImpl);
    await runFlaky(
      {
        profile: 'default',
        output: 'json',
        dryRun: false,
        debug: false,
        verbose: false,
        testId: 'test_x',
        runs: 3,
        untilFail: false,
        timeoutSeconds: 600,
      },
      deps,
    ).catch(() => undefined); // swallow the exit-1 throw; we only assert stdout
    const parsed = JSON.parse(stdout.join('\n')) as FlakyReport;
    expect(parsed.testId).toBe('test_x');
    expect(parsed.runs).toBe(3);
    expect(parsed.passed).toBe(2);
    expect(parsed.verdict).toBe('flaky');
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]!.failureKind).toBe('assertion');
  });

  it('throws exit 4 when the test has no replayable run', async () => {
    const { fetchImpl } = makeFlakyFetch({ statuses: [], notFoundOnTrigger: true });
    const { deps } = makeDeps(fetchImpl);
    const err = await runFlaky(
      {
        profile: 'default',
        output: 'text',
        dryRun: false,
        debug: false,
        verbose: false,
        testId: 'test_x',
        runs: 3,
        untilFail: false,
        timeoutSeconds: 600,
      },
      deps,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('NOT_FOUND');
  });

  it('rejects --runs below the range (0) with a validation error (exit 5)', async () => {
    const { fetchImpl } = makeFlakyFetch({ statuses: [] });
    const { deps } = makeDeps(fetchImpl);
    const err = await runFlaky(
      {
        profile: 'default',
        output: 'text',
        dryRun: false,
        debug: false,
        verbose: false,
        testId: 'test_x',
        runs: 0,
        untilFail: false,
        timeoutSeconds: 600,
      },
      deps,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).exitCode).toBe(5);
  });

  it('rejects --runs above the cap (11) with a validation error (exit 5)', async () => {
    const { fetchImpl } = makeFlakyFetch({ statuses: [] });
    const { deps } = makeDeps(fetchImpl);
    const err = await runFlaky(
      {
        profile: 'default',
        output: 'text',
        dryRun: false,
        debug: false,
        verbose: false,
        testId: 'test_x',
        runs: 11,
        untilFail: false,
        timeoutSeconds: 600,
      },
      deps,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).exitCode).toBe(5);
  });
});
