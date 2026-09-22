import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runsPerMonth } from '../lib/cron.js';
import { ApiError } from '../lib/errors.js';
import {
  type CliSchedule,
  type CliScheduleRun,
  createScheduleCommand,
  runDelete,
  runGet,
  runRunList,
  runUpdate,
} from './schedule.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'cli-sched-write-'));
  const credentialsPath = join(dir, 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write into this test's own mkdtempSync-created temp dir (dir), not user input.
  writeFileSync(
    credentialsPath,
    '[default]\napi_url = http://localhost:13501\napi_key = sk-user-test\n',
    { mode: 0o600 },
  );
  return { credentialsPath };
}

function noNetwork(): typeof globalThis.fetch {
  return (() => {
    throw new Error('no request expected');
  }) as unknown as typeof globalThis.fetch;
}

const SCHEDULE: CliSchedule = {
  scheduleId: 'sch_1',
  name: 'Nightly',
  enabled: true,
  targetType: 'project',
  targetId: 'project_1',
  cron: '0 3 * * *',
  timezone: 'UTC',
  startAt: '2026-05-01T00:00:00.000Z',
  endAt: null,
  sendTo: null,
  autoPausedAt: null,
  lastRunId: null,
  createdAt: '2026-05-01T00:00:00.000Z',
  updatedAt: '2026-05-02T00:00:00.000Z',
};

const RUN: CliScheduleRun = {
  runId: 'exec_1',
  scheduleId: 'sch_1',
  status: 'passed',
  projectId: 'project_1',
  testListId: null,
  stats: { total: 3, passed: 3, failed: 0, blocked: 0, running: 0, cancelled: 0 },
  createdAt: '2026-06-01T03:00:00.000Z',
  updatedAt: '2026-06-01T03:04:00.000Z',
};

const BASE = { profile: 'default', debug: false } as const;
const sink = { stdout: () => {}, stderr: () => {} };

describe('createScheduleCommand — full surface', () => {
  it('exposes every verb, with run history under `run list`', () => {
    const schedule = createScheduleCommand();
    expect(schedule.commands.map(c => c.name()).sort()).toEqual([
      'create',
      'delete',
      'get',
      'list',
      'run',
      'update',
    ]);

    const run = schedule.commands.find(c => c.name() === 'run')!;
    expect(run.commands.map(c => c.name())).toEqual(['list']);
  });

  it('exposes no run-now verb', () => {
    const schedule = createScheduleCommand();
    const run = schedule.commands.find(c => c.name() === 'run')!;
    expect(run.commands.map(c => c.name())).not.toContain('now');
    expect(schedule.commands.map(c => c.name())).not.toContain('trigger');
  });

  it('offers --pause and --resume on update', () => {
    const schedule = createScheduleCommand();
    const update = schedule.commands.find(c => c.name() === 'update')!;
    const flags = update.options.map(o => o.long);
    expect(flags).toContain('--pause');
    expect(flags).toContain('--resume');
  });

  it('gates delete behind --confirm, like every other destructive verb', () => {
    const schedule = createScheduleCommand();
    const del = schedule.commands.find(c => c.name() === 'delete')!;
    expect(del.options.map(o => o.long)).toContain('--confirm');
    expect(del.description()).toContain('--confirm');
  });
});

describe('runUpdate', () => {
  function capturing(): {
    calls: Array<{ url: string; init: RequestInit }>;
    fetchImpl: typeof globalThis.fetch;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = makeFetch((url, init) => {
      calls.push({ url, init });
      return { body: SCHEDULE };
    });
    return { calls, fetchImpl };
  }

  it('PATCHes only the fields it was given', async () => {
    const { credentialsPath } = makeCreds();
    const { calls, fetchImpl } = capturing();

    await runUpdate(
      { ...BASE, output: 'json', scheduleId: 'sch_1', name: 'Renamed' },
      { credentialsPath, fetchImpl, ...sink },
    );

    expect(calls[0]!.init.method).toBe('PATCH');
    expect(calls[0]!.url).toContain('/schedules/sch_1');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: 'Renamed' });
  });

  it('maps --pause and --resume onto enabled', async () => {
    const { credentialsPath } = makeCreds();

    const paused = capturing();
    await runUpdate(
      { ...BASE, output: 'json', scheduleId: 'sch_1', pause: true },
      { credentialsPath, fetchImpl: paused.fetchImpl, ...sink },
    );
    expect(JSON.parse(String(paused.calls[0]!.init.body))).toEqual({ enabled: false });

    const resumed = capturing();
    await runUpdate(
      { ...BASE, output: 'json', scheduleId: 'sch_1', resume: true },
      { credentialsPath, fetchImpl: resumed.fetchImpl, ...sink },
    );
    expect(JSON.parse(String(resumed.calls[0]!.init.body))).toEqual({ enabled: true });
  });

  it('rejects --pause together with --resume instead of picking one', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runUpdate(
        { ...BASE, output: 'json', scheduleId: 'sch_1', pause: true, resume: true },
        { credentialsPath, fetchImpl: noNetwork(), ...sink },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects an update with no fields rather than sending an empty patch', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runUpdate(
        { ...BASE, output: 'json', scheduleId: 'sch_1' },
        { credentialsPath, fetchImpl: noNetwork(), ...sink },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('maps the date and recipient flags onto the wire field names', async () => {
    const { credentialsPath } = makeCreds();
    const { calls, fetchImpl } = capturing();

    await runUpdate(
      {
        ...BASE,
        output: 'json',
        scheduleId: 'sch_1',
        cron: '0 4 * * *',
        timezone: 'America/New_York',
        start: '2026-07-01T00:00:00.000Z',
        end: '2026-08-01T00:00:00.000Z',
        sendTo: 'a@example.com',
      },
      { credentialsPath, fetchImpl, ...sink },
    );

    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      cron: '0 4 * * *',
      timezone: 'America/New_York',
      startAt: '2026-07-01T00:00:00.000Z',
      endAt: '2026-08-01T00:00:00.000Z',
      sendTo: 'a@example.com',
    });
  });

  it('warns about the new frequency when --cron changes it', async () => {
    // Retiming an existing schedule is the same order-of-magnitude mistake as
    // creating one badly, so the advisory covers both halves.
    const { credentialsPath } = makeCreds();
    const { fetchImpl } = capturing();

    const stdout: string[] = [];
    const stderr: string[] = [];
    await runUpdate(
      { ...BASE, output: 'text', scheduleId: 'sch_1', cron: '* * * * *' },
      { credentialsPath, fetchImpl, stdout: l => stdout.push(l), stderr: l => stderr.push(l) },
    );

    expect(stderr.join('\n')).toContain('~43800 time(s)/month');
    // stdout stays the schedule card only.
    expect(stdout.join('\n')).not.toContain('time(s)/month');
  });

  it('says nothing about frequency when --cron was not supplied', async () => {
    const { credentialsPath } = makeCreds();
    const { fetchImpl } = capturing();

    const stderr: string[] = [];
    await runUpdate(
      { ...BASE, output: 'text', scheduleId: 'sch_1', name: 'Renamed' },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: l => stderr.push(l) },
    );

    expect(stderr.join('\n')).not.toContain('time(s)/month');
  });

  it('sends an idempotency key', async () => {
    const { credentialsPath } = makeCreds();
    const { calls, fetchImpl } = capturing();

    await runUpdate(
      { ...BASE, output: 'json', scheduleId: 'sch_1', pause: true },
      { credentialsPath, fetchImpl, ...sink },
    );

    expect(new Headers(calls[0]!.init.headers).get('idempotency-key')).toBeTruthy();
  });

  it('surfaces a 404', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Resource not found.', requestId: 'r' } },
    }));

    await expect(
      runUpdate(
        { ...BASE, output: 'json', scheduleId: 'sch_missing', pause: true },
        { credentialsPath, fetchImpl, ...sink },
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('get → update round trip', () => {
  // The shapes `get` actually hands back.
  const CRONS = ['0 */1 * * *', '0 1 * * *', '0 0 */1 * *', '0 9 * * *', '0 3 * * 1'];

  it.each(CRONS)('sends %s back on a patch unchanged, and can still read it', async cron => {
    const { credentialsPath } = makeCreds();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = makeFetch((url, init) => {
      calls.push({ url, init });
      return { body: { ...SCHEDULE, cron } };
    });

    const fetched = await runGet(
      { ...BASE, output: 'json', scheduleId: 'sch_1' },
      { credentialsPath, fetchImpl, ...sink },
    );

    await runUpdate(
      { ...BASE, output: 'json', scheduleId: 'sch_1', cron: fetched.cron! },
      { credentialsPath, fetchImpl, ...sink },
    );

    const patch = calls.find(c => c.init.method === 'PATCH')!;
    expect(JSON.parse(String(patch.init.body))).toEqual({ cron });

    // A cron off a real schedule the advisory cannot read would leave the
    // frequency warning echoing the raw expression, which is the whole point
    // of having one.
    expect(runsPerMonth(fetched.cron!)).not.toBeNull();
  });
});

describe('runDelete', () => {
  it('refuses without --confirm and never reaches the network', async () => {
    // Same convention as `project delete` / `test delete` / `testlist delete`:
    // every destructive verb needs the flag, and none of them are batch-only.
    const { credentialsPath } = makeCreds();
    await expect(
      runDelete(
        { ...BASE, output: 'json', scheduleId: 'sch_1' },
        { credentialsPath, fetchImpl: noNetwork(), ...sink },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('lets --dry-run through without --confirm', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runDelete(
        { ...BASE, output: 'json', scheduleId: 'sch_1', dryRun: true },
        { credentialsPath, ...sink },
      ),
    ).resolves.toMatchObject({ scheduleId: expect.any(String) });
  });

  it('DELETEs the schedule and sends an idempotency key', async () => {
    const { credentialsPath } = makeCreds();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = makeFetch((url, init) => {
      calls.push({ url, init });
      return { body: { scheduleId: 'sch_1' } };
    });

    const result = await runDelete(
      { ...BASE, output: 'json', scheduleId: 'sch_1', confirm: true },
      { credentialsPath, fetchImpl, ...sink },
    );

    expect(calls[0]!.init.method).toBe('DELETE');
    expect(calls[0]!.url).toContain('/schedules/sch_1');
    expect(new Headers(calls[0]!.init.headers).get('idempotency-key')).toBeTruthy();
    expect(result).toEqual({ scheduleId: 'sch_1' });
  });

  it('reports the deleted id in text mode', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { scheduleId: 'sch_1' } }));

    const out: string[] = [];
    await runDelete(
      { ...BASE, output: 'text', scheduleId: 'sch_1', confirm: true },
      { credentialsPath, fetchImpl, stdout: l => out.push(l), stderr: () => {} },
    );

    expect(out.join('\n')).toContain('deleted: sch_1');
  });
});

describe('runRunList', () => {
  it('requests the runs of one schedule', async () => {
    const { credentialsPath } = makeCreds();
    const urls: string[] = [];
    const fetchImpl = makeFetch(url => {
      urls.push(url);
      return { body: { runs: [RUN] } };
    });

    const result = await runRunList(
      { ...BASE, output: 'json', scheduleId: 'sch_1' },
      { credentialsPath, fetchImpl, ...sink },
    );

    expect(urls[0]).toContain('/schedules/sch_1/runs');
    expect(result.runs).toEqual([RUN]);
  });

  it('renders the run id, status and per-status counts', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { runs: [RUN] } }));

    const out: string[] = [];
    await runRunList(
      { ...BASE, output: 'text', scheduleId: 'sch_1' },
      { credentialsPath, fetchImpl, stdout: l => out.push(l), stderr: () => {} },
    );

    const text = out.join('\n');
    expect(text).toContain('exec_1');
    expect(text).toContain('passed');
    expect(text).toContain('RUN ID');
  });

  it('says there are no runs yet, which is not the same as no schedule', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { runs: [] } }));

    const out: string[] = [];
    await runRunList(
      { ...BASE, output: 'text', scheduleId: 'sch_1' },
      { credentialsPath, fetchImpl, stdout: l => out.push(l), stderr: () => {} },
    );

    expect(out.join('\n')).toBe('No runs yet.');
  });

  it('surfaces a 404 for an unknown schedule', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Resource not found.', requestId: 'r' } },
    }));

    await expect(
      runRunList(
        { ...BASE, output: 'json', scheduleId: 'sch_missing' },
        { credentialsPath, fetchImpl, ...sink },
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('tolerates a response with no runs key', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: {} }));

    const result = await runRunList(
      { ...BASE, output: 'json', scheduleId: 'sch_1' },
      { credentialsPath, fetchImpl, ...sink },
    );

    expect(result.runs).toEqual([]);
  });
});
