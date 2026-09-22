import { ApiError, CLIError, isAuthCode } from './errors.js';

/**
 * One member of a `--wait` fan-out poll (a single dispatched run's outcome).
 * `status` is the terminal run status (`passed`/`failed`/`blocked`/…), or the
 * synthesized `'timeout'` / `'error'` when the poll itself timed out or the
 * run-read returned a typed `ApiError`. When `status === 'error'`, `error`
 * carries that ApiError's `code` + `exitCode`.
 */
export interface WaitMemberResult {
  testId?: string;
  runId?: string;
  status: string;
  // `exitCode` is optional to accept the shared JUnit result shape; an error
  // with no exitCode is treated as the generic failure (1).
  error?: { code: string; message: string; exitCode?: number };
}

/**
 * Exit-code precedence for a `--wait` fan-out, highest first. Ordered
 * batch-wide-non-retriable → per-run → transient → timeout → generic:
 *   - auth (3) and CLIENT_TOO_OLD (14): a bad credential / too-old client fails
 *     EVERY poll and retrying can never succeed — batch-wide, so they top the
 *     table (a transient `RATE_LIMITED` "retry later" must never outrank them).
 *   - INSUFFICIENT_CREDITS (12) / FEATURE_GATED (13): per-run, non-retriable.
 *   - NOT_FOUND (4) / VALIDATION_ERROR (5) / CONFLICT (6): per-run.
 *   - RATE_LIMITED (11) / UNAVAILABLE (10): transient — a retry may help.
 *   - timeout (7): outranks only a generic failure.
 *   - generic (1): the floor (genuine test-fail / INTERNAL).
 * A code NOT in this table folds into the generic bucket (never surfaced as an
 * operational error), so an out-of-contract exit (0, 99, a leaked signal code)
 * can neither preempt a real verdict nor produce a printed-failure-green-exit.
 */
const WAIT_EXIT_PRIORITY = [3, 14, 12, 13, 4, 5, 6, 11, 10, 7, 1] as const;

/**
 * A "typed operational" code is one that sits in the precedence table above the
 * generic floor — known AND not the generic `1`. Everything else (unknown
 * codes, `0`, INTERNAL/1) folds into the generic failure bucket.
 */
function isOperationalCode(exitCode: number): boolean {
  return (
    exitCode !== 1 && WAIT_EXIT_PRIORITY.includes(exitCode as (typeof WAIT_EXIT_PRIORITY)[number])
  );
}

/**
 * Index of `exitCode` in the precedence table (lower = higher priority). Only
 * ever called on operational codes (see `isOperationalCode`), so the index is
 * always valid.
 */
function priorityOf(exitCode: number): number {
  return WAIT_EXIT_PRIORITY.indexOf(exitCode as (typeof WAIT_EXIT_PRIORITY)[number]);
}

/**
 * Resolve the process-level failure for a completed `--wait` fan-out, or `null`
 * when every member passed. Shared by `test run --all` / `test rerun` and
 * `testlist run` so their exit-code semantics can't drift.
 *
 * Precedence (see {@link WAIT_EXIT_PRIORITY}): auth / client-too-old → typed
 * operational ApiError → timeout (7) → generic test-failure (1).
 */
export function resolveWaitFailure(
  results: readonly WaitMemberResult[],
  opts: { timeoutSeconds: number },
): CLIError | ApiError | null {
  const timedOut = results.filter(r => r.status === 'timeout');
  const errored = results.filter(
    (r): r is WaitMemberResult & { error: NonNullable<WaitMemberResult['error']> } =>
      r.status === 'error' && r.error !== undefined,
  );
  // A genuine test failure: terminal-not-passed, and not one of the synthesized
  // timeout/typed-error members above.
  const failed = results.filter(
    r => r.status !== 'passed' && r.status !== 'timeout' && !(r.status === 'error' && r.error),
  );
  // How many runs did NOT pass — used for the auth failure count so the message
  // agrees with the "N failed/blocked" summary printed just above it.
  const notPassed = results.filter(r => r.status !== 'passed').length;

  // 1) Auth wins over everything — the credential is bad, not the test.
  //    Classified via the single `isAuthCode` source (derived from `exitCodeFor`)
  //    rather than a local `=== 3` so a future AUTH_* code can't be missed here.
  const authErr = errored.find(r => isAuthCode(r.error.code));
  if (authErr) {
    return new CLIError(
      `${notPassed} run${notPassed !== 1 ? 's' : ''} failed — auth error (${authErr.error.code}): ${authErr.error.message}`,
      3,
    );
  }

  // 2) Any other typed operational ApiError, highest-priority first. Only codes
  //    IN the precedence table qualify — an unknown / out-of-contract code folds
  //    into the generic bucket below rather than being surfaced (or leaking a
  //    non-1 exit like 0/99). Routed through the ENVELOPE so `--output json`
  //    carries `error.code` — the machine-readable field this fix exists for;
  //    `ApiError.fromEnvelope` derives the exit via `exitCodeFor(code)`.
  const operational = errored
    .filter(r => isOperationalCode(r.error.exitCode ?? 1))
    .sort((a, b) => priorityOf(a.error.exitCode!) - priorityOf(b.error.exitCode!))[0];
  if (operational) {
    return ApiError.fromEnvelope({
      error: {
        code: operational.error.code,
        message: operational.error.message,
        nextAction: '',
        requestId: 'local',
        details: { runId: operational.runId ?? null, testId: operational.testId ?? null },
      },
    });
  }

  // 3) Timeout — outranks a generic failure so the operator gets resume/cancel
  //    guidance for the runs that didn't finish.
  if (timedOut.length > 0) {
    const runIds = timedOut.map(r => r.runId).filter((id): id is string => Boolean(id));
    return ApiError.fromEnvelope({
      error: {
        code: 'UNSUPPORTED',
        message: `${timedOut.length} run${timedOut.length !== 1 ? 's' : ''} timed out.`,
        nextAction: [
          ...runIds.map(rid => `Resume: testsprite test wait ${rid}`),
          ...runIds.map(rid => `Cancel: testsprite test cancel ${rid}`),
        ].join('\n'),
        requestId: 'local',
        details: { timedOutRunIds: runIds, timeoutSeconds: opts.timeoutSeconds },
      },
    });
  }

  // 4) Generic test failures — genuine test-fails, INTERNAL (1), and any
  //    unknown / out-of-contract error code folded here.
  const genericCount =
    failed.length + errored.filter(r => !isOperationalCode(r.error.exitCode ?? 1)).length;
  if (genericCount > 0) {
    return new CLIError(`${genericCount} run${genericCount !== 1 ? 's' : ''} failed.`, 1);
  }

  return null;
}
