/**
 * Unit tests for RateThrottle — sliding-window rate limiter.
 */

import { describe, expect, it } from 'vitest';
import { RateThrottle } from './rate-throttle.js';

it('returns an unused acquisition without removing older dispatched slots', () => {
  let now = 0;
  const throttle = new RateThrottle(2, 60_000, () => now);
  expect(throttle.acquire()).toBe(0);
  now = 1000;
  expect(throttle.acquire()).toBe(0);
  throttle.releaseLast();
  expect(throttle.acquire()).toBe(0);
  expect(throttle.acquire()).toBe(59050);
  now = 60_000;
  expect(throttle.acquire()).toBe(0);
  expect(throttle.acquire()).toBe(1050);
});

describe('RateThrottle', () => {
  it('returns 0 (no delay) when window is empty', () => {
    const throttle = new RateThrottle(5, 60_000);
    expect(throttle.acquire()).toBe(0);
  });

  it('returns 0 for successive calls below the cap within the window', () => {
    let t = 0;
    const throttle = new RateThrottle(3, 60_000, () => t);

    expect(throttle.acquire()).toBe(0); // slot 1
    t += 1000;
    expect(throttle.acquire()).toBe(0); // slot 2
    t += 1000;
    expect(throttle.acquire()).toBe(0); // slot 3
  });

  it('returns a positive delay when the cap is reached', () => {
    let t = 0;
    const throttle = new RateThrottle(2, 60_000, () => t);

    expect(throttle.acquire()).toBe(0); // slot 1 at t=0
    t += 5000;
    expect(throttle.acquire()).toBe(0); // slot 2 at t=5000

    // Window full (2 slots in 60s window).
    t += 1000; // t=6000
    const delay = throttle.acquire();
    // slot 1 was at t=0; it ages out at t=60000; we're at t=6000.
    // Expected delay ≈ 60000 - 6000 + 50 = 54050
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(60_000 + 100); // sanity upper bound
  });

  it('does NOT record a slot when returning a delay (caller must re-acquire)', () => {
    let t = 0;
    const throttle = new RateThrottle(1, 60_000, () => t);

    expect(throttle.acquire()).toBe(0); // slot 1

    t += 1000;
    // Window is full — acquire returns delay and does NOT record a slot.
    const delay1 = throttle.acquire();
    expect(delay1).toBeGreaterThan(0);

    // Calling again at same t still returns a delay (slot count unchanged).
    const delay2 = throttle.acquire();
    expect(delay2).toBeGreaterThan(0);
    // The two delays should be equal (same timestamp, same calculation).
    expect(delay2).toBe(delay1);
  });

  it('allows a new slot after advancing time past the window', () => {
    let t = 0;
    const throttle = new RateThrottle(2, 60_000, () => t);

    expect(throttle.acquire()).toBe(0); // slot 1 at t=0
    expect(throttle.acquire()).toBe(0); // slot 2 at t=0

    // Advance past the window (60001 ms) so both slots age out.
    t += 60_001;
    expect(throttle.acquire()).toBe(0); // Window cleared — slot available again
  });

  it('prunes expired slots correctly and tracks only recent calls', () => {
    let t = 0;
    const throttle = new RateThrottle(3, 60_000, () => t);

    // Fill up to cap.
    expect(throttle.acquire()).toBe(0); // t=0
    t += 10_000;
    expect(throttle.acquire()).toBe(0); // t=10000
    t += 10_000;
    expect(throttle.acquire()).toBe(0); // t=20000

    // Window full at t=20000 (all 3 slots occupied within 60s).
    expect(throttle.acquire()).toBeGreaterThan(0);

    // Advance so first slot (t=0) ages out: move past t=60000.
    t += 45_000; // t=65000 — slot at t=0 is now 65000 ms old > 60000
    // Now only slots at t=10000 and t=20000 are in the window — headroom opens.
    expect(throttle.acquire()).toBe(0); // slot recorded at t=65000
  });

  it('constructor rejects maxPerWindow < 1', () => {
    expect(() => new RateThrottle(0, 60_000)).toThrow('maxPerWindow must be ≥ 1');
  });

  it('constructor rejects windowMs < 1', () => {
    expect(() => new RateThrottle(5, 0)).toThrow('windowMs must be ≥ 1');
  });

  it('handles high-rate burst: first N calls succeed, N+1 is delayed', () => {
    const N = 20;
    let t = 0;
    const throttle = new RateThrottle(N, 60_000, () => t);

    // First N slots — all should succeed.
    for (let i = 0; i < N; i++) {
      t += 10; // 10 ms apart
      expect(throttle.acquire()).toBe(0);
    }

    // N+1 should be delayed.
    t += 10;
    expect(throttle.acquire()).toBeGreaterThan(0);
  });

  it('loop pattern: acquire + sleep + re-acquire allows progress', () => {
    let t = 0;
    const throttle = new RateThrottle(2, 60_000, () => t);

    expect(throttle.acquire()).toBe(0); // slot 1 at t=0
    expect(throttle.acquire()).toBe(0); // slot 2 at t=0

    // Window full — simulate the loop caller sleeping the returned delay.
    const delay = throttle.acquire();
    expect(delay).toBeGreaterThan(0);

    // Caller sleeps `delay` ms (simulated by advancing t).
    t += delay;

    // Now re-acquire — the oldest slot has aged out (t=0 + 60000 ≤ current t).
    expect(throttle.acquire()).toBe(0);
  });
});
