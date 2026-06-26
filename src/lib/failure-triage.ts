/**
 * Client-side failure triage — groups per-test failure summaries into
 * root-cause clusters using deterministic heuristics over existing
 * M2.1 analysis fields. No LLM calls; the backend remains the source
 * of truth for per-test hypotheses.
 *
 * @see `runFailureTriage` in `src/commands/test.ts`
 */

/** Failure kinds that usually indicate a shared environment outage. */
export const ENV_WIDE_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'infra',
  'network',
  'network_timeout',
  'routing_404',
]);

export type FailureTriageGroupReason = 'fix_target' | 'failure_kind' | 'hypothesis' | 'singleton';

export interface FailureTriageMember {
  testId: string;
  testName: string;
  testType: 'frontend' | 'backend';
  updatedAt: string;
  status: string;
  failureKind: string | null;
  snapshotId: string;
  rootCauseHypothesis: string | null;
  recommendedFixTarget: {
    kind: string;
    reference: string | null;
    rationale: string | null;
  } | null;
}

export interface FailureTriageCluster {
  clusterId: string;
  label: string;
  groupKey: string;
  groupReason: FailureTriageGroupReason;
  failureKind: string | null;
  representativeTestId: string;
  memberTestIds: string[];
  members: FailureTriageMember[];
  canonicalRootCause: string | null;
  confidence: number;
  fixPriority: number;
}

export interface FailureTriageResult {
  projectId: string;
  clusters: FailureTriageCluster[];
  summary: {
    totalFailed: number;
    clusterCount: number;
    skipped: number;
  };
  skipped?: Array<{ testId: string; reason: string }>;
}

export interface FailureTriageInput {
  testId: string;
  testName: string;
  testType: 'frontend' | 'backend';
  updatedAt: string;
  summary: {
    status: string;
    failureKind: string | null;
    snapshotId: string;
    rootCauseHypothesis: string | null;
    recommendedFixTarget: {
      kind: string;
      reference: string | null;
      rationale: string | null;
    } | null;
  };
}

export interface GroupKeyResult {
  groupKey: string;
  groupReason: FailureTriageGroupReason;
}

/**
 * Normalize a root-cause hypothesis for coarse grouping. Collapses
 * whitespace, lowercases, and caps length so minor punctuation
 * differences don't split clusters.
 */
export function normalizeHypothesis(hypothesis: string | null): string | null {
  if (hypothesis === null || hypothesis.trim() === '') return null;
  const collapsed = hypothesis.trim().replace(/\s+/g, ' ').toLowerCase();
  return collapsed.length > 100 ? collapsed.slice(0, 100) : collapsed;
}

/**
 * Derive a deterministic group key for one failed test's summary.
 * Priority: shared fix target → env-wide failure kind → hypothesis prefix → singleton.
 */
export function computeGroupKey(input: FailureTriageInput): GroupKeyResult {
  const ref = input.summary.recommendedFixTarget?.reference?.trim();
  if (ref) {
    return { groupKey: `ref:${ref}`, groupReason: 'fix_target' };
  }

  const kind = input.summary.failureKind;
  if (kind !== null && ENV_WIDE_FAILURE_KINDS.has(kind)) {
    return { groupKey: `kind:${kind}`, groupReason: 'failure_kind' };
  }

  const hyp = normalizeHypothesis(input.summary.rootCauseHypothesis);
  if (hyp) {
    return { groupKey: `hyp:${hyp}`, groupReason: 'hypothesis' };
  }

  return { groupKey: `singleton:${input.testId}`, groupReason: 'singleton' };
}

/**
 * Pick the representative test for a cluster. Prefers the member with the
 * richest analysis (non-null hypothesis), then the most recently updated,
 * then lexicographic testId for determinism.
 */
export function pickRepresentativeTestId(members: FailureTriageMember[]): string {
  const sorted = [...members].sort((a, b) => {
    const aHyp = a.rootCauseHypothesis !== null ? 1 : 0;
    const bHyp = b.rootCauseHypothesis !== null ? 1 : 0;
    if (bHyp !== aHyp) return bHyp - aHyp;

    const aTime = new Date(a.updatedAt).getTime();
    const bTime = new Date(b.updatedAt).getTime();
    if (bTime !== aTime) return bTime - aTime;

    return a.testId.localeCompare(b.testId);
  });
  return sorted[0]!.testId;
}

/**
 * Confidence score for a cluster based on grouping signal strength and size.
 */
export function computeClusterConfidence(
  groupReason: FailureTriageGroupReason,
  memberCount: number,
): number {
  if (memberCount < 1) return 0;
  const multi = memberCount >= 2;

  switch (groupReason) {
    case 'fix_target':
      return multi ? 0.92 : 0.7;
    case 'failure_kind':
      return multi ? 0.88 : 0.65;
    case 'hypothesis':
      return multi ? 0.78 : 0.55;
    case 'singleton':
      return 0.4;
    default:
      return 0.4;
  }
}

/**
 * Lower fixPriority means "fix this cluster first".
 */
export function computeFixPriority(
  groupReason: FailureTriageGroupReason,
  failureKind: string | null,
  memberCount: number,
): number {
  if (failureKind === 'infra' || failureKind === 'network' || failureKind === 'network_timeout') {
    return 1;
  }
  if (failureKind === 'routing_404') {
    return 2;
  }
  if (groupReason === 'fix_target' && memberCount >= 2) {
    return 3;
  }
  if (groupReason === 'failure_kind' && memberCount >= 2) {
    return 4;
  }
  if (groupReason === 'hypothesis' && memberCount >= 2) {
    return 5;
  }
  if (groupReason === 'singleton') {
    return 10;
  }
  return 6;
}

function buildClusterLabel(
  groupReason: FailureTriageGroupReason,
  members: FailureTriageMember[],
  failureKind: string | null,
): string {
  const rep = members.find(m => m.recommendedFixTarget?.reference) ?? members[0]!;
  const ref = rep.recommendedFixTarget?.reference;

  if (groupReason === 'fix_target' && ref) {
    return `Shared fix target: ${ref}`;
  }
  if (groupReason === 'failure_kind' && failureKind !== null) {
    return `Environment issue (${failureKind})`;
  }
  if (groupReason === 'hypothesis') {
    const hyp = rep.rootCauseHypothesis;
    if (hyp) {
      return hyp.length > 80 ? `${hyp.slice(0, 77)}…` : hyp;
    }
  }
  return `Independent failure: ${rep.testName}`;
}

function slugifyClusterId(groupKey: string): string {
  const slug = groupKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'unknown';
}

function toMember(input: FailureTriageInput): FailureTriageMember {
  return {
    testId: input.testId,
    testName: input.testName,
    testType: input.testType,
    updatedAt: input.updatedAt,
    status: input.summary.status,
    failureKind: input.summary.failureKind,
    snapshotId: input.summary.snapshotId,
    rootCauseHypothesis: input.summary.rootCauseHypothesis,
    recommendedFixTarget: input.summary.recommendedFixTarget,
  };
}

/**
 * Group triage inputs into clusters. Deterministic: same inputs always
 * produce the same cluster ids and representative tests.
 */
export function buildFailureClusters(
  projectId: string,
  inputs: FailureTriageInput[],
): FailureTriageResult {
  const groups = new Map<
    string,
    { reason: FailureTriageGroupReason; members: FailureTriageMember[] }
  >();

  for (const input of inputs) {
    const { groupKey, groupReason } = computeGroupKey(input);
    const member = toMember(input);
    const existing = groups.get(groupKey);
    if (existing) {
      existing.members.push(member);
    } else {
      groups.set(groupKey, { reason: groupReason, members: [member] });
    }
  }

  const clusters: FailureTriageCluster[] = [];
  for (const [groupKey, { reason, members }] of groups) {
    const representativeTestId = pickRepresentativeTestId(members);
    const rep = members.find(m => m.testId === representativeTestId) ?? members[0]!;
    const memberCount = members.length;
    const failureKind = rep.failureKind;

    clusters.push({
      clusterId: `cluster_${slugifyClusterId(groupKey)}`,
      label: buildClusterLabel(reason, members, failureKind),
      groupKey,
      groupReason: reason,
      failureKind,
      representativeTestId,
      memberTestIds: members.map(m => m.testId).sort(),
      members: [...members].sort((a, b) => a.testId.localeCompare(b.testId)),
      canonicalRootCause: rep.rootCauseHypothesis,
      confidence: computeClusterConfidence(reason, memberCount),
      fixPriority: computeFixPriority(reason, failureKind, memberCount),
    });
  }

  clusters.sort((a, b) => {
    if (a.fixPriority !== b.fixPriority) return a.fixPriority - b.fixPriority;
    if (b.memberTestIds.length !== a.memberTestIds.length) {
      return b.memberTestIds.length - a.memberTestIds.length;
    }
    return a.clusterId.localeCompare(b.clusterId);
  });

  return {
    projectId,
    clusters,
    summary: {
      totalFailed: inputs.length,
      clusterCount: clusters.length,
      skipped: 0,
    },
  };
}

/**
 * Text renderer for `test failure triage` output.
 */
export function renderFailureTriageText(result: FailureTriageResult): string {
  const lines: string[] = [];
  lines.push(`projectId:    ${result.projectId}`);
  lines.push(
    `summary:      ${result.summary.totalFailed} failed test(s) → ${result.summary.clusterCount} cluster(s)`,
  );
  if (result.summary.skipped > 0) {
    lines.push(`skipped:      ${result.summary.skipped} test(s) could not be summarized`);
  }
  lines.push('');

  if (result.clusters.length === 0) {
    lines.push('No failed tests found — nothing to triage.');
    return lines.join('\n');
  }

  for (const [idx, cluster] of result.clusters.entries()) {
    lines.push(
      `[${idx + 1}] ${cluster.label} (confidence ${(cluster.confidence * 100).toFixed(0)}%, fix priority ${cluster.fixPriority})`,
    );
    lines.push(`    clusterId:       ${cluster.clusterId}`);
    lines.push(`    groupReason:     ${cluster.groupReason}`);
    if (cluster.failureKind !== null) lines.push(`    failureKind:     ${cluster.failureKind}`);
    lines.push(`    representative:  ${cluster.representativeTestId}`);
    lines.push(
      `    affected (${cluster.memberTestIds.length}): ${cluster.memberTestIds.join(', ')}`,
    );
    if (cluster.canonicalRootCause !== null) {
      const hyp =
        cluster.canonicalRootCause.length > 120
          ? `${cluster.canonicalRootCause.slice(0, 117)}…`
          : cluster.canonicalRootCause;
      lines.push(`    rootCause:       ${hyp}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
