import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from '../lib/errors.js';
import { createProjectCommand } from './project.js';
import { runSignInGet, runSignInSet, type CliProjectSignInResponse } from './project-sign-in.js';

const secret = 'PASSWORD_DO_NOT_PRINT';
const common = {
  profile: 'default',
  output: 'json' as const,
  debug: false,
  verbose: false,
  dryRun: false,
  projectId: 'project /one',
};
const environment = {
  id: 'env_1',
  name: 'default',
  url: 'https://app.example.com',
  isDefault: true,
  authMode: 'public',
  hasCredentials: false,
  username: null,
  enableOtp: false,
  updatedAt: '2026-09-25T00:00:00Z',
};
const response: CliProjectSignInResponse = {
  projectId: common.projectId,
  environment,
  signIn: { mode: 'public', account: null, otp: null, manual: null },
  nextAction: null,
};

function harness(body: unknown = response, status = 200) {
  const calls: Array<{ url: string; method: string; body: unknown; key: string | null }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      key: new Headers(init?.headers).get('idempotency-key'),
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    calls,
    stdout,
    stderr,
    deps: {
      env: { TESTSPRITE_API_KEY: 'sk-user-test', TESTSPRITE_API_URL: 'https://api.example.com' },
      fetchImpl,
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
  };
}

describe('project sign-in', () => {
  it('registers get and set under project', () => {
    const group = createProjectCommand().commands.find(c => c.name() === 'sign-in');
    expect(group?.commands.map(c => c.name())).toEqual(['get', 'set']);
  });

  it.each([undefined, 'QA / west'])(
    'GET encodes project and optional environment %s',
    async env => {
      const h = harness();
      await runSignInGet({ ...common, env }, h.deps);
      expect(h.calls).toEqual([
        {
          url: `https://api.example.com/api/cli/v1/projects/project%20%2Fone/sign-in${env ? '?environment=QA+%2F+west' : ''}`,
          method: 'GET',
          body: undefined,
          key: null,
        },
      ]);
      expect(JSON.parse(h.stdout.join('\n'))).toEqual(response);
    },
  );

  it.each([
    ['public', 'public', {}],
    ['none', 'public', {}],
    ['account', 'account', { username: 'qa', password: secret }],
    ['credentials', 'account', { username: 'qa', password: secret }],
    ['manual', 'manual', { sessionReuseTtlSeconds: 3600 }],
    ['sso', 'manual', { sessionReuseTtlSeconds: 3600 }],
    ['otp', 'otp', {}],
  ])('PUT mode %s as %s', async (mode, canonical, fields) => {
    const h = harness();
    await runSignInSet(
      {
        ...common,
        mode,
        env: 'QA / west',
        ...(canonical === 'account' ? { username: 'qa', password: secret } : {}),
        ...(canonical === 'manual' ? { sessionTtl: '3600' } : {}),
      },
      h.deps,
    );
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      url: 'https://api.example.com/api/cli/v1/projects/project%20%2Fone/sign-in',
      method: 'PUT',
    });
    expect(h.calls[0]!.body).toEqual({ environment: 'QA / west', mode: canonical, ...fields });
    expect(h.calls[0]!.key).toMatch(/^cli-proj-signin-set-[\da-f-]{36}$/);
    expect(h.stdout.join('\n') + h.stderr.join('\n')).not.toContain(secret);
  });

  it('honors an explicit idempotency key without echoing it', async () => {
    const h = harness();
    await runSignInSet({ ...common, mode: 'public', idempotencyKey: 'user-key' }, h.deps);
    expect(h.calls[0]!.key).toBe('user-key');
    expect(h.stderr.join('\n')).not.toContain('user-key');
  });

  it.each([
    [{ mode: 'bad' }, 'public'],
    [
      { mode: undefined },
      '--mode is required: public, account or manual (otp can only be chosen with `project env create --sign-in otp`)',
    ],
    [{ mode: 'public', username: 'qa' }, '--username'],
    [{ mode: 'otp', password: secret }, '--password'],
    [{ mode: 'manual', passwordFile: '/missing' }, '--password-file'],
    [{ mode: 'account', sessionTtl: '30' }, '--session-ttl'],
    [{ mode: 'account', password: secret, passwordFile: '/missing' }, 'mutually exclusive'],
    [{ mode: 'manual', sessionTtl: '0' }, '--session-ttl'],
    [{ mode: 'manual', sessionTtl: '2592001' }, '--session-ttl'],
    [{ mode: 'manual', sessionTtl: '1.5' }, '--session-ttl'],
  ])('rejects invalid flag combination %j before I/O', async (flags, hint) => {
    const h = harness();
    const error = (await runSignInSet({ ...common, ...flags }, h.deps).catch(e => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.exitCode).toBe(5);
    expect(`${error.message} ${error.nextAction}`).toContain(hint);
    expect(h.calls).toEqual([]);
    expect(h.stdout.join('\n') + h.stderr.join('\n')).not.toContain(secret);
    if ('passwordFile' in flags && flags.passwordFile === '/missing')
      expect(error.details.reason).toBe('invalid_sign_in_flags');
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'rejects inherited mode %s before I/O',
    async mode => {
      const h = harness();
      const error = (await runSignInSet({ ...common, mode }, h.deps).catch(e => e)) as ApiError;
      expect(error).toBeInstanceOf(ApiError);
      expect(error.exitCode).toBe(5);
      expect(error.details.reason).toBe('invalid_sign_in_flags');
      expect(h.calls).toEqual([]);
    },
  );

  it.each(['', '   '])('rejects blank --env %j on get and set before I/O', async env => {
    const h = harness();
    for (const action of [
      runSignInGet({ ...common, env }, h.deps),
      runSignInSet({ ...common, mode: 'public', env }, h.deps),
    ]) {
      const error = (await action.catch(e => e)) as ApiError;
      expect(error.exitCode).toBe(5);
      expect(error.nextAction).toContain('--env must not be empty or whitespace-only.');
    }
    expect(h.calls).toEqual([]);
  });

  it.each([
    ['never', -1],
    ['1', 1],
    ['2592000', 2592000],
  ])('parses TTL %s', async (sessionTtl, value) => {
    const h = harness();
    await runSignInSet({ ...common, mode: 'manual', sessionTtl }, h.deps);
    expect(h.calls[0]!.body).toEqual({ mode: 'manual', sessionReuseTtlSeconds: value });
  });

  it('dry-run does not read a missing password file or fetch', async () => {
    const h = harness();
    await runSignInSet(
      { ...common, dryRun: true, mode: 'account', passwordFile: '/missing' },
      h.deps,
    );
    expect(h.calls).toEqual([]);
  });

  it('reads a password file on the real path without printing its contents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-signin-'));
    const passwordFile = join(dir, 'password');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture path built from this test's own mkdtempSync() dir, never user input
    writeFileSync(passwordFile, `${secret}\n`, { mode: 0o600 });
    const h = harness();
    await runSignInSet({ ...common, mode: 'account', username: 'qa', passwordFile }, h.deps);
    expect(h.calls[0]!.body).toEqual({ mode: 'account', username: 'qa', password: secret });
    expect(h.stdout.join('\n') + h.stderr.join('\n')).not.toContain(secret);
  });

  it('redacts an echoed password from server errors', async () => {
    const h = harness(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: `Rejected ${secret}`,
          nextAction: `Replace ${secret}`,
          requestId: 'req_1',
          details: { value: secret },
        },
      },
      400,
    );
    const error = (await runSignInSet(
      { ...common, mode: 'account', username: 'qa', password: secret },
      h.deps,
    ).catch(e => e)) as ApiError;
    expect(
      JSON.stringify({
        message: error.message,
        nextAction: error.nextAction,
        details: error.details,
      }),
    ).not.toContain(secret);
    expect(error.code).toBe('VALIDATION_ERROR');
  });

  it('redacts an echoed password containing JSON escape characters', async () => {
    const trickyPassword = 'ab"\\cd';
    const h = harness(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Rejected',
          nextAction: 'Try again',
          requestId: 'req_1',
          details: { nested: { value: trickyPassword } },
        },
      },
      400,
    );
    const error = (await runSignInSet(
      { ...common, mode: 'account', username: 'qa', password: trickyPassword },
      h.deps,
    ).catch(e => e)) as ApiError;
    expect((error.details.nested as { value: string }).value).toBe('[REDACTED]');
  });

  it.each([
    ['text' as const, false, false],
    ['text' as const, true, false],
    ['text' as const, false, true],
    ['json' as const, false, false],
  ])(
    'never prints the supplied password in %s output (verbose=%s, debug=%s)',
    async (output, verbose, debug) => {
      const h = harness({
        ...response,
        signIn: {
          mode: 'account',
          account: { username: 'qa', passwordSet: true },
          otp: null,
          manual: null,
        },
        changed: true,
      });
      await runSignInSet(
        { ...common, output, verbose, debug, mode: 'account', username: 'qa', password: secret },
        h.deps,
      );
      expect(h.stdout.join('\n') + h.stderr.join('\n')).not.toContain(secret);
    },
  );

  it.each([
    [{ mode: 'public', account: null, otp: null, manual: null }, 'public — No sign-in'],
    [
      { mode: 'account', account: { username: 'qa', passwordSet: true }, otp: null, manual: null },
      'Password',
    ],
    [
      {
        mode: 'otp',
        account: null,
        otp: { channels: ['email', 'sms'], email: 'inbox@example.com', phone: '+123' },
        manual: null,
      },
      'Channels',
    ],
    [
      {
        mode: 'manual',
        account: null,
        otp: null,
        manual: {
          sessionReuseTtlSeconds: -1,
          hasValidSession: false,
          needsReauth: true,
          reason: 'never',
          capturedAt: null,
          expiresAt: null,
        },
      },
      'runs will NOT be signed in',
    ],
  ])('renders mode %s with %s', async (signIn, expected) => {
    const h = harness({ ...response, signIn, nextAction: 'Open the Portal' });
    await runSignInGet({ ...common, output: 'text' }, h.deps);
    expect(h.stdout.join('\n')).toContain(expected);
    expect(h.stdout.join('\n')).toContain('Next');
    expect(h.stdout.join('\n')).not.toContain(secret);
  });

  it('shows a captured SSO session and its expiration', async () => {
    const h = harness({
      ...response,
      signIn: {
        mode: 'manual',
        account: null,
        otp: null,
        manual: {
          sessionReuseTtlSeconds: 3600,
          hasValidSession: true,
          needsReauth: false,
          reason: null,
          capturedAt: '2026-09-25T00:00:00Z',
          expiresAt: '2026-09-25T01:00:00Z',
        },
      },
    });
    await runSignInGet({ ...common, output: 'text' }, h.deps);
    expect(h.stdout.join('\n')).toContain('Session TTL  1h');
    expect(h.stdout.join('\n')).toContain(
      'Session      valid until 2026-09-25T01:00:00Z — captured 2026-09-25T00:00:00Z',
    );
    expect(h.stdout.join('\n')).not.toContain('will NOT be signed in');
  });

  it.each([
    [
      {
        sessionReuseTtlSeconds: -1,
        hasValidSession: true,
        needsReauth: false,
        reason: null,
        capturedAt: '2026-09-25T00:00:00Z',
        expiresAt: null,
      },
      'valid (never expires) — captured 2026-09-25T00:00:00Z',
    ],
    [
      {
        sessionReuseTtlSeconds: -1,
        hasValidSession: true,
        needsReauth: false,
        reason: null,
        capturedAt: null,
        expiresAt: '2026-09-25T01:00:00Z',
      },
      'valid (never expires)',
    ],
    [
      {
        sessionReuseTtlSeconds: 3600,
        hasValidSession: false,
        needsReauth: true,
        reason: 'expired',
        capturedAt: '2026-09-25T00:00:00Z',
        expiresAt: '2026-09-25T01:00:00Z',
      },
      'expired 2026-09-25T01:00:00Z — runs will NOT be signed in until someone logs in again',
    ],
    [
      {
        sessionReuseTtlSeconds: 3600,
        hasValidSession: false,
        needsReauth: true,
        reason: 'never',
        capturedAt: null,
        expiresAt: null,
      },
      'none captured yet — runs will NOT be signed in until someone logs in once',
    ],
  ] as const)('renders SSO session state %j', async (manual, expected) => {
    const h = harness({
      ...response,
      signIn: { mode: 'manual', account: null, otp: null, manual },
    });
    await runSignInGet({ ...common, output: 'text' }, h.deps);
    expect(h.stdout.join('\n')).toContain(`Session      ${expected}`);
  });

  it('shows the uncaptured warning when manual session details are absent', async () => {
    const h = harness({
      ...response,
      signIn: { mode: 'manual', account: null, otp: null, manual: null },
    });
    await runSignInGet({ ...common, output: 'text' }, h.deps);
    expect(h.stdout.join('\n')).toContain(
      'Session      none captured yet — runs will NOT be signed in until someone logs in once',
    );
  });

  it('previews an existing OTP environment as unchanged', async () => {
    const h = harness();
    const result = await runSignInSet({ ...common, mode: 'otp', dryRun: true }, h.deps);
    expect(result.environment.authMode).toBe('otp');
    expect(result.changed).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it('preserves server error code, message, and next action', async () => {
    const h = harness(
      {
        error: {
          code: 'PRECONDITION_FAILED',
          message: 'OTP is fixed at creation',
          nextAction: 'Create a new environment',
          requestId: 'req_1',
          details: { reason: 'otp-fixed-at-creation' },
        },
      },
      412,
    );
    const error = (await runSignInSet({ ...common, mode: 'otp' }, h.deps).catch(
      e => e,
    )) as ApiError;
    expect(error.code).toBe('PRECONDITION_FAILED');
    expect(error.message).toContain('OTP is fixed');
    expect(error.nextAction).toContain('Create a new environment');
  });
});
