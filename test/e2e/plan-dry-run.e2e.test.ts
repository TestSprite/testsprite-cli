/**
 * Local e2e for `test plan generate` / `test plan accept` (DEV-384 V3-B).
 *
 * Runs the REAL built binary (`dist/index.js`) under `--dry-run`: no network,
 * no credentials, zero charges — the dry-run client factory substitutes the
 * canned-sample fetch, so these tests prove the full argv → Commander →
 * command → renderer → exit-code path end to end.
 *
 * Run via: `npm run test:e2e` (builds first).
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

beforeAll(() => {
  if (!existsSync(BIN_PATH)) {
    throw new Error(`dist/index.js not found — run \`npm run test:e2e\` which builds first.`);
  }
});

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd?: string): CliResult {
  // TESTSPRITE_PROJECT_ID is stripped for determinism: since F5 the plan
  // leaves fall back to it, so a host/CI machine exporting it would flip
  // the missing-project test (same hardening as test.plan.spec.ts).
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  delete env.TESTSPRITE_PROJECT_ID;
  const result = spawnSync('node', [BIN_PATH, ...args], {
    encoding: 'utf8',
    cwd,
    env,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('test plan generate --dry-run (dist)', () => {
  it('json mode: exit 0, canned staged proposals with stable ids, banner on stderr', () => {
    const result = runCli([
      '--dry-run',
      'test',
      'plan',
      'generate',
      '--project',
      'proj_e2e_dry',
      '--output',
      'json',
    ]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout) as {
      projectId: string;
      generation: { status: string };
      proposals: Array<{ proposalId: string; type: string }>;
    };
    expect(body.projectId).toBe('proj_e2e_dry');
    expect(body.generation.status).toBe('idle');
    expect(body.proposals.map(p => p.proposalId)).toEqual(['prop_1', 'prop_2']);
    expect(result.stderr).toContain('[dry-run] sample response');
  });

  it('text mode: renders the proposals table with ids and the accept next-step', () => {
    const result = runCli(['--dry-run', 'test', 'plan', 'generate', '--project', 'proj_e2e_dry']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('2 test-case proposals staged for review');
    expect(result.stdout).toContain('prop_1');
    expect(result.stdout).toContain('prop_2');
    expect(result.stdout).toContain('testsprite test plan accept --project proj_e2e_dry');
  });

  it('missing --project exits 5', () => {
    const result = runCli(['--dry-run', 'test', 'plan', 'generate']);
    expect(result.status).toBe(5);
  });

  it('dry-run generate + accept write NOTHING to the working directory', () => {
    // Exit-checklist evidence: zero FS writes under --dry-run. Run both
    // commands from a fresh empty directory and prove it stays empty.
    const dir = mkdtempSync(join(tmpdir(), 'ts-plan-dryrun-fs-'));
    try {
      const generate = runCli(
        ['--dry-run', 'test', 'plan', 'generate', '--project', 'proj_e2e_dry'],
        dir,
      );
      const accept = runCli(
        ['--dry-run', 'test', 'plan', 'accept', '--project', 'proj_e2e_dry', '--only', 'prop_1'],
        dir,
      );
      expect(generate.status).toBe(0);
      expect(accept.status).toBe(0);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('test plan accept --dry-run (dist)', () => {
  it('accept-all: exit 0, server truth + discard count (no derived split — F10)', () => {
    const result = runCli([
      '--dry-run',
      'test',
      'plan',
      'accept',
      '--project',
      'proj_e2e_dry',
      '--output',
      'json',
    ]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout) as Record<string, number>;
    expect(body.acceptedCount).toBe(2);
    // The FE/API split was dropped (F10 — proposal type is project-derived).
    expect(body.frontendCount).toBeUndefined();
    expect(body.backendCount).toBeUndefined();
    expect(body.discardedCount).toBe(0);
  });

  it('--only subset: input-derived acceptedCount + discarded note + API-codegen note', () => {
    const result = runCli([
      '--dry-run',
      'test',
      'plan',
      'accept',
      '--project',
      'proj_e2e_dry',
      '--only',
      'prop_2',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 proposal accepted — 1 test case created');
    expect(result.stdout).not.toContain('frontend,'); // split dropped (F10)
    expect(result.stdout).toContain('(1 remaining proposal discarded)');
    expect(result.stdout).toContain('API test code is generated when the tests first run');
  });

  it('--only with an unknown id exits 5 and names it', () => {
    const result = runCli([
      '--dry-run',
      'test',
      'plan',
      'accept',
      '--project',
      'proj_e2e_dry',
      '--only',
      'prop_404',
    ]);
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('prop_404');
  });
});

describe('test plan --help surface (dist)', () => {
  it('the plan group lists generate, accept, and put', () => {
    const result = runCli(['test', 'plan', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('generate');
    expect(result.stdout).toContain('accept');
    expect(result.stdout).toContain('put');
  });

  it('generate --help explains that spend is reported on the result line', () => {
    const result = runCli(['test', 'plan', 'generate', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Workspace credits are spent per stage that runs');
    expect(result.stdout).toContain('the result line reports');
    expect(result.stdout).toContain('what THIS run charged'); // F1 delta semantics
    expect(result.stdout).toContain('`testsprite usage` shows your balance');
  });
});
