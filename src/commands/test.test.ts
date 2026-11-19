import { projectHarness, projectRun } from '../../test/helpers/project-run.js';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { ApiError } from '../lib/errors.js';
import { DRY_RUN_BANNER, resetDryRunBannerForTesting } from '../lib/client-factory.js';
import { GLOBAL_OPTS_HINT } from '../lib/output.js';
import { ShutdownController } from '../lib/interrupt.js';
import { defaultSleep } from '../lib/poll-support.js';
import {
  type CliTest,
  type TestDeps,
  createTestCommand,
  createRunCommand,
  runGet,
  runList,
  writeBatchJUnitReportIfRequested,
  runTestRunAll,
  runTestRun,
  sleepUntilOrInterrupt,
} from './test.js';

it('clears a pending sleep timer when interrupted', async () => {
  vi.useFakeTimers();
  try {
    const shutdown = new ShutdownController();
    const pending = sleepUntilOrInterrupt(60_000, shutdown.signal, defaultSleep);
    expect(vi.getTimerCount()).toBe(1);
    shutdown.interrupt('SIGINT');
    await expect(pending).rejects.toBe(shutdown.signal.reason);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

function disableExits(cmd: Command): void {
  cmd.exitOverride();
  cmd.commands.forEach(disableExits);
}

const FE_TEST: CliTest = {
  id: 'test_fe',
  projectId: 'project_alice',
  slug: 'CHECKOUT-001',
  title: 'Checkout happy path',
  type: 'frontend',
  category: 'Checkout',
  priority: 'High',
  version: { hash: 'a3f9c2e1', label: 'v1.2' },
  stepCount: 8,
  createdAt: '2026-04-20T11:00:00.000Z',
  updatedAt: '2026-05-05T12:34:56.000Z',
};

const BE_TEST: CliTest = {
  id: 'test_be',
  projectId: 'project_alice',
  slug: 'SMOKE-002',
  title: 'Smoke — health check',
  type: 'backend',
  category: 'Smoke',
  priority: null,
  version: { hash: '7c1e0b9a', label: 'v1.0' },
  stepCount: null,
  createdAt: '2026-04-22T09:00:00.000Z',
  updatedAt: '2026-05-05T11:00:30.000Z',
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
  apiUrl = 'http://localhost:13502',
): { credentialsPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-p3-'));
  const credentialsPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(credentialsPath, `[default]\napi_url = ${apiUrl}\napi_key = ${apiKey}\n`, {
    mode: 0o600,
  });
  return { credentialsPath };
}

describe('createTestCommand — surface', () => {
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

  it('exposes the expected top-level subcommands', () => {
    const test = createTestCommand();
    const names = test.commands.map(c => c.name()).sort();
    expect(names).toEqual(['get', 'list']);
  });

  // `result list` / `result get` replace these; an old invocation gets
  // Commander's own `unknown command` (exit 5), with no alias left behind.
  it.each(['result', 'steps', 'diff', 'failure', 'artifact'])(
    'test %s is no longer a command',
    name => {
      expect(createTestCommand().commands.map(c => c.name())).not.toContain(name);
    },
  );

  it('list exposes the documented filter and pagination flags (including --cursor alias)', () => {
    const test = createTestCommand();
    const list = test.commands.find(c => c.name() === 'list')!;
    const flagNames = list.options.map(o => o.long);
    expect(flagNames).toEqual(
      expect.arrayContaining([
        '--project',
        '--type',
        '--page-size',
        '--starting-token',
        '--cursor',
        '--max-items',
      ]),
    );
    expect(list.options.map(o => o.long)).not.toContain('--env');
    expect(list.options.map(o => o.long)).not.toContain('--status');
  });

  // -------------------------------------------------------------------------
  // GLOBAL_OPTS_HINT sweep — every leaf subcommand must surface the footer
  // pointing at `testsprite --help` so users discover --dry-run, --output,
  // --profile, --endpoint-url, --verbose, and --debug.
  //
  // This addresses the dogfood entry (2026-05-15): "M3.3 subcommands omitted
  // GLOBAL_OPTS_HINT". The M3.3 fix landed in fix/cli-m3.3-consolidated-fixes;
  // this sweep guards the full surface (M2 + M3.x) against future regressions.
  // -------------------------------------------------------------------------

  function captureHelp(cmd: ReturnType<typeof createTestCommand>): string {
    let out = '';
    cmd.configureOutput({
      writeOut: (str: string) => {
        out += str;
      },
    });
    cmd.outputHelp();
    return out;
  }

  it.each(['run', 'wait', 'cancel'])(
    'test %s help distinguishes execution IDs from result IDs',
    name => {
      const run = createRunCommand();
      const help = captureHelp(name === 'run' ? run : run.commands.find(c => c.name() === name)!);
      expect(help).toContain('runId');
      expect(help).not.toContain('launch, printed as resultId');
      expect(help).not.toContain('A run id is the resultId');
      expect(help).not.toContain('Every run is listed first');
      if (name === 'wait') {
        expect(help).toContain('execution status');
        expect(help).toContain('including later integration results');
      }
      if (name === 'cancel') expect(help).toContain('one cancellation request per execution');
      if (name === 'run') {
        expect(help).toContain('server limit per execution');
        expect(help).not.toContain('split across its runs');
      }
    },
  );

  it('M3.3: run --help includes GLOBAL_OPTS_HINT', () => {
    const run = createRunCommand();
    const help = captureHelp(run);
    expect(help).toContain('testsprite --help');
    expect(help).toContain('--dry-run');
  });

  it('M3.3: run wait --help includes GLOBAL_OPTS_HINT', () => {
    const wait = createRunCommand().commands.find(c => c.name() === 'wait')!;
    const help = captureHelp(wait);
    expect(help).toContain('testsprite --help');
    expect(help).toContain('--dry-run');
  });

  it('M2 sweep: all remaining leaf subcommands include GLOBAL_OPTS_HINT', () => {
    // Covers the case-reading commands.
    const test = createTestCommand();

    // Flat leaf commands (direct children of `test`)
    const flatLeaves = ['list', 'get'];
    for (const name of flatLeaves) {
      const cmd = test.commands.find(c => c.name() === name)!;
      expect(cmd, `test ${name} must exist`).toBeDefined();
      const help = captureHelp(cmd);
      expect(help, `test ${name} --help must include GLOBAL_OPTS_HINT`).toContain(GLOBAL_OPTS_HINT);
    }
  });
});

describe('kept source names no removed read command', () => {
  // Help, hints, nextActions, dry-run samples and comments alike: a user or
  // an agent reading any of them must never be sent to a command that is gone.
  const REMOVED_COMMAND_MENTIONS = [
    /\btest (result|steps|failure|artifact|diff)\b/,
    /\btest [\w/]*\/(result|steps|failure|artifact|diff)\b/,
    /\b(failure|artifact) (get|summary)\b/,
    /--history\b/,
  ];

  it('no non-spec file under src/ mentions one', () => {
    const srcDir = fileURLToPath(new URL('..', import.meta.url));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the repo's own src/ directory, never user input.
    const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).filter(
      f => f.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(f),
    );
    expect(files).toContain(join('commands', 'test.ts'));
    const hits: string[] = [];
    for (const file of files) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file listed from the repo's own src/ directory, never user input.
      readFileSync(join(srcDir, file), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (REMOVED_COMMAND_MENTIONS.some(re => re.test(line))) {
            hits.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });
});

describe('`run list` — usage guard (not a positional test id)', () => {
  function commandWithExitOverride(
    fetchImpl: typeof globalThis.fetch,
  ): ReturnType<typeof createTestCommand> {
    const { credentialsPath } = makeCreds();
    const test = createRunCommand({ credentialsPath, fetchImpl });
    const disable = (c: { exitOverride: () => unknown; commands: Array<unknown> }) => {
      c.exitOverride();
      (c.commands as Array<{ exitOverride: () => unknown; commands: Array<unknown> }>).forEach(
        disable,
      );
    };
    disable(test as never);
    return test;
  }

  it('run list points to result list --test', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not hit network — the guard must fire before any request');
    });
    const test = commandWithExitOverride(fetchImpl as unknown as typeof fetch);
    let thrown: unknown;
    try {
      await test.parseAsync(['list'], { from: 'user' });
    } catch (e) {
      thrown = e;
    }
    const err = thrown as ApiError;
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.exitCode).toBe(5);
    expect(err.nextAction).toContain('testsprite result list --test <test-id>');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('run help — the spec nouns', () => {
  it('describes --skip-dependencies and queueing with run and result', async () => {
    const cmd = createRunCommand();
    let out = '';
    cmd.configureOutput({ writeOut: text => (out += text) });
    cmd.outputHelp();
    const help = out.replace(/\s+/g, ' ');
    expect(help).toContain(
      '--skip-dependencies Backend test cases only: run without the test cases they depend on',
    );
    expect(help).toContain(
      'Each request starts one run; its results show queued until they start, as in the Portal.',
    );
    expect(help).not.toMatch(/closure|--status/);
  });
});

describe('runList', () => {
  it('reports missing credentials before a missing project', async () => {
    const credentialsPath = join(mkdtempSync(join(tmpdir(), 'cli-list-auth-')), 'credentials');
    const test = createTestCommand({
      credentialsPath,
      env: {} as NodeJS.ProcessEnv,
      stdout: () => undefined,
    });

    await expect(test.parseAsync(['list'], { from: 'user' })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      exitCode: 3,
      nextAction: expect.stringContaining('testsprite setup'),
    });
  });

  it('passes projectId and type to the facade query string', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: { items: [FE_TEST], nextToken: null } };
    });
    await runList(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_alice',
        type: 'frontend',
      },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    expect(seen[0]).toContain('projectId=project_alice');
    expect(seen[0]).toContain('type=frontend');
    expect(seen[0]).not.toContain('status=');
  });

  it('--dry-run does not emit the banner when local validation fails (issue #360)', async () => {
    // Repro: `testsprite test list --dry-run` (no --project) used to print
    // "[dry-run] sample response — not from the server" before the
    // VALIDATION_ERROR, because the banner fired at client construction
    // while `requireProjectId` ran after. The banner is now lazy (first
    // dry-run response), so only the error prints.
    resetDryRunBannerForTesting();
    const stderr: string[] = [];
    await expect(
      runList(
        { profile: 'default', output: 'json', debug: false, dryRun: true },
        {
          env: {} as NodeJS.ProcessEnv,
          stderr: line => stderr.push(line),
          stdout: () => undefined,
        },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: expect.objectContaining({ field: 'project' }),
    });
    expect(stderr.join('\n')).not.toContain(DRY_RUN_BANNER);
  });

  it('--dry-run emits the banner when the command produces a dry-run response', async () => {
    // Happy path guard: with validation passing, the lazy banner still
    // prints exactly once before the canned sample.
    resetDryRunBannerForTesting();
    const stderr: string[] = [];
    const out: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        projectId: 'project_alice',
      },
      {
        env: {} as NodeJS.ProcessEnv,
        stderr: line => stderr.push(line),
        stdout: line => out.push(line),
      },
    );
    expect(stderr.filter(l => l === DRY_RUN_BANNER)).toHaveLength(1);
    expect(JSON.parse(out.join('\n'))).toHaveProperty('items');
  });

  it('uses TESTSPRITE_PROJECT_ID when --project is omitted', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: { items: [FE_TEST], nextToken: null } };
    });
    await runList(
      { profile: 'default', output: 'json', debug: false },
      {
        credentialsPath,
        env: { TESTSPRITE_PROJECT_ID: 'project_env' } as NodeJS.ProcessEnv,
        fetchImpl,
        stdout: () => undefined,
      },
    );
    expect(seen[0]).toContain('projectId=project_env');
  });

  it('uses TESTSPRITE_PROJECT_ID when --project is blank', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: { items: [FE_TEST], nextToken: null } };
    });
    await runList(
      { profile: 'default', output: 'json', debug: false, projectId: '   ' },
      {
        credentialsPath,
        env: { TESTSPRITE_PROJECT_ID: 'project_env' } as NodeJS.ProcessEnv,
        fetchImpl,
        stdout: () => undefined,
      },
    );
    expect(seen[0]).toContain('projectId=project_env');
  });

  it('prefers explicit --project over TESTSPRITE_PROJECT_ID', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: { items: [FE_TEST], nextToken: null } };
    });
    await runList(
      { profile: 'default', output: 'json', debug: false, projectId: 'project_flag' },
      {
        credentialsPath,
        env: { TESTSPRITE_PROJECT_ID: 'project_env' } as NodeJS.ProcessEnv,
        fetchImpl,
        stdout: () => undefined,
      },
    );
    expect(seen[0]).toContain('projectId=project_flag');
    expect(seen[0]).not.toContain('projectId=project_env');
  });

  it('auto-pages until nextToken is null', async () => {
    const { credentialsPath } = makeCreds();
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      if (calls === 1) return { body: { items: [FE_TEST], nextToken: 'cursor-1' } };
      return { body: { items: [BE_TEST], nextToken: null } };
    });
    const out: string[] = [];
    const page = await runList(
      { profile: 'default', output: 'json', debug: false, projectId: 'project_alice' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(calls).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(JSON.parse(out[0]!).items).toHaveLength(2);
  });

  it('--page-size returns one page (no auto-paging) and surfaces the cursor', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: { items: [FE_TEST], nextToken: 'opaque-A' } };
    });
    const page = await runList(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_alice',
        pageSize: 1,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('pageSize=1');
    expect(page.nextToken).toBe('opaque-A');
  });

  it('--max-items caps result count across multiple pages', async () => {
    const { credentialsPath } = makeCreds();
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      return {
        body: {
          items: [
            { ...FE_TEST, id: `t_${calls}_a` },
            { ...FE_TEST, id: `t_${calls}_b` },
          ],
          nextToken: calls < 3 ? `cursor-${calls}` : null,
        },
      };
    });
    const page = await runList(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_alice',
        maxItems: 3,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    expect(page.items).toHaveLength(3);
    expect(page.nextToken).toBe('cursor-2');
  });

  it('rejects --type=junk locally with VALIDATION_ERROR (no network call)', async () => {
    const test = createTestCommand();
    disableExits(test);
    await expect(
      test.parseAsync(['list', '--project', 'project_alice', '--type', 'junk'], { from: 'user' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects --page-size=0 locally with VALIDATION_ERROR (no network call)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => {
      throw new Error('network should not be hit');
    });
    await expect(
      runList(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_alice',
          pageSize: 0,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'page-size' } });
  });

  it('forwards a server-side VALIDATION_ERROR envelope as ApiError exit 5', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'bad cursor',
          nextAction: 'pass nextToken from a previous response',
          requestId: 'req_test',
          details: { field: 'cursor' },
        },
      },
    }));
    await expect(
      runList(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_alice',
          startingToken: 'bogus',
        },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('text mode renders mixed FE/BE rows with header + the case columns', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { items: [FE_TEST, BE_TEST], nextToken: null },
    }));
    const out: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_alice',
        pageSize: 25,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    for (const header of [
      'ID',
      'SLUG',
      'TITLE',
      'TYPE',
      'CATEGORY',
      'PRIORITY',
      'VERSION',
      'STEPS',
      'UPDATED',
    ]) {
      expect(block).toContain(header);
    }
    expect(block).toContain('CHECKOUT-001');
    expect(block).toContain('Checkout happy path');
    expect(block).toContain('SMOKE-002');
    expect(block).toContain('Smoke — health check');
    // Both types render explicitly; the agent loop reads `type` directly
    // from JSON, but humans glance at the column.
    expect(block).toContain('frontend');
    expect(block).toContain('backend');
    // Version label and step count come from the case itself; a backend
    // case has no steps, so its STEPS cell is the dash.
    expect(block).toContain('v1.2');
    expect(block).toContain('v1.0');
    expect(block).toMatch(/High\s+v1\.2\s+8\s/);
    expect(block).toMatch(/-\s+v1\.0\s+-\s/);
  });

  it('text mode selects/reorders columns and suppresses the header', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { items: [FE_TEST, BE_TEST], nextToken: null },
    }));
    const out: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_alice',
        pageSize: 25,
        columns: 'version,id',
        noHeader: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const lines = out.join('\n').split('\n');
    expect(lines[0]).toMatch(/^v1\.2\s+test_fe$/);
    expect(lines[1]).toMatch(/^v1\.0\s+test_be$/);
    expect(out.join('\n')).not.toContain('VERSION');
    expect(out.join('\n')).not.toContain('UPDATED');
  });

  it('keeps nextToken on stdout under --no-header for a non-empty page', async () => {
    // `--no-header` suppresses the text-table HEADER row only (its
    // documented contract) — a script piping `--no-header` output still
    // needs `nextToken` to keep paging with `--starting-token`.
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { items: [FE_TEST], nextToken: 'more-1' } }));
    const out: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_alice',
        pageSize: 25,
        noHeader: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    expect(block).not.toContain('STATUS');
    expect(block).toContain('nextToken: more-1');
  });

  it('still prints "No tests." for an empty page under --no-header', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { items: [], nextToken: null } }));
    const out: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_alice',
        pageSize: 25,
        noHeader: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(out.join('\n')).toBe('No tests.');
  });

  it('text mode rejects unknown columns with VALIDATION_ERROR before auth/network access', async () => {
    await expect(
      runList(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          projectId: 'project_alice',
          pageSize: 25,
          columns: 'bogus',
        },
        { stdout: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: { field: 'columns' },
    });
  });

  it('json mode ignores text-only column flags', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { items: [FE_TEST], nextToken: null },
    }));
    const out: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_alice',
        pageSize: 25,
        columns: 'bogus',
        noHeader: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    expect(JSON.parse(out.join('\n')).items[0].id).toBe('test_fe');
  });

  it('text mode reads "No tests." when items is empty and nextToken is null', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { items: [], nextToken: null } }));
    const out: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_alice',
        pageSize: 25,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(out.join('\n')).toBe('No tests.');
  });

  it('text mode reads "No tests on this page." with cursor when filtered out', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { items: [], nextToken: 'still-more' } }));
    const out: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_alice',
        pageSize: 25,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    expect(block).toContain('No tests on this page.');
    expect(block).toContain('nextToken: still-more');
  });

  it('--starting-token resumes pagination from the supplied cursor', async () => {
    const { credentialsPath } = makeCreds();
    const seenCursors: Array<string | null> = [];
    const fetchImpl = makeFetch(url => {
      const match = /cursor=([^&]+)/.exec(url);
      seenCursors.push(match ? decodeURIComponent(match[1]!) : null);
      return { body: { items: [FE_TEST], nextToken: null } };
    });
    await runList(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_alice',
        startingToken: 'resume-here',
      },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    expect(seenCursors[0]).toBe('resume-here');
  });
});

// Fix 2: --cursor alias on `test list`
// Before this fix, `test list --cursor <token>` would emit
// "error: unknown option '--cursor'" (exit 5 via Commander error handling)
// because `test list` only had `--starting-token`.
describe('createTestCommand list — --cursor alias', () => {
  it('--cursor is accepted by `test list` without "unknown option" error', async () => {
    // This test exercises the Commander-level wiring, which is where the
    // --cursor → startingToken merge happens (in the .action() handler).
    // `runList` itself has no `cursor` field — the alias is resolved before
    // `runList` is called.
    const { credentialsPath } = makeCreds();
    const seenCursors: Array<string | null> = [];
    const fetchImpl = makeFetch(url => {
      const match = /cursor=([^&]+)/.exec(url);
      seenCursors.push(match ? decodeURIComponent(match[1]!) : null);
      return { body: { items: [FE_TEST], nextToken: null } };
    });
    const deps: TestDeps = { credentialsPath, fetchImpl, stdout: () => undefined };
    const test = createTestCommand(deps);
    // Commander's .parseAsync with 'user' source parses bare tokens
    // and flags relative to the command. --project is required.
    await test.parseAsync(
      ['list', '--project', 'project_alice', '--cursor', 'cursor-alias-token'],
      {
        from: 'user',
      },
    );
    expect(seenCursors[0]).toBe('cursor-alias-token');
  });

  it('--starting-token takes precedence over --cursor when both are supplied', async () => {
    const { credentialsPath } = makeCreds();
    const seenCursors: Array<string | null> = [];
    const fetchImpl = makeFetch(url => {
      const match = /cursor=([^&]+)/.exec(url);
      seenCursors.push(match ? decodeURIComponent(match[1]!) : null);
      return { body: { items: [FE_TEST], nextToken: null } };
    });
    const deps: TestDeps = { credentialsPath, fetchImpl, stdout: () => undefined };
    const test = createTestCommand(deps);
    await test.parseAsync(
      [
        'list',
        '--project',
        'project_alice',
        '--starting-token',
        'primary-token',
        '--cursor',
        'alias-token',
      ],
      { from: 'user' },
    );
    expect(seenCursors[0]).toBe('primary-token');
  });
});

describe('createTestCommand list — required flag', () => {
  it('rejects when --project is missing with VALIDATION_ERROR (not commander)', async () => {
    const { credentialsPath } = makeCreds();
    const test = createTestCommand({ credentialsPath, env: {} as NodeJS.ProcessEnv });
    disableExits(test);
    // We deliberately removed `.requiredOption` so the local validator
    // (`requireProjectId`) runs and throws the typed envelope. Commander's
    // built-in "required option" error would surface as exit 1, breaking
    // the CLI error spec §2 contract that "missing required field"
    // is a `VALIDATION_ERROR` (exit 5).
    try {
      await test.parseAsync(['list'], { from: 'user' });
      expect.unreachable('expected ApiError');
    } catch (err) {
      const apiErr = err as {
        code?: string;
        exitCode?: number;
        details?: { field?: string; reason?: string };
      };
      expect(apiErr.code).toBe('VALIDATION_ERROR');
      expect(apiErr.exitCode).toBe(5);
      expect(apiErr.details?.field).toBe('project');
      expect(apiErr.details?.reason).toContain('TESTSPRITE_PROJECT_ID');
    }
  });
});

describe('runGet', () => {
  it('GETs /tests/{id} and prints the §6.2 fields in text mode', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: FE_TEST };
    });
    const out: string[] = [];
    const test = await runGet(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(seen[0]).toContain('/tests/test_fe');
    expect(test.id).toBe('test_fe');
    const block = out.join('\n');
    expect(block).toContain('id:          test_fe');
    expect(block).toContain('projectId:   project_alice');
    expect(block).toContain('slug:        CHECKOUT-001');
    expect(block).toContain('title:       Checkout happy path');
    expect(block).toContain('version:     v1.2');
    expect(block).toContain('steps:       8');
    expect(block).not.toContain('status:');
  });

  describe('steps rendering tolerates malformed wire elements', () => {
    const cases: Array<{ name: string; steps: unknown[]; renderedSteps: string[] }> = [
      { name: 'null', steps: [null], renderedSteps: [] },
      { name: 'number', steps: [42], renderedSteps: [] },
      { name: 'empty object', steps: [{}], renderedSteps: ['  1. [step] (no description)'] },
      {
        name: 'type only',
        steps: [{ type: 'action' }],
        renderedSteps: ['  1. [action] (no description)'],
      },
      {
        name: 'description only',
        steps: [{ description: 'x' }],
        renderedSteps: ['  1. [step] x'],
      },
      {
        name: 'well-formed pair',
        steps: [
          { type: 'action', description: 'Open the checkout page' },
          { type: 'assertion', description: 'Confirm the order total is visible' },
        ],
        renderedSteps: [
          '  1. [action] Open the checkout page',
          '  2. [assertion] Confirm the order total is visible',
        ],
      },
    ];

    it.each(cases)('$name renders text exactly and preserves JSON verbatim', async testCase => {
      const wireTest = {
        ...FE_TEST,
        stepCount: testCase.steps.length,
        steps: testCase.steps,
      };
      const { credentialsPath } = makeCreds();
      const fetchImpl = makeFetch(() => ({ body: wireTest }));
      const jsonOut: string[] = [];
      const textOut: string[] = [];

      const jsonResult = await runGet(
        { profile: 'default', output: 'json', debug: false, testId: 'test_fe' },
        { credentialsPath, fetchImpl, stdout: line => jsonOut.push(line) },
      );
      await runGet(
        { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
        { credentialsPath, fetchImpl, stdout: line => textOut.push(line) },
      );

      expect(jsonResult.steps).toEqual(testCase.steps);
      expect(JSON.parse(jsonOut.join('\n')).steps).toEqual(testCase.steps);
      expect(textOut.join('\n')).toBe(
        [
          'id:          test_fe',
          'projectId:   project_alice',
          'slug:        CHECKOUT-001',
          'title:       Checkout happy path',
          'type:        frontend',
          'category:    Checkout',
          'priority:    High',
          'version:     v1.2',
          `steps:       ${testCase.steps.length}`,
          ...testCase.renderedSteps,
          'createdAt:   2026-04-20T11:00:00.000Z',
          'updatedAt:   2026-05-05T12:34:56.000Z',
        ].join('\n'),
      );
    });
  });

  it('renders the per-test step timeout when the facade ships a number', async () => {
    const withStepTimeout: CliTest = { ...FE_TEST, stepTimeoutMs: 45_000 };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: withStepTimeout }));
    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(out.join('\n')).toContain('stepTimeout: 45000 ms (applies to every step)');
  });

  it.each([undefined])(
    'omits the step-timeout line when stepTimeoutMs is %s',
    async stepTimeoutMs => {
      const withoutStepTimeout: CliTest = { ...FE_TEST, stepTimeoutMs };
      const { credentialsPath } = makeCreds();
      const fetchImpl = makeFetch(() => ({ body: withoutStepTimeout }));
      const out: string[] = [];
      await runGet(
        { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
        { credentialsPath, fetchImpl, stdout: line => out.push(line) },
      );
      expect(out.join('\n')).not.toContain('stepTimeout:');
    },
  );

  it('renders produces/consumes/category when the facade ships them', async () => {
    const withDeps: CliTest = {
      ...FE_TEST,
      produces: ['user_id', 'order_id'],
      consumes: ['session_token'],
      category: 'teardown',
    };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: withDeps }));
    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    expect(block).toContain('produces:    user_id, order_id');
    expect(block).toContain('consumes:    session_token');
    expect(block).toContain('category:    teardown');
  });

  it('omits produces/consumes/category lines when absent', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { ...FE_TEST, category: null } }));
    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    expect(block).not.toContain('produces:');
    expect(block).not.toContain('consumes:');
    expect(block).not.toContain('category:');
  });

  it('NOT_FOUND envelope from server propagates as ApiError exit 4', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 404,
      body: {
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found.',
          nextAction: 'Check the id with `testsprite test list --project <id>`.',
          requestId: 'req_test',
          details: { resource: 'test', id: 'test_missing' },
        },
      },
    }));
    await expect(
      runGet(
        { profile: 'default', output: 'json', debug: false, testId: 'test_missing' },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', exitCode: 4 });
  });

  it('URL-encodes test ids with `/` or `?` in them', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: FE_TEST };
    });
    await runGet(
      { profile: 'default', output: 'json', debug: false, testId: 'odd/id?weird' },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    expect(seen[0]).toContain('odd%2Fid%3Fweird');
  });

  it('M2.1 piece 4: renders project: <name> (<id>) when projectName is set', async () => {
    const TEST_WITH_PROJECT_NAME: CliTest = {
      ...FE_TEST,
      projectId: 'project_alice',
      projectName: 'Checkout',
    };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: TEST_WITH_PROJECT_NAME }));
    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    expect(block).toContain('project:     Checkout (project_alice)');
    // Pre-M2.1 line that just had projectId should not appear.
    expect(block).not.toContain('projectId:   project_alice');
  });

  it('M2.1 piece 4: falls back to projectId: <id> when projectName is null', async () => {
    const TEST_NO_PROJECT_NAME: CliTest = {
      ...FE_TEST,
      projectId: 'project_alice',
      projectName: null,
    };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: TEST_NO_PROJECT_NAME }));
    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(out.join('\n')).toContain('projectId:   project_alice');
  });

  // G1a — priority field surfacing
  it('G1a: renders priority: p1 line when backend ships priority', async () => {
    const withPriority: CliTest = { ...FE_TEST, priority: 'p1' };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: withPriority }));
    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(out.join('\n')).toContain('priority:    p1');
  });

  it('G1a: omits priority line when priority is null', async () => {
    const nullPriority: CliTest = { ...FE_TEST, priority: null };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: nullPriority }));
    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(out.join('\n')).not.toContain('priority:');
  });

  it('G1a: omits priority line when priority field is absent (pre-G1a backend)', async () => {
    // No priority field at all — matches the pre-G1a wire shape.
    const withoutPriority: Partial<CliTest> = { ...FE_TEST };
    delete withoutPriority.priority;
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: withoutPriority }));
    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(out.join('\n')).not.toContain('priority:');
  });

  it('G1a: priority is included in --output json pass-through', async () => {
    const withPriority: CliTest = { ...FE_TEST, priority: 'p0' };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: withPriority }));
    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'json', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const parsed = JSON.parse(out.join('')) as CliTest;
    expect(parsed.priority).toBe('p0');
  });
});

describe('writeBatchJUnitReportIfRequested — run timing', () => {
  it.each([
    { startedAt: null, createdAt: '2026-08-17T10:00:00.000Z', time: '12.5' },
    {
      startedAt: '2026-08-17T10:00:05.000Z',
      createdAt: '2026-08-17T10:00:00.000Z',
      time: '7.5',
    },
    { startedAt: null, createdAt: undefined, time: '0' },
  ])('renders testcase and suite time=$time from the run timestamps', async timing => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-junit-timing-'));
    const file = join(dir, 'report.xml');
    await writeBatchJUnitReportIfRequested(
      { report: 'junit', reportFile: file, projectId: 'project_alice' },
      [{ testId: 't1', status: 'passed', ...timing, finishedAt: '2026-08-17T10:00:12.500Z' }],
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads the JUnit report this test wrote to its own temp dir, never user input
    const xml = readFileSync(file, 'utf8');
    expect(xml).toContain(`skipped="0" time="${timing.time}">`);
    expect(xml).toContain(`testId="t1" time="${timing.time}">`);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('writeBatchJUnitReportIfRequested — testcase name precedence', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ts-junit-'));
  });

  const nameInReport = async (
    row: { testId: string; status: string; name?: string; testTitle?: string | null },
    nameMap?: ReadonlyMap<string, string>,
  ): Promise<string> => {
    const file = join(dir, 'report.xml');
    await writeBatchJUnitReportIfRequested(
      { report: 'junit', reportFile: file, projectId: 'project_alice' },
      [row] as never,
      nameMap,
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- report path is join(dir, ...) inside this test's own mkdtempSync temp dir, never user input.
    const xml = readFileSync(file, 'utf8');
    const m = /<testcase[^>]*\bname="([^"]*)"/.exec(xml);
    return m?.[1] ?? '';
  };

  it('sweep map wins over testTitle and the row name', async () => {
    const name = await nameInReport(
      { testId: 't1', status: 'passed', name: 'row-name', testTitle: 'poll-title' },
      new Map([['t1', 'sweep-name']]),
    );
    expect(name).toBe('sweep-name');
  });

  it('falls back to testTitle when the sweep map misses (same source as the summary table)', async () => {
    const name = await nameInReport(
      { testId: 't1', status: 'passed', name: 'row-name', testTitle: 'poll-title' },
      new Map(), // sweep over-paged / timed out → empty
    );
    expect(name).toBe('poll-title');
  });

  it('a blank testTitle does not shadow the row name', async () => {
    const name = await nameInReport(
      { testId: 't1', status: 'passed', name: 'row-name', testTitle: '   ' },
      new Map(),
    );
    expect(name).toBe('row-name');
  });
});

// ---------------------------------------------------------------------------
// M4 piece-2 — BE dependency authoring: --produces/--needs/--category
// ---------------------------------------------------------------------------

describe('native launch dashboard links', () => {
  it.each([false, true])('prints only the server dashboard link for single=%s', async single => {
    const link = 'https://portal.example.com/custom/run';
    const h = projectHarness({ launch: projectRun({ dashboardUrl: link }) });
    if (single)
      await runTestRun(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_xyz',
          wait: false,
          timeoutSeconds: 60,
        },
        h.deps,
      );
    else
      await runTestRunAll(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          projectId: 'project_1',
          wait: false,
          timeoutSeconds: 60,
          maxConcurrency: 5,
        },
        h.deps,
      );
    expect(h.stdout.join('\n').split('\n')).toEqual([
      'Run exec_abc  https://example.com  (1 test)',
      `  Dashboard: ${link}`,
      'testsprite run wait exec_abc',
    ]);
  });
  it.each([undefined])('does not manufacture an absent dashboard=%s', async dashboardUrl => {
    const h = projectHarness({ launch: projectRun({ dashboardUrl }) });
    await runTestRun(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_xyz',
        wait: false,
        timeoutSeconds: 60,
      },
      h.deps,
    );
    expect(h.stdout.join('\n')).not.toMatch(/dashboard/i);
    expect(h.stdout.join('\n')).not.toContain('undefined');
  });
  it('keeps the server link inside the native run receipt in JSON', async () => {
    const h = projectHarness({
      launch: projectRun({ dashboardUrl: 'https://portal.example/run' }),
    });
    await runTestRun(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_xyz',
        wait: false,
        timeoutSeconds: 60,
      },
      h.deps,
    );
    expect(JSON.parse(h.stdout.join('\n'))).toMatchObject({
      runs: [{ runId: 'exec_abc', dashboardUrl: 'https://portal.example/run' }],
    });
  });
});

// ---------------------------------------------------------------------------
// `test list` on an EMPTY project is the moment a new user without a
// coding agent discovers there is nothing to run. Text mode adds one [hint] on
// stderr (stdout stays exactly "No tests." for pipes). A filtered-out page or a
// page with a cursor is not an empty project, and JSON callers get nothing.
// ---------------------------------------------------------------------------
describe("`test list` on an empty project points at the project's agent", () => {
  it('text mode, no filters, no cursor: stdout stays "No tests." and stderr gets one [hint] with the project id', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { items: [], nextToken: null } }));
    const out: string[] = [];
    const stderrLines: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_alice',
        pageSize: 25,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => out.push(line),
        stderr: l => stderrLines.push(l),
      },
    );
    expect(out.join('\n')).toBe('No tests.');
    const hint = stderrLines.find(l => l.startsWith('[hint]'));
    expect(hint).toBeDefined();
    // `test list` cannot tell the type without another request, so the
    // backend API spec is named as a clause.
    expect(hint).toContain('testsprite plan --project project_alice, then testsprite apply');
    expect(hint).toContain('attach its API spec with --file <spec>');
  });

  it('json mode: no hint', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { items: [], nextToken: null } }));
    const stderrLines: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_alice',
        pageSize: 25,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: l => stderrLines.push(l) },
    );
    expect(stderrLines.some(l => l.startsWith('[hint]'))).toBe(false);
  });

  it('a --type filter that returns nothing is not an empty project: no hint', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { items: [], nextToken: null } }));
    const stderrLines: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_alice',
        pageSize: 25,
        type: 'backend',
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: l => stderrLines.push(l) },
    );
    expect(stderrLines.some(l => l.startsWith('[hint]'))).toBe(false);
  });

  it('an empty page with a cursor is not an empty project: no hint', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { items: [], nextToken: 'still-more' } }));
    const stderrLines: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_alice',
        pageSize: 25,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: l => stderrLines.push(l) },
    );
    expect(stderrLines.some(l => l.startsWith('[hint]'))).toBe(false);
  });
});
