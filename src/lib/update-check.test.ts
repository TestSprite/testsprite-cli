/**
 * Unit tests for the update notice (issue #122). Every effect is injected:
 * no real network, filesystem, clock, or TTY is touched.
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpdateCheckDeps } from './update-check.js';
import {
  UPDATE_CHECK_OPT_OUT_ENV,
  UPDATE_CHECK_TTL_MS,
  compareSemver,
  fetchLatestVersion,
  maybeNotifyUpdate,
  shouldCheckForUpdate,
} from './update-check.js';

/** In-memory fs + deterministic clock harness for the cache round-trip. */
function makeHarness(overrides: UpdateCheckDeps = {}) {
  const files = new Map<string, string>();
  const stderrLines: string[] = [];
  const deps: UpdateCheckDeps = {
    env: {},
    now: () => 1_000_000,
    cachePath: '/fake/.testsprite/update-check.json',
    readFile: path => {
      const content = files.get(path);
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    writeFile: (path, content) => {
      files.set(path, content);
    },
    mkdir: () => undefined,
    isTTY: true,
    stderr: line => stderrLines.push(line),
    currentVersion: '0.2.0',
    fetchImpl: async () =>
      new Response(JSON.stringify({ version: '0.2.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ...overrides,
  };
  return { deps, files, stderrLines };
}

describe('shouldCheckForUpdate gates', () => {
  it('opt-out env set to any non-empty value disables (even "0")', () => {
    const { deps } = makeHarness({ env: { [UPDATE_CHECK_OPT_OUT_ENV]: '0' } });
    expect(shouldCheckForUpdate(deps)).toBe(false);
  });

  it('CI set disables; CI="false" re-enables', () => {
    expect(shouldCheckForUpdate(makeHarness({ env: { CI: 'true' } }).deps)).toBe(false);
    expect(shouldCheckForUpdate(makeHarness({ env: { CI: '' } }).deps)).toBe(false);
    expect(shouldCheckForUpdate(makeHarness({ env: { CI: 'false' } }).deps)).toBe(true);
  });

  it('non-TTY stderr disables', () => {
    expect(shouldCheckForUpdate(makeHarness({ isTTY: false }).deps)).toBe(false);
  });

  it('a fresh cache suppresses; a stale cache does not', () => {
    const fresh = makeHarness();
    fresh.files.set(
      '/fake/.testsprite/update-check.json',
      JSON.stringify({ lastCheckMs: 1_000_000 - UPDATE_CHECK_TTL_MS + 5_000 }),
    );
    expect(shouldCheckForUpdate(fresh.deps)).toBe(false);

    const stale = makeHarness();
    stale.files.set(
      '/fake/.testsprite/update-check.json',
      JSON.stringify({ lastCheckMs: 1_000_000 - UPDATE_CHECK_TTL_MS - 5_000 }),
    );
    expect(shouldCheckForUpdate(stale.deps)).toBe(true);
  });

  it('missing, corrupt, wrong-shape, or future-stamped caches count as stale', () => {
    expect(shouldCheckForUpdate(makeHarness().deps)).toBe(true); // missing
    const corrupt = makeHarness();
    corrupt.files.set('/fake/.testsprite/update-check.json', '{not json');
    expect(shouldCheckForUpdate(corrupt.deps)).toBe(true);
    const wrongShape = makeHarness();
    wrongShape.files.set('/fake/.testsprite/update-check.json', JSON.stringify({ nope: true }));
    expect(shouldCheckForUpdate(wrongShape.deps)).toBe(true);
    const future = makeHarness();
    future.files.set(
      '/fake/.testsprite/update-check.json',
      JSON.stringify({ lastCheckMs: 9_999_999_999 }),
    );
    expect(shouldCheckForUpdate(future.deps)).toBe(true);
  });
});

describe('fetchLatestVersion', () => {
  it('returns the version from a valid registry body', async () => {
    const { deps } = makeHarness({
      fetchImpl: async () => new Response(JSON.stringify({ version: '1.2.3' }), { status: 200 }),
    });
    await expect(fetchLatestVersion(deps)).resolves.toBe('1.2.3');
  });

  it('returns undefined on non-2xx, thrown fetch, and wrong-shape body', async () => {
    const notOk = makeHarness({ fetchImpl: async () => new Response('nope', { status: 500 }) });
    await expect(fetchLatestVersion(notOk.deps)).resolves.toBeUndefined();

    const throwing = makeHarness({
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(fetchLatestVersion(throwing.deps)).resolves.toBeUndefined();

    const wrongShape = makeHarness({
      fetchImpl: async () => new Response(JSON.stringify({ notVersion: 1 }), { status: 200 }),
    });
    await expect(fetchLatestVersion(wrongShape.deps)).resolves.toBeUndefined();
  });
});

describe('compareSemver', () => {
  it('orders numerically and treats prerelease as older than its release', () => {
    expect(compareSemver('0.2.0', '0.3.0')).toBe(-1);
    expect(compareSemver('1.0.0', '0.9.9')).toBe(1);
    expect(compareSemver('0.2.0', '0.2.0')).toBe(0);
    expect(compareSemver('0.10.0', '0.9.0')).toBe(1); // numeric, not lexicographic
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1);
  });

  it('unparseable input on either side compares as 0 (never a false notice)', () => {
    expect(compareSemver('garbage', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0', '')).toBe(0);
  });
});

describe('maybeNotifyUpdate', () => {
  it('prints exactly one stderr line naming both versions when newer, and stamps the cache', async () => {
    const harness = makeHarness({
      fetchImpl: async () => new Response(JSON.stringify({ version: '0.3.1' }), { status: 200 }),
    });
    await maybeNotifyUpdate(harness.deps);
    expect(harness.stderrLines).toHaveLength(1);
    expect(harness.stderrLines[0]).toContain('0.2.0 -> 0.3.1');
    expect(harness.stderrLines[0]).toContain(UPDATE_CHECK_OPT_OUT_ENV);
    const cache = JSON.parse(harness.files.get('/fake/.testsprite/update-check.json')!) as {
      lastCheckMs: number;
      latestKnown?: string;
    };
    expect(cache.lastCheckMs).toBe(1_000_000);
    expect(cache.latestKnown).toBe('0.3.1');
  });

  it('stays silent on an equal or older registry version', async () => {
    const equal = makeHarness();
    await maybeNotifyUpdate(equal.deps);
    expect(equal.stderrLines).toHaveLength(0);

    const older = makeHarness({
      fetchImpl: async () => new Response(JSON.stringify({ version: '0.1.9' }), { status: 200 }),
    });
    await maybeNotifyUpdate(older.deps);
    expect(older.stderrLines).toHaveLength(0);
  });

  it('a failed probe stays silent but still stamps the cache (retry once per TTL)', async () => {
    const harness = makeHarness({
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await maybeNotifyUpdate(harness.deps);
    expect(harness.stderrLines).toHaveLength(0);
    const cache = JSON.parse(harness.files.get('/fake/.testsprite/update-check.json')!) as {
      lastCheckMs: number;
      latestKnown?: string;
    };
    expect(cache.lastCheckMs).toBe(1_000_000);
    expect(cache.latestKnown).toBeUndefined();
  });

  it('does nothing when a gate blocks (no fetch fired)', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const harness = makeHarness({ env: { CI: '1' }, fetchImpl });
    await maybeNotifyUpdate(harness.deps);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(harness.stderrLines).toHaveLength(0);
  });

  it('never rejects, even when every injected dependency throws', async () => {
    const harness = makeHarness({
      fetchImpl: async () => new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 }),
      writeFile: () => {
        throw new Error('EROFS');
      },
      stderr: () => {
        throw new Error('broken stderr sink');
      },
    });
    await expect(maybeNotifyUpdate(harness.deps)).resolves.toBeUndefined();
  });

  it('uses the default fs readers/writers when none are injected (real cache round-trip)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-check-'));
    // Point cachePath at a not-yet-existing subdir so the default mkdir
    // (recursive) and writeFile arrows both run, and the first read (file
    // absent) exercises the default readFile arrow's ENOENT path.
    const cachePath = join(dir, 'nested', 'update-check.json');
    const stderrLines: string[] = [];
    try {
      await maybeNotifyUpdate({
        env: {},
        now: () => 1_000_000,
        isTTY: true,
        currentVersion: '0.0.1',
        cachePath,
        stderr: line => stderrLines.push(line),
        fetchImpl: async () => new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 }),
      });
      // Cache was persisted by the default writeFile through the default mkdir.
      expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toMatchObject({ latestKnown: '9.9.9' });
      expect(stderrLines.join('\n')).toContain('0.0.1 -> 9.9.9');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
