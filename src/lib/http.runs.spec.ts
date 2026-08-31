/**
 * Tests for the two new M3.3 HttpClient methods: `triggerRun` and `getRun`.
 *
 * These are additive to the existing `http.test.ts`. They use the same
 * `makeClient` factory pattern.
 */

import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from './http.js';
import type { RunResponse, TriggerRunBody, TriggerRunResponse } from './runs.types.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function errorEnvelopeResponse(status: number, code: string): Response {
  return jsonResponse(
    {
      error: {
        code,
        message: `Error ${code}`,
        nextAction: 'retry',
        requestId: 'req_1',
        details: {},
      },
    },
    { status },
  );
}

function makeClient(fetchImpl: typeof fetch): HttpClient {
  return new HttpClient({
    baseUrl: 'https://api.example.com/api/cli/v1',
    apiKey: 'sk-test',
    fetchImpl,
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
}

// ---------------------------------------------------------------------------
// triggerRun
// ---------------------------------------------------------------------------

describe('HttpClient.triggerRun', () => {
  it('sends POST to /tests/{testId}/runs with correct path encoding', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = input.toString();
      return jsonResponse({
        runId: 'run_1',
        status: 'queued',
        enqueuedAt: '2026-05-15T10:00:00.000Z',
        codeVersion: 'v1',
        targetUrl: 'https://example.com',
      } satisfies TriggerRunResponse);
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.triggerRun('test_abc', { source: 'cli' }, { idempotencyKey: 'key-1' });
    expect(capturedUrl).toContain('/tests/test_abc/runs');
  });

  it('sends Idempotency-Key header', async () => {
    let capturedIdempotencyKey = '';
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      capturedIdempotencyKey = headers.get('idempotency-key') ?? '';
      return jsonResponse({
        runId: 'run_1',
        status: 'queued',
        enqueuedAt: '2026-05-15T10:00:00.000Z',
        codeVersion: 'v1',
        targetUrl: 'https://example.com',
      } satisfies TriggerRunResponse);
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.triggerRun('test_abc', { source: 'cli' }, { idempotencyKey: 'my-key-123' });
    expect(capturedIdempotencyKey).toBe('my-key-123');
  });

  it('sends body with source=cli (no targetUrl when absent)', async () => {
    let capturedBody = '';
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = (init?.body as string) ?? '';
      return jsonResponse({
        runId: 'run_1',
        status: 'queued',
        enqueuedAt: '2026-05-15T10:00:00.000Z',
        codeVersion: 'v1',
        targetUrl: 'https://example.com',
      } satisfies TriggerRunResponse);
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const body: TriggerRunBody = { source: 'cli' };
    await client.triggerRun('test_abc', body, { idempotencyKey: 'k' });
    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(parsed.source).toBe('cli');
    expect(parsed.targetUrl).toBeUndefined();
  });

  it('includes targetUrl in body when provided', async () => {
    let capturedBody = '';
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = (init?.body as string) ?? '';
      return jsonResponse({
        runId: 'run_1',
        status: 'queued',
        enqueuedAt: '2026-05-15T10:00:00.000Z',
        codeVersion: 'v1',
        targetUrl: 'https://staging.example.com',
      } satisfies TriggerRunResponse);
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const body: TriggerRunBody = { source: 'cli', targetUrl: 'https://staging.example.com' };
    await client.triggerRun('test_abc', body, { idempotencyKey: 'k' });
    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(parsed.targetUrl).toBe('https://staging.example.com');
  });

  it('returns the TriggerRunResponse shape', async () => {
    const triggerResp: TriggerRunResponse = {
      runId: 'run_xyz',
      status: 'queued',
      enqueuedAt: '2026-05-15T10:00:00.000Z',
      codeVersion: 'v3',
      targetUrl: 'https://example.com',
    };
    const fetchImpl = vi.fn(async () => jsonResponse(triggerResp));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.triggerRun('test_1', { source: 'cli' }, { idempotencyKey: 'k' });
    expect(result).toEqual(triggerResp);
  });

  it('propagates CONFLICT (409) as ApiError', async () => {
    const fetchImpl = vi.fn(async () => errorEnvelopeResponse(409, 'CONFLICT'));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(
      client.triggerRun('test_1', { source: 'cli' }, { idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', exitCode: 6 });
  });

  // Item 7 regression: triggerRun MUST NOT retry on 409 CONFLICT.
  // POST /tests/{testId}/runs returning 409 means another run is already
  // in flight — a persistent condition. Retrying after 1s would enqueue
  // a second run once the first finishes, which is the unintended behavior
  // the Codex finding flagged.
  it('does not retry CONFLICT (409) — surfaces immediately, no second POST', async () => {
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount += 1;
      return errorEnvelopeResponse(409, 'CONFLICT');
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(
      client.triggerRun('test_1', { source: 'cli' }, { idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', exitCode: 6 });
    // Only one POST must have been sent — no retry
    expect(callCount).toBe(1);
  });

  it('does not observe 200 after 409 — exits at 409, second call never reached', async () => {
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) return errorEnvelopeResponse(409, 'CONFLICT');
      // This success response must never be reached for triggerRun.
      return jsonResponse({
        runId: 'run_should_not_be_returned',
        status: 'queued',
        enqueuedAt: '2026-05-15T10:00:00.000Z',
        codeVersion: 'v1',
        targetUrl: 'https://example.com',
      } satisfies TriggerRunResponse);
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const err = await client
      .triggerRun('test_1', { source: 'cli' }, { idempotencyKey: 'k' })
      .catch(e => e);
    // Must have received CONFLICT, not a run envelope
    expect(err).toMatchObject({ code: 'CONFLICT' });
    // Fetch was called exactly once — never observed the would-be 200
    expect(callCount).toBe(1);
  });

  it('propagates VALIDATION_ERROR (400) as ApiError', async () => {
    const fetchImpl = vi.fn(async () => errorEnvelopeResponse(400, 'VALIDATION_ERROR'));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(
      client.triggerRun('test_1', { source: 'cli' }, { idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('URL-encodes special characters in testId', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = input.toString();
      return jsonResponse({
        runId: 'run_1',
        status: 'queued',
        enqueuedAt: '2026-05-15T10:00:00.000Z',
        codeVersion: 'v1',
        targetUrl: 'https://example.com',
      } satisfies TriggerRunResponse);
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.triggerRun('test/abc', { source: 'cli' }, { idempotencyKey: 'k' });
    expect(capturedUrl).toContain('test%2Fabc');
  });
});

// ---------------------------------------------------------------------------
// getRun
// ---------------------------------------------------------------------------

describe('HttpClient.getRun', () => {
  const SAMPLE_RUN: RunResponse = {
    runId: 'run_1',
    testId: 'test_abc',
    testTitle: null,
    projectId: 'project_xyz',
    userId: 'user_1',
    status: 'running',
    source: 'cli',
    createdAt: '2026-05-15T10:00:00.000Z',
    startedAt: '2026-05-15T10:00:01.000Z',
    finishedAt: null,
    codeVersion: 'v1',
    targetUrl: 'https://example.com',
    createdFrom: 'cli',
    failedStepIndex: null,
    failureKind: null,
    error: null,
    videoUrl: null,
    stepSummary: { total: 5, completed: 2, passedCount: 2, failedCount: 0 },
  };

  it('sends GET to /runs/{runId}', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = input.toString();
      return jsonResponse(SAMPLE_RUN);
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.getRun('run_1');
    expect(capturedUrl).toContain('/runs/run_1');
  });

  it('appends ?waitSeconds when provided', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = input.toString();
      return jsonResponse(SAMPLE_RUN);
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.getRun('run_1', { waitSeconds: 25 });
    expect(capturedUrl).toContain('waitSeconds=25');
  });

  it('does not append waitSeconds when not provided', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = input.toString();
      return jsonResponse(SAMPLE_RUN);
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.getRun('run_1');
    expect(capturedUrl).not.toContain('waitSeconds');
  });

  it('returns RunResponse', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SAMPLE_RUN));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.getRun('run_1');
    expect(result).toEqual(SAMPLE_RUN);
  });

  it('propagates NOT_FOUND (404) as ApiError', async () => {
    const fetchImpl = vi.fn(async () => errorEnvelopeResponse(404, 'NOT_FOUND'));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.getRun('run_1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      exitCode: 4,
    });
  });

  it('propagates VALIDATION_ERROR (400) as ApiError — enables backoff fallback in poll', async () => {
    const fetchImpl = vi.fn(async () => errorEnvelopeResponse(400, 'VALIDATION_ERROR'));
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await expect(client.getRun('run_1', { waitSeconds: 25 })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
    });
  });

  it('URL-encodes special characters in runId', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      capturedUrl = input.toString();
      return jsonResponse(SAMPLE_RUN);
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.getRun('run/special');
    expect(capturedUrl).toContain('run%2Fspecial');
  });

  it('passes x-api-key header', async () => {
    let capturedApiKey = '';
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      capturedApiKey = headers.get('x-api-key') ?? '';
      return jsonResponse(SAMPLE_RUN);
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    await client.getRun('run_1');
    expect(capturedApiKey).toBe('sk-test');
  });
});

// ---------------------------------------------------------------------------
// triggerRunWithMeta — requestId surfacing (dogfood item 1)
// ---------------------------------------------------------------------------

describe('HttpClient.triggerRunWithMeta', () => {
  it('returns requestId alongside the body', async () => {
    const triggerResp = {
      runId: 'run_withMeta',
      status: 'queued' as const,
      enqueuedAt: '2026-05-21T00:00:00.000Z',
      codeVersion: 'v1',
      targetUrl: 'https://example.com',
    };
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      // Capture the requestId set in x-request-id header for cross-check.
      const headers = new Headers(init?.headers);
      const sentRequestId = headers.get('x-request-id') ?? '';
      return new Response(JSON.stringify(triggerResp), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': sentRequestId },
      });
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const result = await client.triggerRunWithMeta(
      'test_1',
      { source: 'cli' },
      { idempotencyKey: 'k' },
    );
    expect(result.body).toEqual(triggerResp);
    expect(result.requestId).toMatch(/^cli_/);
    expect(result.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// onTransition callback (dogfood item 4)
// ---------------------------------------------------------------------------

describe('HttpClient — onTransition callback', () => {
  it('emits a transition message on RATE_LIMITED retry', async () => {
    const transitions: string[] = [];
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'RATE_LIMITED',
              message: 'Too many requests',
              nextAction: '',
              requestId: 'req_1',
              details: {},
            },
          }),
          { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } },
        );
      }
      return jsonResponse({
        runId: 'run_ok',
        status: 'queued',
        enqueuedAt: '2026-05-21T00:00:00Z',
        codeVersion: 'v1',
        targetUrl: 'https://example.com',
      });
    });
    const client = new HttpClient({
      baseUrl: 'https://api.example.com/api/cli/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
      onTransition: msg => transitions.push(msg),
    });
    await client.triggerRun('test_1', { source: 'cli' }, { idempotencyKey: 'k' });
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions[0]).toMatch(/Rate limited/i);
  });
});

// ---------------------------------------------------------------------------
// Auth guard shared by both methods
// ---------------------------------------------------------------------------

describe('HttpClient new methods — auth guard', () => {
  it('triggerRun throws AUTH_REQUIRED when no apiKey', async () => {
    const fetchImpl = vi.fn();
    const client = new HttpClient({
      baseUrl: 'https://api.example.com/api/cli/v1',
      apiKey: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    await expect(
      client.triggerRun('test_1', { source: 'cli' }, { idempotencyKey: 'k' }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED', exitCode: 3 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('getRun throws AUTH_REQUIRED when no apiKey', async () => {
    const fetchImpl = vi.fn();
    const client = new HttpClient({
      baseUrl: 'https://api.example.com/api/cli/v1',
      apiKey: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
    });
    await expect(client.getRun('run_1')).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      exitCode: 3,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// INSUFFICIENT_CREDITS vs RATE_LIMITED — retry behavior
// ---------------------------------------------------------------------------

describe('HttpClient.triggerRun — INSUFFICIENT_CREDITS vs RATE_LIMITED retry', () => {
  function creditsEnvelopeResponse(): Response {
    return new Response(
      JSON.stringify({
        error: {
          code: 'RATE_LIMITED',
          message:
            'Insufficient credits: 2 credit(s) required. Top up at https://www.testsprite.com/settings/billing.',
          nextAction: 'Top up at https://www.testsprite.com/settings/billing.',
          requestId: 'req_cred',
          details: { required: 2, userId: 'u_1' },
        },
      }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    );
  }

  function throttleEnvelopeResponse(): Response {
    return new Response(
      JSON.stringify({
        error: {
          code: 'RATE_LIMITED',
          message: 'Run trigger rate limit exceeded: 60 triggers per minute per key.',
          nextAction: 'Wait Retry-After seconds and retry.',
          requestId: 'req_rl',
          details: { scope: 'key', retryAfterSec: 1 },
        },
      }),
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '1',
        },
      },
    );
  }

  // (b) Credits case is NOT retried — fetch called exactly once
  it('INSUFFICIENT_CREDITS (credits envelope) is NOT retried — fetch called exactly once', async () => {
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount += 1;
      return creditsEnvelopeResponse();
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const err = await client
      .triggerRun('test_1', { source: 'cli' }, { idempotencyKey: 'k' })
      .catch(e => e);
    expect(err.code).toBe('INSUFFICIENT_CREDITS');
    expect(err.exitCode).toBe(12);
    expect(callCount).toBe(1);
  });

  it('INSUFFICIENT_CREDITS nextAction contains billing link', async () => {
    const fetchImpl = vi.fn(async () => creditsEnvelopeResponse());
    const client = makeClient(fetchImpl as unknown as typeof fetch);
    const err = await client
      .triggerRun('test_1', { source: 'cli' }, { idempotencyKey: 'k' })
      .catch(e => e);
    expect(err.nextAction).toContain('settings/billing');
  });

  // (c) Genuine per-minute throttle RATE_LIMITED still retries and maps to exit 11
  it('genuine throttle RATE_LIMITED still retries (up to MAX_ATTEMPTS_RATE_LIMITED) and maps to exit 11', async () => {
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount += 1;
      return throttleEnvelopeResponse();
    });
    const client = new HttpClient({
      baseUrl: 'https://api.example.com/api/cli/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
    });
    const err = await client
      .triggerRun('test_1', { source: 'cli' }, { idempotencyKey: 'k' })
      .catch(e => e);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.exitCode).toBe(11);
    // MAX_ATTEMPTS_RATE_LIMITED = 3; default triggerRun has retryOnRateLimit=true
    expect(callCount).toBe(3);
  });
});
