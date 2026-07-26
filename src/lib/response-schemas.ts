/**
 * Valibot schemas for the API wire shapes (issue #102, extended by #277).
 *
 * `requestWithMeta` used to return `(await response.json()) as T` with zero
 * runtime validation, so a drifted or partial server response surfaced as
 * `undefined` output or an opaque TypeError deep inside a command. These
 * schemas are wired (opt-in, via `RequestOptions.schema`) into the typed
 * HttpClient helpers `triggerRun`, `triggerRunWithMeta`, `triggerRerun`,
 * `triggerBatchRerun`, `triggerBatchRunFresh`, `getRun`, `listTestRuns`, and
 * — for the account surfaces below — at the `client.get` call sites that own
 * a `/me` or usage read. Every other generic `get`/`post`/`put`/`patch`/
 * `delete` caller stays schema-free and opt-in.
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
// Type-only imports: erased at compile time, so pulling a command's wire
// interface into `lib/` adds no runtime edge (same pattern as `bundle.ts`,
// which type-imports `CliTestStep` from `commands/test.ts`).
import type { MeResponse } from '../commands/auth.js';
import type { UsageResponse } from '../commands/usage.js';
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

/** Deployment environment the bound key belongs to; open on the wire (rule 2). */
type AccountEnv = 'development' | 'staging' | 'production';

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
 * Minimal `/me` identity core, as read by `doctor`'s connectivity check.
 *
 * `doctor` deliberately treats every field as optional: the check only needs
 * "the key was accepted", and it decorates the detail line with the userId
 * *when present* (`me.userId ? ...`). Fixture evidence for keeping it fully
 * optional rather than reusing {@link ME_RESPONSE_SCHEMA}: `OK_ME` in
 * `commands/doctor.test.ts` is `{ userId, keyId }` with no `scopes`/`env`, and
 * a connectivity probe must not fail on a partial identity projection.
 *
 * `commands/doctor.ts` aliases its `MeIdentity` to this type so the two cannot
 * drift (they already had: `v3Enabled` existed on the command side only).
 */
export interface MeIdentityWire {
  userId?: string;
  keyId?: string;
  /** Authoritative per-user V3 routing bit; older backends omit it. */
  v3Enabled?: boolean;
}

/** Mirrors `MeIdentity` (commands/doctor.ts): `GET /api/cli/v1/me` core. */
export const ME_IDENTITY_SCHEMA: v.GenericSchema<unknown, MeIdentityWire> = v.looseObject({
  userId: v.optional(v.string()),
  keyId: v.optional(v.string()),
  v3Enabled: v.optional(v.boolean()),
});

/**
 * Mirrors `MeResponse` (commands/auth.ts): the full `GET /me` projection read
 * by `auth whoami` (and, through it, `init`).
 *
 * `scopes` is required and array-typed on purpose — this is the shape drift
 * that actually bites today. `runWhoami` renders `m.scopes.join(', ')` and
 * computes `missingScopes` via `m.scopes.includes(...)` with no guard, so a
 * `/me` body without `scopes` crashes with a raw `TypeError` (exit 1) instead
 * of a typed envelope. Every `/me` fixture in the suite supplies it
 * (`auth.test.ts`, `init.test.ts`, `usage.test.ts`, `cli.subprocess.test.ts`,
 * `test/mock-backend/fixtures.ts`), so requiring it matches observed wire
 * reality; `email` / `displayName` / `v3Enabled` are the genuinely absent-safe
 * ones and stay `v.optional` with no default (rule 3, optional branch).
 *
 * `init` calls this through `runWhoami` inside a try/catch that falls back to
 * a placeholder identity, so a drifted `/me` degrades the setup summary
 * instead of failing the whole `init`.
 */
export const ME_RESPONSE_SCHEMA: v.GenericSchema<unknown, MeResponse> = v.looseObject({
  userId: v.string(),
  keyId: v.string(),
  scopes: v.array(v.string()),
  env: openWireLiteral<AccountEnv>(),
  email: v.optional(v.string()),
  displayName: v.optional(v.string()),
  v3Enabled: v.optional(v.boolean()),
});

// ---------------------------------------------------------------------------
// GET /me (usage projection)
// ---------------------------------------------------------------------------

/**
 * Mirrors `UsageResponse` (commands/usage.ts): the credits/plan projection the
 * `usage` command reads off the same `GET /me` body.
 *
 * `renderUsage` prints `userId`/`keyId`/`env` unconditionally as its "identity
 * block", so those three are required; `credits`, `subPlan` and
 * `creditsPerRun` are forward-compat fields the backend does not send today
 * (see the BACKEND FOLLOW-UP note in usage.ts) and every renderer branch is
 * gated on `!== undefined`, so they stay optional with no default. `scopes`
 * rides along as an unknown extra key and is preserved by `looseObject`.
 */
export const USAGE_RESPONSE_SCHEMA: v.GenericSchema<unknown, UsageResponse> = v.looseObject({
  userId: v.string(),
  keyId: v.string(),
  env: openWireLiteral<AccountEnv>(),
  credits: v.optional(v.number()),
  subPlan: v.optional(v.string()),
  creditsPerRun: v.optional(v.number()),
});
