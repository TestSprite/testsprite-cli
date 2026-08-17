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
  RerunAdvisory,
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
  // Both are nullable on the wire (`RunEnvelope` declares
  // `[string, 'null']`): `codeVersion` is null on pre-M3.1 rows and on tests
  // with no stored code body, `targetUrl` is null for backend runs and for
  // execution backends that record no URL. Renderers already omit the line
  // when either is null (rule 3).
  codeVersion: v.nullish(v.string(), null),
  targetUrl: v.nullish(v.string(), null),
  createdFrom: v.nullish(v.string(), null),
  failedStepIndex: v.nullish(v.number(), null),
  failureKind: v.nullish(v.string(), null),
  // Loosened per fixture evidence (rule 3): several real poll bodies omit
  // `error` entirely; consumers render it only when non-null.
  error: v.nullish(v.string(), null),
  videoUrl: v.nullish(v.string(), null),
  stepSummary: RUN_STEP_SUMMARY_SCHEMA,
  retryAfterSeconds: v.optional(v.number()),
  // Portal link. Three-state wire contract (pinned): **absent** — an older
  // backend that predates this field, and cannot have produced a V3-native/
  // unmirrored entity either (that capability and this field ship together)
  // — the CLI computes its own legacy V2-shaped link. **Present + string** —
  // the backend built a correct link (it alone knows which store answered
  // and this environment's portal origin) — use it verbatim. **Present +
  // `null`** — the backend deliberately has no correct link to offer (e.g. a
  // V3-native entity with no DynamoDB mirror row for the client's V2-shaped
  // guess to land on) — suppress the link entirely; a client-side guess here
  // would be exactly the dead link the server declined to emit. The backend
  // always includes the key going forward (typed `string | null`, never
  // omitted when it has an opinion) — an earlier revision of this comment
  // described the backend as omitting the key on "no correct link", which
  // was the actual production defect this contract closes: the client's
  // absent-branch fallback was firing on real V3-native no-link responses
  // and printing the dead legacy URL this whole feature exists to remove.
  //
  // The `undefined` default (NOT `null`, unlike every field above) is load-bearing
  // and measured: valibot applies a default only when the key is absent, and
  // skips the assignment entirely when that default is `undefined` — so an
  // omitted field stays an ABSENT key, which is exactly what
  // `withRunDashboardUrl`'s `'dashboardUrl' in run` test (via the shared
  // `resolveDashboardUrl` helper) reads to decide "old backend, compute the
  // link myself". Aligning this with the `nullish(..., null)` fields above
  // would materialize the key on every response and silently kill that
  // fallback. A wire `null` is preserved as null here (nullable passes it
  // through untouched) and normalized at the consumer, not in the schema.
  // Locked by tests in response-schemas.test.ts.
  dashboardUrl: v.nullish(v.string(), undefined),
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

/**
 * Mirrors `RerunAdvisory` (runs.types.ts): a server-side note that a
 * requested option was forwarded to the execution engine but is not yet
 * honored there. Present only on a V3-routed rerun that explicitly opted
 * out of auto-heal — absent everywhere else, so this schema is only ever
 * used inside an `v.optional(v.array(...))` wrapper.
 */
const RERUN_ADVISORY_SCHEMA: v.GenericSchema<unknown, RerunAdvisory> = v.looseObject({
  feature: v.string(),
  message: v.string(),
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
  // Absent on every response except a V3-routed rerun with an explicit
  // autoHeal:false opt-out (rule 3: optional, no default, so presence/absence
  // survives validation byte-identically). Older backends that predate the
  // field simply omit it — never fails validation.
  advisories: v.optional(v.array(RERUN_ADVISORY_SCHEMA)),
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
    // Absent on every response except a V3-routed batch containing at least
    // one FE test with an explicit autoHeal:false opt-out. Same resilience
    // rule as RERUN_RESPONSE_SCHEMA.advisories above.
    advisories: v.optional(v.array(RERUN_ADVISORY_SCHEMA)),
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
  // Nullable on the wire (`RunHistoryRow.codeVersion` is `[string, 'null']`).
  codeVersion: v.nullish(v.string(), null),
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
  /**
   * Account-wide organization membership list (mirrors `CliOrgSummary` in
   * `lib/org-render.ts`). Optional/absent-safe: omitted on a server-side
   * lookup failure or an older backend.
   */
  organizations?: Array<{ id: string; name: string; role: string; isPersonal: boolean }>;
  /**
   * The calling key's own org binding (mirrors `CliOrgBinding`). Present
   * only for a Postgres-backed membership key (`sk-member-…`); `name` is
   * nullable (best-effort resolution).
   */
  org?: { id: string; name: string | null; role: string };
}

/** Mirrors `CliOrgSummary` (lib/org-render.ts): one `Me.organizations[]` entry. */
const ORG_SUMMARY_SCHEMA = v.looseObject({
  id: v.string(),
  name: v.string(),
  role: v.string(),
  isPersonal: v.boolean(),
});

/** Mirrors `CliOrgBinding` (lib/org-render.ts): `Me.org`. */
const ORG_BINDING_SCHEMA = v.looseObject({
  id: v.string(),
  name: v.nullable(v.string()),
  role: v.string(),
});

/** Mirrors `MeIdentity` (commands/doctor.ts): `GET /api/cli/v1/me` core. */
export const ME_IDENTITY_SCHEMA: v.GenericSchema<unknown, MeIdentityWire> = v.looseObject({
  userId: v.optional(v.string()),
  keyId: v.optional(v.string()),
  organizations: v.optional(v.array(ORG_SUMMARY_SCHEMA)),
  org: v.optional(ORG_BINDING_SCHEMA),
});
