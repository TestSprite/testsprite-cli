import { describe, expect, it } from 'vitest';
import {
  buildFailureClusters,
  computeClusterConfidence,
  computeFixPriority,
  computeGroupKey,
  normalizeHypothesis,
  pickRepresentativeTestId,
  type FailureTriageInput,
  type FailureTriageMember,
} from './failure-triage.js';

function makeInput(overrides: Partial<FailureTriageInput> & { testId: string }): FailureTriageInput {
  return {
    testName: overrides.testName ?? `Test ${overrides.testId}`,
    testType: overrides.testType ?? 'frontend',
    updatedAt: overrides.updatedAt ?? '2026-06-26T12:00:00.000Z',
    summary: overrides.summary ?? {
      status: 'failed',
      failureKind: 'assertion',
      snapshotId: `snap_${overrides.testId}`,
      rootCauseHypothesis: 'Submit button is disabled.',
      recommendedFixTarget: null,
    },
    ...overrides,
  };
}

describe('normalizeHypothesis', () => {
  it('collapses whitespace and lowercases', () => {
    expect(normalizeHypothesis('  Auth   Token  Expired  ')).toBe('auth token expired');
  });

  it('returns null for empty input', () => {
    expect(normalizeHypothesis(null)).toBeNull();
    expect(normalizeHypothesis('   ')).toBeNull();
  });
});

describe('computeGroupKey', () => {
  it('groups by fix target reference first', () => {
    const key = computeGroupKey(
      makeInput({
        testId: 't1',
        summary: {
          status: 'failed',
          failureKind: 'assertion',
          snapshotId: 'snap',
          rootCauseHypothesis: 'Different text',
          recommendedFixTarget: {
            kind: 'code',
            reference: 'src/auth.ts:42',
            rationale: 'Fix auth',
          },
        },
      }),
    );
    expect(key).toEqual({ groupKey: 'ref:src/auth.ts:42', groupReason: 'fix_target' });
  });

  it('groups env-wide failure kinds', () => {
    const key = computeGroupKey(
      makeInput({
        testId: 't2',
        summary: {
          status: 'failed',
          failureKind: 'network_timeout',
          snapshotId: 'snap',
          rootCauseHypothesis: null,
          recommendedFixTarget: null,
        },
      }),
    );
    expect(key).toEqual({ groupKey: 'kind:network_timeout', groupReason: 'failure_kind' });
  });

  it('groups by normalized hypothesis when no ref or env kind', () => {
    const key = computeGroupKey(
      makeInput({
        testId: 't3',
        summary: {
          status: 'failed',
          failureKind: 'assertion',
          snapshotId: 'snap',
          rootCauseHypothesis: 'Login form validation failed.',
          recommendedFixTarget: null,
        },
      }),
    );
    expect(key.groupReason).toBe('hypothesis');
    expect(key.groupKey).toBe('hyp:login form validation failed.');
  });

  it('falls back to singleton when no grouping signal', () => {
    const key = computeGroupKey(
      makeInput({
        testId: 't4',
        summary: {
          status: 'failed',
          failureKind: 'unknown',
          snapshotId: 'snap',
          rootCauseHypothesis: null,
          recommendedFixTarget: null,
        },
      }),
    );
    expect(key).toEqual({ groupKey: 'singleton:t4', groupReason: 'singleton' });
  });
});

describe('pickRepresentativeTestId', () => {
  const members: FailureTriageMember[] = [
    {
      testId: 't_old',
      testName: 'Old',
      testType: 'backend',
      updatedAt: '2026-06-25T00:00:00.000Z',
      status: 'failed',
      failureKind: 'assertion',
      snapshotId: 'snap1',
      rootCauseHypothesis: null,
      recommendedFixTarget: null,
    },
    {
      testId: 't_rich',
      testName: 'Rich',
      testType: 'backend',
      updatedAt: '2026-06-24T00:00:00.000Z',
      status: 'failed',
      failureKind: 'assertion',
      snapshotId: 'snap2',
      rootCauseHypothesis: 'Detailed root cause hypothesis.',
      recommendedFixTarget: null,
    },
  ];

  it('prefers member with root-cause hypothesis', () => {
    expect(pickRepresentativeTestId(members)).toBe('t_rich');
  });
});

describe('computeClusterConfidence', () => {
  it('scores multi-member fix_target clusters highest', () => {
    expect(computeClusterConfidence('fix_target', 3)).toBe(0.92);
    expect(computeClusterConfidence('singleton', 1)).toBe(0.4);
  });
});

describe('computeFixPriority', () => {
  it('prioritizes infra failures first', () => {
    expect(computeFixPriority('failure_kind', 'infra', 5)).toBe(1);
    expect(computeFixPriority('singleton', 'assertion', 1)).toBe(10);
  });
});

describe('buildFailureClusters', () => {
  it('merges tests sharing the same fix target into one cluster', () => {
    const sharedRef = 'src/components/CheckoutForm.tsx:412';
    const result = buildFailureClusters('proj_abc', [
      makeInput({
        testId: 'test_a',
        summary: {
          status: 'failed',
          failureKind: 'assertion',
          snapshotId: 'snap_a',
          rootCauseHypothesis: 'Button disabled.',
          recommendedFixTarget: { kind: 'code', reference: sharedRef, rationale: 'Fix form' },
        },
      }),
      makeInput({
        testId: 'test_b',
        summary: {
          status: 'failed',
          failureKind: 'assertion',
          snapshotId: 'snap_b',
          rootCauseHypothesis: 'Cannot submit checkout.',
          recommendedFixTarget: { kind: 'code', reference: sharedRef, rationale: 'Same file' },
        },
      }),
      makeInput({
        testId: 'test_c',
        summary: {
          status: 'failed',
          failureKind: 'network_timeout',
          snapshotId: 'snap_c',
          rootCauseHypothesis: null,
          recommendedFixTarget: null,
        },
      }),
    ]);

    expect(result.summary).toEqual({ totalFailed: 3, clusterCount: 2, skipped: 0 });
    expect(result.clusters).toHaveLength(2);

    const envCluster = result.clusters.find(c => c.groupReason === 'failure_kind');
    expect(envCluster?.memberTestIds).toEqual(['test_c']);
    expect(envCluster?.fixPriority).toBe(1);

    const codeCluster = result.clusters.find(c => c.groupReason === 'fix_target');
    expect(codeCluster?.memberTestIds).toEqual(['test_a', 'test_b']);
    expect(codeCluster?.representativeTestId).toMatch(/^test_/);
    expect(codeCluster?.confidence).toBe(0.92);
  });

  it('returns empty clusters when no inputs', () => {
    const result = buildFailureClusters('proj_empty', []);
    expect(result.clusters).toEqual([]);
    expect(result.summary.totalFailed).toBe(0);
  });
});