import type { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TunnelClient } from './client.js';
import { ErrCode } from './types.js';

const transport = vi.hoisted(() => ({
  sockets: [] as Array<EventEmitter & { readyState: number }>,
}));

// Replace only the transport: authentication, close classification, heartbeat
// cleanup, and the reconnect loop all run through the real client.
vi.mock('./ws-compat.js', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: class extends EventEmitter {
      static OPEN = 1;
      static CONNECTING = 0;
      readyState = 0;

      constructor() {
        super();
        transport.sockets.push(this);
      }

      send() {}

      close() {
        this.readyState = 3;
        this.emit('close', 1000, Buffer.alloc(0));
      }
    },
  };
});

afterEach(() => {
  transport.sockets.length = 0;
  vi.useRealTimers();
});

describe('TunnelClient terminal control closes', () => {
  it.each([false, true])(
    'classifies AUTH_FAILED using only the current connection Ack (acknowledged=%s)',
    async acknowledged => {
      vi.useFakeTimers();
      const errors: Array<{ code: ErrCode; message: string }> = [];
      const client = new TunnelClient({
        clientId: '11111111-1111-4111-8111-111111111111',
        secret: 'not-a-real-secret',
        controlUrl: 'ws://tunnel.example/control',
        tunnelAddr: 'tunnel.example:7400',
        reconnectMs: 750,
        logSink: () => {},
        onError: error => errors.push(error),
      });
      const started = client.start();
      try {
        const first = transport.sockets[0]!;
        first.readyState = 1;
        first.emit('open');
        first.emit('message', Buffer.from('{"type":"Ack"}'));
        await started;
        first.readyState = 3;
        first.emit('close', 1006, Buffer.alloc(0));
        await vi.advanceTimersByTimeAsync(750);

        expect(transport.sockets).toHaveLength(2);
        const second = transport.sockets[1]!;
        second.readyState = 1;
        second.emit('open');
        if (acknowledged) second.emit('message', Buffer.from('{"type":"Ack"}'));
        second.readyState = 3;
        second.emit('close', 1008, Buffer.from('AUTH_FAILED'));
        await vi.advanceTimersByTimeAsync(0);

        expect.soft(errors).toEqual([
          {
            code: ErrCode.AuthFailed,
            message: acknowledged
              ? 'tunnel connection superseded or credential revoked'
              : 'Control authentication failed, stop reconnecting: control auth failure (code=1008, reason=AUTH_FAILED)',
          },
        ]);
        expect.soft(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(1_500);
        expect(transport.sockets).toHaveLength(2);
      } finally {
        await client.stop();
        await started;
      }
    },
  );

  describe.each(['CLIENT_REVOKED', 'AUTH_FAILED'])('1008 %s', reason => {
    it.each(['before Ack', 'after Ack', 'during tunnel backoff', 'after pre-Ack error'])(
      '%s is terminal and leaves no reconnect timer',
      async phase => {
        vi.useFakeTimers();
        const errors: Array<{ code: ErrCode; message: string }> = [];
        const client = new TunnelClient({
          clientId: '11111111-1111-4111-8111-111111111111',
          secret: 'not-a-real-secret',
          controlUrl: 'ws://tunnel.example/control',
          tunnelAddr: 'tunnel.example:7400',
          reconnectMs: 750,
          logSink: () => {},
          onError: error => errors.push(error),
        });
        const started = client.start().catch((error: unknown) => error);
        const socket = transport.sockets[0]!;
        try {
          socket.readyState = 1;
          socket.emit('open');
          const acknowledged = phase === 'after Ack' || phase === 'during tunnel backoff';
          if (acknowledged) {
            socket.emit('message', Buffer.from('{"type":"Ack"}'));
            expect(await started).toBeUndefined();
          }
          if (phase === 'during tunnel backoff') {
            const internal = client as unknown as {
              connectTunnel(): Promise<void>;
              ensureTunnelRuntime(id: string): void;
            };
            // Fail only the data-plane dial; retain its real retry loop.
            internal.connectTunnel = async () => {
              throw new Error('data plane unavailable');
            };
            internal.ensureTunnelRuntime('22222222-2222-4222-8222-222222222222');
            await vi.advanceTimersByTimeAsync(0);
            expect(errors).toMatchObject([{ code: ErrCode.TunnelDisconnected }]);
            errors.length = 0;
          }
          if (phase === 'after pre-Ack error') {
            socket.emit('error', new Error('authentication interrupted'));
          }

          socket.readyState = 3;
          socket.emit('close', 1008, Buffer.from(reason));
          await vi.advanceTimersByTimeAsync(0);

          const message =
            reason === 'CLIENT_REVOKED'
              ? 'tunnel credential revoked'
              : acknowledged
                ? 'tunnel connection superseded or credential revoked'
                : 'Control authentication failed, stop reconnecting: control auth failure (code=1008, reason=AUTH_FAILED)';
          expect.soft(errors).toEqual([{ code: ErrCode.AuthFailed, message }]);
          // Check before stop(): teardown must not hide a leaked retry timer.
          expect.soft(vi.getTimerCount()).toBe(0);
          await vi.advanceTimersByTimeAsync(1_500);
          expect(transport.sockets).toHaveLength(1);
          if (!acknowledged) expect(await started).toBeInstanceOf(Error);
        } finally {
          await client.stop();
          await started;
        }
      },
    );
  });
});
