import { projectRun, runListing } from '../helpers/project-run.js';
/**
 * Local e2e regression tests for the error-path exit contract.
 *
 * On Windows, `process.exit(code)` on the error path raced the teardown of the
 * just-used TLS socket: libuv's Windows async-handle cleanup asserted
 * (`src/win/async.c`) and the process died with 0xC0000409 (-1073740791)
 * instead of the documented exit code — voiding the exit-code contract for
 * every script/CI/agent that branches on it. The fix sets `process.exitCode`
 * and lets the event loop drain, like the success path always did.
 *
 * The crash itself is timing-dependent (it needs a real-network TLS socket
 * mid-close at exit; a loopback stub settles too fast to reproduce it), so
 * asserting "no crash text" alone would pass even on broken code. The
 * deterministic discriminator is Node's `beforeExit` event: it fires only when
 * the process exits by draining the event loop and is skipped entirely by
 * `process.exit()`. A `--require` probe prints a marker from `beforeExit`;
 * the marker's presence proves the drain path, its absence a forced exit.
 *
 * Run via: `npm run test:e2e` (builds first). Excluded from `npm test`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resultLine } from '../helpers/result-list.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

const DRAIN_MARKER = 'BEFORE_EXIT_FIRED';

let server: Server;
let baseUrl = '';
let probeDir = '';
let probePath = '';

beforeAll(async () => {
  if (!existsSync(BIN_PATH)) {
    throw new Error('dist/index.js not found — run `npm run test:e2e` which builds first.');
  }

  // `beforeExit` fires only on a natural event-loop drain, never after
  // `process.exit()` — the probe turns that into an observable marker.
  probeDir = await mkdtemp(join(tmpdir(), 'testsprite-exit-probe-'));
  probePath = join(probeDir, 'before-exit-probe.cjs');
  await writeFile(
    probePath,
    `process.on('beforeExit', () => { process.stderr.write('${DRAIN_MARKER}\\n'); });\n`,
    'utf8',
  );

  // Stub routes:
  //   - /results?run=exec_failed_e2e        → the run's one result, run_failed_e2e,
  //     listed as still running
  //   - anything under /runs/run_failed_e2e → that result, now FAILED (drives
  //     the CLIError branch: `run wait` exits 1 after printing the results)
  //   - anything mentioning "hang"          → never answers (drives the
  //     RequestTimeoutError branch under --request-timeout 1)
  //   - everything else                     → 404 error envelope, connection
  //     closed, mimicking how the real backend ends an error exchange.
  server = createServer((req, res) => {
    const url = req.url ?? '';
    const path = new URL(url, 'http://localhost').pathname.replace('/api/cli/v1', '');
    const fixtures: Record<string, unknown> = {
      'GET /tests/test_e2e': { id: 'test_e2e', type: 'frontend', projectId: 'project_1' },
      'GET /projects/project_1': { id: 'project_1', type: 'frontend' },
      'GET /projects/project_1/env': { environments: [] },
      'POST /projects/project_1/runs': projectRun({ runId: 'exec_failed_e2e' }),
      'GET /testlist/list_e2e': { id: 'list_e2e', cases: [] },
      'POST /testlist/list_e2e/run': {
        accepted: [
          {
            runId: 'exec_failed_e2e',
            testId: 'test_e2e',
            resultId: 'run_failed_e2e',
            enqueuedAt: '2026-05-15T10:00:00Z',
          },
        ],
        conflicts: [],
        deferred: [],
      },
    };
    const fixture = fixtures[`${req.method} ${path}`];
    if (fixture) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fixture));
      return;
    }
    if (url.includes('/results') && url.includes('run=exec_failed_e2e')) {
      const line = resultLine({
        resultId: 'run_failed_e2e',
        runId: 'exec_failed_e2e',
        caseKey: 'test_e2e',
        testStatus: 'FAILED',
      });
      const list = JSON.stringify(
        runListing({ runId: 'exec_failed_e2e', status: 'finished', cancelled: false }, [line]),
      );
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(list),
        connection: 'close',
      });
      res.end(list);
      return;
    }
    if (url.includes('/runs/run_failed_e2e')) {
      const run = JSON.stringify({
        resultId: 'run_failed_e2e',
        testId: 'test_e2e',
        projectId: 'proj_e2e',
        userId: 'user_e2e',
        status: 'failed',
        source: 'cli',
        createdAt: '2026-08-18T00:00:00.000Z',
        startedAt: '2026-08-18T00:00:01.000Z',
        finishedAt: '2026-08-18T00:00:05.000Z',
        stepSummary: { total: 3, completed: 3, passedCount: 2, failedCount: 1 },
      });
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(run),
        connection: 'close',
      });
      res.end(run);
      return;
    }
    if (url.includes('hang')) {
      // Accept and never respond; the client's --request-timeout must cut it.
      req.on('close', () => res.destroy());
      return;
    }
    const body = JSON.stringify({
      error: {
        code: 'NOT_FOUND',
        message: 'Resource not found.',
        nextAction:
          'Check the id with the corresponding `list` command, e.g. `testsprite test list --project <id>`.',
        requestId: 'cli_exit_code_e2e',
      },
    });
    res.writeHead(404, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      connection: 'close',
    });
    res.end(body);
  });
  await new Promise<void>(resolveListen => {
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>(resolveClose => {
    server.close(() => resolveClose());
    server.closeAllConnections();
  });
  await rm(probeDir, { recursive: true, force: true });
});

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the built CLI with the beforeExit probe preloaded. */
function runCli(args: string[]): Promise<SpawnResult> {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, ['--require', probePath, BIN_PATH, ...args], {
      env: {
        ...process.env,
        TESTSPRITE_API_KEY: 'sk-user-e2e-exit-code',
        TESTSPRITE_API_URL: baseUrl,
        TESTSPRITE_NO_SKILL_WARNING: '1',
        TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
        TESTSPRITE_NO_TELEMETRY: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', code => resolveRun({ code, stdout, stderr }));
  });
}

describe('exit-code e2e — error paths exit by draining, with the documented code', () => {
  it('NOT_FOUND: exit 4 exactly, friendly error, natural drain, no crash text', async () => {
    const result = await runCli(['test', 'get', 'bogus-test-id-12345', '--endpoint-url', baseUrl]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('Resource not found.');
    expect(result.stderr).toContain(DRAIN_MARKER);
    expect(result.stderr).not.toContain('Assertion failed');
    expect(result.stdout).not.toContain('Assertion failed');
  }, 30_000);

  it('NOT_FOUND (--output json): exit 4, machine envelope on stderr, natural drain', async () => {
    const result = await runCli([
      '--output',
      'json',
      'test',
      'get',
      'bogus-test-id-12345',
      '--endpoint-url',
      baseUrl,
    ]);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('"code": "NOT_FOUND"');
    expect(result.stderr).toContain(DRAIN_MARKER);
  }, 30_000);

  it('parse error (unknown command): exit 5, natural drain', async () => {
    const result = await runCli(['nosuchcommand']);
    expect(result.code).toBe(5);
    expect(result.stderr).toContain(DRAIN_MARKER);
  }, 30_000);

  it('CLIError (failed run under wait): exit 1 exactly, natural drain', async () => {
    // The everyday customer path: `run wait` sees a terminal non-passed
    // result and throws CLIError(1) — src/commands/test.ts "finished
    // non-passed". Exit 1 must come from the drain, not a forced exit.
    const result = await runCli(['run', 'wait', 'exec_failed_e2e', '--endpoint-url', baseUrl]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(DRAIN_MARKER);
    expect(result.stderr).not.toContain('Assertion failed');
  }, 30_000);

  it.each(
    Object.entries({
      named: ['run', 'test_e2e', '--wait'],
      project: ['run', '--project', 'project_1', '--wait'],
      list: ['run', '--testlist', 'list_e2e', '--wait'],
      resume: ['run', 'wait', 'exec_failed_e2e'],
    }),
  )('returns the same complete failed verdict for %s', async (_selection, args) => {
    const result = await runCli([...args, '--endpoint-url', baseUrl, '--output', 'json']);
    expect(result.code).toBe(1);
    expect(result.stdout, result.stderr).not.toBe('');
    const output = JSON.parse(result.stdout);
    expect(output.runs).toMatchObject([{ runId: 'exec_failed_e2e', status: 'finished' }]);
    expect(output.results).toMatchObject([
      {
        resultId: 'run_failed_e2e',
        runId: 'exec_failed_e2e',
        testId: 'test_e2e',
        title: 'Test test_e2e',
        status: 'failed',
      },
    ]);
    expect(output.summary).toMatchObject({
      total: 1,
      failed: 1,
      passed: 0,
      skipped: 0,
      timedOut: 0,
    });
    expect(output).not.toHaveProperty('partial');
    expect(output).not.toHaveProperty('accepted');
    expect(output.summary).not.toHaveProperty('results');
    expect(output.runs[0]).not.toHaveProperty('results');
  });

  it('RequestTimeoutError: exit 7 exactly, natural drain', async () => {
    // The stub accepts the request and never answers; --request-timeout 1
    // aborts it client-side → RequestTimeoutError → exit 7.
    const result = await runCli([
      'test',
      'get',
      'hang-test-id',
      '--endpoint-url',
      baseUrl,
      '--request-timeout',
      '1',
    ]);
    expect(result.code).toBe(7);
    expect(result.stderr).toContain(DRAIN_MARKER);
    expect(result.stderr).not.toContain('Assertion failed');
  }, 30_000);

  it('help subcommand: exit 0, natural drain (restructured help branch)', async () => {
    const result = await runCli(['help', 'test']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stderr).toContain(DRAIN_MARKER);
    // The help path must not fall through into the parse-error rendering.
    expect(result.stderr).not.toContain('error');
  }, 30_000);
});
