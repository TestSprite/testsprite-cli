import { describe, expect, it } from 'vitest';
import { resolveWaitFailure, waitMemberError, type WaitMemberResult } from './wait-exit.js';
import { ApiError, CLIError } from './errors.js';
import { classifyBillingRefusal } from './billing-refusal.js';
import { classifyCliError } from './telemetry.js';

const OPTS = { timeoutSeconds: 600 };
const err = (code: string, exitCode: number): WaitMemberResult['error'] => ({
  code,
  message: `${code} happened`,
  exitCode,
});

describe('resolveWaitFailure — --wait fan-out exit-code precedence', () => {
  it('preserves billing refusal details and links from a member error', () => {
    const action = 'Renew at https://portal.example/dashboard-v3/o/org-1/settings/billing.';
    const f = resolveWaitFailure(
      [
        {
          status: 'error',
          testId: 't1',
          resultId: 'r1',
          error: {
            code: 'FEATURE_GATED',
            message: 'Workspace paused.',
            exitCode: 13,
            nextAction: action,
            requestId: 'req_hold',
            details: { reason: 'billing_hold', state: 'paused', orgId: 'org-1' },
            apiUrl: 'https://unknown-api.example',
          } as WaitMemberResult['error'],
        },
      ],
      OPTS,
    ) as ApiError;
    expect(f.code).toBe('FEATURE_GATED');
    expect(f.nextAction).toBe(action);
    expect(f.details.reason).toBe('billing_hold');
    expect(classifyBillingRefusal(f)?.links.billing).toBe(
      'https://portal.example/dashboard-v3/o/org-1/settings/billing',
    );
  });

  it('does not turn a rollout member error into an upgrade hint', () => {
    const rollout = ApiError.fromEnvelope(
      {
        error: {
          code: 'FEATURE_GATED',
          message: 'Rollout is disabled.',
          nextAction: 'Wait for rollout.',
          requestId: 'req_rollout',
          details: { reason: 'rollout' },
        },
      },
      403,
    );
    const f = resolveWaitFailure(
      [
        {
          status: 'error',
          testId: 't2',
          resultId: 'r2',
          runId: 'e2',
          error: waitMemberError(rollout),
        },
      ],
      OPTS,
    ) as ApiError;
    expect(f.details.reason).toBe('rollout');
    expect(f.nextAction).toBe('Wait for rollout.');
    expect(classifyBillingRefusal(f)).toBeUndefined();
    // The reason survives (asserted above); the id/testId merge must too —
    // a rollout member error must not become a bare `{ reason: 'rollout' }`
    // with no run to point the caller at. `runId` is the launch and
    // `resultId` the test's part of it.
    expect(f.details.runId).toBe('e2');
    expect(f.details.resultId).toBe('r2');
    expect(f.details.testId).toBe('t2');
    expect(JSON.stringify(f.details)).not.toContain('executionId');
  });

  it('waitMemberError keeps the enumerable member-error shape exactly {code, message, exitCode} — even for a rollout gate', () => {
    // The envelope metadata (nextAction/details/requestId/apiUrl) that
    // resolveWaitFailure needs must travel out of band, never as enumerable
    // properties: this object is what lands verbatim in `--output json`
    // stdout's `accepted[]` / `results[]`, and it must stay byte-identical
    // to what it was before billing refusals existed.
    const rollout = ApiError.fromEnvelope(
      {
        error: {
          code: 'FEATURE_GATED',
          message: 'Rollout is disabled.',
          nextAction: 'Wait for rollout.',
          requestId: 'req_rollout',
          details: { reason: 'rollout' },
        },
      },
      403,
    );
    const memberError = waitMemberError(rollout);
    expect(Object.keys(memberError).sort()).toEqual(['code', 'exitCode', 'message'].sort());
    expect(JSON.stringify(memberError)).toBe(
      JSON.stringify({ code: 'FEATURE_GATED', message: 'Rollout is disabled.', exitCode: 13 }),
    );
  });

  it('merges the server details with runId/testId for a paused-workspace member built through waitMemberError', () => {
    const hold = ApiError.fromEnvelope(
      {
        error: {
          code: 'FEATURE_GATED',
          message: 'Workspace paused.',
          nextAction: 'Renew at https://portal.example/dashboard-v3/settings/billing.',
          requestId: 'req_hold',
          details: { reason: 'billing_hold', state: 'paused' },
        },
      },
      403,
    );
    const f = resolveWaitFailure(
      [{ status: 'error', testId: 't3', resultId: 'r3', error: waitMemberError(hold) }],
      OPTS,
    ) as ApiError;
    // No launch id from the backend: the result id is printed as `resultId`
    // and never under `runId`.
    expect(f.details).toMatchObject({ reason: 'billing_hold', resultId: 'r3', testId: 't3' });
    expect('runId' in f.details).toBe(false);
    expect(f.nextAction).toContain('/dashboard-v3/settings/billing');
  });

  it('a typed member error names the launch as runId and the result as resultId', () => {
    const f = resolveWaitFailure(
      [
        {
          status: 'error',
          resultId: 'r1',
          runId: 'e1',
          testId: 't1',
          error: err('NOT_FOUND', 4),
        },
      ],
      OPTS,
    ) as ApiError;
    expect(f.details).toEqual({ runId: 'e1', resultId: 'r1', testId: 't1' });
  });

  it('a typed member error from an older backend carries resultId only', () => {
    const f = resolveWaitFailure(
      [{ status: 'error', resultId: 'r1', testId: 't1', error: err('NOT_FOUND', 4) }],
      OPTS,
    ) as ApiError;
    expect(f.details).toEqual({ resultId: 'r1', testId: 't1' });
  });
  it('a member refused because a run is in flight names the launch in its message', () => {
    const refused = ApiError.fromEnvelope(
      {
        error: {
          code: 'CONFLICT',
          // The backend may name both ids; the member's message is the CLI's own wording.
          message: 'Test case A already has result r1 of run e1 in flight.',
          nextAction: 'Poll it with: testsprite run wait r1',
          requestId: 'req_conflict',
          details: {
            reason: 'run_in_flight',
            conflicts: [{ testId: 'A', resultId: 'r1', runId: 'e1' }],
            currentResultId: 'r1',
            currentRunId: 'e1',
          },
        },
      },
      409,
    );
    expect(waitMemberError(refused)).toEqual({
      code: 'CONFLICT',
      message: 'Test case A already has result r1 of run e1 in flight.',
      exitCode: 6,
    });
  });

  it('the same refusal from an older backend calls the id a result', () => {
    const refused = ApiError.fromEnvelope(
      {
        error: {
          code: 'CONFLICT',
          message: 'Test case A already has run r1 in flight.',
          nextAction: 'Poll it with: testsprite run wait r1',
          requestId: 'req_conflict',
          details: {
            reason: 'run_in_flight',
            conflicts: [{ testId: 'A', runId: 'r1' }],
            currentRunId: 'r1',
          },
        },
      },
      409,
    );
    expect(waitMemberError(refused).message).toBe(refused.message);
  });

  it('a member refused because its producer is running names the producer launch', () => {
    const refused = (producer: Record<string, unknown>): ApiError =>
      ApiError.fromEnvelope(
        {
          error: {
            code: 'CONFLICT',
            message: 'Test case B was not started: its producer A holds result r1 of run e1.',
            nextAction: 'Wait for run r1 to finish (testsprite run wait r1).',
            requestId: 'req_conflict',
            details: { reason: 'producer_in_flight', testId: 'B', producers: [producer] },
          },
        },
        409,
      );
    expect(waitMemberError(refused({ testId: 'A', resultId: 'r1', runId: 'e1' })).message).toBe(
      'Test case B was not started: its producer A holds result r1 of run e1.',
    );
    // An older backend names no launch: the id is called a result.
    expect(waitMemberError(refused({ testId: 'A', runId: 'r1' })).message).toBe(
      'Test case B was not started: its producer A holds result r1 of run e1.',
    );
  });

  it('all passed → null (exit 0)', () => {
    expect(resolveWaitFailure([{ status: 'passed' }, { status: 'passed' }], OPTS)).toBeNull();
  });

  it('a genuine test failure → exit 1', () => {
    const f = resolveWaitFailure([{ status: 'passed' }, { status: 'failed' }], OPTS) as CLIError;
    expect(f).toBeInstanceOf(CLIError);
    expect(f.exitCode).toBe(1);
  });

  it('auth error wins over a concurrent timeout (was masked as exit 7)', () => {
    const f = resolveWaitFailure(
      [
        { status: 'timeout', resultId: 'r1', error: err('UNSUPPORTED', 7) },
        { status: 'error', resultId: 'r2', error: err('AUTH_INVALID', 3) },
      ],
      OPTS,
    ) as CLIError;
    expect(f).toBeInstanceOf(CLIError);
    expect(f.exitCode).toBe(3);
    expect(f.code).toBe('AUTH_INVALID');
  });

  it('an auth failure carries the member auth code, not the generic CLI_ERROR (§2)', () => {
    const f = resolveWaitFailure(
      [{ status: 'error', resultId: 'r1', error: err('AUTH_REQUIRED', 3) }],
      OPTS,
    ) as CLIError;
    expect(f).toBeInstanceOf(CLIError);
    expect(f.exitCode).toBe(3);
    // Both machine consumers read `err.code`: the `--output json` envelope
    // (`error.code`, index.ts) and telemetry's `errorCode`
    // (classifyCliError). It must be the real auth code so agents/CI take
    // their re-auth branch instead of seeing an unclassified failure.
    expect(f.code).toBe('AUTH_REQUIRED');
    expect(classifyCliError(f).errorCode).toBe('AUTH_REQUIRED');
  });

  it('a NOT_FOUND poll error → ApiError exit 4 with a machine-readable code (§2)', () => {
    const f = resolveWaitFailure(
      [{ status: 'passed' }, { status: 'error', resultId: 'r1', error: err('NOT_FOUND', 4) }],
      OPTS,
    ) as ApiError;
    // Routed through the envelope so `--output json` carries error.code — the
    // whole point of the operational branch (was a bare CLIError before).
    expect(f).toBeInstanceOf(ApiError);
    expect(f.exitCode).toBe(4);
    expect(f.code).toBe('NOT_FOUND');
  });

  it('a RATE_LIMITED poll error propagates its exit 11', () => {
    const f = resolveWaitFailure(
      [{ status: 'error', resultId: 'r1', error: err('RATE_LIMITED', 11) }],
      OPTS,
    ) as CLIError;
    expect(f.exitCode).toBe(11);
  });

  it('a typed operational error outranks a timeout', () => {
    const f = resolveWaitFailure(
      [
        { status: 'timeout', resultId: 'r1', error: err('UNSUPPORTED', 7) },
        { status: 'error', resultId: 'r2', error: err('NOT_FOUND', 4) },
      ],
      OPTS,
    ) as CLIError;
    expect(f.exitCode).toBe(4);
  });

  it('timeout outranks a generic test failure', () => {
    const f = resolveWaitFailure(
      [
        { status: 'failed', resultId: 'r1' },
        { status: 'timeout', resultId: 'r2', error: err('UNSUPPORTED', 7) },
      ],
      OPTS,
    ) as ApiError;
    expect(f).toBeInstanceOf(ApiError);
    expect(f.exitCode).toBe(7);
    expect(f.code).toBe('UNSUPPORTED');
  });

  it('an INTERNAL (exit 1) poll error folds into the generic failure bucket', () => {
    const f = resolveWaitFailure(
      [{ status: 'error', resultId: 'r1', error: err('INTERNAL', 1) }],
      OPTS,
    ) as CLIError;
    expect(f.exitCode).toBe(1);
  });

  it('the timeout envelope names the launch to resume or cancel, once', () => {
    const f = resolveWaitFailure(
      [
        { status: 'timeout', resultId: 'run_a', runId: 'exec_1', error: err('UNSUPPORTED', 7) },
        { status: 'timeout', resultId: 'run_b', runId: 'exec_1', error: err('UNSUPPORTED', 7) },
      ],
      OPTS,
    ) as ApiError;
    // The run to resume, under the keys `run wait`'s own timeout uses.
    expect(f.details).toEqual({
      runId: 'exec_1',
      runIds: ['exec_1'],
      timedOutResultIds: ['run_a', 'run_b'],
      timeoutSeconds: 600,
    });
    expect(f.nextAction).toBe(
      'Resume: testsprite run wait exec_1\nCancel: testsprite run cancel exec_1',
    );
  });

  it('an outage at the deadline (exit 10) names the runs still executing to re-attach to or cancel', () => {
    // The API was unreachable when the wait ended: the first result's poll
    // ended in the outage, the second was still queued behind it. Both runs
    // keep executing and billing, so a retry would start a second batch.
    const f = resolveWaitFailure(
      [
        {
          status: 'error',
          testId: 't1',
          resultId: 'run_a',
          runId: 'exec_1',
          error: err('UNAVAILABLE', 10),
        },
        { status: 'timeout', testId: 't2', resultId: 'run_b', runId: 'exec_2' },
        { status: 'passed', testId: 't3', resultId: 'run_c', runId: 'exec_3' },
      ],
      OPTS,
    ) as ApiError;
    expect(f).toBeInstanceOf(ApiError);
    expect(f.code).toBe('UNAVAILABLE');
    expect(f.exitCode).toBe(10);
    expect(f.details).toEqual({ runId: 'exec_1', resultId: 'run_a', testId: 't1' });
    expect(f.nextAction).toBe(
      'Resume: testsprite run wait exec_1 exec_2\nCancel: testsprite run cancel exec_1 exec_2',
    );
  });

  it('an outage at the deadline: a result the CLI cancelled, or one with no run named, is looked up instead', () => {
    const f = resolveWaitFailure(
      [
        {
          status: 'error',
          testId: 't1',
          resultId: 'run_a',
          runId: 'exec_1',
          cancel: 'cancelled',
          error: err('UNAVAILABLE', 10),
        },
        { status: 'error', testId: 't2', resultId: 'run_b', error: err('UNAVAILABLE', 10) },
      ],
      OPTS,
    ) as ApiError;
    expect(f.exitCode).toBe(10);
    expect(f.nextAction).toBe(
      'Check the verdict later with: testsprite result get run_a\n' +
        'Check the verdict later with: testsprite result list --test t2',
    );
  });

  it('the timeout envelope from an older backend lists the results and offers no wait or cancel', () => {
    const f = resolveWaitFailure(
      [
        { status: 'timeout', resultId: 'run_a', error: err('UNSUPPORTED', 7) },
        { status: 'timeout', resultId: 'run_b', error: err('UNSUPPORTED', 7) },
      ],
      OPTS,
    ) as ApiError;
    expect(f.details).toEqual({
      runId: null,
      runIds: [],
      timedOutResultIds: ['run_a', 'run_b'],
      timeoutSeconds: 600,
    });
    // These members name no test either, so each result is looked up itself.
    expect(f.nextAction).toBe(
      'Check the verdict later with: testsprite result get run_a\n' +
        'Check the verdict later with: testsprite result get run_b',
    );
    expect(f.nextAction).not.toMatch(/test (wait|cancel)/);
  });

  it("with no launch to wait on, the timeout points at each test's results instead", () => {
    const f = resolveWaitFailure(
      [
        { status: 'timeout', testId: 't1', resultId: 'run_a', error: err('UNSUPPORTED', 7) },
        { status: 'timeout', testId: 't2', resultId: 'run_b', error: err('UNSUPPORTED', 7) },
      ],
      OPTS,
    ) as ApiError;
    expect(f.nextAction).toBe(
      'Check the verdict later with: testsprite result list --test t1\n' +
        'Check the verdict later with: testsprite result list --test t2',
    );
  });

  it('that list is capped at ten tests, with a count of the rest', () => {
    const f = resolveWaitFailure(
      Array.from({ length: 12 }, (_, i) => ({
        status: 'timeout',
        testId: `t${i}`,
        resultId: `run_${i}`,
        error: err('UNSUPPORTED', 7),
      })),
      OPTS,
    ) as ApiError;
    const lines = f.nextAction.split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe('Check the verdict later with: testsprite result list --test t0');
    expect(lines[10]).toBe('… 2 more');
  });

  it("a timed-out result the CLI cancelled is pointed at itself, not at the test's result list", () => {
    // An owned tunnel's run is cancelled when the wait gives up. Result lists
    // leave cancelled results out, so the list would show an older verdict.
    const f = resolveWaitFailure(
      [
        {
          status: 'timeout',
          testId: 't1',
          resultId: 'run_a',
          cancel: 'cancelled',
          error: err('UNSUPPORTED', 7),
        },
        {
          status: 'timeout',
          testId: 't2',
          resultId: 'run_b',
          cancel: 'skipped',
          error: err('UNSUPPORTED', 7),
        },
      ],
      OPTS,
    ) as ApiError;
    expect(f.nextAction).toBe(
      'Check the verdict later with: testsprite result get run_a\n' +
        'Check the verdict later with: testsprite result list --test t2',
    );
  });

  it('a timed-out result the CLI cancelled is never offered to resume, even with its launch known', () => {
    const f = resolveWaitFailure(
      [
        {
          status: 'timeout',
          resultId: 'run_a',
          runId: 'exec_1',
          cancel: 'cancelled',
          error: err('UNSUPPORTED', 7),
        },
        { status: 'timeout', resultId: 'run_b', runId: 'exec_2', error: err('UNSUPPORTED', 7) },
      ],
      OPTS,
    ) as ApiError;
    expect(f.message).toBe('2 results timed out.');
    expect(f.nextAction).toBe(
      'Resume: testsprite run wait exec_2\n' +
        'Cancel: testsprite run cancel exec_2\n' +
        'Check the verdict later with: testsprite result get run_a',
    );
  });

  it('when the CLI cancelled every timed-out result, the error says so and offers no resume', () => {
    const f = resolveWaitFailure(
      [
        {
          status: 'timeout',
          resultId: 'run_a',
          runId: 'exec_1',
          cancel: 'cancelled',
          error: err('UNSUPPORTED', 7),
        },
      ],
      OPTS,
    ) as ApiError;
    expect(f.message).toBe('1 result timed out and was cancelled.');
    expect(f.nextAction).toBe('Check the verdict later with: testsprite result get run_a');
  });

  it('a timed-out run this command joined says what cancelling it stops', () => {
    const f = resolveWaitFailure(
      [
        { status: 'timeout', resultId: 'run_a', runId: 'exec_1', error: err('UNSUPPORTED', 7) },
        {
          status: 'timeout',
          resultId: 'run_b',
          runId: 'exec_9',
          joined: true,
          error: err('UNSUPPORTED', 7),
        },
      ],
      OPTS,
    ) as ApiError;
    expect(f.nextAction).toBe(
      'Resume: testsprite run wait exec_1 exec_9\n' +
        'Cancel: testsprite run cancel exec_1 exec_9 (cancelling exec_9 stops every test in that run, which this command joined and did not start)',
    );
  });

  it('two operational codes present → the higher-priority one wins (exercises the sort) (§3/§4)', () => {
    // INSUFFICIENT_CREDITS (12) outranks NOT_FOUND (4) in the precedence table.
    const f = resolveWaitFailure(
      [
        { status: 'error', resultId: 'r1', error: err('NOT_FOUND', 4) },
        { status: 'error', resultId: 'r2', error: err('INSUFFICIENT_CREDITS', 12) },
      ],
      OPTS,
    ) as ApiError;
    expect(f.exitCode).toBe(12);
    expect(f.code).toBe('INSUFFICIENT_CREDITS');
  });

  it('a paused workspace outranks a plain credits shortfall when every operational member is a billing refusal', () => {
    // Narrow exception to the table above: paying credits cannot resume a
    // paused workspace, so a mixed paused+credits batch must surface paused
    // (exit 13), not let INSUFFICIENT_CREDITS's higher table position win.
    const hold = ApiError.fromEnvelope(
      {
        error: {
          code: 'FEATURE_GATED',
          message: 'Workspace paused.',
          nextAction: '',
          requestId: 'req_hold',
          details: { reason: 'billing_hold', state: 'paused' },
        },
      },
      403,
    );
    const credits = ApiError.fromEnvelope(
      {
        error: {
          code: 'INSUFFICIENT_CREDITS',
          message: 'Need more credits.',
          nextAction: '',
          requestId: 'req_credits',
          details: { required: 2 },
        },
      },
      402,
    );
    const f = resolveWaitFailure(
      [
        { status: 'error', resultId: 'r1', testId: 't1', error: waitMemberError(credits) },
        { status: 'error', resultId: 'r2', testId: 't2', error: waitMemberError(hold) },
      ],
      OPTS,
    ) as ApiError;
    expect(f.code).toBe('FEATURE_GATED');
    expect(f.exitCode).toBe(13);
    expect(f.details.reason).toBe('billing_hold');
  });

  it('CLIENT_TOO_OLD (14) outranks a transient RATE_LIMITED (11) — non-retriable wins (§5)', () => {
    const f = resolveWaitFailure(
      [
        { status: 'error', resultId: 'r1', error: err('RATE_LIMITED', 11) },
        { status: 'error', resultId: 'r2', error: err('CLIENT_TOO_OLD', 14) },
      ],
      OPTS,
    ) as ApiError;
    expect(f.exitCode).toBe(14);
    expect(f.code).toBe('CLIENT_TOO_OLD');
  });

  it('an out-of-contract exitCode 0 folds into generic (exit 1), never a green exit (§6c)', () => {
    const f = resolveWaitFailure(
      [{ status: 'error', resultId: 'r1', error: err('WEIRD', 0) }],
      OPTS,
    ) as CLIError;
    expect(f).toBeInstanceOf(CLIError);
    expect(f.exitCode).toBe(1);
  });

  it('an unknown exitCode (99) folds to generic and does not preempt a real timeout (§6c)', () => {
    const f = resolveWaitFailure(
      [
        { status: 'timeout', resultId: 'r1', error: err('UNSUPPORTED', 7) },
        { status: 'error', resultId: 'r2', error: err('WEIRD', 99) },
      ],
      OPTS,
    ) as ApiError;
    // 99 is not in the table → folds to generic; timeout (7) outranks generic.
    expect(f).toBeInstanceOf(ApiError);
    expect(f.exitCode).toBe(7);
  });

  it('the auth message carries the failure count (§6b)', () => {
    const f = resolveWaitFailure(
      [
        { status: 'failed', resultId: 'r1' },
        { status: 'failed', resultId: 'r2' },
        { status: 'error', resultId: 'r3', error: err('AUTH_INVALID', 3) },
      ],
      OPTS,
    ) as CLIError;
    expect(f.exitCode).toBe(3);
    // 3 results did not pass (2 failed + 1 auth) — count agrees with the summary line.
    expect(f.message).toContain('3 results did not pass');
    expect(f.message).toContain('AUTH_INVALID');
  });
});
