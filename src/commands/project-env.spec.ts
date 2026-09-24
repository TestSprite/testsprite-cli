/**
 * Unit tests for `project env <verb>` — DEV-1305 (Phase 1 of DEV-793).
 *
 * All HTTP is mocked via `makeFetch` / `makeCreds`, same harness as
 * `project.test.ts`. Every write verb is exercised for its wire shape
 * (method, path, body, idempotency header) and the local validations that
 * must refuse BEFORE any request is sent. Secrets: the password must never
 * appear on stdout in either output mode.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/errors.js';
import { createProjectCommand } from './project.js';
import {
  createProjectEnvCommand,
  runEnvCreate,
  runEnvDelete,
  runEnvList,
  runEnvSetDefault,
  runEnvUpdate,
  type CliProjectEnvironment,
} from './project-env.js';

type FetchInput = Parameters<typeof globalThis.fetch>[0];

interface Call {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function makeFetch(
  calls: Call[],
  handler: (call: Call) => { status?: number; body: unknown },
): typeof globalThis.fetch {
  return (async (input: FetchInput, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: Call = {
      method: (init.method ?? 'GET').toUpperCase(),
      url,
      body:
        init.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body)),
      headers,
    };
    calls.push(call);
    const { status = 200, body } = handler(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

function makeCreds(apiKey = 'sk-user-test', apiUrl = 'http://localhost:13504') {
  const dir = mkdtempSync(join(tmpdir(), 'cli-proj-env-'));
  const credentialsPath = join(dir, 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- writes into this test's own mkdtempSync temp dir, never user input.
  mkdirSync(dir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- writes into this test's own mkdtempSync temp dir, never user input.
  writeFileSync(credentialsPath, `[default]\napi_url = ${apiUrl}\napi_key = ${apiKey}\n`, {
    mode: 0o600,
  });
  return { credentialsPath, dir };
}

const PROJECT_ID = '22c810b0-f34c-42c0-b372-af6f4e1c4fc7';
const SECRET = 'hunter2-DO-NOT-PRINT';
/** DEV-1305: an app that only runs on this machine is a real environment target. */
const LOCAL_URL = 'http://127.0.0.1:5173';

function env(overrides: Partial<CliProjectEnvironment> = {}): CliProjectEnvironment {
  return {
    id: '10cde22f-f017-415c-b7e5-f236cb564e28',
    name: 'demo',
    url: 'https://demo.example.com',
    isDefault: true,
    authMode: 'account',
    hasCredentials: true,
    username: 'qa+demo@example.com',
    enableOtp: false,
    updatedAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  };
}

const COMMON = {
  profile: 'default',
  output: 'json' as const,
  debug: false,
  verbose: false,
  dryRun: false,
};

function errorEnvelope(code: string, status: number) {
  return {
    status,
    body: {
      error: { code, message: `Error: ${code}`, nextAction: 'x', requestId: 'req_1', details: {} },
    },
  };
}

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

describe('project env — command surface', () => {
  it('is attached under `project` and exposes the five verbs', () => {
    const project = createProjectCommand();
    const envCmd = project.commands.find(c => c.name() === 'env');
    expect(envCmd).toBeDefined();
    const names = envCmd!.commands.map(c => c.name()).sort();
    expect(names).toEqual(['create', 'delete', 'list', 'set-default', 'update']);
  });

  it('create exposes --name, --url / --local, --username, --password, --password-file, --set-default', () => {
    const envCmd = createProjectEnvCommand();
    const create = envCmd.commands.find(c => c.name() === 'create')!;
    const longs = create.options.map(o => o.long);
    for (const flag of [
      '--name',
      '--url',
      '--local',
      '--local-host',
      '--skip-preflight',
      '--username',
      '--password',
      '--password-file',
      '--set-default',
      '--idempotency-key',
    ]) {
      expect(longs).toContain(flag);
    }
    // An environment always has an address — there is no URL-less shape to opt
    // into, and `--no-url` would silently negate `--url` in commander. And the
    // opt-in for a loopback address is `--local <port>`, the same spelling as
    // `project create`, not a second flag.
    expect(longs).not.toContain('--no-url');
    expect(longs).not.toContain('--origin-mode');
  });

  it('update exposes --url, --rename (and no --clear-url); delete exposes --confirm', () => {
    const envCmd = createProjectEnvCommand();
    const update = envCmd.commands.find(c => c.name() === 'update')!;
    expect(update.options.map(o => o.long)).toEqual(
      expect.arrayContaining([
        '--url',
        '--local',
        '--local-host',
        '--rename',
        '--username',
        '--password-file',
      ]),
    );
    expect(update.options.map(o => o.long)).not.toContain('--clear-url');
    const del = envCmd.commands.find(c => c.name() === 'delete')!;
    expect(del.options.map(o => o.long)).toContain('--confirm');
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('runEnvList', () => {
  it('GETs /projects/{id}/env and passes the payload through in JSON mode', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const out: string[] = [];
    const payload = {
      environments: [env(), env({ name: 'local-dev', url: LOCAL_URL, isDefault: false })],
    };
    const res = await runEnvList(
      { ...COMMON, projectId: PROJECT_ID },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => ({ body: payload })),
        stdout: l => out.push(l),
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toContain(`/projects/${PROJECT_ID}/env`);
    expect(res).toEqual(payload);
    expect(JSON.parse(out.join('\n'))).toEqual(payload);
  });

  it('renders NAME / DEFAULT / URL / AUTH in text mode, loopback URLs verbatim', async () => {
    const { credentialsPath } = makeCreds();
    const out: string[] = [];
    await runEnvList(
      { ...COMMON, output: 'text', projectId: PROJECT_ID },
      {
        credentialsPath,
        fetchImpl: makeFetch([], () => ({
          body: {
            environments: [
              env(),
              env({ name: 'local-dev', url: LOCAL_URL, isDefault: false, enableOtp: true }),
            ],
          },
        })),
        stdout: l => out.push(l),
      },
    );
    const text = out.join('\n');
    expect(text).toMatch(/NAME\s+DEFAULT\s+URL\s+AUTH\s+ACCOUNT/);
    expect(text).toContain('demo');
    expect(text).toContain('https://demo.example.com');
    expect(text).toContain('account (credentials set)');
    expect(text).toContain('local-dev');
    expect(text).toContain(LOCAL_URL);
    expect(text).toContain('+otp');
  });

  it('shows the test-account username per environment, and never a password', async () => {
    const { credentialsPath } = makeCreds();
    const out: string[] = [];
    await runEnvList(
      { ...COMMON, output: 'text', projectId: PROJECT_ID },
      {
        credentialsPath,
        fetchImpl: makeFetch([], () => ({
          body: {
            environments: [
              env(),
              // An environment someone made for the app on their own machine.
              env({
                name: 'local-harris',
                url: LOCAL_URL,
                isDefault: false,
                username: 'harris@localhost.test',
              }),
              // Nothing stored: the column has to say so rather than go blank.
              env({
                name: 'public-docs',
                isDefault: false,
                authMode: 'public',
                hasCredentials: false,
                username: null,
              }),
            ],
          },
        })),
        stdout: l => out.push(l),
      },
    );
    const text = out.join('\n');
    expect(text).toContain('qa+demo@example.com');
    expect(text).toContain('harris@localhost.test');
    // `public-docs` has no account; the row still renders with an em dash.
    expect(text).toMatch(/public-docs.*—/);
    // The facade never sends a password, and nothing here may invent one.
    expect(text).not.toContain(SECRET);
    expect(text.toLowerCase()).not.toContain('password');
  });

  it('says how to create one when the project has no environments', async () => {
    const { credentialsPath } = makeCreds();
    const out: string[] = [];
    await runEnvList(
      { ...COMMON, output: 'text', projectId: PROJECT_ID },
      {
        credentialsPath,
        fetchImpl: makeFetch([], () => ({ body: { environments: [] } })),
        stdout: l => out.push(l),
      },
    );
    expect(out.join('\n')).toContain('project env create');
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('runEnvCreate', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('POSTs { name, url, username, password, setDefault } with a cli-proj-env-create idempotency key', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const created = env({ name: 'staging', url: 'https://staging.example.com', isDefault: true });
    await runEnvCreate(
      {
        ...COMMON,
        projectId: PROJECT_ID,
        name: 'staging',
        url: 'https://staging.example.com',
        username: 'qa@example.com',
        password: SECRET,
        setDefault: true,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => ({ body: { environment: created, created: true } })),
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.method).toBe('POST');
    expect(call!.url).toContain(`/projects/${PROJECT_ID}/env`);
    expect(call!.body).toEqual({
      name: 'staging',
      url: 'https://staging.example.com',
      username: 'qa@example.com',
      password: SECRET,
      setDefault: true,
    });
    expect(call!.headers['idempotency-key']).toMatch(/^cli-proj-env-create-/);
  });

  it('--local <port> builds the loopback URL, probes the port once, and sends the marker', async () => {
    // The same spelling as `project create --local`: an app on your own machine
    // is named by its port. The CLI builds `http://127.0.0.1:<port>` and sends
    // `originMode: 'local'` — the marker is what authorizes storing a loopback
    // address, and it lives on the environment the server creates.
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const connect = vi.fn(async () => {});
    await runEnvCreate(
      {
        ...COMMON,
        projectId: PROJECT_ID,
        name: 'local-dev',
        local: '5173',
        username: 'dev',
        password: SECRET,
      },
      {
        credentialsPath,
        localPortProbeDeps: { connect },
        fetchImpl: makeFetch(calls, () => ({
          body: {
            environment: env({ name: 'local-dev', url: LOCAL_URL, isDefault: false }),
            created: true,
          },
        })),
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(connect).toHaveBeenCalledWith('127.0.0.1', 5173, 2000);
    expect(calls[0]!.body).toEqual({
      name: 'local-dev',
      url: LOCAL_URL,
      originMode: 'local',
      username: 'dev',
      password: SECRET,
    });
  });

  it.each([
    ['localhost', 'http://localhost:5173'],
    ['127.0.0.1', 'http://127.0.0.1:5173'],
    ['::1', 'http://[::1]:5173'],
    ['[::1]', 'http://[::1]:5173'],
  ])('--local-host %s is stored as %s', async (localHost, url) => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    await runEnvCreate(
      {
        ...COMMON,
        projectId: PROJECT_ID,
        name: 'local-dev',
        local: '5173',
        localHost,
        skipPreflight: true,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => ({
          body: { environment: env({ name: 'local-dev', url }), created: true },
        })),
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(calls[0]!.body).toMatchObject({ url, originMode: 'local' });
  });

  it.each(['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173'])(
    'a loopback --url (%s) is refused before any request and redirected to --local',
    async url => {
      const { credentialsPath } = makeCreds();
      const calls: Call[] = [];
      const error = await runEnvCreate(
        { ...COMMON, projectId: PROJECT_ID, name: 'local-dev', url },
        { credentialsPath, fetchImpl: makeFetch(calls, () => ({ body: {} })), stdout: () => {} },
      ).catch(e => e as ApiError);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('VALIDATION_ERROR');
      expect((error as ApiError).nextAction).toContain('Use --local <port> instead of --url');
      expect(calls).toEqual([]);
    },
  );

  it.each([
    [
      { local: '5173', url: 'https://staging.example.com' },
      '--local and --url are mutually exclusive',
    ],
    [
      { localHost: 'localhost', url: 'https://staging.example.com' },
      '--local-host requires --local',
    ],
    [{ local: '0' }, 'must be a port number between 1 and 65535'],
    [{ local: 'abc' }, 'must be a port number between 1 and 65535'],
    [{ local: '5173', localHost: '10.0.0.5' }, 'must name your own machine'],
  ])('refuses %j before TCP or HTTP', async (flags, explanation) => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const connect = vi.fn(async () => {});
    const error = await runEnvCreate(
      { ...COMMON, projectId: PROJECT_ID, name: 'x', ...flags },
      {
        credentialsPath,
        localPortProbeDeps: { connect },
        fetchImpl: makeFetch(calls, () => ({ body: {} })),
        stdout: () => {},
      },
    ).catch(e => e as ApiError);
    expect((error as ApiError).code).toBe('VALIDATION_ERROR');
    expect(`${(error as ApiError).message} ${(error as ApiError).nextAction}`).toContain(
      explanation,
    );
    expect(calls).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses a dead --local port before any request; --skip-preflight dials nothing', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const connect = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const error = await runEnvCreate(
      { ...COMMON, projectId: PROJECT_ID, name: 'local-dev', local: '5173' },
      {
        credentialsPath,
        localPortProbeDeps: { connect },
        fetchImpl: makeFetch(calls, () => ({ body: {} })),
        stdout: () => {},
      },
    ).catch(e => e as ApiError);
    expect((error as ApiError).message).toBe(
      'Nothing is listening on http://127.0.0.1:5173. Start your app first, or pass --skip-preflight.',
    );
    expect(calls).toEqual([]);

    connect.mockClear();
    await runEnvCreate(
      { ...COMMON, projectId: PROJECT_ID, name: 'local-dev', local: '5173', skipPreflight: true },
      {
        credentialsPath,
        localPortProbeDeps: { connect },
        fetchImpl: makeFetch(calls, () => ({
          body: { environment: env({ name: 'local-dev', url: LOCAL_URL }), created: true },
        })),
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(connect).not.toHaveBeenCalled();
    expect(calls[0]!.body).toMatchObject({ url: LOCAL_URL, originMode: 'local' });
  });

  it.each(['http://10.0.0.5', 'http://192.168.1.10', 'http://169.254.169.254', 'ftp://127.0.0.1'])(
    'still refuses %s before any request — the tunnel dials loopback and nothing else',
    async url => {
      const { credentialsPath } = makeCreds();
      const calls: Call[] = [];
      await expect(
        runEnvCreate(
          { ...COMMON, projectId: PROJECT_ID, name: 'x', url },
          { credentialsPath, fetchImpl: makeFetch(calls, () => ({ body: {} })), stdout: () => {} },
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(calls).toEqual([]);
    },
  );

  it('reads --password-file instead of taking the secret inline', async () => {
    const { credentialsPath, dir } = makeCreds();
    const pwFile = join(dir, 'pw.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- writes into this test's own mkdtempSync temp dir, never user input.
    writeFileSync(pwFile, `${SECRET}\n`, { mode: 0o600 });
    const calls: Call[] = [];
    await runEnvCreate(
      {
        ...COMMON,
        projectId: PROJECT_ID,
        name: 'local-dev',
        local: '5173',
        skipPreflight: true,
        passwordFile: pwFile,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => ({
          body: { environment: env({ name: 'local-dev', url: LOCAL_URL }), created: true },
        })),
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect((calls[0]!.body as { password: string }).password).toBe(SECRET);
  });

  it('never prints the password — text or JSON', async () => {
    for (const output of ['text', 'json'] as const) {
      const { credentialsPath } = makeCreds();
      const out: string[] = [];
      const err: string[] = [];
      await runEnvCreate(
        {
          ...COMMON,
          output,
          projectId: PROJECT_ID,
          name: 'local-dev',
          local: '5173',
          skipPreflight: true,
          password: SECRET,
        },
        {
          credentialsPath,
          fetchImpl: makeFetch([], () => ({
            body: { environment: env({ name: 'local-dev', url: LOCAL_URL }), created: true },
          })),
          stdout: l => out.push(l),
          stderr: l => err.push(l),
        },
      );
      expect(out.join('\n')).not.toContain(SECRET);
      expect(err.join('\n')).not.toContain(SECRET);
    }
  });

  it('refuses when --url is missing, with no request sent', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    let thrown: unknown;
    try {
      await runEnvCreate(
        { ...COMMON, projectId: PROJECT_ID, name: 'x' },
        { credentialsPath, fetchImpl: makeFetch(calls, () => ({ body: {} })), stdout: () => {} },
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).code).toBe('VALIDATION_ERROR');
    expect((thrown as ApiError).exitCode).toBe(5);
    expect((thrown as ApiError).nextAction).toMatch(/--url/);
    expect(calls).toEqual([]);
  });

  it('--set-default on a loopback environment is allowed (a local-only project’s default)', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    await runEnvCreate(
      {
        ...COMMON,
        projectId: PROJECT_ID,
        name: 'local-dev',
        local: '5173',
        skipPreflight: true,
        setDefault: true,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => ({
          body: {
            environment: env({ name: 'local-dev', url: LOCAL_URL, isDefault: true }),
            created: true,
          },
        })),
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(calls[0]!.body).toMatchObject({ url: LOCAL_URL, setDefault: true });
  });

  it('refuses --password together with --password-file', async () => {
    const { credentialsPath, dir } = makeCreds();
    const pwFile = join(dir, 'pw.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- writes into this test's own mkdtempSync temp dir, never user input.
    writeFileSync(pwFile, SECRET);
    await expect(
      runEnvCreate(
        {
          ...COMMON,
          projectId: PROJECT_ID,
          name: 'x',
          local: '5173',
          password: SECRET,
          passwordFile: pwFile,
        },
        { credentialsPath, fetchImpl: makeFetch([], () => ({ body: {} })), stdout: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('surfaces a server FEATURE_GATED envelope as exit 13', async () => {
    const { credentialsPath } = makeCreds();
    let thrown: unknown;
    try {
      await runEnvCreate(
        { ...COMMON, projectId: PROJECT_ID, name: 'x', url: 'https://staging.example.com' },
        {
          credentialsPath,
          fetchImpl: makeFetch([], () => errorEnvelope('FEATURE_GATED', 403)),
          stdout: () => {},
          stderr: () => {},
        },
      );
    } catch (e) {
      thrown = e;
    }
    expect((thrown as ApiError).code).toBe('FEATURE_GATED');
    expect((thrown as ApiError).exitCode).toBe(13);
  });

  it('--dry-run prints a sample and neither dials nor requests', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const out: string[] = [];
    const connect = vi.fn(async () => {});
    const res = await runEnvCreate(
      {
        ...COMMON,
        dryRun: true,
        projectId: PROJECT_ID,
        name: 'local-dev',
        local: '5173',
        password: SECRET,
      },
      {
        credentialsPath,
        localPortProbeDeps: { connect },
        fetchImpl: makeFetch(calls, () => ({ body: {} })),
        stdout: l => out.push(l),
        stderr: () => {},
      },
    );
    expect(calls).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
    expect(res.created).toBe(true);
    expect(res.environment.name).toBe('local-dev');
    expect(res.environment.url).toBe(LOCAL_URL);
    expect(out.join('\n')).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe('runEnvUpdate', () => {
  it('PATCHes /projects/{id}/env/{name} with only the supplied fields', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    await runEnvUpdate(
      { ...COMMON, projectId: PROJECT_ID, name: 'local-dev', username: 'dev2', rename: 'local' },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => ({ body: { environment: env({ name: 'local' }) } })),
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toContain(`/projects/${PROJECT_ID}/env/local-dev`);
    expect(calls[0]!.body).toEqual({ username: 'dev2', rename: 'local' });
    expect(calls[0]!.headers['idempotency-key']).toMatch(/^cli-proj-env-update-/);
  });

  it('--local <port> repoints an environment at this machine; a loopback --url is redirected to it; an empty --url is refused', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const connect = vi.fn(async () => {});
    await runEnvUpdate(
      { ...COMMON, projectId: PROJECT_ID, name: 'demo', local: '5173' },
      {
        credentialsPath,
        localPortProbeDeps: { connect },
        fetchImpl: makeFetch(calls, () => ({ body: { environment: env({ url: LOCAL_URL }) } })),
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(connect).toHaveBeenCalledWith('127.0.0.1', 5173, 2000);
    expect(calls[0]!.body).toEqual({ url: LOCAL_URL, originMode: 'local' });

    // A loopback address is never stored through `--url` — `--local` is the
    // one spelling, and the refusal says so.
    const redirected = await runEnvUpdate(
      { ...COMMON, projectId: PROJECT_ID, name: 'demo', url: LOCAL_URL },
      { credentialsPath, fetchImpl: makeFetch([], () => ({ body: {} })), stdout: () => {} },
    ).catch(e => e as ApiError);
    expect((redirected as ApiError).code).toBe('VALIDATION_ERROR');
    expect((redirected as ApiError).nextAction).toContain('Use --local <port> instead of --url');

    // There is no way to clear a URL: an environment always has an address.
    await expect(
      runEnvUpdate(
        { ...COMMON, projectId: PROJECT_ID, name: 'demo', url: '  ' },
        { credentialsPath, fetchImpl: makeFetch([], () => ({ body: {} })), stdout: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses when no mutable flag is supplied, with no request sent', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    await expect(
      runEnvUpdate(
        { ...COMMON, projectId: PROJECT_ID, name: 'demo' },
        { credentialsPath, fetchImpl: makeFetch(calls, () => ({ body: {} })), stdout: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(calls).toEqual([]);
  });

  it('URL-encodes the environment name in the path', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    await runEnvUpdate(
      { ...COMMON, projectId: PROJECT_ID, name: 'pr 12/preview', username: 'x' },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => ({ body: { environment: env() } })),
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(calls[0]!.url).toContain('/env/pr%2012%2Fpreview');
  });
});

// ---------------------------------------------------------------------------
// delete / set-default
// ---------------------------------------------------------------------------

describe('runEnvDelete', () => {
  it('requires --confirm and otherwise sends nothing', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    await expect(
      runEnvDelete(
        { ...COMMON, projectId: PROJECT_ID, name: 'local-dev', confirm: false },
        { credentialsPath, fetchImpl: makeFetch(calls, () => ({ body: {} })), stdout: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(calls).toEqual([]);
  });

  it('DELETEs /projects/{id}/env/{name} with an idempotency key', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const out: string[] = [];
    await runEnvDelete(
      { ...COMMON, output: 'text', projectId: PROJECT_ID, name: 'local-dev', confirm: true },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => ({ body: { deleted: true, name: 'local-dev' } })),
        stdout: l => out.push(l),
        stderr: () => {},
      },
    );
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toContain(`/projects/${PROJECT_ID}/env/local-dev`);
    expect(calls[0]!.headers['idempotency-key']).toMatch(/^cli-proj-env-delete-/);
    expect(out.join('\n')).toContain('deleted: local-dev');
  });

  it('maps a server 409 (deleting the default) to exit 6', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runEnvDelete(
        { ...COMMON, projectId: PROJECT_ID, name: 'demo', confirm: true },
        {
          credentialsPath,
          fetchImpl: makeFetch([], () => errorEnvelope('CONFLICT', 409)),
          stdout: () => {},
          stderr: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', exitCode: 6 });
  });
});

describe('runEnvSetDefault', () => {
  it('POSTs /projects/{id}/env/{name}/default and renders the environment', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const out: string[] = [];
    await runEnvSetDefault(
      { ...COMMON, output: 'text', projectId: PROJECT_ID, name: 'staging' },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => ({
          body: { environment: env({ name: 'staging', isDefault: true }) },
        })),
        stdout: l => out.push(l),
        stderr: () => {},
      },
    );
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain(`/projects/${PROJECT_ID}/env/staging/default`);
    expect(calls[0]!.headers['idempotency-key']).toMatch(/^cli-proj-env-set-default-/);
    expect(out.join('\n')).toContain('default:     yes');
  });
});
