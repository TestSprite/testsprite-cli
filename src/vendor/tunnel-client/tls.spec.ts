import { generate } from 'selfsigned';
import type { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net, { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import tls, { type TLSSocket } from 'node:tls';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TunnelClient } from './client.js';
import { ErrCode, type TunnelHelloFrame } from './types.js';

const control = vi.hoisted(() => ({
  sockets: [] as Array<EventEmitter & { readyState: number }>,
}));

// Keep the control protocol real and replace only its external transport. The
// tests inject Ack/RequestTunnel at the same WebSocket event seam used by the
// server, while the data-plane sockets below still run Node's real TLS stack.
vi.mock('./ws-compat.js', async () => {
  const { EventEmitter: NodeEventEmitter } = await import('node:events');
  return {
    default: class extends NodeEventEmitter {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 0;

      constructor() {
        super();
        control.sockets.push(this);
      }

      send() {}

      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.emit('close', 1000, Buffer.alloc(0));
      }
    },
  };
});

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'data-plane-secret-must-never-cross-plaintext';
const TUNNEL_CONNECTION_ID = '22222222-2222-4222-8222-222222222222';

let certificate: Awaited<ReturnType<typeof generate>>;

beforeAll(async () => {
  certificate = await generate([{ name: 'commonName', value: 'localhost' }], {
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
    extensions: [
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: 'localhost' },
          { type: 7, ip: '127.0.0.1' },
        ],
      },
    ],
  });
});

afterEach(() => {
  control.sockets.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface MemoryConnection {
  client: Socket;
  server: Socket;
  tlsSocket?: TLSSocket;
  tlsWritesBeforeSecure: Buffer[];
  destroy(): void;
}

class MemorySocket extends Duplex {
  peer?: MemorySocket;

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.peer?.destroyed === false) this.peer.push(Buffer.from(chunk));
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.peer?.destroyed === false) this.peer.push(null);
    callback();
  }

  override _destroy(_error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.peer?.destroyed === false) this.peer.push(null);
    callback();
  }
}

function createMemoryConnection(): MemoryConnection {
  const client = new MemorySocket();
  const server = new MemorySocket();
  client.peer = server;
  server.peer = client;

  for (const socket of [client, server]) {
    Object.assign(socket, {
      setKeepAlive: () => socket,
      setNoDelay: () => socket,
      ref: () => socket,
      unref: () => socket,
    });
    socket.on('error', () => {});
  }

  return {
    client: client as unknown as Socket,
    server: server as unknown as Socket,
    tlsWritesBeforeSecure: [],
    destroy: () => {
      client.destroy();
      server.destroy();
    },
  };
}

function mockNetConnections(
  connections: Set<MemoryConnection>,
  accept: (socket: Socket, connection: MemoryConnection) => void,
) {
  return vi.spyOn(net, 'connect').mockImplementation(((..._args: unknown[]) => {
    const connection = createMemoryConnection();
    connections.add(connection);
    accept(connection.server, connection);
    queueMicrotask(() => connection.client.emit('connect'));
    return connection.client;
  }) as typeof net.connect);
}

function mockTlsConnections(
  connections: Set<MemoryConnection>,
  accept: (socket: Socket, connection: MemoryConnection) => void,
) {
  const realConnect = tls.connect.bind(tls);
  return vi.spyOn(tls, 'connect').mockImplementation(((options: tls.ConnectionOptions) => {
    const connection = createMemoryConnection();
    connections.add(connection);
    accept(connection.server, connection);
    const socket = realConnect({ ...options, socket: connection.client });
    connection.tlsSocket = socket;
    let secure = false;
    socket.once('secureConnect', () => {
      secure = true;
    });
    const originalWrite = socket.write;
    socket.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      if (!secure) connection.tlsWritesBeforeSecure.push(Buffer.from(chunk));
      return Reflect.apply(originalWrite, socket, [chunk, ...args]) as boolean;
    }) as typeof socket.write;
    socket.once('close', () => connection.destroy());
    // `socket:` bypasses an OS TCP dial in this sandbox. Re-emit the
    // underlying transport event so a mutation that listens to `connect`
    // instead of `secureConnect` remains observable.
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  }) as typeof tls.connect);
}

function destroyConnections(connections: Set<MemoryConnection>): void {
  for (const connection of connections) connection.destroy();
  connections.clear();
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before the test deadline');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function readHello(socket: Socket | TLSSocket): Promise<TunnelHelloFrame> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const length = buffered.readUInt32BE(0);
      if (buffered.length < 4 + length) return;
      resolve(JSON.parse(buffered.subarray(4, 4 + length).toString('utf8')) as TunnelHelloFrame);
    });
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('socket closed before TunnelHello')));
  });
}

async function startClient(
  options: Partial<ConstructorParameters<typeof TunnelClient>[0]>,
): Promise<{ client: TunnelClient; controlSocket: EventEmitter }> {
  const client = new TunnelClient({
    clientId: CLIENT_ID,
    secret: SECRET,
    controlUrl: 'ws://control.test/ws',
    tunnelAddr: '127.0.0.1:1',
    heartbeatMs: 60_000,
    reconnectMs: 10,
    logSink: () => {},
    ...options,
  });
  const started = client.start();
  const controlSocket = control.sockets[0]!;
  controlSocket.readyState = 1;
  controlSocket.emit('open');
  controlSocket.emit('message', Buffer.from('{"type":"Ack"}'));
  await started;
  return { client, controlSocket };
}

function requestTunnel(controlSocket: EventEmitter): void {
  controlSocket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'RequestTunnel',
        payload: {
          tunnel_connection_id: TUNNEL_CONNECTION_ID,
          target_host: '127.0.0.1',
          target_port: 8080,
        },
      }),
    ),
  );
}

function createPendingSocket(): Socket {
  const socket = new net.Socket();
  socket.on('error', () => {});
  return socket;
}

async function flushAsyncEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('TunnelClient TLS data plane', () => {
  it('keeps the TLS dial immutable after JavaScript transport and transportMode assignments', async () => {
    const connections = new Set<MemoryConnection>();
    const server = tls.createServer(
      { key: certificate.private, cert: certificate.cert },
      socket => void readHello(socket).catch(() => {}),
    );
    server.on('tlsClientError', () => {});
    const netConnect = mockNetConnections(connections, socket => {
      server.emit('connection', socket);
    });
    const tlsConnect = mockTlsConnections(connections, socket => {
      server.emit('connection', socket);
    });
    const { client, controlSocket } = await startClient({
      tunnelTlsAddr: 'localhost:443',
      tunnelTlsCa: certificate.cert,
    });

    try {
      for (const property of ['transport', 'transportMode'] as const) {
        try {
          (client as unknown as Record<string, unknown>)[property] = 'plaintext';
        } catch (error) {
          expect(error).toBeInstanceOf(TypeError);
        }
      }
      expect(client.transport).toBe('tls');

      requestTunnel(controlSocket);
      await waitUntil(() => tlsConnect.mock.calls.length + netConnect.mock.calls.length > 0);
      expect(tlsConnect).toHaveBeenCalledOnce();
      expect(netConnect).not.toHaveBeenCalled();
    } finally {
      await client.stop();
      destroyConnections(connections);
    }
  });

  it('waits for an authenticated TLS connection before sending the exact TunnelHello', async () => {
    const connections = new Set<MemoryConnection>();
    let resolveHello!: (hello: TunnelHelloFrame) => void;
    const helloReceived = new Promise<TunnelHelloFrame>(resolve => {
      resolveHello = resolve;
    });
    const server = tls.createServer(
      { key: certificate.private, cert: certificate.cert },
      socket => void readHello(socket).then(resolveHello, () => {}),
    );
    server.on('tlsClientError', () => {});
    const port = 443;
    const netConnect = mockNetConnections(connections, socket => {
      server.emit('connection', socket);
    });
    const tlsConnect = mockTlsConnections(connections, socket => {
      server.emit('connection', socket);
    });
    const { client, controlSocket } = await startClient({
      tunnelTlsAddr: `localhost:${port}`,
      tunnelTlsCa: certificate.cert,
    });

    try {
      expect(client.transport).toBe('tls');
      requestTunnel(controlSocket);

      await expect(helloReceived).resolves.toEqual({
        client_id: CLIENT_ID,
        secret: SECRET,
        tunnel_connection_id: TUNNEL_CONNECTION_ID,
      });
      expect(netConnect).toHaveBeenCalledTimes(0);
      const connectOptions = tlsConnect.mock.calls[0]![0] as tls.ConnectionOptions;
      expect(connectOptions).toMatchObject({
        host: 'localhost',
        port,
        servername: 'localhost',
        minVersion: 'TLSv1.2',
      });
      // Extra roots ride on Node's default store (which, unlike tls.rootCertificates,
      // honours NODE_EXTRA_CA_CERTS), so the list must end with the extra root and
      // be a strict superset of the bundled roots.
      const ca = connectOptions.ca as Array<string | Buffer>;
      expect(ca.at(-1)).toBe(certificate.cert);
      expect(ca.length).toBeGreaterThan(tls.rootCertificates.length);
      for (const root of tls.rootCertificates) expect(ca).toContain(root);
    } finally {
      await client.stop();
      destroyConnections(connections);
    }
  });

  it('never falls back to plaintext when every TLS handshake fails', async () => {
    const connections = new Set<MemoryConnection>();
    const attempts: Array<{ bytes: Buffer; closed: boolean }> = [];
    const accept = (socket: Socket, connection: MemoryConnection): void => {
      const attempt = { bytes: Buffer.alloc(0), closed: false };
      attempts.push(attempt);
      socket.on('data', chunk => {
        attempt.bytes = Buffer.concat([attempt.bytes, chunk]);
      });
      socket.once('close', () => {
        attempt.closed = true;
      });
      setTimeout(() => {
        if (connection.tlsSocket) {
          connection.tlsSocket.destroy(new Error('plain sentinel rejected TLS handshake'));
        } else {
          connection.destroy();
        }
      }, 30);
    };
    const port = 443;
    const netConnect = mockNetConnections(connections, accept);
    mockTlsConnections(connections, accept);
    const { client, controlSocket } = await startClient({
      tunnelTlsAddr: `127.0.0.1:${port}`,
      tunnelTlsServername: 'localhost',
      tunnelTlsCa: certificate.cert,
    });

    try {
      requestTunnel(controlSocket);
      await waitUntil(() => attempts.filter(attempt => attempt.closed).length >= 3);
      const completed = attempts.filter(attempt => attempt.closed);
      expect(completed.length).toBeGreaterThanOrEqual(3);
      expect(
        [...connections]
          .flatMap(connection => connection.tlsWritesBeforeSecure)
          .some(bytes => bytes.includes(Buffer.from('client_id'))),
      ).toBe(false);
      expect(completed.map(attempt => attempt.bytes.subarray(0, 2).toString('hex'))).toEqual(
        completed.map(() => '1603'),
      );
      expect(completed.map(attempt => attempt.bytes.includes(Buffer.from('client_id')))).toEqual(
        completed.map(() => false),
      );
      expect(netConnect).toHaveBeenCalledTimes(0);
    } finally {
      await client.stop();
      destroyConnections(connections);
    }
  });

  it('stops after the bounded TLS retry window without a plaintext downgrade', async () => {
    const connections = new Set<MemoryConnection>();
    let attempts = 0;
    const errors: Array<{ code: ErrCode; message: string }> = [];
    const accept = (_socket: Socket, connection: MemoryConnection): void => {
      attempts += 1;
      setTimeout(() => {
        connection.tlsSocket?.destroy(new Error(`certificate rejected for ${SECRET}`));
      }, 15);
    };
    const netConnect = mockNetConnections(connections, accept);
    mockTlsConnections(connections, accept);
    const { client, controlSocket } = await startClient({
      tunnelTlsAddr: '127.0.0.1:443',
      tunnelTlsServername: 'localhost',
      tunnelTlsCa: certificate.cert,
      dataPlaneRetryDeadlineMs: 60,
      reconnectMs: 10,
      onError: error => errors.push(error),
    });

    try {
      requestTunnel(controlSocket);
      await waitUntil(() => errors.some(error => error.code === ErrCode.DataPlaneUnreachable));
      const terminalErrors = errors.filter(error => error.code === ErrCode.DataPlaneUnreachable);
      expect(attempts).toBeGreaterThanOrEqual(3);
      expect(terminalErrors).toHaveLength(1);
      expect(terminalErrors[0]?.message).toBe(
        'Data plane tls at 127.0.0.1:443 is unreachable after 60ms: ' +
          'certificate rejected for [REDACTED]',
      );
      expect(terminalErrors[0]?.message).not.toContain(SECRET);
      expect(netConnect).not.toHaveBeenCalled();

      const attemptsAtFailure = attempts;
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(attempts).toBe(attemptsAtFailure);
    } finally {
      await client.stop();
      destroyConnections(connections);
    }
  });

  it('treats repeated closes after TunnelHello as one failed episode and stops at the deadline', async () => {
    vi.useFakeTimers();
    const connections = new Set<MemoryConnection>();
    const errors: Array<{ code: ErrCode; message: string }> = [];
    let attempts = 0;
    const netConnect = vi.spyOn(net, 'connect').mockImplementation((() => {
      const connection = createMemoryConnection();
      connections.add(connection);
      attempts += 1;
      void readHello(connection.server).then(
        () => connection.server.destroy(),
        () => {},
      );
      queueMicrotask(() => connection.client.emit('connect'));
      return connection.client;
    }) as typeof net.connect);
    const { client, controlSocket } = await startClient({
      tunnelAddr: 'selfhost.example:7400',
      connectTimeoutMs: 100,
      dataPlaneRetryDeadlineMs: 40,
      dataPlaneSettleMs: 100,
      reconnectMs: 5,
      onError: error => errors.push(error),
    });

    try {
      requestTunnel(controlSocket);
      await vi.advanceTimersByTimeAsync(39);
      expect(errors.filter(error => error.code === ErrCode.DataPlaneUnreachable)).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(errors.filter(error => error.code === ErrCode.DataPlaneUnreachable)).toHaveLength(1);
      expect(errors.at(-1)?.message).toContain('closed before the session was established');
      expect([...connections].every(connection => connection.client.destroyed)).toBe(true);

      const attemptsAtDeadline = attempts;
      await vi.advanceTimersByTimeAsync(100);
      expect(attempts).toBe(attemptsAtDeadline);
      expect(netConnect).toHaveBeenCalledTimes(attemptsAtDeadline);
      expect(errors.filter(error => error.code === ErrCode.DataPlaneUnreachable)).toHaveLength(1);
    } finally {
      await client.stop();
      destroyConnections(connections);
    }
  });

  it('times out pending plaintext connects and counts them toward the terminal deadline', async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const errors: Array<{ code: ErrCode; message: string }> = [];
    vi.spyOn(net, 'connect').mockImplementation((() => {
      const socket = createPendingSocket();
      sockets.push(socket);
      return socket;
    }) as typeof net.connect);
    const { client, controlSocket } = await startClient({
      tunnelAddr: 'selfhost.example:7400',
      connectTimeoutMs: 10,
      dataPlaneRetryDeadlineMs: 25,
      reconnectMs: 5,
      onError: error => errors.push(error),
    });

    try {
      requestTunnel(controlSocket);
      await vi.advanceTimersByTimeAsync(9);
      expect(sockets[0]?.destroyed).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(sockets[0]?.destroyed).toBe(true);
      expect(errors.some(error => error.message.includes('connect timed out after 10ms'))).toBe(
        true,
      );

      await vi.advanceTimersByTimeAsync(24);
      expect(errors.filter(error => error.code === ErrCode.DataPlaneUnreachable)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(errors.filter(error => error.code === ErrCode.DataPlaneUnreachable)).toHaveLength(1);
      expect(sockets.at(-1)?.destroyed).toBe(true);
    } finally {
      await client.stop();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('destroys a pending dial when the retry deadline fires mid-attempt', async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const errors: Array<{ code: ErrCode; message: string }> = [];
    vi.spyOn(net, 'connect').mockImplementation((() => {
      const socket = createPendingSocket();
      sockets.push(socket);
      if (sockets.length === 1) {
        queueMicrotask(() => socket.destroy(new Error('initial connection refused')));
      }
      return socket;
    }) as typeof net.connect);
    const { client, controlSocket } = await startClient({
      tunnelAddr: 'selfhost.example:7400',
      connectTimeoutMs: 1_000,
      dataPlaneRetryDeadlineMs: 20,
      reconnectMs: 5,
      onError: error => errors.push(error),
    });

    try {
      requestTunnel(controlSocket);
      await flushAsyncEvents();
      await vi.advanceTimersByTimeAsync(19);
      expect(sockets).toHaveLength(2);
      expect(sockets[1]?.destroyed).toBe(false);
      expect(errors.filter(error => error.code === ErrCode.DataPlaneUnreachable)).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(sockets[1]?.destroyed).toBe(true);
      expect(errors.filter(error => error.code === ErrCode.DataPlaneUnreachable)).toHaveLength(1);
      expect(errors.at(-1)?.message).toContain('initial connection refused');
    } finally {
      await client.stop();
    }
  });

  it('does not report dial errors when stop interrupts an open failure episode', async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const errors: Array<{ code: ErrCode; message: string }> = [];
    vi.spyOn(net, 'connect').mockImplementation((() => {
      const socket = createPendingSocket();
      sockets.push(socket);
      if (sockets.length === 1) {
        queueMicrotask(() => socket.destroy(new Error('initial connection refused')));
      }
      return socket;
    }) as typeof net.connect);
    const { client, controlSocket } = await startClient({
      tunnelAddr: 'selfhost.example:7400',
      connectTimeoutMs: 1_000,
      dataPlaneRetryDeadlineMs: 50,
      reconnectMs: 5,
      onError: error => errors.push(error),
    });

    requestTunnel(controlSocket);
    await flushAsyncEvents();
    await vi.advanceTimersByTimeAsync(5);
    expect(sockets).toHaveLength(2);
    expect(errors.some(error => error.code === ErrCode.TunnelDisconnected)).toBe(true);

    errors.length = 0;
    await client.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(errors).toEqual([]);
    expect(sockets[1]?.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears an episode after the settle interval and gives a later failure a fresh deadline', async () => {
    vi.useFakeTimers();
    const connections: MemoryConnection[] = [];
    const errors: Array<{ code: ErrCode; message: string }> = [];
    vi.spyOn(net, 'connect').mockImplementation((() => {
      const connection = createMemoryConnection();
      connections.push(connection);
      const attempt = connections.length;
      if (attempt === 1 || attempt === 3) {
        queueMicrotask(() => connection.client.destroy(new Error(`attempt ${attempt} failed`)));
      } else if (attempt === 2) {
        queueMicrotask(() => connection.client.emit('connect'));
      }
      return connection.client;
    }) as typeof net.connect);
    const { client, controlSocket } = await startClient({
      tunnelAddr: 'selfhost.example:7400',
      connectTimeoutMs: 1_000,
      dataPlaneRetryDeadlineMs: 50,
      dataPlaneSettleMs: 20,
      reconnectMs: 5,
      onError: error => errors.push(error),
    });

    try {
      requestTunnel(controlSocket);
      await flushAsyncEvents();
      await vi.advanceTimersByTimeAsync(5);
      expect(connections).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(20);
      connections[1]?.server.destroy();
      await flushAsyncEvents();
      await vi.advanceTimersByTimeAsync(10);
      expect(connections.length).toBeGreaterThanOrEqual(4);

      await vi.advanceTimersByTimeAsync(19);
      expect(errors.filter(error => error.code === ErrCode.DataPlaneUnreachable)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(26);
      expect(errors.filter(error => error.code === ErrCode.DataPlaneUnreachable)).toHaveLength(1);
      expect(errors.at(-1)?.message).toContain('attempt 3 failed');
    } finally {
      await client.stop();
      for (const connection of connections) connection.destroy();
    }
  });

  it('keeps retrying timed-out plaintext connects when the deadline is disabled', async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const errors: Array<{ code: ErrCode; message: string }> = [];
    vi.spyOn(net, 'connect').mockImplementation((() => {
      const socket = createPendingSocket();
      sockets.push(socket);
      return socket;
    }) as typeof net.connect);
    const { client, controlSocket } = await startClient({
      tunnelAddr: 'selfhost.example:7400',
      connectTimeoutMs: 10,
      dataPlaneRetryDeadlineMs: 0,
      reconnectMs: 5,
      onError: error => errors.push(error),
    });

    try {
      requestTunnel(controlSocket);
      await vi.advanceTimersByTimeAsync(100);
      expect(sockets.length).toBeGreaterThanOrEqual(5);
      expect(sockets.slice(0, -1).every(socket => socket.destroyed)).toBe(true);
      expect(errors.filter(error => error.code === ErrCode.DataPlaneUnreachable)).toHaveLength(0);
    } finally {
      await client.stop();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('counts a clean socket close before TunnelHello as a failed dial', async () => {
    const connections = new Set<MemoryConnection>();
    const errors: Array<{ code: ErrCode; message: string }> = [];
    const tlsConnect = vi.spyOn(tls, 'connect').mockImplementation((() => {
      const connection = createMemoryConnection();
      connections.add(connection);
      queueMicrotask(() => connection.client.emit('close'));
      return connection.client as unknown as TLSSocket;
    }) as typeof tls.connect);
    const netConnect = vi.spyOn(net, 'connect');
    const { client, controlSocket } = await startClient({
      tunnelTlsAddr: 'data.example:443',
      dataPlaneRetryDeadlineMs: 20,
      reconnectMs: 5,
      onError: error => errors.push(error),
    });

    try {
      requestTunnel(controlSocket);
      await waitUntil(() => errors.some(error => error.code === ErrCode.DataPlaneUnreachable));
      expect(tlsConnect.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(errors.at(-1)?.message).toContain('closed before TunnelHello was sent');
      expect(netConnect).not.toHaveBeenCalled();
    } finally {
      await client.stop();
      destroyConnections(connections);
    }
  });

  it('rejects a certificate for the wrong server name without sending TunnelHello', async () => {
    const connections = new Set<MemoryConnection>();
    const applicationBytes: Buffer[] = [];
    const errors: Array<{ code: ErrCode; message: string }> = [];
    const server = tls.createServer({ key: certificate.private, cert: certificate.cert }, socket =>
      socket.on('data', chunk => applicationBytes.push(chunk)),
    );
    server.on('tlsClientError', () => {});
    const port = 443;
    mockNetConnections(connections, socket => server.emit('connection', socket));
    mockTlsConnections(connections, socket => server.emit('connection', socket));
    const { client, controlSocket } = await startClient({
      tunnelTlsAddr: `127.0.0.1:${port}`,
      tunnelTlsServername: 'wrong.example',
      tunnelTlsCa: certificate.cert,
      reconnectMs: 200,
      onError: error => errors.push(error),
    });

    try {
      requestTunnel(controlSocket);
      await waitUntil(() => errors.length >= 1);
      expect(errors[0]?.code).toBe(ErrCode.TunnelDisconnected);
      expect(errors[0]?.message).toContain("Hostname/IP does not match certificate's altnames");
      expect(Buffer.concat(applicationBytes).includes(Buffer.from('client_id'))).toBe(false);
    } finally {
      await client.stop();
      destroyConnections(connections);
    }
  });

  it('destroys a silent TLS handshake at tlsHandshakeTimeoutMs (connectTimeoutMs bounds plaintext only) and clears its timers on stop', async () => {
    vi.useFakeTimers();
    const sockets: TLSSocket[] = [];
    const errors: Array<{ code: ErrCode; message: string }> = [];
    vi.spyOn(tls, 'connect').mockImplementation((() => {
      const socket = createPendingSocket() as TLSSocket;
      sockets.push(socket);
      return socket;
    }) as typeof tls.connect);
    const { client, controlSocket } = await startClient({
      tunnelTlsAddr: '127.0.0.1:443',
      tunnelTlsServername: 'localhost',
      connectTimeoutMs: 5_000,
      tlsHandshakeTimeoutMs: 50,
      dataPlaneRetryDeadlineMs: 0,
      reconnectMs: 10,
      onError: error => errors.push(error),
    });

    requestTunnel(controlSocket);
    await vi.advanceTimersByTimeAsync(49);
    expect(sockets[0]?.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets[0]?.destroyed).toBe(true);
    expect(errors[0]).toEqual({
      code: ErrCode.TunnelDisconnected,
      message: `Tunnel ${TUNNEL_CONNECTION_ID} disconnected: TLS handshake timed out after 50ms`,
    });

    await client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the canonical A-label for the TLS dial host and default servername', async () => {
    const connection = createMemoryConnection();
    const tlsConnect = vi.spyOn(tls, 'connect').mockImplementation((() => {
      queueMicrotask(() => connection.client.emit('secureConnect'));
      return connection.client as unknown as TLSSocket;
    }) as typeof tls.connect);
    const { client, controlSocket } = await startClient({
      tunnelTlsAddr: 'B\u00dcCHER.example:443',
      dataPlaneRetryDeadlineMs: 0,
    });

    try {
      requestTunnel(controlSocket);
      await waitUntil(() => tlsConnect.mock.calls.length === 1);
      expect(tlsConnect.mock.calls[0]?.[0]).toMatchObject({
        host: 'xn--bcher-kva.example',
        servername: 'xn--bcher-kva.example',
      });
    } finally {
      await client.stop();
      connection.destroy();
    }
  });

  it('omits ca when no extra TLS root is configured', async () => {
    const socket = createPendingSocket() as TLSSocket;
    const tlsConnect = vi
      .spyOn(tls, 'connect')
      .mockImplementation((() => socket) as typeof tls.connect);
    const { client, controlSocket } = await startClient({
      tunnelTlsAddr: 'data.example:443',
      dataPlaneRetryDeadlineMs: 0,
    });

    try {
      requestTunnel(controlSocket);
      await waitUntil(() => tlsConnect.mock.calls.length === 1);
      expect((tlsConnect.mock.calls[0]?.[0] as tls.ConnectionOptions).ca).toBeUndefined();
    } finally {
      await client.stop();
    }
  });

  it('extends getCACertificates default roots when that API is available', async () => {
    const tlsWithOptionalCa = tls as typeof tls & {
      getCACertificates?: (type: 'default') => readonly string[];
    };
    const getCaDescriptor = Object.getOwnPropertyDescriptor(tlsWithOptionalCa, 'getCACertificates');
    const getCa = vi.fn(() => ['default-root-one', 'default-root-two']);
    Object.defineProperty(tlsWithOptionalCa, 'getCACertificates', {
      configurable: true,
      value: getCa,
    });
    const socket = createPendingSocket() as TLSSocket;
    const tlsConnect = vi
      .spyOn(tls, 'connect')
      .mockImplementation((() => socket) as typeof tls.connect);

    try {
      const { client, controlSocket } = await startClient({
        tunnelTlsAddr: 'data.example:443',
        tunnelTlsCa: 'explicit-extra-root',
        dataPlaneRetryDeadlineMs: 0,
      });
      try {
        requestTunnel(controlSocket);
        await waitUntil(() => tlsConnect.mock.calls.length === 1);
        expect(getCa).toHaveBeenCalledWith('default');
        expect((tlsConnect.mock.calls[0]?.[0] as tls.ConnectionOptions).ca).toEqual([
          'default-root-one',
          'default-root-two',
          'explicit-extra-root',
        ]);
      } finally {
        await client.stop();
      }
    } finally {
      if (getCaDescriptor === undefined) {
        Reflect.deleteProperty(tlsWithOptionalCa, 'getCACertificates');
      } else {
        Object.defineProperty(tlsWithOptionalCa, 'getCACertificates', getCaDescriptor);
      }
    }
  });

  it('preserves NODE_EXTRA_CA_CERTS with rootCertificates when getCACertificates is absent', async () => {
    const tlsWithOptionalCa = tls as typeof tls & {
      getCACertificates?: (type: 'default') => readonly string[];
    };
    const getCaDescriptor = Object.getOwnPropertyDescriptor(tlsWithOptionalCa, 'getCACertificates');
    Object.defineProperty(tlsWithOptionalCa, 'getCACertificates', {
      configurable: true,
      value: undefined,
    });
    const priorExtraCa = process.env.NODE_EXTRA_CA_CERTS;
    const dir = mkdtempSync(join(tmpdir(), 'tunnel-node-extra-ca-'));
    const extraCaPath = join(dir, 'enterprise.pem');
    const enterpriseOne = '-----BEGIN CERTIFICATE-----\nenterprise-one\n-----END CERTIFICATE-----';
    const enterpriseTwo = '-----BEGIN CERTIFICATE-----\nenterprise-two\n-----END CERTIFICATE-----';
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- writes this test's own mkdtempSync temp file, never user input.
    writeFileSync(extraCaPath, `${enterpriseOne}\nignored text\n${enterpriseTwo}\n`);
    process.env.NODE_EXTRA_CA_CERTS = extraCaPath;
    const socket = createPendingSocket() as TLSSocket;
    const tlsConnect = vi
      .spyOn(tls, 'connect')
      .mockImplementation((() => socket) as typeof tls.connect);

    try {
      const { client, controlSocket } = await startClient({
        tunnelTlsAddr: 'data.example:443',
        tunnelTlsCa: 'explicit-extra-root',
        dataPlaneRetryDeadlineMs: 0,
      });
      try {
        requestTunnel(controlSocket);
        await waitUntil(() => tlsConnect.mock.calls.length === 1);
        expect((tlsConnect.mock.calls[0]?.[0] as tls.ConnectionOptions).ca).toEqual([
          ...tls.rootCertificates,
          enterpriseOne,
          enterpriseTwo,
          'explicit-extra-root',
        ]);
      } finally {
        await client.stop();
      }
    } finally {
      if (priorExtraCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = priorExtraCa;
      if (getCaDescriptor === undefined)
        Reflect.deleteProperty(tlsWithOptionalCa, 'getCACertificates');
      else Object.defineProperty(tlsWithOptionalCa, 'getCACertificates', getCaDescriptor);
    }
  });

  it('keeps the explicit tunnelAddr-only compatibility path plaintext', async () => {
    const connections = new Set<MemoryConnection>();
    let resolveHello!: (hello: TunnelHelloFrame) => void;
    const helloReceived = new Promise<TunnelHelloFrame>(resolve => {
      resolveHello = resolve;
    });
    const port = 7400;
    mockNetConnections(connections, socket => {
      void readHello(socket).then(resolveHello, () => {});
    });
    const { client, controlSocket } = await startClient({ tunnelAddr: `127.0.0.1:${port}` });

    try {
      expect(client.transport).toBe('plaintext');
      requestTunnel(controlSocket);
      await expect(helloReceived).resolves.toEqual({
        client_id: CLIENT_ID,
        secret: SECRET,
        tunnel_connection_id: TUNNEL_CONNECTION_ID,
      });
    } finally {
      await client.stop();
      destroyConnections(connections);
    }
  });

  it('requires an explicit TLS server name when the configured host is an IP literal', () => {
    expect(
      () =>
        new TunnelClient({
          clientId: CLIENT_ID,
          secret: SECRET,
          controlUrl: 'ws://control.test/ws',
          tunnelAddr: '127.0.0.1:7400',
          tunnelTlsAddr: '127.0.0.1:443',
          logSink: () => {},
        }),
    ).toThrow('tunnelTlsServername is required when tunnelTlsAddr uses an IP-literal host');
  });
});

describe('TunnelClient tunnel address validation', () => {
  const rejectedAddresses = [
    'tls://data.example:443',
    'data.example/path:443',
    'data.example?query:443',
    'data.example#fragment:443',
    'user@data.example:443',
    'data example:443',
    ':443',
    '::1:7400',
    'data.example:not-a-port',
    'data.example:1.5',
    'data.example:0',
    'data.example:65536',
    '[]:443',
    '[not-an-ipv6-literal]:443',
    '[127.0.0.1]:443',
  ];

  it.each(['tunnelAddr', 'tunnelTlsAddr'] as const)(
    'rejects malformed %s values at construction',
    field => {
      for (const address of rejectedAddresses) {
        expect(
          () =>
            new TunnelClient({
              clientId: CLIENT_ID,
              secret: SECRET,
              controlUrl: 'ws://control.test/ws',
              tunnelAddr: field === 'tunnelAddr' ? address : 'data.example:7400',
              ...(field === 'tunnelTlsAddr'
                ? { tunnelTlsAddr: address, tunnelTlsServername: 'data.example' }
                : {}),
              logSink: () => {},
            }),
          address,
        ).toThrow('Invalid tunnel address');
      }
    },
  );

  it.each(['data.example:443', '127.0.0.1:7400', '[::1]:7400', 'b\u00fccher.example:443'])(
    'accepts a strict authority address: %s',
    address => {
      expect(
        () =>
          new TunnelClient({
            clientId: CLIENT_ID,
            secret: SECRET,
            controlUrl: 'ws://control.test/ws',
            tunnelAddr: address,
            logSink: () => {},
          }),
      ).not.toThrow();
      expect(
        () =>
          new TunnelClient({
            clientId: CLIENT_ID,
            secret: SECRET,
            controlUrl: 'ws://control.test/ws',
            tunnelAddr: 'data.example:7400',
            tunnelTlsAddr: address,
            tunnelTlsServername: 'data.example',
            logSink: () => {},
          }),
      ).not.toThrow();
    },
  );
});

describe('TunnelClient data-plane retry deadline validation', () => {
  it('rejects invalid data-plane timing options while accepting zero', () => {
    const options = {
      clientId: CLIENT_ID,
      secret: SECRET,
      controlUrl: 'ws://control.test/ws',
      tunnelAddr: 'data.example:7400',
      logSink: () => {},
    };

    for (const dataPlaneRetryDeadlineMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => new TunnelClient({ ...options, dataPlaneRetryDeadlineMs }),
        String(dataPlaneRetryDeadlineMs),
      ).toThrow('dataPlaneRetryDeadlineMs must be a non-negative integer');
    }
    expect(() => new TunnelClient({ ...options, dataPlaneRetryDeadlineMs: 0 })).not.toThrow();

    for (const field of ['dataPlaneSettleMs', 'connectTimeoutMs'] as const) {
      for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          () => new TunnelClient({ ...options, [field]: value }),
          `${field}=${String(value)}`,
        ).toThrow(`${field} must be a non-negative integer`);
      }
      expect(() => new TunnelClient({ ...options, [field]: 0 })).not.toThrow();
    }
  });
});
