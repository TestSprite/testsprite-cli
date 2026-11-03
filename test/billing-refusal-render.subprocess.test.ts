import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertFreshBuild } from './helpers/assertFreshBuild.js';

const repoRoot = resolve(import.meta.dirname, '..');
const binary = resolve(repoRoot, 'dist/index.js');
const portal = 'https://dev.portal.example';
const billing = `${portal}/dashboard-v3/o/org-1/settings/billing`;

const cases = {
  plan_limit: {
    status: 403,
    code: 'FEATURE_GATED',
    message: 'Plan limit reached: the Free plan allows 1 testlist(s) and this workspace has 1.',
    nextAction: `Delete an existing testlist and retry, or upgrade at ${portal}/pricing.`,
    details: {
      reason: 'plan_limit',
      feature: 'testlist',
      plan: 'Free',
      limit: 1,
      current: 1,
      orgId: 'org-1',
    },
    // The server's text already says what the limit is and prints the pricing
    // link, so only the missing workspace billing link is added.
    lines: [`  billing:   ${billing}`],
  },
  plan: {
    status: 403,
    code: 'FEATURE_GATED',
    message: "Feature 'schedule' is not available on the Free plan.",
    nextAction: '',
    details: {
      reason: 'plan',
      feature: 'schedule',
      plan: 'Free',
      requiredPlan: 'Starter',
      orgId: 'org-1',
    },
    // The synthesized nextAction carries both links, so none is repeated.
    lines: [],
  },
  // A paid workspace paused because it no longer fits its target plan: the
  // server's text says why, and the CLI adds only the missing pricing link.
  paused: {
    status: 403,
    code: 'FEATURE_GATED',
    message:
      "This workspace is paused: it is over the Standard plan's limits. Remove the extra items, or upgrade, in Settings → Billing to resume.",
    nextAction: `Manage plan at ${billing}, then retry. Retrying before that will keep being refused.`,
    details: {
      reason: 'billing_hold',
      state: 'paused',
      pauseKind: 'scheduled_downgrade',
      orgId: 'org-1',
    },
    lines: [`  upgrade:   ${portal}/pricing`],
  },
  credits: {
    status: 402,
    code: 'INSUFFICIENT_CREDITS',
    message: 'Insufficient credits: 2 required.',
    nextAction: '',
    details: { required: 2, orgId: 'org-1' },
    lines: [`  billing:   ${billing}`],
  },
  rollout: {
    status: 403,
    code: 'FEATURE_GATED',
    message: 'This feature is not rolled out.',
    nextAction: 'Wait for the rollout.',
    details: { reason: 'rollout', feature: 'schedule' },
    lines: [],
  },
  mcp_origin: {
    status: 403,
    code: 'FEATURE_GATED',
    message: 'This project is a view-only MCP mirror.',
    nextAction: 'Open this project in your IDE MCP client to run tests.',
    details: { reason: 'mcp_origin' },
    lines: [],
  },
} as const;

function run(shape: keyof typeof cases, args: string[]) {
  assertFreshBuild(repoRoot, binary);
  const preload = `
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith('/api/cli/v1/tunnel') && init?.method === 'POST') {
        const entry = ${JSON.stringify(cases)}[process.env.BILLING_SHAPE];
        return new Response(JSON.stringify({ error: {
          code: entry.code, message: entry.message, nextAction: entry.nextAction,
          requestId: 'req_billing', details: entry.details,
        } }), { status: entry.status, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('Unexpected fetch: ' + String(input));
    };
  `;
  return spawnSync(
    process.execPath,
    [
      `--import=data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`,
      binary,
      ...args,
      'tunnel',
      'start',
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        BILLING_SHAPE: shape,
        TESTSPRITE_API_KEY: 'sk-user-subproc',
        TESTSPRITE_API_URL: 'https://unknown-api.example',
        TESTSPRITE_PORTAL_URL: portal,
        TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
        TESTSPRITE_NO_TELEMETRY: '1',
        NO_COLOR: '1',
      },
    },
  );
}

describe('billing refusal rendering in the built CLI', () => {
  it.each(['plan_limit', 'plan', 'paused', 'credits', 'rollout', 'mcp_origin'] as const)(
    '%s text and JSON',
    shape => {
      const entry = cases[shape];
      const textResult = run(shape, []);
      expect(textResult.error).toBeUndefined();
      expect(textResult.status).toBe(shape === 'credits' ? 12 : 13);
      const action =
        entry.nextAction ||
        (shape === 'plan'
          ? `Upgrade at ${billing} (plans: ${portal}/pricing), then retry.`
          : shape === 'credits'
            ? `Top up credits at ${portal}/dashboard/settings/billing (personal keys) — ask an org admin if this key is organization-bound — or upgrade your plan at ${portal}/pricing. Run \`testsprite usage\` to check your current balance before the next run.`
            : '');
      expect(textResult.stderr).toBe(
        `Error: ${entry.message}\n${action}\n${entry.lines.map(line => `${line}\n`).join('')}requestId: req_billing\n`,
      );

      const jsonResult = run(shape, ['--output', 'json']);
      expect(jsonResult.error).toBeUndefined();
      expect(jsonResult.status).toBe(textResult.status);
      expect(jsonResult.stdout).toBe('');
      const error = (JSON.parse(jsonResult.stderr) as { error: Record<string, unknown> }).error;
      expect(error).toMatchObject({
        code: entry.code,
        message: entry.message,
        nextAction: action,
        requestId: 'req_billing',
        details: entry.details,
      });
      if (shape === 'rollout' || shape === 'mcp_origin') {
        expect(error).not.toHaveProperty('links');
        expect(textResult.stderr).not.toContain('/pricing');
      } else {
        expect(error.links).toEqual({ pricing: `${portal}/pricing`, billing });
      }
    },
  );
});
