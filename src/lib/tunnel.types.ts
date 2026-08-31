/**
 * Wire types for the `/api/cli/v1/tunnel` facade (DEV-747 piece 1).
 *
 * Three routes and deliberately no fourth — there is no resume/adopt route to
 * hand a `{clientId, secret}` back to, so the CLI mints fresh per invocation.
 */

/** Body of `POST /api/cli/v1/tunnel`. */
export interface MintTunnelBody {
  /**
   * Requested binding lifetime in seconds. Server clamps to [60, 28800] and
   * defaults to 2h. The CLI deletes its own binding at run end, so this is a
   * backstop for a crashed process, not the normal cleanup path.
   */
  ttlSeconds?: number;
}

/**
 * The mint response — the ONE place a tunnel secret ever appears.
 *
 * It is never written to disk, never placed in `argv`, never exported into a
 * child process's environment, and never logged. `config.json` credentials are
 * a settled no for this codebase (452 leaked keys of history), and a tunnel
 * secret is strictly worse than an API key: it authorises an inbound network
 * path into the holder's machine.
 */
export interface TunnelMintResponse {
  clientId: string;
  /** Returned here and nowhere else, ever. */
  secret: string;
  /**
   * WebSocket CONTROL plane the tunnel client authenticates against.
   *
   * Not the proxy plane. The execution Lambda's browser talks to a third,
   * server-side-only endpoint that the CLI never learns; wiring a client at
   * that port produces a failure that reads like an auth error, which is why
   * the facade returns these two explicitly instead of a host/port pair.
   */
  controlUrl: string;
  /** `host:port` of the tunnel DATA plane the client dials over raw TCP. */
  tunnelAddr: string;
  /** ISO8601. After this the binding is gone and the run can no longer attach. */
  expiresAt: string;
}

/**
 * `GET /api/cli/v1/tunnel/{clientId}` — deliberately secret-free.
 *
 * `status` is an open string on the wire (resilience rule 2) even though the
 * server has exactly two values today: an unknown value must degrade, never
 * reject the response.
 */
export interface TunnelStatusResponse {
  clientId: string;
  status: 'online' | 'offline' | (string & {});
  expiresAt: string;
}
