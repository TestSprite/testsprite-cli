import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http.js';

const launched = {
  runId: 'run-1',
  projectId: 'project-1',
  enqueuedAt: '2026-11-15T00:00:00.000Z',
  total: 60,
  autoHeal: true,
  targetUrl: 'https://preview.example.com',
  environment: { id: 'env-1', name: 'github-pr-9' },
  maxConcurrency: 4,
  blocked: [{ testId: 'blocked', resultId: 'result-blocked', reason: 'no_producer' }],
  held: [{ testId: 'held', runId: 'other-run', resultId: 'other-result' }],
};

function clientFor(body: unknown, status = 202) {
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'x-request-id': 'request-1' },
      }),
  );
  return {
    fetchImpl,
    client: new HttpClient({
      baseUrl: 'https://api.example.com/api/cli/v1',
      apiKey: 'test-key',
      fetchImpl,
      sleep: async () => undefined,
    }),
  };
}

describe('project launch transport', () => {
  it('sends all 60 selected IDs in one project request with native response IDs', async () => {
    const { client, fetchImpl } = clientFor(launched);
    const signal = new AbortController().signal;
    const testIds = Array.from({ length: 60 }, (_, i) => `test-${i}`);
    const response = await client.triggerProjectRun(
      'project-1',
      {
        testIds,
        admission: 'all',
        environment: 'template',
        previewName: 'github-pr-9',
        targetUrl: launched.targetUrl,
        maxConcurrency: 4,
      },
      { idempotencyKey: 'project-launch', signal },
    );
    expect(response.body).toEqual(launched);
    expect(response.requestId).toMatch(/^cli_/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/cli/v1/projects/project-1/runs');
    expect(JSON.parse(init.body as string)).toEqual({
      testIds,
      admission: 'all',
      environment: 'template',
      previewName: 'github-pr-9',
      targetUrl: launched.targetUrl,
      maxConcurrency: 4,
    });
    expect(new Headers(init.headers).get('idempotency-key')).toBe('project-launch');
    expect(new Headers(init.headers).get('x-request-id')).toBe(response.requestId);
    expect(init.signal).toBeDefined();
  });

  it('rejects a legacy accepted envelope rather than fabricating a project run', async () => {
    const { client } = clientFor({ accepted: [], conflicts: [], deferred: [] });
    await expect(
      client.triggerProjectRun('project-1', {}, { idempotencyKey: 'key' }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('preserves a conflict verbatim and does not retry it', async () => {
    const error = {
      code: 'CONFLICT',
      message: 'Run server-run owns this case.',
      nextAction: 'Server-specific instruction.',
      requestId: 'server-request',
      details: {
        currentRunId: 'server-run',
        currentResultId: 'server-result',
        reason: 'in_flight',
      },
    };
    const { client, fetchImpl } = clientFor({ error }, 409);
    await expect(
      client.triggerProjectRun('project-1', {}, { idempotencyKey: 'key' }),
    ).rejects.toMatchObject(error);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
