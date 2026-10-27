/**
 * Sliding-window rate throttle for the `create-batch --run` fan-out.
 *
 * Tracks the wall-clock timestamps of `acquire()` calls inside a rolling
 * time window (`windowMs`). When the number of acquired slots in the window
 * reaches `maxPerWindow`, `acquire()` returns the number of milliseconds the
 * caller should sleep before proceeding, such that the oldest slot in the
 * window will have aged out by the time the caller resumes.
 *
 * This is intentionally a simple in-process sliding-window counter — it does
 * NOT coordinate across separate CLI processes. Cross-process collisions are
 * handled by the per-trigger `RATE_LIMITED` retry path in `runBatchRun`.
 *
 * @example
 *   const throttle = new RateThrottle(50, 60_000);
 *   const waitMs = throttle.acquire();
 *   if (waitMs > 0) await sleep(waitMs);
 *   // … fire the trigger …
 */
export class RateThrottle {
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  /** Timestamps (Date.now()) of each acquired slot, oldest first. */
  private readonly slots: number[] = [];
  private readonly now: () => number;

  constructor(maxPerWindow: number, windowMs: number, now?: () => number) {
    if (maxPerWindow < 1) throw new Error('maxPerWindow must be ≥ 1');
    if (windowMs < 1) throw new Error('windowMs must be ≥ 1');
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.now = now ?? Date.now;
  }

  /**
   * Request a slot in the rate window.
   *
   * Prunes expired slots (older than `windowMs` ago), then:
   *  - If there is headroom (slots in window < maxPerWindow): records the
   *    current timestamp and returns `0` (no delay needed).
   *  - If the window is full: returns the delay in milliseconds until the
   *    oldest slot ages out. Does NOT record a new slot — the caller must
   *    call `acquire()` again after sleeping to claim the freed slot.
   *
   * This means callers should loop:
   *
   *   ```ts
   *   let wait: number;
   *   while ((wait = throttle.acquire()) > 0) {
   *     await sleep(wait);
   *   }
   *   ```
   *
   * Returns `0` when a slot was successfully acquired.
   */
  acquire(): number {
    const ts = this.now();
    const cutoff = ts - this.windowMs;

    // Prune slots older than the window.
    while (this.slots.length > 0 && (this.slots[0] as number) <= cutoff) {
      this.slots.shift();
    }

    if (this.slots.length < this.maxPerWindow) {
      // Slot available — record and proceed.
      this.slots.push(ts);
      return 0;
    }

    // Window full — compute how long until the oldest slot ages out.
    const oldestTs = this.slots[0] as number;
    const ageoutMs = oldestTs + this.windowMs - ts;
    // Add a 50 ms buffer so we land solidly after the cutoff.
    return Math.max(0, ageoutMs + 50);
  }

  /**
   * Return the last acquired slot when its caller will not dispatch a request.
   * Call only after acquire() returns 0 and before yielding or acquiring again,
   * so no other caller can have recorded a newer slot in the meantime.
   */
  releaseLast(): void {
    this.slots.pop();
  }
}
