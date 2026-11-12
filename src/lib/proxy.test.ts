import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Dispatcher } from 'undici';
import { fetch } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maybeInstallProxyAgent } from './proxy.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))),
  );
});

async function startProxy(): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer();
  server.on('connect', (req, socket) => {
    seen.push(req.url ?? '');
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => {
      socket.end('HTTP/1.1 200 OK\r\ncontent-length: 9\r\nconnection: close\r\n\r\nvia-proxy');
    });
  });
  server.on('request', (_req, res) => {
    seen.push('direct');
    res.end('via-proxy');
  });
  servers.push(server);
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
  return { port: (server.address() as AddressInfo).port, seen };
}

function captureAgent(env: NodeJS.ProcessEnv): {
  agent: Dispatcher | undefined;
  warnings: string[];
} {
  const warnings: string[] = [];
  let agent: Dispatcher | undefined;
  maybeInstallProxyAgent({
    env,
    install: installed => {
      agent = installed;
    },
    stderr: line => warnings.push(line),
  });
  return { agent, warnings };
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
    it.each(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const)(
      'installs the agent for a bare host:port in %s with no warning',
      name => {
        const env = { [name]: 'proxy.corp.example:3128' };
        vi.stubEnv(name, env[name]);
        try {
          const { agent, warnings } = captureAgent(env);
          expect(warnings).toEqual([]);
          expect(agent).toBeDefined();
        } finally {
          vi.unstubAllEnvs();
        }
      },
    );

    it.each(['HTTP_PROXY', 'http_proxy'] as const)(
      'routes a request through a bare 127.0.0.1:port set in %s',
      async name => {
        const proxy = await startProxy();
        const { agent, warnings } = captureAgent({ [name]: `127.0.0.1:${proxy.port}` });
        expect(warnings).toEqual([]);
        const response = await fetch('http://api.unreachable.example/ping', {
          dispatcher: agent,
        });
        expect(await response.text()).toBe('via-proxy');
        expect(proxy.seen.length).toBeGreaterThan(0);
      },
    );

    it('keeps an explicit http:// value working', async () => {
      const proxy = await startProxy();
      const { agent, warnings } = captureAgent({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}` });
      expect(warnings).toEqual([]);
      const response = await fetch('http://api.unreachable.example/ping', { dispatcher: agent });
      expect(await response.text()).toBe('via-proxy');
    });

    it('prefers the lower-case spelling, as undici does', async () => {
      const proxy = await startProxy();
      const { agent } = captureAgent({
        http_proxy: `127.0.0.1:${proxy.port}`,
        HTTP_PROXY: 'http://127.0.0.1:1',
      });
      const response = await fetch('http://api.unreachable.example/ping', { dispatcher: agent });
      expect(await response.text()).toBe('via-proxy');
    });

    it('reads the proxy from deps.env, not from process.env', async () => {
      vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1');
      try {
        const proxy = await startProxy();
        const { agent } = captureAgent({ HTTP_PROXY: `127.0.0.1:${proxy.port}` });
        const response = await fetch('http://api.unreachable.example/ping', {
          dispatcher: agent,
        });
        expect(await response.text()).toBe('via-proxy');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('applies NO_PROXY from deps.env', async () => {
      const direct = await startProxy();
      const proxy = await startProxy();
      const { agent } = captureAgent({
        HTTP_PROXY: `127.0.0.1:${proxy.port}`,
        NO_PROXY: '127.0.0.1',
      });
      const response = await fetch(`http://127.0.0.1:${direct.port}/direct`, { dispatcher: agent });
      expect(await response.text()).toBe('via-proxy');
      expect(direct.seen).toEqual(['direct']);
      expect(proxy.seen).toEqual([]);
    });

    it('still warns and falls back for a value that is not a URL at all', () => {
      const { agent, warnings } = captureAgent({ HTTPS_PROXY: 'http://' });
      expect(agent).toBeUndefined();
      expect(warnings.join('\n')).toContain('ignoring proxy environment');
    });
  });
});
