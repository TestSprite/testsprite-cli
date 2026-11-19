/**
 * Run the tasks given to it no more than `limit` at a time, in the order
 * given. A finishing task hands its slot straight to the next waiting one, so
 * a caller that arrives during the hand-over waits too.
 */
export function concurrencyLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
  return async task => {
    if (running < limit) running++;
    else await new Promise<void>(resolve => waiting.push(resolve));
    try {
      return await task();
    } finally {
      release();
    }
  };
}
