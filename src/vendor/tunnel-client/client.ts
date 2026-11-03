import { EventEmitter, once } from "node:events";
import dns from "node:dns";
import { readFileSync } from "node:fs";
import net, { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { Duplex } from "node:stream";
import tls from "node:tls";
import { domainToASCII } from "node:url";
import WebSocket from "./ws-compat.js";
import { isNumber, isPlainObject, isString } from "./lodash-lite.js";

import { encodeFrame, readTypedFrame } from "./protocol.js";
import {
  DEFAULT_ALLOW_PRIVATE_NETWORK_TARGET,
  DEFAULT_AUTH_TIMEOUT_MS,
  DEFAULT_CLIENT_UNKNOWN_RETRY_DEADLINE_MS,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_DATA_PLANE_RETRY_DEADLINE_MS,
  DEFAULT_DATA_PLANE_SETTLE_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_RECONNECT_MS,
  DEFAULT_TARGET_CONNECT_TIMEOUT_MS,
  DEFAULT_TLS_HANDSHAKE_TIMEOUT_MS,
} from "./config.js";
import {
  ClientToServerControlMessage,
  ErrCode,
  LogLevel,
  ServerToClientControlMessage,
  StreamOpenRequestFrame,
  TunnelClientOptions,
  TunnelHelloFrame,
  TunnelTransport,
} from "./types.js";

import {
  Client as createYamuxClientSession,
  YamuxStreamResetError,
  YamuxSession,
} from "@llmcode/yamux-ts";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const STREAM_CLOSE_TIMEOUT_MS = 1_500;
const CONTROL_AUTHENTICATION_FAILED = Symbol("control-authentication-failed");
const CONTROL_CLIENT_UNKNOWN = Symbol("control-client-unknown");
const CONTROL_CLIENT_UNKNOWN_EXPIRED = Symbol("control-client-unknown-expired");

interface TunnelAddress {
  host: string;
  port: number;
}

interface NormalizedTunnelClientOptions {
  clientId: string;
  secret: string;
  controlUrl: string;
  tunnelTlsServername?: string;
  tunnelTlsCa: Array<string | Buffer>;
  tlsHandshakeTimeoutMs: number;
  connectTimeoutMs: number;
  dataPlaneRetryDeadlineMs: number;
  clientUnknownRetryDeadlineMs: number;
  onClientUnknown?: TunnelClientOptions["onClientUnknown"];
  dataPlaneSettleMs: number;
  authTimeoutMs: number;
  heartbeatMs: number;
  reconnectMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  allowPrivateNetworkTarget: boolean;
  onError: NonNullable<TunnelClientOptions["onError"]>;
  logSink: NonNullable<TunnelClientOptions["logSink"]>;
}

export class TunnelClient extends EventEmitter {
  readonly #transportMode: TunnelTransport;
  private readonly options: NormalizedTunnelClientOptions;
  private readonly tunnelAddress: TunnelAddress;

  private running = false;
  private controlConnected = false;
  private controlWs?: WebSocket;
  private controlLoopTask?: Promise<void>;
  private controlConnectionGeneration = 0;
  private allowTunnelReconnect = true;
  private dataPlaneTerminalErrorReported = false;
  private clientUnknownEpisodeStartedAt?: number;
  private clientUnknownDeadline?: NodeJS.Timeout;
  private readonly tunnelRuntimes = new Map<string, TunnelRuntime>();
  private lifecycleController = new AbortController();
  private targetDialController = new AbortController();
  private readonly activeTargetSockets = new Set<Socket>();

  constructor(options: TunnelClientOptions) {
    super();

    if (!options.clientId || !options.secret) {
      throw new Error("clientId and secret are required");
    }

    if (!Number.isInteger(options.tlsHandshakeTimeoutMs ?? DEFAULT_TLS_HANDSHAKE_TIMEOUT_MS)
      || (options.tlsHandshakeTimeoutMs ?? DEFAULT_TLS_HANDSHAKE_TIMEOUT_MS) < 0) {
      throw new RangeError("tlsHandshakeTimeoutMs must be a non-negative integer");
    }
    if (!Number.isInteger(options.dataPlaneRetryDeadlineMs ?? DEFAULT_DATA_PLANE_RETRY_DEADLINE_MS)
      || (options.dataPlaneRetryDeadlineMs ?? DEFAULT_DATA_PLANE_RETRY_DEADLINE_MS) < 0) {
      throw new RangeError("dataPlaneRetryDeadlineMs must be a non-negative integer");
    }
    if (!Number.isInteger(options.clientUnknownRetryDeadlineMs ?? DEFAULT_CLIENT_UNKNOWN_RETRY_DEADLINE_MS)
      || (options.clientUnknownRetryDeadlineMs ?? DEFAULT_CLIENT_UNKNOWN_RETRY_DEADLINE_MS) < 0) {
      throw new RangeError("clientUnknownRetryDeadlineMs must be a non-negative integer");
    }
    if (!Number.isInteger(options.dataPlaneSettleMs ?? DEFAULT_DATA_PLANE_SETTLE_MS)
      || (options.dataPlaneSettleMs ?? DEFAULT_DATA_PLANE_SETTLE_MS) < 0) {
      throw new RangeError("dataPlaneSettleMs must be a non-negative integer");
    }
    if (!Number.isInteger(options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)
      || (options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS) < 0) {
      throw new RangeError("connectTimeoutMs must be a non-negative integer");
    }

    const configuredPlaintextAddress = parseTunnelAddr(options.tunnelAddr);
    const configuredTlsAddress = options.tunnelTlsAddr === undefined
      ? undefined
      : parseTunnelAddr(options.tunnelTlsAddr);

    if (configuredTlsAddress !== undefined) {
      this.#transportMode = "tls";
      this.tunnelAddress = configuredTlsAddress;
    } else {
      this.#transportMode = "plaintext";
      this.tunnelAddress = configuredPlaintextAddress;
    }

    let tunnelTlsServername: string | undefined;
    if (this.transport === "tls") {
      const configuredServername = options.tunnelTlsServername;
      if (net.isIP(this.tunnelAddress.host) !== 0 && !configuredServername) {
        throw new Error(
          "tunnelTlsServername is required when tunnelTlsAddr uses an IP-literal host",
        );
      }
      tunnelTlsServername = configuredServername ?? this.tunnelAddress.host;
      if (tunnelTlsServername.trim().length === 0) {
        throw new Error("tunnelTlsServername must not be empty");
      }
    }

    this.options = {
      clientId: options.clientId,
      secret: options.secret,
      controlUrl: options.controlUrl,
      tunnelTlsServername,
      tunnelTlsCa: normalizeTlsCa(options.tunnelTlsCa),
      tlsHandshakeTimeoutMs: options.tlsHandshakeTimeoutMs ?? DEFAULT_TLS_HANDSHAKE_TIMEOUT_MS,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      dataPlaneRetryDeadlineMs:
        options.dataPlaneRetryDeadlineMs ?? DEFAULT_DATA_PLANE_RETRY_DEADLINE_MS,
      clientUnknownRetryDeadlineMs:
        options.clientUnknownRetryDeadlineMs ?? DEFAULT_CLIENT_UNKNOWN_RETRY_DEADLINE_MS,
      onClientUnknown: options.onClientUnknown,
      dataPlaneSettleMs: options.dataPlaneSettleMs ?? DEFAULT_DATA_PLANE_SETTLE_MS,
      authTimeoutMs: options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
      heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      reconnectMs: options.reconnectMs ?? DEFAULT_RECONNECT_MS,
      logLevel: options.logLevel ?? DEFAULT_LOG_LEVEL,
      allowPrivateNetworkTarget: options.allowPrivateNetworkTarget ?? DEFAULT_ALLOW_PRIVATE_NETWORK_TARGET,
      onError: options.onError ?? (() => null),
      logSink: options.logSink ?? ((_level: LogLevel, line: string) => {
        process.stderr.write(`${line}\n`);
      }),
    };
  }

  public get transport(): TunnelTransport {
    return this.#transportMode;
  }

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }
    if (this.lifecycleController.signal.aborted) {
      this.lifecycleController = new AbortController();
    }
    if (this.targetDialController.signal.aborted) {
      this.targetDialController = new AbortController();
    }
    this.clearClientUnknownEpisode();
    this.running = true;
    this.dataPlaneTerminalErrorReported = false;

    const expectedConnectionGeneration = this.controlConnectionGeneration + 1;
    const readiness = new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        this.off("control-authenticated", onAuthenticated);
        this.off(CONTROL_AUTHENTICATION_FAILED, onAuthenticationFailed);
        this.off(CONTROL_CLIENT_UNKNOWN, onClientUnknown);
        this.off(CONTROL_CLIENT_UNKNOWN_EXPIRED, onClientUnknownExpired);
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
        if (connectionGeneration >= expectedConnectionGeneration) {
          settle(resolve);
        }
      };
      const onAuthenticationFailed = (connectionGeneration: number, error: Error) => {
        if (connectionGeneration >= expectedConnectionGeneration) {
          settle(() => reject(error));
        }
      };
      const onClientUnknown = () => clearTimeout(timeout);
      const onClientUnknownExpired = (error: ClientUnknownError) => settle(() => reject(error));
      const timeout = setTimeout(() => {
        settle(() => reject(new Error(
          `The tunnel server accepted the connection but never acknowledged authentication within ${this.options.authTimeoutMs}ms`,
        )));
      }, this.options.authTimeoutMs);

      this.on("control-authenticated", onAuthenticated);
      this.on(CONTROL_AUTHENTICATION_FAILED, onAuthenticationFailed);
      this.on(CONTROL_CLIENT_UNKNOWN, onClientUnknown);
      this.on(CONTROL_CLIENT_UNKNOWN_EXPIRED, onClientUnknownExpired);
      this.controlLoopTask = this.runControlLoop();
      const onLoopEnd = () => {
        settle(() => reject(new Error("Control loop ended before connecting")));
      };
      this.controlLoopTask.then(onLoopEnd, onLoopEnd);
    });
    await readiness;

    this.log("info", "Tunnel client started");
  }

  public async stop(): Promise<void> {
    this.running = false;
    this.clearClientUnknownEpisode();
    this.lifecycleController.abort();

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
        if (!this.running) return;
        if (isControlAuthFailureError(err)) {
          const message = err.reason.trim().toUpperCase() === "CLIENT_REVOKED"
            ? "tunnel credential revoked"
            : err.authenticated
              ? "tunnel connection superseded or credential revoked"
              : `Control authentication failed, stop reconnecting: ${toErrorMessage(err)}`;
          this.reportError(ErrCode.AuthFailed, message, "error");
          this.clearClientUnknownEpisode();
          this.running = false;
          this.lifecycleController.abort();
          this.controlConnected = false;
          this.stopAllTunnelRuntimes();
          return;
        }
        if (err instanceof ControlClientUnknownCloseError) {
          this.openClientUnknownEpisode();
          if (this.options.onClientUnknown) {
            try {
              await abortable(Promise.resolve().then(() => this.options.onClientUnknown!()), this.lifecycleController.signal);
            } catch (hookError) {
              if (this.running) this.log("warn", `Client recovery hook failed: ${redactSecret(toErrorMessage(hookError), this.options.secret)}`);
            }
          }
        } else {
          this.reportError(ErrCode.ControlDisconnected, `Control disconnected: ${toErrorMessage(err)}`);
        }
      }

      if (this.running) {
        await delay(this.options.reconnectMs, this.lifecycleController.signal);
      }
    }
  }

  private openClientUnknownEpisode(): void {
    this.clientUnknownEpisodeStartedAt ??= performance.now();
    if (this.options.clientUnknownRetryDeadlineMs === 0 || this.clientUnknownDeadline) return;
    const remainingMs = Math.max(0,
      this.options.clientUnknownRetryDeadlineMs - (performance.now() - this.clientUnknownEpisodeStartedAt));
    this.clientUnknownDeadline = setTimeout(() => {
      this.clientUnknownDeadline = undefined;
      if (!this.running || this.clientUnknownEpisodeStartedAt === undefined) return;
      const error = new ClientUnknownError(this.options.clientUnknownRetryDeadlineMs);
      this.emit(CONTROL_CLIENT_UNKNOWN_EXPIRED, error);
      try {
        this.options.onError(error);
      } catch {
        this.log("warn", "onError callback threw; continuing client lifecycle");
      }
      this.log("error", error.message);
      void this.stop();
    }, remainingMs);
    this.clientUnknownDeadline.unref();
  }

  private clearClientUnknownEpisode(): void {
    if (this.clientUnknownDeadline) clearTimeout(this.clientUnknownDeadline);
    this.clientUnknownDeadline = undefined;
    this.clientUnknownEpisodeStartedAt = undefined;
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
          if (!this.running || !this.allowTunnelReconnect || runtime.stopRetryOnDisconnect) {
            return;
          }
          const errorMessage = toErrorMessage(err);
          const safeErrorMessage = redactSecret(errorMessage, this.options.secret);
          this.openDataPlaneFailureEpisode(runtime, safeErrorMessage);
          this.reportError(
            ErrCode.TunnelDisconnected,
            `Tunnel ${tunnelConnectionId} disconnected: ${safeErrorMessage}`,
          );
        }

        if (!this.allowTunnelReconnect || runtime.stopRetryOnDisconnect) {
          this.log("info", `Tunnel ${tunnelConnectionId} reconnect disabled`);
          return;
        }

        if (this.running) {
          await delay(this.options.reconnectMs, this.lifecycleController.signal);
        }
      }
    } finally {
      this.clearDataPlaneFailureEpisode(runtime);
      this.clearAttemptTimers(runtime);
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
      let authenticated = false;

      const failAuthentication = (error: Error) => {
        if (!authenticationSettled) {
          authenticationSettled = true;
          this.emit(CONTROL_AUTHENTICATION_FAILED, connectionGeneration, error);
        }
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
          authenticated = true;
          if (!authenticationSettled) {
            authenticationSettled = true;
            this.clearClientUnknownEpisode();
            this.emit("control-authenticated", connectionGeneration);
          }
          return;
        }

        if (message.type === "RequestTunnel") {
          this.log("debug", `RequestTunnel received: ${message.payload.tunnel_connection_id}`);
          this.allowTunnelReconnect = true;
          if (this.targetDialController.signal.aborted) {
            this.targetDialController = new AbortController();
          }
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
        if (this.clientUnknownEpisodeStartedAt === undefined) {
          failAuthentication(new Error(
            `Control websocket errored before authentication was acknowledged: ${toErrorMessage(err)}`,
          ));
        }
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
        if (code === 1008 && reason.trim().toUpperCase() === "CLIENT_UNKNOWN") {
          this.emit(CONTROL_CLIENT_UNKNOWN);
          reject(new ControlClientUnknownCloseError());
          return;
        }
        if (this.clientUnknownEpisodeStartedAt === undefined || isAuthFailureClose(code, reason)) {
          failAuthentication(new Error(
            `Control websocket closed before authentication was acknowledged (code=${code}, reason=${reason || "<empty>"})`,
          ));
        }
        this.log("warn", `Control websocket closed (code=${code}, reason=${reason || "<empty>"})`);
        if (isAuthFailureClose(code, reason)) {
          reject(new ControlAuthFailureError(code, reason, authenticated));
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
      const socket = this.connectDataPlane();

      runtime.socket = socket;

      let helloWritten = false;
      let established = false;
      let settled = false;
      let session: YamuxSession | undefined;

      const clearDialTimeout = () => {
        if (runtime.dialTimeout) {
          clearTimeout(runtime.dialTimeout);
          runtime.dialTimeout = undefined;
        }
      };

      const clearSettleTimeout = () => {
        if (runtime.settleTimeout) {
          clearTimeout(runtime.settleTimeout);
          runtime.settleTimeout = undefined;
        }
      };

      const cleanup = () => {
        clearDialTimeout();
        clearSettleTimeout();
        if (runtime.socket === socket) runtime.socket = undefined;
        if (runtime.session === session) runtime.session = undefined;
      };

      const settle = (next: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        next();
      };

      const markEstablished = () => {
        if (
          established
          || settled
          || !this.running
          || !this.allowTunnelReconnect
          || runtime.stopRetryOnDisconnect
        ) {
          return;
        }
        established = true;
        clearSettleTimeout();
        this.clearDataPlaneFailureEpisode(runtime);
      };

      socket.once("error", (err) => {
        if (!established) {
          settle(() => reject(err));
          return;
        }
        this.log(
          "warn",
          `Tunnel ${this.transport} error on established session ${tunnelConnectionId}: ${redactSecret(toErrorMessage(err), this.options.secret)}`,
        );
      });

      const finalizeClose = () => {
        settle(() => {
          this.emit("tunnel-disconnected", tunnelConnectionId);
          this.log("warn", `Tunnel tcp closed: ${tunnelConnectionId}`);
          if (!this.running || !this.allowTunnelReconnect || runtime.stopRetryOnDisconnect) {
            resolve();
            return;
          }
          if (!helloWritten) {
            reject(new Error(
              `Tunnel ${this.transport} connection closed before TunnelHello was sent`,
            ));
            return;
          }
          if (established) {
            resolve();
            return;
          }
          reject(new Error(
            `Tunnel ${this.transport} connection closed before the session was established`,
          ));
        });
      };

      const onReady = () => {
        clearDialTimeout();
        if (!this.running || !this.allowTunnelReconnect || runtime.stopRetryOnDisconnect) {
          socket.destroy();
          settle(resolve);
          return;
        }

        this.log("info", `Tunnel ${this.transport} connected: ${tunnelConnectionId}`);
        const hello: TunnelHelloFrame = {
          client_id: this.options.clientId,
          secret: this.options.secret,
          tunnel_connection_id: tunnelConnectionId,
        };

        try {
          socket.write(encodeFrame(hello), (error) => {
            if (error) {
              settle(() => reject(error));
              socket.destroy();
              return;
            }
            if (settled || socket.destroyed) {
              return;
            }

            helloWritten = true;
            runtime.settleTimeout = setTimeout(markEstablished, this.options.dataPlaneSettleMs);
            runtime.settleTimeout.unref();

            session = createYamuxClientSession(socket);
            runtime.session = session;

            session.on("stream", (stream: Duplex) => {
              markEstablished();
              void this.handleIncomingStream(stream);
            });

            session.on("error", (err: Error) => {
              if (isBenignCloseError(err)) {
                this.log("debug", `Yamux benign close (${tunnelConnectionId}): ${toErrorMessage(err)}`);
                return;
              }

              this.log("warn", `Yamux error (${tunnelConnectionId}): ${toErrorMessage(err)}`);

              if (!socket.destroyed) {
                socket.destroy(err);
              }
            });

            session.on("close", () => {
              this.log("debug", `Yamux session closed: ${tunnelConnectionId}`);
            });

            this.emit("tunnel-connected", tunnelConnectionId);
          });
        } catch (error) {
          settle(() => reject(error));
          socket.destroy();
        }
      };

      socket.once(this.transport === "tls" ? "secureConnect" : "connect", onReady);
      if (this.transport === "tls") {
        runtime.dialTimeout = setTimeout(() => {
          socket.destroy(new Error(
            `TLS handshake timed out after ${this.options.tlsHandshakeTimeoutMs}ms`,
          ));
        }, this.options.tlsHandshakeTimeoutMs);
      } else {
        runtime.dialTimeout = setTimeout(() => {
          socket.destroy(new Error(
            `Plaintext connect timed out after ${this.options.connectTimeoutMs}ms`,
          ));
        }, this.options.connectTimeoutMs);
      }
      runtime.dialTimeout.unref();

      socket.once("close", finalizeClose);
      socket.once("end", finalizeClose);
    });
  }

  private connectDataPlane(): Socket {
    if (this.transport === "tls") {
      const ca = tlsCaOption(this.options.tunnelTlsCa);
      return tls.connect({
        host: this.tunnelAddress.host,
        port: this.tunnelAddress.port,
        servername: this.options.tunnelTlsServername,
        minVersion: "TLSv1.2",
        ...(ca === undefined ? {} : { ca }),
      });
    }

    return net.connect({
      host: this.tunnelAddress.host,
      port: this.tunnelAddress.port,
    });
  }

  private openDataPlaneFailureEpisode(
    runtime: TunnelRuntime,
    safeErrorMessage: string,
  ): void {
    runtime.lastFailureMessage = safeErrorMessage;
    const deadlineMs = this.options.dataPlaneRetryDeadlineMs;
    if (deadlineMs === 0 || runtime.failureDeadline) return;

    runtime.failureEpisodeStartedAt ??= performance.now();
    const remainingMs = Math.max(
      0,
      Math.ceil(deadlineMs - (performance.now() - runtime.failureEpisodeStartedAt)),
    );
    runtime.failureDeadline = setTimeout(() => {
      this.expireDataPlaneFailureEpisode(runtime);
    }, remainingMs);
    runtime.failureDeadline.unref();
  }

  private expireDataPlaneFailureEpisode(runtime: TunnelRuntime): void {
    runtime.failureDeadline = undefined;
    if (
      runtime.failureEpisodeStartedAt === undefined
      || !this.running
      || !this.allowTunnelReconnect
      || runtime.stopRetryOnDisconnect
    ) {
      return;
    }

    runtime.stopRetryOnDisconnect = true;
    if (runtime.socket && !runtime.socket.destroyed) runtime.socket.destroy();
    if (this.dataPlaneTerminalErrorReported) return;
    this.dataPlaneTerminalErrorReported = true;
    const address = formatTunnelAddress(this.tunnelAddress);
    try {
      this.reportError(
        ErrCode.DataPlaneUnreachable,
        `Data plane ${this.transport} at ${address} is unreachable after `
          + `${this.options.dataPlaneRetryDeadlineMs}ms: ${runtime.lastFailureMessage ?? "unknown data-plane failure"}`,
        "error",
      );
    } finally {
      void this.stop();
    }
  }

  private clearDataPlaneFailureEpisode(runtime: TunnelRuntime): void {
    if (runtime.failureDeadline) {
      clearTimeout(runtime.failureDeadline);
      runtime.failureDeadline = undefined;
    }
    runtime.failureEpisodeStartedAt = undefined;
    runtime.lastFailureMessage = undefined;
  }

  private clearAttemptTimers(runtime: TunnelRuntime): void {
    if (runtime.dialTimeout) {
      clearTimeout(runtime.dialTimeout);
      runtime.dialTimeout = undefined;
    }
    if (runtime.settleTimeout) {
      clearTimeout(runtime.settleTimeout);
      runtime.settleTimeout = undefined;
    }
  }

  private stopAllTunnelRuntimes(): void {
    // Invalidate pending DNS/connection work before draining sockets. A later
    // RequestTunnel gets a fresh signal without reviving work from this session.
    this.targetDialController.abort();
    for (const runtime of this.tunnelRuntimes.values()) {
      runtime.stopRetryOnDisconnect = true;
      this.clearDataPlaneFailureEpisode(runtime);
      this.clearAttemptTimers(runtime);
      if (runtime.session) {
        runtime.session.close();
      }
      if (runtime.socket && !runtime.socket.destroyed) {
        runtime.socket.destroy();
      }
    }
    for (const socket of this.activeTargetSockets) {
      socket.destroy();
    }
    this.activeTargetSockets.clear();
  }

  private async handleIncomingStream(stream: Duplex): Promise<void> {
    const completed = new AbortController();
    const signal = anySignal([
      this.lifecycleController.signal,
      this.targetDialController.signal,
      completed.signal,
    ]);
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

      const target = await this.connectTarget(targetHost, targetPort, signal);
      this.log("debug", `Target connected: ${logContext}`);

      await this.proxyStreams(stream, target, logContext);
      this.log("debug", `Stream proxy finished: ${logContext}`);
    } catch (err) {
      if (signal.aborted || !this.running) {
        // Lifecycle teardown is expected; keep stream cleanup below.
      } else if (err instanceof YamuxStreamResetError) {
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
    } finally {
      completed.abort();
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

  private async connectTarget(
    host: string,
    port: number,
    signal?: AbortSignal,
  ): Promise<Socket> {
    const completed = new AbortController();
    try {
      signal ??= anySignal([
        this.lifecycleController.signal,
        this.targetDialController.signal,
        completed.signal,
      ]);
      // `host`/`port` here are the `target_host`/`target_port` relayed verbatim from the inbound
      // proxy request on the internet-facing proxy port — untrusted input as far as this client
      // is concerned. Resolve once, validate the exact resolved candidate set, then dial that same
      // set (never the original hostname): a name that later rebinds to a different address can't
      // slip through, because there is no second, independent lookup between the check and the
      // dial. Mirrors `connect_target`/`ensure_candidates_are_loopback` in the Rust client.
      signal.throwIfAborted();
      const candidates = await abortable(resolveDialCandidates(host, port), signal);
      signal.throwIfAborted();
      ensureTargetAllowed(host, port, candidates, this.options.allowPrivateNetworkTarget);

      let lastError: unknown;

      for (const candidate of candidates) {
        signal.throwIfAborted();
        try {
          return await this.connectOnce(candidate.host, candidate.port, signal);
        } catch (err) {
          signal.throwIfAborted();
          lastError = err;
        }
      }

      throw new TargetConnectError(
        host,
        port,
        lastError ?? new Error(`no dial candidates for ${host}:${port}`),
      );
    } finally {
      completed.abort();
    }
  }

  private connectOnce(host: string, port: number, signal: AbortSignal): Promise<Socket> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const socket = net.connect({ host, port });
      this.activeTargetSockets.add(socket);
      socket.once("close", () => this.activeTargetSockets.delete(socket));

      const onError = (err: unknown) => {
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

      const onAbort = () => onError(signal.reason);

      const timeout = setTimeout(() => {
        onError(new Error(`connect timeout ${DEFAULT_TARGET_CONNECT_TIMEOUT_MS}ms`));
      }, DEFAULT_TARGET_CONNECT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("error", onError);
        socket.off("connect", onConnect);
        signal.removeEventListener("abort", onAbort);
      };

      socket.once("error", onError);
      socket.once("connect", onConnect);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private log(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.options.logLevel]) {
      return;
    }
    this.options.logSink(level, `[TunnelClient] [${level}] ${message}`);
  }

  private reportError(code: ErrCode, message: string, level: LogLevel = "warn"): void {
    try {
      this.options.onError({ code, message });
    } catch {
      this.log("warn", "onError callback threw; continuing client lifecycle");
    }
    this.log(level, message);
  }
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const aborted = signals.find((signal) => signal.aborted);
  if (aborted) {
    controller.abort(aborted.reason);
    return controller.signal;
  }

  const listeners = new Map<AbortSignal, () => void>();
  const cleanup = () => {
    for (const [signal, listener] of listeners) {
      signal.removeEventListener("abort", listener);
    }
    listeners.clear();
  };
  for (const signal of new Set(signals)) {
    const onAbort = () => {
      cleanup();
      controller.abort(signal.reason);
    };
    listeners.set(signal, onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    task.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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

function redactSecret(message: string, secret: string): string {
  return secret.length === 0 ? message : message.replaceAll(secret, "[REDACTED]");
}

function formatTunnelAddress(address: TunnelAddress): string {
  const host = net.isIP(address.host) === 6 ? `[${address.host}]` : address.host;
  return `${host}:${address.port}`;
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

  // Match IPv6 ranges in binary so expanded and compressed spellings share one verdict.
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
    // The /32 supersets cover compatible, mapped, translated and non-canonical NAT64 forms.
    // Native and mapped loopback are exempted above before these reserved ranges are checked.
    embeddedIpv4.addSubnet("::", 32, "ipv6");
    embeddedIpv4.addSubnet("64:ff9b::", 32, "ipv6");
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

function parseTunnelAddr(addr: string): TunnelAddress {
  if (addr !== addr.trim() || addr.includes("://") || /[\s\0/\\?#@]/.test(addr)) {
    throw new Error(`Invalid tunnel address: ${addr}`);
  }

  let hostPart = "";
  let portPart = "";

  if (addr.startsWith("[")) {
    const closing = addr.indexOf("]");
    if (
      closing < 0
      || closing + 2 > addr.length
      || addr[closing + 1] !== ":"
      || net.isIP(addr.slice(1, closing)) !== 6
    ) {
      throw new Error(`Invalid tunnel address: ${addr}`);
    }
    hostPart = addr.slice(1, closing);
    portPart = addr.slice(closing + 2);
  } else {
    const sep = addr.lastIndexOf(":");
    if (sep <= 0 || sep === addr.length - 1 || addr.indexOf(":") !== sep) {
      throw new Error(`Invalid tunnel address: ${addr}`);
    }
    hostPart = addr.slice(0, sep);
    portPart = addr.slice(sep + 1);
  }

  if (!/^\d+$/.test(portPart)) {
    throw new Error(`Invalid tunnel address: ${addr}`);
  }
  const port = Number(portPart);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid tunnel address: ${addr}`);
  }

  const host = net.isIP(hostPart) === 0 ? canonicalDnsHostname(hostPart) : hostPart;
  if (host === undefined) {
    throw new Error(`Invalid tunnel address: ${addr}`);
  }

  return { host, port };
}

function canonicalDnsHostname(host: string): string | undefined {
  const ascii = domainToASCII(host).toLowerCase();
  if (ascii.length === 0 || ascii.length > 253) {
    return undefined;
  }
  const withoutTrailingDot = ascii.endsWith(".") ? ascii.slice(0, -1) : ascii;
  const valid = withoutTrailingDot.split(".").every(
    (label) =>
      label.length > 0
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label),
  );
  return valid ? ascii : undefined;
}

function normalizeTlsCa(extraCa: TunnelClientOptions["tunnelTlsCa"]): Array<string | Buffer> {
  if (extraCa === undefined) return [];
  return Array.isArray(extraCa) ? [...extraCa] : [extraCa];
}

/**
 * Certificates from the NODE_EXTRA_CA_CERTS file, cached per path. Node reads
 * that file once at startup; re-reading only when the path changes keeps the
 * same semantics while letting tests point at a temporary file.
 */
let nodeExtraCaCertificates: { path: string; certificates: string[] } | undefined;

function readNodeExtraCaCertificates(): string[] {
  const path = process.env.NODE_EXTRA_CA_CERTS;
  if (!path) return [];
  if (nodeExtraCaCertificates?.path === path) {
    return nodeExtraCaCertificates.certificates;
  }

  let certificates: string[];
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- `NODE_EXTRA_CA_CERTS` is the operator-set path Node itself reads at startup, never request or user input.
    const contents = readFileSync(path, "utf8");
    certificates =
      contents.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? [];
  } catch {
    certificates = [];
  }
  nodeExtraCaCertificates = { path, certificates };
  return certificates;
}

/**
 * Build the `ca` option for a TLS dial. Extra roots are appended to Node's
 * default trust store. Node 22.15+ exposes that store directly. Older supported
 * releases expose only bundled roots, so append the NODE_EXTRA_CA_CERTS file
 * cached per path before adding the caller's roots (CLI compatibility). With no explicit
 * root configured the option stays undefined so Node applies its defaults.
 */
function tlsCaOption(extraRoots: ReadonlyArray<string | Buffer>): Array<string | Buffer> | undefined {
  if (extraRoots.length === 0) return undefined;
  const withDefaults = tls as unknown as {
    getCACertificates?: (type: "default") => readonly string[];
  };
  const defaults =
    typeof withDefaults.getCACertificates === "function"
      ? withDefaults.getCACertificates("default")
      : [...tls.rootCertificates, ...readNodeExtraCaCertificates()];
  return [...defaults, ...extraRoots];
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
  failureEpisodeStartedAt?: number;
  failureDeadline?: NodeJS.Timeout;
  lastFailureMessage?: string;
  dialTimeout?: NodeJS.Timeout;
  settleTimeout?: NodeJS.Timeout;
  socket?: Socket;
  session?: YamuxSession;
  task: Promise<void>;
}

class ControlAuthFailureError extends Error {
  constructor(code: number, readonly reason: string, readonly authenticated: boolean) {
    super(`control auth failure (code=${code}, reason=${reason || "unknown"})`);
    this.name = "ControlAuthFailureError";
  }
}

class ControlClientUnknownCloseError extends Error {}

export class ClientUnknownError extends Error {
  readonly code = ErrCode.ClientUnknown;

  constructor(deadlineMs: number) {
    super(`Tunnel client registration was not found after ${deadlineMs}ms`);
    this.name = "ClientUnknownError";
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
  return code === 1008 && ["AUTH_FAILED", "CLIENT_REVOKED"].includes(reason.trim().toUpperCase());
}
