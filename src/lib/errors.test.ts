import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  CLIError,
  ERROR_CODES,
  NotImplementedError,
  RequestTimeoutError,
  TransportError,
  exitCodeFor,
  isErrorCode,
  localValidationError,
} from './errors.js';

describe('CLIError', () => {
  it('defaults to exit code 1', () => {
    const err = new CLIError('boom');
    expect(err.exitCode).toBe(1);
    expect(err.message).toBe('boom');
    expect(err.name).toBe('CLIError');
    expect(err).toBeInstanceOf(Error);
  });

  it('accepts a custom exit code', () => {
    expect(new CLIError('boom', 42).exitCode).toBe(42);
  });
});

describe('NotImplementedError', () => {
  it('mentions the command path and uses exit code 2', () => {
    const err = new NotImplementedError('project list');
    expect(err.message).toContain('project list');
    expect(err.exitCode).toBe(2);
    expect(err.name).toBe('NotImplementedError');
    expect(err).toBeInstanceOf(CLIError);
  });
});

describe('isErrorCode', () => {
  it('accepts every catalog code', () => {
    for (const code of ERROR_CODES) expect(isErrorCode(code)).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(isErrorCode('OOPSIE')).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
    expect(isErrorCode(42)).toBe(false);
  });
});

describe('exitCodeFor', () => {
  it.each([
    ['AUTH_REQUIRED', 3],
    ['AUTH_INVALID', 3],
    ['AUTH_FORBIDDEN', 3],
    ['NOT_FOUND', 4],
    ['VALIDATION_ERROR', 5],
    ['CONFLICT', 6],
    ['UNSUPPORTED', 7],
    ['UNAVAILABLE', 10],
    ['RATE_LIMITED', 11],
    ['INSUFFICIENT_CREDITS', 12],
    ['FEATURE_GATED', 13],
    ['CLIENT_TOO_OLD', 14],
    ['AMBIGUOUS_ORG', 6],
    ['INTERNAL', 1],
  ] as const)('%s → exit %d', (code, expected) => {
    expect(exitCodeFor(code)).toBe(expected);
  });
});

describe('ApiError.fromEnvelope', () => {
  it('parses a well-formed envelope', () => {
    const err = ApiError.fromEnvelope(
      {
        error: {
          code: 'AUTH_INVALID',
          message: 'Bad key.',
          nextAction: 'rotate',
          requestId: 'req_1',
          details: { reason: 'revoked' },
        },
      },
      401,
    );
    expect(err).toBeInstanceOf(CLIError);
    expect(err.code).toBe('AUTH_INVALID');
    expect(err.exitCode).toBe(3);
    expect(err.requestId).toBe('req_1');
    expect(err.nextAction).toBe('rotate');
    expect(err.details).toEqual({ reason: 'revoked' });
    expect(err.httpStatus).toBe(401);
  });

  it('falls back to INTERNAL for an unknown code', () => {
    const err = ApiError.fromEnvelope({
      error: { code: 'BIZARRE_NEW_CODE', message: 'eh', nextAction: '', requestId: 'r' },
    });
    expect(err.code).toBe('INTERNAL');
    expect(err.exitCode).toBe(1);
  });

  it('handles a malformed envelope', () => {
    const err = ApiError.fromEnvelope('not an object');
    expect(err.code).toBe('INTERNAL');
    expect(err.message).toContain('malformed');
    expect(err.requestId).toBe('unknown');
  });

  it('accepts a flat envelope (no nested error)', () => {
    const err = ApiError.fromEnvelope({
      code: 'NOT_FOUND',
      message: 'gone',
      nextAction: '',
      requestId: 'r',
      details: {},
    });
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('ApiError.authRequired', () => {
  it('returns a locally-fabricated AUTH_REQUIRED envelope', () => {
    const err = ApiError.authRequired();
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(err.exitCode).toBe(3);
    expect(err.nextAction).toContain('testsprite setup');
  });

  it('P9 — nextAction mentions --from-env for non-interactive flows', () => {
    const err = ApiError.authRequired();
    expect(err.nextAction).toContain('--from-env');
    // Should guide users toward both interactive and non-interactive paths.
    expect(err.nextAction).toContain('TESTSPRITE_API_KEY');
  });
});

describe('ApiError.fromEnvelope status fallback', () => {
  it.each([
    [400, 'VALIDATION_ERROR' as const],
    [401, 'AUTH_INVALID' as const],
    [402, 'INSUFFICIENT_CREDITS' as const],
    [403, 'AUTH_FORBIDDEN' as const],
    [404, 'NOT_FOUND' as const],
    [409, 'CONFLICT' as const],
    [426, 'CLIENT_TOO_OLD' as const],
    [429, 'RATE_LIMITED' as const],
    [501, 'UNSUPPORTED' as const],
    [503, 'UNAVAILABLE' as const],
    [500, 'INTERNAL' as const],
    [418, 'INTERNAL' as const],
  ])('HTTP %d with no envelope → %s', (status, expected) => {
    const err = ApiError.fromEnvelope(null, status);
    expect(err.code).toBe(expected);
  });

  it('uses status fallback when envelope.code is unrecognized', () => {
    const err = ApiError.fromEnvelope(
      { error: { code: 'NEVER_HEARD_OF_IT', message: 'eh', nextAction: '', requestId: 'r' } },
      503,
    );
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.exitCode).toBe(10);
  });

  it('recognizes a well-formed CLIENT_TOO_OLD (426) envelope and echoes the version details', () => {
    const err = ApiError.fromEnvelope(
      {
        error: {
          code: 'CLIENT_TOO_OLD',
          message: 'Your CLI is older than the minimum supported version.',
          nextAction: 'Upgrade with npm i -g @testsprite/testsprite-cli@latest.',
          requestId: 'req_old',
          details: { minVersion: '1.0.0', yourVersion: '0.9.0' },
        },
      },
      426,
    );
    // The code is in the union, so it is trusted directly — NOT remapped.
    expect(err.code).toBe('CLIENT_TOO_OLD');
    expect(err.exitCode).toBe(14);
    expect(err.details).toEqual({ minVersion: '1.0.0', yourVersion: '0.9.0' });
  });

  // Track A dogfood: NestJS raw 404 (route not registered) has the
  // shape `{ message, error: "Not Found", statusCode }`. Previously the
  // parser saw `obj.error = "Not Found"` (a string) and fell through to
  // "Server error.", losing the actually-useful "Cannot POST <path>"
  // message. The current parser distinguishes raw-Express 404s by their
  // `Cannot <METHOD> <path>` pattern and emits an actionable hint.
  it('preserves NestJS raw 404 message + emits route-missing hint', () => {
    const err = ApiError.fromEnvelope(
      {
        message: 'Cannot POST /api/cli/v1/tests/abc/runs',
        error: 'Not Found',
        statusCode: 404,
      },
      404,
    );
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toContain('Cannot POST /api/cli/v1/tests/abc/runs');
    expect(err.message).toContain('endpoint not available');
    expect(err.nextAction).toContain('M3.3 piece');
  });

  it('NestJS-shape 404 with a non-Cannot message falls back to plain message', () => {
    const err = ApiError.fromEnvelope(
      { message: 'something else broke', error: 'Internal Server Error', statusCode: 500 },
      500,
    );
    expect(err.code).toBe('INTERNAL');
    expect(err.message).toBe('something else broke');
    expect(err.nextAction).toBe('');
  });
});

describe('localValidationError', () => {
  it('returns a VALIDATION_ERROR / exit 5 envelope', () => {
    const err = localValidationError('pageSize', 'must be a positive integer');
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.exitCode).toBe(5);
    expect(err.requestId).toBe('local');
  });

  it('kind=flag (default) wraps field name as --flag with camelCase converted to kebab', () => {
    const err = localValidationError('pageSize', 'must be a positive integer');
    expect(err.nextAction).toContain('Flag `--page-size`');
  });

  it('kind=flag passes through already-kebab field names unchanged', () => {
    const err = localValidationError('code-file', 'file does not exist: /tmp/foo.ts');
    expect(err.nextAction).toContain('Flag `--code-file`');
  });

  it('kind=field uses bare field path without double-dash prefix', () => {
    const err = localValidationError(
      'planSteps[0].description',
      'must be a string',
      undefined,
      'field',
    );
    expect(err.nextAction).toContain('Field `planSteps[0].description`');
    expect(err.nextAction).not.toContain('--');
  });

  it('includes accepted values in details when provided', () => {
    const err = localValidationError('type', 'must be one of: frontend, backend', [
      'frontend',
      'backend',
    ]);
    expect(err.details).toMatchObject({
      field: 'type',
      reason: 'must be one of: frontend, backend',
      accepted: ['frontend', 'backend'],
    });
  });

  it('omits accepted key from details when not provided', () => {
    const err = localValidationError('code-file', 'file does not exist: /tmp/x.ts');
    expect(err.details).toEqual({ field: 'code-file', reason: 'file does not exist: /tmp/x.ts' });
    expect('accepted' in err.details).toBe(false);
  });

  // A reason string that already ends in a period (common when a
  // call site composes multiple already-punctuated sentences, e.g.
  // `test run --all --target-url` builds its rejection out of an
  // explanatory sentence + an instruction sentence) must not end up with a
  // doubled `..` once the template appends its own trailing period.
  it('does not double the trailing period when reason already ends with one', () => {
    const err = localValidationError(
      'target-url',
      '--target-url has no effect with --all. Remove --target-url.',
    );
    expect(err.nextAction).toBe(
      'Flag `--target-url` is invalid: --target-url has no effect with --all. Remove --target-url.',
    );
    expect(err.nextAction.endsWith('..')).toBe(false);
    expect(err.nextAction.endsWith('.')).toBe(true);
  });

  it('still appends exactly one period when reason has no trailing punctuation', () => {
    const err = localValidationError('pageSize', 'must be a positive integer');
    expect(err.nextAction).toBe('Flag `--page-size` is invalid: must be a positive integer.');
    expect(err.nextAction.endsWith('..')).toBe(false);
  });
});

describe('ApiError.getDetail', () => {
  function makeErr(details: Record<string, unknown>): ApiError {
    return ApiError.fromEnvelope({
      error: {
        code: 'PRECONDITION_FAILED',
        message: 'Conflict.',
        nextAction: 'retry',
        requestId: 'req_x',
        details,
      },
    });
  }

  it('returns undefined when details is an empty object and key is absent', () => {
    const err = makeErr({});
    expect(err.getDetail('currentCodeVersion')).toBeUndefined();
  });

  it('returns the value when key exists', () => {
    const err = makeErr({ currentCodeVersion: 'v5' });
    expect(err.getDetail('currentCodeVersion')).toBe('v5');
  });

  it('returns undefined when validator rejects the value', () => {
    const err = makeErr({ currentCodeVersion: 42 });
    const result = err.getDetail<string>(
      'currentCodeVersion',
      (v): v is string => typeof v === 'string',
    );
    expect(result).toBeUndefined();
  });

  it('returns typed value when validator accepts', () => {
    const err = makeErr({ currentCodeVersion: 'v7' });
    const result = err.getDetail<string>(
      'currentCodeVersion',
      (v): v is string => typeof v === 'string',
    );
    expect(result).toBe('v7');
  });

  it('returns undefined for an ApiError whose details parsed as empty object (null-body path)', () => {
    // When the server sends a 412 with no body, details defaults to {}
    const err = ApiError.fromEnvelope(null, 412);
    expect(err.getDetail('currentCodeVersion')).toBeUndefined();
  });
});

describe('TransportError', () => {
  it('maps to UNAVAILABLE / exit 10', () => {
    const err = new TransportError('TLS handshake failed');
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.exitCode).toBe(10);
    expect(err.message).toBe('TLS handshake failed');
  });
});

describe('RequestTimeoutError', () => {
  it('maps to exit 7 (UNSUPPORTED bucket)', () => {
    const err = new RequestTimeoutError(120_000);
    expect(err.exitCode).toBe(7);
    expect(err.name).toBe('RequestTimeoutError');
    expect(err).toBeInstanceOf(CLIError);
  });

  it('message mentions the timeout in seconds and the --request-timeout flag', () => {
    const err = new RequestTimeoutError(120_000);
    expect(err.message).toContain('120s');
    expect(err.message).toContain('--request-timeout');
    expect(err.message).toContain('TESTSPRITE_REQUEST_TIMEOUT_MS');
  });

  it('exposes timeoutMs and requestId', () => {
    const err = new RequestTimeoutError(30_000, 'cli_abc123');
    expect(err.timeoutMs).toBe(30_000);
    expect(err.requestId).toBe('cli_abc123');
  });

  it('defaults requestId to "local" when not supplied', () => {
    const err = new RequestTimeoutError(5_000);
    expect(err.requestId).toBe('local');
  });

  it('rounds timeout to the nearest second in the message', () => {
    // 1500ms → 2s in the message
    const err = new RequestTimeoutError(1_500);
    expect(err.message).toContain('2s');
  });
});

describe('INSUFFICIENT_CREDITS detection', () => {
  // (a) Credits envelope → INSUFFICIENT_CREDITS code + exit 12
  it('credits envelope (details.required present) → INSUFFICIENT_CREDITS / exit 12', () => {
    const err = ApiError.fromEnvelope(
      {
        error: {
          code: 'RATE_LIMITED',
          message:
            'Insufficient credits: 2 credit(s) required. Top up at https://www.testsprite.com/settings/billing.',
          nextAction: 'Top up at https://www.testsprite.com/settings/billing.',
          requestId: 'req_cred_1',
          details: { required: 2, userId: 'u_1' },
        },
      },
      429,
    );
    expect(err.code).toBe('INSUFFICIENT_CREDITS');
    expect(err.exitCode).toBe(12);
    expect(err.message).toContain('Insufficient credits');
    expect(err.nextAction).toContain('settings/billing');
  });

  it('credits envelope — message-only signal (no details.required)', () => {
    const err = ApiError.fromEnvelope(
      {
        error: {
          code: 'RATE_LIMITED',
          message: 'Insufficient credits: please top up.',
          nextAction: '',
          requestId: 'req_cred_2',
          details: {},
        },
      },
      429,
    );
    expect(err.code).toBe('INSUFFICIENT_CREDITS');
    expect(err.exitCode).toBe(12);
    // No nextAction from backend AND no apiUrl → synthesized billing hint is
    // route-only (no hardcoded domain — the right portal host is unknown).
    // Pin the real route (/dashboard/settings/billing — bare /settings/billing 404s).
    expect(err.nextAction).toContain('(/dashboard/settings/billing)');
    expect(err.nextAction).toContain('(/pricing)');
    expect(err.nextAction).not.toContain('https://');
  });

  // V3 API keys are membership-bound: a team-org key spends that org's
  // wallet, not the personal one. The CLI has no way to know which kind of
  // key just failed here (this is a client-side synthesis with no backend
  // nextAction), so the synthesized hint must not assert the personal
  // billing page is the ONLY fix — it should also point an org-bound caller
  // at their org admin instead of silently sending them to top up the wrong
  // wallet.
  it('synthesized billing hint does not assert a personal-only path (org-bound key wording)', () => {
    const err = ApiError.fromEnvelope(
      {
        error: {
          code: 'RATE_LIMITED',
          message: 'Insufficient credits: please top up.',
          nextAction: '',
          requestId: 'req_cred_org',
          details: {},
        },
      },
      429,
    );
    expect(err.nextAction.toLowerCase()).toContain('org admin');
    // The personal-key link is still offered — it's a real, correct fix for
    // the common case, just no longer presented as the only one.
    expect(err.nextAction).toContain('(/dashboard/settings/billing)');
  });

  it('synthesized billing link resolves the PROD portal from a prod apiUrl', () => {
    const err = ApiError.fromEnvelope(
      {
        error: {
          code: 'RATE_LIMITED',
          message: 'Insufficient credits: please top up.',
          nextAction: '',
          requestId: 'req_cred_prod',
          details: {},
        },
      },
      429,
      undefined,
      'https://api.testsprite.com/api/cli/v1',
    );
    expect(err.nextAction).toContain('https://www.testsprite.com/dashboard/settings/billing');
    expect(err.nextAction).toContain('https://www.testsprite.com/pricing');
  });

  it('synthesized billing link honors the TESTSPRITE_PORTAL_URL override', () => {
    vi.stubEnv('TESTSPRITE_PORTAL_URL', 'https://portal.internal.example.com');
    try {
      const err = ApiError.fromEnvelope(
        {
          error: {
            code: 'RATE_LIMITED',
            message: 'Insufficient credits: please top up.',
            nextAction: '',
            requestId: 'req_cred_dev',
            details: {},
          },
        },
        429,
        undefined,
        'https://api.example.com:8443/api/cli/v1',
      );
      expect(err.nextAction).toContain(
        'https://portal.internal.example.com/dashboard/settings/billing',
      );
      expect(err.nextAction).not.toContain('www.testsprite.com');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('credits envelope — details.required-only signal (message does not mention credits)', () => {
    const err = ApiError.fromEnvelope(
      {
        error: {
          code: 'RATE_LIMITED',
          message: 'Insufficient credits: 5 credit(s) required.',
          nextAction: '',
          requestId: 'req_cred_3',
          details: { required: 5 },
        },
      },
      429,
    );
    expect(err.code).toBe('INSUFFICIENT_CREDITS');
    expect(err.exitCode).toBe(12);
  });

  it('preserves nextAction from backend when supplied', () => {
    const err = ApiError.fromEnvelope(
      {
        error: {
          code: 'RATE_LIMITED',
          message: 'Insufficient credits: 2 credit(s) required.',
          nextAction: 'Top up at https://www.testsprite.com/settings/billing.',
          requestId: 'req_cred_4',
          details: { required: 2 },
        },
      },
      429,
    );
    expect(err.nextAction).toBe('Top up at https://www.testsprite.com/settings/billing.');
  });

  // Genuine per-minute throttle must NOT be re-mapped
  it('genuine throttle (Run trigger rate limit exceeded) stays RATE_LIMITED / exit 11', () => {
    const err = ApiError.fromEnvelope(
      {
        error: {
          code: 'RATE_LIMITED',
          message: 'Run trigger rate limit exceeded: 60 triggers per minute per key.',
          nextAction: 'Wait Retry-After seconds and retry.',
          requestId: 'req_rl_1',
          details: { scope: 'key', retryAfterSec: 30 },
        },
      },
      429,
    );
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.exitCode).toBe(11);
  });

  it('throttle with details.required=0 stays RATE_LIMITED (zero is not a credit cost)', () => {
    const err = ApiError.fromEnvelope(
      {
        error: {
          code: 'RATE_LIMITED',
          message: 'Run trigger rate limit exceeded.',
          nextAction: '',
          requestId: 'req_rl_2',
          details: { required: 0 },
        },
      },
      429,
    );
    // required=0 is not a valid credit cost; stays RATE_LIMITED
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.exitCode).toBe(11);
  });
});

describe('AMBIGUOUS_ORG detection (409 CONFLICT + reason: ambiguous_org)', () => {
  it('remaps a CONFLICT envelope with details.reason === "ambiguous_org" to AMBIGUOUS_ORG / exit 6', () => {
    const err = ApiError.fromEnvelope(
      {
        error: {
          code: 'CONFLICT',
          message: 'Test id "test_x" resolves in more than one of your organizations.',
          nextAction: 'Open the specific project in the Portal, or contact support.',
          requestId: 'req_ambig_1',
          details: {
            reason: 'ambiguous_org',
            testId: 'test_x',
            candidates: [
              { projectId: 'project_a', orgId: 'org_a' },
              { projectId: 'project_b', orgId: 'org_b' },
            ],
          },
        },
      },
      409,
    );
    expect(err.code).toBe('AMBIGUOUS_ORG');
    expect(err.exitCode).toBe(6);
    // Message/nextAction pass through verbatim — the backend already
    // supplies an actionable template, unlike the INSUFFICIENT_CREDITS
    // sub-case which sometimes synthesizes one for older backends.
    expect(err.message).toContain('resolves in more than one of your organizations');
    expect(err.nextAction).toContain('Open the specific project');
    expect(err.getDetail('testId')).toBe('test_x');
    expect(err.getDetail('candidates')).toEqual([
      { projectId: 'project_a', orgId: 'org_a' },
      { projectId: 'project_b', orgId: 'org_b' },
    ]);
  });

  it('a plain CONFLICT (snapshot in flight, no ambiguous_org reason) stays CONFLICT / exit 6', () => {
    const err = ApiError.fromEnvelope(
      {
        error: {
          code: 'CONFLICT',
          message: 'Snapshot in flight; retry shortly.',
          nextAction: 'Retry in a few seconds.',
          requestId: 'req_conflict_1',
          details: { reason: 'snapshot_in_flight' },
        },
      },
      409,
    );
    expect(err.code).toBe('CONFLICT');
    expect(err.exitCode).toBe(6);
  });

  it('a CONFLICT with an unrelated reason string stays CONFLICT (not falsely remapped)', () => {
    const err = ApiError.fromEnvelope(
      {
        error: {
          code: 'CONFLICT',
          message: 'Another run is already in flight.',
          nextAction: 'Poll it with test wait.',
          requestId: 'req_conflict_2',
          details: { reason: 'run_in_flight', currentRunId: 'run_abc' },
        },
      },
      409,
    );
    expect(err.code).toBe('CONFLICT');
  });
});
