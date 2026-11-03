import { describe, expect, it } from 'vitest';
import { HttpClient } from './http.js';

const RUN = {
  runId: 'run_1',
  testId: 'test_1',
  projectId: 'p_1',
  userId: 'u_1',
  status: 'passed',
  source: 'cli',
  createdAt: '2026-06-01T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  codeVersion: 'v1',
  targetUrl: 'https://example.com',
  createdFrom: null,
  failedStepIndex: null,
  failureKind: null,
  error: null,
  videoUrl: null,
  stepSummary: { total: 0, completed: 0, passedCount: 0, failedCount: 0 },
};

function clientReturning(body: unknown): HttpClient {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  return new HttpClient({
    baseUrl: 'https://api.example.com/api/cli/v1',
    apiKey: 'sk-test',
    fetchImpl,
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
}

describe('run response replay routing record', () => {
  it('accepts null reason and caveat on a normal replay', async () => {
    const run = await clientReturning({
      ...RUN,
      replay: { path: 'replay', reason: null, caveat: null },
    }).getRun('run_1');
    expect(run.replay?.path).toBe('replay');
    expect(run.replay?.reason ?? null).toBeNull();
  });

  it('accepts absent reason and caveat', async () => {
    const run = await clientReturning({ ...RUN, replay: { path: 'agent' } }).getRun('run_1');
    expect(run.replay).toEqual({ path: 'agent' });
  });

  it('keeps a refused reason and caveat strings', async () => {
    const run = await clientReturning({
      ...RUN,
      replay: { path: 'refused', reason: 'stale_code', caveat: 'user_authored_no_heal' },
    }).getRun('run_1');
    expect(run.replay).toMatchObject({ path: 'refused', reason: 'stale_code' });
  });
});
