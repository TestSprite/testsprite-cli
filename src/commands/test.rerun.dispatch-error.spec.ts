import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/errors.js';
import type { RerunAdvisory } from '../lib/runs.types.js';
import { runTestRerun } from './test.js';

const testIds = Array.from({ length: 51 }, (_, i) => `test_${i}`);
/** Dispatch fake batches, fail the selected request and capture recovery output without polling. */
async function exercise(
  options: {
    all?: boolean;
    wait?: boolean;
    text?: boolean;
    failAt?: number;
    errorCode?: 'NOT_FOUND' | 'AUTH_INVALID';
    count?: number;
    advisories?: RerunAdvisory[];
  } = {},
) {
  const requestedIds = Array.from({ length: options.count ?? 51 }, (_, i) => `test_${i}`);
  const tests = requestedIds.map(id => ({
    id,
    name: id,
    type: 'frontend' as const,
    projectId: 'project_repro',
    status: 'passed',
    createdFrom: 'portal',
  }));
  const stdout: string[] = [],
    stderr: string[] = [],
    chunks: string[][] = [];
  /**
   * Serve test and environment data offline, acknowledging batches until the selected failure.
   * Reject unexpected requests so recovery-output tests cannot silently start result polling.
   */
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    let status = 200;
    let body: unknown;
    if (url.includes('/tests/batch/rerun')) {
      const ids = (JSON.parse(String(init.body)) as { testIds: string[] }).testIds;
      chunks.push(ids);
      if (chunks.length === (options.failAt ?? 2)) {
        const code = options.errorCode ?? 'NOT_FOUND';
        status = code === 'NOT_FOUND' ? 404 : 401;
        body = {
          error: {
            code,
            message: 'Dispatch refused',
            requestId: 'req_failed_chunk',
            details: { testIds: ids },
            nextAction: 'Check this request',
          },
        };
      } else {
        status = 202;
        body = {
          accepted: ids.map(testId => ({
            testId,
            runId: `run_${testId}`,
            enqueuedAt: '2026-10-16T00:00:00Z',
          })),
          deferred: [],
          conflicts: [],
          closure: { byProject: [] },
          ...(options.advisories ? { advisories: options.advisories } : {}),
        };
      }
    } else if (url.includes('/env')) body = { environments: [] };
    else if (url.includes('/tests?')) body = { items: tests, nextToken: null };
    else throw new Error(`Unexpected request: ${url}`);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const error = await runTestRerun(
    {
      testIds: options.all ? [] : requestedIds,
      all: options.all ?? false,
      projectId: 'project_repro',
      knownTests: new Map(tests.map(test => [test.id, test])),
      wait: options.wait ?? false,
      noWait: !options.wait,
      timeoutSeconds: 60,
      autoHeal: false,
      autoHealExplicit: false,
      skipDependencies: false,
      maxConcurrency: 5,
      profile: 'default',
      output: options.text ? 'text' : 'json',
      debug: false,
      idempotencyKey: 'dispatch-repro',
    },
    {
      env: { TESTSPRITE_API_KEY: 'sk-user-test', TESTSPRITE_API_URL: 'https://api.example.com' },
      fetchImpl,
      stdout: line => stdout.push(line),
      stderr: line => stderr.push(line),
    },
  ).catch((err: unknown) => err);
  return { error, stdout, stderr, chunks };
}

describe('batch rerun dispatch failures', () => {
  it.each([false, true])('preserves deduplicated advisories with text=%s', async text => {
    const advisory = {
      feature: 'autoHeal',
      message: 'The requested auto-heal opt-out was not enforced.',
    };
    const { error, stdout, stderr, chunks } = await exercise({
      count: 101,
      failAt: 3,
      text,
      advisories: [advisory, advisory],
    });
    expect(error).toMatchObject({ exitCode: 4, requestId: 'req_failed_chunk' });
    expect(chunks.map(chunk => chunk.length)).toEqual([50, 50, 1]);
    expect(stderr.filter(line => line.startsWith('[advisory]'))).toEqual([
      `[advisory] ${advisory.message}`,
    ]);
    if (text) expect(stdout.join('\n')).not.toContain(advisory.message);
    else expect(JSON.parse(stdout[0]!).advisories).toEqual([advisory]);
  });

  it.each([
    { all: false, wait: false },
    { all: false, wait: true },
    { all: true, wait: false },
    { all: true, wait: true },
  ])('separates failed and unattempted requests for all=$all wait=$wait', async options => {
    const { error, stdout, chunks } = await exercise({ ...options, count: 101 });
    expect(chunks.map(chunk => chunk.length)).toEqual([50, 50]);
    expect(error).toMatchObject({ exitCode: 4 });
    const payload = JSON.parse(stdout[0]!);
    expect(payload.accepted).toHaveLength(50);
    expect(payload.failedChunkTestIds).toEqual(chunks[1]);
    expect(payload.notAttemptedTestIds).toEqual(['test_100']);
    expect(payload.unconfirmedTestIds).toEqual([...chunks[1]!, 'test_100']);
    expect(payload.advisories).toEqual([]);
  });

  it('distinguishes failed and unattempted requests in text output', async () => {
    const { stdout, error } = await exercise({ text: true, count: 101 });
    expect(error).toMatchObject({ exitCode: 4 });
    expect(stdout.join('\n')).toContain('Failed request tests (dispatch unconfirmed): test_50,');
    expect(stdout.join('\n')).toContain('Not attempted by this command: test_100');
  });

  it.each([
    { all: false, wait: false },
    { all: false, wait: true },
    { all: true, wait: false },
    { all: true, wait: true },
  ])('preserves earlier runs for all=$all wait=$wait', async options => {
    const { error, stdout, stderr, chunks } = await exercise(options);
    expect(chunks.map(chunk => chunk.length)).toEqual([50, 1]);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      exitCode: 4,
      requestId: 'req_failed_chunk',
      details: { testIds: ['test_50'] },
    });
    expect(stdout).toHaveLength(1);
    const payload = JSON.parse(stdout[0]!);
    expect(payload.partial).toBe(true);
    expect(payload.accepted.map((row: { runId: string }) => row.runId)).toEqual(
      testIds.slice(0, 50).map(id => `run_${id}`),
    );
    expect(payload.unconfirmedTestIds).toEqual(['test_50']);
    expect(payload.failedChunkTestIds).toEqual(['test_50']);
    expect(payload.notAttemptedTestIds).toEqual([]);
    expect(stderr.join('\n')).toContain('testsprite test wait run_test_0');
    expect(stderr.join('\n')).toContain('testsprite test cancel run_test_0');
  });

  it('prints accepted IDs and recovery hints in text mode', async () => {
    const { stdout, stderr, error } = await exercise({ text: true });
    expect(error).toMatchObject({ exitCode: 4 });
    for (const id of testIds.slice(0, 50)) expect(stdout.join('\n')).toContain(`run_${id} `);
    expect(stderr.join('\n')).toContain('50 run(s) were already accepted');
  });

  it('preserves authentication errors after emitting partial results', async () => {
    const { stdout, error } = await exercise({ errorCode: 'AUTH_INVALID' });
    expect(error).toMatchObject({
      exitCode: 3,
      code: 'AUTH_INVALID',
      requestId: 'req_failed_chunk',
    });
    expect(JSON.parse(stdout[0]!).accepted).toHaveLength(50);
  });

  it('does not invent accepted runs when the first chunk fails', async () => {
    const { stdout, stderr, chunks, error } = await exercise({ failAt: 1 });
    expect(error).toMatchObject({ exitCode: 4 });
    expect(chunks).toHaveLength(1);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).not.toContain('already accepted');
  });
});
