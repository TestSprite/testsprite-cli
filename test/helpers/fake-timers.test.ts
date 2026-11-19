import { describe, expect, it, vi } from 'vitest';
import { onFakeTimers } from './fake-timers.js';

describe('onFakeTimers', () => {
  it('moves the fake clock until the work settles, then gives the real clock back', async () => {
    const value = await onFakeTimers(
      () => new Promise<string>(resolve => setTimeout(() => resolve('done'), 2_000)),
    );
    expect(value).toBe('done');
    expect(vi.isFakeTimers()).toBe(false);
  });

  it('rejects work that never settles, and gives the real clock back', async () => {
    await expect(onFakeTimers(() => new Promise(() => {}))).rejects.toThrow(/did not settle/);
    expect(vi.isFakeTimers()).toBe(false);
  }, 2_000);
});

describe('a test that leaves the clock fake', () => {
  it('fakes it and ends', () => {
    vi.useFakeTimers();
    expect(vi.isFakeTimers()).toBe(true);
  });

  it('does not leave it fake for the next test', () => {
    expect(vi.isFakeTimers()).toBe(false);
  });
});

describe('a test that leaves Date.now spied', () => {
  it('spies on it and ends', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => 0);
    expect(Date.now()).toBe(0);
  });

  it('does not leave it frozen for the next test', () => {
    expect(vi.isMockFunction(Date.now)).toBe(false);
    expect(Date.now()).toBeGreaterThan(0);
  });
});
