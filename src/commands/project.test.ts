import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/errors.js';
import { terminalWidth } from '../lib/ticker.js';
import { DRY_RUN_BANNER, resetDryRunBannerForTesting } from '../lib/client-factory.js';
import {
  type CliProject,
  type CliDeleteProjectResponse,
  type CliUpdateProjectResponse,
  createProjectCommand,
  renderProjectListText,
  runCreate,
  runDelete,
  runGet,
  runList,
  runUpdate,
  parseTestIdAttributesFlag,
} from './project.js';
import { onFakeTimers } from '../../test/helpers/fake-timers.js';

const PROJECT_FIXTURE: CliProject = {
  id: 'project_b3c91efa',
  name: 'Checkout',
  type: 'frontend',
  createdFrom: 'portal',
  createdAt: '2026-04-15T10:23:00.000Z',
  updatedAt: '2026-05-05T08:12:00.000Z',
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
): {
  credentialsPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'cli-p2-'));
  const credentialsPath = join(dir, 'credentials');
  mkdirSync(dir, { recursive: true });
  writeFileSync(credentialsPath, `[default]\napi_url = ${apiUrl}\napi_key = ${apiKey}\n`, {
    mode: 0o600,
  });
  return { credentialsPath };
}

describe('createProjectCommand', () => {
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

  it('exposes project subcommands', () => {
    const project = createProjectCommand();
    const names = project.commands.map(c => c.name()).sort();
    expect(names).toEqual(['create', 'delete', 'env', 'get', 'list', 'update']);
  });

  it('list exposes the pagination flags from the design contract', () => {
    const project = createProjectCommand();
    const list = project.commands.find(c => c.name() === 'list')!;
    const flagNames = list.options.map(o => o.long);
    expect(flagNames).toContain('--page-size');
    expect(flagNames).toContain('--starting-token');
    expect(flagNames).toContain('--max-items');
    expect(flagNames).toContain('--columns');
    expect(flagNames).toContain('--no-header');
  });
});

describe('runList', () => {
  it('list shows default environment and count', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: {
        items: [{ ...PROJECT_FIXTURE, defaultEnvironment: 'staging', environmentCount: 2 }],
        nextToken: null,
      },
    }));
    const out: string[] = [];

    await runList(
      { profile: 'default', output: 'text', debug: false, pageSize: 25 },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const [header, row] = out.join('\n').split('\n');
    expect(header).toMatch(/DEFAULT ENV\s+ENVS/);
    expect(row).toMatch(/staging\s+2/);
  });

  it('list renders dash when the server omits environment fields', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { items: [PROJECT_FIXTURE], nextToken: null },
    }));
    const out: string[] = [];

    await runList(
      { profile: 'default', output: 'text', debug: false, pageSize: 25 },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const [header, row] = out.join('\n').split('\n');
    expect(header).toMatch(/DEFAULT ENV\s+ENVS/);
    expect(row).toMatch(/-\s+-/);

    const selectedOut: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        pageSize: 25,
        columns: 'name,defaultenv,envs',
        noHeader: true,
      },
      { credentialsPath, fetchImpl, stdout: line => selectedOut.push(line) },
    );
    expect(selectedOut.join('\n')).toMatch(/^Checkout\s+-\s+-$/);
  });

  it('returns the first page when no flags are passed (auto-paging follows nextToken)', async () => {
    const { credentialsPath } = makeCreds();
    let calls = 0;
    const fetchImpl = makeFetch((_url, _init) => {
      calls += 1;
      if (calls === 1) {
        return {
          body: { items: [PROJECT_FIXTURE], nextToken: 'opaque-cursor-1' },
        };
      }
      return { body: { items: [{ ...PROJECT_FIXTURE, id: 'project_2' }], nextToken: null } };
    });

    const out: string[] = [];
    const page = await runList(
      { profile: 'default', output: 'json', debug: false },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    expect(calls).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.nextToken).toBeNull();
    expect(JSON.parse(out[0]!).items).toHaveLength(2);
  });

  it('--page-size returns one page (no auto-paging) and surfaces the nextToken', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return {
        body: {
          items: [PROJECT_FIXTURE],
          nextToken: 'opaque-cursor-A',
        },
      };
    });

    const out: string[] = [];
    const page = await runList(
      { profile: 'default', output: 'json', debug: false, pageSize: 1 },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('pageSize=1');
    expect(page.items).toHaveLength(1);
    expect(page.nextToken).toBe('opaque-cursor-A');
  });

  it('--max-items caps the result count across multiple pages', async () => {
    const { credentialsPath } = makeCreds();
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      return {
        body: {
          items: [
            { ...PROJECT_FIXTURE, id: `project_${calls}_a` },
            { ...PROJECT_FIXTURE, id: `project_${calls}_b` },
          ],
          nextToken: calls < 3 ? `cursor-${calls}` : null,
        },
      };
    });

    const page = await runList(
      { profile: 'default', output: 'json', debug: false, maxItems: 3 },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );

    expect(page.items).toHaveLength(3);
    // Server still has more pages; the resumable token surfaces.
    expect(page.nextToken).toBe('cursor-2');
  });

  it('--starting-token resumes pagination from the supplied cursor', async () => {
    const { credentialsPath } = makeCreds();
    const seenCursors: Array<string | null> = [];
    const fetchImpl = makeFetch(url => {
      const match = /cursor=([^&]+)/.exec(url);
      seenCursors.push(match ? decodeURIComponent(match[1]!) : null);
      return { body: { items: [PROJECT_FIXTURE], nextToken: null } };
    });

    await runList(
      { profile: 'default', output: 'json', debug: false, startingToken: 'resume-here' },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );

    expect(seenCursors[0]).toBe('resume-here');
  });

  it('rejects pageSize=0 with a local VALIDATION_ERROR (no network call)', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => {
      throw new Error('network should not be hit');
    });

    await expect(
      runList(
        { profile: 'default', output: 'json', debug: false, pageSize: 0 },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'page-size' },
    });
  });

  it('rejects invalid pagination before requiring credentials', async () => {
    const credentialsPath = join(mkdtempSync(join(tmpdir(), 'cli-p2-no-creds-')), 'credentials');
    const fetchImpl = vi.fn();

    await expect(
      runList(
        { profile: 'default', output: 'json', debug: false, pageSize: 1.5 },
        { credentialsPath, fetchImpl: fetchImpl as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: { field: 'page-size' },
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects invalid dry-run pagination before emitting the dry-run banner', async () => {
    const stderr: string[] = [];
    const fetchImpl = vi.fn();

    await expect(
      runList(
        { profile: 'default', output: 'json', debug: false, dryRun: true, pageSize: 1.5 },
        {
          credentialsPath: join(mkdtempSync(join(tmpdir(), 'cli-p2-dryrun-')), 'credentials'),
          fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
          stderr: line => stderr.push(line),
        },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: { field: 'page-size' },
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stderr.join('\n')).not.toContain(DRY_RUN_BANNER);
  });

  it('rejects pageSize=101 with VALIDATION_ERROR exit 5 (Fix 7 — upper-bound enforced client-side)', async () => {
    // Previously silently clamped to 100; now rejected so callers get fast feedback.
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => {
      throw new Error('network should not be hit');
    });

    await expect(
      runList(
        { profile: 'default', output: 'json', debug: false, pageSize: 101 },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: { field: 'page-size' },
    });
  });

  it('renders text output with a column header and nextToken footer when present', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { items: [PROJECT_FIXTURE], nextToken: 'next-please' },
    }));

    const out: string[] = [];
    await runList(
      { profile: 'default', output: 'text', debug: false, pageSize: 25 },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const block = out.join('\n');
    expect(block).toContain('ID');
    expect(block).toContain('NAME');
    expect(block).toContain('TYPE');
    expect(block).toContain('FROM');
    expect(block).toContain('CREATED');
    expect(block).toContain('Checkout');
    expect(block).toContain('nextToken: next-please');
  });

  it('text output selects/reorders columns and suppresses the header', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { items: [PROJECT_FIXTURE], nextToken: null },
    }));

    const out: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        pageSize: 25,
        columns: 'name,id',
        noHeader: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const block = out.join('\n');
    expect(block).toMatch(/^Checkout\s+project_b3c91efa$/);
    expect(block).not.toContain('NAME');
    expect(block).not.toContain('CREATED');
  });

  it('text output rejects unknown columns with VALIDATION_ERROR before auth/network access', async () => {
    await expect(
      runList(
        {
          profile: 'default',
          output: 'text',
          debug: false,
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

  it('json output ignores text-only column flags', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { items: [PROJECT_FIXTURE], nextToken: null },
    }));

    const out: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        pageSize: 25,
        columns: 'bogus',
        noHeader: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    expect(JSON.parse(out.join('\n')).items[0].id).toBe('project_b3c91efa');
  });

  it('text output reads "No projects." when items is empty and nextToken is null', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { items: [], nextToken: null } }));

    const out: string[] = [];
    await runList(
      { profile: 'default', output: 'text', debug: false, pageSize: 25 },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    expect(out.join('\n')).toBe('No projects.');
  });

  it('text output reads "No projects on this page." with nextToken when filtered out', async () => {
    const { credentialsPath } = makeCreds();
    // Empty page that still has a nextToken — happens when a server-side
    // filter excludes everything in the current window.
    const fetchImpl = makeFetch(() => ({ body: { items: [], nextToken: 'still-more' } }));

    const out: string[] = [];
    await runList(
      { profile: 'default', output: 'text', debug: false, pageSize: 25 },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const block = out.join('\n');
    expect(block).toContain('No projects on this page.');
    expect(block).toContain('nextToken: still-more');
  });

  it('--debug emits HTTP events to stderr', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { items: [], nextToken: null } }));

    const stderr: string[] = [];
    await runList(
      { profile: 'default', output: 'json', debug: true, pageSize: 25 },
      { credentialsPath, fetchImpl, stdout: () => undefined, stderr: line => stderr.push(line) },
    );

    // Format is now "[debug <ISO-TS>] {...}"
    expect(stderr.some(line => line.startsWith('[debug '))).toBe(true);
    expect(stderr.some(line => line.includes('"kind":"request"'))).toBe(true);
  });
});

describe('runList — org attribution (ORG column)', () => {
  it('adds the ORG column only when at least one row carries orgId', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: {
        items: [{ ...PROJECT_FIXTURE, orgId: 'org_1', orgName: 'Acme Corp' }],
        nextToken: null,
      },
    }));

    const out: string[] = [];
    await runList(
      { profile: 'default', output: 'text', debug: false, pageSize: 25 },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const block = out.join('\n');
    expect(block).toContain('ORG');
    expect(block).toContain('Acme Corp');
  });

  it('omits the ORG column entirely for a legacy (non-org-scoped) response', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { items: [PROJECT_FIXTURE], nextToken: null },
    }));

    const out: string[] = [];
    await runList(
      { profile: 'default', output: 'text', debug: false, pageSize: 25 },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    expect(out.join('\n')).not.toContain('ORG');
  });

  it('falls back to orgId when orgName is absent', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { items: [{ ...PROJECT_FIXTURE, orgId: 'org_1' }], nextToken: null },
    }));

    const out: string[] = [];
    await runList(
      { profile: 'default', output: 'text', debug: false, pageSize: 25 },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const block = out.join('\n');
    expect(block).toContain('ORG');
    expect(block).toContain('org_1');
  });

  it('an explicit --columns org still renders the column on a legacy (no-org-data) page', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { items: [PROJECT_FIXTURE], nextToken: null },
    }));

    const out: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        pageSize: 25,
        columns: 'name,org',
        noHeader: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    // No org data on this row -> the ORG cell renders empty, but the column
    // (and the explicit selection) is still honored, not rejected.
    expect(out.join('\n')).toMatch(/^Checkout\s*$/);
  });

  it('JSON output passes orgId/orgName through verbatim', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: {
        items: [{ ...PROJECT_FIXTURE, orgId: 'org_1', orgName: 'Acme Corp' }],
        nextToken: null,
      },
    }));

    const out: string[] = [];
    await runList(
      { profile: 'default', output: 'json', debug: false, pageSize: 25 },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const parsed = JSON.parse(out.join('\n')) as { items: CliProject[] };
    expect(parsed.items[0]!.orgId).toBe('org_1');
    expect(parsed.items[0]!.orgName).toBe('Acme Corp');
  });
});

describe('runGet — org attribution', () => {
  it('renders an `org:` line when the project carries orgId/orgName', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { ...PROJECT_FIXTURE, orgId: 'org_1', orgName: 'Acme Corp' },
    }));

    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, projectId: PROJECT_FIXTURE.id },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    expect(out.join('\n')).toContain('org:         Acme Corp (org_1)');
  });

  it('falls back to "(name unknown)" when orgId is present but orgName is absent', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { ...PROJECT_FIXTURE, orgId: 'org_1' },
    }));

    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, projectId: PROJECT_FIXTURE.id },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    expect(out.join('\n')).toContain('org:         (name unknown) (org_1)');
  });

  it('omits the `org:` line entirely when the project has no org attribution', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: PROJECT_FIXTURE }));

    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, projectId: PROJECT_FIXTURE.id },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    expect(out.join('\n')).not.toContain('org:');
    expect(out.join('\n')).not.toContain('undefined');
  });

  it('JSON output passes orgId/orgName through verbatim', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { ...PROJECT_FIXTURE, orgId: 'org_1', orgName: 'Acme Corp' },
    }));

    const project = await runGet(
      { profile: 'default', output: 'json', debug: false, projectId: PROJECT_FIXTURE.id },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );

    expect(project.orgId).toBe('org_1');
    expect(project.orgName).toBe('Acme Corp');
  });
});

describe('the environment flags are gone from project create and update', () => {
  it.each([
    ['create', ['--type', 'frontend', '--name', 'Shop', '--url', 'https://shop.example.com']],
    ['create', ['--type', 'frontend', '--name', 'Shop', '--local', '3000']],
    ['create', ['--type', 'frontend', '--name', 'Shop', '--description', 'x']],
    ['update', ['proj_x', '--url', 'https://shop.example.com']],
    ['update', ['proj_x', '--username', 'qa', '--password-file', '/tmp/pw']],
  ])('%s %j is an unknown option', async (name, args) => {
    const project = createProjectCommand();
    project.exitOverride();
    project.commands.find(c => c.name() === name)!.exitOverride();
    await expect(project.parseAsync([name, ...args], { from: 'user' })).rejects.toThrow(
      /unknown option/i,
    );
  });

  it('rejects --description on `project update` as an unknown option', async () => {
    const project = createProjectCommand();
    const update = project.commands.find(c => c.name() === 'update')!;
    project.exitOverride();
    update.exitOverride();

    await expect(
      project.parseAsync(['update', 'proj_x', '--description', 'should not exist'], {
        from: 'user',
      }),
    ).rejects.toThrow(/unknown option.*--description/i);
  });
});

describe('createProjectCommand --page-size option parser', () => {
  it('rejects non-numeric --page-size values via commander', async () => {
    const project = createProjectCommand();
    const list = project.commands.find(c => c.name() === 'list')!;
    project.exitOverride();
    list.exitOverride();

    await expect(
      project.parseAsync(['list', '--page-size', 'abc'], { from: 'user' }),
    ).rejects.toThrow();
  });

  it('rejects --page-size=0 via commander', async () => {
    const project = createProjectCommand();
    const list = project.commands.find(c => c.name() === 'list')!;
    project.exitOverride();
    list.exitOverride();

    await expect(
      project.parseAsync(['list', '--page-size', '0'], { from: 'user' }),
    ).rejects.toThrow();
  });

  it('forwards a server VALIDATION_ERROR envelope as ApiError exit 5', async () => {
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
        { profile: 'default', output: 'json', debug: false, startingToken: 'bogus' },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('project read response validation', () => {
  it.each([
    ['missing name', { ...PROJECT_FIXTURE, name: undefined }],
    ['invalid attribute list', { ...PROJECT_FIXTURE, testIdAttributes: 'data-testid' }],
    ['invalid instruction', { ...PROJECT_FIXTURE, instruction: { text: 'Unexpected shape' } }],
  ])('rejects %s before printing a successful result', async (_label, body) => {
    const out: string[] = [];
    await expect(
      runGet(
        { profile: 'default', output: 'json', debug: false, projectId: PROJECT_FIXTURE.id },
        { ...makeCreds(), fetchImpl: makeFetch(() => ({ body })), stdout: line => out.push(line) },
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL', exitCode: 1 });
    expect(out).toEqual([]);
  });

  it.each([false, true])('validates list rows before output (single page: %s)', async single => {
    const out: string[] = [];
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      return {
        body:
          !single && calls === 1
            ? { items: [PROJECT_FIXTURE], nextToken: 'second-page' }
            : { items: [{ ...PROJECT_FIXTURE, id: null }], nextToken: null },
      };
    });
    await expect(
      runList(
        { profile: 'default', output: 'text', debug: false, ...(single ? { pageSize: 1 } : {}) },
        { ...makeCreds(), fetchImpl, stdout: line => out.push(line) },
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL', exitCode: 1 });
    expect(calls).toBe(single ? 1 : 2);
    expect(out).toEqual([]);
  });

  it('rejects a malformed cursor instead of returning it as a usable next page', async () => {
    const out: string[] = [];
    await expect(
      runList(
        { profile: 'default', output: 'json', debug: false, pageSize: 1 },
        {
          ...makeCreds(),
          fetchImpl: makeFetch(() => ({ body: { items: [PROJECT_FIXTURE], nextToken: 17 } })),
          stdout: line => out.push(line),
        },
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL', exitCode: 1 });
    expect(out).toEqual([]);
  });

  it.each([
    ['defaultEnvironment', { defaultEnvironment: {} }],
    ['environmentCount', { environmentCount: 'x' }],
  ])('rejects a wrong-typed %s before the text renderer runs', async (_field, patch) => {
    const out: string[] = [];
    await expect(
      runGet(
        { profile: 'default', output: 'text', debug: false, projectId: PROJECT_FIXTURE.id },
        {
          ...makeCreds(),
          fetchImpl: makeFetch(() => ({ body: { ...PROJECT_FIXTURE, ...patch } })),
          stdout: line => out.push(line),
        },
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL', exitCode: 1 });
    expect(out).toEqual([]);
  });

  it('normalizes an omitted nextToken to the terminal null cursor', async () => {
    const out: string[] = [];
    const result = await runList(
      { profile: 'default', output: 'json', debug: false, pageSize: 1 },
      {
        ...makeCreds(),
        fetchImpl: makeFetch(() => ({ body: { items: [PROJECT_FIXTURE] } })),
        stdout: line => out.push(line),
      },
    );
    expect(result.nextToken).toBeNull();
    expect(JSON.parse(out[0]!)).toEqual({ items: [PROJECT_FIXTURE], nextToken: null });
  });

  it('preserves new server fields and enum values without inventing absent optional fields', async () => {
    const body = {
      ...PROJECT_FIXTURE,
      type: 'mobile',
      createdFrom: 'import',
      owner: { name: 'Team' },
    };
    const out: string[] = [];
    const result = await runGet(
      { profile: 'default', output: 'json', debug: false, projectId: PROJECT_FIXTURE.id },
      { ...makeCreds(), fetchImpl: makeFetch(() => ({ body })), stdout: line => out.push(line) },
    );
    expect(result).toEqual(body);
    expect(JSON.parse(out[0]!)).toEqual(body);
    expect(result).not.toHaveProperty('targetUrl');
    expect(result).not.toHaveProperty('testIdAttributes');
    expect(result).not.toHaveProperty('orgName');
  });
});

describe('runGet', () => {
  it('shows the saved project instruction as indented text and returns the original value in JSON', async () => {
    const instruction = 'Use the guest environment.\n\u001b[31mStop on a challenge.\u001b[0m';
    const options = { profile: 'default', debug: false, projectId: PROJECT_FIXTURE.id };
    const out: string[] = [];
    const deps = {
      ...makeCreds(),
      fetchImpl: makeFetch(() => ({ body: { ...PROJECT_FIXTURE, instruction } })),
      stdout: (line: string) => out.push(line),
    };
    await runGet({ ...options, output: 'text' }, deps);
    expect(out[0]).toContain('instruction:\n  Use the guest environment.\n  Stop on a challenge.');
    await runGet({ ...options, output: 'json' }, deps);
    expect(JSON.parse(out[1]!).instruction).toBe(instruction);
  });

  it('distinguishes an unset instruction from an older server that omits the field', async () => {
    const out: string[] = [];
    for (const body of [{ ...PROJECT_FIXTURE, instruction: null }, PROJECT_FIXTURE]) {
      await runGet(
        { profile: 'default', output: 'text', debug: false, projectId: PROJECT_FIXTURE.id },
        { ...makeCreds(), fetchImpl: makeFetch(() => ({ body })), stdout: line => out.push(line) },
      );
    }
    expect(out[0]).toContain('instruction: (not set)');
    expect(out[1]).not.toContain('instruction:');
  });

  it('get shows default environment and count', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { ...PROJECT_FIXTURE, defaultEnvironment: 'staging', environmentCount: 2 },
    }));
    const out: string[] = [];

    await runGet(
      { profile: 'default', output: 'text', debug: false, projectId: PROJECT_FIXTURE.id },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const block = out.join('\n');
    expect(block).toContain('defaultEnv:  staging');
    expect(block).toContain('envs:        2');
    expect(block).toContain(`testsprite project env list ${PROJECT_FIXTURE.id}`);
  });

  it('get omits environment lines for older servers', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: PROJECT_FIXTURE }));
    const out: string[] = [];

    await runGet(
      { profile: 'default', output: 'text', debug: false, projectId: PROJECT_FIXTURE.id },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    const block = out.join('\n');
    expect(block).not.toContain('Default environment:');
    expect(block).not.toContain('Environments:');
    expect(block).not.toContain('testsprite project env list');
  });

  it('zero environments show 0 and no default', async () => {
    const { credentialsPath } = makeCreds();
    const zero = { ...PROJECT_FIXTURE, defaultEnvironment: null, environmentCount: 0 };
    const fetchImpl = makeFetch(url => ({
      body: url.endsWith(`/${PROJECT_FIXTURE.id}`) ? zero : { items: [zero], nextToken: null },
    }));
    const listOut: string[] = [];
    const getOut: string[] = [];

    await runList(
      { profile: 'default', output: 'text', debug: false, pageSize: 25 },
      { credentialsPath, fetchImpl, stdout: line => listOut.push(line) },
    );
    await runGet(
      { profile: 'default', output: 'text', debug: false, projectId: PROJECT_FIXTURE.id },
      { credentialsPath, fetchImpl, stdout: line => getOut.push(line) },
    );

    expect(listOut.join('\n').split('\n')[1]).toMatch(/-\s+0/);
    expect(getOut.join('\n')).toContain('defaultEnv:  -');
    expect(getOut.join('\n')).toContain('envs:        0');
    expect(getOut.join('\n')).not.toContain('testsprite project env list');

    const selectedOut: string[] = [];
    await runList(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        pageSize: 25,
        columns: 'defaultenv,envs',
        noHeader: true,
      },
      { credentialsPath, fetchImpl, stdout: line => selectedOut.push(line) },
    );
    expect(selectedOut.join('\n')).toMatch(/^-\s+0$/);
  });

  it('json passes environment summary fields through', async () => {
    const { credentialsPath } = makeCreds();
    const project = { ...PROJECT_FIXTURE, defaultEnvironment: 'staging', environmentCount: 2 };
    const fetchImpl = makeFetch(url => ({
      body: url.endsWith(`/${PROJECT_FIXTURE.id}`)
        ? project
        : { items: [project], nextToken: null },
    }));
    const listOut: string[] = [];
    const getOut: string[] = [];

    await runList(
      { profile: 'default', output: 'json', debug: false, pageSize: 25 },
      { credentialsPath, fetchImpl, stdout: line => listOut.push(line) },
    );
    await runGet(
      { profile: 'default', output: 'json', debug: false, projectId: PROJECT_FIXTURE.id },
      { credentialsPath, fetchImpl, stdout: line => getOut.push(line) },
    );

    expect(JSON.parse(listOut.join('\n')).items[0]).toMatchObject({
      defaultEnvironment: 'staging',
      environmentCount: 2,
    });
    expect(JSON.parse(getOut.join('\n'))).toMatchObject({
      defaultEnvironment: 'staging',
      environmentCount: 2,
    });

    const olderFetch = makeFetch(url => ({
      body: url.endsWith(`/${PROJECT_FIXTURE.id}`)
        ? PROJECT_FIXTURE
        : { items: [PROJECT_FIXTURE], nextToken: null },
    }));
    const olderListOut: string[] = [];
    const olderGetOut: string[] = [];
    await runList(
      { profile: 'default', output: 'json', debug: false, pageSize: 25 },
      { credentialsPath, fetchImpl: olderFetch, stdout: line => olderListOut.push(line) },
    );
    await runGet(
      { profile: 'default', output: 'json', debug: false, projectId: PROJECT_FIXTURE.id },
      { credentialsPath, fetchImpl: olderFetch, stdout: line => olderGetOut.push(line) },
    );
    expect(JSON.parse(olderListOut.join('\n')).items[0]).not.toHaveProperty('defaultEnvironment');
    expect(JSON.parse(olderListOut.join('\n')).items[0]).not.toHaveProperty('environmentCount');
    expect(JSON.parse(olderGetOut.join('\n'))).not.toHaveProperty('defaultEnvironment');
    expect(JSON.parse(olderGetOut.join('\n'))).not.toHaveProperty('environmentCount');
  });

  it('GETs /projects/{id} and prints the §6.1 fields in text mode', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: PROJECT_FIXTURE };
    });

    const out: string[] = [];
    const project = await runGet(
      { profile: 'default', output: 'text', debug: false, projectId: 'project_b3c91efa' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );

    expect(seen[0]).toContain('/projects/project_b3c91efa');
    expect(project.id).toBe('project_b3c91efa');
    const block = out.join('\n');
    expect(block).toContain('id:          project_b3c91efa');
    expect(block).toContain('type:        frontend');
    expect(block).toContain('createdFrom: portal');
  });

  it('ignores the targetUrl and originMode fields an older backend still sends', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { ...PROJECT_FIXTURE, targetUrl: 'http://localhost:3000', originMode: 'local' },
    }));
    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, projectId: 'project_b3c91efa' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    expect(block).toContain('id:');
    expect(block).not.toContain('targetUrl');
    expect(block).not.toContain('(Local)');
  });

  it('NOT_FOUND envelope from server propagates as ApiError exit 4', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      status: 404,
      body: {
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found.',
          nextAction: 'Check the id with `testsprite project list`.',
          requestId: 'req_test',
          details: { resource: 'project', id: 'project_missing' },
        },
      },
    }));

    await expect(
      runGet(
        { profile: 'default', output: 'json', debug: false, projectId: 'project_missing' },
        { credentialsPath, fetchImpl, stdout: () => undefined },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', exitCode: 4 });
  });

  it('URL-encodes the project id (defense against `/` or `?` in ids)', async () => {
    const { credentialsPath } = makeCreds();
    const seen: string[] = [];
    const fetchImpl = makeFetch(url => {
      seen.push(url);
      return { body: PROJECT_FIXTURE };
    });

    await runGet(
      { profile: 'default', output: 'json', debug: false, projectId: 'odd/id?weird' },
      { credentialsPath, fetchImpl, stdout: () => undefined },
    );

    expect(seen[0]).toContain('odd%2Fid%3Fweird');
  });
});

// ---------------------------------------------------------------------------
// P6 — project create
// ---------------------------------------------------------------------------

describe('runCreate', () => {
  it('P6 FE happy — POSTs /projects with type=frontend + name + idempotency header', async () => {
    const { credentialsPath } = makeCreds();
    const sentBodies: unknown[] = [];
    const sentHeaders: Record<string, string>[] = [];
    const createdProject: CliProject = {
      ...PROJECT_FIXTURE,
      id: 'proj_new',
      type: 'frontend',
      name: 'My FE App',
    };
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      const body = init.body ? (JSON.parse(init.body as string) as unknown) : undefined;
      if (body) sentBodies.push(body);
      const h = new Headers(init.headers);
      const entry: Record<string, string> = {};
      h.forEach((v, k) => {
        entry[k] = v;
      });
      sentHeaders.push(entry);
      return new Response(JSON.stringify(createdProject), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const stderrLines: string[] = [];
    const out: string[] = [];
    const result = await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        type: 'frontend',
        name: 'My FE App',
        idempotencyKey: 'idem-fe-001',
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: line => out.push(line),
        stderr: line => stderrLines.push(line),
      },
    );

    expect(result.id).toBe('proj_new');
    expect(result.type).toBe('frontend');
    // Verify body
    const body = sentBodies[0] as Record<string, unknown>;
    expect(body.type).toBe('frontend');
    expect(body.name).toBe('My FE App');
    // Verify idempotency header
    const h = sentHeaders[0]!;
    expect(h['idempotency-key']).toBe('idem-fe-001');
    // User-supplied idempotency key is NOT echoed to stderr (P2-6: only
    // auto-generated keys are surfaced at --verbose/--debug/json mode).
    expect(stderrLines.some(l => l.includes('idem-fe-001'))).toBe(false);
  });

  it('P6 BE happy — POSTs /projects with type=backend', async () => {
    const { credentialsPath } = makeCreds();
    const createdProject: CliProject = {
      ...PROJECT_FIXTURE,
      id: 'proj_be',
      type: 'backend',
      name: 'My BE API',
    };
    const fetchImpl = makeFetch(() => ({ body: createdProject }));

    const result = await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        type: 'backend',
        name: 'My BE API',
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    );

    expect(result.id).toBe('proj_be');
    expect(result.type).toBe('backend');
  });

  it('P6 — dry-run returns canned shape without hitting the network', async () => {
    resetDryRunBannerForTesting();
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not hit network in dry-run');
    });
    const out: string[] = [];
    const err: string[] = [];
    const result = await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        type: 'frontend',
        name: 'DryRun Project',
      },
      {
        credentialsPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        stdout: line => out.push(line),
        stderr: line => err.push(line),
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.type).toBe('frontend');
    expect(result.name).toBe('DryRun Project');
    // The canned sample must carry the "not from the server" banner.
    expect(err).toContain(DRY_RUN_BANNER);
  });

  it('P6 — renders text mode with §6.1 field labels', async () => {
    const { credentialsPath } = makeCreds();
    const createdProject: CliProject = {
      ...PROJECT_FIXTURE,
      id: 'proj_text',
      name: 'Text Mode',
    };
    const fetchImpl = makeFetch(() => ({ body: createdProject }));
    const out: string[] = [];
    await runCreate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        type: 'frontend',
        name: 'Text Mode',
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line), stderr: () => {} },
    );
    const block = out.join('\n');
    expect(block).toContain('id:');
    expect(block).toContain('name:');
    expect(block).toContain('type:');
  });

  it('rejects a whitespace-only --name with VALIDATION_ERROR (exit 5), no network', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not hit network — validation must fire client-side');
    });

    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          type: 'frontend',
          name: '   ',
        },
        {
          credentialsPath,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          stdout: () => {},
          stderr: () => {},
        },
      ),
    ).rejects.toMatchObject({ exitCode: 5, code: 'VALIDATION_ERROR' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  describe('id-field normalization', () => {
    it('backfills `id` when the live response only carries `projectId`', async () => {
      const { credentialsPath } = makeCreds();
      const fetchImpl = makeFetch(() => ({
        body: {
          projectId: 'proj_live_shape',
          type: 'frontend',
          name: 'Live Shape Project',
          createdFrom: 'cli',
          createdAt: '2026-07-16T00:00:00.000Z',
        },
      }));

      const result = await runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          type: 'frontend',
          name: 'Live Shape Project',
        },
        { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
      );

      expect(result.projectId).toBe('proj_live_shape');
      expect(result.id).toBe('proj_live_shape');
    });

    it('backfills `projectId` when the live response only carries `id` (pre-fix shape)', async () => {
      const { credentialsPath } = makeCreds();
      const createdProject: CliProject = {
        ...PROJECT_FIXTURE,
        id: 'proj_legacy_shape',
      };
      const fetchImpl = makeFetch(() => ({ body: createdProject }));

      const result = await runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          type: 'frontend',
          name: 'Legacy Shape Project',
        },
        { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
      );

      expect(result.id).toBe('proj_legacy_shape');
      expect(result.projectId).toBe('proj_legacy_shape');
    });

    it('--dry-run sample teaches both id field names', async () => {
      resetDryRunBannerForTesting();
      const { credentialsPath } = makeCreds();
      const result = await runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: true,
          type: 'frontend',
          name: 'DryRun Shape Project',
        },
        { credentialsPath, stdout: () => {}, stderr: () => {} },
      );

      expect(typeof result.projectId).toBe('string');
      expect(typeof result.id).toBe('string');
      expect(result.projectId).toBe(result.id);
    });
  });
});

// ---------------------------------------------------------------------------
// P7 — project update
// ---------------------------------------------------------------------------

describe('runUpdate', () => {
  it('P7 happy — PATCHes /projects/{id} with the updated fields', async () => {
    const { credentialsPath } = makeCreds();
    const updateResponse: CliUpdateProjectResponse = {
      id: 'proj_abc',
      updatedFields: ['name'],
      updatedAt: '2026-05-16T10:00:00.000Z',
    };
    const sentBodies: unknown[] = [];
    const sentMethods: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      sentMethods.push(init.method ?? 'GET');
      if (init.body) sentBodies.push(JSON.parse(init.body as string) as unknown);
      return new Response(JSON.stringify(updateResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const stderrLines: string[] = [];
    const result = await runUpdate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'proj_abc',
        name: 'New Name',
        idempotencyKey: 'idem-upd-001',
      },
      {
        credentialsPath,
        fetchImpl,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
      },
    );

    expect(result.id).toBe('proj_abc');
    expect(result.updatedFields).toEqual(['name']);
    expect(sentMethods[0]).toBe('PATCH');
    const body = sentBodies[0] as Record<string, unknown>;
    expect(body.name).toBe('New Name');
    // User-supplied idempotency key is NOT echoed to stderr (P2-6).
    expect(stderrLines.some(l => l.includes('idem-upd-001'))).toBe(false);
  });

  it('sends testIdAttributes as an ordered list; --clear sends null', async () => {
    const { credentialsPath } = makeCreds();
    const sentBodies: unknown[] = [];
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      if (init.body) sentBodies.push(JSON.parse(init.body as string) as unknown);
      return new Response(
        JSON.stringify({ projectId: 'proj_abc', updatedFields: ['testIdAttributes'] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as typeof fetch;
    const deps = { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} };
    const base = {
      profile: 'default',
      output: 'json' as const,
      debug: false,
      projectId: 'proj_abc',
    };

    await runUpdate({ ...base, testIdAttributes: ['data-element', 'data-testid'] }, deps);
    expect(sentBodies[0]).toEqual({ testIdAttributes: ['data-element', 'data-testid'] });

    await runUpdate({ ...base, clearTestIdAttributes: true }, deps);
    expect(sentBodies[1]).toEqual({ testIdAttributes: null });
  });

  it("translates an older backend's generic 400 into UNSUPPORTED when testIdAttributes was sent", async () => {
    const { credentialsPath } = makeCreds();
    const envelope = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request.',
        nextAction:
          'Field `body` is invalid: at least one field must be provided (name, targetUrl, username, password, instruction).',
        requestId: 'cli_old_backend',
        details: {
          field: 'body',
          reason:
            'at least one field must be provided (name, targetUrl, username, password, instruction)',
          accepted: ['name', 'targetUrl', 'username', 'password', 'instruction'],
        },
      },
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(envelope), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const deps = { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} };
    await expect(
      runUpdate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'proj_abc',
          testIdAttributes: ['data-element'],
        },
        deps,
      ),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED',
      details: { reason: 'test_id_attributes_unsupported_backend' },
    });
    // The same 400 without our flag in play stays a plain VALIDATION_ERROR.
    await expect(
      runUpdate(
        { profile: 'default', output: 'json', debug: false, projectId: 'proj_abc', name: 'x' },
        deps,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects --test-id-attributes together with --clear-test-id-attributes before any request', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not be called');
    });
    await expect(
      runUpdate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'proj_abc',
          testIdAttributes: ['data-element'],
          clearTestIdAttributes: true,
        },
        {
          credentialsPath,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          stdout: () => {},
          stderr: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('P7 — exits 5 VALIDATION_ERROR when no mutable flag is supplied', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not be called');
    });
    await expect(
      runUpdate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'proj_abc',
          // no mutable fields
        },
        {
          credentialsPath,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          stdout: () => {},
          stderr: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only --name with VALIDATION_ERROR (exit 5), no network', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not be called');
    });
    await expect(
      runUpdate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'proj_abc',
          name: '   ',
        },
        {
          credentialsPath,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          stdout: () => {},
          stderr: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('P7 — dry-run returns canned shape without network call', async () => {
    resetDryRunBannerForTesting();
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not hit network');
    });
    const err: string[] = [];
    const result = await runUpdate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        projectId: 'proj_dry',
        name: 'Dry Name',
      },
      {
        credentialsPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        stdout: () => {},
        stderr: line => err.push(line),
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.id).toBe('proj_dry');
    expect(result.updatedFields).toContain('name');
    // The canned sample must carry the "not from the server" banner.
    expect(err).toContain(DRY_RUN_BANNER);
  });

  it('P7 — renders text mode with updatedFields and updatedAt', async () => {
    const { credentialsPath } = makeCreds();
    const updateResponse: CliUpdateProjectResponse = {
      id: 'proj_text',
      updatedFields: ['name', 'description'],
      updatedAt: '2026-05-16T10:00:00.000Z',
    };
    const fetchImpl = makeFetch(() => ({ body: updateResponse }));
    const out: string[] = [];
    await runUpdate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'proj_text',
        name: 'New Name',
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line), stderr: () => {} },
    );
    const block = out.join('\n');
    expect(block).toContain('updatedFields:');
    expect(block).toContain('updatedAt:');
  });

  it('Fix 1 — response without updatedFields renders without throwing (text mode)', async () => {
    // Backend may omit updatedFields; the CLI must not crash with
    // "Cannot read properties of undefined (reading 'join')".
    const { credentialsPath } = makeCreds();
    const responseWithoutField: Omit<CliUpdateProjectResponse, 'updatedFields'> & {
      updatedFields?: string[];
    } = {
      id: 'proj_no_fields',
      updatedAt: '2026-06-07T00:00:00.000Z',
      // updatedFields intentionally absent
    };
    const fetchImpl = makeFetch(() => ({ body: responseWithoutField }));

    const out: string[] = [];
    const result = await runUpdate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'proj_no_fields',
        name: 'Changed Name',
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line), stderr: () => {} },
    );

    expect(result.id).toBe('proj_no_fields');
    // Must not throw; text output should contain a graceful "(none)" placeholder.
    const block = out.join('\n');
    expect(block).toContain('updatedFields: (none)');
  });

  it('Fix 1 — response without updatedFields renders gracefully in json mode', async () => {
    const { credentialsPath } = makeCreds();
    const responseWithoutField = {
      id: 'proj_json_no_fields',
      updatedAt: '2026-06-07T00:00:00.000Z',
    };
    const fetchImpl = makeFetch(() => ({ body: responseWithoutField }));

    const out: string[] = [];
    // Must not throw in json mode either.
    const result = await runUpdate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'proj_json_no_fields',
        name: 'Changed Name',
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line), stderr: () => {} },
    );

    expect(result.id).toBe('proj_json_no_fields');
    expect(result.updatedFields).toBeUndefined();
  });

  describe('id-field normalization', () => {
    it('backfills `id` when the live response only carries `projectId`', async () => {
      const { credentialsPath } = makeCreds();
      const fetchImpl = makeFetch(() => ({
        body: {
          projectId: 'proj_live_update_shape',
          updatedFields: ['name'],
          updatedAt: '2026-07-16T00:00:00.000Z',
        },
      }));

      const result = await runUpdate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'proj_live_update_shape',
          name: 'New Name',
        },
        { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
      );

      expect(result.projectId).toBe('proj_live_update_shape');
      expect(result.id).toBe('proj_live_update_shape');
    });

    it('backfills `projectId` when the live response only carries `id` (pre-fix shape)', async () => {
      const { credentialsPath } = makeCreds();
      const fetchImpl = makeFetch(() => ({
        body: {
          id: 'proj_legacy_update_shape',
          updatedFields: ['name'],
          updatedAt: '2026-07-16T00:00:00.000Z',
        },
      }));

      const result = await runUpdate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'proj_legacy_update_shape',
          name: 'New Name',
        },
        { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
      );

      expect(result.id).toBe('proj_legacy_update_shape');
      expect(result.projectId).toBe('proj_legacy_update_shape');
    });

    it('--dry-run sample teaches both id field names', async () => {
      resetDryRunBannerForTesting();
      const { credentialsPath } = makeCreds();
      const result = await runUpdate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: true,
          projectId: 'proj_dryrun_update_shape',
          name: 'New Name',
        },
        { credentialsPath, stdout: () => {}, stderr: () => {} },
      );

      expect(result.projectId).toBe('proj_dryrun_update_shape');
      expect(result.id).toBe('proj_dryrun_update_shape');
    });
  });
});

describe('runDelete', () => {
  it('refuses without --confirm and never hits the network (exit 5)', async () => {
    const { credentialsPath } = makeCreds();
    let called = 0;
    const fetchImpl = makeFetch(() => {
      called += 1;
      return { body: {} };
    });
    await expect(
      runDelete(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'proj_alpha',
          confirm: false,
        },
        { credentialsPath, fetchImpl, stdout: () => {} },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: expect.objectContaining({ field: 'confirm' }),
    });
    expect(called).toBe(0);
  });

  it('DELETEs /projects/{id} with a minted idempotency-key when --confirm is set', async () => {
    const { credentialsPath } = makeCreds();
    const deleteResponse: CliDeleteProjectResponse = {
      projectId: 'proj_alpha',
      deletedAt: '2026-05-16T10:00:00.000Z',
    };
    let seenUrl = '';
    let seenMethod = '';
    let seenIdemKey: string | null = null;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      seenUrl = typeof input === 'string' ? input : (input as { url: string }).url;
      seenMethod = init.method ?? 'GET';
      seenIdemKey = new Headers(init.headers).get('idempotency-key');
      return new Response(JSON.stringify(deleteResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await runDelete(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'proj_alpha',
        confirm: true,
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    );

    expect(seenMethod).toBe('DELETE');
    expect(seenUrl).toContain('/api/cli/v1/projects/proj_alpha');
    expect(seenIdemKey).toMatch(/^cli-delete-[0-9a-f-]{36}$/);
    expect(result.projectId).toBe('proj_alpha');
    expect(result.deletedAt).toBe('2026-05-16T10:00:00.000Z');
  });

  it('forwards a caller-supplied --idempotency-key verbatim', async () => {
    const { credentialsPath } = makeCreds();
    let seenIdemKey: string | null = null;
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      seenIdemKey = new Headers(init.headers).get('idempotency-key');
      return new Response(
        JSON.stringify({ projectId: 'proj_alpha', deletedAt: '2026-05-16T10:00:00.000Z' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    await runDelete(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'proj_alpha',
        confirm: true,
        idempotencyKey: 'idem-del-001',
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    );

    expect(seenIdemKey).toBe('idem-del-001');
  });

  it('--dry-run bypasses --confirm and returns the canned sample without network', async () => {
    resetDryRunBannerForTesting();
    const { credentialsPath } = makeCreds();
    const err: string[] = [];
    // No fetchImpl → the client-factory dry-run fetch serves the samples.ts value.
    const result = await runDelete(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        projectId: 'project_b3c91efa',
        confirm: false,
      },
      { credentialsPath, stdout: () => {}, stderr: line => err.push(line) },
    );

    expect(result.projectId).toBe('project_b3c91efa');
    expect(result.deletedAt).toBe('2026-05-16T00:00:00.000Z');
    expect(err).toContain(DRY_RUN_BANNER);
  });

  it('renders text mode with projectId and deletedAt', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { projectId: 'proj_text', deletedAt: '2026-05-16T10:00:00.000Z' },
    }));
    const out: string[] = [];
    await runDelete(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        projectId: 'proj_text',
        confirm: true,
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line), stderr: () => {} },
    );
    const block = out.join('\n');
    expect(block).toContain('projectId proj_text');
    expect(block).toContain('deletedAt 2026-05-16T10:00:00.000Z');
  });
});

describe('dogfood 2026-06-30 — whitespace-only --name is rejected', () => {
  const noNetwork = () => {
    throw new Error('network should not be hit');
  };

  it('runCreate rejects a whitespace-only --name (exit 5, no network)', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runCreate(
        { profile: 'default', output: 'json', debug: false, type: 'backend', name: '   ' },
        { credentialsPath, fetchImpl: makeFetch(noNetwork), stdout: () => {}, stderr: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('runUpdate rejects a whitespace-only --name (exit 5, no network)', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runUpdate(
        { profile: 'default', output: 'json', debug: false, projectId: 'p1', name: '\t \n' },
        { credentialsPath, fetchImpl: makeFetch(noNetwork), stdout: () => {}, stderr: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });
});

describe('parseTestIdAttributesFlag', () => {
  it('splits, trims, de-duplicates and keeps priority order', () => {
    expect(
      parseTestIdAttributesFlag(' data-element, data-testid ,data-element', 'test-id-attributes'),
    ).toEqual(['data-element', 'data-testid']);
  });

  it('rejects invalid attribute names and empty lists with a VALIDATION_ERROR', () => {
    for (const raw of ['bad name', '[data-element]', '', ' , ']) {
      expect(() => parseTestIdAttributesFlag(raw, 'test-id-attributes')).toThrowError(
        expect.objectContaining({ code: 'VALIDATION_ERROR' }),
      );
    }
  });
});

describe('project compatibility contracts', () => {
  it('appends environment columns after the legacy created column', async () => {
    const { credentialsPath } = makeCreds();
    const output: string[] = [];
    await runList(
      { profile: 'default', output: 'text', debug: false },
      {
        credentialsPath,
        fetchImpl: makeFetch(() => ({ body: { items: [PROJECT_FIXTURE], nextToken: null } })),
        stdout: line => output.push(line),
        stderr: () => {},
      },
    );
    const header = output[0]!.split('\n')[0]!;
    expect(header.indexOf('CREATED')).toBeLessThan(header.indexOf('DEFAULT ENV'));
  });

  it('project update retries one transient conflict with the same idempotency key', async () => {
    const { credentialsPath } = makeCreds();
    const headers: string[] = [];
    const result = await onFakeTimers(() =>
      runUpdate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: PROJECT_FIXTURE.id,
          name: 'New name',
        },
        {
          credentialsPath,
          fetchImpl: makeFetch((_url, init) => {
            headers.push(new Headers(init.headers).get('idempotency-key')!);
            return headers.length === 1
              ? {
                  status: 409,
                  body: {
                    error: {
                      code: 'CONFLICT',
                      message: 'Retry',
                      nextAction: 'Retry',
                      requestId: 'r',
                      details: {},
                    },
                  },
                }
              : { body: { projectId: PROJECT_FIXTURE.id, updatedFields: ['name'] } };
          }),
          stdout: () => {},
          stderr: () => {},
        },
      ),
    ).catch(err => err as ApiError);
    expect(result).not.toBeInstanceOf(ApiError);
    expect(headers).toHaveLength(2);
    expect(headers[0]).toBe(headers[1]);
  });
});

// ---------------------------------------------------------------------------
// A project created without a coding agent must not dead-end. After
// a real create in text mode, one [hint] on stderr points at the project's
// agent: plan, then apply. JSON callers already hold the
// id, and --dry-run would embed the canned sample id, so neither gets it.
// ---------------------------------------------------------------------------
describe('first-suite signpost after `project create`', () => {
  it('text mode, frontend: [hint] names plan and apply with the real id', async () => {
    const { credentialsPath } = makeCreds();
    const createdProject: CliProject = {
      ...PROJECT_FIXTURE,
      id: 'proj_fe_signpost',
      type: 'frontend',
      name: 'Signpost FE',
    };
    const fetchImpl = makeFetch(() => ({ body: createdProject }));
    const stderrLines: string[] = [];

    await runCreate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        type: 'frontend',
        name: 'Signpost FE',
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: line => stderrLines.push(line) },
    );

    const hint = stderrLines.find(l => l.startsWith('[hint]'));
    expect(hint).toBeDefined();
    expect(hint).toContain('testsprite project env create proj_fe_signpost --name default');
    expect(hint).toContain('testsprite plan --project proj_fe_signpost');
    expect(hint).toContain('testsprite apply');
    expect(hint).not.toContain('--file');
  });

  it('text mode, backend: the hint attaches the API spec to plan', async () => {
    const { credentialsPath } = makeCreds();
    const createdProject: CliProject = {
      ...PROJECT_FIXTURE,
      id: 'proj_be_signpost',
      type: 'backend',
      name: 'Signpost BE',
    };
    const fetchImpl = makeFetch(() => ({ body: createdProject }));
    const stderrLines: string[] = [];

    await runCreate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        type: 'backend',
        name: 'Signpost BE',
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: line => stderrLines.push(line) },
    );

    const hint = stderrLines.find(l => l.startsWith('[hint]'));
    expect(hint).toBeDefined();
    expect(hint).toContain('testsprite project env create proj_be_signpost --name default');
    expect(hint).toContain('testsprite plan --project proj_be_signpost --file <api-spec.yaml>');
    expect(hint).toContain('testsprite apply');
  });

  it('json mode: no hint — the caller already holds the project id', async () => {
    const { credentialsPath } = makeCreds();
    const createdProject: CliProject = { ...PROJECT_FIXTURE, id: 'proj_json', type: 'frontend' };
    const fetchImpl = makeFetch(() => ({ body: createdProject }));
    const stderrLines: string[] = [];

    await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        type: 'frontend',
        name: 'JSON FE',
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: line => stderrLines.push(line) },
    );

    expect(stderrLines.some(l => l.startsWith('[hint]'))).toBe(false);
  });

  it('--dry-run: no hint — the command would embed the canned sample id', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not hit network in dry-run');
    });
    const stderrLines: string[] = [];

    await runCreate(
      {
        profile: 'default',
        output: 'text',
        debug: false,
        dryRun: true,
        type: 'frontend',
        name: 'Dry FE',
      },
      {
        credentialsPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        stdout: () => {},
        stderr: line => stderrLines.push(line),
      },
    );

    expect(stderrLines.some(l => l.startsWith('[hint]'))).toBe(false);
  });
});

describe('renderProjectListText — CJK display-width regression (#369)', () => {
  const cjkProject: CliProject = {
    ...PROJECT_FIXTURE,
    id: 'project_cjk',
    name: '登录支付验证系统',
  };
  const page = { items: [PROJECT_FIXTURE, cjkProject], nextToken: null };

  // String indexes can't assert alignment (a CJK row carries fewer UTF-16
  // units for the same terminal cells); compare the DISPLAY width of the
  // prefix before the column instead.
  const offsetOf = (line: string, needle: string): number => {
    const idx = line.indexOf(needle);
    expect(idx).toBeGreaterThan(-1);
    return terminalWidth(line.slice(0, idx));
  };

  it('keeps later columns aligned when a project name is full-width', () => {
    const lines = renderProjectListText(page).split('\n');
    expect(lines.length).toBe(3);
    expect(offsetOf(lines[1]!, 'frontend')).toBe(offsetOf(lines[2]!, 'frontend'));
    expect(offsetOf(lines[0]!, 'TYPE')).toBe(offsetOf(lines[1]!, 'frontend'));
  });

  it('keeps alignment with --columns reordering and CJK names', () => {
    const lines = renderProjectListText(page, { columns: 'type,name', noHeader: true }).split('\n');
    expect(lines.length).toBe(2);
    expect(offsetOf(lines[0]!, PROJECT_FIXTURE.name)).toBe(offsetOf(lines[1]!, cjkProject.name));
  });
});
