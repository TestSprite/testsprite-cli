/**
 * `testsprite project env <verb>` — the per-project environment surface.
 *
 * An environment is a named bundle of "how to reach and log in to the app": a
 * URL and a login method. `run --env <name>`
 * picks one by NAME, which is unique per project server-side; the default
 * environment is what every run without `--env` has always used.
 *
 * A loopback URL names an app on this machine. `--local <port>` is shorthand
 * for `--url http://localhost:<port>`; both send the existing local marker.
 * Frontend runs resolve this URL and open a tunnel automatically. Other
 * private addresses and non-http(s) URLs remain rejected.
 *
 * Thin facade over `/api/cli/v1/projects/{id}/env`; the server owns every
 * rule (name uniqueness, default recompute, credential storage). Passwords go
 * up in the request body and are never echoed — not by the server, not by any
 * renderer here.
 */
import { randomUUID } from 'node:crypto';
import { Command, Option } from 'commander';
import {
  emitDryRunBanner,
  makeHttpClient,
  parseRequestTimeoutFlag,
  type CommonOptions,
} from '../lib/client-factory.js';
import { resolveProfileName } from '../lib/config.js';
import { ApiError, InterruptError } from '../lib/errors.js';
import type { HttpClient } from '../lib/http.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode, type OutputMode } from '../lib/output.js';
import { basicAuthToken, BASIC_AUTH_FORMAT } from '../lib/basic-auth.js';
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
import {
  parseSessionTtl,
  parseSignInMode,
  signInValidationError,
  validateSignInFlags,
} from './project-sign-in.js';
import { terminalSafeLine, terminalSafeWriter } from '../lib/terminal-text.js';

// ---------------------------------------------------------------------------
// Wire types — `GET|POST /projects/{id}/env`, `GET|PATCH|DELETE /projects/{id}/env/{name}`,
// `POST /projects/{id}/env/{name}/default`
// ---------------------------------------------------------------------------

/** One environment row as the facade returns it. Never carries a password. */
export interface CliProjectEnvironment {
  id: string;
  name: string;
  /**
   * The address runs against this environment open. May be a loopback URL for
   * an app that only runs on your own machine — frontend runs open a tunnel.
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
  variables?: Record<string, string>;
  /**
   * Backend projects only: the environment as the project's agent reads it in
   * `environments/<name>.md`. Reports what is set; never a credential, password
   * or secret header value.
   */
  api?: CliApiEnvironment;
  /**
   * The environment's settings in the Portal: the page opens its dialog, where a
   * manual login is captured. Absent from older servers; `null` when none resolves.
   */
  portalUrl?: string | null;
  /** Manual environments only: the login a run would use now. Absent from older servers. */
  manualLogin?: CliManualLogin;
}

/** A manual environment's captured login, by the rule a run applies before it starts. */
export interface CliManualLogin {
  /** `valid`, `never` (nobody has logged in yet) or `expired`. Open string, rendered verbatim. */
  session: string;
  capturedAt: string | null;
  /** `null` until a login is captured, and for a login that never expires. */
  expiresAt: string | null;
  /** How long a captured login is reused, counted from the capture; `-1` never expires. */
  sessionReuseTtlSeconds: number;
}

/** How runs on a backend environment sign in to the API under test, as the agent's doc says it. */
export interface CliApiEnvironment {
  url: string;
  /**
   * `none`, a static credential's type (`bearer`, `basic`, `apikey`) or a
   * sign-in (`login`, `refresh-token`, `cognito`). Open string, rendered
   * verbatim.
   */
  auth: string;
  loginUrl: string;
  loginMethod: string;
  loginContentType: string;
  loginBody: string;
  username: string;
  tokenPath: string;
  tokenUrl: string;
  clientId: string;
  scope: string;
  region: string;
  inject: string;
  /** Header name to value; `null` when the value is a secret: set, not shown. */
  headers: Record<string, string | null>;
  credentialSet: boolean;
  passwordSet: boolean;
  clientSecretSet: boolean;
  refreshTokenSet: boolean;
  /** Why the last sign-in failed; empty while it signs in, or does not sign in. */
  authError: string;
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

function resolveCommonOptions(command: Command, env?: NodeJS.ProcessEnv): CommonOptions {
  const globals = command.optsWithGlobals() as Partial<CommonOptions> & {
    requestTimeout?: string;
  };
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

function stderrOf(deps: ProjectDeps): (line: string) => void {
  return terminalSafeWriter(deps.stderr);
}

function localValidationError(message: string, field?: string): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request.',
      nextAction: message,
      requestId: 'local',
      details: { reason: 'missing_required_flag', ...(field ? { field } : {}) },
    },
  });
}

function envPath(projectId: string, name?: string): string {
  const base = `/projects/${encodeURIComponent(projectId)}/env`;
  return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
}

/**
 * Trim + reject an empty environment name and the dot names `.` and `..`
 * (they would escape the route when used as a path segment, and could never
 * be addressed again once created or renamed); the server owns every other rule.
 */
function requireEnvName(raw: string | undefined, flag: string): string {
  const name = raw?.trim() ?? '';
  if (name.length === 0) {
    throw localValidationError(
      `${flag} is required and must not be empty or whitespace-only`,
      flag === '--rename' ? 'rename' : undefined,
    );
  }
  if (name === '.' || name === '..') {
    throw localValidationError(
      `${flag} must not be "." or "..", which would escape the route. Use a descriptive name of 1-100 characters, unique within the project (for example "staging" or "local-dev").`,
      flag === '--rename' ? 'rename' : undefined,
    );
  }
  if (name.length > 100)
    throw localValidationError(
      `${flag} must be at most 100 characters`,
      flag === '--rename' ? 'rename' : undefined,
    );
  return name;
}

const RESERVED_VARIABLE_KEYS = new Set([
  'url',
  'username',
  'password',
  'authType',
  'credential',
  'memory_hints',
  'rerun_context',
  '__proto__',
  'constructor',
  'prototype',
]);

function parseVariables(raw: string[] | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  if (raw.length > 50) throw localValidationError('--var supports at most 50 keys.');
  const variables: Record<string, string> = Object.create(null) as Record<string, string>;
  let totalBytes = 0;
  for (const item of raw) {
    const separator = item.indexOf('=');
    if (separator <= 0) throw localValidationError('--var requires KEY=VALUE with a nonempty key.');
    const key = item.slice(0, separator);
    const value = item.slice(separator + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || RESERVED_VARIABLE_KEYS.has(key)) {
      throw localValidationError('--var key is invalid or reserved.');
    }
    if (Object.hasOwn(variables, key)) throw localValidationError('--var key was repeated.');
    if (Buffer.byteLength(value, 'utf8') > 4096) {
      throw localValidationError('--var value exceeds 4096 UTF-8 bytes.');
    }
    totalBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8');
    if (totalBytes > 32768) throw localValidationError('--var values exceed 32 KiB.');
    variables[key] = value;
  }
  return variables;
}

function collectVar(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function unsupportedServer(feature: string): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'UNSUPPORTED',
      message: `The server is too old to support ${feature}.${feature === 'project env get' ? '' : ' No requested write was sent.'}`,
      nextAction: `Upgrade the server before using ${feature}.`,
      requestId: 'local',
      details: {},
    },
  });
}

async function assertEnvironmentWriteSupport(
  client: HttpClient,
  projectId: string,
  name: string,
  feature: string,
): Promise<void> {
  try {
    const listed = await client.get<CliProjectEnvListResponse>(envPath(projectId));
    if (listed.environments?.length) {
      if (
        listed.environments.every(
          environment =>
            environment.variables !== undefined &&
            environment.variables !== null &&
            typeof environment.variables === 'object',
        )
      )
        return;
      throw unsupportedServer(feature);
    }
    const detail = await client.get<CliProjectEnvUpdateResponse>(envPath(projectId, name));
    if (
      !detail.environment ||
      detail.environment.variables === undefined ||
      detail.environment.variables === null ||
      typeof detail.environment.variables !== 'object'
    )
      throw unsupportedServer(feature);
  } catch (err) {
    if (err instanceof InterruptError) throw err;
    if (err instanceof ApiError) {
      if (err.code === 'UNSUPPORTED') throw err;
      if (err.httpStatus === 404 && !err.details.resource) throw unsupportedServer(feature);
      if (err.code === 'VALIDATION_ERROR' && err.details.field === 'environment') return;
      if (err.httpStatus !== 403) throw err;
    }
    // A key may have write:projects without read:projects. If the probe is
    // unavailable, preserve that write path and require the response echo below.
  }
}

function confirmRequestedEffects(
  environment: CliProjectEnvironment | undefined,
  requested: {
    clearCredentials?: boolean;
    variables?: Record<string, string>;
  },
  urlMayHaveChanged: boolean,
  created?: { projectId: string; name: string },
  updated?: {
    projectId: string;
    name: string;
    appliedFields: string[];
    passwordSupplied?: boolean;
  },
): void {
  const unapplied: string[] = [];
  if (
    requested.clearCredentials &&
    (environment?.hasCredentials !== false || environment.username)
  ) {
    unapplied.push('--clear-credentials');
  }
  if (requested.variables !== undefined) {
    const returned = environment?.variables;
    if (
      returned === undefined ||
      returned === null ||
      typeof returned !== 'object' ||
      Object.entries(requested.variables).some(
        ([key, value]) => !Object.hasOwn(returned, key) || returned[key] !== value,
      )
    ) {
      unapplied.push('--var');
    }
  }
  if (unapplied.length === 0) return;
  // A create already wrote the environment, so "retry" would hit a name
  // conflict; say what exists and how to finish once the server supports it.
  const receipt = created
    ? `The server did not apply ${unapplied.join(' / ')}; environment '${created.name}' was created without them.`
    : updated
      ? `The server did not apply ${unapplied.join(' / ')}; environment '${updated.name}' ${updated.appliedFields.length ? `was updated (${updated.appliedFields.join(' / ')} applied)` : 'accepted the update'}.`
      : `The server did not apply ${unapplied.join(' / ')}; upgrade the server or retry.`;
  const message =
    receipt +
    (updated?.passwordSupplied
      ? ' --password was supplied; its stored value is not returned.'
      : '');
  const retryFlags = unapplied.map(flag => (flag === '--var' ? '--var KEY=VALUE' : flag)).join(' ');
  const nextAction = created
    ? `${message} After the server is upgraded, run: testsprite project env update ${created.projectId} ${created.name} ${retryFlags}`
    : updated
      ? `${message} After the server is upgraded, run: testsprite project env update ${updated.projectId} ${updated.name} ${retryFlags}${urlMayHaveChanged ? ' URL may already have been applied.' : ''}`
      : `${message}${urlMayHaveChanged ? ' URL may already have been applied.' : ''}`;
  throw ApiError.fromEnvelope({
    error: {
      code: 'UNSUPPORTED',
      message,
      nextAction,
      requestId: 'local',
      details: {},
    },
  });
}

/**
 * Pure validation for `--password` / `--password-file`: mutual exclusion and
 * non-empty inline value. No filesystem I/O — safe to call before a
 * `--dry-run` early return, which must never touch the filesystem even when
 * `--password-file` is present (see `resolvePassword`).
 */
function assertPasswordFlagsValid(opts: { password?: string; passwordFile?: string }): void {
  if (opts.password !== undefined && opts.passwordFile !== undefined) {
    throw localValidationError('--password and --password-file are mutually exclusive.');
  }
  if (opts.password !== undefined && opts.password.trim().length === 0) {
    throw localValidationError('--password must not be empty or whitespace-only');
  }
}

/** Resolve `--password` / `--password-file` (mutually exclusive; never both). Real path only. */
function resolvePassword(opts: { password?: string; passwordFile?: string }): string | undefined {
  assertPasswordFlagsValid(opts);
  if (opts.password !== undefined) return opts.password;
  if (opts.passwordFile !== undefined) {
    return readSecretFileGuarded('password-file', opts.passwordFile);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// API sign-in flags (backend projects only)
// ---------------------------------------------------------------------------

const API_AUTHS = ['none', 'bearer', 'basic', 'apikey'] as const;

interface ApiAuthFlags {
  auth?: string;
  credential?: string;
  credentialFile?: string;
  header?: string[];
  headerFile?: string;
  autoAuthFile?: string;
}

/** The API sign-in flags present, by name. */
function apiAuthFlagNames(opts: ApiAuthFlags): string[] {
  return [
    opts.auth !== undefined ? '--auth' : '',
    opts.credential !== undefined || opts.credentialFile !== undefined ? '--credential' : '',
    opts.header?.length ? '--header' : '',
    opts.headerFile !== undefined ? '--header-file' : '',
    opts.autoAuthFile !== undefined ? '--auto-auth-file' : '',
  ].filter(Boolean);
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** One `Name: value` line, from `--header` or a line of `--header-file`. */
function parseHeaderLine(line: string, where: string): [string, string] {
  const colon = line.indexOf(':');
  const name = colon === -1 ? '' : line.slice(0, colon).trim();
  const value = colon === -1 ? '' : line.slice(colon + 1).trim();
  if (!HEADER_NAME.test(name)) {
    throw localValidationError(
      `${where} must be "Name: value", with a header name before the colon.`,
    );
  }
  if (!value) throw localValidationError(`${where}: header ${name} has no value.`);
  if ([...value].some(ch => ch < ' ' || ch === '\x7f')) {
    throw localValidationError(`${where}: header ${name} has a control character in its value.`);
  }
  return [name, value];
}

function collectHeaders(lines: string[], where: string, into: Record<string, string>): void {
  for (const line of lines) {
    const [name, value] = parseHeaderLine(line, where);
    if (Object.keys(into).some(key => key.toLowerCase() === name.toLowerCase())) {
      throw localValidationError(`Header ${name} is given twice; a header has one value.`);
    }
    into[name] = value;
  }
}

/**
 * Every check that needs no file read, so `--dry-run` still runs it: the
 * `--header` lines parse and the flags agree with each other. A new
 * environment has no stored type for a credential to attach to.
 */
function assertApiAuthFlagsValid(
  opts: ApiAuthFlags & { dryRun?: boolean },
  creating: boolean,
): void {
  if (opts.auth !== undefined && !(API_AUTHS as readonly string[]).includes(opts.auth)) {
    throw localValidationError(`--auth must be one of: ${API_AUTHS.join(', ')}.`);
  }
  if (opts.credential !== undefined && opts.credentialFile !== undefined) {
    throw localValidationError('--credential and --credential-file are mutually exclusive.');
  }
  if (opts.credential !== undefined && opts.credential.trim().length === 0) {
    throw localValidationError('--credential must not be empty or whitespace-only');
  }
  if (
    opts.auth === 'basic' &&
    opts.credential !== undefined &&
    opts.dryRun &&
    !basicAuthToken(opts.credential)
  ) {
    throw localValidationError(BASIC_AUTH_FORMAT);
  }
  const credentialGiven = opts.credential !== undefined || opts.credentialFile !== undefined;
  if (opts.auth === 'none' && credentialGiven) {
    throw localValidationError('--auth none sends no credential; drop --credential.');
  }
  if (creating && credentialGiven && opts.auth === undefined) {
    throw localValidationError('--credential needs --auth on a new environment.');
  }
  if (opts.autoAuthFile !== undefined && (opts.auth !== undefined || credentialGiven)) {
    throw localValidationError(
      '--auto-auth-file is a sign-in and replaces a static credential; drop --auth and --credential.',
    );
  }
  collectHeaders(opts.header ?? [], '--header', {});
}

function readJsonFlagFile(flag: string, path: string): unknown {
  const text = readSecretFileGuarded(flag, path);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw localValidationError(`--${flag} is not valid JSON.`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The request fields for the API sign-in flags. Reads the files, so real path
 * only. Headers replace the stored set. The auto-auth file goes to the server
 * as it is, switched on unless it says `"enabled": false`; the server refuses
 * a field it does not know.
 */
function resolveApiAuthBody(opts: ApiAuthFlags): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (opts.auth !== undefined) body.auth = opts.auth;
  let credential = opts.credential;
  if (opts.credentialFile !== undefined) {
    credential = readSecretFileGuarded('credential-file', opts.credentialFile);
    if (!credential.trim()) throw localValidationError('--credential-file is empty.');
    // With no --auth on an update only the server knows the stored type.
    if (opts.auth && opts.auth !== 'basic') credential = credential.trim();
  }
  if (credential !== undefined) {
    if (opts.auth === 'basic') {
      const token = basicAuthToken(credential);
      if (!token) throw localValidationError(BASIC_AUTH_FORMAT);
      body.credential = token;
    } else {
      body.credential = credential;
    }
  }
  if (opts.header?.length || opts.headerFile !== undefined) {
    const headers: Record<string, string> = {};
    collectHeaders(opts.header ?? [], '--header', headers);
    if (opts.headerFile !== undefined) {
      const lines = readSecretFileGuarded('header-file', opts.headerFile)
        .split(/\r?\n/)
        .filter(line => line.trim().length > 0);
      collectHeaders(lines, '--header-file line', headers);
    }
    body.extraHeaders = headers;
  }
  if (opts.autoAuthFile !== undefined) {
    const config = readJsonFlagFile('auto-auth-file', opts.autoAuthFile);
    if (!isRecord(config)) throw localValidationError('--auto-auth-file must hold a JSON object.');
    body.autoAuth = { enabled: true, ...config };
  }
  return body;
}

/**
 * What `get` will show once the flags apply, for `--dry-run`. No file is
 * read, and every header is shown as set: a dry run's output may land in a
 * log, and the server decides which values are secret.
 */
function sampleApi(opts: ApiAuthFlags, url: string): CliApiEnvironment | undefined {
  if (apiAuthFlagNames(opts).length === 0) return undefined;
  const headers: Record<string, string> = {};
  collectHeaders(opts.header ?? [], '--header', headers);
  return {
    url,
    auth: opts.autoAuthFile !== undefined ? 'login' : (opts.auth ?? 'none'),
    loginUrl: '',
    loginMethod: '',
    loginContentType: '',
    loginBody: '',
    username: '',
    tokenPath: '',
    tokenUrl: '',
    clientId: '',
    scope: '',
    region: '',
    inject: '',
    headers: Object.fromEntries(Object.keys(headers).map(name => [name, null])),
    credentialSet: opts.credential !== undefined || opts.credentialFile !== undefined,
    passwordSet: false,
    clientSecretSet: false,
    refreshTokenSet: false,
    authError: '',
  };
}

/**
 * The server answered without `api`: an older server's whitelist dropped the
 * API sign-in fields silently, so nothing of them was applied.
 */
function apiAuthNotApplied(projectId: string, name: string, created: boolean): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'UNSUPPORTED',
      message: `The server did not apply the API sign-in${created ? `; environment '${name}' was created without it` : ''}.`,
      nextAction: `Upgrade the server, then run: testsprite project env update ${projectId} ${name} <the same --auth / --credential-file / --header / --auto-auth-file flags>`,
      requestId: 'local',
      details: {},
    },
  });
}

/** A save that sent a sign-in switched on but came back failing: its trial login failed. */
function warnIfSignInFailed(
  environment: CliProjectEnvironment | undefined,
  body: Record<string, unknown>,
  projectId: string,
  stderr: (line: string) => void,
): void {
  const wanted = isRecord(body.autoAuth) && body.autoAuth.enabled === true;
  if (!wanted || !environment?.api?.authError) return;
  stderr(
    `The sign-in was saved switched off: its trial login failed (${terminalSafeLine(environment.api.authError)}). ` +
      `Fix the config and run: testsprite project env update ${projectId} ${terminalSafeLine(environment.name)} --auto-auth-file <path>`,
  );
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
  if (env.api) {
    return [
      terminalSafeLine(env.api.auth),
      env.api.credentialSet ? '(credential set)' : '',
      env.api.authError ? '(sign-in failing)' : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  // `otp` already says the mode; repeating it as a suffix read as two settings.
  const parts = [terminalSafeLine(env.authMode)];
  if (env.hasCredentials) parts.push('(credentials set)');
  if (env.enableOtp && env.authMode !== 'otp') parts.push('+otp');
  return parts.join(' ');
}

const LIST_SESSION: Record<string, string> = {
  valid: 'signed in',
  never: 'not logged in',
  expired: 'expired',
};

/** The list's AUTH cell: the mode and, for a manual environment, whether its login is usable. */
function listAuth(env: CliProjectEnvironment): string {
  if (!env.manualLogin) return describeAuth(env);
  const { session } = env.manualLogin;
  return `${describeAuth(env)} (${LIST_SESSION[session] ?? session})`;
}

/** A manual environment's login, for `get`. */
function describeManualLogin(login: CliManualLogin): string {
  switch (login.session) {
    case 'valid':
      return login.expiresAt
        ? `signed in until ${terminalSafeLine(login.expiresAt)}`
        : 'signed in (never expires)';
    case 'never':
      return 'not logged in yet';
    case 'expired':
      return login.expiresAt ? `expired at ${terminalSafeLine(login.expiresAt)}` : 'expired';
    default:
      return terminalSafeLine(login.session);
  }
}

/**
 * "in the Portal" and where: the environment's own page when the server links it,
 * else the way there.
 */
function inPortal(env: CliProjectEnvironment, step?: string): string {
  const then = step ? ` → ${step}` : '';
  return env.portalUrl
    ? `in the Portal: ${terminalSafeLine(env.portalUrl)}${then}`
    : `in the Portal (project → Settings → Environments → ${terminalSafeLine(env.name)}${then})`;
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
    width: rows => Math.max(4, ...rows.map(env => listAuth(env).length)),
    render: listAuth,
  },
  { header: 'ACCOUNT', width: 0, render: env => env.username ?? '—' },
];

function renderEnvListText(r: CliProjectEnvListResponse): string {
  if (r.environments.length === 0) {
    return 'No environments. Create one with: testsprite project env create <project-id> --name <name> --url <url>';
  }
  return renderTextTable(r.environments, ENV_LIST_COLUMNS);
}

const STATIC_API_AUTHS = ['bearer', 'basic', 'apikey'];
const SIGN_IN_API_AUTHS = ['login', 'refresh-token', 'cognito'];

/** The lines of the agent's `environments/<name>.md`, under `get`'s keys; an empty value is left out. */
function renderApiLines(api: CliApiEnvironment): string[] {
  const mark = (set: boolean) => (set ? 'set' : 'none');
  const lines: string[] = [];
  const add = (key: string, value: string) => {
    if (value) lines.push(`${key}:`.padEnd(13) + terminalSafeLine(value));
  };
  if (STATIC_API_AUTHS.includes(api.auth)) add('credential', mark(api.credentialSet));
  if (api.auth === 'login') {
    add('login-url', api.loginUrl);
    add('login-method', api.loginMethod);
    add('login-content-type', api.loginContentType);
    add('login-body', api.loginBody);
    add('username', api.username);
    add('password', mark(api.passwordSet));
    add('token-path', api.tokenPath);
  }
  if (api.auth === 'refresh-token') add('token-url', api.tokenUrl);
  if (api.auth === 'cognito') add('region', api.region);
  if (api.auth === 'refresh-token' || api.auth === 'cognito') {
    add('client-id', api.clientId);
    add('client-secret', mark(api.clientSecretSet));
    add('refresh-token', mark(api.refreshTokenSet));
  }
  if (api.auth === 'refresh-token') add('scope', api.scope);
  if (SIGN_IN_API_AUTHS.includes(api.auth)) add('inject', api.inject);
  add('auth-error', api.authError);
  const names = Object.keys(api.headers).sort((a, b) => a.localeCompare(b));
  lines.push(`headers:     ${names.length}`);
  for (const name of names) {
    const value = api.headers[name];
    lines.push(`  ${terminalSafeLine(name)}: ${value == null ? '<set>' : terminalSafeLine(value)}`);
  }
  return lines;
}

function renderEnvText(env: CliProjectEnvironment): string {
  const login = env.manualLogin
    ? describeManualLogin(env.manualLogin)
    : env.enableOtp || !['public', 'none', 'account'].includes(env.authMode)
      ? 'managed in Portal'
      : env.authMode === 'public' || env.authMode === 'none' || !env.hasCredentials
        ? 'none'
        : `username+password${env.username ? ` (${terminalSafeLine(env.username)})` : ''}`;
  const ttl = env.manualLogin?.sessionReuseTtlSeconds;
  const lines = [
    `name:        ${terminalSafeLine(env.name)}`,
    `id:          ${terminalSafeLine(env.id)}`,
    `default:     ${env.isDefault ? 'yes' : 'no'}`,
    `url:         ${terminalSafeLine(env.url)}`,
    `auth:        ${describeAuth(env)}`,
    ...(env.api
      ? [...renderApiLines(env.api), `updatedAt:   ${terminalSafeLine(env.updatedAt)}`]
      : [
          `account:     ${terminalSafeLine(env.username ?? '(none stored)')}`,
          `updatedAt:   ${terminalSafeLine(env.updatedAt)}`,
          `login:       ${login}`,
          ...(ttl === undefined
            ? []
            : [
                `session-ttl: ${ttl === -1 ? 'never expires' : `${terminalSafeLine(String(ttl))}s`}`,
              ]),
        ]),
    ...(env.portalUrl ? [`portal:      ${terminalSafeLine(env.portalUrl)}`] : []),
  ];
  const variables = Object.entries(env.variables ?? {}).filter(([key]) => key !== 'password');
  lines.push(`variables:   ${variables.length}`);
  for (const [key, value] of variables.sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${terminalSafeLine(key)}=${terminalSafeLine(value)}`);
  }
  return lines.join('\n');
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
    variables: {},
    ...overrides,
  };
}

/**
 * Defence-in-depth DENY-list applied to an environment ONLY at the point it
 * reaches `Output.print`. `Output.print`'s JSON branch stringifies its input
 * verbatim BY DESIGN so that success data round-trips byte-identical — see the
 * comment on `Output.print` and `redact.ts` — and this codebase treats an
 * unrecognized field on a success payload as something to PASS THROUGH, not
 * drop (`project get`'s `defaultEnvironment`/`environmentCount`, and
 * `CliProjectEnvironment.authMode` itself
 * is an open string specifically so a mode added server-side shows up
 * without a CLI release). An allow-list here would silently swallow any new
 * field the server starts returning until the CLI ships again — so this
 * shallow-copies the environment and removes only the two shapes a
 * regression could use to leak a credential: a stray top-level `password`
 * and the Portal's raw `config` object (see the type comment above — the
 * wire shape is documented to never carry either). `variables` gets the same
 * treatment as the reserved-key set the CLI already enforces on `--var`
 * (`RESERVED_VARIABLE_KEYS`, mirrored server-side): everything else in
 * `variables` — and everything else on the environment — passes through
 * untouched, including a `variables` key the source never had at all ("JSON
 * does not invent fields for older backends" falls out of the copy for
 * free). Only the PRINTED copy is affected — the value `runEnv*` returns to
 * its caller is the untouched server response.
 */
function forDisplay(env: CliProjectEnvironment | undefined): CliProjectEnvironment | undefined {
  if (env === undefined || env === null || typeof env !== 'object') return env;
  const clone: Record<string, unknown> = { ...(env as unknown as Record<string, unknown>) };
  delete clone.password;
  delete clone.config;
  if (
    clone.variables !== undefined &&
    clone.variables !== null &&
    typeof clone.variables === 'object'
  ) {
    const variables: Record<string, unknown> = { ...(clone.variables as Record<string, unknown>) };
    for (const key of RESERVED_VARIABLE_KEYS) delete variables[key];
    clone.variables = variables;
  }
  return clone as unknown as CliProjectEnvironment;
}

/** Apply {@link forDisplay} to a single-environment response, for `out.print` only. */
function envForPrint<T extends { environment: CliProjectEnvironment }>(res: T): T {
  return { ...res, environment: forDisplay(res.environment) as CliProjectEnvironment };
}

/** Apply {@link forDisplay} to a list response, for `out.print` only. */
function envListForPrint(res: CliProjectEnvListResponse): CliProjectEnvListResponse {
  return {
    environments: res.environments.map(e => forDisplay(e) as CliProjectEnvironment),
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
    out.print(envListForPrint(sample), data =>
      renderEnvListText(data as CliProjectEnvListResponse),
    );
    return sample;
  }
  const client = makeClient(opts, deps);
  const res = await client.get<CliProjectEnvListResponse>(envPath(opts.projectId));
  out.print(envListForPrint(res), data => renderEnvListText(data as CliProjectEnvListResponse));
  return res;
}

export async function runEnvGet(
  opts: EnvListOptions & { name: string },
  deps: ProjectDeps = {},
): Promise<CliProjectEnvUpdateResponse> {
  const out = makeOutput(opts.output, deps);
  const name = requireEnvName(opts.name, '<name>');
  if (opts.dryRun) {
    emitDryRunBanner(stderrOf(deps));
    const sample = { environment: sampleEnv({ name }) };
    out.print(envForPrint(sample), data =>
      renderEnvText((data as CliProjectEnvUpdateResponse).environment),
    );
    return sample;
  }
  const client = makeClient(opts, deps);
  let res: CliProjectEnvUpdateResponse;
  try {
    res = await client.get<CliProjectEnvUpdateResponse>(envPath(opts.projectId, name));
  } catch (err) {
    if (err instanceof ApiError && err.httpStatus === 404 && !err.details.resource)
      throw unsupportedServer('project env get');
    throw err;
  }
  out.print(envForPrint(res), data =>
    renderEnvText((data as CliProjectEnvUpdateResponse).environment),
  );
  return res;
}

// ---------------------------------------------------------------------------
// project env create
// ---------------------------------------------------------------------------

interface EnvCreateOptions extends CommonOptions, ApiAuthFlags {
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
  vars?: string[];
  setDefault?: boolean;
  idempotencyKey?: string;
  signIn?: string;
  otpChannel?: string[];
  sessionTtl?: string;
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
        'For a web app on this machine, pass --url http://localhost:<port>, then run it ' +
        'with `run <id> --env <name>`; the CLI opens a tunnel automatically.',
    );
  }
  if (opts.url !== undefined && !localTarget) {
    assertNotLocal(opts.url, {
      field: 'url',
      helpCommand: 'testsprite project env create',
      hintContext: 'local-project-create',
    });
  }
  const url =
    opts.url ??
    (localTarget ? buildLocalTargetUrl(localTarget.host, localTarget.port) : undefined)!;
  const signIn = opts.signIn === undefined ? undefined : parseSignInMode(opts.signIn, '--sign-in');
  validateSignInFlags(signIn, opts, true);
  if (localTarget && (signIn === 'otp' || signIn === 'manual')) {
    throw signInValidationError(
      '--sign-in otp and --sign-in manual are not available for local environments (runs through the tunnel sign in inline); use --sign-in public or account.',
      'local-environment-sign-in-unsupported',
    );
  }
  const otpChannels = opts.otpChannel?.flatMap(value =>
    value.split(',').map(channel => channel.trim()),
  );
  if (
    otpChannels &&
    (otpChannels.length === 0 ||
      otpChannels.some(channel => channel !== 'email' && channel !== 'sms'))
  ) {
    throw signInValidationError('--otp-channel accepts email and sms only.');
  }
  const uniqueOtpChannels = otpChannels === undefined ? undefined : [...new Set(otpChannels)];
  const variables = parseVariables(opts.vars);
  const passwordGiven = opts.password !== undefined || opts.passwordFile !== undefined;
  if (signIn === undefined && (opts.username !== undefined) !== passwordGiven) {
    // Half an account would be stored on a public environment.
    throw localValidationError(
      '--username and --password (or --password-file) go together; pass both for a test account, or neither.',
    );
  }
  assertApiAuthFlagsValid(opts, true);

  if (opts.dryRun) {
    emitDryRunBanner(stderr);
    mintIdempotencyKey('create', opts, stderr);
    const hasCredentials =
      opts.username !== undefined &&
      (opts.password !== undefined || opts.passwordFile !== undefined) &&
      (signIn === undefined || signIn === 'account');
    const previewMode = signIn ?? (hasCredentials ? 'account' : 'public');
    const sample: CliProjectEnvCreateResponse = {
      environment: sampleEnv({
        name,
        url,
        isDefault: opts.setDefault === true,
        authMode: previewMode,
        hasCredentials,
        username: hasCredentials ? (opts.username ?? null) : null,
        enableOtp: previewMode === 'otp',
        variables: variables ?? {},
        api: sampleApi(opts, url),
      }),
      created: true,
    };
    out.print(envForPrint(sample), data =>
      renderEnvText((data as CliProjectEnvCreateResponse).environment),
    );
    return sample;
  }

  const client = makeClient(opts, deps);
  if (localTarget) {
    await assertLocalEnvironmentAllowed(client, opts);
    await assertStoredLocalTargetListening(localTarget, opts, deps.localPortProbeDeps);
  }

  // Secrets are read only on the real path — never for a dry run.
  const password = resolvePassword(opts);
  const body: Record<string, unknown> = { name, url };
  // The marker rides with the URL: it is what authorizes storing a loopback
  // address, and it lives on the environment the server creates.
  if (localTarget) body.originMode = 'local';
  if (opts.username !== undefined) body.username = opts.username;
  if (password !== undefined) body.password = password;
  if (opts.setDefault) body.setDefault = true;
  if (variables !== undefined) body.variables = variables;
  if (signIn !== undefined) body.signIn = signIn;
  if (signIn === 'otp') body.otpChannels = uniqueOtpChannels ?? ['email'];
  if (opts.sessionTtl !== undefined) body.sessionReuseTtlSeconds = parseSessionTtl(opts.sessionTtl);
  Object.assign(body, resolveApiAuthBody(opts));

  const idempotencyKey = mintIdempotencyKey('create', opts, stderr);
  if (variables !== undefined)
    await assertEnvironmentWriteSupport(client, opts.projectId, name, '--var');
  const res = await client.post<CliProjectEnvCreateResponse>(envPath(opts.projectId), {
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });
  confirmRequestedEffects(res.environment, { variables }, false, {
    projectId: opts.projectId,
    name: res.environment?.name ?? name,
  });
  if (apiAuthFlagNames(opts).length > 0 && res.environment?.api === undefined) {
    throw apiAuthNotApplied(opts.projectId, res.environment?.name ?? name, true);
  }
  if (opts.output === 'text') warnIfSignInFailed(res.environment, body, opts.projectId, stderr);
  out.print(envForPrint(res), data =>
    renderEnvText((data as CliProjectEnvCreateResponse).environment),
  );
  if (opts.output === 'text' && signIn === 'manual')
    stderr(
      `SSO selected: runs will NOT be signed in until someone logs in once ${inPortal(res.environment, 'Log in')}.`,
    );
  if (opts.output === 'text' && signIn === 'otp')
    stderr(`OTP selected: see the provisioned inbox/phone ${inPortal(res.environment)}.`);
  // Said once, when the address is stored: the agent can only open an app on
  // this machine through a tunnel the user starts, and `plan` has no flag for it.
  if (opts.output === 'text' && localTarget) stderr(LOCAL_ENVIRONMENT_HINT);
  return res;
}

const LOCAL_ENVIRONMENT_HINT =
  'This app is on your machine: before `testsprite plan`, run `testsprite tunnel start` in another terminal so the agent can open it (`testsprite run` opens its own tunnel).';

/**
 * A local environment is a web app the tunnel reaches; a backend project's
 * tests never use one. Asked before the port check, so the answer does not
 * depend on whether anything listens there. A key that cannot read the
 * project keeps the old path: the server refuses it too.
 */
async function assertLocalEnvironmentAllowed(
  client: HttpClient,
  opts: { projectId: string; local?: string },
): Promise<void> {
  let type: string | undefined;
  try {
    ({ type } = await client.get<{ type?: string }>(
      `/projects/${encodeURIComponent(opts.projectId)}`,
    ));
  } catch (err) {
    if (err instanceof ApiError && err.httpStatus === 403) return;
    throw err;
  }
  if (type !== 'backend') return;
  throw ApiError.fromEnvelope({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request.',
      nextAction:
        "A backend project's environment must point at a publicly deployed API; local environments are for frontend projects only.",
      requestId: 'local',
      details: {
        field: opts.local !== undefined ? 'local' : 'url',
        reason: 'backend-local-environment',
      },
    },
  });
}

// ---------------------------------------------------------------------------
// project env update
// ---------------------------------------------------------------------------

interface EnvUpdateOptions extends CommonOptions, ApiAuthFlags {
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
  clearCredentials?: boolean;
  vars?: string[];
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
    if (!localTarget)
      assertNotLocal(opts.url, {
        field: 'url',
        helpCommand: 'testsprite project env update',
        hintContext: 'local-project-create',
      });
  }
  const url =
    opts.url ?? (localTarget ? buildLocalTargetUrl(localTarget.host, localTarget.port) : undefined);
  if (opts.username !== undefined && opts.username.trim().length === 0) {
    throw localValidationError('--username must not be empty or whitespace-only');
  }
  const rename = opts.rename !== undefined ? requireEnvName(opts.rename, '--rename') : undefined;
  const variables = parseVariables(opts.vars);
  const passwordSupplied = opts.password !== undefined || opts.passwordFile !== undefined;
  if (
    opts.clearCredentials &&
    (opts.username !== undefined || opts.password !== undefined || opts.passwordFile !== undefined)
  ) {
    throw localValidationError(
      '--clear-credentials excludes --username, --password and --password-file.',
    );
  }
  const mutable = {
    url: url !== undefined,
    username: opts.username !== undefined,
    password: passwordSupplied,
    rename: rename !== undefined,
    clearCredentials: opts.clearCredentials === true,
    variables: variables !== undefined,
    api: apiAuthFlagNames(opts).length > 0,
  };
  const present = Object.entries(mutable)
    .filter(([, on]) => on)
    .map(([field]) => field);
  if (present.length === 0) {
    throw localValidationError(
      'At least one mutable flag is required: --url, --username, ' +
        '--password / --password-file, --clear-credentials, --rename, --var, ' +
        '--auth, --credential / --credential-file, --header / --header-file, or --auto-auth-file.',
    );
  }
  // See the matching comment in `runEnvCreate`: validate credential flag
  // usage before the dry-run plan is built, not just on the real path.
  assertPasswordFlagsValid(opts);
  assertApiAuthFlagsValid(opts, false);

  if (opts.dryRun) {
    emitDryRunBanner(stderr);
    mintIdempotencyKey('update', opts, stderr);
    const sample: CliProjectEnvUpdateResponse = {
      environment: sampleEnv({
        name: rename ?? name,
        url: url ?? 'https://staging.example.com',
        hasCredentials: passwordSupplied,
        variables: variables ?? {},
        api: sampleApi(opts, url ?? 'https://staging.example.com'),
      }),
    };
    out.print(envForPrint(sample), data =>
      renderEnvText((data as CliProjectEnvUpdateResponse).environment),
    );
    return sample;
  }

  const client = makeClient(opts, deps);
  if (localTarget) {
    await assertLocalEnvironmentAllowed(client, opts);
    await assertStoredLocalTargetListening(localTarget, opts, deps.localPortProbeDeps);
  }

  const password = resolvePassword(opts);
  const body: Record<string, unknown> = {};
  if (url !== undefined) body.url = url;
  if (localTarget) body.originMode = 'local';
  if (opts.username !== undefined) body.username = opts.username;
  if (password !== undefined) body.password = password;
  if (rename !== undefined) body.rename = rename;
  if (opts.clearCredentials) body.clearCredentials = true;
  if (variables !== undefined) body.variables = variables;
  Object.assign(body, resolveApiAuthBody(opts));

  const idempotencyKey = mintIdempotencyKey('update', opts, stderr);
  if (variables !== undefined || opts.clearCredentials) {
    await assertEnvironmentWriteSupport(
      client,
      opts.projectId,
      name,
      [opts.clearCredentials ? '--clear-credentials' : '', variables !== undefined ? '--var' : '']
        .filter(Boolean)
        .join(' / '),
    );
  }
  const res = await client.patch<CliProjectEnvUpdateResponse>(envPath(opts.projectId, name), {
    body,
    headers: { 'idempotency-key': idempotencyKey },
  });
  confirmRequestedEffects(
    res.environment,
    { clearCredentials: opts.clearCredentials, variables },
    url !== undefined,
    undefined,
    {
      projectId: opts.projectId,
      name: res.environment?.name ?? name,
      passwordSupplied: password !== undefined,
      appliedFields: [
        rename !== undefined && res.environment?.name === rename ? '--rename' : '',
        url !== undefined && res.environment?.url === url ? '--url' : '',
        opts.username !== undefined && res.environment?.username === opts.username
          ? '--username'
          : '',
        opts.clearCredentials &&
        res.environment?.hasCredentials === false &&
        !res.environment.username
          ? '--clear-credentials'
          : '',
      ].filter(Boolean),
    },
  );
  if (apiAuthFlagNames(opts).length > 0 && res.environment?.api === undefined) {
    throw apiAuthNotApplied(opts.projectId, res.environment?.name ?? name, false);
  }
  out.print(envForPrint(res), data =>
    renderEnvText((data as CliProjectEnvUpdateResponse).environment),
  );
  if (opts.output === 'text') warnIfSignInFailed(res.environment, body, opts.projectId, stderr);
  if (opts.output === 'text' && url !== undefined && res.environment.authMode === 'manual')
    stderr(
      `This environment signs in with an SSO session captured on its previous address; if the site changed, log in again ${inPortal(res.environment, 'Log in')}.`,
    );
  if (opts.output === 'text' && localTarget) stderr(LOCAL_ENVIRONMENT_HINT);
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
  out.print(
    res,
    data => `deleted: ${terminalSafeLine((data as CliProjectEnvDeleteResponse).name)}`,
  );
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
    out.print(envForPrint(sample), data =>
      renderEnvText((data as CliProjectEnvUpdateResponse).environment),
    );
    return sample;
  }

  const idempotencyKey = mintIdempotencyKey('set-default', opts, stderr);
  const client = makeClient(opts, deps);
  const res = await client.post<CliProjectEnvUpdateResponse>(
    `${envPath(opts.projectId, name)}/default`,
    { body: {}, headers: { 'idempotency-key': idempotencyKey } },
  );
  out.print(envForPrint(res), data =>
    renderEnvText((data as CliProjectEnvUpdateResponse).environment),
  );
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
  var?: string[];
  setDefault?: boolean;
  idempotencyKey?: string;
  signIn?: string;
  otpChannel?: string[];
  sessionTtl?: string;
  auth?: string;
  credential?: string;
  credentialFile?: string;
  header?: string[];
  headerFile?: string;
  autoAuthFile?: string;
}

interface EnvUpdateFlagOpts extends ApiAuthFlags {
  url?: string;
  local?: string;
  localHost?: string;
  skipPreflight?: boolean;
  username?: string;
  password?: string;
  passwordFile?: string;
  clearCredentials?: boolean;
  var?: string[];
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

const API_AUTH_HELP =
  '\nAPI sign-in (backend projects): what runs sign in to the API with, kept on the environment as the\n' +
  'project\'s agent reads it. --auth none|bearer|basic|apikey with --credential-file; --header "Name: value"\n' +
  '(repeatable) and --header-file (one "Name: value" per line, for secret values) replace the extra\n' +
  'headers every request carries; --auto-auth-file holds a sign-in that refreshes the credential, e.g.\n' +
  '  {"method": "password", "inject": "bearer", "loginUrl": "https://api.example.com/login",\n' +
  '   "loginBodyTemplate": "{\\"email\\":\\"{{username}}\\",\\"password\\":\\"{{password}}\\"}",\n' +
  '   "username": "qa@example.com", "password": "<secret>", "tokenPath": "$.access_token"}\n' +
  'method: password | refresh_token (tokenEndpoint, clientId, refreshToken) | aws_cognito_refresh (region,\n' +
  'clientId, refreshToken); inject: bearer | header | cookie (header and cookie take injectKey). The file is\n' +
  'sent as it is: the server refuses a field it does not know, a secret left out keeps its stored value,\n' +
  '"enabled": false saves it switched off. Saving a sign-in runs a trial login and needs a plan with\n' +
  'advanced environment settings; --auth replaces a sign-in with a static credential. Which endpoint\n' +
  'needs which header is decided in the Portal.\n' +
  'For Basic auth, supply username:password or its base64 encoding.\n';

const LIST_EXIT_CODE_NOTE =
  '\nExit codes:\n' +
  '  0  success\n' +
  '  3  auth error\n' +
  '  4  project not found\n' +
  '  5  validation error';
const GET_EXIT_CODE_NOTE =
  '\nExit codes:\n' +
  '  0  success\n' +
  '  3  auth error\n' +
  '  4  project or environment not found\n' +
  '  5  validation error';
const DELETE_EXIT_CODE_NOTE =
  '\nExit codes:\n' +
  '  0  success\n' +
  '  3  auth error\n' +
  '  4  project or environment not found\n' +
  '  5  validation error (e.g., missing --confirm)\n' +
  '  6  conflict (the default environment cannot be deleted)';
const SET_DEFAULT_EXIT_CODE_NOTE =
  '\nExit codes:\n' +
  '  0  success\n' +
  '  3  auth error\n' +
  '  4  project or environment not found\n' +
  '  5  validation error';
const UPDATE_EXIT_CODE_NOTE =
  '\nExit codes:\n' +
  '  0  success\n' +
  '  3  auth error\n' +
  '  4  project (or environment) not found\n' +
  '  5  validation error\n' +
  '  6  conflict (name already exists) / precondition (credentials or a local address on an SSO or OTP environment; change its sign-in in the Portal)';
const CREATE_EXIT_CODE_NOTE =
  '\nExit codes:\n' +
  '  0  success\n' +
  '  3  auth error\n' +
  '  4  project not found\n' +
  '  5  validation error\n' +
  '  6  conflict (name already exists) / precondition (OTP or SSO on a local environment)' +
  '\n  7  unsupported (OTP/SSO in BYOC)' +
  '\n  10 service unavailable' +
  '\n  11 rate limited' +
  '\n  13 SSO feature gated' +
  '\n  14 client too old';

export function createProjectEnvCommand(deps: ProjectDeps = {}): Command {
  const env = new Command('env')
    .summary("Manage a project's environments")
    .description(
      "Manage a project's environments — named URL + test-account bundles that `run --env <name>` selects",
    )
    .addHelpText(
      'after',
      '\nFor a web app that only runs on this machine (frontend projects), create or update the environment\n' +
        'with `--url http://localhost:<port>`; `run <id> --env <name>` opens a tunnel automatically.',
    );

  env
    .command('list <project-id>')
    .summary("List a project's environments")
    .description("List a project's environments (name, default, URL, auth)." + LIST_EXIT_CODE_NOTE)
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (projectId: string, _cmdOpts: unknown, command: Command) => {
      await runEnvList({ ...resolveCommonOptions(command, deps.env), projectId }, deps);
    });

  env
    .command('get <project-id> <name>')
    .summary('Get one environment by name')
    .description('Get one environment by name, including its login settings.' + GET_EXIT_CODE_NOTE)
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (projectId: string, name: string, _cmdOpts: unknown, command: Command) => {
      await runEnvGet({ ...resolveCommonOptions(command, deps.env), projectId, name }, deps);
    });

  env
    .command('create <project-id>')
    .summary('Create an environment')
    .description(
      'Create an environment (--name and --url are required; --local <port> is shorthand for --url http://localhost:<port>).' +
        CREATE_EXIT_CODE_NOTE,
    )
    .option('--name <name>', 'environment name, unique within the project (required)')
    .option(
      '--url <url>',
      'address runs open (public http/https, or a loopback http origin with an explicit port)',
    )
    .option(
      '--local <port>',
      'shorthand for --url http://localhost:<port> (1-65535; excludes --url; frontend only)',
    )
    .addOption(
      new Option(
        '--local-host <host>',
        'deprecated loopback host override; requires --local',
      ).hideHelp(),
    )
    .option('--skip-preflight', 'skip the local TCP listener check before creating')
    .option('--username <user>', 'test-account username the browser logs in with')
    .option('--password <pw>', 'test-account password (prefer --password-file, exclusive)')
    .option('--password-file <path>', 'read the password from a file instead of the command line')
    .option(
      '--var <KEY=VALUE>',
      'set a custom variable (repeatable; max 50, 4096 bytes each, key [A-Za-z_][A-Za-z0-9_]*, reserved names like url/username/password rejected); shown in plain text by `env get`, not for secrets',
      collectVar,
      [],
    )
    .option(
      '--sign-in <mode>',
      'public, account, otp, or manual (aliases: none, credentials, sso). manual: log in once in the Portal, runs reuse that session (not signed in until then). otp and manual: not for local environments',
    )
    .option(
      '--otp-channel <email,sms>',
      'OTP channels: email and/or sms; repeat or comma-separate (default: email)',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      '--session-ttl <seconds|never>',
      'SSO session reuse lifetime: 1–2592000 seconds or never (manual only)',
    )
    .option(
      '--auth <type>',
      'backend projects: how runs sign in to the API — none, bearer, basic or apikey; replaces a sign-in',
    )
    .option(
      '--credential <value>',
      'backend projects: static credential value (prefer --credential-file, exclusive)',
    )
    .option('--credential-file <path>', 'backend projects: read the static credential from a file')
    .option(
      '--header <"Name: value">',
      'backend projects: an extra request header (repeatable; replaces the stored set)',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      '--header-file <path>',
      'backend projects: extra request headers, one "Name: value" per line (for secret values)',
    )
    .option(
      '--auto-auth-file <path>',
      'backend projects: JSON sign-in that refreshes the credential; replaces a static one (see below)',
    )
    .option('--set-default', "make this the project's default environment", false)
    .option('--idempotency-key <token>', IDEMPOTENCY_HELP)
    .addHelpText('after', API_AUTH_HELP)
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (projectId: string, cmdOpts: EnvCreateFlagOpts, command: Command) => {
      await runEnvCreate(
        {
          ...resolveCommonOptions(command, deps.env),
          projectId,
          name: cmdOpts.name,
          url: cmdOpts.url,
          local: cmdOpts.local,
          localHost: cmdOpts.localHost,
          skipPreflight: cmdOpts.skipPreflight,
          username: cmdOpts.username,
          password: cmdOpts.password,
          passwordFile: cmdOpts.passwordFile,
          vars: cmdOpts.var,
          signIn: cmdOpts.signIn,
          otpChannel: cmdOpts.otpChannel,
          sessionTtl: cmdOpts.sessionTtl,
          auth: cmdOpts.auth,
          credential: cmdOpts.credential,
          credentialFile: cmdOpts.credentialFile,
          header: cmdOpts.header,
          headerFile: cmdOpts.headerFile,
          autoAuthFile: cmdOpts.autoAuthFile,
          setDefault: cmdOpts.setDefault === true,
          idempotencyKey: cmdOpts.idempotencyKey,
        },
        deps,
      );
    });

  env
    .command('update <project-id> <name>')
    .summary('Change an environment')
    .description(
      "Change an environment's URL, credentials, custom variables, name or (backend projects) API sign-in; a frontend sign-in mode changes in the Portal." +
        UPDATE_EXIT_CODE_NOTE,
    )
    .option(
      '--url <url>',
      'new address runs open (public http/https, or a loopback http origin with an explicit port)',
    )
    .option(
      '--local <port>',
      'shorthand for --url http://localhost:<port> (1-65535; excludes --url)',
    )
    .addOption(
      new Option(
        '--local-host <host>',
        'deprecated loopback host override; requires --local',
      ).hideHelp(),
    )
    .option('--skip-preflight', 'skip the local TCP listener check before the update')
    .option('--username <user>', 'new test-account username')
    .option('--password <pw>', 'new test-account password (prefer --password-file, exclusive)')
    .option('--password-file <path>', 'read the new password from a file')
    .option('--clear-credentials', 'remove stored username and password; disable account login')
    .option(
      '--var <KEY=VALUE>',
      'merge a custom variable (repeatable; max 50, 4096 bytes each, key [A-Za-z_][A-Za-z0-9_]*, reserved names like url/username/password rejected); shown in plain text by `env get`, not for secrets',
      collectVar,
      [],
    )
    .option(
      '--rename <new-name>',
      'rename the environment (runs keep referring to it by the new name)',
    )
    .option(
      '--auth <type>',
      'backend projects: how runs sign in to the API — none, bearer, basic or apikey; replaces a sign-in',
    )
    .option(
      '--credential <value>',
      'backend projects: static credential value (prefer --credential-file, exclusive)',
    )
    .option('--credential-file <path>', 'backend projects: read the static credential from a file')
    .option(
      '--header <"Name: value">',
      'backend projects: an extra request header (repeatable; replaces the stored set)',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      '--header-file <path>',
      'backend projects: extra request headers, one "Name: value" per line (for secret values)',
    )
    .option(
      '--auto-auth-file <path>',
      'backend projects: JSON sign-in that refreshes the credential; replaces a static one (see below)',
    )
    .option('--idempotency-key <token>', IDEMPOTENCY_HELP)
    .addHelpText('after', API_AUTH_HELP)
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (projectId: string, name: string, cmdOpts: EnvUpdateFlagOpts, command: Command) => {
        await runEnvUpdate(
          {
            ...resolveCommonOptions(command, deps.env),
            projectId,
            name,
            url: cmdOpts.url,
            local: cmdOpts.local,
            localHost: cmdOpts.localHost,
            skipPreflight: cmdOpts.skipPreflight,
            username: cmdOpts.username,
            password: cmdOpts.password,
            passwordFile: cmdOpts.passwordFile,
            clearCredentials: cmdOpts.clearCredentials,
            vars: cmdOpts.var,
            rename: cmdOpts.rename,
            auth: cmdOpts.auth,
            credential: cmdOpts.credential,
            credentialFile: cmdOpts.credentialFile,
            header: cmdOpts.header,
            headerFile: cmdOpts.headerFile,
            autoAuthFile: cmdOpts.autoAuthFile,
            idempotencyKey: cmdOpts.idempotencyKey,
          },
          deps,
        );
      },
    );

  env
    .command('delete <project-id> <name>')
    .summary('Delete an environment (requires --confirm)')
    .description(
      'Delete an environment and its stored credentials. Requires --confirm; the default\n' +
        'environment cannot be deleted (set another default first).' +
        DELETE_EXIT_CODE_NOTE,
    )
    .option('--confirm', 'required: explicit confirmation for the destructive operation', false)
    .option('--idempotency-key <token>', IDEMPOTENCY_HELP)
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (projectId: string, name: string, cmdOpts: EnvDeleteFlagOpts, command: Command) => {
        await runEnvDelete(
          {
            ...resolveCommonOptions(command, deps.env),
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
    .summary('Make an environment the project default')
    .description(
      'Make an environment the project default — what every run without --env uses.' +
        SET_DEFAULT_EXIT_CODE_NOTE,
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
            ...resolveCommonOptions(command, deps.env),
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
