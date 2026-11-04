import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http.js';

describe('HttpClient.cancelRun transport retry', () => {
  it('retries naturally-idempotent cancellation after ECONNRESET', async () => {
    const cancelResponse = {
      runId: 'r1',
      testId: 't1',
      projectId: 'p1',
      userId: 'u1',
      status: 'cancelled',
      source: 'cli',
      createdAt: '2026-10-09T12:00:00.000Z',
      stepSummary: {
        total: 0,
        completed: 0,
        passedCount: 0,
        failedCount: 0,
      },
      alreadyCancelled: true,
    };

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(cancelResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const client = new HttpClient({
      baseUrl: 'https://api.example.com/api/cli/v1',
      apiKey: 'sk-test',
      fetchImpl,
      sleep: () => Promise.resolve(),
      random: () => 0,
    });

    const result = await client.cancelRun('r1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.alreadyCancelled).toBe(true);
  });

  it('retries cancellation after bare HTTP 502', async () => {
    const cancelResponse = {
      runId: 'r1',
      testId: 't1',
      projectId: 'p1',
      userId: 'u1',
      status: 'cancelled',
      source: 'cli',
      createdAt: '2026-10-09T12:00:00.000Z',
      stepSummary: {
        total: 0,
        completed: 0,
        passedCount: 0,
        failedCount: 0,
      },
      alreadyCancelled: true,
    };

    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('Bad Gateway', {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(cancelResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const client = new HttpClient({
      baseUrl: 'https://api.example.com/api/cli/v1',
      apiKey: 'sk-test',
      fetchImpl,
      sleep: () => Promise.resolve(),
      random: () => 0,
    });

    const result = await client.cancelRun('r1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.alreadyCancelled).toBe(true);
  });
});
