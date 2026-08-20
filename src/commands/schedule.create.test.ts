import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/errors.js';
import { runCreate } from './schedule.js';

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
