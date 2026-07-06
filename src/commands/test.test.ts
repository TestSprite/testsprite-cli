import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { ApiError } from '../lib/errors.js';
import { GLOBAL_OPTS_HINT } from '../lib/output.js';
import {
  type CliFailureContext,
  type CliLatestResult,
  type CliTest,
  type CliTestCode,
  type CliTestStep,
  type TestDeps,
  createTestCommand,
  isPresignedCodeUrl,
  runCodeGet,
  runCodePut,
  runCreate,
  runCreateBatch,
  runCreateFromPlan,
  runDelete,
  runDiff,
  runFailureGet,
  runFailureSummary,
  runGet,
  runLint,
  runList,
  runPlanPut,
  runResult,
  runSteps,
  runUpdate,
} from './test.js';

function disableExits(cmd: Command): void {
  cmd.exitOverride();
  cmd.commands.forEach(disableExits);
}

const FE_TEST: CliTest = {
  id: 'test_fe',
  projectId: 'project_alice',
  name: 'Checkout happy path',
  type: 'frontend',
  createdFrom: 'portal',
  status: 'failed',
  createdAt: '2026-04-20T11:00:00.000Z',
  updatedAt: '2026-05-05T12:34:56.000Z',
};

const BE_TEST: CliTest = {
  id: 'test_be',
  projectId: 'project_alice',
  name: 'Smoke — health check',
  type: 'backend',
  createdFrom: 'mcp',
  status: 'passed',
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
    expect(names).toEqual([
      'artifact',
      'code',
      'create',
      'create-batch',
      'delete',
      'delete-batch',
      'diff',
      'failure',
      'flaky',
      'get',
      'lint',
      'list',
      'plan',
      'rerun',
      'result',
      'run',
      'steps',
      'update',
      'wait',
    ]);
  });

  it('exposes the expected `code` subcommands', () => {
    const test = createTestCommand();
    const code = test.commands.find(c => c.name() === 'code');
    expect(code).toBeDefined();
    expect(code!.commands.map(c => c.name()).sort()).toEqual(['get', 'put']);
  });

  it('exposes the expected `failure` subcommands', () => {
    const test = createTestCommand();
    const failure = test.commands.find(c => c.name() === 'failure');
    expect(failure).toBeDefined();
    // M2.1 piece 3 adds `summary`. `get` is the bundle entry point;
    // `summary` is the lightweight analysis-only triage card.
    expect(failure!.commands.map(c => c.name()).sort()).toEqual(['get', 'summary']);
  });

  it('list exposes the documented filter and pagination flags (including --cursor alias)', () => {
    const test = createTestCommand();
    const list = test.commands.find(c => c.name() === 'list')!;
    const flagNames = list.options.map(o => o.long);
    expect(flagNames).toEqual(
      expect.arrayContaining([
        '--project',
        '--type',
        '--created-from',
        '--page-size',
        '--starting-token',
        '--cursor',
        '--max-items',
      ]),
    );
  });

  it('failure get exposes --out and --failed-only flags (P5)', () => {
    // P5 implements `failure get`. The only flags are --out (atomic on-disk
    // bundle) and --failed-only (§7.4 narrow-budget filter). Pinning the
    // surface so a future "consolidate flags" sweep doesn't drop them.
    const test = createTestCommand();
    const failure = test.commands.find(c => c.name() === 'failure')!;
    const failureGet = failure.commands.find(c => c.name() === 'get')!;
    const flagNames = failureGet.options.map(o => o.long).sort();
    expect(flagNames).toEqual(['--failed-only', '--out']);
  });

  it('steps exposes pagination flags', () => {
    const test = createTestCommand();
    const steps = test.commands.find(c => c.name() === 'steps');
    expect(steps).toBeDefined();
    const flagNames = steps!.options.map(o => o.long);
    expect(flagNames).toEqual(
      expect.arrayContaining(['--page-size', '--max-items', '--starting-token']),
    );
  });

  it('result exposes --include-analysis (M2.1) + M3.4 piece-5 --history flags', () => {
    // M2.1 piece 3 adds `--include-analysis` to `test result`.
    // M3.4 piece 5 adds `--history`, `--source`, `--since`, `--page-size`, `--cursor`.
    // Pinning the surface so a future flag-consolidation sweep keeps every
    // option intentional. Back-compat: bare `test result <id>` (no --history)
    // still calls runResult and returns the M2 CliLatestResult shape.
    const test = createTestCommand();
    const result = test.commands.find(c => c.name() === 'result');
    const flagNames = result!.options.map(o => o.long);
    expect(flagNames).toEqual([
      '--include-analysis',
      '--history',
      '--source',
      '--since',
      '--page-size',
      '--cursor',
    ]);
  });

  it('code get exposes --out as its only option', () => {
    // `--out` lets agents write the response to a file without a shell
    // redirect (matters on Windows + when the wire shape carries a
    // presigned URL we want to stream straight to disk). Pinning it
    // here so a future "remove redundant flag" sweep doesn't take it.
    const test = createTestCommand();
    const code = test.commands.find(c => c.name() === 'code');
    const codeGet = code!.commands.find(c => c.name() === 'get');
    const flagNames = codeGet!.options.map(o => o.long);
    expect(flagNames).toEqual(['--out']);
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

  it('M3.3: test run --help includes GLOBAL_OPTS_HINT', () => {
    const test = createTestCommand();
    const run = test.commands.find(c => c.name() === 'run')!;
    const help = captureHelp(run);
    expect(help).toContain('testsprite --help');
    expect(help).toContain('--dry-run');
  });

  it('M3.3: test wait --help includes GLOBAL_OPTS_HINT', () => {
    const test = createTestCommand();
    const wait = test.commands.find(c => c.name() === 'wait')!;
    const help = captureHelp(wait);
    expect(help).toContain('testsprite --help');
    expect(help).toContain('--dry-run');
  });

  it('M3.3: test artifact get --help includes GLOBAL_OPTS_HINT', () => {
    const test = createTestCommand();
    const artifact = test.commands.find(c => c.name() === 'artifact')!;
    const artifactGet = artifact.commands.find(c => c.name() === 'get')!;
    const help = captureHelp(artifactGet);
    expect(help).toContain('testsprite --help');
    expect(help).toContain('--dry-run');
  });

  it('M3.3: test failure get --help includes GLOBAL_OPTS_HINT', () => {
    const test = createTestCommand();
    const failure = test.commands.find(c => c.name() === 'failure')!;
    const failureGet = failure.commands.find(c => c.name() === 'get')!;
    const help = captureHelp(failureGet);
    expect(help).toContain('testsprite --help');
    expect(help).toContain('--dry-run');
  });

  it('M3.3: test failure summary --help includes GLOBAL_OPTS_HINT', () => {
    const test = createTestCommand();
    const failure = test.commands.find(c => c.name() === 'failure')!;
    const failureSummary = failure.commands.find(c => c.name() === 'summary')!;
    const help = captureHelp(failureSummary);
    expect(help).toContain('testsprite --help');
    expect(help).toContain('--dry-run');
  });

  it('M2 sweep: all remaining leaf subcommands include GLOBAL_OPTS_HINT', () => {
    // Covers list, get, create, create-batch, steps, result, update, delete,
    // code get, code put, plan put — the full M2 surface that the dogfood
    // entry (2026-05-13) flagged and fix/cli-dogfood-bundle-2026-05-16 fixed.
    const test = createTestCommand();

    // Flat leaf commands (direct children of `test`)
    const flatLeaves = [
      'list',
      'get',
      'create',
      'create-batch',
      'steps',
      'result',
      'update',
      'delete',
    ];
    for (const name of flatLeaves) {
      const cmd = test.commands.find(c => c.name() === name)!;
      expect(cmd, `test ${name} must exist`).toBeDefined();
      const help = captureHelp(cmd);
      expect(help, `test ${name} --help must include GLOBAL_OPTS_HINT`).toContain(GLOBAL_OPTS_HINT);
    }

    // Nested: test code get, test code put
    const code = test.commands.find(c => c.name() === 'code')!;
    for (const name of ['get', 'put']) {
      const cmd = code.commands.find(c => c.name() === name)!;
      const help = captureHelp(cmd);
      expect(help, `test code ${name} --help must include GLOBAL_OPTS_HINT`).toContain(
        GLOBAL_OPTS_HINT,
      );
    }

    // Nested: test plan put
    const plan = test.commands.find(c => c.name() === 'plan')!;
    const planPut = plan.commands.find(c => c.name() === 'put')!;
    const planHelp = captureHelp(planPut);
    expect(planHelp, 'test plan put --help must include GLOBAL_OPTS_HINT').toContain(
      GLOBAL_OPTS_HINT,
    );
  });
});

describe('runList', () => {
  it('passes projectId, type, and createdFrom to the facade query string', async () => {
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
        createdFrom: 'portal',
      },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    expect(seen[0]).toContain('projectId=project_alice');
    expect(seen[0]).toContain('type=frontend');
    expect(seen[0]).toContain('createdFrom=portal');
  });

  it('accepts --created-from cli and passes createdFrom=cli to the wire (dogfood 2026-06-04)', async () => {
    // End-to-end through parseEnumFlag: backend now stamps createFrom='cli'
    // on `testsprite test create` rows, so the filter must accept 'cli'.
    // If parseEnumFlag rejected it, this would throw VALIDATION_ERROR before
    // any fetch and `seen` would stay empty.
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: { items: [], nextToken: null } };
    });
    const test = createTestCommand({ credentialsPath, fetchImpl, stdout: () => undefined });
    await test.parseAsync(['list', '--project', 'project_alice', '--created-from', 'cli'], {
      from: 'user',
    });
    expect(seen[0]).toContain('createdFrom=cli');
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

  it('rejects --created-from=junk locally with VALIDATION_ERROR', async () => {
    const test = createTestCommand();
    disableExits(test);
    await expect(
      test.parseAsync(['list', '--project', 'project_alice', '--created-from', 'junk'], {
        from: 'user',
      }),
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

  it('rejects invalid --status before requiring credentials', async () => {
    const credentialsPath = join(mkdtempSync(join(tmpdir(), 'cli-list-status-')), 'credentials');
    const fetchImpl = vi.fn();

    await expect(
      runList(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_alice',
          status: 'notastatus',
        },
        {
          credentialsPath,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          stdout: () => undefined,
        },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: { field: 'status' },
    });

    expect(fetchImpl).not.toHaveBeenCalled();
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

  it('text mode renders mixed FE/BE rows with header + status column', async () => {
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
    expect(block).toContain('ID');
    expect(block).toContain('NAME');
    expect(block).toContain('TYPE');
    expect(block).toContain('FROM');
    expect(block).toContain('STATUS');
    expect(block).toContain('UPDATED');
    expect(block).toContain('Checkout happy path');
    expect(block).toContain('Smoke — health check');
    // Both types render explicitly; the agent loop reads `type` directly
    // from JSON, but humans glance at the column.
    expect(block).toContain('frontend');
    expect(block).toContain('backend');
    // Both createdFrom variants render — verifies the column doesn't
    // accidentally hardcode a value.
    expect(block).toContain('portal');
    expect(block).toContain('mcp');
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
    const test = createTestCommand();
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
      const apiErr = err as { code?: string; exitCode?: number; details?: { field?: string } };
      expect(apiErr.code).toBe('VALIDATION_ERROR');
      expect(apiErr.exitCode).toBe(5);
      expect(apiErr.details?.field).toBe('project');
    }
  });

  it('M2.1 piece 2: --status passes the comma-separated value to the wire', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: { items: [], nextToken: null } };
    });
    await runList(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_alice',
        status: 'failed,blocked',
      },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    // Server-side filter applied before pagination — the status query
    // param must reach the wire so a long-tail of 50+ tests doesn't
    // get fetched + filtered client-side.
    expect(seen[0]).toMatch(/[?&]status=failed%2Cblocked/);
  });

  it('M2.1 piece 2: --status rejects unknown tokens locally (exit 5, no fetch)', async () => {
    // Defense: a typo like `--status fail` shouldn't silently filter
    // to nothing. Fail fast client-side with the accepted set in
    // the error envelope.
    const { credentialsPath } = makeCreds();
    let fetched = false;
    const fetchImpl = makeFetch(() => {
      fetched = true;
      return { body: { items: [], nextToken: null } };
    });
    await expect(
      runList(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_alice',
          status: 'fail', // typo for `failed`
        },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(fetched).toBe(false);
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
    expect(block).toContain('status:      failed');
  });

  it('renders a `blocked` test row (M2.1 piece 1 — distinct from failed)', async () => {
    // Regression for the M2.1 contract flip: pre-M2.1 the wire shape
    // would have arrived as `status: failed` for the same source row.
    // The text renderer must surface `blocked` byte-for-byte without
    // collapsing it back to the legacy bucket. Also asserts the
    // structured `details` parsed cleanly through the JSON envelope.
    const blockedTest: CliTest = {
      ...FE_TEST,
      id: 'test_blocked',
      status: 'blocked',
      details: {
        processingStatus: 'Idle',
        testStatus: 'Blocked',
        rawStatus: 'ps=Idle; ts=Blocked',
      },
    };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: blockedTest }));
    const out: string[] = [];
    const test = await runGet(
      { profile: 'default', output: 'text', debug: false, testId: 'test_blocked' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(test.status).toBe('blocked');
    expect(test.details).toEqual({
      processingStatus: 'Idle',
      testStatus: 'Blocked',
      rawStatus: 'ps=Idle; ts=Blocked',
    });
    expect(out.join('\n')).toContain('status:      blocked');
  });

  it('renders the planSteps count when the facade ships planStepCount (M3.4)', async () => {
    const withPlan: CliTest = { ...FE_TEST, planStepCount: 3 };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: withPlan }));
    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(out.join('\n')).toContain('planSteps:   3');
  });

  it('omits the planSteps line when planStepCount is null or absent (M3.4)', async () => {
    const noPlan: CliTest = { ...FE_TEST, planStepCount: null };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: noPlan }));
    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(out.join('\n')).not.toContain('planSteps:');
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
    // FE_TEST has no priority field — matches pre-G1a wire shape
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: FE_TEST }));
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

// ---------- P4: code / steps / result ----------

const TEST_CODE_INLINE: CliTestCode = {
  testId: 'test_fe',
  language: 'typescript',
  framework: 'playwright',
  code: [
    "import { test, expect } from '@playwright/test';",
    "test('checkout', async ({ page }) => {",
    '  await page.goto(process.env.TARGET_URL!);',
    '});',
    '',
  ].join('\n'),
  codeVersion: 'v3',
  etag: 'sha256:abc',
};

const TEST_CODE_PRESIGNED: CliTestCode = {
  testId: 'test_large',
  language: 'typescript',
  framework: 'playwright',
  code: 'https://s3-presigned.example.com/codes/test_large?X-Amz-fixture',
  codeVersion: 'v1',
  etag: null,
};

const STEP_PASSED: CliTestStep = {
  testId: 'test_fe',
  stepIndex: 4,
  action: 'click',
  description: 'Click the cart icon',
  status: 'passed',
  screenshotUrl: 'https://s3-presigned.example.com/snap/04.png?X',
  htmlSnapshotUrl: 'https://s3-presigned.example.com/snap/04.html?X',
  runIdIfAvailable: 'run_abc',
  codeVersion: 'v3',
  capturedAt: '2026-05-05T12:34:55.000Z',
  updatedAt: '2026-05-05T12:34:56.000Z',
};

const STEP_FAILED: CliTestStep = {
  ...STEP_PASSED,
  stepIndex: 5,
  action: 'click',
  description: 'Click the submit button',
  status: 'failed',
  screenshotUrl: 'https://s3-presigned.example.com/snap/05.png?X',
  htmlSnapshotUrl: 'https://s3-presigned.example.com/snap/05.html?X',
  capturedAt: '2026-05-05T12:34:56.000Z',
};

const STEP_PENDING: CliTestStep = {
  ...STEP_PASSED,
  stepIndex: 6,
  action: 'expect',
  description: 'Expect order confirmation heading',
  status: null,
  screenshotUrl: null,
  htmlSnapshotUrl: null,
  capturedAt: null,
  updatedAt: '2026-05-05T12:34:58.000Z',
};

const RESULT_FAILED: CliLatestResult = {
  testId: 'test_fe',
  status: 'failed',
  startedAt: '2026-05-05T12:34:00.000Z',
  finishedAt: '2026-05-05T12:34:58.000Z',
  videoUrl: 'https://s3-presigned.example.com/video/run_abc.mp4?X',
  failureAnalysisUrl: 'https://s3-presigned.example.com/analysis/run_abc.json?X',
  snapshotId: 'snap_2026_05_05_b2f9a1c8',
  runIdIfAvailable: 'run_abc',
  codeVersion: 'v3',
  targetUrl: 'https://staging.example.com/checkout',
  failedStepIndex: 5,
  failureKind: 'assertion',
  verdict: 'failed',
  executionStatus: 'completed',
  summary: 'Failed (assertion) on step 5: expected order confirmation heading to be visible.',
};

const RESULT_PASSED: CliLatestResult = {
  testId: 'test_passed',
  status: 'passed',
  startedAt: '2026-05-05T07:59:30.000Z',
  finishedAt: '2026-05-05T08:00:12.000Z',
  videoUrl: 'https://s3-presigned.example.com/video/run_xyz.mp4?X',
  failureAnalysisUrl: null,
  snapshotId: 'snap_2026_05_05_e1b9c2a4',
  runIdIfAvailable: 'run_xyz',
  codeVersion: 'v2',
  targetUrl: 'https://staging.example.com/checkout',
  failedStepIndex: null,
  failureKind: null,
  verdict: 'passed',
  executionStatus: 'completed',
  summary: 'Test passed.',
};

describe('isPresignedCodeUrl', () => {
  it('treats https:// as presigned and source-looking strings as inline', () => {
    expect(isPresignedCodeUrl('https://s3.example.com/x')).toBe(true);
    expect(isPresignedCodeUrl('http://insecure.example.com/x')).toBe(false);
    expect(isPresignedCodeUrl("import { test } from '@playwright/test';")).toBe(false);
    expect(isPresignedCodeUrl('')).toBe(false);
  });
});

describe('runCodeGet', () => {
  it('JSON mode prints the §6.3 wire shape verbatim and skips the URL fetch', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: TEST_CODE_INLINE };
    });
    const out: string[] = [];
    const got = await runCodeGet(
      { profile: 'default', output: 'json', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('/tests/test_fe/code');
    expect(got).toEqual(TEST_CODE_INLINE);
    expect(JSON.parse(out[0]!)).toEqual(TEST_CODE_INLINE);
  });

  it('text mode prints the inline source body byte-exact via rawStdout', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: TEST_CODE_INLINE }));
    const chunks: string[] = [];
    await runCodeGet(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      {
        credentialsPath,
        fetchImpl,
        rawStdout: chunk => {
          chunks.push(chunk);
        },
      },
    );
    // §12.7: text is human-only; JSON consumers see the wire shape.
    // The CLI writes the source byte-exactly so `> file.ts` piping
    // produces a runnable file; no implicit newline coercion.
    expect(chunks.join('')).toBe(TEST_CODE_INLINE.code);
    // The source must not be wrapped in JSON braces in text mode.
    expect(chunks.join('').startsWith('{')).toBe(false);
  });

  it('text mode streams a presigned URL chunk-wise with no API key header', async () => {
    const { credentialsPath } = makeCreds();
    const seenHeaders: Array<RequestInit['headers']> = [];
    const STREAMED_CHUNKS = [
      "import { test } from '@playwright/test';\n",
      "test('huge', async ({ page }) => {\n",
      '  /* very long file */\n',
      '});\n',
    ];
    const fetchImpl = ((input: Parameters<typeof globalThis.fetch>[0], init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;
      if (url.includes('/tests/')) {
        return Promise.resolve(
          new Response(JSON.stringify(TEST_CODE_PRESIGNED), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      // Presigned URL fetch — capture headers to assert no API key leak,
      // and serve a multi-chunk stream so the streaming branch is
      // actually exercised (not just response.text()).
      seenHeaders.push(init.headers ?? {});
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of STREAMED_CHUNKS) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } }),
      );
    }) as typeof globalThis.fetch;
    const chunks: string[] = [];
    await runCodeGet(
      { profile: 'default', output: 'text', debug: false, testId: 'test_large' },
      {
        credentialsPath,
        fetchImpl,
        rawStdout: chunk => {
          chunks.push(chunk);
        },
      },
    );
    // Bytes must arrive intact end-to-end and chunked rather than as
    // one buffered blob — proves we're streaming, not response.text().
    expect(chunks.join('')).toBe(STREAMED_CHUNKS.join(''));
    expect(chunks.length).toBeGreaterThanOrEqual(STREAMED_CHUNKS.length);
    // Presigned URL fetches must NOT include an x-api-key header. The
    // URL itself is the bearer of authority.
    for (const headers of seenHeaders) {
      const h = new Headers(headers);
      expect(h.get('x-api-key')).toBeNull();
    }
  });

  it('wraps a fetchImpl rejection on the presigned URL as TransportError (exit 10)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;
      if (url.includes('/tests/')) {
        return Promise.resolve(
          new Response(JSON.stringify(TEST_CODE_PRESIGNED), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      // Simulate a DNS / TLS reset — the kind of failure that bypasses
      // HttpClient retry budget because the presigned URL is fetched
      // directly. the CLI error spec §7 says this must surface as
      // UNAVAILABLE / exit 10, never as Commander's exit 1.
      return Promise.reject(new Error('ENETUNREACH dns lookup failed'));
    }) as typeof globalThis.fetch;
    await expect(
      runCodeGet(
        { profile: 'default', output: 'text', debug: false, testId: 'test_large' },
        { credentialsPath, fetchImpl, rawStdout: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      exitCode: 10,
      message: expect.stringContaining('ENETUNREACH'),
    });
  });

  it('streaming loop awaits rawStdout drain on each chunk (backpressure)', async () => {
    // Pins that runCodeGet's streaming loop awaits each writeChunk
    // before reading the next stream value. The fine-grained "exact
    // pull count under backpressure" is pinned by Output.writeChunk's
    // own unit test in output.test.ts (WHATWG streams have an
    // implementation-defined chunk-lookahead window, so asserting
    // exact pull counts here would couple this test to runtime
    // internals).
    const { credentialsPath } = makeCreds();
    type Resolver = () => void;
    const writeOrder: string[] = [];
    const pendingState: { resolve: Resolver | null } = { resolve: null };
    const fetchImpl = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;
      if (url.includes('/tests/')) {
        return Promise.resolve(
          new Response(JSON.stringify(TEST_CODE_PRESIGNED), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('A'));
          controller.enqueue(encoder.encode('B'));
          controller.enqueue(encoder.encode('C'));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } }),
      );
    }) as typeof globalThis.fetch;
    const rawStdout = (text: string): Promise<void> =>
      new Promise<void>(resolve => {
        writeOrder.push(`enter:${text}`);
        // Resolve previous, then queue this resolver — proves the
        // loop didn't fire writeChunk(B) until A's drain settled.
        const prev = pendingState.resolve;
        pendingState.resolve = () => {
          writeOrder.push(`drain:${text}`);
          resolve();
        };
        if (prev) prev();
      });
    const runPromise = runCodeGet(
      { profile: 'default', output: 'text', debug: false, testId: 'test_large' },
      { credentialsPath, fetchImpl, rawStdout },
    );
    // Drive the chain: each enter must be preceded by the previous drain.
    while (!writeOrder.includes('drain:C')) {
      await new Promise(r => setImmediate(r));
      const next = pendingState.resolve;
      if (next !== null) {
        pendingState.resolve = null;
        next();
      }
    }
    await runPromise;
    // Exactly one enter per chunk, drains interleave with subsequent
    // enters, never two enters in a row without the prior drain.
    expect(writeOrder.filter(s => s.startsWith('enter:'))).toEqual([
      'enter:A',
      'enter:B',
      'enter:C',
    ]);
    for (let i = 0; i < writeOrder.length - 1; i += 1) {
      const cur = writeOrder[i]!;
      const next = writeOrder[i + 1]!;
      // No two `enter:` events back-to-back — the loop must drain in between.
      if (cur.startsWith('enter:') && next.startsWith('enter:')) {
        throw new Error(`back-to-back writeChunk without drain: ${cur} → ${next}`);
      }
    }
  });

  it('wraps a mid-stream read error as TransportError (exit 10)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;
      if (url.includes('/tests/')) {
        return Promise.resolve(
          new Response(JSON.stringify(TEST_CODE_PRESIGNED), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      // Use `pull` (not synchronous `start` enqueue+error) so the
      // first chunk is delivered to the consumer before the error
      // fires on the next pull. With sync enqueue+error, Node's
      // WHATWG stream tears down before the queued chunk is observable.
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(new TextEncoder().encode('first chunk OK\n'));
            return;
          }
          controller.error(new Error('ECONNRESET'));
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } }),
      );
    }) as typeof globalThis.fetch;
    const chunks: string[] = [];
    await expect(
      runCodeGet(
        { profile: 'default', output: 'text', debug: false, testId: 'test_large' },
        {
          credentialsPath,
          fetchImpl,
          rawStdout: chunk => {
            chunks.push(chunk);
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', exitCode: 10 });
    // The first chunk that arrived before the reset is fine to have
    // been written — agents that pipe to a file see a partial. The
    // non-zero exit tells them not to trust it.
    expect(chunks.join('')).toContain('first chunk OK');
  });

  it('JSON mode does not follow a presigned URL — caller decides', async () => {
    const { credentialsPath } = makeCreds();
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      return { body: TEST_CODE_PRESIGNED };
    });
    await runCodeGet(
      { profile: 'default', output: 'json', debug: false, testId: 'test_large' },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    // Exactly one network call: the §6.3 fetch. No presigned dereference.
    expect(calls).toBe(1);
  });

  it('CONFLICT envelope from /code maps to exit 6', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 409,
      body: {
        error: {
          code: 'CONFLICT',
          message: 'Snapshot in flight; retry shortly.',
          nextAction: 'retry shortly',
          requestId: 'req_test',
          details: { reason: 'snapshot_in_flight' },
        },
      },
    }));
    await expect(
      runCodeGet(
        { profile: 'default', output: 'json', debug: false, testId: 'test_fe' },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', exitCode: 6 });
  });

  it('translates a non-2xx presigned URL into an UNAVAILABLE ApiError', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;
      if (url.includes('/tests/')) {
        return Promise.resolve(
          new Response(JSON.stringify(TEST_CODE_PRESIGNED), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(
        new Response('expired', { status: 403, headers: { 'content-type': 'text/plain' } }),
      );
    }) as typeof globalThis.fetch;
    await expect(
      runCodeGet(
        { profile: 'default', output: 'text', debug: false, testId: 'test_large' },
        { credentialsPath, fetchImpl, rawStdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', exitCode: 10 });
  });

  // ---------- --out path: file sink instead of stdout ----------
  // The the CLI validation spec §4 P4 contract: "the CLI streams the body
  // to stdout (or `--out`) without buffering the whole thing in memory."
  // These tests pin the file-sink branch end-to-end: text mode writes
  // the source body, json mode writes the wire envelope, the presigned
  // streaming path pipes through to disk preserving chunk boundaries,
  // and validation errors land at the typed VALIDATION_ERROR envelope
  // (exit 5).

  it('--out (text mode) writes the inline body to a file instead of stdout', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: TEST_CODE_INLINE }));
    const dir = mkdtempSync(join(tmpdir(), 'cli-test-code-out-'));
    const target = join(dir, 'inline.ts');
    let stdoutCalls = 0;
    let rawStdoutCalls = 0;
    await runCodeGet(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_fe',
        out: target,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {
          stdoutCalls += 1;
        },
        rawStdout: () => {
          rawStdoutCalls += 1;
        },
      },
    );
    // File holds the byte-exact source body. No JSON braces.
    expect(readFileSync(target, 'utf-8')).toBe(TEST_CODE_INLINE.code);
    // Critical: stdout/rawStdout MUST NOT receive any of the body.
    // A regression where --out also wrote to stdout would corrupt the
    // process pipe in `testsprite ... > thing.zip` style invocations
    // and is the kind of silent-failure --out exists to avoid.
    expect(stdoutCalls).toBe(0);
    expect(rawStdoutCalls).toBe(0);
  });

  it('--out (json mode) writes the §6.3 envelope as a single JSON document', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: TEST_CODE_INLINE }));
    const dir = mkdtempSync(join(tmpdir(), 'cli-test-code-out-'));
    const target = join(dir, 'envelope.json');
    await runCodeGet(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_fe',
        out: target,
      },
      { credentialsPath, fetchImpl },
    );
    const onDisk = readFileSync(target, 'utf-8');
    expect(JSON.parse(onDisk)).toEqual(TEST_CODE_INLINE);
    // Wire-shape consumers piping `--out file.json | jq` should find
    // a trailing newline so jq's per-doc parser handles the file.
    expect(onDisk.endsWith('\n')).toBe(true);
  });

  it('--out streams a presigned URL straight into the file', async () => {
    const { credentialsPath } = makeCreds();
    const STREAMED_CHUNKS = [
      "import { test } from '@playwright/test';\n",
      "test('huge', async ({ page }) => {\n",
      '  /* very long file */\n',
      '});\n',
    ];
    const fetchImpl = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;
      if (url.includes('/tests/')) {
        return Promise.resolve(
          new Response(JSON.stringify(TEST_CODE_PRESIGNED), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const chunk of STREAMED_CHUNKS) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } }),
      );
    }) as typeof globalThis.fetch;
    const dir = mkdtempSync(join(tmpdir(), 'cli-test-code-out-'));
    const target = join(dir, 'large.ts');
    await runCodeGet(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_large',
        out: target,
      },
      { credentialsPath, fetchImpl },
    );
    expect(readFileSync(target, 'utf-8')).toBe(STREAMED_CHUNKS.join(''));
  });

  it('--out rejects an empty path with VALIDATION_ERROR (exit 5) before any network I/O', async () => {
    const { credentialsPath } = makeCreds();
    let fetchCalls = 0;
    const fetchImpl = (() => {
      fetchCalls += 1;
      return Promise.resolve(new Response('{}'));
    }) as typeof globalThis.fetch;
    await expect(
      runCodeGet(
        { profile: 'default', output: 'text', debug: false, testId: 'test_fe', out: '' },
        { credentialsPath, fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    // Failing fast matters: an early validation should not waste an
    // API call. If this assertion regresses, the user pays a network
    // round-trip + audit-log entry on every typo.
    expect(fetchCalls).toBe(0);
  });

  it('--out rejects a directory-style path with VALIDATION_ERROR (exit 5)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = (() => Promise.resolve(new Response('{}'))) as typeof globalThis.fetch;
    await expect(
      runCodeGet(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_fe',
          out: '/tmp/some-dir/',
        },
        { credentialsPath, fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('--out rejects an existing directory path with VALIDATION_ERROR (exit 5) before any network I/O', async () => {
    const { credentialsPath } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-test-code-out-dir-'));
    let fetchCalls = 0;
    const fetchImpl = (() => {
      fetchCalls += 1;
      return Promise.resolve(new Response('{}'));
    }) as typeof globalThis.fetch;

    await expect(
      runCodeGet(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_fe',
          out: dir,
        },
        { credentialsPath, fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(fetchCalls).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  // Regression: a parent dir that doesn't exist used to surface as exit 1
  // (TRANSPORT_ERROR) — `createWriteStream` opens lazily and ENOENT fires
  // mid-write. Synchronous parent stat keeps every `--out` user-input
  // shape on the same exit-5 contract as the rest of CLI v1 validation.
  it('--out rejects a path under a missing parent dir with VALIDATION_ERROR (exit 5)', async () => {
    const { credentialsPath } = makeCreds();
    let fetchCalls = 0;
    const fetchImpl = (() => {
      fetchCalls += 1;
      return Promise.resolve(new Response('{}'));
    }) as typeof globalThis.fetch;
    await expect(
      runCodeGet(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_fe',
          out: `/tmp/_p4_no_such_dir_${process.pid}_${Date.now()}/out.py`,
        },
        { credentialsPath, fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(fetchCalls).toBe(0);
  });

  it('--out rejects a path whose parent is a regular file with VALIDATION_ERROR (exit 5)', async () => {
    const { credentialsPath } = makeCreds();
    // Use this very test file as the "parent" — guaranteed to exist and
    // guaranteed not to be a directory. No fs writes; validator stats it.
    const here = new URL(import.meta.url).pathname;
    const fetchImpl = (() => Promise.resolve(new Response('{}'))) as typeof globalThis.fetch;
    await expect(
      runCodeGet(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_fe',
          out: `${here}/under-a-file.py`,
        },
        { credentialsPath, fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  // Regression: --out used to open (truncate) the destination file
  // before the network request. A failed fetch left a pre-existing
  // file emptied. The fix writes to a sibling temp file and renames it
  // into place only on success, so a failure must never touch the
  // operator's existing --out file.
  it('--out: a failed fetch leaves a pre-existing file untouched, not truncated', async () => {
    const { credentialsPath } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-test-code-out-fail-'));
    const target = join(dir, 'existing.ts');
    writeFileSync(target, 'PRE-EXISTING CONTENT', 'utf8');
    const fetchImpl = (() => Promise.reject(new Error('ENETUNREACH'))) as typeof globalThis.fetch;
    await expect(
      runCodeGet(
        { profile: 'default', output: 'text', debug: false, testId: 'test_fe', out: target },
        { credentialsPath, fetchImpl },
      ),
    ).rejects.toBeDefined();
    expect(readFileSync(target, 'utf-8')).toBe('PRE-EXISTING CONTENT');
    // No leftover temp file in the directory.
    const leftovers = readdirSync(dir).filter(f => f !== 'existing.ts');
    expect(leftovers).toEqual([]);
  });

  it('--out (text mode) rejects empty inline code with VALIDATION_ERROR and leaves no artifact', async () => {
    const { credentialsPath } = makeCreds();
    const emptyCode: CliTestCode = { ...TEST_CODE_INLINE, code: '' };
    const fetchImpl = makeFetch(() => ({ body: emptyCode }));
    const dir = mkdtempSync(join(tmpdir(), 'cli-test-code-empty-out-'));
    const target = join(dir, 'empty.ts');
    await expect(
      runCodeGet(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_fe',
          out: target,
        },
        { credentialsPath, fetchImpl },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: expect.objectContaining({ field: 'out' }),
    });
    expect(existsSync(target)).toBe(false);
  });

  // Regression: empty inline code with --out must reject (exit 5) without
  // truncating or replacing a pre-existing destination file.
  it('--out: "no code generated yet" leaves a pre-existing file untouched', async () => {
    const { credentialsPath } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-test-code-out-empty-'));
    const target = join(dir, 'existing.ts');
    writeFileSync(target, 'PRE-EXISTING CONTENT', 'utf8');
    const fetchImpl = makeFetch(() => ({ body: { ...TEST_CODE_INLINE, code: '' } }));
    await expect(
      runCodeGet(
        { profile: 'default', output: 'text', debug: false, testId: 'test_fe', out: target },
        { credentialsPath, fetchImpl, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: expect.objectContaining({ field: 'out' }),
    });
    expect(readFileSync(target, 'utf-8')).toBe('PRE-EXISTING CONTENT');
    const leftovers = readdirSync(dir).filter(f => f !== 'existing.ts');
    expect(leftovers).toEqual([]);
  });

  it('text mode without --out still hints on stderr when inline code is empty', async () => {
    const { credentialsPath } = makeCreds();
    const emptyCode: CliTestCode = { ...TEST_CODE_INLINE, code: '' };
    const fetchImpl = makeFetch(() => ({ body: emptyCode }));
    const stderr: string[] = [];
    const got = await runCodeGet(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stderr: line => stderr.push(line) },
    );
    expect(got.code).toBe('');
    expect(stderr.join('\n')).toContain('no code generated yet');
  });
});

describe('runCodePut', () => {
  function writeCodeFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-p4-'));
    const path = join(dir, 'updated.py');
    writeFileSync(path, contents, 'utf8');
    return path;
  }

  const SAMPLE_RESPONSE = {
    testId: 'test_alpha',
    codeVersion: 'v4',
    updatedAt: '2026-05-15T10:00:00.000Z',
  };

  it('PUTs /tests/{id}/code with body + If-Match: <expected-version> + idempotency-key', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('updated body');
    type Captured = { url: string; method: string; body: unknown; headers: Headers };
    const captured: Captured[] = [];
    const fetchImpl = makeFetch((url, init) => {
      captured.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body as string) : undefined,
        headers: new Headers(init.headers as Record<string, string>),
      });
      return { status: 200, body: SAMPLE_RESPONSE };
    });

    const res = await runCodePut(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        codeFile,
        expectedVersion: 'v3',
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );

    expect(res).toEqual(SAMPLE_RESPONSE);
    expect(captured).toHaveLength(1);
    const sent = captured[0]!;
    expect(sent.method).toBe('PUT');
    expect(sent.url).toContain('/api/cli/v1/tests/test_alpha/code');
    expect(sent.body).toEqual({ code: 'updated body' });
    expect(sent.headers.get('if-match')).toBe('v3');
    expect(sent.headers.get('idempotency-key')).toMatch(/^cli-code-put-[0-9a-f-]{36}$/);
    expect(sent.headers.get('content-type')).toBe('application/json');
  });

  it('strips a UTF-8 BOM from --code-file before uploading (Windows PowerShell 5.1 default)', async () => {
    const { credentialsPath } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-p4-bom-'));
    const codeFile = join(dir, 'updated.py');
    writeFileSync(codeFile, '\uFEFF' + 'updated body', 'utf8');
    let seenBody: unknown;
    const fetchImpl = makeFetch((_url, init) => {
      seenBody = init.body ? JSON.parse(init.body as string) : undefined;
      return { body: SAMPLE_RESPONSE };
    });
    await runCodePut(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        codeFile,
        expectedVersion: 'v3',
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );
    expect(seenBody).toEqual({ code: 'updated body' });
  });

  it('forwards --language in the body when set', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('print("hi")');
    let seenBody: unknown;
    const fetchImpl = makeFetch((_url, init) => {
      seenBody = init.body ? JSON.parse(init.body as string) : undefined;
      return { body: SAMPLE_RESPONSE };
    });
    await runCodePut(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        codeFile,
        expectedVersion: 'v3',
        language: 'python',
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );
    expect(seenBody).toEqual({ code: 'print("hi")', language: 'python' });
  });

  it('--force sends If-Match: *', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('body');
    let seenIfMatch: string | null = null;
    const fetchImpl = makeFetch((_url, init) => {
      seenIfMatch = new Headers(init.headers as Record<string, string>).get('if-match');
      return { body: SAMPLE_RESPONSE };
    });
    await runCodePut(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        codeFile,
        force: true,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );
    expect(seenIfMatch).toBe('*');
  });

  it('rejects --force + --expected-version combination before sending', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('body');
    let called = 0;
    const fetchImpl = makeFetch(() => {
      called += 1;
      return { body: SAMPLE_RESPONSE };
    });
    await expect(
      runCodePut(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_alpha',
          codeFile,
          force: true,
          expectedVersion: 'v3',
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'expected-version' }),
    });
    expect(called).toBe(0);
  });

  it('rejects an invalid --language value before sending', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('body');
    let called = 0;
    const fetchImpl = makeFetch(() => {
      called += 1;
      return { body: SAMPLE_RESPONSE };
    });
    await expect(
      runCodePut(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_alpha',
          codeFile,
          expectedVersion: 'v3',
          language: 'ruby' as never,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'language' }),
    });
    expect(called).toBe(0);
  });

  it('rejects --language typescript / javascript (only python is supported) (DEV-232 / #210)', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('print("hi")');
    for (const lang of ['typescript', 'javascript'] as const) {
      let called = 0;
      const fetchImpl = makeFetch(() => {
        called += 1;
        return { body: SAMPLE_RESPONSE };
      });
      await expect(
        runCodePut(
          {
            profile: 'default',
            output: 'json',
            debug: false,
            testId: 'test_alpha',
            codeFile,
            expectedVersion: 'v3',
            language: lang as never,
          },
          { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
        ),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        details: expect.objectContaining({ field: 'language' }),
      });
      expect(called).toBe(0);
    }
  });

  it('rejects a non-Python (.ts) --code-file before sending (DEV-232)', async () => {
    const { credentialsPath } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-codeput-ts-'));
    const tsFile = join(dir, 'updated.spec.ts');
    writeFileSync(tsFile, 'export const x = 1;\n', 'utf8');
    let called = 0;
    const fetchImpl = makeFetch(() => {
      called += 1;
      return { body: SAMPLE_RESPONSE };
    });
    await expect(
      runCodePut(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_alpha',
          codeFile: tsFile,
          expectedVersion: 'v3',
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'code-file' }),
    });
    expect(called).toBe(0);
  });

  it('rejects missing --code-file before sending', async () => {
    const { credentialsPath } = makeCreds();
    let called = 0;
    const fetchImpl = makeFetch(() => {
      called += 1;
      return { body: SAMPLE_RESPONSE };
    });
    await expect(
      runCodePut(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_alpha',
          codeFile: '',
          expectedVersion: 'v3',
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(called).toBe(0);
  });

  it('auto-fetches current codeVersion when neither --expected-version nor --force is set', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('body');
    const seen: { method: string; url: string; ifMatch: string | null }[] = [];
    const fetchImpl = makeFetch((url, init) => {
      const method = init.method ?? 'GET';
      seen.push({
        method,
        url,
        ifMatch: new Headers(init.headers as Record<string, string>).get('if-match'),
      });
      if (method === 'GET') {
        return {
          body: { testId: 'test_alpha', language: 'typescript', code: 'old', codeVersion: 'v7' },
        };
      }
      return { body: SAMPLE_RESPONSE };
    });
    const errLines: string[] = [];
    await runCodePut(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        codeFile,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => errLines.push(line),
      },
    );
    expect(seen.map(s => s.method)).toEqual(['GET', 'PUT']);
    expect(seen[1]!.ifMatch).toBe('v7');
    expect(errLines.some(l => l.includes('auto-fetched codeVersion=v7'))).toBe(true);
  });

  it('auto-fetch on legacy null codeVersion falls back to If-Match: * with stderr advisory', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('body');
    const seen: { method: string; ifMatch: string | null }[] = [];
    const fetchImpl = makeFetch((_url, init) => {
      const method = init.method ?? 'GET';
      seen.push({
        method,
        ifMatch: new Headers(init.headers as Record<string, string>).get('if-match'),
      });
      if (method === 'GET') {
        return {
          body: { testId: 'test_alpha', language: 'typescript', code: 'old', codeVersion: null },
        };
      }
      return { body: SAMPLE_RESPONSE };
    });
    const errLines: string[] = [];
    await runCodePut(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        codeFile,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => errLines.push(line),
      },
    );
    expect(seen[1]!.ifMatch).toBe('*');
    expect(errLines.some(l => l.includes('legacy row'))).toBe(true);
  });

  it('on 412 PRECONDITION_FAILED, prints a typed retry hint with the server codeVersion and re-throws', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('body');
    const fetchImpl = makeFetch(() => ({
      status: 412,
      body: {
        error: {
          code: 'PRECONDITION_FAILED',
          message: 'codeVersion mismatch',
          nextAction: "Re-fetch with 'test get <id>' and retry with the new codeVersion.",
          requestId: 'req_42',
          details: { currentCodeVersion: 'v5' },
        },
      },
    }));
    const errLines: string[] = [];
    await expect(
      runCodePut(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_alpha',
          codeFile,
          expectedVersion: 'v3',
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: () => undefined,
          stderr: line => errLines.push(line),
        },
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', exitCode: 6 });
    expect(errLines.some(l => l.includes('Server is at v5, you sent v3'))).toBe(true);
    expect(errLines.some(l => l.includes('--expected-version v5'))).toBe(true);
  });

  it('respects a caller-supplied --idempotency-key', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('body');
    let seenKey: string | null = null;
    const fetchImpl = makeFetch((_url, init) => {
      seenKey = new Headers(init.headers as Record<string, string>).get('idempotency-key');
      return { body: SAMPLE_RESPONSE };
    });
    await runCodePut(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        codeFile,
        expectedVersion: 'v3',
        idempotencyKey: 'op_codeput_1',
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );
    expect(seenKey).toBe('op_codeput_1');
  });

  it('renders text mode with one line per field', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('body');
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    const out: string[] = [];
    await runCodePut(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_alpha',
        codeFile,
        expectedVersion: 'v3',
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line), stderr: () => undefined },
    );
    const block = out.join('\n');
    expect(block).toContain('testId      test_alpha');
    expect(block).toContain('codeVersion v4');
    expect(block).toContain('updatedAt   2026-05-15T10:00:00.000Z');
  });

  // N1: dry-run advisory wording must differ from real-run advisory
  it('N1 — dry-run auto-fetch advisory includes "[dry-run]" prefix', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('body');
    // dry-run fetch returns the canned /code shape via dry-run samples
    const errLines: string[] = [];
    await runCodePut(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        testId: 'test_alpha',
        codeFile,
        // No expectedVersion — triggers the auto-fetch advisory path
      },
      {
        credentialsPath,
        fetchImpl: makeFetch(() => ({
          body: {
            testId: 'test_alpha',
            language: 'typescript',
            code: 'old',
            codeVersion: 'v_sample',
          },
        })),
        stdout: () => undefined,
        stderr: line => errLines.push(line),
      },
    );
    // Dry-run advisory must include the dry-run marker
    expect(errLines.some(l => l.includes('[dry-run]'))).toBe(true);
    expect(errLines.some(l => l.includes('auto-fetched codeVersion='))).toBe(false);
  });

  it('N1 — real-run auto-fetch advisory does NOT include "[dry-run]" prefix', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('body');
    const fetchImpl = makeFetch((_url, init) => {
      const method = init.method ?? 'GET';
      if (method === 'GET') {
        return {
          body: { testId: 'test_alpha', language: 'typescript', code: 'old', codeVersion: 'v9' },
        };
      }
      return { body: SAMPLE_RESPONSE };
    });
    const errLines: string[] = [];
    await runCodePut(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: false,
        testId: 'test_alpha',
        codeFile,
        // No expectedVersion — triggers the auto-fetch advisory path
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: line => errLines.push(line) },
    );
    // Real advisory contains codeVersion, NOT the [dry-run] marker
    expect(errLines.some(l => l.includes('auto-fetched codeVersion=v9'))).toBe(true);
    expect(errLines.some(l => l.includes('[dry-run]'))).toBe(false);
  });

  // Fix #2 — dogfood 2026-05-14: --dry-run-simulate-error PRECONDITION_FAILED
  it('--dry-run --dry-run-simulate-error PRECONDITION_FAILED: exits 6 + emits retry hint', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('any code');
    const stderrLines: string[] = [];
    await expect(
      runCodePut(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: true,
          testId: 'test_abc',
          codeFile,
          expectedVersion: 'v3',
          dryRunSimulateError: 'PRECONDITION_FAILED',
        },
        {
          credentialsPath,
          stdout: () => undefined,
          stderr: line => stderrLines.push(line),
        },
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    // Retry hint must include the server version and testId
    expect(stderrLines.some(l => l.includes('Code conflict'))).toBe(true);
    expect(stderrLines.some(l => l.includes('v99'))).toBe(true);
    expect(stderrLines.some(l => l.includes('--expected-version'))).toBe(true);
  });

  it('without --dry-run, a real 412 from the server still routes through the normal retry-hint path', async () => {
    // Sanity check for the unflagged real-412 path. Confirms the
    // simulate code added in dogfood-2026-05-14 does not displace the
    // existing server-driven 412 handler.
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('code');
    const fetchImpl = makeFetch(() => ({
      status: 412,
      body: {
        error: {
          code: 'PRECONDITION_FAILED',
          message: 'etag mismatch',
          nextAction: 'retry',
          requestId: 'req_test',
          details: { currentCodeVersion: 'v7' },
        },
      },
    }));
    const stderrLines: string[] = [];
    await expect(
      runCodePut(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: false,
          testId: 'test_abc',
          codeFile,
          expectedVersion: 'v3',
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: () => undefined,
          stderr: line => stderrLines.push(line),
        },
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    // Real 412 path: hint from server (currentCodeVersion=v7), not from simulate (which would inject v99)
    expect(stderrLines.some(l => l.includes('Code conflict'))).toBe(true);
    expect(stderrLines.some(l => l.includes('v7'))).toBe(true);
  });

  it('--dry-run-simulate-error WITHOUT --dry-run is ignored — the simulate guard does not fire and the real fetch is reached', async () => {
    // codex-review P2 (2026-05-28): the previous test name promised
    // "without --dry-run" coverage but didn't actually pass
    // dryRunSimulateError. This test does pass it (with dryRun: false)
    // and asserts the simulate block did NOT synthesize the canned v99
    // payload — the request reached fetchImpl and got the server's v7
    // back instead.
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('code');
    let fetchCallCount = 0;
    const fetchImpl = makeFetch(() => {
      fetchCallCount += 1;
      return {
        status: 412,
        body: {
          error: {
            code: 'PRECONDITION_FAILED',
            message: 'etag mismatch',
            nextAction: 'retry',
            requestId: 'req_real_server',
            details: { currentCodeVersion: 'v7' },
          },
        },
      };
    });
    const stderrLines: string[] = [];
    await expect(
      runCodePut(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: false, // <-- key: NOT dry-run
          dryRunSimulateError: 'PRECONDITION_FAILED', // <-- but simulate IS set
          testId: 'test_abc',
          codeFile,
          expectedVersion: 'v3',
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: () => undefined,
          stderr: line => stderrLines.push(line),
        },
      ),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      requestId: 'req_real_server', // server-side requestId, not the simulate 'req_dry-run-simulate'
    });
    // The real fetch must have been reached — simulate did not short-circuit.
    expect(fetchCallCount).toBe(1);
    // And the hint must come from the server's v7, not simulate's canned v99.
    expect(stderrLines.some(l => l.includes('v7'))).toBe(true);
    expect(stderrLines.some(l => l.includes('v99'))).toBe(false);
  });
});

describe('runSteps', () => {
  it('JSON mode returns the §6.4 wire shape and forwards pageSize/cursor', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: { items: [STEP_PASSED, STEP_FAILED, STEP_PENDING], nextToken: null } };
    });
    const out: string[] = [];
    const page = await runSteps(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_fe',
        pageSize: 25,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(seen[0]).toContain('/tests/test_fe/steps');
    expect(seen[0]).toContain('pageSize=25');
    expect(page.items).toHaveLength(3);
    expect(JSON.parse(out[0]!).items).toHaveLength(3);
  });

  it('text mode renders index/action/status/description and shared run metadata', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { items: [STEP_PASSED, STEP_FAILED, STEP_PENDING], nextToken: null },
    }));
    const out: string[] = [];
    await runSteps(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_fe',
        pageSize: 25,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    expect(block).toContain('INDEX');
    expect(block).toContain('ACTION');
    expect(block).toContain('STATUS');
    expect(block).toContain('DESCRIPTION');
    expect(block).toContain('Click the cart icon');
    expect(block).toContain('Click the submit button');
    expect(block).toContain('Expect order confirmation heading');
    // null status renders as an em-dash so a glance reads it as
    // "no verdict yet" rather than a broken cell.
    expect(block).toContain('—');
    // Shared run metadata renders once at the bottom.
    expect(block).toContain('runId:       run_abc');
    expect(block).toContain('codeVersion: v3');
  });

  it('text mode reads "No steps." on an empty list', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { items: [], nextToken: null } }));
    const out: string[] = [];
    await runSteps(
      { profile: 'default', output: 'text', debug: false, testId: 'test_empty' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(out.join('\n')).toBe('No steps.');
  });

  it('--max-items caps total returned across pages', async () => {
    const { credentialsPath } = makeCreds();
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      return {
        body: {
          items: [
            { ...STEP_PASSED, stepIndex: calls * 2 - 1 },
            { ...STEP_PASSED, stepIndex: calls * 2 },
          ],
          nextToken: calls < 3 ? `cursor-${calls}` : null,
        },
      };
    });
    const page = await runSteps(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_fe',
        maxItems: 3,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    expect(page.items).toHaveLength(3);
  });

  it('text mode flags the synthetic terminal assertion row with `*` and a "(synthetic assertion failure)" description tail', async () => {
    // M2.1 piece-4 follow-up: when the test failed at the assertion
    // layer (no real step in error), the backend appends one synthetic
    // terminal row with `action: "assertion"`, `outcomeContributesToFailure:
    // true`, and null screenshot/htmlSnapshot URLs. The text renderer
    // marks it with `* ` so a 50-step list highlights the contributing
    // row, and appends "(synthetic assertion failure)" so an operator
    // doesn't wonder why the action is `assertion` when the test code
    // never had one.
    const { credentialsPath } = makeCreds();
    const synthetic: CliTestStep = {
      testId: 'test_fe',
      stepIndex: 7,
      action: 'assertion',
      description: 'The hosted build did not surface the member detail page.',
      status: 'failed',
      screenshotUrl: null,
      htmlSnapshotUrl: null,
      runIdIfAvailable: 'run_abc',
      codeVersion: 'v3',
      capturedAt: null,
      updatedAt: '2026-05-09T18:00:00.000Z',
      outcomeContributesToFailure: true,
    };
    const fetchImpl = makeFetch(() => ({
      body: { items: [STEP_PASSED, STEP_PENDING, synthetic], nextToken: null },
    }));
    const out: string[] = [];
    await runSteps(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_fe',
        pageSize: 25,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    expect(block).toMatch(/\*\s+7\s+assertion/);
    expect(block).toContain('(synthetic assertion failure)');
    // Real rows without `outcomeContributesToFailure: true` keep the
    // empty 2-char marker so column alignment doesn't drift.
    expect(block).not.toMatch(/\*\s+4\s+click/);
  });

  it('NOT_FOUND envelope from /steps maps to exit 4', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 404,
      body: {
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found.',
          nextAction: 'check id',
          requestId: 'req_test',
          details: { resource: 'test', id: 'test_missing' },
        },
      },
    }));
    await expect(
      runSteps(
        { profile: 'default', output: 'json', debug: false, testId: 'test_missing' },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', exitCode: 4 });
  });

  // ---------------------------------------------------------------------------
  // --run-id filter (dogfood round-4 2026-05-17 fix)
  // ---------------------------------------------------------------------------

  // ------- --run-id path: uses GET /runs/{runId}?includeSteps=true -------
  // FE Portal step rows don't reliably carry per-run `runIdIfAvailable`, so
  // the old client-side filter always returned empty. The new path fetches
  // from the authoritative run-scoped endpoint and maps RunStepDto→CliTestStep.

  /** Minimal RunResponse fixture for the run-scoped steps tests. */
  const RUN_WITH_STEPS = {
    runId: 'run_scoped',
    testId: 'test_fe',
    projectId: 'project_alice',
    userId: 'u1',
    status: 'passed' as const,
    source: 'cli',
    createdAt: '2026-06-01T10:00:00.000Z',
    startedAt: '2026-06-01T10:00:01.000Z',
    finishedAt: '2026-06-01T10:00:30.000Z',
    codeVersion: 'v5',
    targetUrl: 'https://example.com',
    createdFrom: null,
    failedStepIndex: null,
    failureKind: null,
    error: null,
    videoUrl: null,
    stepSummary: { total: 2, completed: 2, passedCount: 2, failedCount: 0 },
    steps: [
      {
        stepIndex: '0001',
        type: 'action',
        action: 'click .btn',
        status: 'passed',
        description: 'Click the submit button',
        error: null,
        screenshotUrl: 'https://s3.example.com/snap/01.png',
        htmlSnapshotUrl: null,
        createdAt: '2026-06-01T10:00:05.000Z',
      },
      {
        stepIndex: '0002',
        type: 'assertion',
        action: 'assert heading',
        status: 'passed',
        description: 'Confirm heading visible',
        error: null,
        screenshotUrl: null,
        htmlSnapshotUrl: null,
        createdAt: '2026-06-01T10:00:10.000Z',
      },
    ],
  };

  it('--run-id calls GET /runs/{runId}?includeSteps=true (not the cumulative steps endpoint)', async () => {
    const { credentialsPath } = makeCreds();
    const seenUrls: string[] = [];
    const fetchImpl = makeFetch(url => {
      seenUrls.push(url);
      return { body: RUN_WITH_STEPS };
    });
    const page = await runSteps(
      { profile: 'default', output: 'json', debug: false, testId: 'test_fe', runId: 'run_scoped' },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    // Must call the run-scoped endpoint, NOT the cumulative /tests/{id}/steps
    expect(seenUrls.some(u => u.includes('/runs/run_scoped'))).toBe(true);
    expect(seenUrls.some(u => u.includes('includeSteps=true'))).toBe(true);
    expect(seenUrls.every(u => !u.includes('/tests/test_fe/steps'))).toBe(true);
    expect(page.items).toHaveLength(2);
  });

  it('--run-id maps RunStepDto fields to CliTestStep correctly', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: RUN_WITH_STEPS }));
    const out: string[] = [];
    const page = await runSteps(
      { profile: 'default', output: 'json', debug: false, testId: 'test_fe', runId: 'run_scoped' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const first = page.items[0]!;
    // stepIndex is parsed from the zero-padded string '0001'
    expect(first.stepIndex).toBe(1);
    // runIdIfAvailable comes from RunResponse.runId
    expect(first.runIdIfAvailable).toBe('run_scoped');
    // testId comes from RunResponse.testId
    expect(first.testId).toBe('test_fe');
    // codeVersion comes from RunResponse.codeVersion
    expect(first.codeVersion).toBe('v5');
    // timestamps come from RunStepDto.createdAt
    expect(first.capturedAt).toBe('2026-06-01T10:00:05.000Z');
    expect(first.updatedAt).toBe('2026-06-01T10:00:05.000Z');
    // outcomeContributesToFailure: null when run passed (failedStepIndex is null)
    expect(first.outcomeContributesToFailure).toBeNull();
    // JSON output should be parseable with 2 items
    const printed = JSON.parse(out[0]!) as { items: unknown[] };
    expect(printed.items).toHaveLength(2);
  });

  it('--run-id: outcomeContributesToFailure=true on the failedStepIndex step', async () => {
    const { credentialsPath } = makeCreds();
    const runWithFailure = {
      ...RUN_WITH_STEPS,
      status: 'failed' as const,
      failedStepIndex: 2,
    };
    const fetchImpl = makeFetch(() => ({ body: runWithFailure }));
    const page = await runSteps(
      { profile: 'default', output: 'json', debug: false, testId: 'test_fe', runId: 'run_scoped' },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    // step at index 2 (stepIndex='0002') should be flagged true; index 1 is a
    // KNOWN non-contributor → false (not null) once failedStepIndex is known
    // (CliTestStep contract: null = unclassified, false = classified non-contrib).
    const step1 = page.items.find(s => s.stepIndex === 1)!;
    const step2 = page.items.find(s => s.stepIndex === 2)!;
    expect(step1.outcomeContributesToFailure).toBe(false);
    expect(step2.outcomeContributesToFailure).toBe(true);
  });

  it('--run-id carries the per-step error text and stepType through to JSON (no silent drop)', async () => {
    // Regression lock for the "steps discard RunStepDto.error" gap: the wire
    // already returns the failure text in the same response; it must survive
    // the CliTestStep mapping instead of forcing an artifact-bundle download.
    const { credentialsPath } = makeCreds();
    const runWithStepError = {
      ...RUN_WITH_STEPS,
      status: 'failed' as const,
      failedStepIndex: 2,
      steps: [
        RUN_WITH_STEPS.steps[0]!,
        {
          ...RUN_WITH_STEPS.steps[1]!,
          status: 'failed',
          error: 'Expected heading "Order confirmed" to be visible, got hidden',
        },
      ],
    };
    const fetchImpl = makeFetch(() => ({ body: runWithStepError }));
    const page = await runSteps(
      { profile: 'default', output: 'json', debug: false, testId: 'test_fe', runId: 'run_scoped' },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    const passing = page.items.find(s => s.stepIndex === 1)!;
    const failing = page.items.find(s => s.stepIndex === 2)!;
    expect(failing.error).toBe('Expected heading "Order confirmed" to be visible, got hidden');
    expect(failing.stepType).toBe('assertion');
    expect(passing.error).toBeNull();
    expect(passing.stepType).toBe('action');
  });

  it('--run-id text mode prints an indented error: sub-line under the failed row only', async () => {
    const { credentialsPath } = makeCreds();
    const runWithStepError = {
      ...RUN_WITH_STEPS,
      status: 'failed' as const,
      failedStepIndex: 2,
      steps: [
        RUN_WITH_STEPS.steps[0]!,
        {
          ...RUN_WITH_STEPS.steps[1]!,
          status: 'failed',
          error: 'Locator resolved to hidden element\n  at assert heading',
        },
      ],
    };
    const fetchImpl = makeFetch(() => ({ body: runWithStepError }));
    const out: string[] = [];
    await runSteps(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe', runId: 'run_scoped' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    // Newlines in the wire error collapse to one displayable line.
    expect(block).toContain('error: Locator resolved to hidden element at assert heading');
    // Exactly one sub-line: the passing step must not grow one.
    expect(block.match(/error: /g)).toHaveLength(1);
  });

  it('--run-id: rejects a runId that belongs to a different test (exit 4)', async () => {
    const { credentialsPath } = makeCreds();
    // The run-scoped endpoint returns a run whose testId differs from the
    // <testId> argument (same tenant, wrong test). Must NOT leak its steps —
    // restores the implicit scoping of the old /tests/{testId}/steps path.
    const otherTestRun = { ...RUN_WITH_STEPS, testId: 'test_OTHER' };
    const fetchImpl = makeFetch(() => ({ body: otherTestRun }));
    await expect(
      runSteps(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_fe',
          runId: 'run_scoped',
        },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  it('--run-id: empty steps → JSON mode prints empty array, exits 0', async () => {
    const { credentialsPath } = makeCreds();
    const runNoSteps = { ...RUN_WITH_STEPS, steps: [] };
    const fetchImpl = makeFetch(() => ({ body: runNoSteps }));
    const out: string[] = [];
    const page = await runSteps(
      { profile: 'default', output: 'json', debug: false, testId: 'test_fe', runId: 'run_scoped' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line), stderr: () => {} },
    );
    expect(page.items).toHaveLength(0);
    const printed = JSON.parse(out[0]!) as { items: unknown[] };
    expect(printed.items).toHaveLength(0);
  });

  it('--run-id: empty steps → text mode emits advisory to stderr pointing at artifact get', async () => {
    const { credentialsPath } = makeCreds();
    const runNoSteps = { ...RUN_WITH_STEPS, steps: [] };
    const fetchImpl = makeFetch(() => ({ body: runNoSteps }));
    const stderrLines: string[] = [];
    const out: string[] = [];
    const page = await runSteps(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_fe',
        runId: 'run_scoped',
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => out.push(line),
        stderr: line => stderrLines.push(line),
      },
    );
    expect(page.items).toHaveLength(0);
    expect(out).toHaveLength(0);
    expect(stderrLines.some(l => l.includes('[advisory]') && l.includes('artifact get'))).toBe(
      true,
    );
  });

  it('--run-id: 404 propagates as ApiError (exit 4, NOT_FOUND)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 404,
      body: { code: 'NOT_FOUND', message: 'Run not found' },
    }));
    await expect(
      runSteps(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_fe',
          runId: 'run_unknown',
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('no --run-id: multi-run response emits advisory to stderr when steps span >1 runId', async () => {
    const { credentialsPath } = makeCreds();
    const stepA: CliTestStep = { ...STEP_PASSED, stepIndex: 1, runIdIfAvailable: 'run_A' };
    const stepB: CliTestStep = { ...STEP_PASSED, stepIndex: 2, runIdIfAvailable: 'run_B' };
    const fetchImpl = makeFetch(() => ({
      body: { items: [stepA, stepB], nextToken: null },
    }));
    const stderrLines: string[] = [];
    await runSteps(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_fe',
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
      },
    );
    // Advisory must mention the count and the --run-id flag
    expect(stderrLines.some(l => l.includes('[advisory]') && l.includes('--run-id'))).toBe(true);
  });

  it('no --run-id: single-run response produces no advisory', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { items: [STEP_PASSED, STEP_FAILED], nextToken: null },
    }));
    const stderrLines: string[] = [];
    await runSteps(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_fe',
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
      },
    );
    expect(stderrLines.some(l => l.includes('[advisory]'))).toBe(false);
  });

  it('--run-id: pagination flags (--page-size / --starting-token / --max-items) are ignored — run endpoint returns all steps', async () => {
    // The run-scoped endpoint returns all steps in a single response.
    // Pagination flags are only meaningful on the cumulative /tests/{id}/steps path.
    const { credentialsPath } = makeCreds();
    const seenUrls: string[] = [];
    const fetchImpl = makeFetch(url => {
      seenUrls.push(url);
      return { body: RUN_WITH_STEPS };
    });
    const page = await runSteps(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_fe',
        runId: 'run_scoped',
        pageSize: 5, // ignored for run-scoped path
        startingToken: 'tok', // ignored for run-scoped path
        maxItems: 1, // ignored for run-scoped path
      },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    // All 2 steps are returned (maxItems=1 is NOT applied on the run-scoped path)
    expect(page.items).toHaveLength(2);
    // The run-scoped URL should not carry pagination query params
    const runUrl = seenUrls.find(u => u.includes('/runs/run_scoped'))!;
    expect(runUrl).toBeDefined();
    expect(runUrl).not.toMatch(/pageSize|cursor|startingToken/);
  });

  it('test steps subcommand exposes --run-id flag', async () => {
    const { createTestCommand } = await import('./test.js');
    const test = createTestCommand();
    const steps = test.commands.find(c => c.name() === 'steps')!;
    const flagNames = steps.options.map(o => o.long);
    expect(flagNames).toContain('--run-id');
  });
});

describe('runDiff', () => {
  const baseRun = {
    testId: 'test_fe',
    projectId: 'project_alice',
    userId: 'u1',
    source: 'cli',
    createdAt: '2026-06-01T10:00:00.000Z',
    startedAt: '2026-06-01T10:00:01.000Z',
    finishedAt: '2026-06-01T10:00:30.000Z',
    targetUrl: 'https://example.com',
    createdFrom: null,
    error: null,
    videoUrl: null,
    stepSummary: { total: 2, completed: 2, passedCount: 2, failedCount: 0 },
  };
  const makeStep = (index: string, status: string, error: string | null = null) => ({
    stepIndex: index,
    type: 'action',
    action: `step ${index}`,
    status,
    description: `Step ${index}`,
    error,
    screenshotUrl: null,
    htmlSnapshotUrl: null,
    createdAt: '2026-06-01T10:00:05.000Z',
  });
  const RUN_GREEN = {
    ...baseRun,
    runId: 'run_green',
    status: 'passed',
    codeVersion: 'v1',
    failedStepIndex: null,
    failureKind: null,
    steps: [makeStep('0001', 'passed'), makeStep('0002', 'passed')],
  };
  const RUN_RED = {
    ...baseRun,
    runId: 'run_red',
    status: 'failed',
    codeVersion: 'v2',
    failedStepIndex: 2,
    failureKind: 'assertion',
    steps: [makeStep('0001', 'passed'), makeStep('0002', 'failed', 'heading not visible')],
  };
  const fetchForRuns = () =>
    makeFetch(url => ({ body: url.includes('run_green') ? RUN_GREEN : RUN_RED }));

  it('reports the verdict flip, the changed step with its error, and code drift, then exits 1', async () => {
    const { credentialsPath } = makeCreds();
    const out: string[] = [];
    const rejection = await runDiff(
      { profile: 'default', output: 'json', debug: false, runA: 'run_green', runB: 'run_red' },
      { credentialsPath, fetchImpl: fetchForRuns(), stdout: line => out.push(line) },
    ).catch((error: unknown) => error);
    expect(rejection).toMatchObject({ exitCode: 1 });
    const printed = JSON.parse(out.join('')) as {
      verdictChanged: boolean;
      codeVersionChanged: boolean;
      crossTest: boolean;
      changedSteps: Array<{ stepIndex: number; statusA: string; statusB: string; errorB?: string }>;
    };
    expect(printed.verdictChanged).toBe(true);
    expect(printed.codeVersionChanged).toBe(true);
    expect(printed.crossTest).toBe(false);
    expect(printed.changedSteps).toHaveLength(1);
    expect(printed.changedSteps[0]).toMatchObject({
      stepIndex: 2,
      statusA: 'passed',
      statusB: 'failed',
      errorB: 'heading not visible',
    });
  });

  it('identical verdicts resolve with exit 0 and no step changes', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: RUN_GREEN }));
    const diff = await runDiff(
      { profile: 'default', output: 'json', debug: false, runA: 'run_green', runB: 'run_green' },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    expect(diff.verdictChanged).toBe(false);
    expect(diff.changedSteps).toHaveLength(0);
  });

  it('warns (not fails) when the runs belong to different tests', async () => {
    const { credentialsPath } = makeCreds();
    const OTHER = { ...RUN_GREEN, runId: 'run_red', testId: 'test_other' };
    const fetchImpl = makeFetch(url => ({
      body: url.includes('run_green') ? RUN_GREEN : OTHER,
    }));
    const errs: string[] = [];
    const diff = await runDiff(
      { profile: 'default', output: 'json', debug: false, runA: 'run_green', runB: 'run_red' },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: line => errs.push(line) },
    );
    expect(diff.crossTest).toBe(true);
    expect(errs.join('\n')).toContain('different tests');
  });

  it('--dry-run returns the canned sample fully offline (no credentials, no fetch)', async () => {
    // Dry-run must not require credentials or hit the network — it returns a
    // canned CliRunDiff so `--dry-run` shows the shape offline.
    const diff = await runDiff(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        runA: 'run_aaa',
        runB: 'run_bbb',
      },
      { stdout: () => undefined, stderr: () => undefined },
    );
    expect(diff.runA.runId).toBe('run_aaa');
    expect(diff.runB.runId).toBe('run_bbb');
    expect(diff.verdictChanged).toBe(true);
    expect(diff.changedSteps).toHaveLength(1);
    expect(diff.changedSteps[0]).toMatchObject({
      stepIndex: 2,
      statusA: 'passed',
      statusB: 'failed',
    });
  });
});

describe('runLint', () => {
  const VALID_PLAN = JSON.stringify({
    projectId: 'project_alice',
    type: 'frontend',
    name: 'Checkout works',
    planSteps: [
      { type: 'action', description: 'Open the cart' },
      { type: 'assertion', description: 'Assert the total is visible' },
    ],
  });
  const INVALID_PLAN = JSON.stringify({
    projectId: 'project_alice',
    type: 'frontend',
    name: 'Broken',
    planSteps: [{ type: 'hover', description: 'Bad step type' }],
  });

  it('a directory with valid and invalid plans reports EVERY problem and exits 5', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-lint-'));
    writeFileSync(join(dir, 'a-valid.json'), VALID_PLAN, 'utf8');
    writeFileSync(join(dir, 'b-invalid.json'), INVALID_PLAN, 'utf8');
    writeFileSync(join(dir, 'c-notjson.json'), '{oops', 'utf8');
    const out: string[] = [];
    const rejection = await runLint(
      { profile: 'default', output: 'json', debug: false, planFromDir: dir },
      { stdout: line => out.push(line) },
    ).catch((error: unknown) => error);
    expect(rejection).toMatchObject({ exitCode: 5 });
    const report = JSON.parse(out.join('')) as {
      checked: number;
      valid: number;
      issues: Array<{ file: string; field: string }>;
    };
    // All three files were checked (no first-error-fatal bailout).
    expect(report.checked).toBe(3);
    expect(report.valid).toBe(1);
    expect(report.issues.map(issue => issue.file).sort()).toEqual([
      'b-invalid.json',
      'c-notjson.json',
    ]);
  });

  it('an all-valid directory resolves with exit 0 and no network/credentials needed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-lint-ok-'));
    writeFileSync(join(dir, 'a.json'), VALID_PLAN, 'utf8');
    const report = await runLint(
      { profile: 'default', output: 'json', debug: false, planFromDir: dir },
      { stdout: () => undefined },
    );
    expect(report).toMatchObject({ checked: 1, valid: 1, issues: [] });
  });

  it('a JSONL file reports each bad line with its PHYSICAL line number (blank lines skipped, not renumbered)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-lint-jsonl-'));
    const file = join(dir, 'plans.jsonl');
    // A blank separator line sits between entries: line 1 valid, line 2 blank,
    // line 3 bad JSON, line 4 invalid plan. Reported numbers must be 3 and 4.
    writeFileSync(file, `${VALID_PLAN}\n\nnot json at all\n${INVALID_PLAN}\n`, 'utf8');
    const out: string[] = [];
    const rejection = await runLint(
      { profile: 'default', output: 'json', debug: false, plans: file },
      { stdout: line => out.push(line) },
    ).catch((error: unknown) => error);
    expect(rejection).toMatchObject({ exitCode: 5 });
    const report = JSON.parse(out.join('')) as { checked: number; issues: Array<{ file: string }> };
    expect(report.checked).toBe(3);
    expect(report.issues.some(issue => issue.file.endsWith(':3'))).toBe(true);
    expect(report.issues.some(issue => issue.file.endsWith(':4'))).toBe(true);
    // The blank line itself is not an entry and never reports.
    expect(report.issues.some(issue => issue.file.endsWith(':2'))).toBe(false);
  });

  it('requires exactly one input source', async () => {
    await expect(
      runLint({ profile: 'default', output: 'json', debug: false }, { stdout: () => undefined }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });
});

describe('runResult', () => {
  it('JSON mode prints the §6.5 LatestResult shape verbatim', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: RESULT_FAILED };
    });
    const out: string[] = [];
    const got = await runResult(
      { profile: 'default', output: 'json', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(seen[0]).toContain('/tests/test_fe/result');
    expect(got).toEqual(RESULT_FAILED);
    expect(JSON.parse(out[0]!)).toEqual(RESULT_FAILED);
  });

  it('text mode for a failed run highlights failureKind + failedStepIndex up top', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: RESULT_FAILED }));
    const out: string[] = [];
    await runResult(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    const lines = block.split('\n');
    // failureKind / failedStepIndex come BEFORE timestamps. "Highlight"
    // here is positional — agents and humans reading top-down see the
    // failure shape first.
    const kindLine = lines.findIndex(l => l.startsWith('failureKind'));
    const indexLine = lines.findIndex(l => l.startsWith('failedStepIndex'));
    const startedLine = lines.findIndex(l => l.startsWith('startedAt'));
    expect(kindLine).toBeGreaterThanOrEqual(0);
    expect(indexLine).toBeGreaterThanOrEqual(0);
    expect(kindLine).toBeLessThan(startedLine);
    expect(indexLine).toBeLessThan(startedLine);
    expect(block).toContain('failureKind:        assertion');
    expect(block).toContain('failedStepIndex:    5');
    // verdict + executionStatus replace the conflated status line;
    // summary is a semantic sentence.
    expect(block).toContain('verdict:            failed');
    expect(block).toContain('executionStatus:    completed');
    expect(block).toContain('summary:            Failed (assertion) on step 5');
    expect(block).toContain('failureAnalysisUrl: ');
  });

  it('text mode for a passed run skips failureKind/failedStepIndex/failureAnalysisUrl', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: RESULT_PASSED }));
    const out: string[] = [];
    await runResult(
      { profile: 'default', output: 'text', debug: false, testId: 'test_passed' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    // verdict/executionStatus instead of the conflated status line.
    expect(block).toContain('verdict:            passed');
    expect(block).toContain('executionStatus:    completed');
    expect(block).not.toContain('failureKind');
    expect(block).not.toContain('failedStepIndex');
    expect(block).not.toContain('failureAnalysisUrl');
    expect(block).toContain('summary:            Test passed.');
  });

  it('CONFLICT envelope from /result maps to exit 6 (snapshot in flight)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 409,
      body: {
        error: {
          code: 'CONFLICT',
          message: 'Snapshot in flight; retry shortly.',
          nextAction:
            'Snapshot in flight; retry in a few seconds. The CLI re-fetches against a single `snapshotId` so partial reads are safe.',
          requestId: 'req_test',
          details: { reason: 'snapshot_in_flight' },
        },
      },
    }));
    // Sleep helper makes CONFLICT retry-backoff instant for the test.
    await expect(
      runResult(
        { profile: 'default', output: 'json', debug: false, testId: 'test_fe' },
        {
          credentialsPath,
          fetchImpl,
          stdout: () => undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', exitCode: 6 });
  });

  it('default does NOT add ?includeAnalysis (byte-identical to pre-M2.1)', async () => {
    // M2.1 piece 3 contract: omitting `--include-analysis` must
    // produce a request whose URL has no `includeAnalysis` query
    // param. That keeps existing automation byte-identical to pre-
    // M2.1 — no surprise shape changes for callers that didn't opt in.
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: RESULT_FAILED };
    });
    await runResult(
      { profile: 'default', output: 'json', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    expect(seen[0]).not.toContain('includeAnalysis');
  });

  it('--include-analysis sends ?includeAnalysis=true and renders the block in text mode', async () => {
    const RESULT_WITH_ANALYSIS = {
      ...RESULT_FAILED,
      analysis: {
        rootCauseHypothesis: 'Submit button is disabled because the form is invalid.',
        recommendedFixTarget: {
          kind: 'code' as const,
          reference: 'src/components/CheckoutForm.tsx:412',
          rationale: 'Disabled state originates from `isFormValid()`.',
        },
        failureKind: 'assertion' as const,
        snapshotId: RESULT_FAILED.snapshotId,
      },
    };
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: RESULT_WITH_ANALYSIS };
    });
    const out: string[] = [];
    const got = await runResult(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_fe',
        includeAnalysis: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(seen[0]).toContain('includeAnalysis=true');
    expect(got.analysis).toEqual(RESULT_WITH_ANALYSIS.analysis);
    const block = out.join('\n');
    expect(block).toContain('rootCause:          Submit button is disabled');
    expect(block).toContain(
      'recommendedFix:    kind=code reference=src/components/CheckoutForm.tsx:412',
    );
  });

  it('--include-analysis renders "(none)" when recommendedFixTarget is null (visibility policy)', async () => {
    // M2.1 piece 3: a failing test with no LLM-filled fix target now
    // arrives with `analysis.recommendedFixTarget: null`. The text
    // renderer surfaces this with a pointed user-facing string rather
    // than echoing the raw null shape.
    const RESULT_WITH_NULL_FIX = {
      ...RESULT_FAILED,
      analysis: {
        rootCauseHypothesis: 'timeout exceeded',
        recommendedFixTarget: null,
        failureKind: 'timeout' as const,
        snapshotId: RESULT_FAILED.snapshotId,
      },
    };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: RESULT_WITH_NULL_FIX }));
    const out: string[] = [];
    await runResult(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_fe',
        includeAnalysis: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    expect(block).toContain('rootCause:          timeout exceeded');
    expect(block).toContain('recommendedFix:    — (analysis pipeline did not propose one)');
  });

  // ---------- L141 — truncation indicator tests ----------

  it('L141: JSON mode adds rootCauseHypothesisTruncated=true when hypothesis ends with ellipsis', async () => {
    // The truncation heuristic requires length ≥ 500; pad to simulate a backend-truncated field.
    const TRUNCATED_HYPOTHESIS =
      'The submit button is disabled because the credit-card field validation failed and isFormValid() returned false, preventing the user from proceeding to the next step. ' +
      'The root cause is that the React context value for the credit-card validation state was not properly propagated through the component tree, causing the submit button ' +
      'to remain in a disabled state even after the user had filled in all required fields. The fix requires updating the context provider to correctly forward the validation state…';
    const RESULT_WITH_TRUNCATED_ANALYSIS = {
      ...RESULT_FAILED,
      analysis: {
        rootCauseHypothesis: TRUNCATED_HYPOTHESIS,
        recommendedFixTarget: {
          kind: 'code' as const,
          reference: 'src/Checkout.tsx:42',
          rationale: 'isFormValid predicate is the gatekeeper.',
        },
        failureKind: 'assertion' as const,
        snapshotId: RESULT_FAILED.snapshotId,
      },
    };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: RESULT_WITH_TRUNCATED_ANALYSIS }));
    const out: string[] = [];
    await runResult(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_fe',
        includeAnalysis: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const parsed = JSON.parse(out[0]!);
    expect(parsed.analysis.rootCauseHypothesisTruncated).toBe(true);
    expect(parsed.analysis.recommendedFixRationaleTruncated).toBeUndefined();
  });

  it('L141: JSON mode adds recommendedFixRationaleTruncated=true when rationale ends with ellipsis', async () => {
    // The truncation heuristic requires length ≥ 500; pad to simulate a backend-truncated field.
    const TRUNCATED_RATIONALE =
      'The isFormValid() predicate at line 412 checks all required fields; the credit-card field validation state is propagated via React context and reaches the submit button disabled state. ' +
      'To fix this, update the CardFieldContext provider at src/contexts/CardFieldContext.tsx to ensure the isValid flag is forwarded correctly to the useFormValidation hook consumed ' +
      'by the SubmitButton component. Once the validation state propagates correctly the button will re-enable when all fields pass their validators…';
    const RESULT_WITH_TRUNCATED_RATIONALE = {
      ...RESULT_FAILED,
      analysis: {
        rootCauseHypothesis: 'Submit button is disabled.',
        recommendedFixTarget: {
          kind: 'code' as const,
          reference: 'src/Checkout.tsx:412',
          rationale: TRUNCATED_RATIONALE,
        },
        failureKind: 'assertion' as const,
        snapshotId: RESULT_FAILED.snapshotId,
      },
    };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: RESULT_WITH_TRUNCATED_RATIONALE }));
    const out: string[] = [];
    await runResult(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_fe',
        includeAnalysis: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const parsed = JSON.parse(out[0]!);
    expect(parsed.analysis.rootCauseHypothesisTruncated).toBeUndefined();
    expect(parsed.analysis.recommendedFixRationaleTruncated).toBe(true);
  });

  it('L141: JSON mode adds both truncation indicators when both fields are truncated', async () => {
    // The truncation heuristic requires length ≥ 500; pad both fields.
    const longHypothesis =
      'Hypothesis that was cut short by the server — the submit button remained disabled because the React context did not propagate the validation state correctly through the component tree. ' +
      'Several intermediate components consumed the context but did not forward the updated value, leaving the leaf SubmitButton with a stale disabled=true derived from the initial render. ' +
      'Traced to CardFieldContext provider at src/contexts/CardFieldContext.tsx line 112 where the isValid flag is not memoized and is recomputed incorrectly on every re-render cycle…';
    const longRationale =
      'Rationale that was also cut short by the server — to fix this update the CardFieldContext provider to ensure isValid is forwarded. The useFormValidation hook consumed by SubmitButton ' +
      'reads from the context on every render cycle; once the provider emits the correct value the button will re-enable when all required fields pass their individual validation rules. ' +
      'The key change is in CardFieldContext.tsx: wrap the derived isValid computation in useMemo so it only recomputes when the field values change, not on every parent re-render…';
    const RESULT_BOTH_TRUNCATED = {
      ...RESULT_FAILED,
      analysis: {
        rootCauseHypothesis: longHypothesis,
        recommendedFixTarget: {
          kind: 'code' as const,
          reference: 'src/Form.tsx:5',
          rationale: longRationale,
        },
        failureKind: 'assertion' as const,
        snapshotId: RESULT_FAILED.snapshotId,
      },
    };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: RESULT_BOTH_TRUNCATED }));
    const out: string[] = [];
    await runResult(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_fe',
        includeAnalysis: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const parsed = JSON.parse(out[0]!);
    expect(parsed.analysis.rootCauseHypothesisTruncated).toBe(true);
    expect(parsed.analysis.recommendedFixRationaleTruncated).toBe(true);
  });

  it('L141: JSON mode omits truncation indicators when neither field is truncated', async () => {
    const RESULT_NO_TRUNCATION = {
      ...RESULT_FAILED,
      analysis: {
        rootCauseHypothesis: 'Submit button is disabled.',
        recommendedFixTarget: {
          kind: 'code' as const,
          reference: 'src/Checkout.tsx:412',
          rationale: 'isFormValid() is the gatekeeper.',
        },
        failureKind: 'assertion' as const,
        snapshotId: RESULT_FAILED.snapshotId,
      },
    };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: RESULT_NO_TRUNCATION }));
    const out: string[] = [];
    await runResult(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_fe',
        includeAnalysis: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const parsed = JSON.parse(out[0]!);
    expect(parsed.analysis.rootCauseHypothesisTruncated).toBeUndefined();
    expect(parsed.analysis.recommendedFixRationaleTruncated).toBeUndefined();
  });

  it('L141: text mode does NOT add truncation indicator markers (renderer unchanged)', async () => {
    const RESULT_WITH_TRUNCATED = {
      ...RESULT_FAILED,
      analysis: {
        rootCauseHypothesis: 'Truncated hypothesis…',
        recommendedFixTarget: null,
        failureKind: 'assertion' as const,
        snapshotId: RESULT_FAILED.snapshotId,
      },
    };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: RESULT_WITH_TRUNCATED }));
    const out: string[] = [];
    await runResult(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_fe',
        includeAnalysis: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    // Text mode shows the raw (possibly truncated) value; no indicator suffix appended
    expect(block).toContain('Truncated hypothesis…');
    // Specifically: no "rootCauseHypothesisTruncated" key/line added by text renderer
    expect(block).not.toContain('rootCauseHypothesisTruncated');
    expect(block).not.toContain('recommendedFixRationaleTruncated');
  });

  it('L141: truncation indicators are NOT present in returned result object (only in printed JSON)', async () => {
    const RESULT_WITH_TRUNCATED = {
      ...RESULT_FAILED,
      analysis: {
        rootCauseHypothesis: 'Truncated hypothesis…',
        recommendedFixTarget: null,
        failureKind: 'assertion' as const,
        snapshotId: RESULT_FAILED.snapshotId,
      },
    };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: RESULT_WITH_TRUNCATED }));
    const result = await runResult(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_fe',
        includeAnalysis: true,
      },
      { credentialsPath, fetchImpl, stdout: () => {} },
    );
    // The returned object is the raw backend response — indicators only in the printed JSON
    expect(result.analysis?.rootCauseHypothesisTruncated).toBeUndefined();
  });
});

// ---------- D1 — targetUrlSource advisory (null targetUrl + unresolved source) ----------

describe('runResult — D1 targetUrlSource', () => {
  it('text mode: null targetUrl + targetUrlSource=unresolved emits advisory to stderr without crashing', async () => {
    const { credentialsPath } = makeCreds();
    const unresolved: CliLatestResult = {
      ...RESULT_FAILED,
      targetUrl: null,
      targetUrlSource: 'unresolved',
    };
    const fetchImpl = makeFetch(() => ({ body: unresolved }));
    const out: string[] = [];
    const stderrLines: string[] = [];
    await runResult(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => out.push(line),
        stderr: line => stderrLines.push(line),
      },
    );
    // Must not print literal "null" for targetUrl
    const block = out.join('\n');
    expect(block).not.toContain('targetUrl:          null');
    expect(block).not.toContain('targetUrl: null');
    // Advisory must appear on stderr
    const advisory = stderrLines.find(l => l.includes('[advisory]') && l.includes('target URL'));
    expect(advisory).toBeDefined();
    expect(advisory).toContain('unresolved');
  });

  it('text mode: null targetUrl + targetUrlSource=null also emits advisory', async () => {
    const { credentialsPath } = makeCreds();
    const nullSource: CliLatestResult = {
      ...RESULT_FAILED,
      targetUrl: null,
      targetUrlSource: null,
    };
    const fetchImpl = makeFetch(() => ({ body: nullSource }));
    const stderrLines: string[] = [];
    await runResult(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
      },
    );
    const advisory = stderrLines.find(l => l.includes('[advisory]') && l.includes('target URL'));
    expect(advisory).toBeDefined();
  });

  it('text mode: normal non-null targetUrl emits no advisory', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { ...RESULT_FAILED, targetUrl: 'https://example.com', targetUrlSource: 'run' },
    }));
    const stderrLines: string[] = [];
    await runResult(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
      },
    );
    expect(stderrLines.some(l => l.includes('[advisory]') && l.includes('target URL'))).toBe(false);
  });

  it('JSON mode: passes targetUrl (null) + targetUrlSource through unchanged without advisory', async () => {
    const { credentialsPath } = makeCreds();
    const unresolved: CliLatestResult = {
      ...RESULT_FAILED,
      targetUrl: null,
      targetUrlSource: 'unresolved',
    };
    const fetchImpl = makeFetch(() => ({ body: unresolved }));
    const out: string[] = [];
    const stderrLines: string[] = [];
    const got = await runResult(
      { profile: 'default', output: 'json', debug: false, testId: 'test_fe' },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => out.push(line),
        stderr: line => stderrLines.push(line),
      },
    );
    // JSON output must include both fields as-is
    const parsed = JSON.parse(out.join('\n')) as CliLatestResult;
    expect(parsed.targetUrl).toBeNull();
    expect(parsed.targetUrlSource).toBe('unresolved');
    // Returned value also carries the field
    expect(got.targetUrlSource).toBe('unresolved');
    // No advisory in JSON mode
    expect(stderrLines.some(l => l.includes('[advisory]'))).toBe(false);
  });
});

// ---------- §5.2 / M2.1 piece 3 — runFailureSummary ----------

describe('runFailureSummary', () => {
  const SUMMARY = {
    testId: 'test_fe',
    status: 'failed' as const,
    failureKind: 'assertion' as const,
    snapshotId: 'snap_summary_xyz',
    rootCauseHypothesis: 'Submit button is disabled because the credit-card field is empty.',
    recommendedFixTarget: {
      kind: 'code' as const,
      reference: 'src/components/CheckoutForm.tsx:412',
      rationale: 'Disabled state originates from `isFormValid()` predicate.',
    },
  };

  it('JSON mode prints the §5.2 wire envelope verbatim', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: SUMMARY };
    });
    const out: string[] = [];
    const got = await runFailureSummary(
      { profile: 'default', output: 'json', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(seen[0]).toContain('/tests/test_fe/failure/summary');
    expect(got).toEqual(SUMMARY);
    expect(JSON.parse(out[0]!)).toEqual(SUMMARY);
  });

  it('text mode renders the one-screen triage card', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: SUMMARY }));
    const out: string[] = [];
    await runFailureSummary(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    expect(block).toContain('testId:               test_fe');
    expect(block).toContain('status:               failed');
    expect(block).toContain('failureKind:          assertion');
    expect(block).toContain('rootCauseHypothesis:  Submit button is disabled');
    expect(block).toContain('recommendedFixTarget: kind=code');
  });

  it('text mode renders "(none)" when recommendedFixTarget is null (visibility policy)', async () => {
    const NULL_FIX_SUMMARY = { ...SUMMARY, recommendedFixTarget: null };
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: NULL_FIX_SUMMARY }));
    const out: string[] = [];
    await runFailureSummary(
      { profile: 'default', output: 'text', debug: false, testId: 'test_fe' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(out.join('\n')).toContain(
      'recommendedFixTarget: — (analysis pipeline did not propose one)',
    );
  });

  it('NOT_FOUND with details.reason="no_failing_run" propagates as exit 4', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 404,
      body: {
        error: {
          code: 'NOT_FOUND',
          message: 'Test has no failing run.',
          nextAction:
            'Test has no failing run. Use `testsprite test result <test-id>` to inspect the latest result.',
          requestId: 'req_test',
          details: { resource: 'test', id: 'test_passing', reason: 'no_failing_run' },
        },
      },
    }));
    await expect(
      runFailureSummary(
        { profile: 'default', output: 'json', debug: false, testId: 'test_passing' },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      exitCode: 4,
      details: { reason: 'no_failing_run' },
    });
  });
});

// ---------- §6.7 runFailureGet ----------

const FAILED_STEPS: CliTestStep[] = [
  {
    testId: 'test_failed',
    stepIndex: 4,
    action: 'click',
    description: 'Click the cart icon',
    status: 'passed',
    screenshotUrl: null,
    htmlSnapshotUrl: 'https://signed.example.com/04.html?sig',
    runIdIfAvailable: 'run_abc',
    codeVersion: 'v3',
    capturedAt: '2026-05-05T12:34:55.000Z',
    updatedAt: '2026-05-05T12:34:56.000Z',
  },
  {
    testId: 'test_failed',
    stepIndex: 5,
    action: 'click',
    description: 'Click the submit button',
    status: 'failed',
    screenshotUrl: null,
    htmlSnapshotUrl: 'https://signed.example.com/05.html?sig',
    runIdIfAvailable: 'run_abc',
    codeVersion: 'v3',
    capturedAt: '2026-05-05T12:34:56.000Z',
    updatedAt: '2026-05-05T12:34:56.000Z',
  },
  {
    testId: 'test_failed',
    stepIndex: 6,
    action: 'expect',
    description: 'Expect order confirmation heading',
    status: null,
    screenshotUrl: null,
    htmlSnapshotUrl: 'https://signed.example.com/06.html?sig',
    runIdIfAvailable: 'run_abc',
    codeVersion: 'v3',
    capturedAt: null,
    updatedAt: '2026-05-05T12:34:58.000Z',
  },
];

function makeFailureContext(overrides: Partial<CliFailureContext> = {}): CliFailureContext {
  const result: CliLatestResult = {
    testId: 'test_failed',
    status: 'failed',
    startedAt: '2026-05-05T12:34:00.000Z',
    finishedAt: '2026-05-05T12:34:58.000Z',
    videoUrl: 'https://video.example.com/run_abc.mp4?sig',
    failureAnalysisUrl: null,
    snapshotId: 'snap_2026_05_07_b2f9a1c8',
    runIdIfAvailable: 'run_abc',
    codeVersion: 'v3',
    targetUrl: 'https://staging.example.com/checkout',
    failedStepIndex: 5,
    failureKind: 'assertion',
    verdict: 'failed',
    executionStatus: 'completed',
    summary: 'Failed (assertion) on step 5: assertion error.',
    ...overrides.result,
  };
  return {
    snapshotId: 'snap_2026_05_07_b2f9a1c8',
    testId: 'test_failed',
    projectId: 'project_alice',
    result,
    steps: FAILED_STEPS,
    code: {
      testId: 'test_failed',
      language: 'typescript',
      framework: 'playwright',
      code: "import { test } from '@playwright/test';\n",
      codeVersion: 'v3',
      etag: null,
    },
    failure: {
      rootCauseHypothesis:
        'Submit button is disabled. Underlying error: AssertionError: expected visible.',
      recommendedFixTarget: { kind: 'unknown', reference: null, rationale: 'fill card field' },
      evidence: [
        {
          kind: 'snapshot',
          stepIndex: 4,
          url: 'https://signed.example.com/ev/04.html?sig',
          summary: "Step 4 'Click the cart icon' passed (captured at ...).",
        },
        {
          kind: 'snapshot',
          stepIndex: 5,
          url: 'https://signed.example.com/ev/05.html?sig',
          summary: "Step 5 'Click the submit button' failed. Error: AssertionError",
        },
      ],
    },
    ...overrides,
  };
}

describe('runFailureGet', () => {
  it('--out rejects an empty path with VALIDATION_ERROR (exit 5) before any network I/O', async () => {
    const { credentialsPath } = makeCreds();
    let fetchCalls = 0;
    const fetchImpl = makeFetch(() => {
      fetchCalls += 1;
      return { body: makeFailureContext() };
    });
    await expect(
      runFailureGet(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_failed',
          failedOnly: false,
          out: '',
        },
        { credentialsPath, fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(fetchCalls).toBe(0);
  });

  it('--out rejects a path under a missing parent dir with VALIDATION_ERROR (exit 5) before any network I/O', async () => {
    const { credentialsPath } = makeCreds();
    let fetchCalls = 0;
    const fetchImpl = makeFetch(() => {
      fetchCalls += 1;
      return { body: makeFailureContext() };
    });
    await expect(
      runFailureGet(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          testId: 'test_failed',
          failedOnly: false,
          out: `/tmp/_p5_no_such_dir_${process.pid}_${Date.now()}/bundle`,
        },
        { credentialsPath, fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(fetchCalls).toBe(0);
  });

  it('JSON mode (no --out) prints the wire envelope verbatim to stdout', async () => {
    const { credentialsPath } = makeCreds();
    const ctx = makeFailureContext();
    const fetchImpl = makeFetch(url => {
      expect(url).toContain('/tests/test_failed/failure');
      return { body: ctx };
    });
    const out: string[] = [];
    const result = await runFailureGet(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_failed',
        failedOnly: false,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(result.context).toEqual(ctx);
    expect(result.bundle).toBeUndefined();
    // Single JSON envelope on stdout — agents pipe directly into jq /
    // their LLM consumer.
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual(ctx);
  });

  it('text mode (no --out) prints the human summary block', async () => {
    const { credentialsPath } = makeCreds();
    const ctx = makeFailureContext();
    const fetchImpl = makeFetch(() => ({ body: ctx }));
    const out: string[] = [];
    await runFailureGet(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_failed',
        failedOnly: false,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    expect(block).toContain('status:           failed');
    expect(block).toContain('failureKind:      assertion');
    expect(block).toContain('failedStepIndex:  5');
    expect(block).toContain('snapshotId:       snap_2026_05_07_b2f9a1c8');
    expect(block).toContain('runId:            run_abc');
    expect(block).toContain('rootCause:        Submit button is disabled.');
    expect(block).toContain('recommendedFix:   kind=unknown');
    expect(block).toContain('evidence:         2 items (snapshot×2)');
    expect(block).toContain('videoUrl:         https://video.example.com');
  });

  it('--out writes the §7 layout and prints a one-line confirmation', async () => {
    const { credentialsPath } = makeCreds();
    const ctx = makeFailureContext();
    const fetchImpl = makeFetch(url => {
      // Presigned URL fetches return a 200 with a tiny body — covers
      // the snapshot HTML / video / evidence-html paths.
      if (url.startsWith('https://signed.example.com')) {
        return { body: '<html>snapshot</html>' };
      }
      if (url.startsWith('https://video.example.com')) {
        return { body: 'fake-video-bytes' };
      }
      // /tests/.../failure
      return { body: ctx };
    });
    const dir = mkdtempSync(join(tmpdir(), 'cli-p5-bundle-'));
    const out: string[] = [];
    const result = await runFailureGet(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_failed',
        failedOnly: false,
        out: dir,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(result.bundle).toBeDefined();
    expect(result.bundle!.dir).toBe(dir);
    // §7.1: meta.json is the identity card. Its presence is the
    // atomic-completion signal — agents read it first.
    const metaPath = join(dir, 'meta.json');
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
    expect(meta.snapshotId).toBe(ctx.snapshotId);
    expect(meta.testId).toBe(ctx.testId);
    expect(meta.failedStepIndex).toBe(5);
    expect(meta.schemaVersion).toBe('cli-v1');
    // Top-level files exist.
    expect(existsSync(join(dir, 'result.json'))).toBe(true);
    expect(existsSync(join(dir, 'failure.json'))).toBe(true);
    // language=typescript → code.ts (matches the test's framework).
    expect(existsSync(join(dir, 'code.ts'))).toBe(true);
    // videoUrl was non-null → video.mp4 written.
    expect(existsSync(join(dir, 'video.mp4'))).toBe(true);
    // Per-step snapshot files for ±1 around step 5.
    expect(existsSync(join(dir, 'steps', '04-snapshot.html'))).toBe(true);
    expect(existsSync(join(dir, 'steps', '05-snapshot.html'))).toBe(true);
    expect(existsSync(join(dir, 'steps', '06-snapshot.html'))).toBe(true);
    // .partial NOT present on success.
    expect(existsSync(join(dir, '.partial'))).toBe(false);
    // Confirmation line on stdout.
    expect(out.join('\n')).toContain(`Bundle written to ${dir}`);
  });

  it('--out --failed-only narrows steps to the failed step ± 1 (drops outside-window)', async () => {
    const { credentialsPath } = makeCreds();
    // Wider step list — failed at 5, neighbors {3,4,6,7}. With --failed-only
    // the bundle keeps only 4/5/6.
    const wideSteps: CliTestStep[] = [3, 4, 5, 6, 7].map(i => ({
      testId: 'test_failed',
      stepIndex: i,
      action: 'click',
      description: `step ${i}`,
      status: i === 5 ? ('failed' as const) : ('passed' as const),
      screenshotUrl: null,
      htmlSnapshotUrl: `https://signed.example.com/${String(i).padStart(2, '0')}.html`,
      runIdIfAvailable: 'run_abc',
      codeVersion: 'v3',
      capturedAt: null,
      updatedAt: '2026-05-05T12:34:56.000Z',
    }));
    const ctx = makeFailureContext({
      steps: wideSteps,
      failure: {
        rootCauseHypothesis: null,
        recommendedFixTarget: { kind: 'unknown', reference: null, rationale: null },
        evidence: wideSteps.map(s => ({
          kind: 'snapshot' as const,
          stepIndex: s.stepIndex,
          url: `https://signed.example.com/ev/${String(s.stepIndex).padStart(2, '0')}.html`,
          summary: `step ${s.stepIndex} summary`,
        })),
      },
    });
    const fetchImpl = makeFetch(url => {
      if (url.includes('/failure')) return { body: ctx };
      return { body: '<html>x</html>' };
    });
    const dir = mkdtempSync(join(tmpdir(), 'cli-p5-failedonly-'));
    await runFailureGet(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_failed',
        failedOnly: true,
        out: dir,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    // Failed step ±1 stays; 3 and 7 dropped.
    expect(existsSync(join(dir, 'steps', '04-snapshot.html'))).toBe(true);
    expect(existsSync(join(dir, 'steps', '05-snapshot.html'))).toBe(true);
    expect(existsSync(join(dir, 'steps', '06-snapshot.html'))).toBe(true);
    expect(existsSync(join(dir, 'steps', '03-snapshot.html'))).toBe(false);
    expect(existsSync(join(dir, 'steps', '07-snapshot.html'))).toBe(false);
  });

  it('refuses a forged bundle with mismatched snapshotId (agent-safety trap)', async () => {
    // §3 invariant: bundle.snapshotId === result.snapshotId, byte-for-byte.
    // A forged response where they disagree must NOT be written to disk —
    // an agent reading the meta would see one snapshotId, the result file
    // would have another, and the bundle would be corrupt.
    const { credentialsPath } = makeCreds();
    const ctx = makeFailureContext({
      result: {
        ...makeFailureContext().result,
        snapshotId: 'snap_DIFFERENT', // mismatch
      },
    });
    const fetchImpl = makeFetch(() => ({ body: ctx }));
    const dir = mkdtempSync(join(tmpdir(), 'cli-p5-forged-'));
    await expect(
      runFailureGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_failed',
          failedOnly: false,
          out: dir,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    // Nothing visible was written; meta.json was never renamed in.
    expect(existsSync(join(dir, 'meta.json'))).toBe(false);
  });

  it('refuses a forged bundle when steps disagree on runIdIfAvailable', async () => {
    const { credentialsPath } = makeCreds();
    const [first, second] = FAILED_STEPS as [CliTestStep, CliTestStep, CliTestStep];
    const stepsMixed: CliTestStep[] = [
      { ...first, runIdIfAvailable: 'run_a' },
      { ...second, runIdIfAvailable: 'run_b' },
    ];
    const ctx = makeFailureContext({ steps: stepsMixed });
    const fetchImpl = makeFetch(() => ({ body: ctx }));
    await expect(
      runFailureGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_failed',
          failedOnly: false,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('writes <dir>/.partial and exits non-zero when a presigned download fails', async () => {
    const { credentialsPath } = makeCreds();
    const ctx = makeFailureContext();
    const fetchImpl = makeFetch(url => {
      if (url.includes('/failure')) return { body: ctx };
      // Force a 403 on the presigned URL (URL expired). Per §6.3 the
      // CLI must NOT retry 4xx — it surfaces UNAVAILABLE / exit 10.
      return { status: 403, body: { error: 'expired' } };
    });
    const dir = mkdtempSync(join(tmpdir(), 'cli-p5-partial-'));
    await expect(
      runFailureGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_failed',
          failedOnly: false,
          out: dir,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    // .partial marker exists; meta.json does NOT (bundle incomplete).
    expect(existsSync(join(dir, '.partial'))).toBe(true);
    expect(existsSync(join(dir, 'meta.json'))).toBe(false);
    const partial = JSON.parse(readFileSync(join(dir, '.partial'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(partial.snapshotId).toBe(ctx.snapshotId);
    expect(typeof partial.error).toBe('string');
  });

  it('404 NOT_FOUND propagates to ApiError (exit 4) and writes nothing', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 404,
      body: {
        error: {
          code: 'NOT_FOUND',
          message: 'Test has no failing run.',
          nextAction: 'Test has no failing run. Use `testsprite test result <test-id>`.',
          requestId: 'req_test',
          details: { resource: 'test', id: 'test_passing', reason: 'no_failing_run' },
        },
      },
    }));
    const dir = mkdtempSync(join(tmpdir(), 'cli-p5-404-'));
    await expect(
      runFailureGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_passing',
          failedOnly: false,
          out: dir,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', exitCode: 4 });
    // Nothing written on 404 — pre-existing <dir> is unmodified per §9.
    expect(existsSync(join(dir, 'meta.json'))).toBe(false);
    expect(existsSync(join(dir, '.partial'))).toBe(false);
  });

  it('CONFLICT envelope from /failure maps to exit 6 (snapshot in flight)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 409,
      body: {
        error: {
          code: 'CONFLICT',
          message: 'Snapshot in flight; retry shortly.',
          nextAction:
            'Snapshot in flight; retry in a few seconds. The CLI re-fetches against a single `snapshotId` so partial reads are safe.',
          requestId: 'req_test',
          details: { reason: 'snapshot_in_flight' },
        },
      },
    }));
    await expect(
      runFailureGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_failed',
          failedOnly: false,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT', exitCode: 6 });
  });

  it('in-place rewrite removes stale top-level files (codex P1)', async () => {
    // Pin: a second `--out` run against an existing dir replaces stale
    // top-level files (e.g. video.mp4 from a previous bundle whose
    // result had a videoUrl, when the new bundle has none) and removes
    // the old meta.json BEFORE renaming new files in. Without this,
    // an agent reading the dir mid-rewrite could see a fresh meta
    // pointing at the new snapshot but still see the prior run's
    // video.mp4. See codex review on lib/bundle.ts:375 for the bug.
    const { credentialsPath } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-p5-rewrite-'));

    // First run: bundle has a video.
    const firstCtx = makeFailureContext();
    const firstFetch = makeFetch(url => {
      if (url.includes('/failure')) return { body: firstCtx };
      return { body: 'fake-bytes' };
    });
    await runFailureGet(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_failed',
        failedOnly: false,
        out: dir,
      },
      { credentialsPath, fetchImpl: firstFetch, stdout: () => undefined },
    );
    expect(existsSync(join(dir, 'video.mp4'))).toBe(true);
    expect(existsSync(join(dir, 'meta.json'))).toBe(true);

    // Second run: bundle has NO video (e.g. backend cleared the
    // videoUrl, or the snapshot was minted before the recording
    // landed). Stale video.mp4 from the first run must NOT linger.
    const secondCtx = makeFailureContext({
      snapshotId: 'snap_2026_05_07_NEW',
      result: { ...makeFailureContext().result, snapshotId: 'snap_2026_05_07_NEW', videoUrl: null },
    });
    const secondFetch = makeFetch(url => {
      if (url.includes('/failure')) return { body: secondCtx };
      return { body: 'fake-bytes' };
    });
    await runFailureGet(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_failed',
        failedOnly: false,
        out: dir,
      },
      { credentialsPath, fetchImpl: secondFetch, stdout: () => undefined },
    );
    // Stale video.mp4 swept; new meta in place.
    expect(existsSync(join(dir, 'video.mp4'))).toBe(false);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(meta.snapshotId).toBe('snap_2026_05_07_NEW');
  });

  it('downloads log/network/console evidence URLs into per-evidence files (codex P2)', async () => {
    // Pin: when the backend emits non-snapshot/screenshot evidence
    // (kind: log|network|console), the CLI dereferences each URL into
    // a per-evidence file under steps/, and the <NN>-evidence.json
    // sidecar references the local path instead of the (soon-expired)
    // presigned URL.
    const { credentialsPath } = makeCreds();
    const ctx = makeFailureContext({
      failure: {
        rootCauseHypothesis: null,
        recommendedFixTarget: { kind: 'unknown', reference: null, rationale: null },
        evidence: [
          // Snapshot evidence is the existing path — sanity check it
          // still goes into <NN>-snapshot.html.
          {
            kind: 'snapshot' as const,
            stepIndex: 5,
            url: 'https://signed.example.com/ev/05.html?sig',
            summary: 'snapshot summary',
          },
          {
            kind: 'console' as const,
            stepIndex: 5,
            url: 'https://signed.example.com/ev/05-console.json?sig',
            summary: 'console summary',
          },
          {
            kind: 'log' as const,
            stepIndex: 5,
            url: 'https://signed.example.com/ev/05-log.txt?sig',
            summary: 'log summary',
          },
        ],
      },
    });
    const seenUrls: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/failure')) return { body: ctx };
      seenUrls.push(url);
      return { body: 'evidence-body' };
    });
    const dir = mkdtempSync(join(tmpdir(), 'cli-p5-evidence-'));
    await runFailureGet(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_failed',
        failedOnly: false,
        out: dir,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    // Per codex round-1 P2 (re-run): every `evidence[].url` must be
    // dereferenced. The snapshot evidence URL here
    // (`/ev/05.html?sig`) differs from `step.htmlSnapshotUrl`
    // (`/05.html?sig`), so it cannot be deduped against the
    // already-downloaded step file — it must be streamed to its own
    // sidecar file. Console + log get their own files too.
    expect(existsSync(join(dir, 'steps', '05-snapshot-0.html'))).toBe(true);
    expect(existsSync(join(dir, 'steps', '05-console-1.json'))).toBe(true);
    expect(existsSync(join(dir, 'steps', '05-log-2.txt'))).toBe(true);
    // The sidecar JSON references the local path, not the URL.
    const sidecar = JSON.parse(
      readFileSync(join(dir, 'steps', '05-evidence.json'), 'utf8'),
    ) as Array<{ kind: string; path?: string; url?: string }>;
    expect(sidecar).toHaveLength(3);
    expect(sidecar[0]!.kind).toBe('snapshot');
    expect(sidecar[0]!.path).toBe('steps/05-snapshot-0.html');
    expect(sidecar[0]!.url).toBeUndefined();
    expect(sidecar[1]!.kind).toBe('console');
    expect(sidecar[1]!.path).toBe('steps/05-console-1.json');
    expect(sidecar[1]!.url).toBeUndefined();
    expect(sidecar[2]!.kind).toBe('log');
    expect(sidecar[2]!.path).toBe('steps/05-log-2.txt');
    // All three evidence URLs were actually fetched.
    expect(seenUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining('05.html?sig'),
        expect.stringContaining('05-console.json'),
        expect.stringContaining('05-log.txt'),
      ]),
    );
  });

  it('reuses the step snapshot/screenshot file when an evidence URL matches it (codex P2 dedupe)', async () => {
    const { credentialsPath } = makeCreds();
    const baseCtx = makeFailureContext();
    // Find the step whose htmlSnapshotUrl is set (the 05 step) and
    // reuse its URL in the evidence list. Path-match should kick in
    // and NO new file is downloaded for the snapshot evidence.
    const step05 = baseCtx.steps.find(s => s.stepIndex === 5)!;
    const ctx = makeFailureContext({
      failure: {
        rootCauseHypothesis: null,
        recommendedFixTarget: { kind: 'unknown', reference: null, rationale: null },
        evidence: [
          {
            kind: 'snapshot' as const,
            stepIndex: 5,
            url: step05.htmlSnapshotUrl!,
            summary: 'snapshot dedupe',
          },
        ],
      },
    });
    const seenUrls: string[] = [];
    const fetchImpl = makeFetch(url => {
      if (url.includes('/failure')) return { body: ctx };
      seenUrls.push(url);
      return { body: 'evidence-body' };
    });
    const dir = mkdtempSync(join(tmpdir(), 'cli-p5-evidence-dedupe-'));
    await runFailureGet(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_failed',
        failedOnly: false,
        out: dir,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    // The snapshot evidence remapped to the existing step snapshot
    // file, not a new sidecar file.
    expect(existsSync(join(dir, 'steps', '05-snapshot.html'))).toBe(true);
    expect(existsSync(join(dir, 'steps', '05-snapshot-0.html'))).toBe(false);
    const sidecar = JSON.parse(
      readFileSync(join(dir, 'steps', '05-evidence.json'), 'utf8'),
    ) as Array<{ kind: string; path?: string; url?: string }>;
    expect(sidecar).toHaveLength(1);
    expect(sidecar[0]!.kind).toBe('snapshot');
    expect(sidecar[0]!.path).toBe('steps/05-snapshot.html');
    expect(sidecar[0]!.url).toBeUndefined();
    // Snapshot URL was fetched exactly once (for the step file), not
    // a second time for the evidence sidecar.
    const snapshotFetches = seenUrls.filter(u => u === step05.htmlSnapshotUrl);
    expect(snapshotFetches).toHaveLength(1);
  });

  it('refuses a bundle where result.codeVersion and code.codeVersion disagree (codex P3)', async () => {
    const { credentialsPath } = makeCreds();
    const ctx = makeFailureContext({
      result: { ...makeFailureContext().result, codeVersion: 'v3' },
      code: { ...makeFailureContext().code, codeVersion: 'v4' },
    });
    const fetchImpl = makeFetch(() => ({ body: ctx }));
    await expect(
      runFailureGet(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_failed',
          failedOnly: false,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: expect.objectContaining({ reason: 'code_version_mismatch' }),
    });
  });
});

describe('runCreate', () => {
  function writeCodeFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-p2-'));
    const path = join(dir, 'test.py');
    writeFileSync(path, contents, 'utf8');
    return path;
  }

  const SAMPLE_RESPONSE = {
    testId: 'test_new',
    type: 'frontend' as const,
    codeVersion: 'v1',
    createdAt: '2026-05-13T10:00:00.000Z',
  };

  it('POSTs /tests with the canonical body + Idempotency-Key + returns the response', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('test("smoke", async () => {});\n');
    type Captured = { url: string; method: string; body: unknown; headers: Headers };
    const captured: Captured[] = [];
    const fetchImpl = makeFetch((url, init) => {
      const method = init.method ?? 'GET';
      captured.push({
        url,
        method,
        body: init.body ? JSON.parse(init.body as string) : undefined,
        headers: new Headers(init.headers as Record<string, string>),
      });
      // Fix 4: best-effort duplicate-name check issues a GET /tests?projectId=... before POST.
      // Return empty listing for that pre-flight call; SAMPLE_RESPONSE for the actual POST.
      if (method === 'GET') return { status: 200, body: { items: [] } };
      return { status: 200, body: SAMPLE_RESPONSE };
    });

    const out: string[] = [];
    const res = await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_alice',
        type: 'frontend',
        name: 'sign-up happy',
        description: 'Cover the happy-path signup flow.',
        priority: 'p1',
        codeFile,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    expect(res).toEqual(SAMPLE_RESPONSE);
    // Fix 4 adds a pre-flight GET /tests listing before the POST; filter to POST only.
    const postCalls = captured.filter(c => c.method === 'POST');
    expect(postCalls).toHaveLength(1);
    const sent = postCalls[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toContain('/api/cli/v1/tests');
    expect(sent.body).toEqual({
      projectId: 'project_alice',
      type: 'frontend',
      name: 'sign-up happy',
      description: 'Cover the happy-path signup flow.',
      priority: 'p1',
      code: 'test("smoke", async () => {});\n',
    });
    // A UUIDv4 idempotency-key prefixed `cli-create-` is minted per call.
    expect(sent.headers.get('idempotency-key')).toMatch(/^cli-create-[0-9a-f-]{36}$/);
    expect(sent.headers.get('content-type')).toBe('application/json');
    expect(sent.headers.get('x-api-key')).toBe('sk-user-test');
  });

  it('respects a caller-supplied --idempotency-key (for safe retries)', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('code body');
    let seenKey: string | null = null;
    const fetchImpl = makeFetch((_url, init) => {
      seenKey = new Headers(init.headers as Record<string, string>).get('idempotency-key');
      return { body: SAMPLE_RESPONSE };
    });
    await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_alice',
        type: 'frontend',
        name: 'n',
        codeFile,
        idempotencyKey: 'op_42',
      },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    expect(seenKey).toBe('op_42');
  });

  it('rejects > 350 KB code body locally with PAYLOAD_TOO_LARGE (no fetch issued)', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('a'.repeat(350 * 1024 + 1));
    const fetchImpl = vi.fn();
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_alice',
          type: 'frontend',
          name: 'n',
          codeFile,
        },
        { credentialsPath, fetchImpl: fetchImpl as never, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE', exitCode: 5 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a missing --code-file surfaces VALIDATION_ERROR before any fetch', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn();
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_alice',
          type: 'frontend',
          name: 'n',
          codeFile: '/tmp/this-file-does-not-exist-xyz123.py',
        },
        { credentialsPath, fetchImpl: fetchImpl as never, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: expect.objectContaining({ field: 'code-file' }),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-Python (.ts) --code-file with VALIDATION_ERROR before any fetch (DEV-232)', async () => {
    const { credentialsPath } = makeCreds();
    // The file exists, so this isolates the extension gate (not ENOENT).
    const dir = mkdtempSync(join(tmpdir(), 'cli-p2-ts-'));
    const tsFile = join(dir, 'test.spec.ts');
    writeFileSync(tsFile, 'test("smoke", async () => {});\n', 'utf8');
    const fetchImpl = vi.fn();
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_alice',
          type: 'backend',
          name: 'n',
          codeFile: tsFile,
        },
        { credentialsPath, fetchImpl: fetchImpl as never, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: expect.objectContaining({ field: 'code-file' }),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts a Python (.py) --code-file (DEV-232)', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('import requests\n\n\ndef test_ok():\n    assert True\n');
    const fetchImpl = makeFetch((_url, init) => {
      const method = init.method ?? 'GET';
      if (method === 'GET') return { status: 200, body: { items: [] } };
      return { status: 200, body: SAMPLE_RESPONSE };
    });
    const res = await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_alice',
        type: 'backend',
        name: 'n',
        codeFile,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    expect(res).toEqual(SAMPLE_RESPONSE);
  });

  it('rejects a non-Python --code-file even under --dry-run (gate runs before the dry-run branch) (DEV-232)', async () => {
    // dry-run skips fs, but the extension gate is an up-front input check, so a
    // .ts file is rejected even in dry-run — the preview matches a real run.
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: true,
          projectId: 'project_alice',
          type: 'backend',
          name: 'n',
          codeFile: '/tmp/whatever-dry-run.spec.ts',
        },
        { stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: expect.objectContaining({ field: 'code-file' }),
    });
  });

  it('missing --project surfaces VALIDATION_ERROR (input gate before fs)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn();
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          // @ts-expect-error — exercising the runtime gate
          projectId: undefined,
          type: 'frontend',
          name: 'n',
          codeFile: '/tmp/whatever.txt',
        },
        { credentialsPath, fetchImpl: fetchImpl as never, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('AUTH_FORBIDDEN from the server (read-only key) propagates as exit 3', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('code body');
    const fetchImpl = makeFetch(() => ({
      status: 403,
      body: {
        error: {
          code: 'AUTH_FORBIDDEN',
          message: 'API key does not grant the required scope.',
          nextAction:
            'This API key does not have the required scope. Ask your account owner to extend it.',
          requestId: 'req_test',
          details: { requiredScope: 'write:tests' },
        },
      },
    }));
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_alice',
          type: 'frontend',
          name: 'n',
          codeFile,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN', exitCode: 3 });
  });

  it('IDEMPOTENCY_BODY_MISMATCH from the server is NOT retried (caller bug, exit 6)', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('a different body');
    let postCalls = 0;
    const fetchImpl = makeFetch((_url, init) => {
      const method = init.method ?? 'GET';
      // Fix 4: best-effort GET /tests listing fires before the POST; return empty listing.
      if (method === 'GET') return { status: 200, body: { items: [] } };
      postCalls += 1;
      return {
        status: 409,
        body: {
          error: {
            code: 'IDEMPOTENCY_BODY_MISMATCH',
            message: 'Idempotency-Key was reused with a different request body.',
            nextAction: 'Generate a new Idempotency-Key for the changed request.',
            requestId: 'req_test',
            details: { reason: 'body-mismatch', storedAt: '2026-05-13T09:00:00.000Z' },
          },
        },
      };
    });
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_alice',
          type: 'frontend',
          name: 'n',
          codeFile,
          idempotencyKey: 'op_42',
        },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_BODY_MISMATCH', exitCode: 6 });
    // IDEMPOTENCY_BODY_MISMATCH is NOT retried — only 1 POST should have been made.
    expect(postCalls).toBe(1);
  });

  it('--dry-run returns the canned sample (no fetchImpl needed; credentialsPath optional)', async () => {
    // Omitting both fetchImpl and credentialsPath proves dry-run skips
    // credential I/O AND substitutes the in-process dry-run fetch
    // (`makeHttpClient` swaps in `createDryRunFetch()` per `client-factory.ts`).
    const codeFile = writeCodeFile('any code');
    const res = await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        projectId: 'project_alice',
        type: 'frontend',
        name: 'n',
        codeFile,
      },
      { stdout: () => undefined, stderr: () => undefined },
    );
    expect(res).toMatchObject({
      testId: expect.any(String),
      type: 'frontend',
      codeVersion: 'v1',
      createdAt: expect.any(String),
    });
  });

  it('--dry-run skips fs entirely so a missing --code-file is not a blocker', async () => {
    // Codex round-1 fix: dry-run must work with dummy inputs (no real
    // disk dependency) to match the M2 P6 contract — operators shake
    // out the wire shape without a real test file on hand.
    const res = await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        projectId: 'project_alice',
        type: 'frontend',
        name: 'n',
        codeFile: '/tmp/this-file-does-not-exist-dry-run-xyz.py',
      },
      { stdout: () => undefined, stderr: () => undefined },
    );
    expect(res).toMatchObject({ testId: expect.any(String), codeVersion: 'v1' });
  });

  it('emits the generated idempotency-key to stderr under --verbose or --output json (Fix 1)', async () => {
    // Fix 1 (Fix 1 review fix): idempotency-key trailers are suppressed ONLY
    // in text mode without --verbose/--debug. In JSON output mode, the trailer
    // must still appear on stderr — stderr never pollutes JSON stdout, and
    // suppressing it was a silent regression for scripts running --output json.
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('code body');
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));

    // Text mode, no flags: key must NOT appear (noise reduction for humans).
    const stderrLinesTextDefault: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_alice',
        type: 'frontend',
        name: 'n',
        codeFile,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => stderrLinesTextDefault.push(line),
      },
    );
    expect(stderrLinesTextDefault.some(l => l.startsWith('idempotency-key:'))).toBe(false);

    // JSON output mode: key MUST appear on stderr (Fix 1 regression guard).
    const stderrLinesJson: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_alice',
        type: 'frontend',
        name: 'n',
        codeFile,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => stderrLinesJson.push(line),
      },
    );
    expect(stderrLinesJson.some(l => /^idempotency-key: cli-create-[0-9a-f-]{36}$/.test(l))).toBe(
      true,
    );

    // Text mode + --verbose: key must appear.
    const stderrLinesVerbose: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        verbose: true,
        projectId: 'project_alice',
        type: 'frontend',
        name: 'n',
        codeFile,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => stderrLinesVerbose.push(line),
      },
    );
    expect(
      stderrLinesVerbose.some(l => /^idempotency-key: cli-create-[0-9a-f-]{36}$/.test(l)),
    ).toBe(true);
  });

  it('does NOT echo a caller-supplied --idempotency-key (no second-channel disclosure)', async () => {
    // Counter-test for the round-1 surface: when the caller pinned the
    // key themselves, they already know it — don't re-print it. Keeps
    // the stderr line a "FYI for auto-generated keys" signal that the
    // operator can scan for.
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('code body');
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    const stderrLines: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_alice',
        type: 'frontend',
        name: 'n',
        codeFile,
        idempotencyKey: 'op_42',
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => stderrLines.push(line),
      },
    );
    expect(stderrLines.some(l => l.startsWith('idempotency-key:'))).toBe(false);
  });

  it('text mode prints one line per response field (no shell-incompatible chars)', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('code body');
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    const out: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_alice',
        type: 'frontend',
        name: 'n',
        codeFile,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    expect(block).toContain('testId      test_new');
    expect(block).toContain('type        frontend');
    expect(block).toContain('codeVersion v1');
    expect(block).toContain('createdAt   2026-05-13T10:00:00.000Z');
  });

  // C1 — --target-url advisory for backend tests (fires only when --run is also set)
  it('[C1] emits advisory on stderr when --type backend + --target-url + --run are all set', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('test("be", async () => {});');
    // Two responses: POST /tests (create) then POST /tests/{id}/runs (trigger)
    const fetchImpl = makeFetch(url => {
      if (url.includes('/runs')) {
        return {
          body: {
            runId: 'run_c1',
            status: 'queued',
            enqueuedAt: '2026-06-04T00:00:00.000Z',
            codeVersion: 'v1',
            targetUrl: 'https://staging.example.com',
          },
        };
      }
      return { body: { ...SAMPLE_RESPONSE, testId: 'test_c1', type: 'backend' } };
    });
    const stderrLines: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_be',
        type: 'backend',
        name: 'be test',
        codeFile,
        targetUrl: 'https://staging.example.com',
        run: true,
        wait: false,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => stderrLines.push(line),
      },
    );
    expect(
      stderrLines.some(
        l => l.includes('[advisory]') && l.includes('--target-url') && l.includes('backend'),
      ),
    ).toBe(true);
  });

  it('[C1] does NOT emit the backend advisory for frontend tests with --target-url', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('test("fe", async () => {});');
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    const stderrLines: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_fe',
        type: 'frontend',
        name: 'fe test',
        codeFile,
        targetUrl: 'https://staging.example.com',
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => stderrLines.push(line),
      },
    );
    // No advisory expected for frontend
    expect(
      stderrLines.some(
        l => l.includes('[advisory]') && l.includes('--target-url') && l.includes('backend'),
      ),
    ).toBe(false);
  });

  it('[C1] does NOT emit the backend advisory for backend tests without --target-url', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('test("be", async () => {});');
    const fetchImpl = makeFetch(() => ({ body: { ...SAMPLE_RESPONSE, type: 'backend' } }));
    const stderrLines: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_be',
        type: 'backend',
        name: 'be test',
        codeFile,
        // no targetUrl
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => stderrLines.push(line),
      },
    );
    expect(stderrLines.some(l => l.includes('[advisory]') && l.includes('--target-url'))).toBe(
      false,
    );
  });

  it('[C1 Fix 4] does NOT emit advisory when --type backend + --target-url but --run is absent', async () => {
    // targetUrl only matters at run time; a bare `test create --type backend
    // --target-url` without --run should NOT emit the advisory (it would be
    // confusing noise since the test isn't being executed).
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('test("be", async () => {});');
    const fetchImpl = makeFetch(() => ({ body: { ...SAMPLE_RESPONSE, type: 'backend' } }));
    const stderrLines: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_be',
        type: 'backend',
        name: 'be test',
        codeFile,
        targetUrl: 'https://staging.example.com',
        // --run not set → advisory must be suppressed
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => stderrLines.push(line),
      },
    );
    expect(stderrLines.some(l => l.includes('[advisory]') && l.includes('--target-url'))).toBe(
      false,
    );
  });

  it('[C1 Fix 4] emits advisory when --type backend + --target-url + --run are all set', async () => {
    // When --run is also passed the test will actually execute and the advisory
    // is meaningful. We verify the guard passes in this combined case.
    // We use --wait: false so the test doesn't need to mock a full run poll.
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('test("be", async () => {});');
    // Two responses: POST /tests (create), POST /tests/{id}/runs (trigger)
    let callCount = 0;
    const fetchImpl = makeFetch(url => {
      callCount += 1;
      if (url.includes('/runs')) {
        return {
          body: {
            runId: 'run_c1_fix4',
            status: 'queued',
            enqueuedAt: '2026-06-04T00:00:00.000Z',
            codeVersion: 'v1',
            targetUrl: 'https://staging.example.com',
          },
        };
      }
      return { body: { ...SAMPLE_RESPONSE, testId: 'test_c1_fix4', type: 'backend' } };
    });
    const stderrLines: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'project_be',
        type: 'backend',
        name: 'be test run',
        codeFile,
        targetUrl: 'https://staging.example.com',
        run: true,
        wait: false,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => stderrLines.push(line),
      },
    );
    expect(callCount).toBeGreaterThan(0);
    expect(
      stderrLines.some(
        l => l.includes('[advisory]') && l.includes('--target-url') && l.includes('backend'),
      ),
    ).toBe(true);
  });

  // Fix 4 — B3: duplicate-name advisory
  it('Fix 4 — emits advisory on stderr when a test with the same name exists, but still proceeds', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('// test code');
    let postCalled = false;
    const existingTest = {
      id: 'test_existing_abc',
      projectId: 'project_alice',
      name: 'Sign-up happy',
      type: 'frontend',
      createdFrom: 'portal',
      status: 'passed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'GET' && url.includes('/tests')) {
        // listing response with a same-name test
        return { body: { items: [existingTest], nextToken: null } };
      }
      if ((init.method ?? 'GET') === 'POST') {
        postCalled = true;
        return { body: SAMPLE_RESPONSE };
      }
      return { body: SAMPLE_RESPONSE };
    });

    const stderrLines: string[] = [];
    const result = await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_alice',
        type: 'frontend',
        name: 'sign-up happy', // case-insensitive match
        codeFile,
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: line => stderrLines.push(line) },
    );

    // Create still proceeds
    expect(result.testId).toBe('test_new');
    expect(postCalled).toBe(true);
    // Advisory on stderr mentioning the existing testId
    const advisoryLine = stderrLines.find(
      l => l.includes('[advisory]') && l.includes('test_existing_abc'),
    );
    expect(advisoryLine).toBeDefined();
    expect(advisoryLine).toContain('test update');
  });

  it('Fix 4 — swallows listing error and still proceeds with create', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('// test code');
    let listCalled = false;
    let postCalled = false;
    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'GET' && url.includes('/tests')) {
        listCalled = true;
        // Simulate a network or permission error (will be thrown via status 403)
        return {
          status: 403,
          body: {
            error: {
              code: 'AUTH_FORBIDDEN',
              message: 'Forbidden',
              nextAction: '',
              requestId: 'r1',
              details: {},
            },
          },
        };
      }
      if ((init.method ?? 'GET') === 'POST') {
        postCalled = true;
        return { body: SAMPLE_RESPONSE };
      }
      return { body: SAMPLE_RESPONSE };
    });

    const stderrLines: string[] = [];
    const result = await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_alice',
        type: 'frontend',
        name: 'another test',
        codeFile,
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: line => stderrLines.push(line) },
    );

    // Listing was attempted
    expect(listCalled).toBe(true);
    // But create still proceeded (error was swallowed)
    expect(postCalled).toBe(true);
    expect(result.testId).toBe('test_new');
    // No advisory emitted (no match found / error swallowed)
    expect(stderrLines.some(l => l.includes('[advisory]') && l.includes('already exists'))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// [B-E2E-03] Fix 3 regression — whitespace-only --name must exit 5 (trim guard)
// ---------------------------------------------------------------------------

describe('[B-E2E-03] runCreate: whitespace-only --name → VALIDATION_ERROR exit 5', () => {
  function writeCodeFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-fix3-name-'));
    const path = join(dir, 'test.py');
    writeFileSync(path, contents, 'utf8');
    return path;
  }

  it('single space --name → exit 5 (no network call)', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('// code');
    const fetchImpl = vi.fn();
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_abc',
          type: 'frontend',
          name: ' ',
          codeFile,
        },
        { credentialsPath, fetchImpl: fetchImpl as never, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('all-whitespace --name (multiple spaces) → exit 5 (no network call)', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('// code');
    const fetchImpl = vi.fn();
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_abc',
          type: 'frontend',
          name: '   ',
          codeFile,
        },
        { credentialsPath, fetchImpl: fetchImpl as never, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('tab-only --name → exit 5 (no network call)', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('// code');
    const fetchImpl = vi.fn();
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_abc',
          type: 'frontend',
          name: '\t\t',
          codeFile,
        },
        { credentialsPath, fetchImpl: fetchImpl as never, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('non-blank --name is accepted (control: no regression)', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('// code');
    const fetchImpl = makeFetch((url, init) => {
      // Return no-match for advisory GET, and success response for POST
      if ((init.method ?? 'GET') === 'GET') return { body: { items: [], nextToken: null } };
      return {
        body: {
          testId: 'test_fix3_ctrl',
          type: 'frontend',
          codeVersion: 'v1',
          createdAt: '2026-06-09T00:00:00.000Z',
        },
      };
    });
    // Should NOT throw — name has real content
    await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_abc',
        type: 'frontend',
        name: 'My real test name',
        codeFile,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );
    // If we get here without throwing, the test passed
  });
});

// ---------------------------------------------------------------------------
// M4 piece-2 — BE dependency authoring: --produces/--needs/--category
// ---------------------------------------------------------------------------

describe('runCreate — M4 BE dependency authoring flags', () => {
  function writeCodeFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-m4-dep-'));
    const path = join(dir, 'test.py');
    writeFileSync(path, contents, 'utf8');
    return path;
  }

  const BE_SAMPLE_RESPONSE = {
    testId: 'test_be_dep_01',
    type: 'backend' as const,
    codeVersion: 'v1',
    createdAt: '2026-06-09T00:00:00.000Z',
  };

  function makeFetch(
    handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
  ): typeof globalThis.fetch {
    return (async (input: Parameters<typeof globalThis.fetch>[0], init: RequestInit = {}) => {
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
    apiUrl = 'http://localhost:13503',
  ): { credentialsPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'cli-m4-creds-'));
    const credentialsPath = join(dir, 'credentials');
    mkdirSync(dir, { recursive: true });
    writeFileSync(credentialsPath, `[default]\napi_url = ${apiUrl}\napi_key = ${apiKey}\n`, {
      mode: 0o600,
    });
    return { credentialsPath };
  }

  it('threads produces[] → body.produces when --type backend', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('// producer code');
    type Captured = { body: Record<string, unknown> };
    const captured: Captured[] = [];
    const fetch = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { body: { items: [], nextToken: null } };
      captured.push({ body: JSON.parse(init.body as string) });
      return { body: BE_SAMPLE_RESPONSE };
    });
    await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_be',
        type: 'backend',
        name: 'create user',
        codeFile,
        produces: ['user_id', 'session_token'],
      },
      { credentialsPath, fetchImpl: fetch, stdout: () => undefined, stderr: () => undefined },
    );
    const postBody = captured.find(c => 'produces' in c.body)?.body;
    expect(postBody).toBeDefined();
    expect(postBody!.produces).toEqual(['user_id', 'session_token']);
    // wire field is `produces` (maps to captures on server)
    expect('consumes' in postBody!).toBe(false);
    expect('category' in postBody!).toBe(false);
  });

  it('threads needs[] → body.consumes (wire field) when --type backend', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('// consumer code');
    type Captured = { body: Record<string, unknown> };
    const captured: Captured[] = [];
    const fetch = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { body: { items: [], nextToken: null } };
      captured.push({ body: JSON.parse(init.body as string) });
      return { body: BE_SAMPLE_RESPONSE };
    });
    await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_be',
        type: 'backend',
        name: 'read user',
        codeFile,
        needs: ['user_id'],
      },
      { credentialsPath, fetchImpl: fetch, stdout: () => undefined, stderr: () => undefined },
    );
    const postBody = captured.find(c => 'consumes' in c.body)?.body;
    expect(postBody).toBeDefined();
    // CLI flag is --needs but wire field must be `consumes`
    expect(postBody!.consumes).toEqual(['user_id']);
    expect('produces' in postBody!).toBe(false);
  });

  it('threads category → body.category when --type backend', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('// teardown code');
    type Captured = { body: Record<string, unknown> };
    const captured: Captured[] = [];
    const fetch = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { body: { items: [], nextToken: null } };
      captured.push({ body: JSON.parse(init.body as string) });
      return { body: BE_SAMPLE_RESPONSE };
    });
    await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_be',
        type: 'backend',
        name: 'cleanup session',
        codeFile,
        category: 'teardown',
      },
      { credentialsPath, fetchImpl: fetch, stdout: () => undefined, stderr: () => undefined },
    );
    const postBody = captured.find(c => 'category' in c.body)?.body;
    expect(postBody).toBeDefined();
    expect(postBody!.category).toBe('teardown');
  });

  it('threads all three dep fields when all are set', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('// all-deps code');
    type Captured = { body: Record<string, unknown> };
    const captured: Captured[] = [];
    const fetch = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { body: { items: [], nextToken: null } };
      captured.push({ body: JSON.parse(init.body as string) });
      return { body: BE_SAMPLE_RESPONSE };
    });
    await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_be',
        type: 'backend',
        name: 'full dep test',
        codeFile,
        produces: ['order_id'],
        needs: ['user_id', 'session_token'],
        category: 'teardown',
      },
      { credentialsPath, fetchImpl: fetch, stdout: () => undefined, stderr: () => undefined },
    );
    const postBody = captured.find(c => 'produces' in c.body)?.body;
    expect(postBody!.produces).toEqual(['order_id']);
    expect(postBody!.consumes).toEqual(['user_id', 'session_token']);
    expect(postBody!.category).toBe('teardown');
  });

  it('does NOT include produces/consumes/category on the wire when arrays are empty', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('// plain be code');
    type Captured = { body: Record<string, unknown> };
    const captured: Captured[] = [];
    const fetch = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { body: { items: [], nextToken: null } };
      captured.push({ body: JSON.parse(init.body as string) });
      return { body: BE_SAMPLE_RESPONSE };
    });
    await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'project_be',
        type: 'backend',
        name: 'plain test',
        codeFile,
        produces: [], // empty → omitted
        needs: [], // empty → omitted
      },
      { credentialsPath, fetchImpl: fetch, stdout: () => undefined, stderr: () => undefined },
    );
    const postBody = captured[captured.length - 1]?.body;
    expect('produces' in (postBody ?? {})).toBe(false);
    expect('consumes' in (postBody ?? {})).toBe(false);
  });

  it('[FE guard] throws VALIDATION_ERROR exit 5 when --type frontend + --produces', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('// fe code');
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_fe',
          type: 'frontend',
          name: 'fe test',
          codeFile,
          produces: ['some_var'],
        },
        {
          credentialsPath,
          fetchImpl: () => Promise.resolve(new Response('{}')),
          stdout: () => undefined,
          stderr: () => undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('[FE guard] throws VALIDATION_ERROR exit 5 when --type frontend + --needs', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('// fe code');
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_fe',
          type: 'frontend',
          name: 'fe test',
          codeFile,
          needs: ['some_var'],
        },
        {
          credentialsPath,
          fetchImpl: () => Promise.resolve(new Response('{}')),
          stdout: () => undefined,
          stderr: () => undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('[FE guard] throws VALIDATION_ERROR exit 5 when --type frontend + --category', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('// fe code');
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_fe',
          type: 'frontend',
          name: 'fe test',
          codeFile,
          category: 'teardown',
        },
        {
          credentialsPath,
          fetchImpl: () => Promise.resolve(new Response('{}')),
          stdout: () => undefined,
          stderr: () => undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('[plan-from guard] --plan-from + --produces → exit 5 (dep flags are BE-only; plan-steps are FE)', async () => {
    const test = createTestCommand();
    disableExits(test);
    // The guard fires at the top of the --plan-from branch, before the plan file
    // is read — so a non-existent path still surfaces the dep-flag rejection first.
    await expect(
      test.parseAsync(
        ['create', '--plan-from', '/nonexistent-plan.json', '--produces', 'user_id'],
        { from: 'user' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('[FE guard] does NOT throw for --type backend with dep flags (no false-positive)', async () => {
    const { credentialsPath } = makeCreds();
    const codeFile = writeCodeFile('// be code');
    const fetch = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { body: { items: [], nextToken: null } };
      return { body: BE_SAMPLE_RESPONSE };
    });
    // Should resolve without error
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_be',
          type: 'backend',
          name: 'producer',
          codeFile,
          produces: ['x'],
          category: 'teardown',
        },
        { credentialsPath, fetchImpl: fetch, stdout: () => undefined, stderr: () => undefined },
      ),
    ).resolves.toMatchObject({ testId: BE_SAMPLE_RESPONSE.testId });
  });
});

describe('runPlanPut', () => {
  function writeStepsFile(payload: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-p6-'));
    const path = join(dir, 'refined-plan.json');
    writeFileSync(path, JSON.stringify(payload), 'utf8');
    return path;
  }

  const STEPS = [
    { type: 'action', description: 'navigate to /login' },
    { type: 'action', description: 'fill email = a@b.c' },
    { type: 'action', description: 'click submit without password' },
    { type: 'assertion', description: "error toast 'invalid password' appears" },
  ];

  const SAMPLE_RESPONSE = {
    testId: 'test_alpha',
    planStepsHash: 'sha256:abc123',
    stepCount: 4,
    updatedAt: '2026-05-14T10:00:00.000Z',
  };

  it('PUTs /tests/{id}/plan-steps with { planSteps } body + idempotency-key', async () => {
    const { credentialsPath } = makeCreds();
    const stepsFile = writeStepsFile({ planSteps: STEPS });
    type Captured = { url: string; method: string; body: unknown; headers: Headers };
    const captured: Captured[] = [];
    const fetchImpl = makeFetch((url, init) => {
      captured.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body as string) : undefined,
        headers: new Headers(init.headers as Record<string, string>),
      });
      return { status: 200, body: SAMPLE_RESPONSE };
    });

    const res = await runPlanPut(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        stepsFile,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );

    expect(res).toEqual(SAMPLE_RESPONSE);
    expect(captured).toHaveLength(1);
    const sent = captured[0]!;
    expect(sent.method).toBe('PUT');
    expect(sent.url).toContain('/api/cli/v1/tests/test_alpha/plan-steps');
    expect(sent.body).toEqual({ planSteps: STEPS });
    expect(sent.headers.get('idempotency-key')).toMatch(/^cli-plan-put-[0-9a-f-]{36}$/);
    // No If-Match-Step-Count header by default — FE is last-writer-wins.
    expect(sent.headers.get('if-match-step-count')).toBeNull();
    expect(sent.headers.get('content-type')).toBe('application/json');
  });

  // Dogfood 2026-05-18 — sibling of the --plan-from BOM regression. `--steps`
  // hits a separate JSON read path; lock both.
  it('accepts a steps file with a UTF-8 BOM (Windows PowerShell 5.1 default)', async () => {
    const { credentialsPath } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-p6-bom-'));
    const path = join(dir, 'refined-plan.json');
    writeFileSync(path, '﻿' + JSON.stringify({ planSteps: STEPS }), 'utf8');
    let seenBody: unknown;
    const fetchImpl = makeFetch((_url, init) => {
      seenBody = init.body ? JSON.parse(init.body as string) : undefined;
      return { body: SAMPLE_RESPONSE };
    });
    await runPlanPut(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        stepsFile: path,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );
    expect(seenBody).toEqual({ planSteps: STEPS });
  });

  it('accepts a bare planSteps[] array (without the wrapping object)', async () => {
    const { credentialsPath } = makeCreds();
    const stepsFile = writeStepsFile(STEPS);
    let seenBody: unknown;
    const fetchImpl = makeFetch((_url, init) => {
      seenBody = init.body ? JSON.parse(init.body as string) : undefined;
      return { body: SAMPLE_RESPONSE };
    });
    await runPlanPut(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        stepsFile,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );
    expect(seenBody).toEqual({ planSteps: STEPS });
  });

  it('sets If-Match-Step-Count when --expected-step-count is passed', async () => {
    const { credentialsPath } = makeCreds();
    const stepsFile = writeStepsFile({ planSteps: STEPS });
    let seen: string | null = null;
    const fetchImpl = makeFetch((_url, init) => {
      seen = new Headers(init.headers as Record<string, string>).get('if-match-step-count');
      return { body: SAMPLE_RESPONSE };
    });
    await runPlanPut(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        stepsFile,
        expectedStepCount: 4,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );
    expect(seen).toBe('4');
  });

  it('rejects an invalid --expected-step-count before sending', async () => {
    const { credentialsPath } = makeCreds();
    const stepsFile = writeStepsFile({ planSteps: STEPS });
    let called = 0;
    const fetchImpl = makeFetch(() => {
      called += 1;
      return { body: SAMPLE_RESPONSE };
    });
    await expect(
      runPlanPut(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_alpha',
          stepsFile,
          expectedStepCount: -1,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'expected-step-count' }),
    });
    expect(called).toBe(0);
  });

  it('rejects a missing steps file with VALIDATION_ERROR', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    await expect(
      runPlanPut(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_alpha',
          stepsFile: '/tmp/does-not-exist-piece6.json',
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects an empty planSteps array with a field pointer', async () => {
    const { credentialsPath } = makeCreds();
    const stepsFile = writeStepsFile({ planSteps: [] });
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    await expect(
      runPlanPut(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_alpha',
          stepsFile,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'planSteps' }),
    });
  });

  it('rejects a step with an invalid type', async () => {
    const { credentialsPath } = makeCreds();
    const stepsFile = writeStepsFile({
      planSteps: [{ type: 'observe', description: 'see thing' }],
    });
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    await expect(
      runPlanPut(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_alpha',
          stepsFile,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'planSteps[0].type' }),
    });
  });

  it('rejects oversize plan-step body (>200 steps) pre-flight', async () => {
    const { credentialsPath } = makeCreds();
    const planSteps = Array.from({ length: 201 }, (_, i) => ({
      type: 'action' as const,
      description: `step ${i}`,
    }));
    const stepsFile = writeStepsFile({ planSteps });
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    await expect(
      runPlanPut(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_alpha',
          stepsFile,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'planSteps' }),
    });
  });

  it('propagates a server 400 BE-rejection envelope unchanged (exit 5)', async () => {
    const { credentialsPath } = makeCreds();
    const stepsFile = writeStepsFile({ planSteps: STEPS });
    const fetchImpl = makeFetch(() => ({
      status: 400,
      body: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Backend test plan-steps cannot be updated via the CLI.',
          nextAction:
            "Use 'testsprite test code put <id> --code-file <path>' to update backend test code directly.",
          requestId: 'req_be_reject',
          details: { field: 'type', reason: 'backend not supported' },
        },
      },
    }));
    await expect(
      runPlanPut(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_be_alpha',
          stepsFile,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      nextAction: expect.stringContaining('test code put'),
    });
  });

  it('respects a caller-supplied --idempotency-key', async () => {
    const { credentialsPath } = makeCreds();
    const stepsFile = writeStepsFile({ planSteps: STEPS });
    let seenKey: string | null = null;
    const fetchImpl = makeFetch((_url, init) => {
      seenKey = new Headers(init.headers as Record<string, string>).get('idempotency-key');
      return { body: SAMPLE_RESPONSE };
    });
    await runPlanPut(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        stepsFile,
        idempotencyKey: 'op_plan_put_77',
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );
    expect(seenKey).toBe('op_plan_put_77');
  });

  it('renders text mode with one line per field', async () => {
    const { credentialsPath } = makeCreds();
    const stepsFile = writeStepsFile({ planSteps: STEPS });
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    const out: string[] = [];
    await runPlanPut(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_alpha',
        stepsFile,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line), stderr: () => undefined },
    );
    const block = out.join('\n');
    expect(block).toContain('testId        test_alpha');
    expect(block).toContain('planStepsHash sha256:abc123');
    expect(block).toContain('stepCount     4');
    expect(block).toContain('updatedAt     2026-05-14T10:00:00.000Z');
  });

  // Fix #1 — dogfood 2026-05-15: dry-run stepCount echoes actual input count
  it('--dry-run: stepCount echoes the actual number of steps in the --steps file', async () => {
    const { credentialsPath } = makeCreds();
    const twoSteps = [
      { type: 'action', description: 'navigate to /login' },
      { type: 'assertion', description: 'page title is Login' },
    ];
    const stepsFile = writeStepsFile({ planSteps: twoSteps });
    const res = await runPlanPut(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        testId: 'test_abc',
        stepsFile,
      },
      { credentialsPath, stdout: () => undefined, stderr: () => undefined },
    );
    // Input had 2 steps; dry-run used to return the canned stepCount=3
    expect(res.stepCount).toBe(2);
  });

  // Fix #2 — dogfood 2026-05-14: --dry-run-simulate-error PRECONDITION_FAILED
  it('--dry-run --dry-run-simulate-error PRECONDITION_FAILED: exits 6 + emits retry hint', async () => {
    const { credentialsPath } = makeCreds();
    const stepsFile = writeStepsFile({ planSteps: STEPS });
    const stderrLines: string[] = [];
    await expect(
      runPlanPut(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: true,
          testId: 'test_abc',
          stepsFile,
          dryRunSimulateError: 'PRECONDITION_FAILED',
        },
        {
          credentialsPath,
          stdout: () => undefined,
          stderr: line => stderrLines.push(line),
        },
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    // Retry hint must be present on stderr
    expect(stderrLines.some(l => l.includes('Plan-steps conflict'))).toBe(true);
    expect(stderrLines.some(l => l.includes('--expected-step-count'))).toBe(true);
  });
});

describe('runUpdate', () => {
  const SAMPLE_RESPONSE = {
    testId: 'test_alpha',
    updatedFields: ['name', 'description'],
    updatedAt: '2026-05-14T10:00:00.000Z',
  };

  it('PUTs /tests/{id} with the body fields the caller set + idempotency header', async () => {
    const { credentialsPath } = makeCreds();
    type Captured = { url: string; method: string; body: unknown; headers: Headers };
    const captured: Captured[] = [];
    const fetchImpl = makeFetch((url, init) => {
      captured.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body as string) : undefined,
        headers: new Headers(init.headers as Record<string, string>),
      });
      return { status: 200, body: SAMPLE_RESPONSE };
    });

    const out: string[] = [];
    const res = await runUpdate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        name: 'renamed test',
        description: 'updated description',
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    expect(res).toEqual(SAMPLE_RESPONSE);
    expect(captured).toHaveLength(1);
    const sent = captured[0]!;
    expect(sent.method).toBe('PUT');
    expect(sent.url).toContain('/api/cli/v1/tests/test_alpha');
    expect(sent.body).toEqual({
      name: 'renamed test',
      description: 'updated description',
    });
    expect(sent.headers.get('idempotency-key')).toMatch(/^cli-update-[0-9a-f-]{36}$/);
    expect(sent.headers.get('content-type')).toBe('application/json');
    expect(sent.headers.get('x-api-key')).toBe('sk-user-test');
  });

  it('sends only the fields the caller set — omits undefined ones from the body', async () => {
    const { credentialsPath } = makeCreds();
    let seenBody: unknown;
    const fetchImpl = makeFetch((_url, init) => {
      seenBody = init.body ? JSON.parse(init.body as string) : undefined;
      return { body: SAMPLE_RESPONSE };
    });
    await runUpdate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        priority: 'p2',
      },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    expect(seenBody).toEqual({ priority: 'p2' });
  });

  it('respects a caller-supplied --idempotency-key', async () => {
    const { credentialsPath } = makeCreds();
    let seenKey: string | null = null;
    const fetchImpl = makeFetch((_url, init) => {
      seenKey = new Headers(init.headers as Record<string, string>).get('idempotency-key');
      return { body: SAMPLE_RESPONSE };
    });
    await runUpdate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        name: 'whatever',
        idempotencyKey: 'op_99',
      },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );
    expect(seenKey).toBe('op_99');
  });

  it('suppresses the minted idempotency-key in text mode without --verbose/--debug (Fix 1)', async () => {
    // Text mode + no flags → key suppressed (not noise in default human output).
    // JSON mode and --verbose/--debug always emit it on stderr (never pollutes
    // the JSON stdout stream; Fix 1 regression guard).
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));

    // Text mode default: key must NOT appear
    const errLinesText: string[] = [];
    await runUpdate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_alpha',
        name: 'n',
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => errLinesText.push(line),
      },
    );
    expect(errLinesText.some(l => l.startsWith('idempotency-key:'))).toBe(false);

    // JSON mode: key MUST appear on stderr (Fix 1 — was silently suppressed)
    const errLinesJson: string[] = [];
    await runUpdate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        name: 'n',
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => errLinesJson.push(line),
      },
    );
    expect(errLinesJson.some(l => l.match(/^idempotency-key: cli-update-[0-9a-f-]{36}$/))).toBe(
      true,
    );

    // Text mode + --verbose: key must appear
    const errLinesVerbose: string[] = [];
    await runUpdate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        verbose: true,
        testId: 'test_alpha',
        name: 'n',
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => errLinesVerbose.push(line),
      },
    );
    expect(errLinesVerbose.some(l => l.match(/^idempotency-key: cli-update-[0-9a-f-]{36}$/))).toBe(
      true,
    );
  });

  it('rejects no-op invocations (none of name/description/priority set) before sending', async () => {
    const { credentialsPath } = makeCreds();
    let called = 0;
    const fetchImpl = makeFetch(() => {
      called += 1;
      return { body: SAMPLE_RESPONSE };
    });
    await expect(
      runUpdate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_alpha',
        },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'fields' }),
    });
    expect(called).toBe(0);
  });

  it('rejects an invalid --priority value before sending', async () => {
    const { credentialsPath } = makeCreds();
    let called = 0;
    const fetchImpl = makeFetch(() => {
      called += 1;
      return { body: SAMPLE_RESPONSE };
    });
    await expect(
      runUpdate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_alpha',
          priority: 'urgent' as never,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'priority' }),
    });
    expect(called).toBe(0);
  });

  it('rejects a whitespace-only --name before sending (parity with test create)', async () => {
    const { credentialsPath } = makeCreds();
    let called = 0;
    const fetchImpl = makeFetch(() => {
      called += 1;
      return { body: SAMPLE_RESPONSE };
    });
    await expect(
      runUpdate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_alpha',
          name: '   ',
        },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'name' }),
    });
    expect(called).toBe(0);
  });

  it('renders text mode with one line per updated field', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    const out: string[] = [];
    await runUpdate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_alpha',
        name: 'renamed',
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    expect(block).toContain('testId        test_alpha');
    expect(block).toContain('updatedFields name, description');
    expect(block).toContain('updatedAt     2026-05-14T10:00:00.000Z');
  });

  // Regression guard: --dry-run on `test update` resolves the canned sample
  // and exits 0. Pins the PUT verb (backend route is `@Put('/:testId')`) so
  // a future "fix" that flips both sides to PATCH doesn't silently break
  // `test update` against the deployed backend.
  it('--dry-run: exits 0 and returns canned updateTest sample (status 200, not 500)', async () => {
    const { credentialsPath } = makeCreds();
    const res = await runUpdate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        testId: 'test_abc',
        name: 'dry-run rename',
      },
      { credentialsPath, stdout: () => undefined, stderr: () => undefined },
    );
    // Must resolve to the canned sample, not throw
    expect(res.testId).toBe('test_dryrun_update_2026');
    expect(Array.isArray(res.updatedFields)).toBe(true);
    expect(res.updatedAt).toBeTruthy();
  });

  // Fix #1 — dogfood 2026-05-15: dry-run should echo user's actual flags
  it('--dry-run: updatedFields echoes only the flags the caller supplied (not canned defaults)', async () => {
    const { credentialsPath } = makeCreds();
    const res = await runUpdate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        testId: 'test_abc',
        name: 'new name only',
        // description intentionally omitted
      },
      { credentialsPath, stdout: () => undefined, stderr: () => undefined },
    );
    // With only --name, updatedFields must be ['name'], not ['name','description']
    expect(res.updatedFields).toEqual(['name']);
  });

  it('--dry-run: updatedFields echoes name + description when both flags are passed', async () => {
    const { credentialsPath } = makeCreds();
    const res = await runUpdate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        testId: 'test_abc',
        name: 'n',
        description: 'd',
      },
      { credentialsPath, stdout: () => undefined, stderr: () => undefined },
    );
    expect(res.updatedFields).toEqual(expect.arrayContaining(['name', 'description']));
    expect(res.updatedFields).toHaveLength(2);
  });
});

describe('runDelete', () => {
  const SAMPLE_RESPONSE = {
    testId: 'test_alpha',
    deletedAt: '2026-05-14T10:00:00.000Z',
  };

  it('refuses without --confirm (exit-5 VALIDATION_ERROR), does not fetch', async () => {
    const { credentialsPath } = makeCreds();
    let called = 0;
    const fetchImpl = makeFetch(() => {
      called += 1;
      return { body: SAMPLE_RESPONSE };
    });
    await expect(
      runDelete(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          testId: 'test_alpha',
          confirm: false,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'confirm' }),
    });
    expect(called).toBe(0);
  });

  it('DELETEs /tests/{id} with --confirm and emits the idempotency-key (json mode)', async () => {
    const { credentialsPath } = makeCreds();
    type Captured = { url: string; method: string; headers: Headers };
    const captured: Captured[] = [];
    const fetchImpl = makeFetch((url, init) => {
      captured.push({
        url,
        method: init.method ?? 'GET',
        headers: new Headers(init.headers as Record<string, string>),
      });
      return { body: SAMPLE_RESPONSE };
    });
    const out: string[] = [];
    const errLines: string[] = [];
    const res = await runDelete(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        confirm: true,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => out.push(line),
        stderr: line => errLines.push(line),
      },
    );

    expect(res).toEqual(SAMPLE_RESPONSE);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe('DELETE');
    expect(captured[0]!.url).toContain('/api/cli/v1/tests/test_alpha');
    expect(captured[0]!.headers.get('idempotency-key')).toMatch(/^cli-delete-[0-9a-f-]{36}$/);
    // No restore hint — hard-delete is permanent.
    expect(errLines.some(l => l.includes('Restore'))).toBe(false);
  });

  it('respects a caller-supplied --idempotency-key', async () => {
    const { credentialsPath } = makeCreds();
    let seenKey: string | null = null;
    const fetchImpl = makeFetch((_url, init) => {
      seenKey = new Headers(init.headers as Record<string, string>).get('idempotency-key');
      return { body: SAMPLE_RESPONSE };
    });
    await runDelete(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_alpha',
        confirm: true,
        idempotencyKey: 'op_delete_1',
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );
    expect(seenKey).toBe('op_delete_1');
  });

  it('--dry-run bypasses the --confirm requirement', async () => {
    const { credentialsPath } = makeCreds();
    // dry-run swaps fetch in via client-factory; we just ensure the
    // command path completes without throwing the --confirm guard.
    const res = await runDelete(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        testId: 'test_alpha',
        confirm: false,
      },
      { credentialsPath, stdout: () => undefined, stderr: () => undefined },
    );
    // dry-run sample is canned per `src/lib/dry-run/samples.ts` (`deleteTest`)
    expect(res.testId).toBe('test_dryrun_delete_2026');
    expect(res.deletedAt).toBe('2026-05-13T00:00:00.000Z');
  });

  it('renders text mode with one line per field', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    const out: string[] = [];
    await runDelete(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        testId: 'test_alpha',
        confirm: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line), stderr: () => undefined },
    );
    const block = out.join('\n');
    expect(block).toContain('testId    test_alpha');
    expect(block).toContain('deletedAt 2026-05-14T10:00:00.000Z');
    expect(block).not.toContain('restorableUntil');
  });
});

describe('runCreateFromPlan', () => {
  function writePlanFile(plan: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-p5-'));
    const path = join(dir, 'plan.json');
    writeFileSync(path, JSON.stringify(plan), 'utf8');
    return path;
  }

  const FE_PLAN = {
    projectId: 'project_alice',
    type: 'frontend' as const,
    name: 'login rejects empty password',
    description: 'Verify /login rejects empty password with a toast.',
    planSteps: [
      { type: 'action', description: 'navigate to /login' },
      { type: 'action', description: 'click submit without filling password' },
      { type: 'assertion', description: "error toast 'invalid password' appears" },
    ],
  };

  const SAMPLE_RESPONSE = {
    testId: 'test_planned',
    type: 'frontend' as const,
    codeVersion: 'v1',
    createdAt: '2026-05-14T10:00:00.000Z',
  };

  it('POSTs /tests with planSteps body + idempotency-key from a valid FE plan file', async () => {
    const { credentialsPath } = makeCreds();
    const planFile = writePlanFile(FE_PLAN);
    type Captured = { url: string; method: string; body: unknown; headers: Headers };
    const captured: Captured[] = [];
    const fetchImpl = makeFetch((url, init) => {
      captured.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body as string) : undefined,
        headers: new Headers(init.headers as Record<string, string>),
      });
      return { body: SAMPLE_RESPONSE };
    });

    const res = await runCreateFromPlan(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        planFrom: planFile,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );

    expect(res).toEqual(SAMPLE_RESPONSE);
    // Fix 4 adds a best-effort dup-name GET before the POST, so captured may
    // contain 2 entries. Find the POST specifically.
    const sent = captured.find(c => c.method === 'POST')!;
    expect(sent).toBeDefined();
    expect(sent.url).toContain('/api/cli/v1/tests');
    expect(sent.body).toEqual({
      projectId: 'project_alice',
      type: 'frontend',
      name: 'login rejects empty password',
      description: 'Verify /login rejects empty password with a toast.',
      planSteps: FE_PLAN.planSteps,
    });
    expect(sent.headers.get('idempotency-key')).toMatch(/^cli-create-plan-[0-9a-f-]{36}$/);
  });

  // Dogfood 2026-05-18 (Joseph): PowerShell 5.1's `Set-Content -Encoding utf8`
  // writes a UTF-8 BOM, which the previous JSON read rejected with a cryptic
  // "Unexpected token ''" error (the BOM renders invisibly). The CLI now
  // strips a leading BOM before parsing.
  it('accepts a plan file with a UTF-8 BOM (Windows PowerShell 5.1 default)', async () => {
    const { credentialsPath } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-p5-bom-'));
    const path = join(dir, 'plan.json');
    writeFileSync(path, '﻿' + JSON.stringify(FE_PLAN), 'utf8');
    type Captured = { body: unknown };
    const captured: Captured[] = [];
    const fetchImpl = makeFetch((_url, init) => {
      captured.push({ body: init.body ? JSON.parse(init.body as string) : undefined });
      return { body: SAMPLE_RESPONSE };
    });

    const res = await runCreateFromPlan(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        planFrom: path,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );

    expect(res).toEqual(SAMPLE_RESPONSE);
    // Fix 4 adds a best-effort dup-name GET before the POST; filter by body presence.
    const postEntry = captured.find(c => c.body !== undefined)!;
    expect(postEntry).toBeDefined();
    expect(postEntry.body).toEqual({
      projectId: 'project_alice',
      type: 'frontend',
      name: 'login rejects empty password',
      description: 'Verify /login rejects empty password with a toast.',
      planSteps: FE_PLAN.planSteps,
    });
  });

  it('rejects a BE plan pre-flight with the documented code-file nextAction', async () => {
    const { credentialsPath } = makeCreds();
    const planFile = writePlanFile({ ...FE_PLAN, type: 'backend' });
    let called = 0;
    const fetchImpl = makeFetch(() => {
      called += 1;
      return { body: SAMPLE_RESPONSE };
    });
    await expect(
      runCreateFromPlan(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          planFrom: planFile,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Backend tests via the CLI require --code-file.',
      nextAction: expect.stringContaining('--code-file'),
    });
    expect(called).toBe(0);
  });

  it('--run triggers a POST /runs after create (M3.3 piece-3 implemented)', async () => {
    // M3.3 has landed: --run no longer exits 7 UNSUPPORTED; it fires
    // POST /tests/{testId}/runs after the create succeeds.
    const { credentialsPath } = makeCreds();
    const planFile = writePlanFile(FE_PLAN);
    const seenUrls: string[] = [];
    const fetchImpl = makeFetch(url => {
      seenUrls.push(url);
      if (url.includes('/runs/')) {
        // GET /runs/{runId} — return terminal run so poll exits
        return {
          body: {
            runId: 'run_m33',
            testId: 'test_planned',
            projectId: 'project_alice',
            userId: 'u1',
            status: 'passed',
            source: 'cli',
            createdAt: '2026-05-15T10:00:00.000Z',
            startedAt: '2026-05-15T10:00:01.000Z',
            finishedAt: '2026-05-15T10:00:30.000Z',
            codeVersion: 'v1',
            targetUrl: 'https://example.com',
            createdFrom: 'cli',
            failedStepIndex: null,
            failureKind: null,
            videoUrl: null,
            stepSummary: { total: 3, completed: 3, passedCount: 3, failedCount: 0 },
          },
        };
      }
      if (url.includes('/runs')) {
        // POST /tests/{testId}/runs
        return {
          body: {
            runId: 'run_m33',
            status: 'queued',
            enqueuedAt: '2026-05-15T10:00:00.000Z',
            codeVersion: 'v1',
            targetUrl: 'https://example.com',
          },
        };
      }
      return { body: SAMPLE_RESPONSE };
    });
    const result = await runCreateFromPlan(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        planFrom: planFile,
        run: true,
        wait: true,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: () => undefined,
        sleep: () => Promise.resolve(),
      },
    );
    // Should have made at least: POST /tests, POST /tests/.../runs, GET /runs/...
    expect(seenUrls.some(u => u.includes('/runs'))).toBe(true);
    // Returns the create response
    expect(result).toMatchObject({ testId: 'test_planned' });
  });

  // codex #128 P2: the `--run` chain derives `<createKey>:run`. A near-limit
  // base key would derive a >256-char run key, which `runTestRun` rejects —
  // but only AFTER the create POST already fired, orphaning a test with no
  // run. The fix validates the derived key up-front (before any I/O).
  it('create --run with a 253-char --idempotency-key fails fast (exit 5) before the create POST (codex #128 P2)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn();
    const longKey = 'k'.repeat(253); // 253 + ':run'.length (4) = 257 > 256
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_alice',
          type: 'frontend',
          name: 'n',
          codeFile: '/tmp/whatever.spec.ts',
          idempotencyKey: longKey,
          run: true,
        },
        { credentialsPath, fetchImpl: fetchImpl as never, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: expect.objectContaining({ field: 'idempotencyKey' }),
    });
    // The create POST must NOT have fired — no orphan test.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('create --run with a 252-char --idempotency-key passes the chain-key guard (boundary: derived == 256)', async () => {
    // 252 + ':run'.length (4) === 256 exactly — must NOT be rejected by the
    // chain-key guard. It proceeds and fails later on the missing code-file,
    // proving the key guard let it through (field is `code-file`, not
    // `idempotencyKey`).
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn();
    const boundaryKey = 'k'.repeat(252);
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'project_alice',
          type: 'frontend',
          name: 'n',
          codeFile: '/tmp/this-file-does-not-exist-p2b-boundary.py',
          idempotencyKey: boundaryKey,
          run: true,
        },
        { credentialsPath, fetchImpl: fetchImpl as never, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: expect.objectContaining({ field: 'code-file' }),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('create --plan-from --run with a 253-char --idempotency-key fails fast before the create POST (codex #128 P2)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn();
    const longKey = 'k'.repeat(253);
    await expect(
      runCreateFromPlan(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          planFrom: '/tmp/whatever-plan.json',
          idempotencyKey: longKey,
          run: true,
          wait: false,
        },
        { credentialsPath, fetchImpl: fetchImpl as never, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: expect.objectContaining({ field: 'idempotencyKey' }),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Per codex round-1 P1: chained `test create --plan-from ... --run`
  // with `--output json` must emit a SINGLE parseable JSON object on
  // stdout, not the create envelope followed by the run envelope.
  // Agents and CI scripts cannot `JSON.parse` two objects back-to-back.
  it('chained --run --output json emits ONE merged envelope on stdout (codex P1)', async () => {
    const { credentialsPath } = makeCreds();
    const planFile = writePlanFile(FE_PLAN);
    const fetchImpl = makeFetch(url => {
      if (url.includes('/runs/')) {
        // GET /runs/{runId} — terminal so poll exits
        return {
          body: {
            runId: 'run_chain_p1',
            testId: 'test_planned',
            projectId: 'project_alice',
            userId: 'u1',
            status: 'passed',
            source: 'cli',
            createdAt: '2026-05-15T10:00:00.000Z',
            startedAt: '2026-05-15T10:00:01.000Z',
            finishedAt: '2026-05-15T10:00:30.000Z',
            codeVersion: 'v1',
            targetUrl: 'https://example.com',
            createdFrom: 'cli',
            failedStepIndex: null,
            failureKind: null,
            videoUrl: null,
            stepSummary: { total: 3, completed: 3, passedCount: 3, failedCount: 0 },
          },
        };
      }
      if (url.includes('/runs')) {
        return {
          body: {
            runId: 'run_chain_p1',
            status: 'queued',
            enqueuedAt: '2026-05-15T10:00:00.000Z',
            codeVersion: 'v1',
            targetUrl: 'https://example.com',
          },
        };
      }
      return { body: SAMPLE_RESPONSE };
    });

    const stdoutLines: string[] = [];
    await runCreateFromPlan(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        planFrom: planFile,
        run: true,
        wait: true,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdoutLines.push(line),
        stderr: () => undefined,
        sleep: () => Promise.resolve(),
      },
    );

    // Exactly one logical line on stdout (the JSON object). Multiple
    // \n inside the pretty-printed JSON.stringify(.. 2) are part of
    // one `out.print` call; the `stdout` writer receives the full
    // pretty body as one argument.
    expect(stdoutLines).toHaveLength(1);
    const parsed = JSON.parse(stdoutLines[0]!) as Record<string, unknown>;
    // Merged envelope: create fields at the top, run nested under `run`.
    expect(parsed.testId).toBe('test_planned');
    expect(parsed.type).toBe('frontend');
    expect(parsed.createdAt).toBe('2026-05-14T10:00:00.000Z');
    expect(parsed.run).toMatchObject({
      runId: 'run_chain_p1',
      status: 'passed',
      testId: 'test_planned',
    });
  });

  it('chained --run --no-wait --output json also emits ONE merged envelope (codex P1)', async () => {
    const { credentialsPath } = makeCreds();
    const planFile = writePlanFile(FE_PLAN);
    const fetchImpl = makeFetch(url => {
      if (url.includes('/runs')) {
        return {
          body: {
            runId: 'run_chain_p1_nowait',
            status: 'queued',
            enqueuedAt: '2026-05-15T10:00:00.000Z',
            codeVersion: 'v1',
            targetUrl: 'https://example.com',
          },
        };
      }
      return { body: SAMPLE_RESPONSE };
    });

    const stdoutLines: string[] = [];
    await runCreateFromPlan(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        planFrom: planFile,
        run: true,
        wait: false,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdoutLines.push(line),
        stderr: () => undefined,
      },
    );

    expect(stdoutLines).toHaveLength(1);
    const parsed = JSON.parse(stdoutLines[0]!) as Record<string, unknown>;
    expect(parsed.testId).toBe('test_planned');
    // Trigger envelope nested under `run`.
    expect(parsed.run).toMatchObject({
      runId: 'run_chain_p1_nowait',
      status: 'queued',
    });
  });

  // Per codex round-1 P2: --timeout on the --plan-from branch must use
  // the same validator as the --code-file branch (parseTimeoutFlag with
  // [1, 3600] integer range). Previously it went through parseNumericFlag
  // which would accept --timeout 0, --timeout 1.5, and --timeout 999999.
  it('rejects --plan-from --timeout 0 with VALIDATION_ERROR (codex P2)', async () => {
    const test = createTestCommand();
    disableExits(test);
    await expect(
      test.parseAsync(
        ['create', '--plan-from', '/tmp/probe-plan.json', '--run', '--timeout', '0'],
        { from: 'user' },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'timeout' }),
    });
  });

  it('rejects --plan-from --timeout 1.5 with VALIDATION_ERROR (codex P2)', async () => {
    const test = createTestCommand();
    disableExits(test);
    await expect(
      test.parseAsync(
        ['create', '--plan-from', '/tmp/probe-plan.json', '--run', '--timeout', '1.5'],
        { from: 'user' },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'timeout' }),
    });
  });

  it('rejects --plan-from --timeout 999999 (above cap) with VALIDATION_ERROR (codex P2)', async () => {
    const test = createTestCommand();
    disableExits(test);
    await expect(
      test.parseAsync(
        ['create', '--plan-from', '/tmp/probe-plan.json', '--run', '--timeout', '999999'],
        { from: 'user' },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'timeout' }),
    });
  });

  it('rejects a missing plan file with VALIDATION_ERROR', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    await expect(
      runCreateFromPlan(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          planFrom: '/tmp/does-not-exist-piece5.json',
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a plan missing required fields with a typed field pointer', async () => {
    const { credentialsPath } = makeCreds();
    const planFile = writePlanFile({ projectId: 'p', type: 'frontend', planSteps: [] });
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    await expect(
      runCreateFromPlan(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          planFrom: planFile,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'name' }),
    });
  });

  it('L1778: a plan missing projectId fails fast (field projectId) BEFORE the ignored-flags warning', async () => {
    const { credentialsPath } = makeCreds();
    const planFile = writePlanFile({
      type: 'frontend',
      name: 'x',
      planSteps: [{ type: 'action', description: 'go' }],
    });
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    const stderrLines: string[] = [];
    await expect(
      runCreateFromPlan(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          planFrom: planFile,
          ignoredFlags: ['--project'],
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: l => stderrLines.push(l) },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'projectId' }),
    });
    // The misleading "ignoring --project" advisory must NOT precede the error.
    expect(stderrLines.join(' ')).not.toContain('warning: --plan-from');
  });

  it('L1778: a valid plan still warns about ignored flags (after validation passes)', async () => {
    const { credentialsPath } = makeCreds();
    const planFile = writePlanFile(FE_PLAN);
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    const stderrLines: string[] = [];
    await runCreateFromPlan(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        planFrom: planFile,
        ignoredFlags: ['--project', '--name'],
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: l => stderrLines.push(l) },
    );
    const errText = stderrLines.join(' ');
    expect(errText).toContain('warning: --plan-from supplies the test definition');
    expect(errText).toContain('--project');
    expect(errText).toContain('--name');
  });

  it('rejects a plan with an invalid step type', async () => {
    const { credentialsPath } = makeCreds();
    const planFile = writePlanFile({
      ...FE_PLAN,
      planSteps: [{ type: 'go', description: 'do thing' }],
    });
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    await expect(
      runCreateFromPlan(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          planFrom: planFile,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'planSteps[0].type' }),
    });
  });

  it('rejects oversize plan-step body (>200 steps) pre-flight', async () => {
    const { credentialsPath } = makeCreds();
    const oversize = {
      ...FE_PLAN,
      planSteps: Array.from({ length: 201 }, (_, i) => ({
        type: 'action' as const,
        description: `step ${i}`,
      })),
    };
    const planFile = writePlanFile(oversize);
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    await expect(
      runCreateFromPlan(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          planFrom: planFile,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'planSteps' }),
    });
  });

  it('respects a caller-supplied --idempotency-key', async () => {
    const { credentialsPath } = makeCreds();
    const planFile = writePlanFile(FE_PLAN);
    let seenKey: string | null = null;
    const fetchImpl = makeFetch((_url, init) => {
      seenKey = new Headers(init.headers as Record<string, string>).get('idempotency-key');
      return { body: SAMPLE_RESPONSE };
    });
    await runCreateFromPlan(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        planFrom: planFile,
        idempotencyKey: 'op_plan_42',
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );
    expect(seenKey).toBe('op_plan_42');
  });

  // ---------------------------------------------------------------------------
  // Finding 4 — dup-name advisory must fire in runCreateFromPlan too (codex
  // round-2: the round-1 advisory only covered runCreate).
  // ---------------------------------------------------------------------------

  it('[finding-4] emits dup-name advisory on stderr when a same-name test exists in the plan project', async () => {
    const { credentialsPath } = makeCreds();
    const existingTest = {
      id: 'test_existing_plan',
      projectId: 'project_alice',
      name: 'login rejects empty password', // same as FE_PLAN.name
      type: 'frontend',
      createdFrom: 'portal',
      status: 'passed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    let postCalled = false;
    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'GET' && url.includes('/tests')) {
        return { body: { items: [existingTest], nextToken: null } };
      }
      if ((init.method ?? 'GET') === 'POST') {
        postCalled = true;
        return { body: SAMPLE_RESPONSE };
      }
      return { body: SAMPLE_RESPONSE };
    });
    const planFile = writePlanFile(FE_PLAN);
    const stderrLines: string[] = [];

    const result = await runCreateFromPlan(
      { profile: 'default', output: 'json', debug: false, planFrom: planFile },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => stderrLines.push(line),
      },
    );

    // Create still proceeds
    expect(result.testId).toBe(SAMPLE_RESPONSE.testId);
    expect(postCalled).toBe(true);
    // Advisory on stderr mentioning the existing testId
    const advisoryLine = stderrLines.find(
      l => l.includes('[advisory]') && l.includes('test_existing_plan'),
    );
    expect(advisoryLine).toBeDefined();
    expect(advisoryLine).toContain('test update');
  });

  it('[finding-4] swallows listing error on plan-from path and still creates', async () => {
    const { credentialsPath } = makeCreds();
    let listAttempted = false;
    let postCalled = false;
    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'GET' && url.includes('/tests')) {
        listAttempted = true;
        return {
          status: 500,
          body: {
            error: {
              code: 'INTERNAL',
              message: 'err',
              nextAction: '',
              requestId: 'r',
              details: {},
            },
          },
        };
      }
      if ((init.method ?? 'GET') === 'POST') {
        postCalled = true;
        return { body: SAMPLE_RESPONSE };
      }
      return { body: SAMPLE_RESPONSE };
    });
    const planFile = writePlanFile(FE_PLAN);

    const result = await runCreateFromPlan(
      { profile: 'default', output: 'json', debug: false, planFrom: planFile },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );

    expect(listAttempted).toBe(true);
    expect(postCalled).toBe(true);
    expect(result.testId).toBe(SAMPLE_RESPONSE.testId);
  });

  it('[finding-4] skips dup-name lookup when dry-run is true', async () => {
    const { credentialsPath } = makeCreds();
    let listAttempted = false;
    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'GET' && url.includes('/tests')) {
        listAttempted = true;
      }
      return { body: SAMPLE_RESPONSE };
    });
    const planFile = writePlanFile(FE_PLAN);

    await runCreateFromPlan(
      { profile: 'default', output: 'json', debug: false, planFrom: planFile, dryRun: true },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );

    // No listing call on dry-run path
    expect(listAttempted).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Finding B (codex round-2) — advisory dup-name lookup passes AbortSignal
  // so the 5s AbortController deadline can abort a stalled fetch.
  // ---------------------------------------------------------------------------

  it('[finding-B] advisory GET passes an AbortSignal (5s deadline abort gate)', async () => {
    // The short-deadline advisory wraps client.get with an AbortController.
    // Verify the listing fetch receives signal= so the abort can fire.
    const { credentialsPath } = makeCreds();

    let capturedSignal: AbortSignal | undefined;
    let postCalled = false;

    // Use an async fetch impl that captures the signal from the listing call.
    type FetchInput2 = Parameters<typeof globalThis.fetch>[0];
    const asyncFetchImpl = (async (input: FetchInput2, init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;
      if ((init.method ?? 'GET') === 'GET' && url.includes('/tests?projectId=')) {
        capturedSignal = init.signal ?? undefined;
        return new Response(JSON.stringify({ items: [], nextToken: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if ((init.method ?? 'GET') === 'POST') {
        postCalled = true;
        return new Response(JSON.stringify(SAMPLE_RESPONSE), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(SAMPLE_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const planFile = writePlanFile(FE_PLAN);

    const result = await runCreateFromPlan(
      { profile: 'default', output: 'json', debug: false, planFrom: planFile },
      {
        credentialsPath,
        fetchImpl: asyncFetchImpl as ReturnType<typeof makeFetch>,
        stdout: () => undefined,
        stderr: () => undefined,
      },
    );

    expect(result.testId).toBe(SAMPLE_RESPONSE.testId);
    expect(postCalled).toBe(true);
    // The advisory GET must have been called with an AbortSignal so the
    // 5s AbortController timer can cancel it.
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });
});

describe('runCreateBatch', () => {
  function writePlansJsonl(plans: unknown[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-p5-batch-'));
    const path = join(dir, 'plans.jsonl');
    writeFileSync(path, plans.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf8');
    return path;
  }

  const FE_SPEC = {
    projectId: 'project_alice',
    type: 'frontend' as const,
    name: 'one',
    planSteps: [{ type: 'action', description: 'navigate' }],
  };

  const SAMPLE_RESPONSE = {
    results: [
      { specIndex: 0, testId: 'test_b0', status: 'created' as const },
      { specIndex: 1, testId: 'test_b1', status: 'created' as const },
    ],
    summary: { total: 2, created: 2, failed: 0 },
  };

  it('POSTs /tests/batch with the parsed specs + idempotency-key', async () => {
    const { credentialsPath } = makeCreds();
    const plansFile = writePlansJsonl([FE_SPEC, { ...FE_SPEC, name: 'two' }]);
    type Captured = { url: string; method: string; body: unknown; headers: Headers };
    const captured: Captured[] = [];
    const fetchImpl = makeFetch((url, init) => {
      captured.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body as string) : undefined,
        headers: new Headers(init.headers as Record<string, string>),
      });
      return { body: SAMPLE_RESPONSE };
    });

    const res = await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        plans: plansFile,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );
    expect(res).toEqual(SAMPLE_RESPONSE);
    expect(captured).toHaveLength(1);
    const sent = captured[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toContain('/api/cli/v1/tests/batch');
    const body = sent.body as { tests: unknown[] };
    expect(body.tests).toHaveLength(2);
    expect(sent.headers.get('idempotency-key')).toMatch(/^cli-create-batch-[0-9a-f-]{36}$/);
  });

  it('warns on stderr listing BE specs in a mixed batch but still proceeds', async () => {
    const { credentialsPath } = makeCreds();
    const plansFile = writePlansJsonl([
      FE_SPEC,
      { ...FE_SPEC, type: 'backend', name: 'be-spec' },
      { ...FE_SPEC, name: 'three' },
    ]);
    let sent = 0;
    const fetchImpl = makeFetch(() => {
      sent += 1;
      return { body: SAMPLE_RESPONSE };
    });
    const errLines: string[] = [];
    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        plans: plansFile,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => errLines.push(line),
      },
    );
    expect(sent).toBe(1);
    expect(errLines.some(l => l.includes('warning: 1 of 3 specs have type="backend"'))).toBe(true);
    expect(errLines.some(l => l.includes('indexes: 1'))).toBe(true);
  });

  it('rejects an oversize batch (>50 specs) pre-flight', async () => {
    const { credentialsPath } = makeCreds();
    const plans = Array.from({ length: 51 }, () => FE_SPEC);
    const plansFile = writePlansJsonl(plans);
    let called = 0;
    const fetchImpl = makeFetch(() => {
      called += 1;
      return { body: SAMPLE_RESPONSE };
    });
    await expect(
      runCreateBatch(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          plans: plansFile,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'plans' }),
    });
    expect(called).toBe(0);
  });

  it('rejects an empty JSONL file with VALIDATION_ERROR', async () => {
    const { credentialsPath } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-p5-empty-'));
    const plansFile = join(dir, 'empty.jsonl');
    writeFileSync(plansFile, '\n  \n', 'utf8');
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    await expect(
      runCreateBatch(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          plans: plansFile,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'plans' }),
    });
  });

  it('rejects a malformed JSONL line with a typed line-number pointer', async () => {
    const { credentialsPath } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-p5-bad-'));
    const plansFile = join(dir, 'bad.jsonl');
    writeFileSync(plansFile, `${JSON.stringify(FE_SPEC)}\nnot-json\n`, 'utf8');
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    await expect(
      runCreateBatch(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          plans: plansFile,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'plans[1]' }),
    });
  });

  it('rejects --max-concurrency < 1 before sending', async () => {
    const { credentialsPath } = makeCreds();
    const plansFile = writePlansJsonl([FE_SPEC]);
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    await expect(
      runCreateBatch(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          plans: plansFile,
          maxConcurrency: 0,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'max-concurrency' }),
    });
  });

  it('rejects --max-concurrency > 100 (upper bound enforcement)', async () => {
    const { credentialsPath } = makeCreds();
    const plansFile = writePlansJsonl([FE_SPEC]);
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    await expect(
      runCreateBatch(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          plans: plansFile,
          maxConcurrency: 101,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({ field: 'max-concurrency' }),
    });
  });

  it('accepts --max-concurrency = 100 (boundary value)', async () => {
    const { credentialsPath } = makeCreds();
    const plansFile = writePlansJsonl([FE_SPEC]);
    const fetchImpl = makeFetch(() => ({ body: SAMPLE_RESPONSE }));
    // Should NOT throw VALIDATION_ERROR for exactly 100
    await expect(
      runCreateBatch(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          plans: plansFile,
          maxConcurrency: 100,
        },
        { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
      ),
    ).resolves.toBeDefined();
  });

  // Regression test: create-batch --run must keep launching new triggers
  // up to --max-concurrency as slots free up, not collapse to serial
  // after the first wave. Uses equal-delay trigger responses so the
  // first three jobs settle in the same microtask batch, the exact
  // condition that exposed the bug (race only reacts to one settlement,
  // then blocks the scheduler on the whole next job before moving on).
  it('--run keeps concurrency at --max-concurrency for tail jobs, not just the first wave', async () => {
    const { credentialsPath } = makeCreds();
    const specs = Array.from({ length: 6 }, (_, i) => ({ ...FE_SPEC, name: `spec-${i}` }));
    const plansFile = writePlansJsonl(specs);
    const CREATE_RESP = {
      results: specs.map((_, i) => ({
        specIndex: i,
        testId: `test_tail_${i}`,
        status: 'created' as const,
      })),
      summary: { total: 6, created: 6, failed: 0 },
    };
    const TRIGGER_DELAY_MS = 60;
    const limit = 3;
    let activeCount = 0;
    let triggerCallIndex = 0;
    const activeAtStart: number[] = [];

    type FetchInput2 = Parameters<typeof globalThis.fetch>[0];
    const fetchImpl = (async (input: FetchInput2) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;
      if (url.includes('/tests/batch')) {
        return new Response(JSON.stringify(CREATE_RESP), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/runs')) {
        const callIdx = triggerCallIndex++;
        activeCount++;
        activeAtStart[callIdx] = activeCount;
        await new Promise(resolve => setTimeout(resolve, TRIGGER_DELAY_MS));
        activeCount--;
        return new Response(
          JSON.stringify({
            runId: `run_tail_${callIdx}`,
            status: 'queued' as const,
            enqueuedAt: '2026-06-09T10:00:00.000Z',
            codeVersion: 'v1',
            targetUrl: 'https://example.com',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'not found', nextAction: '', requestId: 'r1' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;

    try {
      await runCreateBatch(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          plans: plansFile,
          run: true,
          wait: false,
          dryRun: false,
          maxConcurrency: limit,
        },
        {
          credentialsPath,
          fetchImpl: fetchImpl as ReturnType<typeof makeFetch>,
          stdout: () => undefined,
          stderr: () => undefined,
        },
      );
    } catch {
      // CLIError exit 1 expected: trigger status is 'queued', not 'passed'.
    }

    expect(activeAtStart).toHaveLength(6);
    // First wave fills up to the limit; true under the bug too.
    expect(Math.max(...activeAtStart.slice(0, limit))).toBe(limit);
    // Tail jobs (index >= limit) must ALSO reach the concurrency limit.
    // Under the bug, the scheduler blocks on each whole job after the
    // first wave, so every tail job launches alone (active === 1).
    for (const snapshot of activeAtStart.slice(limit)) {
      expect(snapshot).toBe(limit);
    }
  });

  // Per codex round-1 P2: a 200 OK with `summary.created === 0` on a
  // non-empty batch must not exit 0. Without this, a misconfigured
  // batch job (every spec invalid) silently lands nothing in DDB while
  // the wrapping CI pipeline considers the run green.
  it('throws INTERNAL when summary.created === 0 on a non-empty batch (codex P2)', async () => {
    const { credentialsPath } = makeCreds();
    const plansFile = writePlansJsonl([FE_SPEC, { ...FE_SPEC, name: 'two' }]);
    const zeroSuccessResponse = {
      results: [
        {
          specIndex: 0,
          status: 'validation_error' as const,
          error: { code: 'VALIDATION_ERROR', message: 'projectId invalid', field: 'projectId' },
        },
        {
          specIndex: 1,
          status: 'not_found' as const,
          error: { code: 'NOT_FOUND', message: 'project not found' },
        },
      ],
      summary: { total: 2, created: 0, failed: 2 },
    };
    const fetchImpl = makeFetch(() => ({ body: zeroSuccessResponse }));
    const stdoutLines: string[] = [];
    await expect(
      runCreateBatch(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          plans: plansFile,
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: l => stdoutLines.push(l),
          stderr: () => undefined,
        },
      ),
    ).rejects.toMatchObject({
      code: 'INTERNAL',
      details: expect.objectContaining({ total: 2, created: 0, failed: 2 }),
    });
    // The per-spec response was printed before the throw so an operator
    // sees both the per-spec error envelopes AND the non-zero exit.
    expect(stdoutLines.some(line => line.includes('"created": 0'))).toBe(true);
  });

  it('keeps exit 0 on partial success (some created, some failed) — CI-friendly', async () => {
    const { credentialsPath } = makeCreds();
    const plansFile = writePlansJsonl([FE_SPEC, { ...FE_SPEC, name: 'two' }]);
    const partialResponse = {
      results: [
        { specIndex: 0, testId: 'test_b0', status: 'created' as const },
        {
          specIndex: 1,
          status: 'validation_error' as const,
          error: { code: 'VALIDATION_ERROR', message: 'name too long', field: 'name' },
        },
      ],
      summary: { total: 2, created: 1, failed: 1 },
    };
    const fetchImpl = makeFetch(() => ({ body: partialResponse }));
    const res = await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        plans: plansFile,
      },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: () => undefined },
    );
    expect(res).toEqual(partialResponse);
  });

  // Fix #1 — dogfood 2026-05-15: dry-run result count echoes actual input count
  it('--dry-run: result count matches the number of specs in the --plans file', async () => {
    const { credentialsPath } = makeCreds();
    const plansFile = writePlansJsonl([FE_SPEC, { ...FE_SPEC, name: 'two' }]);
    const res = await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        plans: plansFile,
      },
      { credentialsPath, stdout: () => undefined, stderr: () => undefined },
    );
    // Input had 2 specs; dry-run used to return the canned 3-entry sample
    expect(res.results).toHaveLength(2);
    expect(res.summary.total).toBe(2);
    expect(res.summary.created).toBe(2);
    expect(res.results[0]?.specIndex).toBe(0);
    expect(res.results[1]?.specIndex).toBe(1);
  });

  // — Duplicate plan-body advisory tests (dogfood L120, 2026-05-28) —

  it('emits advisory exactly once on stderr when ≥3 specs share identical planSteps+description', async () => {
    const { credentialsPath } = makeCreds();
    const DUP_SPEC = {
      ...FE_SPEC,
      description: 'checkout flow',
      planSteps: [
        { type: 'action' as const, description: 'click checkout' },
        { type: 'assertion' as const, description: 'order confirmed' },
      ],
    };
    // 3 specs sharing identical planSteps+description, each with distinct name
    const plansFile = writePlansJsonl([
      { ...DUP_SPEC, name: 'agent-A' },
      { ...DUP_SPEC, name: 'agent-B' },
      { ...DUP_SPEC, name: 'agent-C' },
    ]);
    const fetchImpl = makeFetch(() => ({
      body: {
        results: [
          { specIndex: 0, testId: 'test_x0', status: 'created' as const },
          { specIndex: 1, testId: 'test_x1', status: 'created' as const },
          { specIndex: 2, testId: 'test_x2', status: 'created' as const },
        ],
        summary: { total: 3, created: 3, failed: 0 },
      },
    }));
    const errLines: string[] = [];
    await runCreateBatch(
      { profile: 'default', output: 'json', debug: false, plans: plansFile },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: line => errLines.push(line) },
    );
    // Advisory should appear exactly once
    const advisoryLines = errLines.filter(l => l.includes('[advisory]'));
    expect(advisoryLines).toHaveLength(1);
    expect(advisoryLines[0]).toContain('3 spec(s) share an identical plan body');
    expect(advisoryLines[0]).toContain('prefix each name per agent');
  });

  it('emits no advisory when <3 specs share identical planSteps+description', async () => {
    const { credentialsPath } = makeCreds();
    const DUP_SPEC = {
      ...FE_SPEC,
      planSteps: [{ type: 'action' as const, description: 'click submit' }],
    };
    // Only 2 duplicates — below threshold
    const plansFile = writePlansJsonl([
      { ...DUP_SPEC, name: 'agent-A' },
      { ...DUP_SPEC, name: 'agent-B' },
      { ...FE_SPEC, name: 'distinct' }, // different planSteps body
    ]);
    const fetchImpl = makeFetch(() => ({
      body: {
        results: [
          { specIndex: 0, testId: 'test_y0', status: 'created' as const },
          { specIndex: 1, testId: 'test_y1', status: 'created' as const },
          { specIndex: 2, testId: 'test_y2', status: 'created' as const },
        ],
        summary: { total: 3, created: 3, failed: 0 },
      },
    }));
    const errLines: string[] = [];
    await runCreateBatch(
      { profile: 'default', output: 'json', debug: false, plans: plansFile },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: line => errLines.push(line) },
    );
    const advisoryLines = errLines.filter(l => l.includes('[advisory]'));
    expect(advisoryLines).toHaveLength(0);
  });

  it('advisory goes to stderr and stdout remains a single parseable JSON document in --output json mode', async () => {
    const { credentialsPath } = makeCreds();
    const DUP_SPEC = {
      ...FE_SPEC,
      planSteps: [
        { type: 'action' as const, description: 'click login' },
        { type: 'assertion' as const, description: 'dashboard visible' },
      ],
    };
    const batchResponse = {
      results: [
        { specIndex: 0, testId: 'test_z0', status: 'created' as const },
        { specIndex: 1, testId: 'test_z1', status: 'created' as const },
        { specIndex: 2, testId: 'test_z2', status: 'created' as const },
      ],
      summary: { total: 3, created: 3, failed: 0 },
    };
    const plansFile = writePlansJsonl([
      { ...DUP_SPEC, name: 'agent-A' },
      { ...DUP_SPEC, name: 'agent-B' },
      { ...DUP_SPEC, name: 'agent-C' },
    ]);
    const fetchImpl = makeFetch(() => ({ body: batchResponse }));
    const stdoutLines: string[] = [];
    const errLines: string[] = [];
    await runCreateBatch(
      { profile: 'default', output: 'json', debug: false, plans: plansFile },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => stdoutLines.push(line),
        stderr: line => errLines.push(line),
      },
    );
    // stderr carries the advisory (safe for both modes)
    expect(errLines.some(l => l.includes('[advisory]'))).toBe(true);
    // stdout in json mode is a single parseable JSON document
    const stdoutDoc = stdoutLines.join('\n');
    const parsed: unknown = JSON.parse(stdoutDoc);
    expect(parsed).toMatchObject({ summary: { total: 3, created: 3 } });
  });
});

// ---------------------------------------------------------------------------
// Finding 1 — timeoutIsDefault in create-chain paths (codex round-2)
// ---------------------------------------------------------------------------
// Confirm that the first-run timeout hint fires (or doesn't) correctly when
// `test create --run --wait` and `test create --plan-from --run --wait` are
// used without or with an explicit --timeout.  The chain path exercises
// runCreate / runCreateFromPlan → runTestRun with a mocked HTTP stack.
// ---------------------------------------------------------------------------

describe('[finding-1] first-run --timeout hint flows through test create --run --wait chain', () => {
  const CREATE_RESP = {
    testId: 'test_chain_xyz',
    type: 'frontend' as const,
    codeVersion: 'v1',
    createdAt: '2026-06-07T00:00:00.000Z',
  };

  const TRIGGER_RESP = {
    runId: 'run_chain_001',
    status: 'queued' as const,
    enqueuedAt: '2026-06-07T00:01:00.000Z',
    codeVersion: 'v1',
    targetUrl: 'https://example.com',
  };

  const PASSED_RUN = {
    runId: 'run_chain_001',
    testId: 'test_chain_xyz',
    projectId: 'project_alice',
    userId: 'user_1',
    status: 'passed' as const,
    source: 'cli' as const,
    createdAt: '2026-06-07T00:01:00.000Z',
    startedAt: '2026-06-07T00:01:01.000Z',
    finishedAt: '2026-06-07T00:01:30.000Z',
    codeVersion: 'v1',
    targetUrl: 'https://example.com',
    createdFrom: 'cli' as const,
    failedStepIndex: null,
    failureKind: null,
    videoUrl: null,
    stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 },
  };

  function makeChainFetch(): typeof globalThis.fetch {
    return (async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as { url: string }).url;
      const method = init?.method ?? 'GET';
      // dup-name GET /tests?projectId=...
      if (method === 'GET' && url.includes('/tests')) {
        return new Response(JSON.stringify({ items: [], nextToken: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // POST /tests (create)
      if (method === 'POST' && /\/tests$/.test(url)) {
        return new Response(JSON.stringify(CREATE_RESP), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // POST /runs (trigger)
      if (method === 'POST' && url.includes('/runs')) {
        return new Response(JSON.stringify(TRIGGER_RESP), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // GET /runs/{id} (poll)
      return new Response(JSON.stringify(PASSED_RUN), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
  }

  // Plan-from chain fetch is identical to the code-file chain fetch
  const makePlanChainFetch = makeChainFetch;

  const instantSleep = () => Promise.resolve();

  it('emits [hint] when --timeout was not set (timeoutIsDefault=true) for test create --run --wait', async () => {
    const { credentialsPath } = makeCreds();
    const codeDir = mkdtempSync(join(tmpdir(), 'cli-f1-code-'));
    const codeFile = join(codeDir, 'test.py');
    writeFileSync(codeFile, '// chain test code', 'utf8');
    const stderrLines: string[] = [];

    await runCreate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        verbose: false,
        dryRun: false,
        projectId: 'project_alice',
        type: 'frontend',
        name: 'chain test',
        codeFile,
        run: true,
        wait: true,
        timeout: 600, // parsed from undefined → DEFAULT_RUN_TIMEOUT_SECONDS
        timeoutIsDefault: true, // <-- the fix: explicitly flag as default
      },
      {
        credentialsPath,
        fetchImpl: makeChainFetch() as unknown as ReturnType<typeof makeFetch>,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );

    expect(stderrLines.some(l => l.includes('[hint]') && l.includes('--timeout'))).toBe(true);
  });

  it('does NOT emit [hint] when --timeout was explicitly set (timeoutIsDefault=false) for test create --run --wait', async () => {
    const { credentialsPath } = makeCreds();
    const codeDir2 = mkdtempSync(join(tmpdir(), 'cli-f1-code2-'));
    const codeFile = join(codeDir2, 'test2.py');
    writeFileSync(codeFile, '// chain test code 2', 'utf8');
    const stderrLines: string[] = [];

    await runCreate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        verbose: false,
        dryRun: false,
        projectId: 'project_alice',
        type: 'frontend',
        name: 'chain test 2',
        codeFile,
        run: true,
        wait: true,
        timeout: 120,
        timeoutIsDefault: false, // <-- explicit timeout
      },
      {
        credentialsPath,
        fetchImpl: makeChainFetch() as unknown as ReturnType<typeof makeFetch>,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );

    expect(stderrLines.some(l => l.includes('[hint]') && l.includes('--timeout'))).toBe(false);
  });

  it('emits [hint] for test create --plan-from --run --wait when timeoutIsDefault=true', async () => {
    const { credentialsPath } = makeCreds();
    const FE_PLAN = {
      projectId: 'project_alice',
      type: 'frontend' as const,
      name: 'plan chain test',
      planSteps: [{ type: 'action', description: 'navigate' }],
    };
    const dir = mkdtempSync(join(tmpdir(), 'cli-f1-plan-'));
    const planFile = join(dir, 'plan.json');
    writeFileSync(planFile, JSON.stringify(FE_PLAN), 'utf8');

    const stderrLines: string[] = [];

    await runCreateFromPlan(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        verbose: false,
        dryRun: false,
        planFrom: planFile,
        run: true,
        wait: true,
        timeout: 600,
        timeoutIsDefault: true, // <-- the fix: --plan-from chain now threads this
      },
      {
        credentialsPath,
        fetchImpl: makePlanChainFetch() as unknown as ReturnType<typeof makeFetch>,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );

    expect(stderrLines.some(l => l.includes('[hint]') && l.includes('--timeout'))).toBe(true);
  });

  it('does NOT emit [hint] for test create --plan-from --run --wait when timeoutIsDefault=false', async () => {
    const { credentialsPath } = makeCreds();
    const FE_PLAN = {
      projectId: 'project_alice',
      type: 'frontend' as const,
      name: 'plan chain test explicit',
      planSteps: [{ type: 'action', description: 'navigate' }],
    };
    const dir = mkdtempSync(join(tmpdir(), 'cli-f1-plan-explicit-'));
    const planFile = join(dir, 'plan.json');
    writeFileSync(planFile, JSON.stringify(FE_PLAN), 'utf8');

    const stderrLines: string[] = [];

    await runCreateFromPlan(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        verbose: false,
        dryRun: false,
        planFrom: planFile,
        run: true,
        wait: true,
        timeout: 120,
        timeoutIsDefault: false, // <-- explicit timeout
      },
      {
        credentialsPath,
        fetchImpl: makePlanChainFetch() as unknown as ReturnType<typeof makeFetch>,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
        sleep: instantSleep,
      },
    );

    expect(stderrLines.some(l => l.includes('[hint]') && l.includes('--timeout'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 5 — dashboard URL in outputs (runCreate + runCreateBatch)
// ---------------------------------------------------------------------------

describe('Fix 5 — dashboardUrl emission', () => {
  function writeCodeFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cli-dash-'));
    const path = join(dir, 'test.py');
    writeFileSync(path, contents, 'utf8');
    return path;
  }

  const SAMPLE_RESP = {
    testId: 'test_dash_01',
    type: 'frontend' as const,
    codeVersion: 'v1',
    createdAt: '2026-06-09T10:00:00.000Z',
  };

  it('runCreate: JSON mode includes dashboardUrl when API URL is prod', async () => {
    // Use prod API URL → resolvePortalUrl returns a URL
    const { credentialsPath } = makeCreds('sk-test', 'https://api.testsprite.com');
    const codeFile = writeCodeFile('test("dash", async () => {});');
    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { status: 200, body: { items: [] } };
      return { status: 200, body: SAMPLE_RESP };
    });
    const out: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'proj_dash',
        type: 'frontend',
        name: 'dash test',
        codeFile,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line), stderr: () => undefined },
    );
    const printed = JSON.parse(out.join('')) as { testId: string; dashboardUrl?: string };
    expect(printed.testId).toBe('test_dash_01');
    expect(printed.dashboardUrl).toBe(
      'https://www.testsprite.com/dashboard/tests/proj_dash/test/test_dash_01',
    );
  });

  it('runCreate: text mode emits Dashboard: line to stderr when API URL is prod', async () => {
    const { credentialsPath } = makeCreds('sk-test', 'https://api.testsprite.com');
    const codeFile = writeCodeFile('test("dash", async () => {});');
    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { status: 200, body: { items: [] } };
      return { status: 200, body: SAMPLE_RESP };
    });
    const stderrLines: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'proj_dash',
        type: 'frontend',
        name: 'dash test',
        codeFile,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => undefined,
        stderr: line => stderrLines.push(line),
      },
    );
    expect(stderrLines.some(l => l.startsWith('Dashboard:'))).toBe(true);
    const dashLine = stderrLines.find(l => l.startsWith('Dashboard:'))!;
    expect(dashLine).toContain('www.testsprite.com/dashboard/tests/proj_dash/test/test_dash_01');
  });

  it('runCreate: no dashboardUrl when API URL is unknown (localhost)', async () => {
    const { credentialsPath } = makeCreds('sk-test', 'http://localhost:13502');
    const codeFile = writeCodeFile('test("dash", async () => {});');
    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { status: 200, body: { items: [] } };
      return { status: 200, body: SAMPLE_RESP };
    });
    const out: string[] = [];
    const stderrLines: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'proj_dash',
        type: 'frontend',
        name: 'dash test',
        codeFile,
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => out.push(line),
        stderr: line => stderrLines.push(line),
      },
    );
    const printed = JSON.parse(out.join('')) as { testId: string; dashboardUrl?: string };
    expect(printed.dashboardUrl).toBeUndefined();
    expect(stderrLines.some(l => l.startsWith('Dashboard:'))).toBe(false);
  });

  // R1: suppress dashboardUrl under --dry-run (test create)
  it('runCreate: --dry-run does NOT emit dashboardUrl in JSON mode', async () => {
    // No credentialsPath / fetchImpl needed — dry-run bypasses both.
    const codeFile = writeCodeFile('test("dash", async () => {});');
    const out: string[] = [];
    const stderrLines: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'proj_dash',
        type: 'frontend',
        name: 'dash test',
        codeFile,
        dryRun: true,
        // Use prod-looking endpoint so resolvePortalUrl would match if not suppressed.
        endpointUrl: 'https://api.testsprite.com',
      },
      { stdout: line => out.push(line), stderr: line => stderrLines.push(line) },
    );
    const printed = JSON.parse(out.join('')) as Record<string, unknown>;
    expect(printed['dashboardUrl']).toBeUndefined();
    expect(stderrLines.some(l => l.startsWith('Dashboard:'))).toBe(false);
  });

  it('runCreate: --dry-run does NOT emit Dashboard: line to stderr', async () => {
    const codeFile = writeCodeFile('test("dash", async () => {});');
    const stderrLines: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'proj_dash',
        type: 'frontend',
        name: 'dash test',
        codeFile,
        dryRun: true,
        endpointUrl: 'https://api.testsprite.com',
      },
      { stdout: () => undefined, stderr: line => stderrLines.push(line) },
    );
    expect(stderrLines.some(l => l.startsWith('Dashboard:'))).toBe(false);
  });

  // Fix 5 plan-from coverage (E2E 2026-06-10 gap): projectId comes from the
  // PLAN body, not opts — the enrichment must still fire.
  it('runCreateFromPlan: JSON mode includes dashboardUrl (projectId from plan body)', async () => {
    function writePlanFileDash(plan: unknown): string {
      const dir = mkdtempSync(join(tmpdir(), 'cli-dash-plan-'));
      const path = join(dir, 'plan.json');
      writeFileSync(path, JSON.stringify(plan), 'utf8');
      return path;
    }
    const { credentialsPath } = makeCreds('sk-test', 'https://api.testsprite.com');
    const planFile = writePlanFileDash({
      projectId: 'proj_dash_plan',
      type: 'frontend',
      name: 'dash plan test',
      planSteps: [{ type: 'action', description: 'navigate' }],
    });
    const fetchImpl = makeFetch((_url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { status: 200, body: { items: [] } };
      return { status: 200, body: SAMPLE_RESP };
    });
    const out: string[] = [];
    await runCreateFromPlan(
      { profile: 'default', output: 'json', debug: false, planFrom: planFile },
      { credentialsPath, fetchImpl, stdout: line => out.push(line), stderr: () => undefined },
    );
    const printed = JSON.parse(out.join('')) as { testId: string; dashboardUrl?: string };
    expect(printed.testId).toBe('test_dash_01');
    expect(printed.dashboardUrl).toBe(
      'https://www.testsprite.com/dashboard/tests/proj_dash_plan/test/test_dash_01',
    );
  });

  it('runCreateFromPlan: --dry-run does NOT emit dashboardUrl', async () => {
    function writePlanFileDash(plan: unknown): string {
      const dir = mkdtempSync(join(tmpdir(), 'cli-dash-plan-dry-'));
      const path = join(dir, 'plan.json');
      writeFileSync(path, JSON.stringify(plan), 'utf8');
      return path;
    }
    const planFile = writePlanFileDash({
      projectId: 'proj_dash_plan',
      type: 'frontend',
      name: 'dash plan test',
      planSteps: [{ type: 'action', description: 'navigate' }],
    });
    const out: string[] = [];
    const stderrLines: string[] = [];
    await runCreateFromPlan(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        planFrom: planFile,
        dryRun: true,
        endpointUrl: 'https://api.testsprite.com',
      },
      { stdout: line => out.push(line), stderr: line => stderrLines.push(line) },
    );
    const printed = JSON.parse(out.join('')) as Record<string, unknown>;
    expect(printed['dashboardUrl']).toBeUndefined();
    expect(stderrLines.some(l => l.startsWith('Dashboard:'))).toBe(false);
  });

  // R1: suppress dashboardUrl under --dry-run (test create-batch)
  it('runCreateBatch: --dry-run does NOT include dashboardUrl in JSON output', async () => {
    function writePlansJsonl(plans: unknown[]): string {
      const dir = mkdtempSync(join(tmpdir(), 'cli-dash-batch-'));
      const path = join(dir, 'plans.jsonl');
      writeFileSync(path, plans.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf8');
      return path;
    }
    const spec = {
      projectId: 'proj_dash',
      type: 'frontend' as const,
      name: 'dash batch',
      planSteps: [{ type: 'action', description: 'navigate' }],
    };
    const plansFile = writePlansJsonl([spec]);
    const out: string[] = [];
    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        plans: plansFile,
        dryRun: true,
        endpointUrl: 'https://api.testsprite.com',
      },
      { stdout: line => out.push(line), stderr: () => undefined },
    );
    // In dry-run the output may be a descriptor envelope (no results key) or
    // a batch response — in either case no dashboardUrl must appear anywhere.
    const hasUrl = out.join('').includes('dashboardUrl');
    expect(hasUrl).toBe(false);
  });

  // R3a: dashboardUrl in create --run JSON envelope
  it('runCreate --run: dashboardUrl is included in the merged { ...create, run } JSON envelope', async () => {
    // prod API URL so resolvePortalUrl maps correctly
    const { credentialsPath } = makeCreds('sk-test', 'https://api.testsprite.com');
    const codeFile = writeCodeFile('test("chain", async () => {});');
    const CREATE_RESP = {
      testId: 'test_chain_01',
      type: 'frontend' as const,
      codeVersion: 'v1',
      createdAt: '2026-06-09T10:00:00.000Z',
    };
    const TRIGGER_RESP = {
      runId: 'run_chain_01',
      status: 'queued' as const,
      enqueuedAt: '2026-06-09T10:00:01.000Z',
      codeVersion: 'v1',
      targetUrl: 'https://example.com',
    };
    const fetchImpl = makeFetch((url, init) => {
      if ((init.method ?? 'GET') === 'GET') return { status: 200, body: { items: [] } };
      if (url.includes('/runs')) return { status: 200, body: TRIGGER_RESP };
      return { status: 200, body: CREATE_RESP };
    });
    const out: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'proj_chain',
        type: 'frontend',
        name: 'chain test',
        codeFile,
        run: true,
        wait: false,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line), stderr: () => undefined },
    );
    const printed = JSON.parse(out.join('')) as Record<string, unknown>;
    // The merged envelope must carry dashboardUrl from the create context.
    expect(printed['dashboardUrl']).toBe(
      'https://www.testsprite.com/dashboard/tests/proj_chain/test/test_chain_01',
    );
  });

  it('runCreate --run --dry-run: no dashboardUrl in the dry-run descriptor envelope', async () => {
    const codeFile = writeCodeFile('test("chain", async () => {});');
    const out: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'proj_chain',
        type: 'frontend',
        name: 'chain test',
        codeFile,
        run: true,
        wait: false,
        dryRun: true,
        endpointUrl: 'https://api.testsprite.com',
      },
      { stdout: line => out.push(line), stderr: () => undefined },
    );
    expect(out.join('').includes('dashboardUrl')).toBe(false);
  });

  // R3b: dashboardUrl in create-batch --run JSON output
  it('runCreateBatch --run: per-item dashboardUrl in JSON run results', async () => {
    function writePlansJsonl2(plans: unknown[]): string {
      const dir = mkdtempSync(join(tmpdir(), 'cli-dash-batch-run-'));
      const path = join(dir, 'plans.jsonl');
      writeFileSync(path, plans.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf8');
      return path;
    }
    // Use prod API URL
    const { credentialsPath } = makeCreds('sk-test', 'https://api.testsprite.com');
    const spec = {
      projectId: 'proj_batch',
      type: 'frontend' as const,
      name: 'batch spec',
      planSteps: [{ type: 'action', description: 'navigate' }],
    };
    const plansFile = writePlansJsonl2([spec]);
    const BATCH_CREATE_RESP = {
      results: [{ specIndex: 0, testId: 'test_batch_01', status: 'created' as const }],
      summary: { total: 1, created: 1, failed: 0 },
    };
    const TRIGGER_RESP = {
      runId: 'run_batch_01',
      status: 'queued' as const,
      enqueuedAt: '2026-06-09T10:00:00.000Z',
      codeVersion: 'v1',
      targetUrl: 'https://example.com',
    };
    const fetchImpl = makeFetch(url => {
      if (url.includes('/tests/batch')) return { body: BATCH_CREATE_RESP };
      if (url.includes('/runs')) return { body: TRIGGER_RESP };
      return {
        status: 404,
        body: {
          error: { code: 'NOT_FOUND', message: 'not found', nextAction: '', requestId: 'r1' },
        },
      };
    });
    const out: string[] = [];
    // Use sleep injection to avoid real delays. The run status is 'queued' (no --wait),
    // so runBatchRun throws CLIError(1) at the end — catch it to inspect stdout first.
    try {
      await runCreateBatch(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          plans: plansFile,
          run: true,
          wait: false,
          dryRun: false,
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: line => out.push(line),
          stderr: () => undefined,
          sleep: () => Promise.resolve(),
        },
      );
    } catch {
      // CLIError exit 1 expected because status is 'queued' (not 'passed').
      // JSON was already emitted to stdout before the throw.
    }
    const printed = JSON.parse(out.join('')) as { results?: Array<Record<string, unknown>> };
    expect(printed.results).toHaveLength(1);
    expect(printed.results![0]!['dashboardUrl']).toBe(
      'https://www.testsprite.com/dashboard/tests/proj_batch/test/test_batch_01',
    );
  });

  it('runCreateBatch --run --dry-run: no dashboardUrl in dry-run run results', async () => {
    function writePlansJsonl3(plans: unknown[]): string {
      const dir = mkdtempSync(join(tmpdir(), 'cli-dash-batch-run-dry-'));
      const path = join(dir, 'plans.jsonl');
      writeFileSync(path, plans.map(p => JSON.stringify(p)).join('\n') + '\n', 'utf8');
      return path;
    }
    const spec = {
      projectId: 'proj_batch',
      type: 'frontend' as const,
      name: 'batch dry-run spec',
      planSteps: [{ type: 'action', description: 'navigate' }],
    };
    const plansFile = writePlansJsonl3([spec]);
    const out: string[] = [];
    await runCreateBatch(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        plans: plansFile,
        run: true,
        wait: false,
        dryRun: true,
        endpointUrl: 'https://api.testsprite.com',
      },
      { stdout: line => out.push(line), stderr: () => undefined },
    );
    expect(out.join('').includes('dashboardUrl')).toBe(false);
  });
});
