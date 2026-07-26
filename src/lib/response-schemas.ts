/**
 * Valibot schemas for the run-path wire shapes (issue #102).
 *
 * `requestWithMeta` used to return `(await response.json()) as T` with zero
 * runtime validation, so a drifted or partial server response surfaced as
 * `undefined` output or an opaque TypeError deep inside a command. These
 * schemas are wired (opt-in, via `RequestOptions.schema`) into the typed
 * HttpClient helpers only: `triggerRun`, `triggerRunWithMeta`, `triggerRerun`,
 * `triggerBatchRerun`, `triggerBatchRunFresh`, `getRun`, `listTestRuns`.
 * The generic `get`/`post`/`put`/`patch`/`delete` paths stay schema-free.
 *
 * Resilience rules (additive server changes must never hard-fail the CLI):
 *
 * 1. Every object is `v.looseObject`: unknown extra keys pass validation AND
 *    are preserved in the output, so a new server field still reaches
 *    `--output json` consumers untouched.
 * 2. Enum-ish string fields (`status`, `source`, `role`, step `type`, ...) are
 *    validated as open strings via {@link openWireLiteral}: the CLI already
 *    treats unknown values as open (e.g. `isTerminalStatus` returns false and
 *    the poll continues; renderers print the raw value), so a new server enum
 *    member must degrade gracefully, never reject the whole response.
 * 3. REQUIRED-nullable interface fields use `v.nullish(inner, null)`: the wire
 *    may omit a nullable field entirely (real fixture evidence: the chained
 *    `test create --run` poll bodies in `test.test.ts` omit `error`), and
 *    every consumer already null-checks these, so absence normalizes to
 *    `null` instead of failing. OPTIONAL interface fields (`?`) use
 *    `v.optional` with NO default so presence/absence semantics that commands
 *    branch on (e.g. `RerunResponse.closure`, `RunResponse.steps`) survive
 *    validation byte-identically.
 *
 * Each schema is annotated `v.GenericSchema<unknown, T>` against the
 * interface it mirrors, so schema/interface drift fails `tsc` in this file.
 */
import * as v from 'valibot';
import type {
  BatchRerunResponse,
  BatchRunFreshResponse,
  ListRunsResponse,
  RerunClosure,
  RerunResponse,
  RunResponse,
  RunSource,
  RunStatus,
  TriggerRunResponse,
} from './runs.types.js';

/**
 * Compile-time literal union, runtime open string.
 *
 * Keeps `InferOutput` aligned with the union declared in `runs.types.ts`
 * while accepting any string on the wire, per resilience rule 2 above.
 * `v.custom` is valibot's documented escape hatch for exactly this
 * "caller-asserted type, custom runtime check" pattern.
 */
function openWireLiteral<TLiteral extends string>(): v.GenericSchema<unknown, TLiteral> {
  return v.custom<TLiteral>(value => typeof value === 'string');
}

// ---------------------------------------------------------------------------
// GET /runs/{runId}
// ---------------------------------------------------------------------------

/** Mirrors `RunStepSummary` (runs.types.ts): per-run step counters. */
const RUN_STEP_SUMMARY_SCHEMA = v.looseObject({
  total: v.number(),
  completed: v.number(),
  passedCount: v.number(),
  failedCount: v.number(),
});

/** Mirrors `RunStepDto` (runs.types.ts): one `?includeSteps=true` step row. */
const RUN_STEP_DTO_SCHEMA = v.looseObject({
  stepIndex: v.string(),
  type: openWireLiteral<'action' | 'assertion'>(),
  action: v.string(),
  status: v.nullish(openWireLiteral<'passed' | 'failed'>(), null),
  description: v.nullish(v.string(), null),
  error: v.nullish(v.string(), null),
  screenshotUrl: v.nullish(v.string(), null),
  htmlSnapshotUrl: v.nullish(v.string(), null),
  createdAt: v.string(),
});

/** Mirrors `RunResponse` (runs.types.ts): `GET /api/cli/v1/runs/{runId}`. */
export const RUN_RESPONSE_SCHEMA: v.GenericSchema<unknown, RunResponse> = v.looseObject({
  runId: v.string(),
  testId: v.string(),
  projectId: v.string(),
  userId: v.string(),
  status: openWireLiteral<RunStatus>(),
  source: v.string(),
  createdAt: v.string(),
  startedAt: v.nullish(v.string(), null),
  finishedAt: v.nullish(v.string(), null),
  codeVersion: v.string(),
  targetUrl: v.string(),
  createdFrom: v.nullish(v.string(), null),
  failedStepIndex: v.nullish(v.number(), null),
  failureKind: v.nullish(v.string(), null),
  // Loosened per fixture evidence (rule 3): several real poll bodies omit
  // `error` entirely; consumers render it only when non-null.
  error: v.nullish(v.string(), null),
  videoUrl: v.nullish(v.string(), null),
  stepSummary: RUN_STEP_SUMMARY_SCHEMA,
  retryAfterSeconds: v.optional(v.number()),
  // Client-synthesized Portal link (never sent by the server); tolerated so a
  // future server echo cannot fail validation.
  dashboardUrl: v.optional(v.string()),
  // Absence means "steps not requested" and drives command branching, so no
  // default is applied (rule 3, optional branch).
  steps: v.optional(v.nullable(v.array(RUN_STEP_DTO_SCHEMA))),
});

// ---------------------------------------------------------------------------
// POST /tests/{testId}/runs
// ---------------------------------------------------------------------------

/** Mirrors `TriggerRunResponse` (runs.types.ts): `POST /tests/{testId}/runs`. */
export const TRIGGER_RUN_RESPONSE_SCHEMA: v.GenericSchema<unknown, TriggerRunResponse> =
  v.looseObject({
    runId: v.string(),
    status: openWireLiteral<'queued'>(),
    enqueuedAt: v.string(),
    codeVersion: v.string(),
    targetUrl: v.string(),
  });

// ---------------------------------------------------------------------------
// POST /tests/{testId}/runs/rerun
// ---------------------------------------------------------------------------

/** Mirrors `RerunClosureMember` (runs.types.ts): one BE closure member. */
const RERUN_CLOSURE_MEMBER_SCHEMA = v.looseObject({
  testId: v.string(),
  runId: v.string(),
  role: openWireLiteral<'selected' | 'producer' | 'teardown'>(),
});

/** Mirrors `RerunClosure` (runs.types.ts): BE closure breakdown. */
const RERUN_CLOSURE_SCHEMA: v.GenericSchema<unknown, RerunClosure> = v.looseObject({
  members: v.array(RERUN_CLOSURE_MEMBER_SCHEMA),
  addedProducers: v.array(v.string()),
  addedTeardowns: v.array(v.string()),
  clearedCaptured: v.number(),
});

/** Mirrors `RerunResponse` (runs.types.ts): `POST /tests/{testId}/runs/rerun`. */
export const RERUN_RESPONSE_SCHEMA: v.GenericSchema<unknown, RerunResponse> = v.looseObject({
  runId: v.string(),
  status: openWireLiteral<'queued'>(),
  enqueuedAt: v.string(),
  codeVersion: v.string(),
  autoHeal: v.boolean(),
  // FE reruns omit `closure`; the CLI's `!!closure` truthy check relies on
  // absent staying absent, so optional with no default (rule 3).
  closure: v.optional(v.nullable(RERUN_CLOSURE_SCHEMA)),
});

// ---------------------------------------------------------------------------
// POST /tests/batch/rerun
// ---------------------------------------------------------------------------

/** Mirrors `BatchRerunResponse` (runs.types.ts): `POST /tests/batch/rerun`. */
export const BATCH_RERUN_RESPONSE_SCHEMA: v.GenericSchema<unknown, BatchRerunResponse> =
  v.looseObject({
    // Mirrors BatchRerunAccepted (runs.types.ts).
    accepted: v.array(
      v.looseObject({ testId: v.string(), runId: v.string(), enqueuedAt: v.string() }),
    ),
    // Mirrors BatchRerunDeferred (runs.types.ts).
    deferred: v.array(v.looseObject({ testId: v.string(), reason: v.string() })),
    // Mirrors BatchRerunConflict (runs.types.ts).
    conflicts: v.array(v.looseObject({ testId: v.string(), currentRunId: v.string() })),
    // Mirrors BatchRerunClosure / BatchRerunClosureByProject (runs.types.ts).
    closure: v.looseObject({
      byProject: v.array(
        v.looseObject({
          projectId: v.string(),
          testIds: v.array(v.string()),
          addedProducers: v.array(v.string()),
          addedTeardowns: v.array(v.string()),
          clearedCaptured: v.number(),
        }),
      ),
    }),
    // Optional on the wire for back-compat with older backends (D2-CLI).
    notFound: v.optional(v.array(v.string())),
  });

// ---------------------------------------------------------------------------
// POST /tests/batch/run
// ---------------------------------------------------------------------------

/** Mirrors `BatchRunFreshResponse` (runs.types.ts): `POST /tests/batch/run`. */
export const BATCH_RUN_FRESH_RESPONSE_SCHEMA: v.GenericSchema<unknown, BatchRunFreshResponse> =
  v.looseObject({
    // Mirrors BatchRunFreshAccepted (runs.types.ts); dashboardUrl is
    // client-synthesized, tolerated as optional.
    accepted: v.array(
      v.looseObject({
        testId: v.string(),
        runId: v.string(),
        enqueuedAt: v.string(),
        dashboardUrl: v.optional(v.string()),
      }),
    ),
    conflicts: v.array(v.looseObject({ testId: v.string() })),
    deferred: v.array(v.looseObject({ testId: v.string() })),
    skippedFrontend: v.array(v.string()),
    skippedIntegration: v.array(v.looseObject({ testId: v.string() })),
  });

// ---------------------------------------------------------------------------
// GET /tests/{testId}/runs
// ---------------------------------------------------------------------------

/** Mirrors `RunHistoryItem` (runs.types.ts): one run-history row. */
const RUN_HISTORY_ITEM_SCHEMA = v.looseObject({
  runId: v.string(),
  status: openWireLiteral<RunStatus>(),
  source: openWireLiteral<RunSource>(),
  isRerun: v.boolean(),
  createdFrom: v.nullish(v.string(), null),
  createdAt: v.string(),
  startedAt: v.nullish(v.string(), null),
  finishedAt: v.nullish(v.string(), null),
  codeVersion: v.string(),
  failureKind: v.nullish(v.string(), null),
  // G1b fields: optional on the wire for back-compat with older backends.
  targetUrl: v.optional(v.nullable(v.string())),
  targetUrlSource: v.optional(v.nullable(openWireLiteral<'run' | 'unresolved'>())),
});

/** Mirrors `ListRunsResponse` (runs.types.ts): `GET /tests/{testId}/runs`. */
export const LIST_RUNS_RESPONSE_SCHEMA: v.GenericSchema<unknown, ListRunsResponse> = v.looseObject({
  runs: v.array(RUN_HISTORY_ITEM_SCHEMA),
  nextCursor: v.nullish(v.string(), null),
  // Mirrors RunHistoryMeta (runs.types.ts): every field optional, and the
  // history command reads `resp.meta.note` / `resp.meta.portalUrl` directly,
  // so the container itself stays required like the interface declares.
  meta: v.looseObject({
    testKind: v.optional(openWireLiteral<'frontend' | 'backend'>()),
    historyStartsAt: v.optional(v.string()),
    note: v.optional(v.string()),
    portalUrl: v.optional(v.string()),
  }),
});

// ---------------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------------

/**
 * Minimal `/me` identity core shared by its consumers. `doctor` reads a
 * two-field optional projection (`MeIdentity` in commands/doctor.ts) while
 * `auth whoami` reads the full `MeResponse` (commands/auth.ts); this schema
 * validates the common identity core so it can guard either caller, and
 * `looseObject` lets the full projection (scopes, env, email, ...) pass
 * through untouched. Not wired into any typed helper yet: `/me` callers use
 * the generic `get`, which stays schema-free in this change.
 */
export interface MeIdentityWire {
  userId?: string;
  keyId?: string;
}

/** Mirrors `MeIdentity` (commands/doctor.ts): `GET /api/cli/v1/me` core. */
export const ME_IDENTITY_SCHEMA: v.GenericSchema<unknown, MeIdentityWire> = v.looseObject({
  userId: v.optional(v.string()),
  keyId: v.optional(v.string()),
});
