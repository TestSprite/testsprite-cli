import { describe, expect, it } from 'vitest';
import { resolveWaitFailure, type WaitMemberResult } from './wait-exit.js';
import { ApiError, CLIError } from './errors.js';

const OPTS = { timeoutSeconds: 600 };
const err = (code: string, exitCode: number): WaitMemberResult['error'] => ({
  code,
  message: `${code} happened`,
  exitCode,
});

describe('resolveWaitFailure — --wait fan-out exit-code precedence', () => {
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
