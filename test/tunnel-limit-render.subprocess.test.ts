import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertFreshBuild } from './helpers/assertFreshBuild.js';

const repoRoot = resolve(import.meta.dirname, '..');
const binary = resolve(repoRoot, 'dist/index.js');
const mockFetch = `
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/api/cli/v1/tunnel') && init?.method === 'POST') {
      return new Response(JSON.stringify({ error: {
        code: 'RATE_LIMITED', message: 'Tunnel limit reached.',
        nextAction: 'List or stop tunnels.', requestId: 'req_tunnel_cap',
        details: { reason: 'tunnel_binding_limit',
          clientIds: ['11111111-2222-4333-8444-555555555555', '22222222-3333-4444-8555-666666666666'],
          soonestExpiresAt: '2026-08-24T18:00:00.000Z' }
      } }), { status: 429, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('Unexpected fetch: ' + String(input));
  };
`;

function runTunnelStart(args: string[]) {
  assertFreshBuild(repoRoot, binary);
  const preload = `data:text/javascript;base64,${Buffer.from(mockFetch).toString('base64')}`;
  return spawnSync(process.execPath, [`--import=${preload}`, binary, ...args, 'tunnel', 'start'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TESTSPRITE_API_KEY: 'sk-user-subproc',
      TESTSPRITE_API_URL: 'http://localhost:13502',
      TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
      TESTSPRITE_NO_TELEMETRY: '1',
    },
    timeout: 10_000,
  });
}

describe('tunnel limit error rendering in the built CLI', () => {
  it('shows client ids only in text mode and preserves them in JSON details', () => {
    const textResult = runTunnelStart([]);
    expect(textResult.error).toBeUndefined();
    expect(textResult.status).toBe(11);
    expect(textResult.stderr).toContain('  tunnel: 11111111-2222-4333-8444-555555555555');
    expect(textResult.stderr).toContain('  tunnel: 22222222-3333-4444-8555-666666666666');
    expect(textResult.stderr).toContain('testsprite tunnel stop --all --confirm');

    const jsonResult = runTunnelStart(['--output', 'json']);
    expect(jsonResult.error).toBeUndefined();
    expect(jsonResult.status).toBe(11);
    expect(jsonResult.stdout).toBe('');
    const envelope = JSON.parse(jsonResult.stderr) as {
      error: { details: { clientIds: string[] } };
    };
    expect(envelope.error.details.clientIds).toHaveLength(2);
    expect(jsonResult.stderr).not.toContain('  tunnel:');
  });
});
