export type LogLevel = "debug" | "info" | "warn" | "error";


export enum ErrCode {
    AuthFailed = "0001",
    ControlDisconnected = "0002",
    TunnelDisconnected = "0003",
    TargetConnectFailed = "0004",
    StreamFailed = "0005",
    BlockedTargetRejected = "0006",
}

export interface TunnelClientError {
    code: ErrCode;
    message: string;
}

export interface TunnelClientOptions {
  clientId: string;
  secret: string;
  /**
   * VENDOR DELTA: required, not optional. The endpoint defaults upstream
   * carries are hard-coded TestSprite dev hostnames; they are gone here and
   * both values come from `POST /api/cli/v1/tunnel`. See ./config.ts.
   */
  controlUrl: string;
  /** VENDOR DELTA: required. `host:port` of the tunnel DATA plane. */
  tunnelAddr: string;
  /**
   * VENDOR DELTA: maximum time `start()` waits for the current control
   * connection's first Ack, which is the server's authentication acknowledgement.
   */
  authTimeoutMs?: number;
  heartbeatMs?: number;
  reconnectMs?: number;
  logLevel?: LogLevel;
  /**
   * Allow a proxied target to resolve into the private address space (RFC1918, CGNAT,
   * link-local incl. cloud metadata, IPv6 ULA/link-local). Off by default.
   *
   * Loopback and public targets are always allowed and are NOT gated by this flag: the browser
   * under test proxies every request through this tunnel (Chromium `bypass='<-loopback>'`), so a
   * page pulling a web font or calling a third-party API is normal traffic, not abuse. What this
   * gates is the pivot — `target_host`/`target_port` are relayed verbatim from the inbound proxy
   * request on the internet-facing proxy port, so nothing otherwise stops a crafted request from
   * steering this client at hosts it can only reach from inside your network. Mirrors the Rust
   * client's `--allow-private-network-target` / `TS_TUNNEL_ALLOW_PRIVATE_NETWORK_TARGET`;
   * enabling it removes a safety rail, it is not a network sandbox.
   */
  allowPrivateNetworkTarget?: boolean;
  onError?(e: TunnelClientError): void;
  /**
   * VENDOR DELTA (not upstream): where log lines go. Upstream writes them to
   * `console.log`/`console.warn`, i.e. STDOUT, which would corrupt this CLI's
   * `--output json` contract. Absent -> stderr.
   */
  logSink?(level: LogLevel, line: string): void;
}

export type ClientToServerControlMessage =
  | { type: "Auth"; payload: { secret: string } }
  | { type: "Hello"; payload: { client_id: string; version: string } }
  | { type: "Heartbeat" }
  | { type: "Status"; payload: { status: "Offline" | "Online" } };

export type ServerToClientControlMessage =
  | { type: "Ack" }
  | {
    type: "RequestTunnel";
    payload: {
      tunnel_connection_id: string;
      target_host: string;
      target_port: number;
    };
  }
  | { type: "CloseTunnel"; payload: { reason: string } };

export interface TunnelHelloFrame {
  client_id: string;
  secret: string;
  tunnel_connection_id: string;
}

export interface StreamOpenRequestFrame {
  request_id: string;
  inbound_request_id: string;
  tunnel_connection_id: string;
  mux_stream_id: number;
  target_host: string;
  target_port: number;
}
