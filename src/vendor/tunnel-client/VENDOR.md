# Vendored: TestSprite tunnel Node client

`client.ts`, `protocol.ts` and `types.ts` are copies of the tunnel repo's
`clients/node/src/`. They are **not** to be edited except through the deltas
listed below — fix protocol bugs upstream and re-sync.

| field         | value                                      |
| ------------- | ------------------------------------------ |
| source repo   | `TestSprite/tunnel`                        |
| source branch | `v2-patch`                                 |
| source commit | `4a3c8359b152f07f945f82e6901eebabe90483b7` |
| source path   | `clients/node/src/`                        |
| synced on     | 2026-10-02                                 |

Per-file blobs at that commit, verified on every re-sync:

| file          | blob                                       |
| ------------- | ------------------------------------------ |
| `client.ts`   | `8676de6c6f255453eecc2b925ce6b122bfab20b5` |
| `protocol.ts` | `dc7d36e0e090eb5d33c851ca9c106a5bfd171039` |
| `types.ts`    | `31ad244d0ec8a5b47216d6f2488445c48d40e02b` |

## Why vendored rather than reimplemented

The Rust server, this Node client and the MCP plugin's hand-port already
implement this wire protocol. The hand-port omitted the frame-bounds fix
(`MAX_TUNNEL_FRAME` in `protocol.ts`): four stray bytes (`"GET "`, read as a
length prefix) decoded to a 1.1 GiB allocation and took dev down on 2026-08-14.
A fourth independent implementation is not acceptable. This is a copy with a
diffable delta list and a sync script.

## Deliberate deltas from upstream

Numbers remain stable; retired numbers are recorded under **Upstreamed**.
Every remaining difference in the three copied files must map to an entry here.

- **#1. `ws` → `./ws-compat.ts`** (`client.ts`). The CLI uses its existing undici
  dependency through the compatibility facade, including the global dispatcher
  and the facade's ping/pong behavior.
- **#2. `lodash` → `./lodash-lite.ts`** (`client.ts`). Three predicates avoid adding
  a runtime dependency.
- **#3. Explicit endpoints and fixed configuration** (`config.ts`, `types.ts`,
  `client.ts`). Keep the CLI's configuration: no hard-coded endpoint defaults,
  package-version import, `TSTUN_*` overrides or private-target environment
  override. `controlUrl` and `tunnelAddr` are required and come from
  `POST /api/cli/v1/tunnel`; `tunnelTlsAddr` alone selects TLS. The constructor
  cannot fall back to upstream's production endpoints or default TLS transport.
  Timing defaults remain fixed at their existing CLI values. The upstream
  unknown-client deadline constant is retained without environment reads; it
  is normally inactive for this CLI because of #20.
- **#4. `logSink`** (`types.ts`, `client.ts`). All client logs use an injected sink;
  the default writes only to stderr. Upstream's console logging would corrupt
  `--output json`. The CLI-owned sink also scrubs the tunnel secret.
- **#5. CLI exports** (`index.ts`). Additionally re-export `resolveDialCandidates`
  and `blockedTargetReason` so the pre-charge port probe uses the same dial
  candidates as the tunnel. Keep the CLI's error and option exports.
- **#6. Files not copied**: `control.ts` (unused by `client.ts`), `cli.ts`,
  `utils.ts`, `tunnel.ts` (empty), `example/`. The CLI owns configuration and
  command construction rather than upstream's standalone command.
- **#12. Bounded undici close** (`ws-compat.ts`; no copied-file change). An OPEN
  undici WebSocket sends Close and enters CLOSING without a peer-response
  timeout. The shim arms a grace timer, unrefs the captured raw socket and
  synthesizes `close` (1006) so the client's ordinary close handler runs even
  when the peer never answers. Preserve the CONNECTING close behavior too.
- **#15. Supported blocked-target remedies** (`client.ts`). Keep the CLI's exact
  advice: make the dependency reachable through this machine's loopback or a
  public address. Do not suggest an environment variable or private-target
  option that the CLI does not expose. The refusal policy is upstream's.
- **#19. Control socket capture isolation** (`ws-compat.ts`; no copied-file change).
  Scope diagnostic capture to the upgrade origin, host, port, path and query;
  normalize ws/http and wss/https defaults and proxy absolute paths. Clean up
  subscriptions after a match and on construction failure, open, error, real
  close or local close. This remains CLI-local: upstream uses native `ws` and
  has no undici capture seam to receive this change.
- **#20. No `client-unknown` advertisement** (`client.ts`, one removed line).
  Upstream has no option to disable this capability. The CLI cannot
  re-register the same ID, so advertising it would replace today's terminal
  `AUTH_FAILED` on a wiped server registry with up to two minutes of futile
  retries. Keep the legacy server-visible URL behavior. The upstream recovery
  machinery and types are normally dormant. If a server ever sent
  `CLIENT_UNKNOWN` unsolicited, this copy would retry for 120 seconds, emit
  a non-terminal `ClientUnknown` error and stop itself. That path is
  unreachable with the current server: `src/control/mod.rs` at `4a3c8359`
  sends `CLIENT_UNKNOWN` only to clients advertising the capability. The CLI
  consumer treats only `AuthFailed` and `DataPlaneUnreachable` as terminal.
  Adoption requires a backend endpoint
  that re-registers the **same client ID and secret**, plus a CLI recovery hook;
  minting a new ID cannot repair an in-flight run's baked-in proxy credentials.
- **#21. Construction compatibility** (`client.ts`). Keep zero-valued connect/TLS
  handshake timeouts and their existing validation messages. Preserve the
  CLI's stricter DNS-authority validation, all `Invalid tunnel address` error
  text, literal IPv6 spelling, trailing-dot DNS hosts, explicit SNI acceptance
  and the existing missing/blank SNI errors. Upstream's looser plaintext host
  validation must not weaken a refusal, and its new SNI restrictions must not
  change accepted CLI mint responses. The one intentional address-validation
  difference from the previous CLI is upstream's backslash refusal: `a\b:1`
  now throws `Invalid tunnel address` instead of accepting and truncating
  the host to `a`. Keep this stricter validation for both data-plane addresses.
- **#22. Node ESM and strict indexing** (`client.ts`). Local imports use `.js`
  extensions for the CLI's NodeNext build. `LEVEL_ORDER` is keyed by `LogLevel`
  and the logging method parameters use that union, satisfying
  `noUncheckedIndexedAccess` without changing runtime behavior.
- **#23. CLI diagnostics and events** (`client.ts`). Preserve the authentication
  timeout text, uppercase `[REDACTED]`, data-plane close/error prefixes and
  fallback detail. Keep the existing connected/closed log placement and
  `tunnel-disconnected` event behavior. Omit the new established-info log and
  constructor plaintext warning: `openTunnelSession` already owns the exact
  user-facing plaintext warning. Adopt upstream's redacted established-error
  warning as a strict fix for a previously swallowed transport error. Adopt
  upstream's suppression of control disconnect errors during intentional stop.
- **#24. Legacy extra-CA sampling** (`client.ts`). On Node versions without
  `getCACertificates('default')`, keep `NODE_EXTRA_CA_CERTS` PEM reads lazy and
  cached per path rather than adding a module-startup read. Preserve the
  existing explicit-root/default-root behavior and operator file diagnostics.
- **#25. Deadline rounding** (`client.ts`). Round the remaining monotonic data-plane
  deadline upward with `Math.ceil`, as the previous CLI did. A fractional
  millisecond otherwise truncates in `setTimeout` and expires the retry window
  one millisecond early. Episode lifecycle and defaults are upstream's.
- **#26. Quiet stream teardown** (`client.ts`). Do not report stream failures when
  that stream's composed lifecycle/target signal is aborted or the client is
  no longer running. Stopping during a pending DNS lookup or target dial must
  not print a spurious `StreamFailed` diagnostic; the same applies to control
  disconnect, `CloseTunnel` and streams left over from an earlier lifecycle.
  Preserve real stream failure codes and messages while running. Keep stream
  cleanup and composed-signal disposal unchanged. This is an upstream
  candidate for the Node client's `handleIncomingStream` catch.

## Upstreamed

- Former #7: binary IPv6 classification and embedded-IPv4 refusal — `55e3471`.
- Former #8: stop a CONNECTING control socket — `91970c6`.
- Former #9: cancellable reconnect backoffs and restart renewal — `91970c6`.
- Former #10: 6to4, Teredo and site-local refusal — `55e3471`.
- Former #11: `/32` NAT64 and IPv4-compatible supersets — `55e3471`.
- Former #13: outstanding target socket teardown, including pending DNS/dials — `91970c6`.
- Former #14: generation-scoped first-Ack readiness and authentication timeout — `91970c6`.
- Former #16: terminal revocation/takeover — `b997fdb`, `f28d2e0`, `55e3471` (CLI-exact messages and backoff abort).
- Former #17: immutable TLS data plane, trust roots, strict authorities and bounded handshakes — `a5fb58f`, `4b0f946`, `ad4dce3`, `1d1c001`; compatibility details remain in #21/#24.
- Former #18: terminal data-plane retry deadline and establishment-scoped episodes — `ad4dce3`, `1d1c001`, `55e3471`; CLI text/rounding remain in #23/#25.

## Re-syncing

Run `scripts/sync-tunnel-client.sh /path/to/tunnel 4a3c8359` against a local
checkout or worktree. It verifies the source blob table and prints every
copied-file difference. Review every hunk against the delta list, apply upstream
fixes, re-apply the necessary CLI deltas and update the source table.

`scripts/sync-tunnel-client.sh` is still **not in CI** because CI cannot read
the tunnel repository without a cross-repository read credential. No workflow
is added for this re-sync.

## Target policy

Loopback and globally routable targets are allowed; private/reserved space is
refused. Do not narrow this to loopback-only: execution Chromium proxies every
request (`bypass='<-loopback>'`), including fonts and identity providers.
`allowPrivateNetworkTarget` remains hard-coded `false` at the CLI construction
site and is not exposed as a flag. Binary embedded-IPv4 coverage agrees with
`src/lib/target-url.ts`; loopback treatment deliberately differs, and the tunnel
also refuses 6to4, Teredo and site-local space. Native `::1` and mapped loopback
remain exempt before the embedded-IPv4 rules.
