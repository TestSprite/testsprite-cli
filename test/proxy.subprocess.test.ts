/**
 * Subprocess test for proxy variables written as `host:port` (no scheme), the
 * way many corporate machines and CI runners set them. The API URL points at
 * a closed local port that only the proxy can "reach": the in-test proxy
 * answers every CONNECT by tunnelling to the local API server, so the command
 * succeeds only if the built CLI really sends its traffic through the proxy.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertFreshBuild } from './helpers/assertFreshBuild.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

const ME_BODY = {
  userId: 'u-proxy',
  keyId: 'k-proxy',
  scopes: ['read:projects'],
  env: 'development',
};

let api: Server;
let proxy: Server;
let proxyPort: number;
let unreachableApiUrl: string;
let tmpHome: string;
const tunnels: string[] = [];
const sockets = new Set<Socket>();

function listen(server: Server): Promise<number> {
  return new Promise(resolveListen => {
    server.listen(0, '127.0.0.1', () => resolveListen((server.address() as AddressInfo).port));
  });
}

beforeAll(async () => {
  assertFreshBuild(REPO_ROOT, BIN_PATH);
  api = createServer((req, res) => {
    if (req.url === '/api/cli/v1/me') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ME_BODY));
      return;
    }
    res.writeHead(404).end();
  });
  const apiPort = await listen(api);

  proxy = createServer((_req, res) => res.writeHead(502).end());
  proxy.on('connect', (req, client: Socket, head: Buffer) => {
    tunnels.push(req.url ?? '');
    const upstream = connect(apiPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.on('close', () => sockets.delete(socket));
    }
  });
  proxyPort = await listen(proxy);

  const closed = createServer();
  const closedPort = await listen(closed);
  await new Promise(resolveClose => closed.close(resolveClose));
  unreachableApiUrl = `http://127.0.0.1:${closedPort}`;

  tmpHome = mkdtempSync(join(tmpdir(), 'testsprite-proxy-'));
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    [api, proxy].map(server => new Promise(resolveClose => server?.close(resolveClose))),
  );
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

function runCli(
  args: string[],
  envOverrides: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn('node', [BIN_PATH, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        HTTP_PROXY: undefined,
        HTTPS_PROXY: undefined,
        http_proxy: undefined,
        https_proxy: undefined,
        NO_PROXY: undefined,
        no_proxy: undefined,
        TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
        TESTSPRITE_NO_TELEMETRY: '1',
        NO_COLOR: '1',
        ...envOverrides,
      } as NodeJS.ProcessEnv,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk.toString()));
    child.stderr.on('data', chunk => (stderr += chunk.toString()));
    child.on('error', rejectResult);
    child.on('close', code => resolveResult({ exitCode: code ?? -1, stdout, stderr }));
  });
}

describe('proxy variables without a scheme (built CLI)', () => {
  it('sends auth status through a host:port proxy and exits 0', async () => {
    tunnels.length = 0;
    const result = await runCli(['auth', 'status', '--output', 'json'], {
      TESTSPRITE_API_KEY: 'sk-user-proxy',
      TESTSPRITE_API_URL: unreachableApiUrl,
      HTTP_PROXY: `127.0.0.1:${proxyPort}`,
      HTTPS_PROXY: `127.0.0.1:${proxyPort}`,
    });
    expect(result.stderr).not.toContain('ignoring proxy environment');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(ME_BODY);
    expect(tunnels).toContain(new URL(unreachableApiUrl).host);
  }, 30_000);
});
