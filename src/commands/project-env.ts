/**
 * `testsprite project env <verb>` — the per-project environment surface
 * (DEV-1305, Phase 1 of DEV-793).
 *
 * An environment is a named bundle of "how to reach and log in to the app": a
 * URL and a login method. `test run --env <name>`
 * picks one by NAME, which is unique per project server-side; the default
 * environment is what every run without `--env` has always used.
 *
 * An app that only runs on your own machine is named with `--local <port>`
 * instead of `--url` — the same spelling as `project create`. The CLI builds
 * the loopback URL and sends the `originMode: 'local'` marker that lets the
 * server store it:
 *
 *   project env create <pid> --name local-dev --local 5173 \
 *     --username … --password-file …
 *   test run <test-id> --env local-dev --local 5173
 *
 * `--local` on the run is what makes that address reachable from the cloud
 * runner; a run against a loopback environment without it is refused before
 * dispatch. A loopback `--url` is redirected to `--local`; everything the
 * runner can never reach (RFC1918, link-local, the metadata address,
 * non-http(s)) stays rejected.
 *
 * Thin facade over `/api/cli/v1/projects/{id}/env`; the server owns every
 * rule (name uniqueness, default recompute, credential storage). Passwords go
 * up in the request body and are never echoed — not by the server, not by any
 * renderer here.
 */
import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import {
  emitDryRunBanner,
  makeHttpClient,
  parseRequestTimeoutFlag,
  type CommonOptions,
} from '../lib/client-factory.js';
import { ApiError } from '../lib/errors.js';
import type { HttpClient } from '../lib/http.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode, type OutputMode } from '../lib/output.js';
import { readSecretFileGuarded } from '../lib/secret-file.js';
import {
  assertStoredLocalTargetListening,
  buildLocalTargetUrl,
  parseStoredLocalTarget,
} from '../lib/local-target.js';
import { assertNotLocal } from '../lib/target-url.js';
import { renderTextTable, type TextTableColumn } from '../lib/text-table.js';
import { assertIdempotencyKey } from '../lib/validate.js';
import type { ProjectDeps } from './project.js';

// ---------------------------------------------------------------------------
// Wire types — `GET|POST /projects/{id}/env`, `PATCH|DELETE /projects/{id}/env/{name}`,
// `POST /projects/{id}/env/{name}/default`
// ---------------------------------------------------------------------------

/** One environment row as the facade returns it. Never carries a password. */
export interface CliProjectEnvironment {
  id: string;
  name: string;
  /**
   * The address runs against this environment open. May be a loopback URL for
   * an app that only runs on your own machine — pair it with `--local`.
   */
  url: string;
  isDefault: boolean;
  /**
   * How a run signs in: `account` (the stored test account), `otp` (a one-time
   * code account), `manual` (a human-captured Google/SSO session, set up in the
   * Portal) or `public` (no sign-in). Open string, rendered verbatim, so a mode
   * added server-side shows up without a CLI release.
   */
  authMode: string;
  /** Whether a test-account username/password is stored. The password is never returned. */
  hasCredentials: boolean;
  /** The test-account username this environment signs in with; `null` when none is stored. */
  username: string | null;
  enableOtp: boolean;
  updatedAt: string;
}

export interface CliProjectEnvListResponse {
  environments: CliProjectEnvironment[];
}

export interface CliProjectEnvCreateResponse {
  environment: CliProjectEnvironment;
  created: true;
}

export interface CliProjectEnvUpdateResponse {
  environment: CliProjectEnvironment;
}

export interface CliProjectEnvDeleteResponse {
  deleted: true;
  name: string;
}

// ---------------------------------------------------------------------------
// Shared plumbing (same shape as `project.ts`; kept local so this module does
// not import `project.ts` at runtime — that file imports this one).
// ---------------------------------------------------------------------------

function resolveCommonOptions(command: Command): CommonOptions {
  const globals = command.optsWithGlobals() as Partial<CommonOptions> & {
    requestTimeout?: string;
  };
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

function stderrOf(deps: ProjectDeps): (line: string) => void {
  return deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
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

function envPath(projectId: string, name?: string): string {
  const base = `/projects/${encodeURIComponent(projectId)}/env`;
  return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
}

/** Trim + reject an empty environment name; the server owns every other rule. */
function requireEnvName(raw: string | undefined, flag: string): string {
  const name = raw?.trim() ?? '';
  if (name.length === 0) {
    throw localValidationError(`${flag} is required and must not be empty or whitespace-only`);
  }
  if (name.length > 100) throw localValidationError(`${flag} must be at most 100 characters`);
  return name;
}

/** Resolve `--password` / `--password-file` (mutually exclusive; never both). */
function resolvePassword(opts: { password?: string; passwordFile?: string }): string | undefined {
  if (opts.password !== undefined && opts.passwordFile !== undefined) {
    throw localValidationError('--password and --password-file are mutually exclusive.');
  }
  if (opts.password !== undefined) {
    if (opts.password.trim().length === 0) {
      throw localValidationError('--password must not be empty or whitespace-only');
    }
    return opts.password;
  }
  if (opts.passwordFile !== undefined) {
    return readSecretFileGuarded('password-file', opts.passwordFile);
  }
  return undefined;
}

function mintIdempotencyKey(
  verb: string,
  opts: CommonOptions & { idempotencyKey?: string },
  stderr: (line: string) => void,
): string {
  const key = opts.idempotencyKey ?? `cli-proj-env-${verb}-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug)) {
    stderr(`idempotency-key: ${key}`);
  }
  return key;
}

function describeAuth(env: CliProjectEnvironment): string {
  // `otp` already says the mode; repeating it as a suffix read as two settings.
  const parts = [env.authMode];
  if (env.hasCredentials) parts.push('(credentials set)');
  if (env.enableOtp && env.authMode !== 'otp') parts.push('+otp');
  return parts.join(' ');
}

const ENV_LIST_COLUMNS: ReadonlyArray<TextTableColumn<CliProjectEnvironment>> = [
  {
    header: 'NAME',
    width: rows => Math.max(4, ...rows.map(env => env.name.length)),
    render: env => env.name,
  },
  { header: 'DEFAULT', width: 7, render: env => (env.isDefault ? 'yes' : '—') },
  {
    header: 'URL',
    width: rows => Math.max(3, ...rows.map(env => env.url.length)),
    render: env => env.url,
  },
  {
    header: 'AUTH',
    width: rows => Math.max(4, ...rows.map(env => describeAuth(env).length)),
    render: describeAuth,
  },
  { header: 'ACCOUNT', width: 0, render: env => env.username ?? '—' },
];

function renderEnvListText(r: CliProjectEnvListResponse): string {
  if (r.environments.length === 0) {
    return 'No environments. Create one with: testsprite project env create <project-id> --name <name> --url <url>';
  }
  return renderTextTable(r.environments, ENV_LIST_COLUMNS);
}

function renderEnvText(env: CliProjectEnvironment): string {
  return [
    `name:        ${env.name}`,
    `id:          ${env.id}`,
    `default:     ${env.isDefault ? 'yes' : 'no'}`,
    `url:         ${env.url}`,
    `auth:        ${describeAuth(env)}`,
    `account:     ${env.username ?? '(none stored)'}`,
    `updatedAt:   ${env.updatedAt}`,
  ].join('\n');
}

function sampleEnv(overrides: Partial<CliProjectEnvironment>): CliProjectEnvironment {
  return {
    id: '00000000-0000-4000-8000-000000000000',
    name: 'sample',
    url: 'https://staging.example.com',
    isDefault: false,
    authMode: 'account',
    hasCredentials: false,
    username: null,
    enableOtp: false,
    updatedAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// project env list
// ---------------------------------------------------------------------------

interface EnvListOptions extends CommonOptions {
  projectId: string;
}

export async function runEnvList(
  opts: EnvListOptions,
  deps: ProjectDeps = {},
): Promise<CliProjectEnvListResponse> {
  const out = makeOutput(opts.output, deps);
  if (opts.dryRun) {
    emitDryRunBanner(stderrOf(deps));
    const sample: CliProjectEnvListResponse = {
      environments: [
        sampleEnv({ name: 'production', isDefault: true, hasCredentials: true }),
        sampleEnv({ name: 'local-dev', url: 'http://127.0.0.1:5173', hasCredentials: true }),
      ],
    };
    out.print(sample, data => renderEnvListText(data as CliProjectEnvListResponse));
    return sample;
  }
  const client = makeClient(opts, deps);
  const res = await client.get<CliProjectEnvListResponse>(envPath(opts.projectId));
  out.print(res, data => renderEnvListText(data as CliProjectEnvListResponse));
  return res;
}

// ---------------------------------------------------------------------------
// project env create
// ---------------------------------------------------------------------------

interface EnvCreateOptions extends CommonOptions {
  projectId: string;
  name?: string;
  url?: string;
  /** `--local <port>`: an app on this machine; builds the loopback URL and sends the marker. */
  local?: string;
  localHost?: string;
  skipPreflight?: boolean;
  username?: string;
  password?: string;
  passwordFile?: string;
  setDefault?: boolean;
  idempotencyKey?: string;
}

export async function runEnvCreate(
  opts: EnvCreateOptions,
  deps: ProjectDeps = {},
): Promise<CliProjectEnvCreateResponse> {
  const out = makeOutput(opts.output, deps);
  const stderr = stderrOf(deps);
  assertIdempotencyKey(opts.idempotencyKey);

  const name = requireEnvName(opts.name, '--name');
  const localTarget = parseStoredLocalTarget(opts);
  if (localTarget === undefined && (opts.url === undefined || opts.url.trim().length === 0)) {
    throw localValidationError(
      '--url is required: it names the address runs against this environment open. ' +
        'For an app that only runs on this machine, pass --local <port> instead, then run it ' +
        'with `test run <id> --env <name> --local <port>`.',
    );
  }
  if (opts.url !== undefined) {
    assertNotLocal(opts.url, {
      field: 'url',
      helpCommand: 'testsprite project env create',
      hintContext: 'local-project-create',
    });
  }
  const url = localTarget ? buildLocalTargetUrl(localTarget.host, localTarget.port) : opts.url!;
  if (opts.username !== undefined && opts.username.trim().length === 0) {
    throw localValidationError('--username must not be empty or whitespace-only');
  }

  if (opts.dryRun) {
    emitDryRunBanner(stderr);
    mintIdempotencyKey('create', opts, stderr);
    const sample: CliProjectEnvCreateResponse = {
      environment: sampleEnv({
        name,
        url,
        isDefault: opts.setDefault === true,
        hasCredentials: opts.password !== undefined || opts.passwordFile !== undefined,
      }),
      created: true,
    };
    out.print(sample, data => renderEnvText((data as CliProjectEnvCreateResponse).environment));
    return sample;
  }

  if (localTarget) {
    await assertStoredLocalTargetListening(localTarget, opts, deps.localPortProbeDeps);
  }

  // Secrets are read only on the real path — never for a dry run.
  const password = resolvePassword(opts);
  const body: Record<string, string | boolean> = { name, url };
  // The marker rides with the URL: it is what authorizes storing a loopback
  // address, and it lives on the environment the server creates.
  if (localTarget) body.originMode = 'local';
  if (opts.username !== undefined) body.username = opts.username;
  if (password !== undefined) body.password = password;
  if (opts.setDefault) body.setDefault = true;

  const idempotencyKey = mintIdempotencyKey('create', opts, stderr);
  const client = makeClient(opts, deps);
  const res = await client.post<CliProjectEnvCreateResponse>(envPath(opts.projectId), {
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });
  out.print(res, data => renderEnvText((data as CliProjectEnvCreateResponse).environment));
  return res;
}

// ---------------------------------------------------------------------------
// project env update
// ---------------------------------------------------------------------------

interface EnvUpdateOptions extends CommonOptions {
  projectId: string;
  name: string;
  url?: string;
  /** `--local <port>`: repoint at an app on this machine (see `runEnvCreate`). */
  local?: string;
  localHost?: string;
  skipPreflight?: boolean;
  username?: string;
  password?: string;
  passwordFile?: string;
  rename?: string;
  idempotencyKey?: string;
}

export async function runEnvUpdate(
  opts: EnvUpdateOptions,
  deps: ProjectDeps = {},
): Promise<CliProjectEnvUpdateResponse> {
  const out = makeOutput(opts.output, deps);
  const stderr = stderrOf(deps);
  assertIdempotencyKey(opts.idempotencyKey);

  const name = requireEnvName(opts.name, '<name>');
  const localTarget = parseStoredLocalTarget(opts);
  if (opts.url !== undefined) {
    if (opts.url.trim().length === 0) {
      throw localValidationError(
        '--url must not be empty. An environment always has an address; delete the environment ' +
          'if it is no longer used (testsprite project env delete <project-id> <name> --confirm).',
      );
    }
    assertNotLocal(opts.url, {
      field: 'url',
      helpCommand: 'testsprite project env update',
      hintContext: 'local-project-create',
    });
  }
  const url = localTarget ? buildLocalTargetUrl(localTarget.host, localTarget.port) : opts.url;
  if (opts.username !== undefined && opts.username.trim().length === 0) {
    throw localValidationError('--username must not be empty or whitespace-only');
  }
  const rename = opts.rename !== undefined ? requireEnvName(opts.rename, '--rename') : undefined;
  const passwordSupplied = opts.password !== undefined || opts.passwordFile !== undefined;
  const mutable = {
    url: url !== undefined,
    username: opts.username !== undefined,
    password: passwordSupplied,
    rename: rename !== undefined,
  };
  const present = Object.entries(mutable)
    .filter(([, on]) => on)
    .map(([field]) => field);
  if (present.length === 0) {
    throw localValidationError(
      'At least one mutable flag is required: --url, --username, ' +
        '--password / --password-file, or --rename.',
    );
  }

  if (opts.dryRun) {
    emitDryRunBanner(stderr);
    mintIdempotencyKey('update', opts, stderr);
    const sample: CliProjectEnvUpdateResponse = {
      environment: sampleEnv({
        name: rename ?? name,
        url: url ?? 'https://staging.example.com',
        hasCredentials: passwordSupplied,
      }),
    };
    out.print(sample, data => renderEnvText((data as CliProjectEnvUpdateResponse).environment));
    return sample;
  }

  if (localTarget) {
    await assertStoredLocalTargetListening(localTarget, opts, deps.localPortProbeDeps);
  }

  const password = resolvePassword(opts);
  const body: Record<string, string> = {};
  if (url !== undefined) body.url = url;
  if (localTarget) body.originMode = 'local';
  if (opts.username !== undefined) body.username = opts.username;
  if (password !== undefined) body.password = password;
  if (rename !== undefined) body.rename = rename;

  const idempotencyKey = mintIdempotencyKey('update', opts, stderr);
  const client = makeClient(opts, deps);
  const res = await client.patch<CliProjectEnvUpdateResponse>(envPath(opts.projectId, name), {
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });
  out.print(res, data => renderEnvText((data as CliProjectEnvUpdateResponse).environment));
  return res;
}

// ---------------------------------------------------------------------------
// project env delete
// ---------------------------------------------------------------------------

interface EnvDeleteOptions extends CommonOptions {
  projectId: string;
  name: string;
  confirm: boolean;
  idempotencyKey?: string;
}

export async function runEnvDelete(
  opts: EnvDeleteOptions,
  deps: ProjectDeps = {},
): Promise<CliProjectEnvDeleteResponse> {
  const out = makeOutput(opts.output, deps);
  const stderr = stderrOf(deps);
  assertIdempotencyKey(opts.idempotencyKey);
  const name = requireEnvName(opts.name, '<name>');
  if (!opts.confirm) {
    throw localValidationError(
      '--confirm is required: deleting an environment removes its stored credentials and ' +
        'login settings. Runs that referenced it by name will fail until you recreate it.',
    );
  }

  if (opts.dryRun) {
    emitDryRunBanner(stderr);
    mintIdempotencyKey('delete', opts, stderr);
    const sample: CliProjectEnvDeleteResponse = { deleted: true, name };
    out.print(sample, () => `deleted: ${name}`);
    return sample;
  }

  const idempotencyKey = mintIdempotencyKey('delete', opts, stderr);
  const client = makeClient(opts, deps);
  const res = await client.delete<CliProjectEnvDeleteResponse>(envPath(opts.projectId, name), {
    headers: { 'idempotency-key': idempotencyKey },
  });
  out.print(res, data => `deleted: ${(data as CliProjectEnvDeleteResponse).name}`);
  return res;
}

// ---------------------------------------------------------------------------
// project env set-default
// ---------------------------------------------------------------------------

interface EnvSetDefaultOptions extends CommonOptions {
  projectId: string;
  name: string;
  idempotencyKey?: string;
}

export async function runEnvSetDefault(
  opts: EnvSetDefaultOptions,
  deps: ProjectDeps = {},
): Promise<CliProjectEnvUpdateResponse> {
  const out = makeOutput(opts.output, deps);
  const stderr = stderrOf(deps);
  assertIdempotencyKey(opts.idempotencyKey);
  const name = requireEnvName(opts.name, '<name>');

  if (opts.dryRun) {
    emitDryRunBanner(stderr);
    mintIdempotencyKey('set-default', opts, stderr);
    const sample: CliProjectEnvUpdateResponse = {
      environment: sampleEnv({ name, isDefault: true }),
    };
    out.print(sample, data => renderEnvText((data as CliProjectEnvUpdateResponse).environment));
    return sample;
  }

  const idempotencyKey = mintIdempotencyKey('set-default', opts, stderr);
  const client = makeClient(opts, deps);
  const res = await client.post<CliProjectEnvUpdateResponse>(
    `${envPath(opts.projectId, name)}/default`,
    { body: {}, headers: { 'idempotency-key': idempotencyKey } },
  );
  out.print(res, data => renderEnvText((data as CliProjectEnvUpdateResponse).environment));
  return res;
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

interface EnvCreateFlagOpts {
  name?: string;
  url?: string;
  local?: string;
  localHost?: string;
  skipPreflight?: boolean;
  username?: string;
  password?: string;
  passwordFile?: string;
  setDefault?: boolean;
  idempotencyKey?: string;
}

interface EnvUpdateFlagOpts {
  url?: string;
  local?: string;
  localHost?: string;
  skipPreflight?: boolean;
  username?: string;
  password?: string;
  passwordFile?: string;
  rename?: string;
  idempotencyKey?: string;
}

interface EnvDeleteFlagOpts {
  confirm?: boolean;
  idempotencyKey?: string;
}

interface EnvIdempotencyFlagOpts {
  idempotencyKey?: string;
}

const IDEMPOTENCY_HELP = 'opaque idempotency token. Defaults to a UUIDv4 minted per invocation.';

const EXIT_CODE_NOTE =
  '\nExit codes:\n' +
  '  0  success\n' +
  '  3  auth error\n' +
  '  4  project (or environment) not found\n' +
  '  5  validation error\n' +
  '  6  conflict (name already exists / deleting the default)';

export function createProjectEnvCommand(deps: ProjectDeps = {}): Command {
  const env = new Command('env')
    .description(
      "Manage a project's environments — named URL + test-account bundles that `test run --env <name>` selects",
    )
    .addHelpText(
      'after',
      '\nFor an app that only runs on this machine, create or update the environment with\n' +
        '`--local <port>` instead of `--url`; reach it per run with `test run <id> --env <name> --local <port>`.',
    );

  env
    .command('list <project-id>')
    .description("List a project's environments (name, default, URL, auth)." + EXIT_CODE_NOTE)
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (projectId: string, _cmdOpts: unknown, command: Command) => {
      await runEnvList({ ...resolveCommonOptions(command), projectId }, deps);
    });

  env
    .command('create <project-id>')
    .description(
      'Create an environment (--name and one of --url / --local are required).' + EXIT_CODE_NOTE,
    )
    .option('--name <name>', 'environment name, unique within the project (required)')
    .option(
      '--url <url>',
      'address runs open (public http/https; for an app on this machine use --local)',
    )
    .option(
      '--local <port>',
      'an app on this machine: stores http://<host>:<port> (1-65535; excludes --url; frontend only)',
    )
    .option(
      '--local-host <host>',
      'loopback host: localhost, 127.0.0.1 (default), or ::1; requires --local',
    )
    .option('--skip-preflight', 'skip the local TCP listener check before creating')
    .option('--username <user>', 'test-account username the browser logs in with')
    .option('--password <pw>', 'test-account password (prefer --password-file)')
    .option('--password-file <path>', 'read the password from a file instead of the command line')
    .option('--set-default', "make this the project's default environment", false)
    .option('--idempotency-key <token>', IDEMPOTENCY_HELP)
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (projectId: string, cmdOpts: EnvCreateFlagOpts, command: Command) => {
      await runEnvCreate(
        {
          ...resolveCommonOptions(command),
          projectId,
          name: cmdOpts.name,
          url: cmdOpts.url,
          local: cmdOpts.local,
          localHost: cmdOpts.localHost,
          skipPreflight: cmdOpts.skipPreflight,
          username: cmdOpts.username,
          password: cmdOpts.password,
          passwordFile: cmdOpts.passwordFile,
          setDefault: cmdOpts.setDefault === true,
          idempotencyKey: cmdOpts.idempotencyKey,
        },
        deps,
      );
    });

  env
    .command('update <project-id> <name>')
    .description("Change an environment's URL, credentials or name." + EXIT_CODE_NOTE)
    .option(
      '--url <url>',
      'new address runs open (public http/https; for an app on this machine use --local)',
    )
    .option(
      '--local <port>',
      'repoint at an app on this machine: stores http://<host>:<port> (1-65535; excludes --url)',
    )
    .option(
      '--local-host <host>',
      'loopback host: localhost, 127.0.0.1 (default), or ::1; requires --local',
    )
    .option('--skip-preflight', 'skip the local TCP listener check before the update')
    .option('--username <user>', 'new test-account username')
    .option('--password <pw>', 'new test-account password (prefer --password-file)')
    .option('--password-file <path>', 'read the new password from a file')
    .option(
      '--rename <new-name>',
      'rename the environment (runs keep referring to it by the new name)',
    )
    .option('--idempotency-key <token>', IDEMPOTENCY_HELP)
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (projectId: string, name: string, cmdOpts: EnvUpdateFlagOpts, command: Command) => {
        await runEnvUpdate(
          {
            ...resolveCommonOptions(command),
            projectId,
            name,
            url: cmdOpts.url,
            local: cmdOpts.local,
            localHost: cmdOpts.localHost,
            skipPreflight: cmdOpts.skipPreflight,
            username: cmdOpts.username,
            password: cmdOpts.password,
            passwordFile: cmdOpts.passwordFile,
            rename: cmdOpts.rename,
            idempotencyKey: cmdOpts.idempotencyKey,
          },
          deps,
        );
      },
    );

  env
    .command('delete <project-id> <name>')
    .description(
      'Delete an environment and its stored credentials. Requires --confirm; the default\n' +
        'environment cannot be deleted (set another default first).' +
        EXIT_CODE_NOTE,
    )
    .option('--confirm', 'required: explicit confirmation for the destructive operation', false)
    .option('--idempotency-key <token>', IDEMPOTENCY_HELP)
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (projectId: string, name: string, cmdOpts: EnvDeleteFlagOpts, command: Command) => {
        await runEnvDelete(
          {
            ...resolveCommonOptions(command),
            projectId,
            name,
            confirm: cmdOpts.confirm === true,
            idempotencyKey: cmdOpts.idempotencyKey,
          },
          deps,
        );
      },
    );

  env
    .command('set-default <project-id> <name>')
    .description(
      'Make an environment the project default — what every run without --env uses.\n' +
        'The environment needs a URL.' +
        EXIT_CODE_NOTE,
    )
    .option('--idempotency-key <token>', IDEMPOTENCY_HELP)
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (
        projectId: string,
        name: string,
        cmdOpts: EnvIdempotencyFlagOpts,
        command: Command,
      ) => {
        await runEnvSetDefault(
          {
            ...resolveCommonOptions(command),
            projectId,
            name,
            idempotencyKey: cmdOpts.idempotencyKey,
          },
          deps,
        );
      },
    );

  return env;
}
