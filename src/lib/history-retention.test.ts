import { describe, expect, it } from 'vitest';
import { historyRetentionNote } from './history-retention.js';

const billingUrl = 'https://server.example/dashboard-v3/o/org-1/settings/billing';

describe('historyRetentionNote', () => {
  it('names the plan window for a paid or free tier', () => {
    expect(
      historyRetentionNote(
        { tier: 'Standard', retentionDays: 90, hiddenCount: 1, billingUrl },
        'https://unknown-api.example',
      )?.split('\n')[0],
    ).toBe('1 older run hidden — the Standard plan keeps 90 days of run history.');
  });

  it('explains a paused workspace instead of a zero-day plan window', () => {
    const note = historyRetentionNote(
      { tier: 'Paused', retentionDays: 0, hiddenCount: 3, billingUrl },
      'https://unknown-api.example',
    );
    expect(note?.split('\n')[0]).toBe(
      '3 runs hidden — this workspace is on the Paused plan, which keeps no run history.',
    );
    expect(note).not.toContain('0 days');
    expect(note).toContain(`  billing:   ${billingUrl}`);
  });
});
