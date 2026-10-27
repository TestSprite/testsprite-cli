import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readProfile } from '../lib/credentials.js';
import { runConfigure, runWhoami } from './auth.js';
import { runInstall } from './agent.js';
import { runInit } from './init.js';

vi.mock('../lib/credentials.js', () => ({ readProfile: vi.fn() }));
vi.mock('./auth.js', () => ({ runConfigure: vi.fn(), runWhoami: vi.fn() }));
vi.mock('./agent.js', () => ({ runInstall: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(readProfile).mockReturnValue(undefined);
  vi.mocked(runConfigure).mockResolvedValue({
    persisted: true,
    source: 'prompt',
  });
  vi.mocked(runWhoami).mockResolvedValue({
    userId: 'u1',
    keyId: 'k1',
    scopes: [],
    env: 'production',
  });
  vi.mocked(runInstall).mockImplementation(async (_opts, deps) => {
    deps?.stdout?.('[{"action":"written","skills":["testsprite-verify"]}]');
  });
});

type Scenario = 'profile' | 'install' | 'identity';
const contexts = {
  profile: 'setup summary profile lookup failed; using endpoint fallback',
  install: 'setup ignored non-JSON agent install output',
  identity: 'setup identity lookup failed after configure',
};

/** Exercise the setup orchestrator while its existing primitives inject fallback failures. */
async function setup(
  scenario: Scenario,
  debug: boolean,
  output: 'json' | 'text',
  brokenSink = false,
) {
  if (scenario === 'profile') {
    // The initial credential guard succeeds; only the display-only reread fails.
    vi.mocked(readProfile)
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => {
        throw new Error('profile read failed');
      });
  } else if (scenario === 'install') {
    vi.mocked(runInstall).mockImplementation(async (_opts, deps) => {
      deps?.stdout?.('private-install-content-not-json');
      deps?.stdout?.('[{"action":"written","skills":["testsprite-verify"]}]');
    });
  } else {
    vi.mocked(runWhoami).mockRejectedValue(new Error('identity unavailable'));
  }
  const stdout: string[] = [];
  const stderr: string[] = [];
  await runInit(
    {
      profile: 'default',
      output,
      debug,
      fromEnv: true,
      agent: 'claude',
      noAgent: false,
      force: false,
      yes: true,
    },
    {
      env: { TESTSPRITE_API_KEY: 'sk-user-test-only' },
      isTTY: false,
      stdout: line => stdout.push(line),
      stderr: line => {
        stderr.push(line);
        if (brokenSink && line.startsWith('[debug]')) throw new Error('broken diagnostic sink');
      },
    },
  );
  return { stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

describe.each(['profile', 'install', 'identity'] as const)(
  'setup %s fallback diagnostics',
  scenario => {
    it.each(['json', 'text'] as const)(
      'preserves %s output and emits only under debug',
      async output => {
        const normal = await setup(scenario, false, output);
        const debug = await setup(scenario, true, output);
        expect(debug.stdout).toBe(normal.stdout);
        expect(normal.stderr).toBe('');
        expect(debug.stderr).toContain(`[debug] ${contexts[scenario]}`);
        expect(debug.stderr).not.toContain('private-install-content');
        if (output === 'json') {
          const summary = JSON.parse(debug.stdout);
          expect(summary.status).toBe('initialized');
          expect(summary.apiUrl).toBe('https://api.testsprite.com');
          expect(summary.agent.action).toBe('installed');
          expect(summary.agent.skills).toEqual(['testsprite-verify']);
        }
      },
    );

    it('preserves a successful setup when the diagnostic sink throws', async () => {
      const result = await setup(scenario, true, 'json', true);
      expect(JSON.parse(result.stdout).status).toBe('initialized');
    });
  },
);
