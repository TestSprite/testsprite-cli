import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http.js';

function clientWith(fetchImpl: typeof fetch, shutdownSignal?: AbortSignal): HttpClient {
  return new HttpClient({
    baseUrl: 'https://api.example.com/api/cli/v1',
    apiKey: 'sk-test',
    fetchImpl,
    shutdownSignal,
    sleep: async () => {},
    random: () => 0,
  });
}

function conflictResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'CONFLICT',
        message: 'Run is already terminal',
        nextAction: 'Do not retry',
        requestId: 'req_conflict',
        details: {},
      },
    }),
    { status: 409, headers: { 'content-type': 'application/json' } },
  );
}

describe('cleanup transport retry invariants', () => {
  it('keeps a generic keyless DELETE non-retriable', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      clientWith(fetchImpl).delete('/tunnel/c1', { allowNoContent: true }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry 409 for cancelRun', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(conflictResponse());

    await expect(clientWith(fetchImpl).cancelRun('r1')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry 409 for deleteTunnel', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(conflictResponse());

    await expect(clientWith(fetchImpl).deleteTunnel('c1')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry 409 for a retry-safe teardown DELETE', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(conflictResponse());

    await expect(
      clientWith(fetchImpl).delete('/tunnel/c1', {
        allowNoContent: true,
        retryOnConflict: false,
        transportRetrySafe: true,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps explicit retry: false authoritative even with opt-in', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      clientWith(fetchImpl).delete('/tunnel/c1', {
        allowNoContent: true,
        transportRetrySafe: true,
        retry: false,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('honours the original four-attempt transport retry cap', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNRESET'));

    await expect(clientWith(fetchImpl).deleteTunnel('c1')).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('does not dispatch after shutdown is already aborted', async () => {
    const shutdown = new AbortController();
    const reason = new Error('Interrupted before cleanup');
    shutdown.abort(reason);
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(clientWith(fetchImpl, shutdown.signal).deleteTunnel('c1')).rejects.toBe(reason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
