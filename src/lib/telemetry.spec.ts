import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CommanderError } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CLIError, InterruptError, RequestTimeoutError } from './errors.js';
import { VERSION } from '../version.js';
import {
  batchOutcomeCounts,
  buildCiContext,
  buildTelemetryEvent,
  classifyCliError,
  detectCiEvent,
  detectCiProvider,
  hashRepository,
  isTelemetryOptedOut,
  recordBatchOutcome,
  recordOutcome,
  recordTelemetryExtras,
  resolveTelemetryAuth,
  sanitizeTelemetryExtras,
  takeTelemetryExtras,
} from './telemetry.js';

afterEach(() => {
  // The extras sink is process-wide; never let one case's facts leak into the next.
  takeTelemetryExtras();
});

function writeCreds(withKey: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-telemetry-'));
  const p = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  const body = withKey
    ? `[default]\napi_url = https://api.example.com\napi_key = sk-user-test\n`
    : `[default]\napi_url = https://api.example.com\n`;
  writeFileSync(p, body, { mode: 0o600 });
  return p;
}

function okResponse(): Response {
  return new Response(null, { status: 204 });
}

// ---------------------------------------------------------------------------
// classifyCliError — mirrors index.ts's exit-code mapping
// ---------------------------------------------------------------------------

describe('classifyCliError', () => {
  it('InterruptError → abort + INTERRUPTED + its exit code + client origin', () => {
    expect(classifyCliError(new InterruptError('SIGINT'))).toEqual({
      outcome: 'abort',
      exitCode: 130,
      errorCode: 'INTERRUPTED',
      errorOrigin: 'client',
    });
  });

  it('RequestTimeoutError → error + REQUEST_TIMEOUT + exit 7 + client origin + timeoutSeconds', () => {
    expect(classifyCliError(new RequestTimeoutError(1000))).toEqual({
      outcome: 'error',
      exitCode: 7,
      errorCode: 'REQUEST_TIMEOUT',
      errorOrigin: 'client',
      timeoutSeconds: 1,
    });
  });

  it('ApiError with no httpStatus (client-fabricated envelope) → client origin', () => {
    // ApiError.authRequired() is a LOCAL fabrication (missing-key pre-flight
    // check) — no HTTP round trip ever happened, so httpStatus is undefined.
    const err = ApiError.authRequired();
    expect(err.httpStatus).toBeUndefined();
    expect(classifyCliError(err)).toEqual({
      outcome: 'error',
      exitCode: err.exitCode,
      errorCode: err.code,
      errorOrigin: 'client',
    });
  });

  it('ApiError with httpStatus set (a real backend response) → server origin', () => {
    // Mirrors what http.ts does on a genuine non-OK response: it always
    // passes response.status into ApiError.fromEnvelope.
    const err = ApiError.fromEnvelope(
      { error: { code: 'NOT_FOUND', message: 'gone', nextAction: '', requestId: 'req_real_1' } },
      404,
    );
    expect(classifyCliError(err)).toEqual({
      outcome: 'error',
      exitCode: err.exitCode,
      errorCode: 'NOT_FOUND',
      errorOrigin: 'server',
    });
  });

  // Regression guard for the discriminator itself: `requestId` is NOT a
  // reliable client/server signal on its own. http.ts stamps every OUTGOING
  // request with a real generated x-request-id (see newRequestId() in
  // http.ts) BEFORE it knows whether a response will ever arrive — so
  // TransportError (DNS/TLS failure, never got a response) carries a real,
  // non-'local' requestId despite being 100% client-side. Only `httpStatus`
  // (set exclusively from an actual Response) tells the truth.
  it('ApiError with a real (non-"local") requestId but NO httpStatus still classifies as client', () => {
    const err = ApiError.fromEnvelope({
      error: {
        code: 'UNAVAILABLE',
        message: 'network down',
        nextAction: '',
        requestId: 'cli_generated_abc123',
      },
    });
    expect(err.httpStatus).toBeUndefined();
    expect(classifyCliError(err).errorOrigin).toBe('client');
  });

  it('ApiError surfaces timeoutSeconds from details when present (the --wait timeout→UNSUPPORTED conversion)', () => {
    const err = ApiError.fromEnvelope({
      error: {
        code: 'UNSUPPORTED',
        message: 'Timed out after 30s waiting for run run_abc.',
        nextAction: 'Resume polling: testsprite test wait run_abc',
        requestId: 'local',
        details: { runId: 'run_abc', timeoutSeconds: 30 },
      },
    });
    expect(classifyCliError(err)).toEqual({
      outcome: 'error',
      exitCode: 7,
      errorCode: 'UNSUPPORTED',
      errorOrigin: 'client',
      timeoutSeconds: 30,
    });
  });

  it('CommanderError help/version → success + exit 0 (no errorCode)', () => {
    expect(classifyCliError(new CommanderError(0, 'commander.helpDisplayed', ''))).toEqual({
      outcome: 'success',
      exitCode: 0,
    });
    expect(classifyCliError(new CommanderError(0, 'commander.version', ''))).toEqual({
      outcome: 'success',
      exitCode: 0,
    });
  });

  it('CommanderError parse error → error + VALIDATION_ERROR + exit 5 + client origin', () => {
    expect(classifyCliError(new CommanderError(1, 'commander.unknownCommand', 'nope'))).toEqual({
      outcome: 'error',
      exitCode: 5,
      errorCode: 'VALIDATION_ERROR',
      errorOrigin: 'client',
    });
  });

  // This was one of the two silent-errorCode fallback branches (a plain
  // CLIError previously reported no errorCode at all — errorCode=None).
  it('CLIError → error + its exit code + its code (CLI_ERROR default) + client origin', () => {
    expect(classifyCliError(new CLIError('boom', 4))).toEqual({
      outcome: 'error',
      exitCode: 4,
      errorCode: 'CLI_ERROR',
      errorOrigin: 'client',
    });
  });

  it('CLIError with a custom code propagates it', () => {
    expect(classifyCliError(new CLIError('boom', 4, 'MY_CODE'))).toEqual({
      outcome: 'error',
      exitCode: 4,
      errorCode: 'MY_CODE',
      errorOrigin: 'client',
    });
  });

  // The second silent-errorCode fallback branch — a genuinely
  // uncaught, non-CLIError exception. Node built-in errors (fs, net) carry a
  // real `.code` (ENOENT, ECONNREFUSED, …); surface it instead of nothing.
  it('unknown error with a Node-style `.code` → that code + exit 1 + client origin', () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    expect(classifyCliError(err)).toEqual({
      outcome: 'error',
      exitCode: 1,
      errorCode: 'ENOENT',
      errorOrigin: 'client',
    });
  });

  it('unknown error with no `.code` → UNCAUGHT_EXCEPTION + exit 1 + client origin', () => {
    expect(classifyCliError(new Error('weird'))).toEqual({
      outcome: 'error',
      exitCode: 1,
      errorCode: 'UNCAUGHT_EXCEPTION',
      errorOrigin: 'client',
    });
  });

  it('a non-Error thrown value → UNCAUGHT_EXCEPTION + exit 1 + client origin', () => {
    expect(classifyCliError('a string was thrown')).toEqual({
      outcome: 'error',
      exitCode: 1,
      errorCode: 'UNCAUGHT_EXCEPTION',
      errorOrigin: 'client',
    });
  });
});

// ---------------------------------------------------------------------------
// isTelemetryOptedOut
// ---------------------------------------------------------------------------

describe('isTelemetryOptedOut', () => {
  it('opts out on TESTSPRITE_NO_TELEMETRY or DO_NOT_TRACK truthy values', () => {
    expect(isTelemetryOptedOut({ TESTSPRITE_NO_TELEMETRY: '1' })).toBe(true);
    expect(isTelemetryOptedOut({ DO_NOT_TRACK: '1' })).toBe(true);
    expect(isTelemetryOptedOut({ DO_NOT_TRACK: 'true' })).toBe(true);
  });

  it('does NOT opt out for unset / "0" / "false" / empty', () => {
    expect(isTelemetryOptedOut({})).toBe(false);
    expect(isTelemetryOptedOut({ DO_NOT_TRACK: '0' })).toBe(false);
    expect(isTelemetryOptedOut({ TESTSPRITE_NO_TELEMETRY: 'false' })).toBe(false);
    expect(isTelemetryOptedOut({ TESTSPRITE_NO_TELEMETRY: '' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildTelemetryEvent — allowlist only, no PII
// ---------------------------------------------------------------------------

describe('buildTelemetryEvent', () => {
  it('emits only allowlisted fields; never a url or message', () => {
    const event = buildTelemetryEvent(
      {
        command: 'test run',
        outcome: 'error',
        exitCode: 5,
        errorCode: 'VALIDATION_ERROR',
        durationMs: 42,
        output: 'json',
        endpointUrl: 'https://secret.internal',
        profile: 'work',
      },
      { CI: '1' },
      false,
    );
    expect(event).toEqual({
      command: 'test run',
      outcome: 'error',
      exitCode: 5,
      errorCode: 'VALIDATION_ERROR',
      durationMs: 42,
      cliVersion: expect.any(String),
      os: process.platform,
      nodeVersion: process.versions.node,
      output: 'json',
      ci: true,
      ciProvider: 'other',
    });
    // Allowlist backstop: nothing sensitive leaked through.
    expect(event).not.toHaveProperty('endpointUrl');
    expect(event).not.toHaveProperty('profile');
    expect(event).not.toHaveProperty('message');
    expect(event).not.toHaveProperty('client');
    expect(event).not.toHaveProperty('repoHash');
  });

  it('ci=true when non-TTY even without CI env; omits errorCode when absent', () => {
    const event = buildTelemetryEvent(
      { command: 'test list', outcome: 'success', exitCode: 0, durationMs: 1 },
      {},
      false,
    );
    expect(event.ci).toBe(true);
    expect(event).not.toHaveProperty('errorCode');
  });

  // errorOrigin is the field that resolves the UNSUPPORTED
  // client/server ambiguity — included only when the caller supplies it.
  it('includes errorOrigin and timeoutSeconds when supplied', () => {
    const event = buildTelemetryEvent(
      {
        command: 'test wait',
        outcome: 'error',
        exitCode: 7,
        errorCode: 'UNSUPPORTED',
        errorOrigin: 'client',
        timeoutSeconds: 30,
        durationMs: 30_000,
      },
      {},
      false,
    );
    expect(event.errorOrigin).toBe('client');
    expect(event.timeoutSeconds).toBe(30);
  });

  it('omits errorOrigin and timeoutSeconds when absent', () => {
    const event = buildTelemetryEvent(
      { command: 'test list', outcome: 'success', exitCode: 0, durationMs: 1 },
      {},
      false,
    );
    expect(event).not.toHaveProperty('errorOrigin');
    expect(event).not.toHaveProperty('timeoutSeconds');
  });

  it('a "server" errorOrigin is preserved verbatim (not coerced to client)', () => {
    const event = buildTelemetryEvent(
      {
        command: 'test run',
        outcome: 'error',
        exitCode: 7,
        errorCode: 'UNSUPPORTED',
        errorOrigin: 'server',
        durationMs: 5,
      },
      {},
      false,
    );
    expect(event.errorOrigin).toBe('server');
  });

  it('emits local: true for a --local invocation', () => {
    const event = buildTelemetryEvent(
      { command: 'test run', outcome: 'success', exitCode: 0, durationMs: 1, local: true },
      {},
      false,
    );
    expect(event.local).toBe(true);
  });

  it('omits the local key entirely for an ordinary invocation', () => {
    const event = buildTelemetryEvent(
      { command: 'test list', outcome: 'success', exitCode: 0, durationMs: 1 },
      {},
      false,
    );
    expect(event).not.toHaveProperty('local');
  });
});

// ---------------------------------------------------------------------------
// recordOutcome — gates + POST shape + best-effort
// ---------------------------------------------------------------------------

describe('recordOutcome', () => {
  const base = { command: 'test run', outcome: 'success' as const, exitCode: 0, durationMs: 42 };

  it('POSTs the event to the beacon when authenticated', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await recordOutcome(
      { ...base, output: 'json' },
      { env: {}, credentialsPath: writeCreds(true), fetchImpl, isTTY: true },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/cli\/v1\/telemetry$/);
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-user-test');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.command).toBe('test run');
    expect(body.outcome).toBe('success');
    expect(body.ci).toBe(false);
    expect(body).not.toHaveProperty('endpointUrl');
  });

  it('POST body carries local: true for a --local invocation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await recordOutcome(
      { ...base, local: true },
      { env: {}, credentialsPath: writeCreds(true), fetchImpl },
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.local).toBe(true);
  });

  it('POST body has no local key for an ordinary (non --local) invocation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await recordOutcome(base, { env: {}, credentialsPath: writeCreds(true), fetchImpl });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('local');
  });

  // The whole point of this field: a --local invocation that never reached
  // the network (a client-side, pre-mint refusal) must still report
  // local: true — those are exactly the attempts a backend-side
  // mint/attach event can never see.
  it('POST body carries local: true even for an outcome the network never saw', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await recordOutcome(
      {
        command: 'test run',
        outcome: 'error',
        exitCode: 5,
        errorCode: 'VALIDATION_ERROR',
        durationMs: 3,
        local: true,
      },
      { env: {}, credentialsPath: writeCreds(true), fetchImpl },
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.local).toBe(true);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('skips when opted out (DO_NOT_TRACK)', async () => {
    const fetchImpl = vi.fn();
    await recordOutcome(base, {
      env: { DO_NOT_TRACK: '1' },
      credentialsPath: writeCreds(true),
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips under --dry-run', async () => {
    const fetchImpl = vi.fn();
    await recordOutcome(
      { ...base, dryRun: true },
      { env: {}, credentialsPath: writeCreds(true), fetchImpl },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips on the abort path (Ctrl-C stays snappy)', async () => {
    const fetchImpl = vi.fn();
    await recordOutcome(
      { ...base, outcome: 'abort', exitCode: 130, errorCode: 'INTERRUPTED' },
      { env: {}, credentialsPath: writeCreds(true), fetchImpl },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips when no leaf command ran', async () => {
    const fetchImpl = vi.fn();
    await recordOutcome(
      { ...base, command: '' },
      { env: {}, credentialsPath: writeCreds(true), fetchImpl },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips when no api-key is configured (authenticated-only)', async () => {
    const fetchImpl = vi.fn();
    await recordOutcome(base, { env: {}, credentialsPath: writeCreds(false), fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is best-effort — a fetch rejection never propagates', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(
      recordOutcome(base, { env: {}, credentialsPath: writeCreds(true), fetchImpl }),
    ).resolves.toBeUndefined();
  });

  it('uses pre-resolved auth and never reads the credentials file', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await recordOutcome(base, {
      env: {},
      // Bogus path: if it were read, no key would resolve and the POST would skip.
      credentialsPath: join(tmpdir(), 'cli-telemetry-missing', 'credentials'),
      resolvedAuth: { apiKey: 'sk-user-pre', apiUrl: 'https://api.example.com' },
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-user-pre');
  });

  it('skips when the pre-resolved auth carries no api-key', async () => {
    const fetchImpl = vi.fn();
    await recordOutcome(base, {
      env: {},
      resolvedAuth: { apiUrl: 'https://api.example.com' },
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveTelemetryAuth — one config read, done up front for `auth remove`
// ---------------------------------------------------------------------------

describe('resolveTelemetryAuth', () => {
  it('returns the api-key and api-url from the credentials file', () => {
    const auth = resolveTelemetryAuth({}, { env: {}, credentialsPath: writeCreds(true) });
    expect(auth).toEqual({ apiKey: 'sk-user-test', apiUrl: 'https://api.example.com' });
  });

  it('returns no api-key when the profile has none', () => {
    const auth = resolveTelemetryAuth({}, { env: {}, credentialsPath: writeCreds(false) });
    expect(auth.apiKey).toBeUndefined();
    expect(auth.apiUrl).toBe('https://api.example.com');
  });
});

describe('wait timeout event fields', () => {
  const base = {
    command: 'test run',
    outcome: 'error' as const,
    exitCode: 7,
    durationMs: 1000,
    local: true,
  };

  it.each(['cancelled', 'already_terminal', 'failed', 'skipped'] as const)(
    'sends the allowlisted %s outcome to the beacon',
    async cancelOutcome => {
      const events: unknown[] = [];
      await recordOutcome(
        { ...base, reason: 'wait_timeout', cancelOutcome },
        {
          env: {},
          resolvedAuth: { apiKey: 'sk-user-test', apiUrl: 'https://api.example.com' },
          fetchImpl: async (_input, init) => {
            events.push(JSON.parse(String(init?.body)));
            return okResponse();
          },
        },
      );
      expect(events).toEqual([expect.objectContaining({ reason: 'wait_timeout', cancelOutcome })]);
    },
  );

  it('omits timeout fields for success', () => {
    const event = buildTelemetryEvent({ ...base, outcome: 'success', exitCode: 0 }, {}, false);
    expect(event).not.toHaveProperty('reason');
    expect(event).not.toHaveProperty('cancelOutcome');
  });

  it('rejects untyped free text and the internal hyphenated cancellation value', () => {
    const input = { ...base, reason: 'wait_timeout' as const, cancelOutcome: 'cancelled' as const };
    Reflect.set(input, 'reason', 'private error message');
    Reflect.set(input, 'cancelOutcome', 'secret token');
    expect(buildTelemetryEvent(input, {}, false)).not.toHaveProperty('reason');
    expect(buildTelemetryEvent(input, {}, false)).not.toHaveProperty('cancelOutcome');
    Reflect.set(input, 'reason', 'wait_timeout');
    Reflect.set(input, 'cancelOutcome', 'already-terminal');
    expect(buildTelemetryEvent(input, {}, false)).toHaveProperty('reason', 'wait_timeout');
    expect(buildTelemetryEvent(input, {}, false)).not.toHaveProperty('cancelOutcome');
  });

  it.each([
    { dryRun: true, env: {} },
    { dryRun: false, env: { DO_NOT_TRACK: '1' } },
    { dryRun: false, env: { TESTSPRITE_NO_TELEMETRY: '1' } },
  ])('preserves telemetry suppression (%j)', async ({ dryRun, env }) => {
    const fetchImpl = vi.fn();
    await recordOutcome(
      { ...base, reason: 'wait_timeout', cancelOutcome: 'cancelled', dryRun },
      {
        env,
        resolvedAuth: { apiKey: 'sk-user-test', apiUrl: 'https://api.example.com' },
        fetchImpl,
      },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Client tag + CI context — who ran the command, and where
// ---------------------------------------------------------------------------

describe('client tag on the event and the beacon UA', () => {
  const base = { command: 'test run', outcome: 'success' as const, exitCode: 0, durationMs: 1 };

  it('carries a valid TESTSPRITE_CLIENT as `client`; omits it when unset or invalid', () => {
    expect(buildTelemetryEvent(base, { TESTSPRITE_CLIENT: 'github-action/v1' }, false).client).toBe(
      'github-action/v1',
    );
    expect(buildTelemetryEvent(base, {}, false)).not.toHaveProperty('client');
    const invalid = buildTelemetryEvent(base, { TESTSPRITE_CLIENT: 'bad value (x)' }, false);
    expect(invalid).not.toHaveProperty('client');
    expect(JSON.stringify(invalid)).not.toContain('bad value');
  });

  it('the beacon POST sends the tagged User-Agent and the client field together', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await recordOutcome(base, {
      env: { TESTSPRITE_CLIENT: 'github-action/v1' },
      resolvedAuth: { apiKey: 'sk-user-test', apiUrl: 'https://api.example.com' },
      fetchImpl,
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['user-agent']).toBe(
      `testsprite-cli/${VERSION} (github-action/v1)`,
    );
    expect((JSON.parse(init.body as string) as { client?: string }).client).toBe(
      'github-action/v1',
    );
  });

  it('the beacon UA is byte-identical to before when no tag is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await recordOutcome(base, {
      env: {},
      resolvedAuth: { apiKey: 'sk-user-test', apiUrl: 'https://api.example.com' },
      fetchImpl,
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['user-agent']).toBe(
      `testsprite-cli/${VERSION}`,
    );
  });
});

describe('detectCiProvider', () => {
  it.each([
    [{ GITHUB_ACTIONS: 'true' }, 'github'],
    [{ GITLAB_CI: 'true' }, 'gitlab'],
    [{ CIRCLECI: 'true' }, 'circleci'],
    [{ BUILDKITE: 'true' }, 'buildkite'],
    [{ CI: 'true' }, 'other'],
    [{ CI: '1' }, 'other'],
    [{}, 'none'],
  ] as const)('%j → %s', (env, expected) => {
    expect(detectCiProvider(env)).toBe(expected);
  });

  it('github wins over a generic CI marker; a falsy vendor marker does not count', () => {
    expect(detectCiProvider({ GITHUB_ACTIONS: 'true', CI: 'true' })).toBe('github');
    expect(detectCiProvider({ GITHUB_ACTIONS: 'false', CI: 'true' })).toBe('other');
    expect(detectCiProvider({ GITLAB_CI: '0' })).toBe('none');
    expect(detectCiProvider({ CI: 'false' })).toBe('none');
  });
});

describe('detectCiEvent', () => {
  it.each(['push', 'pull_request', 'schedule', 'workflow_dispatch'] as const)(
    'maps GITHUB_EVENT_NAME=%s verbatim under github',
    name => {
      expect(detectCiEvent({ GITHUB_EVENT_NAME: name }, 'github')).toBe(name);
    },
  );

  it('buckets an unknown event to `other` and omits when unset', () => {
    expect(detectCiEvent({ GITHUB_EVENT_NAME: 'release' }, 'github')).toBe('other');
    expect(detectCiEvent({}, 'github')).toBeUndefined();
    expect(detectCiEvent({ GITHUB_EVENT_NAME: '' }, 'github')).toBeUndefined();
  });

  it('is undefined for every non-github provider even when the var is set', () => {
    expect(detectCiEvent({ GITHUB_EVENT_NAME: 'push' }, 'gitlab')).toBeUndefined();
    expect(detectCiEvent({ GITHUB_EVENT_NAME: 'push' }, 'none')).toBeUndefined();
  });
});

describe('hashRepository / buildCiContext', () => {
  it('is the first 16 hex chars of sha256("testsprite-ci-repo:" + slug)', () => {
    const expected = createHash('sha256')
      .update('testsprite-ci-repo:TestSprite/testsprite-cli')
      .digest('hex')
      .slice(0, 16);
    expect(hashRepository('TestSprite/testsprite-cli')).toBe(expected);
    expect(hashRepository('TestSprite/testsprite-cli')).toMatch(/^[0-9a-f]{16}$/);
    // Pinned so the backend can join on the same derivation.
    expect(hashRepository('octo/repo')).toBe(
      createHash('sha256').update('testsprite-ci-repo:octo/repo').digest('hex').slice(0, 16),
    );
  });

  it('never carries the slug; omits repoHash when GITHUB_REPOSITORY is unset', () => {
    const env = {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REPOSITORY: 'octo/secret-repo',
    };
    const ctx = buildCiContext(env);
    expect(ctx).toEqual({
      ciProvider: 'github',
      ciEvent: 'pull_request',
      repoHash: hashRepository('octo/secret-repo'),
    });
    expect(JSON.stringify(ctx)).not.toContain('secret-repo');
    expect(buildCiContext({ GITHUB_ACTIONS: 'true' })).toEqual({ ciProvider: 'github' });
    expect(buildCiContext({})).toEqual({ ciProvider: 'none' });
  });

  it('lands on the event', () => {
    const event = buildTelemetryEvent(
      { command: 'test run', outcome: 'success', exitCode: 0, durationMs: 1 },
      { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'a/b' },
      false,
    );
    expect(event.ciProvider).toBe('github');
    expect(event.ciEvent).toBe('push');
    expect(event.repoHash).toBe(hashRepository('a/b'));
    expect(event.ci).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Extras sink — batch counts / conflict reason / ci init facts
// ---------------------------------------------------------------------------

describe('sanitizeTelemetryExtras', () => {
  it('keeps allowlisted keys of the right shape and drops everything else', () => {
    expect(
      sanitizeTelemetryExtras({
        accepted: 3,
        conflicts: 1,
        deferred: 0,
        skipped: 2,
        passed: 2,
        failed: 1,
        blocked: 0,
        timedOut: 0,
        conflictReason: 'insufficient_credits',
        platform: 'github',
        force: true,
        workflowExisted: false,
        projectResolved: 'auto',
        // Not on the contract → dropped.
        testId: 'test_1',
        message: 'secret',
        url: 'https://x',
      }),
    ).toEqual({
      accepted: 3,
      conflicts: 1,
      deferred: 0,
      skipped: 2,
      passed: 2,
      failed: 1,
      blocked: 0,
      timedOut: 0,
      conflictReason: 'insufficient_credits',
      platform: 'github',
      force: true,
      workflowExisted: false,
      projectResolved: 'auto',
    });
  });

  it('drops negative, fractional, NaN and non-number counts', () => {
    expect(sanitizeTelemetryExtras({ accepted: -1 })).toEqual({});
    expect(sanitizeTelemetryExtras({ accepted: 1.5 })).toEqual({});
    expect(sanitizeTelemetryExtras({ accepted: Number.NaN })).toEqual({});
    expect(sanitizeTelemetryExtras({ accepted: '3' })).toEqual({});
  });

  it('drops enum values outside the contract and non-boolean flags', () => {
    expect(sanitizeTelemetryExtras({ conflictReason: 'not_found' })).toEqual({});
    expect(sanitizeTelemetryExtras({ conflictReason: 'tunnel-required' })).toEqual({
      conflictReason: 'tunnel-required',
    });
    expect(sanitizeTelemetryExtras({ platform: 'gitlab' })).toEqual({});
    expect(sanitizeTelemetryExtras({ projectResolved: 'guess' })).toEqual({});
    expect(sanitizeTelemetryExtras({ force: 'true' })).toEqual({});
  });
});

describe('recordTelemetryExtras / takeTelemetryExtras', () => {
  it('merges per key, last write wins, and clears on take', () => {
    recordTelemetryExtras({ accepted: 2, conflicts: 1 });
    recordTelemetryExtras({ conflicts: 3, passed: 2 });
    expect(takeTelemetryExtras()).toEqual({ accepted: 2, conflicts: 3, passed: 2 });
    expect(takeTelemetryExtras()).toEqual({});
  });

  it('recordOutcome drains the sink into the POST body', async () => {
    recordTelemetryExtras({ accepted: 1, passed: 1, conflictReason: 'in_flight' });
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    await recordOutcome(
      { command: 'test run', outcome: 'success', exitCode: 0, durationMs: 1 },
      {
        env: {},
        resolvedAuth: { apiKey: 'sk-user-test', apiUrl: 'https://api.example.com' },
        fetchImpl,
      },
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ accepted: 1, passed: 1, conflictReason: 'in_flight' });
    expect(takeTelemetryExtras()).toEqual({});
  });

  it('a gated-out recordOutcome still drains the sink (no leak into the next event)', async () => {
    recordTelemetryExtras({ accepted: 1 });
    const fetchImpl = vi.fn();
    await recordOutcome(
      { command: 'test run', outcome: 'success', exitCode: 0, durationMs: 1, dryRun: true },
      { env: {}, fetchImpl },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(takeTelemetryExtras()).toEqual({});
  });
});

describe('batchOutcomeCounts / recordBatchOutcome', () => {
  it('splits verdicts into disjoint passed / failed / blocked / timedOut', () => {
    expect(
      batchOutcomeCounts([
        { status: 'passed' },
        { status: 'passed' },
        { status: 'failed' },
        { status: 'blocked' },
        { status: 'timeout' },
        { status: 'error' },
        { status: 'cancelled' },
      ]),
    ).toEqual({ passed: 2, failed: 3, blocked: 1, timedOut: 1 });
    expect(batchOutcomeCounts([])).toEqual({ passed: 0, failed: 0, blocked: 0, timedOut: 0 });
  });

  it('records dispatch counts, the dominant conflict reason, and verdicts when given', () => {
    recordBatchOutcome({
      accepted: 2,
      conflicts: [
        { testId: 'a', reason: 'insufficient_credits' },
        { testId: 'b', reason: 'insufficient_credits' },
        { testId: 'c', currentRunId: 'r' },
      ],
      deferred: 1,
      skipped: 3,
      results: [{ status: 'passed' }, { status: 'blocked' }],
    });
    expect(takeTelemetryExtras()).toEqual({
      accepted: 2,
      conflicts: 3,
      deferred: 1,
      skipped: 3,
      conflictReason: 'insufficient_credits',
      passed: 1,
      failed: 0,
      blocked: 1,
      timedOut: 0,
    });
  });

  it('omits conflictReason for an empty conflict set and verdicts for a non-wait dispatch', () => {
    recordBatchOutcome({ accepted: 2, conflicts: [], deferred: 0, skipped: 0 });
    expect(takeTelemetryExtras()).toEqual({ accepted: 2, conflicts: 0, deferred: 0, skipped: 0 });
  });
});
