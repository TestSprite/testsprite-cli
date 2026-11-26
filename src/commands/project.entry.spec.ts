import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

// Intercept only external I/O in the real entry process. No socket or backend is needed.
const PRELOAD = `
globalThis.fetch = async (input, init) => {
  const url = String(input);
  process.stderr.write('HTTP: ' + url + '\\n');
  if (url.endsWith('/telemetry')) {
    process.stderr.write('TELEMETRY: ' + String(init?.body) + '\\n');
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify({
    projectId: 'project_local', type: 'frontend', name: 'Local app',
    createdFrom: 'cli', createdAt: '2026-09-09T00:00:00.000Z'
  }), { status: 201, headers: { 'content-type': 'application/json' } });
};
`;

function run(flags: string[], command = ['project', 'create', '--name', 'Local app']) {
  return spawnSync(
    process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(PRELOAD)}`, BIN, ...command, ...flags],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        TESTSPRITE_API_KEY: 'sk-user-test',
        TESTSPRITE_API_URL: 'https://api.example.com',
        TESTSPRITE_NO_TELEMETRY: '0',
        DO_NOT_TRACK: '0',
        TESTSPRITE_NO_SKILL_WARNING: '1',
        CI: '1',
      },
    },
  );
}

// Every case spawns the built CLI with a 10 s ceiling (`run` above). The test
// timeout must sit above that ceiling, or a slow runner fails the test while
// the child is still inside its own budget.
describe('validation errors and telemetry through the CLI entry', { timeout: 20_000 }, () => {
  it('refuses a blank positional with exit 5 and still reports the outcome', () => {
    const result = run(['--output', 'json'], ['project', 'get', '   ']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('VALIDATION_ERROR');
    expect(result.stderr).toContain('Argument `<project-id>` is invalid');
    expect(result.stderr.match(/HTTP: .*/g)).toEqual([
      'HTTP: https://api.example.com/api/cli/v1/telemetry',
    ]);
    const body = /TELEMETRY: (.*)/.exec(result.stderr)?.[1] ?? '';
    expect(JSON.parse(body)).toMatchObject({
      command: 'project get',
      outcome: 'error',
      errorCode: 'VALIDATION_ERROR',
      exitCode: 5,
    });
    expect(body).not.toContain('project-id');
  });

  it('names the blank positional even when the profile name is invalid too', () => {
    const result = run(['--profile', 'bad name'], ['project', 'get', '   ']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('Argument `<project-id>` is invalid');
  });

  it('still emits success telemetry after a successful create', () => {
    const result = run(['--type', 'frontend']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr.match(/HTTP: .*/g)).toEqual([
      'HTTP: https://api.example.com/api/cli/v1/projects',
      'HTTP: https://api.example.com/api/cli/v1/telemetry',
    ]);
  });

  it.each([
    ['create', ['--type', 'frontend', '--name', 'Shop']],
    ['update', ['project_local']],
  ])('never echoes a secret handed to the removed --password flag on project %s', (name, base) => {
    for (const extra of [[], ['--output', 'json'], ['--dry-run']]) {
      for (const flag of [
        ['--password=SECRET-ENTRY-DO-NOT-PRINT'],
        ['--password', 'SECRET-ENTRY-DO-NOT-PRINT'],
        // A quote inside the value does not end what is hidden.
        ["--password=it's-SECRET-ENTRY-DO-NOT-PRINT"],
      ]) {
        const result = run([...extra, ...flag], ['project', name, ...base]);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(5);
        expect(result.stderr).toContain('--password');
        expect(`${result.stdout}${result.stderr}`).not.toContain('SECRET-ENTRY-DO-NOT-PRINT');
      }
    }
  });

  it('preserves telemetry for existing test-run validation errors', () => {
    const result = run(['--tunnel-client', 'borrowed', '--no-wait'], ['run', 'test_1']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(5);
    expect(result.stderr.match(/HTTP: .*/g)).toEqual([
      'HTTP: https://api.example.com/api/cli/v1/telemetry',
    ]);
  });

  it('preserves telemetry for existing create validation errors', () => {
    const result = run([]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(5);
    expect(result.stderr.match(/HTTP: .*/g)).toEqual([
      'HTTP: https://api.example.com/api/cli/v1/telemetry',
    ]);
  });
});
