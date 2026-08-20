/**
 * Types for M3.3 piece-3 — `test run` / `test wait` commands.
 * Extended by M3.4 piece-3 — `test rerun` command.
 * Extended by M3.4 piece-5 — `test result --history` command.

 */

import type { RunConflict } from './conflict-reason.js';

/** Literal body sent to `POST /api/cli/v1/tests/{testId}/runs`. */
export interface TriggerRunBody {
  /** Fixed source literal for CLI-triggered runs. */
  source: 'cli';
  /** Optional override for the project's configured target URL. */
  targetUrl?: string;
}

// ---------------------------------------------------------------------------
// M3.4 — Rerun wire types
// ---------------------------------------------------------------------------

/**
 * Body sent to `POST /api/cli/v1/tests/{testId}/runs/rerun`.
 * No `targetUrl` — rerun replays against the project's configured URL.
 * `source` must be "cli" (not "cli-rerun" — that is not a valid RUN_SOURCES value).
 */
export interface RerunRequest {
  source: 'cli';
  /** Opt into AI heal-on-drift. Paid + FE only. Server tier-gates and echoes effective value. */
  autoHeal?: boolean;
  /** BE only: rerun only the named test without expanding the producer/teardown closure. */
  skipDependencies?: boolean;
}

/** One closure member returned in `RerunResponse.closure.members[]`. */
export interface RerunClosureMember {
  testId: string;
  /** The runId minted synchronously (claimRunSlotOrThrow) for this member. Never null. */
  runId: string;
  /** Role of this test in the closure: 'selected' | 'producer' | 'teardown'. */
  role: 'selected' | 'producer' | 'teardown';
}

/** Closure breakdown returned for BE reruns. */
export interface RerunClosure {
  members: RerunClosureMember[];
  addedProducers: string[];
  addedTeardowns: string[];
  clearedCaptured: number;
}

/**
 * A machine-readable note that a requested option was forwarded to the
 * execution engine but is not yet honored there. Emitted ONLY on a
 * V3-routed rerun when the caller explicitly requested `autoHeal:false` —
 * absent otherwise, including every V2 response and every V3 response that
 * did not request an opt-out.
 */
export interface RerunAdvisory {
  /** Machine-readable feature name the advisory concerns (e.g. "autoHeal"). */
  feature: string;
  /** Human-readable explanation of the current limitation. */
  message: string;
}

/**
 * Response from `POST /api/cli/v1/tests/{testId}/runs/rerun`.
 * FE shape: no `closure`. BE shape: includes `closure` with per-member runIds.
 * `runId` is always non-null (minted synchronously before async invoke).
 */
export interface RerunResponse {
  /** The named test's runId (minted synchronously before async Lambda invoke). */
  runId: string;
  status: 'queued';
  enqueuedAt: string;
  codeVersion: string;
  /** Effective autoHeal value after the server tier-gate (Free → always false). */
  autoHeal: boolean;
  /**
   * Present for BE reruns only. Contains per-member runIds.
   * G1c: backend always sends this field; FE reruns send `null`.
   * `undefined` means pre-G1c backend (treated identically to `null` —
   * the `!!closure` truthy check in the CLI already handles both).
   */
  closure?: RerunClosure | null;
  /**
   * Present only when this rerun was routed to V3 execution AND the caller
   * explicitly requested `autoHeal:false` (see {@link RerunAdvisory}). Absent
   * on every other response, including older backends that predate the field.
   */
  advisories?: RerunAdvisory[];
}

/**
 * Body sent to `POST /api/cli/v1/tests/batch/rerun`.
 * Mixed FE/BE testIds allowed; BE closure deduped server-side per project.
 */
export interface BatchRerunRequest {
  source: 'cli';
  testIds: string[];
  autoHeal?: boolean;
  skipDependencies?: boolean;
}

/** One accepted run in the batch rerun response. */
export interface BatchRerunAccepted {
  testId: string;
  /** runId minted synchronously (claimRunSlotOrThrow). Never null. */
  runId: string;
  enqueuedAt: string;
}

/** One rate-deferred testId in the batch rerun response. */
export interface BatchRerunDeferred {
  testId: string;
  reason: string;
}

/** One conflicted (already in-flight) testId in the batch rerun response. */
export interface BatchRerunConflict {
  testId: string;
  currentRunId: string;
}

/** Per-project closure summary in the batch rerun response. */
export interface BatchRerunClosureByProject {
  projectId: string;
  testIds: string[];
  addedProducers: string[];
  addedTeardowns: string[];
  clearedCaptured: number;
}

export interface BatchRerunClosure {
  byProject: BatchRerunClosureByProject[];
}

/**
 * Response from `POST /api/cli/v1/tests/batch/rerun`.
 * `accepted` carries one entry per dispatched run (incl. BE closure members), each with its runId.
 * `deferred` = rate-limited this window; retry later (C1).
 * `conflicts` = already in-flight, skipped.
 * `notFound` = ids that were unknown, cross-tenant, or never completed a clean run (D2-CLI).
 *   Present when the server supports partial-accept (SOME ids bad → 200 with accepted+notFound).
 *   When ALL ids are bad the server returns 404 (caught separately in the catch block).
 *   Optional for back-compat with older backends that don't send this field.
 * `advisories` = present only when at least one FE test in the batch was routed to V3
 *   execution AND explicitly requested `autoHeal:false` (see {@link RerunAdvisory}).
 *   Absent on every other response. The CLI aggregates + dedupes this field across
 *   chunked dispatch requests (see `dedupeRerunAdvisories` in `commands/test.ts`).
 */
export interface BatchRerunResponse {
  accepted: BatchRerunAccepted[];
  deferred: BatchRerunDeferred[];
  conflicts: BatchRerunConflict[];
  closure: BatchRerunClosure;
  notFound?: string[];
  advisories?: RerunAdvisory[];
}

/**
 * Response from `POST /api/cli/v1/tests/{testId}/runs`.
 * All fields are stamped at trigger time and cannot change for this runId.
 */
export interface TriggerRunResponse {
  runId: string;
  status: 'queued';
  enqueuedAt: string;
  /** codeVersion resolved at trigger time from the test row. */
  codeVersion: string;
  /** Resolved target URL (project default when --target-url absent). */
  targetUrl: string;
}

/**
 * Public run-status values.
 * `queued` and `running` are non-terminal; the rest are terminal.
 */
export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'cancelled';

/**
 * Lightweight step summary returned inside `GET /api/cli/v1/runs/{runId}`.
 * Full step records arrive via `/runs/{runId}/failure`.
 */
export interface RunStepSummary {
  total: number;
  completed: number;
  passedCount: number;
  failedCount: number;
}

/**
 * One step row returned when `GET /api/cli/v1/runs/{runId}?includeSteps=true`.
 * Mirrors the backend's `RunStepDto` / `TestRunStepEntity` public fields.
 *
 * Note: `stepIndex` is a zero-padded string on the wire (SK of `TestRunStep`);
 * parse with `parseInt` when a numeric index is needed. `createdAt` is the
 * timestamp the step was recorded (no separate `updatedAt` for run-scoped steps).
 */
export interface RunStepDto {
  stepIndex: string;
  type: 'action' | 'assertion';
  action: string;
  status: 'passed' | 'failed' | null;
  description: string | null;
  error: string | null;
  screenshotUrl: string | null;
  htmlSnapshotUrl: string | null;
  createdAt: string;
}

/**
 * Response from `GET /api/cli/v1/runs/{runId}`.
 */
export interface RunResponse {
  runId: string;
  testId: string;
  projectId: string;
  userId: string;
  status: RunStatus;
  source: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /**
   * Code version stamped at trigger time. `null` on pre-M3.1 rows and on
   * runs whose test has no stored code body (e.g. a plan-driven frontend
   * test), per the server contract (`RunEnvelope.codeVersion` is
   * `[string, 'null']`).
   */
  codeVersion: string | null;
  /**
   * Target URL stamped at trigger time. `null` for backend runs and for any
   * run whose execution backend does not record one, per the server contract
   * (`RunEnvelope.targetUrl` is `[string, 'null']`).
   */
  targetUrl: string | null;
  createdFrom: string | null;
  failedStepIndex: number | null;
  failureKind: string | null;
  /** Raw error text for failed/blocked runs. Matches `GetRunResponseDto.error`. */
  error: string | null;
  videoUrl: string | null;
  stepSummary: RunStepSummary;
  /** Optional hint from the server; honored by the polling loop. */
  retryAfterSeconds?: number;
  /**
   * Portal deep link for this run's test.
   *
   * **Server-provided when present, client-synthesized otherwise.** Newer
   * backends send this field on `GET /runs/{runId}` because only the server
   * knows which store answered the read (a V3-served run's page is a different
   * route family, and the V2 route it replaces cannot render for a V3-native
   * project) and only the server can resolve the portal origin outside prod.
   *
   * A server `null` means "no correct link exists for this run" — the CLI
   * treats it as absent for rendering and does NOT substitute its own guess.
   * A missing field (older backend) reopens the client path: `resolvePortalUrl`
   * from projectId+testId when the endpoint maps to a known portal host. See
   * `withRunDashboardUrl` in `commands/test.ts`.
   */
  dashboardUrl?: string | null;
  /**
   * Full ordered step list. Only present when the request includes
   * `?includeSteps=true`. Absent (undefined) when the flag was not sent.
   * Null means the server returned the field explicitly as null (treated
   * the same as absent for rendering purposes).
   *
   * Per M3.4 piece-4: default (absent/false) is byte-identical to the M3.3
   * summary shape — the cheap `test wait` polling path is unaffected.
   */
  steps?: RunStepDto[] | null;
}

// ---------------------------------------------------------------------------
// DEV-331 piece 3 — cancel wire types
// ---------------------------------------------------------------------------

/**
 * Response from `POST /api/cli/v1/runs/{runId}/cancel`.
 * Same shape as `GET /runs/{runId}` (`status: "cancelled"`, verdict
 * untouched) plus `alreadyCancelled` distinguishing a fresh cancel
 * (naturally idempotent) from a no-op re-cancel.
 */
export interface CancelRunResponse extends RunResponse {
  alreadyCancelled: boolean;
}

/** Terminal states from the RunStatus union. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'passed',
  'failed',
  'blocked',
  'cancelled',
]);

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// M3.4 piece-5 — run-history wire types
// ---------------------------------------------------------------------------

/**
 * Valid trigger source values for filtering run history.
 * "cli-rerun" is NOT a valid source — reruns have source="cli" and
 * createdFrom starting with "rerun:" (surfaced as `isRerun: true`).
 */
export type RunSource = 'cli' | 'portal' | 'mcp' | 'schedule' | 'github_action';

/** The valid RUN_SOURCES values as an array for CLI flag validation. */
export const RUN_SOURCES: ReadonlyArray<RunSource> = [
  'cli',
  'portal',
  'mcp',
  'schedule',
  'github_action',
];

/**
 * One row in a `GET /api/cli/v1/tests/{testId}/runs` response.
 *
 * `isRerun` is a derived field: `createdFrom?.startsWith('rerun:')` on the
 * backend. Reruns always have `source: 'cli'`; the `isRerun` flag + the
 * `createdFrom` lineage string together identify them.
 */
export interface RunHistoryItem {
  runId: string;
  status: RunStatus;
  source: RunSource;
  /** Derived by backend: true when `createdFrom` starts with "rerun:". */
  isRerun: boolean;
  /** Lineage pointer; `null` for fresh runs. For reruns: `"rerun:<priorRunId>"`. */
  createdFrom: string | null;
  createdAt: string;
  /** May be null — backend doesn't always stamp it. */
  startedAt: string | null;
  finishedAt: string | null;
  /** May be null — not stamped on pre-M3.2 rows or on tests with no code body. */
  codeVersion: string | null;
  /** Null when the run passed. */
  failureKind: string | null;
  /**
   * G1b — the resolved target URL for this specific run. `null` when the
   * backend could not determine the URL (pre-G1b rows, or `targetUrlSource`
   * is `'unresolved'`). Optional on the wire for back-compat with older
   * backends that don't ship the field.
   */
  targetUrl?: string | null;
  /**
   * G1b — provenance of `targetUrl`.
   * - `'run'`: stamped at run-trigger time (authoritative).
   * - `'unresolved'`: backend could not resolve a URL for this run.
   * - `null` / absent: pre-G1b backend; treat as unknown.
   */
  targetUrlSource?: 'run' | 'unresolved' | null;
}

/**
 * Pre-cutover metadata block present when the test has no CLI-tracked
 * history (created before 2026-05-14).
 */
export interface RunHistoryMeta {
  testKind?: 'frontend' | 'backend';
  /**
   * ISO date the history window starts at.
   * Present on pre-cutover responses (when `runs` is empty because no
   * TestRun rows exist for this test).
   */
  historyStartsAt?: string;
  /**
   * Human-readable note from the backend.
   * Rendered in CLI text mode instead of a blank table for pre-cutover tests.
   */
  note?: string;
  /** Portal URL where older run history can be viewed. */
  portalUrl?: string;
}

/**
 * Response from `GET /api/cli/v1/tests/{testId}/runs`.
 *
 * Pre-cutover shape: `runs: []`, `nextCursor: null`, `meta` has
 * `historyStartsAt` + `note` + `portalUrl`.
 */
export interface ListRunsResponse {
  runs: RunHistoryItem[];
  /** Opaque cursor for the next page; `null` when no more pages. */
  nextCursor: string | null;
  meta: RunHistoryMeta;
}

/** Query parameters for `GET /api/cli/v1/tests/{testId}/runs`. */
export interface ListRunsQuery {
  cursor?: string;
  pageSize?: number;
  source?: RunSource;
  /** ISO timestamp (after client-side duration parsing). */
  since?: string;
}

// ---------------------------------------------------------------------------
// M4 piece-2 — batch fresh-run wire types (POST /tests/batch/run)
// ---------------------------------------------------------------------------

/**
 * Body sent to `POST /api/cli/v1/tests/batch/run`.
 * BE-only engine — FE tests in the set are skipped server-side (advisory only).
 * `testIds` absent / empty → run ALL BE tests in the project.
 */
export interface BatchRunFreshRequest {
  projectId: string;
  testIds?: string[];
  source: 'cli';
}

/** One accepted run in the batch fresh-run response. */
export interface BatchRunFreshAccepted {
  testId: string;
  /**
   * runId minted synchronously by `claimRunSlotOrThrow`. The backend partitions
   * any member whose slot-claim failed into `conflicts[]`, so every entry that
   * lands in `accepted[]` always carries a real runId (never undefined). The CLI
   * polls each one under `--wait`.
   */
  runId: string;
  enqueuedAt: string;
  /**
   * CLIENT-synthesized Portal deep link — never sent by the server. Added by
   * `test run --all` (projectId from the request, testId per item) when the
   * API endpoint maps to a known portal host.
   */
  dashboardUrl?: string;
}

/**
 * Response from `POST /api/cli/v1/tests/batch/run`.
 * `accepted` carries per-test runIds. `conflicts`/`deferred`/`skippedFrontend`/
 * `skippedIntegration` enumerate everything NOT dispatched, so a JSON consumer
 * reading `accepted` alone can never silently undercount.
 *   - `conflicts`        — BE test already executing (slot-claim conflict)
 *   - `deferred`         — per-key run budget exhausted this window; retry later
 *   - `skippedFrontend`  — FE tests in the set (BE-only wave engine)
 *   - `skippedIntegration` — assembled integration tests (run via the portal)
 */
export interface BatchRunFreshResponse {
  accepted: BatchRunFreshAccepted[];
  /**
   * A run-slot conflict. `currentRunId`, when present, is the id of the run
   * ALREADY in flight for this test — under `--wait` the CLI polls it to a
   * verdict (auto-resume) instead of failing the batch. Absent ⇒ a hard
   * conflict with no resolvable in-flight run (still fails the batch).
   */
  conflicts: RunConflict[];
  deferred: Array<{ testId: string }>;
  skippedFrontend: string[];
  skippedIntegration: Array<{ testId: string }>;
}
