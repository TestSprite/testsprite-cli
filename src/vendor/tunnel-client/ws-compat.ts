/**
 * VENDOR DELTA (not upstream). A minimal `ws`-shaped facade over undici's
 * WHATWG `WebSocket`, so the vendored tunnel client keeps its upstream body
 * while this CLI adds no `ws` dependency: `undici` is already a runtime
 * dependency here (`lib/proxy.ts` uses its `EnvHttpProxyAgent`), and its
 * `WebSocket` is the same RFC 6455 implementation Node ships as the global.
 *
 * Only the surface `client.ts` actually touches is implemented — `on`,
 * `send`, `close`, `pong`, `readyState`, and the statics `CONNECTING`/`OPEN`. Anything else
 * is deliberately absent, and an unknown event name throws rather than being
 * silently accepted, so a future upstream sync that reaches for a new `ws` API
 * fails loudly instead of quietly never firing.
 *
 * Two behavioural notes, both a consequence of WHATWG's narrower surface:
 *
 *   - **`ping` never fires and `pong()` is a no-op.** The WHATWG API does not
 *     expose control frames; undici answers a server PING with a PONG inside
 *     its own receiver, which is exactly what upstream's handler did by hand.
 *     Registering the listener is still accepted so the upstream line stays
 *     compilable and diffable.
 *   - **The control socket uses the process-global undici dispatcher**, so an
 *     `HTTP(S)_PROXY` this CLI honours (`lib/proxy.ts`) also carries the
 *     control WebSocket. Deliberate — but note it does NOT help the tunnel
 *     DATA plane, which is a raw `net.connect` and bypasses proxies entirely.
 *     `lib/tunnel-session.ts` warns about that asymmetry rather than
 *     pretending a proxied environment is supported.
 *
 * ## Why `close()` cannot just call `WebSocket.close()` and wait
 *
 * Read straight from undici's own source (`lib/web/websocket/connection.js`):
 * `WebSocket.close()` on an OPEN connection sends a Close frame and sets the
 * ready state to CLOSING — nothing more. It does not abort the underlying
 * connection and does not time out; that only happens for a CONNECTING
 * socket (`failWebsocketConnection`, upstream `client.ts` VENDOR DELTA #8's
 * territory). If the peer never sends its own Close frame back — a redeploy
 * mid-handshake, a proxy that swallows the FIN, a server too busy to answer —
 * the ready state sits at CLOSING forever, the JS `'close'` event never
 * fires, and the socket stays an active libuv handle. Confirmed empirically:
 * against a stub that completes the WS upgrade and then never answers a
 * Close frame, `TunnelClient.stop()` (which awaits exactly this event) never
 * resolves, and `process.getActiveResourcesInfo()` shows the same
 * `TCPSocketWrap` present indefinitely. There is no public undici API to
 * force it — `#handler.socket` is a true private class field, and even a
 * dedicated per-connection `Dispatcher.destroy()` does nothing once the
 * connection has been upgraded (verified: undici hands the socket off to the
 * `WebSocket` instance at that point, detaching it from the dispatcher's own
 * bookkeeping).
 *
 * So `close()` here arms a short local grace timer alongside the real
 * WHATWG close. If the peer answers within it, the real `'close'` event
 * settles everything and the timer is a no-op. If it doesn't, we settle
 * locally instead of waiting forever:
 *
 *   - `.unref()` (never `.destroy()`) the raw socket, captured at connect
 *     time via undici's documented `undici:client:connected` diagnostics
 *     channel — a public, if "Experimental"-labeled, hook that hands us the
 *     `net.Socket` undici itself dialed, filtered to this connection's own
 *     host/port so an unrelated concurrent undici connection is never
 *     mistaken for it. `unref()` is the right tool and `.destroy()` is not:
 *     by the time the grace period expires we have already sent our own
 *     Close frame and have no further use for the socket — there is no
 *     work left that it is the last thing holding open, which is exactly
 *     the bar this codebase's timer-`unref` doctrine sets (contrast the
 *     rejected fix elsewhere in this repo, where `unref`ing a POLLING
 *     timer let a process exit before its work was done — this is the
 *     opposite situation, a corpse the peer refuses to bury after the work
 *     is already finished). `.destroy()` would instead reset the still-open
 *     TCP connection out from under a peer that might complete its side a
 *     moment later, for no benefit we need.
 *   - Synthesize the `'close'` event ourselves (code 1006, "abnormal
 *     closure" — the conventional code for "the connection just went away",
 *     and never confused with an auth failure: `client.ts`'s
 *     `isAuthFailureClose` only matches code 1008) so `client.ts`'s own
 *     unmodified `ws.on("close", ...)` handler runs exactly as it would for
 *     a real close: it clears the heartbeat interval, resolves the
 *     `connectControl()` promise `runControlLoop` is stuck awaiting, and
 *     unwinds `stop()`'s own `Promise.allSettled`. No vendored file needs to
 *     change for this — the synthetic close travels through the exact same,
 *     already-correct listener.
 *
 * A proxied connection is NOT a miss, which is worth stating because it looks
 * like one: with `EnvHttpProxyAgent` installed as the global dispatcher,
 * undici publishes TWO `undici:client:connected` events — the physical dial to
 * the proxy, whose `connectParams` carry the PROXY's host/port, and a second
 * one from the per-origin `Client` it creates internally, whose `connectParams`
 * carry the TARGET's. The filter below matches the second and captures the
 * same live socket (physically connected to the proxy, tunneled to the
 * target). Verified against undici 7.29.0 with a real CONNECT proxy: a `--local`
 * teardown under `HTTP_PROXY` exits in the same ~1.4s as without one. The `wss:`
 * variant TLS-wraps that tunneled socket and was not exercised — it is
 * analogous by code reading only.
 *
 * If capture DOES miss — the channel never fires, or a future undici publishes
 * a different payload shape — the synthetic close still clears the heartbeat,
 * but the control socket stays ref'd and **the original hang comes back**. That
 * is the honest statement: this is not a socket "left for process exit to
 * reap", because nothing forces this process to exit — a ref'd socket IS the
 * bug. Treat any change to the filter as load-bearing. Never throws either way:
 * a diagnostics hook failing must not break teardown.
 */

import diagnosticsChannel from 'node:diagnostics_channel';
import type { Socket as NetSocket } from 'node:net';
import type { CloseEvent, ErrorEvent, MessageEvent } from 'undici';
import { WebSocket as UndiciWebSocket } from 'undici';

type CloseListener = (code: number, reason: Buffer) => void;
type MessageListener = (payload: string | Buffer) => void;
type ErrorListener = (err: Error) => void;
type OpenListener = () => void;
type PingListener = (data: Buffer) => void;

/**
 * How long `close()` waits for the peer to finish the WHATWG closing
 * handshake before giving up and settling locally (see the class docstring).
 * Deliberately well under `TUNNEL_CLIENT_STOP_TIMEOUT_MS`
 * (`lib/tunnel-session.ts`, 2000ms) so the caller's own bounded race around
 * `client.stop()` sees OUR settle win, not its own timeout race — the
 * process should learn its socket/timer are released, not just stop waiting
 * to hear about it.
 */
export const CLOSE_GRACE_MS = 1200;

/**
 * The diagnostics_channel this module listens to in order to capture the raw
 * socket a WebSocket connection is running over. Documented at
 * https://github.com/nodejs/undici/blob/main/docs/docs/api/DiagnosticsChannel.md#undiciclientconnected
 * — payload is `{ socket, connectParams, connector }`.
 */
const CONNECTED_CHANNEL = 'undici:client:connected';

/** The subset of `undici:client:connected`'s `connectParams` this filter reads. */
export interface ConnectParams {
  hostname?: unknown;
  port?: unknown;
}

/**
 * Does this `undici:client:connected` event belong to the WebSocket we are
 * trying to capture?
 *
 * Exported, and its own function, because it is load-bearing and subtle: a
 * miss here is silent, and its consequence is the original close-hang coming
 * back with every test still green (see the class docstring). Reviewing a
 * predicate is easier than reviewing it inlined in a subscription callback.
 *
 * Both ports are normalized to the scheme default, and that symmetry is the
 * fix: undici publishes `connectParams.port` straight from a WHATWG URL, which
 * leaves a default-scheme port IMPLICIT — `ws://host/control` arrives as `''`,
 * and `Number('') === 0`. The target side was already being defaulted to
 * 80/443 while the event side was not, so capture missed for every
 * implicit-port control URL, proxy or no proxy.
 *
 * Host is compared exactly. A proxied connection publishes two events — the
 * physical dial to the proxy, and a second one from the per-origin `Client`
 * undici creates internally — and only the second carries the target's host,
 * which is precisely the one worth capturing.
 */
export function connectEventMatchesTarget(
  connectParams: ConnectParams | undefined,
  target: URL,
): boolean {
  if (connectParams?.hostname !== target.hostname) return false;
  const defaultPort = target.protocol === 'wss:' ? 443 : 80;
  const normalize = (raw: unknown): number =>
    raw === '' || raw === undefined || raw === null ? defaultPort : Number(raw);
  return normalize(connectParams.port) === normalize(target.port);
}

/**
 * Normalise a WHATWG message payload to the `string | Buffer` union the
 * vendored client's `typeof payload === "string" ? … : payload.toString()`
 * branch expects. Text frames arrive as strings; a binary frame (which this
 * protocol never sends) arrives as an ArrayBuffer and is wrapped rather than
 * dropped, so an unexpected frame surfaces as a JSON parse failure instead of
 * a `payload.toString is not a function` crash.
 */
export function toPayload(data: unknown): string | Buffer {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return String(data);
}

/**
 * Pull a real `Error` out of undici's ErrorEvent. `.error` is typed as an
 * `Error` but is not guaranteed to be populated for every failure mode, so
 * `.message` is the fallback and a generic error is the floor — the vendored
 * client passes whatever comes out to `toErrorMessage()` and to `reject()`.
 */
export function toError(event: unknown): Error {
  const candidate = (event as { error?: unknown } | null)?.error;
  if (candidate instanceof Error) return candidate;
  const message = (event as { message?: unknown } | null)?.message;
  return new Error(typeof message === 'string' && message.length > 0 ? message : 'websocket error');
}

export class WsCompatSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;

  private readonly socket: UndiciWebSocket;
  /** Captured via `undici:client:connected`, if it fired — see the class docstring. */
  private rawSocket: NetSocket | undefined;
  private closeListener: CloseListener | undefined;
  private closeSettled = false;
  private closeGraceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly unsubscribeConnected: () => void;

  constructor(url: URL | string) {
    this.unsubscribeConnected = this.captureRawSocket(url);
    this.socket = new UndiciWebSocket(url);
    // Whichever comes first, the capture window is over the moment this
    // connection attempt is decided — see captureRawSocket's docstring.
    this.socket.addEventListener('open', () => this.unsubscribeConnected(), { once: true });
    this.socket.addEventListener('error', () => this.unsubscribeConnected(), { once: true });
  }

  /**
   * Subscribe to `undici:client:connected` just long enough to grab the raw
   * `net.Socket` for THIS connection, filtered by target host/port so an
   * unrelated concurrent undici connection elsewhere in the process (e.g.
   * this CLI's own HTTP polling) is never mistaken for it. See the class
   * docstring for why `close()` needs this at all. Returns an idempotent
   * unsubscribe closure. Never throws: a diagnostics hook failing must not
   * break the connection it exists only to make teardown more graceful for.
   */
  private captureRawSocket(url: URL | string): () => void {
    try {
      const target = typeof url === 'string' ? new URL(url) : url;
      const channel = diagnosticsChannel.channel(CONNECTED_CHANNEL);
      const onConnected = (message: unknown): void => {
        const { socket, connectParams } = (message ?? {}) as {
          socket?: unknown;
          connectParams?: ConnectParams;
        };
        if (socket !== undefined && connectEventMatchesTarget(connectParams, target)) {
          this.rawSocket = socket as NetSocket;
          channel.unsubscribe(onConnected);
        }
      };
      channel.subscribe(onConnected);
      return () => channel.unsubscribe(onConnected);
    } catch {
      // Degrade to "no captured socket": close() still settles via the
      // synthetic-close path, just without the unref step.
      return () => {};
    }
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  on(event: 'open', listener: OpenListener): this;
  on(event: 'message', listener: MessageListener): this;
  on(event: 'error', listener: ErrorListener): this;
  on(event: 'close', listener: CloseListener): this;
  on(event: 'ping', listener: PingListener): this;
  on(
    event: 'open' | 'message' | 'error' | 'close' | 'ping',
    listener: OpenListener | MessageListener | ErrorListener | CloseListener | PingListener,
  ): this {
    switch (event) {
      case 'open':
        this.socket.addEventListener('open', () => {
          (listener as OpenListener)();
        });
        return this;
      case 'message':
        this.socket.addEventListener('message', (ev: MessageEvent) => {
          (listener as MessageListener)(toPayload(ev.data));
        });
        return this;
      case 'error':
        this.socket.addEventListener('error', (ev: ErrorEvent) => {
          (listener as ErrorListener)(toError(ev));
        });
        return this;
      case 'close':
        // Stored rather than forwarded directly: settleClose() is also the
        // target of the synthetic close below, and either path must reach
        // this exact listener exactly once. See the class docstring.
        this.closeListener = listener as CloseListener;
        this.socket.addEventListener('close', (ev: CloseEvent) => {
          this.settleClose(ev.code, Buffer.from(ev.reason ?? '', 'utf8'));
        });
        return this;
      case 'ping':
        // See the module docstring: undici answers PING internally, so there
        // is nothing to forward. Accepted, never invoked.
        return this;
      default:
        throw new Error(`WsCompatSocket: unsupported event "${String(event)}"`);
    }
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
    this.armCloseGrace();
  }

  /** No-op — see the module docstring. */
  pong(_data?: Buffer): void {
    void _data;
  }

  /**
   * Invoke the registered close listener exactly once, whichever of "the
   * real WHATWG close event" or "our own grace-timeout settle" gets there
   * first — a real close that arrives after the grace timer already fired is
   * a no-op here, and vice versa.
   */
  private settleClose(code: number, reason: Buffer): void {
    if (this.closeSettled) return;
    this.closeSettled = true;
    if (this.closeGraceTimer !== undefined) {
      clearTimeout(this.closeGraceTimer);
      this.closeGraceTimer = undefined;
    }
    this.unsubscribeConnected();
    this.closeListener?.(code, reason);
  }

  /**
   * See the class docstring's "Why `close()` cannot just call
   * `WebSocket.close()` and wait" section. A no-op if the real close has
   * already settled synchronously (true for a CONNECTING socket — undici's
   * own `failWebsocketConnection` handles that case completely, with no
   * grace period needed) or if a grace timer is already armed.
   */
  private armCloseGrace(): void {
    if (this.closeSettled || this.closeGraceTimer !== undefined) return;
    this.closeGraceTimer = setTimeout(() => {
      this.closeGraceTimer = undefined;
      // The peer never finished the closing handshake within the grace
      // window. We already sent our own Close frame and have no further use
      // for this socket, so unref (never destroy — see the class docstring)
      // it, then settle locally so client.ts's own unmodified close handler
      // still runs (clears the heartbeat interval, unwinds the control
      // loop). 1006 ("abnormal closure") is never mistaken for an auth
      // failure — client.ts's isAuthFailureClose only matches code 1008.
      this.rawSocket?.unref();
      this.settleClose(
        1006,
        Buffer.from('local close timeout: peer did not complete the WS closing handshake', 'utf8'),
      );
    }, CLOSE_GRACE_MS);
  }
}

export default WsCompatSocket;
