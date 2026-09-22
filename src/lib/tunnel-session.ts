/**
 * Lifecycle of one `--local` tunnel: mint → connect → (run) → tear down.
 *
 * The credential handling is the point of this module, so it is stated once
 * here rather than repeated at every line that touches it. The secret returned
 * by `POST /api/cli/v1/tunnel` lives in exactly one place — a local in this
 * function — for the lifetime of the process. It is never written to disk,
 * never placed in `argv`, never exported into a child's environment, never
 * logged (the log sink is a closure this module owns), and never sent on the
 * run trigger: the trigger body carries only `tunnelClientId`, and the backend
 * builds the proxy string from its own configuration. `config.json`
 * credentials are a settled no in this codebase, and a tunnel secret is worse
 * than an API key — it authorises an inbound network path into the holder's
 * machine.
 *
 * ## Why there is no remint-and-reconnect
 *
 * The design ledger's D3 said a terminal `1008/AUTH_FAILED` mid-run should
 * mint a fresh client, reconnect, and keep polling — "the in-flight step still
 * fails" being the only accepted cost. That is not achievable, and the reason
 * is structural rather than a matter of effort:
 *
 *   - The proxy string the execution Lambda uses is
 *     `http://<clientId>:<secret>@<proxy-host>:<port>`, built ONCE at trigger
 *     time and baked into the Lambda payload (the invoke is async — there is
 *     no channel to hand it a new one).
 *   - The tunnel's proxy plane authenticates every request against that
 *     `(clientId, secret)` pair and looks the client session up **by that
 *     clientId** (`src/proxy/runtime.rs`: `extract_proxy_credentials` →
 *     `registry.authenticate(client_id, &secret)` → `registry.get(client_id)`).
 *   - The facade is mint-only by design — there is no route that re-registers
 *     an existing id, and adding one would be the credential-confirmation
 *     oracle the MCP surface already has.
 *
 * So a reminted client necessarily has a NEW id that the in-flight run's proxy
 * string can never name. It would connect a tunnel nothing routes to, while
 * the run kept burning credits failing every remaining step. What this module
 * does instead is honest failure: record the loss, let the caller stop the run
 * and say why. See `openTunnelSession`'s `onFatal`.
 */

import { ApiError } from './errors.js';
import { ErrCode, TunnelClient } from '../vendor/tunnel-client/index.js';
import { DEFAULT_DATA_PLANE_RETRY_DEADLINE_MS } from '../vendor/tunnel-client/config.js';
import type { LogLevel, TunnelClientOptions } from '../vendor/tunnel-client/index.js';
import type { TunnelMintResponse } from './tunnel.types.js';

/**
 * How long to wait for the control plane's first successful connection.
 *
 * The vendored client resolves `start()` only on the first
 * `control-connected` event, and its control loop retries every non-auth
 * failure forever. Without a deadline, `--local` against an unreachable
 * control plane hangs with no output at all — the worst possible shape for a
 * command an agent might be driving unattended.
 */
export const DEFAULT_TUNNEL_CONNECT_TIMEOUT_MS = 20_000;

/** Maximum time teardown lets a wedged client delay credential deletion. */
export const TUNNEL_CLIENT_STOP_TIMEOUT_MS = 2_000;

const TUNNEL_SECRET_REDACTION = '[REDACTED]';

function isCredentialRevokedMessage(message: string): boolean {
  return (
    message === 'tunnel credential revoked' ||
    message === 'tunnel connection superseded or credential revoked'
  );
}

/** Why a tunnel stopped being usable for the run that was attached to it. */
export type TunnelFatalReason =
  /** The server refused or dropped a client WE minted and connected. */
  | 'auth-failed'
  /** The server revoked our credential or another connection took over. */
  | 'credential-revoked'
  /** The selected data-plane transport could not connect inside its retry window. */
  | 'data-plane-unreachable'
  /**
   * A BORROWED client (`--tunnel-client`) is no longer registered. Different
   * cause and different remedy from `auth-failed`: nobody disconnected us,
   * the process that minted the tunnel stopped owning it.
   */
  | 'owner-gone';

export interface TunnelSession {
  readonly clientId: string;
  readonly expiresAt: string;
  /** Unknown only for an adopted client whose owning process chose the transport. */
  readonly transport: 'tls' | 'plaintext' | undefined;
  /** True when this session attached to a client someone else minted. */
  readonly adopted: boolean;
  /** The fatal reason, once one has occurred. `undefined` while healthy. */
  fatalReason(): TunnelFatalReason | undefined;
  /** Safe client detail for the fatal reason, when one carries user-facing context. */
  fatalMessage(): string | undefined;
  /** Give the client a bounded stop window, then delete our binding. Idempotent. */
  close(): Promise<void>;
}

/** The slice of the vendored client this module drives. */
export interface TunnelClientHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface OpenTunnelSessionOptions {
  /** stderr sink. Every line this module emits goes here, never to stdout. */
  log: (line: string) => void;
  /**
   * Verbosity floor forwarded to the vendored client. Default `'error'` —
   * at `'info'` the client narrates every stream open and close, which on a
   * page pulling dozens of subresources buries the run's own output.
   */
  logLevel?: LogLevel;
  /** Requested binding lifetime. Server clamps and defaults. */
  ttlSeconds?: number;
  /** See {@link DEFAULT_TUNNEL_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
  /** Called once, the first time the tunnel becomes unusable for this run. */
  onFatal?: (reason: TunnelFatalReason, message?: string) => void;
  /**
   * Attach to a client someone else minted (`testsprite tunnel start` in
   * another terminal) instead of minting one. No secret is available, so
   * nothing is connected here and nothing is deleted at teardown — the
   * process that minted it owns both.
   */
  adopt?: { clientId: string; expiresAt: string };
}

export interface TunnelSessionDeps {
  mint: (ttlSeconds?: number) => Promise<TunnelMintResponse>;
  /**
   * Delete the binding. MUST be issued through a client whose shutdown signal
   * is not the interrupted one — teardown runs from a `finally` that is often
   * reached *because* of a signal, and a request composed with an
   * already-aborted signal never leaves the process.
   */
  destroy: (clientId: string) => Promise<void>;
  /** Injectable for tests. Defaults to the vendored `TunnelClient`. */
  createClient?: (options: TunnelClientOptions) => TunnelClientHandle;
}

/**
 * Thrown when the tunnel a run depends on dies mid-run. `UNAVAILABLE` (exit
 * 10 rather than a run failure: the test did not fail, the transport under it
 * did. An owned run can retry with a fresh tunnel; a borrowed run must inspect
 * the already-started server-side run before deciding whether to retry.
 */
export class TunnelLostError extends ApiError {
  constructor(reason: TunnelFatalReason, runId: string, fatalMessage?: string) {
    // Two different things go wrong here and they do NOT share a remedy.
    // `--tunnel-client <id>` re-attaches to the same dead id and mints nothing,
    // so a borrower must inspect this run before deciding what to do next.
    // The wait path reports the observed cancellation outcome separately.
    const ownerGone = reason === 'owner-gone';
    const dataPlaneUnreachable = reason === 'data-plane-unreachable';
    super({
      code: 'UNAVAILABLE',
      message: ownerGone
        ? `The borrowed tunnel for run ${runId} is no longer registered. It was minted by ` +
          `another process (\`testsprite tunnel start\`), and that process has stopped or its ` +
          `credential expired. The run cannot reach your app through that tunnel.`
        : dataPlaneUnreachable
          ? formatDataPlaneUnreachableMessage(fatalMessage)
          : `The tunnel carrying run ${runId} was disconnected by the server and cannot be ` +
            `restored for this run (${reason}).`,
      nextAction: ownerGone
        ? `Check the run before re-running: testsprite test wait ${runId}.`
        : dataPlaneUnreachable
          ? `Check the cancelled run with testsprite test wait ${runId}. ` +
            formatDataPlaneUnreachableNextAction(fatalMessage, 'start a new run')
          : 'This usually means the tunnel service was redeployed mid-run. Start the run again: ' +
            'the retry mints a fresh tunnel.',
      requestId: 'local',
      details: { reason, runId },
    });
    this.name = 'TunnelLostError';
  }
}

interface ParsedDataPlaneUnreachable {
  transport: 'tls' | 'plaintext';
  address: string;
  deadlineMs: number;
  error: string;
}

function parseDataPlaneUnreachableMessage(
  clientMessage?: string,
): ParsedDataPlaneUnreachable | undefined {
  const parsed =
    /^Data plane (tls|plaintext) at (.+) is unreachable after (\d+)ms: ([\s\S]+)$/u.exec(
      clientMessage ?? '',
    );
  if (!parsed) return undefined;
  return {
    transport: parsed[1] as 'tls' | 'plaintext',
    address: parsed[2]!,
    deadlineMs: Number(parsed[3]),
    error: parsed[4]!,
  };
}

export function formatDataPlaneUnreachableMessage(clientMessage?: string): string {
  const parsed = parseDataPlaneUnreachableMessage(clientMessage);
  const base = parsed
    ? `The tunnel's ${parsed.transport === 'tls' ? 'encrypted' : 'plaintext'} data connection to ${parsed.address} ` +
      `could not be established for ${parsed.deadlineMs / 1_000}s (last error: ${parsed.error}).`
    : (clientMessage ?? "The tunnel's encrypted data connection could not be established.");
  if (parsed?.transport === 'plaintext') {
    return (
      `${base} Check that the self-hosted tunnel service at ${parsed.address} is running and ` +
      'that the egress firewall allows a direct connection to that address and port.'
    );
  }
  if (base.includes('NODE_EXTRA_CA_CERTS')) return base;
  return (
    `${base} Corporate TLS interception, a wrong system clock, or a firewall blocking port 443 ` +
    "are the usual causes; set NODE_EXTRA_CA_CERTS to your organisation's CA bundle if your " +
    'network re-signs TLS.'
  );
}

export function formatDataPlaneUnreachableNextAction(
  clientMessage: string | undefined,
  retryAction: string,
): string {
  const parsed = parseDataPlaneUnreachableMessage(clientMessage);
  if (parsed?.transport === 'plaintext') {
    return (
      `Check that the self-hosted tunnel service at ${parsed.address} is running and that the ` +
      `egress firewall allows a direct connection to that address and port. Then ${retryAction}.`
    );
  }
  return (
    'Fix the network or TLS trust configuration: check for TLS interception, correct the system ' +
    "clock, allow outbound port 443, and set NODE_EXTRA_CA_CERTS to your organisation's CA " +
    `bundle when the network re-signs TLS. Then ${retryAction}.`
  );
}

export const TUNNEL_DATA_PLANE_PROXY_BYPASS_DESCRIPTION =
  'the tunnel data plane uses a direct socket connection (TLS when the server advertises it; ' +
  'raw TCP only for the legacy transport) that bypasses HTTP proxies';

function defaultCreateClient(options: TunnelClientOptions): TunnelClientHandle {
  return new TunnelClient(options);
}

async function stopClientWithDeadline(client: TunnelClientHandle): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.stop(),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, TUNNEL_CLIENT_STOP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function redactTunnelSecret(line: string, secret: string): string {
  if (secret.length === 0) return line;
  return line.replaceAll(secret, TUNNEL_SECRET_REDACTION);
}

/**
 * Mint (or adopt) a tunnel client and connect it.
 *
 * On any failure after the mint, the client gets a bounded chance to stop and
 * the binding is always deleted before the error propagates. A
 * minted-but-unconnected binding is a live credential with nothing watching
 * it, while an un-stopped client can leave ref'd heartbeat/reconnect timers
 * that keep the process alive long after the command has printed its last
 * line. Credential deletion cannot wait indefinitely for those timers.
 */
export async function openTunnelSession(
  options: OpenTunnelSessionOptions,
  deps: TunnelSessionDeps,
): Promise<TunnelSession> {
  const { log } = options;
  let fatal: TunnelFatalReason | undefined;
  let fatalMessage: string | undefined;
  let closed = false;

  if (options.adopt) {
    // Adopted: no secret here, so no connection and no teardown obligation.
    return {
      clientId: options.adopt.clientId,
      expiresAt: options.adopt.expiresAt,
      transport: undefined,
      adopted: true,
      fatalReason: () => fatal,
      fatalMessage: () => fatalMessage,
      close: async () => {},
    };
  }

  const minted = await deps.mint(options.ttlSeconds);
  // Treat the vendored client as untrusted at this boundary: every line is
  // scrubbed before the caller-owned sink can observe it. This remains safe if
  // a future client log message accidentally interpolates its options.
  const sessionLog = (line: string): void => log(redactTunnelSecret(line, minted.secret));
  const transport = minted.tunnelTlsAddr === undefined ? 'plaintext' : 'tls';
  if (transport === 'plaintext') {
    sessionLog(
      'Warning: this TestSprite server did not advertise an encrypted tunnel data plane; the tunnel secret will be sent over plaintext TCP.',
    );
  }

  const createClient = deps.createClient ?? defaultCreateClient;
  let client: TunnelClientHandle | undefined;

  const stopAndDestroy = async (): Promise<void> => {
    // Stop first so cooperative clients release their sockets and ref'd
    // timers. A websocket stuck in CONNECTING makes the real stop() await the
    // same pending control handshake as start(), so the hard deadline below
    // must expire before destroy runs. Deleting the binding revokes the live
    // credential and therefore always gets the final say in this ordering.
    if (client !== undefined) {
      try {
        await stopClientWithDeadline(client);
      } catch {
        // Best-effort: a failure to stop must never mask the original error,
        // and must never skip the binding delete below.
      }
    }
    try {
      await deps.destroy(minted.clientId);
    } catch (err) {
      sessionLog(
        `[advisory] could not delete the tunnel credential (${
          err instanceof Error ? err.message : String(err)
        }); it expires on its own at ${minted.expiresAt}.`,
      );
    }
  };

  try {
    client = createClient({
      clientId: minted.clientId,
      secret: minted.secret,
      controlUrl: minted.controlUrl,
      tunnelAddr: minted.tunnelAddr,
      ...(minted.tunnelTlsAddr !== undefined ? { tunnelTlsAddr: minted.tunnelTlsAddr } : {}),
      dataPlaneRetryDeadlineMs: DEFAULT_DATA_PLANE_RETRY_DEADLINE_MS,
      logLevel: options.logLevel ?? 'error',
      // Never opened up. The point of `--local` is the caller's own loopback;
      // a run that pivots into the rest of their network is the failure this
      // rail exists to stop. Loopback and public targets are unaffected.
      allowPrivateNetworkTarget: false,
      logSink: (_level, line) => sessionLog(line),
      onError: e => {
        const terminal = e.code === ErrCode.AuthFailed || e.code === ErrCode.DataPlaneUnreachable;
        if (terminal && fatal === undefined) {
          // Terminal: the vendored client has stopped reconnecting, and a
          // remint cannot rescue this run (see the module docstring).
          fatal =
            e.code === ErrCode.DataPlaneUnreachable
              ? 'data-plane-unreachable'
              : isCredentialRevokedMessage(e.message)
                ? 'credential-revoked'
                : 'auth-failed';
          fatalMessage =
            e.code === ErrCode.DataPlaneUnreachable
              ? redactTunnelSecret(e.message, minted.secret)
              : undefined;
          options.onFatal?.(fatal, fatalMessage);
          return;
        }
        if (terminal) return;
        sessionLog(`[tunnel] ${e.message}`);
      },
    });
  } catch (err) {
    await stopAndDestroy();
    throw err;
  }

  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_TUNNEL_CONNECT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          ApiError.fromEnvelope({
            error: {
              code: 'UNAVAILABLE',
              message: `The tunnel did not connect within ${Math.round(timeoutMs / 1000)}s.`,
              nextAction:
                'Check that outbound WebSocket traffic is allowed from this machine, then retry. ' +
                `An HTTP proxy does not help here: ${TUNNEL_DATA_PLANE_PROXY_BYPASS_DESCRIPTION}.`,
              requestId: 'local',
              details: { reason: 'tunnel-connect-timeout', timeoutMs },
            },
          }),
        );
      }, timeoutMs);
      client.start().then(resolve, reject);
    });
  } catch (err) {
    await stopAndDestroy();
    if (err instanceof ApiError) throw err;
    throw ApiError.fromEnvelope({
      error: {
        code: 'UNAVAILABLE',
        message:
          fatal === 'credential-revoked'
            ? `Tunnel credential ${minted.clientId} was revoked, expired, or taken over by another process.`
            : `Could not connect the tunnel: ${err instanceof Error ? err.message : String(err)}`,
        nextAction: 'Retry. If this persists, report it to support@testsprite.com.',
        requestId: 'local',
        details: {
          reason: fatal === 'credential-revoked' ? 'credential-revoked' : 'tunnel-connect-failed',
        },
      },
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  return {
    clientId: minted.clientId,
    expiresAt: minted.expiresAt,
    transport,
    adopted: false,
    fatalReason: () => fatal,
    fatalMessage: () => fatalMessage,
    close: async () => {
      if (closed) return;
      closed = true;
      await stopAndDestroy();
    },
  };
}
