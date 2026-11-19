import { ApiError, CLIError, isAuthCode, isErrorCode } from './errors.js';
import { classifyBillingRefusal, isPausedReason } from './billing-refusal.js';
import {
  cancelCommand,
  checkLaterHint,
  launchIds,
  resultCount,
  waitCommand,
} from './run-render.js';

/**
 * One member of a `--wait` fan-out poll (a single dispatched run's outcome).
 * `status` is the terminal run status (`passed`/`failed`/`blocked`/…), or the
 * synthesized `'timeout'` / `'error'` when the poll itself timed out or the
 * run-read returned a typed `ApiError`. When `status === 'error'`, `error`
 * carries that ApiError's `code` + `exitCode`.
 */
export interface WaitMemberResult {
  testId?: string;
  /** The result id (wire name). Printed as `resultId`. */
  resultId?: string;
  /** The launch the result belongs to (wire name); absent on an older backend. Printed as `runId`. */
  runId?: string;
  /** True for a run this invocation joined instead of starting; see `RunRef.joined`. */
  joined?: boolean;
  /**
   * What happened when the CLI tried to stop this run (a tunnel run it stopped
   * waiting for). `'cancelled'` means the result is cancelled: result lists
   * leave it out, so a later lookup has to name the result itself.
   */
  cancel?: string;
  status: string;
  // `exitCode` is optional to accept the shared JUnit result shape; an error
  // with no exitCode is treated as the generic failure (1).
  error?: {
    code: string;
    message: string;
    exitCode?: number;
    nextAction?: string;
    serverNextAction?: string;
    requestId?: string;
    details?: Record<string, unknown>;
    apiUrl?: string;
  };
}

/**
 * Envelope metadata for a billing/feature-gate member error, keyed by the
 * IDENTITY of the object `waitMemberError` returns. The enumerable shape of
 * that object must stay exactly `{ code, message, exitCode }` — it lands
 * verbatim in `--output json` stdout (`accepted[]` / `results[]`), and a
 * `nextAction` / `details` / `apiUrl` riding along there would both leak
 * internal fields to every consumer AND (since the guard below fires for
 * every FEATURE_GATED, including `rollout`) attach billing-looking data to a
 * refusal that isn't one. The extra fields `resolveWaitFailure` needs to
 * reconstruct a faithful ApiError travel here instead, out of band.
 */
const memberEnvelopeMeta = new WeakMap<
  NonNullable<WaitMemberResult['error']>,
  {
    nextAction?: string;
    serverNextAction?: string;
    requestId?: string;
    details?: Record<string, unknown>;
    apiUrl?: string;
  }
>();

export function waitMemberError(
  err: ApiError,
): NonNullable<WaitMemberResult['error']> & { exitCode: number } {
  const { message } = err;
  const memberError = { code: err.code, message, exitCode: err.exitCode };
  if (err.code === 'FEATURE_GATED' || classifyBillingRefusal(err)) {
    memberEnvelopeMeta.set(memberError, {
      nextAction: err.nextAction,
      serverNextAction: err.serverNextAction,
      requestId: err.requestId,
      details: err.details,
      apiUrl: err.apiUrl,
    });
  }
  return memberError;
}

/**
 * Read a member error's out-of-band envelope metadata, falling back to
 * whatever the object carries as OWN enumerable properties. The fallback
 * exists for callers that build a `WaitMemberResult['error']` by hand (a
 * legacy/shared JUnit result shape, or a test fixture) rather than through
 * `waitMemberError` — those never got a `memberEnvelopeMeta` entry, so their
 * fields must still be read the old way.
 */
function memberMeta(error: NonNullable<WaitMemberResult['error']>): {
  nextAction?: string;
  serverNextAction?: string;
  requestId?: string;
  details?: Record<string, unknown>;
  apiUrl?: string;
} {
  return (
    memberEnvelopeMeta.get(error) ?? {
      nextAction: error.nextAction,
      serverNextAction: error.serverNextAction,
      requestId: error.requestId,
      details: error.details,
      apiUrl: error.apiUrl,
    }
  );
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
export const WAIT_EXIT_PRIORITY = [3, 14, 12, 13, 4, 5, 6, 11, 10, 7, 1] as const;

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
 * How to get back to results a wait let go of while they may still be
 * running: `run wait` / `run cancel` take the launch, so each launch is
 * named once. A result the CLI cancelled (an owned tunnel's, when the wait
 * gave up) cannot be resumed: it is looked up itself. With no launch id from
 * the backend neither command can be given; what can still be looked up is
 * each test's own results.
 */
export function unfinishedHint(rows: readonly WaitMemberResult[]): string {
  const cancelled = rows.filter(r => r.cancel === 'cancelled');
  const live = rows.filter(r => r.cancel !== 'cancelled');
  const resume = waitCommand(live);
  const cancel = cancelCommand(live);
  const resumable = resume !== undefined && cancel !== undefined;
  const later = checkLaterHint(
    [...cancelled, ...(resumable ? [] : live)].map(r => ({
      testId: r.testId,
      resultId: r.resultId,
      byResult: r.cancel === 'cancelled',
    })),
  );
  return [...(resumable ? [`Resume: ${resume}`, `Cancel: ${cancel}`] : []), later]
    .filter(line => line.length > 0)
    .join('\n');
}

/**
 * Resolve the process-level failure for a completed `--wait` fan-out, or `null`
 * when every member passed. Shared by `run --project` and `run --testlist` so their exit-code semantics can't drift.
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
  const nonPassed = results.filter(r => r.status !== 'passed');

  // 1) Auth wins over everything — the credential is bad, not the test.
  //    Classified via the single `isAuthCode` source (derived from `exitCodeFor`)
  //    rather than a local `=== 3` so a future AUTH_* code can't be missed here.
  const authErr = errored.find(r => isAuthCode(r.error.code));
  if (authErr) {
    return new CLIError(
      `${resultCount(nonPassed.length)} did not pass — auth error (${authErr.error.code}): ${authErr.error.message}`,
      3,
      // Carry the member's real catalog code (AUTH_REQUIRED / AUTH_INVALID /
      // AUTH_FORBIDDEN — `isAuthCode` above guarantees one of them) so the
      // JSON envelope's `error.code` and telemetry's `errorCode` classify
      // this as auth instead of falling into the generic 'CLI_ERROR'
      // bucket — agreeing with the exit code and the message.
      authErr.error.code,
    );
  }

  // 2) Any other typed operational ApiError, highest-priority first. Only codes
  //    IN the precedence table qualify — an unknown / out-of-contract code folds
  //    into the generic bucket below rather than being surfaced (or leaking a
  //    non-1 exit like 0/99). Routed through the ENVELOPE so `--output json`
  //    carries `error.code` — the machine-readable field this fix exists for;
  //    `ApiError.fromEnvelope` derives the exit via `exitCodeFor(code)`.
  const operationalCandidates = errored.filter(r => isOperationalCode(r.error.exitCode ?? 1));
  // Narrow exception to the table above (mirrors the identical rule in
  // conflict-reason.ts's `isPausedRefusal`): when EVERY operational
  // member is a billing refusal and at least one is a paused workspace, paused
  // wins over a plain credits shortfall — topping up credits cannot resume a
  // paused workspace. This does not reorder WAIT_EXIT_PRIORITY for any other
  // code combination.
  const isPausedMember = (r: (typeof operationalCandidates)[number]): boolean =>
    r.error.code === 'FEATURE_GATED' && isPausedReason(memberMeta(r.error).details?.reason);
  const isBillingRefusalMember = (r: (typeof operationalCandidates)[number]): boolean =>
    r.error.code === 'INSUFFICIENT_CREDITS' || isPausedMember(r);
  const operational =
    operationalCandidates.length > 0 &&
    operationalCandidates.every(isBillingRefusalMember) &&
    operationalCandidates.some(isPausedMember)
      ? operationalCandidates.find(isPausedMember)
      : operationalCandidates.sort(
          (a, b) => priorityOf(a.error.exitCode!) - priorityOf(b.error.exitCode!),
        )[0];
  if (operational) {
    const meta = memberMeta(operational.error);
    if (meta.details && isErrorCode(operational.error.code)) {
      // Merge the server's own details with the local ids (never the reverse)
      // so automation reading `error.details.resultId`/`testId` keeps working
      // for a billing refusal exactly as it does for any other typed error,
      // while `reason` (billing_hold / rollout / …) survives untouched.
      return new ApiError(
        {
          code: operational.error.code,
          message: operational.error.message,
          nextAction: meta.nextAction ?? '',
          requestId: meta.requestId ?? 'local',
          details: {
            ...meta.details,
            ...(operational.runId ? { runId: operational.runId } : {}),
            resultId: operational.resultId ?? null,
            testId: operational.testId ?? null,
          },
        },
        undefined,
        undefined,
        meta.apiUrl,
        meta.serverNextAction,
      );
    }
    // An outage that outlasted --timeout (UNAVAILABLE): the results not seen
    // to finish keep executing, and billing, so the hint re-attaches to their
    // runs. Without it the exit-10 advice is to retry, which starts and bills
    // a second batch beside the first.
    const unreachable = operational.error.code === 'UNAVAILABLE';
    return ApiError.fromEnvelope({
      error: {
        code: operational.error.code,
        message: operational.error.message,
        nextAction: unreachable
          ? unfinishedHint(
              results.filter(
                r =>
                  r.status === 'timeout' ||
                  (r.status === 'error' && r.error?.code === 'UNAVAILABLE'),
              ),
            )
          : '',
        requestId: 'local',
        details: {
          ...(operational.runId ? { runId: operational.runId } : {}),
          resultId: operational.resultId ?? null,
          testId: operational.testId ?? null,
        },
      },
    });
  }

  // 3) Timeout — outranks a generic failure so the operator gets resume/cancel
  //    guidance for the runs that didn't finish.
  if (timedOut.length > 0) {
    const resultIds = timedOut.map(r => r.resultId).filter((id): id is string => Boolean(id));
    const live = timedOut.filter(r => r.cancel !== 'cancelled');
    const launches = launchIds(live);
    const n = timedOut.length;
    return ApiError.fromEnvelope({
      error: {
        code: 'UNSUPPORTED',
        message:
          live.length === 0
            ? `${resultCount(n)} timed out and ${n === 1 ? 'was' : 'were'} cancelled.`
            : `${resultCount(n)} timed out.`,
        nextAction: unfinishedHint(timedOut),
        requestId: 'local',
        details: {
          // The runs to resume, under the keys `run wait`'s own timeout uses.
          runId: launches.length === 1 ? launches[0]! : null,
          runIds: launches,
          timedOutResultIds: resultIds,
          timeoutSeconds: opts.timeoutSeconds,
        },
      },
    });
  }

  // The remaining rows are result verdicts or generic errors. Multiple
  // results can belong to the same run.
  if (nonPassed.length > 0) {
    const failed = nonPassed.filter(row => row.status === 'failed').length;
    const subject = resultCount(nonPassed.length);
    if (failed === nonPassed.length) return new CLIError(`${subject} failed.`, 1);
    const blocked = nonPassed.filter(row => row.status === 'blocked').length;
    const cancelled = nonPassed.filter(row => row.status === 'cancelled').length;
    const other = nonPassed.length - failed - blocked - cancelled;
    const detail = [
      ...(failed ? [`${failed} failed`] : []),
      ...(blocked ? [`${blocked} blocked`] : []),
      ...(cancelled ? [`${cancelled} cancelled`] : []),
      ...(other ? [`${other} unresolved`] : []),
    ].join(', ');
    return new CLIError(`${subject} did not pass (${detail}).`, 1);
  }

  return null;
}
