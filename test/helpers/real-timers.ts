/**
 * Vitest setup file: every test ends on the real clock. A test that fakes
 * timers or spies on `Date.now` and never restores them (it timed out first,
 * say) would otherwise leave the rest of its file on a fake or frozen clock.
 */

import { afterEach, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  if (vi.isMockFunction(Date.now)) vi.mocked(Date.now).mockRestore();
});
