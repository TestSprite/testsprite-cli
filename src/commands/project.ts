import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  emitDryRunBanner,
  makeHttpClient,
  parseRequestTimeoutFlag,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import { ApiError } from '../lib/errors.js';
import type { FetchImpl } from '../lib/http.js';
import type { HttpClient } from '../lib/http.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode, type OutputMode } from '../lib/output.js';
import { assertNotLocal } from '../lib/target-url.js';
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
}

export interface ProjectDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

type CommonOptions = FactoryCommonOptions;

interface ListOptions extends CommonOptions {
  pageSize?: number;
  startingToken?: string;
  maxItems?: number;
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
    return renderProjectListText(p);
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
  description?: string;
  username?: string;
  password?: string;
  instruction?: string;
}

export type CliCreateProjectResponse = CliProject;

interface CreateOptions extends CommonOptions {
  type: 'frontend' | 'backend';
  name: string;
  targetUrl?: string;
  description?: string;
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

  // Reject empty / whitespace-only names so a junk record never reaches the
  // backend — matches the `requireString` whitespace guard `test create` uses
  // (dogfood P1 fix #1). Without this, `--name "   "` passes the action
  // handler's `if (!name)` check (a non-empty string is truthy) and is sent
  // verbatim, creating a blank-named project.
  if (opts.name !== undefined && opts.name.trim().length === 0) {
    throw localValidationError('--name must not be empty or whitespace-only');
  }
  if (opts.password !== undefined && opts.password.trim().length === 0) {
    throw localValidationError('--password must not be empty or whitespace-only');
  }

  // P1-3: client-side length checks matching server limits.
  if (opts.name !== undefined && opts.name.length > 200) {
    throw localValidationError('--name must be at most 200 characters');
  }
  if (opts.description !== undefined && opts.description.length > 2000) {
    throw localValidationError('--description must be at most 2000 characters');
  }

  // P2-7: guard --url against localhost/RFC1918/non-http(s) (same rules as
  // `test create --target-url`). Applies to both FE (required) and BE (optional).
  if (opts.targetUrl !== undefined) {
    assertNotLocal(opts.targetUrl);
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
    const sample: CliCreateProjectResponse = {
      id: 'p_dryrun_2026',
      type: opts.type,
      name: opts.name,
      targetUrl: opts.targetUrl ?? '',
      createdFrom: 'cli',
      createdAt: '2026-05-16T00:00:00.000Z',
      updatedAt: '2026-05-16T00:00:00.000Z',
    } as unknown as CliCreateProjectResponse;
    out.print(sample, data => renderProjectText(data as CliProject));
    return sample;
  }

  // Resolve password: flag > file > none
  let password = opts.password;
  if (password === undefined && opts.passwordFile !== undefined) {
    password = readFileSync(opts.passwordFile, 'utf8').trim();
  }

  const idempotencyKey = opts.idempotencyKey ?? `cli-proj-create-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  const body: CliCreateProjectRequest = {
    type: opts.type,
    name: opts.name,
    ...(opts.targetUrl !== undefined ? { targetUrl: opts.targetUrl } : {}),
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    ...(opts.username !== undefined ? { username: opts.username } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(opts.instruction !== undefined ? { instruction: opts.instruction } : {}),
  };

  const client = makeClient(opts, deps);
  const created = await client.post<CliCreateProjectResponse>('/projects', {
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });

  out.print(created, data => renderProjectText(data as CliProject));
  return created;
}

// ---------------------------------------------------------------------------
// project update
// ---------------------------------------------------------------------------

export interface CliUpdateProjectResponse {
  id: string;
  /** Backend may omit this field; treat absence as no specific fields reported. */
  updatedFields?: string[];
  updatedAt: string;
}

interface UpdateOptions extends CommonOptions {
  projectId: string;
  name?: string;
  targetUrl?: string;
  username?: string;
  password?: string;
  passwordFile?: string;
  description?: string;
  instruction?: string;
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
  if (opts.name !== undefined && opts.name.trim().length === 0) {
    throw localValidationError('--name must not be empty or whitespace-only');
  }
  if (opts.password !== undefined && opts.password.trim().length === 0) {
    throw localValidationError('--password must not be empty or whitespace-only');
  }
  if (opts.name !== undefined && opts.name.length > 200) {
    throw localValidationError('--name must be at most 200 characters');
  }
  if (opts.description !== undefined && opts.description.length > 2000) {
    throw localValidationError('--description must be at most 2000 characters');
  }

  // P2-7: guard --url against localhost/RFC1918/non-http(s).
  if (opts.targetUrl !== undefined) {
    assertNotLocal(opts.targetUrl);
  }

  const passwordSupplied = opts.password !== undefined || opts.passwordFile !== undefined;
  const mutableFields: Record<string, boolean> = {
    name: opts.name !== undefined,
    targetUrl: opts.targetUrl !== undefined,
    username: opts.username !== undefined,
    password: passwordSupplied,
    description: opts.description !== undefined,
    instruction: opts.instruction !== undefined,
  };
  const presentFieldNames = Object.entries(mutableFields)
    .filter(([, present]) => present)
    .map(([field]) => field);
  if (presentFieldNames.length === 0) {
    throw localValidationError(
      'At least one mutable flag is required: --name, --url, --username, --password/--password-file, --description, or --instruction.',
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
    const sample: CliUpdateProjectResponse = {
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
    password = readFileSync(opts.passwordFile, 'utf8').trim();
  }

  const idempotencyKey = opts.idempotencyKey ?? `cli-proj-update-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    stderr(`idempotency-key: ${idempotencyKey}`);
  }

  const bodyFields: Record<string, string | undefined> = {
    name: opts.name,
    targetUrl: opts.targetUrl,
    username: opts.username,
    password,
    description: opts.description,
    instruction: opts.instruction,
  };
  const body = Object.fromEntries(
    Object.entries(bodyFields).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
  const client = makeClient(opts, deps);
  const updated = await client.patch<CliUpdateProjectResponse>(
    `/projects/${encodeURIComponent(opts.projectId)}`,
    {
      body,
      headers: { 'idempotency-key': idempotencyKey },
    },
  );

  out.print(updated, data => renderUpdateText(data as CliUpdateProjectResponse));
  return updated;
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
    .option('--url <url>', 'target URL (required for frontend)')
    .option('--description <text>', 'optional human description')
    .option('--username <user>', 'optional auth username')
    .option('--password <pw>', 'optional auth password (use --password-file for non-interactive)')
    .option('--password-file <path>', 'read password from file instead of inline flag')
    .option('--instruction <text>', 'optional FE plan-gen instruction hint')
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
    .option('--description <text>', 'new description')
    .option('--instruction <text>', 'new FE plan-gen instruction hint')
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
          description: cmdOpts.description,
          instruction: cmdOpts.instruction,
          idempotencyKey: cmdOpts.idempotencyKey,
        },
        deps,
      );
    });

  return project;
}

interface ListFlagOpts {
  pageSize?: string;
  startingToken?: string;
  maxItems?: string;
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
  idempotencyKey?: string;
}

interface UpdateFlagOpts {
  name?: string;
  url?: string;
  username?: string;
  password?: string;
  passwordFile?: string;
  description?: string;
  instruction?: string;
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

function renderProjectListText(page: Page<CliProject>): string {
  if (page.items.length === 0) {
    return page.nextToken
      ? `No projects on this page.\nnextToken: ${page.nextToken}`
      : 'No projects.';
  }
  // Compact, AWS-CLI-grade columnar output. Column widths are computed
  // per-call so a single absurdly long project name doesn't push the
  // whole table off-screen.
  const idWidth = Math.max(2, ...page.items.map(p => p.id.length));
  const nameWidth = Math.max(4, ...page.items.map(p => p.name.length));
  const typeWidth = 8;
  const fromWidth = 6;

  const header =
    pad('ID', idWidth) +
    '  ' +
    pad('NAME', nameWidth) +
    '  ' +
    pad('TYPE', typeWidth) +
    '  ' +
    pad('FROM', fromWidth) +
    '  ' +
    'CREATED';

  const rows = page.items.map(
    p =>
      pad(p.id, idWidth) +
      '  ' +
      pad(p.name, nameWidth) +
      '  ' +
      pad(p.type, typeWidth) +
      '  ' +
      pad(p.createdFrom, fromWidth) +
      '  ' +
      p.createdAt,
  );

  const lines = [header, ...rows];
  if (page.nextToken) lines.push('', `nextToken: ${page.nextToken}`);
  return lines.join('\n');
}

function renderProjectText(p: CliProject): string {
  return [
    `id:          ${p.id}`,
    `name:        ${p.name}`,
    `type:        ${p.type}`,
    `createdFrom: ${p.createdFrom}`,
    `createdAt:   ${p.createdAt}`,
    `updatedAt:   ${p.updatedAt}`,
  ].join('\n');
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function renderUpdateText(r: CliUpdateProjectResponse): string {
  return [
    `id:            ${r.id}`,
    `updatedFields: ${r.updatedFields?.join(', ') ?? '(none)'}`,
    `updatedAt:     ${r.updatedAt}`,
  ].join('\n');
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
