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

describe('local project admission through the CLI entry', () => {
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
