import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CLIError } from '../lib/errors.js';
import { readProfile, writeProfile } from '../lib/credentials.js';
import type { AuthDeps, MeResponse } from './auth.js';
import { createAuthCommand, runConfigure, runLogout, runWhoami } from './auth.js';

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
  prelude: string[];
}

function makeCapture(): {
  capture: CapturedOutput;
  deps: Pick<AuthDeps, 'stdout' | 'stderr' | 'preludeWrite'>;
} {
  const capture: CapturedOutput = { stdout: [], stderr: [], prelude: [] };
  return {
    capture,
    deps: {
      stdout: line => capture.stdout.push(line),
      stderr: line => capture.stderr.push(line),
      preludeWrite: chunk => capture.prelude.push(chunk),
    },
  };
}

const sampleMe: MeResponse = {
  userId: 'u-1',
  keyId: 'k-1',
  scopes: ['read:projects', 'read:tests'],
  env: 'development',
};

/** Mock fetchImpl that returns 200 for /me — used by runConfigure tests to satisfy the pre-write ping. */
const meOkFetch: AuthDeps['fetchImpl'] = vi.fn(
  async () =>
    new Response(JSON.stringify(sampleMe), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
) as unknown as AuthDeps['fetchImpl'];

let credentialsPath: string;

beforeEach(() => {
  credentialsPath = join(mkdtempSync(join(tmpdir(), 'testsprite-auth-')), 'credentials');
});

describe('runConfigure', () => {
  it('writes the env-supplied key when --from-env is set', async () => {
    const { capture, deps } = makeCapture();
    await runConfigure(
      { profile: 'default', output: 'text', debug: false, fromEnv: true },
      {
        ...deps,
        env: { TESTSPRITE_API_KEY: 'sk-from-env', TESTSPRITE_API_URL: 'https://from-env' },
        credentialsPath,
        fetchImpl: meOkFetch,
      },
    );
    expect(readProfile('default', { path: credentialsPath })).toEqual({
      apiKey: 'sk-from-env',
      apiUrl: 'https://from-env',
    });
    expect(capture.stdout.join('\n')).toContain('configured');
  });

  it('--from-env without TESTSPRITE_API_URL uses the built-in default endpoint', async () => {
    const { deps } = makeCapture();
    await runConfigure(
      { profile: 'default', output: 'text', debug: false, fromEnv: true },
      {
        ...deps,
        env: { TESTSPRITE_API_KEY: 'sk' },
        credentialsPath,
        fetchImpl: meOkFetch,
      },
    );
    expect(readProfile('default', { path: credentialsPath })?.apiUrl).toBe(
      'https://api.testsprite.com',
    );
  });

  it('--endpoint-url overrides TESTSPRITE_API_URL when --from-env is set', async () => {
    const { deps } = makeCapture();
    await runConfigure(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        fromEnv: true,
        endpointUrl: 'https://flag-wins.example.com',
      },
      {
        ...deps,
        env: {
          TESTSPRITE_API_KEY: 'sk',
          TESTSPRITE_API_URL: 'https://env-loses.example.com',
        },
        credentialsPath,
        fetchImpl: meOkFetch,
      },
    );
    expect(readProfile('default', { path: credentialsPath })?.apiUrl).toBe(
      'https://flag-wins.example.com',
    );
  });

  it('uses requestTimeoutMs for the pre-write key validation ping', async () => {
    const { deps } = makeCapture();
    let sawAbort = false;
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const timeout = setTimeout(() => {
            reject(new Error('requestTimeoutMs was not applied to the validation ping'));
          }, 50);
          signal?.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              clearTimeout(timeout);
              reject(new DOMException('The operation timed out.', 'TimeoutError'));
            },
            { once: true },
          );
        }),
    ) as unknown as typeof fetch;

    await expect(
      runConfigure(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          fromEnv: true,
          requestTimeoutMs: 1,
        },
        {
          ...deps,
          env: { TESTSPRITE_API_KEY: 'sk' },
          credentialsPath,
          fetchImpl,
        },
      ),
    ).rejects.toBeInstanceOf(CLIError);

    expect(sawAbort).toBe(true);
    expect(readProfile('default', { path: credentialsPath })).toBeUndefined();
  });

  it('throws VALIDATION_ERROR when --from-env is set but key is missing', async () => {
    const { deps } = makeCapture();
    await expect(
      runConfigure(
        { profile: 'default', output: 'text', debug: false, fromEnv: true },
        { ...deps, env: {}, credentialsPath },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('prompts only for the API key (never the endpoint) and defaults to prod', async () => {
    const { capture, deps } = makeCapture();
    // Prompt object exposes ONLY `secret`. If runConfigure tried to prompt for
    // the endpoint it would call an undefined `text` and throw — so a passing
    // test proves the endpoint is never prompted.
    const prompt = {
      secret: vi.fn(async () => 'sk-typed'),
    };
    await runConfigure(
      { profile: 'default', output: 'text', debug: false, fromEnv: false },
      { ...deps, env: {}, credentialsPath, prompt, fetchImpl: meOkFetch },
    );
    expect(prompt.secret).toHaveBeenCalledTimes(1);
    expect(readProfile('default', { path: credentialsPath })).toEqual({
      apiKey: 'sk-typed',
      apiUrl: 'https://api.testsprite.com',
    });
    expect(capture.prelude.join('')).toContain('Configuring profile "default"');
  });

  it('interactive path resolves the endpoint from TESTSPRITE_API_URL without prompting', async () => {
    const { capture, deps } = makeCapture();
    const prompt = { secret: vi.fn(async () => 'sk-typed') };
    await runConfigure(
      { profile: 'default', output: 'text', debug: false, fromEnv: false },
      {
        ...deps,
        env: { TESTSPRITE_API_URL: 'https://api.example.com:8443' },
        credentialsPath,
        prompt,
        fetchImpl: meOkFetch,
      },
    );
    expect(readProfile('default', { path: credentialsPath })).toEqual({
      apiKey: 'sk-typed',
      apiUrl: 'https://api.example.com:8443',
    });
    // An env-supplied endpoint is explicit → no inherit advisory.
    expect(capture.stderr.join('\n')).not.toContain('[advisory]');
  });

  it('interactive path inherits an existing non-default profile endpoint without prompting (+ advisory)', async () => {
    const { capture, deps } = makeCapture();
    // Pre-existing dev profile — re-running configure interactively must keep it
    // (the internal dogfooding flow) without ever prompting for the endpoint.
    writeProfile(
      'dev',
      { apiKey: 'sk-old', apiUrl: 'https://api.example.com:8443' },
      { path: credentialsPath },
    );
    const prompt = { secret: vi.fn(async () => 'sk-typed') };
    await runConfigure(
      { profile: 'dev', output: 'text', debug: false, fromEnv: false },
      { ...deps, env: {}, credentialsPath, prompt, fetchImpl: meOkFetch },
    );
    expect(readProfile('dev', { path: credentialsPath })).toEqual({
      apiKey: 'sk-typed',
      apiUrl: 'https://api.example.com:8443',
    });
    expect(capture.stderr.join('\n')).toContain(
      '[advisory] Inheriting api_url from existing profile: https://api.example.com:8443',
    );
  });

  it('throws when interactive secret comes back empty', async () => {
    const { deps } = makeCapture();
    const prompt = { secret: vi.fn(async () => '   ') };
    await expect(
      runConfigure(
        { profile: 'default', output: 'text', debug: false, fromEnv: false },
        { ...deps, env: {}, credentialsPath, prompt },
      ),
    ).rejects.toBeInstanceOf(CLIError);
  });

  it('honors --endpoint-url without prompting for the endpoint', async () => {
    const { capture, deps } = makeCapture();
    const prompt = { secret: vi.fn(async () => 'sk-1') };
    await runConfigure(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        fromEnv: false,
        endpointUrl: 'https://override.example',
      },
      { ...deps, env: {}, credentialsPath, prompt, fetchImpl: meOkFetch },
    );
    expect(prompt.secret).toHaveBeenCalledTimes(1);
    expect(readProfile('default', { path: credentialsPath })?.apiUrl).toBe(
      'https://override.example',
    );
    // Explicit endpoint → no inherit advisory.
    expect(capture.stderr.join('\n')).not.toContain('[advisory]');
  });

  // P4: pre-write /me ping behaviour
  it('P4 — writes profile and prints success when API key is accepted', async () => {
    const { capture, deps } = makeCapture();
    await runConfigure(
      { profile: 'default', output: 'text', debug: false, fromEnv: true },
      {
        ...deps,
        env: { TESTSPRITE_API_KEY: 'sk-good' },
        credentialsPath,
        fetchImpl: meOkFetch,
      },
    );
    expect(readProfile('default', { path: credentialsPath })?.apiKey).toBe('sk-good');
    expect(capture.stdout.join('\n')).toContain('configured');
  });

  it('P4 — does NOT write profile and throws CLIError when API key is rejected (401)', async () => {
    const { capture, deps } = makeCapture();
    const rejectedFetch: AuthDeps['fetchImpl'] = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_INVALID',
              message: 'API key is invalid or revoked.',
              nextAction: 'Rotate your key.',
              requestId: 'req_reject',
              details: {},
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as AuthDeps['fetchImpl'];

    await expect(
      runConfigure(
        { profile: 'default', output: 'text', debug: false, fromEnv: true },
        {
          ...deps,
          env: { TESTSPRITE_API_KEY: 'sk-bad' },
          credentialsPath,
          fetchImpl: rejectedFetch,
        },
      ),
    ).rejects.toBeInstanceOf(CLIError);

    // Profile must NOT be written.
    expect(readProfile('default', { path: credentialsPath })).toBeUndefined();
    // Stderr must mention the rejection.
    expect(capture.stderr.join('\n')).toContain('profile NOT updated');
  });

  // The old "run `testsprite agent install`" self-bootstrap tip was removed with
  // the setup consolidation — runConfigure now runs ONLY as part of `setup`,
  // which installs the skill itself. These guard that the tip stays gone.
  it('piece-3 — text mode success does NOT emit the agent-install tip', async () => {
    const { capture, deps } = makeCapture();
    await runConfigure(
      { profile: 'default', output: 'text', debug: false, fromEnv: true },
      {
        ...deps,
        env: { TESTSPRITE_API_KEY: 'sk-good' },
        credentialsPath,
        fetchImpl: meOkFetch,
      },
    );
    expect(capture.stderr.join('\n')).not.toContain('agent install');
  });

  it('piece-3 — json mode success does NOT emit the agent-install tip', async () => {
    const { capture, deps } = makeCapture();
    await runConfigure(
      { profile: 'default', output: 'json', debug: false, fromEnv: true },
      {
        ...deps,
        env: { TESTSPRITE_API_KEY: 'sk-good' },
        credentialsPath,
        fetchImpl: meOkFetch,
      },
    );
    expect(capture.stderr.join('\n')).not.toContain('agent install');
  });

  it('piece-3 — dry-run does NOT emit the agent-install tip', async () => {
    const { capture, deps } = makeCapture();
    await runConfigure(
      { profile: 'default', output: 'text', debug: false, fromEnv: true, dryRun: true },
      {
        ...deps,
        env: { TESTSPRITE_API_KEY: 'sk-good' },
        credentialsPath,
        fetchImpl: meOkFetch,
      },
    );
    expect(capture.stderr.join('\n')).not.toContain('agent install');
  });

  it('piece-3 — key-rejected path does NOT emit the agent-install tip', async () => {
    const { capture, deps } = makeCapture();
    const rejectedFetch: AuthDeps['fetchImpl'] = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_INVALID',
              message: 'API key is invalid or revoked.',
              nextAction: 'Rotate your key.',
              requestId: 'req_reject',
              details: {},
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as AuthDeps['fetchImpl'];

    await expect(
      runConfigure(
        { profile: 'default', output: 'text', debug: false, fromEnv: true },
        {
          ...deps,
          env: { TESTSPRITE_API_KEY: 'sk-bad' },
          credentialsPath,
          fetchImpl: rejectedFetch,
        },
      ),
    ).rejects.toBeInstanceOf(CLIError);

    expect(capture.stderr.join('\n')).not.toContain('agent install');
  });

  // Regression (2026-05-25): auth configure inherits existing profile apiUrl
  it('dogfood-2026-05-25 — --from-env without TESTSPRITE_API_URL inherits existing profile api_url AND validates against it', async () => {
    const { capture, deps } = makeCapture();
    // Pre-write an existing profile with a custom (non-default) endpoint.
    writeProfile(
      'default',
      { apiKey: 'sk-old', apiUrl: 'https://api.example.com' },
      { path: credentialsPath },
    );
    // codex-review P2 (2026-05-28): capture the URL the /me ping was made against
    // so the regression actually exercises "validation hit the inherited URL, not
    // DEFAULT_API_URL". meOkFetch was URL-agnostic, so the original test would
    // have passed even if runConfigure called against prod and then wrote the
    // inherited dev URL — exactly the bug we're trying to prevent.
    const seenFetchUrls: string[] = [];
    const urlAwareFetch: AuthDeps['fetchImpl'] = vi.fn(async (input: unknown) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
      seenFetchUrls.push(url);
      return new Response(JSON.stringify(sampleMe), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as AuthDeps['fetchImpl'];
    await runConfigure(
      { profile: 'default', output: 'text', debug: false, fromEnv: true },
      {
        ...deps,
        env: { TESTSPRITE_API_KEY: 'sk-new' },
        credentialsPath,
        fetchImpl: urlAwareFetch,
      },
    );
    // The new profile should reuse the inherited dev endpoint.
    expect(readProfile('default', { path: credentialsPath })).toEqual({
      apiKey: 'sk-new',
      apiUrl: 'https://api.example.com',
    });
    // The /me ping MUST have been issued against the inherited dev URL — this is
    // the actual regression guard (the original bug was validating against prod).
    expect(seenFetchUrls.length).toBeGreaterThan(0);
    expect(seenFetchUrls[0]).toMatch(/^https:\/\/api\.example\.com\//);
    // And no fetch should have hit the default endpoint.
    expect(seenFetchUrls.some(u => /^https:\/\/api\.testsprite\.com\//.test(u))).toBe(false);
    // An advisory message must appear on stderr so the user is not confused.
    expect(capture.stderr.join('\n')).toContain(
      '[advisory] Inheriting api_url from existing profile: https://api.example.com',
    );
  });

  it('dogfood-2026-05-25 — --endpoint-url flag overrides existing profile api_url', async () => {
    const { capture, deps } = makeCapture();
    writeProfile(
      'default',
      { apiKey: 'sk-old', apiUrl: 'https://api.example.com' },
      { path: credentialsPath },
    );
    await runConfigure(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        fromEnv: true,
        endpointUrl: 'https://custom.example.com',
      },
      {
        ...deps,
        env: { TESTSPRITE_API_KEY: 'sk-new' },
        credentialsPath,
        fetchImpl: meOkFetch,
      },
    );
    expect(readProfile('default', { path: credentialsPath })?.apiUrl).toBe(
      'https://custom.example.com',
    );
    // No advisory when --endpoint-url was supplied explicitly.
    expect(capture.stderr.join('\n')).not.toContain('[advisory]');
  });

  it('dogfood-2026-05-25 — no advisory when inherited url equals DEFAULT_API_URL', async () => {
    const { capture, deps } = makeCapture();
    // Existing profile has the default prod endpoint — no advisory needed.
    writeProfile(
      'default',
      { apiKey: 'sk-old', apiUrl: 'https://api.testsprite.com' },
      { path: credentialsPath },
    );
    await runConfigure(
      { profile: 'default', output: 'text', debug: false, fromEnv: true },
      {
        ...deps,
        env: { TESTSPRITE_API_KEY: 'sk-new' },
        credentialsPath,
        fetchImpl: meOkFetch,
      },
    );
    expect(capture.stderr.join('\n')).not.toContain('[advisory]');
  });

  it('dogfood-2026-05-25 — fresh machine (no existing profile) still falls back to DEFAULT_API_URL', async () => {
    const { deps } = makeCapture();
    // No existing profile written — credentialsPath points at an empty temp dir.
    await runConfigure(
      { profile: 'default', output: 'text', debug: false, fromEnv: true },
      {
        ...deps,
        env: { TESTSPRITE_API_KEY: 'sk-new' },
        credentialsPath,
        fetchImpl: meOkFetch,
      },
    );
    expect(readProfile('default', { path: credentialsPath })?.apiUrl).toBe(
      'https://api.testsprite.com',
    );
  });

  it('dogfood-2026-05-25 — rejection error message includes the resolved endpoint URL', async () => {
    const { deps } = makeCapture();
    const rejectedFetch: AuthDeps['fetchImpl'] = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTH_INVALID',
              message: 'API key is invalid or revoked.',
              nextAction: 'Rotate your key.',
              requestId: 'req_dd',
              details: {},
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    ) as unknown as AuthDeps['fetchImpl'];

    // No existing profile → falls back to DEFAULT_API_URL.
    const error = await runConfigure(
      { profile: 'default', output: 'text', debug: false, fromEnv: true },
      {
        ...deps,
        env: { TESTSPRITE_API_KEY: 'sk-bad' },
        credentialsPath,
        fetchImpl: rejectedFetch,
      },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CLIError);
    const msg = (error as CLIError).message;
    // Must contain the endpoint so the user knows which host rejected the key.
    expect(msg).toContain('https://api.testsprite.com');
    // Must contain the TESTSPRITE_API_URL hint.
    expect(msg).toContain('TESTSPRITE_API_URL');
  });

  it('treats an empty / whitespace TESTSPRITE_API_URL as unset (falls through to profile, never "")', async () => {
    const { capture, deps } = makeCapture();
    // An exported-but-empty env var (`export TESTSPRITE_API_URL=`) must not
    // short-circuit the `??` chain to an empty endpoint; it should fall through
    // to the existing profile's api_url.
    writeProfile(
      'default',
      { apiKey: 'sk-old', apiUrl: 'https://api.example.com:8443' },
      { path: credentialsPath },
    );
    const seenFetchUrls: string[] = [];
    const urlAwareFetch: AuthDeps['fetchImpl'] = vi.fn(async (input: unknown) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
      seenFetchUrls.push(url);
      return new Response(JSON.stringify(sampleMe), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as AuthDeps['fetchImpl'];
    await runConfigure(
      { profile: 'default', output: 'text', debug: false, fromEnv: true },
      {
        ...deps,
        env: { TESTSPRITE_API_KEY: 'sk-new', TESTSPRITE_API_URL: '   ' },
        credentialsPath,
        fetchImpl: urlAwareFetch,
      },
    );
    // Empty env → inherit the profile's dev endpoint, never "".
    expect(readProfile('default', { path: credentialsPath })?.apiUrl).toBe(
      'https://api.example.com:8443',
    );
    // The /me ping must have gone to the inherited dev URL, not an empty/relative one.
    expect(seenFetchUrls[0]).toMatch(/^https:\/\/api\.example\.com:8443\//);
    // And the inherit advisory must still fire (empty env is treated as absent).
    expect(capture.stderr.join('\n')).toContain(
      '[advisory] Inheriting api_url from existing profile: https://api.example.com:8443',
    );
  });

  // Telemetry attribution: commandTag → X-CLI-Command header on the validate /me
  // so the backend counts `init` onboarding as cli.initialized (not session_started).
  it('sends X-CLI-Command on the validation /me when commandTag is set', async () => {
    const { deps } = makeCapture();
    const sentHeaders: Array<Record<string, string> | undefined> = [];
    const capturingFetch = vi.fn(
      async (_url: string, init: { headers?: Record<string, string> }) => {
        sentHeaders.push(init?.headers);
        return new Response(JSON.stringify(sampleMe), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    ) as unknown as AuthDeps['fetchImpl'];
    await runConfigure(
      { profile: 'default', output: 'json', debug: false, fromEnv: true },
      {
        ...deps,
        env: { TESTSPRITE_API_KEY: 'sk' },
        credentialsPath,
        fetchImpl: capturingFetch,
        commandTag: 'init',
      },
    );
    expect(sentHeaders.some(h => h?.['x-cli-command'] === 'init')).toBe(true);
  });

  it('omits X-CLI-Command when no commandTag (plain auth configure)', async () => {
    const { deps } = makeCapture();
    const sentHeaders: Array<Record<string, string> | undefined> = [];
    const capturingFetch = vi.fn(
      async (_url: string, init: { headers?: Record<string, string> }) => {
        sentHeaders.push(init?.headers);
        return new Response(JSON.stringify(sampleMe), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    ) as unknown as AuthDeps['fetchImpl'];
    await runConfigure(
      { profile: 'default', output: 'json', debug: false, fromEnv: true },
      {
        ...deps,
        env: { TESTSPRITE_API_KEY: 'sk' },
        credentialsPath,
        fetchImpl: capturingFetch,
      },
    );
    expect(sentHeaders.every(h => h?.['x-cli-command'] === undefined)).toBe(true);
  });
});

describe('runWhoami', () => {
  function makeFetch(response: Response | Error): typeof fetch {
    if (response instanceof Error) {
      return vi.fn(async () => {
        throw response;
      }) as unknown as typeof fetch;
    }
    return vi.fn(async () => response) as unknown as typeof fetch;
  }

  function meResponse(): Response {
    return new Response(JSON.stringify(sampleMe), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('calls GET /me using the configured profile and prints text output', async () => {
    writeProfile(
      'default',
      { apiKey: 'sk-stored', apiUrl: 'https://api.example.com' },
      { path: credentialsPath },
    );
    const { capture, deps } = makeCapture();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(input.toString()).toBe('https://api.example.com/api/cli/v1/me');
      const headers = new Headers(init?.headers);
      expect(headers.get('x-api-key')).toBe('sk-stored');
      expect(headers.get('authorization')).toBeNull();
      return meResponse();
    });
    const me = await runWhoami(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, env: {}, credentialsPath, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(me).toEqual(sampleMe);
    expect(capture.stdout.join('\n')).toContain('userId: u-1');
    expect(capture.stdout.join('\n')).toContain('scopes: read:projects, read:tests');
  });

  it('emits JSON when --output json', async () => {
    writeProfile('default', { apiKey: 'sk' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runWhoami(
      { profile: 'default', output: 'json', debug: false },
      { ...deps, env: {}, credentialsPath, fetchImpl: makeFetch(meResponse()) },
    );
    const printed = JSON.parse(capture.stdout.join(''));
    expect(printed).toEqual(sampleMe);
  });

  it('L1788: text output includes the resolved endpoint URL', async () => {
    writeProfile(
      'default',
      { apiKey: 'sk-stored', apiUrl: 'https://api.example.com' },
      { path: credentialsPath },
    );
    const { capture, deps } = makeCapture();
    await runWhoami(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        env: {},
        credentialsPath,
        fetchImpl: vi.fn(
          async () =>
            new Response(JSON.stringify(sampleMe), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ) as unknown as typeof fetch,
      },
    );
    const out = capture.stdout.join('\n');
    // Endpoint must be surfaced so the user can confirm which env they are in.
    expect(out).toContain('endpoint:');
    expect(out).toContain('api.example.com');
  });

  it('L1788: JSON output does NOT add endpoint (raw /me envelope is passed through)', async () => {
    writeProfile(
      'default',
      { apiKey: 'sk-stored', apiUrl: 'https://api.example.com' },
      { path: credentialsPath },
    );
    const { capture, deps } = makeCapture();
    await runWhoami(
      { profile: 'default', output: 'json', debug: false },
      {
        ...deps,
        env: {},
        credentialsPath,
        fetchImpl: vi.fn(
          async () =>
            new Response(JSON.stringify(sampleMe), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ) as unknown as typeof fetch,
      },
    );
    // JSON mode outputs the raw server envelope — endpoint is only in text.
    const parsed = JSON.parse(capture.stdout.join('')) as Record<string, unknown>;
    expect(parsed.userId).toBe('u-1');
    // endpoint is not part of the wire response, so must not appear in JSON output.
    expect(parsed).not.toHaveProperty('endpoint');
  });

  it('L1866: renders email + name in text mode when the backend supplies them', async () => {
    writeProfile('default', { apiKey: 'sk' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const meWithEmail = new Response(
      JSON.stringify({ ...sampleMe, email: 'alice@example.com', displayName: 'Alice' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
    await runWhoami(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, env: {}, credentialsPath, fetchImpl: makeFetch(meWithEmail) },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('email:  alice@example.com');
    expect(out).toContain('name:   Alice');
    expect(out).toContain('userId: u-1');
  });

  it('L1866: omits email/name lines when the backend does not return them', async () => {
    writeProfile('default', { apiKey: 'sk' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runWhoami(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, env: {}, credentialsPath, fetchImpl: makeFetch(meResponse()) },
    );
    const out = capture.stdout.join('\n');
    expect(out).not.toContain('email:');
    expect(out).not.toContain('name:');
    expect(out).toContain('userId: u-1');
  });

  it('L1866: passes email through verbatim in JSON mode when present', async () => {
    writeProfile('default', { apiKey: 'sk' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const meWithEmail = new Response(JSON.stringify({ ...sampleMe, email: 'alice@example.com' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    await runWhoami(
      { profile: 'default', output: 'json', debug: false },
      { ...deps, env: {}, credentialsPath, fetchImpl: makeFetch(meWithEmail) },
    );
    const printed = JSON.parse(capture.stdout.join('')) as MeResponse;
    expect(printed.email).toBe('alice@example.com');
  });

  it('throws AUTH_REQUIRED locally when no profile/key is configured', async () => {
    const { deps } = makeCapture();
    await expect(
      runWhoami(
        { profile: 'default', output: 'text', debug: false },
        { ...deps, env: {}, credentialsPath, fetchImpl: makeFetch(meResponse()) },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('falls back to TESTSPRITE_API_KEY env when the file has no key', async () => {
    const { deps } = makeCapture();
    await runWhoami(
      { profile: 'default', output: 'text', debug: false },
      {
        ...deps,
        env: { TESTSPRITE_API_KEY: 'sk-env' },
        credentialsPath,
        fetchImpl: makeFetch(meResponse()),
      },
    );
  });

  it('emits debug events to stderr when debug is enabled', async () => {
    writeProfile('default', { apiKey: 'sk' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runWhoami(
      { profile: 'default', output: 'json', debug: true },
      { ...deps, env: {}, credentialsPath, fetchImpl: makeFetch(meResponse()) },
    );
    const stderr = capture.stderr.join('\n');
    expect(stderr).toContain('"kind":"request"');
    expect(stderr).toContain('"kind":"response"');
    expect(stderr).not.toContain('x-api-key');
  });

  it('forwards server AUTH_INVALID with exit code 3', async () => {
    writeProfile('default', { apiKey: 'sk-bad' }, { path: credentialsPath });
    const { deps } = makeCapture();
    const errorBody = {
      error: {
        code: 'AUTH_INVALID',
        message: 'Bad key.',
        nextAction: 'rotate it',
        requestId: 'req_x',
        details: { reason: 'revoked' },
      },
    };
    await expect(
      runWhoami(
        { profile: 'default', output: 'text', debug: false },
        {
          ...deps,
          env: {},
          credentialsPath,
          fetchImpl: makeFetch(new Response(JSON.stringify(errorBody), { status: 401 })),
        },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID', exitCode: 3 });
  });

  // C2: warn in text mode when key is missing write:tests or run:tests
  it('C2 — text mode warns when key lacks write:tests and run:tests', async () => {
    const readOnlyMe: MeResponse = {
      ...sampleMe,
      scopes: ['read:projects', 'read:tests'],
    };
    writeProfile('default', { apiKey: 'sk' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const fetchImpl = makeFetch(
      new Response(JSON.stringify(readOnlyMe), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await runWhoami(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, env: {}, credentialsPath, fetchImpl },
    );
    const out = capture.stdout.join('\n');
    expect(out).toContain('note:');
    expect(out).toContain('write:tests');
    expect(out).toContain('run:tests');
  });

  it('C2 — text mode shows NO warning when key has both write:tests and run:tests', async () => {
    const fullMe: MeResponse = {
      ...sampleMe,
      scopes: ['read:projects', 'read:tests', 'write:tests', 'run:tests'],
    };
    writeProfile('default', { apiKey: 'sk' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const fetchImpl = makeFetch(
      new Response(JSON.stringify(fullMe), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await runWhoami(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, env: {}, credentialsPath, fetchImpl },
    );
    const out = capture.stdout.join('\n');
    expect(out).not.toContain('note:');
  });

  it('C2 — JSON mode does NOT include the scope warning (clean envelope)', async () => {
    const readOnlyMe: MeResponse = {
      ...sampleMe,
      scopes: ['read:projects', 'read:tests'],
    };
    writeProfile('default', { apiKey: 'sk' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const fetchImpl = makeFetch(
      new Response(JSON.stringify(readOnlyMe), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await runWhoami(
      { profile: 'default', output: 'json', debug: false },
      { ...deps, env: {}, credentialsPath, fetchImpl },
    );
    // JSON stdout must be the raw MeResponse envelope — no warning field.
    const parsed = JSON.parse(capture.stdout.join('')) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('note');
    // The warning does NOT appear in stdout when JSON mode is active.
    expect(capture.stdout.join('\n')).not.toContain('note:');
  });
});

describe('runLogout', () => {
  it('removes the profile and reports success', async () => {
    writeProfile('default', { apiKey: 'sk' }, { path: credentialsPath });
    writeProfile('dev', { apiKey: 'sk-dev' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runLogout(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath },
    );
    expect(readProfile('default', { path: credentialsPath })).toBeUndefined();
    expect(readProfile('dev', { path: credentialsPath })).toBeDefined();
    expect(capture.stdout.join('\n')).toContain('Removed credentials');
  });

  it('reports no_credentials when the profile is not present', async () => {
    const { capture, deps } = makeCapture();
    await runLogout(
      { profile: 'default', output: 'text', debug: false },
      { ...deps, credentialsPath },
    );
    expect(capture.stdout.join('\n')).toContain('No credentials stored');
  });
});

describe('createAuthCommand wiring', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('exposes status/remove as primaries plus deprecated whoami/logout aliases', () => {
    const auth = createAuthCommand();
    // `configure` is NOT here — it is a hidden, program-level alias for `setup`
    // (attached in index.ts) so it can route through the setup flow.
    expect(auth.commands.map(c => c.name()).sort()).toEqual([
      'logout',
      'remove',
      'status',
      'whoami',
    ]);
  });

  it('remove deletes the active profile and exits 0', async () => {
    writeProfile('default', { apiKey: 'sk-remove' }, { path: credentialsPath });
    const { deps } = makeCapture();
    const auth = createAuthCommand({ ...deps, credentialsPath });
    auth.exitOverride();
    auth.commands.forEach(c => c.exitOverride());
    await auth.parseAsync(['remove'], { from: 'user' });
    expect(readProfile('default', { path: credentialsPath })).toBeUndefined();
  });

  it('deprecated `whoami` alias emits a deprecation notice pointing at `auth status`', async () => {
    writeProfile('default', { apiKey: 'sk' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const auth = createAuthCommand({
      ...deps,
      credentialsPath,
      env: {},
      fetchImpl: meOkFetch,
    });
    auth.exitOverride();
    auth.commands.forEach(c => c.exitOverride());
    await auth.parseAsync(['whoami'], { from: 'user' });
    expect(capture.stderr.join('\n')).toContain('[deprecated]');
    expect(capture.stderr.join('\n')).toContain('auth status');
  });

  it('whoami uses injected fetch and exits 0', async () => {
    writeProfile('default', { apiKey: 'sk' }, { path: credentialsPath });
    const { deps } = makeCapture();
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(sampleMe), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const auth = createAuthCommand({ ...deps, credentialsPath, env: {}, fetchImpl });
    auth.exitOverride();
    auth.commands.forEach(c => c.exitOverride());
    await auth.parseAsync(['whoami'], { from: 'user' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('L1802: `status` alias resolves to the whoami action', async () => {
    writeProfile('default', { apiKey: 'sk' }, { path: credentialsPath });
    const { deps } = makeCapture();
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(sampleMe), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const auth = createAuthCommand({ ...deps, credentialsPath, env: {}, fetchImpl });
    auth.exitOverride();
    auth.commands.forEach(c => c.exitOverride());
    await auth.parseAsync(['status'], { from: 'user' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('logout removes the profile', async () => {
    writeProfile('default', { apiKey: 'sk' }, { path: credentialsPath });
    const { deps } = makeCapture();
    const auth = createAuthCommand({ ...deps, credentialsPath });
    auth.exitOverride();
    auth.commands.forEach(c => c.exitOverride());
    await auth.parseAsync(['logout'], { from: 'user' });
    expect(readProfile('default', { path: credentialsPath })).toBeUndefined();
  });
});

describe('createAuthCommand surface', () => {
  it('returns an ApiError type that maps to the right exit code', () => {
    const err = ApiError.authRequired();
    expect(err.exitCode).toBe(3);
  });
});
