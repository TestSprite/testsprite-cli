/**
 * Wire types for the run surfaces: `run`, `run wait`, `run cancel`,
 * `run --testlist` and `ci run`.
 */
import type { RunConflict } from './conflict-reason.js';

/** Literal body sent to `POST /api/cli/v1/tests/{testId}/runs`. */
export interface TriggerRunBody {
  /** Fixed source literal for CLI-triggered runs. */
  source: 'cli';
  /** Optional override for the project's configured target URL. */
  targetUrl?: string;
  /**
   * Id of a tunnel client minted through `POST /api/cli/v1/tunnel`.
   *
   * An ID, never a proxy string — the caller does not choose the proxy host.
   * The server loads the binding, checks it belongs to the calling principal
   * and that the tunnel is connected, and only then builds the proxy string
   * from its own configuration. Sent ONLY alongside a loopback `targetUrl`;
   * the server refuses the pairing in every other combination rather than
   * dropping the field.
   */
  tunnelClientId?: string;
  /**
   * The NAME of the project environment whose credentials, auto-auth and OTP
   * settings this run should use (`unique(project_id, name)` server side).
   * Absent → the project's default environment, exactly as before. Composes
   * with `targetUrl`/`tunnelClientId`: those pick WHERE the browser goes,
   * this picks WHOSE credentials it logs in with.
   */
  environment?: string;
  /**
   * BE only: run just the named test without expanding the producer/teardown
   * closure. Sent only when the caller asked for it (never `false`); an older
   * backend strips the field, so omitting it is the default on the wire.
   */
  skipDependencies?: boolean;
}

/** The environment a run resolved to — its credentials, its config, its address. */
export interface RunEnvironmentRef {
  /** `test_environment.id`; null when the row keeps only the denormalised name. */
  id: string | null;
  /** Environment name at seed time; null on an id-only row. */
  name: string | null;
}

/**
 * Response from `POST /api/cli/v1/tests/{testId}/runs`.
 * All fields are stamped at trigger time and cannot change for this resultId.
 */
export interface TriggerRunResponse {
  tunnelClientId?: string;
  resultId: string;
  /** The launch this result belongs to. Absent on an older backend. */
  runId?: string;
  status: 'queued';
  enqueuedAt: string;
  /**
   * The EFFECTIVE heal decision the server made for this run.
   *
   * OPTIONAL on purpose: a server that predates the field echoes nothing. The
   * CLI sends no request for it (the server decides per run; code a person
   * wrote is never re-authored), so the echo is informational.
   */
  autoHeal?: boolean;
  /** codeVersion resolved at trigger time from the test row. */
  codeVersion: string;
  /** Resolved target URL (project default when --target-url absent). */
  targetUrl: string;
  /**
   * The environment this run resolved to. Absent on an older backend; `null`
   * when the server resolved no environment row.
   */
  environment?: RunEnvironmentRef | null;
  /**
   * Portal deep link for the run's test, built by the server. Present-or-absent
   * (never null): an older backend, or a run with no resolvable workspace,
   * OMITS it, and the CLI prints nothing rather than guessing.
   */
  dashboardUrl?: string;
  /**
   * Portal deep link to THIS run's result page. Same present-or-absent contract.
   */
  executionUrl?: string;
  /**
   * `true` exactly when the request carried `skipDependencies: true` and this
   * backend handled it; otherwise OMITTED. A CLI that sent the flag and gets no
   * echo was served by a backend that stripped it and ran the full closure.
   */
  skipDependencies?: boolean;
}

/**
 * Public run-status values.
 * `queued` and `running` are non-terminal; the rest are terminal.
 */
export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'blocked' | 'cancelled';

/**
 * Lightweight step summary returned inside `GET /api/cli/v1/runs/{resultId}`.
 * Full step records come from `GET /api/cli/v1/results/{resultId}` (`result get`).
 */
export interface RunStepSummary {
  total: number;
  completed: number;
  passedCount: number;
  failedCount: number;
}

/**
 * Response from `GET /api/cli/v1/runs/{resultId}`.
 */
export interface RunResponse {
  resultId: string;
  /** The launch this result belongs to. Absent on an older backend. */
  runId?: string;
  testId: string;
  /**
   * The test's human title, for CI output. `null`/absent on older servers or
   * when it can't be resolved — consumers fall back to `testId`.
   */
  testTitle?: string | null;
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
  /**
   * The environment this run resolved to. Absent on an older backend; `null`
   * when the row names no environment.
   */
  environment?: RunEnvironmentRef | null;
  createdFrom: string | null;
  failedStepIndex: number | null;
  failureKind: string | null;
  /** Raw error text for failed/blocked runs. Matches `GetRunResponseDto.error`. */
  error: string | null;
  videoUrl: string | null;
  stepSummary: RunStepSummary;
  /**
   * How the stored code was routed. `path: 'refused'` means the run was
   * blocked before dispatch because the stored code could not be replayed;
   * `reason` names why. Absent on older backends.
   */
  replay?: { path: string; reason?: string | null; caveat?: string | null };
  /** Optional hint from the server; honored by the polling loop. */
  retryAfterSeconds?: number;
  /**
   * Portal deep link for this run's test. **Server-built only**: the server
   * alone knows the workspace that owns the project and the portal origin
   * outside prod, so the CLI never builds one itself.
   *
   * A server `null` means "no correct link exists for this run" — the CLI
   * treats it like an absent field and prints nothing. See
   * `withRunDashboardUrl` in `commands/test.ts`.
   */
  dashboardUrl?: string | null;
  /**
   * Portal deep link to this result's own page, the companion to
   * `dashboardUrl` (which opens the test case). Same server-built /
   * omit-not-null contract as `dashboardUrl`; when it is absent the job
   * summary's Result cell shows the bare result id, and an annotation links
   * the test case instead.
   */
  executionUrl?: string | null;
}

// ---------------------------------------------------------------------------
// Cancel wire types
// ---------------------------------------------------------------------------

/** Credit outcome returned when cancellation applies frontend billing rules. */
export interface CancelRunRefund {
  status: 'refunded' | 'not_charged' | 'failed';
  /** Original charged amount returned to the workspace. Present when refunded. */
  amount?: number;
}

/**
 * Response from `POST /api/cli/v1/runs/{resultId}/cancel`.
 * Same shape as `GET /runs/{resultId}` (`status: "cancelled"`, verdict
 * untouched) plus `alreadyCancelled` distinguishing a fresh cancel
 * (naturally idempotent) from a no-op re-cancel.
 */
export interface CancelRunResult {
  resultId: string;
  runId: string | null;
  testId: string | null;
  title: string;
  status: RunStatus;
  alreadyCancelled: boolean;
  alreadyFinished: boolean;
  refund?: CancelRunRefund;
}

export interface CancelRunResponse {
  runId: string;
  alreadyCancelled: boolean;
  alreadyFinished: boolean;
  results: CancelRunResult[];
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
// M4 piece-2 — batch fresh-run wire types (POST /tests/batch/run)
// ---------------------------------------------------------------------------

/**
 * Body sent to `POST /api/cli/v1/tests/batch/run`.
 * BE-only engine — FE tests in the set are skipped server-side (advisory only).
 * `testIds` absent / empty → run ALL BE tests in the project.
 */
/**
 * Where a `ci run` came from on GitHub, read off the Actions event. Stamped on
 * the execution so the Portal can link the run back to its pull request.
 */
export interface CiGithubTrigger {
  repoOwner: string;
  repoName: string;
  branchName?: string;
  /** 40-hex commit the preview was built from. */
  commitSha?: string;
  prNumber: number;
}

export interface BatchRunFreshRequest {
  projectId: string;
  testIds?: string[];
  source: 'cli';
  /** See `TriggerRunBody.environment` — applied to every test in the batch. */
  environment?: string;
  /** See `TriggerRunBody.skipDependencies` — applies to every BE test in the batch. */
  skipDependencies?: boolean;
  /** Per-run URL override for the batch; echoed when the backend honors it. */
  targetUrl?: string;
  /** See `TriggerRunBody.tunnelClientId`; carries every test of the request. Echoed when used. */
  tunnelClientId?: string;
  /**
   * The most frontend tests of each run this request starts that execute at
   * once (the server also caps a tunnelled run). Echoed with the cap it
   * applied when a frontend run was started.
   */
  maxConcurrency?: number;
  /**
   * `'all'`: the server seeds every selected case into one execution and
   * paces dispatch itself (as for a GitHub App run) instead of cutting the
   * selection to the per-key budget and returning the rest as `deferred`.
   * Default `'budget'` is today's behaviour. Echoed when honored.
   */
  admission?: 'budget' | 'all';
  /** `github-pr-<N>`: run in a temporary clone of `environment` at `targetUrl`. Echoed when honored. */
  previewName?: string;
  githubTrigger?: CiGithubTrigger;
}

/** Strict body of POST /projects/:projectId/runs. Pacing belongs to the server. */
export interface ProjectRunRequest {
  testIds?: string[];
  environment?: string;
  targetUrl?: string;
  tunnelClientId?: string;
  skipDependencies?: boolean;
  maxConcurrency?: number;
  admission?: 'all';
  previewName?: string;
  githubTrigger?: CiGithubTrigger;
}

/** One project launch. Result identities are read from GET /results?run=. */
export interface ProjectRunResponse {
  runId: string;
  projectId: string;
  enqueuedAt: string;
  total: number;
  autoHeal: boolean;
  maxConcurrency?: number;
  environment: RunEnvironmentRef | null;
  targetUrl: string | null;
  tunnelClientId?: string;
  dashboardUrl?: string;
  blocked: Array<{ testId: string; resultId: string; reason: string; message?: string }>;
  held: Array<{ testId: string; runId: string; resultId: string }>;
}

/** One accepted run in the batch fresh-run response. */
export interface BatchRunFreshAccepted {
  /**
   * The `test_execution.id` this run was dispatched under (absent on an
   * older backend). One execution usually covers the whole batch — `ci run`
   * de-duplicates it to read the execution report.
   */
  runId?: string;
  testId: string;
  /**
   * resultId minted synchronously by `claimRunSlotOrThrow`. The backend partitions
   * any member whose slot-claim failed into `conflicts[]`, so every entry that
   * lands in `accepted[]` always carries a real resultId (never undefined). The CLI
   * polls each one under `--wait`.
   */
  resultId: string;
  enqueuedAt: string;
}

/**
 * Response from `POST /api/cli/v1/tests/batch/run`.
 * `accepted` carries per-test runIds. `conflicts`/`deferred` enumerate
 * everything NOT dispatched, so a JSON consumer reading `accepted` alone can
 * never silently undercount.
 *   - `conflicts`        — test already executing (slot-claim conflict)
 *   - `deferred`         — per-key run budget exhausted this window; retry later
 *   - `skippedFrontend` / `skippedIntegration` — always empty (every case
 *     runs); kept on the wire, and in the CLI's JSON, for older consumers.
 */
export interface BatchRunFreshResponse {
  accepted: BatchRunFreshAccepted[];
  /** See `TriggerRunResponse.autoHeal`; absence means the same thing. */
  autoHeal?: boolean;
  /**
   * A run-slot conflict. `currentResultId`, when present, is the id of the run
   * ALREADY in flight for this test — under `--wait` the CLI polls it to a
   * verdict (auto-resume) instead of failing the batch. Absent ⇒ a hard
   * conflict with no resolvable in-flight run (still fails the batch).
   */
  conflicts: RunConflict[];
  deferred: Array<{ testId: string }>;
  skippedFrontend: string[];
  skippedIntegration: Array<{ testId: string }>;
  /**
   * Backend projects only: the integration phase that follows the wave.
   * `existing` integration tests run after it (0.2 credits each);
   * `mayGenerate` means a first run may also generate new ones. Absent on
   * older backends and for frontend projects.
   */
  integration?: { existing: number; runsAfterWave: boolean; mayGenerate: boolean };
  /**
   * Project-level portal link the batch closes with ("watch it here"),
   * server-built: a string ⇒ print it verbatim; `null` or absent ⇒ no correct
   * page exists (several sibling projects, no owning org, or an older
   * backend) — print nothing rather than a dead link.
   */
  dashboardUrl?: string | null;
  /**
   * Exact echo of the request's `targetUrl` when the backend read the override.
   * A missing or different echo makes the CLI refuse the batch rather than
   * report a verdict for an unconfirmed target.
   */
  targetUrl?: string;
  /** Echoes, same contract as `targetUrl`: absent means this backend never read the field. */
  admission?: 'budget' | 'all';
  previewName?: string;
  /** See `TriggerRunResponse.skipDependencies`; same present-or-omitted contract. */
  skipDependencies?: boolean;
  /** The request's tunnel, echoed once a test was started through it. */
  tunnelClientId?: string;
  /**
   * The cap the server applied to each run it started (the highest when the
   * request spans projects), echoed when the request sent `maxConcurrency`
   * and a frontend run was started.
   */
  maxConcurrency?: number;
}

// ─── Execution report (GET /tests/executions/{runId}/report) ───────────

/** One row of an execution report — one `test_result` of that execution. */
export interface ExecutionReportTest {
  /** The `test_result.id` (the CLI's run id). */
  id: string;
  title: string;
  /** Display id of the case (e.g. `AUTH-002`); null when unresolved. */
  slug: string | null;
  status: 'PASSED' | 'FAILED' | 'BLOCKED' | (string & {});
  /** Presigned PNG of a step snapshot; null when unavailable. */
  screenshotUrl: string | null;
  /** Raw failure text; set for FAILED rows. */
  error: string | null;
  /** Suggested fix prompt; set for FAILED rows. */
  fix: string | null;
  /** This result's own Portal page (`…/execution/{eid}/test/{rid}`). */
  resultUrl?: string;
}

/**
 * The execution report the GitHub App posts as its PR comment — the server's
 * content model, returned verbatim so a later CI step can shape it itself.
 */
export interface ExecutionReport {
  projectId: string;
  runId: string;
  projectName: string;
  orgId: string | null;
  stats: { passed: number; failed: number; blocked: number; total: number };
  allPassed: boolean;
  /** Narrative run summary from the analyze pass; null when unavailable. */
  narrative: string | null;
  whatCouldBeBetter: string | null;
  recommendedNextStep: string | null;
  /** Ordered failed → blocked → passed. */
  tests: ExecutionReportTest[];
  /** The execution's Portal page. */
  resultUrl: string;
}

/**
 * `ready: false` means the execution is still running or its report is still
 * being built (the build waits for the analyze pass); poll again after
 * `retryAfterSeconds`. `report` and `markdown` are present only when ready.
 */
export interface ExecutionReportResponse {
  ready: boolean;
  retryAfterSeconds?: number;
  report?: ExecutionReport;
  /** The report rendered as GitHub-flavoured Markdown — the PR comment body. */
  markdown?: string;
}
