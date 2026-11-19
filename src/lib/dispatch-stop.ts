/**
 * What a batch dispatch that stopped part-way says on stderr: the stop lines
 * and the hint naming the tests it never sent. `run`'s batch uses them
 * all; its local (tunnel) batch shares the hint and the line for a stop that
 * still awaits accepted runs, so the two cannot drift there.
 *
 * The reports differ. {@link NOT_SENT_REASON} is the cloud batch's reason for
 * a test it never sent while it awaited the runs already accepted, or after
 * an unconfirmed first request. A stop it does not await (a first request
 * that failed, say) gives the error instead (`not dispatched: <error>`), and
 * the local batch lists such a test as skipped with no reason.
 */

import { terminalSafeLine } from './terminal-text.js';

/** `N tests were not dispatched: <ids>`, the hint for the tests a stopped dispatch never sent. */
export function notDispatchedHint(testIds: readonly string[]): string {
  return (
    `${testIds.length} test${testIds.length !== 1 ? 's were' : ' was'} not dispatched: ` +
    testIds.map(terminalSafeLine).join(' ')
  );
}

/** The stderr line of a dispatch that stopped part-way: why, then each hint given, as sentences. */
export function dispatchStoppedLine(
  reason: string,
  hints: ReadonlyArray<string | undefined>,
): string {
  return `[run] Dispatch stopped (${terminalSafeLine(reason)}). ${hints.filter(Boolean).join('. ')}.`;
}

/** The cloud batch's reason for a test it never sent, in the summary file and the report. */
export const NOT_SENT_REASON = 'not dispatched: the dispatch stopped before this test was sent';

/** The stderr line of a dispatch that stopped while it still awaits the runs already accepted. */
export function awaitingStoppedLine(reason: string, neverSent: readonly string[]): string {
  return (
    `[run] Dispatch stopped (${terminalSafeLine(reason)}); awaiting the runs already accepted. ` +
    `${notDispatchedHint(neverSent)}.`
  );
}
