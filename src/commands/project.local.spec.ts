import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/errors.js';
import type { LocalPortProbeDeps } from '../lib/local-target.js';
import { createProjectCommand } from './project.js';

const CREATED = {
  projectId: 'project_local',
  name: 'Local app',
  type: 'frontend',
  createdFrom: 'cli',
  createdAt: '2026-09-09T00:00:00.000Z',
  targetUrl: 'http://127.0.0.1:3000',
  originMode: 'local',
};

function harness(
  options: {
    response?: unknown;
    status?: number;
    connect?: LocalPortProbeDeps['connect'];
  } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const events: string[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const connect = vi.fn(
    options.connect ??
      (async () => {
        events.push('connect');
      }),
  );
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    events.push('http');
    requests.push({ url, init });
    return new Response(JSON.stringify(options.response ?? CREATED), {
      status: options.status ?? 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  const root = new Command('testsprite')
    .option('--output <mode>', 'output mode', 'text')
    .option('--dry-run', 'show a sample');
  root.addCommand(
    createProjectCommand({
      env: { TESTSPRITE_API_KEY: 'sk-user-test', TESTSPRITE_API_URL: 'https://api.example.com' },
      fetchImpl,
      localPortProbeDeps: { connect },
      stdout: line => stdout.push(line),
      stderr: line => stderr.push(line),
    }),
  );
  for (const command of [root, ...root.commands, ...root.commands.flatMap(c => c.commands)]) {
    command.exitOverride();
    command.configureOutput({
      writeOut: text => stdout.push(text),
      writeErr: text => stderr.push(text),
    });
  }
  return {
    stdout,
    stderr,
    events,
    requests,
    connect,
    root,
    async run(args: string[]) {
      let error: unknown;
      try {
        await root.parseAsync(['project', ...args], { from: 'user' });
      } catch (cause) {
        error = cause;
      }
      return error;
    },
  };
}

const CREATE = ['create', '--type', 'frontend', '--name', 'Local app'];

function apiError(error: unknown): ApiError {
  expect(error).toBeInstanceOf(ApiError);
  if (!(error instanceof ApiError)) throw new Error('expected an API error');
  return error;
}

describe('project create local flags', () => {
  it.each([
    [
      ['--local', '3000', '--url', 'https://example.com'],
      '--local and --url are mutually exclusive',
    ],
    [
      ['--local-host', 'localhost', '--url', 'https://example.com'],
      '--local-host requires --local',
    ],
    ...[
      '0',
      '65536',
      '-1',
      '3000.5',
      'abc',
      '',
      ' 3000',
      '3000 ',
      '1e3',
      '0x10',
      '+3000',
      '3000.0',
    ].map<[string[], string]>(port => [
      ['--local', port],
      'must be a port number between 1 and 65535',
    ]),
    ...['127.0.0.2', '0.0.0.0', '10.0.0.5', 'example.com', '::'].map<[string[], string]>(host => [
      ['--local', '3000', '--local-host', host],
      'must name your own machine',
    ]),
  ] satisfies Array<[string[], string]>)(
    'rejects %j before TCP or HTTP',
    async (flags, explanation) => {
      const h = harness();
      const error = apiError(await h.run([...CREATE, ...flags]));
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.exitCode).toBe(5);
      expect(`${error.message} ${error.nextAction}`).toContain(explanation);
      expect(h.requests).toEqual([]);
      expect(h.connect).not.toHaveBeenCalled();
    },
  );

  it('rejects backend local projects before TCP or HTTP', async () => {
    const h = harness();
    const error = apiError(
      await h.run(['create', '--type', 'backend', '--name', 'API', '--local', '3000']),
    );
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.exitCode).toBe(5);
    expect(error.nextAction).toBe('--local projects are frontend-only');
    expect(h.requests).toEqual([]);
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('documents the local flags and the frontend URL alternative in help', () => {
    const h = harness();
    const create = h.root.commands[0]!.commands.find(command => command.name() === 'create')!;
    const help = create.helpInformation();
    expect(help).toContain('--local <port>');
    expect(help).toContain('--local-host <host>');
    expect(help).toContain('--skip-preflight');
    expect(help).toContain('127.0.0.1');
    expect(help).toContain('localhost');
    expect(help).toContain('::1');
    expect(help).toContain('frontend unless --local');
  });
});

describe('project create local preflight and request', () => {
  it.each([
    [[], '127.0.0.1', 'http://127.0.0.1:3000'],
    [['--local-host', 'localhost'], '127.0.0.1', 'http://localhost:3000'],
    [['--local-host', '127.0.0.1'], '127.0.0.1', 'http://127.0.0.1:3000'],
    [['--local-host', '::1'], '::1', 'http://[::1]:3000'],
    [['--local-host', '[::1]'], '::1', 'http://[::1]:3000'],
  ] satisfies Array<[string[], string, string]>)(
    'probes %j before the only create request',
    async (flags, dialHost, targetUrl) => {
      const h = harness({ response: { ...CREATED, targetUrl } });
      expect(
        await h.run([
          ...CREATE,
          '--local',
          '3000',
          ...flags,
          '--username',
          'alice',
          '--password',
          'example-password',
          '--instruction',
          'Sign in first',
          '--test-id-attributes',
          'data-element,data-testid',
          '--idempotency-key',
          'local-create-key',
        ]),
      ).toBeUndefined();
      expect(h.connect).toHaveBeenCalledWith(dialHost, 3000, 2000);
      expect(h.events).toEqual(['connect', 'http']);
      expect(h.requests).toHaveLength(1);
      const request = h.requests[0]!;
      expect(request.url).toBe('https://api.example.com/api/cli/v1/projects');
      expect(request.init.method).toBe('POST');
      expect(new Headers(request.init.headers).get('idempotency-key')).toBe('local-create-key');
      expect(JSON.parse(String(request.init.body))).toEqual({
        type: 'frontend',
        name: 'Local app',
        targetUrl,
        originMode: 'local',
        username: 'alice',
        password: 'example-password',
        instruction: 'Sign in first',
        testIdAttributes: ['data-element', 'data-testid'],
      });
    },
  );

  it.each(['ECONNREFUSED', 'ETIMEDOUT'])('refuses a dead port (%s) without HTTP', async reason => {
    const h = harness({
      connect: async () => {
        throw new Error(reason);
      },
    });
    const error = apiError(await h.run([...CREATE, '--local', '3000']));
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.exitCode).toBe(5);
    expect(error.message).toBe(
      'Nothing is listening on http://127.0.0.1:3000. Start your app first, or pass --skip-preflight.',
    );
    expect(h.requests).toEqual([]);
    expect(h.connect).toHaveBeenCalledOnce();
  });

  it('skip-preflight performs no TCP attempts and still sends the local marker', async () => {
    const h = harness({
      connect: async () => {
        throw new Error('no listener');
      },
    });
    expect(await h.run([...CREATE, '--local', '3000', '--skip-preflight'])).toBeUndefined();
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(1);
    expect(JSON.parse(String(h.requests[0]!.init.body))).toMatchObject({
      targetUrl: 'http://127.0.0.1:3000',
      originMode: 'local',
    });
  });

  it.each(['1', '65535'])('accepts boundary port %s', async port => {
    const h = harness();
    expect(await h.run([...CREATE, '--local', port, '--skip-preflight'])).toBeUndefined();
    expect(JSON.parse(String(h.requests[0]!.init.body)).targetUrl).toBe(`http://127.0.0.1:${port}`);
  });

  it('dry-run validates local flags but neither dials nor creates', async () => {
    const h = harness();
    expect(
      await h.run([...CREATE, '--local', '3000', '--dry-run', '--output', 'json']),
    ).toBeUndefined();
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
    expect(JSON.parse(h.stdout.join(''))).toMatchObject({
      targetUrl: 'http://127.0.0.1:3000',
      originMode: 'local',
    });
    expect(h.stderr.join('\n')).toContain('[dry-run] sample response — not from the server');
  });
});

describe('project create local output and errors', () => {
  it.each(['projectId', 'id'])(
    'prints manual-plan and local-run guidance using response %s',
    async idField => {
      const { projectId, ...fields } = CREATED;
      const h = harness({ response: { ...fields, [idField]: projectId } });
      expect(await h.run([...CREATE, '--local', '3000'])).toBeUndefined();
      const text = h.stdout.join('\n');
      expect(text).toContain('id:          project_local');
      expect(text).toContain(
        'Local project: TestSprite will reach http://127.0.0.1:3000 only through a tunnel from this machine.',
      );
      expect(text).toContain('Next: write a plan and run it locally:');
      expect(text).toContain(
        '  testsprite test create --project project_local --plan-from plan.json',
      );
      expect(text).toContain('  testsprite test run <test-id> --local 3000');
      expect(text).toContain(
        'Portal runs of this project stay blocked (free) until you set a public URL with: testsprite project update project_local --url https://...',
      );
    },
  );

  it.each([true, false])(
    'JSON preserves originMode presence=%s from the response',
    async present => {
      const { originMode, ...withoutOrigin } = CREATED;
      const response = present
        ? { ...withoutOrigin, originMode, serverExtra: 'kept' }
        : { ...withoutOrigin, serverExtra: 'kept' };
      const h = harness({ response });
      expect(await h.run([...CREATE, '--local', '3000', '--output', 'json'])).toBeUndefined();
      expect(JSON.parse(h.stdout.join(''))).toEqual({ ...response, id: 'project_local' });
      expect(h.stdout.join('')).not.toContain('Next:');
    },
  );

  it.each([
    [
      501,
      'UNSUPPORTED',
      'local-origin-requires-v3',
      'Local projects need the V3 project platform, which this account does not have yet.',
      7,
    ],
    [501, 'UNSUPPORTED', 'another-feature', 'Unrelated unsupported feature.', 7],
    [400, 'VALIDATION_ERROR', 'invalid-local-origin', 'Local origin was rejected.', 5],
  ] as const)('preserves HTTP %s %s %s', async (status, code, reason, message, exitCode) => {
    const envelope = {
      code,
      message,
      requestId: 'req-local',
      nextAction: 'Server guidance.',
      details: { reason },
    };
    const h = harness({ status, response: { error: envelope } });
    const error = apiError(await h.run([...CREATE, '--local', '3000']));
    expect(error.exitCode).toBe(exitCode);
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
    expect(error.nextAction).toBe(envelope.nextAction);
    expect(error.requestId).toBe('req-local');
    expect(error.details).toEqual(envelope.details);
    expect(h.requests).toHaveLength(1);
  });

  it('public create keeps its request and output shape and makes no TCP probe', async () => {
    const response = { ...CREATED, originMode: undefined };
    const h = harness({ response: { ...response, targetUrl: 'https://example.com' } });
    expect(
      await h.run([...CREATE, '--url', 'https://example.com', '--output', 'json']),
    ).toBeUndefined();
    expect(h.connect).not.toHaveBeenCalled();
    expect(JSON.parse(String(h.requests[0]!.init.body))).toEqual({
      type: 'frontend',
      name: 'Local app',
      targetUrl: 'https://example.com',
    });
    expect(JSON.parse(h.stdout.join(''))).not.toHaveProperty('originMode');
  });
});

const READ_PROJECT = { ...CREATED, id: 'project_local', updatedAt: CREATED.createdAt };

describe('local project setup guidance', () => {
  it('tells the caller to put the new project ID inside the plan file', async () => {
    const h = harness();
    expect(await h.run([...CREATE, '--local', '3000'])).toBeUndefined();
    expect(h.stdout.join('\n')).toContain('In plan.json, set projectId to project_local.');
  });

  it('names --url when an invalid local host should use a public URL', async () => {
    const h = harness();
    const error = apiError(
      await h.run([...CREATE, '--local', '3000', '--local-host', 'example.com']),
    );
    expect(`${error.message} ${error.nextAction}`).toContain('use --url instead');
    expect(`${error.message} ${error.nextAction}`).not.toContain('--target-url');
  });
});

describe('local-origin project reads', () => {
  it('get marks a local URL', async () => {
    const h = harness({ response: READ_PROJECT, status: 200 });
    expect(await h.run(['get', 'project_local'])).toBeUndefined();
    expect(h.stdout.join('\n')).toContain('targetUrl:   http://127.0.0.1:3000 (Local)');
  });

  it('get retains the local marker even when an older read response omits the URL', async () => {
    const response = { ...READ_PROJECT, targetUrl: undefined };
    const h = harness({ response, status: 200 });
    expect(await h.run(['get', 'project_local'])).toBeUndefined();
    expect(h.stdout.join('\n')).toContain('originMode:  local (Local)');
    expect(h.stdout.join('\n')).not.toContain('not set');
  });

  it('list displays the local URL and marker in a mixed page', async () => {
    const publicProject = { ...READ_PROJECT, originMode: undefined };
    const h = harness({
      response: {
        items: [
          READ_PROJECT,
          { ...publicProject, id: 'public_project', targetUrl: 'https://example.com' },
        ],
        nextToken: null,
      },
      status: 200,
    });
    expect(await h.run(['list'])).toBeUndefined();
    const rows = h.stdout.join('\n').split('\n');
    expect(rows.find(row => row.includes('project_local'))).toContain(
      'http://127.0.0.1:3000 (Local)',
    );
    expect(rows.find(row => row.includes('public_project'))).toContain('https://example.com');
    expect(rows.find(row => row.includes('public_project'))).not.toContain('(Local)');
  });

  it('list displays the marker without inventing a URL for an absent list URL', async () => {
    const response = { ...READ_PROJECT, targetUrl: undefined };
    const h = harness({ response: { items: [response], nextToken: null }, status: 200 });
    expect(await h.run(['list'])).toBeUndefined();
    expect(h.stdout.join('\n')).toContain('(Local)');
    expect(h.stdout.join('\n')).not.toContain('http://');
    expect(h.stdout.join('\n')).not.toContain('not set');
  });

  it('list allows selecting the URL column', async () => {
    const h = harness({ response: { items: [READ_PROJECT], nextToken: null }, status: 200 });
    expect(await h.run(['list', '--columns', 'id,url', '--no-header'])).toBeUndefined();
    expect(h.stdout.join('\n')).toContain('http://127.0.0.1:3000 (Local)');
    expect(h.stdout.join('\n')).not.toContain('Local app');
  });

  it.each(['get', 'list'])(
    '%s JSON preserves the server origin field and extra fields',
    async command => {
      const project = { ...READ_PROJECT, serverExtra: 'kept' };
      const response = command === 'get' ? project : { items: [project], nextToken: null };
      const h = harness({ response, status: 200 });
      expect(
        await h.run([command, ...(command === 'get' ? ['project_local'] : []), '--output', 'json']),
      ).toBeUndefined();
      expect(JSON.parse(h.stdout.join(''))).toEqual(response);
    },
  );

  it('get keeps public URL output without a marker', async () => {
    const project = { ...READ_PROJECT, originMode: undefined };
    const h = harness({ response: { ...project, targetUrl: 'https://example.com' }, status: 200 });
    expect(await h.run(['get', 'project_local'])).toBeUndefined();
    expect(h.stdout.join('\n')).toContain('targetUrl:   https://example.com');
    expect(h.stdout.join('\n')).not.toContain('(Local)');
  });

  it('list keeps the old default column set when no local marker is present', async () => {
    const project = { ...READ_PROJECT, originMode: undefined };
    const h = harness({ response: { items: [project], nextToken: null }, status: 200 });
    expect(await h.run(['list'])).toBeUndefined();
    expect(h.stdout.join('\n')).not.toContain('URL');
    expect(h.stdout.join('\n')).not.toContain('(Local)');
  });
});

describe('local project run guidance preserves the selected host', () => {
  it.each([
    ['localhost', 'http://localhost:3000'],
    ['::1', 'http://[::1]:3000'],
  ])('keeps %s in the suggested tunnel command', async (host, targetUrl) => {
    const h = harness({ response: { ...CREATED, targetUrl } });
    expect(await h.run([...CREATE, '--local', '3000', '--local-host', host])).toBeUndefined();
    expect(h.stdout.join('\n')).toContain(
      `Local project: TestSprite will reach ${targetUrl} only through a tunnel from this machine.`,
    );
    expect(h.stdout.join('\n')).toContain(
      `  testsprite test run <test-id> --local 3000 --local-host ${host}`,
    );
  });
});
