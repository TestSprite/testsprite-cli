/**
 * Unit tests for `project env <verb>`.
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
  runEnvGet,
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
    const responseBody =
      call.method === 'GET' &&
      call.url.endsWith('/env') &&
      body &&
      typeof body === 'object' &&
      'environment' in body
        ? { environments: [(body as { environment: unknown }).environment] }
        : body;
    return new Response(JSON.stringify(responseBody), {
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
/** An app that only runs on this machine is a real environment target. */
const LOCAL_URL = 'http://localhost:5173';

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
    variables: {},
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
  it('is attached under `project` and exposes the environment verbs', () => {
    const project = createProjectCommand();
    const envCmd = project.commands.find(c => c.name() === 'env');
    expect(envCmd).toBeDefined();
    const names = envCmd!.commands.map(c => c.name()).sort();
    expect(names).toEqual(['create', 'delete', 'get', 'list', 'set-default', 'update']);
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

  it('create combines sign-in flags with variables and safe output', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const variables = { REGION: 'west', ROLE: 'qa' };
    const command = createProjectEnvCommand({
      credentialsPath,
      fetchImpl: makeFetch(calls, () => ({
        body: {
          environment: {
            ...env({
              name: 'staging',
              authMode: 'manual',
              hasCredentials: false,
              username: null,
              variables,
            }),
            password: SECRET,
            config: { password: SECRET },
          },
          created: true,
        },
      })),
      stdout: line => stdout.push(line),
      stderr: line => stderr.push(line),
    });
    await command.parseAsync(
      [
        'create',
        PROJECT_ID,
        '--name',
        'staging',
        '--url',
        'https://staging.example.com',
        '--sign-in',
        'sso',
        '--session-ttl',
        'never',
        '--var',
        'REGION=west',
        '--var',
        'ROLE=qa',
      ],
      { from: 'user' },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[1]!.body).toEqual({
      name: 'staging',
      url: 'https://staging.example.com',
      signIn: 'manual',
      sessionReuseTtlSeconds: -1,
      variables,
    });
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain('login:       managed in Portal');
    expect(stdout[0]).toContain('REGION=west');
    expect(stdout[0]).toContain('ROLE=qa');
    expect(stdout[0]).not.toContain(SECRET);
    expect(stderr.join('\n')).toContain('SSO selected: runs will NOT be signed in');
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

describe('environment read and safe writes', () => {
  it('get treats OTP login as managed in Portal', async () => {
    const { credentialsPath } = makeCreds();
    const output: string[] = [];
    const command = createProjectEnvCommand({
      credentialsPath,
      fetchImpl: makeFetch([], () => ({ body: { environment: env({ enableOtp: true }) } })),
      stdout: line => output.push(line),
      stderr: () => {},
    });
    await command.parseAsync(['get', PROJECT_ID, 'demo'], { from: 'user' });
    expect(output.join('\n')).toContain('login:       managed in Portal');
  });

  it('clear credentials dry run reports no login', async () => {
    const output: string[] = [];
    await runEnvUpdate(
      {
        ...COMMON,
        output: 'text',
        dryRun: true,
        projectId: PROJECT_ID,
        name: 'demo',
        clearCredentials: true,
      },
      { stdout: line => output.push(line), stderr: () => {} },
    );
    expect(output.join('\n')).toContain('login:       none');
  });

  it('get uses the name path', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const command = createProjectEnvCommand({
      credentialsPath,
      fetchImpl: makeFetch(calls, () => ({ body: { environment: env() } })),
      stdout: () => {},
      stderr: () => {},
    });
    await command.parseAsync(['get', PROJECT_ID, 'pr 12/preview'], { from: 'user' });
    expect(calls[0]?.url).toContain(`/projects/${PROJECT_ID}/env/pr%2012%2Fpreview`);
  });

  it('get text retains id and omits password', async () => {
    const { credentialsPath } = makeCreds();
    const output: string[] = [];
    const command = createProjectEnvCommand({
      credentialsPath,
      fetchImpl: makeFetch([], () => ({ body: { environment: { ...env(), password: SECRET } } })),
      stdout: line => output.push(line),
      stderr: () => {},
    });
    await command.parseAsync(['get', PROJECT_ID, 'demo'], { from: 'user' });
    expect(output.join('\n')).toContain('name:');
    expect(output.join('\n')).toContain(env().id);
    expect(output.join('\n')).not.toContain(SECRET);
  });

  it('get never echoes a password the server unexpectedly returns — text or JSON, top-level, in variables, or under config', async () => {
    // Defense in depth: the facade's documented wire shape never carries a
    // password (see `CliProjectEnvironment`'s type comment) — this pins what
    // happens if a server regression sends one anyway, in every shape a leak
    // could take: a stray top-level field, a `variables.password` entry, or
    // the Portal's raw `config` object riding along unexpectedly.
    for (const output of ['text', 'json'] as const) {
      const { credentialsPath } = makeCreds();
      const out: string[] = [];
      const res = await runEnvGet(
        { ...COMMON, output, projectId: PROJECT_ID, name: 'demo' },
        {
          credentialsPath,
          fetchImpl: makeFetch([], () => ({
            body: {
              environment: {
                ...env(),
                password: SECRET,
                variables: { password: SECRET, region: 'us-east-1' },
                config: { username: 'qa', password: SECRET },
              },
            },
          })),
          stdout: line => out.push(line),
          stderr: () => {},
        },
      );
      const printed = out.join('\n');
      expect(printed).not.toContain(SECRET);
      expect(printed).not.toContain('"config"');
      // A legitimate, non-secret custom variable alongside the poisoned
      // `password` key still prints — only the reserved key is dropped.
      expect(printed).toContain('region');
      // Only the PRINTED copy is sanitized; the value handed back to a
      // programmatic caller is the untouched server response.
      expect((res.environment as unknown as { password?: string }).password).toBe(SECRET);
    }
  });

  it('clear credentials sends clearCredentials', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    await runEnvUpdate(
      { ...COMMON, projectId: PROJECT_ID, name: 'demo', clearCredentials: true } as Parameters<
        typeof runEnvUpdate
      >[0],
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => ({
          body: { environment: env({ hasCredentials: false, username: null }) },
        })),
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(calls[1]?.body).toEqual({ clearCredentials: true });
  });

  it('clear credentials with a password is rejected locally', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    await expect(
      runEnvUpdate(
        {
          ...COMMON,
          projectId: PROJECT_ID,
          name: 'demo',
          clearCredentials: true,
          password: SECRET,
        } as Parameters<typeof runEnvUpdate>[0],
        {
          credentialsPath,
          fetchImpl: makeFetch(calls, () => ({ body: { environment: env() } })),
          stdout: () => {},
          stderr: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(calls).toEqual([]);
  });

  it('write confirmations retain the legacy id line', async () => {
    const { credentialsPath } = makeCreds();
    const output: string[] = [];
    const deps = {
      credentialsPath,
      fetchImpl: makeFetch([], () => ({ body: { environment: env(), created: true } })),
      stdout: (line: string) => output.push(line),
      stderr: () => {},
    };
    await runEnvCreate(
      { ...COMMON, output: 'text', projectId: PROJECT_ID, name: 'demo', url: env().url },
      deps,
    );
    await runEnvUpdate(
      { ...COMMON, output: 'text', projectId: PROJECT_ID, name: 'demo', username: 'qa' },
      deps,
    );
    await runEnvSetDefault(
      { ...COMMON, output: 'text', projectId: PROJECT_ID, name: 'demo' },
      deps,
    );
    await runEnvDelete(
      { ...COMMON, output: 'text', projectId: PROJECT_ID, name: 'demo', confirm: true },
      { ...deps, fetchImpl: makeFetch([], () => ({ body: { deleted: true, name: 'demo' } })) },
    );
    expect(output.join('\n')).toContain(env().id);
  });
});

describe('environment variables', () => {
  it('mixed update refuses an old server response that applied only the URL', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const output: string[] = [];
    const error = await runEnvUpdate(
      {
        ...COMMON,
        projectId: PROJECT_ID,
        name: 'demo',
        url: 'https://new.example.com',
        clearCredentials: true,
        vars: ['REGION=west'],
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => ({
          body: { environment: env({ url: 'https://new.example.com' }) },
        })),
        stdout: line => output.push(line),
        stderr: () => {},
      },
    ).catch(e => e as ApiError);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[1]?.body).toEqual({
      url: 'https://new.example.com',
      clearCredentials: true,
      variables: { REGION: 'west' },
    });
    expect(error).toMatchObject({
      code: 'UNSUPPORTED',
      nextAction: expect.stringContaining('--clear-credentials'),
    });
    expect((error as ApiError).nextAction).toContain('--var');
    expect((error as ApiError).nextAction).toContain('URL may already have been applied');
    expect(output).toEqual([]);
  });

  it('create --var refuses a response without variables', async () => {
    const { credentialsPath } = makeCreds();
    const output: string[] = [];
    const error = await runEnvCreate(
      { ...COMMON, projectId: PROJECT_ID, name: 'demo', url: env().url, vars: ['REGION=west'] },
      {
        credentialsPath,
        fetchImpl: makeFetch([], call => ({
          body: {
            environment: env(call.method === 'GET' ? {} : { variables: undefined }),
            created: true,
          },
        })),
        stdout: line => output.push(line),
        stderr: () => {},
      },
    ).catch(e => e as ApiError);
    expect(error).toMatchObject({
      code: 'UNSUPPORTED',
      nextAction: expect.stringContaining('server did not apply --var'),
    });
    const nextAction = (error as ApiError).nextAction;
    expect(nextAction).toContain(`was created without them`);
    expect(nextAction).toContain(`testsprite project env update ${PROJECT_ID} demo --var`);
    expect(nextAction).not.toContain('retry');
    expect(output).toEqual([]);
  });

  it.each([
    ['missing key', { REGION: 'west' }],
    ['wrong value', { REGION: 'east', TENANT: 'trial' }],
  ])('update --var rejects a response with %s', async (_case, variables) => {
    const { credentialsPath } = makeCreds();
    const error = await runEnvUpdate(
      {
        ...COMMON,
        projectId: PROJECT_ID,
        name: 'demo',
        vars: ['REGION=west', 'TENANT=trial'],
      },
      {
        credentialsPath,
        fetchImpl: makeFetch([], () => ({ body: { environment: env({ variables }) } })),
        stdout: () => {},
        stderr: () => {},
      },
    ).catch(e => e as ApiError);
    expect(error).toMatchObject({
      code: 'UNSUPPORTED',
      nextAction: expect.stringContaining('server did not apply --var'),
    });
  });

  it('update --var sends a variable merge', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    await runEnvUpdate(
      { ...COMMON, projectId: PROJECT_ID, name: 'demo', vars: ['REGION=east'] },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => ({
          body: { environment: env({ variables: { REGION: 'east' } }) },
        })),
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(calls[1]?.body).toEqual({ variables: { REGION: 'east' } });
  });

  it('repeated --var is sent as variables', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const command = createProjectEnvCommand({
      credentialsPath,
      fetchImpl: makeFetch(calls, () => ({
        body: {
          environment: env({ variables: { REGION: 'west', TENANT: 'trial' } }),
          created: true,
        },
      })),
      stdout: () => {},
      stderr: () => {},
    });
    await command.parseAsync(
      [
        'create',
        PROJECT_ID,
        '--name',
        'demo',
        '--url',
        env().url,
        '--var',
        'REGION=west',
        '--var',
        'TENANT=trial',
      ],
      { from: 'user' },
    );
    expect(calls[1]?.body).toMatchObject({ variables: { REGION: 'west', TENANT: 'trial' } });
  });

  it('--var keeps equals signs in the value', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const command = createProjectEnvCommand({
      credentialsPath,
      fetchImpl: makeFetch(calls, () => ({
        body: { environment: env({ variables: { TOKEN_HINT: 'a=b=c' } }), created: true },
      })),
      stdout: () => {},
      stderr: () => {},
    });
    await command.parseAsync(
      ['create', PROJECT_ID, '--name', 'demo', '--url', env().url, '--var', 'TOKEN_HINT=a=b=c'],
      { from: 'user' },
    );
    expect(calls[1]?.body).toMatchObject({ variables: { TOKEN_HINT: 'a=b=c' } });
  });

  it('duplicate --var is rejected locally', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    await expect(
      runEnvCreate(
        {
          ...COMMON,
          projectId: PROJECT_ID,
          name: 'demo',
          url: env().url,
          vars: ['A=1', 'A=2'],
        } as Parameters<typeof runEnvCreate>[0],
        { credentialsPath, fetchImpl: makeFetch(calls, () => ({ body: {} })), stdout: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(calls).toEqual([]);
  });

  it('reserved --var key is rejected locally', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    await expect(
      runEnvUpdate(
        { ...COMMON, projectId: PROJECT_ID, name: 'demo', vars: ['password=hidden'] } as Parameters<
          typeof runEnvUpdate
        >[0],
        { credentialsPath, fetchImpl: makeFetch(calls, () => ({ body: {} })), stdout: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(calls).toEqual([]);
  });

  it('oversize --var is rejected without echoing the value', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const value = 'private-data-'.repeat(400);
    const error = await runEnvCreate(
      {
        ...COMMON,
        projectId: PROJECT_ID,
        name: 'demo',
        url: env().url,
        vars: [`LONG=${value}`],
      } as Parameters<typeof runEnvCreate>[0],
      { credentialsPath, fetchImpl: makeFetch(calls, () => ({ body: {} })), stdout: () => {} },
    ).catch(e => e as ApiError);
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(JSON.stringify(error)).not.toContain(value);
    expect(calls).toEqual([]);
  });

  it('get lists variables', async () => {
    const { credentialsPath } = makeCreds();
    const output: string[] = [];
    const command = createProjectEnvCommand({
      credentialsPath,
      fetchImpl: makeFetch([], () => ({
        body: {
          environment: env({
            variables: { REGION: 'west', TOKEN_HINT: 'a=b', password: 'must-not-print' },
          }),
        },
      })),
      stdout: line => output.push(line),
      stderr: () => {},
    });
    await command.parseAsync(['get', PROJECT_ID, 'demo'], { from: 'user' });
    expect(output.join('\n')).toContain('REGION=west');
    expect(output.join('\n')).toContain('TOKEN_HINT=a=b');
    expect(output.join('\n')).not.toContain('must-not-print');
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

  it('retries a persistent create conflict once', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const error = await runEnvCreate(
      { ...COMMON, projectId: PROJECT_ID, name: 'demo', url: env().url },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => errorEnvelope('CONFLICT', 409)),
        stdout: () => {},
        stderr: () => {},
      },
    ).catch(e => e as ApiError);
    expect(calls).toHaveLength(2);
    expect(error).toMatchObject({ code: 'CONFLICT', exitCode: 6, nextAction: 'x' });
  });

  it.each([
    [{ signIn: 'otp' }, { signIn: 'otp', otpChannels: ['email'] }],
    [
      { signIn: 'otp', otpChannel: ['sms,email', 'sms'] },
      { signIn: 'otp', otpChannels: ['sms', 'email'] },
    ],
    [
      { signIn: 'sso', sessionTtl: 'never' },
      { signIn: 'manual', sessionReuseTtlSeconds: -1 },
    ],
    [
      { signIn: 'credentials', username: 'qa', password: SECRET },
      { signIn: 'account', username: 'qa', password: SECRET },
    ],
  ])('adds explicit sign-in fields %j', async (flags, expected) => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    await runEnvCreate(
      {
        ...COMMON,
        projectId: PROJECT_ID,
        name: 'staging',
        url: 'https://staging.example.com',
        ...flags,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => ({ body: { environment: env(), created: true } })),
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(calls[0]!.body).toEqual({
      name: 'staging',
      url: 'https://staging.example.com',
      ...expected,
    });
  });

  it.each([
    [{ signIn: 'account' }, '--username'],
    [{ signIn: 'account', username: 'qa' }, '--password'],
    [{ signIn: 'public', username: 'qa' }, '--username'],
    [{ signIn: 'otp', passwordFile: '/missing' }, '--password-file'],
    [{ signIn: 'manual', password: SECRET }, '--password'],
    [{ signIn: 'public', otpChannel: ['sms'] }, '--otp-channel'],
    [{ otpChannel: ['email'] }, '--otp-channel'],
    [{ signIn: 'otp', otpChannel: ['push'] }, '--otp-channel'],
    [
      { signIn: 'otp', local: '5173' },
      '--sign-in otp and --sign-in manual are not available for --local environments',
    ],
    [
      { signIn: 'manual', local: '5173' },
      '--sign-in otp and --sign-in manual are not available for --local environments',
    ],
  ])(
    'rejects invalid sign-in create flags %j before request and file read',
    async (flags, hint) => {
      const { credentialsPath } = makeCreds();
      const calls: Call[] = [];
      const error = (await runEnvCreate(
        {
          ...COMMON,
          projectId: PROJECT_ID,
          name: 'staging',
          url: 'local' in flags ? undefined : 'https://staging.example.com',
          ...flags,
        },
        { credentialsPath, fetchImpl: makeFetch(calls, () => ({ body: {} })), stdout: () => {} },
      ).catch(e => e)) as ApiError;
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.exitCode).toBe(5);
      expect(`${error.message} ${error.nextAction}`).toContain(hint);
      if ('passwordFile' in flags && flags.passwordFile === '/missing')
        expect(error.details.reason).toBe('invalid_sign_in_flags');
      if ('local' in flags && 'signIn' in flags)
        expect(error.details.reason).toBe('local-environment-sign-in-unsupported');
      expect(calls).toEqual([]);
    },
  );

  it.each([
    [
      { password: SECRET, passwordFile: '/missing' },
      '--password and --password-file are mutually exclusive.',
    ],
    [{ username: '   ', password: SECRET }, '--username must not be empty or whitespace-only.'],
    [{ username: 'qa', password: '   ' }, '--password must not be empty or whitespace-only.'],
  ])('uses the sign-in refusal contract for credential flags %j', async (flags, nextAction) => {
    for (const dryRun of [false, true]) {
      const { credentialsPath } = makeCreds();
      const calls: Call[] = [];
      const stdout: string[] = [];
      const error = await runEnvCreate(
        {
          ...COMMON,
          dryRun,
          projectId: PROJECT_ID,
          name: 'staging',
          url: 'https://staging.example.com',
          ...flags,
        },
        {
          credentialsPath,
          fetchImpl: makeFetch(calls, () => ({ body: {} })),
          stdout: line => stdout.push(line),
        },
      ).catch(e => e as ApiError);
      expect(error).toMatchObject({
        code: 'VALIDATION_ERROR',
        exitCode: 5,
        nextAction,
        details: { reason: 'invalid_sign_in_flags' },
      });
      expect(calls).toEqual([]);
      expect(stdout).toEqual([]);
    }
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'rejects inherited --sign-in %s before request',
    async signIn => {
      const { credentialsPath } = makeCreds();
      const calls: Call[] = [];
      const error = (await runEnvCreate(
        {
          ...COMMON,
          projectId: PROJECT_ID,
          name: 'staging',
          url: 'https://staging.example.com',
          signIn,
        },
        { credentialsPath, fetchImpl: makeFetch(calls, () => ({ body: {} })), stdout: () => {} },
      ).catch(e => e)) as ApiError;
      expect(error.exitCode).toBe(5);
      expect(error.details.reason).toBe('invalid_sign_in_flags');
      expect(calls).toEqual([]);
    },
  );

  it.each([
    [
      'manual',
      'SSO selected: runs will NOT be signed in until someone logs in once in the Portal (project → Settings → Environments → staging → Log in). Check with: testsprite project sign-in get ' +
        PROJECT_ID +
        ' --env staging',
    ],
    [
      'otp',
      'OTP selected: see the provisioned inbox/phone with: testsprite project sign-in get ' +
        PROJECT_ID +
        ' --env staging',
    ],
  ])('shows a text hint after creating %s', async (signIn, hint) => {
    const { credentialsPath } = makeCreds();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const deps = {
      credentialsPath,
      fetchImpl: makeFetch([], () => ({
        body: { environment: env({ name: 'staging', authMode: signIn }), created: true },
      })),
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    };
    const opts = {
      ...COMMON,
      output: 'text' as const,
      projectId: PROJECT_ID,
      name: 'staging',
      url: 'https://staging.example.com',
      signIn,
    };
    await runEnvCreate(opts, deps);
    expect(stderr.join('\n')).toContain(hint);
    expect(stdout.join('\n')).not.toContain(hint);
    stderr.length = 0;
    await runEnvCreate({ ...opts, output: 'json' }, deps);
    expect(stderr.join('\n')).not.toContain(hint);
  });

  it.each([[{ password: 'pw' }], [{ username: 'qa@example.com' }]])(
    'refuses half a test account without --sign-in (%j) before any request',
    async creds => {
      const { credentialsPath } = makeCreds();
      const calls: Call[] = [];
      const error = (await runEnvCreate(
        {
          ...COMMON,
          projectId: PROJECT_ID,
          name: 'staging',
          url: 'https://staging.example.com',
          ...creds,
        },
        { credentialsPath, fetchImpl: makeFetch(calls, () => ({ body: {} })), stdout: () => {} },
      ).catch(e => e)) as ApiError;
      expect(error.exitCode).toBe(5);
      expect(error.nextAction).toContain('go together');
      expect(calls).toEqual([]);
    },
  );

  it.each([
    ['public', false, null, false],
    ['otp', false, null, true],
    ['manual', false, null, false],
  ] as const)(
    'previews --sign-in %s in the environment row',
    async (signIn, hasCredentials, username, enableOtp) => {
      const { credentialsPath } = makeCreds();
      const calls: Call[] = [];
      const stdout: string[] = [];
      const result = await runEnvCreate(
        {
          ...COMMON,
          output: 'text',
          dryRun: true,
          projectId: PROJECT_ID,
          name: 'staging',
          url: 'https://staging.example.com',
          signIn,
        },
        {
          credentialsPath,
          fetchImpl: makeFetch(calls, () => ({ body: {} })),
          stdout: line => stdout.push(line),
          stderr: () => {},
        },
      );
      expect(result.environment).toMatchObject({
        authMode: signIn,
        hasCredentials,
        username,
        enableOtp,
      });
      expect(stdout.join('\n')).toContain(
        `login:       ${signIn === 'public' ? 'none' : 'managed in Portal'}`,
      );
      expect(calls).toEqual([]);
    },
  );

  it('previews account credentials without reading the password file', async () => {
    const { credentialsPath } = makeCreds();
    const result = await runEnvCreate(
      {
        ...COMMON,
        dryRun: true,
        projectId: PROJECT_ID,
        name: 'staging',
        url: 'https://staging.example.com',
        signIn: 'account',
        username: 'qa@example.com',
        passwordFile: '/missing',
      },
      {
        credentialsPath,
        fetchImpl: makeFetch([], () => ({ body: {} })),
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(result.environment).toMatchObject({
      authMode: 'account',
      hasCredentials: true,
      username: 'qa@example.com',
      enableOtp: false,
    });
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

  it.each(['http://localhost:5173', 'http://127.0.0.1:5173/', 'http://[::1]:5173'])(
    'a loopback --url (%s) sends the existing wire shape unchanged',
    async url => {
      const { credentialsPath } = makeCreds();
      const calls: Call[] = [];
      const deps = {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => ({ body: { environment: env({ url }), created: true } })),
        stdout: () => {},
        stderr: () => {},
      };
      await runEnvCreate(
        { ...COMMON, projectId: PROJECT_ID, name: 'local-dev', url, skipPreflight: true },
        deps,
      );
      await runEnvUpdate(
        { ...COMMON, projectId: PROJECT_ID, name: 'local-dev', url, skipPreflight: true },
        deps,
      );
      expect(calls.map(call => call.body)).toEqual([
        { name: 'local-dev', url, originMode: 'local' },
        { url, originMode: 'local' },
      ]);
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
      'Nothing is listening on http://localhost:5173. Start your app first, or pass --skip-preflight.',
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
        username: 'dev',
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
          username: 'dev',
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

  it('never prints the password even if the server echoes it back in the response', async () => {
    // Same defense-in-depth as the `get` test above, exercised on the create
    // response shape (`{ environment, created }`).
    for (const output of ['text', 'json'] as const) {
      const { credentialsPath } = makeCreds();
      const out: string[] = [];
      await runEnvCreate(
        {
          ...COMMON,
          output,
          projectId: PROJECT_ID,
          name: 'local-dev',
          local: '5173',
          skipPreflight: true,
          username: 'dev',
          password: SECRET,
        },
        {
          credentialsPath,
          fetchImpl: makeFetch([], () => ({
            body: {
              environment: { ...env({ name: 'local-dev', url: LOCAL_URL }), password: SECRET },
              created: true,
            },
          })),
          stdout: l => out.push(l),
          stderr: () => {},
        },
      );
      const printed = out.join('\n');
      expect(printed).not.toContain(SECRET);
      // Not a vacuous pass: something was actually printed.
      expect(printed).toContain('local-dev');
    }
  });

  it('--debug never traces the request password', async () => {
    const { credentialsPath } = makeCreds();
    const out: string[] = [];
    const err: string[] = [];
    await runEnvCreate(
      {
        ...COMMON,
        output: 'json',
        debug: true,
        projectId: PROJECT_ID,
        name: 'local-dev',
        local: '5173',
        skipPreflight: true,
        username: 'dev',
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
    // Not a vacuous pass: `--debug` actually traced this request, so the
    // absence of SECRET above reflects a checked trace, not an empty one.
    expect(err.some(line => line.startsWith('[debug '))).toBe(true);
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
        username: 'dev',
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

  it('dry-run validates credential flags before printing the plan', async () => {
    const { credentialsPath, dir } = makeCreds();
    const pwFile = join(dir, 'pw.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- writes into this test's own mkdtempSync temp dir, never user input.
    writeFileSync(pwFile, SECRET);
    const calls: Call[] = [];
    const out: string[] = [];
    await expect(
      runEnvCreate(
        {
          ...COMMON,
          dryRun: true,
          projectId: PROJECT_ID,
          name: 'local-dev',
          local: '5173',
          password: SECRET,
          passwordFile: pwFile,
        },
        {
          credentialsPath,
          fetchImpl: makeFetch(calls, () => ({ body: {} })),
          stdout: l => out.push(l),
          stderr: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // No plan was printed and the password file was never read.
    expect(out).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('dry-run never prints the password', async () => {
    for (const output of ['text', 'json'] as const) {
      const { credentialsPath } = makeCreds();
      const out: string[] = [];
      const err: string[] = [];
      await runEnvCreate(
        {
          ...COMMON,
          output,
          dryRun: true,
          projectId: PROJECT_ID,
          name: 'local-dev',
          local: '5173',
          username: 'dev',
          password: SECRET,
        },
        {
          credentialsPath,
          fetchImpl: makeFetch([], () => ({ body: {} })),
          stdout: l => out.push(l),
          stderr: l => err.push(l),
        },
      );
      expect(out.join('\n')).not.toContain(SECRET);
      expect(err.join('\n')).not.toContain(SECRET);
    }
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe('runEnvUpdate', () => {
  it('never prints the password — text or JSON, real path and dry-run, even if the server echoes it back', async () => {
    for (const output of ['text', 'json'] as const) {
      for (const dryRun of [false, true] as const) {
        const { credentialsPath } = makeCreds();
        const out: string[] = [];
        await runEnvUpdate(
          { ...COMMON, output, dryRun, projectId: PROJECT_ID, name: 'demo', password: SECRET },
          {
            credentialsPath,
            fetchImpl: makeFetch([], () => ({
              body: { environment: { ...env(), password: SECRET } },
            })),
            stdout: l => out.push(l),
            stderr: () => {},
          },
        );
        const printed = out.join('\n');
        expect(printed).not.toContain(SECRET);
        // Not a vacuous pass: something was actually printed.
        expect(printed).toContain('demo');
      }
    }
  });

  it('--debug never traces the request password', async () => {
    const { credentialsPath } = makeCreds();
    const out: string[] = [];
    const err: string[] = [];
    await runEnvUpdate(
      {
        ...COMMON,
        output: 'json',
        debug: true,
        projectId: PROJECT_ID,
        name: 'demo',
        password: SECRET,
      },
      {
        credentialsPath,
        fetchImpl: makeFetch([], () => ({ body: { environment: env() } })),
        stdout: l => out.push(l),
        stderr: l => err.push(l),
      },
    );
    expect(out.join('\n')).not.toContain(SECRET);
    expect(err.join('\n')).not.toContain(SECRET);
    // Not a vacuous pass: `--debug` actually traced this request, so the
    // absence of SECRET above reflects a checked trace, not an empty one.
    expect(err.some(line => line.startsWith('[debug '))).toBe(true);
  });

  it('clear credentials requires both no stored credentials and no username in the response', async () => {
    const { credentialsPath } = makeCreds();
    const error = await runEnvUpdate(
      { ...COMMON, projectId: PROJECT_ID, name: 'demo', clearCredentials: true },
      {
        credentialsPath,
        fetchImpl: makeFetch([], () => ({
          body: { environment: env({ hasCredentials: false, username: 'stale@example.com' }) },
        })),
        stdout: () => {},
        stderr: () => {},
      },
    ).catch(e => e as ApiError);
    expect(error).toMatchObject({
      code: 'UNSUPPORTED',
      nextAction: expect.stringContaining('server did not apply --clear-credentials'),
    });
  });

  it('preserves a Portal-only conflict after the compatible retry', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const nextAction = 'Open https://portal.example.com/settings/environments';
    const error = await runEnvUpdate(
      { ...COMMON, projectId: PROJECT_ID, name: 'demo', clearCredentials: true },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, call =>
          call.method === 'GET'
            ? { body: { environments: [env()] } }
            : {
                status: 409,
                body: {
                  error: {
                    code: 'CONFLICT',
                    message: 'Portal-only login mode',
                    nextAction,
                    requestId: 'req_conflict',
                    details: { reason: 'portal-only-login-mode' },
                  },
                },
              },
        ),
        stdout: () => {},
        stderr: () => {},
      },
    ).catch(e => e as ApiError);
    expect(calls).toHaveLength(3);
    expect(error).toMatchObject({
      code: 'CONFLICT',
      exitCode: 6,
      nextAction,
      details: { reason: 'portal-only-login-mode' },
    });
  });

  it.each([
    ['manual', 'text', true],
    ['manual', 'json', false],
    ['account', 'text', false],
  ] as const)(
    'a --url change on a %s environment in %s mode warns about the captured session: %s',
    async (authMode, output, warns) => {
      const { credentialsPath } = makeCreds();
      const stderr: string[] = [];
      await runEnvUpdate(
        { ...COMMON, output, projectId: PROJECT_ID, name: 'sso', url: 'https://new.example.com' },
        {
          credentialsPath,
          fetchImpl: makeFetch([], () => ({
            body: { environment: env({ name: 'sso', authMode, url: 'https://new.example.com' }) },
          })),
          stdout: () => {},
          stderr: (line: string) => stderr.push(line),
        },
      );
      expect(
        stderr.some(line => line.includes('SSO session captured on its previous address')),
      ).toBe(warns);
    },
  );

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

  it('--local and loopback --url repoint an environment; an empty --url is refused', async () => {
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

    const rawUrl = 'http://127.0.0.1:5173/';
    await runEnvUpdate(
      { ...COMMON, projectId: PROJECT_ID, name: 'local-dev', url: rawUrl, skipPreflight: true },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => ({ body: { environment: env({ url: rawUrl }) } })),
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(calls[1]?.body).toEqual({ url: rawUrl, originMode: 'local' });

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

  it('dry-run also validates credential flags before printing the plan', async () => {
    const { credentialsPath, dir } = makeCreds();
    const pwFile = join(dir, 'pw.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- writes into this test's own mkdtempSync temp dir, never user input.
    writeFileSync(pwFile, SECRET);
    const calls: Call[] = [];
    const out: string[] = [];
    await expect(
      runEnvUpdate(
        {
          ...COMMON,
          dryRun: true,
          projectId: PROJECT_ID,
          name: 'demo',
          password: SECRET,
          passwordFile: pwFile,
        },
        {
          credentialsPath,
          fetchImpl: makeFetch(calls, () => ({ body: {} })),
          stdout: l => out.push(l),
          stderr: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(out).toEqual([]);
    expect(calls).toEqual([]);
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
  it('retries a persistent set-default conflict once', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const error = await runEnvSetDefault(
      { ...COMMON, projectId: PROJECT_ID, name: 'demo' },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, () => errorEnvelope('CONFLICT', 409)),
        stdout: () => {},
        stderr: () => {},
      },
    ).catch(e => e as ApiError);
    expect(calls).toHaveLength(2);
    expect(error).toMatchObject({ code: 'CONFLICT', exitCode: 6, nextAction: 'x' });
  });

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

describe('environment compatibility contracts', () => {
  it('appends login and variables after the legacy environment detail lines', async () => {
    const output: string[] = [];
    const { credentialsPath } = makeCreds();
    await runEnvGet(
      { ...COMMON, output: 'text', projectId: PROJECT_ID, name: 'demo' },
      {
        credentialsPath,
        fetchImpl: makeFetch([], () => ({ body: { environment: env({ variables: {} }) } })),
        stdout: line => output.push(line),
        stderr: () => {},
      },
    );
    expect(output[0]?.split('\n').slice(0, 7)).toEqual([
      'name:        demo',
      `id:          ${env().id}`,
      'default:     yes',
      `url:         ${env().url}`,
      'auth:        account (credentials set)',
      `account:     ${env().username}`,
      `updatedAt:   ${env().updatedAt}`,
    ]);
    expect(output[0]?.split('\n')[7]).toBe('login:       username+password (qa+demo@example.com)');
  });

  it('reports an unavailable environment detail route as an unsupported old server', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runEnvGet(
        { ...COMMON, projectId: PROJECT_ID, name: 'demo' },
        {
          credentialsPath,
          fetchImpl: makeFetch([], () => errorEnvelope('NOT_FOUND', 404)),
          stdout: () => {},
          stderr: () => {},
        },
      ),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      exitCode: 7,
      message: expect.stringContaining('server is too old'),
    });
  });

  it.each([
    ['create', 404],
    ['update', 404],
    ['clear', 200],
  ] as const)(
    '%s refuses unsupported environment writes before any side effect (probe %s)',
    async (operation, status) => {
      const { credentialsPath } = makeCreds();
      const calls: Call[] = [];
      const deps = {
        credentialsPath,
        fetchImpl: makeFetch(calls, call => {
          if (call.method === 'GET')
            return status === 200
              ? { body: { environments: [env({ variables: undefined })] } }
              : errorEnvelope('NOT_FOUND', status);
          return { body: { environment: env(), created: true } };
        }),
        stdout: () => {},
        stderr: () => {},
      };
      const attempt =
        operation === 'create'
          ? runEnvCreate(
              {
                ...COMMON,
                projectId: PROJECT_ID,
                name: 'demo',
                url: env().url,
                vars: ['REGION=west'],
              },
              deps,
            )
          : runEnvUpdate(
              {
                ...COMMON,
                projectId: PROJECT_ID,
                name: 'demo',
                ...(operation === 'clear' ? { clearCredentials: true } : { vars: ['REGION=west'] }),
              },
              deps,
            );
      await expect(attempt).rejects.toMatchObject({
        code: 'UNSUPPORTED',
      });
      expect(calls.map(call => call.method)).toEqual(['GET']);
    },
  );

  it.each(['create', 'update', 'set-default'] as const)(
    '%s retries one transient conflict with the same idempotency key',
    async operation => {
      const { credentialsPath } = makeCreds();
      const calls: Call[] = [];
      const deps = {
        credentialsPath,
        fetchImpl: makeFetch(calls, () =>
          calls.length === 1
            ? errorEnvelope('CONFLICT', 409)
            : { body: { environment: env(), created: true } },
        ),
        stdout: () => {},
        stderr: () => {},
      };
      const opts = { ...COMMON, projectId: PROJECT_ID, name: 'demo' };
      let thrown: unknown;
      try {
        if (operation === 'create') await runEnvCreate({ ...opts, url: env().url }, deps);
        else if (operation === 'update') await runEnvUpdate({ ...opts, username: 'qa' }, deps);
        else await runEnvSetDefault(opts, deps);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeUndefined();
      expect(calls).toHaveLength(2);
      expect(calls[0]?.headers['idempotency-key']).toBe(calls[1]?.headers['idempotency-key']);
    },
  );
});

describe('environment capability probe fallbacks', () => {
  it.each([
    { operation: 'create', resource: 'project', detail: false },
    { operation: 'update', resource: 'project', detail: false },
    { operation: 'clear', resource: 'project', detail: false },
    { operation: 'update', resource: 'environment', detail: true },
    { operation: 'clear', resource: 'environment', detail: true },
  ] as const)(
    '$operation preserves a missing $resource response from the capability probe',
    async ({ operation, resource, detail }) => {
      const { credentialsPath } = makeCreds();
      const calls: Call[] = [];
      const output: string[] = [];
      const envelope = {
        code: 'NOT_FOUND',
        message: `The requested ${resource} does not exist.`,
        nextAction: `Choose an existing ${resource}.`,
        requestId: 'request-missing-resource',
        details: { resource, reason: 'missing_resource' },
      };
      const deps = {
        credentialsPath,
        fetchImpl: makeFetch(calls, call =>
          detail && call.url.endsWith('/env')
            ? { body: { environments: [] } }
            : { status: 404, body: { error: envelope } },
        ),
        stdout: (line: string) => output.push(line),
        stderr: () => {},
      };
      const opts = { ...COMMON, projectId: PROJECT_ID, name: 'demo' };
      const attempt =
        operation === 'create'
          ? runEnvCreate({ ...opts, url: env().url, vars: ['REGION=west'] }, deps)
          : runEnvUpdate(
              {
                ...opts,
                ...(operation === 'clear' ? { clearCredentials: true } : { vars: ['REGION=west'] }),
              },
              deps,
            );
      await expect(attempt).rejects.toMatchObject({ ...envelope, httpStatus: 404, exitCode: 4 });
      expect(calls.map(call => call.method)).toEqual(detail ? ['GET', 'GET'] : ['GET']);
      expect(output).toEqual([]);
    },
  );

  it('supports the first environment with variables when the detail route proves support', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    await runEnvCreate(
      { ...COMMON, projectId: PROJECT_ID, name: 'first', url: env().url, vars: ['REGION=west'] },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, call => {
          if (call.method === 'GET' && call.url.endsWith('/env'))
            return { body: { environments: [] } };
          if (call.method === 'GET')
            return {
              status: 400,
              body: {
                error: {
                  code: 'VALIDATION_ERROR',
                  message: 'Unknown environment',
                  nextAction: 'Choose a name',
                  requestId: 'r',
                  details: { field: 'environment', reason: 'unknown_environment' },
                },
              },
            };
          return {
            body: {
              environment: env({ name: 'first', variables: { REGION: 'west' } }),
              created: true,
            },
          };
        }),
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(calls.map(call => call.method)).toEqual(['GET', 'GET', 'POST']);
    expect(calls[2]?.body).toMatchObject({ variables: { REGION: 'west' } });
  });

  it('preserves write-only keys and verifies the requested variable echo', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    await runEnvUpdate(
      { ...COMMON, projectId: PROJECT_ID, name: 'demo', vars: ['REGION=west'] },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, call =>
          call.method === 'GET'
            ? errorEnvelope('FORBIDDEN', 403)
            : { body: { environment: env({ variables: { REGION: 'west' } }) } },
        ),
        stdout: () => {},
        stderr: () => {},
      },
    );
    expect(calls.map(call => call.method)).toEqual(['GET', 'PATCH']);
  });

  it('reports the renamed environment and applied fields when an old server strips variables', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const error = await runEnvUpdate(
      {
        ...COMMON,
        projectId: PROJECT_ID,
        name: 'staging',
        rename: 'preview',
        url: 'https://preview.example.com',
        username: 'preview-user',
        vars: ['REGION=west'],
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, call =>
          call.method === 'GET'
            ? errorEnvelope('FORBIDDEN', 403)
            : {
                body: {
                  environment: env({
                    name: 'preview',
                    url: 'https://preview.example.com',
                    username: 'preview-user',
                    variables: undefined,
                  }),
                },
              },
        ),
        stdout: () => {},
        stderr: () => {},
      },
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'UNSUPPORTED', exitCode: 7, details: {} });
    expect((error as ApiError).message).toContain("environment 'preview' was updated");
    expect((error as ApiError).message).toContain('--rename / --url / --username applied');
    expect((error as ApiError).nextAction).toContain(
      `testsprite project env update ${PROJECT_ID} preview --var KEY=VALUE`,
    );
    expect((error as ApiError).nextAction).not.toContain('staging --var');
    expect((error as ApiError).nextAction).not.toContain('REGION=west');
    expect(calls.map(call => call.method)).toEqual(['GET', 'PATCH']);
    expect(calls[1]?.body).toMatchObject({ rename: 'preview', variables: { REGION: 'west' } });
  });

  it('reports a supplied password without claiming its hidden value when variables were ignored', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    const output: string[] = [];
    const password = 'receipt-password-value-never-print';
    const error = await runEnvUpdate(
      { ...COMMON, projectId: PROJECT_ID, name: 'staging', password, vars: ['REGION=west'] },
      {
        credentialsPath,
        fetchImpl: makeFetch(calls, call =>
          call.method === 'GET'
            ? errorEnvelope('FORBIDDEN', 403)
            : {
                body: {
                  environment: env({ name: 'staging', hasCredentials: true, variables: undefined }),
                },
              },
        ),
        stdout: line => output.push(line),
        stderr: line => output.push(line),
      },
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'UNSUPPORTED', exitCode: 7, details: {} });
    expect((error as ApiError).message).toContain(
      '--password was supplied; its stored value is not returned',
    );
    expect((error as ApiError).nextAction).toContain(
      `testsprite project env update ${PROJECT_ID} staging --var KEY=VALUE`,
    );
    expect(JSON.stringify(error)).not.toContain(password);
    expect(output.join('\n')).not.toContain(password);
    expect(calls.map(call => call.method)).toEqual(['GET', 'PATCH']);
    expect(calls[1]?.body).toMatchObject({ password, variables: { REGION: 'west' } });
  });

  it('keeps post-write confirmation after an unavailable probe and says exactly what was created', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Call[] = [];
    await expect(
      runEnvCreate(
        {
          ...COMMON,
          projectId: PROJECT_ID,
          name: 'preview',
          url: env().url,
          vars: ['REGION=west'],
        },
        {
          credentialsPath,
          fetchImpl: makeFetch(calls, call =>
            call.method === 'GET'
              ? errorEnvelope('FORBIDDEN', 403)
              : {
                  body: {
                    environment: env({ name: 'preview', variables: undefined }),
                    created: true,
                  },
                },
          ),
          stdout: () => {},
          stderr: () => {},
        },
      ),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      message: "The server did not apply --var; environment 'preview' was created without them.",
    });
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST']);
  });
});

describe('environment rename validation compatibility', () => {
  it('keeps the rename field in invalid rename errors', async () => {
    await expect(
      runEnvUpdate(
        { ...COMMON, projectId: PROJECT_ID, name: 'demo', rename: '   ' },
        { stdout: () => {}, stderr: () => {} },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: { field: 'rename' },
    });
  });
});
