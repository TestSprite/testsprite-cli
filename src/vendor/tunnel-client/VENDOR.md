# Vendored: TestSprite tunnel Node client

`client.ts`, `protocol.ts` and `types.ts` are copies of the tunnel repo's
`clients/node/src/`. They are **not** to be edited except through the deltas
listed below — fix protocol bugs upstream and re-sync.

| field         | value                                      |
| ------------- | ------------------------------------------ |
| source repo   | `TestSprite/tunnel`                        |
| source branch | `v2-patch`                                 |
| source commit | `c00a695a691f0c92e70659bc0cb93852bb569a9a` |
| source path   | `clients/node/src/`                        |
| synced on     | 2026-08-24                                 |

Per-file blobs at that commit, verified on every re-sync:

| file          | blob                                       |
| ------------- | ------------------------------------------ |
| `client.ts`   | `a33333d6a67396d02cf0934f27c7c1075a0733fb` |
| `protocol.ts` | `dc7d36e0e090eb5d33c851ca9c106a5bfd171039` |
| `types.ts`    | `936a9f2d6b8902d857e2a0312475966272477214` |

## Why vendored rather than reimplemented

There are already three implementations of this wire protocol — the Rust
server, this Node client, and the MCP plugin's hand-port. The hand-port drifted
and shipped without the frame-bounds fix (`MAX_TUNNEL_FRAME` in `protocol.ts`),
which is what let four stray bytes (`"GET "`, read as a length prefix) decode to
a 1.1 GiB allocation and take dev down on 2026-08-14. A fourth independent
implementation is not acceptable, so this is a copy with a diffable delta list
and a sync script — not a fork.

## Deliberate deltas from upstream

Everything here is an isolated, one-purpose change. Anything larger belongs
upstream.

1. **`ws` → `./ws-compat.ts`** (`client.ts`, one import line). This CLI ships
   three runtime dependencies on purpose; `undici` is already one of them and
   its `WebSocket` is the same RFC 6455 implementation. See that file for the
   two behavioural notes (`ping`/`pong` and the global dispatcher).
2. **`lodash` → `./lodash-lite.ts`** (`client.ts`, one import line). Three
   predicates, a dozen lines.
3. **`./config.ts` rewritten.** Upstream reads `TSTUN_*` env vars and falls
   back to hard-coded TestSprite dev ALB/NLB hostnames. Those must not ship in
   a package published to the public npm registry, and a default endpoint is
   precisely the failure the facade exists to prevent — `controlUrl` and
   `tunnelAddr` come from `POST /api/cli/v1/tunnel` and nowhere else. The
   endpoint defaults are removed and the two options are now **required**
   (`types.ts` delta). `CLIENT_VERSION` (an upstream `package.json` import)
   is dropped; it was only referenced from commented-out code.
4. **`logSink`** (`types.ts` + `client.ts`). Upstream logs through
   `console.log` / `console.warn`, i.e. STDOUT, which would corrupt this CLI's
   `--output json` contract. Default sink is stderr; the CLI injects its own.
5. **`./index.ts`** additionally re-exports `resolveDialCandidates` and
   `blockedTargetReason`, so the pre-charge port preflight dials the same
   candidate set the client dials at run time instead of an independent guess.
6. **Not copied:** `control.ts` (dead — `client.ts` handles the control plane
   inline and never imports it), `cli.ts`, `utils.ts`, `tunnel.ts` (empty),
   `example/`.
7. **IPv6 target classification uses binary `net.BlockList` matching**
   (`client.ts`). The spelling-specific `toIpv4Mapped()` regexes are removed;
   mapped loopback stays allowed, while compatible, mapped, translated, and
   NAT64 embedded-IPv4 spaces are refused consistently across textual forms.

8. **`stop()` also closes a control socket still in `CONNECTING`**
   (`client.ts`). Upstream closes only an `OPEN` one, so a control plane that
   accepts TCP without completing the WebSocket handshake left `stop()` awaiting
   the control loop parked in that handshake — it never returned, and the
   caller's teardown never reached the credential delete that follows it.
   `ws-compat.ts` gained the matching `CONNECTING` static.
9. **Reconnect backoffs are cancellable** (`client.ts`). Both the control and
   tunnel loops wait on the same lifecycle abort signal; `stop()` aborts it
   before awaiting either loop, so teardown settles promptly and leaves no
   referenced backoff timer behind. A later `start()` creates a fresh signal.
10. **6to4, Teredo, and deprecated IPv6 site-local space are refused**
    (`client.ts`). `2002::/16` and `2001::/32` are IPv4-derived encapsulation
    prefixes and join delta 7's embedded-IPv4 refusal; `fec0::/10` joins the
    private-scope ranges. `2001:db8::/32` remains allowed.
11. **NAT64 and IPv4-compatible refusal widened to `/32`** (`client.ts`).
    Delta 7's NAT64 and IPv4-compatible entries were the canonical-form
    prefixes only (`64:ff9b::/96` + `64:ff9b:1::/48`; `::/96`) — a
    reserved-but-non-canonical NAT64 prefix landing between the two (e.g.
    `64:ff9b:ffff::a9fe:a9fe`, which is in neither) still reached the network
    unrejected. Both are now the single `/32` superset of their family
    (`64:ff9b::/32`; `::/32`), matching `src/lib/target-url.ts`'s
    `NAT64_SUBNETS` / `IPV4_COMPATIBLE_SUBNETS` — the two host classifiers'
    embedded-IPv4 coverage is meant to be identical (see that file's doc
    comment), and this delta is what makes that claim true again. Both
    widened prefixes sit inside IETF-reserved space (`0064::/16`,
    `0000::/8`), so nothing globally routable is newly refused. `::1` and
    mapped loopback (`::ffff:127.0.0.0/104`) are unaffected: the loopback
    `BlockList` in `blockedTargetReason` is checked first and returns before
    this one is consulted. Note the coverage here is NOT identical to
    `target-url.ts`'s in both directions — this file additionally refuses 6to4,
    Teredo and site-local (delta 10), which that one does not; the two agree on
    the embedded-IPv4 family and deliberately disagree on loopback.

12. **`ws-compat.ts`'s `close()` is not a passthrough** (no vendored file
    changed). Upstream's `ws` resolves `stop()` because the peer answers the
    closing handshake. undici's `WebSocket.close()` on an OPEN connection only
    SENDS a Close frame and sets `CLOSING` — it never aborts the controller,
    destroys the socket, or applies any timeout — so a control peer that never
    answers left the socket ref'd and the process hung with the right message
    already printed. The shim therefore arms a bounded grace timer, `unref()`s
    the raw socket it captured from undici's `undici:client:connected`
    diagnostics channel, and SYNTHESIZES a `close` event (code 1006) so
    `client.ts`'s own unmodified `ws.on("close", ...)` handler runs exactly as
    it would for a real close. Recorded here because the delta is invisible in
    `client.ts`'s diff: a future re-sync must not assume `close()` is a thin
    forward, and the capture filter in particular is load-bearing — a miss
    there is silent and restores the hang with every test still green.
13. **Outstanding proxy target sockets are destroyed on teardown** (`client.ts`).
    Upstream tracks only `runtime.socket` (the tunnel data-plane socket) and
    leaves each per-stream target socket dialed in `connectOnce` to close on its
    own. But the browser proxies ALL of its traffic through the tunnel, so a run
    routinely opens keep-alive connections to external hosts (e.g.
    `accounts.google.com:443`) that hold the socket open and send nothing —
    `proxyStreams`'s `copyOneWay(target, …)` then parks forever and its
    `finally`-cleanup never runs. Destroying `runtime.socket` does not reach these
    independent sockets, so on `stop()` they stay `ESTABLISHED` and ref'd, keeping
    the event loop alive until the remote's own idle timeout (minutes). Visible
    symptom: a `--local` run's Ctrl-C or `--timeout` printed the right message,
    cancelled the run server-side, then hung. Fix: a `activeTargetSockets` set,
    populated in `connectOnce` (removed on `close`) and drained in
    `stopAllTunnelRuntimes` — the single data-plane teardown chokepoint, so both
    `stop()` and a `CloseTunnel` clean up. Complements #12: that closed the
    control socket, this closes the data-plane target sockets — a distinct leak
    the control-socket fix exposed rather than covered. Upstream candidate
    (DEV-1030): the Rust client has the same shape.

## Re-syncing

Maintainers diff the three vendored files against a checkout of the upstream
tunnel client at the commit named above, apply upstream changes by hand,
re-apply the deltas listed here, then update the table at the top of this file.
The blob hashes above are what that check compares against.

## Target policy

`ensureTargetAllowed` is upstream's, unchanged: **loopback and
globally-routable targets are allowed; private/reserved space is refused.**
Do not narrow this to loopback-only — the execution Lambda's Chromium proxies
_every_ request through this client (`bypass='<-loopback>'`), so a page pulling
a web font or hitting an identity provider is normal traffic. Verified on dev
2026-08-24: `accounts.google.com` and `cf.browser-use.com` both crossed the same
client during a real `--local` run. `allowPrivateNetworkTarget` is hard-coded
`false` here and is not exposed as a CLI flag.
