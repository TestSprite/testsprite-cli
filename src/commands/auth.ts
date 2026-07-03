import { Command } from 'commander';
import {
  assertValidEndpointUrl,
  emitDryRunBanner,
  makeHttpClient,
  parseRequestTimeoutFlag,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import type { ErrorCode } from '../lib/errors.js';
import { ApiError, CLIError } from '../lib/errors.js';
import { facadeBaseUrl } from '../lib/facade.js';
import type { FetchImpl } from '../lib/http.js';
import { HttpClient } from '../lib/http.js';
import {
  defaultCredentialsPath,
  deleteProfile,
  readProfile,
  writeProfile,
} from '../lib/credentials.js';
import { loadConfig } from '../lib/config.js';
import { emitDeprecationNotice } from '../lib/deprecate.js';
import type { OutputMode } from '../lib/output.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode } from '../lib/output.js';
import { promptSecret } from '../lib/prompt.js';

export interface MeResponse {
  userId: string;
  keyId: string;
  scopes: string[];
  env: 'development' | 'staging' | 'production';
  /**
   * Human-readable email for the bound account. Forward-compat: the
   * backend `/me` projection does not surface it yet, so it is optional
   * and absent-safe — rendered only when present (dogfood L1866). Keep
   * `userId` as the machine-stable join key regardless.
   */
  email?: string;
  /** Human-readable display name for the bound account. Absent-safe (dogfood L1866). */
  displayName?: string;
}

export interface AuthDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  prompt?: {
    secret: (question: string) => Promise<string>;
  };
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  preludeWrite?: (chunk: string) => void;
  /**
   * Identifies the higher-level command that invoked `runConfigure`. When set,
   * it is sent as the `X-CLI-Command` request header on the key-validation
   * `GET /me` so the backend can attribute the call for product analytics —
   * e.g. `init` is counted as `cli.initialized` instead of the generic
   * `cli.session_started`. `auth configure` run directly leaves it unset.
   * Advisory only: it never changes behavior, and the backend honors only a
   * known allowlist value.
   */
  commandTag?: string;
}

type CommonOptions = FactoryCommonOptions;

interface ConfigureOptions extends CommonOptions {
  fromEnv: boolean;
}

const DEFAULT_API_URL = 'https://api.testsprite.com';
const FROM_ENV_MISSING_KEY =
  'TESTSPRITE_API_KEY is not set in the environment. Set it and re-run with --from-env, or omit --from-env to enter the key interactively.';

export async function runConfigure(opts: ConfigureOptions, deps: AuthDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const credentialsPath = deps.credentialsPath ?? defaultCredentialsPath();
  const out = makeOutput(opts.output, deps);
  const prelude = deps.preludeWrite ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  // Normalize the env endpoint: an empty / whitespace-only TESTSPRITE_API_URL is
  // treated as unset. Without this, `''` (e.g. `export TESTSPRITE_API_URL=` in a
  // shell profile) is non-nullish and would short-circuit the `??` chains below to
  // an empty endpoint instead of falling through to the profile / prod default.
  const envApiUrl = env.TESTSPRITE_API_URL?.trim() || undefined;

  // Dry-run: do not prompt, do not read env, do not write credentials.
  // Print the canned success shape so an agent sees exactly the JSON it
  // would get on a real configure (modulo the endpoint string).
  if (opts.dryRun) {
    const apiUrl = opts.endpointUrl ?? envApiUrl ?? DEFAULT_API_URL;
    assertValidEndpointUrl(apiUrl);
    emitDryRunBanner(stderr);
    stderr(`[dry-run] would write credentials for profile="${opts.profile}" to ${credentialsPath}`);
    out.print({ profile: opts.profile, apiUrl, status: 'configured' }, data => {
      const d = data as { profile: string; apiUrl: string };
      return `Profile "${d.profile}" configured (dry-run). Endpoint: ${d.apiUrl}`;
    });
    return;
  }

  let apiKey: string | undefined;

  // Read the existing profile once — used for apiUrl inheritance in both
  // --from-env and interactive paths when no explicit URL is supplied.
  const existingProfile = readProfile(opts.profile, { path: credentialsPath });

  // The API endpoint is resolved SILENTLY and is never prompted for. Public
  // users must not be asked to configure an endpoint at install time — the prod
  // default is always correct for them. Internal/staging point elsewhere via the
  // global `--endpoint-url` flag or the `TESTSPRITE_API_URL` env var.
  //
  // Precedence: --endpoint-url flag > TESTSPRITE_API_URL > existing profile's
  // api_url > built-in prod default. The existing-profile fallback mirrors
  // lib/config.ts runtime resolution so a machine already pointed at a non-default
  // api_url doesn't silently validate a new key against the default endpoint.
  const resolvedFromProfile = existingProfile?.apiUrl;
  const apiUrl = opts.endpointUrl ?? envApiUrl ?? resolvedFromProfile ?? DEFAULT_API_URL;
  assertValidEndpointUrl(apiUrl);

  if (opts.fromEnv) {
    apiKey = env.TESTSPRITE_API_KEY?.trim();
    if (!apiKey) throw validationError('TESTSPRITE_API_KEY', FROM_ENV_MISSING_KEY);
  } else {
    const promptApi = deps.prompt ?? { secret: (q: string) => promptSecret(q) };
    prelude(`Configuring profile "${opts.profile}".\n`);
    // Only the API key is prompted — the endpoint defaults to prod (see above).
    apiKey = (await promptApi.secret('TestSprite API key: ')).trim();
    if (!apiKey) throw new CLIError('No API key provided.', 5);
  }

  // Advisory: when the endpoint was silently inherited from an existing profile
  // (not an explicit flag/env), surface it before validating the key against it
  // so a key is never checked against an unexpected host without the user noticing.
  if (
    !opts.endpointUrl &&
    !envApiUrl &&
    resolvedFromProfile &&
    resolvedFromProfile !== DEFAULT_API_URL
  ) {
    stderr(`[advisory] Inheriting api_url from existing profile: ${resolvedFromProfile}`);
  }

  // Verify the key is accepted before persisting. Build an HttpClient
  // directly (bypassing loadConfig) so we can test the candidate key+url
  // before it is written to disk. This ensures we never overwrite a
  // working profile with a bad key.
  const pingClient = new HttpClient({
    baseUrl: facadeBaseUrl(apiUrl),
    apiKey,
    fetchImpl: deps.fetchImpl,
    requestTimeoutMs: opts.requestTimeoutMs,
  });
  try {
    // Tag the validation call with the originating command (when provided) so
    // the backend attributes it for product analytics — e.g. `init` → the
    // cli.initialized event instead of the generic cli.session_started. The
    // header is advisory; omitting it changes nothing.
    await pingClient.get<MeResponse>(
      '/me',
      deps.commandTag ? { headers: { 'x-cli-command': deps.commandTag } } : {},
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr(`API key rejected by ${apiUrl}: ${message} — profile NOT updated`);
    // When the verification call returned a typed API error (AUTH_INVALID,
    // AUTH_FORBIDDEN, etc.), re-throw it directly so `index.ts` renders the
    // full typed envelope under `--output json` (code, nextAction, requestId,
    // details). Previously wrapping it in CLIError discarded those fields and
    // emitted a bare `{"error":"...string..."}` — violating the JSON contract.
    // Augment the message with the endpoint context so text-mode users still
    // see which host rejected the key.
    if (err instanceof ApiError) {
      err.message = `API key rejected by ${apiUrl}: ${message} — did you mean to set TESTSPRITE_API_URL?`;
      throw err;
    }
    // Non-ApiError (truly unexpected throws like a TypeError from a
    // misconfigured fetchImpl). Exit 3 (auth family).
    throw new CLIError(
      `API key rejected by ${apiUrl}: ${message} — did you mean to set TESTSPRITE_API_URL?`,
      3,
    );
  }

  writeProfile(opts.profile, { apiKey, apiUrl }, { path: credentialsPath });

  out.print({ profile: opts.profile, apiUrl, status: 'configured' }, data => {
    const d = data as { profile: string; apiUrl: string };
    return `Profile "${d.profile}" configured. Endpoint: ${d.apiUrl}`;
  });

  // Note: the old "run `testsprite agent install`" self-bootstrap tip was
  // removed with the setup consolidation. `runConfigure` now only runs as part
  // of `setup` (the sole credential-writing path), which installs the skill
  // itself (unless --no-agent) — so the tip would be redundant or misleading.
}

export async function runWhoami(opts: CommonOptions, deps: AuthDeps = {}): Promise<MeResponse> {
  const out = makeOutput(opts.output, deps);
  const env = deps.env ?? process.env;

  // Resolve the endpoint URL so it can be surfaced in text output.
  // Dry-run uses the flag/env/default chain without touching credentials.
  // Real path uses the same loadConfig the HttpClient factory uses so the
  // displayed URL always matches where requests actually go (dogfood L1788).
  let resolvedEndpoint: string;
  if (opts.dryRun) {
    resolvedEndpoint = opts.endpointUrl ?? env.TESTSPRITE_API_URL ?? 'https://api.testsprite.com';
  } else {
    const credentialsPath = deps.credentialsPath ?? defaultCredentialsPath();
    const config = loadConfig({
      profile: opts.profile,
      endpointUrl: opts.endpointUrl,
      env,
      credentialsPath,
    });
    resolvedEndpoint = config.apiUrl;
  }

  // Dry-run + real path both go through the shared factory.
  const client = makeHttpClient(opts, {
    env: deps.env,
    credentialsPath: deps.credentialsPath,
    fetchImpl: deps.fetchImpl,
    stderr: deps.stderr,
  });

  const me = await client.get<MeResponse>('/me');
  out.print(me, data => {
    const m = data as MeResponse;
    const lines = [
      `userId: ${m.userId}`,
      // Human-readable identity, rendered only when the backend supplies it
      // (dogfood L1866) — confirm the account at a glance before a billable run.
      ...(m.displayName ? [`name:   ${m.displayName}`] : []),
      ...(m.email ? [`email:  ${m.email}`] : []),
      `keyId:  ${m.keyId}`,
      // Show the resolved endpoint so the user knows which env they are bound to
      // without having to infer from the `env` field alone (dogfood L1788).
      `endpoint: ${resolvedEndpoint}`,
      `env:    ${m.env}`,
      `scopes: ${m.scopes.join(', ')}`,
    ];
    // C2: warn in text mode when key cannot write/run
    const missingScopes = (['write:tests', 'run:tests'] as const).filter(
      s => !m.scopes.includes(s),
    );
    if (missingScopes.length > 0) {
      lines.push(
        `note: this key cannot run write or test-trigger commands. Missing scopes: ${missingScopes.join(', ')}. Ask your account owner to extend it via the portal.`,
      );
    }
    return lines.join('\n');
  });
  return me;
}

export async function runLogout(opts: CommonOptions, deps: AuthDeps = {}): Promise<void> {
  const credentialsPath = deps.credentialsPath ?? defaultCredentialsPath();
  const out = makeOutput(opts.output, deps);
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));

  if (opts.dryRun) {
    emitDryRunBanner(stderr);
    stderr(
      `[dry-run] would remove credentials for profile="${opts.profile}" from ${credentialsPath}`,
    );
    out.print({ profile: opts.profile, status: 'logged_out' }, data => {
      const d = data as { profile: string; status: string };
      return `Removed credentials for profile "${d.profile}" (dry-run).`;
    });
    return;
  }

  const removed = deleteProfile(opts.profile, { path: credentialsPath });
  out.print({ profile: opts.profile, status: removed ? 'logged_out' : 'no_credentials' }, data => {
    const d = data as { profile: string; status: string };
    return d.status === 'logged_out'
      ? `Removed credentials for profile "${d.profile}".`
      : `No credentials stored for profile "${d.profile}".`;
  });
}

export function createAuthCommand(deps: AuthDeps = {}): Command {
  const auth = new Command('auth').description('Manage TestSprite credentials');

  // `status` (primary; formerly `whoami`). Credential WRITES no longer live
  // here — `auth configure` is a hidden, deprecated alias for `setup` (attached
  // in index.ts), and `setup` is the only command that writes credentials.

  auth
    .command('status')
    .description('Show the user, API key, env, and scopes bound to the active profile')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (_cmdOpts, command: Command) => {
      await runWhoami(resolveCommonOptions(command), deps);
    });

  // `whoami` — hidden, deprecated alias for `status` (kept so scripts/agents
  // on the old name keep working; invisible to --help).
  auth
    .command('whoami', { hidden: true })
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (_cmdOpts, command: Command) => {
      emitDeprecationNotice('auth whoami', 'auth status', deps.stderr);
      await runWhoami(resolveCommonOptions(command), deps);
    });

  auth
    .command('remove')
    .description('Remove credentials for the active profile')
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (_cmdOpts, command: Command) => {
      await runLogout(resolveCommonOptions(command), deps);
    });

  // `logout` — hidden, deprecated alias for `remove`.
  auth
    .command('logout', { hidden: true })
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .action(async (_cmdOpts, command: Command) => {
      emitDeprecationNotice('auth logout', 'auth remove', deps.stderr);
      await runLogout(resolveCommonOptions(command), deps);
    });

  return auth;
}

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

function makeOutput(mode: OutputMode, deps: AuthDeps): Output {
  return new Output(mode, { stdout: deps.stdout, stderr: deps.stderr });
}

function validationError(field: string, message: string): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'VALIDATION_ERROR' satisfies ErrorCode,
      message,
      nextAction: `Set ${field} and re-run.`,
      requestId: 'local',
      details: { field, reason: 'missing' },
    },
  });
}
