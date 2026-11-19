import { describe, expect, it } from 'vitest';
import { concurrencyLimiter } from './concurrency-limiter.js';

/** Let `n` microtask turns pass. */
async function turns(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('concurrencyLimiter', () => {
  it.each(Array.from({ length: 8 }, (_, delay) => delay))(
    'never runs more than its limit when a caller arrives %i turns after a release',
    async delay => {
      const limit = concurrencyLimiter(2);
      let running = 0;
      let most = 0;
      const releases: Array<() => void> = [];
      const task = () =>
        limit(async () => {
          most = Math.max(most, ++running);
          await new Promise<void>(resolve => releases.push(resolve));
          running--;
        });
      const settled = [task(), task(), task()];
      await new Promise(resolve => setImmediate(resolve));
      // The first finishes, handing its slot to the third; a fourth caller
      // arrives while that hand-over is under way.
      releases.shift()!();
      await turns(delay);
      settled.push(task());
      for (let round = 0; round < 6; round++) {
        await new Promise(resolve => setImmediate(resolve));
        while (releases.length > 0) releases.shift()!();
      }
      await Promise.all(settled);
      expect(most).toBe(2);
    },
  );

  it('runs the waiting tasks in the order they were given', async () => {
    const limit = concurrencyLimiter(1);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map(n => limit(async () => void order.push(n))));
    expect(order).toEqual([1, 2, 3]);
  });
});
