import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors.js';
import { ErrCode } from '../vendor/tunnel-client/index.js';
import type { TunnelClientOptions } from '../vendor/tunnel-client/index.js';
import { TunnelLostError, openTunnelSession } from './tunnel-session.js';
import type { TunnelMintResponse } from './tunnel.types.js';

const MINT: TunnelMintResponse = {
  clientId: 'client-1',
  secret: 'sup3r-s3cret-value',
  controlUrl: 'ws://tunnel.example:7300/ws',
  tunnelAddr: 'tunnel.example:7400',
  expiresAt: '2026-08-24T18:00:00.000Z',
};

/** A stand-in for the vendored `TunnelClient`, with hooks the tests drive. */
function fakeClientFactory(
  behaviour: {
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
  } = {},
) {
  const seen: TunnelClientOptions[] = [];
  const calls = { start: 0, stop: 0 };
  let captured: TunnelClientOptions | undefined;
  const factory = (options: TunnelClientOptions) => {
    seen.push(options);
    captured = options;
    return {
      start: async () => {
        calls.start += 1;
        await (behaviour.start?.() ?? Promise.resolve());
      },
      stop: async () => {
        calls.stop += 1;
        await (behaviour.stop?.() ?? Promise.resolve());
      },
    };
  };
  return {
    factory,
    seen,
    calls,
    /** Fire the client's `onError` the way the vendored client does. */
    emitError: (code: ErrCode, message: string) => captured?.onError?.({ code, message }),
    /** Fire the client's log sink the way the vendored client does. */
    emitLog: (line: string) => captured?.logSink?.('info', line),
  };
}

describe('openTunnelSession — mint and connect', () => {
  it('passes the mint endpoints through verbatim and never defaults them', async () => {
    const fake = fakeClientFactory();
    const session = await openTunnelSession(
      { log: () => {} },
      { mint: async () => MINT, destroy: async () => {}, createClient: fake.factory },
    );
    expect(fake.seen[0]?.controlUrl).toBe(MINT.controlUrl);
    expect(fake.seen[0]?.tunnelAddr).toBe(MINT.tunnelAddr);
    expect(fake.seen[0]?.clientId).toBe(MINT.clientId);
    expect(session.clientId).toBe('client-1');
    expect(session.expiresAt).toBe(MINT.expiresAt);
    await session.close();
  });

  it('never enables the private-network escape hatch', async () => {
    const fake = fakeClientFactory();
    const session = await openTunnelSession(
      { log: () => {} },
      { mint: async () => MINT, destroy: async () => {}, createClient: fake.factory },
    );
    expect(fake.seen[0]?.allowPrivateNetworkTarget).toBe(false);
    await session.close();
  });

  it('deletes the binding AND stops the client when the initial connect fails', async () => {
    const destroyed: string[] = [];
    const fake = fakeClientFactory({ start: () => Promise.reject(new Error('control refused')) });
    let thrown: unknown;
    try {
      await openTunnelSession(
        { log: () => {} },
        {
          mint: async () => MINT,
          destroy: async id => {
            destroyed.push(id);
          },
          createClient: fake.factory,
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).code).toBe('UNAVAILABLE');
    // Both halves matter: a minted-but-unconnected binding is a live
    // credential, and an un-stopped client leaves ref'd reconnect timers that
    // keep the process alive after the command has "finished".
    expect(destroyed).toEqual(['client-1']);
    expect(fake.calls.stop).toBe(1);
  });

  it('deletes the minted binding and rethrows when the client constructor throws', async () => {
    const constructorError = new Error('constructor rejected the minted endpoints');
    const destroy = vi.fn(async () => {});

    await expect(
      openTunnelSession(
        { log: () => {} },
        {
          mint: async () => MINT,
          destroy,
          createClient: () => {
            throw constructorError;
          },
        },
      ),
    ).rejects.toBe(constructorError);
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledWith(MINT.clientId);
  });

  it('deletes the binding when the real client rejects an empty minted secret', async () => {
    const destroy = vi.fn(async () => {});

    await expect(
      openTunnelSession(
        { log: () => {} },
        {
          mint: async () => ({ ...MINT, secret: '' }),
          destroy,
        },
      ),
    ).rejects.toThrow('clientId and secret are required');
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledWith(MINT.clientId);
  });

  it('deletes the binding when the timed-out control handshake also makes stop hang', async () => {
    // The vendored client only resolves `start()` on the first
    // `control-connected` event and retries every non-auth failure
    // indefinitely. While its websocket is still CONNECTING, `stop()` then
    // waits on that same control loop, so start and stop remain coupled to the
    // same pending state just as they are in the real client.
    const pendingControlState = new Promise<void>(() => {});
    const fake = fakeClientFactory({
      start: () => pendingControlState,
      stop: () => pendingControlState,
    });
    const destroyed: string[] = [];
    vi.useFakeTimers();
    try {
      const opening = openTunnelSession(
        { log: () => {}, connectTimeoutMs: 20 },
        {
          mint: async () => MINT,
          destroy: async id => {
            destroyed.push(id);
          },
          createClient: fake.factory,
        },
      );
      const openingResult = opening.then(
        () => ({ status: 'fulfilled' as const }),
        error => ({ status: 'rejected' as const, error }),
      );

      // First timer: connect deadline. Second timer: the hard stop deadline.
      await vi.runOnlyPendingTimersAsync();
      expect(fake.calls.stop).toBe(1);
      await vi.runOnlyPendingTimersAsync();

      expect(destroyed).toEqual(['client-1']);
      await expect(openingResult).resolves.toMatchObject({
        status: 'rejected',
        error: { code: 'UNAVAILABLE' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('openTunnelSession — secret custody', () => {
  it('redacts the secret from the client log sink at any verbosity', async () => {
    const lines: string[] = [];
    const fake = fakeClientFactory();
    const session = await openTunnelSession(
      { log: line => lines.push(line), logLevel: 'debug' },
      { mint: async () => MINT, destroy: async () => {}, createClient: fake.factory },
    );
    fake.emitLog(`[TunnelClient] [debug] Control websocket connected with secret=${MINT.secret}`);
    fake.emitError(ErrCode.TunnelDisconnected, 'Tunnel abc disconnected: ECONNRESET');
    await session.close();
    expect(lines).toContain(
      '[TunnelClient] [debug] Control websocket connected with secret=[REDACTED]',
    );
    expect(lines.join('\n')).not.toContain(MINT.secret);
  });

  it('does not put the secret in the process environment or argv', async () => {
    const fake = fakeClientFactory();
    const session = await openTunnelSession(
      { log: () => {} },
      { mint: async () => MINT, destroy: async () => {}, createClient: fake.factory },
    );
    expect(Object.values(process.env)).not.toContain(MINT.secret);
    expect(process.argv).not.toContain(MINT.secret);
    await session.close();
  });
});

describe('openTunnelSession — fatal auth close', () => {
  it('records a fatal reason when the control channel closes with AUTH_FAILED', async () => {
    const fake = fakeClientFactory();
    const fatals: unknown[] = [];
    const session = await openTunnelSession(
      { log: () => {}, onFatal: reason => fatals.push(reason) },
      { mint: async () => MINT, destroy: async () => {}, createClient: fake.factory },
    );
    expect(session.fatalReason()).toBeUndefined();
    fake.emitError(ErrCode.AuthFailed, 'Control authentication failed, stop reconnecting');
    expect(session.fatalReason()).toBe('auth-failed');
    expect(fatals).toEqual(['auth-failed']);
    await session.close();
  });

  it('does NOT treat a recoverable disconnect as fatal', async () => {
    // The client reconnects with the SAME credentials, and the server still
    // holds the registration, so the in-flight run survives — reporting this
    // as fatal would cancel a run that was about to keep working.
    const fake = fakeClientFactory();
    const session = await openTunnelSession(
      { log: () => {} },
      { mint: async () => MINT, destroy: async () => {}, createClient: fake.factory },
    );
    fake.emitError(ErrCode.ControlDisconnected, 'Control disconnected: ECONNRESET');
    fake.emitError(ErrCode.TunnelDisconnected, 'Tunnel t1 disconnected');
    fake.emitError(ErrCode.TargetConnectFailed, 'Target connect failed');
    expect(session.fatalReason()).toBeUndefined();
    await session.close();
  });
});

describe('openTunnelSession — teardown', () => {
  it('stops the client before deleting the binding, every time', async () => {
    const order: string[] = [];
    const fake = fakeClientFactory({
      stop: async () => {
        order.push('stop');
      },
    });
    const session = await openTunnelSession(
      { log: () => {} },
      {
        mint: async () => MINT,
        destroy: async () => {
          order.push('destroy');
        },
        createClient: fake.factory,
      },
    );
    await session.close();
    expect(order).toEqual(['stop', 'destroy']);
  });

  it('still deletes the binding when stopping the client throws', async () => {
    const destroyed: string[] = [];
    const fake = fakeClientFactory({ stop: () => Promise.reject(new Error('boom')) });
    const session = await openTunnelSession(
      { log: () => {} },
      {
        mint: async () => MINT,
        destroy: async id => {
          destroyed.push(id);
        },
        createClient: fake.factory,
      },
    );
    await expect(session.close()).resolves.toBeUndefined();
    expect(destroyed).toEqual(['client-1']);
  });

  it('warns but does not throw when the delete fails — the TTL is the backstop', async () => {
    const lines: string[] = [];
    const fake = fakeClientFactory();
    const session = await openTunnelSession(
      { log: line => lines.push(line) },
      {
        mint: async () => MINT,
        destroy: () => Promise.reject(new Error('network down')),
        createClient: fake.factory,
      },
    );
    await expect(session.close()).resolves.toBeUndefined();
    expect(lines.join('\n')).toMatch(/could not delete the tunnel/i);
  });

  it('is idempotent — a second close does not delete twice', async () => {
    const destroyed: string[] = [];
    const fake = fakeClientFactory();
    const session = await openTunnelSession(
      { log: () => {} },
      {
        mint: async () => MINT,
        destroy: async id => {
          destroyed.push(id);
        },
        createClient: fake.factory,
      },
    );
    await session.close();
    await session.close();
    expect(destroyed).toEqual(['client-1']);
    expect(fake.calls.stop).toBe(1);
  });
});

describe('openTunnelSession — adopting a caller-supplied client', () => {
  it('does not mint, and does not delete a binding it did not create', async () => {
    const mint = vi.fn();
    const destroy = vi.fn();
    const fake = fakeClientFactory();
    const session = await openTunnelSession(
      {
        log: () => {},
        adopt: { clientId: 'someone-elses', expiresAt: '2026-08-24T19:00:00.000Z' },
      },
      { mint: mint as never, destroy: destroy as never, createClient: fake.factory },
    );
    expect(mint).not.toHaveBeenCalled();
    expect(session.adopted).toBe(true);
    // No secret is available for an adopted client, so nothing is connected
    // here either — the process that minted it owns the connection.
    expect(fake.calls.start).toBe(0);
    await session.close();
    expect(destroy).not.toHaveBeenCalled();
  });
});

describe('TunnelLostError', () => {
  it('is an UNAVAILABLE ApiError so the caller exits 10, not 1', () => {
    const err = new TunnelLostError('auth-failed', 'run-1');
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toMatch(/tunnel/i);
  });
});
