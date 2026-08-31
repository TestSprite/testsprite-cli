/**
 * Generation-ladder driver for `test plan generate` (DEV-384 V3-B).
 *
 * This is a NEW loop, deliberately not a reuse of `poll.ts`: the run poller
 * is hard-typed to runs (its `RunClient` contract, `isTerminalStatus` check,
 * and `TimeoutError.runId` are all run-specific), while generation settles on
 * a completely different state machine — the facade-synthesized
 * `CliGenerationStatus` — and additionally has to RE-TRIGGER between stages
 * (writes happen on POST; the read stays pure, so when a stage finishes while
 * a later one is still missing the client must POST again to start it).
 *
 * What it shares with the run poller, by design:
 *
 *  - **The shutdown handle is armed here** for the whole ladder (first POST
 *    included). Arm/disarm lives inside the run poller, not for free in the
 *    harness — without arming, Ctrl-C during a generate wait would hard-kill
 *    the process instead of running the honest-detach UX (DEV-331).
 *  - Long-poll preferred (`?waitSeconds = min(remaining, 25)`), with a
 *    plain-GET + fixed-sleep fallback when the server rejects `waitSeconds`
 *    with VALIDATION_ERROR (older deployment).
 *  - ONE session-scoped `AbortController` firing at the deadline plus a 2s
 *    transport cushion (a fixed absolute instant, so per-request minting
 *    would be pure churn), composed with the shutdown signal via explicit
 *    add/removeEventListener — NOT `AbortSignal.any`, whose dependent-signal
 *    tracking against the long-lived shutdown signal is the known
 *    FinalizationRegistry backlog. poll.ts CONTAINS that backlog by hoisting
 *    a single `.any()` per session (it still calls it); only http.ts
 *    eliminated it outright (`composeAbortSignals`). This module composes
 *    explicitly, like http.ts — don't go hunting for a poll.ts replacement
 *    that isn't there (DEV-384 review F12).
 *    A hung fetch can never overrun `--timeout` and an interrupt aborts the
 *    in-flight request instantly.
 *  - Every sleep is clamped to the remaining deadline and bails on interrupt.
 *
 * The deadline throws {@link PlanGenerationTimeoutError} — which, exactly
 * like poll.ts's `TimeoutError`, is NOT a typed CLI error. The command layer
 * must convert it into the typed exit-7 envelope (`code: 'UNSUPPORTED'`) the
 * way every existing wait site does; letting it propagate raw would surface
 * as a generic exit 1.
 *
 * ── Billing safety (why re-POSTs are guarded) ──────────────────────────────
 *
 * The proposals stage has NO server-side duplicate guard: a second append
 * request wipes the staged batch, regenerates, and bills another 2 credits.
 * The facade refuses to restart when it can SEE the stage (staged proposals,
 * or in-flight per-feature flags) — but those flags are set asynchronously
 * by the append listener, so a client that re-POSTs in the gap between
 * "append accepted" and "flags visible" would still double-bill. Two ladder
 * rules make that structurally impossible:
 *
 *  1. **Never re-POST after the proposals rung.** The trigger response names
 *     the remaining stages; when the last accepted trigger reported
 *     `stagesRemaining: []` there is no later stage a re-POST could start,
 *     so an idle-and-empty read just keeps polling.
 *  2. **Dwell before any other re-POST.** A re-POST fires only once the
 *     started stage was actually observed running (it has genuinely
 *     finished), or after two consecutive idle reads (covering a stage that
 *     finished faster than our first poll). Exploration and strategy are
 *     server-idempotent (per-project ledger key / row lock), so a duplicate
 *     POST there wastes nothing even if the dwell heuristic misjudges.
 */

import { ApiError, InterruptError } from './errors.js';
import type { ShutdownHandle } from './interrupt.js';
import { defaultSleep, isAbortError, sleepUnlessInterrupted } from './poll-support.js';
import type {
  CliGeneratePlansResponse,
  CliGetPlansResponse,
  CliGenerationStage,
} from './plans.types.js';
import { isActiveGenerationStatus, PLAN_GENERATION_STAGES } from './plans.types.js';

/**
 * Minimal structural interface the ladder needs from the HTTP client —
 * mirrors `RunClient` in poll.ts so tests supply a lightweight fake instead
 * of the full `HttpClient`.
 */
export interface PlanLadderClient {
  generatePlans(
    projectId: string,
    options: { idempotencyKey: string; signal?: AbortSignal },
  ): Promise<CliGeneratePlansResponse>;
  getPlans(
    projectId: string,
    options?: { waitSeconds?: number; signal?: AbortSignal },
  ): Promise<CliGetPlansResponse>;
}

/**
 * Thrown when the ladder's deadline elapses. NOT a typed CLI error — the
 * command layer converts it to the exit-7 `UNSUPPORTED` envelope (see the
 * module doc). Carries the last observed plans read so the caller can print
 * an honest partial before exiting.
 */
export class PlanGenerationTimeoutError extends Error {
  readonly projectId: string;
  readonly timeoutSeconds: number;
  readonly lastPlans: CliGetPlansResponse | null;

  constructor(projectId: string, timeoutSeconds: number, lastPlans: CliGetPlansResponse | null) {
    super(`Timed out after ${timeoutSeconds}s waiting for plan generation on ${projectId}`);
    this.name = 'PlanGenerationTimeoutError';
    this.projectId = projectId;
    this.timeoutSeconds = timeoutSeconds;
    this.lastPlans = lastPlans;
  }
}

export interface PlanLadderOptions {
  /** Total wall-clock budget for the WHOLE ladder (all stages), in seconds. */
  timeoutSeconds: number;
  /**
   * Idempotency key for the first trigger POST. Every later POST attempt —
   * 409-attaches included — suffixes it (`<key>:post2`, `<key>:post3`, …):
   * each POST is fresh work, so replaying an earlier POST's cached 202
   * would silently never start the next stage.
   */
  idempotencyKey: string;
  /** Injectable sleep (tests use an instant fake). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Graceful-detach coordinator (DEV-331). The ladder arms it for its whole
   * duration; a SIGINT/SIGTERM surfaces as `InterruptError` out of this
   * function and the caller renders the honest detach.
   */
  shutdown?: ShutdownHandle;
  /**
   * Fired after every trigger POST outcome: an accepted stage start
   * (`acceptedPosts` counts it) or the `nothing_to_start` answer. The
   * command layer prints the first-run hint / credentials warning from the
   * FIRST accepted response.
   */
  onTrigger?: (response: CliGeneratePlansResponse, acceptedPosts: number) => void;
  /** Fired when a trigger answered 409 `stage_in_flight` (attach + poll). */
  onAttach?: (err: ApiError) => void;
  /** Fired after every successful plans read (ticker updates). */
  onTick?: (plans: CliGetPlansResponse, elapsedMs: number) => void;
  /** Low-volume mode-switch messages (wired to stderr at `--verbose`). */
  onTransition?: (msg: string) => void;
}

export interface PlanLadderResult {
  /** The settled read: staged proposals (success), empty-idle, or `failed`. */
  plans: CliGetPlansResponse;
  /**
   * The first ACCEPTED trigger response, or `null` when the ladder only ever
   * attached to stages started elsewhere (409) or found the batch already
   * staged (`nothing_to_start`).
   */
  firstTrigger: CliGeneratePlansResponse | null;
  /** How many trigger POSTs were accepted (stages this invocation started). */
  acceptedPosts: number;
  /**
   * DEV-1008 — `skippedCategories` from the accepted trigger that carried it
   * (the proposals rung), or `null` when no accepted trigger did. Read from
   * the LAST such trigger, not `firstTrigger`: on a fresh backend project
   * the first accepted POST starts strategy, and the field rides only on
   * the proposals POST that follows.
   */
  skippedCategories: number | null;
}

const LONG_POLL_WAIT_SECONDS = 25;
/** Client-side pacing between reads whenever the server can't long-poll for
 *  us: settled (idle) reads return immediately, and so does every read in
 *  the no-`waitSeconds` fallback mode. */
const SETTLED_POLL_DELAY_MS = 2_000;
/** Extra time the per-iteration abort allows past the deadline for
 *  in-flight transport before the fetch is cut (mirrors poll.ts). */
const TRANSPORT_CUSHION_MS = 2_000;
/**
 * Hard cap on accepted trigger POSTs per invocation. The ladder has one rung
 * per pipeline stage, so one more accepted POST than stages means the server
 * keeps reporting "idle and nothing staged" after every stage was started — a
 * contract violation worth failing loudly on instead of re-POSTing forever.
 */
export const MAX_ACCEPTED_TRIGGER_POSTS = PLAN_GENERATION_STAGES.length;
/**
 * Companion cap on TOTAL trigger POSTs (attaches included), so an
 * attach-dominated pathological sequence also fails fast instead of
 * silently burning the whole `--timeout` (DEV-384 review): the accepted
 * rungs + headroom for an attach per rung.
 */
export const MAX_TRIGGER_POSTS_TOTAL = PLAN_GENERATION_STAGES.length * 2;

type TriggerOutcome = 'accepted' | 'nothing_to_start' | 'attached';

/**
 * Drive the generate ladder to a settled state: trigger the next missing
 * stage, poll, re-trigger between stages, and return the settled plans read.
 *
 * @returns the settled read — the caller maps it to exit codes (staged
 *   proposals → 0, `failed` → 1) and renders it.
 * @throws `PlanGenerationTimeoutError` when `timeoutSeconds` elapses (the
 *   caller converts to the typed exit-7 envelope).
 * @throws `InterruptError` on SIGINT/SIGTERM while armed (the caller renders
 *   the honest detach and index.ts exits 128+signum).
 * @throws `ApiError` for trigger/read failures (412 preconditions, 402
 *   credits, 404, 429 — already typed with their exit codes).
 */
export async function runGenerationLadder(
  client: PlanLadderClient,
  projectId: string,
  options: PlanLadderOptions,
): Promise<PlanLadderResult> {
  // Arm the graceful-detach scope for the WHOLE ladder — trigger POSTs
  // included, not just the polling: a Ctrl-C during the first POST must
  // detach honestly too (charges may already be committed server-side).
  const disarm = options.shutdown?.arm();
  try {
    return await ladderLoop(client, projectId, options);
  } finally {
    disarm?.();
  }
}

async function ladderLoop(
  client: PlanLadderClient,
  projectId: string,
  options: PlanLadderOptions,
): Promise<PlanLadderResult> {
  const shutdownSignal = options.shutdown?.signal;
  const rawSleep = options.sleep ?? defaultSleep;
  const sleep = (ms: number): Promise<void> => sleepUnlessInterrupted(rawSleep, ms, shutdownSignal);

  const startMs = Date.now();
  const deadlineMs = startMs + options.timeoutSeconds * 1000;
  let lastPlans: CliGetPlansResponse | null = null;

  const timedOut = (): PlanGenerationTimeoutError =>
    new PlanGenerationTimeoutError(projectId, options.timeoutSeconds, lastPlans);

  // Hoisted ONCE per ladder *session*, not per request (mirrors poll.ts):
  // the abort target — deadlineMs + a transport cushion — is a fixed
  // absolute instant, identical for every trigger POST and plans read, so a
  // per-request controller + `AbortSignal.any` composite was pure churn.
  // Worse, every `AbortSignal.any` registered a never-removed dependent on
  // the long-lived shutdown signal — the FinalizationRegistry backlog that
  // poll.ts contains by hoisting one `.any()` per session and http.ts
  // eliminated outright — the composition below uses explicit listeners,
  // removed in the session's finally.
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(),
    deadlineMs - startMs + TRANSPORT_CUSHION_MS,
  );
  const session = composeSessionSignal(deadlineController.signal, shutdownSignal);

  // Long-poll works until the server says otherwise (VALIDATION_ERROR on
  // `waitSeconds` → plain GETs paced by SETTLED_POLL_DELAY_MS).
  let useLongPoll = true;

  /**
   * Mutable ladder state, grouped in one object because `doTrigger` (a
   * closure) writes it — plain `let` captures would freeze TypeScript's
   * control-flow narrowing at the initial values.
   *
   * `expectedRemaining` is `stagesRemaining` from the last ACCEPTED
   * trigger; `null` = unknown (this invocation attached to a stage started
   * elsewhere). `[]` is the proposals rung — the never-re-POST billing
   * guard keys off it. `proposalsObserved` arms the same guard when the
   * proposals stage is seen RUNNING (covers the 409-attach path, where no
   * trigger response names the stage); sticky — stages are ordered, so
   * nothing legal follows proposals. `triggerPosts` counts every POST that
   * reached the server (attaches included) — drives idempotency-key
   * freshness and the total-POST fuse. `observedActiveSinceTrigger` /
   * `consecutiveIdleGaps` implement the between-stages gap dwell.
   */
  const state = {
    acceptedPosts: 0,
    triggerPosts: 0,
    firstTrigger: null as CliGeneratePlansResponse | null,
    skippedCategories: null as number | null,
    expectedRemaining: null as CliGenerationStage[] | null,
    proposalsObserved: false,
    observedActiveSinceTrigger: false,
    consecutiveIdleGaps: 0,
  };

  /** Interrupt outranks everything, deadline second (mirrors poll.ts). */
  const checkInterruptAndDeadline = (): void => {
    if (shutdownSignal?.aborted) throw shutdownSignal.reason;
    if (Date.now() >= deadlineMs) throw timedOut();
  };

  /**
   * Run one bounded request on the session-scoped signal (deadline +
   * transport cushion, composed with the interrupt), classifying errors
   * the shared way (interrupt > deadline-abort > passthrough).
   */
  const bounded = async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    checkInterruptAndDeadline();
    try {
      return await fn(session.signal);
    } catch (err) {
      // Interrupt classification precedes the timeout mapping — a Ctrl-C
      // that aborted the in-flight fetch must never read as a timeout.
      if (err instanceof InterruptError) throw err;
      if (shutdownSignal?.aborted) throw shutdownSignal.reason;
      if (isAbortError(err)) throw timedOut();
      throw err;
    }
  };

  const doTrigger = async (): Promise<TriggerOutcome> => {
    // Fresh idempotency namespace per POST attempt — ATTACHES INCLUDED
    // (DEV-384 review): a 409's key is never committed server-side, but
    // reusing it would silently depend on that; a fresh key never can.
    // Transport-level retries inside one POST still share the header.
    const key =
      state.triggerPosts === 0
        ? options.idempotencyKey
        : `${options.idempotencyKey}:post${state.triggerPosts + 1}`;
    try {
      const response = await bounded(signal =>
        client.generatePlans(projectId, { idempotencyKey: key, signal }),
      );
      state.triggerPosts += 1;
      if (response.status === 'nothing_to_start') {
        options.onTrigger?.(response, state.acceptedPosts);
        return 'nothing_to_start';
      }
      state.acceptedPosts += 1;
      if (state.firstTrigger === null) state.firstTrigger = response;
      if (typeof response.skippedCategories === 'number') {
        state.skippedCategories = response.skippedCategories;
      }
      state.expectedRemaining = response.stagesRemaining;
      state.observedActiveSinceTrigger = false;
      state.consecutiveIdleGaps = 0;
      options.onTrigger?.(response, state.acceptedPosts);
      return 'accepted';
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.code === 'CONFLICT' &&
        err.getDetail('reason') === 'stage_in_flight'
      ) {
        // A stage is already running (Portal-triggered counts): attach and
        // poll. We don't know what remains after it → re-POSTs allowed,
        // guarded by the dwell and by `proposalsObserved` (billing guard #1
        // arms off the OBSERVED status on this path).
        state.triggerPosts += 1;
        options.onAttach?.(err);
        state.expectedRemaining = null;
        state.observedActiveSinceTrigger = false;
        state.consecutiveIdleGaps = 0;
        return 'attached';
      }
      throw err;
    }
  };

  const readPlans = async (): Promise<CliGetPlansResponse> => {
    const attempt = async (withWait: boolean): Promise<CliGetPlansResponse> =>
      bounded(signal => {
        if (!withWait) return client.getPlans(projectId, { signal });
        const remainingSeconds = Math.ceil((deadlineMs - Date.now()) / 1000);
        const waitSeconds = Math.max(1, Math.min(remainingSeconds, LONG_POLL_WAIT_SECONDS));
        return client.getPlans(projectId, { waitSeconds, signal });
      });
    try {
      return await attempt(useLongPoll);
    } catch (err) {
      // Older deployment without ?waitSeconds → downgrade once, permanently
      // for this invocation, and retry immediately without it.
      if (useLongPoll && err instanceof ApiError && err.code === 'VALIDATION_ERROR') {
        useLongPoll = false;
        options.onTransition?.(
          'Server does not support long-poll (?waitSeconds) — switching to plain polling',
        );
        return attempt(false);
      }
      throw err;
    }
  };

  /** Clamped pacing sleep for reads the server answered immediately. */
  const paceBeforeNextRead = async (): Promise<void> => {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw timedOut();
    await sleep(Math.min(SETTLED_POLL_DELAY_MS, remaining));
  };

  try {
    // ── initial trigger ──
    const initial = await doTrigger();
    if (initial === 'nothing_to_start') {
      // Proposals already staged — one bounded read, render, done.
      const plans = await readPlans();
      lastPlans = plans;
      options.onTick?.(plans, Date.now() - startMs);
      return {
        plans,
        firstTrigger: state.firstTrigger,
        acceptedPosts: state.acceptedPosts,
        skippedCategories: state.skippedCategories,
      };
    }

    // ── poll / re-trigger loop ──
    while (true) {
      checkInterruptAndDeadline();

      const plans = await readPlans();
      lastPlans = plans;
      options.onTick?.(plans, Date.now() - startMs);
      const status = plans.generation.status;

      if (status === 'failed') {
        return {
          plans,
          firstTrigger: state.firstTrigger,
          acceptedPosts: state.acceptedPosts,
          skippedCategories: state.skippedCategories,
        };
      }
      if (isActiveGenerationStatus(status)) {
        state.observedActiveSinceTrigger = true;
        // Seeing the proposals stage RUN arms billing guard #1 regardless of
        // who started it (DEV-384 review — the 409-attach path has no trigger
        // response to arm it from).
        if (status === 'proposing') state.proposalsObserved = true;
        state.consecutiveIdleGaps = 0;
        // Long-poll mode: the server already waited for us — loop immediately.
        // Fallback mode: pace client-side.
        if (!useLongPoll) await paceBeforeNextRead();
        continue;
      }

      // status === 'idle'
      if (plans.proposals.length > 0) {
        // Staged batch present — success.
        return {
          plans,
          firstTrigger: state.firstTrigger,
          acceptedPosts: state.acceptedPosts,
          skippedCategories: state.skippedCategories,
        };
      }

      // Idle and nothing staged: the between-stages gap.
      //
      // Both idle branches below pace UNCONDITIONALLY — even in long-poll
      // mode. This asymmetry with the active branch (which skips pacing under
      // long-poll) is deliberate, not a bug: the server only enters its
      // waitSeconds hold for an ACTIVE generation status (`getPlans` guards
      // its wait loop with `waitSeconds && isActiveGenerationStatus(...)`),
      // so an idle read returns immediately and an unpaced loop here would
      // hammer the facade (DEV-384 review F13).
      //
      // Billing guard #1: once the proposals rung is known to have started —
      // our own trigger said so (`stagesRemaining: []`) OR we watched it run
      // (`proposing`, incl. after a 409-attach) — there is NO later stage;
      // never re-POST (a duplicate append would wipe + re-bill). Keep polling
      // until staged/failed/timeout.
      if (
        (state.expectedRemaining !== null && state.expectedRemaining.length === 0) ||
        state.proposalsObserved
      ) {
        options.onTransition?.(
          'Proposals stage triggered — waiting for the staged batch to appear',
        );
        await paceBeforeNextRead();
        continue;
      }

      // Billing guard #2 (dwell): re-POST only when the started stage was
      // observed running (it has genuinely finished), or after two
      // consecutive idle reads (stage finished before our first poll).
      state.consecutiveIdleGaps += 1;
      if (!state.observedActiveSinceTrigger && state.consecutiveIdleGaps < 2) {
        await paceBeforeNextRead();
        continue;
      }

      if (
        state.acceptedPosts >= MAX_ACCEPTED_TRIGGER_POSTS ||
        state.triggerPosts >= MAX_TRIGGER_POSTS_TOTAL
      ) {
        // Every rung started (or the total-POST budget is spent on attaches)
        // yet the server still reports idle+empty — a facade contract
        // violation; fail loudly instead of looping.
        throw ApiError.fromEnvelope({
          error: {
            code: 'INTERNAL',
            message:
              `Plan generation appears stuck: ${state.triggerPosts} trigger request(s) ` +
              `(${state.acceptedPosts} accepted) but the server still reports no staged ` +
              `proposals and nothing running.`,
            nextAction:
              'Retry later or check the project in the Portal. If this persists, report the requestId to support@testsprite.com.',
            requestId: 'local',
            details: {
              projectId,
              acceptedPosts: state.acceptedPosts,
              triggerPosts: state.triggerPosts,
            },
          },
        });
      }

      const outcome = await doTrigger();
      if (outcome === 'nothing_to_start') {
        // Proposals got staged between our read and the POST (or another
        // client staged them) — settle on a final read.
        const finalPlans = await readPlans();
        lastPlans = finalPlans;
        options.onTick?.(finalPlans, Date.now() - startMs);
        return {
          plans: finalPlans,
          firstTrigger: state.firstTrigger,
          acceptedPosts: state.acceptedPosts,
          skippedCategories: state.skippedCategories,
        };
      }
      // 'accepted' or 'attached' → back to polling.
    }
  } finally {
    clearTimeout(deadlineTimer);
    session.cleanup();
  }
}

interface SessionSignalComposition {
  signal: AbortSignal;
  /** Removes the composition listeners — call once when the session ends. */
  cleanup: () => void;
}

/**
 * Compose the session deadline signal with the (optional, long-lived)
 * shutdown signal WITHOUT `AbortSignal.any` — same rationale as http.ts's
 * `composeAbortSignals`: `.any()` tracks its result as a dependent of every
 * source via WeakRef + FinalizationRegistry, and dependents registered
 * against the process-lifetime shutdown signal are reclaimed only when V8
 * runs a (deferrable) cleanup pass. Explicit listeners, removed by
 * `cleanup()` in the session's finally, leave nothing behind.
 */
function composeSessionSignal(
  deadlineSignal: AbortSignal,
  shutdownSignal: AbortSignal | undefined,
): SessionSignalComposition {
  if (shutdownSignal == null) {
    return { signal: deadlineSignal, cleanup: () => {} };
  }
  const controller = new AbortController();
  // Mirror AbortSignal.any's already-aborted short-circuit.
  const alreadyAborted = [deadlineSignal, shutdownSignal].find(s => s.aborted);
  if (alreadyAborted) {
    controller.abort(alreadyAborted.reason);
    return { signal: controller.signal, cleanup: () => {} };
  }
  const removers: Array<() => void> = [];
  for (const source of [deadlineSignal, shutdownSignal]) {
    const onAbort = (): void => controller.abort(source.reason);
    source.addEventListener('abort', onAbort, { once: true });
    removers.push(() => source.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const remove of removers) remove();
    },
  };
}
