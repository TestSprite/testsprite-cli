import { resolveBillingLinks } from './billing-refusal.js';

export interface HistoryRetentionMeta {
  tier?: string;
  retentionDays?: number | null;
  hiddenCount?: number;
  billingUrl?: string;
}

/**
 * Returns no text for older backends, unlimited history, or an unhidden page.
 * `noun` names what was hidden, in the unit of the rows the note sits under:
 * runs by default, results for one test's history.
 */
export function historyRetentionNote(
  meta: HistoryRetentionMeta | undefined,
  apiUrl: string,
  noun: 'run' | 'result' = 'run',
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
  const nouns = `${noun}${count === 1 ? '' : 's'}`;
  const plan = meta.tier ? `the ${meta.tier} plan` : 'your plan';
  // Paused is a plan tier whose window is zero days: every run is hidden, not
  // just older ones, and "keeps 0 days" would read oddly.
  const reason =
    meta.tier === 'Paused' || meta.retentionDays === 0
      ? `${count} ${nouns} hidden — this workspace is on the Paused plan, which keeps no run history.`
      : `${count} older ${nouns} hidden — ${plan} keeps ${meta.retentionDays} day${meta.retentionDays === 1 ? '' : 's'} of run history.`;
  return `${reason}\n` + `  upgrade:   ${pricing}\n` + `  billing:   ${billing}`;
}
