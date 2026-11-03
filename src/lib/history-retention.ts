import { resolveBillingLinks } from './billing-refusal.js';

export interface HistoryRetentionMeta {
  tier?: string;
  retentionDays?: number | null;
  hiddenCount?: number;
  billingUrl?: string;
}

/** Returns no text for older backends, unlimited history, or an unhidden page. */
export function historyRetentionNote(
  meta: HistoryRetentionMeta | undefined,
  apiUrl: string,
  derived = false,
): string | undefined {
  if (!meta || !Number.isFinite(meta.hiddenCount) || !meta.hiddenCount || meta.hiddenCount <= 0) {
    return undefined;
  }
  if (meta.retentionDays == null || !Number.isFinite(meta.retentionDays)) return undefined;
  const { pricing, billing } = resolveBillingLinks({
    apiUrl,
    billingUrl: meta.billingUrl,
  });
  const count = meta.hiddenCount;
  const runs = `${count} run${count === 1 ? '' : 's'}`;
  const plan = meta.tier ? `the ${meta.tier} plan` : 'your plan';
  const prefix = derived ? "This suggestion only covers the plan's visible history. " : '';
  // Paused is a plan tier whose window is zero days: every run is hidden, not
  // just older ones, and "keeps 0 days" would read oddly.
  const reason =
    meta.tier === 'Paused' || meta.retentionDays === 0
      ? `${runs} hidden — this workspace is on the Paused plan, which keeps no run history.`
      : `${count} older run${count === 1 ? '' : 's'} hidden — ${plan} keeps ${meta.retentionDays} day${meta.retentionDays === 1 ? '' : 's'} of run history.`;
  return `${prefix}${reason}\n` + `  upgrade:   ${pricing}\n` + `  billing:   ${billing}`;
}
