import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import {
  emitDryRunBanner,
  makeHttpClient,
  parseRequestTimeoutFlag,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import { resolveProfileName } from '../lib/config.js';
import { ApiError } from '../lib/errors.js';
import { firstSuiteNextSteps } from '../lib/first-suite-hint.js';
import type { FetchImpl, HttpClient } from '../lib/http.js';
import { type ShutdownHandle } from '../lib/interrupt.js';
import { type LocalPortProbeDeps } from '../lib/local-target.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode, type OutputMode } from '../lib/output.js';
import { CLI_PROJECT_LIST_SCHEMA, CLI_PROJECT_SCHEMA } from '../lib/response-schemas.js';
import { terminalWidth } from '../lib/ticker.js';
import { renderTextTable, resolveTextColumns, type TextTableColumn } from '../lib/text-table.js';
import { assertIdempotencyKey } from '../lib/validate.js';
import {
  fetchSinglePage,
  paginate,
  validatePaginationFlags,
  type FetchPageArgs,
  type Page,
  type PaginationFlags,
} from '../lib/pagination.js';
import { createProjectEnvCommand } from './project-env.js';
import { terminalSafe, terminalSafeLine, terminalSafeWriter } from '../lib/terminal-text.js';

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
  /** Absent on older servers, or when the environment read failed. */
  defaultEnvironment?: string | null;
  environmentCount?: number;
  /** Project detail only. Null when unset, absent on older servers. */
  instruction?: string | null;
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
  localPortProbeDeps?: LocalPortProbeDeps;
  /** Graceful-detach coordinator; tests inject their own. */
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

  const fetchPage = async ({ pageSize, cursor }: FetchPageArgs) =>
    client.get<Page<CliProject>>('/projects', {
      query: { pageSize, cursor },
      schema: CLI_PROJECT_LIST_SCHEMA,
    });

  let page: Page<CliProject>;
  if (useSinglePage) {
    page = await fetchSinglePage<CliProject>(
      client,
      '/projects',
      paginationFlags.pageSize!,
      opts.startingToken,
      {},
      CLI_PROJECT_LIST_SCHEMA,
    );
  } else {
    page = await paginate<CliProject>(fetchPage, paginationFlags);
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

  const project = await client.get<CliProject>(`/projects/${encodeURIComponent(opts.projectId)}`, {
    schema: CLI_PROJECT_SCHEMA,
  });
  out.print(project, data => renderProjectText(data as CliProject));
  return project;
}

// ---------------------------------------------------------------------------
// project create
// ---------------------------------------------------------------------------

export interface CliCreateProjectRequest {
  type: 'frontend' | 'backend';
  name: string;
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
 * possibly omitting `updatedAt` entirely. Rather than guess which
 * single shape is "the real one" and risk flipping the drift instead of
 * fixing it, both id field names are accepted here (and normalized — see
 * `resolveCreatedProjectId` — so JSON consumers keyed on either `id` or
 * `projectId` keep working), and `updatedAt` is optional.
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
}

/** Resolve the created project's id regardless of which field name the backend used. */
export function resolveCreatedProjectId(r: CliCreateProjectResponse): string | undefined {
  return r.projectId ?? r.id;
}

interface CreateOptions extends CommonOptions {
  type: 'frontend' | 'backend';
  name: string;
  instruction?: string;
  testIdAttributes?: string[];
  idempotencyKey?: string;
}

export async function runCreate(
  opts: CreateOptions,
  deps: ProjectDeps = {},
): Promise<CliCreateProjectResponse> {
  const out = makeOutput(opts.output, deps);
  const stderr = terminalSafeWriter(deps.stderr);

  // P1-2: validate idempotency key before sending as an HTTP header.
  // Non-ASCII chars cause a ByteString TypeError at the transport layer
  // (exit 10 UNAVAILABLE) — fail fast with a clear exit 5 instead.
  assertIdempotencyKey(opts.idempotencyKey);

  // P1-3: client-side length checks matching server limits.
  // Whitespace-only / empty rejection: a truthy `--name "   "` otherwise
  // creates a blank-named project on the backend.
  if (opts.name === undefined || opts.name.trim().length === 0) {
    throw localValidationError('--name is required and must not be empty or whitespace-only');
  }
  if (opts.name.length > 200) {
    throw localValidationError('--name must be at most 200 characters');
  }

  if (opts.dryRun) {
    // This path returns without making any dry-run request, so emit the
    // banner here — otherwise the canned sample can be mistaken for a live
    // response.
    emitDryRunBanner(stderr);
    const idempotencyKey = opts.idempotencyKey ?? `cli-proj-create-${randomUUID()}`;
    // P2-6: gate idempotency-key output behind --verbose/--debug/json. Suppress
    // in plain text interactive mode to reduce noise; still available for
    // automation and retry flows.
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
      createdFrom: 'cli',
      createdAt: '2026-05-16T00:00:00.000Z',
      updatedAt: '2026-05-16T00:00:00.000Z',
    };
    out.print(sample, data => renderCreateProjectText(data as CliCreateProjectResponse));
    return sample;
  }

  const idempotencyKey = opts.idempotencyKey ?? `cli-proj-create-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  const body: CliCreateProjectRequest = {
    type: opts.type,
    name: opts.name,
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

  // A new project has no environment and no tests yet; one hint names both
  // steps. Text mode only: a JSON caller already holds the id, and --dry-run
  // returned above with a canned one.
  if (opts.output !== 'json' && resolvedId !== undefined) {
    stderr(firstSuiteNextSteps(resolvedId, opts.type));
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
  const stderr = terminalSafeWriter(deps.stderr);

  // P1-2: validate idempotency key before sending as an HTTP header.
  assertIdempotencyKey(opts.idempotencyKey);

  // P1-3: client-side length checks matching server limits.
  // Reject a whitespace-only `--name` on update too (parity with create); name
  // stays optional here, so only validate when the flag is supplied.
  if (opts.name !== undefined && opts.name.trim().length === 0) {
    throw localValidationError('--name must not be empty or whitespace-only');
  }
  if (opts.name !== undefined && opts.name.length > 200) {
    throw localValidationError('--name must be at most 200 characters');
  }
  if (opts.testIdAttributes !== undefined && opts.clearTestIdAttributes) {
    throw localValidationError(
      '--test-id-attributes and --clear-test-id-attributes are mutually exclusive.',
    );
  }
  const mutableFields: Record<string, boolean> = {
    name: opts.name !== undefined,
    instruction: opts.instruction !== undefined,
    testIdAttributes: opts.testIdAttributes !== undefined || opts.clearTestIdAttributes === true,
  };
  const presentFieldNames = Object.entries(mutableFields)
    .filter(([, present]) => present)
    .map(([field]) => field);
  if (presentFieldNames.length === 0) {
    throw localValidationError(
      'At least one mutable flag is required: --name, --instruction, --test-id-attributes, or ' +
        '--clear-test-id-attributes.',
    );
  }

  if (opts.dryRun) {
    // Emit the banner here (this path returns before makeClient() does).
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

  const idempotencyKey = opts.idempotencyKey ?? `cli-proj-update-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  const bodyFields: Record<string, string | string[] | null | undefined> = {
    name: opts.name,
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
    const stderr = terminalSafeWriter(deps.stderr);
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

export function createProjectCommand(deps: ProjectDeps = {}): Command {
  const project = new Command('project').description('Manage TestSprite projects');

  project
    .command('list')
    .summary('List projects visible to the API key')
    .description(
      'List projects visible to the API key\n' +
        '\nExit codes:\n' +
        '  0  success\n' +
        '  3  auth error\n' +
        '  5  validation error (e.g., bad --page-size)\n' +
        ' 10  transport/network failure (UNAVAILABLE) — retry the command',
    )
    .option(
      '--page-size <n>',
      'page size (1-100, default 25); alone it returns one page plus a next --starting-token (add --max-items to auto-page)',
    )
    .option('--starting-token <token>', 'opaque cursor from a previous list response')
    .option('--max-items <n>', 'stop after this many items across auto-paged pages')
    .option(
      '--columns <list>',
      'select/reorder text table columns (comma-separated keys: id, name, type, from, org, url, created, defaultenv, envs)',
    )
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
          ...resolveCommonOptions(command, deps.env),
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
      await runGet({ ...resolveCommonOptions(command, deps.env), projectId }, deps);
    });

  project
    .command('create')
    .description('Create a project; add where it runs with `project env create`')
    .option('--type <frontend|backend>', 'project type (required)')
    .option('--name <name>', 'project name (required)')
    .option(
      '--instruction <text>',
      'extra instructions: facts and rules the agent keeps in mind when it explores the app, writes tests or runs them',
    )
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
      await runCreate(
        {
          ...resolveCommonOptions(command, deps.env),
          type,
          name: cmdOpts.name,
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
    .description("Update a project's name, extra instructions or test-id attributes")
    .option('--name <name>', 'new project name')
    .option('--instruction <text>', 'replace the current instructions (read them with project get)')
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
          ...resolveCommonOptions(command, deps.env),
          projectId,
          name: cmdOpts.name,
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
    .summary('Permanently delete a project (requires --confirm)')
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
          ...resolveCommonOptions(command, deps.env),
          projectId,
          confirm: cmdOpts.confirm === true,
          idempotencyKey: cmdOpts.idempotencyKey,
        },
        deps,
      );
    });

  // `project env <verb>` — the per-project environment surface (URL, sign-in,
  // backend credentials, default). Own module; `deps` threaded so tests inject.
  project.addCommand(createProjectEnvCommand(deps));

  return project;
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
  instruction?: string;
  testIdAttributes?: string;
  idempotencyKey?: string;
}

interface UpdateFlagOpts {
  name?: string;
  instruction?: string;
  testIdAttributes?: string;
  clearTestIdAttributes?: boolean;
  idempotencyKey?: string;
}

interface DeleteFlagOpts {
  confirm?: boolean;
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

function resolveCommonOptions(command: Command, env?: NodeJS.ProcessEnv): CommonOptions {
  const globals = command.optsWithGlobals() as Partial<CommonOptions> & {
    requestTimeout?: string;
  };
  // P2-8: validate --output before allowing silent fallback to 'text'.
  return {
    profile: resolveProfileName(globals.profile, env),
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
    width: rows => Math.max(2, ...rows.map(project => terminalWidth(project.id))),
    render: project => project.id,
  },
  {
    header: 'NAME',
    width: rows => Math.max(4, ...rows.map(project => terminalWidth(project.name))),
    render: project => project.name,
  },
  { header: 'TYPE', width: 8, render: project => project.type },
  { header: 'FROM', width: 6, render: project => project.createdFrom },
  {
    header: 'ORG',
    width: rows =>
      Math.max(3, ...rows.map(project => terminalWidth(project.orgName ?? project.orgId ?? ''))),
    render: project => project.orgName ?? project.orgId ?? '',
  },
  {
    header: 'CREATED',
    width: rows => Math.max(7, ...rows.map(project => terminalWidth(project.createdAt))),
    render: project => project.createdAt,
  },
  {
    header: 'DEFAULT ENV',
    width: rows =>
      Math.max(11, ...rows.map(project => terminalWidth(project.defaultEnvironment ?? '-'))),
    render: project => project.defaultEnvironment ?? '-',
  },
  {
    header: 'ENVS',
    width: 4,
    render: project => project.environmentCount?.toString() ?? '-',
  },
];

/**
 * Default (no explicit `--columns`) column set. ORG is included only when
 * at least one row carries `orgId`.
 */
function defaultProjectListColumns(
  rows: readonly CliProject[],
): ReadonlyArray<TextTableColumn<CliProject>> {
  const hasOrgInfo = rows.some(project => project.orgId !== undefined);
  return PROJECT_LIST_COLUMNS.filter(column => column.header !== 'ORG' || hasOrgInfo);
}

/**
 * Render `project list`'s text table over a fetched page. Falls back to the
 * default column set (ORG/URL included only when the data carries them).
 * Exported for direct unit coverage of the CJK display-width regression
 * (#369): later columns must not shift when a project name is full-width.
 */
export function renderProjectListText(
  page: Page<CliProject>,
  options: { columns?: string; noHeader?: boolean } = {},
): string {
  if (page.items.length === 0) {
    return page.nextToken
      ? `No projects on this page.\nnextToken: ${terminalSafeLine(page.nextToken)}`
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
  if (page.nextToken) lines.push('', `nextToken: ${terminalSafeLine(page.nextToken)}`);
  return lines.join('\n');
}

function renderProjectText(p: CliProject): string {
  const lines = [
    `id:          ${terminalSafeLine(p.id)}`,
    `name:        ${terminalSafeLine(p.name)}`,
    `type:        ${terminalSafeLine(p.type)}`,
    `createdFrom: ${terminalSafeLine(p.createdFrom)}`,
    `createdAt:   ${terminalSafeLine(p.createdAt)}`,
    `updatedAt:   ${terminalSafeLine(p.updatedAt)}`,
  ];
  if (p.orgId !== undefined) {
    lines.push(
      `org:         ${terminalSafeLine(p.orgName ?? '(name unknown)')} (${terminalSafeLine(p.orgId)})`,
    );
  }
  if (p.instruction !== undefined) {
    lines.push(
      p.instruction
        ? `instruction:\n  ${terminalSafe(p.instruction).replaceAll('\n', '\n  ')}`
        : 'instruction: (not set)',
    );
  }
  if ('defaultEnvironment' in p) {
    lines.push(`defaultEnv:  ${terminalSafeLine(p.defaultEnvironment ?? '-')}`);
  }
  if ('environmentCount' in p) {
    const count = p.environmentCount;
    lines.push(
      `envs:        ${count}${count !== undefined && count > 0 ? ` (list with: testsprite project env list ${terminalSafeLine(p.id)})` : ''}`,
    );
  }
  // Presence-keyed: older backends don't report the field at all.
  if ('testIdAttributes' in p) {
    lines.push(
      p.testIdAttributes && p.testIdAttributes.length > 0
        ? `testIdAttrs: ${terminalSafeLine(p.testIdAttributes.join(', '))}  (locator priority, highest first)`
        : `testIdAttrs: (not set — engine default data-testid; set with: testsprite project update ${terminalSafeLine(p.id)} --test-id-attributes <list>)`,
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
    `id:          ${terminalSafeLine(resolveCreatedProjectId(p) ?? '(unknown)')}`,
    `name:        ${terminalSafeLine(p.name)}`,
    `type:        ${terminalSafeLine(p.type)}`,
    `createdFrom: ${terminalSafeLine(p.createdFrom)}`,
    `createdAt:   ${terminalSafeLine(p.createdAt)}`,
  ];
  if (p.updatedAt !== undefined) lines.push(`updatedAt:   ${terminalSafeLine(p.updatedAt)}`);
  return lines.join('\n');
}

function renderUpdateText(r: CliUpdateProjectResponse): string {
  const lines = [
    `id:            ${terminalSafeLine(resolveUpdatedProjectId(r) ?? '(unknown)')}`,
    `updatedFields: ${terminalSafeLine(r.updatedFields?.join(', ') ?? '(none)')}`,
  ];
  if (r.updatedAt !== undefined) lines.push(`updatedAt:     ${terminalSafeLine(r.updatedAt)}`);
  return lines.join('\n');
}

function renderDeleteText(r: CliDeleteProjectResponse): string {
  return [
    `projectId ${terminalSafeLine(r.projectId)}`,
    `deletedAt ${terminalSafeLine(r.deletedAt)}`,
  ].join('\n');
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
