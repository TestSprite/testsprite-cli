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
    assertNotLocal(opts.targetUrl);
  }

  const passwordSupplied = opts.password !== undefined || opts.passwordFile !== undefined;
  const mutableFields: Record<string, boolean> = {
    name: opts.name !== undefined,
    targetUrl: opts.targetUrl !== undefined,
    username: opts.username !== undefined,
    password: passwordSupplied,
    instruction: opts.instruction !== undefined,
  };
  const presentFieldNames = Object.entries(mutableFields)
    .filter(([, present]) => present)
    .map(([field]) => field);
  if (presentFieldNames.length === 0) {
    throw localValidationError(
      'At least one mutable flag is required: --name, --url, --username, --password/--password-file, or --instruction.',
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
          instruction: cmdOpts.instruction,
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
  instruction?: string;
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
