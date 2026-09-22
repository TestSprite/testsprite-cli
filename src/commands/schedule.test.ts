import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/errors.js';
import { type CliSchedule, createScheduleCommand, runGet, runList } from './schedule.js';

const SCHEDULE_FIXTURE: CliSchedule = {
  scheduleId: 'sch_b3c91efa',
  name: 'Nightly checkout',
  enabled: true,
  targetType: 'project',
  targetId: 'project_b3c91efa',
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

function makeCreds(
  apiKey = 'sk-user-test',
  apiUrl = 'http://localhost:13501',
): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-sched-'));
  const credentialsPath = join(dir, 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write into this test's own mkdtempSync-created temp dir (dir), not user input.
  writeFileSync(credentialsPath, `[default]\napi_url = ${apiUrl}\napi_key = ${apiKey}\n`, {
    mode: 0o600,
  });
  return { credentialsPath };
}

const BASE = { profile: 'default', debug: false } as const;

describe('createScheduleCommand', () => {
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

  // The full subcommand set is asserted in schedule.write.test.ts, which owns
  // the surface-shape check.

  it('list exposes the table flags', () => {
    const schedule = createScheduleCommand();
    const list = schedule.commands.find(c => c.name() === 'list')!;
    const flagNames = list.options.map(o => o.long);
    expect(flagNames).toContain('--columns');
    expect(flagNames).toContain('--no-header');
  });

  it('list exposes no pagination flags — the endpoint returns every schedule', () => {
    const schedule = createScheduleCommand();
    const list = schedule.commands.find(c => c.name() === 'list')!;
    const flagNames = list.options.map(o => o.long);
    expect(flagNames).not.toContain('--page-size');
    expect(flagNames).not.toContain('--starting-token');
    expect(flagNames).not.toContain('--max-items');
  });
});

describe('runList', () => {
  it('requests /schedules and returns the schedules array', async () => {
    const { credentialsPath } = makeCreds();
    const urls: string[] = [];
    const fetchImpl = makeFetch(url => {
      urls.push(url);
      return { body: { schedules: [SCHEDULE_FIXTURE] } };
    });

    const result = await runList(
      { ...BASE, output: 'json' },
      { credentialsPath, fetchImpl, stdout: () => {} },
    );

    expect(urls[0]).toContain('/schedules');
    expect(result.schedules).toEqual([SCHEDULE_FIXTURE]);
  });

  it('renders a table with the schedule id, name, status and cron', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { schedules: [SCHEDULE_FIXTURE] } }));

    const out: string[] = [];
    await runList(
      { ...BASE, output: 'text' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const text = out.join('\n');
    expect(text).toContain('sch_b3c91efa');
    expect(text).toContain('Nightly checkout');
    expect(text).toContain('ENABLED');
    expect(text).toContain('0 3 * * *');
  });

  it('reports an empty list without rendering a header row', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { schedules: [] } }));

    const out: string[] = [];
    await runList(
      { ...BASE, output: 'text' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    expect(out.join('\n')).toBe('No schedules.');
  });

  it('tolerates a response with no schedules key', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: {} }));

    const result = await runList(
      { ...BASE, output: 'json' },
      { credentialsPath, fetchImpl, stdout: () => {} },
    );

    expect(result.schedules).toEqual([]);
  });

  it('distinguishes a schedule paused automatically from one paused by hand', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: {
        schedules: [
          { ...SCHEDULE_FIXTURE, enabled: false, autoPausedAt: '2026-06-01T00:00:00.000Z' },
          { ...SCHEDULE_FIXTURE, scheduleId: 'sch_other', enabled: false, autoPausedAt: null },
        ],
      },
    }));

    const out: string[] = [];
    await runList(
      { ...BASE, output: 'text' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const rows = out.join('\n').split('\n');
    expect(rows.find(r => r.includes('sch_b3c91efa'))).toContain('AUTO_PAUSED');
    // What `update --pause` produces, so the label has to be the verb's name.
    const manual = rows.find(r => r.includes('sch_other'))!;
    expect(manual).toContain('PAUSED');
    expect(manual).not.toContain('AUTO_PAUSED');
  });

  it('pads the status column wide enough for the longest label', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: {
        schedules: [
          { ...SCHEDULE_FIXTURE, enabled: false, autoPausedAt: '2026-06-01T00:00:00.000Z' },
        ],
      },
    }));

    const out: string[] = [];
    await runList(
      { ...BASE, output: 'text' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const [header, row] = out.join('\n').split('\n');
    expect(row!.indexOf('project')).toBe(header!.indexOf('TARGET'));
  });
});

describe('runGet', () => {
  it('requests the schedule by id and renders its fields', async () => {
    const { credentialsPath } = makeCreds();
    const urls: string[] = [];
    const fetchImpl = makeFetch(url => {
      urls.push(url);
      return { body: SCHEDULE_FIXTURE };
    });

    const out: string[] = [];
    await runGet(
      { ...BASE, output: 'text', scheduleId: SCHEDULE_FIXTURE.scheduleId },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    expect(urls[0]).toContain('/schedules/sch_b3c91efa');
    const text = out.join('\n');
    expect(text).toContain('id:         sch_b3c91efa');
    expect(text).toContain('status:     ENABLED');
    expect(text).toContain('cron:       0 3 * * *');
  });

  it('url-encodes the schedule id', async () => {
    const { credentialsPath } = makeCreds();
    const urls: string[] = [];
    const fetchImpl = makeFetch(url => {
      urls.push(url);
      return { body: SCHEDULE_FIXTURE };
    });

    await runGet(
      { ...BASE, output: 'json', scheduleId: 'a b/c' },
      { credentialsPath, fetchImpl, stdout: () => {} },
    );

    expect(urls[0]).toContain('a%20b%2Fc');
  });

  it('labels an absent last run rather than printing null', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: SCHEDULE_FIXTURE }));

    const out: string[] = [];
    await runGet(
      { ...BASE, output: 'text', scheduleId: SCHEDULE_FIXTURE.scheduleId },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const text = out.join('\n');
    expect(text).toContain('lastRunId:  (never run)');
    expect(text).toContain('endAt:      (open-ended)');
    expect(text).not.toContain('null');
  });

  it('shows the auto-paused timestamp only when set', async () => {
    const { credentialsPath } = makeCreds();

    const enabled: string[] = [];
    await runGet(
      { ...BASE, output: 'text', scheduleId: 'sch_1' },
      {
        credentialsPath,
        fetchImpl: makeFetch(() => ({ body: SCHEDULE_FIXTURE })),
        stdout: line => enabled.push(line),
      },
    );
    expect(enabled.join('\n')).not.toContain('autoPaused:');

    const paused: string[] = [];
    await runGet(
      { ...BASE, output: 'text', scheduleId: 'sch_1' },
      {
        credentialsPath,
        fetchImpl: makeFetch(() => ({
          body: { ...SCHEDULE_FIXTURE, enabled: false, autoPausedAt: '2026-06-01T00:00:00.000Z' },
        })),
        stdout: line => paused.push(line),
      },
    );
    expect(paused.join('\n')).toContain('autoPaused: 2026-06-01T00:00:00.000Z');
  });

  it('surfaces a 404 as an ApiError', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Resource not found.', requestId: 'req_1' } },
    }));

    await expect(
      runGet(
        { ...BASE, output: 'json', scheduleId: 'sch_missing' },
        { credentialsPath, fetchImpl, stdout: () => {} },
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('surfaces a plan refusal as an ApiError', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 403,
      body: {
        error: {
          code: 'FEATURE_GATED',
          message: "Feature 'schedule' is not available on the Free plan.",
          requestId: 'req_2',
        },
      },
    }));

    await expect(
      runGet(
        { ...BASE, output: 'json', scheduleId: 'sch_1' },
        { credentialsPath, fetchImpl, stdout: () => {} },
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
