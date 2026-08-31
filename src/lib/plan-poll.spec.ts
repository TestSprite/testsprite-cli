/**
 * Unit tests for `runGenerationLadder` (DEV-384 V3-B).
 *
 * All HTTP is a scripted fake `PlanLadderClient`; sleep is an instant no-op.
 * Deadline tests monkey-patch `Date.now` (same convention as poll.spec.ts).
 *
 * The two billing guards get dedicated coverage — they are the reason this
 * loop exists as its own module (a duplicate proposals append server-side
 * wipes the staged batch and re-bills 2 credits):
 *   1. never re-POST after the proposals rung (`stagesRemaining: []`);
 *   2. dwell before any other re-POST (observed-active or two idle reads).
 */

import { describe, expect, it } from 'vitest';
import { ApiError, InterruptError } from './errors.js';
import { ShutdownController } from './interrupt.js';
import {
  MAX_ACCEPTED_TRIGGER_POSTS,
  MAX_TRIGGER_POSTS_TOTAL,
  PlanGenerationTimeoutError,
  runGenerationLadder,
} from './plan-poll.js';
import type { PlanLadderClient } from './plan-poll.js';
import type {
  CliGeneratePlansResponse,
  CliGetPlansResponse,
  CliGenerationStage,
  CliGenerationStatus,
  CliPlanProposal,
} from './plans.types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ID = 'project_plans_1';
const IDEMPOTENCY_KEY = 'cli-plan-gen-test';

const instantSleep = (): Promise<void> => Promise.resolve();

function accepted(
  stage: CliGenerationStage,
  stagesRemaining: CliGenerationStage[],
): CliGeneratePlansResponse {
  return {
    status: 'accepted',
    projectId: PROJECT_ID,
    stage,
    stagesRemaining,
    enqueuedAt: '2026-07-28T09:00:00.000Z',
  };
}

function nothingToStart(): CliGeneratePlansResponse {
  return {
    status: 'nothing_to_start',
    projectId: PROJECT_ID,
    stage: null,
    stagesRemaining: [],
    enqueuedAt: '2026-07-28T09:00:00.000Z',
  };
}

function proposal(id: string, type: 'frontend' | 'backend' = 'frontend'): CliPlanProposal {
  return {
    proposalId: id,
    title: `Proposal ${id}`,
    description: 'desc',
    priority: 'p1',
    category: 'auth',
    feature: 'login',
    type,
  };
}

function plansRead(
  status: CliGenerationStatus,
  proposals: CliPlanProposal[] = [],
  extra: Partial<CliGetPlansResponse['generation']> = {},
): CliGetPlansResponse {
  return {
    generation: { status, errorCode: null, errorMessage: null, ...extra },
    proposals,
    credits: { charged: [], balance: null },
  };
}

const STAGED = [proposal('prop_1'), proposal('prop_2', 'backend')];

interface ScriptedClient extends PlanLadderClient {
  readonly triggerKeys: string[];
  readonly triggerCount: number;
  readonly readCount: number;
  readonly readWaitSeconds: Array<number | undefined>;
}

/**
 * Scripted fake: `triggers` and `reads` are consumed in order; an `ApiError`
 * entry throws. Running out of either script is a test bug and throws.
 */
function makeClient(
  triggers: Array<CliGeneratePlansResponse | ApiError>,
  reads: Array<CliGetPlansResponse | ApiError>,
): ScriptedClient {
  let t = 0;
  let r = 0;
  const triggerKeys: string[] = [];
  const readWaitSeconds: Array<number | undefined> = [];
  return {
    get triggerKeys() {
      return triggerKeys;
    },
    get triggerCount() {
      return t;
    },
    get readCount() {
      return r;
    },
    get readWaitSeconds() {
      return readWaitSeconds;
    },
    generatePlans: async (_projectId, options) => {
      triggerKeys.push(options.idempotencyKey);
      const next = triggers[t++];
      if (!next) throw new Error('Ran out of scripted trigger responses');
      if (next instanceof ApiError) throw next;
      return next;
    },
    getPlans: async (_projectId, options) => {
      readWaitSeconds.push(options?.waitSeconds);
      const next = reads[r++];
      if (!next) throw new Error('Ran out of scripted plans reads');
      if (next instanceof ApiError) throw next;
      return next;
    },
  };
}

function makeApiError(
  code: string,
  details: Record<string, unknown> = {},
  httpStatus?: number,
): ApiError {
  return ApiError.fromEnvelope(
    { error: { code, message: `Error: ${code}`, nextAction: '', requestId: 'req_test', details } },
    httpStatus,
  );
}

function ladder(
  client: PlanLadderClient,
  overrides: Partial<Parameters<typeof runGenerationLadder>[2]> = {},
): ReturnType<typeof runGenerationLadder> {
  return runGenerationLadder(client, PROJECT_ID, {
    timeoutSeconds: 600,
    idempotencyKey: IDEMPOTENCY_KEY,
    sleep: instantSleep,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Full-chain progression
// ---------------------------------------------------------------------------

describe('runGenerationLadder — stage progression', () => {
  it('drives the full three-stage chain, re-POSTing between stages', async () => {
    const client = makeClient(
      [
        accepted('exploration', ['strategy', 'proposals']),
        accepted('strategy', ['proposals']),
        accepted('proposals', []),
      ],
      [
        plansRead('exploring'),
        plansRead('exploring'),
        plansRead('idle'), // exploration finished, strategy missing → re-POST
        plansRead('strategizing'),
        plansRead('idle'), // strategy finished, proposals missing → re-POST
        plansRead('proposing'),
        plansRead('idle', STAGED), // staged → success
      ],
    );
    const triggersSeen: Array<[string, number]> = [];
    const result = await ladder(client, {
      onTrigger: (resp, acceptedPosts) => triggersSeen.push([resp.stage ?? 'null', acceptedPosts]),
    });

    expect(client.triggerCount).toBe(3);
    expect(result.acceptedPosts).toBe(3);
    expect(result.plans.proposals).toHaveLength(2);
    expect(result.firstTrigger?.stage).toBe('exploration');
    expect(triggersSeen).toEqual([
      ['exploration', 1],
      ['strategy', 2],
      ['proposals', 3],
    ]);
    // Each POST attempt gets its own idempotency namespace.
    expect(client.triggerKeys).toEqual([
      IDEMPOTENCY_KEY,
      `${IDEMPOTENCY_KEY}:post2`,
      `${IDEMPOTENCY_KEY}:post3`,
    ]);
  });

  it('skips completed stages: an explored project starts at strategy', async () => {
    const client = makeClient(
      [accepted('strategy', ['proposals']), accepted('proposals', [])],
      [
        plansRead('strategizing'),
        plansRead('idle'),
        plansRead('proposing'),
        plansRead('idle', STAGED),
      ],
    );
    const result = await ladder(client);
    expect(client.triggerCount).toBe(2);
    expect(result.firstTrigger?.stage).toBe('strategy');
    expect(result.plans.proposals).toHaveLength(2);
  });

  it('nothing_to_start on the initial trigger settles on one read', async () => {
    const client = makeClient([nothingToStart()], [plansRead('idle', STAGED)]);
    const seen: number[] = [];
    const result = await ladder(client, {
      onTrigger: (_resp, acceptedPosts) => seen.push(acceptedPosts),
    });
    expect(result.acceptedPosts).toBe(0);
    expect(result.firstTrigger).toBeNull();
    expect(result.plans.proposals).toHaveLength(2);
    expect(seen).toEqual([0]);
    expect(client.readCount).toBe(1);
  });

  it('attaches on 409 stage_in_flight and keeps polling (initial POST)', async () => {
    const inFlight = makeApiError('CONFLICT', { reason: 'stage_in_flight' }, 409);
    const client = makeClient(
      [inFlight, accepted('proposals', [])],
      [
        plansRead('strategizing'), // attached to someone else's strategy run
        plansRead('idle'), // it finished; proposals missing → re-POST allowed
        plansRead('proposing'),
        plansRead('idle', STAGED),
      ],
    );
    let attached = 0;
    const result = await ladder(client, { onAttach: () => (attached += 1) });
    expect(attached).toBe(1);
    expect(result.acceptedPosts).toBe(1);
    expect(result.plans.proposals).toHaveLength(2);
    expect(result.firstTrigger?.stage).toBe('proposals');
  });

  it('DEV-1008: skippedCategories is read from the accepted trigger that carries it, not firstTrigger', async () => {
    const proposalsWithSkips = { ...accepted('proposals', []), skippedCategories: 2 };
    const client = makeClient(
      [accepted('strategy', ['proposals']), proposalsWithSkips],
      [
        plansRead('strategizing'),
        plansRead('idle'),
        plansRead('proposing'),
        plansRead('idle', STAGED),
      ],
    );
    const result = await ladder(client);
    expect(result.acceptedPosts).toBe(2);
    expect(result.firstTrigger?.stage).toBe('strategy');
    expect(result.skippedCategories).toBe(2);
  });

  it('DEV-1008: skippedCategories is null when no accepted trigger carried it', async () => {
    const client = makeClient(
      [accepted('proposals', [])],
      [plansRead('proposing'), plansRead('idle', STAGED)],
    );
    const result = await ladder(client);
    expect(result.acceptedPosts).toBe(1);
    expect(result.skippedCategories).toBeNull();
  });

  it('409 on a mid-ladder re-POST also attaches (Portal race)', async () => {
    const inFlight = makeApiError('CONFLICT', { reason: 'stage_in_flight' }, 409);
    const client = makeClient(
      [accepted('strategy', ['proposals']), inFlight],
      [
        plansRead('strategizing'),
        plansRead('idle'), // strategy done → re-POST → 409 (Portal started proposals)
        plansRead('proposing'),
        plansRead('idle', STAGED),
      ],
    );
    let attached = 0;
    const result = await ladder(client, { onAttach: () => (attached += 1) });
    expect(attached).toBe(1);
    expect(result.plans.proposals).toHaveLength(2);
  });

  it('a generic CONFLICT (no stage_in_flight reason) propagates instead of attaching', async () => {
    const conflict = makeApiError('CONFLICT', { reason: 'something_else' }, 409);
    const client = makeClient([conflict], []);
    await expect(ladder(client)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('settles on failed status and returns it (caller maps exit 1)', async () => {
    const client = makeClient(
      [accepted('strategy', ['proposals'])],
      [
        plansRead('strategizing'),
        plansRead('failed', [], {
          errorCode: 'strategy_generation_stale',
          errorMessage: 'strategy generation crashed',
        }),
      ],
    );
    const result = await ladder(client);
    expect(result.plans.generation.status).toBe('failed');
    expect(result.plans.generation.errorCode).toBe('strategy_generation_stale');
  });

  it('nothing_to_start on a re-POST settles on a final read', async () => {
    const client = makeClient(
      [accepted('strategy', ['proposals']), nothingToStart()],
      [
        plansRead('strategizing'),
        plansRead('idle'), // gap → re-POST answers nothing_to_start (raced)
        plansRead('idle', STAGED), // final read
      ],
    );
    const result = await ladder(client);
    expect(result.plans.proposals).toHaveLength(2);
    expect(client.triggerCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Billing guards
// ---------------------------------------------------------------------------

describe('runGenerationLadder — billing guards', () => {
  it('NEVER re-POSTs after the proposals rung (stagesRemaining: [])', async () => {
    // The append listener sets its in-flight flags asynchronously: reads can
    // show idle+empty right after the proposals trigger. A re-POST there
    // would wipe + re-bill server-side — the ladder must only poll.
    const client = makeClient(
      [accepted('proposals', [])],
      [
        plansRead('idle'), // flags not visible yet
        plansRead('idle'), // still not visible — two consecutive gaps
        plansRead('idle'), // (a naive dwell-only guard would re-POST by now)
        plansRead('proposing'),
        plansRead('idle', STAGED),
      ],
    );
    const result = await ladder(client);
    expect(client.triggerCount).toBe(1); // never re-POSTed
    expect(result.plans.proposals).toHaveLength(2);
  });

  it('dwells before re-POSTing when the started stage was never observed running', async () => {
    // Strategy finished faster than our first poll: first read is already
    // idle+empty. The ladder must NOT re-POST on that single read — only
    // after a second consecutive idle read confirms the gap.
    const client = makeClient(
      [accepted('strategy', ['proposals']), accepted('proposals', [])],
      [
        plansRead('idle'), // 1st gap read — no re-POST yet
        plansRead('idle'), // 2nd gap read — now re-POST
        plansRead('proposing'),
        plansRead('idle', STAGED),
      ],
    );
    const readsAtTrigger: number[] = [];
    await ladder(client, {
      onTrigger: () => readsAtTrigger.push(client.readCount),
    });
    expect(client.triggerCount).toBe(2);
    // First trigger fires before any read; the re-POST only after TWO reads.
    expect(readsAtTrigger).toEqual([0, 2]);
  });

  it('re-POSTs immediately once the stage was observed running and then went idle', async () => {
    const client = makeClient(
      [accepted('strategy', ['proposals']), accepted('proposals', [])],
      [
        plansRead('strategizing'), // observed running
        plansRead('idle'), // finished → re-POST without extra dwell
        plansRead('idle', STAGED),
      ],
    );
    const readsAtTrigger: number[] = [];
    await ladder(client, {
      onTrigger: () => readsAtTrigger.push(client.readCount),
    });
    expect(readsAtTrigger).toEqual([0, 2]);
  });

  it('attached to an in-flight PROPOSALS stage: idle+empty reads NEVER re-POST (review fix)', async () => {
    // The double-bill race from the DEV-384 review: attach to someone
    // else's proposals run, watch it run, then hit a visibility gap
    // (finished but batch not readable yet). Before the fix,
    // `expectedRemaining = null` + observed-active meant an IMMEDIATE
    // re-POST here — a duplicate append that wipes + re-bills server-side.
    // `proposalsObserved` must arm guard #1 off the watched status.
    const inFlight = makeApiError('CONFLICT', { reason: 'stage_in_flight' }, 409);
    const client = makeClient(
      [inFlight],
      [
        plansRead('proposing'), // attached; watched it run
        plansRead('idle'), // visibility gap — must NOT re-POST
        plansRead('idle'), // still gapped — must NOT re-POST
        plansRead('idle', STAGED), // batch appears → success
      ],
    );
    const result = await ladder(client);
    expect(client.triggerCount).toBe(1); // the attach attempt only
    expect(result.plans.proposals).toHaveLength(2);
  });

  it('a re-POST after an attach uses a FRESH idempotency key (review fix)', async () => {
    // The attach attempt consumed a key; the follow-up POST must not reuse
    // it (a cached replay would silently never start the next stage).
    const inFlight = makeApiError('CONFLICT', { reason: 'stage_in_flight' }, 409);
    const client = makeClient(
      [inFlight, accepted('proposals', [])],
      [
        plansRead('strategizing'), // attached to someone else's strategy
        plansRead('idle'), // it finished → re-POST for proposals
        plansRead('proposing'),
        plansRead('idle', STAGED),
      ],
    );
    await ladder(client);
    expect(client.triggerKeys).toEqual([IDEMPOTENCY_KEY, `${IDEMPOTENCY_KEY}:post2`]);
  });

  it('an attach-dominated stuck sequence trips the total-POST fuse (review fix)', async () => {
    // Every POST 409-attaches, every observation is strategizing→idle, so
    // acceptedPosts never grows. Before the fix, no fuse could fire and the
    // ladder silently re-POSTed until --timeout; now the total cap answers
    // with the diagnostic INTERNAL error.
    const inFlight = makeApiError('CONFLICT', { reason: 'stage_in_flight' }, 409);
    const client = makeClient(
      Array.from({ length: 8 }, () => inFlight),
      Array.from({ length: 20 }, (_v, i) =>
        i % 2 === 0 ? plansRead('strategizing') : plansRead('idle'),
      ),
    );
    const err = await ladder(client).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('INTERNAL');
    expect(client.triggerCount).toBe(MAX_TRIGGER_POSTS_TOTAL);
    // The documented discriminator for the locally-minted envelope (§13):
    // requestId "local" + the POST counters in details.
    expect((err as ApiError).requestId).toBe('local');
    expect((err as ApiError).getDetail('acceptedPosts')).toBe(0);
    expect((err as ApiError).getDetail('triggerPosts')).toBe(MAX_TRIGGER_POSTS_TOTAL);
  });

  it(`fails loudly (INTERNAL) after ${MAX_ACCEPTED_TRIGGER_POSTS} accepted POSTs with no progress`, async () => {
    // A misbehaving facade keeps accepting triggers yet always reports
    // idle+empty. The ladder must stop re-POSTing after the cap instead of
    // looping forever.
    const misbehaving = accepted('strategy', ['proposals']);
    const client = makeClient(
      [misbehaving, misbehaving, misbehaving],
      Array.from({ length: 12 }, () => plansRead('idle')),
    );
    const err = await ladder(client).catch(e => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('INTERNAL');
    expect(client.triggerCount).toBe(MAX_ACCEPTED_TRIGGER_POSTS);
    // The documented discriminator for the locally-minted envelope (§13):
    // requestId "local" + the POST counters in details.
    expect((err as ApiError).requestId).toBe('local');
    expect((err as ApiError).getDetail('acceptedPosts')).toBe(MAX_ACCEPTED_TRIGGER_POSTS);
    expect((err as ApiError).getDetail('triggerPosts')).toBe(MAX_ACCEPTED_TRIGGER_POSTS);
  });
});

// ---------------------------------------------------------------------------
// Long-poll mechanics
// ---------------------------------------------------------------------------

describe('runGenerationLadder — long-poll mechanics', () => {
  it('sends waitSeconds = min(remaining, 25) on plans reads', async () => {
    const client = makeClient(
      [accepted('proposals', [])],
      [plansRead('proposing'), plansRead('idle', STAGED)],
    );
    await ladder(client, { timeoutSeconds: 600 });
    expect(client.readWaitSeconds).toEqual([25, 25]);
  });

  it('caps waitSeconds at the remaining deadline', async () => {
    const client = makeClient([accepted('proposals', [])], [plansRead('idle', STAGED)]);
    await ladder(client, { timeoutSeconds: 10 });
    expect(client.readWaitSeconds[0]).toBeLessThanOrEqual(10);
    expect(client.readWaitSeconds[0]).toBeGreaterThanOrEqual(1);
  });

  it('falls back to plain polling when the server rejects waitSeconds', async () => {
    const validation = makeApiError('VALIDATION_ERROR', {}, 400);
    const client = makeClient(
      [accepted('proposals', [])],
      [validation, plansRead('proposing'), plansRead('idle', STAGED)],
    );
    const transitions: string[] = [];
    const result = await ladder(client, { onTransition: m => transitions.push(m) });
    expect(result.plans.proposals).toHaveLength(2);
    // First read attempted long-poll; the retry and every later read did not.
    expect(client.readWaitSeconds[0]).toBe(25);
    expect(client.readWaitSeconds.slice(1)).toEqual([undefined, undefined]);
    expect(transitions.some(m => m.includes('waitSeconds'))).toBe(true);
  });

  it('propagates NOT_FOUND from the plans read (unknown/cross-workspace project)', async () => {
    const client = makeClient(
      [accepted('strategy', ['proposals'])],
      [makeApiError('NOT_FOUND', {}, 404)],
    );
    await expect(ladder(client)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// Deadline + interrupt
// ---------------------------------------------------------------------------

describe('runGenerationLadder — deadline', () => {
  it('throws PlanGenerationTimeoutError (with lastPlans) when the deadline passes', async () => {
    const client: PlanLadderClient = {
      generatePlans: async () => accepted('exploration', ['strategy', 'proposals']),
      getPlans: async () => plansRead('exploring', [], {}),
    };
    const realDateNow = Date.now;
    const base = realDateNow();
    let calls = 0;
    Date.now = () => {
      calls += 1;
      // Let the trigger and the first read complete, then pass the deadline.
      return calls > 6 ? base + 10_000 : base;
    };
    try {
      const err = await runGenerationLadder(client, PROJECT_ID, {
        timeoutSeconds: 5,
        idempotencyKey: IDEMPOTENCY_KEY,
        sleep: instantSleep,
      }).catch(e => e);
      expect(err).toBeInstanceOf(PlanGenerationTimeoutError);
      const timeout = err as PlanGenerationTimeoutError;
      expect(timeout.timeoutSeconds).toBe(5);
      expect(timeout.projectId).toBe(PROJECT_ID);
      expect(timeout.lastPlans?.generation.status).toBe('exploring');
    } finally {
      Date.now = realDateNow;
    }
  });

  it('maps a hung fetch (AbortError) to PlanGenerationTimeoutError', async () => {
    const client: PlanLadderClient = {
      generatePlans: async () => accepted('proposals', []),
      getPlans: async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      },
    };
    const err = await runGenerationLadder(client, PROJECT_ID, {
      timeoutSeconds: 10,
      idempotencyKey: IDEMPOTENCY_KEY,
      sleep: instantSleep,
    }).catch(e => e);
    expect(err).toBeInstanceOf(PlanGenerationTimeoutError);
  });
});

describe('runGenerationLadder — shutdown handle (DEV-331)', () => {
  it('arms the shared shutdown handle for the ladder and disarms after', async () => {
    const shutdown = new ShutdownController();
    let armedDuringPoll = false;
    const client: PlanLadderClient = {
      generatePlans: async () => accepted('proposals', []),
      getPlans: async () => {
        armedDuringPoll = shutdown.isArmed;
        return plansRead('idle', STAGED);
      },
    };
    await runGenerationLadder(client, PROJECT_ID, {
      timeoutSeconds: 60,
      idempotencyKey: IDEMPOTENCY_KEY,
      sleep: instantSleep,
      shutdown,
    });
    expect(armedDuringPoll).toBe(true);
    expect(shutdown.isArmed).toBe(false);
  });

  it('surfaces InterruptError when the shutdown signal fires mid-poll', async () => {
    // getPlans hangs until the composed per-iteration signal aborts — the
    // same contract as a real fetch (mirrors poll.spec.ts). Only the signal
    // composition can interrupt this; flag-checking between iterations never
    // would.
    const shutdown = new ShutdownController();
    const client: PlanLadderClient = {
      generatePlans: async () => accepted('exploration', ['strategy', 'proposals']),
      getPlans: (_projectId, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal!.reason as Error),
            {
              once: true,
            },
          );
        }),
    };
    const pending = runGenerationLadder(client, PROJECT_ID, {
      timeoutSeconds: 60,
      idempotencyKey: IDEMPOTENCY_KEY,
      sleep: instantSleep,
      shutdown,
    });
    queueMicrotask(() => shutdown.interrupt('SIGINT'));
    const err = await pending.catch(e => e);
    expect(err).toBeInstanceOf(InterruptError);
    expect((err as InterruptError).signal).toBe('SIGINT');
    expect((err as InterruptError).exitCode).toBe(130);
    expect(shutdown.isArmed).toBe(false); // disarmed on the way out
  });
});
