import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

// Intercept only external I/O in the real entry process. No socket or backend is needed.
const PRELOAD = `
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
net.connect = () => {
  const socket = new EventEmitter();
  socket.destroy = () => socket;
  queueMicrotask(() => socket.emit('error', new Error('ECONNREFUSED')));
  return socket;
};
syncBuiltinESMExports();
globalThis.fetch = async input => {
  const url = String(input);
  process.stderr.write('HTTP: ' + url + '\\n');
  if (url.endsWith('/telemetry')) return new Response(null, { status: 204 });
  return new Response(JSON.stringify({
    projectId: 'project_local', type: 'frontend', name: 'Local app',
    createdFrom: 'cli', createdAt: '2026-09-09T00:00:00.000Z',
    targetUrl: 'http://127.0.0.1:3000', originMode: 'local'
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
describe('local project admission through the CLI entry', { timeout: 20_000 }, () => {
  it('routes project sign-in get through the real CLI entry', () => {
    const result = run(['--output', 'json'], ['project', 'sign-in', 'get', 'proj_1']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      'HTTP: https://api.example.com/api/cli/v1/projects/proj_1/sign-in',
    );
  });

  it('validates a missing sign-in mode with exit 5 before the sign-in request', () => {
    const result = run([], ['project', 'sign-in', 'set', 'proj_1']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('--mode is required: public, account or manual');
    expect(result.stderr.match(/HTTP: .*/g)).toEqual([
      'HTTP: https://api.example.com/api/cli/v1/telemetry',
    ]);
  });

  it.each(['constructor', '__proto__', 'toString'])(
    'rejects inherited sign-in mode %s before an API request',
    mode => {
      for (const command of [
        ['project', 'sign-in', 'set', 'proj_1', '--mode', mode],
        [
          'project',
          'env',
          'create',
          'proj_1',
          '--name',
          'staging',
          '--url',
          'https://example.com',
          '--sign-in',
          mode,
        ],
      ]) {
        const result = run([], command);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(5);
        expect(result.stderr).not.toContain('HTTP: https://api.example.com/api/cli/v1/projects/');
      }
    },
  );
  it.each([
    ['--type', 'frontend', '--local', '3000'],
    ['--type', 'frontend', '--local', '3000', '--url', 'https://example.com'],
    ['--type', 'backend', '--local', '3000'],
    ['--type', 'frontend', '--local', '0'],
    ['--type', 'frontend', '--local', '3000', '--local-host', 'example.com'],
    ['--type', 'frontend', '--local-host', 'localhost', '--url', 'https://example.com'],
  ])('refuses %j without any HTTP, including telemetry', (...flags) => {
    const result = run(flags);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(5);
    expect(result.stderr).not.toContain('HTTP:');
  });

  it('still emits success telemetry after a skipped probe and successful create', () => {
    const result = run(['--type', 'frontend', '--local', '3000', '--skip-preflight']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr.match(/HTTP: .*/g)).toEqual([
      'HTTP: https://api.example.com/api/cli/v1/projects',
      'HTTP: https://api.example.com/api/cli/v1/telemetry',
    ]);
  });

  it('preserves telemetry for existing test-run local validation errors', () => {
    const result = run(['--local', '0'], ['test', 'run', 'test_1']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(5);
    expect(result.stderr.match(/HTTP: .*/g)).toEqual([
      'HTTP: https://api.example.com/api/cli/v1/telemetry',
    ]);
  });

  it('preserves telemetry for existing public-create validation errors', () => {
    const result = run(['--type', 'frontend']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(5);
    expect(result.stderr.match(/HTTP: .*/g)).toEqual([
      'HTTP: https://api.example.com/api/cli/v1/telemetry',
    ]);
  });
});
