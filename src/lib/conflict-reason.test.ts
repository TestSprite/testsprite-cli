import { describe, expect, it } from 'vitest';
import { describeConflict, summarizeConflicts } from './conflict-reason.js';

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
