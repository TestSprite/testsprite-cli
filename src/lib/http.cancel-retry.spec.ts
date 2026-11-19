import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http.js';

// A replayed cancel answers 200 with alreadyCancelled, so the retry's answer is
// the one the caller sees.
const cancelResponse = {
  runId: 'r1',
  alreadyCancelled: true,
  alreadyFinished: false,
  results: [
    {
      resultId: 'res1',
      runId: 'r1',
      testId: 't1',
      title: 'Checkout',
      status: 'cancelled',
      alreadyCancelled: true,
      alreadyFinished: false,
    },
  ],
};

function cancelled(): Response {
  return new Response(JSON.stringify(cancelResponse), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(fetchImpl: typeof fetch): HttpClient {
  return new HttpClient({
    baseUrl: 'https://api.example.com/api/cli/v1',
    apiKey: 'sk-test',
    fetchImpl,
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
}

describe('HttpClient.cancelRun transport retry', () => {
  it('retries naturally-idempotent cancellation after ECONNRESET', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(cancelled());

    const result = await clientWith(fetchImpl).cancelRun('r1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.alreadyCancelled).toBe(true);
  });

  it('retries cancellation after bare HTTP 502', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('Bad Gateway', {
          status: 502,
          headers: { 'content-type': 'text/plain' },
        }),
      )
      .mockResolvedValueOnce(cancelled());

    const result = await clientWith(fetchImpl).cancelRun('r1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.alreadyCancelled).toBe(true);
  });
});
