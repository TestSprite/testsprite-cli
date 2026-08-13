/**
 * `testsprite usage` — show the account's credit balance and plan/entitlement
 * info as a proactive pre-flight before a large `test run` fan-out.
 *
 * Backend note: `GET /me` now includes the `credits` / `subPlan` projection
 * (this shipped; the CLI's old "requires a backend update"
 * wording is stale and was removed). This command calls `/me` and surfaces
 * the `credits` / `subPlan` / `creditsPerRun` fields when and only when the
 * backend response includes them — kept absent-safe/forward-compat since not
 * every account shape is guaranteed to populate all three (e.g. `creditsPerRun`
 * has no server-side source at all today).
 */

import { Command } from 'commander';
import {
  emitDryRunBanner,
  makeHttpClient,
  parseRequestTimeoutFlag,
  type CommonOptions as FactoryCommonOptions,
} from '../lib/client-factory.js';
import { loadConfig } from '../lib/config.js';
import { resolvePortalBase } from '../lib/facade.js';
import type { FetchImpl } from '../lib/http.js';
import type { CliOrgBinding, CliOrgSummary } from '../lib/org-render.js';
import { formatOrgBinding, formatOrgsSummary } from '../lib/org-render.js';
import { GLOBAL_OPTS_HINT, Output, resolveOutputMode, type OutputMode } from '../lib/output.js';

/**
 * Usage/balance response from `/me` (when the backend supplies it) or a future
 * `/usage` endpoint.
 *
 * `credits` / `subPlan` now ship on `/me` (live). Still
 * kept optional/absent-safe: `userId`/`keyId`/`env` are the only fields every
 * backend and account shape is guaranteed to populate.
 */
export interface UsageResponse {
  userId: string;
  keyId: string;
  env: 'development' | 'staging' | 'production';
  /**
   * Remaining credit balance. Present when the backend /me (or /usage)
   * includes the User.credits projection (live).
   */
  credits?: number;
  /**
   * Subscription plan name (e.g. "Free", "Standard", "Pro"). Present when
   * the backend /me (or /usage) includes the User.subPlan projection (live).
   */
  subPlan?: string;
  /**
   * Credit cost per test run trigger (informational). Present only when the
   * backend supplies it.
   */
  creditsPerRun?: number;
  /**
   * The caller's organization wallet — the billing subject on org-based
   * accounts. Rendered only together with `v3Enabled: true` (see
   * `renderUsage`): the org wallet supersedes the legacy `credits`/`subPlan`
   * pair only for callers whose commands actually bill it. Absent-safe like
   * every other optional field.
   */
  activeOrg?: ActiveOrg;
  /**
   * Authoritative per-caller routing bit: true when this caller's commands
   * run (and bill) on the V3 platform. Always present on current backends;
   * absent on older ones.
   */
  v3Enabled?: boolean;
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
  v3Enabled: true,
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
 * Run the `usage` command. Calls `GET /me`, surfaces identity + any
 * credits/plan fields the backend supplies. Absent fields are silently
 * omitted (forward-compat in case a given account/backend version doesn't
 * populate them).
 */
export async function runUsage(opts: CommonOptions, deps: UsageDeps = {}): Promise<UsageResponse> {
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
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
      ? `${portalBase}/dashboard/settings/billing`
      : 'the portal Billing page (/dashboard/settings/billing)';

  // /me is the only available source of credits/plan today. If the backend
  // adds a dedicated /usage endpoint later, this single get call is where
  // it would be swapped in — no other code change needed in the CLI.
  const me = await client.get<UsageResponse>('/me');

  out.print(me, data => renderUsage(data as UsageResponse, portalBase));

  // In text mode, emit a note when NO balance was shown at all — neither the
  // legacy per-user `credits` nor an org wallet. A V3-routed org account can
  // legitimately have no DDB `credits` field (org-native members never get a
  // legacy user row), and its balance already rendered in the organization
  // block — the note would contradict the output right above it.
  //
  // "Is this key org-bound" and "do I have a balance number to show" are two
  // different questions and must not be conflated. `me.org` is the key's own
  // binding — always present, no I/O, populated whenever the request
  // authenticated with a membership key (`sk-member-…`). `activeOrg` is the
  // *enriched* org balance: the backend does a best-effort Postgres read for
  // it and swallows the exception on failure, so `org` can be present while
  // `activeOrg` (and, for a V3-native user with no legacy DynamoDB row,
  // `credits` too) is absent. Deciding org-boundedness from `activeOrg`
  // (i.e. `orgWalletShown`) alone means that degraded state falls through to
  // this personal-billing note — pointing an org-key operator at the wrong
  // wallet in exactly the situation this whole surface exists to prevent.
  const isOrgBound = me.org !== undefined;
  const orgWalletShown = me.v3Enabled === true && me.activeOrg !== undefined;
  if (opts.output === 'text' && me.credits === undefined && !orgWalletShown) {
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

function renderUsage(u: UsageResponse, portalBase?: string): string {
  const lines: string[] = [];

  // Identity block (always present)
  lines.push(`userId: ${u.userId}`);
  lines.push(`keyId:  ${u.keyId}`);
  lines.push(`env:    ${u.env}`);
  // Org attribution — rendered only when the backend supplies it.
  const orgsSummary = formatOrgsSummary(u.organizations);
  if (orgsSummary) lines.push(`orgs:   ${orgsSummary}`);
  const orgBinding = formatOrgBinding(u.org);
  if (orgBinding) lines.push(`org binding: ${orgBinding}`);

  // Whether the CALLING KEY is org-bound — read from `u.org` (the key's own
  // membership binding: always present, no I/O, populated whenever the
  // request authenticated with a `sk-member-…` key), NOT from `activeOrg`.
  // `activeOrg` is the *enriched* org balance: the backend does a best-effort
  // Postgres read for it and swallows the exception on failure, so a caller
  // can be genuinely org-bound (`org` present) while `activeOrg` — and, for a
  // V3-native user with no legacy DynamoDB row, `credits` too — is absent.
  // "Is this key org-bound" and "do I have a balance number to show" are two
  // different questions; conflating them (deciding org-boundedness from
  // `orgWallet`/`activeOrg` alone) sends a degraded-enrichment org caller
  // down the personal-wallet branches below.
  const isOrgBound = u.org !== undefined;

  // Org wallet block — the billing subject on org-based accounts. Rendered
  // only when the caller is actually V3-routed: `v3Enabled` is the
  // authoritative routing bit, so wallet selection never rests on field
  // presence alone. A V2-routed caller keeps the legacy block below (their
  // billable commands still charge the legacy wallet); older backends send
  // neither field and degrade the same way.
  // `?? undefined` also normalizes a hypothetical explicit `null` from the
  // wire so the block below can't dereference it.
  const orgWallet = u.v3Enabled === true ? (u.activeOrg ?? undefined) : undefined;
  if (orgWallet !== undefined) {
    const org = orgWallet;
    lines.push('');
    lines.push('--- organization ---');
    lines.push(`org:          ${org.name} (${org.role})`);
    lines.push(`plan:         ${org.plan}`);
    // Labeled `balance:` (not `credits:`) — `--output json` exposes the
    // legacy per-user number under `.credits`, and giving the org wallet the
    // same label in text mode would make one word mean two different values.
    lines.push(`balance:      ${org.remaining} remaining (${org.includedCredits}/mo per seat)`);
    lines.push(`seats:        ${org.seats}`);
    // No "~N runs" estimate here: org billing prices actions individually and
    // the API does not expose a per-run rate for the org wallet — an estimate
    // computed from the legacy frontend rate would be wrong.
  } else if (isOrgBound) {
    // Org-bound key, but the enrichment that would have populated `activeOrg`
    // degraded (best-effort Postgres read failed server-side, or `v3Enabled`
    // itself couldn't be resolved). Say so honestly — never fall through to
    // the legacy per-user blocks below (this key's commands bill the org
    // wallet, not the personal one, regardless of whether we could load its
    // number just now), and never fabricate an org-scoped URL.
    lines.push('');
    lines.push('--- organization ---');
    lines.push(
      "balance:      could not be loaded right now. Retry `testsprite usage`, or check the Portal's organization billing settings (ask an org admin if you don't have access).",
    );
  }

  // Legacy balance block — shown only when the backend supplies it, no org
  // wallet superseded it (older backends / V2-routed accounts), AND the key
  // isn't org-bound (an org-bound key's commands never charge these numbers,
  // even if a legacy row happens to still carry them).
  const hasBalanceData = u.credits !== undefined || u.subPlan !== undefined;
  if (orgWallet === undefined && !isOrgBound && hasBalanceData) {
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
      // Backend runs DO consume credits (confirmed by design 2026-06-30).
      // The API exposes no backend-specific per-run cost field, and it differs from
      // the frontend rate, so state that it bills without asserting a possibly-wrong
      // number — check your balance before/after, or see the billing page.
      lines.push(
        `cost per backend run:  also consumes credits (exact amount not reported by the API)`,
      );
    }

    // Pre-flight hint: how many runs the current balance can fund
    if (u.credits !== undefined && u.creditsPerRun !== undefined && u.creditsPerRun > 0) {
      const maxRuns = Math.floor(u.credits / u.creditsPerRun);
      lines.push(`can trigger:  ~${maxRuns} run(s) at current balance`);
    }
  }

  // Actionable upgrade line for Free or low-balance keys. Prefer the org
  // wallet's plan/balance when present. `!isOrgBound` guards the personal
  // branch of each: an org-bound key with degraded enrichment has no
  // `orgWallet` to compute from, but must not fall back to reading `u.credits`
  // / `u.subPlan` either (a legacy row that happens to coexist with an org
  // binding is not what this key's commands actually bill).
  const isLowBalance =
    orgWallet !== undefined
      ? orgWallet.remaining < LOW_ORG_BALANCE_CREDITS
      : !isOrgBound &&
        u.credits !== undefined &&
        u.creditsPerRun !== undefined &&
        u.credits < u.creditsPerRun;
  const isFree =
    orgWallet !== undefined
      ? orgWallet.plan.toLowerCase() === 'free'
      : !isOrgBound && u.subPlan?.toLowerCase() === 'free';

  if (isLowBalance) {
    lines.push('');
    // The org wallet is billed under the ORGANIZATION's own settings, not the
    // personal `/dashboard/settings/billing` page (that page manages the
    // legacy per-user DDB balance, a different column entirely) — so the
    // org branch deliberately does not point at that URL. No org-scoped
    // settings URL is fabricated here either: the CLI has no confirmed route
    // for one, so "ask an org admin" is the honest next step.
    lines.push(
      orgWallet !== undefined
        ? // Org billing prices actions individually, and cheaper actions (e.g.
          // a 1-credit backend run) may still succeed below the threshold —
          // so this is "low", not "cannot run".
          `warning: organization balance is low (under the ${LOW_ORG_BALANCE_CREDITS}-credit cost of a generation action). Top up in the Portal's organization billing settings (ask an org admin if you don't have access).`
        : `warning: credit balance is below the per-run cost. Top up at: ${portalBase !== undefined ? `${portalBase}/dashboard/settings/billing` : 'the portal Billing page (/dashboard/settings/billing)'}`,
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
        '  testsprite usage --debug         # trace HTTP method/path, request id, latency\n' +
        '  testsprite credits               # alias for usage\n' +
        '\nExit codes:\n' +
        '  0   success (or --dry-run)\n' +
        '  3   auth error — run `testsprite setup` to configure credentials\n' +
        '  10  transport/network failure (UNAVAILABLE) — retry the command\n' +
        "\nNote: if credit balance isn't shown for your account, check your portal's\n" +
        '  Billing page (/dashboard/settings/billing) for a personal key, or your\n' +
        '  organization billing settings (ask an org admin) if this key is\n' +
        '  organization-bound.',
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

function makeOutput(mode: OutputMode, deps: UsageDeps): Output {
  return new Output(mode, { stdout: deps.stdout, stderr: deps.stderr });
}
