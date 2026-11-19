/**
 * Unit tests for `testsprite usage` / `testsprite credits`.
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

/** `/me` identity core with no wallet (the `activeOrg` enrichment failed). */
const meWithoutCredits = {
  userId: 'u-abc',
  keyId: 'k-abc',
  scopes: ['read:projects', 'read:tests', 'write:tests', 'run:tests'],
  env: 'development' as const,
};

const meWithOrg: UsageResponse = {
  ...meWithoutCredits,
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

/**
 * What the backend actually sends: the wallet plus its flattened copy
 * (`credits`/`subPlan`/`creditsPerRun`) and `v3Enabled: true`, both kept on the
 * wire for older CLIs. This CLI renders the wallet from `activeOrg` only.
 */
const meWire = {
  ...meWithOrg,
  credits: 1650,
  subPlan: 'Standard',
  creditsPerRun: 2,
  v3Enabled: true,
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

  it('dry-run sample carries an org wallet and renders it', async () => {
    expect(DRY_RUN_USAGE_SAMPLE.activeOrg?.remaining).toBeGreaterThan(0);
    const { capture, deps } = makeCapture();
    await runUsage({ profile: 'default', output: 'text', debug: false, dryRun: true }, deps);
    expect(capture.stdout.join('\n')).toContain('--- organization ---');
  });

  it('dry-run JSON output contains the sample wallet', async () => {
    const { capture, deps } = makeCapture();
    await runUsage({ profile: 'default', output: 'json', debug: false, dryRun: true }, deps);
    const parsed = JSON.parse(capture.stdout.join('')) as UsageResponse;
    expect(parsed.activeOrg).toEqual(DRY_RUN_USAGE_SAMPLE.activeOrg);
  });
});

describe('runUsage — real path without a wallet', () => {
  // Confirms `usage` never sends X-CLI-Command — it must stay a plain,
  // untagged /me call (only `runInit`'s configure-validate step tags it).
  it('sends no X-CLI-Command header on its GET /me call', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { deps } = makeCapture();
    const sentHeaders: Array<Record<string, string> | undefined> = [];
    const capturingFetch = vi.fn(
      async (_url: string, init: { headers?: Record<string, string> }) => {
        sentHeaders.push(init?.headers);
        return new Response(JSON.stringify(meWithoutCredits), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    ) as unknown as UsageDeps['fetchImpl'];
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: capturingFetch },
    );
    expect(sentHeaders).toHaveLength(1);
    expect(sentHeaders[0]?.['x-cli-command']).toBeUndefined();
  });

  it('returns the /me response and points at the org-less Portal billing page', async () => {
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
    expect(result.activeOrg).toBeUndefined();
    const stderr = capture.stderr.join('\n');
    expect(stderr).toContain('credit balance not returned');
    expect(stderr).toContain('https://www.testsprite.com/dashboard-v3/settings/billing');
  });

  // Issue #277: the usage projection is validated at the client boundary, so a
  // drifted identity core surfaces as a typed envelope instead of a crash.
  it('rejects a /me body without its identity core with a typed INTERNAL envelope', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { deps } = makeCapture();
    const rejection = await runUsage(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch({ ...meWithoutCredits, keyId: 42 }),
      },
    ).catch((error: unknown) => error);
    expect(rejection).toMatchObject({ code: 'INTERNAL' });
  });

  it('text output includes identity fields even without a wallet', async () => {
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
    expect(out).not.toContain('--- organization ---');
  });

  it('JSON output passes the raw /me response through (no activeOrg key present)', async () => {
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
    expect(parsed.activeOrg).toBeUndefined();
  });
});

describe('runUsage — org wallet (activeOrg)', () => {
  it('renders the org block from activeOrg and ignores the flattened wire copy', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(meWire) },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('--- organization ---');
    expect(out).toContain('Acme QA (admin)');
    expect(out).toContain('Standard');
    expect(out).toContain('balance:      1650 remaining');
    expect(out).toContain('seats:');
    // The per-user block and its per-run estimate are gone.
    expect(out).not.toContain('--- credits & plan ---');
    expect(out).not.toContain('cost per frontend run:');
    expect(out).not.toContain('can trigger:');
    expect(capture.stderr.join('\n')).not.toContain('credit balance not returned');
  });

  it('does not read v3Enabled: the wallet renders whatever the field says', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch({ ...meWire, v3Enabled: false }) },
    );
    expect(capture.stdout.join('\n')).toContain('balance:      1650 remaining');
  });

  it('renders a `state:` line for a paused workspace, with the notice and its billing link', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const paused: UsageResponse = {
      ...meWithOrg,
      activeOrg: {
        ...meWithOrg.activeOrg!,
        workspace: {
          state: 'paused',
          tier: 'Paused',
          notice: {
            title: 'Workspace paused',
            message: 'This workspace is paused because its subscription ended.',
            cta: 'Renew subscription',
            billingUrl: 'https://portal.example/o/org-1/settings/billing',
          },
        },
      },
    };
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(paused) },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain(
      'state:        paused — This workspace is paused because its subscription ended. Renew subscription: https://portal.example/o/org-1/settings/billing',
    );
  });

  it('renders a `state:` line for a payment-pending workspace and none while it is simply on its plan', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const pending: UsageResponse = {
      ...meWithOrg,
      activeOrg: {
        ...meWithOrg.activeOrg!,
        workspace: { state: 'pending', tier: 'Standard', notice: null },
      },
    };
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(pending) },
    );
    expect(capture.stdout.join('\n')).toContain(
      'state:        pending — a scheduled plan change or a payment retry is in progress',
    );

    const { capture: okCapture, deps: okDeps } = makeCapture();
    const ok: UsageResponse = {
      ...meWithOrg,
      activeOrg: {
        ...meWithOrg.activeOrg!,
        workspace: { state: 'ok', tier: 'Standard', notice: null },
      },
    };
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...okDeps, credentialsPath, fetchImpl: makeFetch(ok) },
    );
    expect(okCapture.stdout.join('\n')).not.toContain('state:');
  });

  // The Portal's org-less billing route re-anchors under the viewer's ACTIVE
  // workspace, which need not be the org this key bills — so the low-balance
  // warning names the organization's billing settings instead of a URL.
  it('low org balance triggers the top-up warning without a billing URL', async () => {
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
    expect(out).toContain('warning: organization balance is low');
    expect(out).toContain('billing');
    expect(out).not.toContain('/settings/billing');
    expect(out.toLowerCase()).toContain('org admin');
  });

  it('Free org plan triggers the upgrade hint even when the flattened subPlan says otherwise', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const freeOrg = {
      ...meWire,
      subPlan: 'Standard',
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

  it('JSON output passes the /me body through verbatim, wire extras included', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'json', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(meWire) },
    );
    const parsed = JSON.parse(capture.stdout.join('')) as Record<string, unknown>;
    expect(parsed.activeOrg).toEqual(meWithOrg.activeOrg);
    expect(parsed.credits).toBe(1650);
  });
});

describe('runUsage — org-bound key with degraded /me enrichment', () => {
  // A Postgres-backed membership key (`sk-member-…`) — `cli.guard.ts` only ever
  // populates `/me`'s `org` field for THIS key family. (`runUsage` itself
  // doesn't branch on the key's own shape — only on what `/me` returns — so
  // this only matters for fixture realism.)
  const MEMBERSHIP_KEY = `tsp_u_${'A'.repeat(43)}`;

  // `me.controller.ts` keeps `org` (no I/O — the key's own binding) even when
  // the best-effort `activeOrg` Postgres enrichment throws and is swallowed,
  // and it then omits the flattened billing fields too. Org-boundedness must
  // be read from `org`, never from `activeOrg`, or this state falls through
  // to the generic billing note.
  const degradedOrgBound: UsageResponse = {
    ...meWithoutCredits,
    org: { id: 'org-1', name: 'Acme QA', role: 'admin' },
  };

  it('does not point the caller at the generic billing page', async () => {
    writeProfile('default', { apiKey: MEMBERSHIP_KEY }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath, fetchImpl: makeFetch(degradedOrgBound) },
    );
    const out = capture.stdout.join('\n');
    const err = capture.stderr.join('\n');
    expect(out).not.toContain('/settings/billing');
    expect(err).not.toContain('/settings/billing');
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
    expect(combined).not.toMatch(/https?:\/\/\S+\/dashboard/);
  });

  // Flattened billing fields without `activeOrg` are never rendered: the
  // low-balance and Free-plan hints read the wallet only.
  it('stray flattened credits/subPlan without activeOrg render no low-balance or Free-plan hints', async () => {
    writeProfile('default', { apiKey: MEMBERSHIP_KEY }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runUsage(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        credentialsPath,
        fetchImpl: makeFetch({
          ...degradedOrgBound,
          credits: 0,
          subPlan: 'Free',
          creditsPerRun: 2,
        }),
      },
    );
    const out = capture.stdout.join('\n');
    expect(out).not.toContain('--- credits & plan ---');
    expect(out).not.toContain('warning:');
    expect(out).not.toContain('Free plan');
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
