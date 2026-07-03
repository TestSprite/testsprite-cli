import { describe, expect, it, vi } from 'vitest';
import { maybeInstallProxyAgent } from './proxy.js';

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
});
