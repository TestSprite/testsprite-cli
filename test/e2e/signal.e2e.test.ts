import { runListing } from '../helpers/project-run.js';
/**
 * Local e2e tests for SIGINT/SIGTERM graceful detach during `--wait`
 * (exit 130/143/129 per the documented signal contract).
 *
 * Spawns the real built binary (`dist/index.js`) against a local HTTP stub
 * that lists the run's one result and then hangs every other request (the
 * `GET /runs/{id}` long-poll included) forever, sends a real signal to the
 * child, and asserts the honest-detach contract:
 *
 *   - stdout: parseable partial, the run with its result `running` (JSON mode)
 *   - stderr: "keeps running (and billing)" + re-attach hint naming the run
 *     (+ INTERRUPTED envelope in JSON mode)
 *   - exit code 130 (SIGINT) / 143 (SIGTERM)
 *
 * Run via: `npm run test:e2e` (builds first). Excluded from `npm test`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resultLine } from '../helpers/result-list.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

/** The run `run wait` is given, and the one result `GET /results` lists in it. */
const RUN_ID = 'run_sig_e2e_01';
const RESULT_ID = 'res_sig_e2e_01';
const LISTED = [resultLine({ resultId: RESULT_ID, runId: RUN_ID, caseKey: 'test_sig' })];

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
/** Every request path (with its query) the stub received, in order. */
const requested: string[] = [];
/** Resolvers waiting for the next hanging request to arrive. */
let listingReads = 0;
const runRequestWaiters: Array<() => void> = [];

beforeAll(async () => {
  // Nothing below runs on Windows, so don't stand up the stub server there.
  if (isWindows) return;
  if (!existsSync(BIN_PATH)) {
    throw new Error('dist/index.js not found — run `npm run test:e2e` which builds first.');
  }
  server = createServer((req, res) => {
    requested.push(req.url ?? '');
    if (req.url?.includes('/results') && listingReads++ === 0) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(runListing({ runId: RUN_ID, status: 'running', cancelled: false }, LISTED)),
      );
      return;
    }
    // Hang every other request (long-poll / stalled-backend simulation): the
    // CLI's abort must cut it. Signal any test waiting for the hang to arrive.
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

/** Resolves when the stub receives the next hanging request (the long-poll, for `run wait`). */
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
 * Spawn `testsprite run wait` (or the given argv) against the hanging stub,
 * deliver `signal` once a hanging request is in flight, and collect the outcome.
 */
async function waitAndInterrupt(
  signal: NodeJS.Signals,
  extraArgs: string[] = [],
  argv: string[] = ['run', 'wait', RUN_ID, '--timeout', '120'],
): Promise<SpawnResult> {
  listingReads = 0;
  const child = spawn(process.execPath, [BIN_PATH, ...argv, ...extraArgs], {
    env: {
      ...process.env,
      TESTSPRITE_API_KEY: 'sk-user-e2e-signal',
      TESTSPRITE_API_URL: baseUrl,
      TESTSPRITE_NO_SKILL_WARNING: '1',
      TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

describe.skipIf(isWindows)('signal e2e — graceful detach during run wait', () => {
  it('SIGINT (json mode) → exit 130, partial JSON on stdout, honest stderr hint', async () => {
    const result = await waitAndInterrupt('SIGINT', ['--output', 'json']);
    expect(result.code).toBe(130);

    // stdout is a parseable partial: the run, with its result not yet seen
    // to finish (file redirects never 0-byte).
    const partial = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(partial).toMatchObject({
      runs: [{ runId: RUN_ID }],
      results: [{ resultId: RESULT_ID, runId: RUN_ID, testId: 'test_sig', status: 'running' }],
      partial: true,
      summary: { total: 1 },
    });

    // stderr: honest detach line + machine-readable INTERRUPTED envelope, both
    // naming the run the command was given, before any poll answered.
    expect(result.stderr).toContain('Interrupted (SIGINT)');
    expect(result.stderr).toContain(`Run ${RUN_ID} is still executing`);
    expect(result.stderr).toContain('billing');
    expect(result.stderr).toContain(`Re-attach with: testsprite run wait ${RUN_ID}`);
    expect(result.stderr).toContain('"code": "INTERRUPTED"');
    expect(result.stderr).toContain(
      '"nextAction": "The server-side run keeps executing and billing. ' +
        `Re-attach with: testsprite run wait ${RUN_ID}, or stop it with: testsprite run cancel ${RUN_ID}."`,
    );
    expect(result.stderr).toContain('"signal": "SIGINT"');
  }, 30_000);

  it('SIGINT (text mode) → exit 130, human-readable partial + hint', async () => {
    const result = await waitAndInterrupt('SIGINT');
    expect(result.code).toBe(130);
    expect(result.stdout).toContain(`Run ${RUN_ID}`);
    expect(result.stdout).toContain(`${RESULT_ID}  Test test_sig  running`);
    expect(result.stderr).toContain('Interrupted (SIGINT)');
    expect(result.stderr).toContain('Error: Interrupted by SIGINT.');
  }, 30_000);

  it('SIGTERM → exit 143', async () => {
    const result = await waitAndInterrupt('SIGTERM', ['--output', 'json']);
    expect(result.code).toBe(143);
    expect(result.stderr).toContain('Interrupted (SIGTERM)');
    expect(result.stderr).toContain('"signal": "SIGTERM"');
  }, 30_000);

  it('SIGINT drains an in-flight non-wait request but exits immediately at an idle prompt', async () => {
    // `test list` is outside any armed --wait scope. The stub hangs its fetch;
    // the disarmed handler prints the generic explanation, then lets the
    // aborted request reach the shared top-level catch.
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
    expect(stderr).toContain('run wait');
    expect(stderr).toContain('Error: Interrupted by SIGINT.');
    expect(stderr).not.toContain('    at '); // no stack trace / corrupted output

    // `setup` waits at a prompt with no request to abort. Mark the piped stdin
    // as interactive in a tiny launcher so the real CLI enters that prompt.
    const launch = `Object.defineProperty(process.stdin, 'isTTY', { value: true }); process.argv = [process.execPath, ${JSON.stringify(BIN_PATH)}, 'setup', '--no-agent']; await import(${JSON.stringify(pathToFileURL(BIN_PATH).href)});`;
    const idleChild = spawn(process.execPath, ['--input-type=module', '--eval', launch], {
      env: {
        ...process.env,
        TESTSPRITE_API_KEY: '',
        TESTSPRITE_NO_SKILL_WARNING: '1',
        TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let idleStderr = '';
    const prompted = new Promise<void>(resolvePrompt => {
      idleChild.stderr.on('data', (chunk: Buffer) => {
        idleStderr += chunk.toString();
        if (idleStderr.includes('TestSprite API key:')) resolvePrompt();
      });
    });
    const idleExited = new Promise<number | null>(resolveExit => {
      idleChild.on('exit', exitCode => resolveExit(exitCode));
    });
    let promptTimer: ReturnType<typeof setTimeout> | undefined;
    const promptDeadline = new Promise<never>((_resolve, reject) => {
      promptTimer = setTimeout(() => reject(new Error('setup prompt did not appear')), 10_000);
    });
    try {
      await Promise.race([
        prompted,
        idleExited.then(exitCode => {
          throw new Error(`setup exited before prompting (${exitCode}): ${idleStderr}`);
        }),
        promptDeadline,
      ]);
      idleChild.kill('SIGINT');
      expect(await idleExited).toBe(130);
      expect(idleStderr).toContain('Interrupted (SIGINT)');
      expect(idleStderr).not.toContain('Error: Interrupted by SIGINT.');
    } finally {
      clearTimeout(promptTimer);
      idleChild.kill('SIGKILL');
    }
  }, 30_000);

  it('detach then re-attach — the same runId can be waited on again (server unaffected)', async () => {
    // First wait: interrupted.
    requested.length = 0;
    const first = await waitAndInterrupt('SIGINT', ['--output', 'json']);
    expect(first.code).toBe(130);
    // Re-attach: the stub lists the SAME run again and receives a fresh
    // long-poll for its result — proof the detach was client-side only. (We
    // interrupt again to end it.)
    const second = await waitAndInterrupt('SIGINT', ['--output', 'json']);
    expect(second.code).toBe(130);
    const listings = requested.filter(path => path.includes(`/results?run=${RUN_ID}`));
    const polls = requested.filter(path => path.includes(`/runs/${RESULT_ID}`));
    expect(listings).toHaveLength(4);
    expect(polls).toHaveLength(0);
    const partial = JSON.parse(second.stdout) as {
      results: Array<{ resultId: string; status: string }>;
    };
    expect(partial.results).toMatchObject([
      { resultId: RESULT_ID, testId: 'test_sig', status: 'running' },
    ]);
  }, 60_000);
});
