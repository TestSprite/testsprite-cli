/**
 * Shared low-level helpers for the two polling loops (`poll.ts` for run
 * polling, `plan-poll.ts` for the plan-generation ladder). These three were
 * byte-identical copies in both files (#341 review); extracted here so a fix
 * to the interrupt/abort contract lands in one place. Signal COMPOSITION is
 * deliberately NOT here — each loop composes its own session signal with a
 * shape specific to its lifetime (`poll.ts` inline, `plan-poll.ts` via
 * `composeSessionSignal`), and folding those together would couple two
 * unrelated lifetimes.
 */

/** Resolve after `ms`. The default injectable sleep; tests substitute a fake. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Race a sleep against the shutdown signal: rejects with the signal's
 * `InterruptError` reason the moment it fires, so no backoff/retry/pacing wait
 * can delay the honest-detach UX. The default sleep receives the signal and
 * clears its pending timer when interrupted; the outer race remains necessary
 * for injected sleeps that do not implement cancellation themselves.
 */
export function sleepUnlessInterrupted(
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal == null) return sleep(ms);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    sleep(ms, signal).then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      err => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Detects an AbortError thrown when an AbortSignal fires. Works for native
 * fetch AbortErrors as well as `AbortController.abort()` from Node 18+ stdlib
 * (both set `name === 'AbortError'`).
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (typeof err === 'object' && err !== null && 'name' in err) {
    return (err as { name?: string }).name === 'AbortError';
  }
  return false;
}
