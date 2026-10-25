import { CLIError } from './errors.js';
import type { CiSummary } from './gh-output.js';
import type { RunConflict } from './conflict-reason.js';
import { resolveWaitFailure, type WaitMemberResult } from './wait-exit.js';

/** CI owns non-dispatch policy; operational poll failures retain their typed exit. */
export function resolveCiRunFailure(
  summary: CiSummary,
  accepted: readonly WaitMemberResult[],
  opts: { timeoutSeconds: number; allowEmpty?: boolean; failOnSkipped?: boolean },
  /** The batch's `conflicts[]`, with their reasons, when the caller has them. */
  conflicts: readonly RunConflict[] = [],
): Error | null {
  const missing = summary.runs.filter(row => row.status === 'not_found');
  if (missing.length > 0) {
    return new CLIError(`Tests not found: ${missing.map(row => row.testId).join(', ')}`, 4);
  }
  const failure = resolveWaitFailure(accepted, opts);
  if (failure) return failure;
  if (accepted.length === 0) {
    // `--allow-empty` covers an empty selection: no tests, a filter that
    // matched nothing, or runs already in flight elsewhere. A batch the
    // backend REFUSED — an unknown environment, an un-runnable one, a
    // view-only mirror, a billing hold — is not empty, and reading it as
    // green is the false-green shape a gate exists to prevent.
    const refused = conflicts.filter(
      c => c.reason !== undefined && c.reason !== 'in_flight' && c.reason !== 'not_found',
    );
    if (refused.length > 0) {
      const first = refused[0]!;
      return new CLIError(
        `No tests were dispatched: ${refused.length} refused (${first.reason}${first.message ? `: ${first.message}` : ''}).`,
        5,
      );
    }
    if (!opts.allowEmpty) {
      return new CLIError(
        'No tests were dispatched. Pass --allow-empty to allow an empty CI run.',
        5,
      );
    }
  }
  if (summary.skipped > 0 && opts.failOnSkipped) {
    return new CLIError(`${summary.skipped} tests were skipped (--fail-on-skipped).`, 1);
  }
  return null;
}
