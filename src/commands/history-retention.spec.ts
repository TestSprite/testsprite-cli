import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runResultHistory, runSteps } from './test.js';
import { runRunList } from './schedule.js';

const billingUrl = 'https://server.example/dashboard-v3/o/org-1/settings/billing';
const meta = { tier: 'Free', retentionDays: 30, hiddenCount: 2, billingUrl };

function credentialsPath(apiUrl = 'https://api.testsprite.com'): string {
  const path = join(mkdtempSync(join(tmpdir(), 'history-retention-')), 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- this suite's own mkdtempSync temp path, never user input
  writeFileSync(path, `[default]\napi_url = ${apiUrl}\napi_key = sk-user-test\n`, {
    mode: 0o600,
  });
  return path;
}

function fetchFor(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

const row = {
  runId: 'run_1',
  status: 'passed',
  source: 'cli',
  isRerun: false,
  createdFrom: null,
  createdAt: '2026-06-01T10:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  codeVersion: 'v1',
  failureKind: null,
};

async function render(
  kind: 'test' | 'schedule',
  body: unknown,
  output: 'text' | 'json' = 'text',
  apiUrl = 'https://api.testsprite.com',
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps = {
    credentialsPath: credentialsPath(apiUrl),
    fetchImpl: fetchFor(body),
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
  };
  const base = { profile: 'default', output, debug: false, dryRun: false, verbose: false } as const;
  if (kind === 'test') {
    await runResultHistory({ ...base, testId: 'test_1' }, deps);
  } else {
    await runRunList({ ...base, scheduleId: 'schedule_1' }, deps);
  }
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

afterEach(() => vi.unstubAllEnvs());

describe.each(['test', 'schedule'] as const)('%s run history retention', kind => {
  const body = (runs: unknown[], fields: Record<string, unknown> = {}) =>
    kind === 'test'
      ? { runs, nextCursor: null, meta: { testKind: 'frontend', ...fields } }
      : { runs, meta: fields };
  const runs =
    kind === 'test'
      ? [row]
      : [
          {
            ...row,
            scheduleId: 'schedule_1',
            projectId: null,
            testListId: null,
            stats: { total: 1, passed: 1, failed: 0, blocked: 0, running: 0, cancelled: 0 },
            updatedAt: row.createdAt,
          },
        ];

  it('prints plural hidden count and both server-origin links after a nonempty list', async () => {
    const result = await render(kind, body(runs, meta));
    expect(result.stdout).toContain('run_1');
    expect(result.stderr).toBe(
      '2 older runs hidden — the Free plan keeps 30 days of run history.\n' +
        '  upgrade:   https://server.example/pricing\n' +
        `  billing:   ${billingUrl}`,
    );
  });

  it('prints singular count after the existing empty-state line', async () => {
    const result = await render(kind, body([], { ...meta, hiddenCount: 1 }));
    expect(result.stdout).toContain(kind === 'test' ? 'No CLI-tracked history' : 'No runs yet.');
    expect(result.stderr).toContain('1 older run hidden — the Free plan keeps 30 days');
  });

  it('rebases both links onto TESTSPRITE_PORTAL_URL', async () => {
    vi.stubEnv('TESTSPRITE_PORTAL_URL', 'https://staging.portal.example');
    const result = await render(kind, body(runs, meta));
    expect(result.stderr).toContain('  upgrade:   https://staging.portal.example/pricing');
    expect(result.stderr).toContain(
      '  billing:   https://staging.portal.example/dashboard-v3/o/org-1/settings/billing',
    );
  });

  it('passes the backend meta through in JSON without a human note', async () => {
    const result = await render(kind, body(runs, meta), 'json');
    expect(JSON.parse(result.stdout).meta).toEqual(
      kind === 'test' ? { testKind: 'frontend', ...meta } : meta,
    );
    expect(result.stderr).toBe('');
  });

  it('keeps text byte-identical when fields are absent, hidden count is zero, or retention is unlimited', async () => {
    const baseline = await render(kind, body(runs, {}));
    expect(baseline.stderr).toBe('');
    for (const fields of [
      { ...meta, hiddenCount: 0 },
      { ...meta, retentionDays: null },
    ]) {
      expect(await render(kind, body(runs, fields))).toEqual(baseline);
    }
  });

  it('uses production Portal mapping when billingUrl is absent', async () => {
    const result = await render(
      kind,
      body(runs, { tier: 'Starter', retentionDays: 30, hiddenCount: 1 }),
    );
    expect(result.stderr).toContain('  upgrade:   https://www.testsprite.com/pricing');
    expect(result.stderr).toContain(
      '  billing:   https://www.testsprite.com/dashboard/settings/billing',
    );
  });

  it('uses route-only links for an unknown API without a billingUrl', async () => {
    const result = await render(
      kind,
      body(runs, { tier: 'Starter', retentionDays: 30, hiddenCount: 1 }),
      'text',
      'https://unknown-api.example',
    );
    expect(result.stderr).toContain('  upgrade:   /pricing');
    expect(result.stderr).toContain('  billing:   /dashboard/settings/billing');
  });
});

it.each(['text', 'json'] as const)(
  'test steps labels its earlier-run suggestion as limited to the plan window in %s',
  async output => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const body = String(input).includes('/steps')
        ? { items: [], nextToken: null }
        : {
            runs: [row, { ...row, runId: 'run_older' }],
            nextCursor: null,
            meta: { testKind: 'frontend', ...meta },
          };
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    await runSteps(
      { profile: 'default', output, debug: false, testId: 'test_1' },
      {
        credentialsPath: credentialsPath(),
        fetchImpl,
        stdout: line => stdout.push(line),
        stderr: line => stderr.push(line),
      },
    );
    expect(stdout).toEqual([
      output === 'text' ? 'No steps.' : JSON.stringify({ items: [], nextToken: null }, null, 2),
    ]);
    expect(stderr[0]).toContain('--run-id run_older');
    expect(stderr[1]).toContain("This suggestion only covers the plan's visible history.");
    expect(stderr[1]).toContain('2 older runs hidden');
    expect(stderr[1]).toContain(`  billing:   ${billingUrl}`);
  },
);
