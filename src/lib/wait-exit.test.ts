import { describe, expect, it } from 'vitest';
import { resolveWaitFailure, waitMemberError, type WaitMemberResult } from './wait-exit.js';
import { ApiError, CLIError } from './errors.js';
import { classifyBillingRefusal } from './billing-refusal.js';

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
          runId: 'r1',
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
      [{ status: 'error', testId: 't2', runId: 'r2', error: waitMemberError(rollout) }],
      OPTS,
    ) as ApiError;
    expect(f.details.reason).toBe('rollout');
    expect(f.nextAction).toBe('Wait for rollout.');
    expect(classifyBillingRefusal(f)).toBeUndefined();
    // The reason survives (asserted above); the runId/testId merge must too —
    // a rollout member error must not become a bare `{ reason: 'rollout' }`
    // with no run to point the caller at.
    expect(f.details.runId).toBe('r2');
    expect(f.details.testId).toBe('t2');
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
          nextAction: 'Renew at https://portal.example/dashboard/settings/billing.',
          requestId: 'req_hold',
          details: { reason: 'billing_hold', state: 'paused' },
        },
      },
      403,
    );
    const f = resolveWaitFailure(
      [{ status: 'error', testId: 't3', runId: 'r3', error: waitMemberError(hold) }],
      OPTS,
    ) as ApiError;
    expect(f.details).toMatchObject({ reason: 'billing_hold', runId: 'r3', testId: 't3' });
    expect(f.nextAction).toContain('/dashboard/settings/billing');
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
        { status: 'timeout', runId: 'r1', error: err('UNSUPPORTED', 7) },
        { status: 'error', runId: 'r2', error: err('AUTH_INVALID', 3) },
      ],
      OPTS,
    ) as CLIError;
    expect(f).toBeInstanceOf(CLIError);
    expect(f.exitCode).toBe(3);
  });

  it('a NOT_FOUND poll error → ApiError exit 4 with a machine-readable code (§2)', () => {
    const f = resolveWaitFailure(
      [{ status: 'passed' }, { status: 'error', runId: 'r1', error: err('NOT_FOUND', 4) }],
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
      [{ status: 'error', runId: 'r1', error: err('RATE_LIMITED', 11) }],
      OPTS,
    ) as CLIError;
    expect(f.exitCode).toBe(11);
  });

  it('a typed operational error outranks a timeout', () => {
    const f = resolveWaitFailure(
      [
        { status: 'timeout', runId: 'r1', error: err('UNSUPPORTED', 7) },
        { status: 'error', runId: 'r2', error: err('NOT_FOUND', 4) },
      ],
      OPTS,
    ) as CLIError;
    expect(f.exitCode).toBe(4);
  });

  it('timeout outranks a generic test failure', () => {
    const f = resolveWaitFailure(
      [
        { status: 'failed', runId: 'r1' },
        { status: 'timeout', runId: 'r2', error: err('UNSUPPORTED', 7) },
      ],
      OPTS,
    ) as ApiError;
    expect(f).toBeInstanceOf(ApiError);
    expect(f.exitCode).toBe(7);
    expect(f.code).toBe('UNSUPPORTED');
  });

  it('an INTERNAL (exit 1) poll error folds into the generic failure bucket', () => {
    const f = resolveWaitFailure(
      [{ status: 'error', runId: 'r1', error: err('INTERNAL', 1) }],
      OPTS,
    ) as CLIError;
    expect(f.exitCode).toBe(1);
  });

  it('the timeout envelope carries per-run resume/cancel guidance', () => {
    const f = resolveWaitFailure(
      [
        { status: 'timeout', runId: 'run_a', error: err('UNSUPPORTED', 7) },
        { status: 'timeout', runId: 'run_b', error: err('UNSUPPORTED', 7) },
      ],
      OPTS,
    ) as ApiError;
    expect(f.details).toMatchObject({ timedOutRunIds: ['run_a', 'run_b'], timeoutSeconds: 600 });
  });

  it('two operational codes present → the higher-priority one wins (exercises the sort) (§3/§4)', () => {
    // INSUFFICIENT_CREDITS (12) outranks NOT_FOUND (4) in the precedence table.
    const f = resolveWaitFailure(
      [
        { status: 'error', runId: 'r1', error: err('NOT_FOUND', 4) },
        { status: 'error', runId: 'r2', error: err('INSUFFICIENT_CREDITS', 12) },
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
        { status: 'error', runId: 'r1', testId: 't1', error: waitMemberError(credits) },
        { status: 'error', runId: 'r2', testId: 't2', error: waitMemberError(hold) },
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
        { status: 'error', runId: 'r1', error: err('RATE_LIMITED', 11) },
        { status: 'error', runId: 'r2', error: err('CLIENT_TOO_OLD', 14) },
      ],
      OPTS,
    ) as ApiError;
    expect(f.exitCode).toBe(14);
    expect(f.code).toBe('CLIENT_TOO_OLD');
  });

  it('an out-of-contract exitCode 0 folds into generic (exit 1), never a green exit (§6c)', () => {
    const f = resolveWaitFailure(
      [{ status: 'error', runId: 'r1', error: err('WEIRD', 0) }],
      OPTS,
    ) as CLIError;
    expect(f).toBeInstanceOf(CLIError);
    expect(f.exitCode).toBe(1);
  });

  it('an unknown exitCode (99) folds to generic and does not preempt a real timeout (§6c)', () => {
    const f = resolveWaitFailure(
      [
        { status: 'timeout', runId: 'r1', error: err('UNSUPPORTED', 7) },
        { status: 'error', runId: 'r2', error: err('WEIRD', 99) },
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
        { status: 'failed', runId: 'r1' },
        { status: 'failed', runId: 'r2' },
        { status: 'error', runId: 'r3', error: err('AUTH_INVALID', 3) },
      ],
      OPTS,
    ) as CLIError;
    expect(f.exitCode).toBe(3);
    // 3 runs did not pass (2 failed + 1 auth) — count agrees with the summary line.
    expect(f.message).toContain('3 runs failed');
    expect(f.message).toContain('AUTH_INVALID');
  });
});
