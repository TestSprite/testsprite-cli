import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/errors.js';
import { createScheduleCommand, runCreate } from './schedule.js';

type FetchInput = Parameters<typeof globalThis.fetch>[0];

function makeFetch(
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
): typeof globalThis.fetch {
  return (async (input: FetchInput, init: RequestInit = {}) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as { url: string }).url;
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

function makeCreds(): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-sched-create-'));
  const credentialsPath = join(dir, 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write into this test's own mkdtempSync-created temp dir (dir), not user input.
  writeFileSync(
    credentialsPath,
    '[default]\napi_url = http://localhost:13501\napi_key = sk-user-test\n',
    { mode: 0o600 },
  );
  return { credentialsPath };
}

/** Answers the tests lookup with an empty page and the create with an id. */
function happyFetch(testsBody: unknown = { items: [], nextToken: null }): typeof globalThis.fetch {
  return makeFetch(url =>
    url.includes('/tests') ? { body: testsBody } : { body: { scheduleId: 'sch_new' } },
  );
}

/** Fails loudly if any request is made. */
function noNetwork(): typeof globalThis.fetch {
  return (() => {
    throw new Error('no request expected');
  }) as unknown as typeof globalThis.fetch;
}

const VALID = {
  profile: 'default',
  debug: false,
  output: 'json' as const,
  name: 'Nightly',
  targetType: 'project',
  targetId: 'project_1',
  cron: '0 3 * * *',
};

const sink = { stdout: () => {}, stderr: () => {} };

describe('runCreate — validation', () => {
  it('test-list target refuses --env locally', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runCreate(
        { ...VALID, targetType: 'testList', targetId: 'tl_1', env: 'staging' },
        { credentialsPath, fetchImpl: noNetwork(), ...sink },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      nextAction: expect.stringContaining(
        'testsprite testlist update tl_1 --project-env <projectId>:<environmentName>',
      ),
      details: { field: 'environment', reason: 'not_supported_for_target' },
    });
  });

  it('blank env rejects locally', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runCreate({ ...VALID, env: '   ' }, { credentialsPath, fetchImpl: noNetwork(), ...sink }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: { field: 'environment', reason: 'blank_value' },
    });
  });

  it.each(['name', 'targetId', 'cron'])('rejects a missing %s before any request', async field => {
    const { credentialsPath } = makeCreds();
    const opts = { ...VALID } as Record<string, unknown>;
    delete opts[field];

    await expect(
      runCreate(opts as never, { credentialsPath, fetchImpl: noNetwork(), ...sink }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a whitespace-only name', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runCreate({ ...VALID, name: '   ' }, { credentialsPath, fetchImpl: noNetwork(), ...sink }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a missing or unknown target type', async () => {
    const { credentialsPath } = makeCreds();
    const deps = { credentialsPath, fetchImpl: noNetwork(), ...sink };

    await expect(runCreate({ ...VALID, targetType: undefined }, deps)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(runCreate({ ...VALID, targetType: 'suite' }, deps)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('accepts both target types', async () => {
    const { credentialsPath } = makeCreds();
    for (const targetType of ['project', 'testList']) {
      await expect(
        runCreate({ ...VALID, targetType }, { credentialsPath, fetchImpl: happyFetch(), ...sink }),
      ).resolves.toEqual({ scheduleId: 'sch_new' });
    }
  });
});

describe('runCreate — request', () => {
  function capturing(): {
    calls: Array<{ url: string; init: RequestInit }>;
    fetchImpl: typeof globalThis.fetch;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = makeFetch((url, init) => {
      calls.push({ url, init });
      return url.includes('/tests')
        ? { body: { items: [], nextToken: null } }
        : { body: { scheduleId: 'sch_new' } };
    });
    return { calls, fetchImpl };
  }

  const postOf = (calls: Array<{ url: string; init: RequestInit }>) =>
    calls.find(c => (c.init.method ?? 'GET') === 'POST')!;

  it('refuses a known old server before creating a pinned schedule', async () => {
    const { credentialsPath } = makeCreds();
    const methods: string[] = [];
    const fetchImpl = makeFetch((_url, init) => {
      methods.push(init.method ?? 'GET');
      return {
        body:
          (init.method ?? 'GET') === 'GET'
            ? { schedules: [{ scheduleId: 'sch_existing', targetType: 'project' }] }
            : { scheduleId: 'sch_new' },
      };
    });
    await expect(
      runCreate({ ...VALID, env: 'staging' }, { credentialsPath, fetchImpl, ...sink }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      exitCode: 7,
      nextAction: expect.stringContaining('No schedule was created'),
    });
    expect(methods).toEqual(['GET']);
  });

  it.each([403, 404])(
    'keeps echo verification when the capability read returns %s',
    async status => {
      const { credentialsPath } = makeCreds();
      const methods: string[] = [];
      const fetchImpl = makeFetch((_url, init) => {
        const method = init.method ?? 'GET';
        methods.push(method);
        if (method === 'GET') {
          return {
            status,
            body: {
              error: {
                code: status === 403 ? 'AUTH_FORBIDDEN' : 'NOT_FOUND',
                message: 'unreadable',
                requestId: 'r1',
              },
            },
          };
        }
        return { body: { scheduleId: 'sch_new' } };
      });
      await expect(
        runCreate({ ...VALID, env: 'staging' }, { credentialsPath, fetchImpl, ...sink }),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED',
        nextAction: expect.stringContaining('Schedule sch_new was created and then removed'),
        details: { scheduleId: 'sch_new', rolledBack: true },
      });
      expect(methods).toEqual(['GET', 'POST', 'DELETE']);
    },
  );

  /** A server new enough to echo `environment`/`environmentMode` on the create response. */
  function pinAwareFetch(mode: 'pinned' | 'inherit', environment: string | null = null) {
    return makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'DELETE') return { body: { scheduleId: 'sch_new' } };
      return url.includes('/tests')
        ? { body: { items: [], nextToken: null } }
        : { body: { scheduleId: 'sch_new', environment, environmentMode: mode } };
    });
  }

  it('create forwards --env for a project target', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = makeFetch((url, init) => {
      calls.push({ url, init });
      return url.includes('/tests')
        ? { body: { items: [], nextToken: null } }
        : { body: { scheduleId: 'sch_new', environment: 'staging', environmentMode: 'pinned' } };
    });
    await runCreate({ ...VALID, env: 'staging' }, { credentialsPath, fetchImpl, ...sink });
    expect(JSON.parse(String(postOf(calls).init.body)).environment).toBe('staging');
  });

  it('create without --env inherits', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = makeFetch((url, init) => {
      calls.push({ url, init });
      return url.includes('/tests')
        ? { body: { items: [], nextToken: null } }
        : { body: { scheduleId: 'sch_new', environment: null, environmentMode: 'inherit' } };
    });
    const output: string[] = [];
    await runCreate(
      { ...VALID, output: 'text' },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => output.push(line),
        stderr: () => {},
      },
    );
    expect(JSON.parse(String(postOf(calls).init.body))).not.toHaveProperty('environment');
    expect(output.join('\n')).toContain('project default (inherits)');
  });

  it('create confirmation shows a pinned environment', async () => {
    const { credentialsPath } = makeCreds();
    const output: string[] = [];
    await runCreate(
      { ...VALID, output: 'text', env: 'staging' },
      {
        credentialsPath,
        fetchImpl: pinAwareFetch('pinned', 'staging'),
        stdout: line => output.push(line),
        stderr: () => {},
      },
    );
    expect(output.join('\n')).toContain('staging (pinned)');
  });

  it("create without --env on an old server keeps today's output (no mode line)", async () => {
    // An old server has no idea what `environment`/`environmentMode` are and
    // omits both from the response — this is not a rejection, just silence,
    // so the confirmation card falls back to exactly what it printed before
    // schedule environments existed.
    const { credentialsPath } = makeCreds();
    const output: string[] = [];
    await runCreate(
      { ...VALID, output: 'text' },
      {
        credentialsPath,
        fetchImpl: happyFetch(),
        stdout: line => output.push(line),
        stderr: () => {},
      },
    );
    expect(output.join('\n')).toBe('id: sch_new');
  });

  it('old server drops --env on create: rolls the schedule back and refuses', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = makeFetch((url, init) => {
      calls.push({ url, init });
      if ((init.method ?? 'GET') === 'DELETE') return { body: { scheduleId: 'sch_new' } };
      if ((init.method ?? 'GET') === 'GET') return { body: { schedules: [] } };
      // Old server: silently drops `environment`, never echoes a mode.
      return { body: { scheduleId: 'sch_new' } };
    });
    const output: string[] = [];
    await expect(
      runCreate(
        { ...VALID, env: 'staging' },
        { credentialsPath, fetchImpl, stdout: line => output.push(line), stderr: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED', exitCode: 7 });

    const del = calls.find(c => (c.init.method ?? 'GET') === 'DELETE');
    expect(del).toBeDefined();
    expect(del!.url).toContain('/schedules/sch_new');
    expect(output).toEqual([]); // no success card for a schedule that was rolled back
  });

  it('old server drops --env on create: reports the id when the rollback delete itself fails', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { body: { schedules: [] } };
      if ((init.method ?? 'GET') === 'DELETE') {
        return {
          status: 500,
          body: { error: { code: 'INTERNAL', message: 'boom', requestId: 'r1' } },
        };
      }
      return { body: { scheduleId: 'sch_new' } };
    });
    await expect(
      runCreate({ ...VALID, env: 'staging' }, { credentialsPath, fetchImpl, ...sink }),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      exitCode: 7,
      nextAction: expect.stringContaining('sch_new'),
    });
  });

  it('unknown env shows available names', async () => {
    const { credentialsPath } = makeCreds();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = makeFetch((_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return {
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Unknown environment.',
            nextAction: 'Use one of: default, staging',
            requestId: 'req_1',
            details: {
              field: 'environment',
              requested: 'stagin',
              available: ['default', 'staging'],
              accepted: ['default', 'staging'],
            },
          },
        },
      };
    });
    await expect(
      runCreate({ ...VALID, env: 'stagin' }, { credentialsPath, fetchImpl, ...sink }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      nextAction: 'Use one of: default, staging',
      details: { available: ['default', 'staging'] },
    });
    expect(bodies).toEqual([expect.objectContaining({ environment: 'stagin' })]);
  });

  it('POSTs to /schedules with the mapped body', async () => {
    const { credentialsPath } = makeCreds();
    const { calls, fetchImpl } = capturing();

    await runCreate(VALID, { credentialsPath, fetchImpl, ...sink });

    const post = postOf(calls);
    expect(post.url).toContain('/schedules');
    expect(JSON.parse(String(post.init.body))).toEqual({
      name: 'Nightly',
      targetType: 'project',
      targetId: 'project_1',
      cron: '0 3 * * *',
    });
  });

  it('sends an idempotency key, and reuses a supplied one verbatim', async () => {
    const { credentialsPath } = makeCreds();

    const generated = capturing();
    await runCreate(VALID, { credentialsPath, fetchImpl: generated.fetchImpl, ...sink });
    expect(new Headers(postOf(generated.calls).init.headers).get('idempotency-key')).toBeTruthy();

    const supplied = capturing();
    await runCreate(
      { ...VALID, idempotencyKey: 'my-key-1' },
      { credentialsPath, fetchImpl: supplied.fetchImpl, ...sink },
    );
    expect(new Headers(postOf(supplied.calls).init.headers).get('idempotency-key')).toBe(
      'my-key-1',
    );
  });

  it('omits optional fields it was not given', async () => {
    const { credentialsPath } = makeCreds();
    const { calls, fetchImpl } = capturing();

    await runCreate(VALID, { credentialsPath, fetchImpl, ...sink });

    const body = JSON.parse(String(postOf(calls).init.body));
    for (const key of ['timezone', 'startAt', 'endAt', 'sendTo']) {
      expect(key in body).toBe(false);
    }
  });

  it('maps the optional flags onto the wire field names', async () => {
    const { credentialsPath } = makeCreds();
    const { calls, fetchImpl } = capturing();

    await runCreate(
      {
        ...VALID,
        timezone: 'America/New_York',
        start: '2026-07-01T00:00:00.000Z',
        end: '2026-08-01T00:00:00.000Z',
        sendTo: 'a@example.com,b@example.com',
      },
      { credentialsPath, fetchImpl, ...sink },
    );

    expect(JSON.parse(String(postOf(calls).init.body))).toMatchObject({
      timezone: 'America/New_York',
      startAt: '2026-07-01T00:00:00.000Z',
      endAt: '2026-08-01T00:00:00.000Z',
      sendTo: 'a@example.com,b@example.com',
    });
  });

  it('surfaces a plan-limit refusal', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(url =>
      url.includes('/tests')
        ? { body: { items: [], nextToken: null } }
        : {
            status: 403,
            body: {
              error: {
                code: 'FEATURE_GATED',
                message: 'Plan limit reached.',
                requestId: 'req_1',
                details: { reason: 'plan_limit', limit: 5, current: 5 },
              },
            },
          },
    );

    await expect(runCreate(VALID, { credentialsPath, fetchImpl, ...sink })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});

describe('createScheduleCommand — wiring', () => {
  it('create wires --env onto the request body', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const command = createScheduleCommand({
      credentialsPath,
      fetchImpl: makeFetch((url, init) => {
        calls.push({ url, init });
        return url.includes('/tests')
          ? { body: { items: [], nextToken: null } }
          : { body: { scheduleId: 'sch_new', environment: 'staging', environmentMode: 'pinned' } };
      }),
      ...sink,
    });

    await command.parseAsync(
      [
        'create',
        '--name',
        'Nightly',
        '--target-type',
        'project',
        '--target-id',
        'project_1',
        '--cron',
        '0 3 * * *',
        '--env',
        'staging',
      ],
      { from: 'user' },
    );

    const post = calls.find(c => (c.init.method ?? 'GET') === 'POST')!;
    expect(JSON.parse(String(post.init.body))).toMatchObject({ environment: 'staging' });
  });
});

describe('runCreate — frequency advisory', () => {
  it('prints the advisory to stderr, keeping stdout parseable', async () => {
    const { credentialsPath } = makeCreds();

    const stdout: string[] = [];
    const stderr: string[] = [];
    await runCreate(VALID, {
      credentialsPath,
      fetchImpl: happyFetch(),
      stdout: l => stdout.push(l),
      stderr: l => stderr.push(l),
    });

    expect(stderr.join('\n')).toContain('~30 time(s)/month (daily at 03:00)');
    expect(stdout.join('\n')).not.toContain('time(s)/month');
    expect(() => JSON.parse(stdout.join('\n'))).not.toThrow();
  });

  it('quotes no credit figure', async () => {
    // The API exposes no per-action rate for the workspace wallet, so any
    // number here would be derived from something that is not the real price.
    const { credentialsPath } = makeCreds();

    const stderr: string[] = [];
    await runCreate(VALID, {
      credentialsPath,
      fetchImpl: happyFetch(),
      stdout: () => {},
      stderr: l => stderr.push(l),
    });

    const text = stderr.join('\n');
    expect(text).not.toMatch(/credits\/month/);
    expect(text).not.toMatch(/Estimated cost/);
  });

  it('reads no test list to build the advisory', async () => {
    // Frequency comes from the cron alone, so create makes exactly one request.
    const { credentialsPath } = makeCreds();
    const urls: string[] = [];
    const fetchImpl = makeFetch(url => {
      urls.push(url);
      return { body: { scheduleId: 'sch_new' } };
    });

    await runCreate(VALID, { credentialsPath, fetchImpl, ...sink });

    expect(urls.some(u => u.includes('/tests'))).toBe(false);
    expect(urls).toHaveLength(1);
  });

  it('states the advisory for a test-list target too', async () => {
    const { credentialsPath } = makeCreds();

    const stderr: string[] = [];
    await runCreate(
      { ...VALID, targetType: 'testList', targetId: 'tl_1' },
      { credentialsPath, fetchImpl: happyFetch(), stdout: () => {}, stderr: l => stderr.push(l) },
    );

    expect(stderr.join('\n')).toContain('~30 time(s)/month');
  });
});

describe('runCreate — dry run', () => {
  it('returns a sample without sending any request', async () => {
    const { credentialsPath } = makeCreds();
    const urls: string[] = [];
    const fetchImpl = makeFetch(url => {
      urls.push(url);
      return { body: {} };
    });

    const result = await runCreate(
      { ...VALID, dryRun: true },
      { credentialsPath, fetchImpl, ...sink },
    );

    expect(result.scheduleId).toContain('dryrun');
    expect(urls).toEqual([]);
  });

  it('exercises the cost advisory offline', async () => {
    // The one new output line of this command; without a figure in the sample
    // it would only ever be seen against a real backend.
    const { credentialsPath } = makeCreds();

    const stderr: string[] = [];
    const result = await runCreate(
      { ...VALID, dryRun: true },
      { credentialsPath, fetchImpl: noNetwork(), stdout: () => {}, stderr: l => stderr.push(l) },
    );

    expect(result.estimatedCreditsPerRun).toBe(5);
    expect(stderr.join('\n')).toContain('~5 credits/run, ~152 credits/month');
  });

  it('still validates before short-circuiting', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runCreate(
        { ...VALID, dryRun: true, name: undefined },
        { credentialsPath, fetchImpl: noNetwork(), ...sink },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('runCreate — server-supplied cost estimate', () => {
  it('prints the per-run price and the monthly total it implies, to stderr', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { scheduleId: 'sch_new', estimatedCreditsPerRun: 5 },
    }));

    const stdout: string[] = [];
    const stderr: string[] = [];
    await runCreate(VALID, {
      credentialsPath,
      fetchImpl,
      stdout: l => stdout.push(l),
      stderr: l => stderr.push(l),
    });

    // Daily, so ~30.4 runs a month at 5 credits each.
    expect(stderr.join('\n')).toContain('~5 credits/run, ~152 credits/month');
    expect(stdout.join('\n')).not.toContain('credits/run');
    expect(() => JSON.parse(stdout.join('\n'))).not.toThrow();
  });

  it('scales the monthly total with the cron, not with a fixed run count', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { scheduleId: 'sch_new', estimatedCreditsPerRun: 5 },
    }));

    const stderr: string[] = [];
    await runCreate(
      { ...VALID, cron: '0 * * * *' },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: l => stderr.push(l) },
    );

    // Hourly is 730 runs a month, not the 30 a daily cron gets.
    expect(stderr.join('\n')).toContain('~5 credits/run, ~3650 credits/month');
  });

  it('keeps a sub-credit price legible instead of rounding it to zero', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { scheduleId: 'sch_new', estimatedCreditsPerRun: 0.2 },
    }));

    const stderr: string[] = [];
    await runCreate(VALID, {
      credentialsPath,
      fetchImpl,
      stdout: () => {},
      stderr: l => stderr.push(l),
    });

    expect(stderr.join('\n')).toContain('~0.2 credits/run, ~6 credits/month');
  });

  it('states the per-run price alone for a cron it cannot read', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { scheduleId: 'sch_new', estimatedCreditsPerRun: 5 },
    }));

    const stderr: string[] = [];
    await runCreate(
      { ...VALID, cron: '0 3 * * MON#2' },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: l => stderr.push(l) },
    );

    const text = stderr.join('\n');
    expect(text).toContain('~5 credits/run,');
    expect(text).not.toContain('credits/month');
  });

  it('says nothing about cost when the API could not determine one', async () => {
    const { credentialsPath } = makeCreds();

    for (const body of [
      { scheduleId: 'sch_new', estimatedCreditsPerRun: null },
      { scheduleId: 'sch_new' }, // field absent
    ]) {
      const stderr: string[] = [];
      await runCreate(VALID, {
        credentialsPath,
        fetchImpl: makeFetch(() => ({ body })),
        stdout: () => {},
        stderr: l => stderr.push(l),
      });
      expect(stderr.join('\n')).not.toContain('credits/');
    }
  });

  it('passes the figure through on --output json', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { scheduleId: 'sch_new', estimatedCreditsPerRun: 73000 },
    }));

    const result = await runCreate(VALID, { credentialsPath, fetchImpl, ...sink });
    expect(result.estimatedCreditsPerRun).toBe(73000);
  });

  it('never prices a run itself', async () => {
    // The rates and the case count are both server-side; a number invented here
    // would be derived from neither.
    const { credentialsPath } = makeCreds();
    const stderr: string[] = [];
    await runCreate(VALID, {
      credentialsPath,
      fetchImpl: makeFetch(() => ({ body: { scheduleId: 'sch_new' } })),
      stdout: () => {},
      stderr: l => stderr.push(l),
    });
    expect(stderr.join('\n')).not.toMatch(/\d+(\.\d+)?\s*credits/);
  });
});
