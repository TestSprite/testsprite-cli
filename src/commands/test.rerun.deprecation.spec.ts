/**
 * `test rerun` / `test flaky` are deprecated but must keep working unchanged
 * until removal: the action path may add one stderr line and one trailing
 * `deprecations` key, nothing else. Each case runs the same scenario through
 * the direct `runTestRerun` call and through the Commander action and compares.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { createTestCommand, runTestRerun } from './test.js';

type Handler = (
  method: string,
  path: string,
  body: Record<string, unknown>,
) => { status?: number; body: unknown };

const TEST_ROW = {
  id: 'test_fe_01',
  projectId: 'project_abc',
  name: 'FE test',
  type: 'frontend',
  createdFrom: 'portal',
  status: 'passed',
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
};

function runRow(runId: string, status = 'passed') {
  return {
    runId,
    testId: 'test_fe_01',
    projectId: 'project_abc',
    userId: 'user_1',
    status,
    source: 'cli',
    createdAt: '2026-06-03T10:00:00.000Z',
    startedAt: '2026-06-03T10:00:01.000Z',
    finishedAt: '2026-06-03T10:00:30.000Z',
    codeVersion: 'v1',
    targetUrl: 'https://example.com',
    createdFrom: 'rerun:prior',
    failedStepIndex: null,
    failureKind: null,
    error: null,
    videoUrl: null,
    stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 },
  };
}

function harness(handler: Handler) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-rerun-depr-'));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp path, never user input.
  mkdirSync(dir, { recursive: true });
  const credentialsPath = join(dir, 'credentials');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own mkdtempSync temp path, never user input.
  writeFileSync(
    credentialsPath,
    '[default]\napi_url = http://localhost:13503\napi_key = sk-user-test\n',
    { mode: 0o600 },
  );
  const requests: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    requests.push(`${method} ${url.pathname}${url.search} ${JSON.stringify(body)}`);
    const out = handler(method, url.pathname.replace('/api/cli/v1', ''), body);
    return new Response(JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const deps = {
    credentialsPath,
    fetchImpl,
    sleep: async () => {},
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
  };
  const action = (output: 'json' | 'text', ...args: string[]) =>
    new Command('testsprite')
      .option('--output <mode>')
      .option('--dry-run')
      .addCommand(createTestCommand(deps))
      .parseAsync(['--output', output, 'test', ...args], { from: 'user' });
  return { deps, requests, stdout, stderr, action };
}

const BASE = {
  testIds: ['test_fe_01'],
  all: false,
  wait: false,
  timeoutSeconds: 600,
  autoHeal: true,
  autoHealExplicit: false,
  skipDependencies: false,
  concurrencyIsDefault: true,
  maxConcurrency: 50,
  output: 'json' as const,
  profile: 'default',
  dryRun: false,
  debug: false,
  verbose: false,
};

const noticeLines = (lines: string[]) => lines.filter(l => l.startsWith('[deprecated]'));

async function outcome(fn: () => Promise<unknown>): Promise<{ code?: number; message?: string }> {
  try {
    await fn();
    return {};
  } catch (err) {
    const e = err as { exitCode?: number; message?: string };
    return { code: e.exitCode, message: e.message };
  }
}

const singleHandler: Handler = (method, path) => {
  if (method === 'POST' && path.endsWith('/runs/rerun'))
    return {
      body: {
        runId: 'run_1',
        status: 'queued',
        enqueuedAt: '2026-06-03T10:00:00.000Z',
        codeVersion: 'v1',
        autoHeal: false,
      },
    };
  if (path.startsWith('/runs/')) return { body: runRow('run_1') };
  if (path.startsWith('/tests/') && method === 'GET') return { body: TEST_ROW };
  return { status: 404, body: { error: { code: 'NOT_FOUND', message: 'x', details: {} } } };
};

const batchHandler: Handler = (method, path, body) => {
  if (path === '/tests/batch/rerun') {
    const ids = (body.testIds as string[]) ?? [];
    return {
      status: 202,
      body: {
        accepted: ids.slice(0, 1).map(id => ({
          testId: id,
          runId: `run_${id}`,
          enqueuedAt: '2026-06-03T10:00:00.000Z',
        })),
        deferred: ids.slice(1).map(id => ({ testId: id, reason: 'rate_limited' })),
        conflicts: [],
        closure: { byProject: [] },
      },
    };
  }
  return singleHandler(method, path, body);
};

const allHandler: Handler = (method, path, body) => {
  if (method === 'GET' && path === '/tests') return { body: { items: [], nextToken: null } };
  return batchHandler(method, path, body);
};

interface Scenario {
  name: string;
  handler: Handler;
  opts: Partial<typeof BASE> & { projectId?: string; allowEmpty?: boolean };
  args: string[];
  code?: number;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'single FE queued',
    handler: singleHandler,
    opts: {},
    args: ['rerun', 'test_fe_01'],
  },
  {
    name: 'single FE --wait pass',
    handler: singleHandler,
    opts: { wait: true },
    args: ['rerun', 'test_fe_01', '--wait'],
  },
  {
    name: 'batch with a deferred id',
    code: 7,
    handler: batchHandler,
    opts: { testIds: ['test_a', 'test_b'] },
    args: ['rerun', 'test_a', 'test_b'],
  },
  {
    name: '--all zero-dispatch with --allow-empty',
    handler: allHandler,
    opts: { testIds: [], all: true, projectId: 'project_abc', allowEmpty: true },
    args: ['rerun', '--all', '--project', 'project_abc', '--allow-empty'],
  },
  {
    name: '--all zero-dispatch without --allow-empty',
    code: 5,
    handler: allHandler,
    opts: { testIds: [], all: true, projectId: 'project_abc' },
    args: ['rerun', '--all', '--project', 'project_abc'],
  },
];

describe('test rerun deprecation is additive only', () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: same requests, stdout plus a trailing deprecations key, same outcome`, async () => {
      const direct = harness(s.handler);
      const directOutcome = await outcome(() => runTestRerun({ ...BASE, ...s.opts }, direct.deps));
      const viaAction = harness(s.handler);
      const actionOutcome = await outcome(() => viaAction.action('json', ...s.args));

      expect(viaAction.requests).toEqual(direct.requests);
      expect(actionOutcome).toEqual(directOutcome);
      expect(actionOutcome.code).toBe(s.code);
      const withEntry = direct.stdout.map(line => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return Array.isArray(parsed)
          ? parsed
          : {
              ...parsed,
              deprecations: [
                { command: 'test rerun', replacement: 'test run', removedIn: '0.17.0' },
              ],
            };
      });
      expect(viaAction.stdout.map(l => JSON.parse(l))).toEqual(withEntry);
      const last = viaAction.stdout.map(l => Object.keys(JSON.parse(l) as object).pop());
      for (const key of last) expect(key).toBe('deprecations');
      expect(noticeLines(viaAction.stderr)).toHaveLength(1);
      expect(noticeLines(direct.stderr)).toHaveLength(0);
    });
  }

  it('the notice names the template replacement, not a runnable command', async () => {
    const h = harness(singleHandler);
    await h.action('json', 'rerun', 'test_fe_01');
    expect(noticeLines(h.stderr)).toEqual([
      '[deprecated] `testsprite test rerun` is deprecated and will be removed in 0.17.0. ' +
        'Use `testsprite test run` with the same ids and flags, except: ' +
        '--skip-terminal becomes --status not_run, and --status takes only ' +
        'passed, failed, blocked, cancelled, not_run.',
    ]);
  });

  it('a chunked batch rerun still prints one notice and one deprecations key', async () => {
    const h = harness(batchHandler);
    const many = Array.from({ length: 60 }, (_, i) => `test_${i}`);
    await outcome(() => h.action('json', 'rerun', ...many));
    expect(h.requests.filter(r => r.includes('/tests/batch/rerun'))).toHaveLength(2);
    expect(noticeLines(h.stderr)).toHaveLength(1);
    expect(h.stdout).toHaveLength(1);
    expect(JSON.parse(h.stdout[0]!).deprecations).toHaveLength(1);
  });

  it('text mode keeps the notice off stdout', async () => {
    const h = harness(singleHandler);
    await h.action('text', 'rerun', 'test_fe_01');
    expect(noticeLines(h.stderr)).toHaveLength(1);
    expect(h.stdout.join('\n')).not.toContain('[deprecated]');
    expect(h.stdout.join('\n')).not.toContain('deprecations');
  });

  it('dry-run still emits the notice and the key', async () => {
    const h = harness(singleHandler);
    await h.action('json', '--dry-run', 'rerun', 'test_fe_01');
    expect(noticeLines(h.stderr)).toHaveLength(1);
    expect(JSON.parse(h.stdout[0]!).deprecations).toEqual([
      { command: 'test rerun', replacement: 'test run', removedIn: '0.17.0' },
    ]);
  });

  it('the notice precedes a validation error and is not repeated', async () => {
    const h = harness(singleHandler);
    const res = await outcome(() => h.action('json', 'rerun', 'test_fe_01', '--gh-output'));
    expect(res.code).toBe(5);
    expect(noticeLines(h.stderr)).toHaveLength(1);
    expect(h.requests).toHaveLength(0);
  });

  it('a server deprecation advisory still yields exactly one notice and key entry', async () => {
    const h = harness((method, path, body) => {
      const base = singleHandler(method, path, body);
      if (method === 'POST' && path.endsWith('/runs/rerun'))
        return {
          body: {
            ...(base.body as object),
            advisories: [
              {
                feature: 'deprecation',
                message: 'server says deprecated',
                command: 'test rerun',
                replacement: 'test run',
                removedIn: '0.17.0',
              },
            ],
          },
        };
      return base;
    });
    await h.action('json', 'rerun', 'test_fe_01');
    expect(noticeLines(h.stderr)).toHaveLength(1);
    expect(h.stderr.join('\n')).not.toContain('server says deprecated');
    const out = JSON.parse(h.stdout[0]!);
    expect(out.deprecations).toHaveLength(1);
    expect(out.advisories).toBeUndefined();
  });
});

describe('test flaky deprecation', () => {
  it('emits one notice and a trailing deprecations key', async () => {
    const h = harness(singleHandler);
    const res = await outcome(() => h.action('json', 'flaky', 'test_fe_01', '--runs', '1'));
    expect(res.code).toBeUndefined();
    expect(noticeLines(h.stderr)).toHaveLength(1);
    expect(noticeLines(h.stderr)).toEqual([
      '[deprecated] `testsprite test flaky` is deprecated and will be removed in 0.17.0, ' +
        'with no replacement. To sample a test again, run `testsprite test run test_fe_01`.',
    ]);
    const out = JSON.parse(h.stdout[0]!) as Record<string, unknown>;
    expect(out.deprecations).toEqual([
      { command: 'test flaky', replacement: 'test run', removedIn: '0.17.0' },
    ]);
    expect(Object.keys(out).pop()).toBe('deprecations');
  });
});

describe('deprecated command help', () => {
  const test = createTestCommand();
  for (const name of ['rerun', 'flaky']) {
    it(`${name} is a hidden alias whose own help leads with [deprecated]`, () => {
      const cmd = test.commands.find(c => c.name() === name)!;
      expect((cmd as unknown as { _hidden: boolean })._hidden).toBe(true);
      expect(test.helpInformation()).not.toMatch(new RegExp(`^\\s+${name}\\b`, 'm'));
      expect(cmd.description().startsWith('[deprecated]')).toBe(true);
      expect(cmd.helpInformation()).toContain('[deprecated]');
    });
  }
});
