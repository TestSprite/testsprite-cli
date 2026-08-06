/**
 * Shared V3-routing text surfaces for `auth status` and `doctor`.
 *
 * `v3Enabled` on the `/me` response is the authoritative routing bit. When it
 * is on, some commands behave differently while the V3 gaps stay open — the
 * advisory names them. Copy lives here so both commands stay in sync.
 */

/** One-word routing label for the text card. */
export function routingLabel(v3Enabled: boolean): 'v3' | 'v2' {
  return v3Enabled ? 'v3' : 'v2';
}

/**
 * Consolidated advisory (stderr) emitted when V3 routing is on.
 *
 * Only genuinely-open gaps belong here. Two originally-listed items have
 * shipped and were removed: `test cancel` works on V3 runs, and `test delete`
 * mirrors into Postgres instead of leaving a runnable, billable row behind.
 * An advisory that warns about fixed behavior is worse than none — it teaches
 * users to distrust the whole block, and it sends them chasing a failure that
 * cannot happen.
 */
export const V3_ROUTING_ADVISORY: string[] = [
  '[advisory] V3 routing is on for this account. While these gaps are open:',
  '  - `--target-url` is ignored on frontend runs (the run uses the project environment)',
  '  - a frontend rerun replays the run it was pointed at, not necessarily the latest saved code',
];

/** Write the advisory to a stderr sink, one line per call. */
export function emitV3RoutingAdvisory(stderr: (line: string) => void): void {
  for (const line of V3_ROUTING_ADVISORY) stderr(line);
}
