import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the real spawner so the default `exec` path (detached spawn + unref)
// is exercised without launching a real process.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: readonly string[], opts: unknown) =>
    spawnMock(command, args, opts),
}));

import { openInBrowser } from './browser.js';
import { ApiError } from './errors.js';

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

  it('refuses a non-http(s) URL with exit 5 before spawning', () => {
    const exec = vi.fn();
    let error: unknown;
    try {
      openInBrowser('file:///etc/passwd', { platform: 'linux', exec });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).exitCode).toBe(5);
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
      spawnMock.mockReturnValue({ unref, on: vi.fn() });
      openInBrowser(url, { platform: 'darwin' });
      expect(spawnMock).toHaveBeenCalledWith('open', [url], { detached: true, stdio: 'ignore' });
      expect(unref).toHaveBeenCalledTimes(1);
    });

    it("handles the child's async 'error' (missing binary) with a stderr hint, not a crash", () => {
      // spawn() reports ENOENT asynchronously on the child; an unhandled
      // 'error' event would crash the CLI. The default spawner must register
      // a listener that degrades to the manual-open hint.
      const listeners = new Map<string, (err: Error) => void>();
      spawnMock.mockReturnValue({
        unref: vi.fn(),
        on: (event: string, listener: (err: Error) => void) => {
          listeners.set(event, listener);
        },
      });
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        openInBrowser(url, { platform: 'linux' });
        const onError = listeners.get('error');
        expect(onError).toBeDefined();
        // Firing the listener must not throw and must print the hint.
        expect(() => onError!(new Error('spawn xdg-open ENOENT'))).not.toThrow();
        expect(String(stderrSpy.mock.calls.at(-1)?.[0])).toContain('could not launch a browser');
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});
