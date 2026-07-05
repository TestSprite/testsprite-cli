import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the real spawner so the default `exec` path (detached spawn + unref)
// is exercised without launching a real process.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: readonly string[], opts: unknown) =>
    spawnMock(command, args, opts),
}));

import { openInBrowser } from './browser.js';

describe('openInBrowser', () => {
  const url = 'https://portal.example.com/tests/t_123';

  it('uses `open <url>` on darwin', () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    openInBrowser(url, {
      platform: 'darwin',
      exec: (command, args) => calls.push({ command, args }),
    });
    expect(calls).toEqual([{ command: 'open', args: [url] }]);
  });

  it('uses rundll32 FileProtocolHandler on win32', () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    openInBrowser(url, {
      platform: 'win32',
      exec: (command, args) => calls.push({ command, args }),
    });
    expect(calls).toEqual([{ command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }]);
  });

  it('uses xdg-open on other platforms', () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    openInBrowser(url, {
      platform: 'linux',
      exec: (command, args) => calls.push({ command, args }),
    });
    expect(calls).toEqual([{ command: 'xdg-open', args: [url] }]);
  });

  it('refuses a non-http(s) URL before spawning', () => {
    const exec = vi.fn();
    expect(() => openInBrowser('file:///etc/passwd', { platform: 'linux', exec })).toThrow(
      /non-http\(s\)/,
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it('throws on a malformed URL', () => {
    const exec = vi.fn();
    expect(() => openInBrowser('not a url', { exec })).toThrow();
    expect(exec).not.toHaveBeenCalled();
  });

  describe('default spawner', () => {
    beforeEach(() => {
      spawnMock.mockReset();
    });

    it('spawns detached, ignores stdio, and unrefs the child', () => {
      const unref = vi.fn();
      spawnMock.mockReturnValue({ unref });
      openInBrowser(url, { platform: 'darwin' });
      expect(spawnMock).toHaveBeenCalledWith('open', [url], { detached: true, stdio: 'ignore' });
      expect(unref).toHaveBeenCalledTimes(1);
    });
  });
});
