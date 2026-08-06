/**
 * Unit tests for `testsprite usage` / `testsprite credits`.
 *
 * Backend follow-up: the `/me` endpoint must add `credits` + `subPlan` projection.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeProfile } from '../lib/credentials.js';
import type { UsageDeps, UsageResponse } from './usage.js';
import { DRY_RUN_USAGE_SAMPLE, createUsageCommand, runUsage } from './usage.js';

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

function makeCapture(): {
  capture: CapturedOutput;
  deps: Pick<UsageDeps, 'stdout' | 'stderr'>;
} {
  const capture: CapturedOutput = { stdout: [], stderr: [] };
  return {
    capture,
    deps: {
      stdout: line => capture.stdout.push(line),
      stderr: line => capture.stderr.push(line),
    },
  };
}

/** Minimal MeResponse without credits/subPlan (backend current state) */
const meWithoutCredits = {
  userId: 'u-abc',
  keyId: 'k-abc',
  scopes: ['read:projects', 'read:tests', 'write:tests', 'run:tests'],
  env: 'development' as const,
};

/** Extended MeResponse WITH credits + subPlan (backend future state) */
const meWithCredits: UsageResponse = {
  ...meWithoutCredits,
  credits: 100,
  subPlan: 'Standard',
  creditsPerRun: 2,
};

function makeFetch(body: unknown, status = 200): UsageDeps['fetchImpl'] {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as UsageDeps['fetchImpl'];
}

let credentialsPath: string;

beforeEach(() => {
  credentialsPath = join(mkdtempSync(join(tmpdir(), 'testsprite-usage-')), 'credentials');
});

describe('runUsage — dry-run', () => {
  it('emits the dry-run banner + note that these are sample values', async () => {
    const { capture, deps } = makeCapture();
    const result = await runUsage(
      { profile: 'default', output: 'text', debug: false, dryRun: true },
      deps,
    );
    const stderr = capture.stderr.join('\n');
    // Banner must be present.
    expect(stderr).toContain('dry-run');
    // Must note that these are canned sample values, not a real balance.
    expect(stderr).toContain('sample');
    // Must return the canned sample.
    expect(result).toEqual(DRY_RUN_USAGE_SAMPLE);
  });

  it('dry-run sample contains credits, subPlan, and creditsPerRun', () => {
    expect(DRY_RUN_USAGE_SAMPLE.credits).toBeGreaterThan(0);
    expect(DRY_RUN_USAGE_SAMPLE.subPlan).toBeTruthy();
    expect(DRY_RUN_USAGE_SAMPLE.creditsPerRun).toBeGreaterThan(0);
  });

  it('dry-run JSON output contains the sample fields', async () => {
    const { capture, deps } = makeCapture();
    await runUsage({ profile: 'default', output: 'json', debug: false, dryRun: true }, deps);
    const parsed = JSON.parse(capture.stdout.join('')) as UsageResponse;
    expect(parsed.credits).toBe(DRY_RUN_USAGE_SAMPLE.credits);
    expect(parsed.subPlan).toBe(DRY_RUN_USAGE_SAMPLE.subPlan);
    expect(parsed.creditsPerRun).toBe(DRY_RUN_USAGE_SAMPLE.creditsPerRun);
  });
});

describe('runUsage — real path without credits (current backend)', () => {
  it('returns the /me response and emits a note about missing balance', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const result = await runUsage(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch(meWithoutCredits),
      },
    );
    expect(result.userId).toBe('u-abc');
    expect(result.credits).toBeUndefined();
    // Must emit the note pointing at the billing URL.
    const stderr = capture.stderr.join('\n');
    expect(stderr).toContain('billing');
    expect(stderr).toContain('testsprite.com');
  });

  it('text output includes identity fields even without credits', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch(meWithoutCredits),
      },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('userId:');
    expect(out).toContain('u-abc');
  });

  it('JSON output passes the raw /me response through (no credits key present)', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'json', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch(meWithoutCredits),
      },
    );
    const parsed = JSON.parse(capture.stdout.join('')) as UsageResponse;
    expect(parsed.userId).toBe('u-abc');
    expect(parsed.credits).toBeUndefined();
  });
});

describe('runUsage — real path with credits (future backend)', () => {
  it('renders balance block when credits + subPlan are present', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch(meWithCredits),
      },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('credits:');
    expect(out).toContain('100');
    expect(out).toContain('plan:');
    expect(out).toContain('Standard');
    expect(out).toContain('cost per frontend run:');
    // Should show max runs estimate.
    expect(out).toContain('can trigger:');
    // 100 / 2 = 50 runs
    expect(out).toContain('50');
  });

  it('does NOT emit the missing-balance note when credits are present', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch(meWithCredits),
      },
    );
    const stderr = capture.stderr.join('\n');
    // No missing-balance note when data is present.
    expect(stderr).not.toContain('not available');
  });

  it('emits low-balance warning when credits < creditsPerRun', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const lowBalance: UsageResponse = { ...meWithCredits, credits: 1, creditsPerRun: 2 };
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch(lowBalance),
      },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('warning');
    expect(out).toContain('billing');
  });

  it('emits free-plan upgrade hint when subPlan is Free', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const freePlan: UsageResponse = { ...meWithCredits, subPlan: 'Free', credits: 10 };
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch(freePlan),
      },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('Free plan');
    expect(out).toContain('pricing');
  });

  it('JSON output passes credits and subPlan through verbatim', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'json', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch(meWithCredits),
      },
    );
    const parsed = JSON.parse(capture.stdout.join('')) as UsageResponse;
    expect(parsed.credits).toBe(100);
    expect(parsed.subPlan).toBe('Standard');
    expect(parsed.creditsPerRun).toBe(2);
  });
});

describe('runUsage — org wallet (activeOrg)', () => {
  const meWithOrg: UsageResponse = {
    ...meWithCredits,
    // The org block renders only for V3-routed callers: the renderer checks
    // the authoritative `v3Enabled` routing bit alongside `activeOrg`,
    // never field presence alone.
    v3Enabled: true,
    activeOrg: {
      id: 'org-1',
      name: 'Acme QA',
      plan: 'Standard',
      role: 'admin',
      remaining: 1650,
      includedCredits: 1600,
      seats: 3,
    },
  };

  it('renders the org block and suppresses the legacy balance block', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(meWithOrg) },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('organization');
    expect(out).toContain('Acme QA (admin)');
    expect(out).toContain('Standard');
    // `balance:` (not `credits:`) — the legacy per-user number keeps the
    // `credits` name in JSON output, so the org wallet must not reuse it.
    expect(out).toContain('balance:      1650 remaining');
    expect(out).toContain('seats:');
    // Legacy per-user block is superseded — its lines must not render.
    expect(out).not.toContain('cost per frontend run:');
    expect(out).not.toContain('can trigger:');
  });

  it('low org balance triggers the top-up warning', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const drained: UsageResponse = {
      ...meWithOrg,
      activeOrg: { ...meWithOrg.activeOrg!, remaining: 1 },
    };
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(drained) },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('warning');
    expect(out).toContain('billing');
  });

  // The org wallet is a DIFFERENT settings page than the personal
  // `/dashboard/settings/billing` route (that page only manages the legacy
  // per-user balance) — the low-balance warning must not point an org-bound
  // caller at a page that can't actually top up their wallet.
  it('low org balance warning does not point at the personal billing URL', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const drained: UsageResponse = {
      ...meWithOrg,
      activeOrg: { ...meWithOrg.activeOrg!, remaining: 1 },
    };
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(drained) },
    );
    const out = capture.stdout.join('\n');
    expect(out).not.toContain('/dashboard/settings/billing');
    expect(out.toLowerCase()).toContain('org admin');
  });

  // The non-org (legacy) low-balance path is unchanged: it still points at
  // the real personal billing URL.
  it('low personal balance warning still points at /dashboard/settings/billing', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const drainedLegacy: UsageResponse = {
      ...meWithCredits,
      credits: 0,
      creditsPerRun: 2,
    };
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(drainedLegacy) },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('/dashboard/settings/billing');
  });

  it('Free org plan triggers the upgrade hint even when legacy subPlan is paid', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const freeOrg: UsageResponse = {
      ...meWithOrg,
      subPlan: 'Standard', // stale legacy value — org plan must win
      activeOrg: { ...meWithOrg.activeOrg!, plan: 'Free', remaining: 150 },
    };
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(freeOrg) },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('Free plan');
    expect(out).toContain('pricing');
  });

  it('JSON output passes activeOrg through verbatim', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'json', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(meWithOrg) },
    );
    const parsed = JSON.parse(capture.stdout.join('')) as UsageResponse;
    expect(parsed.activeOrg).toEqual(meWithOrg.activeOrg);
  });

  it('absent activeOrg keeps the legacy rendering intact (older backends)', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(meWithCredits) },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('cost per frontend run:');
    expect(out).not.toContain('organization');
  });

  it('org account without legacy credits → org block renders and NO missing-balance note', async () => {
    // A V3-native org account has no DDB user row, so the legacy `credits`
    // field is legitimately absent — but its balance already rendered in the
    // organization block, so the stderr "balance not returned" note must not
    // fire (it would contradict the output right above it).
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const orgOnly: UsageResponse = {
      ...meWithOrg,
      credits: undefined,
      subPlan: undefined,
      creditsPerRun: undefined,
    };
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(orgOnly) },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('organization');
    expect(out).toContain('1650 remaining');
    expect(capture.stderr.join('\n')).not.toContain('credit balance not returned');
  });

  it('activeOrg present but v3Enabled false → legacy rendering (wallet selection follows routing, not field presence)', async () => {
    // Defense-in-depth: a V2-routed caller's billable commands charge the
    // legacy wallet, so an org block must never supersede the legacy lines
    // for them — even if a backend regression ships activeOrg to such a
    // caller again. The current backend never produces this combination.
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const v2Routed: UsageResponse = { ...meWithOrg, v3Enabled: false };
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(v2Routed) },
    );
    const out = capture.stdout.join('\n');
    expect(out).not.toContain('organization');
    expect(out).toContain('cost per frontend run:');
  });
});

describe('runUsage — org-bound key with degraded /me enrichment', () => {
  // A Postgres-backed membership key (`sk-member-…`) — `cli.guard.ts` only ever
  // populates `/me`'s `org` field for THIS key family; a legacy `sk-user-…`
  // key never carries an org binding at all. Using a legacy key here would
  // model a `{apiKey: sk-user-…, me: {org: {...}}}` combination the real
  // backend can never produce, which would silently stop protecting the
  // behavior these tests exist for. (`runUsage` itself doesn't branch on the
  // key's own shape — only on what `/me` returns — so this only matters for
  // fixture realism, not for making the assertions below pass.)
  const MEMBERSHIP_KEY = `tsp_u_${'A'.repeat(43)}`;

  // `me.controller.ts` keeps `org` (no I/O — the key's own binding) even when
  // the best-effort `activeOrg` Postgres enrichment throws and is swallowed.
  // A V3-native org member has no legacy DynamoDB user row either, so
  // `credits`/`subPlan` are absent too. This is the exact reachable state the
  // backend's own tests cover (PG down + no DDB row → both `activeOrg` and
  // `credits` missing) — org-boundedness must be read from `org`, never from
  // `activeOrg`/`v3Enabled` alone, or this state falls through to the
  // personal-billing branches.
  const degradedOrgBound: UsageResponse = {
    ...meWithoutCredits,
    v3Enabled: true,
    org: { id: 'org-1', name: 'Acme QA', role: 'admin' },
    // activeOrg, credits, subPlan all absent — enrichment degraded.
  };

  it('does not point the caller at the personal billing page', async () => {
    writeProfile('default', { apiKey: MEMBERSHIP_KEY }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(degradedOrgBound) },
    );
    const out = capture.stdout.join('\n');
    const err = capture.stderr.join('\n');
    expect(out).not.toContain('/dashboard/settings/billing');
    expect(err).not.toContain('/dashboard/settings/billing');
  });

  it('says the org balance could not be loaded, and asks for an org admin — not a fabricated org URL', async () => {
    writeProfile('default', { apiKey: MEMBERSHIP_KEY }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(degradedOrgBound) },
    );
    const out = capture.stdout.join('\n');
    const err = capture.stderr.join('\n');
    const combined = `${out}\n${err}`;
    expect(combined.toLowerCase()).toContain('could not be loaded');
    expect(combined.toLowerCase()).toContain('org admin');
    // No fabricated org-scoped settings URL — the CLI has no confirmed route.
    expect(combined).not.toMatch(/https?:\/\/\S+\/dashboard/);
  });

  it('never falls back to rendering a legacy credits/plan block', async () => {
    writeProfile('default', { apiKey: MEMBERSHIP_KEY }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(degradedOrgBound) },
    );
    const out = capture.stdout.join('\n');
    expect(out).not.toContain('--- credits & plan ---');
    expect(out).not.toContain('cost per frontend run:');
  });

  // A user who signed up before V3 (and so still carries a legacy DynamoDB
  // `credits`/`subPlan` row) can LATER be issued a membership key — `/me`'s
  // billing enrichment GetItems `UserEntity` independently of the org read,
  // so both can coexist. This is the fixture that actually exercises the
  // `!isOrgBound` guards on the legacy block / low-balance / free-plan
  // branches: `degradedOrgBound` above has no legacy fields at all, so those
  // branches were already false before the guard existed and the assertions
  // above passed vacuously. Here `credits`/`subPlan` are deliberately set to
  // values that WOULD trip both the low-balance warning and the Free-plan
  // upgrade hint on the personal branch if the org binding weren't checked
  // first.
  const migratedOrgBound: UsageResponse = {
    ...meWithoutCredits,
    v3Enabled: true,
    org: { id: 'org-1', name: 'Acme QA', role: 'admin' },
    credits: 0,
    subPlan: 'Free',
    creditsPerRun: 2,
    // activeOrg absent — degraded enrichment, same as above.
  };

  it('migrated user (stale legacy credits/subPlan + org binding): renders neither the legacy block nor its low-balance/Free-plan hints', async () => {
    writeProfile('default', { apiKey: MEMBERSHIP_KEY }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(migratedOrgBound) },
    );
    const out = capture.stdout.join('\n');
    const err = capture.stderr.join('\n');
    expect(out).not.toContain('--- credits & plan ---');
    // Would have fired from the personal low-balance branch (credits:0 <
    // creditsPerRun:2) had `!isOrgBound` not gated it.
    expect(out).not.toContain('credit balance is below the per-run cost');
    // Would have fired from the personal Free-plan branch (subPlan:'Free')
    // had `!isOrgBound` not gated it.
    expect(out).not.toContain('Free plan');
    expect(out).not.toContain('pricing');
    expect(out).not.toContain('/dashboard/settings/billing');
    expect(err).not.toContain('/dashboard/settings/billing');
    // The honest degraded-org line still renders instead.
    expect(out.toLowerCase()).toContain('could not be loaded');
  });
});

describe('runUsage — org attribution', () => {
  it('renders `orgs:` and `org binding:` lines when the backend supplies them', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const meWithOrgs: UsageResponse = {
      ...meWithoutCredits,
      organizations: [{ id: 'org_1', name: 'Acme Corp', role: 'owner', isPersonal: false }],
      org: { id: 'org_1', name: 'Acme Corp', role: 'owner' },
    };
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(meWithOrgs) },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('orgs:   Acme Corp (org_1, role: owner)');
    expect(out).toContain('org binding: Acme Corp (org_1, role: owner)');
  });

  it('omits the org lines entirely when the backend does not return them', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(meWithoutCredits) },
    );
    const out = capture.stdout.join('\n');
    expect(out).not.toContain('orgs:');
    expect(out).not.toContain('org binding:');
    expect(out).not.toContain('undefined');
  });

  it('--output json passes organizations[] and org through verbatim', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const meWithOrgs: UsageResponse = {
      ...meWithoutCredits,
      organizations: [{ id: 'org_1', name: 'Acme Corp', role: 'owner', isPersonal: false }],
      org: { id: 'org_1', name: 'Acme Corp', role: 'owner' },
    };
    await runUsage(
      { profile: 'default', output: 'json', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(meWithOrgs) },
    );
    const parsed = JSON.parse(capture.stdout.join('')) as UsageResponse;
    expect(parsed.organizations).toEqual(meWithOrgs.organizations);
    expect(parsed.org).toEqual(meWithOrgs.org);
  });
});

describe('runUsage — error handling', () => {
  it('throws AUTH_REQUIRED when no profile is configured', async () => {
    const { deps } = makeCapture();
    await expect(
      runUsage({ profile: 'default', output: 'text', debug: false }, { ...deps, credentialsPath }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('forwards server AUTH_INVALID with exit code 3', async () => {
    writeProfile('default', { apiKey: 'sk-user-bad' }, { path: credentialsPath });
    const { deps } = makeCapture();
    const errorBody = {
      error: {
        code: 'AUTH_INVALID',
        message: 'Bad key.',
        nextAction: 'rotate it',
        requestId: 'req_x',
        details: {},
      },
    };
    await expect(
      runUsage(
        { profile: 'default', output: 'text', debug: false },
        {
          ...deps,
          credentialsPath,
          fetchImpl: makeFetch(errorBody, 401),
        },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID', exitCode: 3 });
  });

  it('re-maps INSUFFICIENT_CREDITS (rate_limited with credits sub-case) to exit 12', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { deps } = makeCapture();
    const creditError = {
      error: {
        code: 'RATE_LIMITED',
        message: 'Insufficient credits: 2 credit(s) required.',
        nextAction: 'Top up at billing.',
        requestId: 'req_y',
        details: { required: 2, userId: 'u-abc' },
      },
    };
    await expect(
      runUsage(
        { profile: 'default', output: 'text', debug: false },
        {
          ...deps,
          credentialsPath,
          fetchImpl: makeFetch(creditError, 429),
        },
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS', exitCode: 12 });
  });
});

describe('createUsageCommand wiring', () => {
  it('exposes the expected command name and credits alias', () => {
    const cmd = createUsageCommand();
    expect(cmd.name()).toBe('usage');
    expect(cmd.alias()).toBe('credits');
  });

  it('--help includes the expected command description', () => {
    const cmd = createUsageCommand();
    const helpText = cmd.helpInformation();
    // Commander's helpInformation() includes the command description.
    expect(helpText).toContain('credit balance');
  });
});
