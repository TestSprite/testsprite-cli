import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFreshBuild } from './helpers/assertFreshBuild.js';

const repoRoot = resolve(import.meta.dirname, '..');
const binary = resolve(repoRoot, 'dist/index.js');

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))),
  );
});

async function startConnectProxy(): Promise<{ port: number; targets: string[] }> {
  const targets: string[] = [];
  const body = JSON.stringify({
    userId: 'user-1',
    keyId: 'key-1',
    scopes: ['read:projects'],
    env: 'development',
  });
  const server = createServer();
  server.on('connect', (req, socket) => {
    targets.push(req.url ?? '');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => {
      socket.end(
        `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
    });
  });
  servers.push(server);
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  return { port: (server.address() as AddressInfo).port, targets };
}

function runCli(env: Record<string, string>) {
  assertFreshBuild(repoRoot, binary);
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(done => {
    const child = spawn(process.execPath, [binary, 'auth', 'status', '--output', 'json'], {
      env: {
        ...process.env,
        TESTSPRITE_API_KEY: 'sk-user-subproc',
        TESTSPRITE_API_URL: 'http://api.proxy-only.example',
        TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
        TESTSPRITE_NO_TELEMETRY: '1',
        NO_COLOR: '1',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += String(chunk)));
    child.stderr.on('data', chunk => (stderr += String(chunk)));
    child.on('close', status => done({ status, stdout, stderr }));
  });
}

describe('proxy variable written without a scheme, in the built CLI', () => {
  it.each(['HTTP_PROXY', 'http_proxy'] as const)(
    'reaches an API host only the proxy can resolve through a bare host:port in %s',
    async name => {
      const proxy = await startConnectProxy();
      const result = await runCli({ [name]: `127.0.0.1:${proxy.port}` });
      expect(result.stderr).not.toContain('ignoring proxy environment');
      expect(result.status).toBe(0);
      expect(proxy.targets).toEqual(['api.proxy-only.example:80']);
    },
    20_000,
  );
});
