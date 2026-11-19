import { describe, expect, it } from 'vitest';
import { removedCommandPointer, removedOptionPointer } from './removed-commands.js';

const WRITE =
  'tests are written by the project\'s agent: testsprite plan "<what to test>", then testsprite apply';
const PLAN =
  'tests are written and changed by the project\'s agent: testsprite plan "<what to test>" (or testsprite reply in an open conversation), then testsprite apply';
const CHANGE =
  'change or remove a test through the project\'s agent: testsprite plan "<test> should ..." (or testsprite reply in an open conversation), then testsprite apply';
const READ_RESULTS =
  'read results with: testsprite result list --test <test-id> | --run <run-id>, and testsprite result get <result-id>';
const NO_CI =
  'there is no replacement; read deployment history with gh api repos/<owner>/<repo>/deployments and link the platform with its CLI';

describe('removedCommandPointer', () => {
  it.each([
    // The launch commands that moved to `run`.
    [
      'test',
      'run',
      '`test run` was removed; use testsprite run <test-id...> or testsprite run --project <project-id>',
    ],
    ['test', 'wait', '`test wait` was removed; use testsprite run wait <run-id...>'],
    ['test', 'cancel', '`test cancel` was removed; use testsprite run cancel <run-id...>'],
    [
      'testlist',
      'run',
      '`testlist run` was removed; use testsprite run --testlist <list-id>; select a subset with testsprite run <test-id...> --testlist <list-id>',
    ],
    [
      'schedule',
      'run',
      '`schedule run list` was removed in 0.17.0; view schedule runs in the Portal',
    ],
    // The read commands `result list` / `result get` replaced.
    ['test', 'result', `\`test result\` was removed in 0.17.0; ${READ_RESULTS}`],
    ['test', 'steps', `\`test steps\` was removed in 0.17.0; ${READ_RESULTS}`],
    ['test', 'failure', `\`test failure\` was removed in 0.17.0; ${READ_RESULTS}`],
    ['test', 'artifact', `\`test artifact\` was removed in 0.17.0; ${READ_RESULTS}`],
    [
      'test',
      'diff',
      '`test diff` was removed in 0.17.0; there is no replacement; compare two `result get` outputs',
    ],
    // `test code get` and `test code put` share the one name that is looked up.
    [
      'test',
      'code',
      '`test code` was removed in 0.17.0; view the stored test code in the Portal; change it through the project\'s agent: testsprite plan "<test> should ...", then testsprite apply',
    ],
    // The commands that wrote tests.
    ['test', 'create', `\`test create\` was removed in 0.17.0; ${WRITE}`],
    ['test', 'create-batch', `\`test create-batch\` was removed in 0.17.0; ${WRITE}`],
    ['test', 'scaffold', `\`test scaffold\` was removed in 0.17.0; ${WRITE}`],
    ['test', 'lint', `\`test lint\` was removed in 0.17.0; ${WRITE}`],
    // `test plan generate`, `accept` and `put` share the one name that is looked up.
    ['test', 'plan', `\`test plan\` was removed in 0.17.0; ${PLAN}`],
    ['test', 'update', `\`test update\` was removed in 0.17.0; ${CHANGE}`],
    ['test', 'delete', `\`test delete\` was removed in 0.17.0; ${CHANGE}`],
    ['test', 'delete-batch', `\`test delete-batch\` was removed in 0.17.0; ${CHANGE}`],
    [
      'test',
      'rerun',
      '`test rerun` was removed in 0.17.0; use testsprite run <test-id...>, or testsprite run --project <project-id> for `--all`; `run` takes no `--status` or `--skip-terminal`',
    ],
    [
      'test',
      'flaky',
      '`test flaky` was removed in 0.17.0; there is no replacement; run testsprite run <test-id> again',
    ],
    [
      'test',
      'open',
      '`test open` was removed in 0.17.0; open the Dashboard: link that testsprite run prints',
    ],
    [
      'project',
      'docs',
      '`project docs` was removed in 0.17.0; attach the document to the request: testsprite plan --file <path>',
    ],
    [
      'project',
      'sign-in',
      "`project sign-in` was removed in 0.17.0; an existing environment's sign-in is set in the Portal; testsprite project env create still takes the sign-in flags",
    ],
    [
      'project',
      'credential',
      '`project credential` was removed in 0.17.0; use testsprite project env create <project-id> or testsprite project env update <project-id> <name> with --auth and --credential-file',
    ],
    [
      'project',
      'auto-auth',
      '`project auto-auth` was removed in 0.17.0; use testsprite project env update <project-id> <name> --auto-auth-file <json>; --auth switches it off',
    ],
    ['ci', 'doctor', `\`ci doctor\` was removed in 0.17.0; ${NO_CI}`],
    ['ci', 'connect', `\`ci connect\` was removed in 0.17.0; ${NO_CI}`],
    // The hidden aliases; a root command is looked up in the group ''.
    ['', 'init', '`init` was removed in 0.17.0; use testsprite setup'],
    ['auth', 'configure', '`auth configure` was removed in 0.17.0; use testsprite setup'],
    ['auth', 'whoami', '`auth whoami` was removed in 0.17.0; use testsprite auth status'],
    ['auth', 'logout', '`auth logout` was removed in 0.17.0; use testsprite auth remove'],
  ])('%j %j', (group, name, pointer) => {
    expect(removedCommandPointer(group, name)).toBe(pointer);
    expect(pointer).not.toContain('\n');
  });

  it.each([
    ['test', 'bogus'],
    ['project', 'create'],
    ['project', 'result'],
    ['project env', 'result'],
    ['', 'create'],
    ['', 'run'],
    ['ci', 'init'],
    ['schedule', 'open'],
  ])('%j %j is not a removed command', (group, name) => {
    expect(removedCommandPointer(group, name)).toBeUndefined();
  });
});

describe('removedOptionPointer', () => {
  const ENV_CREATE =
    'set it on an environment: testsprite project env create <project-id> --name default --url <url> (or --local <port>), which takes the sign-in flags';
  const ENV_UPDATE =
    'set it on an environment: testsprite project env update <project-id> <name> with the same flag';
  const NO_RESULT =
    'a test case carries no result; read its results with testsprite result list --test <test-id> (--limit 1 for the latest)';

  it.each([
    [
      'run',
      '--all',
      '`run` takes no `--all`; run a whole project with testsprite run --project <project-id>',
    ],
    [
      'run',
      '--case',
      '`run` takes no `--case`; name the tests: testsprite run <test-id...> --testlist <list-id>',
    ],
    [
      'run',
      '--status',
      '`run` takes no `--status`; name the tests: testsprite run <test-id...> with the caseKey of each result that testsprite result list --run <run-id> --status failed,blocked lists',
    ],
    [
      'run',
      '--skip-terminal',
      '`run` takes no `--skip-terminal`; there is no replacement: name the tests to run, testsprite run <test-id...>',
    ],
    [
      'project create',
      '--description',
      '`project create --description` was removed in 0.17.0; there is no replacement: a project has no description, so omit it',
    ],
    ...['--url', '--local', '--username', '--password', '--password-file', '--skip-preflight'].map(
      option => [
        'project create',
        option,
        `\`project create ${option}\` was removed in 0.17.0; ${ENV_CREATE}`,
      ],
    ),
    ...['--url', '--local', '--username', '--password', '--password-file', '--skip-preflight'].map(
      option => [
        'project update',
        option,
        `\`project update ${option}\` was removed in 0.17.0; ${ENV_UPDATE}`,
      ],
    ),
    ...['--status', '--env', '--created-from'].map(option => [
      'test list',
      option,
      `\`test list ${option}\` was removed in 0.17.0; ${NO_RESULT}`,
    ]),
  ])('%j %j', (command, option, pointer) => {
    expect(removedOptionPointer(command!, `error: unknown option '${option}'\n`)).toBe(pointer);
  });

  it('reads the option name and never the value given with it', () => {
    const pointer = removedOptionPointer(
      'project create',
      "error: unknown option '--password=hunter2'\n",
    );
    expect(pointer).toBe(`\`project create --password\` was removed in 0.17.0; ${ENV_CREATE}`);
    expect(
      removedOptionPointer('project update', "error: unknown option '--password=[REDACTED]'\n"),
    ).toBe(`\`project update --password\` was removed in 0.17.0; ${ENV_UPDATE}`);
  });

  it.each([
    ['run', "error: unknown option '--bogus'\n"],
    ['run wait', "error: unknown option '--all'\n"],
    ['project env create', "error: unknown option '--all'\n"],
    ['project update', "error: unknown option '--description'\n"],
    ['run wait', "error: unknown option '--status'\n"],
    ['project create', "error: unknown option '--urls'\n"],
    ['project create', "error: unknown command 'url'\n"],
    ['project create', "error: missing required argument 'project-id'\n"],
    ['', "error: unknown option '--all'\n"],
  ])('%j %j has no pointer', (command, message) => {
    expect(removedOptionPointer(command, message)).toBeUndefined();
  });
});
