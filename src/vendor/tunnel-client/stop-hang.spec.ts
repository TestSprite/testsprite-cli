import net from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { TunnelClient } from './client.js';

interface TestRuntime {
  stopRetryOnDisconnect: boolean;
  task: Promise<void>;
}

interface TestableTunnelClient {
  running: boolean;
  controlWs?: { readyState: number; close: () => void };
  controlLoopTask?: Promise<void>;
  tunnelRuntimes: Map<string, TestRuntime>;
  runControlLoop(): Promise<void>;
  runTunnelLoop(tunnelConnectionId: string, runtime: TestRuntime): Promise<void>;
  connectControl(): Promise<void>;
  connectTunnel(tunnelConnectionId: string, runtime: TestRuntime): Promise<void>;
}

function makeClient(reconnectMs = 750): TunnelClient {
  return new TunnelClient({
    clientId: '11111111-1111-4111-8111-111111111111',
    secret: 'not-a-real-secret',
    controlUrl: 'ws://127.0.0.1:1/control',
    tunnelAddr: '127.0.0.1:1',
    reconnectMs,
    logSink: () => {},
  });
}

async function stopWinner(client: TunnelClient): Promise<'stopped' | 'timer'> {
  const stopPromise = client.stop();
  let timeout!: NodeJS.Timeout;
  const winner = await Promise.race([
    stopPromise.then(() => 'stopped' as const),
    new Promise<'timer'>(resolve => {
      timeout = setTimeout(() => resolve('timer'), 100);
    }),
  ]);
  clearTimeout(timeout);
  // Always settle the client's real teardown so a RED assertion cannot leave
  // a background task or timer behind in the Vitest worker.
  await stopPromise;
  return winner;
}

describe('TunnelClient.stop', () => {
  it('returns while the control handshake is still pending', async () => {
    const client = makeClient();
    const internal = client as unknown as TestableTunnelClient;
    let finishControlLoop!: () => void;
    internal.controlLoopTask = new Promise<void>(resolve => {
      finishControlLoop = resolve;
    });
    const close = vi.fn(() => finishControlLoop());
    // CONNECTING is 0. The fake is only the transport seam; stop() and its
    // ordering are the real TunnelClient implementation.
    internal.controlWs = { readyState: 0, close };

    expect(await stopWinner(client)).toBe('stopped');
    expect(close).toHaveBeenCalledOnce();
  });

  it('cancels a pending control reconnect delay', async () => {
    const client = makeClient();
    const internal = client as unknown as TestableTunnelClient;
    let reportAttempt!: () => void;
    const attempted = new Promise<void>(resolve => {
      reportAttempt = resolve;
    });
    internal.connectControl = async () => {
      reportAttempt();
      throw new Error('control refused');
    };
    internal.running = true;
    internal.controlLoopTask = internal.runControlLoop();

    await attempted;
    expect(await stopWinner(client)).toBe('stopped');
  });

  it('cancels a pending tunnel reconnect delay', async () => {
    const client = makeClient();
    const internal = client as unknown as TestableTunnelClient;
    let reportAttempt!: () => void;
    const attempted = new Promise<void>(resolve => {
      reportAttempt = resolve;
    });
    internal.connectTunnel = async () => {
      reportAttempt();
      throw new Error('tunnel refused');
    };
    internal.running = true;
    const runtime: TestRuntime = {
      stopRetryOnDisconnect: false,
      task: Promise.resolve(),
    };
    runtime.task = internal.runTunnelLoop('22222222-2222-4222-8222-222222222222', runtime);
    internal.tunnelRuntimes.set('22222222-2222-4222-8222-222222222222', runtime);

    await attempted;
    expect(await stopWinner(client)).toBe('stopped');
  });

  it('destroys an outstanding target socket on stop (an idle keep-alive target cannot pin the event loop)', async () => {
    // A target that accepts the connection and then holds it open, sending
    // nothing and never closing — exactly what one of the browser's global
    // keep-alive connections (e.g. accounts.google.com:443, proxied through the
    // tunnel) looks like when a --local run is cancelled or times out mid-flight.
    // proxyStreams()'s copyOneWay(target, ...) parks forever on such a socket, so
    // its finally-cleanup never runs; stop() must destroy the socket directly or
    // the process outlives its own exit by the remote's idle timeout (minutes).
    const held: net.Socket[] = [];
    const stub = net.createServer(socket => {
      held.push(socket);
    });
    await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', () => resolve()));
    const port = (stub.address() as net.AddressInfo).port;

    const client = makeClient();
    const internal = client as unknown as {
      connectTarget(host: string, port: number): Promise<net.Socket>;
    };
    const target = await internal.connectTarget('127.0.0.1', port);
    expect(target.destroyed).toBe(false);

    await client.stop();

    expect(target.destroyed).toBe(true);

    for (const socket of held) {
      socket.destroy();
    }
    await new Promise<void>(resolve => stub.close(() => resolve()));
  });
});
