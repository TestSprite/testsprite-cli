/**
 * Local e2e tests for SIGINT/SIGTERM graceful detach during `--wait`
 * (exit 130/143/129 per the documented signal contract).
 *
 * Spawns the real built binary (`dist/index.js`) against a local HTTP stub
 * whose `GET /runs/{id}` long-poll hangs forever, sends a real signal to the
 * child, and asserts the honest-detach contract:
 *
 *   - stdout: parseable partial `{runId, status:"running"}` (JSON mode)
 *   - stderr: "keeps running (and billing)" + re-attach hint (+ INTERRUPTED
 *     envelope in JSON mode)
 *   - exit code 130 (SIGINT) / 143 (SIGTERM)
 *
 * Run via: `npm run test:e2e` (builds first). Excluded from `npm test`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

const RUN_ID = 'run_sig_e2e_01';

/**
 * Windows has no POSIX signal delivery. `child.kill('SIGINT')` there terminates
 * the process outright, so the graceful-detach handler never runs and the exit
 * code comes back `null` instead of 130/143. Every assertion below is about
 * that handler, so the suite is POSIX-only by nature rather than by neglect —
 * the handler itself is platform-shared and covered by the unit tests.
 */
const isWindows = process.platform === 'win32';

let server: Server;
let baseUrl = '';
/** Resolvers waiting for the next hanging /runs request to arrive. */
const runRequestWaiters: Array<() => void> = [];

beforeAll(async () => {
  // Nothing below runs on Windows, so don't stand up the stub server there.
  if (isWindows) return;
  if (!existsSync(BIN_PATH)) {
    throw new Error('dist/index.js not found — run `npm run test:e2e` which builds first.');
  }
  server = createServer((req, res) => {
    // Hang every request (long-poll / stalled-backend simulation): the CLI's
    // abort must cut it. Signal any test waiting for the request to arrive.
    runRequestWaiters.splice(0).forEach(fn => fn());
    req.on('close', () => res.destroy());
  });
  await new Promise<void>(resolveListen => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  // `server` is only assigned when beforeAll ran its body.
  if (!server) return;
  await new Promise<void>(resolveClose => {
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
});

/** Resolves when the stub receives the next hanging GET /runs request. */
function nextRunRequest(): Promise<void> {
  return new Promise<void>(resolveWait => runRequestWaiters.push(resolveWait));
}

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `testsprite test wait` against the hanging stub, deliver `signal`
 * once the long-poll request is in flight, and collect the outcome.
 */
async function waitAndInterrupt(
  signal: NodeJS.Signals,
  extraArgs: string[] = [],
): Promise<SpawnResult> {
  const child = spawn(
    process.execPath,
    [BIN_PATH, 'test', 'wait', RUN_ID, '--timeout', '120', ...extraArgs],
    {
      env: {
        ...process.env,
        TESTSPRITE_API_KEY: 'sk-user-e2e-signal',
        TESTSPRITE_API_URL: baseUrl,
        TESTSPRITE_NO_SKILL_WARNING: '1',
        TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

  const arrived = nextRunRequest();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    resolveExit => {
      child.on('exit', (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
    },
  );

  await arrived; // the long-poll fetch is in flight — the armed window is open
  await new Promise(r => setTimeout(r, 150)); // let the request settle into the poll loop
  child.kill(signal);

  const { code, signal: exitSignal } = await exited;
  return { code, signal: exitSignal, stdout, stderr };
}

describe.skipIf(isWindows)('signal e2e — graceful detach during test wait (DEV-331)', () => {
  it('SIG-1/SIG-2: SIGINT → exit 130, partial JSON on stdout, honest stderr hint', async () => {
    const result = await waitAndInterrupt('SIGINT', ['--output', 'json']);
    expect(result.code).toBe(130);

    // stdout is a parseable partial naming the runId (file redirects never 0-byte).
    const partial = JSON.parse(result.stdout) as { runId: string; status: string };
    expect(partial.runId).toBe(RUN_ID);
    expect(partial.status).toBe('running');

    // stderr: honest detach line + machine-readable INTERRUPTED envelope.
    expect(result.stderr).toContain('Interrupted (SIGINT)');
    expect(result.stderr).toContain('billing');
    expect(result.stderr).toContain(`testsprite test wait ${RUN_ID}`);
    expect(result.stderr).toContain('"code": "INTERRUPTED"');
    expect(result.stderr).toContain('"signal": "SIGINT"');
  }, 30_000);

  it('SIG-1 (text mode): SIGINT → exit 130, human-readable partial + hint', async () => {
    const result = await waitAndInterrupt('SIGINT');
    expect(result.code).toBe(130);
    expect(result.stdout).toContain(RUN_ID);
    expect(result.stdout).toContain('running (interrupted)');
    expect(result.stderr).toContain('Interrupted (SIGINT)');
    expect(result.stderr).toContain('Error: Interrupted by SIGINT.');
  }, 30_000);

  it('SIG-3: SIGTERM → exit 143', async () => {
    const result = await waitAndInterrupt('SIGTERM', ['--output', 'json']);
    expect(result.code).toBe(143);
    expect(result.stderr).toContain('Interrupted (SIGTERM)');
    expect(result.stderr).toContain('"signal": "SIGTERM"');
  }, 30_000);

  it('SIG-7: SIGINT during a non-wait command → immediate exit 130 with the generic explanation', async () => {
    // `test list` is outside any armed --wait scope. The stub hangs its fetch;
    // the disarmed handler must exit immediately with the generic explanation
    // (no partial envelope — there is no runId to re-attach to).
    const child = spawn(process.execPath, [BIN_PATH, 'test', 'list', '--project', 'p1'], {
      env: {
        ...process.env,
        TESTSPRITE_API_KEY: 'sk-user-e2e-signal',
        TESTSPRITE_API_URL: baseUrl,
        TESTSPRITE_NO_SKILL_WARNING: '1',
        TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<{ code: number | null }>(resolveExit => {
      child.on('exit', code => resolveExit({ code }));
    });
    const arrived = nextRunRequest();
    await arrived; // the list fetch is in flight (disarmed — no poll running)
    child.kill('SIGINT');
    const { code } = await exited;
    expect(code).toBe(130);
    expect(stderr).toContain('Interrupted (SIGINT)');
    expect(stderr).toContain('test wait');
    expect(stderr).not.toContain('    at '); // no stack trace / corrupted output
  }, 30_000);

  it('SIG-8: detach then re-attach — the same runId can be waited on again (server unaffected)', async () => {
    // First wait: interrupted.
    const first = await waitAndInterrupt('SIGINT', ['--output', 'json']);
    expect(first.code).toBe(130);
    // Re-attach: the stub receives a fresh long-poll for the SAME runId —
    // proof the detach was client-side only. (We interrupt again to end it.)
    const second = await waitAndInterrupt('SIGINT', ['--output', 'json']);
    expect(second.code).toBe(130);
    const partial = JSON.parse(second.stdout) as { runId: string };
    expect(partial.runId).toBe(RUN_ID);
  }, 60_000);
});
