import { afterEach, describe, expect, it } from 'vitest';
import {
  DRY_RUN_API_KEY,
  DRY_RUN_BANNER,
  assertValidEndpointUrl,
  emitDryRunBanner,
  makeHttpClient,
  resetDryRunBannerForTesting,
  resolveRequestTimeoutMs,
} from './client-factory.js';
import {
  REQUEST_TIMEOUT_DEFAULT_MS,
  REQUEST_TIMEOUT_MAX_MS,
  REQUEST_TIMEOUT_MIN_MS,
} from './http.js';
import { ApiError } from './errors.js';

const NO_CREDS_PATH = '/tmp/testsprite-cli-test-no-such-file-1234.ini';

describe('makeHttpClient — dry-run path', () => {
  afterEach(() => {
    resetDryRunBannerForTesting();
  });

  it('does not require a credentials file or env var', async () => {
    const stderrLines: string[] = [];
    // Real path would throw AUTH_REQUIRED here; dry-run should succeed.
    const client = makeHttpClient(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
      },
      {
        env: {} as NodeJS.ProcessEnv,
        credentialsPath: NO_CREDS_PATH,
        stderr: line => stderrLines.push(line),
      },
    );
    const me = await client.get<{ userId: string }>('/me');
    expect(me.userId).toBeTruthy();
    expect(stderrLines).toContain(DRY_RUN_BANNER);
  });

  it('emits the banner once per process even across multiple clients', () => {
    const lines: string[] = [];
    const stderr = (line: string) => lines.push(line);
    emitDryRunBanner(stderr);
    emitDryRunBanner(stderr);
    emitDryRunBanner(stderr);
    expect(lines.filter(l => l === DRY_RUN_BANNER)).toHaveLength(1);
  });

  it('debug events include mode: "dry-run"', async () => {
    const stderrLines: string[] = [];
    const client = makeHttpClient(
      { profile: 'default', output: 'json', debug: true, dryRun: true },
      {
        env: {} as NodeJS.ProcessEnv,
        credentialsPath: NO_CREDS_PATH,
        stderr: line => stderrLines.push(line),
      },
    );
    await client.get('/projects');
    // Format is now: [debug <ISO-TS>] {...}
    const debug = stderrLines.filter(l => l.startsWith('[debug '));
    expect(debug.length).toBeGreaterThan(0);
    for (const line of debug) {
      expect(line).toContain('"mode":"dry-run"');
    }
  });

  it('debug lines carry an ISO 8601 timestamp (dogfood item 2)', async () => {
    const stderrLines: string[] = [];
    const client = makeHttpClient(
      { profile: 'default', output: 'json', debug: true, dryRun: true },
      {
        env: {} as NodeJS.ProcessEnv,
        credentialsPath: NO_CREDS_PATH,
        stderr: line => stderrLines.push(line),
      },
    );
    await client.get('/projects');
    const debug = stderrLines.filter(l => l.startsWith('[debug '));
    expect(debug.length).toBeGreaterThan(0);
    // Each line should match: [debug 2026-05-21T12:34:56.789Z] {...}
    for (const line of debug) {
      expect(line).toMatch(/^\[debug \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    }
  });

  it('--verbose wires onTransition to stderr', async () => {
    const stderrLines: string[] = [];
    // The dry-run fetch doesn't produce retries, but we verify the option is
    // accepted and no error is thrown.
    const client = makeHttpClient(
      { profile: 'default', output: 'json', debug: false, verbose: true, dryRun: true },
      {
        env: {} as NodeJS.ProcessEnv,
        credentialsPath: NO_CREDS_PATH,
        stderr: line => stderrLines.push(line),
      },
    );
    await client.get('/projects');
    // No transitions fire on a clean request; just confirm no throw.
    expect(stderrLines).toContain(DRY_RUN_BANNER);
  });

  it('uses the fake API key constant (never real)', () => {
    expect(DRY_RUN_API_KEY).toBe('sk-user-DRY-RUN');
  });
});

// M3.3 piece-4 — getRunFailure dry-run path
describe('makeHttpClient — getRunFailure dry-run path (M3.3 piece-4)', () => {
  afterEach(() => {
    resetDryRunBannerForTesting();
  });

  it('GET /runs/{runId}/failure returns a FailureContext-shaped body in dry-run', async () => {
    const client = makeHttpClient(
      { profile: 'default', output: 'json', debug: false, dryRun: true },
      {
        env: {} as NodeJS.ProcessEnv,
        credentialsPath: NO_CREDS_PATH,
        stderr: () => {},
      },
    );
    const result = await client.get<{
      snapshotId: string;
      testId: string;
      result: { snapshotId: string; runIdIfAvailable: string };
    }>('/runs/run_abc/failure');
    expect(result.snapshotId).toBeTruthy();
    expect(result.testId).toBeTruthy();
    expect(result.result.snapshotId).toBe(result.snapshotId);
    // Run-scoped bundle must have runIdIfAvailable set
    expect(result.result.runIdIfAvailable).toBe('run_abc');
  });

  it('GET /runs/{runId} returns a run-status-shaped body in dry-run', async () => {
    const client = makeHttpClient(
      { profile: 'default', output: 'json', debug: false, dryRun: true },
      {
        env: {} as NodeJS.ProcessEnv,
        credentialsPath: NO_CREDS_PATH,
        stderr: () => {},
      },
    );
    const result = await client.get<{
      runId: string;
      testId: string;
      status: string;
    }>('/runs/run_abc');
    expect(result.runId).toBeTruthy();
    expect(result.testId).toBeTruthy();
    expect(result.status).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// resolveRequestTimeoutMs — flag / env / default precedence
// ---------------------------------------------------------------------------

describe('resolveRequestTimeoutMs', () => {
  it('returns the default when no flag or env var is set', () => {
    expect(resolveRequestTimeoutMs({}, {})).toBe(REQUEST_TIMEOUT_DEFAULT_MS);
  });

  it('flag (requestTimeoutMs) takes precedence over env var', () => {
    expect(
      resolveRequestTimeoutMs(
        { requestTimeoutMs: 30_000 }, // 30s
        { TESTSPRITE_REQUEST_TIMEOUT_MS: '60000' }, // 60s
      ),
    ).toBe(30_000);
  });

  it('env var is used when flag is absent', () => {
    expect(resolveRequestTimeoutMs({}, { TESTSPRITE_REQUEST_TIMEOUT_MS: '45000' })).toBe(45_000);
  });

  it('clamps values below the minimum to REQUEST_TIMEOUT_MIN_MS', () => {
    expect(
      resolveRequestTimeoutMs({ requestTimeoutMs: 100 }, {}), // 100ms < 1s min
    ).toBe(REQUEST_TIMEOUT_MIN_MS);
  });

  it('clamps values above the maximum to REQUEST_TIMEOUT_MAX_MS', () => {
    expect(resolveRequestTimeoutMs({ requestTimeoutMs: 999_999_999 }, {})).toBe(
      REQUEST_TIMEOUT_MAX_MS,
    );
  });

  it('ignores a non-numeric TESTSPRITE_REQUEST_TIMEOUT_MS env var', () => {
    expect(resolveRequestTimeoutMs({}, { TESTSPRITE_REQUEST_TIMEOUT_MS: 'not-a-number' })).toBe(
      REQUEST_TIMEOUT_DEFAULT_MS,
    );
  });

  it('ignores a zero or negative TESTSPRITE_REQUEST_TIMEOUT_MS env var', () => {
    expect(resolveRequestTimeoutMs({}, { TESTSPRITE_REQUEST_TIMEOUT_MS: '0' })).toBe(
      REQUEST_TIMEOUT_DEFAULT_MS,
    );
    expect(resolveRequestTimeoutMs({}, { TESTSPRITE_REQUEST_TIMEOUT_MS: '-100' })).toBe(
      REQUEST_TIMEOUT_DEFAULT_MS,
    );
  });

  it('accepts a valid env var within range', () => {
    expect(resolveRequestTimeoutMs({}, { TESTSPRITE_REQUEST_TIMEOUT_MS: '5000' })).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// makeHttpClient — requestTimeoutMs propagation
// ---------------------------------------------------------------------------

describe('makeHttpClient — requestTimeoutMs propagation', () => {
  afterEach(() => {
    resetDryRunBannerForTesting();
  });

  it('passes requestTimeoutMs from flag to the HttpClient (dry-run path)', () => {
    const client = makeHttpClient(
      { profile: 'default', output: 'json', debug: false, dryRun: true, requestTimeoutMs: 30_000 },
      { env: {} as NodeJS.ProcessEnv, credentialsPath: '/tmp/no-such-file.ini', stderr: () => {} },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).requestTimeoutMs).toBe(30_000);
  });

  it('resolves requestTimeoutMs from env var when flag is not set (dry-run path)', () => {
    const client = makeHttpClient(
      { profile: 'default', output: 'json', debug: false, dryRun: true },
      {
        env: { TESTSPRITE_REQUEST_TIMEOUT_MS: '10000' } as NodeJS.ProcessEnv,
        credentialsPath: '/tmp/no-such-file.ini',
        stderr: () => {},
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).requestTimeoutMs).toBe(10_000);
  });

  it('falls back to REQUEST_TIMEOUT_DEFAULT_MS when neither flag nor env is set', () => {
    const client = makeHttpClient(
      { profile: 'default', output: 'json', debug: false, dryRun: true },
      { env: {} as NodeJS.ProcessEnv, credentialsPath: '/tmp/no-such-file.ini', stderr: () => {} },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any).requestTimeoutMs).toBe(REQUEST_TIMEOUT_DEFAULT_MS);
  });
});

describe('makeHttpClient — real path (regression)', () => {
  afterEach(() => {
    resetDryRunBannerForTesting();
  });

  it('throws AUTH_REQUIRED when no credentials are configured and not dry-run', () => {
    expect(() =>
      makeHttpClient(
        { profile: 'default', output: 'json', debug: false, dryRun: false },
        {
          env: {} as NodeJS.ProcessEnv,
          credentialsPath: NO_CREDS_PATH,
        },
      ),
    ).toThrow(/authentication is required/i);
  });

  it('does not emit the dry-run banner when dryRun is false', () => {
    const stderrLines: string[] = [];
    expect(() =>
      makeHttpClient(
        { profile: 'default', output: 'json', debug: false, dryRun: false },
        {
          env: {} as NodeJS.ProcessEnv,
          credentialsPath: NO_CREDS_PATH,
          stderr: line => stderrLines.push(line),
        },
      ),
    ).toThrow();
    expect(stderrLines).not.toContain(DRY_RUN_BANNER);
  });
});

// ---------------------------------------------------------------------------
// assertValidEndpointUrl — endpoint syntax guard (NOT an SSRF guard)
// ---------------------------------------------------------------------------

describe('assertValidEndpointUrl', () => {
  it('accepts http(s) URLs, including private / localhost hosts (self-hosted, dev, mock)', () => {
    for (const url of [
      'https://api.testsprite.com',
      'http://localhost:3000',
      'http://127.0.0.1:8787',
      'https://testsprite.internal.example.com/api/cli/v1',
    ]) {
      expect(() => assertValidEndpointUrl(url)).not.toThrow();
    }
  });

  it('rejects an unparseable URL with a VALIDATION_ERROR (exit 5)', () => {
    let caught: unknown;
    try {
      assertValidEndpointUrl('not a url');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const apiErr = caught as ApiError;
    expect(apiErr.code).toBe('VALIDATION_ERROR');
    expect(apiErr.exitCode).toBe(5);
    expect(apiErr.nextAction).toContain('endpoint-url');
  });

  it('rejects a missing scheme (parses as a bogus scheme) and a non-http(s) scheme', () => {
    // `new URL('localhost:3000')` does not throw — it parses with protocol
    // `localhost:`. Without the scheme check this would sail through and later
    // fail as a retried "fetch failed".
    for (const url of ['localhost:3000', 'ftp://example.com', 'file:///etc/hosts']) {
      let caught: unknown;
      try {
        assertValidEndpointUrl(url);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ApiError);
      expect((caught as ApiError).code).toBe('VALIDATION_ERROR');
      expect((caught as ApiError).exitCode).toBe(5);
    }
  });
});

describe('makeHttpClient — endpoint validation', () => {
  afterEach(() => {
    resetDryRunBannerForTesting();
  });

  it('throws a VALIDATION_ERROR (exit 5) on a malformed --endpoint-url under --dry-run', () => {
    let caught: unknown;
    try {
      makeHttpClient(
        { profile: 'default', output: 'json', debug: false, dryRun: true, endpointUrl: 'ftp://x' },
        { env: {} as NodeJS.ProcessEnv, credentialsPath: NO_CREDS_PATH, stderr: () => {} },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).exitCode).toBe(5);
  });

  it('rejects a malformed endpoint before the auth check on the real path', () => {
    // No API key is configured, but the malformed endpoint is reported first
    // (a deterministic config error) — exit 5, not exit 3.
    let caught: unknown;
    try {
      makeHttpClient(
        { profile: 'default', output: 'json', debug: false, dryRun: false, endpointUrl: 'nope' },
        { env: {} as NodeJS.ProcessEnv, credentialsPath: NO_CREDS_PATH, stderr: () => {} },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('VALIDATION_ERROR');
    expect((caught as ApiError).exitCode).toBe(5);
  });
});
