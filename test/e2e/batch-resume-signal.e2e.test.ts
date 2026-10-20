import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const binary = join(root, 'dist/index.js');
const batch = {
  accepted: [{ testId: 'test_new', runId: 'run_new', enqueuedAt: '2026-06-09T10:00:00Z' }],
  conflicts: [{ testId: 'test_busy', currentRunId: 'run_busy', reason: 'run_in_flight' }],
  deferred: [],
  skippedFrontend: ['test_frontend'],
  skippedIntegration: [{ testId: 'test_integration' }],
};

function passedRun(runId: string) {
  return {
    runId,
    testId: runId === 'run_new' ? 'test_new' : 'test_busy',
    projectId: 'project_signal',
    userId: 'user_signal',
    status: 'passed',
    source: 'cli',
    createdAt: '2026-06-09T10:00:00Z',
    startedAt: '2026-06-09T10:00:01Z',
    finishedAt: '2026-06-09T10:00:02Z',
    codeVersion: 'v1',
    targetUrl: 'https://example.com',
    createdFrom: 'cli',
    failedStepIndex: null,
    failureKind: null,
    error: null,
    videoUrl: null,
    stepSummary: { total: 1, completed: 1, passedCount: 1, failedCount: 0 },
  };
}

type Stage = 'request' | 'body' | 'idle' | 'complete';

async function runBatch(stage: Stage, signal: 'SIGINT' | 'SIGTERM', output: 'json' | 'text') {
  const directory = mkdtempSync(join(tmpdir(), 'batch-resume-signal-'));
  const preload = join(directory, 'preload.mjs');
  // The idle seam pauses getRun AFTER its real HTTP request has settled. It
  // makes the otherwise tiny gap deterministic, with no tracked request left
  // for the disarmed signal handler to drain. Signals and handlers stay real.
  writeFileSync(
    preload,
    `
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    import { HttpClient } from ${JSON.stringify(pathToFileURL(join(root, 'dist/lib/http.js')).href)};
    import { globalShutdown } from ${JSON.stringify(pathToFileURL(join(root, 'dist/lib/interrupt.js')).href)};
    os.homedir = () => ${JSON.stringify(directory)};
    syncBuiltinESMExports();
    const fetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.origin !== process.env.TESTSPRITE_API_URL) throw new Error('Unexpected origin');
      return fetch(input, init);
    };
    if (${JSON.stringify(stage)} === 'idle') {
      const getRun = HttpClient.prototype.getRun;
      HttpClient.prototype.getRun = async function(id, options) {
        const result = await getRun.call(this, id, options);
        if (id === 'run_busy' && options?.waitSeconds === undefined) {
          await new Promise((resolve, reject) => {
            const keepAlive = setInterval(() => {}, 1000);
            globalShutdown.signal.addEventListener('abort', () => { clearInterval(keepAlive); reject(globalShutdown.signal.reason); }, { once: true });
            process.send({ idle: true, critical: globalShutdown.hasCriticalOperations });
          });
        }
        return result;
      };
    }
  `,
  );
  const requests: Array<{ method: string; path: string }> = [];
  let ready!: () => void;
  const reached = new Promise<void>(resolveReady => {
    ready = resolveReady;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    const path = url.pathname.replace('/api/cli/v1', '');
    requests.push({ method: req.method!, path: req.url! });
    let body: unknown;
    if (path === '/projects/project_signal/env') body = { environments: [] };
    else if (path === '/tests/batch/run' && req.method === 'POST') body = batch;
    else if (path.startsWith('/runs/')) {
      if (
        path === '/runs/run_busy' &&
        !url.searchParams.has('waitSeconds') &&
        (stage === 'request' || stage === 'body')
      ) {
        if (stage === 'body') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"runId":"run_busy"');
        }
        ready();
        return;
      }
      body = passedRun(path.slice('/runs/'.length));
    } else {
      res.writeHead(500);
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port');
  const child = spawn(
    process.execPath,
    [
      '--import',
      preload,
      binary,
      'test',
      'run',
      '--all',
      '--project',
      'project_signal',
      '--wait',
      '--timeout',
      '30',
      '--max-concurrency',
      '1',
      '--output',
      output,
    ],
    {
      env: {
        ...process.env,
        TESTSPRITE_API_URL: `http://127.0.0.1:${address.port}`,
        TESTSPRITE_API_KEY: 'sk-user-e2e-batch-signal',
        TESTSPRITE_NO_TELEMETRY: '1',
        TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
        TESTSPRITE_NO_SKILL_WARNING: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  );
  let stdout = '';
  let stderr = '';
  let idleCritical: unknown;
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('message', (message: { idle?: boolean; critical?: boolean }) => {
    if (message.idle) {
      idleCritical = message.critical;
      ready();
    }
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveClose, reject) => {
      child.on('error', reject);
      child.on('close', (code, exitSignal) => resolveClose({ code, signal: exitSignal }));
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Batch fixture timed out: ${stderr}`)), 10_000);
  });
  try {
    if (stage !== 'complete') {
      await Promise.race([
        reached,
        closed.then(result => {
          throw new Error(`Exited before metadata signal: ${JSON.stringify(result)} ${stderr}`);
        }),
        deadline,
      ]);
      child.kill(signal);
    }
    const result = await Promise.race([closed, deadline]);
    return { ...result, stdout, stderr, requests, idleCritical };
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await closed;
    server.closeAllConnections();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    rmSync(directory, { recursive: true, force: true });
  }
}

// Windows does not deliver POSIX signals to the Node handler.
describe.skipIf(process.platform === 'win32')('batch conflict metadata signal receipts', () => {
  for (const stage of ['request', 'body', 'idle'] as const) {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const output of ['json', 'text'] as const) {
        it(`${stage}, ${signal}, ${output}: preserves acknowledged receipts without cancelling`, async () => {
          const result = await runBatch(stage, signal, output);
          expect(result.code).toBe(signal === 'SIGINT' ? 130 : 143);
          expect(result.signal).toBeNull();
          if (stage === 'idle') expect(result.idleCritical).toBe(false);
          if (output === 'json') {
            expect(JSON.parse(result.stdout)).toEqual({
              accepted: [{ testId: 'test_new', runId: 'run_new', status: 'running' }],
              conflicts: batch.conflicts,
              deferred: [],
              skippedFrontend: batch.skippedFrontend,
              skippedIntegration: batch.skippedIntegration,
            });
            expect(result.stderr).toContain('"code": "INTERRUPTED"');
          } else {
            expect(result.stdout).toContain('run_new  running');
          }
          expect(result.stderr).toContain(`Interrupted (${signal})`);
          expect(result.stderr).toContain('testsprite test wait run_new');
          expect(result.requests.filter(r => r.method !== 'GET')).toEqual([
            { method: 'POST', path: '/api/cli/v1/tests/batch/run' },
          ]);
          expect(result.requests.some(r => r.path.includes('waitSeconds'))).toBe(false);
        }, 15_000);
      }
    }
  }

  it('completes the normal accepted plus adopted run without changing resume behaviour', async () => {
    const result = await runBatch('complete', 'SIGINT', 'json');
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(
      payload.accepted.map((row: { runId: string; status: string }) => [row.runId, row.status]),
    ).toEqual([
      ['run_new', 'passed'],
      ['run_busy', 'passed'],
    ]);
    expect(payload.conflicts).toEqual([]);
    expect(result.stderr).not.toContain('Interrupted');
  }, 15_000);
});
