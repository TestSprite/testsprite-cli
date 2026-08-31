/**
 * `doctor` — the Local tunnel check (DEV-747 piece 3).
 *
 * The check exists for one concrete failure: `run:tunnel` is the first scope
 * ever deliberately excluded from the grandfather grant, so every key minted
 * before it — i.e. most keys in the wild — gets a 403 the first time someone
 * tries `--local`. Finding that out from `doctor` costs nothing; finding it out
 * from a failed run costs a support round-trip.
 *
 * It is a READ (`GET /tunnel/<random-uuid>`, expected 404). Minting to probe
 * would consume one of the caller's small per-principal live-binding slots and
 * spend rate-limit budget on a diagnostic.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, CLIError } from '../lib/errors.js';
import { runDoctor } from './doctor.js';

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function makeCreds(): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-doctor-tunnel-'));
  const credentialsPath = join(dir, 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- `dir` is this suite's own mkdtempSync temp dir, never user input
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- same temp dir; writing the fixture credentials file is the point of this helper
  writeFileSync(
    credentialsPath,
    '[default]\napi_url = http://localhost:13502\napi_key = sk-user-test\n',
    { mode: 0o600 },
  );
  return { credentialsPath };
}

function envelope(code: string): unknown {
  return {
    error: { code, message: code, nextAction: 'x', requestId: 'r1', details: {} },
  };
}

function fetchWith(tunnelStatus: number, tunnelBody: unknown): typeof globalThis.fetch {
  return (async (input: FetchInput) => {
    const url = String(input);
    if (url.includes('/tunnel/')) {
      return new Response(JSON.stringify(tunnelBody), {
        status: tunnelStatus,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ userId: 'u1', keyId: 'k1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

async function tunnelCheck(status: number, body: unknown) {
  const report = await runDoctor(
    { profile: 'default', output: 'json', debug: false },
    { ...makeCreds(), fetchImpl: fetchWith(status, body), stdout: () => {}, stderr: () => {} },
  );
  return report.checks.find(check => check.name === 'Local tunnel');
}

describe('doctor — Local tunnel', () => {
  it('is OK when the surface answers a read (404 for an id nobody owns)', async () => {
    const check = await tunnelCheck(404, envelope('NOT_FOUND'));
    expect(check?.status).toBe('ok');
    expect(check?.detail).toMatch(/available/i);
  });

  it('warns with a mint-a-new-key next step when the key lacks run:tunnel', async () => {
    const check = await tunnelCheck(403, envelope('AUTH_FORBIDDEN'));
    expect(check?.status).toBe('warn');
    // The whole reason the check exists: the remedy is a NEW key, not a
    // re-login, and nothing else in the CLI says so.
    expect(check?.detail).toMatch(/new API key/i);
  });

  it('warns — never fails — when the environment has no tunnel surface', async () => {
    // Production has no tunnel endpoints configured today. A `fail` here would
    // make `doctor` exit 1 for every prod user over a feature they are not using.
    const check = await tunnelCheck(503, envelope('UNAVAILABLE'));
    expect(check?.status).toBe('warn');
    expect(check?.detail).toMatch(/not available/i);
  });

  it('is skipped under --dry-run', async () => {
    const report = await runDoctor(
      { profile: 'default', output: 'json', debug: false, dryRun: true },
      { ...makeCreds(), stdout: () => {}, stderr: () => {} },
    );
    const check = report.checks.find(c => c.name === 'Local tunnel');
    expect(check?.status).toBe('warn');
    expect(check?.detail).toMatch(/skipped/);
  });

  it('prints the full report and exits 1 when the API key is malformed', async () => {
    const stdout: string[] = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error('a malformed key must fail before fetch');
    }) as unknown as typeof globalThis.fetch;
    const rejection = await runDoctor(
      { profile: 'default', output: 'json', debug: false },
      {
        ...makeCreds(),
        env: { TESTSPRITE_API_KEY: 'malformed' },
        cwd: '/project',
        existsSync: () => true,
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: () => {},
      },
    ).catch((error: unknown) => error);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rejection).toBeInstanceOf(CLIError);
    expect(rejection).not.toBeInstanceOf(ApiError);
    expect(rejection).toMatchObject({ exitCode: 1 });
    expect(stdout).toHaveLength(1);
    const report = JSON.parse(stdout[0]!) as {
      failures: number;
      checks: Array<{ name: string; status: string; detail: string }>;
    };
    expect(report.failures).toBe(1);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Connectivity',
          status: 'fail',
          detail: expect.stringContaining('VALIDATION_ERROR'),
        }),
        expect.objectContaining({
          name: 'Local tunnel',
          status: 'warn',
          detail: expect.stringContaining('VALIDATION_ERROR'),
        }),
      ]),
    );
  });

  it('warns within 3 seconds when the tunnel status fetch never settles', async () => {
    vi.useFakeTimers();
    try {
      let markTunnelStarted!: () => void;
      const tunnelStarted = new Promise<void>(resolve => {
        markTunnelStarted = resolve;
      });
      const fetchImpl = vi.fn(async (input: FetchInput, init?: RequestInit): Promise<Response> => {
        if (!String(input).includes('/tunnel/')) {
          return new Response(JSON.stringify({ userId: 'u1', keyId: 'k1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        markTunnelStarted();
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const rejectOnAbort = (): void => reject(signal?.reason ?? new Error('aborted'));
          if (signal?.aborted) rejectOnAbort();
          else signal?.addEventListener('abort', rejectOnAbort, { once: true });
        });
      }) as unknown as typeof globalThis.fetch;
      let report: Awaited<ReturnType<typeof runDoctor>> | undefined;
      const pending = runDoctor(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          requestTimeoutMs: 600_000,
        },
        {
          ...makeCreds(),
          cwd: '/project',
          existsSync: () => true,
          fetchImpl,
          stdout: () => {},
          stderr: () => {},
        },
      ).then(value => {
        report = value;
      });

      // Wait for /me to finish and the tunnel request to start without
      // advancing fake time; the probe deadline begins immediately before it.
      await tunnelStarted;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(report).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(report).toBeDefined();
      await pending;
      expect(report?.failures).toBe(0);
      expect(report?.checks).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'Local tunnel', status: 'warn' })]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('cuts a Retry-After sleep at the 3 second probe deadline before a second attempt', async () => {
    vi.useFakeTimers();
    let pending: Promise<Awaited<ReturnType<typeof runDoctor>>> | undefined;
    try {
      let tunnelProbeCalls = 0;
      const fetchImpl = vi.fn(async (input: FetchInput): Promise<Response> => {
        if (!String(input).includes('/tunnel/')) {
          return new Response(JSON.stringify({ userId: 'u1', keyId: 'k1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        tunnelProbeCalls += 1;
        return new Response(JSON.stringify(envelope('RATE_LIMITED')), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '4' },
        });
      }) as unknown as typeof globalThis.fetch;

      pending = runDoctor(
        { profile: 'default', output: 'json', debug: false },
        {
          ...makeCreds(),
          cwd: '/project',
          existsSync: () => true,
          fetchImpl,
          stdout: () => {},
          stderr: () => {},
        },
      );
      let report: Awaited<ReturnType<typeof runDoctor>> | undefined;
      void pending.then(value => {
        report = value;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(tunnelProbeCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(report).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(report).toBeDefined();
      expect(tunnelProbeCalls).toBe(1);
      expect(report?.checks).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'Local tunnel', status: 'warn' })]),
      );
    } finally {
      await vi.runAllTimersAsync();
      await pending?.catch(() => {});
      vi.useRealTimers();
    }
  });
});
