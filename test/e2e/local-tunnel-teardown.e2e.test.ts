/**
 * Local e2e regression test for the `--local` teardown hang: SIGINT (or a
 * `--timeout` expiry) during a `--local` run printed the correct message,
 * genuinely cancelled the run server-side, and then never exited — the
 * process had to be killed externally.
 *
 * Root cause (see `src/vendor/tunnel-client/ws-compat.ts`'s docstring and its
 * `ws-compat.close-hang.spec.ts`): once the control WebSocket reaches OPEN,
 * undici's own `WebSocket.close()` only sends a Close frame and waits — it
 * never times out, so a control-plane peer that accepts the connection and
 * then goes quiet (accepts the TCP, completes the WS upgrade, then never
 * answers a Close frame) leaves `TunnelClient.stop()` — and the process —
 * hanging forever. This is a DIFFERENT state than the CONNECTING-socket hang
 * an earlier fix already covers, which is why the WS stub below completes a
 * REAL handshake before going quiet, rather than just refusing to open.
 *
 * Copies `test/e2e/signal.e2e.test.ts`'s machinery (spawn the real built
 * binary, real OS signals, a hanging HTTP stub) rather than inventing new
 * harness code, extended to be route-aware (mint / trigger / poll / cancel /
 * delete) and to speak one real WebSocket handshake for the control plane.
 *
 * The two assertions this file exists to make, that a plain "did it exit
 * with the right code" check would miss:
 *
 *   1. The process exits BY ITSELF within a bounded wall-clock — asserted via
 *      `exitSignal === null` (a harness-side `child.kill()` would report a
 *      signal, not `null`; only a process that called `process.exitCode = N`
 *      and drained its own event loop reports a bare numeric code with no
 *      signal). The bug was never a wrong exit code — the message and the
 *      server-side cancel were already correct — it was that the exit never
 *      arrived at all.
 *   2. The server-side teardown calls (`POST .../cancel`, `DELETE
 *      /tunnel/{id}`) actually LANDED before the process exited — a fix that
 *      merely stops waiting on the leaked socket without confirming these
 *      requests got out would trade a visible hang for a silently leaked
 *      live tunnel credential and an uncancelled, still-billing run. Both
 *      calls are issued through `makeDetachedClient` (not composed with the
 *      shutdown signal) specifically so a Ctrl-C does not abort them, and the
 *      grace period this fix adds starts only AFTER they are issued (the
 *      catch block's cancel-POST runs before the outer `finally`'s tunnel
 *      close/delete) — so this file also serves as evidence that ordering
 *      held.
 *
 * Run via: `npm run test:e2e` (builds first). Excluded from `npm test`.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const BIN_PATH = join(REPO_ROOT, 'dist', 'index.js');

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TEST_ID = 'test_local_teardown_e2e_01';
const RUN_ID = 'run_local_teardown_e2e_01';
const CLIENT_ID = '33333333-3333-4333-8333-333333333333';

/** Windows has no POSIX signal delivery — same scoping as signal.e2e.test.ts. */
const isWindows = process.platform === 'win32';

let apiServer: Server;
let baseUrl = '';
let localAppServer: NetServer;
let localAppPort = 0;

/**
 * Server-side sockets accepted for the control WS upgrade. The stub is
 * deliberately uncooperative — it never destroys/ends these itself (that is
 * the whole point of the fixture) — so `afterAll` must track and force-close
 * them, or the suite's own teardown would hang on exactly the same shape of
 * problem this file exists to catch on the CLIENT side. `server.close()` /
 * `closeAllConnections()` cannot be trusted to reach an upgraded socket: once
 * a connection is upgraded, Node's `http.Server` stops tracking it as an
 * ordinary keep-alive connection.
 */
const openControlSockets = new Set<Duplex>();

let wsOpenWaiters: Array<() => void> = [];
let runPollWaiters: Array<() => void> = [];
let cancelReceived = false;
let deleteReceived = false;
/**
 * Records 'cancel' / 'delete' in the order the stub actually received them —
 * the explicit evidence that the grace period (which only ever delays the
 * NEXT step, tunnel teardown) starts AFTER both detached teardown calls are
 * issued, never before. `settleTunnelDetach`'s cancel POST runs inside the
 * catch block, strictly before the outer `finally`'s `tunnelSession.close()`
 * (which issues the DELETE) even begins — this array is what proves that
 * ordering held for the actual spawned process, not just for the source
 * read.
 */
const landingOrder: string[] = [];

/**
 * How long the stub sits on the tunnel DELETE before answering. Zero for every
 * test except the one that asserts the credential delete is not raced by the
 * close grace period — see that test for why an eventual `landingOrder` of
 * `['cancel', 'delete']` does not prove it on its own.
 */
let deleteDelayMs = 0;
/** Responses the stub is intentionally holding; see the `'close'` guard below. */
const delayedResponses = new Set<ServerResponse>();
/** `Date.now()` when the stub finished writing the DELETE response. */
let deleteRespondedAt = 0;

function nextWsOpen(): Promise<void> {
  return new Promise(resolve => wsOpenWaiters.push(resolve));
}
function nextRunPoll(): Promise<void> {
  return new Promise(resolve => runPollWaiters.push(resolve));
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

beforeAll(async () => {
  if (isWindows) return;
  if (!existsSync(BIN_PATH)) {
    throw new Error('dist/index.js not found — run `npm run test:e2e` which builds first.');
  }

  // The "app under test" for --local's port-liveness preflight — just needs
  // to accept a raw connect; --local never actually routes browser traffic
  // through this because our stub tunnel control plane never sends
  // RequestTunnel.
  localAppServer = createNetServer(socket => socket.destroy());
  await new Promise<void>(r => localAppServer.listen(0, '127.0.0.1', () => r()));
  const localAddress = localAppServer.address();
  if (localAddress === null || typeof localAddress === 'string') throw new Error('no address');
  localAppPort = localAddress.port;

  apiServer = createServer((req, res) => {
    // `'close'` on the REQUEST fires once the request is fully received — for
    // a body-less DELETE that is immediately — NOT when the client goes away.
    // So an unguarded destroy here kills any response the stub is deliberately
    // holding, and `writableEnded` does not save it either, because the whole
    // point of a delayed answer is that it has not ended yet. Left unguarded it
    // silently turned the slow-delete test below into a "could not delete the
    // tunnel credential (fetch failed)" advisory — a fake failure wearing the
    // exact costume of the real bug that test exists to detect.
    req.on('close', () => {
      if (res.writableEnded) return;
      if (delayedResponses.has(res)) return;
      res.destroy();
    });
    req.resume();

    const method = req.method ?? '';
    // Strip the query string — the poll route arrives as
    // `/runs/{id}?waitSeconds=N`, and route matching below is path-only.
    const url = (req.url ?? '').split('?')[0] ?? '';

    if (method === 'POST' && url === '/api/cli/v1/tunnel') {
      respondJson(res, 200, {
        clientId: CLIENT_ID,
        secret: 'e2e-test-secret',
        controlUrl: `ws://127.0.0.1:${(apiServer.address() as { port: number }).port}/control`,
        tunnelAddr: '127.0.0.1:1', // never dialed — the stub never sends RequestTunnel
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      return;
    }

    if (method === 'POST' && url === `/api/cli/v1/tests/${TEST_ID}/runs`) {
      respondJson(res, 202, {
        runId: RUN_ID,
        status: 'queued',
        enqueuedAt: new Date().toISOString(),
        codeVersion: 'v1',
        targetUrl: `http://127.0.0.1:${localAppPort}`,
      });
      return;
    }

    if (method === 'GET' && url === `/api/cli/v1/runs/${RUN_ID}`) {
      // Hang forever — same long-poll-stall simulation as signal.e2e.test.ts.
      // The CLI's own abort (on SIGINT) or --timeout is what must cut this.
      runPollWaiters.splice(0).forEach(fn => fn());
      return;
    }

    if (method === 'POST' && url === `/api/cli/v1/runs/${RUN_ID}/cancel`) {
      cancelReceived = true;
      landingOrder.push('cancel');
      respondJson(res, 200, { runId: RUN_ID, status: 'cancelled' });
      return;
    }

    if (method === 'DELETE' && url === `/api/cli/v1/tunnel/${CLIENT_ID}`) {
      deleteReceived = true;
      landingOrder.push('delete');
      const answer = (): void => {
        delayedResponses.delete(res);
        res.writeHead(204);
        res.end();
        deleteRespondedAt = Date.now();
      };
      if (deleteDelayMs > 0) {
        delayedResponses.add(res);
        setTimeout(answer, deleteDelayMs).unref();
      } else answer();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  apiServer.on('upgrade', (req, socket) => {
    if (!(req.url ?? '').startsWith('/control')) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'] as string;
    const accept = createHash('sha1')
      .update(key + WS_MAGIC)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // Acknowledge authentication, exactly once, the way the real control
    // plane does: it answers the client's `Auth` frame with `{"type":"Ack"}`,
    // and `TunnelClient.start()` waits for that rather than for socket open
    // (DEV-1007). A stub that stayed silent from the very first byte would no
    // longer get past startup, and this suite would be exercising a startup
    // timeout instead of the thing it is about.
    //
    // One unmasked text frame, hand-built because this stub speaks the
    // handshake itself rather than pulling in a WebSocket library: 0x81 =
    // FIN + text opcode, then the payload length (< 126, so a single byte).
    const ack = Buffer.from('{"type":"Ack"}');
    socket.write(Buffer.concat([Buffer.from([0x81, ack.length]), ack]));

    // From here the real bug's shape: go completely quiet — never answer a
    // Close frame, never destroy/end this socket. This is what the
    // ws-compat.ts fix's grace-timeout + unref exists for. The Ack above is
    // orthogonal: it gets the client to "started", and the hang under test is
    // what happens at CLOSE. Tracked in openControlSockets so the suite's OWN
    // teardown doesn't hang on it — see that Set's docstring.
    openControlSockets.add(socket);
    socket.on('close', () => openControlSockets.delete(socket));
    socket.on('data', () => {});
    wsOpenWaiters.splice(0).forEach(fn => fn());
  });

  await new Promise<void>(r => apiServer.listen(0, '127.0.0.1', () => r()));
  const address = apiServer.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (localAppServer) await new Promise<void>(r => localAppServer.close(() => r()));
  // Force-close the uncooperative-peer sockets ourselves first — see
  // openControlSockets' docstring for why closeAllConnections() cannot be
  // trusted to reach them.
  for (const socket of openControlSockets) socket.destroy();
  openControlSockets.clear();
  if (apiServer) {
    await new Promise<void>(r => {
      apiServer.close(() => r());
      apiServer.closeAllConnections();
    });
  }
});

beforeEach(() => {
  wsOpenWaiters = [];
  runPollWaiters = [];
  cancelReceived = false;
  deleteReceived = false;
  landingOrder.length = 0;
  deleteDelayMs = 0;
  deleteRespondedAt = 0;
});

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

function spawnLocalRun(extraArgs: string[]): {
  child: ReturnType<typeof spawn>;
  result: Promise<SpawnResult>;
  stdout: () => string;
  stderr: () => string;
} {
  const child = spawn(
    process.execPath,
    [BIN_PATH, 'test', 'run', TEST_ID, '--local', String(localAppPort), ...extraArgs],
    {
      env: {
        ...process.env,
        TESTSPRITE_API_KEY: 'sk-user-e2e-local-teardown',
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

  const startedAt = Date.now();
  const result = new Promise<SpawnResult>(resolveExit => {
    child.on('exit', (code, signal) => {
      resolveExit({ code, signal, stdout, stderr, elapsedMs: Date.now() - startedAt });
    });
  });
  return { child, result, stdout: () => stdout, stderr: () => stderr };
}

describe.skipIf(isWindows)('local-tunnel teardown e2e — the process must exit on its own', () => {
  it('SIGINT during a --local run: exits naturally (no signal, code 130) after the cancel + tunnel-delete land', async () => {
    const { child, result } = spawnLocalRun(['--timeout', '120']);

    // Wait for the EXACT shape of the original bug: the control socket is
    // OPEN (handshake complete) AND the run poll is in flight — not merely
    // "the process started".
    await nextWsOpen();
    await nextRunPoll();
    child.kill('SIGINT');

    const outcome = await result;

    // The bug was never a wrong code — it was that the exit never arrived.
    // `signal === null` is what proves natural termination: a harness-side
    // kill would report a signal here, not a bare exit code.
    expect(outcome.signal).toBeNull();
    expect(outcome.code).toBe(130);

    // Both detached teardown calls must have landed — the process exiting
    // promptly is worthless (worse: silently worse) if the credential
    // delete or the run cancel got cut off along with the leaked socket.
    expect(cancelReceived).toBe(true);
    expect(deleteReceived).toBe(true);
    // Ordering: the cancel POST (issued from the catch block) must land
    // strictly before the tunnel DELETE (issued from the outer `finally`,
    // after the close-hang grace period) — proof the grace period this fix
    // adds starts AFTER teardown is issued, never before it.
    expect(landingOrder).toEqual(['cancel', 'delete']);

    // Bounded wall-clock: grace window (1200ms) + scheduling slack, well
    // short of anything a human would perceive as "hung".
    expect(outcome.elapsedMs).toBeLessThan(5_000);

    // The existing, already-correct UX must be unchanged by this fix. A
    // --local run's interrupt message is the TUNNEL-specific one (no
    // "keeps running/billing" claim, no `test wait` hint — re-attaching
    // cannot revive a closed tunnel) rather than the ordinary non-tunnel
    // detach message.
    expect(outcome.stderr).toContain('Interrupted by SIGINT');
    // The interrupt message states the observed outcome, not a promise about
    // credits: the run was cancelled with this exit code and its verdict is
    // discarded.
    expect(outcome.stderr).toMatch(/so it was cancelled \(exit 130\)/);
    expect(outcome.stderr).toContain("a cancelled run's verdict is discarded");
    expect(outcome.stderr).not.toMatch(/guaranteed failure|no further credits/i);
    expect(outcome.stderr).not.toContain('keeps running (and billing)');
    expect(outcome.stderr).not.toContain('testsprite test wait');
  }, 15_000);

  // `landingOrder` proves the two teardown calls were RECEIVED in order — the
  // stub pushes each name the instant the request arrives. It says nothing
  // about whether the credential delete had actually COMPLETED before the
  // close grace period expired and the socket was released. Those are
  // different claims, and only the second one is about leaking a live
  // credential, which this PR itself argues is strictly worse than the hang it
  // replaces. So: hold the DELETE response well past both CLOSE_GRACE_MS
  // (1200ms) and TUNNEL_CLIENT_STOP_TIMEOUT_MS (2000ms), and assert the
  // process outlived it.
  it('waits for the credential DELETE to be answered even when it takes longer than the close grace period', async () => {
    deleteDelayMs = 3_500;
    const { child, result } = spawnLocalRun(['--timeout', '120']);

    await nextWsOpen();
    await nextRunPoll();
    child.kill('SIGINT');

    const outcome = await result;
    const exitObservedAt = Date.now();

    expect(outcome.signal).toBeNull();
    expect(outcome.code).toBe(130);
    expect(deleteReceived).toBe(true);

    // The load-bearing assertion: the stub answered, and the process was still
    // alive to hear it. A grace-timer release that let the process exit early
    // would land here as `deleteRespondedAt === 0` (never answered) or as an
    // exit timestamp before it.
    expect(deleteRespondedAt).toBeGreaterThan(0);
    expect(exitObservedAt).toBeGreaterThanOrEqual(deleteRespondedAt);
    expect(outcome.elapsedMs).toBeGreaterThan(deleteDelayMs);

    // ...and it must not have given up on the credential instead of waiting.
    // That advisory is what a real abandonment looks like, and it is exactly
    // what an unguarded `req.on('close', () => res.destroy())` in the stub
    // above fakes, so it is worth asserting rather than assuming.
    expect(outcome.stderr).not.toContain('could not delete the tunnel credential');
  }, 20_000);

  it('--timeout expiry during a --local run: exits naturally (no signal, code 7) after the cancel + tunnel-delete land', async () => {
    const { result } = spawnLocalRun(['--timeout', '1']);

    // No signal sent here — --timeout 1 elapsing while the run poll hangs
    // forever is what ends this one.
    const outcome = await result;

    expect(outcome.signal).toBeNull();
    expect(outcome.code).toBe(7);

    expect(cancelReceived).toBe(true);
    expect(deleteReceived).toBe(true);
    expect(landingOrder).toEqual(['cancel', 'delete']);

    // --timeout 1 itself accounts for ~1s; bound generously above that.
    expect(outcome.elapsedMs).toBeLessThan(6_000);

    expect(outcome.stderr).not.toContain('keeps running (and billing)');
    expect(outcome.stderr).not.toContain('testsprite test wait');
  }, 15_000);
});
