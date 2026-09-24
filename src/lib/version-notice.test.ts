import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatBelowFloorNotice,
  formatPinnedVersionWarning,
  noteServerVersion,
  resetBelowFloorNoticeState,
  shouldWarnBelowFloor,
  shouldWarnPinnedInActions,
  type VersionNoticeDeps,
} from './version-notice.js';

/** Baseline deps: all gates open, running version below the floor. */
function baseDeps(overrides: Partial<VersionNoticeDeps> = {}): VersionNoticeDeps {
  return {
    currentVersion: '0.9.0',
    env: {},
    isTTY: true,
    outputMode: 'text',
    dryRun: false,
    ...overrides,
  };
}

afterEach(() => {
  resetBelowFloorNoticeState();
  vi.restoreAllMocks();
});

describe('shouldWarnBelowFloor', () => {
  it('warns when the running version is strictly below the floor', () => {
    expect(shouldWarnBelowFloor({ minVersion: '1.0.0' }, baseDeps())).toBe(true);
  });

  it('does not warn when at or above the floor', () => {
    expect(shouldWarnBelowFloor({ minVersion: '0.9.0' }, baseDeps())).toBe(false); // equal
    expect(shouldWarnBelowFloor({ minVersion: '0.8.0' }, baseDeps())).toBe(false); // above
  });

  it('does not warn when no minVersion header was present', () => {
    expect(shouldWarnBelowFloor({}, baseDeps())).toBe(false);
    expect(shouldWarnBelowFloor({ minVersion: undefined }, baseDeps())).toBe(false);
  });

  it('does not warn on unparseable versions (garbage never warns)', () => {
    expect(shouldWarnBelowFloor({ minVersion: 'not-a-version' }, baseDeps())).toBe(false);
    expect(
      shouldWarnBelowFloor({ minVersion: '1.0.0' }, baseDeps({ currentVersion: 'nope' })),
    ).toBe(false);
  });

  it('is gated off by the opt-out env (any non-empty value)', () => {
    expect(
      shouldWarnBelowFloor(
        { minVersion: '1.0.0' },
        baseDeps({ env: { TESTSPRITE_NO_UPDATE_NOTIFIER: '1' } }),
      ),
    ).toBe(false);
    expect(
      shouldWarnBelowFloor(
        { minVersion: '1.0.0' },
        baseDeps({ env: { TESTSPRITE_NO_UPDATE_NOTIFIER: '0' } }),
      ),
    ).toBe(false);
  });

  it('is gated off under --output json, --dry-run, and non-TTY', () => {
    expect(shouldWarnBelowFloor({ minVersion: '1.0.0' }, baseDeps({ outputMode: 'json' }))).toBe(
      false,
    );
    expect(shouldWarnBelowFloor({ minVersion: '1.0.0' }, baseDeps({ dryRun: true }))).toBe(false);
    expect(shouldWarnBelowFloor({ minVersion: '1.0.0' }, baseDeps({ isTTY: false }))).toBe(false);
  });
});

describe('formatBelowFloorNotice', () => {
  it('names the current version, the floor, and the npm upgrade command', () => {
    const line = formatBelowFloorNotice('0.9.0', '1.0.0');
    expect(line).toContain('0.9.0');
    expect(line).toContain('minimum supported version 1.0.0');
    expect(line).toContain('npm install -g @testsprite/testsprite-cli');
    expect(line).toContain('TESTSPRITE_NO_UPDATE_NOTIFIER=1');
  });

  it('does not name a target release (npm update-notice owns "latest")', () => {
    const line = formatBelowFloorNotice('0.9.0', '1.0.0');
    expect(line).not.toContain('Upgrade to 1.');
  });
});

describe('noteServerVersion', () => {
  it('emits exactly one advisory line when below the floor', () => {
    const stderr = vi.fn();
    noteServerVersion({ minVersion: '1.0.0' }, baseDeps({ stderr }));
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('below the minimum supported'));
  });

  it('warns at most once per process', () => {
    const stderr = vi.fn();
    const deps = baseDeps({ stderr });
    noteServerVersion({ minVersion: '1.0.0' }, deps);
    noteServerVersion({ minVersion: '1.0.0' }, deps);
    noteServerVersion({ minVersion: '1.0.0' }, deps);
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  it('stays silent when not below the floor', () => {
    const stderr = vi.fn();
    noteServerVersion({ minVersion: '0.5.0' }, baseDeps({ stderr }));
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe('GitHub Actions pinned-version warning', () => {
  const actions = { GITHUB_ACTIONS: 'true' };

  it('shouldWarnPinnedInActions: only under GITHUB_ACTIONS=true and strictly below the floor', () => {
    expect(shouldWarnPinnedInActions({ minVersion: '1.0.0' }, baseDeps({ env: actions }))).toBe(
      true,
    );
    expect(shouldWarnPinnedInActions({ minVersion: '1.0.0' }, baseDeps({ env: {} }))).toBe(false);
    expect(
      shouldWarnPinnedInActions(
        { minVersion: '1.0.0' },
        baseDeps({ env: { GITHUB_ACTIONS: '1' } }),
      ),
    ).toBe(false);
    expect(shouldWarnPinnedInActions({ minVersion: '0.9.0' }, baseDeps({ env: actions }))).toBe(
      false,
    );
    expect(shouldWarnPinnedInActions({}, baseDeps({ env: actions }))).toBe(false);
  });

  it('ignores the TTY and JSON gates (a job is never a TTY; the command rides stderr)', () => {
    expect(
      shouldWarnPinnedInActions(
        { minVersion: '1.0.0' },
        baseDeps({ env: actions, isTTY: false, outputMode: 'json' }),
      ),
    ).toBe(true);
  });

  it('keeps the opt-out env and the dry-run gate', () => {
    expect(
      shouldWarnPinnedInActions(
        { minVersion: '1.0.0' },
        baseDeps({ env: { ...actions, TESTSPRITE_NO_UPDATE_NOTIFIER: '1' } }),
      ),
    ).toBe(false);
    expect(
      shouldWarnPinnedInActions({ minVersion: '1.0.0' }, baseDeps({ env: actions, dryRun: true })),
    ).toBe(false);
  });

  it('formatPinnedVersionWarning is a single ::warning workflow command naming both versions', () => {
    const line = formatPinnedVersionWarning('0.9.0', '1.0.0');
    expect(line).toBe(
      '::warning title=TestSprite::testsprite-cli 0.9.0 is pinned in this workflow and is below the minimum supported version 1.0.0. Regenerate with testsprite ci init github --force.',
    );
    expect(line).not.toContain('\n');
  });

  it('noteServerVersion emits the ::warning form once under Actions, even non-TTY / json', () => {
    const stderr = vi.fn();
    const deps = baseDeps({ env: actions, isTTY: false, outputMode: 'json', stderr });
    noteServerVersion({ minVersion: '1.0.0' }, deps);
    noteServerVersion({ minVersion: '1.0.0' }, deps);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^::warning title=TestSprite::/));
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('Your testsprite-cli'));
  });

  it('off Actions the plain TTY advisory is unchanged', () => {
    const stderr = vi.fn();
    noteServerVersion({ minVersion: '1.0.0' }, baseDeps({ stderr }));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('below the minimum supported'));
    expect(stderr).not.toHaveBeenCalledWith(expect.stringMatching(/^::warning/));
  });
});
