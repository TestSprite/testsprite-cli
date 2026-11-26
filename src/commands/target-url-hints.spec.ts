import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/errors.js';
import { runCiRun } from './ci.js';

const RUNTIME_NEXT_ACTION =
  "This looks like a local-dev target. Save `--url http://localhost:<port>` on an environment, then run `testsprite run <test-id> --env <name>` — it tunnels this machine's loopback address to the test runner (frontend tests only; requires an API key with the `run:tunnel` scope). " +
  'See `testsprite ci run --help` for accepted values.';

async function rejectedBy(targetUrl: string): Promise<ApiError> {
  const fetchImpl = vi.fn(async () => {
    throw new Error('the target is refused before any request');
  });
  const error = await runCiRun(
    {
      profile: 'default',
      output: 'json',
      debug: false,
      projectId: 'project-1',
      targetUrl,
      timeoutSeconds: 60,
      maxConcurrency: 50,
    },
    {
      env: { TESTSPRITE_API_KEY: 'sk-user-test', TESTSPRITE_API_URL: 'http://localhost:13599' },
      fetchImpl,
      stdout: () => {},
      stderr: () => {},
    },
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiError);
  expect(fetchImpl).not.toHaveBeenCalled();
  return error as ApiError;
}

// `ci run` is the one command left that takes a run-time address.
describe('local target nextAction at run time', () => {
  it('ci run --target-url on an unspecified address keeps the exact runtime guidance', async () => {
    expect((await rejectedBy('http://0.0.0.0:3000')).nextAction).toBe(RUNTIME_NEXT_ACTION);
  });

  it('ci run --target-url on a private address points at ci run help', async () => {
    expect((await rejectedBy('http://10.0.0.1')).nextAction).toMatch(
      /See `testsprite ci run --help` for accepted values\.$/,
    );
  });
});
