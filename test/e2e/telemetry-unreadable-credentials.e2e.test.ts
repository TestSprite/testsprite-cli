/**
 * An unreadable credentials file must not crash commands in the telemetry
 * pre-action hook (#465). The hook resolves telemetry auth before every
 * command's action; a raw EACCES/EPERM from that read used to end the process
 * before `doctor` could diagnose the file or an offline command could run.
 * Now the command runs as if telemetry were off: no beacon, and `doctor`
 * reports the problem itself.
 *
 * Exercises the built entrypoint against a local server that records every
 * request. `chmod 000` is how the read is made to fail, so the suite needs a
 * POSIX host and a non-root user (root reads through mode bits); the hook's
 * error handling itself is unit-tested cross-platform in `telemetry.spec.ts`.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

const canDenyRead = process.platform !== 'win32' && process.getuid?.() !== 0;

let server: Server;
let baseUrl = '';
const requests: string[] = [];
let home = '';
let credentialsPath = '';

beforeAll(async () => {
  if (!existsSync(BIN_PATH)) {
    throw new Error('dist/index.js not found — run `npm run test:e2e` which builds first.');
  }
  server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    requests.push(`${req.method} ${path}`);
    req.resume();
    if (req.method === 'POST' && path === '/api/cli/v1/telemetry') {
      res.writeHead(204, { connection: 'close' });
      res.end();
      return;
    }
    if (req.method === 'GET' && path === '/api/cli/v1/me') {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(
        JSON.stringify({
          userId: 'user_e2e',
          keyId: 'key_e2e',
          scopes: ['tests:read'],
          env: 'e2e',
        }),
      );
      return;
    }
    res.writeHead(404, { connection: 'close' });
    res.end();
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ts-e2e-unreadable-creds-'));
  mkdirSync(join(home, '.testsprite'));
  credentialsPath = join(home, '.testsprite', 'credentials');
  writeFileSync(credentialsPath, '[default]\napi_key = sk-user-from-file\n', { mode: 0o600 });
});

afterEach(() => {
  requests.length = 0;
  // Restore access first so the temp tree can be removed.
  if (existsSync(credentialsPath)) chmodSync(credentialsPath, 0o600);
  rmSync(home, { recursive: true, force: true });
});

afterAll(async () => {
  await new Promise<void>(resolveClose => {
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
});

async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [BIN_PATH, ...args], {
    cwd: home,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      // A key in the environment: the file is still read (loadConfig always
      // reads the profile), and without the fix that read is what crashes.
      TESTSPRITE_API_KEY: 'sk-user-e2e-env-key',
      TESTSPRITE_API_URL: baseUrl,
      TESTSPRITE_PROFILE: '',
      TESTSPRITE_NO_SKILL_WARNING: '1',
      TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
      // Telemetry must be ON — that is the path under test.
      TESTSPRITE_NO_TELEMETRY: '',
      DO_NOT_TRACK: '',
      CI: '',
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const status = await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', code => resolveExit(code ?? -1));
  });
  return { status, stdout, stderr };
}

const telemetryPosts = (): string[] => requests.filter(r => r === 'POST /api/cli/v1/telemetry');

describe('telemetry pre-action hook — readable credentials (control)', () => {
  it('sends the beacon, so its absence below is meaningful', async () => {
    const result = await runCli(['agent', 'list']);
    expect(result.status).toBe(0);
    expect(telemetryPosts()).toHaveLength(1);
  });
});

describe.skipIf(!canDenyRead)('telemetry pre-action hook — unreadable credentials file', () => {
  beforeEach(() => {
    chmodSync(credentialsPath, 0o000);
  });

  it('doctor runs and reports the Credentials problem itself; no beacon', async () => {
    const result = await runCli(['doctor']);
    const output = result.stdout + result.stderr;
    // TESTSPRITE_API_KEY is set and /me answers, so the unreadable file is a
    // WARN (commands still work) and doctor completes with exit 0.
    expect(result.status).toBe(0);
    expect(output).not.toMatch(/Error: (EACCES|EPERM)/);
    expect(output).toContain('TestSprite doctor');
    expect(output).toMatch(
      /\[WARN\]\s+Credentials\s+credentials file exists but cannot be read \((EACCES|EPERM)\)/,
    );
    expect(telemetryPosts()).toEqual([]);
  });

  it('an offline command (agent list) runs and exits 0; no beacon', async () => {
    const result = await runCli(['agent', 'list']);
    expect(result.stderr).not.toMatch(/EACCES|EPERM/);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('AGENT');
    expect(telemetryPosts()).toEqual([]);
  });

  it('completion still prints its script and exits 0; no beacon', async () => {
    const result = await runCli(['completion', 'bash']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('_testsprite_completion');
    expect(telemetryPosts()).toEqual([]);
  });

  it('--debug names why the beacon was skipped', async () => {
    const result = await runCli(['--debug', 'agent', 'list']);
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/\[debug\] telemetry skipped: (EACCES|EPERM)/);
    expect(telemetryPosts()).toEqual([]);
  });
});
