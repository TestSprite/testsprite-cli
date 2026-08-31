import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors.js';
import { assertTargetUrlReachable, probeTargetUrl } from './target-url-preflight.js';

/** A fetch mock that resolves with the given status (default 200, body pre-cancelled-safe). */
function fetchResolving(status: number): typeof fetch {
  return vi.fn().mockResolvedValue({
    status,
    body: { cancel: () => Promise.resolve() },
  }) as unknown as typeof fetch;
}

/** A fetch mock that rejects with an error shaped like a real fetch/undici failure. */
function fetchRejecting(err: unknown): typeof fetch {
  return vi.fn().mockRejectedValue(err) as unknown as typeof fetch;
}

function dnsResolving(): (hostname: string) => Promise<unknown> {
  return vi.fn().mockResolvedValue({ address: '93.184.216.34', family: 4 });
}

/** A DNS mock resolving to a single, caller-chosen address (any family). */
function dnsResolvingTo(
  address: string,
  family: 4 | 6 = 4,
): (hostname: string) => Promise<unknown> {
  return vi.fn().mockResolvedValue({ address, family });
}

/** A DNS mock resolving to multiple addresses, mirroring the `{ all: true }`
 * shape the real default requests (dual-stack: both an A and AAAA record). */
function dnsResolvingToAll(
  addresses: Array<{ address: string; family: 4 | 6 }>,
): (hostname: string) => Promise<unknown> {
  return vi.fn().mockResolvedValue(addresses);
}

function dnsRejecting(code: string): (hostname: string) => Promise<unknown> {
  const err = Object.assign(new Error(`getaddrinfo ${code}`), { code });
  return vi.fn().mockRejectedValue(err);
}

describe('probeTargetUrl — rule table', () => {
  it('DNS NXDOMAIN, no proxy -> refuse', async () => {
    const outcome = await probeTargetUrl('https://dead.trycloudflare.com', {
      dnsLookup: dnsRejecting('ENOTFOUND'),
      proxyActive: false,
    });
    expect(outcome.verdict).toBe('refuse');
    expect(outcome).toMatchObject({ reason: expect.stringContaining('ENOTFOUND') });
  });

  it('DNS EAI_NONAME, no proxy -> refuse', async () => {
    const outcome = await probeTargetUrl('https://dead.example.com', {
      dnsLookup: dnsRejecting('EAI_NONAME'),
      proxyActive: false,
    });
    expect(outcome.verdict).toBe('refuse');
  });

  it('DNS NXDOMAIN, proxy active -> warn (raw DNS bypasses the proxy)', async () => {
    const outcome = await probeTargetUrl('https://dead.example.com', {
      dnsLookup: dnsRejecting('ENOTFOUND'),
      proxyActive: true,
    });
    expect(outcome.verdict).toBe('warn');
  });

  it('EAI_AGAIN (transient resolver hiccup) -> warn, never refuse', async () => {
    const outcome = await probeTargetUrl('https://flaky.example.com', {
      dnsLookup: dnsRejecting('EAI_AGAIN'),
      proxyActive: false,
    });
    expect(outcome.verdict).toBe('warn');
  });

  it('ECONNREFUSED, no proxy -> refuse', async () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8080'), {
        code: 'ECONNREFUSED',
      }),
    });
    const outcome = await probeTargetUrl('https://example.com', {
      dnsLookup: dnsResolving(),
      fetchImpl: fetchRejecting(err),
      proxyActive: false,
    });
    expect(outcome.verdict).toBe('refuse');
    expect(outcome).toMatchObject({ reason: expect.stringContaining('ECONNREFUSED') });
  });

  it('ECONNREFUSED nested inside an AggregateError (dual-stack host) -> refuse', async () => {
    // Undici's shape for a host with both an A and AAAA record where one
    // family connects and refuses while dial attempts fan out.
    const agg = Object.assign(new Error('AggregateError'), {
      errors: [
        Object.assign(new Error('connect ECONNREFUSED ::1:8080'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      ],
    });
    const err = Object.assign(new TypeError('fetch failed'), { cause: agg });
    const outcome = await probeTargetUrl('https://dual-stack.example.com', {
      dnsLookup: dnsResolving(),
      fetchImpl: fetchRejecting(err),
      proxyActive: false,
    });
    expect(outcome.verdict).toBe('refuse');
  });

  it('ECONNREFUSED, proxy active -> warn', async () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    const outcome = await probeTargetUrl('https://example.com', {
      dnsLookup: dnsResolving(),
      fetchImpl: fetchRejecting(err),
      proxyActive: true,
    });
    expect(outcome.verdict).toBe('warn');
  });

  it.each([502, 503, 504])('HTTP %d, no proxy -> refuse (gateway error)', async status => {
    const outcome = await probeTargetUrl('https://tunnel.trycloudflare.com', {
      dnsLookup: dnsResolving(),
      fetchImpl: fetchResolving(status),
      proxyActive: false,
    });
    expect(outcome.verdict).toBe('refuse');
    expect(outcome).toMatchObject({ reason: expect.stringContaining(String(status)) });
  });

  it('HTTP 503, proxy active -> warn', async () => {
    const outcome = await probeTargetUrl('https://tunnel.trycloudflare.com', {
      dnsLookup: dnsResolving(),
      fetchImpl: fetchResolving(503),
      proxyActive: true,
    });
    expect(outcome.verdict).toBe('warn');
  });

  it('any other 4xx/5xx (e.g. 404, 500, 401) -> warn only', async () => {
    for (const status of [404, 500, 401]) {
      const outcome = await probeTargetUrl('https://example.com', {
        dnsLookup: dnsResolving(),
        fetchImpl: fetchResolving(status),
        proxyActive: false,
      });
      expect(outcome.verdict).toBe('warn');
    }
  });

  it('connect/read timeout -> warn', async () => {
    const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const outcome = await probeTargetUrl('https://slow.example.com', {
      dnsLookup: dnsResolving(),
      fetchImpl: fetchRejecting(err),
      proxyActive: false,
    });
    expect(outcome.verdict).toBe('warn');
  });

  it('TLS error -> warn', async () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('self-signed certificate'), {
        code: 'SELF_SIGNED_CERT_IN_CHAIN',
      }),
    });
    const outcome = await probeTargetUrl('https://self-signed.example.com', {
      dnsLookup: dnsResolving(),
      fetchImpl: fetchRejecting(err),
      proxyActive: false,
    });
    expect(outcome.verdict).toBe('warn');
  });

  it('2xx response -> ok, no advisory', async () => {
    const outcome = await probeTargetUrl('https://example.com', {
      dnsLookup: dnsResolving(),
      fetchImpl: fetchResolving(200),
      proxyActive: false,
    });
    expect(outcome).toEqual({ verdict: 'ok' });
  });

  it('ANY negative result at all is downgraded to warn when a proxy is active', async () => {
    // Even a signal that would normally refuse (gateway error) softens under
    // an actually-active proxy — the probe's raw-socket half is proxy-blind.
    const outcomes = await Promise.all([
      probeTargetUrl('https://a.example.com', {
        dnsLookup: dnsRejecting('ENOTFOUND'),
        proxyActive: true,
      }),
      probeTargetUrl('https://b.example.com', {
        dnsLookup: dnsResolving(),
        fetchImpl: fetchResolving(502),
        proxyActive: true,
      }),
    ]);
    for (const outcome of outcomes) expect(outcome.verdict).toBe('warn');
  });

  it('an IP-literal host skips the DNS step entirely', async () => {
    const dnsLookup = vi.fn();
    const outcome = await probeTargetUrl('http://93.184.216.34:8080', {
      dnsLookup,
      fetchImpl: fetchResolving(200),
      proxyActive: false,
    });
    expect(outcome).toEqual({ verdict: 'ok' });
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it('an IPv6-literal host skips the DNS step entirely', async () => {
    const dnsLookup = vi.fn();
    const outcome = await probeTargetUrl('http://[::1]:8080', {
      dnsLookup,
      fetchImpl: fetchResolving(200),
      proxyActive: false,
    });
    expect(outcome).toEqual({ verdict: 'ok' });
    expect(dnsLookup).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DNS-resolved address blocklist — a public-looking hostname whose A/AAAA
// record actually points at a private/loopback/link-local/metadata address
// (DNS rebinding). `assertNotLocal` never sees this (it only ever inspects
// the literal --target-url string); the probe is the only layer that
// resolves DNS at all, so it's the only layer that can catch it.
// ---------------------------------------------------------------------------

describe('probeTargetUrl — DNS-resolved address blocklist (rebinding guard)', () => {
  it('hostname resolves to the AWS metadata address -> refuse, HTTP probe never runs', async () => {
    const fetchImpl = vi.fn();
    const outcome = await probeTargetUrl('https://looks-public.example.com', {
      dnsLookup: dnsResolvingTo('169.254.169.254'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      proxyActive: false,
    });
    expect(outcome.verdict).toBe('refuse');
    expect(outcome).toMatchObject({ reason: expect.stringContaining('169.254.169.254') });
    // The whole point: never actually issue the GET once the resolved
    // address is known to be disallowed.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['127.0.0.1', 4, 'loopback'],
    ['10.1.2.3', 4, 'RFC1918 (10/8)'],
    ['192.168.1.1', 4, 'RFC1918 (192.168/16)'],
    ['172.20.0.5', 4, 'RFC1918 (172.16/12)'],
    ['169.254.1.1', 4, 'link-local'],
    ['0.0.0.0', 4, 'unspecified'],
    ['0.1.2.3', 4, 'this-network 0/8'],
    ['100.64.0.1', 4, 'carrier-grade NAT'],
    ['224.0.0.1', 4, 'multicast'],
    ['240.0.0.1', 4, 'class E'],
    ['255.255.255.255', 4, 'limited broadcast'],
    ['fec0::1', 6, 'deprecated IPv6 site-local'],
    ['::ffff:169.254.169.254', 6, 'mapped metadata, dotted tail'],
    ['::ffff:a9fe:a9fe', 6, 'mapped metadata, hex tail'],
  ] as const)('hostname resolves to %s (%s, %s) -> refuse', async (address, family, _label) => {
    const outcome = await probeTargetUrl('https://looks-public.example.com', {
      dnsLookup: dnsResolvingTo(address, family),
      proxyActive: false,
    });
    expect(outcome.verdict).toBe('refuse');
    expect(outcome).toMatchObject({ reason: expect.stringContaining(address) });
  });

  it('hostname resolves to an IPv6 loopback address -> refuse', async () => {
    const outcome = await probeTargetUrl('https://looks-public.example.com', {
      dnsLookup: dnsResolvingTo('::1', 6),
      proxyActive: false,
    });
    expect(outcome.verdict).toBe('refuse');
  });

  it('hostname resolves to an IPv6 unique-local address -> refuse', async () => {
    const outcome = await probeTargetUrl('https://looks-public.example.com', {
      dnsLookup: dnsResolvingTo('fd12:3456:789a::1', 6),
      proxyActive: false,
    });
    expect(outcome.verdict).toBe('refuse');
  });

  it('a dual-stack resolution where only the SECOND address is private -> still refuses (fails closed)', async () => {
    const outcome = await probeTargetUrl('https://dual-stack-evil.example.com', {
      dnsLookup: dnsResolvingToAll([
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]),
      proxyActive: false,
    });
    expect(outcome.verdict).toBe('refuse');
    expect(outcome).toMatchObject({ reason: expect.stringContaining('169.254.169.254') });
  });

  it('a private resolution refuses even when a proxy IS active — no carve-out for this signal', async () => {
    // Unlike a DNS *failure* (ambiguous — the real resolution may happen at
    // the proxy) or an HTTP gateway error, a resolved private/metadata
    // address is a security signal, not an ambiguity about where resolution
    // happened. It must not soften just because a proxy is in play.
    const outcome = await probeTargetUrl('https://looks-public.example.com', {
      dnsLookup: dnsResolvingTo('169.254.169.254'),
      proxyActive: true,
    });
    expect(outcome.verdict).toBe('refuse');
  });

  it('a public resolution proceeds to the HTTP probe as before', async () => {
    const outcome = await probeTargetUrl('https://example.com', {
      dnsLookup: dnsResolvingTo('93.184.216.34'),
      fetchImpl: fetchResolving(200),
      proxyActive: false,
    });
    expect(outcome).toEqual({ verdict: 'ok' });
  });

  it.each([
    ['8.8.8.8', 4, 'ordinary public IPv4'],
    ['::ffff:8.8.8.8', 6, 'mapped public IPv4, dotted tail'],
    ['::ffff:808:808', 6, 'mapped public IPv4, hex tail'],
    ['64:ff9b::808:808', 6, 'NAT64 to public IPv4'],
    ['2001:db8::a9fe:a9fe', 6, 'ordinary IPv6 interface bits'],
    ['2001:4860:4860::8888', 6, 'ordinary public IPv6'],
  ] as const)(
    'hostname resolution to %s (%s, %s) proceeds to HTTP probe',
    async (address, family, _label) => {
      const outcome = await probeTargetUrl('https://looks-public.example.com', {
        dnsLookup: dnsResolvingTo(address, family),
        fetchImpl: fetchResolving(200),
        proxyActive: false,
      });
      expect(outcome).toEqual({ verdict: 'ok' });
    },
  );
});

// ---------------------------------------------------------------------------
// Redirect handling — a redirect target is unvalidated by everything above,
// so it must never be dereferenced. A 3xx is still a live-reachability
// signal on its own.
// ---------------------------------------------------------------------------

describe('probeTargetUrl — redirect handling (SSRF guard)', () => {
  it.each([301, 302, 303, 307, 308])(
    'HTTP %d redirect -> ok, treated as reachable',
    async status => {
      const outcome = await probeTargetUrl('https://example.com', {
        dnsLookup: dnsResolving(),
        fetchImpl: fetchResolving(status),
        proxyActive: false,
      });
      expect(outcome).toEqual({ verdict: 'ok' });
    },
  );

  it('requests with redirect: "manual" — never auto-follows', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve({ status: 302, body: { cancel: () => Promise.resolve() } });
    }) as unknown as typeof fetch;
    await probeTargetUrl('https://example.com', {
      dnsLookup: dnsResolving(),
      fetchImpl,
      proxyActive: false,
    });
    expect(capturedInit?.redirect).toBe('manual');
  });

  // A mocked `fetchImpl` can prove the *option* passed to fetch (the test
  // above) but can't prove non-dereferencing itself — a canned mock returns
  // whatever status it's told regardless of `redirect`, so it can't tell
  // apart "followed the real redirect" from "never followed it". This is
  // the actual SSRF PoC shape (server A: a normal, publicly-resolving host;
  // server B: standing in for 169.254.169.254), run against REAL servers
  // with no injected fetchImpl/dnsLookup — i.e. the real global `fetch` and
  // `dns.promises.lookup`, exactly what a live CLI invocation uses.
  it('SSRF regression: server A 302s to server B (metadata stand-in) — server B is never contacted', async () => {
    let serverBHits = 0;
    const serverB = http.createServer((_req, res) => {
      serverBHits += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('SECRET-METADATA-CREDS');
    });
    await new Promise<void>(resolve => serverB.listen(0, resolve));
    const portB = (serverB.address() as AddressInfo).port;

    const serverA = http.createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${portB}/latest/meta-data/` });
      res.end();
    });
    await new Promise<void>(resolve => serverA.listen(0, resolve));
    const portA = (serverA.address() as AddressInfo).port;

    try {
      // No injected deps — real fetch, real DNS (skipped here since the
      // host is a literal IP), exactly the code path a live invocation runs.
      const outcome = await probeTargetUrl(`http://127.0.0.1:${portA}/`, {});
      // Server A's 302 is itself a live-reachability signal.
      expect(outcome).toEqual({ verdict: 'ok' });
      // The redirect target was never dereferenced.
      expect(serverBHits).toBe(0);
    } finally {
      serverA.close();
      serverB.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The refuse→warn downgrade must be gated on an actually-installed proxy
// dispatcher, not on an ambient env var — a CI runner exporting HTTPS_PROXY
// for unrelated registry egress must not silently soften every refusal.
// ---------------------------------------------------------------------------

describe('probeTargetUrl — proxy downgrade is gated on the dispatcher, not the env var', () => {
  it('an HTTPS_PROXY env var alone (no dispatcher installed) does NOT downgrade a refusal', async () => {
    const original = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://proxy.example.invalid:8080';
    try {
      // `proxyActive` is deliberately omitted here — this exercises the
      // REAL default (`isProxyAgentActive()`, proxy.ts), which must ignore
      // this env var since nothing installed a dispatcher for it in this
      // test process.
      const outcome = await probeTargetUrl('https://dead.trycloudflare.com', {
        dnsLookup: dnsRejecting('ENOTFOUND'),
      });
      expect(outcome.verdict).toBe('refuse');
    } finally {
      if (original === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = original;
    }
  });
});

describe('assertTargetUrlReachable — call-site integration', () => {
  it('--skip-preflight issues zero network calls', async () => {
    const dnsLookup = vi.fn();
    const fetchImpl = vi.fn();
    const stderrLines: string[] = [];
    await assertTargetUrlReachable(
      'https://dead.trycloudflare.com',
      { skipPreflight: true },
      { dnsLookup, fetchImpl: fetchImpl as unknown as typeof fetch, proxyActive: false },
      line => stderrLines.push(line),
    );
    expect(dnsLookup).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(stderrLines).toHaveLength(0);
  });

  it('throws a VALIDATION_ERROR (exit 5) naming --skip-preflight on a refuse verdict', async () => {
    const err = await assertTargetUrlReachable(
      'https://dead.trycloudflare.com',
      {},
      { dnsLookup: dnsRejecting('ENOTFOUND'), proxyActive: false },
      () => undefined,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('VALIDATION_ERROR');
    expect((err as ApiError).exitCode).toBe(5);
    expect((err as ApiError).nextAction).toContain('--skip-preflight');
  });

  it('prints a [advisory] line (and does not throw) on a warn verdict', async () => {
    const stderrLines: string[] = [];
    await assertTargetUrlReachable(
      'https://example.com',
      {},
      { dnsLookup: dnsResolving(), fetchImpl: fetchResolving(500), proxyActive: false },
      line => stderrLines.push(line),
    );
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain('[advisory]');
    expect(stderrLines[0]).toContain('--skip-preflight');
  });

  it('is silent on an ok verdict', async () => {
    const stderrLines: string[] = [];
    await assertTargetUrlReachable(
      'https://example.com',
      {},
      { dnsLookup: dnsResolving(), fetchImpl: fetchResolving(200), proxyActive: false },
      line => stderrLines.push(line),
    );
    expect(stderrLines).toHaveLength(0);
  });
});
