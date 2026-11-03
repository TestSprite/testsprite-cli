/**
 * Command-level coverage for the documented profile-resolution order:
 *
 *   `--profile` flag  >  `TESTSPRITE_PROFILE` env var  >  `default`
 *
 * `src/lib/config.test.ts` already asserts this for `loadConfig` in isolation,
 * and always passed — because it calls `loadConfig()` without a `profile`, so
 * `options.profile` really is `undefined` at that layer. Every real command
 * resolved its own profile first and handed `loadConfig` a concrete string,
 * which short-circuited the `??` chain and made the env var unreachable from
 * any CLI entry point. A user exporting `TESTSPRITE_PROFILE` silently kept
 * using the `default` profile's key — writing to the wrong workspace with no
 * error.
 *
 * These tests therefore assert on the WIRE (request URL + `x-api-key` header),
 * driven through `parseAsync` on a program that mirrors the real global-flag
 * wiring. Asserting on the resolved options object would not have caught the
 * original bug; asserting on what was actually sent does.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/errors.js';
import { createProjectCommand, type ProjectDeps } from './project.js';
import { createAuthCommand } from './auth.js';
import { createDoctorCommand } from './doctor.js';

const DEFAULT_KEY = 'sk-user-default-profile-key';
const ALT_KEY = 'sk-user-alt-profile-key';
const DEFAULT_URL = 'http://127.0.0.1:13801';
const ALT_URL = 'http://127.0.0.1:13802';

function makeCreds(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-profile-env-'));
  const credentialsPath = join(dir, 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture: `dir` comes from this function's own mkdtempSync() call, not from any input, so the path is fully controlled by the test.
  writeFileSync(
    credentialsPath,
    `[default]\napi_url = ${DEFAULT_URL}\napi_key = ${DEFAULT_KEY}\n\n` +
      `[alt]\napi_url = ${ALT_URL}\napi_key = ${ALT_KEY}\n`,
    { mode: 0o600 },
  );
  return credentialsPath;
}

interface SeenRequest {
  url: string;
  apiKey: string;
}

function recordingFetch(seen: SeenRequest[], body: unknown): ProjectDeps['fetchImpl'] {
  return (async (input: Parameters<typeof globalThis.fetch>[0], init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    seen.push({
      url: String(input),
      apiKey: headers.get('x-api-key') ?? '',
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as ProjectDeps['fetchImpl'];
}

/**
 * A parent program carrying the same global flags `src/index.ts` registers, so
 * `optsWithGlobals()` inside the subcommand sees `--profile` exactly as it does
 * in the real binary.
 */
function makeProgram(deps: ProjectDeps): Command {
  const program = new Command();
  program.exitOverride();
  program.option('--profile <name>', 'Configuration profile to use');
  program.option('--endpoint-url <url>', 'Override the API endpoint host');
  program.addCommand(createProjectCommand(deps));
  return program;
}

describe('profile resolution at the command layer', () => {
  it('honors TESTSPRITE_PROFILE when --profile is absent', async () => {
    const credentialsPath = makeCreds();
    const seen: SeenRequest[] = [];
    const program = makeProgram({
      env: { TESTSPRITE_PROFILE: 'alt' },
      credentialsPath,
      fetchImpl: recordingFetch(seen, { items: [], nextToken: null }),
      stdout: () => {},
      stderr: () => {},
    });

    await program.parseAsync(['project', 'list'], { from: 'user' });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain(ALT_URL);
    expect(seen[0]!.apiKey).toBe(ALT_KEY);
  });

  it('lets --profile win over TESTSPRITE_PROFILE', async () => {
    const credentialsPath = makeCreds();
    const seen: SeenRequest[] = [];
    const program = makeProgram({
      env: { TESTSPRITE_PROFILE: 'alt' },
      credentialsPath,
      fetchImpl: recordingFetch(seen, { items: [], nextToken: null }),
      stdout: () => {},
      stderr: () => {},
    });

    await program.parseAsync(['--profile', 'default', 'project', 'list'], { from: 'user' });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain(DEFAULT_URL);
    expect(seen[0]!.apiKey).toBe(DEFAULT_KEY);
  });

  it('falls back to the default profile when neither is set', async () => {
    const credentialsPath = makeCreds();
    const seen: SeenRequest[] = [];
    const program = makeProgram({
      env: {},
      credentialsPath,
      fetchImpl: recordingFetch(seen, { items: [], nextToken: null }),
      stdout: () => {},
      stderr: () => {},
    });

    await program.parseAsync(['project', 'list'], { from: 'user' });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain(DEFAULT_URL);
    expect(seen[0]!.apiKey).toBe(DEFAULT_KEY);
  });

  it('treats a blank TESTSPRITE_PROFILE as unset instead of failing the INI name guard', async () => {
    const credentialsPath = makeCreds();
    const seen: SeenRequest[] = [];
    const program = makeProgram({
      env: { TESTSPRITE_PROFILE: '   ' },
      credentialsPath,
      fetchImpl: recordingFetch(seen, { items: [], nextToken: null }),
      stdout: () => {},
      stderr: () => {},
    });

    await program.parseAsync(['project', 'list'], { from: 'user' });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain(DEFAULT_URL);
    expect(seen[0]!.apiKey).toBe(DEFAULT_KEY);
  });

  it('names the selected profile when it has no credentials, instead of a bare auth error', async () => {
    const credentialsPath = makeCreds();
    const program = makeProgram({
      env: { TESTSPRITE_PROFILE: 'typo' },
      credentialsPath,
      fetchImpl: recordingFetch([], { items: [], nextToken: null }),
      stdout: () => {},
      stderr: () => {},
    });

    // Honoring the env var means a typo in it now selects a profile that does
    // not exist. The remediation has to say so, or the reader is sent to
    // configure the default profile they already have.
    const error = await program
      .parseAsync(['project', 'list'], { from: 'user' })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe('AUTH_REQUIRED');
    // `message` is stable per code by contract — the profile goes in the
    // remediation and in `details`.
    expect(apiError.message).toBe('Authentication is required.');
    expect(apiError.nextAction).toContain('profile "typo"');
    expect(apiError.nextAction).toContain('testsprite setup --profile typo');
    expect(apiError.details.profile).toBe('typo');
  });

  it('never echoes a profile name shaped like an API key', async () => {
    const credentialsPath = makeCreds();
    // The credentials-file guard only checks that a name is a safe INI section,
    // and every key format satisfies that. `TESTSPRITE_PROFILE=$SOME_KEY_VAR`
    // must not print the key to stderr or into `--output json`.
    const keyShaped = `sk-user-${'A'.repeat(43)}`;
    const program = makeProgram({
      env: { TESTSPRITE_PROFILE: keyShaped },
      credentialsPath,
      fetchImpl: recordingFetch([], { items: [], nextToken: null }),
      stdout: () => {},
      stderr: () => {},
    });

    const error = await program
      .parseAsync(['project', 'list'], { from: 'user' })
      .then(() => undefined)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe('AUTH_REQUIRED');
    expect(apiError.nextAction).not.toContain(keyShaped);
    expect(JSON.stringify(apiError.details)).not.toContain(keyShaped);
    expect(apiError.details).toEqual({});
  });

  it('reports the env-selected profile in `doctor`, and reports the one it actually used', async () => {
    const credentialsPath = makeCreds();
    const out: string[] = [];
    const seen: SeenRequest[] = [];
    const doctor = createDoctorCommand({
      env: { TESTSPRITE_PROFILE: 'alt' },
      credentialsPath,
      fetchImpl: recordingFetch(seen, { userId: 'u_1' }),
      stdout: line => out.push(line),
      stderr: () => {},
      cwd: mkdtempSync(join(tmpdir(), 'cli-profile-env-cwd-')),
    });
    doctor.exitOverride();

    // `doctor` throws only on a failed check; a missing skill in the throwaway
    // cwd is a warning, and with connectivity mocked green nothing fails — so
    // this must NOT swallow errors.
    await doctor.parseAsync([], { from: 'user' });

    const text = out.join('\n');
    expect(text).toMatch(/Profile\s+alt/);
    expect(text).toContain(ALT_URL);
    // `doctor` builds its displayed config and its connectivity client
    // separately, so asserting only on the printed text would pass even if the
    // probe authenticated as a different profile than the one it names.
    expect(seen).not.toHaveLength(0);
    for (const request of seen) {
      expect(request.url).toContain(ALT_URL);
      expect(request.apiKey).toBe(ALT_KEY);
    }
  });

  it('points credential WRITES at the env-selected profile and leaves the others alone', async () => {
    const credentialsPath = makeCreds();
    const auth = createAuthCommand({
      env: { TESTSPRITE_PROFILE: 'alt' },
      credentialsPath,
      stdout: () => {},
      stderr: () => {},
    });
    const program = new Command();
    program.exitOverride();
    program.option('--profile <name>', 'Configuration profile to use');
    program.addCommand(auth);

    // `auth remove` deletes "the active profile". Now that the env var selects
    // it, this deletes `alt` — the destructive mirror of the read path, and the
    // change most likely to surprise someone who exported the variable months
    // ago and concluded it did nothing.
    await program.parseAsync(['auth', 'remove'], { from: 'user' });

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture: `credentialsPath` is the file makeCreds() just created under its own mkdtempSync() directory.
    const after = readFileSync(credentialsPath, 'utf8');
    expect(after).not.toContain(ALT_KEY);
    expect(after).toContain(DEFAULT_KEY);
  });
});
