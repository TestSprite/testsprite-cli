import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertFreshBuild } from './helpers/assertFreshBuild.js';

const repoRoot = resolve(import.meta.dirname, '..');
const binary = resolve(repoRoot, 'dist/index.js');
const billingUrl = 'https://server.example/dashboard-v3/o/org-1/settings/billing';
const meta = { tier: 'Free', retentionDays: 30, hiddenCount: 2, billingUrl };

function run(kind: 'test' | 'schedule', json = false) {
  assertFreshBuild(repoRoot, binary);
  const preload = `
    globalThis.fetch = async input => {
      const path = String(input);
      const meta = ${JSON.stringify(meta)};
      const body = path.includes('/tests/test_1/runs')
        ? { runs: [], nextCursor: null, meta: { testKind: 'frontend', ...meta } }
        : path.includes('/schedules/schedule_1/runs')
          ? { runs: [], meta }
          : (() => { throw new Error('Unexpected fetch: ' + path) })();
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
  `;
  return spawnSync(
    process.execPath,
    [
      `--import=data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`,
      binary,
      ...(json ? ['--output', 'json'] : []),
      ...(kind === 'test'
        ? ['test', 'result', 'test_1', '--history']
        : ['schedule', 'run', 'list', 'schedule_1']),
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        TESTSPRITE_API_KEY: 'sk-user-subproc',
        TESTSPRITE_API_URL: 'https://api.testsprite.com',
        TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
        TESTSPRITE_NO_TELEMETRY: '1',
        NO_COLOR: '1',
      },
    },
  );
}

describe.each(['test', 'schedule'] as const)('%s built CLI history retention', kind => {
  it('prints empty state followed by the plan note and preserves exit zero', () => {
    const result = run(kind);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(kind === 'test' ? 'No CLI-tracked history' : 'No runs yet.');
    expect(result.stderr).toContain('2 older runs hidden — the Free plan keeps 30 days');
    expect(result.stderr).toContain(`  billing:   ${billingUrl}`);
  });

  it('prints backend meta unchanged in JSON with no human note', () => {
    const result = run(kind, true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).meta).toEqual(
      kind === 'test' ? { testKind: 'frontend', ...meta } : meta,
    );
    expect(result.stderr).toBe('');
  });
});
