/**
 * Valibot schemas for the API wire shapes (issue #102, extended by #277).
 *
 * `requestWithMeta` used to return `(await response.json()) as T` with zero
 * runtime validation, so a drifted or partial server response surfaced as
 * `undefined` output or an opaque TypeError deep inside a command. These
 * schemas are wired (opt-in, via `RequestOptions.schema`) into the typed
 * HttpClient helpers `triggerRun`, `triggerRunWithMeta`, `triggerRerun`,
 * `triggerBatchRerun`, `triggerBatchRunFresh`, `getRun`, `listTestRuns`,
 * `cancelRun`, and — for the account surfaces below — the `client.get` call
 * sites that own a `/me` or usage read. Every other generic
 * `get`/`post`/`put`/`patch`/`delete` caller stays schema-free and opt-in.
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
  CancelRunRefund,
  CancelRunResponse,
  ListRunsResponse,
  RerunAdvisory,
  RerunClosure,
  RerunResponse,
  RunEnvironmentRef,
  RunResponse,
  RunSource,
  RunStatus,
  TriggerRunResponse,
} from './runs.types.js';
import type { CliTestListRunResponse } from './testlist.types.js';
import type { TunnelMintResponse, TunnelStatusResponse } from './tunnel.types.js';
import type { ConflictReason } from './conflict-reason.js';

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

/**
 * Mirrors `RunEnvironmentRef` (runs.types.ts): the environment a run resolved to.
 * Optional + nullable everywhere it appears: absent on an older backend, `null`
 * when the row carries no stamp — both mean "unknown" to every renderer.
 */
const RUN_ENVIRONMENT_REF_SCHEMA: v.GenericSchema<unknown, RunEnvironmentRef> = v.looseObject({
  // Either half may be null: a backfilled row whose environment was deleted
  // keeps the denormalised name but no id, and a pre-name row keeps the id only.
  id: v.nullable(v.string()),
  name: v.nullable(v.string()),
});
const OPTIONAL_ENVIRONMENT_SCHEMA = v.optional(v.nullable(RUN_ENVIRONMENT_REF_SCHEMA));
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
  // The test's human title (for CI output). Absent on older servers; the type
  // keeps it optional and renderers fall back to `testId`.
  testTitle: v.nullish(v.string(), null),
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
  // The run's environment — optional with no default (rule 3, optional branch).
  environment: OPTIONAL_ENVIRONMENT_SCHEMA,
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
  // Same absent-key-preserving contract as `dashboardUrl` (see the note above):
  // the run-scoped execution-result link is present only for a V3-served run
  // with the server flag on, absent otherwise, and never materialized as null.
  executionUrl: v.nullish(v.string(), undefined),
  // Absence means "steps not requested" and drives command branching, so no
  // default is applied (rule 3, optional branch).
  steps: v.optional(v.nullable(v.array(RUN_STEP_DTO_SCHEMA))),
});

// ---------------------------------------------------------------------------
// POST /runs/{runId}/cancel
// ---------------------------------------------------------------------------

/** Mirrors `CancelRunRefund` (runs.types.ts): optional V3 frontend refund result. */
const CANCEL_RUN_REFUND_SCHEMA: v.GenericSchema<unknown, CancelRunRefund> = v.looseObject({
  status: openWireLiteral<CancelRunRefund['status']>(),
  amount: v.optional(v.number()),
});

/** Mirrors `CancelRunResponse` (runs.types.ts): the run envelope plus cancel metadata. */
export const CANCEL_RUN_RESPONSE_SCHEMA: v.GenericSchema<unknown, CancelRunResponse> = v.intersect([
  RUN_RESPONSE_SCHEMA,
  v.looseObject({
    alreadyCancelled: v.boolean(),
    // Older backends, V2 runs, and backend-test runs omit this field. No
    // default: absence must stay absent so JSON output passes through unchanged.
    refund: v.optional(CANCEL_RUN_REFUND_SCHEMA),
  }),
]);

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
    // The run's environment — optional with no default (rule 3, optional branch).
    environment: OPTIONAL_ENVIRONMENT_SCHEMA,
    // Server-built portal links (backend ≥ the run-links change). Optional
    // with no default (rule 3): an older backend omits them, and a V3 run
    // the server could not link stays ABSENT — the renderer prints a
    // `dashboard` line only when the key is present.
    dashboardUrl: v.optional(v.string()),
    executionUrl: v.optional(v.string()),
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
  // Same present-or-absent portal links as TRIGGER_RUN_RESPONSE_SCHEMA.
  dashboardUrl: v.optional(v.string()),
  executionUrl: v.optional(v.string()),
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
    conflicts: v.array(
      v.looseObject({
        testId: v.string(),
        currentRunId: v.optional(v.string()),
        reason: v.optional(v.string()) as v.GenericSchema<unknown, ConflictReason | undefined>,
        message: v.optional(v.string()),
      }),
    ),
    deferred: v.array(v.looseObject({ testId: v.string() })),
    skippedFrontend: v.array(v.string()),
    skippedIntegration: v.array(v.looseObject({ testId: v.string() })),
    // Project-level closing link. Absent-key-preserving like `RUN_RESPONSE_SCHEMA`'s
    // `dashboardUrl` (see the note there): omitted stays ABSENT so the client
    // keeps computing its legacy template for an older backend / the V2 engine;
    // `null` passes through as a present key meaning "no correct page".
    dashboardUrl: v.nullish(v.string(), undefined),
  });

/**
 * `POST /api/cli/v1/testlist/{listId}/run`. Mirrors the batch-run-fresh shape so
 * the `--wait` fan-out reuses the same poll tail; `conflicts[]` additionally
 * carry the in-flight `currentRunId`, and `reason` marks a nothing-dispatched run.
 */
export const TESTLIST_RUN_RESPONSE_SCHEMA: v.GenericSchema<unknown, CliTestListRunResponse> =
  v.looseObject({
    accepted: v.array(
      v.looseObject({ testId: v.string(), runId: v.string(), enqueuedAt: v.string() }),
    ),
    conflicts: v.array(
      v.looseObject({
        testId: v.string(),
        currentRunId: v.optional(v.string()),
        reason: v.optional(v.string()) as v.GenericSchema<unknown, ConflictReason | undefined>,
        message: v.optional(v.string()),
      }),
    ),
    deferred: v.array(v.looseObject({ testId: v.string() })),
    notFound: v.optional(v.array(v.string())),
    reason: v.optional(v.string()) as v.GenericSchema<unknown, CliTestListRunResponse['reason']>,
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
  // The run's environment — optional with no default.
  environment: OPTIONAL_ENVIRONMENT_SCHEMA,
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
  v3Enabled: v.optional(v.boolean()),
  organizations: v.optional(v.array(ORG_SUMMARY_SCHEMA)),
  org: v.optional(ORG_BINDING_SCHEMA),
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

// ---------------------------------------------------------------------------
// /tunnel — DEV-747 piece 1 facade
// ---------------------------------------------------------------------------

/**
 * Mirrors `TunnelMintResponse` (tunnel.types.ts): `POST /tunnel`.
 *
 * Every field is required rather than nullish-defaulted, and that is
 * deliberate on this one surface: a mint response missing `controlUrl` or
 * `tunnelAddr` cannot be used for anything, and the client's failure mode
 * for a bad endpoint (a control socket that closes) is indistinguishable
 * from an auth failure. Refusing the response here names the real problem.
 */
export const TUNNEL_MINT_RESPONSE_SCHEMA: v.GenericSchema<unknown, TunnelMintResponse> =
  v.looseObject({
    clientId: v.pipe(v.string(), v.minLength(1)),
    secret: v.pipe(v.string(), v.minLength(1)),
    controlUrl: v.pipe(v.string(), v.minLength(1)),
    tunnelAddr: v.pipe(v.string(), v.minLength(1)),
    tunnelTlsAddr: v.optional(v.pipe(v.string(), v.minLength(1))),
    expiresAt: v.string(),
  });

/** Mirrors `TunnelStatusResponse` (tunnel.types.ts): `GET /tunnel/{clientId}`. */
export const TUNNEL_STATUS_RESPONSE_SCHEMA: v.GenericSchema<unknown, TunnelStatusResponse> =
  v.looseObject({
    clientId: v.string(),
    status: openWireLiteral<'online' | 'offline'>(),
    expiresAt: v.string(),
  });
