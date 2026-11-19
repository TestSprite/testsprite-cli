import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/errors.js';
import { runTestRun } from './test.js';

const RUNTIME_NEXT_ACTION =
  "This looks like a local-dev target. Save `--url http://localhost:<port>` on an environment, then run `testsprite run <test-id> --env <name>` — it tunnels this machine's loopback address to the test runner (frontend tests only; requires an API key with the `run:tunnel` scope). " +
  'See `testsprite run --help` for accepted values.';

async function rejectedBy(action: () => Promise<unknown>): Promise<ApiError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error('expected command to reject the local target');
}

describe('local target nextAction at run time', () => {
  it('run --target-url private keeps the exact runtime guidance', async () => {
    const error = await rejectedBy(() =>
      runTestRun({
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_existing',
        targetUrl: 'http://0.0.0.0:3000',
        wait: false,
        timeoutSeconds: 60,
      }),
    );

    expect(error.nextAction).toBe(RUNTIME_NEXT_ACTION);
  });
});
