import { EventEmitter, once } from "node:events";
import dns from "node:dns";
import net, { Socket } from "node:net";
import { Duplex } from "node:stream";
// VENDOR DELTA: `ws` -> undici-backed facade. See ./ws-compat.ts.
import WebSocket from "./ws-compat.js";
// VENDOR DELTA: `lodash` -> three local predicates. See ./lodash-lite.ts.
import { isNumber, isPlainObject, isString } from "./lodash-lite.js";

import { encodeFrame, readTypedFrame } from "./protocol.js";
// VENDOR DELTA: no CLIENT_VERSION (no package.json import) and no endpoint
// defaults — `controlUrl`/`tunnelAddr` are required and come from the mint
// response. See ./config.ts.
import {
  DEFAULT_ALLOW_PRIVATE_NETWORK_TARGET,
  DEFAULT_AUTH_TIMEOUT_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_RECONNECT_MS,
  DEFAULT_TARGET_CONNECT_TIMEOUT_MS,
} from "./config.js";
import {
    ClientToServerControlMessage, ErrCode, LogLevel,
    ServerToClientControlMessage,
    StreamOpenRequestFrame,
    TunnelClientOptions,
    TunnelHelloFrame,
} from "./types.js";

import {
  Client as createYamuxClientSession,
  YamuxStreamResetError,
  YamuxSession,
} from "@llmcode/yamux-ts";

// VENDOR DELTA: `Record<string, number>` -> `Record<LogLevel, number>`, and
// the two `keyof typeof LEVEL_ORDER` parameters below become `LogLevel`. This
// CLI compiles with `noUncheckedIndexedAccess`, under which indexing a string
// index signature yields `number | undefined`; a mapped type over the four
// known levels does not. Type-only — no behaviour change. Worth upstreaming.
const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const STREAM_CLOSE_TIMEOUT_MS = 1_500;
const CONTROL_AUTHENTICATION_FAILED = Symbol("control-authentication-failed");

export class TunnelClient extends EventEmitter {
  private readonly options: Required<Omit<TunnelClientOptions, "clientId" | "secret">> &
    Pick<TunnelClientOptions, "clientId" | "secret">;

  private running = false;
  private controlConnected = false;
  private controlWs?: WebSocket;
  private controlLoopTask?: Promise<void>;
  // VENDOR DELTA: monotonically scopes authentication readiness to one
  // control socket. A reconnect gets a new generation, so an Ack emitted by
  // an older socket cannot satisfy a later start() wait. See VENDOR.md #14.
  private controlConnectionGeneration = 0;
  private allowTunnelReconnect = true;
  private readonly tunnelRuntimes = new Map<string, TunnelRuntime>();
  // VENDOR DELTA: reconnect backoffs are tied to this lifecycle controller so stop() cancels
  // both control and tunnel sleeps instead of awaiting a still-ref'd timer. See VENDOR.md #9.
  private reconnectDelayController = new AbortController();
  // VENDOR DELTA: every socket this client dials on behalf of an inbound proxy
  // stream (connectOnce). Tearing down a tunnel data session (runtime.socket)
  // does NOT reach these independent per-stream sockets, and a browser
  // keep-alive target that holds the connection open and sends nothing parks
  // proxyStreams()'s copyOneWay(target, …) forever, so its finally-cleanup never
  // runs. On teardown such ESTABLISHED sockets stay ref'd and keep the event loop
  // alive for the remote's idle timeout (minutes) — the visible symptom is a
  // --local run whose Ctrl-C / --timeout appears to hang. stop()/CloseTunnel
  // destroy these directly. See VENDOR.md #13.
  private readonly activeTargetSockets = new Set<Socket>();

  constructor(options: TunnelClientOptions) {
    super();

    if (!options.clientId || !options.secret) {
      throw new Error("clientId and secret are required");
    }

    this.options = {
      clientId: options.clientId,
      secret: options.secret,
      controlUrl: options.controlUrl,
      tunnelAddr: options.tunnelAddr,
      authTimeoutMs: options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
      heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      reconnectMs: options.reconnectMs ?? DEFAULT_RECONNECT_MS,
      logLevel: options.logLevel ?? DEFAULT_LOG_LEVEL,
      allowPrivateNetworkTarget: options.allowPrivateNetworkTarget ?? DEFAULT_ALLOW_PRIVATE_NETWORK_TARGET,
      onError: options.onError ?? (() => null),
      // VENDOR DELTA: upstream logs through `console.log`/`console.warn`,
      // which would write to STDOUT and corrupt `--output json` — a hard
      // contract in this CLI. The default sink is stderr-only, and the CLI
      // injects its own so tunnel chatter obeys `--verbose`/`--debug`.
      logSink:
        options.logSink ??
        ((_level: LogLevel, line: string) => {
          process.stderr.write(`${line}\n`);
        }),
    };
  }

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }
    if (this.reconnectDelayController.signal.aborted) {
      this.reconnectDelayController = new AbortController();
    }
    this.running = true;

    const expectedConnectionGeneration = this.controlConnectionGeneration + 1;
    this.controlLoopTask = this.runControlLoop();

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        this.off("control-authenticated", onAuthenticated);
        this.off(CONTROL_AUTHENTICATION_FAILED, onAuthenticationFailed);
      };

      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback();
      };

      const onAuthenticated = (connectionGeneration: number) => {
        if (connectionGeneration === expectedConnectionGeneration) {
          settle(resolve);
        }
      };

      const onAuthenticationFailed = (connectionGeneration: number, error: Error) => {
        if (connectionGeneration === expectedConnectionGeneration) {
          settle(() => reject(error));
        }
      };

      const onLoopEnd = () => {
        settle(() => reject(new Error("Control loop ended before connecting")));
      };

      this.on("control-authenticated", onAuthenticated);
      this.on(CONTROL_AUTHENTICATION_FAILED, onAuthenticationFailed);
      this.controlLoopTask?.then(onLoopEnd);
      const timeout = setTimeout(() => {
        settle(() =>
          reject(
            new Error(
              `The tunnel server accepted the connection but never acknowledged authentication within ${this.options.authTimeoutMs}ms`,
            ),
          ),
        );
      }, this.options.authTimeoutMs);
    });

    this.log("info", "Tunnel client started");
  }

  public async stop(): Promise<void> {
    this.running = false;
    this.reconnectDelayController.abort();

    // VENDOR DELTA: also close a socket still in CONNECTING. Upstream only
    // closes an OPEN one, so a control plane that accepts TCP and never
    // completes the WebSocket handshake leaves the socket untouched — and the
    // `await this.controlLoopTask` below then waits on the very handshake
    // nothing is going to finish. `stop()` never returns, so the caller's
    // teardown never reaches the credential delete that follows it.
    if (
      this.controlWs &&
      (this.controlWs.readyState === WebSocket.OPEN ||
        this.controlWs.readyState === WebSocket.CONNECTING)
    ) {
      this.controlWs.close();
    }

    this.stopAllTunnelRuntimes();

    const tunnelTasks = Array.from(this.tunnelRuntimes.values(), (runtime) => runtime.task);
    await Promise.allSettled([this.controlLoopTask, ...tunnelTasks]);

    this.controlWs = undefined;
    this.tunnelRuntimes.clear();

    this.log("info", "Tunnel client stopped");
  }

  private async runControlLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.connectControl();
      } catch (err) {
        if (isControlAuthFailureError(err)) {
          const message = `Control authentication failed, stop reconnecting: ${toErrorMessage(err)}`;
          this.reportError(ErrCode.AuthFailed, message, "error");
          this.running = false;
          this.controlConnected = false;
          this.stopAllTunnelRuntimes();
          return;
        }
        this.reportError(ErrCode.ControlDisconnected, `Control disconnected: ${toErrorMessage(err)}`);
      }

      if (this.running) {
        await delay(this.options.reconnectMs, this.reconnectDelayController.signal);
      }
    }
  }

  private async runTunnelLoop(
    tunnelConnectionId: string,
    runtime: TunnelRuntime,
  ): Promise<void> {
    try {
      while (this.running) {
        if (!this.allowTunnelReconnect || runtime.stopRetryOnDisconnect) {
          return;
        }

        try {
          await this.connectTunnel(tunnelConnectionId, runtime);
        } catch (err) {
          this.reportError(ErrCode.TunnelDisconnected, `Tunnel ${tunnelConnectionId} disconnected: ${toErrorMessage(err)}`);
        }

        if (!this.allowTunnelReconnect || runtime.stopRetryOnDisconnect) {
          this.log("info", `Tunnel ${tunnelConnectionId} reconnect disabled`);
          return;
        }

        if (this.running) {
          await delay(this.options.reconnectMs, this.reconnectDelayController.signal);
        }
      }
    } finally {
      runtime.socket = undefined;
      runtime.session = undefined;
      this.tunnelRuntimes.delete(tunnelConnectionId);
    }
  }

  private connectControl(): Promise<void> {
    return new Promise((resolve, reject) => {
      const connectionGeneration = ++this.controlConnectionGeneration;
      const controlUrl = new URL(this.options.controlUrl);
      controlUrl.searchParams.set("client_id", this.options.clientId);

      const ws = new WebSocket(controlUrl);
      this.controlWs = ws;

      let heartbeatTimer: NodeJS.Timeout | undefined;
      let opened = false;
      let authenticationSettled = false;

      const failAuthentication = (error: Error) => {
        if (authenticationSettled) {
          return;
        }
        authenticationSettled = true;
        this.emit(CONTROL_AUTHENTICATION_FAILED, connectionGeneration, error);
      };

      const cleanup = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
        }
      };

      ws.on("open", () => {
        opened = true;
        this.controlConnected = true;
        this.log("info", "Control websocket connected");
        this.emit("control-connected");

        this.sendControlMessage(ws, {
          type: "Auth",
          payload: {
            secret: this.options.secret,
          },
        });
        // this.sendControlMessage(ws, {
        //   type: "Hello",
        //   payload: {
        //     client_id: this.options.clientId,
        //     version: CLIENT_VERSION,
        //   },
        // });
        heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            this.sendControlMessage(ws, { type: "Heartbeat" });
          }
        }, this.options.heartbeatMs);
      });

      ws.on("ping", (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.pong(data);
        }
      });

      ws.on("message", (payload) => {
        const text = typeof payload === "string" ? payload : payload.toString("utf8");
        this.emit("control-message", text);
        this.log("debug", `Control message: ${text}`);

        const message = this.parseControlMessage(text);
        if (!message) {
          return;
        }

        if (message.type === "Ack") {
          if (!authenticationSettled) {
            authenticationSettled = true;
            this.emit("control-authenticated", connectionGeneration);
          }
          return;
        }

        if (message.type === "RequestTunnel") {
          this.log("debug", `RequestTunnel received: ${message.payload.tunnel_connection_id}`);
          this.allowTunnelReconnect = true;
          this.ensureTunnelRuntime(message.payload.tunnel_connection_id);
          return;
        }

        if (message.type === "CloseTunnel") {
          this.allowTunnelReconnect = false;
          this.log("info", `Received close tunnel instruction: ${message.payload.reason}`);
          this.stopAllTunnelRuntimes();
        }
      });

      ws.on("error", (err) => {
        cleanup();
        failAuthentication(
          new Error(
            `Control websocket errored before authentication was acknowledged: ${toErrorMessage(err)}`,
          ),
        );
        if (!opened) {
          this.controlConnected = false;
          this.stopAllTunnelRuntimes();
          reject(err);
          return;
        }
        this.log("warn", `Control websocket error: ${toErrorMessage(err)}`);
      });

      ws.on("close", (code, reasonBuffer) => {
        cleanup();
        this.controlConnected = false;
        this.stopAllTunnelRuntimes();
        this.emit("control-disconnected");

        const reason = reasonBuffer.toString("utf8");
        failAuthentication(
          new Error(
            `Control websocket closed before authentication was acknowledged (code=${code}, reason=${reason || "<empty>"})`,
          ),
        );
        this.log("warn", `Control websocket closed (code=${code}, reason=${reason || "<empty>"})`);
        if (isAuthFailureClose(code, reason)) {
          reject(new ControlAuthFailureError(code, reason));
          return;
        }

        resolve();
      });
    });
  }

  private sendControlMessage(ws: WebSocket, message: ClientToServerControlMessage): void {
    ws.send(JSON.stringify(message));
  }

  private parseControlMessage(messageText: string): ServerToClientControlMessage | undefined {
    try {
      const message = JSON.parse(messageText) as { type?: string; payload?: unknown };
      if (message.type === "Ack") {
        return { type: "Ack" };
      }

      if (message.type === "CloseTunnel") {
        const payload = message.payload as { reason?: unknown };
        if (!isPlainObject(payload) || !isString(payload.reason)) {
          return undefined;
        }
        return {
          type: "CloseTunnel",
          payload: {
            reason: payload.reason,
          },
        };
      }

      if (message.type !== "RequestTunnel" || !isPlainObject(message.payload)) {
        return undefined;
      }

      const payload = message.payload as {
        tunnel_connection_id?: unknown;
        target_host?: unknown;
        target_port?: unknown;
      };

      if (
        !isString(payload.tunnel_connection_id)
        || !isString(payload.target_host)
        || !isNumber(payload.target_port)
      ) {
        return undefined;
      }

      return {
        type: "RequestTunnel",
        payload: {
          tunnel_connection_id: payload.tunnel_connection_id,
          target_host: payload.target_host,
          target_port: payload.target_port,
        },
      };
    } catch {
      return undefined;
    }
  }

  private ensureTunnelRuntime(tunnelConnectionId: string): void {
    if (!this.running || !this.controlConnected) {
      return;
    }

    const existing = this.tunnelRuntimes.get(tunnelConnectionId);
    if (existing) {
      // If server asks again while runtime is shutting down, restore retry intent.
      existing.stopRetryOnDisconnect = false;
      this.log("debug", `Tunnel runtime already active: ${tunnelConnectionId}`);
      return;
    }

    const runtime: TunnelRuntime = {
      stopRetryOnDisconnect: false,
      task: Promise.resolve(),
    };

    runtime.task = this.runTunnelLoop(tunnelConnectionId, runtime);
    this.tunnelRuntimes.set(tunnelConnectionId, runtime);
    this.log("info", `Starting tunnel runtime on demand: ${tunnelConnectionId}`);
  }

  private connectTunnel(
    tunnelConnectionId: string,
    runtime: TunnelRuntime,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const tunnelAddress = parseTunnelAddr(this.options.tunnelAddr);
      const socket = net.connect({
        host: tunnelAddress.host,
        port: tunnelAddress.port,
      });

      runtime.socket = socket;

      let handshakeDone = false;
      let settled = false;

      const settle = (next: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        next();
      };

      socket.once("error", (err) => {
        if (!handshakeDone) {
          settle(() => reject(err));
        }
      });

      const finalizeClose = () => {
        settle(() => {
          this.emit("tunnel-disconnected", tunnelConnectionId);
          this.log("warn", `Tunnel tcp closed: ${tunnelConnectionId}`);
          resolve();
        });
      };

      socket.once("connect", () => {
        if (!this.running || !this.allowTunnelReconnect || runtime.stopRetryOnDisconnect) {
          socket.destroy();
          settle(resolve);
          return;
        }

        this.log("info", `Tunnel tcp connected: ${tunnelConnectionId}`);

        const hello: TunnelHelloFrame = {
          client_id: this.options.clientId,
          secret: this.options.secret,
          tunnel_connection_id: tunnelConnectionId,
        };

        socket.write(encodeFrame(hello));
        handshakeDone = true;

        const session = createYamuxClientSession(socket);
        runtime.session = session;

        session.on("stream", (stream: Duplex) => {
          void this.handleIncomingStream(stream);
        });

        session.on("error", (err: Error) => {
          if (isBenignCloseError(err)) {
            this.log("debug", `Yamux benign close (${tunnelConnectionId}): ${toErrorMessage(err)}`);
            return;
          }

          this.log("warn", `Yamux error (${tunnelConnectionId}): ${toErrorMessage(err)}`);

          if (!socket.destroyed) {
            socket.destroy();
          }
        });

        session.on("close", () => {
          this.log("debug", `Yamux session closed: ${tunnelConnectionId}`);
        });

        this.emit("tunnel-connected", tunnelConnectionId);
      });

      socket.once("close", finalizeClose);
      socket.once("end", finalizeClose);
    });
  }

  private stopAllTunnelRuntimes(): void {
    for (const runtime of this.tunnelRuntimes.values()) {
      runtime.stopRetryOnDisconnect = true;
      if (runtime.session) {
        runtime.session.close();
      }
      if (runtime.socket && !runtime.socket.destroyed) {
        runtime.socket.destroy();
      }
    }
    // VENDOR DELTA: destroy every outstanding proxy target socket. See the
    // `activeTargetSockets` field comment. Iterate a copy: destroy() emits
    // 'close' synchronously for an already-connected socket, and that handler
    // deletes from the live set.
    for (const socket of [...this.activeTargetSockets]) {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
    this.activeTargetSockets.clear();
  }

  private async handleIncomingStream(stream: Duplex): Promise<void> {
    try {
      const frame = await readTypedFrame(stream, isStreamOpenRequestFrame);
      const targetHost = frame.target_host;
      const targetPort = frame.target_port;
      const logContext = `${frame.request_id} (${frame.inbound_request_id}, ${frame.tunnel_connection_id}, stream ${frame.mux_stream_id})`;
      this.log("debug", `Stream open: ${logContext}`);

      this.log(
        "info",
        `Open request ${logContext}: ${targetHost}:${targetPort}`,
      );

      const target = await this.connectTarget(targetHost, targetPort);
      this.log("debug", `Target connected: ${logContext}`);

      await this.proxyStreams(stream, target, logContext);
      this.log("debug", `Stream proxy finished: ${logContext}`);
    } catch (err) {
      if (err instanceof YamuxStreamResetError) {
        this.log("debug", `Stream reset while handling inbound stream: ${toErrorMessage(err)}`);
      } else if (err instanceof BlockedTargetError) {
        this.reportError(ErrCode.BlockedTargetRejected, `Rejecting stream open request targeting a blocked (private/internal) address: ${toErrorMessage(err)}`);
      } else if (err instanceof TargetConnectError) {
        this.reportError(ErrCode.TargetConnectFailed, `Target connect failed: ${toErrorMessage(err)}`);
      } else {
        this.reportError(ErrCode.StreamFailed, `Failed handling tunnel stream: ${toErrorMessage(err)}`);
      }
      if (!stream.destroyed && !isBenignCloseError(err)) {
        stream.destroy();
      }
    }
  }

  private async proxyStreams(stream: Duplex, target: Socket, logContext: string): Promise<void> {
    const onTargetError = (err: Error) => {
      if (isBenignCloseError(err)) {
        this.log("debug", `Target error: ${logContext}: ${toErrorMessage(err)}`);
      } else {
        this.log("warn", `Target error: ${logContext}: ${toErrorMessage(err)}`);
      }
    };
    const onStreamError = (err: Error) => {
      if (isBenignCloseError(err)) {
        this.log("debug", `Tunnel stream error: ${logContext}: ${toErrorMessage(err)}`);
      } else {
        this.log("warn", `Tunnel stream error: ${logContext}: ${toErrorMessage(err)}`);
      }
    };

    target.on("error", onTargetError);
    stream.on("error", onStreamError);
    target.once("close", () => this.log("debug", `Target close: ${logContext}`));
    stream.once("close", () => this.log("debug", `Tunnel stream close: ${logContext}`));
    target.once("end", () => this.log("debug", `Target end: ${logContext}`));
    stream.once("end", () => this.log("debug", `Tunnel stream end: ${logContext}`));

    try {
      this.log("debug", `Proxy copy start: ${logContext}`);

      const tunnelToTarget = this.copyOneWay(stream, target).then(async () => {
        this.log("debug", `Copy complete tunnel->target: ${logContext}`);
        await endWritable(target);
        this.log("debug", `Half-close target write: ${logContext}`);
      });

      const targetToTunnel = this.copyOneWay(target, stream).then(async () => {
        this.log("debug", `Copy complete target->tunnel: ${logContext}`);
        await endWritable(stream);
        this.log("debug", `Half-close tunnel write: ${logContext}`);
      });

      const results = await Promise.allSettled([tunnelToTarget, targetToTunnel]);
      const severe = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason)
        .find((reason) => !isBenignCloseError(reason));

      if (severe) {
        throw severe;
      }
    } finally {
      target.off("error", onTargetError);
      stream.off("error", onStreamError);

      const [targetClosed, streamClosed] = await Promise.all([
        waitForClose(target, STREAM_CLOSE_TIMEOUT_MS),
        waitForClose(stream, STREAM_CLOSE_TIMEOUT_MS),
      ]);

      if (!targetClosed && !target.destroyed) {
        this.log("debug", `Force close target after timeout: ${logContext}`);
        target.destroy();
      }

      if (!streamClosed && !stream.destroyed) {
        this.log("debug", `Force close tunnel stream after timeout: ${logContext}`);
        stream.destroy();
      }
    }
  }

  private async copyOneWay(readable: NodeJS.ReadableStream, writable: NodeJS.WritableStream): Promise<void> {
    for await (const chunk of readable) {
      if (!writable.write(chunk)) {
        await once(writable, "drain");
      }
    }
  }

  private async connectTarget(host: string, port: number): Promise<Socket> {
    // `host`/`port` here are the `target_host`/`target_port` relayed verbatim from the inbound
    // proxy request on the internet-facing proxy port — untrusted input as far as this client
    // is concerned. Resolve once, validate the exact resolved candidate set, then dial that same
    // set (never the original hostname): a name that later rebinds to a different address can't
    // slip through, because there is no second, independent lookup between the check and the
    // dial. Mirrors `connect_target`/`ensure_candidates_are_loopback` in the Rust client.
    const candidates = await resolveDialCandidates(host, port);
    ensureTargetAllowed(host, port, candidates, this.options.allowPrivateNetworkTarget);

    let lastError: unknown;

    for (const candidate of candidates) {
      try {
        return await this.connectOnce(candidate.host, candidate.port);
      } catch (err) {
        lastError = err;
      }
    }

    throw new TargetConnectError(
      host,
      port,
      lastError ?? new Error(`no dial candidates for ${host}:${port}`),
    );
  }

  private connectOnce(host: string, port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });

      // VENDOR DELTA: track from creation so a teardown mid-dial destroys it too;
      // the 'close' handler removes it whether the dial succeeds, fails, or is
      // force-destroyed by stopAllTunnelRuntimes(). See the field comment.
      this.activeTargetSockets.add(socket);
      socket.once("close", () => {
        this.activeTargetSockets.delete(socket);
      });

      const onError = (err: Error) => {
        cleanup();
        if (!socket.destroyed) {
          socket.destroy();
        }
        reject(err);
      };

      const onConnect = () => {
        cleanup();
        resolve(socket);
      };

      const timeout = setTimeout(() => {
        onError(new Error(`connect timeout ${DEFAULT_TARGET_CONNECT_TIMEOUT_MS}ms`));
      }, DEFAULT_TARGET_CONNECT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("error", onError);
        socket.off("connect", onConnect);
      };

      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
  }

  private log(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.options.logLevel]) {
      return;
    }
    this.options.logSink(level, `[TunnelClient] [${level}] ${message}`);
  }

  private reportError(code: ErrCode, message: string, level: LogLevel = "warn"): void {
    this.options.onError({ code, message });
    this.log(level, message);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function isBenignCloseError(err: unknown): boolean {
  if (err instanceof YamuxStreamResetError) {
    return true;
  }

  if (!(err instanceof Error)) {
    return false;
  }

  const e = err as Error & { code?: string };
  return e.code === "ECONNRESET"
    || e.code === "EPIPE"
    || e.code === "ECONNABORTED"
    || e.code === "ERR_STREAM_PREMATURE_CLOSE"
    || e.code === "ABORT_ERR"
    || e.name === "AbortError"
    || e.message === "The operation was aborted";
}

async function waitForClose(
  stream: (NodeJS.ReadableStream | NodeJS.WritableStream) & { destroyed?: boolean },
  timeoutMs: number,
): Promise<boolean> {
  if (stream.destroyed) {
    return true;
  }

  const closed = new Promise<boolean>((resolve) => {
    const onClose = () => {
      cleanup();
      resolve(true);
    };
    const onEnd = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      stream.off("close", onClose);
      stream.off("end", onEnd);
    };

    stream.once("close", onClose);
    stream.once("end", onEnd);
  });

  const timeout = delay(timeoutMs).then(() => false);
  return Promise.race([closed, timeout]);
}

async function endWritable(stream: NodeJS.WritableStream): Promise<void> {
  const typed = stream as NodeJS.WritableStream & {
    writableEnded?: boolean;
    destroyed?: boolean;
  };

  if (typed.destroyed || typed.writableEnded) {
    return;
  }

  await new Promise<void>((resolve) => {
    stream.end(() => resolve());
  });
}

function dedupeCandidates(
  candidates: Array<{ host: string; port: number }>,
): Array<{ host: string; port: number }> {
  const seen = new Set<string>();
  const result: Array<{ host: string; port: number }> = [];

  for (const candidate of candidates) {
    const key = `${candidate.host}:${candidate.port}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(candidate);
  }

  return result;
}

/**
 * Resolve `host:port` to the exact set of addresses a dial will be attempted against.
 *
 * Mirrors the Rust client's `dial_candidates`: for `localhost` (case-insensitive), `127.0.0.1`
 * and `::1` are added up front; the host is then also resolved normally (an IP literal parses
 * without touching the network, exactly like Rust's `to_socket_addrs`; anything else goes
 * through `dns.lookup`, i.e. getaddrinfo, honoring `/etc/hosts`), and any additional resolved
 * addresses are appended, deduplicated.
 *
 * Callers must validate and dial this exact returned list — re-resolving `host` a second time
 * reopens the DNS-rebind window this function exists to close.
 */
export async function resolveDialCandidates(
  host: string,
  port: number,
): Promise<Array<{ host: string; port: number }>> {
  const candidates: Array<{ host: string; port: number }> = [];

  if (host.toLowerCase() === "localhost") {
    candidates.push({ host: "127.0.0.1", port });
    candidates.push({ host: "::1", port });
  }

  for (const address of await resolveHostAddresses(host)) {
    candidates.push({ host: address, port });
  }

  return dedupeCandidates(candidates);
}

/** Resolve `host` to literal IP address strings. Returns `[]` if resolution fails (swallowed,
 * matching the Rust side's `if let Ok(resolved) = ...`), never rejects. */
async function resolveHostAddresses(host: string): Promise<string[]> {
  if (net.isIP(host) !== 0) {
    // Already a literal (v4 or v6) — no DNS involved, same as Rust's `to_socket_addrs` parsing
    // an IP literal directly.
    return [host];
  }

  try {
    const results = await dns.promises.lookup(host, { all: true });
    return results.map((entry) => entry.address);
  } catch {
    return [];
  }
}

/**
 * Why `address` (a literal IPv4 or IPv6 address, e.g. from {@link resolveDialCandidates}) must not
 * be dialled, or `undefined` if it is acceptable. Mirrors the Rust client's
 * `blocked_target_reason` — the two must agree exactly, or the same request succeeds on one
 * client and fails on the other.
 *
 * Acceptable = loopback (the app under test) or a globally-routable address (the fonts, CDNs and
 * third-party APIs a real page legitimately loads). Blocked = the private address space, which is
 * only reachable because this client runs inside someone's network.
 *
 * Not a hostname resolver — callers pass already-resolved literals.
 */
export function blockedTargetReason(address: string): string | undefined {
  const family = net.isIP(address);
  if (family === 0) {
    return "not an IP literal";
  }

  // VENDOR DELTA: classify IPv6 loopback and embedded-IPv4 spaces with binary `net.BlockList`
  // matching instead of spelling-specific mapped-address regexes. This makes equivalent IPv6
  // spellings share one verdict and refuses compatible, mapped, translated, and NAT64 forms.
  const targetFamily: "ipv4" | "ipv6" = family === 4 ? "ipv4" : "ipv6";

  const loopback = new net.BlockList();
  if (targetFamily === "ipv4") {
    loopback.addSubnet("127.0.0.0", 8, "ipv4");
  } else {
    loopback.addSubnet("::1", 128, "ipv6");
    loopback.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
  }
  if (loopback.check(address, targetFamily)) {
    return undefined;
  }

  if (targetFamily === "ipv6") {
    const embeddedIpv4 = new net.BlockList();
    // VENDOR DELTA: `::/32` and `64:ff9b::/32` rather than the narrower canonical-form
    // prefixes (`::/96`, and `64:ff9b::/96` + `64:ff9b:1::/48`) alone. Each /32 is the
    // binary superset of every RFC-named spelling in its family, so a reserved-but-
    // non-canonical prefix that sits between two narrow rules (e.g.
    // `64:ff9b:ffff::a9fe:a9fe`, which is in neither the RFC 6052 `/96` nor the RFC 8215
    // `/48`) can no longer slip through. Mirrors `src/lib/target-url.ts`'s
    // `NAT64_SUBNETS` / `IPV4_COMPATIBLE_SUBNETS` exactly (see that file's doc comment for
    // the full reasoning); both `0000::/8` and `0064::/16` are IETF-reserved, so widening
    // costs no reachable public target. The narrower `::ffff:0:0/96` / `::ffff:0:0:0/80` /
    // `0:0:0:ffff:0:0:0:0/96` entries below are now FULLY SUBSUMED by the wider `::/32` and
    // change no verdict — every hit here returns the one generic string, so unlike
    // `target-url.ts` they name no family. They are kept only as an inline record of which
    // RFC-named spellings this range covers, and deleting them is behaviour-neutral (proved
    // by mutation: removing all three leaves the target-guard spec at 31/31). `::1` and mapped
    // loopback
    // (`::ffff:127.0.0.0/104`) are unaffected — the loopback `BlockList` above is checked
    // first and returns before this one is ever consulted. See VENDOR.md #11.
    embeddedIpv4.addSubnet("::", 32, "ipv6");
    embeddedIpv4.addSubnet("::ffff:0:0", 96, "ipv6");
    embeddedIpv4.addSubnet("::ffff:0:0:0", 80, "ipv6");
    embeddedIpv4.addSubnet("0:0:0:ffff:0:0:0:0", 96, "ipv6");
    embeddedIpv4.addSubnet("64:ff9b::", 32, "ipv6");
    // VENDOR DELTA: 6to4 and Teredo derive IPv4 destinations by construction, so they belong
    // with the other embedded-IPv4 spaces. See VENDOR.md #10.
    embeddedIpv4.addSubnet("2002::", 16, "ipv6");
    embeddedIpv4.addSubnet("2001::", 32, "ipv6");
    if (embeddedIpv4.check(address, "ipv6")) {
      return "IPv4 address embedded in an IPv6 literal";
    }
  }

  for (const [reason, subnets] of targetFamily === "ipv4" ? BLOCKED_IPV4 : BLOCKED_IPV6) {
    const list = new net.BlockList();
    for (const [network, prefix] of subnets) {
      list.addSubnet(network, prefix, targetFamily);
    }
    if (list.check(address, targetFamily)) {
      return reason;
    }
  }

  return undefined;
}

const BLOCKED_IPV4: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]> = [
  ["RFC1918 private address", [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]]],
  // 169.254.0.0/16 — also where cloud instance-metadata endpoints live.
  ["link-local address", [["169.254.0.0", 16]]],
  ["RFC6598 carrier-grade NAT address", [["100.64.0.0", 10]]],
  ["RFC2544 benchmarking address", [["198.18.0.0", 15]]],
  ["unspecified address", [["0.0.0.0", 8]]],
  ["multicast address", [["224.0.0.0", 4]]],
  ["reserved address", [["240.0.0.0", 4]]],
];

const BLOCKED_IPV6: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, number]>]> = [
  ["IPv6 unique-local address", [["fc00::", 7]]],
  // VENDOR DELTA: deprecated site-local space is private-scope even though it predates ULA.
  // See VENDOR.md #10.
  ["IPv6 site-local address", [["fec0::", 10]]],
  ["IPv6 link-local address", [["fe80::", 10]]],
  ["multicast address", [["ff00::", 8]]],
  ["unspecified address", [["::", 128]]],
];

/**
 * Ensure no candidate in `candidates` sits in a blocked range, unless `allowPrivateNetwork` opts
 * out. Mirrors the Rust client's `ensure_candidates_allowed` / `ensure_target_allowed`: takes an
 * already-resolved candidate set (rather than resolving internally) so callers about to dial that
 * exact set can validate it without a second, independent DNS lookup.
 *
 * Deliberately NOT loopback-only: the browser under test proxies every request through this
 * tunnel (Chromium `bypass='<-loopback>'`), so public targets are normal subresource traffic.
 * See the Rust `ensure_target_allowed` doc comment for the full rationale.
 */
export function ensureTargetAllowed(
  host: string,
  port: number,
  candidates: Array<{ host: string; port: number }>,
  allowPrivateNetwork: boolean,
): void {
  if (allowPrivateNetwork) {
    return;
  }

  if (candidates.length === 0) {
    throw new BlockedTargetError(host, port);
  }

  for (const candidate of candidates) {
    const reason = blockedTargetReason(candidate.host);
    if (reason !== undefined) {
      throw new BlockedTargetError(host, port, candidate.host, reason);
    }
  }
}

function parseTunnelAddr(addr: string): { host: string; port: number } {
  let hostPart = "";
  let portPart = "";

  if (addr.startsWith("[")) {
    const closing = addr.indexOf("]");
    if (closing < 0 || closing + 2 > addr.length || addr[closing + 1] !== ":") {
      throw new Error(`Invalid tunnel address: ${addr}`);
    }
    hostPart = addr.slice(1, closing);
    portPart = addr.slice(closing + 2);
  } else {
    const sep = addr.lastIndexOf(":");
    if (sep <= 0 || sep === addr.length - 1) {
      throw new Error(`Invalid tunnel address: ${addr}`);
    }
    hostPart = addr.slice(0, sep);
    portPart = addr.slice(sep + 1);
  }

  const port = Number(portPart);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid tunnel address port: ${addr}`);
  }

  return {
    host: hostPart,
    port,
  };
}

function isStreamOpenRequestFrame(value: unknown): value is StreamOpenRequestFrame {
  if (!isPlainObject(value)) {
    return false;
  }

  const frame = value as Record<string, unknown>;

  return isString(frame.request_id)
    && isString(frame.inbound_request_id)
    && isString(frame.tunnel_connection_id)
    && isNumber(frame.mux_stream_id)
    && isString(frame.target_host)
    && isNumber(frame.target_port);
}

interface TunnelRuntime {
  stopRetryOnDisconnect: boolean;
  socket?: Socket;
  session?: YamuxSession;
  task: Promise<void>;
}

class ControlAuthFailureError extends Error {
  constructor(code: number, reason: string) {
    super(`control auth failure (code=${code}, reason=${reason || "unknown"})`);
    this.name = "ControlAuthFailureError";
  }
}

class TargetConnectError extends Error {
  constructor(host: string, port: number, cause: unknown) {
    super(`Target connect failed for ${host}:${port}: ${toErrorMessage(cause)}`);
    this.name = "TargetConnectError";
  }
}

/**
 * Thrown by {@link ensureTargetAllowed} when a proxied target resolves into a blocked
 * (private/internal) range. Mirrors the Rust client's `ensure_candidates_allowed` error.
 */
export class BlockedTargetError extends Error {
  constructor(host: string, port: number, address?: string, reason?: string) {
    super(
      address === undefined
        ? `target ${host}:${port} did not resolve to any address`
        : `target ${host}:${port} resolves to ${address} (${reason}); refusing to dial. `
          + "This run can reach localhost, 127.0.0.1, or ::1 on this machine and the public internet; "
          + "private/LAN/VPN addresses are deliberately blocked. Make the dependency reachable through "
          + "loopback or a public address, then retry.",
    );
    this.name = "BlockedTargetError";
  }
}

function isControlAuthFailureError(err: unknown): err is ControlAuthFailureError {
  return err instanceof ControlAuthFailureError;
}

function isAuthFailureClose(code: number, reason: string): boolean {
  return code === 1008 && reason.trim().toUpperCase() === "AUTH_FAILED";
}
