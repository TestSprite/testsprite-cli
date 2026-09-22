import { describe, expect, it } from 'vitest';
import {
  describeConflict,
  dominantConflictReason,
  everyConflictIs,
  insufficientCreditsConflictError,
  isAllCreditsRefusal,
  summarizeConflicts,
} from './conflict-reason.js';
import { ApiError } from './errors.js';

describe('describeConflict', () => {
  it('names each cause instead of a blanket "already in flight"', () => {
    expect(describeConflict({ testId: 't', reason: 'mcp_view_only' })).toContain('view-only');
    expect(describeConflict({ testId: 't', reason: 'not_found' })).toContain('not found');
  });

  it('local_address surfaces the actionable message (falls back to a generic label)', () => {
    expect(
      describeConflict({ testId: 't', reason: 'local_address', message: 'Pass a public URL.' }),
    ).toBe('Pass a public URL.');
    expect(describeConflict({ testId: 't', reason: 'local_address' })).toContain('not runnable');
  });

  it('error surfaces its message or a generic fallback', () => {
    expect(describeConflict({ testId: 't', reason: 'error', message: 'boom' })).toBe('boom');
    expect(describeConflict({ testId: 't', reason: 'error' })).toBe('dispatch failed');
  });

  it('in_flight names the run id when present', () => {
    expect(describeConflict({ testId: 't', reason: 'in_flight', currentRunId: 'run-1' })).toBe(
      'already in flight (run run-1)',
    );
  });

  it('absent reason (legacy backend) renders as the historical "already in flight"', () => {
    expect(describeConflict({ testId: 't', currentRunId: 'run-1' })).toBe(
      'already in flight (run run-1)',
    );
    expect(describeConflict({ testId: 't' })).toBe('already in flight');
  });
});

describe('summarizeConflicts', () => {
  it('groups by reason with counts', () => {
    const summary = summarizeConflicts([
      { testId: 'a', reason: 'in_flight', currentRunId: 'r1' },
      { testId: 'b', reason: 'in_flight', currentRunId: 'r2' },
      { testId: 'c', reason: 'local_address' },
    ]);
    expect(summary).toContain('2 already in flight');
    expect(summary).toContain('1 environment not runnable');
  });

  it('treats an absent reason as in_flight (legacy)', () => {
    expect(summarizeConflicts([{ testId: 'a' }])).toBe('1 already in flight');
  });

  it('renders an unknown future reason as "not dispatched", not "undefined"', () => {
    // The loose wire schema admits reasons this CLI version does not know yet.
    const summary = summarizeConflicts([
      { testId: 'a', reason: 'some_future_reason' as never },
      { testId: 'b', reason: 'some_future_reason' as never },
    ]);
    expect(summary).toBe('2 not dispatched');
    expect(summary).not.toContain('undefined');
  });
});

describe('billing conflict reasons', () => {
  it('describeConflict names the billing refusal (server message preferred)', () => {
    expect(describeConflict({ testId: 't', reason: 'insufficient_credits' })).toBe(
      'insufficient credits',
    );
    expect(
      describeConflict({ testId: 't', reason: 'insufficient_credits', message: 'Need 2 more.' }),
    ).toBe('Need 2 more.');
    expect(describeConflict({ testId: 't', reason: 'billing_hold' })).toBe('billing hold');
    expect(
      describeConflict({ testId: 't', reason: 'billing_hold', message: 'Card declined.' }),
    ).toBe('Card declined.');
  });

  it('summarizeConflicts labels them', () => {
    const summary = summarizeConflicts([
      { testId: 'a', reason: 'insufficient_credits' },
      { testId: 'b', reason: 'billing_hold' },
      { testId: 'c' },
    ]);
    expect(summary).toBe('1 insufficient credits, 1 billing hold, 1 already in flight');
  });
});

describe('dominantConflictReason', () => {
  it('returns the most frequent reason (absent ⇒ in_flight), ties to the first seen', () => {
    expect(
      dominantConflictReason([
        { testId: 'a', reason: 'local_address' },
        { testId: 'b', reason: 'insufficient_credits' },
        { testId: 'c', reason: 'insufficient_credits' },
      ]),
    ).toBe('insufficient_credits');
    expect(dominantConflictReason([{ testId: 'a' }, { testId: 'b', reason: 'error' }])).toBe(
      'in_flight',
    );
    expect(dominantConflictReason([])).toBeUndefined();
  });

  it('passes an unknown future reason through as its raw string', () => {
    expect(dominantConflictReason([{ testId: 'a', reason: 'tunnel-required' as never }])).toBe(
      'tunnel-required',
    );
  });
});

describe('everyConflictIs / isAllCreditsRefusal', () => {
  it('requires a non-empty set where every entry carries the reason (absent never matches)', () => {
    expect(everyConflictIs([], 'insufficient_credits')).toBe(false);
    expect(
      everyConflictIs(
        [{ testId: 'a', reason: 'insufficient_credits' }, { testId: 'b' }],
        'insufficient_credits',
      ),
    ).toBe(false);
    expect(
      everyConflictIs(
        [
          { testId: 'a', reason: 'insufficient_credits' },
          { testId: 'b', reason: 'insufficient_credits' },
        ],
        'insufficient_credits',
      ),
    ).toBe(true);
  });

  it('isAllCreditsRefusal needs zero accepted AND zero deferred', () => {
    const credits = [{ testId: 'a', reason: 'insufficient_credits' as const }];
    expect(isAllCreditsRefusal({ accepted: [], deferred: [], conflicts: credits })).toBe(true);
    expect(isAllCreditsRefusal({ accepted: [{}], deferred: [], conflicts: credits })).toBe(false);
    expect(isAllCreditsRefusal({ accepted: [], deferred: [{}], conflicts: credits })).toBe(false);
    expect(
      isAllCreditsRefusal({
        accepted: [],
        deferred: [],
        conflicts: [{ testId: 'a', reason: 'billing_hold' }],
      }),
    ).toBe(false);
  });
});

describe('insufficientCreditsConflictError', () => {
  it('is the single-run INSUFFICIENT_CREDITS shape: code, exit 12, billing nextAction', () => {
    const err = insufficientCreditsConflictError(
      [
        { testId: 'a', reason: 'insufficient_credits' },
        { testId: 'b', reason: 'insufficient_credits' },
      ],
      'https://api.testsprite.com',
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('INSUFFICIENT_CREDITS');
    expect(err.exitCode).toBe(12);
    expect(err.message).toBe('Insufficient credits — nothing was queued (2 tests refused).');
    expect(err.nextAction).toContain('dashboard/settings/billing');
    expect(err.nextAction).toContain('testsprite usage');
    expect(err.requestId).toBe('local');
    expect(err.details).toEqual({ reason: 'insufficient_credits', conflicts: ['a', 'b'] });
  });

  it('prefers the server message carried on the conflicts', () => {
    const err = insufficientCreditsConflictError([
      { testId: 'a', reason: 'insufficient_credits', message: '  ' },
      { testId: 'b', reason: 'insufficient_credits', message: 'Insufficient credits: need 1.' },
    ]);
    expect(err.message).toBe('Insufficient credits: need 1.');
    // Unknown API host → route-only hint (no fabricated domain).
    expect(err.nextAction).toContain('/dashboard/settings/billing');
  });
});
