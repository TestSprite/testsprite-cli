/**
 * Unit tests for `testsprite init` — all deps injected, no disk or network.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CLIError } from '../lib/errors.js';
import { resetDryRunBannerForTesting } from '../lib/client-factory.js';
import type { MeResponse } from './auth.js';
import type { AgentFs } from './agent.js';
import type { InitDeps } from './init.js';
import { runInit } from './init.js';
import { TARGETS, DEFAULT_SKILLS, pathFor, type AgentTarget } from '../lib/agent-targets.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ME: MeResponse = {
  userId: 'u-test',
  keyId: 'k-test',
  scopes: ['read:projects', 'write:tests', 'run:tests'],
  env: 'development',
  email: 'test@example.com',
  displayName: 'Test User',
};

/** Mock fetch that returns 200 /me response for any request. */
function makeOkFetch(): InitDeps['fetchImpl'] {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(ME), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as InitDeps['fetchImpl'];
}

/** Mock fetch that returns 401 for any request (simulates bad key). */
function makeAuthFailFetch(): InitDeps['fetchImpl'] {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'AUTH_INVALID',
            message: 'Invalid API key',
            nextAction: 'Provide a valid key.',
            requestId: 'r-1',
          },
        }),
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        },
      ),
  ) as unknown as InitDeps['fetchImpl'];
}

// ---------------------------------------------------------------------------
// In-memory AgentFs
// ---------------------------------------------------------------------------

function makeMemFs(): {
  store: Map<string, string>;
  fs: AgentFs;
  writeCalls: string[];
  mkdirCalls: string[];
} {
  const store = new Map<string, string>();
  const dirs = new Set<string>();
  const writeCalls: string[] = [];
  const mkdirCalls: string[] = [];

  const addAncestors = (p: string) => {
    let cur = path.dirname(p);
    while (cur !== path.dirname(cur)) {
      dirs.add(cur);
      cur = path.dirname(cur);
    }
    dirs.add(cur);
  };

  const agentFs: AgentFs = {
    async lstat(p: string) {
      if (store.has(p)) return { isFile: true, isSymbolicLink: false };
      if (dirs.has(p)) return { isFile: false, isSymbolicLink: false };
      return null;
    },
    async readFile(p: string) {
      const v = store.get(p);
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return v;
    },
    async writeFile(p: string, data: string, opts?: { exclusive?: boolean }) {
      if (opts?.exclusive && (store.has(p) || dirs.has(p))) {
        throw Object.assign(new Error(`EEXIST: ${p}`), { code: 'EEXIST' });
      }
      writeCalls.push(p);
      store.set(p, data);
      addAncestors(p);
    },
    async mkdir(p: string) {
      mkdirCalls.push(p);
      dirs.add(p);
      addAncestors(p);
    },
  };

  return { store, fs: agentFs, writeCalls, mkdirCalls };
}

// ---------------------------------------------------------------------------
// Output capture
// ---------------------------------------------------------------------------

interface Captured {
  stdout: string[];
  stderr: string[];
}

function makeCapture(): { captured: Captured; deps: Pick<InitDeps, 'stdout' | 'stderr'> } {
  const captured: Captured = { stdout: [], stderr: [] };
  return {
    captured,
    deps: {
      stdout: line => captured.stdout.push(line),
      stderr: line => captured.stderr.push(line),
    },
  };
}

// ---------------------------------------------------------------------------
// Base options factories
// ---------------------------------------------------------------------------

const CWD = '/test-project';

function makeBaseOpts(overrides: Partial<Parameters<typeof runInit>[0]> = {}) {
  return {
    profile: 'default',
    output: 'text' as const,
    debug: false,
    dryRun: false,
    fromEnv: false,
    agent: 'claude' as AgentTarget,
    noAgent: false,
    force: false,
    yes: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let credentialsPath: string;

beforeEach(() => {
  credentialsPath = join(mkdtempSync(join(tmpdir(), 'testsprite-init-')), 'credentials');
  resetDryRunBannerForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Happy path — interactive (text + json output)
// ---------------------------------------------------------------------------

describe('runInit — happy path (interactive)', () => {
  it('text mode: prompts key → configure → whoami banner → install → summary', async () => {
    const { captured, deps } = makeCapture();
    const { fs: agentFs } = makeMemFs();
    const fetchMock = makeOkFetch();
    const secretPrompt = vi.fn(async () => 'sk-test-key');

    await runInit(makeBaseOpts(), {
      ...deps,
      fetchImpl: fetchMock,
      credentialsPath,
      prompt: { secret: secretPrompt },
      isTTY: true,
      cwd: CWD,
      fs: agentFs,
    });

    // Secret was prompted once
    expect(secretPrompt).toHaveBeenCalledOnce();

    // GET /me was called (configure + whoami = 2 calls minimum)
    expect(fetchMock).toHaveBeenCalled();

    const stdout = captured.stdout.join('\n');
    expect(stdout).toContain('TestSprite initialized.');
    expect(stdout).toContain('profile:');
    // Next steps leads with creating a project; no command that fails without --project.
    expect(stdout).toContain('Next steps:');
    expect(stdout).toContain('testsprite project create --type frontend');
    expect(stdout).toContain('testsprite test run --all --project <projectId>');
    expect(stdout).toContain('the testsprite-onboard skill is installed');
    // No "current project" wording, no bare test list.
    expect(stdout).not.toContain('current project');
    expect(stdout).not.toContain('testsprite test list');
  });

  it('json mode: emits structured InitSummary object', async () => {
    const { captured, deps } = makeCapture();
    const { fs: agentFs } = makeMemFs();
    const fetchMock = makeOkFetch();

    await runInit(makeBaseOpts({ output: 'json', apiKey: 'sk-json-test' }), {
      ...deps,
      fetchImpl: fetchMock,
      credentialsPath,
      isTTY: false,
      cwd: CWD,
      fs: agentFs,
    });

    // The last stdout line (or join) should be parseable JSON
    const jsonOut = captured.stdout.join('\n');
    const parsed = JSON.parse(jsonOut) as Record<string, unknown>;
    expect(parsed.status).toBe('initialized');
    expect(parsed.profile).toBe('default');
    expect(typeof parsed.apiUrl).toBe('string');
    expect(Array.isArray(parsed.scopes)).toBe(true);
    expect(parsed.agent).not.toBeNull();
    // setup installs DEFAULT_SKILLS (both skills); aggregate action is 'installed'
    const agent = parsed.agent as { target: string; action: string; skills?: string[] };
    expect(agent.action).toBe('installed');
    expect(agent.skills).toContain('testsprite-verify');
    expect(agent.skills).toContain('testsprite-onboard');
  });
});

// ---------------------------------------------------------------------------
// 2. --yes --api-key: zero prompts, default claude agent
// ---------------------------------------------------------------------------

describe('runInit — --yes --api-key (non-interactive)', () => {
  it('completes with zero prompts, uses claude as agent target', async () => {
    const { captured, deps } = makeCapture();
    const { fs: agentFs } = makeMemFs();
    const fetchMock = makeOkFetch();
    const secretPrompt = vi.fn(async () => 'should-never-be-called');

    await runInit(makeBaseOpts({ apiKey: 'sk-test', yes: true }), {
      ...deps,
      fetchImpl: fetchMock,
      credentialsPath,
      prompt: { secret: secretPrompt },
      isTTY: false,
      cwd: CWD,
      fs: agentFs,
    });

    // Prompt never called
    expect(secretPrompt).not.toHaveBeenCalled();

    const stdout = captured.stdout.join('\n');
    expect(stdout).toContain('claude');
    expect(stdout).toContain('initialized');
  });
});

// ---------------------------------------------------------------------------
// 3. --no-agent: install NOT called, summary shows agent: null
// ---------------------------------------------------------------------------

describe('runInit — --no-agent', () => {
  it('skips agent install; summary has agent: null in JSON', async () => {
    const { captured, deps } = makeCapture();
    const { fs: agentFs, writeCalls } = makeMemFs();
    const fetchMock = makeOkFetch();

    await runInit(makeBaseOpts({ apiKey: 'sk-test', noAgent: true, output: 'json' }), {
      ...deps,
      fetchImpl: fetchMock,
      credentialsPath,
      isTTY: false,
      cwd: CWD,
      fs: agentFs,
    });

    // No skill file written
    expect(writeCalls.length).toBe(0);

    const jsonOut = captured.stdout.join('\n');
    const parsed = JSON.parse(jsonOut) as Record<string, unknown>;
    expect(parsed.agent).toBeNull();
  });

  it('text mode shows "skipped (--no-agent)"', async () => {
    const { captured, deps } = makeCapture();
    const { fs: agentFs } = makeMemFs();
    const fetchMock = makeOkFetch();

    await runInit(makeBaseOpts({ apiKey: 'sk-test', noAgent: true }), {
      ...deps,
      fetchImpl: fetchMock,
      credentialsPath,
      isTTY: false,
      cwd: CWD,
      fs: agentFs,
    });

    const stdout = captured.stdout.join('\n');
    expect(stdout).toContain('skipped (--no-agent)');
    // --no-agent points at manual test creation; must not claim the skill is installed.
    expect(stdout).toContain('Next steps:');
    expect(stdout).toContain('testsprite project create --type frontend');
    expect(stdout).toContain('testsprite test create --project <projectId>');
    expect(stdout).toContain('testsprite test run --all --project <projectId>');
    expect(stdout).not.toContain('skill is installed');
    // No "current project" wording, no bare test list.
    expect(stdout).not.toContain('current project');
    expect(stdout).not.toContain('testsprite test list');
  });

  it('text mode with agent: summary contains skills line with both default skills', async () => {
    const { captured, deps } = makeCapture();
    const { fs: agentFs } = makeMemFs();
    const fetchMock = makeOkFetch();

    await runInit(makeBaseOpts({ apiKey: 'sk-test' }), {
      ...deps,
      fetchImpl: fetchMock,
      credentialsPath,
      isTTY: false,
      cwd: CWD,
      fs: agentFs,
    });

    const stdout = captured.stdout.join('\n');
    // renderInitText emits a 'skills:' line when skills are present
    expect(stdout).toContain('skills:');
    expect(stdout).toContain('testsprite-verify');
    expect(stdout).toContain('testsprite-onboard');
  });
});

// ---------------------------------------------------------------------------
// 3b. Default claude target: installs both DEFAULT_SKILLS (2 own-file writes)
// ---------------------------------------------------------------------------

describe('runInit — default claude target installs 2 skill files', () => {
  it('writes both testsprite-verify and testsprite-onboard for claude', async () => {
    const { deps } = makeCapture();
    const { fs: agentFs, writeCalls } = makeMemFs();
    const fetchMock = makeOkFetch();

    await runInit(makeBaseOpts({ apiKey: 'sk-test' }), {
      ...deps,
      fetchImpl: fetchMock,
      credentialsPath,
      isTTY: false,
      cwd: CWD,
      fs: agentFs,
    });

    const verifyPath = path.resolve(CWD, pathFor('claude', 'testsprite-verify'));
    const onboardPath = path.resolve(CWD, pathFor('claude', 'testsprite-onboard'));
    expect(writeCalls).toContain(verifyPath);
    expect(writeCalls).toContain(onboardPath);
    // Exactly 2 skill-file writes (claude is own-file, one file per skill)
    const skillWrites = writeCalls.filter(p => p === verifyPath || p === onboardPath);
    expect(skillWrites).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 4. --agent cursor: passes target:'cursor' to runInstall
// ---------------------------------------------------------------------------

describe('runInit — --agent cursor', () => {
  it('installs cursor skill at the correct matrix path', async () => {
    const { captured, deps } = makeCapture();
    const { fs: agentFs, writeCalls } = makeMemFs();
    const fetchMock = makeOkFetch();

    await runInit(makeBaseOpts({ apiKey: 'sk-test', agent: 'cursor' }), {
      ...deps,
      fetchImpl: fetchMock,
      credentialsPath,
      isTTY: false,
      cwd: CWD,
      fs: agentFs,
    });

    // cursor is own-file; DEFAULT_SKILLS installs 2 files (testsprite-verify + testsprite-onboard)
    const cursorVerifyPath = path.resolve(CWD, pathFor('cursor', 'testsprite-verify'));
    const cursorOnboardPath = path.resolve(CWD, pathFor('cursor', 'testsprite-onboard'));
    expect(writeCalls).toContain(cursorVerifyPath);
    expect(writeCalls).toContain(cursorOnboardPath);
    // TARGETS[target].path is the verify skill path (back-compat); still written
    const cursorAbsPath = path.resolve(CWD, TARGETS.cursor.path);
    expect(writeCalls).toContain(cursorAbsPath);

    const stdout = captured.stdout.join('\n');
    expect(stdout).toContain('cursor');
  });
});

// ---------------------------------------------------------------------------
// 5. --dry-run: zero fetch calls, zero fs writes
// ---------------------------------------------------------------------------

describe('runInit — --dry-run', () => {
  it('makes no fetch calls and no fs writes', async () => {
    const { deps } = makeCapture();
    const { fs: agentFs, writeCalls, mkdirCalls } = makeMemFs();
    const fetchMock = vi.fn(
      async () => new Response('{}', { status: 200 }),
    ) as unknown as InitDeps['fetchImpl'];

    await runInit(makeBaseOpts({ dryRun: true, apiKey: 'sk-dry' }), {
      ...deps,
      fetchImpl: fetchMock,
      credentialsPath,
      isTTY: false,
      cwd: CWD,
      fs: agentFs,
    });

    // No network
    expect(fetchMock).not.toHaveBeenCalled();
    // No file writes
    expect(writeCalls).toHaveLength(0);
    expect(mkdirCalls).toHaveLength(0);
  });

  it('emits dry-run banners and preview lines on stderr', async () => {
    const { captured, deps } = makeCapture();
    const { fs: agentFs } = makeMemFs();

    await runInit(makeBaseOpts({ dryRun: true, apiKey: 'sk-dry' }), {
      ...deps,
      fetchImpl: vi.fn(async () => new Response('{}')) as unknown as InitDeps['fetchImpl'],
      credentialsPath,
      isTTY: false,
      cwd: CWD,
      fs: agentFs,
    });

    const stderr = captured.stderr.join('\n');
    expect(stderr).toContain('[dry-run]');
    expect(stderr).toContain('preview only');
  });

  it('dry-run with agent: summary action is dry-run and skills lists DEFAULT_SKILLS', async () => {
    const { captured, deps } = makeCapture();
    const { fs: agentFs } = makeMemFs();

    await runInit(makeBaseOpts({ dryRun: true, apiKey: 'sk-dry', output: 'json' }), {
      ...deps,
      fetchImpl: vi.fn(async () => new Response('{}')) as unknown as InitDeps['fetchImpl'],
      credentialsPath,
      isTTY: false,
      cwd: CWD,
      fs: agentFs,
    });

    const parsed = JSON.parse(captured.stdout.join('\n')) as {
      agent: { target: string; action: string; skills?: string[] } | null;
    };
    expect(parsed.agent).not.toBeNull();
    expect(parsed.agent?.action).toBe('dry-run');
    expect(parsed.agent?.skills).toContain('testsprite-verify');
    expect(parsed.agent?.skills).toContain('testsprite-onboard');
  });

  it('dry-run --no-agent: still no fetch, no writes, summary shows agent: null', async () => {
    const { captured, deps } = makeCapture();
    const { fs: agentFs, writeCalls } = makeMemFs();
    const fetchMock = vi.fn(async () => new Response('{}')) as unknown as InitDeps['fetchImpl'];

    await runInit(makeBaseOpts({ dryRun: true, apiKey: 'sk-dry', noAgent: true, output: 'json' }), {
      ...deps,
      fetchImpl: fetchMock,
      credentialsPath,
      isTTY: false,
      cwd: CWD,
      fs: agentFs,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeCalls).toHaveLength(0);

    const jsonOut = captured.stdout.join('\n');
    const parsed = JSON.parse(jsonOut) as Record<string, unknown>;
    expect(parsed.agent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. No TTY + no key + no --from-env → exit 5
// ---------------------------------------------------------------------------

describe('runInit — no TTY + no key source → exit 5', () => {
  it('throws CLIError with exit 5 when non-interactive and no key available', async () => {
    const { deps } = makeCapture();

    let thrown: unknown;
    try {
      await runInit(makeBaseOpts(), {
        ...deps,
        isTTY: false,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(5);
    const msg = (thrown as CLIError).message;
    expect(msg).toContain('--api-key');
  });
});

// ---------------------------------------------------------------------------
// 6b. Codex-review fixes — dry-run bypass, key precedence, endpoint, JSON guard
// ---------------------------------------------------------------------------

describe('runInit — codex-review hardening', () => {
  it('--dry-run bypasses the no-key guard in non-interactive mode (no throw, no fetch)', async () => {
    const { captured, deps } = makeCapture();
    const fetchImpl = makeOkFetch();
    // No TTY, no apiKey, no fromEnv — but dry-run must still preview, not exit 5.
    await runInit(makeBaseOpts({ dryRun: true, noAgent: true }), {
      ...deps,
      fetchImpl,
      credentialsPath,
      isTTY: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(captured.stderr.some(l => l.includes('[dry-run]'))).toBe(true);
  });

  it('--api-key wins over --from-env (configure uses the explicit key, not env)', async () => {
    const { deps } = makeCapture();
    const fetchImpl = makeOkFetch();
    // env has NO TESTSPRITE_API_KEY; if --from-env wrongly won, runConfigure would
    // read undefined and throw. Success proves --api-key took precedence.
    await runInit(makeBaseOpts({ apiKey: 'sk-wins', fromEnv: true, noAgent: true }), {
      ...deps,
      env: {},
      fetchImpl,
      credentialsPath,
      isTTY: false,
    });
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('rejects malformed --endpoint-url before setup key verification', async () => {
    const { captured, deps } = makeCapture();
    const fetchImpl = makeOkFetch();

    await expect(
      runInit(
        makeBaseOpts({
          fromEnv: true,
          endpointUrl: 'not-a-url',
          noAgent: true,
          output: 'json',
        }),
        {
          ...deps,
          env: { TESTSPRITE_API_KEY: 'sk' },
          fetchImpl,
          credentialsPath,
          isTTY: false,
        },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      details: { field: 'endpoint-url' },
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(captured.stderr.join('\n')).not.toContain('API key rejected');
  });

  it('whoami banner uses --api-key, not a stale TESTSPRITE_API_KEY in env (E2E 2026-06-09)', async () => {
    const { captured, deps } = makeCapture();
    // Key-aware fetch: only the real key gets a 200 + identity; the stale env key 401s.
    // The bug was: runWhoami read env.TESTSPRITE_API_KEY (stale) → 401 → misleading
    // production/no-email banner even though configure wrote the correct key.
    const fetchImpl = vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
      const key = init.headers?.['x-api-key'] ?? init.headers?.['X-API-Key'];
      if (key === 'sk-real') {
        return new Response(JSON.stringify(ME), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          error: { code: 'AUTH_INVALID', message: 'Invalid API key', requestId: 'r' },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as InitDeps['fetchImpl'];

    await runInit(makeBaseOpts({ apiKey: 'sk-real', noAgent: true, output: 'json' }), {
      ...deps,
      env: { TESTSPRITE_API_KEY: 'sk-stale-bogus' },
      fetchImpl,
      credentialsPath,
      isTTY: false,
    });
    const summary = JSON.parse(captured.stdout.join('\n')) as {
      email?: string;
      env: string;
      scopes: string[];
    };
    // Real-key identity must surface — NOT the 401 placeholder (production/no-email/[]).
    expect(summary.email).toBe(ME.email);
    expect(summary.env).toBe('development');
    expect(summary.scopes.length).toBeGreaterThan(0);
  });

  it('summary reports the endpoint from TESTSPRITE_API_URL, not a flat prod default', async () => {
    const { captured, deps } = makeCapture();
    await runInit(makeBaseOpts({ apiKey: 'sk-env-url', noAgent: true, output: 'json' }), {
      ...deps,
      env: { TESTSPRITE_API_URL: 'https://api.example.com:8443' },
      fetchImpl: makeOkFetch(),
      credentialsPath,
      isTTY: false,
    });
    const summary = JSON.parse(captured.stdout.join('\n')) as { apiUrl: string };
    expect(summary.apiUrl).toBe('https://api.example.com:8443');
  });

  it('--output json with an interactive prompt (no key source) → exit 5 (protects JSON stdout)', async () => {
    const { deps } = makeCapture();
    let thrown: unknown;
    try {
      await runInit(makeBaseOpts({ output: 'json' }), {
        ...deps,
        fetchImpl: makeOkFetch(),
        credentialsPath,
        isTTY: true, // interactive: would otherwise promptSecret → stdout
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CLIError);
    expect((thrown as CLIError).exitCode).toBe(5);
    expect((thrown as CLIError).message.toLowerCase()).toContain('json');
  });
});

// ---------------------------------------------------------------------------
// 7. Bad key → runConfigure throws → auth error propagates (exit 3)
// ---------------------------------------------------------------------------

describe('runInit — bad API key', () => {
  it('propagates auth error from runConfigure (exit 3)', async () => {
    const { deps } = makeCapture();
    const { fs: agentFs } = makeMemFs();

    let thrown: unknown;
    try {
      await runInit(makeBaseOpts({ apiKey: 'sk-bad' }), {
        ...deps,
        fetchImpl: makeAuthFailFetch(),
        credentialsPath,
        isTTY: false,
        cwd: CWD,
        fs: agentFs,
      });
    } catch (err) {
      thrown = err;
    }

    // runConfigure throws a CLIError wrapping the auth failure
    expect(thrown).toBeDefined();
    const exitCode =
      thrown instanceof CLIError
        ? thrown.exitCode
        : thrown instanceof ApiError
          ? thrown.exitCode
          : -1;
    expect(exitCode).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 8. Summary JSON shape
// ---------------------------------------------------------------------------

describe('runInit — summary JSON shape', () => {
  it('JSON summary has all required top-level fields', async () => {
    const { captured, deps } = makeCapture();
    const { fs: agentFs } = makeMemFs();
    const fetchMock = makeOkFetch();

    await runInit(makeBaseOpts({ apiKey: 'sk-shape', output: 'json' }), {
      ...deps,
      fetchImpl: fetchMock,
      credentialsPath,
      isTTY: false,
      cwd: CWD,
      fs: agentFs,
    });

    const parsed = JSON.parse(captured.stdout.join('\n')) as Record<string, unknown>;
    expect(parsed).toHaveProperty('profile');
    expect(parsed).toHaveProperty('apiUrl');
    expect(parsed).toHaveProperty('env');
    expect(parsed).toHaveProperty('scopes');
    expect(parsed).toHaveProperty('agent');
    expect(parsed).toHaveProperty('status', 'initialized');
  });

  it('JSON summary agent field has target, action (installed), and skills (both defaults)', async () => {
    const { captured, deps } = makeCapture();
    const { fs: agentFs } = makeMemFs();
    const fetchMock = makeOkFetch();

    await runInit(makeBaseOpts({ apiKey: 'sk-agent-shape', output: 'json' }), {
      ...deps,
      fetchImpl: fetchMock,
      credentialsPath,
      isTTY: false,
      cwd: CWD,
      fs: agentFs,
    });

    const parsed = JSON.parse(captured.stdout.join('\n')) as {
      agent: { target: string; action: string; skills?: string[] } | null;
    };
    expect(parsed.agent).not.toBeNull();
    expect(parsed.agent?.target).toBe('claude');
    // aggregateInstallAction maps 'written' → 'installed'; fresh install is 'installed'
    expect(parsed.agent?.action).toBe('installed');
    expect(typeof parsed.agent?.action).toBe('string');
    // Both DEFAULT_SKILLS must appear in the skills list
    expect(parsed.agent?.skills).toContain('testsprite-verify');
    expect(parsed.agent?.skills).toContain('testsprite-onboard');
    expect(parsed.agent?.skills).toHaveLength(DEFAULT_SKILLS.length);
  });
});

// ---------------------------------------------------------------------------
// 9. --from-env reads TESTSPRITE_API_KEY
// ---------------------------------------------------------------------------

describe('runInit — --from-env', () => {
  it('reads key from env, no prompt', async () => {
    const { captured, deps } = makeCapture();
    const { fs: agentFs } = makeMemFs();
    const fetchMock = makeOkFetch();
    const secretPrompt = vi.fn(async () => 'should-not-be-called');

    await runInit(makeBaseOpts({ fromEnv: true }), {
      ...deps,
      fetchImpl: fetchMock,
      credentialsPath,
      env: { TESTSPRITE_API_KEY: 'sk-from-env-key' },
      prompt: { secret: secretPrompt },
      isTTY: false,
      cwd: CWD,
      fs: agentFs,
    });

    expect(secretPrompt).not.toHaveBeenCalled();
    const stdout = captured.stdout.join('\n');
    expect(stdout).toContain('initialized');
  });
});

// ---------------------------------------------------------------------------
// 10. All valid agent targets
// ---------------------------------------------------------------------------

describe('runInit — all agent targets', () => {
  const allTargets = Object.keys(TARGETS) as AgentTarget[];

  for (const target of allTargets) {
    it(`target=${target}: installs to correct matrix path`, async () => {
      const { deps } = makeCapture();
      const { fs: agentFs, writeCalls } = makeMemFs();
      const fetchMock = makeOkFetch();

      // Reset banner state per-test since module-level state persists
      resetDryRunBannerForTesting();

      // Fresh credentials path per target
      const localCreds = join(
        mkdtempSync(join(tmpdir(), `testsprite-init-target-${target}-`)),
        'credentials',
      );

      await runInit(makeBaseOpts({ apiKey: 'sk-target', agent: target }), {
        ...deps,
        fetchImpl: fetchMock,
        credentialsPath: localCreds,
        isTTY: false,
        cwd: CWD,
        fs: agentFs,
      });

      // TARGETS[target].path is the testsprite-verify path (back-compat); always written
      const expectedPath = path.resolve(CWD, TARGETS[target].path);
      expect(writeCalls).toContain(expectedPath);

      if (TARGETS[target].mode === 'own-file') {
        // own-file targets: DEFAULT_SKILLS installs 2 separate files (one per skill)
        const verifyPath = path.resolve(CWD, pathFor(target, 'testsprite-verify'));
        const onboardPath = path.resolve(CWD, pathFor(target, 'testsprite-onboard'));
        expect(writeCalls).toContain(verifyPath);
        expect(writeCalls).toContain(onboardPath);
      } else {
        // managed-section (codex): ONE write to AGENTS.md aggregating all skills
        expect(writeCalls.filter(p => p === expectedPath).length).toBe(1);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// [B-E2E-05] Fix 5 regression — --no-agent + --agent conflict warning
// ---------------------------------------------------------------------------

describe('[B-E2E-05] runInit: --no-agent + --agent conflict emits [warn] on stderr', () => {
  // Commander sets opts.agent=false when --no-agent is passed (negation flag).
  // When both --agent <target> and --no-agent are in rawArgs, the CLI should
  // emit a [warn] and apply last-flag-wins semantics.
  // runInit receives the pre-resolved noAgent boolean and agent value from
  // Commander; the conflict is detected via a rawArgs scan in the command action.
  // These tests exercise runInit with rawArgConflict=true injected as the flag.

  it('warns on stderr when rawArgConflict=true and noAgent wins', async () => {
    // Simulate: user passed --agent cursor --no-agent (--no-agent last → noAgent=true)
    const { captured, deps } = makeCapture();
    const { fs: agentFs } = makeMemFs();
    const fetchMock = makeOkFetch();
    const localCreds = join(mkdtempSync(join(tmpdir(), 'testsprite-init-fix5a-')), 'credentials');

    // Pass rawArgConflict signal: noAgent=true wins (--no-agent was last)
    // runInit exposes a rawArgConflict option that the command action passes
    // when it detects both --agent and --no-agent in rawArgs.
    await runInit(makeBaseOpts({ apiKey: 'sk-conflict', noAgent: true, rawArgConflict: true }), {
      ...deps,
      fetchImpl: fetchMock,
      credentialsPath: localCreds,
      isTTY: false,
      cwd: CWD,
      fs: agentFs,
    });

    const warnLine = captured.stderr.find(l => l.includes('[warn]') && l.includes('--no-agent'));
    expect(warnLine).toBeDefined();
  });

  it('warns on stderr when rawArgConflict=true and --agent wins', async () => {
    // Simulate: user passed --no-agent --agent cursor (--agent last → agent='cursor')
    const { captured, deps } = makeCapture();
    const { fs: agentFs, writeCalls } = makeMemFs();
    const fetchMock = makeOkFetch();
    const localCreds = join(mkdtempSync(join(tmpdir(), 'testsprite-init-fix5b-')), 'credentials');

    await runInit(
      makeBaseOpts({
        apiKey: 'sk-conflict2',
        agent: 'cursor',
        noAgent: false,
        rawArgConflict: true,
      }),
      {
        ...deps,
        fetchImpl: fetchMock,
        credentialsPath: localCreds,
        isTTY: false,
        cwd: CWD,
        fs: agentFs,
      },
    );

    const warnLine = captured.stderr.find(l => l.includes('[warn]') && l.includes('--no-agent'));
    expect(warnLine).toBeDefined();

    // --agent cursor wins → cursor file should be written
    const cursorPath = path.resolve(CWD, TARGETS.cursor.path);
    expect(writeCalls).toContain(cursorPath);
  });

  it('no warning when only --agent is passed (no conflict)', async () => {
    const { captured, deps } = makeCapture();
    const { fs: agentFs } = makeMemFs();
    const fetchMock = makeOkFetch();
    const localCreds = join(mkdtempSync(join(tmpdir(), 'testsprite-init-fix5c-')), 'credentials');

    await runInit(
      // rawArgConflict not set (default undefined/false)
      makeBaseOpts({ apiKey: 'sk-no-conflict', agent: 'claude' }),
      {
        ...deps,
        fetchImpl: fetchMock,
        credentialsPath: localCreds,
        isTTY: false,
        cwd: CWD,
        fs: agentFs,
      },
    );

    const warnLine = captured.stderr.find(l => l.includes('[warn]') && l.includes('--no-agent'));
    expect(warnLine).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// [B-E2E-06] Fix 6 regression — install failure emits info message about creds
// ---------------------------------------------------------------------------

describe('[B-E2E-06] runInit: install failure → info message on stderr + re-throws', () => {
  // When the agent install step fails (e.g. bad --dir path), credentials are
  // already saved. The CLI should emit an [info] saying credentials are saved
  // and suggesting 'testsprite agent install' before re-throwing.

  it('emits [info] about saved credentials when install throws, then re-throws', async () => {
    const { captured, deps } = makeCapture();
    const fetchMock = makeOkFetch();
    const localCreds = join(mkdtempSync(join(tmpdir(), 'testsprite-init-fix6-')), 'credentials');

    // Inject an AgentFs that throws on writeFile to simulate install failure
    const failFs: AgentFs = {
      async lstat() {
        return null;
      },
      async readFile() {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      async writeFile() {
        throw new Error('ENOENT: no such directory');
      },
      async mkdir() {
        throw new Error('ENOENT: no such directory');
      },
    };

    let caughtErr: unknown;
    try {
      await runInit(makeBaseOpts({ apiKey: 'sk-install-fail', agent: 'claude' }), {
        ...deps,
        fetchImpl: fetchMock,
        credentialsPath: localCreds,
        isTTY: false,
        cwd: CWD,
        fs: failFs,
      });
    } catch (err) {
      caughtErr = err;
    }

    // Must re-throw
    expect(caughtErr).toBeDefined();

    // Must emit an [info] mentioning credentials were saved + agent install hint
    const infoLine = captured.stderr.find(
      l => l.includes('[info]') && (l.includes('credentials') || l.includes('agent install')),
    );
    expect(infoLine).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 11. Telemetry attribution — X-CLI-Command header (cli.initialized)
// ---------------------------------------------------------------------------

describe('runInit — telemetry attribution (X-CLI-Command)', () => {
  it('tags the configure /me with X-CLI-Command: init exactly once; whoami /me is untagged', async () => {
    const { deps } = makeCapture();
    // Capture the headers of every outgoing request so we can assert which /me
    // calls carry the init attribution tag.
    const sentHeaders: Array<Record<string, string> | undefined> = [];
    const fetchMock = vi.fn(async (_url: string, init: { headers?: Record<string, string> }) => {
      sentHeaders.push(init.headers);
      return new Response(JSON.stringify(ME), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as InitDeps['fetchImpl'];

    await runInit(makeBaseOpts({ apiKey: 'sk-tag', noAgent: true, output: 'json' }), {
      ...deps,
      fetchImpl: fetchMock,
      credentialsPath,
      isTTY: false,
    });

    // init drives two GET /me calls: configure-validate + whoami banner.
    expect(sentHeaders.length).toBeGreaterThanOrEqual(2);
    const initTagged = sentHeaders.filter(h => h?.['x-cli-command'] === 'init');
    // Exactly one carries the tag → the backend emits exactly one cli.initialized
    // (no double-count); the whoami /me stays cli.session_started.
    expect(initTagged).toHaveLength(1);
  });
});
