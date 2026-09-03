/**
 * CLI-side pre-flight guard for `--target-url`.
 *
 * Defense-in-depth: the backend is the trust boundary and performs DNS
 * resolution. `assertNotLocal` below does **literal-only** checks
 * to give a fast, friendly error before sending the request — it cannot by
 * itself detect DNS rebinding (a public hostname that resolves to a private
 * IP). That gap is closed one layer up: `target-url-preflight.ts` reuses
 * `disallowedIpReason` (exported below) against the actually-*resolved*
 * address before probing, so the same range list guards both the literal
 * string and the DNS answer — not two drifting copies of it.
 *
 * CLI-side target-url guard (exit 5 on any rejection):
 *  - Reject non-http(s) schemes
 *  - Reject `localhost`, `127.0.0.0/8`, `0.0.0.0/8`, and IPv6 loopback/unspecified (`::1`, `::`)
 *  - Reject `169.254.0.0/16` link-local and the `169.254.169.254` metadata address
 *  - Reject RFC1918 literal IPv4 (10.x, 172.16-31.x, 192.168.x)
 *  - Reject carrier-grade NAT (`100.64.0.0/10`), multicast (`224.0.0.0/4`),
 *    and class E / limited broadcast (`240.0.0.0/4`)
 *  - Decode and re-classify the low 32 bits of standard embedded-IPv4 forms:
 *    IPv4-mapped/translated, RFC 6052 NAT64 (`64:ff9b::/96`), and deprecated
 *    IPv4-compatible (`::/96`); public embedded IPv4 addresses stay allowed
 *  - Reject RFC 8215's NAT64 local-use range (`64:ff9b:1::/48`) wholesale
 *  - Reject IPv6 link-local (`fe80::/10`), unique-local (`fc00::/7`), and
 *    deprecated site-local (`fec0::/10`)
 */

import * as net from 'node:net';
import { ApiError } from './errors.js';

// `--local-host` accepts EXACTLY `localhost`, `127.0.0.1`, `::1` (mirroring
// the server's `isLoopbackString`) — not "anything loopback-shaped". This
// hint is only honest for those three literal hosts (`0.0.0.0` and `::`
// join them below because binding to the unspecified address also answers
// on `127.0.0.1`/`::1`, so `--local`'s default dial reaches it) — NOT for
// the rest of `127.0.0.0/8`, which `--local` cannot dial by name at all. See
// `'loopback-other'` below for that distinction.
const LOCAL_DEV_RUNTIME_HINT =
  "This looks like a local-dev target. Run it with `testsprite test run <test-id> --local <port>` instead — it tunnels this machine's loopback address to the test runner (frontend tests only; requires an API key with the `run:tunnel` scope).";

// Project/test creation happens before the caller necessarily has a test id
// (and project create happens before they have a project at all). Lead those
// callers through the required public project URL first, then name the per-run
// loopback tunnel only after the test exists.
const LOCAL_DEV_BOOTSTRAP_HINT =
  "TestSprite executes tests from the cloud, so a project's URL must be an internet-reachable address the runner can use. " +
  'Set the project to its deployed or staging URL. ' +
  'After a test exists, target an app on this machine for an individual run with ' +
  "`testsprite test run <test-id> --local <port>`; that tunnel is per-run and does not make localhost the project's URL.";

type TargetUrlHintContext = 'runtime' | 'bootstrap';

export interface TargetUrlCaller {
  /** CLI flag name without the leading `--`, used in the error envelope. */
  field: string;
  /** Command prefix without `--help`, for example `testsprite project create`. */
  helpCommand: string;
  hintContext?: TargetUrlHintContext;
}

const DEFAULT_TARGET_URL_CALLER: TargetUrlCaller = {
  field: 'target-url',
  helpCommand: 'testsprite test run',
  hintContext: 'runtime',
};

// Private, reserved, link-local, and metadata addresses are network-reachable from
// the caller's own machine in general (a LAN or VPN address usually answers)
// — what is actually true, and all this hint claims, is that TestSprite's
// execution modes cannot target them: `--target-url` refuses them outright,
// and `--local`'s tunnel only ever dials `localhost` / `127.0.0.1` / `::1`
// on THIS machine, never a LAN/VPC address. Embedded IPv4 addresses inherit
// this hint only after their decoded IPv4 address lands in this class.
const PRIVATE_NETWORK_HINT =
  'This is a private/reserved network address (private, link-local, multicast, or metadata). ' +
  'TestSprite cannot use it as --target-url, and --local cannot tunnel it either — --local only ' +
  'reaches localhost, 127.0.0.1, or ::1 on this machine.';

/**
 * Throws a local `VALIDATION_ERROR` (exit 5) when `rawUrl` is a
 * disallowed target — localhost or a private/reserved literal IP. Also rejects
 * non-http(s) schemes.
 *
 * Silently returns on allowed URLs.
 */
export function assertNotLocal(
  rawUrl: string,
  caller: TargetUrlCaller = DEFAULT_TARGET_URL_CALLER,
): void {
  const { field, helpCommand, hintContext = 'runtime' } = caller;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw localTargetError(field, 'must be a valid URL', helpCommand);
  }

  // Scheme check.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw localTargetError(field, 'must use http or https scheme', helpCommand);
  }

  // Normalize a single trailing dot in the hostname. `localhost.` is the
  // fully-qualified form of `localhost` (RFC 6761 reserves both to resolve to
  // loopback), so `http://localhost.` must be rejected just like
  // `http://localhost`. Without this strip, the trailing-dot form (also
  // reachable via `localhost%2e`) slips past the `host === 'localhost'` check.
  // IP literals are already dot-normalized by the WHATWG URL parser, so this
  // only affects named hosts.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');

  // 'localhost' is a name, not an IP literal, so it sits outside
  // `disallowedIpReason` below (which classifies IPv4/IPv6 address forms).
  // It is also always loopback — the same class `--local` can reach.
  if (host === 'localhost') {
    throw localTargetError(
      field,
      'localhost targets are not allowed',
      helpCommand,
      localDevHintFor(hintContext),
    );
  }

  const disallowed = disallowedIpReason(host);
  if (disallowed !== undefined) {
    throw localTargetError(
      field,
      disallowed.reason,
      helpCommand,
      hintFor(disallowed.hintKind, hintContext),
    );
  }
}

function localDevHintFor(hintContext: TargetUrlHintContext): string {
  return hintContext === 'bootstrap' ? LOCAL_DEV_BOOTSTRAP_HINT : LOCAL_DEV_RUNTIME_HINT;
}

/**
 * Map a classification's `hintKind` to the hint text `assertNotLocal` attaches
 * to the rejection — or no hint at all for `'loopback-other'`/`'undecided'`.
 * Kept as its own function so the four-way mapping is a single, testable
 * spot rather than a nested ternary repeated wherever a classification is
 * consumed.
 */
function hintFor(
  hintKind: DisallowedIpClassification['hintKind'],
  hintContext: TargetUrlHintContext,
): string | undefined {
  switch (hintKind) {
    case 'loopback':
      return localDevHintFor(hintContext);
    case 'loopback-other':
      return undefined;
    case 'private':
      return PRIVATE_NETWORK_HINT;
    case 'undecided':
      return undefined;
  }
}

/**
 * One disallowed-address classification: the human-readable reason (used
 * verbatim in the rejection message — unchanged wording, not a new
 * classification) plus a `hintKind` telling `assertNotLocal` which hint, if
 * any, is honest to attach:
 *  - `'loopback'` — exactly the host set `--local-host` accepts
 *    (`localhost`, `127.0.0.1`, `::1`) plus the two unspecified addresses
 *    (`0.0.0.0`, `::`), which `--local`'s default dial also reaches because
 *    binding to "all interfaces" includes the loopback one; hint `--local`.
 *  - `'loopback-other'` — the REST of `127.0.0.0/8` (e.g. `127.0.0.2`). This
 *    is loopback-range and unreachable from outside the machine, same as
 *    `'loopback'` above, but `--local-host` cannot dial it by name — an app
 *    bound only to `127.0.0.2` does not answer on `127.0.0.1`. Hinting
 *    `--local` here would recommend a command that cannot reach the address
 *    it was just told about, so this gets no hint (a caller who reads the
 *    reason can rebind their dev server onto `127.0.0.1` and get `--local`
 *    to work, but that's their call to make, not a claim this code asserts).
 *  - `'private'` — `--local` can never reach this class even in principle;
 *    hint that plainly, with no tunnel suggestion.
 *  - `'undecided'` — the address genuinely cannot be decoded safely (currently
 *    RFC 8215's `/48` NAT64 local-use range, whose embedded bit position differs
 *    from the `/96` well-known prefix), so neither hint is knowably true.
 *
 * `target-url-preflight.ts` uses only `.reason` and is unaffected by this
 * field's addition.
 */
export interface DisallowedIpClassification {
  reason: string;
  hintKind: 'loopback' | 'loopback-other' | 'private' | 'undecided';
}

/**
 * Classify a bare IP-address literal — IPv4 dotted form, or IPv6 optionally
 * wrapped in the `[...]` bracket notation `URL.hostname` uses — against the
 * private/loopback/link-local/metadata blocklist. Returns the disallowed
 * classification, or `undefined` when the address is allowed.
 *
 * This is the single source of truth for the range list: `assertNotLocal`
 * calls it for the literal `--target-url` string above, and the reachability
 * preflight (`target-url-preflight.ts`) calls it again for a DNS-*resolved*
 * address — a public-looking hostname whose A/AAAA record actually points
 * at a private or metadata IP (DNS rebinding) is a distinct bypass from a
 * literal private IP typed on the command line, and both need the same
 * range list, not two drifting copies of it.
 */
export function disallowedIpReason(host: string): DisallowedIpClassification | undefined {
  // IPv6 literals. Node's URL parser wraps IPv6 hosts in brackets and
  // normalizes IPv4-mapped forms to hex (`http://[::ffff:127.0.0.1]` →
  // hostname `[::ffff:7f00:1]`). A dotted-form string check alone would miss
  // the normalized variant, so we strip the brackets and classify the
  // address family explicitly. A DNS-resolved IPv6 address arrives
  // unbracketed already; stripping is a no-op for that shape.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const addressFamily = net.isIP(bare);
  if (addressFamily === 6) {
    return disallowedIpv6Reason(bare.toLowerCase());
  }
  return addressFamily === 4 ? disallowedIpv4Reason(bare) : undefined;
}

function disallowedIpv4Reason(address: string): DisallowedIpClassification | undefined {
  // Unspecified — binds every interface, including loopback.
  if (address === '0.0.0.0') {
    return { reason: 'localhost targets are not allowed', hintKind: 'loopback' };
  }

  // Only the literal 127.0.0.1 is in `--local-host`'s exact accepted set.
  if (ipv4LoopbackBlocklist.check(address, 'ipv4')) {
    return {
      reason: 'loopback addresses are not allowed',
      hintKind: address === '127.0.0.1' ? 'loopback' : 'loopback-other',
    };
  }

  // AWS instance-metadata service. Keep the specific diagnostic ahead of the
  // enclosing link-local subnet rule.
  if (address === '169.254.169.254') {
    return {
      reason: '169.254.169.254 (AWS metadata service) is not allowed',
      hintKind: 'private',
    };
  }

  if (ipv4ThisNetworkBlocklist.check(address, 'ipv4')) {
    return { reason: 'reserved "this network" addresses are not allowed', hintKind: 'private' };
  }
  if (ipv4LinkLocalBlocklist.check(address, 'ipv4')) {
    return { reason: 'link-local addresses are not allowed', hintKind: 'private' };
  }
  if (ipv4Rfc1918Blocklist.check(address, 'ipv4')) {
    return { reason: 'private/RFC1918 addresses are not allowed', hintKind: 'private' };
  }
  if (ipv4CgnatBlocklist.check(address, 'ipv4')) {
    return { reason: 'carrier-grade NAT addresses are not allowed', hintKind: 'private' };
  }
  if (ipv4MulticastBlocklist.check(address, 'ipv4')) {
    return { reason: 'multicast addresses are not allowed', hintKind: 'private' };
  }
  if (ipv4ClassEBlocklist.check(address, 'ipv4')) {
    return { reason: 'reserved/class E addresses are not allowed', hintKind: 'private' };
  }
  return undefined;
}

/**
 * Standard IPv6 forms that encode a literal IPv4 address in their low 32 bits —
 * IPv4-mapped (`::ffff:a.b.c.d`), IPv4-translated (`::ffff:0:a.b.c.d`),
 * RFC 6052's well-known NAT64 prefix (`64:ff9b::/96`), and IPv4-compatible
 * (deprecated, `::a.b.c.d`). RFC 8215's local-use `64:ff9b:1::/48` is a
 * separate blanket refusal because its embedded address is not in the low
 * 32 bits.
 *
 * `net.BlockList` — binary subnet matching, not a per-spelling regex or
 * `startsWith` — is what makes the spelling question go away entirely: the
 * WHATWG URL parser COMPRESSES some of these forms
 * (`0:0:0:0:0:ffff:a9fe:a9fe` → `::ffff:a9fe:a9fe`) while it PRESERVES others
 * verbatim (`::ffff:0:a9fe:a9fe` stays exactly as typed), so a check tuned to
 * one textual shape reliably misses the other — which is exactly how
 * `64:ff9b::a9fe:a9fe` (NAT64-encoded AWS metadata) once reached the network
 * unrejected. Binary matching also holds for NON-canonical input, which a
 * `startsWith` check on a canonical-form assumption does not.
 *
 * Each class keeps its own list so it can be decoded only where its prefix
 * defines the low 32 bits as IPv4. The three are checked mapped → NAT64 →
 * compatible, preserving the established class precedence.
 *
 * This is the SAME primitive `src/vendor/tunnel-client/client.ts`'s
 * `blockedTargetReason` already uses for the identical problem (see its
 * VENDOR.md deltas #7/#10) — the two host classifiers in this repo now
 * share one mechanism instead of two independently maintained spelling
 * lists, so a future NAT64-shaped bypass can't reopen only one of them.
 *
 * The matched `/96` forms are decoded from their final two 16-bit groups and
 * re-classified through the IPv4 blocklists. This makes an embedded public
 * address public while preserving the decoded address's exact hint class.
 */
const IPV4_MAPPED_SUBNETS: ReadonlyArray<readonly [string, number]> = [
  // Exact `/96` prefixes whose canonical `::` head contains only zero/ffff
  // groups. Keeping them exact avoids the old `/80` rule's false positives on
  // a non-embedded group while covering mapped, translated, and repeated-ffff
  // spellings on the same binary value seen by URL and DNS paths.
  ['0:0:0:0:0:ffff:0:0', 96],
  ['0:0:0:0:ffff:0:0:0', 96],
  ['0:0:0:0:ffff:ffff:0:0', 96],
  ['0:0:0:ffff:0:0:0:0', 96],
  ['0:0:0:ffff:0:ffff:0:0', 96],
  ['0:0:0:ffff:ffff:0:0:0', 96],
  ['0:0:0:ffff:ffff:ffff:0:0', 96],
  ['0:0:ffff:0:0:ffff:0:0', 96],
  ['0:0:ffff:0:ffff:0:0:0', 96],
  ['0:0:ffff:0:ffff:ffff:0:0', 96],
  ['0:0:ffff:ffff:0:0:0:0', 96],
  ['0:0:ffff:ffff:0:ffff:0:0', 96],
  ['0:0:ffff:ffff:ffff:0:0:0', 96],
  ['0:0:ffff:ffff:ffff:ffff:0:0', 96],
];

/**
 * The RFC 6052 well-known prefix stores IPv4 in the final 32 bits, so it can
 * be decoded. RFC 8215 local-use has a different bit layout and stays a
 * separate, undecoded `/48` blanket refusal.
 */
const NAT64_SUBNETS: ReadonlyArray<readonly [string, number]> = [['64:ff9b::', 96]];
const NAT64_LOCAL_USE_SUBNETS: ReadonlyArray<readonly [string, number]> = [['64:ff9b:1::', 48]];

/**
 * Deprecated IPv4-compatible addresses use `::/96`; a broader `::/32` would
 * read genuine IPv6 interface bits as IPv4 and reject targets the backend
 * accepts. `::` and `::1` are exact-matched before this list is consulted.
 */
const IPV4_COMPATIBLE_SUBNETS: ReadonlyArray<readonly [string, number]> = [['::', 96]];

function blocklistOf(
  subnets: ReadonlyArray<readonly [string, number]>,
  family: 'ipv4' | 'ipv6',
): net.BlockList {
  const list = new net.BlockList();
  for (const [network, prefix] of subnets) {
    list.addSubnet(network, prefix, family);
  }
  return list;
}

const ipv4ThisNetworkBlocklist = blocklistOf([['0.0.0.0', 8]], 'ipv4');
const ipv4LoopbackBlocklist = blocklistOf([['127.0.0.0', 8]], 'ipv4');
const ipv4Rfc1918Blocklist = blocklistOf(
  [
    ['10.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
  ],
  'ipv4',
);
const ipv4CgnatBlocklist = blocklistOf([['100.64.0.0', 10]], 'ipv4');
const ipv4LinkLocalBlocklist = blocklistOf([['169.254.0.0', 16]], 'ipv4');
const ipv4MulticastBlocklist = blocklistOf([['224.0.0.0', 4]], 'ipv4');
const ipv4ClassEBlocklist = blocklistOf([['240.0.0.0', 4]], 'ipv4');

const ipv4MappedBlocklist = blocklistOf(IPV4_MAPPED_SUBNETS, 'ipv6');
const nat64Blocklist = blocklistOf(NAT64_SUBNETS, 'ipv6');
const nat64LocalUseBlocklist = blocklistOf(NAT64_LOCAL_USE_SUBNETS, 'ipv6');
const ipv4CompatibleBlocklist = blocklistOf(IPV4_COMPATIBLE_SUBNETS, 'ipv6');
const ipv6LinkLocalBlocklist = blocklistOf([['fe80::', 10]], 'ipv6');
const ipv6UniqueLocalBlocklist = blocklistOf([['fc00::', 7]], 'ipv6');
const ipv6SiteLocalBlocklist = blocklistOf([['fec0::', 10]], 'ipv6');

function decodeLow32BitsAsIpv4(address: string): string | undefined {
  const groups = address.split(':');
  const last = groups.at(-1);
  if (last === undefined) return undefined;

  // A DNS result can preserve the human-written dotted tail even though the
  // WHATWG URL path canonicalises it to two hex groups.
  if (net.isIP(last) === 4) return last;

  const secondLast = groups.at(-2);
  if (secondLast === undefined) return undefined;
  const high = Number.parseInt(secondLast, 16);
  const low = Number.parseInt(last, 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return undefined;
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function reclassifyEmbeddedIpv4(
  address: string,
  label: string,
): DisallowedIpClassification | undefined {
  const decoded = decodeLow32BitsAsIpv4(address);
  if (decoded === undefined) {
    return {
      reason: `${label} address could not be decoded safely`,
      hintKind: 'undecided',
    };
  }

  const decodedClassification = disallowedIpv4Reason(decoded);
  if (decodedClassification === undefined) return undefined;
  return {
    reason: `${label} address embeds disallowed IPv4 address ${decoded}: ${decodedClassification.reason}`,
    hintKind: decodedClassification.hintKind,
  };
}

/**
 * Classify disallowed IPv6 literals: loopback (`::1`), unspecified (`::`),
 * the embedded-IPv4 family (see {@link IPV4_MAPPED_SUBNETS}'s doc comment),
 * link-local (`fe80::/10`), unique-local (`fc00::/7`), and deprecated
 * site-local (`fec0::/10`). `inner` is the
 * bracket-stripped, already-lowercased host — `disallowedIpReason` lowercases
 * it on the way in rather than trusting every caller to.
 */
function disallowedIpv6Reason(inner: string): DisallowedIpClassification | undefined {
  // Loopback (::1) and unspecified (::).
  if (inner === '::1' || inner === '::') {
    return { reason: 'localhost targets are not allowed', hintKind: 'loopback' };
  }
  // Embedded-IPv4 family, checked mapped → NAT64 → compatible. Standard /96
  // forms inherit the decoded IPv4 classification; RFC 8215 local-use stays
  // wholesale and undecided because its embedded address has a different bit
  // position.
  if (ipv4MappedBlocklist.check(inner, 'ipv6')) {
    return reclassifyEmbeddedIpv4(inner, 'IPv4-mapped/translated IPv6');
  }
  if (nat64Blocklist.check(inner, 'ipv6')) {
    return reclassifyEmbeddedIpv4(inner, 'NAT64-translated IPv6');
  }
  if (nat64LocalUseBlocklist.check(inner, 'ipv6')) {
    return {
      reason: 'NAT64 local-use addresses are not allowed',
      hintKind: 'undecided',
    };
  }
  if (ipv4CompatibleBlocklist.check(inner, 'ipv6')) {
    return reclassifyEmbeddedIpv4(inner, 'IPv4-compatible/deprecated IPv6');
  }
  if (ipv6LinkLocalBlocklist.check(inner, 'ipv6')) {
    return { reason: 'link-local addresses are not allowed', hintKind: 'private' };
  }
  if (ipv6UniqueLocalBlocklist.check(inner, 'ipv6')) {
    return { reason: 'unique-local (private) addresses are not allowed', hintKind: 'private' };
  }
  if (ipv6SiteLocalBlocklist.check(inner, 'ipv6')) {
    return {
      reason: 'site-local (deprecated private) addresses are not allowed',
      hintKind: 'private',
    };
  }
  return undefined;
}

function localTargetError(
  field: string,
  reason: string,
  helpCommand: string,
  hint?: string,
): ApiError {
  return ApiError.fromEnvelope({
    error: {
      code: 'VALIDATION_ERROR',
      message: `Field \`${field}\` is invalid: ${reason}.`,
      nextAction: hint
        ? hint + ` See \`${helpCommand} --help\` for accepted values.`
        : `See \`${helpCommand} --help\` for accepted values.`,
      requestId: 'local',
      details: { field, reason, ...(hint ? { hint } : {}) },
    },
  });
}
