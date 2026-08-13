import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommanderError } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, CLIError, InterruptError, RequestTimeoutError } from './errors.js';
import {
  buildTelemetryEvent,
  classifyCliError,
  isTelemetryOptedOut,
  recordOutcome,
  resolveTelemetryAuth,
} from './telemetry.js';

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
  it('InterruptError → abort + INTERRUPTED + its exit code', () => {
    expect(classifyCliError(new InterruptError('SIGINT'))).toEqual({
      outcome: 'abort',
      exitCode: 130,
      errorCode: 'INTERRUPTED',
    });
  });

  it('RequestTimeoutError → error + REQUEST_TIMEOUT + exit 7', () => {
    expect(classifyCliError(new RequestTimeoutError(1000))).toEqual({
      outcome: 'error',
      exitCode: 7,
      errorCode: 'REQUEST_TIMEOUT',
    });
  });

  it('ApiError → error + its code + its exit code', () => {
    const err = ApiError.authRequired();
    expect(classifyCliError(err)).toEqual({
      outcome: 'error',
      exitCode: err.exitCode,
      errorCode: err.code,
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

  it('CommanderError parse error → error + VALIDATION_ERROR + exit 5', () => {
    expect(classifyCliError(new CommanderError(1, 'commander.unknownCommand', 'nope'))).toEqual({
      outcome: 'error',
      exitCode: 5,
      errorCode: 'VALIDATION_ERROR',
    });
  });

  it('CLIError → error + its exit code (no errorCode)', () => {
    expect(classifyCliError(new CLIError('boom', 4))).toEqual({ outcome: 'error', exitCode: 4 });
  });

  it('unknown error → error + exit 1', () => {
    expect(classifyCliError(new Error('weird'))).toEqual({ outcome: 'error', exitCode: 1 });
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
    });
    // Allowlist backstop: nothing sensitive leaked through.
    expect(event).not.toHaveProperty('endpointUrl');
    expect(event).not.toHaveProperty('profile');
    expect(event).not.toHaveProperty('message');
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
