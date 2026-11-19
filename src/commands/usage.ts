/**
 * `testsprite usage` — show the caller's organization wallet (balance, plan,
 * seats) as a proactive pre-flight before a large `run` fan-out.
 *
 * Reads `GET /me`. The wallet is the `activeOrg` block, which the backend
 * enriches best-effort and omits on a lookup failure; every field beyond the
 * identity core stays absent-safe.
 */

import { Command } from 'commander';
import { formatWorkspaceStatus, type WorkspaceStatus } from '../lib/workspace-status.js';
import {
  emitDryRunBanner,
  makeHttpClient,
  parseRequestTimeoutFlag,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import { loadConfig, resolveProfileName } from '../lib/config.js';
import { resolvePortalBase } from '../lib/facade.js';
import type { FetchImpl } from '../lib/http.js';
import type { CliOrgBinding, CliOrgSummary } from '../lib/org-render.js';
import { formatOrgBinding, formatOrgsSummary } from '../lib/org-render.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode, type OutputMode } from '../lib/output.js';
import { USAGE_RESPONSE_SCHEMA } from '../lib/response-schemas.js';
import { terminalSafeLine, terminalSafeWriter } from '../lib/terminal-text.js';

/**
 * The `/me` projection the `usage` command reads. `userId`/`keyId`/`env` are
 * the only fields every account shape is guaranteed to populate.
 */
export interface UsageResponse {
  userId: string;
  keyId: string;
  env: 'development' | 'staging' | 'production';
  /**
   * The caller's organization wallet — the billing subject. The backend
   * resolves it from the key's org binding, else the personal org, and omits
   * it when that lookup fails.
   */
  activeOrg?: ActiveOrg;
  /**
   * Every organization the underlying user belongs to (account-wide
   * membership list, personal org included). Absent-safe: omitted on a
   * server-side lookup failure or an older backend.
   */
  organizations?: CliOrgSummary[];
  /**
   * The calling key's own org binding. Present only when the request
   * authenticated with a Postgres-backed membership key (`sk-member-…`).
   */
  org?: CliOrgBinding;
}

/** Slim org-wallet view shipped on `/me` (see the backend `Me` schema). */
export interface ActiveOrg {
  id: string;
  name: string;
  /** Org plan (`Free` | `Starter` | `Standard`). */
  plan: string;
  /** Caller's role in the org (`owner` | `admin` | `member`). */
  role: string;
  /** Spendable balance: the caller's member bucket + the org's shared top-up pool. */
  remaining: number;
  /** Monthly per-seat credit allowance for the org's plan. */
  includedCredits: number;
  seats: number;
  /** Billing standing (paused / pending / ok). Absent on an older backend. */
  workspace?: WorkspaceStatus;
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
  activeOrg: {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Dry Run Workspace',
    plan: 'Standard',
    role: 'owner',
    remaining: 1650,
    includedCredits: 1600,
    seats: 1,
  },
};

/**
 * Run the `usage` command. Calls `GET /me` and surfaces identity plus the org
 * wallet when the backend supplies it. Absent fields are silently omitted.
 */
export async function runUsage(opts: CommonOptions, deps: UsageDeps = {}): Promise<UsageResponse> {
  const stderr = terminalSafeWriter(deps.stderr);
  const out = makeOutput(opts.output, deps);

  if (opts.dryRun) {
    emitDryRunBanner(stderr);
    stderr('[note] --dry-run showing canned sample values, not your real balance');
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
      ? `${portalBase}${BILLING_PAGE_PATH}`
      : `the portal Billing page (${BILLING_PAGE_PATH})`;

  const me = await client.get<UsageResponse>('/me', { schema: USAGE_RESPONSE_SCHEMA });

  out.print(me, data => renderUsage(data as UsageResponse, portalBase));

  // In text mode, emit a note when no balance was shown at all.
  //
  // "Is this key org-bound" and "do I have a balance number to show" are two
  // different questions and must not be conflated. `me.org` is the key's own
  // binding — always present, no I/O, populated whenever the request
  // authenticated with a membership key (`sk-member-…`). `activeOrg` is the
  // *enriched* org balance: the backend does a best-effort Postgres read for
  // it and swallows the exception on failure, so `org` can be present while
  // `activeOrg` is absent. An org-bound key in that state must be told its
  // org balance is unavailable, never pointed at a generic billing page.
  const isOrgBound = me.org !== undefined;
  if (opts.output === 'text' && me.activeOrg === undefined) {
    stderr(
      isOrgBound
        ? "[note] this key is organization-bound, but the org balance could not be loaded right now. Retry `testsprite usage`, or check the Portal's organization billing settings (ask an org admin if you don't have access)."
        : `[note] credit balance not returned for this account. Check ${billingUrl} for your current balance.`,
    );
  }

  return me;
}

/**
 * Org-wallet low-balance threshold: the cost of a generation action —
 * the priciest common single action on org billing. Below this, the next
 * AI-assisted operation may fail; cheaper actions can still succeed.
 */
const LOW_ORG_BALANCE_CREDITS = 2;

/**
 * Org-less Portal billing route: the Portal re-anchors it under the viewer's
 * active workspace.
 */
const BILLING_PAGE_PATH = '/dashboard-v3/settings/billing';

function renderUsage(u: UsageResponse, portalBase?: string): string {
  const lines: string[] = [];

  // Identity block (always present)
  lines.push(`userId: ${terminalSafeLine(u.userId)}`);
  lines.push(`keyId:  ${terminalSafeLine(u.keyId)}`);
  lines.push(`env:    ${terminalSafeLine(u.env)}`);
  // Org attribution — rendered only when the backend supplies it.
  const orgsSummary = formatOrgsSummary(u.organizations);
  if (orgsSummary) lines.push(`orgs:   ${terminalSafeLine(orgsSummary)}`);
  const orgBinding = formatOrgBinding(u.org);
  if (orgBinding) lines.push(`org binding: ${terminalSafeLine(orgBinding)}`);

  // Whether the CALLING KEY is org-bound — read from `u.org` (the key's own
  // membership binding), NOT from `activeOrg`, which is a best-effort
  // enrichment the backend omits on a lookup failure (see `runUsage`).
  const isOrgBound = u.org !== undefined;

  // Org wallet block — the billing subject. `?? undefined` also normalizes a
  // hypothetical explicit `null` from the wire so the block below can't
  // dereference it.
  const orgWallet = u.activeOrg ?? undefined;
  if (orgWallet !== undefined) {
    const org = orgWallet;
    lines.push('');
    lines.push('--- organization ---');
    lines.push(`org:          ${terminalSafeLine(org.name)} (${terminalSafeLine(org.role)})`);
    lines.push(`plan:         ${terminalSafeLine(org.plan)}`);
    // A paused workspace cannot spend this balance at all; a payment-pending
    // one keeps spending but gets no refill. Both are worth a line here.
    const standing = formatWorkspaceStatus(org.workspace);
    if (standing) lines.push(`state:        ${standing}`);
    lines.push(`balance:      ${org.remaining} remaining (${org.includedCredits}/mo per seat)`);
    lines.push(`seats:        ${org.seats}`);
    // No "~N runs" estimate here: org billing prices actions individually,
    // so a single per-run rate would be wrong for most fan-outs.
  } else if (isOrgBound) {
    // Org-bound key, but the enrichment that would have populated `activeOrg`
    // degraded (best-effort Postgres read failed server-side). Say so
    // honestly, and never fabricate an org-scoped URL.
    lines.push('');
    lines.push('--- organization ---');
    lines.push(
      "balance:      could not be loaded right now. Retry `testsprite usage`, or check the Portal's organization billing settings (ask an org admin if you don't have access).",
    );
  }

  // Upgrade line for Free or low-balance wallets.
  const isLowBalance = orgWallet !== undefined && orgWallet.remaining < LOW_ORG_BALANCE_CREDITS;
  const isFree = orgWallet !== undefined && orgWallet.plan.toLowerCase() === 'free';

  if (isLowBalance) {
    lines.push('');
    // No URL here: the Portal's org-less billing route re-anchors under the
    // viewer's ACTIVE workspace in the browser, which need not be the org
    // this key bills, so "the organization billing settings" is the honest
    // pointer. Org billing prices actions individually, and cheaper actions
    // (e.g. a 1-credit backend run) may still succeed below the threshold —
    // so this is "low", not "cannot run".
    lines.push(
      `warning: organization balance is low (under the ${LOW_ORG_BALANCE_CREDITS}-credit cost of a generation action). Top up in the Portal's organization billing settings (ask an org admin if you don't have access).`,
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
    .summary('Show credit balance and plan info')
    .description(
      'Show credit balance and plan/entitlement info (proactive pre-flight before a large run)',
    )
    .addHelpText('after', GLOBAL_OPTS_HINT)
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  testsprite usage                 # show balance + plan\n' +
        '  testsprite usage --output json   # machine-readable balance\n' +
        '  testsprite usage --debug         # trace HTTP method/path, request id, latency\n' +
        '  testsprite credits               # alias for usage\n' +
        '\nExit codes:\n' +
        '  0   success (or --dry-run)\n' +
        '  3   auth error — run `testsprite setup` to configure credentials\n' +
        '  10  transport/network failure (UNAVAILABLE) — retry the command\n' +
        "\nNote: if the balance isn't shown, check the portal's Billing page\n" +
        '  (/dashboard-v3/settings/billing), or ask an org admin if this key is\n' +
        '  organization-bound.',
    )
    .action(async (_cmdOpts, command: Command) => {
      await runUsage(resolveCommonOptions(command, deps.env), deps);
    });

  return cmd;
}

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

function makeOutput(mode: OutputMode, deps: UsageDeps): Output {
  return new Output(mode, { stdout: deps.stdout, stderr: deps.stderr });
}
