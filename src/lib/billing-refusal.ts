import { resolvePortalBase } from './facade.js';
import type { ApiError } from './errors.js';

/**
 * The workspace gate's three refusals, named as the backend's `GateRefusal`
 * names them — the one set the CLI, MCP, portal and agent all share.
 */
export type GateRefusal = 'paused' | 'not_entitled' | 'limit_exceeded';

export interface BillingRefusal {
  /** A gate refusal, or a credit shortfall (reported separately as INSUFFICIENT_CREDITS). */
  reason: GateRefusal | 'insufficient_credits';
  links: { pricing: string; billing: string };
  nextAction: string;
  lines: string[];
}

type BillingInput = Pick<ApiError, 'code' | 'message' | 'nextAction' | 'details'> & {
  apiUrl?: string;
  serverNextAction?: string;
};

function hasPlaceholder(url: URL): boolean {
  return (
    /^(undefined|null)$/i.test(url.hostname) || /\/(?:undefined|null)(?:\/|$)/i.test(url.pathname)
  );
}

function portalUrlIn(text: string, billingOnly = false): string | undefined {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    const candidate = match[0].replace(/[),.;!?]+$/, '');
    try {
      const url = new URL(candidate);
      if (hasPlaceholder(url)) continue;
      if (
        url.pathname.endsWith('/settings/billing') ||
        (!billingOnly && url.pathname === '/pricing')
      ) {
        return candidate;
      }
    } catch {
      // Ignore malformed server text and use the next available source.
    }
  }
  return undefined;
}

/**
 * The `TESTSPRITE_PORTAL_URL` origin, when the override is set and valid.
 * `resolvePortalBase` checks this same env var first and ignores its `apiUrl`
 * argument once it finds it set, so any argument resolves it — `''` keeps the
 * intent explicit at each call site (there is no API URL to fall back to).
 */
function overridePortalBase(): string | undefined {
  if (!process.env.TESTSPRITE_PORTAL_URL?.trim()) return undefined;
  const resolved = resolvePortalBase('');
  return resolved && !hasPlaceholder(new URL(resolved)) ? resolved : undefined;
}

function portalBase(input: BillingInput): string | undefined {
  const override = overridePortalBase();
  if (override) return override;
  const billingUrl = typeof input.details.billingUrl === 'string' ? input.details.billingUrl : '';
  const serverUrl = portalUrlIn(
    [billingUrl, input.serverNextAction ?? input.nextAction, input.message].join(' '),
  );
  if (serverUrl) return new URL(serverUrl).origin;
  return input.apiUrl ? resolvePortalBase(input.apiUrl) : undefined;
}

/**
 * Rebase an absolute server-supplied billing URL onto the operator's
 * `TESTSPRITE_PORTAL_URL` override, keeping the path (and query, if any) —
 * the server knows its own routes, but the override says where the CLI's
 * links should actually point. Without this, an override set for `pricing`
 * (always synthesized from `portalBase`) silently didn't apply to a
 * server-found `billing` URL, sending the two links to different hosts.
 */
function rebaseOntoOverride(url: string): string {
  const override = overridePortalBase();
  if (!override) return url;
  const parsed = new URL(url);
  return `${override}${parsed.pathname}${parsed.search}`;
}

/** Shared pricing/billing destinations for refusals and history-window notes. */
export function resolveBillingLinks(input: {
  apiUrl?: string;
  billingUrl?: string;
  orgId?: unknown;
  nextAction?: string;
  message?: string;
}): { pricing: string; billing: string } {
  const base = portalBase({
    apiUrl: input.apiUrl,
    details: { billingUrl: input.billingUrl },
    nextAction: input.nextAction ?? '',
    message: input.message ?? '',
    code: 'FEATURE_GATED',
  });
  const pricing = base ? `${base}/pricing` : '/pricing';
  const foundBilling =
    portalUrlIn(input.billingUrl ?? '', true) ??
    portalUrlIn([input.nextAction, input.message].join(' '), true);
  const orgId = safeOrgId(input.orgId);
  const billing =
    (foundBilling !== undefined ? rebaseOntoOverride(foundBilling) : undefined) ??
    (base
      ? `${base}${orgId ? `/dashboard-v3/o/${orgId}` : '/dashboard'}/settings/billing`
      : orgId
        ? `/dashboard-v3/o/${orgId}/settings/billing`
        : '/dashboard/settings/billing');
  return { pricing, billing };
}

/** One `  label: value` line, aligned like the CLI's other key/value output. */
function fact(label: string, value: string): string {
  return `  ${`${label}:`.padEnd(11)}${value}`;
}

function safeOrgId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.trim() !== '' &&
    !/^(undefined|null)$/i.test(value.trim()) &&
    !/[/?#]/.test(value)
    ? encodeURIComponent(value)
    : undefined;
}

/**
 * `details.reason` spellings of the three gate refusals: the gate's own names,
 * plus the deprecated `billing_hold` / `plan` / `plan_limit` that older
 * backends' CLI envelope and gate body still send. The CLI reads both and
 * only ever writes the gate's names.
 */
const GATE_REFUSAL_BY_REASON = new Map<string, GateRefusal>([
  ['paused', 'paused'],
  ['billing_hold', 'paused'],
  ['not_entitled', 'not_entitled'],
  ['plan', 'not_entitled'],
  ['limit_exceeded', 'limit_exceeded'],
  ['plan_limit', 'limit_exceeded'],
]);

/**
 * Which gate refusal a FEATURE_GATED `details.reason` is. An absent or empty
 * reason is an older backend that never sent one (historically a plan
 * exclusion). Any other value — `rollout`, the MCP view-only mirror's
 * `mcp_origin`, or one this CLI doesn't know yet — is not a billing refusal:
 * upgrading does nothing for it, so it gets no links and no fallback advice.
 */
export function gateRefusalOf(reason: unknown): GateRefusal | undefined {
  if (reason === undefined || reason === '') return 'not_entitled';
  return typeof reason === 'string' ? GATE_REFUSAL_BY_REASON.get(reason) : undefined;
}

/** True for a paused-workspace reason, including the deprecated `billing_hold`. */
export function isPausedReason(reason: unknown): boolean {
  return reason === 'paused' || reason === 'billing_hold';
}

export function classifyBillingRefusal(input: BillingInput): BillingRefusal | undefined {
  let reason: BillingRefusal['reason'];
  if (input.code === 'INSUFFICIENT_CREDITS') {
    reason = 'insufficient_credits';
  } else if (input.code === 'FEATURE_GATED') {
    const refusal = gateRefusalOf(input.details.reason);
    if (!refusal) return undefined;
    reason = refusal;
  } else {
    return undefined;
  }
  const { pricing, billing } = resolveBillingLinks({
    apiUrl: input.apiUrl,
    billingUrl: typeof input.details.billingUrl === 'string' ? input.details.billingUrl : undefined,
    orgId: input.details.orgId,
    nextAction: input.serverNextAction ?? input.nextAction,
    message: input.message,
  });
  // The server's message says why (which feature, which limit, why the
  // workspace is paused) and its nextAction says what to do. These fallbacks
  // only cover a response that arrived without a nextAction, and follow the
  // backend's own CLI wording rather than guessing a cause.
  let nextAction = input.nextAction;
  if (!nextAction) {
    switch (reason) {
      case 'not_entitled':
        nextAction = `Upgrade at ${billing} (plans: ${pricing}), then retry.`;
        break;
      case 'limit_exceeded':
        nextAction = `Delete one and retry, or upgrade at ${billing} for a higher limit.`;
        break;
      case 'paused':
        nextAction = `See ${billing} to resume this workspace, then retry.`;
        break;
    }
  }
  // Add only the links the printed message and nextAction don't already carry.
  const printed = `${input.message}\n${nextAction}`;
  const lines: string[] = [];
  if (!printed.includes(pricing)) lines.push(fact('upgrade', pricing));
  if (!printed.includes(billing)) lines.push(fact('billing', billing));
  return { reason, links: { pricing, billing }, nextAction, lines };
}
