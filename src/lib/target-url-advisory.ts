import { terminalSafeLine } from './terminal-text.js';

/**
 * Point-of-use advisory for `run --target-url`. Response-driven: it
 * compares what the caller asked for against the target the trigger response
 * reports, and speaks up only when they differ — the backend is the ground
 * truth for which origin a run used, so the CLI never infers it.
 *
 * Deliberately cause-agnostic in its wording: a mismatch is reported purely
 * from the observed response, regardless of why the backend didn't apply the
 * override.
 */
export function targetUrlAdvisoryText(requested: string, applied: string): string {
  const appliedClause =
    applied.length > 0
      ? `the run will use ${terminalSafeLine(applied)} instead`
      : 'the run reports no target URL for it';
  return (
    `[advisory] --target-url ${terminalSafeLine(requested)} was not applied to this run — ${appliedClause}. ` +
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
