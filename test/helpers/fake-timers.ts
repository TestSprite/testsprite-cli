import { vi } from 'vitest';

/** How much fake time {@link onFakeTimers} moves, in steps of 100 ms, before it gives up. */
const FAKE_TIME_LIMIT_MS = 100_000;

/**
 * Run `work` with `setTimeout` faked, moving the fake clock until it settles,
 * so a timer it waits on (an HTTP retry's back-off, say) takes no real time.
 * Work that has not settled after 100 s of fake time is rejected. The real
 * timers are always restored (and `real-timers.ts` restores them after every
 * test, should a test time out in here).
 */
export async function onFakeTimers<T>(work: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let settled = false;
    const pending = work().finally(() => {
      settled = true;
    });
    pending.catch(() => {});
    for (let ms = 0; !settled && ms < FAKE_TIME_LIMIT_MS; ms += 100) {
      await vi.advanceTimersByTimeAsync(100);
    }
    if (!settled) {
      throw new Error(`the work did not settle within ${FAKE_TIME_LIMIT_MS / 1000} s of fake time`);
    }
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}
