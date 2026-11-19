/**
 * The commands and options removed in 0.17.0, and where each one went.
 * Calling one is still an unknown command or option (exit 5); the error adds
 * this line, and the JSON envelope carries it as `nextAction`, so a script or
 * an installed agent skill that still calls one is told what to run instead.
 * The CHANGELOG's "Removed" tables are the source for every row.
 */

const READ_RESULTS =
  'read results with: testsprite result list --test <test-id> | --run <run-id>, and testsprite result get <result-id>';
const WRITE_TESTS =
  'tests are written by the project\'s agent: testsprite plan "<what to test>", then testsprite apply';
const PLAN_TESTS =
  'tests are written and changed by the project\'s agent: testsprite plan "<what to test>" (or testsprite reply in an open conversation), then testsprite apply';
const CHANGE_TESTS =
  'change or remove a test through the project\'s agent: testsprite plan "<test> should ..." (or testsprite reply in an open conversation), then testsprite apply';
const NO_CI_REPLACEMENT =
  'there is no replacement; read deployment history with gh api repos/<owner>/<repo>/deployments and link the platform with its CLI';

/**
 * Each removed command, under the group it was looked up in (`''` is the
 * root), and what replaced it. Only the first unknown name is looked up, so a
 * removed group's line holds for every command it had.
 */
const REMOVED_COMMANDS: Readonly<Record<string, ReadonlyMap<string, string>>> = {
  test: new Map([
    ['result', READ_RESULTS],
    ['steps', READ_RESULTS],
    ['failure', READ_RESULTS],
    ['artifact', READ_RESULTS],
    ['diff', 'there is no replacement; compare two `result get` outputs'],
    [
      'code',
      'view the stored test code in the Portal; change it through the project\'s agent: testsprite plan "<test> should ...", then testsprite apply',
    ],
    ['create', WRITE_TESTS],
    ['create-batch', WRITE_TESTS],
    ['scaffold', WRITE_TESTS],
    ['lint', WRITE_TESTS],
    ['plan', PLAN_TESTS],
    ['update', CHANGE_TESTS],
    ['delete', CHANGE_TESTS],
    ['delete-batch', CHANGE_TESTS],
    [
      'rerun',
      'use testsprite run <test-id...>, or testsprite run --project <project-id> for `--all`; `run` takes no `--status` or `--skip-terminal`',
    ],
    ['flaky', 'there is no replacement; run testsprite run <test-id> again'],
    ['open', 'open the Dashboard: link that testsprite run prints'],
  ]),
  project: new Map([
    ['docs', 'attach the document to the request: testsprite plan --file <path>'],
    [
      'sign-in',
      "an existing environment's sign-in is set in the Portal; testsprite project env create still takes the sign-in flags",
    ],
    [
      'credential',
      'use testsprite project env create <project-id> or testsprite project env update <project-id> <name> with --auth and --credential-file',
    ],
    [
      'auto-auth',
      'use testsprite project env update <project-id> <name> --auto-auth-file <json>; --auth switches it off',
    ],
  ]),
  ci: new Map([
    ['doctor', NO_CI_REPLACEMENT],
    ['connect', NO_CI_REPLACEMENT],
  ]),
  auth: new Map([
    ['configure', 'use testsprite setup'],
    ['whoami', 'use testsprite auth status'],
    ['logout', 'use testsprite auth remove'],
  ]),
  '': new Map([['init', 'use testsprite setup']]),
};

/**
 * Where an unknown command went, scoped to the group it was looked up in
 * (`''` for the root).
 */
export function removedCommandPointer(groupPath: string, name: string): string | undefined {
  if (groupPath === 'test' && name === 'run')
    return '`test run` was removed; use testsprite run <test-id...> or testsprite run --project <project-id>';
  if (groupPath === 'test' && (name === 'wait' || name === 'cancel'))
    return `\`test ${name}\` was removed; use testsprite run ${name} <run-id...>`;
  if (groupPath === 'testlist' && name === 'run')
    return '`testlist run` was removed; use testsprite run --testlist <list-id>; select a subset with testsprite run <test-id...> --testlist <list-id>';
  if (groupPath === 'schedule' && name === 'run') {
    return '`schedule run list` was removed in 0.17.0; view schedule runs in the Portal';
  }
  const replacement = Object.hasOwn(REMOVED_COMMANDS, groupPath)
    ? REMOVED_COMMANDS[groupPath]!.get(name)
    : undefined;
  if (replacement === undefined) return undefined;
  const path = groupPath === '' ? name : `${groupPath} ${name}`;
  return `\`${path}\` was removed in 0.17.0; ${replacement}`;
}

const ENV_CREATE =
  'set it on an environment: testsprite project env create <project-id> --name default --url <url> (or --local <port>), which takes the sign-in flags';
const ENV_UPDATE =
  'set it on an environment: testsprite project env update <project-id> <name> with the same flag';
const NO_RESULT_ON_A_CASE =
  'a test case carries no result; read its results with testsprite result list --test <test-id> (--limit 1 for the latest)';

const ENVIRONMENT_OPTIONS = [
  '--url',
  '--local',
  '--username',
  '--password',
  '--password-file',
  '--skip-preflight',
];

/** Each removed option, by the command that took it, and what replaced it. */
const REMOVED_OPTIONS = new Map<string, string>([
  ...ENVIRONMENT_OPTIONS.map((option): [string, string] => [
    `project create ${option}`,
    ENV_CREATE,
  ]),
  ...ENVIRONMENT_OPTIONS.map((option): [string, string] => [
    `project update ${option}`,
    ENV_UPDATE,
  ]),
  [
    'project create --description',
    'there is no replacement: a project has no description, so omit it',
  ],
  ['test list --status', NO_RESULT_ON_A_CASE],
  ['test list --env', NO_RESULT_ON_A_CASE],
  ['test list --created-from', NO_RESULT_ON_A_CASE],
]);

/**
 * The options `test run`, `test rerun` and `testlist run` took that root `run`
 * never did.
 */
const NOT_ON_RUN = new Map<string, string>([
  [
    '--status',
    'name the tests: testsprite run <test-id...> with the caseKey of each result that testsprite result list --run <run-id> --status failed,blocked lists',
  ],
  [
    '--skip-terminal',
    'there is no replacement: name the tests to run, testsprite run <test-id...>',
  ],
  ['--all', 'run a whole project with testsprite run --project <project-id>'],
  ['--case', 'name the tests: testsprite run <test-id...> --testlist <list-id>'],
]);

/**
 * Where an unknown option went, from Commander's own message for it and the
 * command it was given to. Only the option's name is read: it ends at `=`, so a
 * value given with it (a password, from an older script) is never in the line.
 */
export function removedOptionPointer(commandPath: string, message: string): string | undefined {
  const option = /unknown option '(--[^='\s]+)/.exec(message)?.[1];
  if (option === undefined) return undefined;
  const notOnRun = commandPath === 'run' ? NOT_ON_RUN.get(option) : undefined;
  if (notOnRun !== undefined) return `\`run\` takes no \`${option}\`; ${notOnRun}`;
  const replacement = REMOVED_OPTIONS.get(`${commandPath} ${option}`);
  return replacement === undefined
    ? undefined
    : `\`${commandPath} ${option}\` was removed in 0.17.0; ${replacement}`;
}
