export type LogLevel = "debug" | "info" | "warn" | "error";
export type TunnelTransport = "tls" | "plaintext";


export enum ErrCode {
    AuthFailed = "0001",
    ControlDisconnected = "0002",
    TunnelDisconnected = "0003",
    TargetConnectFailed = "0004",
    StreamFailed = "0005",
    BlockedTargetRejected = "0006",
    DataPlaneUnreachable = "0007",
    ClientUnknown = "0008",
}

export interface TunnelClientError {
    code: ErrCode;
    message: string;
}

export interface TunnelClientOptions {
  clientId: string;
  secret: string;
  /** CLI endpoints must come from the tunnel mint response. */
  controlUrl: string;
  /** Legacy unencrypted data-plane address (`host:port` or `[v6]:port`). */
  tunnelAddr: string;
  /** TLS data-plane address (`host:port` or `[v6]:port`). Takes precedence over `tunnelAddr`. */
  tunnelTlsAddr?: string;
  /** TLS SNI and certificate hostname. Defaults to the DNS host in `tunnelTlsAddr`. */
  tunnelTlsServername?: string;
  /** Additional PEM roots appended to Node's default trust store. */
  tunnelTlsCa?: string | Buffer | Array<string | Buffer>;
  /** Maximum wait for the data-plane TLS handshake; defaults to 10 seconds. */
  tlsHandshakeTimeoutMs?: number;
  /** Maximum wait for a plaintext data-plane TCP connection; defaults to 10 seconds. */
  connectTimeoutMs?: number;
  /** Continuous data-plane failure episode; defaults to 60 seconds. Zero retries forever. */
  dataPlaneRetryDeadlineMs?: number;
  /** Continuous unknown-client episode; defaults to 120 seconds. Zero retries forever. */
  clientUnknownRetryDeadlineMs?: number;
  /** Called before retrying an unknown client; can re-register the same ID and secret. */
  onClientUnknown?: () => Promise<boolean | void>;
  /** Open-session stability period that establishes the data plane; defaults to 5 seconds. */
  dataPlaneSettleMs?: number;
  /** Maximum wait for the initial control connection's authentication Ack; defaults to 10 seconds. */
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
  /** CLI logs use the injected sink; the default writes only to stderr. */
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
