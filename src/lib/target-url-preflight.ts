/**
 * Pre-charge reachability preflight for a caller-supplied `--target-url`.
 *
 * A blocked-run analysis measured 1,003 blocked-with-URL CLI runs: 26%
 * pointed at a third-party tunnel host (`*.trycloudflare.com`, `*.loca.lt`,
 * ngrok), 55.5% of those were blocked, and every one of them was charged
 * anyway — the run row and its credit spend happen before the Lambda ever
 * discovers the target is dead. This probe runs BEFORE the trigger POST so
 * an obviously-doomed run never gets a run row or a charge.
 *
 * **Honest limitation** (this must also be stated in `--help` and the PR
 * body): the probe below runs from wherever this CLI process runs — the
 * caller's laptop, a CI runner — while the actual test executes from a
 * Lambda inside AWS. Reachability from one is not proof of reachability
 * from the other. That asymmetry is why the refusal set is deliberately
 * narrow (only the failure classes that analysis actually measured — a
 * broader rule would not have prevented a single one of those 1,003 runs), why
 * every ambiguous signal downgrades to a warning instead of a hard block,
 * and why `--skip-preflight` exists as a full opt-out (zero network calls).
 *
 * Two injectable seams, mirroring the MCP plugin's `checkPortListening`
 * shape (a cheap first check, then an HTTP-level fallback for the signal
 * the first check can't see) rather than inventing a new one:
 *   - `dnsLookup` — a raw DNS resolution. Deliberately separate from the
 *     HTTP probe below: `proxy.ts` installs a proxy dispatcher that only
 *     `fetch()` honours, never a raw socket/DNS call, so behind a
 *     configured HTTP(S) proxy this step can fail locally (the real
 *     resolution happens at the proxy) even though the target is reachable
 *     — hence the proxy carve-out downgrades a negative *failure* result
 *     here. A resolved address landing in the private/loopback/link-local/
 *     metadata range is a different kind of signal (DNS rebinding, not
 *     ambiguity about where resolution happens) and always refuses — see
 *     the resolved-address check below.
 *   - `fetchImpl` — the actual HTTP probe (proxy-aware once a proxy
 *     dispatcher is installed), used for the 502/503/504 gateway-error
 *     signal a DNS/TCP-level check cannot see at all. Runs with
 *     `redirect: 'manual'`: a 3xx is treated as a live/reachable signal
 *     (a real app 302ing to a login page is healthy) but is never
 *     followed — the redirect target is unvalidated by everything above
 *     (`assertNotLocal` only ever inspected the literal `--target-url`
 *     string; the resolved-address check only covers *this* URL's host),
 *     so following it would hand an attacker-controlled Location header a
 *     live SSRF primitive running on the caller's machine or CI runner.
 *
 * One redirect is refused: Vercel Deployment Protection's login wall. Its
 * Location is parsed as a string and never fetched, so the guarantee above
 * holds. Unlike the app's own login page, no test credential gets past
 * Vercel's wall. The honest limitation above (the probe runs here, not on
 * the Lambda) does not apply either: Vercel sends every visitor without a
 * Vercel session there, the Lambda included.
 */

import * as dns from 'node:dns';
import { isIP } from 'node:net';
import { ApiError, InterruptError } from './errors.js';
import { globalShutdown, type ShutdownHandle } from './interrupt.js';
import { isProxyAgentActive } from './proxy.js';
import { disallowedIpReason } from './target-url.js';

/** ~8s, matching the MCP plugin's `checkPortListening` TCP-probe budget. */
const PREFLIGHT_TIMEOUT_MS = 8_000;

const GATEWAY_ERROR_STATUSES = new Set([502, 503, 504]);

/**
 * Where Vercel Deployment Protection redirects a visitor with no Vercel
 * session. A protected preview answers `302` with
 * `location: https://vercel.com/sso-api?url=<preview>&nonce=<nonce>`.
 */
const VERCEL_LOGIN_WALL_HOST = 'vercel.com';
const VERCEL_LOGIN_WALL_PATH = '/sso-api';

export interface TargetUrlPreflightDeps {
  /** DNS resolution hook. Defaults to `dns.promises.lookup`. Injectable for tests. */
  dnsLookup?: (hostname: string) => Promise<unknown>;
  /** HTTP probe hook. Defaults to the global `fetch`. Injectable for tests. */
  fetchImpl?: typeof fetch;
  shutdownSignal?: AbortSignal;
  shutdown?: Pick<ShutdownHandle, 'runCriticalOperation'>;
  /**
   * Whether a proxy dispatcher is actually installed for this process.
   * Defaults to `isProxyAgentActive()` (proxy.ts), which inspects the
   * active global undici dispatcher — deliberately NOT an env-var check:
   * an `HTTP(S)_PROXY` variable can be present in the environment (e.g. a
   * CI runner exporting it for unrelated package-registry egress) without
   * this CLI ever having installed a dispatcher for it, and gating the
   * refuse→warn downgrade on the env var alone would silently soften every
   * refusal in exactly that environment. Injectable for tests so they don't
   * need to mutate the real global dispatcher to exercise the proxy path.
   */
  proxyActive?: boolean;
}

/** A `refuse` verdict's `refusal` names why; it becomes `details.reason` on the thrown error. */
export type TargetUrlPreflightOutcome =
  | { verdict: 'ok' }
  | { verdict: 'warn'; reason: string }
  | { verdict: 'refuse'; refusal: 'target-unreachable' | 'target-protected'; reason: string };

/** Pulls the string addresses out of a `dns.lookup` result, whether it's a
 * single `{ address, family }` object (the no-options default) or an array
 * of them (the `{ all: true }` shape the real default below requests, so a
 * dual-stack host's A *and* AAAA records are both checked). */
function resolvedAddresses(lookupResult: unknown): string[] {
  const records = Array.isArray(lookupResult) ? lookupResult : [lookupResult];
  return records
    .map(r => (r as { address?: unknown } | null)?.address)
    .filter((a): a is string => typeof a === 'string');
}

/**
 * True when `err` (or a `cause` nested inside it — including an
 * `AggregateError`'s `.errors[]`, the shape undici throws for a dual-stack
 * host where one address family connects and the other refuses) carries
 * one of `codes` as its `code`.
 */
function errorHasCode(err: unknown, codes: readonly string[]): boolean {
  const top = (err as { code?: unknown } | null)?.code;
  if (typeof top === 'string' && codes.includes(top)) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  const causeCode = (cause as { code?: unknown } | null)?.code;
  if (typeof causeCode === 'string' && codes.includes(causeCode)) return true;
  const aggErrors = (cause as { errors?: unknown[] } | null)?.errors;
  if (Array.isArray(aggErrors)) {
    return aggErrors.some(e => {
      const code = (e as { code?: unknown } | null)?.code;
      return typeof code === 'string' && codes.includes(code);
    });
  }
  return false;
}

function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * True when a redirect's Location points at Vercel's login wall. The value
 * is resolved against the probed URL as a string only; it is never fetched.
 * A missing or unparseable Location is not the wall, and a relative one
 * resolves to the probed host.
 */
function isVercelLoginWall(location: string | null, probedUrl: string): boolean {
  if (location === null) return false;
  let target: URL;
  try {
    target = new URL(location, probedUrl);
  } catch {
    return false;
  }
  return target.hostname === VERCEL_LOGIN_WALL_HOST && target.pathname === VERCEL_LOGIN_WALL_PATH;
}

/** Strips the `[...]` bracket notation the WHATWG `URL.hostname` getter uses for IPv6 literals. */
function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Probe `rawUrl` for the narrow refusal set described in the module
 * docstring. Network failures classify to `warn` or `refuse`, while a process
 * interruption propagates. A malformed URL degrades to `warn` rather than
 * crashing (callers validate the URL shape via `assertNotLocal` before this runs).
 */
export async function probeTargetUrl(
  rawUrl: string,
  deps: TargetUrlPreflightDeps = {},
): Promise<TargetUrlPreflightOutcome> {
  const proxied = deps.proxyActive ?? isProxyAgentActive();

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { verdict: 'warn', reason: 'could not parse --target-url for the reachability probe' };
  }

  const host = bareHost(parsed.hostname);

  // Step 1 — DNS. Skipped for a literal IP host (nothing to resolve, and
  // dns.lookup on a literal is a needless round trip through the resolver).
  if (isIP(host) === 0) {
    const dnsLookup =
      deps.dnsLookup ?? ((hostname: string) => dns.promises.lookup(hostname, { all: true }));
    let lookupResult: unknown;
    try {
      lookupResult = await dnsLookup(host);
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'ENOTFOUND' || code === 'EAI_NONAME') {
        if (proxied) {
          return {
            verdict: 'warn',
            reason: `DNS lookup for "${host}" failed locally (${code}) — not conclusive behind a configured proxy`,
          };
        }
        return {
          verdict: 'refuse',
          refusal: 'target-unreachable',
          reason: `--target-url host "${host}" does not resolve (${code})`,
        };
      }
      // Anything else (e.g. EAI_AGAIN — a transient resolver hiccup) is
      // ambiguous, not a confirmed dead target — warn, never refuse.
      return {
        verdict: 'warn',
        reason: `DNS lookup for "${host}" failed (${typeof code === 'string' ? code : 'unknown error'})`,
      };
    }

    // DNS rebinding: a public-looking hostname (e.g. an attacker-controlled
    // domain, or a tunnel host with attacker-influenced DNS) whose A/AAAA
    // record actually points at a private, loopback, link-local, or
    // metadata-service address. `assertNotLocal` never catches this — it
    // only ever inspected the literal `--target-url` *string*, and this
    // hostname passed that check honestly (it doesn't LOOK private). Unlike
    // the DNS-failure branch above, there is no proxy carve-out: resolving
    // locally to a private address is a security signal, not an ambiguous
    // "can't tell from here" result, and a false positive has a documented
    // escape hatch (`--skip-preflight`) rather than a broken workflow.
    for (const address of resolvedAddresses(lookupResult)) {
      const blocked = disallowedIpReason(address);
      if (blocked !== undefined) {
        return {
          verdict: 'refuse',
          refusal: 'target-unreachable',
          reason: `--target-url host "${host}" resolves to ${address} (${blocked.reason})`,
        };
      }
    }
  }

  // Step 2 — HTTP probe. Runs through the global `fetch`, which picks up
  // the proxy dispatcher `proxy.ts` installs at startup when one is
  // configured — so this step (unlike the DNS step above) is proxy-aware
  // by construction, not just proxy-tolerant.
  const fetchImpl = deps.fetchImpl ?? fetch;
  const shutdownSignal = deps.shutdownSignal ?? globalShutdown.signal;
  const shutdown = deps.shutdown ?? globalShutdown;
  return shutdown.runCriticalOperation(async () => {
    try {
      const resp = await fetchImpl(rawUrl, {
        method: 'GET',
        // Never follow — see the module docstring. A 3xx is reachability
        // proof on its own (handled immediately below); the redirect target
        // is unvalidated and must not be dereferenced.
        redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS), shutdownSignal]),
      });
      // Never read the body — only the status matters here. Cancel it so the
      // connection is released promptly instead of buffering a full page.
      await resp.body?.cancel().catch(() => undefined);
      if (shutdownSignal.aborted) throw shutdownSignal.reason;
      if (resp.status >= 300 && resp.status < 400) {
        // A redirect is a live-server signal (e.g. a real app 302ing an
        // unauthenticated GET to a login page) — reachable, not refused. The
        // Location header is never dereferenced; it is only parsed to spot
        // Vercel's login wall (see the module docstring). `headers?.` because
        // an injected fetch may answer without headers.
        if (isVercelLoginWall(resp.headers?.get('location') ?? null, rawUrl)) {
          return {
            verdict: 'refuse',
            refusal: 'target-protected',
            reason: `--target-url redirects to Vercel's login wall (${VERCEL_LOGIN_WALL_HOST}${VERCEL_LOGIN_WALL_PATH})`,
          };
        }
        return { verdict: 'ok' };
      }
      if (GATEWAY_ERROR_STATUSES.has(resp.status)) {
        if (proxied) {
          return {
            verdict: 'warn',
            reason: `--target-url responded HTTP ${resp.status} — not conclusive behind a configured proxy`,
          };
        }
        return {
          verdict: 'refuse',
          refusal: 'target-unreachable',
          reason: `--target-url responded HTTP ${resp.status} (gateway error — the target is unreachable)`,
        };
      }
      if (resp.status >= 400) {
        return { verdict: 'warn', reason: `--target-url responded HTTP ${resp.status}` };
      }
      return { verdict: 'ok' };
    } catch (err) {
      if (shutdownSignal.aborted) throw shutdownSignal.reason;
      if (err instanceof InterruptError) throw err;
      if (errorHasCode(err, ['ECONNREFUSED'])) {
        if (proxied) {
          return {
            verdict: 'warn',
            reason:
              'connection to --target-url was refused — not conclusive behind a configured proxy',
          };
        }
        return {
          verdict: 'refuse',
          refusal: 'target-unreachable',
          reason: 'connection to --target-url was refused (ECONNREFUSED)',
        };
      }
      if (isTimeoutError(err)) {
        return {
          verdict: 'warn',
          reason: `--target-url did not respond within ${PREFLIGHT_TIMEOUT_MS / 1000}s`,
        };
      }
      // TLS errors and anything else unclassified: warn only — the refusal
      // set stays narrow to exactly what that analysis measured.
      return {
        verdict: 'warn',
        reason: `could not reach --target-url (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  });
}

/** Shared wording so `--help` and every refuse/warn message agree on the escape hatch. */
const SKIP_HINT = 'Skip this check entirely with --skip-preflight.';

/**
 * The two ways past Vercel Deployment Protection. The query parameters come
 * from Vercel's "Protection Bypass for Automation" docs, which accept them as
 * headers or query parameters (sourceRef:
 * https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation).
 */
const VERCEL_PROTECTION_HINT =
  "Turn off Vercel Authentication for preview deployments in the Vercel project's Deployment " +
  'Protection settings, or create a Protection Bypass for Automation secret and pass it in the ' +
  'URL: --target-url "<preview>?x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=true" ' +
  '(use "&" instead of "?" when the preview URL already has a query).';

/**
 * Run the preflight and either throw (refuse), print an `[advisory]` line
 * (warn), or no-op (ok / skipped). This is the call-site integration point
 * — wired at all four `--target-url` trigger paths, after `assertNotLocal`
 * and before the trigger POST.
 *
 * `skipPreflight: true` makes this a pure no-op with ZERO network calls —
 * neither `dnsLookup` nor `fetchImpl` is invoked.
 */
export async function assertTargetUrlReachable(
  targetUrl: string,
  opts: { skipPreflight?: boolean },
  deps: TargetUrlPreflightDeps,
  stderrFn: (line: string) => void,
): Promise<void> {
  if (opts.skipPreflight === true) return;

  const outcome = await probeTargetUrl(targetUrl, deps);
  if (outcome.verdict === 'refuse' && outcome.refusal === 'target-protected') {
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message:
          `${outcome.reason}: the preview is behind Vercel Deployment Protection, so every test ` +
          `would run against Vercel's login page instead of your app.`,
        nextAction: `${VERCEL_PROTECTION_HINT} ${SKIP_HINT}`,
        requestId: 'local',
        details: { field: 'targetUrl', reason: 'target-protected', probeReason: outcome.reason },
      },
    });
  }
  if (outcome.verdict === 'refuse') {
    throw ApiError.fromEnvelope({
      error: {
        code: 'VALIDATION_ERROR',
        message: `--target-url is not reachable: ${outcome.reason}. Retry with --skip-preflight if the preview is still warming up.`,
        nextAction:
          'This CLI probes reachability from where the CLI runs, not from the Lambda that ' +
          'executes the test — a false positive is possible (e.g. an IP allowlist that permits ' +
          `the Lambda but not this machine). If you're confident the target is reachable from the ` +
          `test runner, retry with --skip-preflight. ${SKIP_HINT}`,
        requestId: 'local',
        details: { field: 'targetUrl', reason: 'target-unreachable', probeReason: outcome.reason },
      },
    });
  }
  if (outcome.verdict === 'warn') {
    stderrFn(
      `[advisory] --target-url may not be reachable (${outcome.reason}); proceeding anyway ` +
        `(the CLI probes from where it runs, not from the Lambda that executes the test, so this ` +
        `is not conclusive). ${SKIP_HINT}`,
    );
  }
}
