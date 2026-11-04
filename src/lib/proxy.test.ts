import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Dispatcher } from 'undici';
import { fetch } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maybeInstallProxyAgent } from './proxy.js';

// A local proxy that records each CONNECT target and refuses the tunnel, so a
// test can see which proxy a request went to without any external network.
async function startRecordingProxy(): Promise<{ server: Server; port: number; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((_req, res) => res.writeHead(502).end());
  server.on('connect', (req, socket) => {
    seen.push(req.url ?? '');
    socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, seen };
}

describe('maybeInstallProxyAgent', () => {
  it('installs an agent when HTTPS_PROXY is set', () => {
    const install = vi.fn();
    const installed = maybeInstallProxyAgent({
      env: { HTTPS_PROXY: 'http://proxy.corp.example.com:8080' },
      install,
    });
    expect(installed).toBe(true);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it.each(['https_proxy', 'HTTP_PROXY', 'http_proxy'] as const)(
    'also honors the %s spelling',
    name => {
      const install = vi.fn();
      const installed = maybeInstallProxyAgent({
        env: { [name]: 'http://proxy.corp.example.com:8080' },
        install,
      });
      expect(installed).toBe(true);
      expect(install).toHaveBeenCalledTimes(1);
    },
  );

  it('does nothing when no proxy variable is set (default path unchanged)', () => {
    const install = vi.fn();
    expect(maybeInstallProxyAgent({ env: {}, install })).toBe(false);
    expect(maybeInstallProxyAgent({ env: { HTTPS_PROXY: '' }, install })).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it('falls back (returns false, warns, never throws) when installing the agent fails', () => {
    // A malformed/unsupported proxy value makes the agent throw at startup; the
    // CLI must degrade to a proxy-less dispatcher, not crash every command.
    const errs: string[] = [];
    const installed = maybeInstallProxyAgent({
      env: { HTTPS_PROXY: 'http://proxy.corp.example.com:8080' },
      install: () => {
        throw new Error('unsupported proxy scheme');
      },
      stderr: line => errs.push(line),
    });
    expect(installed).toBe(false);
    expect(errs.join('\n')).toContain('ignoring proxy environment');
  });

  it('still installs when NO_PROXY is set (exemptions are applied per request by undici)', () => {
    const install = vi.fn();
    const installed = maybeInstallProxyAgent({
      env: { HTTPS_PROXY: 'http://proxy.corp.example.com:8080', NO_PROXY: 'localhost,127.0.0.1' },
      install,
    });
    expect(installed).toBe(true);
    expect(install).toHaveBeenCalledTimes(1);
  });

  describe('proxy values written without a scheme', () => {
    const cleanups: Array<() => Promise<unknown>> = [];
    afterEach(async () => {
      vi.unstubAllEnvs();
      await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
    });

    async function routeThrough(env: NodeJS.ProcessEnv, target: string) {
      const proxy = await startRecordingProxy();
      cleanups.push(() => new Promise(resolve => proxy.server.close(resolve)));
      const errs: string[] = [];
      let agent: Dispatcher | undefined;
      const installed = maybeInstallProxyAgent({
        env: Object.fromEntries(
          Object.entries(env).map(([k, v]) => [k, v?.replace('PORT', String(proxy.port))]),
        ),
        install: a => {
          agent = a;
          cleanups.push(() => a.close());
        },
        stderr: line => errs.push(line),
      });
      const url = target.replace('PORT', String(proxy.port));
      if (agent) await fetch(url, { dispatcher: agent }).catch(() => undefined);
      return { installed, errs, seen: proxy.seen, tunnel: new URL(url).host };
    }

    it.each([
      ['HTTPS_PROXY', 'https://127.0.0.1:PORT/me'],
      ['http_proxy', 'http://127.0.0.1:PORT/me'],
    ] as const)('routes through a host:port %s value as http://', async (name, target) => {
      const result = await routeThrough({ [name]: '127.0.0.1:PORT' }, target);
      expect(result.installed).toBe(true);
      expect(result.errs).toEqual([]);
      expect(result.seen).toEqual([result.tunnel]);
    });

    it('keeps HTTPS falling back to HTTP_PROXY when only HTTP_PROXY is set', async () => {
      const result = await routeThrough(
        { HTTP_PROXY: '127.0.0.1:PORT' },
        'https://127.0.0.1:PORT/me',
      );
      expect(result.seen).toEqual([result.tunnel]);
    });

    it('prefers the lower-case spelling, as undici does', async () => {
      const result = await routeThrough(
        { https_proxy: '127.0.0.1:PORT', HTTPS_PROXY: 'ftp://127.0.0.1:1' },
        'https://127.0.0.1:PORT/me',
      );
      expect(result.errs).toEqual([]);
      expect(result.seen).toEqual([result.tunnel]);
    });

    it('leaves full http:// values unchanged', async () => {
      const result = await routeThrough(
        { HTTPS_PROXY: 'http://127.0.0.1:PORT' },
        'https://127.0.0.1:PORT/me',
      );
      expect(result.errs).toEqual([]);
      expect(result.seen).toEqual([result.tunnel]);
    });

    it('still lets NO_PROXY send a matching host direct', async () => {
      const result = await routeThrough(
        { HTTPS_PROXY: '127.0.0.1:PORT', no_proxy: '127.0.0.1' },
        'https://127.0.0.1:PORT/me',
      );
      expect(result.installed).toBe(true);
      expect(result.seen).toEqual([]);
    });

    it('reads NO_PROXY from the same env as the proxy, not process.env', async () => {
      vi.stubEnv('no_proxy', '127.0.0.1');
      vi.stubEnv('NO_PROXY', '127.0.0.1');
      const result = await routeThrough(
        { HTTPS_PROXY: '127.0.0.1:PORT' },
        'https://127.0.0.1:PORT/me',
      );
      expect(result.seen).toEqual([result.tunnel]);
    });

    it.each(['socks5h://127.0.0.1:1080', 'ftp://127.0.0.1:2121'])(
      'still warns and falls back on an unsupported scheme (%s)',
      value => {
        const errs: string[] = [];
        const install = vi.fn();
        const installed = maybeInstallProxyAgent({
          env: { HTTPS_PROXY: value },
          install,
          stderr: line => errs.push(line),
        });
        expect(installed).toBe(false);
        expect(install).not.toHaveBeenCalled();
        expect(errs.join('\n')).toContain('ignoring proxy environment');
      },
    );
  });
});
