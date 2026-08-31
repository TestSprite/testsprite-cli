/**
 * VENDOR DELTA (not upstream). Upstream's `config.ts` reads `TSTUN_*`
 * environment variables and falls back to **hard-coded TestSprite dev
 * ALB/NLB hostnames**. Neither belongs in a package published to the public
 * npm registry:
 *
 *   - the endpoints are internal infrastructure names, and a default value is
 *     still a value that ships;
 *   - a default endpoint is the failure mode the facade exists to prevent.
 *     `POST /api/cli/v1/tunnel` returns `controlUrl` and `tunnelAddr` for the
 *     environment the caller authenticated against, and those are the ONLY
 *     endpoints this client may dial. A default would let a
 *     misconfigured/partially-constructed client silently connect somewhere
 *     else and fail in a way that reads like an auth problem.
 *
 * So the endpoint defaults are gone and `TunnelClientOptions.controlUrl` /
 * `.tunnelAddr` are required by the caller (`lib/tunnel-session.ts` passes
 * the mint response through verbatim). The timing constants below are
 * upstream's values.
 */

/** Heartbeat cadence on the control WebSocket. Upstream default. */
export const DEFAULT_HEARTBEAT_MS = 10_000;

/** Delay between control/tunnel reconnect attempts. Upstream default. */
export const DEFAULT_RECONNECT_MS = 3_000;

/** Log verbosity floor. Upstream default. */
export const DEFAULT_LOG_LEVEL = 'info' as const;

/** Per-attempt dial timeout when connecting to the proxied target. Upstream default. */
export const DEFAULT_TARGET_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Whether a proxied target may resolve into private address space.
 *
 * Upstream reads `TS_TUNNEL_ALLOW_PRIVATE_NETWORK_TARGET`. This CLI hard-codes
 * `false` and exposes no flag for it: the whole point of `--local` is to reach
 * the caller's own loopback, and a run that pivots into the rest of their
 * network is the failure this rail exists to stop. Loopback and public targets
 * are unaffected — the browser under test proxies every request, so a page
 * pulling a font or calling a third-party API is normal traffic (verified on
 * dev 2026-08-24: `accounts.google.com` and `cf.browser-use.com` both crossed
 * the same client during a real run).
 */
export const DEFAULT_ALLOW_PRIVATE_NETWORK_TARGET = false;
