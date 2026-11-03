import { afterEach, describe, expect, it } from 'vitest';
import { classifyBillingRefusal } from './billing-refusal.js';
import { ApiError } from './errors.js';

const originalPortal = process.env.TESTSPRITE_PORTAL_URL;
afterEach(() => {
  if (originalPortal === undefined) delete process.env.TESTSPRITE_PORTAL_URL;
  else process.env.TESTSPRITE_PORTAL_URL = originalPortal;
});

function refusal(
  code: 'FEATURE_GATED' | 'INSUFFICIENT_CREDITS',
  details: Record<string, unknown>,
  nextAction = '',
  apiUrl = 'https://unknown-api.example',
  message = 'Refused.',
) {
  return ApiError.fromEnvelope(
    { error: { code, message, nextAction, requestId: 'req_1', details } },
    code === 'FEATURE_GATED' ? 403 : 402,
    undefined,
    apiUrl,
  );
}

describe('billing refusal classifier', () => {
  it.each([
    ['plan', 'not_entitled'],
    ['not_entitled', 'not_entitled'],
    ['plan_limit', 'limit_exceeded'],
    ['limit_exceeded', 'limit_exceeded'],
    ['billing_hold', 'paused'],
    ['paused', 'paused'],
  ] as const)('reads details.reason %s as the gate refusal %s', (wire, refusalName) => {
    const result = classifyBillingRefusal(refusal('FEATURE_GATED', { reason: wire }));
    expect(result?.reason).toBe(refusalName);
    expect(result?.links).toEqual({ pricing: '/pricing', billing: '/dashboard/settings/billing' });
    expect(result?.nextAction).toContain('/dashboard/settings/billing');
  });

  it('adds only links — the server message already says what was refused and why', () => {
    const result = classifyBillingRefusal(
      refusal(
        'FEATURE_GATED',
        {
          reason: 'plan_limit',
          feature: 'environment',
          plan: 'Free',
          limit: 1,
          current: 1,
          requiredPlan: 'Standard',
        },
        '',
        'https://unknown-api.example',
        'This workspace has 1 environment and the Free plan allows 1.',
      ),
    );
    expect(result?.lines).toEqual(['  upgrade:   /pricing']);
  });

  it('does not repeat a link the server text already printed', () => {
    const server = 'https://portal.example';
    const billingUrl = `${server}/dashboard-v3/o/org-1/settings/billing`;
    const both = classifyBillingRefusal(
      refusal(
        'FEATURE_GATED',
        { reason: 'plan', feature: 'schedule', plan: 'Free', orgId: 'org-1' },
        `Upgrade at ${billingUrl} (plans: ${server}/pricing), then retry.`,
      ),
    );
    expect(both?.lines.some(line => line.includes('upgrade:') || line.includes('billing:'))).toBe(
      false,
    );
    expect(both?.links).toEqual({ pricing: `${server}/pricing`, billing: billingUrl });

    const billingOnly = classifyBillingRefusal(
      refusal(
        'FEATURE_GATED',
        { reason: 'plan_limit', feature: 'testlist', plan: 'Free', limit: 1, current: 1 },
        `Delete one and retry, or upgrade at ${billingUrl} for a higher limit.`,
      ),
    );
    expect(billingOnly?.lines.filter(line => /upgrade:|billing:/u.test(line))).toEqual([
      `  upgrade:   ${server}/pricing`,
    ]);
  });

  it('uses the server portal origin and keeps server nextAction verbatim', () => {
    const action = 'Upgrade at https://dev.portal.example/pricing, then retry.';
    const result = classifyBillingRefusal(refusal('FEATURE_GATED', { reason: 'plan' }, action));
    expect(result?.nextAction).toBe(action);
    expect(result?.links).toEqual({
      pricing: 'https://dev.portal.example/pricing',
      billing: 'https://dev.portal.example/dashboard/settings/billing',
    });
  });

  it('takes an explicit billing URL from details and derives the portal origin', () => {
    const url = 'https://dev.portal.example/dashboard-v3/o/org-1/settings/billing';
    const result = classifyBillingRefusal(
      refusal('FEATURE_GATED', { reason: 'billing_hold', billingUrl: url }),
    );
    expect(result?.links).toEqual({ pricing: 'https://dev.portal.example/pricing', billing: url });
  });

  it('finds a billing URL after a pricing URL in server text', () => {
    const action =
      'Plans: https://dev.portal.example/pricing. Billing: https://dev.portal.example/dashboard-v3/o/org-1/settings/billing.';
    const result = classifyBillingRefusal(refusal('FEATURE_GATED', { reason: 'plan' }, action));
    expect(result?.links.billing).toBe(
      'https://dev.portal.example/dashboard-v3/o/org-1/settings/billing',
    );
  });

  it('uses the org id only when supplied and supports the portal override', () => {
    process.env.TESTSPRITE_PORTAL_URL = 'https://chosen.example/';
    const result = classifyBillingRefusal(
      refusal(
        'FEATURE_GATED',
        { reason: 'plan', orgId: 'org-1' },
        'Upgrade at https://server.example/pricing.',
      ),
    );
    expect(result?.links).toEqual({
      pricing: 'https://chosen.example/pricing',
      billing: 'https://chosen.example/dashboard-v3/o/org-1/settings/billing',
    });
  });

  it('uses the production mapping and prints no missing values', () => {
    const result = classifyBillingRefusal(
      refusal('FEATURE_GATED', {}, '', 'https://api.testsprite.com'),
    );
    expect(result?.reason).toBe('not_entitled');
    expect(result?.links.pricing).toBe('https://www.testsprite.com/pricing');
    expect(JSON.stringify(result)).not.toMatch(/undefined|null/);
  });

  it('does not render placeholder org ids or server URLs as links', () => {
    const result = classifyBillingRefusal(
      refusal('FEATURE_GATED', {
        reason: 'plan',
        orgId: 'undefined',
        billingUrl: 'https://undefined/dashboard-v3/o/null/settings/billing',
      }),
    );
    expect(result?.links).toEqual({ pricing: '/pricing', billing: '/dashboard/settings/billing' });
    expect(JSON.stringify(result?.links)).not.toMatch(/undefined|null/);
  });

  it('classifies credits and excludes rollout gates', () => {
    const credits = classifyBillingRefusal(refusal('INSUFFICIENT_CREDITS', { required: 2 }));
    expect(credits?.reason).toBe('insufficient_credits');
    expect(credits?.lines.some(line => line.includes('required'))).toBe(false);
    expect(credits?.links.pricing).toBe('/pricing');
    expect(classifyBillingRefusal(refusal('FEATURE_GATED', { reason: 'rollout' }))).toBeUndefined();
  });

  it('excludes the MCP view-only mirror reason — not a billing refusal, no links, no synthesized advice', () => {
    expect(
      classifyBillingRefusal(refusal('FEATURE_GATED', { reason: 'mcp_origin' })),
    ).toBeUndefined();
    // Any other reason this CLI version has never heard of is treated the
    // same way — only the gate's refusals (or no reason at all) are billing.
    expect(
      classifyBillingRefusal(refusal('FEATURE_GATED', { reason: 'some_future_reason' })),
    ).toBeUndefined();
  });

  it('a paused workspace without a server nextAction gets advice that does not guess the cause', () => {
    // Paused covers an ended subscription, a failed payment, and a paid
    // workspace over its target plan's limits; only the server knows which.
    for (const state of [undefined, 'paused']) {
      const result = classifyBillingRefusal(
        refusal('FEATURE_GATED', { reason: 'billing_hold', ...(state ? { state } : {}) }),
      );
      expect(result?.nextAction).toBe(
        'See /dashboard/settings/billing to resume this workspace, then retry.',
      );
      expect(result?.lines).toEqual(['  upgrade:   /pricing']);
    }
  });

  it('TESTSPRITE_PORTAL_URL rebases a server-found billing URL onto the override origin', () => {
    process.env.TESTSPRITE_PORTAL_URL = 'https://chosen.example';
    const result = classifyBillingRefusal(
      refusal('FEATURE_GATED', {
        reason: 'billing_hold',
        billingUrl: 'https://dev.portal.example/dashboard-v3/o/org-9/settings/billing',
      }),
    );
    expect(result?.links).toEqual({
      pricing: 'https://chosen.example/pricing',
      billing: 'https://chosen.example/dashboard-v3/o/org-9/settings/billing',
    });
  });

  it('finds a portal URL wrapped in backticks in the server text', () => {
    const action = 'Upgrade at `https://dev.portal.example/pricing`, then retry.';
    const result = classifyBillingRefusal(refusal('FEATURE_GATED', { reason: 'plan' }, action));
    expect(result?.links.pricing).toBe('https://dev.portal.example/pricing');
  });
});
