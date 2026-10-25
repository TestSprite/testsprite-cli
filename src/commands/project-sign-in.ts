import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import {
  emitDryRunBanner,
  makeHttpClient,
  parseRequestTimeoutFlag,
  type CommonOptions,
} from '../lib/client-factory.js';
import { resolveProfileName } from '../lib/config.js';
import { ApiError, InterruptError } from '../lib/errors.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode } from '../lib/output.js';
import { readSecretFileGuarded } from '../lib/secret-file.js';
import { assertIdempotencyKey } from '../lib/validate.js';
import type { CliProjectEnvironment } from './project-env.js';
import type { ProjectDeps } from './project.js';

export interface CliProjectSignInResponse {
  projectId: string;
  environment: CliProjectEnvironment;
  signIn: {
    mode: string;
    account: { username: string | null; passwordSet: boolean } | null;
    otp: { channels: Array<'email' | 'sms'>; email: string | null; phone: string | null } | null;
    manual: {
      sessionReuseTtlSeconds: number;
      hasValidSession: boolean;
      needsReauth: boolean;
      reason: 'never' | 'expired' | null;
      capturedAt: string | null;
      expiresAt: string | null;
    } | null;
  };
  nextAction: string | null;
}

export interface CliProjectSignInSetResponse extends CliProjectSignInResponse {
  changed: boolean;
}

export type SignInMode = 'public' | 'account' | 'otp' | 'manual';
type GetOptions = CommonOptions & { projectId: string; env?: string };
type SetOptions = GetOptions & {
  mode?: string;
  username?: string;
  password?: string;
  passwordFile?: string;
  sessionTtl?: string;
  idempotencyKey?: string;
};

export function signInValidationError(message: string, reason = 'invalid_sign_in_flags'): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request.',
      nextAction: message,
      requestId: 'local',
      details: { reason },
    },
  });
}

export function parseSignInMode(raw: string | undefined, flag: string): SignInMode {
  const aliases: Record<string, SignInMode> = {
    public: 'public',
    account: 'account',
    otp: 'otp',
    manual: 'manual',
    none: 'public',
    credentials: 'account',
    sso: 'manual',
  };
  if (raw === undefined && flag === '--mode')
    throw signInValidationError(
      '--mode is required: public, account or manual (otp can only be chosen with `project env create --sign-in otp`)',
    );
  const key = raw?.toLowerCase();
  const mode = key !== undefined && Object.hasOwn(aliases, key) ? aliases[key] : undefined;
  if (!mode)
    throw signInValidationError(
      `${flag} must be one of: public, account, otp, manual, none, credentials, sso.`,
    );
  return mode;
}

export function parseSessionTtl(raw: string): number {
  if (raw === 'never') return -1;
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > 2_592_000)
    throw signInValidationError(
      '--session-ttl must be an integer from 1 to 2592000 seconds, or never.',
    );
  return Number(raw);
}

export function validateSignInFlags(
  mode: SignInMode | undefined,
  opts: {
    username?: string;
    password?: string;
    passwordFile?: string;
    sessionTtl?: string;
    otpChannel?: string[];
  },
  requireAccountPair: boolean,
): void {
  if (opts.password !== undefined && opts.passwordFile !== undefined)
    throw signInValidationError('--password and --password-file are mutually exclusive.');
  if (opts.username !== undefined && !opts.username.trim())
    throw signInValidationError('--username must not be empty or whitespace-only.');
  if (opts.password !== undefined && !opts.password.trim())
    throw signInValidationError('--password must not be empty or whitespace-only.');
  if (mode !== undefined && mode !== 'account') {
    if (opts.username !== undefined)
      throw signInValidationError('--username is only valid with account sign-in.');
    if (opts.password !== undefined)
      throw signInValidationError('--password is only valid with account sign-in.');
    if (opts.passwordFile !== undefined)
      throw signInValidationError('--password-file is only valid with account sign-in.');
  }
  if (requireAccountPair && mode === 'account') {
    if (opts.username === undefined)
      throw signInValidationError('--username is required with --sign-in account.');
    if (opts.password === undefined && opts.passwordFile === undefined)
      throw signInValidationError(
        '--password or --password-file is required with --sign-in account.',
      );
  }
  if (opts.sessionTtl !== undefined && mode !== 'manual')
    throw signInValidationError('--session-ttl is only valid with manual sign-in.');
  if (opts.otpChannel !== undefined && mode !== 'otp')
    throw signInValidationError('--otp-channel is only valid with --sign-in otp.');
  if (opts.sessionTtl !== undefined) parseSessionTtl(opts.sessionTtl);
}

function commonOptions(command: Command, env?: NodeJS.ProcessEnv): CommonOptions {
  const globals = command.optsWithGlobals() as Partial<CommonOptions> & { requestTimeout?: string };
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

function stderrOf(deps: ProjectDeps): (line: string) => void {
  return deps.stderr ?? (line => process.stderr.write(`${line}\n`));
}

function pathFor(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/sign-in`;
}

function clientFor(opts: CommonOptions, deps: ProjectDeps) {
  return makeHttpClient(opts, {
    env: deps.env,
    credentialsPath: deps.credentialsPath,
    fetchImpl: deps.fetchImpl,
    stderr: deps.stderr,
  });
}

function ttlText(seconds: number): string {
  if (seconds === -1) return 'never expires';
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function renderText(result: CliProjectSignInResponse): string {
  const { environment, signIn } = result;
  const labels: Record<string, string> = {
    public: 'No sign-in',
    account: 'Test account credentials',
    otp: 'OTP (one-time password) login',
    manual: 'SSO: log in once in a live browser, runs reuse the session',
  };
  const lines = [
    `Environment  ${environment.name}${environment.isDefault ? ' (default)' : ''} — ${environment.url}`,
    `Sign-in      ${signIn.mode}${labels[signIn.mode] ? ` — ${labels[signIn.mode]}` : ''}`,
  ];
  if (signIn.mode === 'account' && signIn.account)
    lines.push(
      `Username     ${signIn.account.username}`,
      `Password     ${signIn.account.passwordSet ? 'set' : 'not set'}`,
    );
  if (signIn.mode === 'otp' && signIn.otp) {
    lines.push(`Channels     ${signIn.otp.channels.join(', ')}`);
    if (signIn.otp.email) lines.push(`Inbox        ${signIn.otp.email}`);
    if (signIn.otp.phone) lines.push(`Phone        ${signIn.otp.phone}`);
  }
  if (signIn.mode === 'manual') {
    const manual = signIn.manual;
    let session = 'none captured yet — runs will NOT be signed in until someone logs in once';
    if (manual?.hasValidSession) {
      session =
        manual.expiresAt && manual.sessionReuseTtlSeconds !== -1
          ? `valid until ${manual.expiresAt}`
          : 'valid (never expires)';
      if (manual.capturedAt) session += ` — captured ${manual.capturedAt}`;
    } else if (manual?.reason === 'expired') {
      session = `expired ${manual.expiresAt ?? '(expiration unknown)'} — runs will NOT be signed in until someone logs in again`;
    }
    lines.push(`Session      ${session}`);
    if (manual) lines.push(`Session TTL  ${ttlText(manual.sessionReuseTtlSeconds)}`);
  }
  if (result.nextAction) lines.push(`Next         ${result.nextAction}`);
  return lines.join('\n');
}

function dryRunResponse(projectId: string, mode = 'public'): CliProjectSignInResponse {
  return {
    projectId,
    environment: {
      id: 'env_dryrun',
      name: 'default',
      url: 'https://app.example.com',
      isDefault: true,
      authMode: mode,
      hasCredentials: mode === 'account',
      username: mode === 'account' ? 'qa@example.com' : null,
      enableOtp: mode === 'otp',
      updatedAt: '2026-09-25T00:00:00.000Z',
    },
    signIn: {
      mode,
      account: mode === 'account' ? { username: 'qa@example.com', passwordSet: true } : null,
      otp:
        mode === 'otp' ? { channels: ['email'], email: 'dryrun@inbox.example', phone: null } : null,
      manual:
        mode === 'manual'
          ? {
              sessionReuseTtlSeconds: 3600,
              hasValidSession: false,
              needsReauth: true,
              reason: 'never',
              capturedAt: null,
              expiresAt: null,
            }
          : null,
    },
    nextAction: mode === 'manual' ? 'Log in once in the Portal.' : null,
  };
}

function redactSecret(value: unknown, secret: string): unknown {
  if (typeof value === 'string') return value.split(secret).join('[REDACTED]');
  if (Array.isArray(value)) return value.map(item => redactSecret(item, secret));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.split(secret).join('[REDACTED]'),
        redactSecret(item, secret),
      ]),
    );
  }
  return value;
}

export async function runSignInGet(
  opts: GetOptions,
  deps: ProjectDeps = {},
): Promise<CliProjectSignInResponse> {
  if (opts.env !== undefined && !opts.env.trim())
    throw signInValidationError('--env must not be empty or whitespace-only.');
  const out = new Output(opts.output, { stdout: deps.stdout, stderr: deps.stderr });
  if (opts.dryRun) {
    emitDryRunBanner(stderrOf(deps));
    const sample = dryRunResponse(opts.projectId);
    out.print(sample, data => renderText(data as CliProjectSignInResponse));
    return sample;
  }
  const result = await clientFor(opts, deps).get<CliProjectSignInResponse>(
    pathFor(opts.projectId),
    opts.env === undefined ? {} : { query: { environment: opts.env } },
  );
  out.print(result, data => renderText(data as CliProjectSignInResponse));
  return result;
}

export async function runSignInSet(
  opts: SetOptions,
  deps: ProjectDeps = {},
): Promise<CliProjectSignInSetResponse> {
  if (opts.env !== undefined && !opts.env.trim())
    throw signInValidationError('--env must not be empty or whitespace-only.');
  const mode = parseSignInMode(opts.mode, '--mode');
  validateSignInFlags(mode, opts, false);
  assertIdempotencyKey(opts.idempotencyKey);
  const out = new Output(opts.output, { stdout: deps.stdout, stderr: deps.stderr });
  const stderr = stderrOf(deps);
  const key = opts.idempotencyKey ?? `cli-proj-signin-set-${randomUUID()}`;
  if (opts.idempotencyKey === undefined && (opts.output === 'json' || opts.verbose || opts.debug))
    stderr(`idempotency-key: ${key}`);
  if (opts.dryRun) {
    emitDryRunBanner(stderr);
    const sample = { ...dryRunResponse(opts.projectId, mode), changed: mode !== 'otp' };
    out.print(sample, data => renderText(data as CliProjectSignInResponse));
    return sample;
  }
  const password =
    opts.passwordFile === undefined
      ? opts.password
      : readSecretFileGuarded('password-file', opts.passwordFile);
  const body: {
    environment?: string;
    mode: SignInMode;
    username?: string;
    password?: string;
    sessionReuseTtlSeconds?: number;
  } = { mode };
  if (opts.env !== undefined) body.environment = opts.env;
  if (opts.username !== undefined) body.username = opts.username;
  if (password !== undefined) body.password = password;
  if (opts.sessionTtl !== undefined) body.sessionReuseTtlSeconds = parseSessionTtl(opts.sessionTtl);
  try {
    const result = await clientFor(opts, deps).put<CliProjectSignInSetResponse>(
      pathFor(opts.projectId),
      { body, headers: { 'idempotency-key': key } },
    );
    out.print(result, data => renderText(data as CliProjectSignInResponse));
    return result;
  } catch (err) {
    if (err instanceof InterruptError) throw err;
    if (err instanceof ApiError && password) {
      throw new ApiError(
        {
          code: err.code,
          message: redactSecret(err.message, password) as string,
          nextAction: redactSecret(err.nextAction, password) as string,
          requestId: err.requestId,
          details: redactSecret(err.details, password) as Record<string, unknown>,
        },
        err.httpStatus,
        err.retryAfterMs,
      );
    }
    if (err instanceof Error && password)
      err.message = redactSecret(err.message, password) as string;
    throw err;
  }
}

export function createProjectSignInCommand(deps: ProjectDeps = {}): Command {
  const group = new Command('sign-in').description(
    'Inspect or change how an environment signs in to the app under test.',
  );
  group
    .command('get <project-id>')
    .description(
      'Show the environment sign-in mode, credentials status, OTP channels, or SSO session.',
    )
    .option('--env <name>', 'environment name (defaults to the project default)')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (projectId: string, flags: { env?: string }, command: Command) => {
      await runSignInGet({ ...commonOptions(command, deps.env), projectId, env: flags.env }, deps);
    });
  group
    .command('set <project-id>')
    .description('Set the sign-in mode; choose OTP when creating a new environment.')
    .option(
      '--mode <mode>',
      'required: public, account, otp, or manual (aliases: none, credentials, sso)',
    )
    .option('--env <name>', 'environment name (defaults to the project default)')
    .option('--username <user>', 'test-account username (account only)')
    .option('--password <pw>', 'test-account password (prefer --password-file; account only)')
    .option('--password-file <path>', 'read the test-account password from a file (account only)')
    .option(
      '--session-ttl <seconds|never>',
      'SSO session reuse lifetime: 1–2592000 seconds or never (manual only)',
    )
    .option(
      '--idempotency-key <token>',
      'opaque idempotency token. Defaults to a UUIDv4 minted per invocation.',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(
      async (
        projectId: string,
        flags: Omit<SetOptions, keyof CommonOptions | 'projectId'>,
        command: Command,
      ) => {
        await runSignInSet({ ...commonOptions(command, deps.env), projectId, ...flags }, deps);
      },
    );
  return group;
}
