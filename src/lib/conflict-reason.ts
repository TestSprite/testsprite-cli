/**
 * Why a case landed in a run response's `conflicts[]` instead of dispatching.
 * The backend (`batchRunFresh` / `dispatchTestListGroups`) tags each conflict so
 * the CLI stops rendering every non-dispatch as "already in flight" — which is
 * wrong for a view-only mirror, an un-runnable environment, or an unknown id.
 *
 * Absent ⇒ a legacy / pre-discriminator backend: treated as `in_flight` (the
 * historical rendering) for backward compatibility.
 */
export type ConflictReason =
  'in_flight' | 'mcp_view_only' | 'local_address' | 'not_found' | 'error';

/** A conflict entry on a run response. `message` carries actionable detail for
 * `local_address` / `error` (the backend env guard's nextAction). */
export interface RunConflict {
  testId: string;
  currentRunId?: string;
  reason?: ConflictReason;
  message?: string;
}

/**
 * Short human label for a conflict's cause — the reason a case did NOT dispatch.
 * Absent reason renders as the legacy "already in flight" so an old backend's
 * bare `{testId, currentRunId?}` conflicts read exactly as they did before.
 */
export function describeConflict(c: RunConflict): string {
  switch (c.reason) {
    case 'mcp_view_only':
      return 'project is view-only (MCP-mirrored) — not runnable';
    case 'local_address':
      return c.message || 'environment not runnable (local/private/unresolvable URL)';
    case 'not_found':
      return 'not found in this workspace';
    case 'error':
      return c.message || 'dispatch failed';
    case 'in_flight':
    default:
      return c.currentRunId ? `already in flight (run ${c.currentRunId})` : 'already in flight';
  }
}

/**
 * One-line summary of a conflict set grouped by reason, e.g.
 * `2 already in flight, 1 environment not runnable`. Used where a single line
 * must stand in for the whole `conflicts[]` (exit-message / advisory).
 */
export function summarizeConflicts(conflicts: readonly RunConflict[]): string {
  const labels: Record<ConflictReason, string> = {
    in_flight: 'already in flight',
    mcp_view_only: 'view-only (MCP) project',
    local_address: 'environment not runnable',
    not_found: 'not found',
    error: 'dispatch error',
  };
  const counts = new Map<string, number>();
  for (const c of conflicts) {
    const reason: string = c.reason ?? 'in_flight';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  // A future/unknown reason the loose wire schema admits (describeConflict covers
  // it via its default arm) must not render as "N undefined" here.
  return [...counts.entries()]
    .map(([reason, n]) => `${n} ${labels[reason as ConflictReason] ?? 'not dispatched'}`)
    .join(', ');
}
