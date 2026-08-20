/**
 * Shared V3-routing text surfaces.
 *
 * `V3_ROUTING_ADVISORY`/`emitV3RoutingAdvisory` back `auth status` and
 * `doctor`: `v3Enabled` on the `/me` response is the authoritative routing
 * bit, and when it is on, some commands behave differently while the V3
 * gaps stay open — the advisory names them. Copy lives here so both
 * commands stay in sync.
 *
 * `targetUrlAdvisoryText`/`emitTargetUrlMismatchAdvisory` back the
 * `--target-url` point-of-use advisory in `commands/test.ts` — a different,
 * response-driven mechanism (see its own docblock below) that does not
 * depend on `v3Enabled` at all.
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

/**
 * Point-of-use advisory for `test run --target-url`, redesigned to be
 * response-driven rather than assumption-driven. The original
 * version probed `GET /me` for `v3Enabled` and warned on that ASSUMPTION —
 * but the backend is the ground truth here, not a proxy for it. V3
 * deliberately returns `targetUrl: ''` rather than echoing an override it
 * did not apply ("so the response doesn't claim a target we didn't use"),
 * while V2 echoes the real applied value. So the advisory now fires purely
 * from comparing what the caller asked for against what the trigger
 * response reports — it self-corrects the day the backend applies the
 * override, needs no `v3Enabled` lookup (and so no extra `/me` round trip,
 * no `X-CLI-Command` tagging machinery), and is exact rather than inferred.
 *
 * Deliberately type-agnostic in its wording (no "on the V3 path" claim):
 * a mismatch is reported purely from the observed response, regardless of
 * why the backend didn't apply the override.
 */
export function targetUrlAdvisoryText(requested: string, applied: string): string {
  const appliedClause =
    applied.length > 0
      ? `the run will use ${applied} instead`
      : 'the run reports no target URL for it';
  return (
    `[advisory] --target-url ${requested} was not applied to this run — ${appliedClause}. ` +
    `The run used its own configured environment.`
  );
}

/**
 * Compare the requested `--target-url` against what the trigger response
 * reports and write the advisory when they differ. No-op when they match
 * (the override was applied, or the caller didn't supply one — callers are
 * expected to gate the `requested` argument on `opts.targetUrl !== undefined`
 * themselves so this stays a pure comparison).
 */
export function emitTargetUrlMismatchAdvisory(
  stderr: (line: string) => void,
  requested: string,
  applied: string,
): void {
  if (applied === requested) return;
  stderr(targetUrlAdvisoryText(requested, applied));
}
