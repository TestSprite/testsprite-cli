/**
 * Covers the fix for the `--local` teardown hang: `TunnelClient.stop()` never
 * resolved when the control-plane peer completed the WS upgrade but then
 * never answered a Close frame (a redeploy mid-handshake, a proxy that
 * swallows the FIN, a server too busy to answer). Root cause is read straight
 * from undici's own source in `ws-compat.ts`'s docstring — this file proves
 * the fix against a REAL, in-process, uncooperative peer (a raw HTTP-upgrade
 * stub, not a fake `controlWs`), so it exercises the actual undici
 * `WebSocket` behavior rather than an assumption about it.
 *
 * Two concerns, two describe blocks:
 *
 *   - The fix itself: `stop()` (and therefore `client.ts`'s existing,
 *     UNMODIFIED close handler — heartbeat clear, control-loop unwind)
 *     settles within a bound even when the peer never cooperates, and the
 *     captured socket is actually released (`getActiveResourcesInfo()`
 *     drops it).
 *   - The premise: this whole fix rests on undici's `undici:client:connected`
 *     diagnostics channel firing with a usable socket for a plain WebSocket
 *     connect. That channel is documented but labeled "Experimental" by
 *     undici itself — if a future undici release stops publishing it, or
 *     changes the payload shape, `ws-compat.ts`'s capture silently misses
 *     and the ORIGINAL hang comes back with every other test still green
 *     (they only assert the happy end state). Pinning the premise directly
 *     means that day fails loudly, here, instead of quietly six months from
 *     now in a customer's terminal.
 */
import { createHash } from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { TunnelClient } from './client.js';
import { connectEventMatchesTarget } from './ws-compat.js';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const AUTH_ACK_FRAME = Buffer.concat([
  Buffer.from([0x81, 0x0e]),
  Buffer.from('{"type":"Ack"}', 'utf8'),
]);

/** A real WS-upgrade stub: completes the handshake, then ignores everything
 * — never answers a Close frame, never destroys/ends the socket. This is the
 * "uncooperative peer" the fix exists for. */
async function startUncooperativeStub(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(400);
    res.end('upgrade only');
  });
  server.on('upgrade', (req, socket) => {
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
    let authAcknowledged = false;
    // Acknowledge the first client frame (Auth), then deliberately swallow
    // all later bytes (including a Close frame), never reply again, and never
    // destroy/end this socket.
    socket.on('data', () => {
      if (!authAcknowledged) {
        authAcknowledged = true;
        socket.write(AUTH_ACK_FRAME);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return { server, port: address.port };
}

describe('connectEventMatchesTarget (the capture filter — a miss here restores the hang)', () => {
  // The bug this pins: undici hands the event's port through from a WHATWG
  // URL, which leaves a default-scheme port implicit (`''`). The target side
  // was already being defaulted to 80/443 while the event side was not, so
  // `Number('') === 0` matched nothing and capture missed for EVERY control
  // URL written without an explicit port — with or without a proxy. A miss is
  // silent: the synthetic close still clears the heartbeat, so every existing
  // test stays green while the socket stays ref'd and the process hangs.
  it.each([
    ['implicit ws port on both sides', 'ws://tunnel.example.com/control', '', true],
    ['implicit wss port on both sides', 'wss://tunnel.example.com/control', '', true],
    [
      'implicit target port, explicit 80 in the event',
      'ws://tunnel.example.com/control',
      '80',
      true,
    ],
    [
      'implicit target port, explicit 443 in the event',
      'wss://tunnel.example.com/control',
      '443',
      true,
    ],
    ['explicit port on both sides', 'ws://tunnel.example.com:9090/control', '9090', true],
    ['wrong port', 'ws://tunnel.example.com:9090/control', '9091', false],
    ['implicit ws target vs the wss default', 'ws://tunnel.example.com/control', '443', false],
    [
      'explicit non-default target vs an implicit event port',
      'ws://tunnel.example.com:9090/control',
      '',
      false,
    ],
  ])('%s', (_label, controlUrl, eventPort, expected) => {
    const target = new URL(controlUrl);
    expect(connectEventMatchesTarget({ hostname: target.hostname, port: eventPort }, target)).toBe(
      expected,
    );
  });

  it('never matches a different host, which is what keeps a proxy dial from being captured', () => {
    const target = new URL('ws://tunnel.example.com/control');
    // The first of the two events a proxied connection publishes: the physical
    // dial to the proxy. The second one carries the target's host and IS the
    // one that matches — verified against undici 7.29.0 with a real CONNECT
    // proxy, where teardown exits in the same ~1.4s as an unproxied run.
    expect(connectEventMatchesTarget({ hostname: 'proxy.internal', port: '3128' }, target)).toBe(
      false,
    );
  });

  it('never matches a missing or malformed payload', () => {
    const target = new URL('ws://tunnel.example.com/control');
    expect(connectEventMatchesTarget(undefined, target)).toBe(false);
    expect(connectEventMatchesTarget({}, target)).toBe(false);
    expect(connectEventMatchesTarget({ hostname: undefined, port: '80' }, target)).toBe(false);
  });
});

describe('undici:client:connected premise (pins the third-party behavior the fix depends on)', () => {
  it('fires with a real net.Socket for a plain WebSocket connect', async () => {
    const { server, port } = await startUncooperativeStub();
    try {
      let captured: { socket?: unknown; connectParams?: { hostname?: unknown; port?: unknown } } =
        {};
      const onConnected = (message: unknown): void => {
        captured = message as typeof captured;
      };
      const channel = diagnosticsChannel.channel('undici:client:connected');
      channel.subscribe(onConnected);
      try {
        const { WebSocket: UndiciWebSocket } = await import('undici');
        const ws = new UndiciWebSocket(`ws://127.0.0.1:${port}/control`);
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener('open', () => resolve());
          ws.addEventListener('error', () => reject(new Error('ws error before open')));
        });
        ws.close();
      } finally {
        channel.unsubscribe(onConnected);
      }

      // If this fails, undici stopped publishing the channel, changed its
      // payload shape, or stopped including a usable socket — any of which
      // means ws-compat.ts's capture silently misses and the close-hang fix
      // degrades to "heartbeat cleared, socket leaked forever." That is the
      // signal to re-derive the capture mechanism, not to relax this test.
      expect(captured.connectParams?.hostname).toBe('127.0.0.1');
      expect(Number(captured.connectParams?.port)).toBe(port);
      expect(captured.socket).toBeDefined();
      expect(typeof (captured.socket as Socket | undefined)?.unref).toBe('function');
      expect(typeof (captured.socket as Socket | undefined)?.destroy).toBe('function');
    } finally {
      server.close();
    }
  }, 10_000);
});

describe('TunnelClient.stop against an uncooperative control peer', () => {
  it('resolves within a bound, and releases the captured socket, even when the peer never completes the close handshake', async () => {
    const { server, port } = await startUncooperativeStub();
    try {
      const client = new TunnelClient({
        clientId: '11111111-1111-4111-8111-111111111111',
        secret: 'not-a-real-secret',
        controlUrl: `ws://127.0.0.1:${port}/control`,
        tunnelAddr: '127.0.0.1:1', // never dialed — no RequestTunnel is ever sent
        heartbeatMs: 10_000,
        reconnectMs: 3_000,
        logSink: () => {},
      });

      await client.start();

      const before = (
        process as unknown as { getActiveResourcesInfo?: () => string[] }
      ).getActiveResourcesInfo?.();
      const socketsBefore = (before ?? []).filter(r => r === 'TCPSocketWrap').length;
      expect(socketsBefore).toBeGreaterThan(0); // sanity: the control socket IS open

      const started = Date.now();
      await client.stop();
      const elapsedMs = Date.now() - started;

      // Must resolve well under the grace window plus scheduling slack —
      // not "eventually", and never by hanging until the suite's own
      // timeout kills it (which is indistinguishable from the original bug
      // if this assertion were absent).
      expect(elapsedMs).toBeLessThan(2_000);

      const after = (
        process as unknown as { getActiveResourcesInfo?: () => string[] }
      ).getActiveResourcesInfo?.();
      const socketsAfter = (after ?? []).filter(r => r === 'TCPSocketWrap').length;
      expect(socketsAfter).toBeLessThan(socketsBefore);
    } finally {
      server.close();
    }
  }, 10_000);

  it('still resolves promptly when the peer DOES complete the close handshake (no regression on the happy path)', async () => {
    // A cooperative server: completes the upgrade AND echoes a Close frame
    // back immediately, then destroys the socket — a real, real closing
    // handshake, so the grace timer must never fire here.
    const server = createServer((_req, res) => {
      res.writeHead(400);
      res.end('upgrade only');
    });
    server.on('upgrade', (req, socket) => {
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
      let authAcknowledged = false;
      socket.on('data', (chunk: Buffer) => {
        if (!authAcknowledged) {
          authAcknowledged = true;
          socket.write(AUTH_ACK_FRAME);
        }
        // client.ts sends its Auth text frame immediately on open, so the
        // Close frame this test is watching for may arrive in a later chunk
        // — or coalesced into the same one. Scanning the whole chunk for the
        // Close opcode byte (0x88, FIN+opcode=CLOSE) is robust to both: our
        // own plain-ASCII Auth JSON never contains that byte value.
        if (chunk.includes(0x88)) {
          socket.write(Buffer.from([0x88, 0x00]));
          // A real cooperative server tears the raw TCP connection all the
          // way down once the WS-level handshake is done — undici's own
          // receiver only tracks close-frame SENT/RECEIVED state and never
          // destroys the socket itself (verified: no destroy()/end() call
          // anywhere in its receiver.js), so `close` fires on the client
          // only once the underlying duplex is actually, fully closed.
          // `.end()` alone is a half-close and does not produce that.
          socket.destroy();
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no address');

    try {
      const client = new TunnelClient({
        clientId: '22222222-2222-4222-8222-222222222222',
        secret: 'not-a-real-secret',
        controlUrl: `ws://127.0.0.1:${address.port}/control`,
        tunnelAddr: '127.0.0.1:1',
        heartbeatMs: 10_000,
        reconnectMs: 3_000,
        logSink: () => {},
      });
      await client.start();

      const started = Date.now();
      await client.stop();
      const elapsedMs = Date.now() - started;

      // A cooperative peer should settle almost immediately — comfortably
      // before the grace timer (1200ms) would ever fire.
      expect(elapsedMs).toBeLessThan(500);
    } finally {
      server.close();
    }
  }, 10_000);
});
