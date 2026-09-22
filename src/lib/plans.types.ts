/**
 * Wire types for the DEV-384 plan-generation surface:
 *
 *   `POST /api/cli/v1/projects/{id}/plans/generate` — start the next missing
 *        pipeline stage (202)
 *   `GET  /api/cli/v1/projects/{id}/plans`          — synthesized generation
 *        status + staged proposals + best-effort credits (long-polls via
 *        `?waitSeconds=1..25`)
 *   `POST /api/cli/v1/projects/{id}/plans/accept`   — staged proposals → real
 *        test cases
 *
 * These mirror the backend facade's `cli-plans.types.ts` (V3-A) shape-for-
 * shape. The generation `status` is FACADE-SYNTHESIZED — no such enum exists
 * on the V3 pipeline itself (design-doc v3.1 §7, DR-31) — so the CLI treats
 * it as the complete truth and never tries to derive state from anything
 * else.
 */

/** Pipeline stages the trigger can start, in ladder order. */
export const PLAN_GENERATION_STAGES = ['exploration', 'strategy', 'proposals'] as const;
export type CliGenerationStage = (typeof PLAN_GENERATION_STAGES)[number];

/**
 * Facade-synthesized generation status. `exploring`/`strategizing`/
 * `proposing` are the active (keep-polling) states; `idle` means nothing is
 * running (proposals present = staged batch ready, proposals empty = nothing
 * staged yet); `failed` carries `errorCode`/`errorMessage`.
 */
export type CliGenerationStatus = 'exploring' | 'strategizing' | 'proposing' | 'idle' | 'failed';

/**
 * `generation.errorCode` values a `failed` status can carry. Kept as an open
 * string union on the wire (`string | null` in {@link CliGenerationBlock})
 * so a future backend adding a code is non-breaking — the CLI renders the
 * message text and never switches on codes outside this set.
 */
export type CliGenerationErrorCode =
  'exploration_failed' | 'strategy_generation_stale' | 'proposal_generation_aborted';

/** Exploration progress: resources SETTLED (process AND embedding terminal). */
export interface CliGenerationProgress {
  resourcesReady: number;
  resourcesTotal: number;
}

export interface CliGenerationBlock {
  status: CliGenerationStatus;
  /** Present only while `exploring`. */
  progress?: CliGenerationProgress;
  errorCode: string | null;
  errorMessage: string | null;
}

/** One FE plan step inside a staged proposal. */
export interface CliPlanProposalStep {
  type: 'action' | 'assertion';
  description: string;
}

/**
 * One staged proposal. `proposalId` is the stable id `accept --only`
 * consumes — every listed proposal carries it, which is why the CLI table
 * prints it.
 */
export interface CliPlanProposal {
  proposalId: string;
  title: string;
  description: string;
  /** CLI priority vocabulary (`p1`..`p3`, mapped from V3 High/Medium/Low). */
  priority: string;
  category: string;
  feature: string;
  type: 'frontend' | 'backend';
  /** Frontend proposals: action/assertion steps. */
  steps?: CliPlanProposalStep[];
  /** Backend proposals: the endpoint under test (when resolvable). */
  endpointPath?: string | null;
  /** Backend proposals: variable names this test captures for consumers. */
  captures?: string[];
  /** Backend proposals: variable names this test consumes from producers. */
  consumes?: string[];
}

export interface CliPlanCreditsCharged {
  action: string;
  amount: number;
}

/**
 * Best-effort billing summary — the facade degrades this to an empty block
 * on any billing-read failure, so the CLI must render fine without it
 * (design-doc §5: "filled in best-effort and never able to fail the
 * command").
 */
export interface CliPlanCreditsBlock {
  charged: CliPlanCreditsCharged[];
  balance: number | null;
}

/** `GET /projects/{id}/plans` response. */
export interface CliGetPlansResponse {
  generation: CliGenerationBlock;
  proposals: CliPlanProposal[];
  /** Optional-safe on the wire: treat an absent block like an empty one. */
  credits?: CliPlanCreditsBlock;
}

/** `POST /projects/{id}/plans/generate` response (HTTP 202 both ways). */
export interface CliGeneratePlansResponse {
  /**
   * `accepted` — one stage was started; poll `GET /plans`.
   * `nothing_to_start` — proposals are already staged (the facade's
   * no-restart guard: a duplicate append would wipe the staged batch and
   * re-bill 2 credits, so the trigger refuses and points at the batch).
   */
  status: 'accepted' | 'nothing_to_start';
  /** The resolved V3 project id (the id `GET /plans` should be polled with). */
  projectId: string;
  stage: CliGenerationStage | null;
  stagesRemaining: CliGenerationStage[];
  enqueuedAt: string;
  /**
   * DEV-1008 — `stage: proposals` on a backend project only. Strategy
   * categories the proposals stage was NOT asked for because they carry no
   * endpoint to attach a test case to (cross-cutting themes such as
   * authorization or pagination). Absent when nothing was skipped and on
   * every other stage. The stage is charged flat, so this is the only
   * signal that the plan covers fewer categories than the strategy lists.
   */
  skippedCategories?: number;
}

/**
 * `POST /projects/{id}/plans/accept` response — the server's real shape.
 * No code-generation field: accept does not generate code (API test code
 * generates at first run — DR-29).
 */
export interface CliAcceptPlansResponse {
  acceptedCount: number;
  caseKeys: string[];
}

// A local `PLAN_STAGE_COSTS` price table used to live here, feeding the
// `--help` credits block and the pre-run hint. Both were removed: the command
// no longer quotes a price up front (matching `test run`), and actual spend is
// reported after the fact from `credits.charged` / `credits.balance` on the
// wire. Deliberately NOT kept as an unused constant — a hardcoded copy of the
// backend's rate card that nothing reads is a silent drift risk against
// `billing-pricing.ts`, which is the only billing authority.

/** The active (keep-polling) statuses. `idle`/`failed` are settled. */
export function isActiveGenerationStatus(status: CliGenerationStatus): boolean {
  return status === 'exploring' || status === 'strategizing' || status === 'proposing';
}
