import dns from 'node:dns';
import { getEventListeners, type EventEmitter } from 'node:events';
import net, { Socket } from 'node:net';
import { PassThrough, type Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlockedTargetError, TunnelClient } from './client.js';
import { encodeFrame } from './protocol.js';
import { ErrCode, type TunnelClientOptions } from './types.js';

const control = vi.hoisted(() => ({ sockets: [] as ControlSocket[] }));

interface ControlSocket extends EventEmitter {
  url: URL;
  readyState: number;
  sent: string[];
  close(): void;
}

vi.mock('./ws-compat.js', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('node:events');
  return {
    default: class extends NodeEventEmitter {
      static CONNECTING = 0;
      static OPEN = 1;
      readyState = 0;
      sent: string[] = [];
      constructor(readonly url: URL) {
        super();
        control.sockets.push(this);
      }
      send(message: string) {
        this.sent.push(message);
      }
      close() {
        if (this.readyState === 3) return;
        const connecting = this.readyState === 0;
        this.readyState = 3;
        queueMicrotask(() => {
          if (connecting) this.emit('error', new Error('control upgrade aborted'));
          this.emit('close', 1000, Buffer.alloc(0));
        });
      }
    },
  };
});

type Targets = {
  connectTarget(host: string, port: number): Promise<Socket>;
  handleIncomingStream(stream: Duplex): Promise<void>;
};

const clients: TunnelClient[] = [];
const sockets: Socket[] = [];

beforeEach(() =>
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  }),
);
afterEach(async () => {
  for (const client of clients) await client.stop();
  for (const socket of sockets) socket.destroy();
  clients.length = 0;
  sockets.length = 0;
  control.sockets.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function makeClient(options: Partial<TunnelClientOptions> = {}) {
  const client = new TunnelClient({
    clientId: 'test-client',
    secret: 'test-secret',
    controlUrl: 'ws://control.invalid/ws?existing=1',
    tunnelAddr: 'tunnel.invalid:7400',
    reconnectMs: 30_000,
    logSink: () => {},
    ...options,
  });
  clients.push(client);
  return client;
}

function targets(client: TunnelClient): Targets {
  return client as unknown as Targets;
}

async function flush() {
  await new Promise<void>(resolve => setImmediate(resolve));
}

function observe<T>(promise: Promise<T>) {
  const result: { status: 'pending' | 'resolved' | 'rejected'; error?: unknown; value?: T } = {
    status: 'pending',
  };
  const done = promise.then(
    value => {
      result.status = 'resolved';
      result.value = value;
    },
    error => {
      result.status = 'rejected';
      result.error = error;
    },
  );
  return { result, done };
}

async function openClient(client: TunnelClient) {
  const started = client.start();
  const ws = control.sockets.at(-1)!;
  ws.readyState = 1;
  ws.emit('open');
  ws.emit('message', Buffer.from('{"type":"Ack"}'));
  await started;
  return ws;
}

function mockTargets(connect = true) {
  return vi.spyOn(net, 'connect').mockImplementation((() => {
    const socket = new Socket();
    sockets.push(socket);
    if (connect) queueMicrotask(() => socket.emit('connect'));
    return socket;
  }) as typeof net.connect);
}

async function teardown(client: TunnelClient, ws: ControlSocket, kind: string) {
  if (kind === 'stop') await client.stop();
  else if (kind === 'control disconnect') ws.emit('close', 1000, Buffer.alloc(0));
  else ws.emit('message', Buffer.from('{"type":"CloseTunnel","payload":{"reason":"finished"}}'));
}

// Ported from upstream client.lifecycle.test.ts; only the WebSocket and dial
// boundaries are replaced. The lifecycle, DNS guard and cancellation run here.
describe('TunnelClient upstream lifecycle', () => {
  it('never advertises client-unknown on the initial control URL or a reconnect', async () => {
    const client = makeClient();
    const first = await openClient(client);
    first.emit('close', 1000, Buffer.alloc(0));
    await flush();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(control.sockets).toHaveLength(2);
    for (const socket of control.sockets) {
      expect(socket.url.searchParams.get('client_id')).toBe('test-client');
      expect(socket.url.searchParams.get('existing')).toBe('1');
      expect(socket.url.searchParams.has('capabilities')).toBe(false);
    }
  });

  it('stops a pending control upgrade without reporting a spurious disconnect', async () => {
    const errors: Array<{ code: string; message: string }> = [];
    const client = makeClient({ onError: error => errors.push(error) });
    const started = observe(client.start());
    await client.stop();
    await started.done;
    expect(started.result.status).toBe('rejected');
    expect(errors).toEqual([]);
  });

  it.each(['stop', 'control disconnect', 'CloseTunnel'])(
    'destroys idle target sockets on %s',
    async kind => {
      const client = makeClient();
      const ws = await openClient(client);
      mockTargets();
      const socket = await targets(client).connectTarget('127.0.0.1', 8080);
      await teardown(client, ws, kind);
      expect(socket.destroyed).toBe(true);
    },
  );

  it.each(['stop', 'control disconnect', 'CloseTunnel'])(
    'prevents a late DNS answer from dialing after %s',
    async kind => {
      const client = makeClient();
      const ws = await openClient(client);
      mockTargets();
      let resolveDns!: (addresses: dns.LookupAddress[]) => void;
      vi.spyOn(dns.promises, 'lookup').mockImplementation(
        (() =>
          new Promise<dns.LookupAddress[]>(
            resolve => (resolveDns = resolve),
          )) as unknown as typeof dns.promises.lookup,
      );
      const dial = observe(targets(client).connectTarget('target.invalid', 8080));
      await teardown(client, ws, kind);
      resolveDns([{ address: '127.0.0.1', family: 4 }]);
      await flush();
      expect(sockets).toHaveLength(0);
      expect(dial.result.status).toBe('rejected');
    },
  );

  it('rejects a DNS wait on stop even when the resolver never finishes', async () => {
    const client = makeClient();
    await openClient(client);
    mockTargets();
    vi.spyOn(dns.promises, 'lookup').mockImplementation(
      (() => new Promise<dns.LookupAddress[]>(() => {})) as unknown as typeof dns.promises.lookup,
    );
    const dial = observe(targets(client).connectTarget('target.invalid', 8080));
    await client.stop();
    await flush();
    expect(dial.result.status).toBe('rejected');
    expect(sockets).toHaveLength(0);
  });

  it.each([
    ['stop', 'DNS lookup'],
    ['stop', 'target dial'],
    ['control disconnect', 'DNS lookup'],
    ['control disconnect', 'target dial'],
    ['CloseTunnel', 'DNS lookup'],
    ['CloseTunnel', 'target dial'],
  ])('does not report a stream error when %s interrupts a pending %s', async (kind, phase) => {
    const onError = vi.fn();
    const client = makeClient({ onError });
    const ws = await openClient(client);
    mockTargets(false);
    const lookup = vi
      .spyOn(dns.promises, 'lookup')
      .mockImplementation((() =>
        phase === 'DNS lookup'
          ? new Promise<dns.LookupAddress[]>(() => {})
          : Promise.resolve([
              { address: '127.0.0.1', family: 4 },
            ])) as unknown as typeof dns.promises.lookup);
    const stream = new PassThrough();
    try {
      const handled = targets(client).handleIncomingStream(stream);
      stream.write(
        encodeFrame({
          request_id: 'request-1',
          inbound_request_id: 'inbound-1',
          tunnel_connection_id: 'tunnel-1',
          mux_stream_id: 1,
          target_host: 'target.invalid',
          target_port: 8080,
        }),
      );
      await flush();
      expect(lookup).toHaveBeenCalledWith('target.invalid', { all: true });
      expect(sockets).toHaveLength(phase === 'DNS lookup' ? 0 : 1);
      await teardown(client, ws, kind);
      await handled;
      expect(onError).not.toHaveBeenCalled();
      if (phase === 'target dial') expect(sockets[0]!.destroyed).toBe(true);
    } finally {
      stream.destroy();
    }
  });

  it('reports a genuine stream failure while running', async () => {
    const onError = vi.fn();
    const client = makeClient({ onError });
    await openClient(client);
    const stream = new PassThrough();
    try {
      const handled = targets(client).handleIncomingStream(stream);
      stream.write(encodeFrame({ invalid: 'stream header' }));
      await handled;
      expect(onError).toHaveBeenCalledExactlyOnceWith({
        code: ErrCode.StreamFailed,
        message: 'Failed handling tunnel stream: Invalid frame payload',
      });
      expect(stream.destroyed).toBe(true);
    } finally {
      stream.destroy();
    }
  });

  it.each(['pending', 'failed'])(
    'prevents candidate fallback when stop interrupts a %s target dial',
    async phase => {
      const client = makeClient();
      await openClient(client);
      mockTargets(false);
      vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [
        { address: '127.0.0.1', family: 4 },
        { address: '::1', family: 6 },
      ]) as unknown as typeof dns.promises.lookup);
      const dial = observe(targets(client).connectTarget('target.invalid', 8080));
      await flush();
      expect(sockets).toHaveLength(1);
      if (phase === 'failed') sockets[0]!.emit('error', new Error('first candidate refused'));
      await client.stop();
      await flush();
      expect(sockets[0]!.destroyed).toBe(true);
      expect(dial.result.status).toBe('rejected');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sockets).toHaveLength(1);
    },
  );

  it('cannot dial an old stream whose header arrives after stop and restart', async () => {
    const onError = vi.fn();
    const client = makeClient({ onError });
    await openClient(client);
    mockTargets();
    const stream = new PassThrough();
    const handled = observe(targets(client).handleIncomingStream(stream));
    try {
      await client.stop();
      await openClient(client);
      stream.write(
        encodeFrame({
          request_id: 'request-1',
          inbound_request_id: 'inbound-1',
          tunnel_connection_id: 'tunnel-1',
          mux_stream_id: 1,
          target_host: '127.0.0.1',
          target_port: 8080,
        }),
      );
      await flush();
      expect(sockets).toHaveLength(0);
      expect(handled.result.status).toBe('resolved');
      expect(onError).not.toHaveBeenCalled();
    } finally {
      stream.destroy();
    }
  });

  it.each(['connect', 'abort'])('releases composed signal listeners after %s', async finish => {
    const client = makeClient();
    mockTargets(finish === 'connect');
    const controllers = client as unknown as {
      lifecycleController: AbortController;
      targetDialController: AbortController;
    };
    const dial = observe(targets(client).connectTarget('127.0.0.1', 8080));
    await flush();
    if (finish === 'abort') {
      const reason = new Error('target session ended');
      controllers.targetDialController.abort(reason);
      await dial.done;
      expect(dial.result.error).toBe(reason);
    } else expect(dial.result.status).toBe('resolved');
    for (const controller of [controllers.lifecycleController, controllers.targetDialController]) {
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
  });

  it('refuses a mixed DNS answer containing embedded IPv4 before any target dial', async () => {
    const client = makeClient();
    mockTargets();
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '64:ff9b:ffff::a9fe:a9fe', family: 6 },
    ]) as unknown as typeof dns.promises.lookup);
    await expect(targets(client).connectTarget('mixed.invalid', 443)).rejects.toBeInstanceOf(
      BlockedTargetError,
    );
    expect(sockets).toHaveLength(0);
  });

  it('keeps AUTH_FAILED terminal without unknown-client retries', async () => {
    const errors: Array<{ code: string; message: string }> = [];
    const client = makeClient({ onError: error => errors.push(error) });
    const ws = await openClient(client);
    ws.emit('close', 1008, Buffer.from('AUTH_FAILED'));
    await flush();
    expect(errors).toEqual([
      { code: ErrCode.AuthFailed, message: 'tunnel connection superseded or credential revoked' },
    ]);
    await vi.advanceTimersByTimeAsync(150_000);
    expect(control.sockets).toHaveLength(1);
  });

  it('rejects start once on AUTH_FAILED before the first Ack without reconnecting', async () => {
    const onError = vi.fn();
    const client = makeClient({ onError });
    const started = observe(client.start());
    const ws = control.sockets[0]!;
    ws.readyState = 1;
    ws.emit('open');
    ws.emit('close', 1008, Buffer.from('AUTH_FAILED'));
    await started.done;
    await flush();

    expect(started.result.status).toBe('rejected');
    expect(started.result.error).toEqual(
      new Error(
        'Control websocket closed before authentication was acknowledged (code=1008, reason=AUTH_FAILED)',
      ),
    );
    expect(onError).toHaveBeenCalledExactlyOnceWith({
      code: ErrCode.AuthFailed,
      message:
        'Control authentication failed, stop reconnecting: control auth failure (code=1008, reason=AUTH_FAILED)',
    });
    await vi.advanceTimersByTimeAsync(150_000);
    expect(control.sockets).toHaveLength(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
