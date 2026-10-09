/**
 * Explicit --local commands report local=true even when refused before opening
 * a tunnel. Saved loopback environments also report local=true after the
 * automatic tunnel opens. Exercise the built entrypoint and its HTTP beacon.
 * Run one file with vitest.e2e.config.ts after building the CLI.
 */

import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

let server: Server;
let baseUrl = '';
const telemetryBodies: Array<Record<string, unknown>> = [];
const requests: string[] = [];
const controlSockets = new Set<Duplex>();
const AUTO_CLIENT_ID = '11111111-2222-3333-4444-555555555555';
const AUTO_URL = 'http://localhost:5173';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString()));
    req.on('end', () => resolveBody(data));
    req.on('error', rejectBody);
  });
}

beforeAll(async () => {
  if (!existsSync(BIN_PATH)) {
    throw new Error('dist/index.js not found — run `npm run test:e2e` which builds first.');
  }

  server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    requests.push(`${req.method} ${path}`);
    if (req.url === '/api/cli/v1/telemetry' && req.method === 'POST') {
      void readBody(req).then(raw => {
        telemetryBodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(204, { connection: 'close' });
        res.end();
      });
      return;
    }
    const json = (body: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && path === '/api/cli/v1/tests/test_auto') {
      json({ id: 'test_auto', type: 'frontend', projectId: 'project_auto', name: 'auto-test' });
      return;
    }
    if (req.method === 'GET' && path === '/api/cli/v1/projects/project_auto/env') {
      json({
        environments: [{ id: 'env_auto', name: 'local-app', url: AUTO_URL, isDefault: true }],
      });
      return;
    }
    if (req.method === 'POST' && path === '/api/cli/v1/tunnel') {
      req.resume();
      json({
        clientId: AUTO_CLIENT_ID,
        secret: 'fixture-secret',
        controlUrl: `${baseUrl.replace('http:', 'ws:')}/control`,
        tunnelAddr: '127.0.0.1:1',
        expiresAt: '2099-01-01T00:00:00Z',
      });
      return;
    }
    if (req.method === 'DELETE' && path === `/api/cli/v1/tunnel/${AUTO_CLIENT_ID}`) {
      res.writeHead(204, { connection: 'close' });
      res.end();
      return;
    }
    if (req.method === 'POST' && path === '/api/cli/v1/tests/test_auto/runs') {
      req.resume();
      json({
        runId: 'run_auto',
        status: 'queued',
        enqueuedAt: '2026-10-01T00:00:00Z',
        codeVersion: 'v1',
        targetUrl: AUTO_URL,
        tunnelClientId: AUTO_CLIENT_ID,
      });
      return;
    }
    if (req.method === 'GET' && path === '/api/cli/v1/runs/run_auto') {
      json({
        runId: 'run_auto',
        testId: 'test_auto',
        projectId: 'project_auto',
        userId: 'user_auto',
        status: 'passed',
        source: 'cli',
        createdAt: '2026-10-01T00:00:00Z',
        startedAt: null,
        finishedAt: '2026-10-01T00:00:01Z',
        codeVersion: 'v1',
        targetUrl: AUTO_URL,
        createdFrom: 'cli',
        failedStepIndex: null,
        failureKind: null,
        error: null,
        videoUrl: null,
        stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 },
      });
      return;
    }
    res.writeHead(404, { connection: 'close' });
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    if ((req.url ?? '').split('?')[0] !== '/control') {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // The control plane's Ack settles TunnelClient.start(). No browser request
    // is sent, so the data plane is unused in this terminal-run fixture.
    const ack = Buffer.from('{"type":"Ack"}');
    socket.write(Buffer.concat([Buffer.from([0x81, ack.length]), ack]));
    controlSockets.add(socket);
    socket.on('close', () => controlSockets.delete(socket));
    socket.on('data', () => {});
  });
  await new Promise<void>(resolveListen => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  telemetryBodies.length = 0;
  requests.length = 0;
  for (const socket of controlSockets) socket.destroy();
});

afterAll(async () => {
  await new Promise<void>(resolveClose => {
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
});

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  const child = spawn(process.execPath, [BIN_PATH, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
    env: {
      ...process.env,
      TESTSPRITE_API_KEY: 'sk-user-e2e-telemetry-local',
      TESTSPRITE_API_URL: baseUrl,
      TESTSPRITE_NO_SKILL_WARNING: '1',
      TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
      // Neutralize any opt-out inherited from the developer's shell — this
      // suite exists to observe the telemetry POST, so it must not opt out.
      TESTSPRITE_NO_TELEMETRY: '',
      DO_NOT_TRACK: '',
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const status = await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', code => resolveExit(code ?? -1));
  });
  return { status, stdout, stderr };
}

/**
 * Poll for the telemetry POST to land: `recordOutcome` is awaited by
 * `index.ts` before exit, so by the time `runCli` resolves the POST has
 * already completed against this in-process server — no real race, but a
 * short bounded wait keeps the assertion robust against the async
 * `req.on('end', ...)` body-read tick above.
 */
async function waitForTelemetryBody(): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i++) {
    if (telemetryBodies.length > 0) return telemetryBodies[0]!;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('no telemetry POST received');
}

describe('telemetry — local field', () => {
  it('records local for a refused --local command that opened no tunnel', async () => {
    const result = await runCli([
      'test',
      'run',
      'some-test-id',
      '--local',
      '5173',
      '--target-url',
      'https://example.com',
      '--endpoint-url',
      baseUrl,
    ]);
    expect(result.status).toBe(5);
    const body = await waitForTelemetryBody();
    expect(body.command).toBe('test run');
    expect(body.outcome).toBe('error');
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.local).toBe(true);
    expect(requests).toEqual(['POST /api/cli/v1/telemetry']);
  });

  it('omits the local key for an ordinary (non --local) invocation', async () => {
    // <test-id> + --all is a different, --local-free mutual-exclusion
    // refusal (positional vs. --all) — same exit code, no --local anywhere.
    const result = await runCli([
      'test',
      'run',
      'some-test-id',
      '--all',
      '--endpoint-url',
      baseUrl,
    ]);
    expect(result.status).toBe(5);

    const body = await waitForTelemetryBody();
    expect(body.command).toBe('test run');
    expect(body.outcome).toBe('error');
    expect(body).not.toHaveProperty('local');
  });

  it('records local for an automatic tunnel without a --local flag', async () => {
    const result = await runCli([
      'test',
      'run',
      'test_auto',
      '--skip-preflight',
      '--output',
      'json',
      '--endpoint-url',
      baseUrl,
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ runId: 'run_auto', status: 'passed' });
    const body = await waitForTelemetryBody();
    expect(body).toMatchObject({ command: 'test run', outcome: 'success', local: true });
    expect(requests).toContain('POST /api/cli/v1/tunnel');
    expect(requests).toContain(`DELETE /api/cli/v1/tunnel/${AUTO_CLIENT_ID}`);
  });
});
