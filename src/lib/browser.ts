/**
 * Cross-platform "open this URL in the default browser" helper for
 * `test open` (issue #121). Spawns the platform opener with an argv array
 * (never a shell string) so a URL can never be shell-injected, and refuses
 * anything that is not http(s) before any process is spawned.
 *
 * Platform openers:
 *   darwin  open <url>
 *   win32   rundll32 url.dll,FileProtocolHandler <url>  (avoids `cmd /c start`,
 *           whose re-parsing would mangle `&` and other metachars in the URL)
 *   other   xdg-open <url>
 *
 * The child is detached and unref'd so the CLI exits immediately; failures
 * are the caller's to surface (it already printed the URL as the fallback).
 */
import { spawn } from 'node:child_process';
import { localValidationError } from './errors.js';

export interface OpenInBrowserDeps {
  platform?: NodeJS.Platform;
  /** Process spawner taking an argv array. Defaults to a detached spawn. */
  exec?: (command: string, args: readonly string[]) => void;
}

export function openInBrowser(url: string, deps: OpenInBrowserDeps = {}): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    // User-input error, not an internal failure: classify as VALIDATION_ERROR
    // so it maps to exit 5 (like every other bad-argument path), not exit 1.
    throw localValidationError(
      'url',
      `must be an http(s) URL (got ${parsed.protocol})`,
      undefined,
      'field',
    );
  }
  const platform = deps.platform ?? process.platform;
  const exec =
    deps.exec ??
    ((command: string, args: readonly string[]) => {
      const child = spawn(command, [...args], { detached: true, stdio: 'ignore' });
      // spawn() reports a missing binary (ENOENT) ASYNCHRONOUSLY on the child,
      // so the caller's try/catch cannot see it — and an unhandled 'error'
      // event would crash the whole CLI. The URL is already on stdout, so
      // degrade to the same manual-open hint the sync failure path prints.
      child.on('error', () => {
        process.stderr.write(
          'could not launch a browser; open the URL above manually (or use --no-browser)\n',
        );
      });
      child.unref();
    });

  if (platform === 'darwin') {
    exec('open', [url]);
    return;
  }
  if (platform === 'win32') {
    exec('rundll32', ['url.dll,FileProtocolHandler', url]);
    return;
  }
  exec('xdg-open', [url]);
}
