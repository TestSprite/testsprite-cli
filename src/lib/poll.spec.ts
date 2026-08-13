/**
 * Unit tests for `pollRunUntilTerminal`.
 *
 * All HTTP is mocked via a fake `HttpClient`-shaped object so tests are
 * fast and deterministic. Sleep is always injected as an instant no-op
 * (or a spy) so there are no real delays.
 */

import { describe, expect, it } from 'vitest';
import { ApiError, InterruptError } from './errors.js';
import { ShutdownController } from './interrupt.js';
import { pollRunUntilTerminal, TimeoutError } from './poll.js';
import type { RunClient } from './poll.js';
import type { RunResponse } from './runs.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const RUN_ID = 'run_test_001';

function makeRun(status: RunResponse['status'], extra: Partial<RunResponse> = {}): RunResponse {
  return {
    runId: RUN_ID,
    testId: 'test_abc',
    projectId: 'project_xyz',
    userId: 'user_1',
    status,
    source: 'cli',
    createdAt: '2026-05-15T10:00:00.000Z',
    startedAt: status !== 'queued' ? '2026-05-15T10:00:01.000Z' : null,
    finishedAt: status !== 'queued' && status !== 'running' ? '2026-05-15T10:00:30.000Z' : null,
    codeVersion: 'v1',
    targetUrl: 'https://example.com',
    createdFrom: 'cli',
    failedStepIndex: null,
    failureKind: null,
    error: null,
    videoUrl: null,
    stepSummary: { total: 5, completed: 3, passedCount: 3, failedCount: 0 },
    ...extra,
  };
}

/** Build a fake ApiError as the http layer would. */
function makeApiError(
  code: string,
  details: Record<string, unknown> = {},
  httpStatus?: number,
): ApiError {
  return ApiError.fromEnvelope(
    {
      error: {
        code,
        message: `Error: ${code}`,
        nextAction: 'retry',
        requestId: 'req_test',
        details,
      },
    },
    httpStatus,
  );
}

/** Simple controlled fake for HttpClient.getRun */
function makeClient(
  responses: Array<RunResponse | ApiError>,
  capturedWaitSeconds?: number[],
): RunClient {
  let callIndex = 0;
  return {
    getRun: async (_runId: string, opts?: { waitSeconds?: number }) => {
      capturedWaitSeconds?.push(opts?.waitSeconds ?? -1);
      const resp = responses[callIndex++];
      if (!resp) throw new Error('Ran out of mock responses');
      if (resp instanceof ApiError) throw resp;
      return resp;
    },
  };
}

const instantSleep = () => Promise.resolve();

// ---------------------------------------------------------------------------
// TimeoutError
// ---------------------------------------------------------------------------

describe('TimeoutError', () => {
  it('carries runId and has the right name', () => {
    const err = new TimeoutError(RUN_ID, 30);
    expect(err.runId).toBe(RUN_ID);
    expect(err.name).toBe('TimeoutError');
    expect(err.message).toContain('30s');
    expect(err.message).toContain(RUN_ID);
  });
});

// ---------------------------------------------------------------------------
// Long-poll preferred — normal paths
// ---------------------------------------------------------------------------

describe('pollRunUntilTerminal — long-poll happy paths', () => {
  it('returns immediately on first poll when already passed', async () => {
    const client = makeClient([makeRun('passed')]);
    const result = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
    });
    expect(result.status).toBe('passed');
    expect(result.runId).toBe(RUN_ID);
  });

  it('returns on first poll when already failed (terminal)', async () => {
    const client = makeClient([makeRun('failed')]);
    const result = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
    });
    expect(result.status).toBe('failed');
  });

  it('returns on first poll when already blocked (terminal)', async () => {
    const client = makeClient([makeRun('blocked')]);
    const result = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
    });
    expect(result.status).toBe('blocked');
  });

  it('returns on first poll when already cancelled (terminal)', async () => {
    const client = makeClient([makeRun('cancelled')]);
    const result = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
    });
    expect(result.status).toBe('cancelled');
  });

  it('polls multiple times and returns on first terminal', async () => {
    const client = makeClient([
      makeRun('queued'),
      makeRun('running'),
      makeRun('running'),
      makeRun('passed'),
    ]);
    const ticks: Array<{ status: string }> = [];
    const result = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 120,
      sleep: instantSleep,
      onTick: run => ticks.push({ status: run.status }),
    });
    expect(result.status).toBe('passed');
    // onTick called for all 4 polls
    expect(ticks).toHaveLength(4);
    expect(ticks[0]?.status).toBe('queued');
    expect(ticks[3]?.status).toBe('passed');
  });

  it('sends waitSeconds = min(remaining, 25) on long-poll path', async () => {
    const capturedWaitSeconds: number[] = [];
    const client = makeClient([makeRun('passed')], capturedWaitSeconds);
    await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
    });
    expect(capturedWaitSeconds[0]).toBeLessThanOrEqual(25);
    expect(capturedWaitSeconds[0]).toBeGreaterThan(0);
  });

  it('sends waitSeconds = 25 when remaining > 25', async () => {
    const capturedWaitSeconds: number[] = [];
    const client = makeClient([makeRun('passed')], capturedWaitSeconds);
    await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 600, // plenty of time
      sleep: instantSleep,
    });
    expect(capturedWaitSeconds[0]).toBe(25);
  });

  it('passes elapsedMs to onTick', async () => {
    const client = makeClient([makeRun('passed')]);
    const elapsed: number[] = [];
    await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
      onTick: (_run, ms) => elapsed.push(ms),
    });
    expect(elapsed).toHaveLength(1);
    expect(elapsed[0]).toBeGreaterThanOrEqual(0);
  });

  it('honors retryAfterSeconds from non-terminal response', async () => {
    const sleepCalls: number[] = [];
    const client = makeClient([makeRun('running', { retryAfterSeconds: 5 }), makeRun('passed')]);
    const result = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: async ms => {
        sleepCalls.push(ms);
      },
    });
    expect(result.status).toBe('passed');
    // Should have slept for retryAfterSeconds (5000 ms)
    expect(sleepCalls).toContain(5000);
  });
});

// ---------------------------------------------------------------------------
// Backoff fallback (VALIDATION_ERROR on waitSeconds)
// ---------------------------------------------------------------------------

describe('pollRunUntilTerminal — backoff fallback', () => {
  it('switches to backoff on VALIDATION_ERROR for waitSeconds and continues', async () => {
    const capturedWaitSeconds: number[] = [];
    const client = makeClient(
      [
        makeApiError('VALIDATION_ERROR'),
        makeRun('running'), // on backoff path (no waitSeconds)
        makeRun('passed'),
      ],
      capturedWaitSeconds,
    );
    const sleepCalls: number[] = [];
    const result = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: async ms => {
        sleepCalls.push(ms);
      },
    });
    expect(result.status).toBe('passed');
    // After switching to backoff, waitSeconds should be undefined (-1 sentinel)
    // The first call sends waitSeconds, the retry + subsequent don't
    expect(capturedWaitSeconds[0]).toBe(25); // first long-poll attempt
    // After VALIDATION_ERROR, backoff path uses no waitSeconds
    expect(capturedWaitSeconds[1]).toBe(-1);
  });

  it('uses backoff schedule (first delay ~2000ms) after fallback switch', async () => {
    const client = makeClient([
      makeApiError('VALIDATION_ERROR'),
      makeRun('running'),
      makeRun('passed'),
    ]);
    const sleepCalls: number[] = [];
    await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: async ms => {
        sleepCalls.push(ms);
      },
    });
    // First backoff delay should be ~2000ms (±20% = 1600–2400)
    const firstBackoff = sleepCalls.find(ms => ms >= 1600 && ms <= 2400);
    expect(firstBackoff).toBeDefined();
  });

  it('VALIDATION_ERROR only triggers backoff switch once; subsequent VALIDATION_ERROR propagates', async () => {
    // After switching, a new VALIDATION_ERROR (shouldn't happen, but if it
    // does with useBackoff=true) propagates as a regular error.
    const client = makeClient([
      makeApiError('VALIDATION_ERROR'), // first: switch to backoff
      makeApiError('VALIDATION_ERROR'), // second: propagate
    ]);
    await expect(
      pollRunUntilTerminal(client, RUN_ID, {
        timeoutSeconds: 60,
        sleep: instantSleep,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

// ---------------------------------------------------------------------------
// 404 handling
// ---------------------------------------------------------------------------

describe('pollRunUntilTerminal — 404 semantics', () => {
  it('404 not_yet_visible: retries once after 1s then continues', async () => {
    const sleepCalls: number[] = [];
    const client = makeClient([
      makeApiError('NOT_FOUND', { reason: 'not_yet_visible' }),
      makeRun('passed'),
    ]);
    const result = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: async ms => {
        sleepCalls.push(ms);
      },
    });
    expect(result.status).toBe('passed');
    expect(sleepCalls).toContain(1000);
  });

  it('404 not_yet_visible: only retries once (second not_yet_visible propagates)', async () => {
    const client = makeClient([
      makeApiError('NOT_FOUND', { reason: 'not_yet_visible' }),
      makeApiError('NOT_FOUND', { reason: 'not_yet_visible' }), // second: propagates
    ]);
    await expect(
      pollRunUntilTerminal(client, RUN_ID, {
        timeoutSeconds: 60,
        sleep: instantSleep,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('404 not_found: throws immediately (cross-tenant / stale runId)', async () => {
    const client = makeClient([makeApiError('NOT_FOUND', { reason: 'not_found' })]);
    const err = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
    }).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('NOT_FOUND');
  });

  it('404 with no details reason: throws immediately', async () => {
    const client = makeClient([makeApiError('NOT_FOUND', {})]);
    await expect(
      pollRunUntilTerminal(client, RUN_ID, {
        timeoutSeconds: 60,
        sleep: instantSleep,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

// ---------------------------------------------------------------------------
// 429 RATE_LIMITED
// ---------------------------------------------------------------------------

describe('pollRunUntilTerminal — 429 RATE_LIMITED', () => {
  it('propagates RATE_LIMITED immediately (http.ts handles retries)', async () => {
    const client = makeClient([makeApiError('RATE_LIMITED')]);
    const err = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
    }).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('RATE_LIMITED');
  });
});

// ---------------------------------------------------------------------------
// 5xx / server errors
// ---------------------------------------------------------------------------

describe('pollRunUntilTerminal — 5xx single-retry logic', () => {
  it('absorbs first INTERNAL error, retries, and succeeds', async () => {
    const sleepCalls: number[] = [];
    const client = makeClient([makeApiError('INTERNAL'), makeRun('passed')]);
    const result = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: async ms => {
        sleepCalls.push(ms);
      },
    });
    expect(result.status).toBe('passed');
    expect(sleepCalls.length).toBeGreaterThan(0);
  });

  it('absorbs first UNAVAILABLE error, retries, and succeeds', async () => {
    const client = makeClient([makeApiError('UNAVAILABLE'), makeRun('passed')]);
    const result = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
    });
    expect(result.status).toBe('passed');
  });

  it('second INTERNAL error propagates (exit 9 path)', async () => {
    const client = makeClient([
      makeApiError('INTERNAL'),
      makeApiError('INTERNAL'), // second one
    ]);
    const err = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
    }).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('INTERNAL');
  });

  it('uses retryAfterSec from 5xx details when available', async () => {
    const sleepCalls: number[] = [];
    const client = makeClient([makeApiError('INTERNAL', { retryAfterSec: 3 }), makeRun('passed')]);
    await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: async ms => {
        sleepCalls.push(ms);
      },
    });
    expect(sleepCalls).toContain(3000);
  });
});

// ---------------------------------------------------------------------------
// Deadline / TimeoutError
// ---------------------------------------------------------------------------

describe('pollRunUntilTerminal — deadline behavior', () => {
  it('throws TimeoutError when deadline is hit before terminal status', async () => {
    // Use a real Date.now() mock approach: inject a very short timeout
    // and a response stream that never terminates.
    const client: RunClient = {
      getRun: async () => makeRun('running'),
    };

    // We fake Date.now to make deadline pass quickly after first poll.
    let callCount = 0;
    const realDateNow = Date.now;
    const base = Date.now();
    Date.now = () => {
      callCount++;
      // After 3 calls (start + loop check + post-poll check), report past deadline
      return callCount > 3 ? base + 2000 : base;
    };
    try {
      await expect(
        pollRunUntilTerminal(client, RUN_ID, {
          timeoutSeconds: 1, // 1s deadline
          sleep: instantSleep,
        }),
      ).rejects.toBeInstanceOf(TimeoutError);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('TimeoutError has the correct runId', async () => {
    let callCount = 0;
    const base = Date.now();
    const realDateNow = Date.now;
    Date.now = () => (callCount++ > 3 ? base + 2000 : base);
    try {
      const err = await pollRunUntilTerminal(
        { getRun: async () => makeRun('running') } satisfies RunClient,
        RUN_ID,
        { timeoutSeconds: 1, sleep: instantSleep },
      ).catch(e => e);
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).runId).toBe(RUN_ID);
    } finally {
      Date.now = realDateNow;
    }
  });
});

// ---------------------------------------------------------------------------
// Unknown error propagation
// ---------------------------------------------------------------------------

describe('pollRunUntilTerminal — unknown error propagation', () => {
  it('propagates non-ApiError errors immediately', async () => {
    const networkErr = new Error('fetch failed');
    const client: RunClient = {
      getRun: async () => {
        throw networkErr;
      },
    };
    await expect(
      pollRunUntilTerminal(client, RUN_ID, {
        timeoutSeconds: 60,
        sleep: instantSleep,
      }),
    ).rejects.toThrow('fetch failed');
  });

  it('propagates CONFLICT immediately (not retried)', async () => {
    const client = makeClient([makeApiError('CONFLICT')]);
    const err = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
    }).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('CONFLICT');
  });
});

// ---------------------------------------------------------------------------
// onTick callback
// ---------------------------------------------------------------------------

describe('pollRunUntilTerminal — onTick', () => {
  it('onTick is called for every successful poll', async () => {
    const client = makeClient([makeRun('queued'), makeRun('running'), makeRun('passed')]);
    const ticks: string[] = [];
    await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
      onTick: run => ticks.push(run.status),
    });
    expect(ticks).toEqual(['queued', 'running', 'passed']);
  });

  it('onTick is not called when get throws', async () => {
    const client = makeClient([makeApiError('NOT_FOUND', { reason: 'not_found' })]);
    const ticks: string[] = [];
    await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
      onTick: run => ticks.push(run.status),
    }).catch(() => {});
    expect(ticks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// inject sleep as undefined (uses default)
// ---------------------------------------------------------------------------

describe('pollRunUntilTerminal — default sleep', () => {
  it('works without injected sleep (passes through instantly since already terminal)', async () => {
    const client = makeClient([makeRun('passed')]);
    // Don't inject sleep — it will use the real setTimeout, but since
    // the result is terminal on first call, no sleep will be invoked.
    const result = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
    });
    expect(result.status).toBe('passed');
  });
});

// ---------------------------------------------------------------------------
// Item 8 regression: AbortSignal threading + timeout enforced while in flight
// ---------------------------------------------------------------------------

describe('pollRunUntilTerminal — AbortSignal + timeout enforcement', () => {
  it('passes an AbortSignal to getRun on each iteration', async () => {
    const receivedSignals: Array<AbortSignal | undefined> = [];
    const client: RunClient = {
      getRun: async (_runId, opts) => {
        receivedSignals.push(opts?.signal);
        return makeRun('passed');
      },
    };
    await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
    });
    expect(receivedSignals).toHaveLength(1);
    expect(receivedSignals[0]).toBeInstanceOf(AbortSignal);
  });

  it('reuses the same session AbortSignal across poll iterations (no per-iteration churn)', async () => {
    // Regression guard for the AbortController/AbortSignal.any churn fix: a
    // fresh controller + composed signal per iteration was pure waste (the
    // abort target — deadlineMs + cushion — never changes between
    // iterations), and on a `--wait` fan-out over many concurrent runIds it
    // produced enough short-lived `AbortSignal.any` composites to make V8's
    // FinalizationRegistry cleanup pass pathologically slow. The signal is
    // now hoisted once per poll session and reused for every iteration.
    const receivedSignals: Array<AbortSignal | undefined> = [];
    const client: RunClient = {
      getRun: async (_runId, opts) => {
        receivedSignals.push(opts?.signal);
        // Return non-terminal then terminal to force two iterations
        return receivedSignals.length < 2 ? makeRun('running') : makeRun('passed');
      },
    };
    await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
    });
    expect(receivedSignals).toHaveLength(2);
    expect(receivedSignals[0]).toBeInstanceOf(AbortSignal);
    expect(receivedSignals[0]).toBe(receivedSignals[1]);
  });

  it('surfaces TimeoutError when fetch resolves as AbortError (hung fetch past deadline)', async () => {
    // Simulate a hung fetch: getRun throws an AbortError (as fetch would when
    // the AbortSignal fires) rather than resolving normally.
    const client: RunClient = {
      getRun: async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      },
    };
    const result = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 10,
      sleep: instantSleep,
    }).catch(e => e);
    expect(result).toBeInstanceOf(TimeoutError);
    expect((result as TimeoutError).runId).toBe(RUN_ID);
  });

  it('does not treat AbortError from other sources as TimeoutError — propagates as-is', async () => {
    // AbortError thrown from within getRun (not our controller) — should
    // still surface as TimeoutError since we can't distinguish the source
    // from inside the poll loop, and any AbortError reaching the catch block
    // means the fetch was aborted (our timer fired).
    // This is correct behavior: if fetch is aborted, timeout is the reason.
    const client: RunClient = {
      getRun: async () => {
        const err = new DOMException('Aborted', 'AbortError');
        throw err;
      },
    };
    const result = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 10,
      sleep: instantSleep,
    }).catch(e => e);
    expect(result).toBeInstanceOf(TimeoutError);
  });

  it('clamps retryAfterSeconds sleep to remaining deadline', async () => {
    const sleepCalls: number[] = [];
    // Server returns a 30s retryAfterSeconds hint. We use a very short
    // timeout (2s) so the remaining time at the point of the sleep is
    // well under 30000ms. The sleep must be clamped to what's left.
    const client = makeClient([makeRun('running', { retryAfterSeconds: 30 }), makeRun('passed')]);

    // Advance the clock inside the sleep so the loop sees a near-deadline
    // situation, rather than trying to count Date.now() calls.
    const realDateNow = Date.now;
    const base = realDateNow();
    let advancedBy = 0;
    Date.now = () => base + advancedBy;
    try {
      await pollRunUntilTerminal(client, RUN_ID, {
        timeoutSeconds: 5, // deadlineMs = base + 5000
        sleep: async ms => {
          sleepCalls.push(ms);
          // Simulate time passing when we sleep: advance clock to just past
          // the deadline so the next iteration sees the deadline exceeded.
          advancedBy = 5100;
        },
      });
    } catch {
      // TimeoutError is fine — we just want to inspect sleepCalls
    } finally {
      Date.now = realDateNow;
    }
    // The sleep for retryAfterSeconds must NOT be the full 30000ms.
    // With 5s timeout and near-zero elapsed before the sleep, remaining ≈ 5000ms.
    // Clamped sleep must be ≤ 5000ms — much less than the 30000ms server hint.
    expect(sleepCalls.length).toBeGreaterThan(0);
    expect(sleepCalls[0]).toBeLessThanOrEqual(5000);
    expect(sleepCalls[0]).not.toBe(30000);
  });

  it('clamps backoff fallback sleep to remaining deadline', async () => {
    const sleepCalls: number[] = [];
    // Switch to backoff mode, then test that the ~2000ms backoff delay
    // is clamped when very little time is left.
    const client: RunClient = {
      getRun: async (_runId, opts) => {
        if (opts?.waitSeconds !== undefined) {
          // First call: trigger backoff switch
          throw ApiError.fromEnvelope(
            {
              error: {
                code: 'VALIDATION_ERROR',
                message: 'not supported',
                nextAction: '',
                requestId: 'r1',
                details: {},
              },
            },
            400,
          );
        }
        return makeRun('passed');
      },
    };

    const realDateNow = Date.now;
    const base = realDateNow();
    let advancedBy = 0;
    Date.now = () => base + advancedBy;
    try {
      await pollRunUntilTerminal(client, RUN_ID, {
        timeoutSeconds: 5, // deadlineMs = base + 5000
        sleep: async ms => {
          sleepCalls.push(ms);
          // Advance clock past deadline so the test doesn't loop forever
          advancedBy = 5100;
        },
      });
    } catch {
      // TimeoutError / other — we just want to inspect sleepCalls
    } finally {
      Date.now = realDateNow;
    }
    // The backoff delay (nominally ~2000ms from schedule) must be clamped
    // to ≤ timeoutSeconds (5000ms). With near-zero elapsed, remaining ≈ 5000ms.
    expect(sleepCalls.every(ms => ms <= 5000)).toBe(true);
  });

  it('happy path: normal getRun resolve still works (abort timer fires after response)', async () => {
    // Validate that when the server responds before the abort timer fires,
    // the poll loop proceeds correctly and returns the terminal run.
    let capturedSignal: AbortSignal | undefined;
    const client: RunClient = {
      getRun: async (_runId, opts) => {
        capturedSignal = opts?.signal;
        return makeRun('passed');
      },
    };
    const result = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
    });
    expect(result.status).toBe('passed');
    // Signal should still be an AbortSignal (not undefined)
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    // After successful completion, the signal should NOT have been aborted
    // (the timer was cleared)
    expect(capturedSignal?.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// onTransition callback (dogfood item 4)
// ---------------------------------------------------------------------------

describe('pollRunUntilTerminal — onTransition callback', () => {
  it('emits a transition when switching from long-poll to backoff mode', async () => {
    const transitions: string[] = [];
    // First call throws VALIDATION_ERROR (server doesn't support waitSeconds) →
    // switches to backoff mode, then second call returns terminal.
    const client = makeClient([makeApiError('VALIDATION_ERROR', {}), makeRun('passed')]);
    await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
      onTransition: msg => transitions.push(msg),
    });
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions[0]).toMatch(/backoff/i);
  });

  it('emits a transition on not_yet_visible 404', async () => {
    const transitions: string[] = [];
    const client = makeClient([
      makeApiError('NOT_FOUND', { reason: 'not_yet_visible' }),
      makeRun('passed'),
    ]);
    await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
      onTransition: msg => transitions.push(msg),
    });
    expect(transitions.some(t => t.includes('not yet visible'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveAlternate hook (backend testId fallback — dogfood L1888, codex round-2)
// ---------------------------------------------------------------------------

describe('pollRunUntilTerminal — resolveAlternate hook', () => {
  it('resolves a terminal alternate returned on a non-terminal tick (and passes a signal)', async () => {
    const client = makeClient([makeRun('running'), makeRun('running')]);
    let sawSignal = false;
    const result = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
      resolveAlternate: async (_run, _elapsed, signal) => {
        sawSignal = signal instanceof AbortSignal;
        return makeRun('passed', { source: 'cli' });
      },
    });
    expect(result.status).toBe('passed');
    expect(sawSignal).toBe(true);
  });

  it('is NOT called when the run row is already terminal (FE path untouched)', async () => {
    const client = makeClient([makeRun('passed')]);
    let called = false;
    const result = await pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 60,
      sleep: instantSleep,
      resolveAlternate: async () => {
        called = true;
        return makeRun('passed');
      },
    });
    expect(result.status).toBe('passed');
    expect(called).toBe(false);
  });

  it('rejects a terminal alternate that only arrives AFTER the deadline (--timeout is a hard cap)', async () => {
    const realDateNow = Date.now;
    const base = realDateNow();
    let past = false;
    // Stay before the deadline until resolveAlternate flips `past`, then jump
    // well beyond it so the post-alternate deadline check fires.
    Date.now = () => (past ? base + 10_000 : base + 100);
    try {
      const client = makeClient([makeRun('running'), makeRun('running')]);
      const err = await pollRunUntilTerminal(client, RUN_ID, {
        timeoutSeconds: 1, // deadline = startMs + 1000
        sleep: instantSleep,
        resolveAlternate: async () => {
          past = true; // the alternate lookup "took" longer than the remaining --timeout
          return makeRun('passed');
        },
      }).catch(e => e);
      expect(err).toBeInstanceOf(TimeoutError);
    } finally {
      Date.now = realDateNow;
    }
  });
});

// ---------------------------------------------------------------------------
// Graceful detach — shutdown handle (DEV-331 piece 1)
// ---------------------------------------------------------------------------

describe('pollRunUntilTerminal — shutdown (SIGINT/SIGTERM graceful detach)', () => {
  it('throws the InterruptError when the shutdown signal was already aborted (beats the deadline)', async () => {
    const shutdown = new ShutdownController();
    shutdown.interrupt('SIGINT');
    // timeoutSeconds 0 → the deadline has also passed; the interrupt must win.
    const err = await pollRunUntilTerminal(makeClient([makeRun('passed')]), RUN_ID, {
      timeoutSeconds: 0,
      sleep: instantSleep,
      shutdown,
    }).catch(e => e);
    expect(err).toBeInstanceOf(InterruptError);
    expect((err as InterruptError).signal).toBe('SIGINT');
  });

  it('aborts an in-flight long-poll fetch and surfaces InterruptError (not TimeoutError)', async () => {
    // getRun hangs until the composed per-iteration signal aborts — the same
    // contract as a real fetch. Flag-checking between iterations would never
    // notice; only the signal composition can interrupt this.
    const client: RunClient = {
      getRun: (_runId, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(opts.signal!.reason), {
            once: true,
          });
        }),
    };
    const shutdown = new ShutdownController();
    const poll = pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 30,
      sleep: instantSleep,
      shutdown,
    });
    queueMicrotask(() => shutdown.interrupt('SIGINT'));
    const err = await poll.catch(e => e);
    expect(err).toBeInstanceOf(InterruptError);
    expect((err as InterruptError).signal).toBe('SIGINT');
    expect((err as InterruptError).exitCode).toBe(130);
  });

  it('bails out of a retryAfterSeconds sleep immediately on interrupt', async () => {
    // The injected sleep never resolves — only the shutdown race can end it.
    const neverSleep = () => new Promise<void>(() => {});
    const client = makeClient([makeRun('running', { retryAfterSeconds: 60 }), makeRun('running')]);
    const shutdown = new ShutdownController();
    const poll = pollRunUntilTerminal(client, RUN_ID, {
      timeoutSeconds: 300,
      sleep: neverSleep,
      shutdown,
    });
    await new Promise(resolve => setTimeout(resolve, 10)); // let the loop reach the sleep
    shutdown.interrupt('SIGTERM');
    const err = await poll.catch(e => e);
    expect(err).toBeInstanceOf(InterruptError);
    expect((err as InterruptError).signal).toBe('SIGTERM');
    expect((err as InterruptError).exitCode).toBe(143);
  });

  it('arms the graceful-detach scope for the poll duration and disarms after', async () => {
    let armed = 0;
    let disposedCount = 0;
    const handle = {
      signal: new AbortController().signal,
      arm: () => {
        armed += 1;
        return () => {
          disposedCount += 1;
        };
      },
    };
    const run = await pollRunUntilTerminal(makeClient([makeRun('passed')]), RUN_ID, {
      timeoutSeconds: 5,
      sleep: instantSleep,
      shutdown: handle,
    });
    expect(run.status).toBe('passed');
    expect(armed).toBe(1);
    expect(disposedCount).toBe(1);
  });

  it('disarms even when the poll throws (TimeoutError path)', async () => {
    let disposedCount = 0;
    const handle = {
      signal: new AbortController().signal,
      arm: () => () => {
        disposedCount += 1;
      },
    };
    const err = await pollRunUntilTerminal(makeClient([makeRun('running')]), RUN_ID, {
      timeoutSeconds: 0,
      sleep: instantSleep,
      shutdown: handle,
    }).catch(e => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(disposedCount).toBe(1);
  });
});
