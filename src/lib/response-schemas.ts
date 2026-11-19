/**
 * Valibot schemas for the API wire shapes (issue #102, extended by #277).
 *
 * `requestWithMeta` used to return `(await response.json()) as T` with zero
 * runtime validation, so a drifted or partial server response surfaced as
 * `undefined` output or an opaque TypeError deep inside a command. These
 * schemas are wired (opt-in, via `RequestOptions.schema`) into the typed
 * HttpClient helpers (the run, test-list, tunnel and execution-report calls), and —
 * for the account surfaces below — the `client.get` call sites that own a
 * `/me` or usage read, plus the `client.get` call sites that
 * own the `project get` / `project list` reads. Every other generic
 * `get`/`post`/`put`/`patch`/`delete` caller stays
 * schema-free and opt-in.
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
 *    may omit a nullable field entirely (real fixture evidence: poll bodies
 *    that omit `error`), and
 *    every consumer already null-checks these, so absence normalizes to
 *    `null` instead of failing. OPTIONAL interface fields (`?`) use
 *    `v.optional` with NO default so presence/absence semantics that commands
 *    branch on (e.g. `RunResponse.runId`) survive
 *    validation byte-identically.
 *
 * Each schema is annotated `v.GenericSchema<unknown, T>` against the
 * interface it mirrors, so schema/interface drift fails `tsc` in this file.
 */
import * as v from 'valibot';
// Type-only imports: erased at compile time, so pulling a command's wire
// interface into `lib/` adds no runtime edge.
import type { MeResponse } from '../commands/auth.js';
import type { UsageResponse } from '../commands/usage.js';
import type {
  BatchRunFreshResponse,
  ProjectRunResponse,
  CancelRunRefund,
  CancelRunResponse,
  RunEnvironmentRef,
  RunResponse,
  RunStatus,
  TriggerRunResponse,
  ExecutionReport,
  ExecutionReportResponse,
} from './runs.types.js';
import type { CliTestListRunResponse } from './testlist.types.js';
import type {
  ResultDetail,
  ResultLine,
  ResultList,
  ResultRun,
  ResultSignIn,
  ResultStep,
} from './result/types.js';
import type {
  TunnelListResponse,
  TunnelMintResponse,
  TunnelStatusResponse,
} from './tunnel.types.js';
import type { ConflictReason } from './conflict-reason.js';
import type { CliProject } from '../commands/project.js';
import type { Page } from './pagination.js';

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
 * GET /projects/{id} and the rows of GET /projects. Optional fields stay
 * absent when omitted. The renderer-consumed environment fields are typed so
 * a drifted value cannot throw in the text renderer.
 */
export const CLI_PROJECT_SCHEMA: v.GenericSchema<unknown, CliProject> = v.looseObject({
  id: v.string(),
  name: v.string(),
  type: openWireLiteral<CliProject['type']>(),
  createdFrom: openWireLiteral<CliProject['createdFrom']>(),
  createdAt: v.string(),
  updatedAt: v.string(),
  orgId: v.optional(v.string()),
  orgName: v.optional(v.string()),
  defaultEnvironment: v.optional(v.nullable(v.string())),
  environmentCount: v.optional(v.number()),
  instruction: v.optional(v.nullable(v.string())),
  testIdAttributes: v.optional(v.nullable(v.array(v.string()))),
});

/** GET /projects page; an omitted `nextToken` normalizes to the terminal `null` cursor. */
export const CLI_PROJECT_LIST_SCHEMA: v.GenericSchema<unknown, Page<CliProject>> = v.looseObject({
  items: v.array(CLI_PROJECT_SCHEMA),
  nextToken: v.nullish(v.string(), null),
});

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

/** Mirrors `RunResponse` (runs.types.ts): `GET /api/cli/v1/runs/{runId}`. */
export const RUN_RESPONSE_SCHEMA: v.GenericSchema<unknown, RunResponse> = v.looseObject({
  resultId: v.string(),
  testId: v.string(),
  // The test's human title (for CI output). Absent on older servers; the type
  // keeps it optional and renderers fall back to `testId`.
  testTitle: v.nullish(v.string(), null),
  projectId: v.string(),
  userId: v.string(),
  // The launch this result belongs to; an older backend omits it.
  runId: v.optional(v.string()),
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
  // Optional with no default: absent on older backends. `reason` / `caveat` are
  // `null` on the wire when the run carries no routing reason or caveat.
  replay: v.optional(
    v.looseObject({
      path: v.string(),
      reason: v.nullish(v.string()),
      caveat: v.nullish(v.string()),
    }),
  ),
  retryAfterSeconds: v.optional(v.number()),
  // Portal link, server-built only (the CLI never builds one): a string is
  // used verbatim; `null` means the backend has no correct link to offer and
  // is rendered like an absent key.
  //
  // The `undefined` default (NOT `null`, unlike every field above) is
  // load-bearing: valibot applies a default only when the key is absent, and
  // skips the assignment entirely when that default is `undefined` — so an
  // omitted field stays an ABSENT key and `--output json` passes it through
  // unchanged instead of materializing `"dashboardUrl": null` on every run.
  // Locked by tests in response-schemas.test.ts.
  dashboardUrl: v.nullish(v.string(), undefined),
  // Same absent-key-preserving contract as `dashboardUrl` (see the note above):
  // the run-scoped execution-result link is absent when the server has none,
  // and never materialized as null.
  executionUrl: v.nullish(v.string(), undefined),
});

// ---------------------------------------------------------------------------
// POST /runs/{runId}/cancel
// ---------------------------------------------------------------------------

/** Mirrors `CancelRunRefund` (runs.types.ts): optional per-result refund outcome. */
const CANCEL_RUN_REFUND_SCHEMA: v.GenericSchema<unknown, CancelRunRefund> = v.looseObject({
  status: openWireLiteral<CancelRunRefund['status']>(),
  amount: v.optional(v.number()),
});

/** Mirrors `CancelRunResponse` (runs.types.ts): the run envelope plus cancel metadata. */
export const CANCEL_RUN_RESPONSE_SCHEMA: v.GenericSchema<unknown, CancelRunResponse> =
  v.looseObject({
    runId: v.string(),
    alreadyCancelled: v.boolean(),
    alreadyFinished: v.boolean(),
    results: v.array(
      v.looseObject({
        resultId: v.string(),
        runId: v.nullable(v.string()),
        testId: v.nullable(v.string()),
        title: v.string(),
        status: openWireLiteral<RunStatus>(),
        alreadyCancelled: v.boolean(),
        alreadyFinished: v.boolean(),
        refund: v.optional(CANCEL_RUN_REFUND_SCHEMA),
      }),
    ),
  });

// ---------------------------------------------------------------------------
// POST /tests/{testId}/runs
// ---------------------------------------------------------------------------

/** Mirrors `TriggerRunResponse` (runs.types.ts): `POST /tests/{testId}/runs`. */
export const TRIGGER_RUN_RESPONSE_SCHEMA: v.GenericSchema<unknown, TriggerRunResponse> =
  v.looseObject({
    resultId: v.string(),
    status: openWireLiteral<'queued'>(),
    // The launch this result belongs to; an older backend omits it.
    runId: v.optional(v.string()),
    enqueuedAt: v.string(),
    codeVersion: v.string(),
    targetUrl: v.string(),
    // Optional with NO default (rule 3): `undefined` means this backend
    // predates the field; the CLI reports the server's decision as given.
    autoHeal: v.optional(v.boolean()),
    // The run's environment — optional with no default (rule 3, optional branch).
    environment: OPTIONAL_ENVIRONMENT_SCHEMA,
    // Server-built portal links (backend ≥ the run-links change). Optional
    // with no default (rule 3): an older backend omits them, and a run
    // the server could not link stays ABSENT — the renderer prints a
    // `dashboard` line only when the key is present.
    dashboardUrl: v.optional(v.string()),
    executionUrl: v.optional(v.string()),
    // Present-or-omitted echo of the request's `skipDependencies: true`; no default.
    skipDependencies: v.optional(v.boolean()),
  });

// ---------------------------------------------------------------------------
// POST /tests/batch/run
// ---------------------------------------------------------------------------

/** Modern project launch; never accept a legacy batch envelope. */
export const PROJECT_RUN_RESPONSE_SCHEMA: v.GenericSchema<unknown, ProjectRunResponse> =
  v.looseObject({
    runId: v.pipe(v.string(), v.nonEmpty()),
    projectId: v.pipe(v.string(), v.nonEmpty()),
    enqueuedAt: v.string(),
    total: v.pipe(v.number(), v.integer(), v.minValue(0)),
    autoHeal: v.boolean(),
    maxConcurrency: v.optional(v.number()),
    environment: v.nullable(
      v.looseObject({ id: v.nullable(v.string()), name: v.nullable(v.string()) }),
    ),
    targetUrl: v.nullable(v.string()),
    tunnelClientId: v.optional(v.string()),
    dashboardUrl: v.optional(v.string()),
    blocked: v.array(
      v.looseObject({
        testId: v.string(),
        resultId: v.string(),
        reason: v.string(),
        message: v.optional(v.string()),
      }),
    ),
    held: v.array(v.looseObject({ testId: v.string(), runId: v.string(), resultId: v.string() })),
  });

/** Mirrors `BatchRunFreshResponse` (runs.types.ts): `POST /tests/batch/run`. */
export const BATCH_RUN_FRESH_RESPONSE_SCHEMA: v.GenericSchema<unknown, BatchRunFreshResponse> =
  v.looseObject({
    // See TRIGGER_RUN_RESPONSE_SCHEMA; absence carries the same meaning.
    autoHeal: v.optional(v.boolean()),
    // Mirrors BatchRunFreshAccepted (runs.types.ts); dashboardUrl is
    // client-synthesized, tolerated as optional.
    accepted: v.array(
      v.looseObject({
        testId: v.string(),
        resultId: v.string(),
        enqueuedAt: v.string(),
        // Runs name their execution; an older backend omits it.
        runId: v.optional(v.string()),
      }),
    ),
    conflicts: v.array(
      v.looseObject({
        testId: v.string(),
        currentResultId: v.optional(v.string()),
        // The launch the in-flight result belongs to; an older backend omits it.
        currentRunId: v.optional(v.string()),
        reason: v.optional(v.string()) as v.GenericSchema<unknown, ConflictReason | undefined>,
        message: v.optional(v.string()),
      }),
    ),
    deferred: v.array(v.looseObject({ testId: v.string() })),
    skippedFrontend: v.array(v.string()),
    skippedIntegration: v.array(v.looseObject({ testId: v.string() })),
    // Optional with no default: absent on older backends and frontend projects.
    integration: v.optional(
      v.looseObject({
        existing: v.number(),
        runsAfterWave: v.boolean(),
        mayGenerate: v.boolean(),
      }),
    ),
    // Project-level closing link. Absent-key-preserving like `RUN_RESPONSE_SCHEMA`'s
    // `dashboardUrl` (see the note there); `null` passes through as a present
    // key meaning "no correct page".
    dashboardUrl: v.nullish(v.string(), undefined),
    // An exact echo confirms that the backend read the target URL override.
    targetUrl: v.optional(v.string()),
    // Same contract for the CI fields: a client that sent one and gets no
    // echo was served by a backend that cut the batch / ran a plain override.
    admission: v.optional(v.picklist(['budget', 'all'])),
    previewName: v.optional(v.string()),
    skipDependencies: v.optional(v.boolean()),
    tunnelClientId: v.optional(v.string()),
    maxConcurrency: v.optional(v.number()),
  });

/**
 * `POST /api/cli/v1/testlist/{listId}/run`. Mirrors the batch-run-fresh shape so
 * the `--wait` path uses whole-execution result listings; `conflicts[]` additionally
 * carry the in-flight `currentResultId`, and `reason` marks a nothing-dispatched run.
 */
export const TESTLIST_RUN_RESPONSE_SCHEMA: v.GenericSchema<unknown, CliTestListRunResponse> =
  v.looseObject({
    accepted: v.array(
      v.looseObject({
        testId: v.string(),
        resultId: v.string(),
        // The launch the result belongs to; an older backend omits it.
        runId: v.optional(v.string()),
        enqueuedAt: v.string(),
      }),
    ),
    conflicts: v.array(
      v.looseObject({
        testId: v.string(),
        currentResultId: v.optional(v.string()),
        // The launch the in-flight result belongs to; an older backend omits it.
        currentRunId: v.optional(v.string()),
        reason: v.optional(v.string()) as v.GenericSchema<unknown, ConflictReason | undefined>,
        message: v.optional(v.string()),
      }),
    ),
    deferred: v.array(v.looseObject({ testId: v.string() })),
    notFound: v.optional(v.array(v.string())),
    reason: v.optional(v.string()) as v.GenericSchema<unknown, CliTestListRunResponse['reason']>,
    maxConcurrency: v.optional(v.number()),
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
 * drift.
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

/**
 * Mirrors `MeResponse` (commands/auth.ts): the full `GET /me` projection read
 * by `auth status` (and, through it, `setup`).
 *
 * `scopes` is required and array-typed on purpose — this is the shape drift
 * that actually bites today. `runWhoami` renders `m.scopes.join(', ')` and
 * computes `missingScopes` via `m.scopes.includes(...)` with no guard, so a
 * `/me` body without `scopes` crashes with a raw `TypeError` (exit 1) instead
 * of a typed envelope. Every `/me` fixture in the suite supplies it
 * (`auth.test.ts`, `init.test.ts`, `usage.test.ts`, `cli.subprocess.test.ts`,
 * `test/mock-backend/fixtures.ts`), so requiring it matches observed wire
 * reality; `email` / `displayName` are the genuinely absent-safe
 * ones and stay `v.optional` with no default (rule 3, optional branch).
 *
 * `setup` calls this through `runWhoami` inside a try/catch that falls back to
 * a placeholder identity, so a drifted `/me` degrades the setup summary
 * instead of failing the whole `setup`.
 */
export const ME_RESPONSE_SCHEMA: v.GenericSchema<unknown, MeResponse> = v.looseObject({
  userId: v.string(),
  keyId: v.string(),
  scopes: v.array(v.string()),
  env: openWireLiteral<AccountEnv>(),
  email: v.optional(v.string()),
  displayName: v.optional(v.string()),
});

// ---------------------------------------------------------------------------
// GET /me (usage projection)
// ---------------------------------------------------------------------------

/**
 * Mirrors `UsageResponse` (commands/usage.ts): the wallet projection the
 * `usage` command reads off the same `GET /me` body.
 *
 * `renderUsage` prints `userId`/`keyId`/`env` unconditionally as its "identity
 * block", so those three are required. `activeOrg`, `organizations` and `org`
 * are best-effort enrichments every renderer branch gates on `!== undefined`,
 * and ride along (with `scopes`) as extra keys preserved by `looseObject`.
 */
export const USAGE_RESPONSE_SCHEMA: v.GenericSchema<unknown, UsageResponse> = v.looseObject({
  userId: v.string(),
  keyId: v.string(),
  env: openWireLiteral<AccountEnv>(),
});

// ---------------------------------------------------------------------------
// /tunnel facade
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

/** Mirrors `TunnelListResponse`: a server may add status values or omit creation time. */
export const TUNNEL_LIST_RESPONSE_SCHEMA: v.GenericSchema<unknown, TunnelListResponse> =
  v.looseObject({
    tunnels: v.array(
      v.looseObject({
        clientId: v.string(),
        status: openWireLiteral<'online' | 'offline' | 'unknown'>(),
        expiresAt: v.string(),
        createdAt: v.optional(v.nullable(v.string())),
      }),
    ),
  });

/** Mirrors `ExecutionReport` — the server's report model, kept loose so new fields pass through. */
export const EXECUTION_REPORT_SCHEMA: v.GenericSchema<unknown, ExecutionReport> = v.looseObject({
  projectId: v.string(),
  runId: v.string(),
  projectName: v.string(),
  orgId: v.nullish(v.string(), null),
  stats: v.looseObject({
    passed: v.number(),
    failed: v.number(),
    blocked: v.number(),
    total: v.number(),
  }),
  allPassed: v.boolean(),
  narrative: v.nullish(v.string(), null),
  whatCouldBeBetter: v.nullish(v.string(), null),
  recommendedNextStep: v.nullish(v.string(), null),
  tests: v.array(
    v.looseObject({
      id: v.string(),
      title: v.string(),
      slug: v.nullish(v.string(), null),
      status: openWireLiteral<'PASSED' | 'FAILED' | 'BLOCKED'>(),
      screenshotUrl: v.nullish(v.string(), null),
      error: v.nullish(v.string(), null),
      fix: v.nullish(v.string(), null),
      resultUrl: v.optional(v.string()),
    }),
  ),
  resultUrl: v.string(),
});

/** Mirrors `ExecutionReportResponse`: `report`/`markdown` only travel with `ready: true`. */
export const EXECUTION_REPORT_RESPONSE_SCHEMA: v.GenericSchema<unknown, ExecutionReportResponse> =
  v.looseObject({
    ready: v.boolean(),
    retryAfterSeconds: v.optional(v.number()),
    report: v.optional(EXECUTION_REPORT_SCHEMA),
    markdown: v.optional(v.string()),
  });

// ---------------------------------------------------------------------------
// GET /results, GET /results/{resultId}
// ---------------------------------------------------------------------------

/** Mirrors `ResultLine` (result/types.ts): one row of `GET /results`. */
const RESULT_LINE_SCHEMA: v.GenericSchema<unknown, ResultLine> = v.looseObject({
  resultId: v.string(),
  runId: v.nullish(v.string(), null),
  caseKey: v.nullish(v.string(), null),
  title: v.string(),
  testStatus: v.string(),
  processStatus: v.nullish(v.string(), null),
  error: v.nullish(v.string(), null),
  blockedReason: v.nullish(v.string(), null),
  environmentName: v.nullish(v.string(), null),
  created: v.string(),
  // No default: an older backend does not send it.
  modified: v.optional(v.string()),
});

/** A field read as null when absent, null, or of a shape this CLI cannot read. */
function lenient<T>(schema: v.GenericSchema<unknown, T>): v.GenericSchema<unknown, T | null> {
  return v.fallback(v.nullish(schema, null), null);
}

/**
 * Mirrors `ResultRun` (result/types.ts): the run a run's listing is of. Only
 * what a wait needs is required, so drift in any other field cannot stop one.
 */
const RESULT_RUN_SCHEMA: v.GenericSchema<unknown, ResultRun> = v.looseObject({
  runId: v.string(),
  status: openWireLiteral<'running' | 'finished'>(),
  projectId: lenient(v.string()),
  cancelled: lenient(v.boolean()),
  created: lenient(v.string()),
  modified: lenient(v.string()),
  targetUrl: lenient(v.string()),
  dashboardUrl: lenient(v.string()),
});

/** Mirrors `ResultList` (result/types.ts): `GET /results?run=…` or `?test=…`. */
export const RESULT_LIST_SCHEMA: v.GenericSchema<unknown, ResultList> = v.looseObject({
  // A run's listing only, and absent from an older backend. No default: the
  // waiter on a run tells an older backend by its absence. A run without a
  // readable runId and status reads as null, so a read that does not use it
  // still works and the waiter can refuse it in its own words.
  run: v.optional(v.fallback(v.nullable(RESULT_RUN_SCHEMA), null)),
  results: v.array(RESULT_LINE_SCHEMA),
  // Only a test's history carries these two. No default: a run's listing must
  // not gain keys the server never sent.
  hiddenRunCount: v.optional(v.number()),
  retentionDays: v.optional(v.nullable(v.number())),
});

/** Mirrors `ResultStep` (result/types.ts): a step of a result or of its sign-in run. */
const RESULT_STEP_SCHEMA: v.GenericSchema<unknown, ResultStep> = v.looseObject({
  stepIndex: v.nullish(v.string(), null),
  type: v.nullish(v.string(), null),
  action: v.nullish(v.string(), null),
  description: v.nullish(v.string(), null),
  status: v.nullish(openWireLiteral<'passed' | 'failed'>(), null),
  selector: v.nullish(v.string(), null),
  url: v.nullish(v.string(), null),
  healed: v.boolean(),
  screenshotSignedUrl: v.nullish(v.string(), null),
  htmlSignedUrl: v.nullish(v.string(), null),
});

/** Mirrors `ResultSignIn` (result/types.ts): the sign-in run behind a blocked result. */
const RESULT_SIGN_IN_SCHEMA: v.GenericSchema<unknown, ResultSignIn> = v.looseObject({
  id: v.string(),
  status: v.nullish(v.string(), null),
  videoUrl: v.nullish(v.string(), null),
  finalUrl: v.nullish(v.string(), null),
  stepCount: v.nullish(v.number(), null),
  error: v.nullish(v.string(), null),
  steps: v.array(RESULT_STEP_SCHEMA),
});

/** Mirrors `ResultDetail` (result/types.ts): `GET /results/{resultId}`. */
export const RESULT_DETAIL_SCHEMA: v.GenericSchema<unknown, ResultDetail> = v.looseObject({
  resultId: v.string(),
  runId: v.nullish(v.string(), null),
  caseKey: v.nullish(v.string(), null),
  caseHash: v.nullish(v.string(), null),
  title: v.string(),
  type: v.string(),
  testStatus: v.string(),
  processStatus: v.nullish(v.string(), null),
  processErrorMessage: v.nullish(v.string(), null),
  error: v.nullish(v.string(), null),
  cause: v.nullish(v.string(), null),
  fix: v.nullish(v.string(), null),
  blockedReason: v.nullish(v.string(), null),
  // No default: an older backend sends neither, and JSON prints what was sent.
  trace: v.optional(v.nullable(v.string())),
  apiOutput: v.optional(v.nullable(v.string())),
  videoUrl: v.nullish(v.string(), null),
  envId: v.nullish(v.string(), null),
  created: v.string(),
  modified: v.string(),
  failedStep: v.nullish(RESULT_STEP_SCHEMA, null),
  steps: v.array(RESULT_STEP_SCHEMA),
  signIn: v.nullish(RESULT_SIGN_IN_SCHEMA, null),
});
