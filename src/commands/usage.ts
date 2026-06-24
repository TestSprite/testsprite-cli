/**
 * `testsprite usage` — show the account's credit balance and plan/entitlement
 * info as a proactive pre-flight before a large `test run` fan-out.
 *
 * Backend note: the `GET /me` endpoint does NOT currently return credit balance
 * or plan info. This command calls `/me` for auth-identity fields and surfaces
 * the `credits` / `subPlan` fields when and only when the backend supplies them
 * (forward-compat / absent-safe). A dedicated backend endpoint is a required
 * follow-up.
 *
 * BACKEND FOLLOW-UP REQUIRED:
 *   Add `credits`, `subPlan` to the `/me` response, or add a dedicated
 *   `GET /api/cli/v1/usage` endpoint returning `{ credits, subPlan, creditsPerRun }`.
 */

import { Command } from 'commander';
import {
  emitDryRunBanner,
  makeHttpClient,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import { loadConfig } from '../lib/config.js';
import { resolvePortalBase } from '../lib/facade.js';
import type { FetchImpl } from '../lib/http.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode, type OutputMode } from '../lib/output.js';

/**
 * Usage/balance response from `/me` (when the backend supplies it) or a future
 * `/usage` endpoint.
 *
 * All fields except `userId`/`keyId`/`env` are forward-compat: the backend
 * does not return them today. They are rendered only when present.
 */
export interface UsageResponse {
  userId: string;
  keyId: string;
  env: 'development' | 'staging' | 'production';
  /**
   * Remaining credit balance. Present only when the backend /me (or /usage)
   * includes the User.credits projection. BACKEND FOLLOW-UP: me.controller.ts.
   */
  credits?: number;
  /**
   * Subscription plan name (e.g. "Free", "Standard", "Pro"). Present only when
   * the backend /me (or /usage) includes the User.subPlan projection.
   * BACKEND FOLLOW-UP: me.controller.ts.
   */
  subPlan?: string;
  /**
   * Credit cost per test run trigger (informational). Present only when the
   * backend supplies it.
   */
  creditsPerRun?: number;
}

export interface UsageDeps {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
  fetchImpl?: FetchImpl;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

type CommonOptions = FactoryCommonOptions;

/** Dry-run canned response — matches what the real /me + User lookup would return. */
export const DRY_RUN_USAGE_SAMPLE: UsageResponse = {
  userId: '11111111-1111-4111-8111-111111111111',
  keyId: 'key_dryrun_2026',
  env: 'development',
  credits: 42,
  subPlan: 'Standard',
  creditsPerRun: 2,
};

/**
 * Run the `usage` command. Calls `GET /me`, surfaces identity + any
 * credits/plan fields the backend supplies. Absent fields are silently
 * omitted (forward-compat until the backend adds the projection).
 */
export async function runUsage(opts: CommonOptions, deps: UsageDeps = {}): Promise<UsageResponse> {
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const out = makeOutput(opts.output, deps);

  if (opts.dryRun) {
    emitDryRunBanner(stderr);
    stderr('[note] credit balance requires a backend update — showing dry-run sample values');
    out.print(DRY_RUN_USAGE_SAMPLE, data => renderUsage(data as UsageResponse));
    return DRY_RUN_USAGE_SAMPLE;
  }

  const client = makeHttpClient(opts, {
    env: deps.env,
    credentialsPath: deps.credentialsPath,
    fetchImpl: deps.fetchImpl,
    stderr: deps.stderr,
  });

  // Environment-correct portal origin for billing/upgrade links (dev and prod
  // portals live on different domains — never hardcode). Resolved from the
  // same credentials the client was just built from; undefined for unknown
  // hosts (links then render as routes only).
  const portalBase = resolvePortalBase(
    loadConfig({
      profile: opts.profile,
      endpointUrl: opts.endpointUrl,
      env: deps.env,
      credentialsPath: deps.credentialsPath,
    }).apiUrl,
  );
  const billingUrl =
    portalBase !== undefined
      ? `${portalBase}/dashboard/settings/billing`
      : 'the portal Billing page (/dashboard/settings/billing)';

  // /me is the only available source of credits/plan today.
  // When the backend adds credits/subPlan to MeResponse (or adds /usage),
  // this single get call is sufficient — no code change needed in the CLI.
  const me = await client.get<UsageResponse>('/me');

  out.print(me, data => renderUsage(data as UsageResponse, portalBase));

  // In text mode, emit a backend-gap note when credits are missing so the
  // user knows why the balance isn't shown (instead of assuming zero or error).
  if (opts.output === 'text' && me.credits === undefined) {
    stderr(
      '[note] credit balance not available — backend does not yet expose credits on /me.' +
        ` Check ${billingUrl} for your current balance.`,
    );
  }

  return me;
}

function renderUsage(u: UsageResponse, portalBase?: string): string {
  const lines: string[] = [];

  // Identity block (always present)
  lines.push(`userId: ${u.userId}`);
  lines.push(`keyId:  ${u.keyId}`);
  lines.push(`env:    ${u.env}`);

  // Balance block — shown only when the backend supplies it
  const hasBalanceData = u.credits !== undefined || u.subPlan !== undefined;
  if (hasBalanceData) {
    lines.push('');
    lines.push('--- credits & plan ---');
    if (u.subPlan !== undefined) {
      lines.push(`plan:         ${u.subPlan}`);
    }
    if (u.credits !== undefined) {
      lines.push(`credits:      ${u.credits}`);
    }
    if (u.creditsPerRun !== undefined) {
      lines.push(`cost per frontend run: ${u.creditsPerRun} credit(s)`);
      lines.push(
        `cost per backend run:  0 credit(s) (backend tests bill at code-generation, not at run time)`,
      );
    }

    // Pre-flight hint: how many runs the current balance can fund
    if (u.credits !== undefined && u.creditsPerRun !== undefined && u.creditsPerRun > 0) {
      const maxRuns = Math.floor(u.credits / u.creditsPerRun);
      lines.push(`can trigger:  ~${maxRuns} run(s) at current balance`);
    }
  }

  // Actionable upgrade line for Free or low-balance keys
  const isLowBalance =
    u.credits !== undefined && u.creditsPerRun !== undefined && u.credits < u.creditsPerRun;
  const isFree = u.subPlan?.toLowerCase() === 'free';

  if (isLowBalance) {
    lines.push('');
    lines.push(
      'warning: credit balance is below the per-run cost. Top up at:' +
        ` ${portalBase !== undefined ? `${portalBase}/dashboard/settings/billing` : 'the portal Billing page (/dashboard/settings/billing)'}`,
    );
  } else if (isFree) {
    lines.push('');
    lines.push(
      'note: on Free plan — upgrade for more credits and higher run limits:' +
        ` ${portalBase !== undefined ? `${portalBase}/pricing` : 'the portal Pricing page (/pricing)'}`,
    );
  }

  return lines.join('\n');
}

export function createUsageCommand(deps: UsageDeps = {}): Command {
  const cmd = new Command('usage')
    .alias('credits')
    .description(
      'Show credit balance and plan/entitlement info (proactive pre-flight before a large test run)',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  testsprite usage                 # show balance + plan\n' +
        '  testsprite usage --output json   # machine-readable balance\n' +
        '  testsprite credits               # alias for usage\n' +
        '\nNote: credit balance requires a backend update to /me. Until shipped,\n' +
        "  check your portal's Billing page (/dashboard/settings/billing) for your balance.",
    )
    .action(async (_cmdOpts, command: Command) => {
      await runUsage(resolveCommonOptions(command), deps);
    });

  return cmd;
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

function parseRequestTimeoutFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 1000);
}

function makeOutput(mode: OutputMode, deps: UsageDeps): Output {
  return new Output(mode, { stdout: deps.stdout, stderr: deps.stderr });
}
