/**
 * Local e2e test for the `--local` telemetry field (`lib/telemetry.ts`'s
 * `local?: boolean`).
 *
 * Exercises the real built binary (`dist/index.js`) so the full wiring is
 * verified end-to-end: `test run`'s `--local <port>` option parsed by
 * Commander → read off `actionCommand.optsWithGlobals()` in `src/index.ts`'s
 * `preAction` hook (the same seam the hook already uses for other
 * subcommand-local flags, e.g. `--plan-template`) → carried in the
 * module-level `telemetryLocal` mutable → merged into the `recordOutcome`
 * event at both emit sites (success path and the error `catch` block) →
 * `buildTelemetryEvent` → the `POST /api/cli/v1/telemetry` body.
 *
 * Both invocations below are deliberately a client-side, zero-network
 * mutual-exclusion refusal (`test run --all --local <port>` and
 * `test run <id> --all`) rather than a real dead-port probe or a real
 * triggered run — this is the wiring test, not a re-test of `--local`'s own
 * validation (covered in `commands/test.ts`'s specs) or of the port probe
 * (covered in `lib/local-target.spec.ts`). It doubles as the required proof
 * that the field is reported even for an invocation nothing server-side ever
 * saw, which is the reason this field exists.
 *
 * SCOPE — this proves only the CLI's side of the wire. The stub server above
 * accepts any body (it never validates against the backend DTO), and as of
 * this writing `origin/dev` of backend-v2.0 does not yet declare `local` on
 * the telemetry DTO — its global `ValidationPipe({ whitelist: true })` would
 * silently strip an undeclared field, so a real production POST loses this
 * field today even though this test passes. The backend-side declaration is
 * a parallel, separate change; the true end-to-end witness (the field
 * actually reaching PostHog) is that change's job, not this test's. Don't
 * read this file's green as proof the counter produces data in production.
 *
 * Run via: `npm run test:e2e` (builds first). Excluded from `npm test`.
 */

import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

let server: Server;
let baseUrl = '';
const telemetryBodies: Array<Record<string, unknown>> = [];

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
    if (req.url === '/api/cli/v1/telemetry' && req.method === 'POST') {
      void readBody(req).then(raw => {
        telemetryBodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(204, { connection: 'close' });
        res.end();
      });
      return;
    }
    // Neither invocation below should ever reach any other route — both are
    // client-side refusals before the trigger POST. A hit here would mean
    // the mutual-exclusion guard regressed and let the command reach the
    // network, which the test's exit-code assertion also guards against.
    res.writeHead(404, { connection: 'close' });
    res.end();
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

function runCli(args: string[]): CliResult {
  const result = spawnSync(process.execPath, [BIN_PATH, ...args], {
    encoding: 'utf8',
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
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Poll for the telemetry POST to land: `recordOutcome` is awaited by
 * `index.ts` before exit, so by the time `spawnSync` returns the POST has
 * already completed against this in-process server — no real race, but a
 * tiny synchronous wait keeps the assertion robust against the async
 * `req.on('end', ...)` body-read tick above.
 */
async function waitForTelemetryBody(): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i++) {
    if (telemetryBodies.length > 0) return telemetryBodies[0]!;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('no telemetry POST received');
}

describe('telemetry — --local field', () => {
  it('reports local: true for a --local invocation, even a zero-network refusal', async () => {
    // `--local` + `--all` is a client-side mutual-exclusion refusal (`--local`
    // runs one test through one tunnel; `--all` fans out) — thrown before any
    // network call, i.e. exactly the class of attempt a backend-side
    // mint/attach analytics event can never see.
    const result = runCli(['test', 'run', '--all', '--local', '5173', '--endpoint-url', baseUrl]);
    expect(result.status).toBe(5);

    const body = await waitForTelemetryBody();
    expect(body.command).toBe('test run');
    expect(body.outcome).toBe('error');
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    // Proves the CLI SENDS `local: true` — the stub above accepts anything,
    // so this is not a substitute for the backend DTO change (see the module
    // docstring's SCOPE note); until that ships, a real POST loses this key.
    expect(body.local).toBe(true);
  });

  it('omits the local key for an ordinary (non --local) invocation', async () => {
    // <test-id> + --all is a different, --local-free mutual-exclusion
    // refusal (positional vs. --all) — same exit code, no --local anywhere.
    const result = runCli(['test', 'run', 'some-test-id', '--all', '--endpoint-url', baseUrl]);
    expect(result.status).toBe(5);

    const body = await waitForTelemetryBody();
    expect(body.command).toBe('test run');
    expect(body.outcome).toBe('error');
    expect(body).not.toHaveProperty('local');
  });
});
