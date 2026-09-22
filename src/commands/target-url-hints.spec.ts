import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/errors.js';
import { runCreate as runProjectCreate, runUpdate as runProjectUpdate } from './project.js';
import {
  runCreate as runTestCreate,
  runCreateBatch,
  runCreateFromPlan,
  runTestRun,
} from './test.js';

// What a per-run-target caller emits (`test create --target-url`). A project or
// environment for an app on this machine is created with `--local <port>`, so
// the text says that instead of sending the reader to find a public URL.
const BOOTSTRAP_GUIDANCE =
  'TestSprite executes tests from the cloud, so the runner needs an address it can reach: ' +
  'a deployed or staging URL. For an app that only runs on this machine, create the project ' +
  'or environment with `--local <port>` instead of a URL, then run with ' +
  '`testsprite test run <test-id> --local <port>`. ';

const LOCAL_PROJECT_GUIDANCE =
  'Use --local <port> instead of --url for an app on this machine. ' +
  'Local projects are frontend-only and require the V3 project platform. ';

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

// `project create/update --url` never accept a loopback address: an app on
// this machine is named with `--local <port>` on both, so a loopback `--url`
// (and a bind-all `0.0.0.0` / `::`, which is not loopback either) is
// redirected to that flag. These two cases exercise the bind-all shape.
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
      // Every project write has `--local <port>`; only the per-run test-create
      // paths still lead with the deployed-URL shape.
      const guidance = helpCommand.startsWith('testsprite project ')
        ? LOCAL_PROJECT_GUIDANCE
        : BOOTSTRAP_GUIDANCE;
      expect(error.nextAction).toBe(
        `${guidance}See \`${helpCommand} --help\` for accepted values.`,
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
    for (const [, , helpCommand, action] of bootstrapCases) {
      const { nextAction } = await rejectedBy(action);
      if (helpCommand.startsWith('testsprite project ')) {
        expect(nextAction).toContain('Use --local <port> instead of --url');
        expect(nextAction).not.toContain('<test-id>');
        continue;
      }
      expect(nextAction).toContain('a deployed or staging URL');
      expect(nextAction).toContain('`--local <port>`');
      // The deployed shape comes first; the per-run tunnel is not the only instruction.
      expect(nextAction.indexOf('a deployed or staging URL')).toBeLessThan(
        nextAction.indexOf('<test-id>'),
      );
    }
  });

  it('project update --local <port> is the one way to point a project at this machine', async () => {
    // Same spelling as `project create`: the CLI builds the loopback URL and
    // sends the marker; a dry run validates the flags but dials nothing.
    const updated = await runProjectUpdate(
      {
        profile: 'default',
        output: 'json',
        debug: false,
        dryRun: true,
        projectId: 'project_local',
        local: '3000',
      },
      { stdout: () => {}, stderr: () => {} },
    );
    expect(updated.updatedFields).toEqual(['targetUrl']);
  });

  it('a loopback --url is refused on create AND update, and both point at --local <port>', async () => {
    // A loopback address is never stored through `--url`: that flag has no
    // opt-in, `--local` is the opt-in. The refusal names it, and never a flag
    // the command does not have.
    const attempts = [
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
    ];
    for (const attempt of attempts) {
      const error = await rejectedBy(attempt);
      expect(error.details).toMatchObject({ field: 'url' });
      expect(error.nextAction).toContain('Use --local <port> instead of --url');
      expect(error.nextAction).not.toContain('--origin-mode');
    }
  });
});
