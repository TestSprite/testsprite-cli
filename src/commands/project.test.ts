import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/errors.js';
import { DRY_RUN_BANNER, resetDryRunBannerForTesting } from '../lib/client-factory.js';
import {
  type CliProject,
  type CliCreateProjectResponse,
  type CliDeleteProjectResponse,
  type CliUpdateProjectResponse,
  createProjectCommand,
  runAutoAuth,
  runCreate,
  runCredential,
  runDelete,
  runGet,
  runList,
  runUpdate,
} from './project.js';

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

  it('exposes list, get, create, update, delete, credential and auto-auth subcommands', () => {
    const project = createProjectCommand();
    const names = project.commands.map(c => c.name()).sort();
    expect(names).toEqual(['auto-auth', 'create', 'credential', 'delete', 'get', 'list', 'update']);
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

describe('DEV-244 — project update no longer accepts the dead --description flag', () => {
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

describe('runGet', () => {
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

  it('renders a configured targetUrl', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { ...PROJECT_FIXTURE, targetUrl: 'https://staging.example.com' },
    }));
    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, projectId: 'project_b3c91efa' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(out.join('\n')).toContain('targetUrl:   https://staging.example.com');
  });

  it('renders an explicit null targetUrl as "(not set)" with the fix-it command', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({ body: { ...PROJECT_FIXTURE, targetUrl: null } }));
    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, projectId: 'project_b3c91efa' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    expect(block).toContain('targetUrl:   (not set');
    expect(block).toContain('testsprite project update project_b3c91efa --url <url>');
  });

  it('offers the same fix-it for a BACKEND project with a null targetUrl (the V3 case, where it works)', async () => {
    // A null on a backend project only ever comes from V3, where the default
    // environment URL is real, settable, and exactly what the run guard checks —
    // so the `--url` remedy is correct there. V2 never sends null for a backend
    // project (it omits the key, because a V2 backend run resolves no project URL
    // and the remedy would change nothing) — which is why this renderer can print
    // one message for `null` without asking which execution path it came from.
    const { credentialsPath } = makeCreds();
    const fetchImpl = makeFetch(() => ({
      body: { ...PROJECT_FIXTURE, type: 'backend', targetUrl: null },
    }));
    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, projectId: 'project_b3c91efa' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    const block = out.join('\n');
    expect(block).toContain('type:        backend');
    expect(block).toContain('testsprite project update project_b3c91efa --url <url>');
  });

  // NOTE: a guard, not a proof — this assertion also holds on the pre-change
  // renderer (which had no targetUrl line at all). It exists so a future edit
  // cannot switch the presence check to a truthiness check without going red.
  it('says nothing about targetUrl when the backend omits the field (older backend, or `project list`)', async () => {
    const { credentialsPath } = makeCreds();
    // PROJECT_FIXTURE deliberately has no targetUrl key — an absent field must
    // NOT render as "(not set)", or every project on a pre-field backend reads
    // as URL-less, including the ones that have a URL.
    const fetchImpl = makeFetch(() => ({ body: PROJECT_FIXTURE }));
    const out: string[] = [];
    await runGet(
      { profile: 'default', output: 'text', debug: false, projectId: 'project_b3c91efa' },
      { credentialsPath, fetchImpl, stdout: line => out.push(line) },
    );
    expect(out.join('\n')).not.toContain('targetUrl');
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
        targetUrl: 'https://example.com',
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
        targetUrl: 'https://example.com',
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
    // DEV-247: the canned sample must carry the "not from the server" banner.
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
        targetUrl: 'https://example.com',
      },
      { credentialsPath, fetchImpl, stdout: line => out.push(line), stderr: () => {} },
    );
    const block = out.join('\n');
    expect(block).toContain('id:');
    expect(block).toContain('name:');
    expect(block).toContain('type:');
  });

  it('P6 — frontend without --url rejects with VALIDATION_ERROR (exit 5)', async () => {
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
          name: 'No URL Project',
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
          targetUrl: 'https://example.com',
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
  it('rejects a whitespace-only --password with VALIDATION_ERROR (exit 5), no network', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not hit network - validation must fire client-side');
    });

    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          type: 'frontend',
          name: 'Password Guard Project',
          targetUrl: 'https://example.com',
          password: '   ',
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

  it('rejects --description with VALIDATION_ERROR (exit 5), no network — projects have no description', async () => {
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
          name: 'Desc Project',
          targetUrl: 'https://example.com',
          description: 'a human description',
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

  describe('backend project without --url — dead-on-arrival advisory (dogfood 2026-07-30)', () => {
    it('emits [advisory] on stderr naming no-target-resolvable + the copy-pasteable fix, with the real created project id', async () => {
      const { credentialsPath } = makeCreds();
      const createdProject: CliProject = {
        ...PROJECT_FIXTURE,
        id: 'proj_be_nourl',
        type: 'backend',
        name: 'No URL BE',
      };
      const fetchImpl = makeFetch(() => ({ body: createdProject }));
      const stderrLines: string[] = [];

      await runCreate(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          type: 'backend',
          name: 'No URL BE',
        },
        { credentialsPath, fetchImpl, stdout: () => {}, stderr: line => stderrLines.push(line) },
      );

      const advisory = stderrLines.find(l => l.includes('[advisory]'));
      expect(advisory).toBeDefined();
      expect(advisory).toContain('no-target-resolvable');
      expect(advisory).toContain('testsprite project update proj_be_nourl --url <url>');
      // The guard that produces no-target-resolvable only applies on the V3
      // execution path (V2 backend runs never resolve a project URL at all),
      // so the claim must be scoped, not stated as universal — and it must
      // point the reader at how to check which path they're on.
      expect(advisory).toContain('V3');
      expect(advisory).toContain('auth status');
    });

    it('does NOT emit the advisory when --url is supplied for a backend project', async () => {
      const { credentialsPath } = makeCreds();
      const createdProject: CliProject = {
        ...PROJECT_FIXTURE,
        id: 'proj_be_withurl',
        type: 'backend',
        name: 'With URL BE',
      };
      const fetchImpl = makeFetch(() => ({ body: createdProject }));
      const stderrLines: string[] = [];

      await runCreate(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          type: 'backend',
          name: 'With URL BE',
          targetUrl: 'https://staging.example.com',
        },
        { credentialsPath, fetchImpl, stdout: () => {}, stderr: line => stderrLines.push(line) },
      );

      expect(
        stderrLines.some(l => l.includes('[advisory]') && l.includes('no-target-resolvable')),
      ).toBe(false);
    });

    it('does NOT emit the advisory for a frontend project (--url is already required there)', async () => {
      const { credentialsPath } = makeCreds();
      const createdProject: CliProject = {
        ...PROJECT_FIXTURE,
        id: 'proj_fe',
        type: 'frontend',
        name: 'FE Project',
      };
      const fetchImpl = makeFetch(() => ({ body: createdProject }));
      const stderrLines: string[] = [];

      await runCreate(
        {
          profile: 'default',
          output: 'text',
          debug: false,
          type: 'frontend',
          name: 'FE Project',
          targetUrl: 'https://staging.example.com',
        },
        { credentialsPath, fetchImpl, stdout: () => {}, stderr: line => stderrLines.push(line) },
      );

      expect(
        stderrLines.some(l => l.includes('[advisory]') && l.includes('no-target-resolvable')),
      ).toBe(false);
    });

    it('emits the advisory to stderr in --output json mode too, while stdout stays valid parseable JSON with no advisory text', async () => {
      // The advisory goes to stderr, which no output mode ever routes into
      // stdout — there is nothing for a --output json gate to protect, and
      // --output json is exactly the non-interactive/agent/CI case where a
      // silent dead-on-arrival project is most costly (nobody is watching a
      // terminal for a warning that never fires).
      const { credentialsPath } = makeCreds();
      const createdProject: CliProject = {
        ...PROJECT_FIXTURE,
        id: 'proj_be_json',
        type: 'backend',
        name: 'JSON BE',
      };
      const fetchImpl = makeFetch(() => ({ body: createdProject }));
      const stderrLines: string[] = [];
      const stdoutLines: string[] = [];

      const result = await runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          type: 'backend',
          name: 'JSON BE',
        },
        {
          credentialsPath,
          fetchImpl,
          stdout: line => stdoutLines.push(line),
          stderr: line => stderrLines.push(line),
        },
      );

      expect(result.type).toBe('backend');
      expect(
        stderrLines.some(l => l.includes('[advisory]') && l.includes('no-target-resolvable')),
      ).toBe(true);

      // Pipeline-contract assertion: stdout is still exactly one valid,
      // parseable JSON payload — the advisory never leaks into it.
      expect(stdoutLines).toHaveLength(1);
      const parsed: unknown = JSON.parse(stdoutLines[0]!);
      expect((parsed as CliCreateProjectResponse).type).toBe('backend');
      expect(stdoutLines[0]).not.toContain('[advisory]');
    });

    it('does NOT emit the advisory under --dry-run (the remedy would embed the fake dry-run project id)', async () => {
      resetDryRunBannerForTesting();
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
          type: 'backend',
          name: 'DryRun BE No URL',
        },
        {
          credentialsPath,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          stdout: () => {},
          stderr: line => stderrLines.push(line),
        },
      );

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(
        stderrLines.some(l => l.includes('[advisory]') && l.includes('no-target-resolvable')),
      ).toBe(false);
    });
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
          targetUrl: 'https://example.com',
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
          targetUrl: 'https://example.com',
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
          targetUrl: 'https://example.com',
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

  it('rejects a whitespace-only --password with VALIDATION_ERROR (exit 5), no network', async () => {
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
          password: '   ',
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
    // DEV-247: the canned sample must carry the "not from the server" banner.
    expect(err).toContain(DRY_RUN_BANNER);
  });

  it('P7 — dry-run with --password-file does not read the filesystem', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not hit network');
    });
    const result = await runUpdate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        projectId: 'proj_dry',
        passwordFile: '/tmp/definitely-not-here-testsprite',
      },
      {
        credentialsPath,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        stdout: () => {},
        stderr: () => {},
      },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.id).toBe('proj_dry');
    expect(result.updatedFields).toContain('password');
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

describe('#79 — an unreadable --password-file is a validation error, not a crash', () => {
  const missing = join(tmpdir(), 'testsprite-issue-79-absent-password-file');

  it('runCreate rejects a missing file with VALIDATION_ERROR (exit 5) before the network', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not hit network');
    });

    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          type: 'backend',
          name: 'Guarded',
          passwordFile: missing,
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

  it('runUpdate rejects a missing file with VALIDATION_ERROR (exit 5) before the network', async () => {
    const { credentialsPath } = makeCreds();
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not hit network');
    });

    await expect(
      runUpdate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'proj_guarded',
          passwordFile: missing,
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

  it('names the flag in nextAction instead of leaking a raw ENOENT', async () => {
    const { credentialsPath } = makeCreds();

    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          type: 'backend',
          name: 'Guarded',
          passwordFile: missing,
        },
        {
          credentialsPath,
          fetchImpl: (async () => {
            throw new Error('should not hit network');
          }) as unknown as typeof fetch,
          stdout: () => {},
          stderr: () => {},
        },
      ),
    ).rejects.toMatchObject({
      nextAction: expect.stringContaining('--password-file') as unknown as string,
    });
  });

  it('still reads a password file that exists', async () => {
    const { credentialsPath } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-p79-'));
    const passwordFile = join(dir, 'pw.txt');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture write into this test's own mkdtempSync-created temp dir (dir), not user input.
    writeFileSync(passwordFile, 'from-file\n');

    const sentBodies: unknown[] = [];
    const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      if (init.body) sentBodies.push(JSON.parse(init.body as string) as unknown);
      return new Response(JSON.stringify({ ...PROJECT_FIXTURE, id: 'proj_pw' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await runCreate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        type: 'backend',
        name: 'Guarded',
        passwordFile,
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    );

    expect((sentBodies[0] as Record<string, unknown>).password).toBe('from-file');
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

describe('runCredential', () => {
  interface Captured {
    url: string;
    method: string;
    body: unknown;
    headers: Headers;
  }
  function captureFetch(captured: Captured[], body: unknown) {
    return makeFetch((url, init) => {
      captured.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body as string) : undefined,
        headers: new Headers(init.headers as Record<string, string>),
      });
      return { status: 200, body };
    });
  }

  it('PUTs /projects/:id/credential with authType + credential + idempotency-key', async () => {
    const { credentialsPath } = makeCreds();
    const captured: Captured[] = [];
    const fetchImpl = captureFetch(captured, {
      projectId: 'p1',
      authType: 'Bearer token',
      rewroteCount: 2,
    });
    const res = await runCredential(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'p1',
        authType: 'Bearer token',
        credential: 'tok-123',
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    );
    expect(res.rewroteCount).toBe(2);
    const put = captured.find(c => c.method === 'PUT')!;
    expect(put.url).toContain('/projects/p1/credential');
    expect(put.body).toEqual({ authType: 'Bearer token', credential: 'tok-123' });
    expect(put.headers.get('idempotency-key')).toMatch(/^cli-proj-cred-[0-9a-f-]{36}$/);
  });

  it('public clears the credential (no credential in body, none required)', async () => {
    const { credentialsPath } = makeCreds();
    const captured: Captured[] = [];
    const fetchImpl = captureFetch(captured, {
      projectId: 'p1',
      authType: 'public',
      rewroteCount: 0,
    });
    await runCredential(
      { profile: 'default', output: 'json', debug: false, projectId: 'p1', authType: 'public' },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    );
    const put = captured.find(c => c.method === 'PUT')!;
    expect(put.body).toEqual({ authType: 'public' });
  });

  it('non-public without --credential → VALIDATION_ERROR (exit 5), no fetch', async () => {
    const { credentialsPath } = makeCreds();
    let fetched = false;
    const fetchImpl = makeFetch(() => {
      fetched = true;
      return { body: {} };
    });
    await expect(
      runCredential(
        { profile: 'default', output: 'json', debug: false, projectId: 'p1', authType: 'API key' },
        { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(fetched).toBe(false);
  });

  it('rejects an unknown --type locally (no fetch)', async () => {
    const { credentialsPath } = makeCreds();
    let fetched = false;
    const fetchImpl = makeFetch(() => {
      fetched = true;
      return { body: {} };
    });
    await expect(
      runCredential(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'p1',
          authType: 'jwt',
          credential: 'x',
        },
        { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(fetched).toBe(false);
  });
});

describe('runAutoAuth', () => {
  interface Captured {
    url: string;
    method: string;
    body: Record<string, unknown>;
    headers: Headers;
  }
  function captureFetch(captured: Captured[]) {
    return makeFetch((url, init) => {
      captured.push({
        url,
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(init.body as string) : {},
        headers: new Headers(init.headers as Record<string, string>),
      });
      return {
        status: 200,
        body: { projectId: 'p1', enabled: true, method: 'aws_cognito_refresh', inject: 'bearer' },
      };
    });
  }

  it('PUTs /projects/:id/auto-auth with the config body + idempotency-key', async () => {
    const { credentialsPath } = makeCreds();
    const captured: Captured[] = [];
    const fetchImpl = captureFetch(captured);
    await runAutoAuth(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'p1',
        method: 'aws_cognito_refresh',
        inject: 'bearer',
        region: 'us-east-1',
        clientId: 'abc',
        refreshToken: 'rt-xyz',
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    );
    const put = captured.find(c => c.method === 'PUT')!;
    expect(put.url).toContain('/projects/p1/auto-auth');
    expect(put.body).toEqual({
      enabled: true,
      method: 'aws_cognito_refresh',
      inject: 'bearer',
      region: 'us-east-1',
      clientId: 'abc',
      refreshToken: 'rt-xyz',
    });
    expect(put.headers.get('idempotency-key')).toMatch(/^cli-proj-autoauth-[0-9a-f-]{36}$/);
  });

  it('--disable sends enabled:false', async () => {
    const { credentialsPath } = makeCreds();
    const captured: Captured[] = [];
    const fetchImpl = captureFetch(captured);
    await runAutoAuth(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'p1',
        disable: true,
        method: 'password',
        inject: 'bearer',
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    );
    expect(captured.find(c => c.method === 'PUT')!.body.enabled).toBe(false);
  });

  it('reads a secret from --refresh-token-file', async () => {
    const { credentialsPath } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-rt-'));
    const rtFile = join(dir, 'rt.txt');
    writeFileSync(rtFile, '  rt-from-file\n');
    const captured: Captured[] = [];
    const fetchImpl = captureFetch(captured);
    await runAutoAuth(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'p1',
        method: 'refresh_token',
        inject: 'bearer',
        tokenEndpoint: 'https://idp.example.com/token',
        refreshTokenFile: rtFile,
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    );
    expect(captured.find(c => c.method === 'PUT')!.body.refreshToken).toBe('rt-from-file');
  });

  it('rejects an unknown --method / --inject locally (no fetch)', async () => {
    const { credentialsPath } = makeCreds();
    let fetched = false;
    const fetchImpl = makeFetch(() => {
      fetched = true;
      return { body: {} };
    });
    await expect(
      runAutoAuth(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'p1',
          method: 'magic',
          inject: 'bearer',
        },
        { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
    expect(fetched).toBe(false);
  });
});

describe('dogfood 2026-06-30 — whitespace-only --name is rejected (parity with `test create`)', () => {
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

describe('#282 — secret --*-file flags are guarded (structured error, exit 5, no raw ENOENT)', () => {
  const noNetwork = () => {
    throw new Error('network should not be hit');
  };
  const deps = (credentialsPath: string) => ({
    credentialsPath,
    fetchImpl: makeFetch(noNetwork),
    stdout: () => {},
    stderr: () => {},
  });
  const missingPath = () => join(mkdtempSync(join(tmpdir(), 'cli-missing-')), 'no-such-secret.txt');

  it('runCredential --credential-file missing → VALIDATION_ERROR (exit 5), no network', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runCredential(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'p1',
          authType: 'API key',
          credentialFile: missingPath(),
        },
        deps(credentialsPath),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('runCredential --credential-file pointing at a directory → VALIDATION_ERROR (exit 5)', async () => {
    const { credentialsPath } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-cred-dir-'));
    await expect(
      runCredential(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'p1',
          authType: 'API key',
          credentialFile: dir,
        },
        deps(credentialsPath),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('runCredential reads a valid --credential-file (trimmed) and sends it', async () => {
    const { credentialsPath } = makeCreds();
    const dir = mkdtempSync(join(tmpdir(), 'cli-cred-ok-'));
    const credFile = join(dir, 'cred.txt');
    writeFileSync(credFile, '  tok-from-file\n');
    let sentBody: { credential?: string } | undefined;
    const fetchImpl = makeFetch((_url, init) => {
      sentBody = init.body ? JSON.parse(init.body as string) : undefined;
      return { status: 200, body: { projectId: 'p1', authType: 'API key', rewroteCount: 1 } };
    });
    await runCredential(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        projectId: 'p1',
        authType: 'API key',
        credentialFile: credFile,
      },
      { credentialsPath, fetchImpl, stdout: () => {}, stderr: () => {} },
    );
    // The on-disk fixture is "  tok-from-file\n"; the shared guard trims it.
    expect(sentBody?.credential).toBe('tok-from-file');
  });

  it('runAutoAuth --password-file missing → VALIDATION_ERROR (exit 5), no network', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runAutoAuth(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'p1',
          method: 'password',
          inject: 'bearer',
          passwordFile: missingPath(),
        },
        deps(credentialsPath),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('runAutoAuth --client-secret-file missing → VALIDATION_ERROR (exit 5), no network', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runAutoAuth(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'p1',
          method: 'refresh_token',
          inject: 'bearer',
          clientSecretFile: missingPath(),
        },
        deps(credentialsPath),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('runAutoAuth --refresh-token-file missing → VALIDATION_ERROR (exit 5), no network', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runAutoAuth(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'p1',
          method: 'refresh_token',
          inject: 'bearer',
          refreshTokenFile: missingPath(),
        },
        deps(credentialsPath),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('runCreate --password-file missing → VALIDATION_ERROR (exit 5), no network', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          type: 'frontend',
          name: 'FE',
          targetUrl: 'https://example.com',
          username: 'u',
          passwordFile: missingPath(),
        },
        deps(credentialsPath),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });

  it('runUpdate --password-file missing → VALIDATION_ERROR (exit 5), no network', async () => {
    const { credentialsPath } = makeCreds();
    await expect(
      runUpdate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          projectId: 'p1',
          passwordFile: missingPath(),
        },
        deps(credentialsPath),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', exitCode: 5 });
  });
});
