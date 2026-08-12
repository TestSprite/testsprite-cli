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

/**
 * Point-of-use advisory for `test run --target-url` on a V3-routed caller
 * (DEV-749). `V3_ROUTING_ADVISORY` above already names this gap once, in
 * the account-level summary `auth status`/`doctor` print — this is the
 * SAME gap surfaced at the moment the caller actually hits it, matching
 * the existing backend-test `--target-url` advisory in `runCreate`
 * (`commands/test.ts`): unconditional across every `--output` mode. That
 * advisory's family is "a flag the caller just passed has a structural
 * consequence" — `--output json` is precisely the unattended/CI case that
 * needs the warning most, not the case to withhold it from (unlike the
 * routing-advisory family above, which a JSON caller can skip by reading
 * `v3Enabled` directly off that command's own structured output — `test
 * run`'s JSON output carries no such field). Deliberately type-agnostic
 * (no "on frontend runs" claim): the CLI cannot learn a test's type at
 * `test run <existing-test-id>` time without an extra round trip, and the
 * override is equally inert on the V3 backend-run path.
 */
export const TARGET_URL_V3_ADVISORY =
  "[advisory] --target-url is not applied on the V3 execution path; the run uses the test's " +
  'configured environment instead.';

/** Write the target-url advisory to a stderr sink. */
export function emitTargetUrlV3Advisory(stderr: (line: string) => void): void {
  stderr(TARGET_URL_V3_ADVISORY);
}
