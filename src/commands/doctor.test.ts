/**
 * Unit tests for `testsprite doctor`.
 *
 * The command reuses the real resolution helpers (loadConfig, makeHttpClient,
 * isVerifySkillInstalled), so these tests inject env/credentials/fetch/fs and
 * assert on the rendered report + the exit-on-failure contract.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CLIError } from '../lib/errors.js';
import { writeProfile } from '../lib/credentials.js';
import type { DoctorDeps, DoctorReport } from './doctor.js';
import { createDoctorCommand, runDoctor } from './doctor.js';

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
}

function makeCapture(): { capture: CapturedOutput; deps: Pick<DoctorDeps, 'stdout' | 'stderr'> } {
  const capture: CapturedOutput = { stdout: [], stderr: [] };
  return {
    capture,
    deps: {
      stdout: line => capture.stdout.push(line),
      stderr: line => capture.stderr.push(line),
    },
  };
}

function makeFetch(body: unknown, status = 200): DoctorDeps['fetchImpl'] {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as DoctorDeps['fetchImpl'];
}

const OK_ME = { userId: 'u-doc', keyId: 'k-doc' };

/** Base deps shared by the healthy-path tests: node OK, skill installed, empty env. */
function healthyDeps(credentialsPath: string, extra: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    env: {},
    credentialsPath,
    cwd: '/project',
    nodeVersion: '22.9.0',
    existsSync: () => true, // skill landing file present
    fetchImpl: makeFetch(OK_ME),
    ...extra,
  };
}

function makeDoctorProgram(deps: DoctorDeps = {}): Command {
  const program = new Command();
  program.exitOverride();
  program.option('--output <mode>', 'output', 'text');
  program.addCommand(createDoctorCommand(deps));
  return program;
}

let credentialsPath: string;

beforeEach(() => {
  credentialsPath = join(mkdtempSync(join(tmpdir(), 'testsprite-doctor-')), 'credentials');
});

describe('runDoctor — healthy environment', () => {
  it('returns an all-passing report and does not throw', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const report = await runDoctor(
      { profile: 'default', output: 'text', debug: false },
      { ...healthyDeps(credentialsPath), ...deps },
    );
    expect(report.failures).toBe(0);
    expect(report.warnings).toBe(0);
    const out = capture.stdout.join('\n');
    expect(out).toContain('[OK]');
    expect(out).toContain('All checks passed.');
    expect(out).toContain('reached GET /me');
  });

  it('adds a Routing check (v3) and the gap advisory when /me reports v3Enabled', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const report = await runDoctor(
      { profile: 'default', output: 'text', debug: false },
      {
        ...healthyDeps(credentialsPath, {
          fetchImpl: makeFetch({ ...OK_ME, v3Enabled: true }),
        }),
        ...deps,
      },
    );
    expect(report.failures).toBe(0);
    expect(report.checks.some(c => c.name === 'Routing' && c.detail.includes('v3'))).toBe(true);
    expect(capture.stderr.join('\n')).toContain('[advisory]');
    expect(capture.stderr.join('\n')).toContain('--target-url');
  });

  it('shows Routing v2 and no advisory when v3Enabled is false', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const report = await runDoctor(
      { profile: 'default', output: 'text', debug: false },
      {
        ...healthyDeps(credentialsPath, {
          fetchImpl: makeFetch({ ...OK_ME, v3Enabled: false }),
        }),
        ...deps,
      },
    );
    expect(report.checks.some(c => c.name === 'Routing' && c.detail.includes('v2'))).toBe(true);
    expect(capture.stderr.join('\n')).not.toContain('[advisory]');
  });

  it('omits the Routing check when /me does not report v3Enabled', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { deps } = makeCapture();
    const report = await runDoctor(
      { profile: 'default', output: 'text', debug: false },
      { ...healthyDeps(credentialsPath), ...deps }, // OK_ME has no v3Enabled
    );
    expect(report.checks.some(c => c.name === 'Routing')).toBe(false);
    expect(report.warnings).toBe(0);
  });

  it('adds Organizations and Org binding checks when /me reports them', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const report = await runDoctor(
      { profile: 'default', output: 'text', debug: false },
      {
        ...healthyDeps(credentialsPath, {
          fetchImpl: makeFetch({
            ...OK_ME,
            organizations: [{ id: 'org_1', name: 'Acme Corp', role: 'owner', isPersonal: false }],
            org: { id: 'org_1', name: 'Acme Corp', role: 'owner' },
          }),
        }),
        ...deps,
      },
    );
    expect(report.failures).toBe(0);
    const orgsCheck = report.checks.find(c => c.name === 'Organizations');
    expect(orgsCheck?.status).toBe('ok');
    expect(orgsCheck?.detail).toBe('Acme Corp (org_1, role: owner)');
    const bindingCheck = report.checks.find(c => c.name === 'Org binding');
    expect(bindingCheck?.status).toBe('ok');
    expect(bindingCheck?.detail).toBe('Acme Corp (org_1, role: owner)');
    expect(capture.stdout.join('\n')).toContain('Organizations');
    expect(capture.stdout.join('\n')).toContain('Org binding');
  });

  it('omits Organizations and Org binding checks when /me does not report them (older backend)', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { deps } = makeCapture();
    const report = await runDoctor(
      { profile: 'default', output: 'text', debug: false },
      { ...healthyDeps(credentialsPath), ...deps }, // OK_ME has no organizations/org
    );
    expect(report.checks.some(c => c.name === 'Organizations')).toBe(false);
    expect(report.checks.some(c => c.name === 'Org binding')).toBe(false);
    expect(report.warnings).toBe(0);
  });

  it('never prints the API key anywhere in the report', async () => {
    writeProfile('default', { apiKey: 'sk-user-super-secret-value' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runDoctor(
      { profile: 'default', output: 'text', debug: false },
      { ...healthyDeps(credentialsPath), ...deps },
    );
    const all = capture.stdout.join('\n') + capture.stderr.join('\n');
    expect(all).not.toContain('sk-user-super-secret-value');
  });

  it('emits a machine-readable report under --output json without leaking the API key', async () => {
    writeProfile('default', { apiKey: 'sk-user-json-secret-value' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    await runDoctor(
      { profile: 'default', output: 'json', debug: false },
      { ...healthyDeps(credentialsPath), ...deps },
    );
    const raw = capture.stdout.join('');
    // Security: the JSON serialization path is distinct from the text renderer,
    // so assert the key never leaks here either.
    expect(raw).not.toContain('sk-user-json-secret-value');
    const parsed = JSON.parse(raw) as DoctorReport;
    expect(parsed.failures).toBe(0);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(
      parsed.checks.some(check => check.name === 'Connectivity' && check.status === 'ok'),
    ).toBe(true);
  });
});

describe('runDoctor — failing checks exit non-zero', () => {
  it('missing API key fails Credentials and throws CLIError (exit 1)', async () => {
    const { capture, deps } = makeCapture();
    const rejection = await runDoctor(
      { profile: 'default', output: 'text', debug: false },
      { ...healthyDeps(credentialsPath), ...deps }, // no profile written => no key
    ).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(CLIError);
    expect(rejection).toMatchObject({ exitCode: 1 });
    const out = capture.stdout.join('\n');
    expect(out).toContain('[FAIL]');
    expect(out).toContain('Credentials');
  });

  it('invalid endpoint URL fails the API endpoint check', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const rejection = await runDoctor(
      { profile: 'default', output: 'text', debug: false, endpointUrl: 'not-a-url' },
      { ...healthyDeps(credentialsPath), ...deps },
    ).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(CLIError);
    const out = capture.stdout.join('\n');
    expect(out).toContain('API endpoint');
    expect(out).toContain('not a valid');
  });

  it('rejected API key surfaces as a Connectivity failure', async () => {
    writeProfile('default', { apiKey: 'sk-user-bad' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const authError = {
      error: { code: 'AUTH_INVALID', message: 'Bad key.', requestId: 'req_x', details: {} },
    };
    const rejection = await runDoctor(
      { profile: 'default', output: 'text', debug: false },
      { ...healthyDeps(credentialsPath, { fetchImpl: makeFetch(authError, 401) }), ...deps },
    ).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(CLIError);
    const out = capture.stdout.join('\n');
    expect(out).toContain('Connectivity');
    expect(out).toContain('API key rejected (AUTH_INVALID)');
  });

  it('a non-auth /me error is reported as a Connectivity failure with its code', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const notFound = {
      error: { code: 'NOT_FOUND', message: 'nope', requestId: 'req_y', details: {} },
    };
    const rejection = await runDoctor(
      { profile: 'default', output: 'text', debug: false },
      { ...healthyDeps(credentialsPath, { fetchImpl: makeFetch(notFound, 404) }), ...deps },
    ).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(CLIError);
    expect(capture.stdout.join('\n')).toContain('GET /me failed (NOT_FOUND)');
  });

  it('an outdated Node runtime fails the Node.js check', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const rejection = await runDoctor(
      { profile: 'default', output: 'text', debug: false },
      { ...healthyDeps(credentialsPath, { nodeVersion: '18.0.0' }), ...deps },
    ).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(CLIError);
    const out = capture.stdout.join('\n');
    expect(out).toContain('Node.js');
    expect(out).toContain('below the required Node 20');
  });
});

describe('runDoctor — warnings do not fail', () => {
  it('missing verify skill is a warning, not a failure', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    const { capture, deps } = makeCapture();
    const report = await runDoctor(
      { profile: 'default', output: 'text', debug: false },
      { ...healthyDeps(credentialsPath, { existsSync: () => false }), ...deps },
    );
    expect(report.failures).toBe(0);
    expect(report.warnings).toBeGreaterThanOrEqual(1);
    const out = capture.stdout.join('\n');
    expect(out).toContain('[WARN]');
    expect(out).toContain('Verify skill');
  });

  it('--dry-run skips connectivity and never calls fetch, missing key is a warning', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('fetch must not be called under --dry-run');
    }) as unknown as DoctorDeps['fetchImpl'];
    const { capture, deps } = makeCapture();
    const report = await runDoctor(
      { profile: 'default', output: 'text', debug: false, dryRun: true },
      {
        env: {},
        credentialsPath,
        cwd: '/project',
        nodeVersion: '22.9.0',
        existsSync: () => true,
        fetchImpl,
        ...deps,
      },
    );
    expect(report.failures).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(capture.stdout.join('\n')).toContain('skipped under --dry-run');
  });
});

describe('createDoctorCommand wiring', () => {
  it('exposes the doctor command name', () => {
    expect(createDoctorCommand().name()).toBe('doctor');
  });

  it('--help describes the diagnostic', () => {
    expect(createDoctorCommand().helpInformation()).toContain('Diagnose');
  });

  it('rejects invalid --output with the shared VALIDATION_ERROR', async () => {
    const rejection = await makeDoctorProgram()
      .parseAsync(['node', 'ts', '--output', 'yaml', 'doctor'])
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ApiError);
    expect(rejection).toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      nextAction: 'Flag `--output` is invalid: must be one of: json, text.',
    });
  });

  it('accepts valid --output modes through command wiring', async () => {
    writeProfile('default', { apiKey: 'sk-user-abc' }, { path: credentialsPath });
    for (const mode of ['text', 'json'] as const) {
      const { capture, deps } = makeCapture();
      await makeDoctorProgram({ ...healthyDeps(credentialsPath), ...deps }).parseAsync([
        'node',
        'ts',
        '--output',
        mode,
        'doctor',
      ]);
      const raw = capture.stdout.join('');
      if (mode === 'json') {
        expect((JSON.parse(raw) as DoctorReport).failures).toBe(0);
      } else {
        expect(raw).toContain('All checks passed.');
      }
    }
  });
});
