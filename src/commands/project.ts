import { randomUUID } from 'node:crypto';
import { createReadStream, readFileSync, statSync, type Stats } from 'node:fs';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import { Command } from 'commander';
import {
  emitDryRunBanner,
  makeHttpClient,
  parseRequestTimeoutFlag,
  resolveRequestTimeoutMs,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import { ApiError, InterruptError, RequestTimeoutError } from '../lib/errors.js';
import type { FetchImpl, HttpClient } from '../lib/http.js';
import { globalShutdown, type ShutdownHandle } from '../lib/interrupt.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode, type OutputMode } from '../lib/output.js';
import { readSecretFileGuarded } from '../lib/secret-file.js';
import { assertNotLocal } from '../lib/target-url.js';
import { renderTextTable, resolveTextColumns, type TextTableColumn } from '../lib/text-table.js';
import { assertIdempotencyKey } from '../lib/validate.js';
import {
  fetchSinglePage,
  paginate,
  validatePaginationFlags,
  type Page,
  type PaginationFlags,
} from '../lib/pagination.js';

export interface CliProject {
  id: string;
  name: string;
  type: 'frontend' | 'backend';
  createdFrom: 'portal' | 'mcp' | 'cli';
  createdAt: string;
  updatedAt: string;
  /**
   * Owning organization id + human-readable name. Additive + absent-safe:
   * populated only for a membership-key (`sk-member-…`) caller on `project list`
   * (org attribution across the caller's org-scoped view); `project get`
   * does not populate them today even for a bound key. `orgName` may be
   * absent even when `orgId` is present (best-effort name lookup). Legacy
   * (unbound) callers never see either field.
   */
  orgId?: string;
  orgName?: string;
  /**
   * The project's default target/environment URL, or `null` when the project has
   * none configured.
   *
   * **Absent vs. `null` is load-bearing here.** `null` means "the server resolved
   * it and this project has no URL configured" — actionable, so the renderer
   * prints the `project update … --url` remedy. **Absent** means "no answer", and
   * the server uses it for every case where a remedy would be a lie: an older
   * backend, the `list` endpoint (which would pay an extra read per row), a
   * resolution that failed (a transient outage must never be reported as "no URL
   * set"), and a V2 backend project (V2 backend runs resolve no project URL at
   * all, so there is nothing to report and nothing `--url` would change).
   *
   * So the renderer must key on presence, not truthiness: printing "(not set)"
   * for an absent field would report every project on an older backend — and
   * every project in a `list` — as having no URL, including the ones that do.
   *
   * A backend project with no URL is not merely cosmetic: on the V3 execution
   * path the first run of any of its tests is rejected `no-target-resolvable`
   * (see the `project create --type backend` note in CLAUDE.md).
   */
  targetUrl?: string | null;
  /**
   * Project-level test-id attribute priority list (e.g. `['data-element',
   * 'data-testid']`). The execution engine tries these DOM attributes, in
   * order, before any other locator strategy when it exports test code, so
   * customers who tag their UI with their own attribute get
   * `page.locator('[data-element="…"]')` locators. Absent on older backends;
   * `null`/empty means "not configured" (engine default: `data-testid`).
   */
  testIdAttributes?: string[] | null;
}

/** Attribute names are interpolated into CSS selectors by the engine — keep them plain. */
const TEST_ID_ATTRIBUTE_NAME = /^[A-Za-z_][\w.:-]*$/;
const TEST_ID_ATTRIBUTES_MAX = 10;

/**
 * Parse `--test-id-attributes <list>`: a comma-separated, ordered list of DOM
 * attribute names. Trims, drops empties and duplicates (first occurrence
 * wins — order is the priority), rejects invalid names. Exported for tests.
 */
export function parseTestIdAttributesFlag(raw: string, flagName: string): string[] {
  const seen = new Set<string>();
  const attrs: string[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (!name) continue;
    if (name.length > 64 || !TEST_ID_ATTRIBUTE_NAME.test(name)) {
      throw localValidationError(
        `--${flagName}: '${name}' is not a valid attribute name (letters, digits, '_', '-', '.', ':'; must not start with a digit).`,
      );
    }
    if (!seen.has(name)) {
      seen.add(name);
      attrs.push(name);
    }
  }
  if (attrs.length === 0) {
    throw localValidationError(
      `--${flagName} needs at least one attribute name, e.g. --${flagName} data-element,data-testid`,
    );
  }
  if (attrs.length > TEST_ID_ATTRIBUTES_MAX) {
    throw localValidationError(
      `--${flagName} accepts at most ${TEST_ID_ATTRIBUTES_MAX} attribute names.`,
    );
  }
  return attrs;
}

export interface ProjectDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Graceful-detach coordinator (DEV-331); tests inject their own. */
  shutdown?: ShutdownHandle;
}

type CommonOptions = FactoryCommonOptions;

interface ListOptions extends CommonOptions {
  pageSize?: number;
  startingToken?: string;
  maxItems?: number;
  columns?: string;
  noHeader?: boolean;
}

export async function runList(
  opts: ListOptions,
  deps: ProjectDeps = {},
): Promise<Page<CliProject>> {
  const out = makeOutput(opts.output, deps);

  const paginationFlags: PaginationFlags = validatePaginationFlags({
    pageSize: opts.pageSize,
    startingToken: opts.startingToken,
    maxItems: opts.maxItems,
  });
  if (opts.output === 'text') {
    resolveTextColumns(opts.columns, PROJECT_LIST_COLUMNS);
  }
  const client = makeClient(opts, deps);

  // When the user explicitly passed a page-size flag and did NOT ask
  // for --max-items, treat that as a "give me one page and the cursor"
  // request — same shape AWS CLI ships. Otherwise auto-page.
  const useSinglePage = opts.pageSize !== undefined && opts.maxItems === undefined;

  let page: Page<CliProject>;
  if (useSinglePage) {
    page = await fetchSinglePage<CliProject>(
      client,
      '/projects',
      paginationFlags.pageSize!,
      opts.startingToken,
    );
  } else {
    page = await paginate<CliProject>(
      async ({ pageSize, cursor }) =>
        client.get<Page<CliProject>>('/projects', {
          query: { pageSize, cursor },
        }),
      paginationFlags,
    );
  }

  out.print(page, data => {
    const p = data as Page<CliProject>;
    return renderProjectListText(p, { columns: opts.columns, noHeader: opts.noHeader });
  });
  return page;
}

interface GetOptions extends CommonOptions {
  projectId: string;
}

export async function runGet(opts: GetOptions, deps: ProjectDeps = {}): Promise<CliProject> {
  const out = makeOutput(opts.output, deps);
  const client = makeClient(opts, deps);

  const project = await client.get<CliProject>(`/projects/${encodeURIComponent(opts.projectId)}`);
  out.print(project, data => renderProjectText(data as CliProject));
  return project;
}

// ---------------------------------------------------------------------------
// project create
// ---------------------------------------------------------------------------

export interface CliCreateProjectRequest {
  type: 'frontend' | 'backend';
  name: string;
  targetUrl?: string;
  // `description` is intentionally not part of the wire request — projects have
  // no description field. The `--description` flag is rejected client-side.
  username?: string;
  password?: string;
  instruction?: string;
  /** Ordered test-id attribute list — see `CliProject.testIdAttributes`. */
  testIdAttributes?: string[];
}

/**
 * Response shape for `POST /projects`.
 *
 * The validation sweep found the LIVE `POST /projects`
 * response keying its id as `projectId` (matching `CliDeleteProjectResponse`'s
 * convention), not `id` like the read paths (`GET /projects`, `GET
 * /projects/{id}` — those are proven-`id` via the dev-e2e smoke test) — and
 * possibly omitting `targetUrl`/`updatedAt` entirely. Rather than guess which
 * single shape is "the real one" and risk flipping the drift instead of
 * fixing it, both id field names are accepted here (and normalized — see
 * `resolveCreatedProjectId` — so JSON consumers keyed on either `id` or
 * `projectId` keep working), and `targetUrl`/`updatedAt` are optional.
 */
export interface CliCreateProjectResponse {
  /** Preferred — matches the live backend's response and `project delete`'s `projectId`. */
  projectId?: string;
  /** Legacy/fallback name; some responses (and the read paths) use this instead. */
  id?: string;
  name: string;
  type: 'frontend' | 'backend';
  createdFrom: 'portal' | 'mcp' | 'cli';
  createdAt: string;
  /** Absent-safe: not guaranteed on every backend response. */
  updatedAt?: string;
  targetUrl?: string;
}

/** Resolve the created project's id regardless of which field name the backend used. */
export function resolveCreatedProjectId(r: CliCreateProjectResponse): string | undefined {
  return r.projectId ?? r.id;
}

interface CreateOptions extends CommonOptions {
  type: 'frontend' | 'backend';
  name: string;
  targetUrl?: string;
  description?: string;
  testIdAttributes?: string[];
  username?: string;
  password?: string;
  passwordFile?: string;
  instruction?: string;
  idempotencyKey?: string;
}

export async function runCreate(
  opts: CreateOptions,
  deps: ProjectDeps = {},
): Promise<CliCreateProjectResponse> {
  const out = makeOutput(opts.output, deps);
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  // P1-2: validate idempotency key before sending as an HTTP header.
  // Non-ASCII chars cause a ByteString TypeError at the transport layer
  // (exit 10 UNAVAILABLE) — fail fast with a clear exit 5 instead.
  assertIdempotencyKey(opts.idempotencyKey);

  // P1-3: client-side length checks matching server limits.
  // Whitespace-only / empty rejection (parity with `test create`'s requireString;
  // a truthy `--name "   "` otherwise creates a blank-named project on the backend).
  if (opts.name === undefined || opts.name.trim().length === 0) {
    throw localValidationError('--name is required and must not be empty or whitespace-only');
  }
  if (opts.password !== undefined && opts.password.trim().length === 0) {
    throw localValidationError('--password must not be empty or whitespace-only');
  }
  if (opts.name.length > 200) {
    throw localValidationError('--name must be at most 200 characters');
  }
  // `--description` is not supported on projects — no project entity stores a
  // description, and the backend rejects it with a 422. Fail fast client-side
  // with an actionable message instead of a wasted round trip.
  if (opts.description !== undefined) {
    throw localValidationError(
      '--description is not supported for projects; omit it (test-level descriptions are set on `test create`)',
    );
  }

  // P2-7: guard --url against localhost/RFC1918/non-http(s) (same rules as
  // `test create --target-url`). Applies to both FE (required) and BE (optional).
  if (opts.targetUrl !== undefined) {
    assertNotLocal(opts.targetUrl, {
      field: 'url',
      helpCommand: 'testsprite project create',
      hintContext: 'bootstrap',
    });
  }

  if (opts.type === 'frontend' && !opts.targetUrl) {
    throw localValidationError('--url is required for --type frontend');
  }

  if (opts.dryRun) {
    // DEV-247: this path returns before makeClient() fires the banner, so emit it
    // here — otherwise the canned sample can be mistaken for a live response.
    emitDryRunBanner(stderr);
    const idempotencyKey = opts.idempotencyKey ?? `cli-proj-create-${randomUUID()}`;
    // P2-6: gate idempotency-key output behind --verbose/--debug/json (matches
    // test create convention). Suppress in plain text interactive mode to reduce
    // noise; still available for automation and retry flows.
    if (
      opts.idempotencyKey === undefined &&
      (opts.output === 'json' || opts.verbose || opts.debug)
    ) {
      stderr(`idempotency-key: ${idempotencyKey}`);
    }
    // Teach both id field names — `projectId` is the field the
    // live backend actually sends; `id` is kept so this sample still matches
    // callers written against the pre-fix shape.
    const sample: CliCreateProjectResponse = {
      projectId: 'p_dryrun_2026',
      id: 'p_dryrun_2026',
      type: opts.type,
      name: opts.name,
      targetUrl: opts.targetUrl ?? '',
      createdFrom: 'cli',
      createdAt: '2026-05-16T00:00:00.000Z',
      updatedAt: '2026-05-16T00:00:00.000Z',
    };
    out.print(sample, data => renderCreateProjectText(data as CliCreateProjectResponse));
    return sample;
  }

  // Resolve password: flag > file > none
  let password = opts.password;
  if (password === undefined && opts.passwordFile !== undefined) {
    password = readSecretFileGuarded('password-file', opts.passwordFile);
  }

  const idempotencyKey = opts.idempotencyKey ?? `cli-proj-create-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  const body: CliCreateProjectRequest = {
    type: opts.type,
    name: opts.name,
    ...(opts.targetUrl !== undefined ? { targetUrl: opts.targetUrl } : {}),
    ...(opts.username !== undefined ? { username: opts.username } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(opts.instruction !== undefined ? { instruction: opts.instruction } : {}),
    ...(opts.testIdAttributes !== undefined ? { testIdAttributes: opts.testIdAttributes } : {}),
  };

  const client = makeClient(opts, deps);
  let rawCreated: CliCreateProjectResponse;
  try {
    rawCreated = await client.post<CliCreateProjectResponse>('/projects', {
      body,
      headers: { 'idempotency-key': idempotencyKey },
    });
  } catch (err) {
    throw translateUnsupportedTestIdAttributes(err, body.testIdAttributes !== undefined);
  }
  // Normalize whichever id field name the backend actually
  // sent onto BOTH `projectId` and `id`, so JSON consumers keyed on either
  // name keep working regardless of which one the live response used.
  const resolvedId = resolveCreatedProjectId(rawCreated);
  const created: CliCreateProjectResponse = {
    ...rawCreated,
    ...(resolvedId !== undefined ? { projectId: resolvedId, id: resolvedId } : {}),
  };

  out.print(created, data => renderCreateProjectText(data as CliCreateProjectResponse));

  // A backend project created without --url has no default environment URL.
  // On the V3 execution path, the shared admission guard (`runProjectGuarded`
  // -> `assertProjectEnvNotLocal`, called by every V3 run/rerun/batch entry
  // point, including `backendRun`) rejects the FIRST run of any test in the
  // project with 400 no-target-resolvable. On the V2 path (`cli-run.service.ts`
  // -> `resolveRunPrereqsFE`), this URL resolution is frontend-only and is
  // never applied to a backend run, so a V2-routed backend project without a
  // URL runs fine — V2 is the only execution path live in production today
  // (V3 is dev-only pending its own GA release), so the wording below is
  // conditioned on V3 rather than stated as a universal consequence.
  // `--url` is intentionally NOT made mandatory here (that would break the
  // published --help contract: npm 0.4.0 already ships text saying the URL
  // is frontend-only), so this stays advisory-only. The CLI does not call
  // GET /me here to check the caller's actual v3Enabled routing before
  // deciding whether to print this — an extra round-trip on every create is
  // not worth it just to gate a hint — so it points the reader at `auth
  // status` (which already renders the routing: v2|v3 line) instead.
  // Emitted in EVERY output mode, including --output json: this goes to
  // stderr, which never touches JSON stdout, so there is nothing to protect
  // by suppressing it (unlike `emitV3RoutingAdvisory`, which withholds
  // account-context advisory in JSON mode because a JSON caller can read
  // `v3Enabled` directly instead — there is no equivalent structured signal
  // for this one). And --output json is precisely the case that needs it
  // most: a script or agent creating a project non-interactively has no one
  // watching a terminal, so a silent dead-on-arrival project only surfaces
  // later as an unexplained 400 on the first run. Same family as the C1
  // `--target-url` advisory above (a flag/setup the caller just made has a
  // structural consequence) rather than the routing-advisory family.
  // Real path only — NOT duplicated into the dry-run branch above, because
  // the remedy command below embeds the created project id, and under
  // --dry-run that id is the canned `p_dryrun_2026` sample: emitting a
  // live-looking fix-it command against a fake resource is exactly what the
  // `dashboardUrl` convention (see CLAUDE.md) already decided to suppress.
  if (opts.type === 'backend' && !opts.targetUrl) {
    stderr(
      `[advisory] this backend project has no default environment URL. On the V3 execution ` +
        `path (check with \`testsprite auth status\`), test runs are rejected with ` +
        `no-target-resolvable until one is set. Fix: testsprite project update ` +
        `${resolvedId ?? '<project-id>'} --url <url>`,
    );
  }

  return created;
}

// ---------------------------------------------------------------------------
// project update
// ---------------------------------------------------------------------------

/**
 * Response shape for `PATCH /projects/{id}`.
 *
 * Same `id`-field drift as `CliCreateProjectResponse` — both
 * names are accepted and normalized (see `resolveUpdatedProjectId`), and
 * `updatedAt` is optional since the live response may omit it.
 */
export interface CliUpdateProjectResponse {
  /** Preferred — matches the live backend's response and `project delete`'s `projectId`. */
  projectId?: string;
  /** Legacy/fallback name; some responses use this instead. */
  id?: string;
  /** Backend may omit this field; treat absence as no specific fields reported. */
  updatedFields?: string[];
  /** Absent-safe: not guaranteed on every backend response. */
  updatedAt?: string;
}

/** Resolve the updated project's id regardless of which field name the backend used. */
export function resolveUpdatedProjectId(r: CliUpdateProjectResponse): string | undefined {
  return r.projectId ?? r.id;
}

interface UpdateOptions extends CommonOptions {
  projectId: string;
  name?: string;
  targetUrl?: string;
  username?: string;
  password?: string;
  passwordFile?: string;
  instruction?: string;
  /** Ordered test-id attribute list; `clearTestIdAttributes` sends `null` to unset. */
  testIdAttributes?: string[];
  clearTestIdAttributes?: boolean;
  idempotencyKey?: string;
}

export async function runUpdate(
  opts: UpdateOptions,
  deps: ProjectDeps = {},
): Promise<CliUpdateProjectResponse> {
  const out = makeOutput(opts.output, deps);
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  // P1-2: validate idempotency key before sending as an HTTP header.
  assertIdempotencyKey(opts.idempotencyKey);

  // P1-3: client-side length checks matching server limits.
  // Reject a whitespace-only `--name` on update too (parity with create); name
  // stays optional here, so only validate when the flag is supplied.
  if (opts.name !== undefined && opts.name.trim().length === 0) {
    throw localValidationError('--name must not be empty or whitespace-only');
  }
  if (opts.password !== undefined && opts.password.trim().length === 0) {
    throw localValidationError('--password must not be empty or whitespace-only');
  }
  if (opts.name !== undefined && opts.name.length > 200) {
    throw localValidationError('--name must be at most 200 characters');
  }
  // P2-7: guard --url against localhost/RFC1918/non-http(s).
  if (opts.targetUrl !== undefined) {
    assertNotLocal(opts.targetUrl, {
      field: 'url',
      helpCommand: 'testsprite project update',
      hintContext: 'bootstrap',
    });
  }

  if (opts.testIdAttributes !== undefined && opts.clearTestIdAttributes) {
    throw localValidationError(
      '--test-id-attributes and --clear-test-id-attributes are mutually exclusive.',
    );
  }
  const passwordSupplied = opts.password !== undefined || opts.passwordFile !== undefined;
  const mutableFields: Record<string, boolean> = {
    name: opts.name !== undefined,
    targetUrl: opts.targetUrl !== undefined,
    username: opts.username !== undefined,
    password: passwordSupplied,
    instruction: opts.instruction !== undefined,
    testIdAttributes: opts.testIdAttributes !== undefined || opts.clearTestIdAttributes === true,
  };
  const presentFieldNames = Object.entries(mutableFields)
    .filter(([, present]) => present)
    .map(([field]) => field);
  if (presentFieldNames.length === 0) {
    throw localValidationError(
      'At least one mutable flag is required: --name, --url, --username, --password/--password-file, ' +
        '--instruction, --test-id-attributes, or --clear-test-id-attributes.',
    );
  }

  if (opts.dryRun) {
    // DEV-247: emit the banner here (this path returns before makeClient() does).
    emitDryRunBanner(stderr);
    const idempotencyKey = opts.idempotencyKey ?? `cli-proj-update-${randomUUID()}`;
    if (
      opts.idempotencyKey === undefined &&
      (opts.output === 'json' || opts.verbose || opts.debug)
    ) {
      stderr(`idempotency-key: ${idempotencyKey}`);
    }
    // Teach both id field names — `projectId` is the field the
    // live backend actually sends; `id` is kept so this sample still matches
    // callers written against the pre-fix shape.
    const sample: CliUpdateProjectResponse = {
      projectId: opts.projectId,
      id: opts.projectId,
      updatedFields: presentFieldNames,
      updatedAt: '2026-05-16T00:00:00.000Z',
    };
    out.print(sample, data => renderUpdateText(data as CliUpdateProjectResponse));
    return sample;
  }

  // Resolve password only on the real path. Dry-run must not touch the
  // filesystem, even when --password-file is present.
  let password = opts.password;
  if (password === undefined && opts.passwordFile !== undefined) {
    password = readSecretFileGuarded('password-file', opts.passwordFile);
  }

  const idempotencyKey = opts.idempotencyKey ?? `cli-proj-update-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  const bodyFields: Record<string, string | string[] | null | undefined> = {
    name: opts.name,
    targetUrl: opts.targetUrl,
    username: opts.username,
    password,
    instruction: opts.instruction,
    // `null` clears the list server-side (same convention as `test update --clear-step-timeout`).
    testIdAttributes: opts.clearTestIdAttributes ? null : opts.testIdAttributes,
  };
  const body = Object.fromEntries(
    Object.entries(bodyFields).filter(([, v]) => v !== undefined),
  ) as Record<string, string | string[] | null>;
  const client = makeClient(opts, deps);
  let rawUpdated: CliUpdateProjectResponse;
  try {
    rawUpdated = await client.patch<CliUpdateProjectResponse>(
      `/projects/${encodeURIComponent(opts.projectId)}`,
      {
        body,
        headers: { 'idempotency-key': idempotencyKey },
      },
    );
  } catch (err) {
    throw translateUnsupportedTestIdAttributes(err, 'testIdAttributes' in body);
  }
  // Normalize whichever id field name the backend actually
  // sent onto BOTH `projectId` and `id`, so JSON consumers keyed on either
  // name keep working regardless of which one the live response used.
  const resolvedUpdatedId = resolveUpdatedProjectId(rawUpdated);
  const updated: CliUpdateProjectResponse = {
    ...rawUpdated,
    ...(resolvedUpdatedId !== undefined
      ? { projectId: resolvedUpdatedId, id: resolvedUpdatedId }
      : {}),
  };

  out.print(updated, data => renderUpdateText(data as CliUpdateProjectResponse));
  return updated;
}

// ---------------------------------------------------------------------------
// project delete
// ---------------------------------------------------------------------------

export interface CliDeleteProjectResponse {
  projectId: string;
  deletedAt: string;
}

interface DeleteOptions extends CommonOptions {
  projectId: string;
  /** Hard gate — required (unless `--dry-run` is set). No interactive prompts. */
  confirm: boolean;
  /** Caller-supplied idempotency token; UUIDv4 minted client-side if absent. */
  idempotencyKey?: string;
}

/**
 * `project delete <project-id> --confirm` — permanent cascade delete via
 * DELETE /projects/{id}.
 *
 * The server deletes the project together with everything under it — its
 * frontend/backend sub-projects, all their tests, and backend fixtures —
 * matching the Portal's own delete behavior. There is no restore window.
 *
 * **`--confirm` is required** (unless `--dry-run`). Without either, the CLI
 * exits 5 `VALIDATION_ERROR` with a typed envelope explaining the convention.
 * The CLI never prompts interactively (CI-friendly contract). Re-delete on an already-deleted (or missing) project returns 404 from
 * the server; the CLI surfaces the envelope as-is (exit 4), no client branching.
 */
export async function runDelete(
  opts: DeleteOptions,
  deps: ProjectDeps = {},
): Promise<CliDeleteProjectResponse> {
  assertIdempotencyKey(opts.idempotencyKey);
  if (opts.projectId === undefined || opts.projectId.trim().length === 0) {
    throw localValidationError('<project-id> is required');
  }

  if (!opts.confirm && !opts.dryRun) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Refusing to delete without --confirm.',
        nextAction:
          'This permanently deletes the project and everything under it — its ' +
          'sub-projects, all their tests, and backend fixtures (no restore window). ' +
          'The CLI convention is explicit confirmation for destructive operations. ' +
          'Re-run with --confirm. (--dry-run also works without --confirm.)',
        requestId: 'local',
        details: { field: 'confirm', reason: 'required for destructive operation' },
      },
    });
  }

  const idempotencyKey = opts.idempotencyKey ?? `cli-delete-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  const client = makeClient(opts, deps);
  const out = makeOutput(opts.output, deps);
  const response = await client.delete<CliDeleteProjectResponse>(
    `/projects/${encodeURIComponent(opts.projectId)}`,
    {
      headers: { 'idempotency-key': idempotencyKey },
    },
  );

  out.print(response, data => renderDeleteText(data as CliDeleteProjectResponse));
  return response;
}

// ---------------------------------------------------------------------------
// project credential — set the static backend credential
// ---------------------------------------------------------------------------

const CLI_AUTH_TYPES = ['public', 'Bearer token', 'API key', 'basic token'] as const;

export interface CliProjectCredentialResponse {
  projectId: string;
  authType: string;
  rewroteCount: number;
}

interface CredentialOptions extends CommonOptions {
  projectId: string;
  authType: string;
  credential?: string;
  credentialFile?: string;
  idempotencyKey?: string;
}

export async function runCredential(
  opts: CredentialOptions,
  deps: ProjectDeps = {},
): Promise<CliProjectCredentialResponse> {
  const out = makeOutput(opts.output, deps);
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  assertIdempotencyKey(opts.idempotencyKey);

  if (!(CLI_AUTH_TYPES as readonly string[]).includes(opts.authType)) {
    throw localValidationError(`--type must be one of: ${CLI_AUTH_TYPES.join(', ')}`);
  }

  // Resolve the credential value (flag or file). Required for every type
  // except `public` (which clears it).
  let credential = opts.credential;
  if (credential === undefined && opts.credentialFile !== undefined) {
    credential = readFileSync(opts.credentialFile, 'utf8').trim();
  }
  if (opts.authType !== 'public' && (credential === undefined || credential === '')) {
    throw localValidationError(
      '--credential (or --credential-file) is required unless --type is "public"',
    );
  }

  const body: Record<string, string> = { authType: opts.authType };
  if (opts.authType !== 'public' && credential !== undefined) body.credential = credential;

  const idempotencyKey = opts.idempotencyKey ?? `cli-proj-cred-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  if (opts.dryRun) {
    const sample: CliProjectCredentialResponse = {
      projectId: opts.projectId,
      authType: opts.authType,
      rewroteCount: 0,
    };
    out.print(sample, data => renderCredentialText(data as CliProjectCredentialResponse));
    return sample;
  }

  const client = makeClient(opts, deps);
  const res = await client.put<CliProjectCredentialResponse>(
    `/projects/${encodeURIComponent(opts.projectId)}/credential`,
    { body, headers: { 'idempotency-key': idempotencyKey } },
  );
  out.print(res, data => renderCredentialText(data as CliProjectCredentialResponse));
  return res;
}

function renderCredentialText(r: CliProjectCredentialResponse): string {
  return [
    `projectId    ${r.projectId}`,
    `authType     ${r.authType}`,
    `rewroteCount ${r.rewroteCount}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// project auto-auth — configure the recurring-token (auto-refresh) login
// ---------------------------------------------------------------------------

const AUTO_AUTH_METHODS = ['password', 'refresh_token', 'aws_cognito_refresh'] as const;
const AUTO_AUTH_INJECTS = ['bearer', 'header', 'cookie'] as const;

export interface CliProjectAutoAuthResponse {
  projectId: string;
  enabled: boolean;
  method: string;
  inject: string;
  /**
   * Present when the server's trial refresh failed: `enabled` is then `false`
   * and this carries the reason (e.g. a bad refresh token). The config is still
   * stored, but auto-auth won't run until the login succeeds.
   */
  lastRefreshError?: string;
}

interface AutoAuthOptions extends CommonOptions {
  projectId: string;
  disable?: boolean;
  method: string;
  inject: string;
  injectKey?: string;
  // password method
  loginUrl?: string;
  loginMethod?: string;
  loginContentType?: string;
  loginBodyTemplate?: string;
  username?: string;
  password?: string;
  passwordFile?: string;
  tokenPath?: string;
  // refresh_token method
  tokenEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
  clientSecretFile?: string;
  refreshToken?: string;
  refreshTokenFile?: string;
  scope?: string;
  // aws_cognito_refresh method
  region?: string;
  idempotencyKey?: string;
}

export async function runAutoAuth(
  opts: AutoAuthOptions,
  deps: ProjectDeps = {},
): Promise<CliProjectAutoAuthResponse> {
  const out = makeOutput(opts.output, deps);
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  assertIdempotencyKey(opts.idempotencyKey);

  if (!(AUTO_AUTH_METHODS as readonly string[]).includes(opts.method)) {
    throw localValidationError(`--method must be one of: ${AUTO_AUTH_METHODS.join(', ')}`);
  }
  if (!(AUTO_AUTH_INJECTS as readonly string[]).includes(opts.inject)) {
    throw localValidationError(`--inject must be one of: ${AUTO_AUTH_INJECTS.join(', ')}`);
  }

  // Resolve secrets from --*-file variants so they stay out of shell history.
  const password =
    opts.password ??
    (opts.passwordFile !== undefined ? readFileSync(opts.passwordFile, 'utf8').trim() : undefined);
  const clientSecret =
    opts.clientSecret ??
    (opts.clientSecretFile !== undefined
      ? readFileSync(opts.clientSecretFile, 'utf8').trim()
      : undefined);
  const refreshToken =
    opts.refreshToken ??
    (opts.refreshTokenFile !== undefined
      ? readFileSync(opts.refreshTokenFile, 'utf8').trim()
      : undefined);

  const enabled = opts.disable !== true;
  const body: Record<string, unknown> = { enabled, method: opts.method, inject: opts.inject };
  const maybe = (k: string, v: string | undefined): void => {
    if (v !== undefined) body[k] = v;
  };
  maybe('injectKey', opts.injectKey);
  maybe('loginUrl', opts.loginUrl);
  maybe('loginMethod', opts.loginMethod);
  maybe('loginContentType', opts.loginContentType);
  maybe('loginBodyTemplate', opts.loginBodyTemplate);
  maybe('username', opts.username);
  maybe('password', password);
  maybe('tokenPath', opts.tokenPath);
  maybe('tokenEndpoint', opts.tokenEndpoint);
  maybe('clientId', opts.clientId);
  maybe('clientSecret', clientSecret);
  maybe('refreshToken', refreshToken);
  maybe('scope', opts.scope);
  maybe('region', opts.region);

  const idempotencyKey = opts.idempotencyKey ?? `cli-proj-autoauth-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  if (opts.dryRun) {
    const sample: CliProjectAutoAuthResponse = {
      projectId: opts.projectId,
      enabled,
      method: opts.method,
      inject: opts.inject,
    };
    out.print(sample, data => renderAutoAuthText(data as CliProjectAutoAuthResponse));
    return sample;
  }

  const client = makeClient(opts, deps);
  const res = await client.put<CliProjectAutoAuthResponse>(
    `/projects/${encodeURIComponent(opts.projectId)}/auto-auth`,
    { body, headers: { 'idempotency-key': idempotencyKey } },
  );
  out.print(res, data => renderAutoAuthText(data as CliProjectAutoAuthResponse));
  return res;
}

function renderAutoAuthText(r: CliProjectAutoAuthResponse): string {
  const lines = [
    `projectId ${r.projectId}`,
    `enabled   ${r.enabled}`,
    `method    ${r.method}`,
    `inject    ${r.inject}`,
  ];
  if (r.lastRefreshError) {
    lines.push(`lastRefreshError ${r.lastRefreshError}`);
  }
  // A disabled result after a write means the trial login failed — call it out
  // so the user doesn't assume auto-auth is live.
  if (!r.enabled) {
    lines.push(
      'note      auto-auth was stored but is DISABLED — the trial login failed. Fix the credentials (e.g. a valid refresh token) and re-run.',
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// project docs upload — DEV-384 piece V3-D
// ---------------------------------------------------------------------------

/**
 * CLI-facing role flags → wire enum. Default is `api-doc` (stated in help);
 * no inference from project type in v1 (design §3.4).
 */
const DOC_ROLES = { 'api-doc': 'API_DOC', prd: 'PRD' } as const;
type DocRoleFlag = keyof typeof DOC_ROLES;
type DocRoleWire = (typeof DOC_ROLES)[DocRoleFlag];

/**
 * MIME type sent in step 1 and echoed on the step-2 PUT. The backend signs
 * `ContentType` into the presigned URL when supplied, so the PUT's
 * `Content-Type` header must be byte-identical to what step 1 declared —
 * both come from this one lookup, so they cannot drift.
 */
const DOC_CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
};
const DEFAULT_DOC_CONTENT_TYPE = 'application/octet-stream';

/** `POST /projects/{id}/docs/upload-url` response (V3-A facade). */
export interface CliDocsUploadUrlResponse {
  uploadUrl: string;
  s3Key: string;
  expiresInSeconds: number;
}

/** `POST /projects/{id}/docs` (register) response (V3-A facade). */
export interface CliDocsRegisterResponse {
  resourceId: string;
  displayName: string;
  docRole: DocRoleWire | null;
  processStatus: string;
}

/** Success result — the JSON-mode stdout shape (piece V3-D scope item 3). */
export interface CliDocsUploadResult {
  resourceId: string;
  displayName: string;
  role: DocRoleWire | null;
  size: number;
  processStatus: string;
}

/** Dry-run result: the would-be plan. Zero network, nothing read beyond a stat. */
export interface CliDocsUploadPlan {
  dryRun: true;
  projectId: string;
  file: string;
  fileName: string;
  displayName: string;
  role: DocRoleWire;
  contentType: string;
  size: number;
  steps: string[];
}

interface DocsUploadOptions extends CommonOptions {
  file: string;
  projectId?: string;
  role?: string;
  name?: string;
  idempotencyKey?: string;
}

/**
 * `project docs upload <file>` — upload an API spec or PRD as a project
 * source so plan generation has inputs to feed on (closes the API-project
 * cold start at `no_processed_inputs`).
 *
 * Three-step flow against the V3-A facade routes:
 *
 *   1. `POST /projects/{id}/docs/upload-url` — mints a one-hour presigned
 *      S3 PUT URL plus the S3 key to register afterwards.
 *   2. HTTP PUT of the file bytes to the presigned URL — **streamed**
 *      (`createReadStream` → web stream), never buffering the whole file.
 *      This request goes straight to S3: no facade base URL, no API key.
 *   3. `POST /projects/{id}/docs` — registers the S3 object with its role
 *      and display name, which starts processing + embedding.
 *
 * Reading the local file as INPUT is allowed by DR-21 (the no-local-OUTPUTS
 * rule); nothing is ever written back to disk.
 *
 * Failure modes are deliberately distinguished (design non-negotiable): a
 * step-2 failure names the presigned PUT and the fix (re-running mints a
 * fresh URL — they expire); a step-3 failure preserves the server envelope
 * and says the upload already succeeded (re-running is safe: the server
 * upserts the document by S3 key, so no duplicate is created).
 */
export async function runDocsUpload(
  opts: DocsUploadOptions,
  deps: ProjectDeps = {},
): Promise<CliDocsUploadResult | CliDocsUploadPlan> {
  const out = makeOutput(opts.output, deps);
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  assertIdempotencyKey(opts.idempotencyKey);

  const projectId = requireDocsProjectId(opts.projectId, deps);
  const roleFlag = opts.role ?? 'api-doc';
  if (!(roleFlag in DOC_ROLES)) {
    throw localValidationError(
      '--role must be api-doc (API spec, the default) or prd (product requirements document)',
    );
  }
  const role: DocRoleWire = DOC_ROLES[roleFlag as DocRoleFlag];

  if (opts.name !== undefined && opts.name.trim().length === 0) {
    throw localValidationError('--name must not be empty or whitespace-only');
  }
  if (opts.name !== undefined && opts.name.length > 255) {
    throw localValidationError('--name must be at most 255 characters');
  }

  if (opts.file === undefined || opts.file.trim().length === 0) {
    throw localValidationError('<file> is required');
  }
  // Size + existence sanity via stat only — the dry-run contract is "nothing
  // read beyond a stat", and the real path opens the file exactly once, in
  // the streamed PUT below.
  let stat: Stats;
  try {
    stat = statSync(opts.file);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw localValidationError(`file does not exist: ${opts.file}`);
    }
    throw localValidationError(
      `cannot stat file ${opts.file}: ${(cause as Error).message ?? String(cause)}`,
    );
  }
  if (!stat.isFile()) {
    throw localValidationError(`${opts.file} is not a regular file (is it a directory?)`);
  }
  if (stat.size === 0) {
    throw localValidationError(`file is empty (0 bytes), nothing to upload: ${opts.file}`);
  }

  const fileName = basename(opts.file);
  if (fileName.length > 255) {
    throw localValidationError(
      'the file name (basename) must be at most 255 characters — rename the file ' +
        '(--name only changes the display name, not the stored file name)',
    );
  }
  const displayName = opts.name ?? fileName;
  const contentType =
    DOC_CONTENT_TYPES[extname(fileName).toLowerCase()] ?? DEFAULT_DOC_CONTENT_TYPE;
  const projectPath = encodeURIComponent(projectId);

  if (opts.dryRun) {
    // Same inline early-exit family as `test delete-batch --dry-run`: the
    // command's dry-run contract (zero network, stat only, print the plan)
    // cannot be expressed through canned fetch samples — step 2 would have
    // to PUT somewhere. The `docsUploadUrl`/`docsRegister` entries in
    // `samples.ts` are shape-guards/documentation, not consumed here.
    emitDryRunBanner(stderr);
    const plan: CliDocsUploadPlan = {
      dryRun: true,
      projectId,
      file: opts.file,
      fileName,
      displayName,
      role,
      contentType,
      size: stat.size,
      steps: [
        `POST /projects/${projectId}/docs/upload-url — mint a presigned S3 PUT URL for ${fileName} (${contentType})`,
        `PUT ${stat.size} bytes to the presigned URL (streamed from disk, never buffered)`,
        `POST /projects/${projectId}/docs — register ${displayName} as ${role}; starts processing + embedding`,
      ],
    };
    out.print(plan, data => renderDocsUploadPlanText(data as CliDocsUploadPlan));
    return plan;
  }

  const idempotencyKey = opts.idempotencyKey ?? `cli-docs-upload-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  const client = makeClient(opts, deps);

  // ── Step 1 of 3: mint the presigned upload URL ────────────────────────────
  const minted = await client.post<CliDocsUploadUrlResponse>(
    `/projects/${projectPath}/docs/upload-url`,
    { body: { fileName, contentType } },
  );

  // ── Step 2 of 3: stream the file bytes to S3 ──────────────────────────────
  // Straight to the presigned host with the raw fetch impl — NOT through
  // HttpClient, which would attach the facade base URL and leak the API key
  // to S3. Content-Length comes from the stat: S3 rejects chunked
  // transfer-encoding on presigned PUTs, and Node's fetch uses the explicit
  // header to keep identity framing with a streamed body.
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  // DEV-384 review F3: a remote facade must mint a non-local https URL.
  assertSafePresignedUploadUrl(minted.uploadUrl, client.resolvedBaseUrl);
  // Same flag > TESTSPRITE_REQUEST_TIMEOUT_MS > default resolution (and 1-600s
  // clamp) as makeHttpClient — this leg bypasses HttpClient, so resolve here.
  const requestTimeoutMs = resolveRequestTimeoutMs(opts, deps.env ?? process.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  // DEV-384 review F14b: compose the shutdown signal into the PUT abort
  // (manual listeners, house style — no AbortSignal.any) and arm the
  // graceful scope for the upload's duration, so Ctrl-C during a long PUT
  // takes the honest DEV-331 detach path instead of being unabortable.
  const shutdown = deps.shutdown ?? globalShutdown;
  const shutdownSignal = shutdown.signal;
  const onShutdownAbort = (): void => controller.abort(shutdownSignal.reason);
  const disarm = shutdown.arm();
  if (shutdownSignal.aborted) onShutdownAbort();
  else shutdownSignal.addEventListener('abort', onShutdownAbort, { once: true });
  let putResponse: Response;
  try {
    putResponse = await fetchImpl(minted.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': contentType, 'content-length': String(stat.size) },
      body: Readable.toWeb(createReadStream(opts.file)) as unknown as RequestInit['body'],
      duplex: 'half',
      // #342 review: assertSafePresignedUploadUrl vets the MINTED url, but a
      // default `redirect: 'follow'` would let a 3xx from that host resend
      // the request to an unvetted Location (e.g. a 303 → 169.254.169.254) —
      // an SSRF-shaped hop the guard never sees. A real S3 presigned PUT never
      // redirects, so refuse: the thrown TypeError falls through to the catch
      // below as a normal `presigned_put_failed` (no new error reason).
      redirect: 'error',
      signal: controller.signal,
    } as RequestInit);
  } catch (cause) {
    // Interrupt outranks the timeout mapping: a Ctrl-C-aborted fetch must
    // surface as InterruptError (exit 130/143), never as a timeout.
    if (cause instanceof InterruptError) throw cause;
    if (shutdownSignal.aborted) throw shutdownSignal.reason;
    // Any other abort here is ours (the per-request timer): map to the CLI's
    // typed exit-7 timeout, same contract as HttpClient's per-request timeout.
    if (isAbortError(cause)) {
      throw new RequestTimeoutError(requestTimeoutMs);
    }
    throw presignedPutError(
      `network error before S3 responded: ${describeCause(cause)}`,
      minted.expiresInSeconds,
    );
  } finally {
    clearTimeout(timer);
    shutdownSignal.removeEventListener('abort', onShutdownAbort);
    disarm();
  }
  if (!putResponse.ok) {
    const snippet = (await putResponse.text().catch(() => '')).slice(0, 300);
    throw presignedPutError(
      `S3 returned HTTP ${putResponse.status}${snippet ? ` — ${snippet}` : ''}`,
      minted.expiresInSeconds,
    );
  }

  // ── Step 3 of 3: register the uploaded object ─────────────────────────────
  let registered: CliDocsRegisterResponse;
  try {
    registered = await client.post<CliDocsRegisterResponse>(`/projects/${projectPath}/docs`, {
      body: { s3Key: minted.s3Key, displayName, docRole: role },
      headers: { 'idempotency-key': idempotencyKey },
    });
  } catch (cause) {
    if (cause instanceof ApiError) throw registerStepError(cause);
    // DEV-384 review F4: a register timeout needs the same step-3 context —
    // it is precisely the case where the caller can't tell whether the
    // register landed. Class and exit 7 are preserved; only the text gains
    // the upload-succeeded / safe-to-re-run explanation.
    if (cause instanceof RequestTimeoutError) {
      cause.message =
        `Document register timed out (step 3 of 3) — the S3 upload succeeded, and the ` +
        `register may or may not have landed. ${cause.message} Re-running the whole command ` +
        `is safe: the server upserts the document by its S3 key (no duplicate is created; a PRD re-register re-runs the embedding compute, but the embedding charge is idempotent per document — never billed twice).`;
      throw cause;
    }
    throw cause;
  }

  const result: CliDocsUploadResult = {
    resourceId: registered.resourceId,
    displayName: registered.displayName ?? displayName,
    role: registered.docRole ?? role,
    size: stat.size,
    processStatus: registered.processStatus,
  };
  out.print(result, data => renderDocsUploadText(data as CliDocsUploadResult));
  return result;
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError';
}

function describeCause(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  // undici wraps network failures as `TypeError: fetch failed` with the
  // useful detail on `.cause` — surface both.
  const nested = (cause as { cause?: unknown }).cause;
  const nestedMsg = nested instanceof Error ? ` (${nested.message})` : '';
  return `${cause.message}${nestedMsg}`;
}

/**
 * DEV-384 review F3 — defense-in-depth on the server-minted presigned URL.
 *
 * A REMOTE facade must mint a non-local `https:` URL; a localhost/private or
 * plain-http mint from a remote facade is exactly the anomaly to reject
 * (compromised/misconfigured facade or an active MITM) — the PUT would
 * otherwise send the user's file wherever that URL points, before any bytes
 * leave the machine. A facade that is ITSELF loopback (dev rig, localhost
 * e2e) is a deliberate operator configuration and is trusted to mint local
 * URLs — and ONLY loopback qualifies (#342 review): the gate is a positive,
 * fail-closed check, because gating on "anything `assertNotLocal` dislikes"
 * would silently disable the guard for an unparsable base URL or a
 * user-settable private-range endpoint (`--endpoint-url https://10.1.2.3`).
 * Literal checks only (same scope as `assertNotLocal`); no host
 * allow-listing by design.
 *
 * Known residual (#342 review): a loopback facade that is really a TUNNEL to a
 * remote backend (`ssh -L`, a localhost corporate proxy) is trusted here even
 * though the real conversation is remote and MITM-able upstream. This is
 * inherent to "loopback facade = trusted dev rig" and accepted — the CLI
 * cannot tell a dev rig from a tunnel by the base URL alone.
 */
function assertSafePresignedUploadUrl(uploadUrl: string, facadeBaseUrl: string): void {
  if (isLoopbackFacade(facadeBaseUrl)) return;
  const reject = (reason: string): never => {
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: `Refusing the presigned upload URL the server returned: ${reason}.`,
        nextAction:
          'No bytes were uploaded. This can indicate a misconfigured or intercepted API ' +
          'endpoint — verify --endpoint-url / TESTSPRITE_API_URL and retry.',
        requestId: 'local',
        details: { field: 'uploadUrl', reason: 'unsafe_presigned_url' },
      },
    });
  };
  let parsed: URL;
  try {
    parsed = new URL(uploadUrl);
  } catch {
    return reject('it is not a valid URL');
  }
  if (parsed.protocol !== 'https:') return reject('it is not https');
  if (isLocalUrl(uploadUrl)) return reject('it points at a local/private address');
}

/** True when `assertNotLocal` rejects the URL (localhost, RFC1918, link-local,
 *  metadata, non-http(s), unparsable). Fail-closed in the REJECTION direction
 *  only — used to refuse a suspicious mint, never to grant trust (that side
 *  is `isLoopbackFacade`). */
function isLocalUrl(url: string): boolean {
  try {
    assertNotLocal(url, {
      field: 'upload-url',
      helpCommand: 'testsprite project docs upload',
    });
    return false;
  } catch {
    return true;
  }
}

/**
 * #342 review: the facade-trust gate for `assertSafePresignedUploadUrl`.
 * Positive and narrow — only an explicitly-loopback facade (`localhost`,
 * a `127.0.0.0/8` literal, or `[::1]`) is trusted to mint local upload URLs.
 * Anything else — including an unparsable base URL or a private-range
 * endpoint — leaves the guard ON.
 */
function isLoopbackFacade(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // `localhost.` is the fully-qualified form of `localhost` (RFC 6761).
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost') return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  return host === '[::1]';
}

/**
 * Step-2 failure: the presigned PUT to S3. Distinguished from a register
 * failure per the design non-negotiable — the fix is different (re-running
 * re-mints the URL; nothing was registered, so nothing is half-done).
 */
function presignedPutError(detail: string, expiresInSeconds: number): ApiError {
  return new ApiError({
    code: 'UNAVAILABLE',
    message: `Presigned S3 upload failed (step 2 of 3): ${detail}`,
    nextAction:
      'The document was NOT registered. Re-run the command — each run mints a fresh ' +
      `upload URL (presigned URLs expire, this one after ${Math.round(expiresInSeconds / 60)} minutes).`,
    requestId: 'local',
    details: { reason: 'presigned_put_failed' },
  });
}

/**
 * Step-3 failure: register. The server envelope (code, exit, requestId,
 * details) passes through unchanged; only the text gains step context so
 * the caller knows the upload itself already landed and a re-run is safe
 * (the server upserts the document by S3 key — no duplicate).
 */
function registerStepError(cause: ApiError): ApiError {
  return new ApiError(
    {
      code: cause.code,
      message: `Document register failed (step 3 of 3) — the S3 upload succeeded, but the document is not registered yet. ${cause.message}`,
      nextAction:
        `${cause.nextAction ? `${cause.nextAction} ` : ''}` +
        'Re-running the whole command is safe: the same file re-uploads and the server ' +
        'upserts the document by its S3 key (no duplicate is created; a PRD re-register re-runs the embedding compute, but the embedding charge is idempotent per document — never billed twice).',
      requestId: cause.requestId,
      details: cause.details,
    },
    cause.httpStatus,
    cause.retryAfterMs,
  );
}

function formatDocSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderDocsUploadText(r: CliDocsUploadResult): string {
  return [
    `uploaded ${r.displayName} (${formatDocSize(r.size)}) — processing started`,
    'note: generation can use this source once processing and embedding finish',
    '      (check with `testsprite test plan generate` — it says if inputs are still processing)',
  ].join('\n');
}

function renderDocsUploadPlanText(p: CliDocsUploadPlan): string {
  return [
    `would upload ${p.file} (${formatDocSize(p.size)}) to project ${p.projectId} as ${p.role}:`,
    ...p.steps.map((step, i) => `  ${i + 1}. ${step}`),
  ].join('\n');
}

export function createProjectCommand(deps: ProjectDeps = {}): Command {
  const project = new Command('project').description('Manage TestSprite projects');

  project
    .command('list')
    .description(
      'List projects visible to the API key\n' +
        '\nExit codes:\n' +
        '  0  success\n' +
        '  3  auth error\n' +
        '  5  validation error (e.g., bad --page-size)\n' +
        ' 10  transport/network failure (UNAVAILABLE) — retry the command',
    )
    .option('--page-size <n>', 'service page-size hint (1-100, default 25)')
    .option('--starting-token <token>', 'opaque cursor from a previous list response')
    .option('--max-items <n>', 'stop after this many items across auto-paged pages')
    .option('--columns <list>', 'select/reorder text table columns (comma-separated keys)')
    .option('--no-header', 'suppress the text table header row')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts: ListFlagOpts, command: Command) => {
      // Don't parse numeric flags via Commander — its parser throws a
      // plain `Error`, which `index.ts` maps to exit code 1. Local
      // validation lives in `runList → validatePaginationFlags`, which
      // raises a typed `ApiError(VALIDATION_ERROR)` and surfaces with
      // the contract-mandated exit code 5.
      await runList(
        {
          ...resolveCommonOptions(command),
          pageSize: parseFlag(cmdOpts.pageSize, 'page-size'),
          startingToken: cmdOpts.startingToken,
          maxItems: parseFlag(cmdOpts.maxItems, 'max-items'),
          columns: cmdOpts.columns,
          noHeader: cmdOpts.header === false,
        },
        deps,
      );
    });

  project
    .command('get <project-id>')
    .description('Get a project by id')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (projectId: string, _cmdOpts, command: Command) => {
      await runGet({ ...resolveCommonOptions(command), projectId }, deps);
    });

  project
    .command('create')
    .description('Create a new project')
    .option('--type <frontend|backend>', 'project type (required)')
    .option('--name <name>', 'project name (required)')
    .option(
      '--url <url>',
      'target URL (required for frontend; also required for backend on the V3 execution ' +
        'path — see `auth status` for your routing)',
    )
    .option(
      '--description <text>',
      'not supported — projects have no description (test-level descriptions are set on `test create`)',
    )
    .option('--username <user>', 'optional auth username')
    .option('--password <pw>', 'optional auth password (use --password-file for non-interactive)')
    .option('--password-file <path>', 'read password from file instead of inline flag')
    .option('--instruction <text>', 'optional FE plan-gen instruction hint')
    .option(
      '--test-id-attributes <list>',
      'comma-separated DOM attributes the engine should prefer as locators, highest priority first ' +
        '(e.g. data-element,data-testid). Unique values are exported as page.locator(\'[attr="…"]\').',
    )
    .option(
      '--idempotency-key <token>',
      'opaque idempotency token. Defaults to a UUIDv4 minted per invocation.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (cmdOpts: CreateFlagOpts, command: Command) => {
      if (!cmdOpts.type) throw localValidationError('--type is required (frontend|backend)');
      if (!cmdOpts.name) throw localValidationError('--name is required');
      const type = cmdOpts.type as 'frontend' | 'backend';
      if (type !== 'frontend' && type !== 'backend') {
        throw localValidationError('--type must be frontend or backend');
      }
      if (type === 'frontend' && !cmdOpts.url) {
        throw localValidationError('--url is required for --type frontend');
      }
      await runCreate(
        {
          ...resolveCommonOptions(command),
          type,
          name: cmdOpts.name,
          targetUrl: cmdOpts.url,
          description: cmdOpts.description,
          username: cmdOpts.username,
          password: cmdOpts.password,
          passwordFile: cmdOpts.passwordFile,
          instruction: cmdOpts.instruction,
          testIdAttributes:
            cmdOpts.testIdAttributes !== undefined
              ? parseTestIdAttributesFlag(cmdOpts.testIdAttributes, 'test-id-attributes')
              : undefined,
          idempotencyKey: cmdOpts.idempotencyKey,
        },
        deps,
      );
    });

  project
    .command('update <project-id>')
    .description('Update project metadata')
    .option('--name <name>', 'new project name')
    .option('--url <url>', 'new target URL')
    .option('--username <user>', 'new auth username')
    .option('--password <pw>', 'new auth password')
    .option('--password-file <path>', 'read new password from file')
    .option('--instruction <text>', 'new FE plan-gen instruction hint')
    .option(
      '--test-id-attributes <list>',
      'comma-separated DOM attributes the engine should prefer as locators, highest priority first ' +
        '(e.g. data-element,data-testid); replaces the current list',
    )
    .option(
      '--clear-test-id-attributes',
      'remove the test-id attribute list (engine falls back to data-testid)',
      false,
    )
    .option(
      '--idempotency-key <token>',
      'opaque idempotency token. Defaults to a UUIDv4 minted per invocation.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (projectId: string, cmdOpts: UpdateFlagOpts, command: Command) => {
      await runUpdate(
        {
          ...resolveCommonOptions(command),
          projectId,
          name: cmdOpts.name,
          targetUrl: cmdOpts.url,
          username: cmdOpts.username,
          password: cmdOpts.password,
          passwordFile: cmdOpts.passwordFile,
          instruction: cmdOpts.instruction,
          testIdAttributes:
            cmdOpts.testIdAttributes !== undefined
              ? parseTestIdAttributesFlag(cmdOpts.testIdAttributes, 'test-id-attributes')
              : undefined,
          clearTestIdAttributes: cmdOpts.clearTestIdAttributes,
          idempotencyKey: cmdOpts.idempotencyKey,
        },
        deps,
      );
    });

  project
    .command('delete <project-id>')
    .description(
      'Permanently delete a project and everything under it (sub-projects,\n' +
        'their tests, and backend fixtures). Requires --confirm.\n' +
        '\nExit codes:\n' +
        '  0  success\n' +
        '  3  auth error\n' +
        '  4  project not found (or already deleted)\n' +
        '  5  validation error (e.g., missing --confirm)',
    )
    .option('--confirm', 'required: explicit confirmation for the destructive operation', false)
    .option(
      '--idempotency-key <token>',
      'opaque idempotency token. Defaults to a UUIDv4 minted per invocation.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (projectId: string, cmdOpts: DeleteFlagOpts, command: Command) => {
      await runDelete(
        {
          ...resolveCommonOptions(command),
          projectId,
          confirm: cmdOpts.confirm === true,
          idempotencyKey: cmdOpts.idempotencyKey,
        },
        deps,
      );
    });

  project
    .command('credential <project-id>')
    .description(
      'Set the static backend credential injected into every backend test\n' +
        '(Bearer token / API key / Basic token / public). Free tier.',
    )
    .requiredOption('--type <type>', 'public | "Bearer token" | "API key" | "basic token"')
    .option('--credential <value>', 'credential value (required unless --type public)')
    .option('--credential-file <path>', 'read the credential value from a file')
    .option(
      '--idempotency-key <token>',
      'opaque idempotency token. Defaults to a UUIDv4 minted per invocation.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (projectId: string, cmdOpts: CredentialFlagOpts, command: Command) => {
      await runCredential(
        {
          ...resolveCommonOptions(command),
          projectId,
          authType: cmdOpts.type,
          credential: cmdOpts.credential,
          credentialFile: cmdOpts.credentialFile,
          idempotencyKey: cmdOpts.idempotencyKey,
        },
        deps,
      );
    });

  project
    .command('auto-auth <project-id>')
    .description(
      'Configure the recurring-token (auto-refresh login) for backend tests (Pro).\n' +
        'A fresh token is fetched on each run and injected into every backend test.',
    )
    .requiredOption('--method <method>', 'password | refresh_token | aws_cognito_refresh')
    .requiredOption('--inject <where>', 'bearer | header | cookie')
    .option('--disable', 'turn auto-auth off (keeps stored config)')
    .option('--inject-key <name>', 'header/cookie name when --inject is header/cookie')
    // password method
    .option('--login-url <url>', 'login endpoint (method=password)')
    .option('--login-method <verb>', 'POST | PUT (method=password)')
    .option('--login-content-type <ct>', 'application/json | application/x-www-form-urlencoded')
    .option('--login-body-template <tpl>', 'login body template with {{username}}/{{password}}')
    .option('--username <user>', 'login username (method=password)')
    .option('--password <pw>', 'login password (method=password)')
    .option('--password-file <path>', 'read login password from a file')
    .option('--token-path <jsonpath>', 'JSONPath to the token in the login response')
    // refresh_token method
    .option('--token-endpoint <url>', 'OAuth token endpoint (method=refresh_token)')
    .option('--client-id <id>', 'OAuth client id')
    .option('--client-secret <secret>', 'OAuth client secret')
    .option('--client-secret-file <path>', 'read OAuth client secret from a file')
    .option('--refresh-token <token>', 'OAuth/Cognito refresh token')
    .option('--refresh-token-file <path>', 'read the refresh token from a file')
    .option('--scope <scope>', 'OAuth scope')
    // aws_cognito_refresh method
    .option('--region <region>', "AWS region (method=aws_cognito_refresh, e.g. 'us-east-1')")
    .option(
      '--idempotency-key <token>',
      'opaque idempotency token. Defaults to a UUIDv4 minted per invocation.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (projectId: string, cmdOpts: AutoAuthFlagOpts, command: Command) => {
      await runAutoAuth(
        {
          ...resolveCommonOptions(command),
          projectId,
          disable: cmdOpts.disable,
          method: cmdOpts.method,
          inject: cmdOpts.inject,
          injectKey: cmdOpts.injectKey,
          loginUrl: cmdOpts.loginUrl,
          loginMethod: cmdOpts.loginMethod,
          loginContentType: cmdOpts.loginContentType,
          loginBodyTemplate: cmdOpts.loginBodyTemplate,
          username: cmdOpts.username,
          password: cmdOpts.password,
          passwordFile: cmdOpts.passwordFile,
          tokenPath: cmdOpts.tokenPath,
          tokenEndpoint: cmdOpts.tokenEndpoint,
          clientId: cmdOpts.clientId,
          clientSecret: cmdOpts.clientSecret,
          clientSecretFile: cmdOpts.clientSecretFile,
          refreshToken: cmdOpts.refreshToken,
          refreshTokenFile: cmdOpts.refreshTokenFile,
          scope: cmdOpts.scope,
          region: cmdOpts.region,
          idempotencyKey: cmdOpts.idempotencyKey,
        },
        deps,
      );
    });

  const docs = new Command('docs').description(
    'Manage project documents — the sources plan generation feeds on',
  );
  docs
    .command('upload <file>')
    .description(
      'Upload an API spec or PRD as a project source (DEV-384). Three steps:\n' +
        'mint a presigned S3 URL, stream the file bytes to it, register the\n' +
        'document — which starts processing + embedding. The local file is\n' +
        'only read; nothing is written back to disk.\n' +
        '\nExit codes:\n' +
        '  0  upload registered (processing started)\n' +
        '  3  auth error\n' +
        '  4  project not found (or not accessible in this workspace)\n' +
        '  5  validation error (missing/empty file, bad --role)\n' +
        '  7  request timeout (also: backend predates the docs routes)\n' +
        ' 10  presigned S3 PUT failed — re-run to mint a fresh URL',
    )
    .option('--project <id>', 'project id the document belongs to (required)')
    .option('--role <role>', 'document role: api-doc (API spec, default) | prd')
    .option('--name <display-name>', 'display name for the document (default: file basename)')
    .option(
      '--idempotency-key <token>',
      'opaque idempotency token. Defaults to a UUIDv4 minted per invocation.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (file: string, cmdOpts: DocsUploadFlagOpts, command: Command) => {
      await runDocsUpload(
        {
          ...resolveCommonOptions(command),
          file,
          projectId: cmdOpts.project,
          role: cmdOpts.role,
          name: cmdOpts.name,
          idempotencyKey: cmdOpts.idempotencyKey,
        },
        deps,
      );
    });
  project.addCommand(docs);

  return project;
}

interface DocsUploadFlagOpts {
  project?: string;
  role?: string;
  name?: string;
  idempotencyKey?: string;
}

interface ListFlagOpts {
  pageSize?: string;
  startingToken?: string;
  maxItems?: string;
  columns?: string;
  header?: boolean;
}

interface CreateFlagOpts {
  type?: string;
  name?: string;
  url?: string;
  description?: string;
  username?: string;
  password?: string;
  passwordFile?: string;
  instruction?: string;
  testIdAttributes?: string;
  idempotencyKey?: string;
}

interface UpdateFlagOpts {
  name?: string;
  url?: string;
  username?: string;
  password?: string;
  passwordFile?: string;
  instruction?: string;
  testIdAttributes?: string;
  clearTestIdAttributes?: boolean;
  idempotencyKey?: string;
}

interface DeleteFlagOpts {
  confirm?: boolean;
  idempotencyKey?: string;
}

interface CredentialFlagOpts {
  type: string;
  credential?: string;
  credentialFile?: string;
  idempotencyKey?: string;
}

interface AutoAuthFlagOpts {
  disable?: boolean;
  method: string;
  inject: string;
  injectKey?: string;
  loginUrl?: string;
  loginMethod?: string;
  loginContentType?: string;
  loginBodyTemplate?: string;
  username?: string;
  password?: string;
  passwordFile?: string;
  tokenPath?: string;
  tokenEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
  clientSecretFile?: string;
  refreshToken?: string;
  refreshTokenFile?: string;
  scope?: string;
  region?: string;
  idempotencyKey?: string;
}

function parseFlag(raw: string | undefined, flagName: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request.',
        nextAction: `Flag \`--${flagName}\` is invalid: must be an integer.`,
        requestId: 'local',
        details: { field: flagName, reason: 'must be an integer' },
      },
    });
  }
  return n;
}

function resolveCommonOptions(command: Command): CommonOptions {
  const globals = command.optsWithGlobals() as Partial<CommonOptions> & {
    requestTimeout?: string;
  };
  // P2-8: validate --output before allowing silent fallback to 'text'.
  return {
    profile: globals.profile ?? 'default',
    output: resolveOutputMode(globals.output),
    endpointUrl: globals.endpointUrl,
    debug: globals.debug ?? false,
    verbose: globals.verbose ?? false,
    dryRun: globals.dryRun ?? false,
    requestTimeoutMs: parseRequestTimeoutFlag(globals.requestTimeout),
  };
}

function makeClient(opts: CommonOptions, deps: ProjectDeps): HttpClient {
  return makeHttpClient(opts, {
    env: deps.env,
    credentialsPath: deps.credentialsPath,
    fetchImpl: deps.fetchImpl,
    stderr: deps.stderr,
  });
}

function makeOutput(mode: OutputMode, deps: ProjectDeps): Output {
  return new Output(mode, { stdout: deps.stdout, stderr: deps.stderr });
}

/**
 * Master column set — includes ORG so `--columns` validation and explicit
 * `--columns ...,org` selection both work regardless of whether any row in
 * THIS response happens to carry org attribution. The default (no
 * `--columns` flag) rendering uses {@link defaultProjectListColumns} instead,
 * which drops ORG unless at least one row carries it — this keeps the table
 * unchanged for legacy (non-org-scoped) callers.
 */
const PROJECT_LIST_COLUMNS: ReadonlyArray<TextTableColumn<CliProject>> = [
  {
    header: 'ID',
    width: rows => Math.max(2, ...rows.map(project => project.id.length)),
    render: project => project.id,
  },
  {
    header: 'NAME',
    width: rows => Math.max(4, ...rows.map(project => project.name.length)),
    render: project => project.name,
  },
  { header: 'TYPE', width: 8, render: project => project.type },
  { header: 'FROM', width: 6, render: project => project.createdFrom },
  {
    header: 'ORG',
    width: rows =>
      Math.max(3, ...rows.map(project => (project.orgName ?? project.orgId ?? '').length)),
    render: project => project.orgName ?? project.orgId ?? '',
  },
  { header: 'CREATED', width: 0, render: project => project.createdAt },
];

const PROJECT_LIST_ORG_COLUMN = PROJECT_LIST_COLUMNS.find(c => c.header === 'ORG')!;

/**
 * Default (no explicit `--columns`) column set. ORG is included only when
 * at least one row in this page carries `orgId` — avoids widening the table
 * for callers whose projects have no org attribution at all.
 */
function defaultProjectListColumns(
  rows: readonly CliProject[],
): ReadonlyArray<TextTableColumn<CliProject>> {
  const hasOrgInfo = rows.some(project => project.orgId !== undefined);
  return hasOrgInfo
    ? PROJECT_LIST_COLUMNS
    : PROJECT_LIST_COLUMNS.filter(c => c !== PROJECT_LIST_ORG_COLUMN);
}

function renderProjectListText(
  page: Page<CliProject>,
  options: { columns?: string; noHeader?: boolean } = {},
): string {
  if (page.items.length === 0) {
    return page.nextToken
      ? `No projects on this page.\nnextToken: ${page.nextToken}`
      : 'No projects.';
  }
  // Explicit --columns: resolve against the FULL master set (so `org` can be
  // requested even when this page happens to have no org-scoped rows).
  // Default: only include ORG when the data actually carries it.
  const columns =
    options.columns !== undefined ? PROJECT_LIST_COLUMNS : defaultProjectListColumns(page.items);
  const lines = [
    renderTextTable(page.items, columns, {
      columns: options.columns,
      noHeader: options.noHeader,
    }),
  ];
  if (page.nextToken) lines.push('', `nextToken: ${page.nextToken}`);
  return lines.join('\n');
}

function renderProjectText(p: CliProject): string {
  const lines = [
    `id:          ${p.id}`,
    `name:        ${p.name}`,
    `type:        ${p.type}`,
    `createdFrom: ${p.createdFrom}`,
    `createdAt:   ${p.createdAt}`,
    `updatedAt:   ${p.updatedAt}`,
  ];
  if (p.orgId !== undefined) {
    lines.push(`org:         ${p.orgName ?? '(name unknown)'} (${p.orgId})`);
  }
  // Presence, not truthiness — see the `targetUrl` docstring on `CliProject`.
  // `'targetUrl' in p` distinguishes "the backend answered 'no URL'" (render the
  // hint) from "this endpoint doesn't report it" (say nothing).
  if ('targetUrl' in p) {
    lines.push(
      p.targetUrl
        ? `targetUrl:   ${p.targetUrl}`
        : `targetUrl:   (not set — set one with: testsprite project update ${p.id} --url <url>)`,
    );
  }
  // Presence-keyed like targetUrl: older backends don't report the field at all.
  if ('testIdAttributes' in p) {
    lines.push(
      p.testIdAttributes && p.testIdAttributes.length > 0
        ? `testIdAttrs: ${p.testIdAttributes.join(', ')}  (locator priority, highest first)`
        : `testIdAttrs: (not set — engine default data-testid; set with: testsprite project update ${p.id} --test-id-attributes <list>)`,
    );
  }
  return lines.join('\n');
}

/**
 * `project create`'s text renderer. Distinct from
 * `renderProjectText` (used by `project get`/`list`, where the live `id`
 * field is proven reliable) because the create response's id field name and
 * `updatedAt` presence are not guaranteed — see `CliCreateProjectResponse`.
 */
function renderCreateProjectText(p: CliCreateProjectResponse): string {
  const lines = [
    `id:          ${resolveCreatedProjectId(p) ?? '(unknown)'}`,
    `name:        ${p.name}`,
    `type:        ${p.type}`,
    `createdFrom: ${p.createdFrom}`,
    `createdAt:   ${p.createdAt}`,
  ];
  if (p.updatedAt !== undefined) lines.push(`updatedAt:   ${p.updatedAt}`);
  return lines.join('\n');
}

function renderUpdateText(r: CliUpdateProjectResponse): string {
  const lines = [
    `id:            ${resolveUpdatedProjectId(r) ?? '(unknown)'}`,
    `updatedFields: ${r.updatedFields?.join(', ') ?? '(none)'}`,
  ];
  if (r.updatedAt !== undefined) lines.push(`updatedAt:     ${r.updatedAt}`);
  return lines.join('\n');
}

function renderDeleteText(r: CliDeleteProjectResponse): string {
  return [`projectId ${r.projectId}`, `deletedAt ${r.deletedAt}`].join('\n');
}

/**
 * `--project` resolution for `project docs upload` — mirrors test.ts's
 * resolveProjectId/requireProjectId so `TESTSPRITE_PROJECT_ID` works here the
 * same as on every other command (DEV-384 review F5). Flag wins over env.
 */
function requireDocsProjectId(projectId: string | undefined, deps: ProjectDeps): string {
  const explicit = projectId?.trim();
  if (explicit && explicit.length > 0) return explicit;
  const envValue = (deps.env ?? process.env).TESTSPRITE_PROJECT_ID?.trim();
  if (envValue && envValue.length > 0) return envValue;
  throw localValidationError(
    '--project <id> is required; pass --project <id> or set TESTSPRITE_PROJECT_ID',
  );
}

/**
 * A backend that predates the testIdAttributes field answers a PATCH/POST that
 * carries it with a generic 400 whose `details.accepted` list omits the field
 * ("at least one field must be provided …" — misleading, since a field WAS
 * provided). Translate that into an honest UNSUPPORTED so the user learns the
 * real cause instead of re-reading their own command.
 */
function translateUnsupportedTestIdAttributes(
  err: unknown,
  sentTestIdAttributes: boolean,
): unknown {
  if (!sentTestIdAttributes || !(err instanceof ApiError) || err.code !== 'VALIDATION_ERROR')
    return err;
  const accepted = err.details?.accepted;
  if (!Array.isArray(accepted) || accepted.includes('testIdAttributes')) return err;
  return ApiError.fromEnvelope({
    error: {
      code: 'UNSUPPORTED',
      message: 'This backend does not support test-id attributes yet.',
      nextAction:
        'The server accepted fields: ' +
        accepted.join(', ') +
        '. `--test-id-attributes` / `--clear-test-id-attributes` need a backend that knows the ' +
        '`testIdAttributes` field; retry once it is deployed, or drop the flag.',
      requestId: err.requestId,
      details: { reason: 'test_id_attributes_unsupported_backend', accepted },
    },
  });
}

function localValidationError(message: string): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request.',
      nextAction: message,
      requestId: 'local',
      details: { reason: 'missing_required_flag' },
    },
  });
}
