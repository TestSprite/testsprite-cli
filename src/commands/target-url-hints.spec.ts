import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/errors.js';
import { runCreate as runProjectCreate, runUpdate as runProjectUpdate } from './project.js';
import {
  runCreate as runTestCreate,
  runCreateBatch,
  runCreateFromPlan,
  runTestRun,
} from './test.js';

const BOOTSTRAP_GUIDANCE =
  "TestSprite executes tests from the cloud, so a project's URL must be an internet-reachable address the runner can use. " +
  'Set the project to its deployed or staging URL. ' +
  'After a test exists, target an app on this machine for an individual run with ' +
  "`testsprite test run <test-id> --local <port>`; that tunnel is per-run and does not make localhost the project's URL. ";

const RUNTIME_NEXT_ACTION =
  "This looks like a local-dev target. Run it with `testsprite test run <test-id> --local <port>` instead — it tunnels this machine's loopback address to the test runner (frontend tests only; requires an API key with the `run:tunnel` scope). " +
  'See `testsprite test run --help` for accepted values.';

async function rejectedBy(action: () => Promise<unknown>): Promise<ApiError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error('expected command to reject the local target');
}

const bootstrapCases: ReadonlyArray<readonly [string, string, string, () => Promise<unknown>]> = [
  [
    'project create --url localhost',
    'url',
    'testsprite project create',
    () =>
      runProjectCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: true,
          type: 'frontend',
          name: 'Local app',
          targetUrl: 'http://localhost:3000',
        },
        { stdout: () => {}, stderr: () => {} },
      ),
  ],
  [
    'project update --url 127.0.0.1',
    'url',
    'testsprite project update',
    () =>
      runProjectUpdate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: true,
          projectId: 'project_local',
          targetUrl: 'http://127.0.0.1:3000',
        },
        { stdout: () => {}, stderr: () => {} },
      ),
  ],
  [
    'test create --target-url localhost',
    'target-url',
    'testsprite test create',
    () =>
      runTestCreate(
        {
          profile: 'default',
          output: 'json',
          debug: false,
          dryRun: true,
          projectId: 'project_local',
          type: 'frontend',
          name: 'Local test',
          codeFile: 'unused-in-dry-run.py',
          targetUrl: 'http://localhost:3000',
        },
        { stdout: () => {}, stderr: () => {} },
      ),
  ],
  [
    'test create --plan-from --target-url localhost',
    'target-url',
    'testsprite test create',
    () =>
      runCreateFromPlan({
        profile: 'default',
        output: 'json',
        debug: false,
        planFrom: 'unread-because-target-is-rejected.json',
        targetUrl: 'http://localhost:3000',
      }),
  ],
  [
    'test create-batch --target-url localhost',
    'target-url',
    'testsprite test create-batch',
    () =>
      runCreateBatch({
        profile: 'default',
        output: 'json',
        debug: false,
        plans: 'unread-because-target-is-rejected.jsonl',
        targetUrl: 'http://localhost:3000',
      }),
  ],
];

describe('local target nextAction by command phase', () => {
  it.each(bootstrapCases)(
    '%s receives the caller-specific field and help guidance',
    async (_name, field, helpCommand, action) => {
      const error = await rejectedBy(action);
      expect(error.message).toContain(`Field \`${field}\``);
      expect(error.details).toMatchObject({ field });
      expect(error.nextAction).toBe(
        `${BOOTSTRAP_GUIDANCE}See \`${helpCommand} --help\` for accepted values.`,
      );
    },
  );

  it('test run --target-url localhost keeps the exact runtime guidance', async () => {
    const error = await rejectedBy(() =>
      runTestRun({
        profile: 'default',
        output: 'json',
        debug: false,
        testId: 'test_existing',
        targetUrl: 'http://localhost:3000',
        wait: false,
        timeoutSeconds: 60,
      }),
    );

    expect(error.nextAction).toBe(RUNTIME_NEXT_ACTION);
  });

  it('never presents <test-id> as the only instruction on a project/test-creation path', async () => {
    for (const [, , , action] of bootstrapCases) {
      const { nextAction } = await rejectedBy(action);
      expect(nextAction).toContain('Set the project to its deployed or staging URL.');
      expect(nextAction).toContain('After a test exists');
      expect(nextAction.indexOf('After a test exists')).toBeLessThan(
        nextAction.indexOf('<test-id>'),
      );
    }
  });
});
