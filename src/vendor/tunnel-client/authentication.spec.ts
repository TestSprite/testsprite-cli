import { createHash } from 'node:crypto';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { Duplex, PassThrough } from 'node:stream';
import { Agent, getGlobalDispatcher, setGlobalDispatcher, type buildConnector } from 'undici';
import { describe, expect, it } from 'vitest';
import { TunnelClient } from './client.js';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

interface ControlConnection {
  authReceived: Promise<void>;
  sendAck(): void;
  close(code?: number, reason?: string): void;
}

interface ControlServer {
  controlUrl: string;
  nextConnection(): Promise<ControlConnection>;
  stop(): Promise<void>;
}

interface FrameReader {
  buffered: Buffer;
}

function encodeServerFrame(
  opcode: number,
  payload: Buffer<ArrayBufferLike> = Buffer.alloc(0),
): Buffer {
  if (payload.length <= 125) {
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  }

  if (payload.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function readClientFrames(reader: FrameReader): Array<{ opcode: number; payload: Buffer }> {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];

  while (reader.buffered.length >= 2) {
    const first = reader.buffered[0]!;
    const second = reader.buffered[1]!;
    let payloadLength = second & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (reader.buffered.length < 4) break;
      payloadLength = reader.buffered.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      if (reader.buffered.length < 10) break;
      const wideLength = reader.buffered.readBigUInt64BE(2);
      if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('WebSocket frame is too large for the test harness');
      }
      payloadLength = Number(wideLength);
      offset = 10;
    }

    const masked = (second & 0x80) !== 0;
    const maskLength = masked ? 4 : 0;
    const frameLength = offset + maskLength + payloadLength;
    if (reader.buffered.length < frameLength) break;

    const mask = masked ? reader.buffered.subarray(offset, offset + 4) : undefined;
    offset += maskLength;
    const payload = Buffer.from(reader.buffered.subarray(offset, offset + payloadLength));
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = payload[index]! ^ mask[index % 4]!;
      }
    }

    frames.push({ opcode: first & 0x0f, payload });
    reader.buffered = reader.buffered.subarray(frameLength);
  }

  return frames;
}

async function startControlServer(): Promise<ControlServer> {
  const previousDispatcher = getGlobalDispatcher();
  const sockets = new Set<Duplex>();
  const queued: ControlConnection[] = [];
  const waiters: Array<(connection: ControlConnection) => void> = [];

  const acceptConnection = (socket: Duplex) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});

    let resolveAuth!: () => void;
    let authSeen = false;
    const authReceived = new Promise<void>(resolve => {
      resolveAuth = resolve;
    });
    const reader: FrameReader = { buffered: Buffer.alloc(0) };

    let handshake = Buffer.alloc(0);
    let upgraded = false;
    const processFrames = (chunk: Buffer) => {
      reader.buffered = Buffer.concat([reader.buffered, chunk]);
      for (const frame of readClientFrames(reader)) {
        if (frame.opcode === 0x1) {
          const message = JSON.parse(frame.payload.toString('utf8')) as { type?: unknown };
          if (!authSeen && message.type === 'Auth') {
            authSeen = true;
            resolveAuth();
          }
          continue;
        }

        if (frame.opcode === 0x8 && !socket.destroyed) {
          socket.write(encodeServerFrame(0x8, frame.payload), () => socket.end());
        }
      }
    };

    const connection: ControlConnection = {
      authReceived,
      sendAck: () => {
        socket.write(encodeServerFrame(0x1, Buffer.from('{"type":"Ack"}', 'utf8')));
      },
      close: (code = 1000, reason = '') => {
        const reasonBytes = Buffer.from(reason, 'utf8');
        const payload = Buffer.alloc(2 + reasonBytes.length);
        payload.writeUInt16BE(code, 0);
        reasonBytes.copy(payload, 2);
        socket.write(encodeServerFrame(0x8, payload), () => socket.end());
      },
    };

    socket.on('data', (chunk: Buffer) => {
      if (upgraded) {
        processFrames(chunk);
        return;
      }

      handshake = Buffer.concat([handshake, chunk]);
      const headerEnd = handshake.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;

      const headers = handshake.subarray(0, headerEnd).toString('latin1');
      const key = /^sec-websocket-key:\s*(.+)$/im.exec(headers)?.[1]?.trim();
      if (!key) {
        socket.destroy(new Error('missing Sec-WebSocket-Key'));
        return;
      }

      const accept = createHash('sha1')
        .update(key + WS_MAGIC)
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      upgraded = true;

      const waiter = waiters.shift();
      if (waiter) waiter(connection);
      else queued.push(connection);

      const remaining = handshake.subarray(headerEnd + 4);
      handshake = Buffer.alloc(0);
      if (remaining.length > 0) processFrames(remaining);
    });
  };

  let controlUrl: string;
  let dispatcher: Agent | undefined;
  let tcpServer: NetServer | undefined;
  const candidateServer = createNetServer(socket => acceptConnection(socket));

  try {
    await listenOnLoopback(candidateServer);
    tcpServer = candidateServer;
    const address = candidateServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('control server has no TCP address');
    }
    controlUrl = `ws://127.0.0.1:${address.port}/control`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;

    // Some execution sandboxes forbid every OS listener, including loopback.
    // Keep undici's real HTTP Upgrade and WebSocket framing in that environment,
    // replacing only the connector with an in-memory duplex pair.
    const connect: buildConnector.connector = (_options, callback) => {
      const { client, server } = createDuplexPair();
      acceptConnection(server);
      queueMicrotask(() => callback(null, client));
    };
    dispatcher = new Agent({ connect });
    setGlobalDispatcher(dispatcher);
    controlUrl = 'ws://tunnel-auth.test/control';
  }

  return {
    controlUrl,
    nextConnection: () => {
      const connection = queued.shift();
      if (connection) return Promise.resolve(connection);
      return new Promise<ControlConnection>(resolve => waiters.push(resolve));
    },
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      if (tcpServer) await closeNetServer(tcpServer);
      if (dispatcher) {
        setGlobalDispatcher(previousDispatcher);
        await dispatcher.destroy();
      }
    },
  };
}

function listenOnLoopback(server: NetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeNetServer(server: NetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createDuplexPair(): { client: Socket; server: Duplex } {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const client = Duplex.from({ readable: serverToClient, writable: clientToServer });
  const server = Duplex.from({ readable: clientToServer, writable: serverToClient });

  Object.assign(client, {
    setKeepAlive: () => client,
    setNoDelay: () => client,
    ref: () => client,
    unref: () => client,
  });
  client.on('error', () => {});
  server.on('error', () => {});

  return { client: client as unknown as Socket, server };
}

function makeClient(
  server: ControlServer,
  options: { authTimeoutMs?: number; reconnectMs?: number } = {},
): TunnelClient {
  return new TunnelClient({
    clientId: '11111111-1111-4111-8111-111111111111',
    secret: 'not-a-real-secret',
    controlUrl: server.controlUrl,
    tunnelAddr: '127.0.0.1:1',
    heartbeatMs: 60_000,
    authTimeoutMs: options.authTimeoutMs,
    reconnectMs: options.reconnectMs,
    logSink: () => {},
  });
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer!: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('TunnelClient control authentication readiness', () => {
  it('T1: start stays pending until the server sends its Ack', async () => {
    const server = await startControlServer();
    const client = makeClient(server, { authTimeoutMs: 500 });
    let ackSent = false;
    let startResolved = false;
    let ackHadBeenSentWhenStartResolved: boolean | undefined;
    const startPromise = client.start().then(() => {
      startResolved = true;
      ackHadBeenSentWhenStartResolved = ackSent;
    });
    let connection: ControlConnection | undefined;

    try {
      connection = await server.nextConnection();
      await connection.authReceived;

      expect(startResolved).toBe(false);

      ackSent = true;
      connection.sendAck();
      await startPromise;

      expect(ackHadBeenSentWhenStartResolved).toBe(true);
    } finally {
      if (!ackSent) {
        ackSent = true;
        connection?.sendAck();
      }
      await startPromise.catch(() => {});
      await client.stop();
      await server.stop();
    }
  }, 5_000);

  it('T2: start times out without an Ack, then stop still resolves', async () => {
    const server = await startControlServer();
    const client = makeClient(server, { authTimeoutMs: 50 });
    let stopped = false;

    try {
      const startPromise = client.start();
      const connection = await server.nextConnection();
      await connection.authReceived;

      await expect(startPromise).rejects.toThrow(
        /accepted the connection but never acknowledged authentication/i,
      );
      await within(client.stop(), 2_000, 'stop did not resolve after the authentication timeout');
      stopped = true;
    } finally {
      if (!stopped) await client.stop();
      await server.stop();
    }
  }, 5_000);

  it('T3: start rejects when the control socket closes before Ack', async () => {
    const server = await startControlServer();
    const client = makeClient(server, { authTimeoutMs: 1_000 });

    try {
      const startPromise = client.start();
      const connection = await server.nextConnection();
      await connection.authReceived;
      connection.close(1000, 'closed before auth Ack');

      await expect(startPromise).rejects.toThrow(/closed before authentication was acknowledged/i);
    } finally {
      await client.stop();
      await server.stop();
    }
  }, 5_000);

  it('T4: control-connected still fires before control-authenticated', async () => {
    const server = await startControlServer();
    const client = makeClient(server, { authTimeoutMs: 500 });
    const order: string[] = [];
    const connected = new Promise<void>(resolve => {
      client.once('control-connected', () => {
        order.push('connected');
        resolve();
      });
    });
    const authenticated = new Promise<void>(resolve => {
      client.once('control-authenticated', () => {
        order.push('authenticated');
        resolve();
      });
    });

    try {
      const startPromise = client.start();
      const connection = await server.nextConnection();
      await connection.authReceived;
      await connected;

      expect(order).toEqual(['connected']);

      connection.sendAck();
      await within(authenticated, 500, 'control-authenticated did not fire after Ack');
      await startPromise;

      expect(order).toEqual(['connected', 'authenticated']);
    } finally {
      await client.stop();
      await server.stop();
    }
  }, 5_000);

  it('T5: authentication readiness re-arms for a reconnected control socket', async () => {
    const server = await startControlServer();
    const client = makeClient(server, { authTimeoutMs: 500, reconnectMs: 1 });
    let authenticatedCount = 0;
    let resolveFirstAuthenticated!: () => void;
    let resolveSecondAuthenticated!: () => void;
    const firstAuthenticated = new Promise<void>(resolve => {
      resolveFirstAuthenticated = resolve;
    });
    const secondAuthenticated = new Promise<void>(resolve => {
      resolveSecondAuthenticated = resolve;
    });
    let secondAuthenticatedSettled = false;
    void secondAuthenticated.then(() => {
      secondAuthenticatedSettled = true;
    });
    const onAuthenticated = () => {
      authenticatedCount += 1;
      if (authenticatedCount === 1) resolveFirstAuthenticated();
      if (authenticatedCount === 2) resolveSecondAuthenticated();
    };
    client.on('control-authenticated', onAuthenticated);

    try {
      const startPromise = client.start();
      const first = await server.nextConnection();
      await first.authReceived;
      first.sendAck();
      await within(firstAuthenticated, 500, 'first control socket was not marked authenticated');
      await startPromise;

      // A later Ack on the old socket is a heartbeat Ack, not fresh readiness.
      first.sendAck();
      first.close(1000, 'reconnect test');

      const second = await server.nextConnection();
      await second.authReceived;

      expect(authenticatedCount).toBe(1);
      expect(secondAuthenticatedSettled).toBe(false);

      second.sendAck();
      await within(secondAuthenticated, 500, 'second control socket was not marked authenticated');
      expect(authenticatedCount).toBe(2);
    } finally {
      client.off('control-authenticated', onAuthenticated);
      await client.stop();
      await server.stop();
    }
  }, 5_000);
});
