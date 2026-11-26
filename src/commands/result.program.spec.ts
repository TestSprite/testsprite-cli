import { projectRun, runListing } from '../../test/helpers/project-run.js';
import { resultLine } from '../../test/helpers/result-list.js';
/**
 * `result list` and `result get` through the real program, in process: the
 * parser in `src/index.ts`, the command, the HTTP client and the top-level
 * error renderer.
 *
 * Hints: every `testsprite result get|list …` the CLI prints is a command that
 * parses. The shipped source is scanned for them, each is reduced to its shape
 * (the flags it passes and the placeholders it names), and every shape runs as
 * a dry run. A hint whose shape is not in {@link SHAPES} fails the first test,
 * so a new hint, or one naming the wrong id, is caught before it ships.
 *
 * Errors: a result the server does not know, and a server error carrying
 * terminal escape sequences, as text and as JSON.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as InterruptModule from '../lib/interrupt.js';
import type * as ResultApiModule from '../lib/result/api.js';

// The real parser, commands and error renderer run; only the process-wide
// handlers are left out of these in-process invocations.
vi.mock('../lib/interrupt.js', async importOriginal => ({
  ...(await importOriginal<typeof InterruptModule>()),
  installSignalHandlers: vi.fn(),
  installBrokenPipeGuard: vi.fn(),
  armInterruptExitBackstop: vi.fn(),
}));
vi.mock('../lib/proxy.js', () => ({
  maybeInstallProxyAgent: vi.fn(),
  isProxyAgentActive: () => false,
}));

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What a `${…}` interpolation after each token stands for. */
const INTERPOLATED_AFTER = new Map([
  ['get', '<result-id>'],
  ['--test', '<test-id>'],
  ['--run', '<run-id>'],
  ['--out', '<dir>'],
]);

/**
 * The camelCase spellings of a placeholder. Any other placeholder stays as it
 * is written, so `result get <run-id>` is a shape of its own and fails.
 */
const SYNONYM = new Map([
  ['<resultId>', '<result-id>'],
  ['<runId>', '<run-id>'],
  ['<testId>', '<test-id>'],
]);

/** A concrete value for each placeholder. */
const VALUE_OF = new Map([
  ['<result-id>', 'res_hint'],
  ['<test-id>', 'test_hint'],
  ['<run-id>', 'run_hint'],
  ['<dir>', 'evidence'],
]);

/**
 * Every hint shape the CLI prints, and the exit code its dry run ends with.
 * A dry run of the `--out` shape lists what it would write, and writes nothing.
 */
const SHAPES: Record<string, number> = {
  'result get <result-id>': 0,
  'result get <result-id> --out <dir>': 0,
  'result list --test <test-id>': 0,
  'result list --run <run-id>': 0,
  // What an owned tunnel cancelled: the read the tunnel hints name.
  'result list --run <run-id> --status cancelled': 0,
  // The results a removed `--status` selection ran: the `run --status` pointer.
  'result list --run <run-id> --status failed,blocked': 0,
};

/**
 * Hints printed in two parts: a sentence that names `result get <id>` and
 * then adds "add --out <dir>". Each pairing is a shape of its own.
 */
const COMPOSED: ReadonlyArray<{ hint: RegExp; shape: string }> = [
  {
    hint: /testsprite result get [\s\S]{0,200}?add --out <dir>/,
    shape: 'result get <result-id> --out <dir>',
  },
];

/* eslint-disable security/detect-non-literal-fs-filename -- reads the repository's own src tree beside this file, never user input. */
/** Every shipped source file under `src`: not a spec, test or declaration file. */
function shippedSources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return shippedSources(path);
    return /(?<!\.(?:spec|test|d))\.ts$/.test(entry.name) ? [path] : [];
  });
}

/**
 * One argument of a hint: a flag, a `<placeholder>` or a `${interpolation}`,
 * which may pass the id through a call (`${terminalSafeLine(testId)}`).
 */
const ARGUMENT = / (--[a-z][a-z-]*|<[a-zA-Z-]+>|\$\{[\w.()]+\})/y;

/** A status list after `--status`, as `result list` takes it. */
const STATUS_VALUE =
  / ((?:passed|failed|running|blocked|cancelled)(?:,(?:passed|failed|running|blocked|cancelled))*)/y;

/** The arguments right after `index`, up to the first thing that is not one. */
function argumentsAt(text: string, index: number): string[] {
  const found: string[] = [];
  ARGUMENT.lastIndex = index;
  for (let match = ARGUMENT.exec(text); match; match = ARGUMENT.exec(text)) {
    found.push(match[1]!);
    // `--status` takes a value a hint spells out (`--status cancelled`).
    if (match[1] === '--status') {
      STATUS_VALUE.lastIndex = ARGUMENT.lastIndex;
      const value = STATUS_VALUE.exec(text);
      if (value) {
        found.push(value[1]!);
        ARGUMENT.lastIndex = STATUS_VALUE.lastIndex;
      }
    }
  }
  return found;
}

/** The hint shapes in `text`: an interpolation named by what it stands for, a placeholder as written. */
function shapesIn(text: string): string[] {
  const shapes = [...text.matchAll(/testsprite (result (?:get|list))/g)].map(hint => {
    const tokens = [...hint[1]!.split(' '), ...argumentsAt(text, hint.index + hint[0].length)];
    return tokens
      .map((token, i) =>
        token.startsWith('${')
          ? (INTERPOLATED_AFTER.get(tokens[i - 1]!) ?? token)
          : (SYNONYM.get(token) ?? token),
      )
      .join(' ');
  });
  const composed = COMPOSED.filter(({ hint }) => hint.test(text)).map(({ shape }) => shape);
  return [...shapes, ...composed];
}

const found = [...new Set(shippedSources().flatMap(file => shapesIn(readFileSync(file, 'utf8'))))];
/* eslint-enable security/detect-non-literal-fs-filename */

// ── running the program ──────────────────────────────────────────────────────

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let stdout = '';
let stderr = '';
/** A backend that fails every request: a dry run must send none. */
const refusingFetch = () =>
  vi.fn((_input: unknown, _init?: RequestInit): Promise<Response> =>
    Promise.reject(new Error('a dry run sent a request')),
  );
/** The backend every request goes to. */
let fetchImpl = refusingFetch();

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(line => {
    stdout += `${String(line)}\n`;
  });
  vi.spyOn(console, 'error').mockImplementation(line => {
    stderr += `${String(line)}\n`;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
    stderr += String(chunk);
    return true;
  });
  vi.stubEnv('TESTSPRITE_API_KEY', 'sk-user-unit-test');
  vi.stubEnv('TESTSPRITE_API_URL', 'https://api.example.com');
  vi.stubEnv('TESTSPRITE_NO_SKILL_WARNING', '1');
  vi.stubEnv('TESTSPRITE_NO_UPDATE_CHECK', '1');
  vi.stubEnv('TESTSPRITE_NO_TELEMETRY', '1');
  fetchImpl = refusingFetch();
  vi.stubGlobal('fetch', fetchImpl);
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Run the real program once, in process. */
async function cli(args: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
  vi.resetModules();
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  process.argv = ['node', 'testsprite', ...args];
  await import('../index.js');
  return { exit: Number(process.exitCode ?? 0), stdout, stderr };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A server error envelope. */
const failure = (status: number, error: Record<string, unknown>): Response =>
  json({ error: { code: 'NOT_FOUND', requestId: 'req_404', details: {}, ...error } }, status);

/** The JSON envelope the program wrote on stderr. */
const envelopeOf = (text: string) => (JSON.parse(text) as { error: Record<string, unknown> }).error;

describe('the result hints the CLI prints', () => {
  it('are found in the source, and each has a shape this file runs', () => {
    expect(found).toEqual(
      expect.arrayContaining([
        'result get <result-id>',
        'result get <result-id> --out <dir>',
        'result list --test <test-id>',
      ]),
    );
    expect(found.filter(shape => !(shape in SHAPES))).toEqual([]);
  });

  it('a placeholder naming the wrong id keeps its own shape', () => {
    expect(shapesIn('Use testsprite result get <run-id> next.')).toEqual(['result get <run-id>']);
    expect(shapesIn('Use testsprite result list --run <resultId>.')).toEqual([
      'result list --run <result-id>',
    ]);
    expect(shapesIn('Use `testsprite result get ${row.runId}`.')).toEqual([
      'result get <result-id>',
    ]);
  });

  it.each(Object.entries(SHAPES))('%s parses (dry run exits %i)', async (shape, exit) => {
    const args = shape.split(' ').map(token => VALUE_OF.get(token) ?? token);
    const printed = await cli([...args, '--dry-run']);
    expect(printed.exit, printed.stderr).toBe(exit);
    expect(printed.stderr).not.toMatch(/unknown option|unknown command|missing required/i);
    if (exit === 0) expect(printed.stdout.length).toBeGreaterThan(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('a result the server does not know', () => {
  beforeEach(() => {
    fetchImpl.mockImplementation(() =>
      Promise.resolve(
        failure(404, {
          message: 'Resource not found.',
          nextAction: 'Check the id with the corresponding `list` command.',
          details: { resource: 'result', id: 'r_missing' },
        }),
      ),
    );
  });

  it('exits 4 and names it, in text', async () => {
    const printed = await cli(['result', 'get', 'r_missing']);
    expect(printed.exit).toBe(4);
    expect(printed.stdout).toBe('');
    expect(printed.stderr).toContain('Error: Resource not found.\n');
    expect(printed.stderr).toContain('Check the id with the corresponding `list` command.');
    expect(printed.stderr).toContain('requestId: req_404');
  });

  it('exits 4 and names it, in the JSON envelope', async () => {
    const printed = await cli(['--output', 'json', 'result', 'get', 'r_missing']);
    expect(printed.exit).toBe(4);
    expect(envelopeOf(printed.stderr)).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Resource not found.',
      requestId: 'req_404',
      details: { resource: 'result', id: 'r_missing' },
    });
  });
});

describe('a server error that carries terminal escape sequences', () => {
  const message = 'Resource \u001b]0;pwned\u0007not found.\nrequestId: req_forged';
  const nextAction =
    'Check \u001b[31mthe id\u001b[0m.\u001b]8;;https://evil.example\u001b\\\nThen retry.';
  const requestId = 'req_\u001b[2J404\nrequestId: forged';

  beforeEach(() => {
    // No resource named: the error passes through as the server sent it.
    fetchImpl.mockImplementation(() =>
      Promise.resolve(failure(404, { message, nextAction, requestId })),
    );
  });

  it('is printed without them in text: message and request id on one line each', async () => {
    const printed = await cli(['result', 'get', 'r1']);
    expect(printed.exit).toBe(4);
    for (const unsafe of ['\u001b', '\u0007', 'pwned', 'evil.example']) {
      expect(printed.stderr).not.toContain(unsafe);
    }
    const lines = printed.stderr.split('\n');
    expect(lines).toContain('Error: Resource not found. requestId: req_forged');
    expect(lines.some(line => line.startsWith('requestId: req_forged'))).toBe(false);
    expect(lines).toContain('Check the id.');
    expect(lines).toContain('Then retry.');
    // The request id stays on its own line: a line break in it is a space.
    expect(lines).toContain('requestId: req_404 requestId: forged');
    expect(lines).not.toContain('requestId: forged');
  });

  it('is printed without them in the details text mode lists (the scopes of a refused key)', async () => {
    fetchImpl.mockImplementation(() =>
      Promise.resolve(
        failure(403, {
          code: 'AUTH_FORBIDDEN',
          message: 'API key does not grant the required scope.',
          nextAction: '',
          details: {
            requiredScopes: ['read:tests\u001b]0;pwned\u0007\n  granted:  everything'],
            grantedScopes: ['run:tests\u001b[31m'],
          },
        }),
      ),
    );
    const printed = await cli(['result', 'get', 'r1']);
    expect(printed.exit).toBe(3);
    expect(printed.stderr).toContain('  required: read:tests granted: everything\n');
    expect(printed.stderr).toContain('  granted:  run:tests\n');
    expect(printed.stderr).not.toContain('pwned');
    expect(printed.stderr).not.toContain('\u001b');
  });

  it('is printed as the server sent it in the JSON envelope', async () => {
    const printed = await cli(['--output', 'json', 'result', 'get', 'r1']);
    expect(printed.exit).toBe(4);
    expect(envelopeOf(printed.stderr)).toMatchObject({ message, nextAction, requestId });
  });
});

describe('a refusal of a client too old, whose versions carry escape sequences', () => {
  beforeEach(() => {
    fetchImpl.mockImplementation(() =>
      Promise.resolve(
        failure(426, {
          code: 'CLIENT_TOO_OLD',
          message: 'CLI version is below the minimum supported version.',
          nextAction: 'Upgrade the CLI.',
          details: {
            yourVersion: '0.17.0\u001b]0;pwned\u0007\n  forged: line',
            minVersion: '0.18.0\u001b[31m',
          },
        }),
      ),
    );
  });

  it('prints the two versions on one clean line in text', async () => {
    const printed = await cli(['result', 'get', 'r1']);
    expect(printed.exit).toBe(14);
    expect(printed.stderr.split('\n')).toContain(
      '  your version: 0.17.0 forged: line, minimum supported: 0.18.0',
    );
    expect(printed.stderr).not.toContain('\u001b');
    expect(printed.stderr).not.toContain('pwned');
  });
});

describe('a request timeout whose message names a server value', () => {
  // The timeout a command raises when a read of a result goes unanswered
  // names that result; here the id carries a sequence and a forged line.
  const message = 'Could not read result res_1\u001b]0;pwned\u0007\nrequestId: forged within 10s.';

  beforeEach(() => {
    vi.doMock('../lib/result/api.js', async importOriginal => {
      const { RequestTimeoutError } = await import('../lib/errors.js');
      const real = await importOriginal<typeof ResultApiModule>();
      return {
        ...real,
        resultApi: () => ({
          get: () => Promise.reject(new RequestTimeoutError(10_000, 'local', { message })),
        }),
      };
    });
  });

  afterEach(() => {
    vi.doUnmock('../lib/result/api.js');
  });

  it('prints it on one clean line in text', async () => {
    const printed = await cli(['result', 'get', 'r1']);
    expect(printed.exit).toBe(7);
    expect(printed.stderr.split('\n')).toContain(
      'Error: Could not read result res_1 requestId: forged within 10s.',
    );
    expect(printed.stderr).not.toContain('\u001b');
  });

  it('keeps it as composed in the JSON envelope', async () => {
    const printed = await cli(['--output', 'json', 'result', 'get', 'r1']);
    expect(printed.exit).toBe(7);
    expect(envelopeOf(printed.stderr)).toMatchObject({ code: 'REQUEST_TIMEOUT', message });
  });
});

describe('an error the CLI composes around a server value', () => {
  // The run row names its result with an id carrying a window-title sequence
  // and a line break; the failed run ends in a CLIError that embeds that id.
  const resultId = 'res_1\u001b]0;pwned\u0007\nrequestId: req_forged';
  beforeEach(() => {
    fetchImpl.mockImplementation((input: unknown, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const route = `${init?.method ?? 'GET'} ${url.pathname.replace('/api/cli/v1', '')}`;
      if (route === 'GET /tests/fails') {
        return Promise.resolve(
          json({ id: 'fails', title: 'Test fails', type: 'frontend', projectId: 'P' }),
        );
      }
      if (route === 'GET /projects/P/env') {
        return Promise.resolve(
          json({
            environments: [
              { id: 'env_1', name: 'prod', url: 'https://app.example.com', isDefault: true },
            ],
          }),
        );
      }
      if (route === 'POST /projects/P/runs')
        return Promise.resolve(json(projectRun({ runId: 'run_1', projectId: 'P' })));
      if (route === 'GET /results')
        return Promise.resolve(
          json(
            runListing({ runId: 'run_1', status: 'finished', cancelled: false }, [
              resultLine({ resultId, runId: 'run_1', caseKey: 'fails', testStatus: 'FAILED' }),
            ]),
          ),
        );
      return Promise.reject(new Error(`Unexpected request: ${route}`));
    });
  });

  it('prints it on one line without the sequence in text', async () => {
    const printed = await cli(['run', 'fails', '--wait']);
    expect(printed.exit).toBe(1);
    expect(printed.stdout).toContain('res_1 requestId: req_forged');
    expect(printed.stdout).not.toContain('\u001b');
    expect(printed.stderr).toContain('Error: 1 result failed.');
  });

  it('keeps it as the server sent it in the JSON envelope', async () => {
    const printed = await cli(['--output', 'json', 'run', 'fails', '--wait']);
    expect(printed.exit).toBe(1);
    expect(JSON.parse(printed.stdout).results[0].resultId).toBe(resultId);
    const envelope = printed.stderr.slice(printed.stderr.lastIndexOf('{\n  "error"'));
    expect(envelopeOf(envelope)).toMatchObject({
      message: '1 result failed.',
    });
  });
});

describe('a read command removed from `test`', () => {
  const READ_RESULTS =
    'read results with: testsprite result list --test <test-id> | --run <run-id>, and testsprite result get <result-id>';
  const POINTER: Record<string, string> = {
    result: `\`test result\` was removed in 0.17.0; ${READ_RESULTS}`,
    steps: `\`test steps\` was removed in 0.17.0; ${READ_RESULTS}`,
    failure: `\`test failure\` was removed in 0.17.0; ${READ_RESULTS}`,
    artifact: `\`test artifact\` was removed in 0.17.0; ${READ_RESULTS}`,
    diff: '`test diff` was removed in 0.17.0; there is no replacement; compare two `result get` outputs',
  };

  it.each(Object.keys(POINTER))(
    '`test %s` exits 5 with the unknown-command error and one line saying where it went',
    async name => {
      const printed = await cli(['test', name, 'test_1']);
      expect(printed.exit).toBe(5);
      expect(printed.stdout).toBe('');
      expect(printed.stderr).toBe(`error: unknown command '${name}'\n${POINTER[name]}\n`);
    },
  );

  it.each([
    [['test', 'result', '--help']],
    [['test', '--help', 'result']],
    [['help', 'test', 'result']],
    [['test', 'help', 'result']],
  ])('%j prints no help, and the same two lines', async args => {
    const printed = await cli(args);
    expect(printed.exit).toBe(5);
    expect(printed.stdout).toBe('');
    expect(printed.stderr).toBe(`error: unknown command 'result'\n${POINTER.result}\n`);
  });

  it.each([
    [['test', 'failure', 'get', 'test_1'], 'failure'],
    [['test', 'artifact', 'get', 'res_1', '--out', 'evidence'], 'artifact'],
    [['test', 'result', 'test_1', '--history'], 'result'],
  ])('%j, as scripts ran it, gets the same line', async (args, name) => {
    const printed = await cli(args);
    expect(printed.exit).toBe(5);
    expect(printed.stderr).toBe(`error: unknown command '${name}'\n${POINTER[name]}\n`);
  });

  it.each([
    [['--output', 'json', 'test', 'result', 'test_1']],
    [['test', 'result', 'test_1', '--output', 'json']],
    [['--output', 'json', 'test', 'result', '--help']],
    [['--output', 'json', 'help', 'test', 'result']],
  ])('%j puts it in the JSON envelope as nextAction', async args => {
    const printed = await cli(args);
    expect(printed.exit).toBe(5);
    expect(printed.stdout).toBe('');
    expect(envelopeOf(printed.stderr)).toEqual({
      code: 'VALIDATION_ERROR',
      message: "error: unknown command 'result'",
      nextAction: POINTER.result,
      requestId: 'local',
    });
  });

  it.each([
    [['test', 'bogus'], 'bogus'],
    [['project', 'result'], 'result'],
    [['project', 'result', '--help'], 'result'],
    [['project', 'env', 'result'], 'result'],
  ])('%j, not a removed read command, gets no such line', async (args, name) => {
    const printed = await cli(args);
    expect(printed.exit).toBe(5);
    expect(printed.stderr).toBe(`error: unknown command '${name}'\n`);
    const json = await cli(['--output', 'json', ...args]);
    expect(envelopeOf(json.stderr).nextAction).toBe(
      'Run testsprite --help or testsprite <command> --help for usage.',
    );
  });
});

describe('a command removed in 0.17.0, outside the read commands', () => {
  const PLAN =
    'tests are written and changed by the project\'s agent: testsprite plan "<what to test>" (or testsprite reply in an open conversation), then testsprite apply';
  const WRITE =
    'tests are written by the project\'s agent: testsprite plan "<what to test>", then testsprite apply';
  const NO_CI =
    'there is no replacement; read deployment history with gh api repos/<owner>/<repo>/deployments and link the platform with its CLI';

  it.each([
    [
      ['test', 'create', '--project', 'p_1'],
      'create',
      `\`test create\` was removed in 0.17.0; ${WRITE}`,
    ],
    [['test', 'plan', 'generate'], 'plan', `\`test plan\` was removed in 0.17.0; ${PLAN}`],
    [['test', 'plan', 'put', 'test_1'], 'plan', `\`test plan\` was removed in 0.17.0; ${PLAN}`],
    [
      ['test', 'rerun', 'test_1', '--wait'],
      'rerun',
      '`test rerun` was removed in 0.17.0; use testsprite run <test-id...>, or testsprite run --project <project-id> for `--all`; `run` takes no `--status` or `--skip-terminal`',
    ],
    [
      ['test', 'open', 'test_1'],
      'open',
      '`test open` was removed in 0.17.0; open the Dashboard: link that testsprite run prints',
    ],
    [
      ['project', 'docs', 'upload', 'p_1', 'spec.md'],
      'docs',
      '`project docs` was removed in 0.17.0; attach the document to the request: testsprite plan --file <path>',
    ],
    [
      ['project', 'auto-auth', 'p_1', '--help'],
      'auto-auth',
      '`project auto-auth` was removed in 0.17.0; use testsprite project env update <project-id> <name> --auto-auth-file <json>; --auth switches it off',
    ],
    [['ci', 'doctor'], 'doctor', `\`ci doctor\` was removed in 0.17.0; ${NO_CI}`],
    [['help', 'ci', 'connect'], 'connect', `\`ci connect\` was removed in 0.17.0; ${NO_CI}`],
    [['init'], 'init', '`init` was removed in 0.17.0; use testsprite setup'],
    [['init', '--help'], 'init', '`init` was removed in 0.17.0; use testsprite setup'],
    [['help', 'init'], 'init', '`init` was removed in 0.17.0; use testsprite setup'],
    [
      ['auth', 'whoami'],
      'whoami',
      '`auth whoami` was removed in 0.17.0; use testsprite auth status',
    ],
  ])('%j exits 5 as an unknown command that says where it went', async (args, name, pointer) => {
    const printed = await cli(args);
    expect(printed.exit).toBe(5);
    expect(printed.stdout).toBe('');
    expect(printed.stderr).toBe(`error: unknown command '${name}'\n${pointer}\n`);

    const json = await cli(['--output', 'json', ...args]);
    expect(json.exit).toBe(5);
    expect(json.stdout).toBe('');
    expect(envelopeOf(json.stderr)).toEqual({
      code: 'VALIDATION_ERROR',
      message: `error: unknown command '${name}'`,
      nextAction: pointer,
      requestId: 'local',
    });
  });

  it('`test lint` says where it went in place of Commander\'s "Did you mean list?"', async () => {
    const pointer = `\`test lint\` was removed in 0.17.0; ${WRITE}`;
    const printed = await cli(['test', 'lint', 'plan.json']);
    expect(printed.exit).toBe(5);
    expect(printed.stderr).toBe(`error: unknown command 'lint'\n${pointer}\n`);
    const json = await cli(['--output', 'json', 'test', 'lint', 'plan.json']);
    expect(envelopeOf(json.stderr)).toEqual({
      code: 'VALIDATION_ERROR',
      message: "error: unknown command 'lint'",
      nextAction: pointer,
      requestId: 'local',
    });
  });

  it("an unknown command that was never removed keeps Commander's suggestion", async () => {
    const printed = await cli(['test', 'lst']);
    expect(printed.exit).toBe(5);
    expect(printed.stderr).toBe("error: unknown command 'lst'\n(Did you mean list?)\n");
  });

  it.each([
    [['setup', 'init'], undefined],
    [['project', 'init'], 'init'],
    [['ci', 'whoami'], 'whoami'],
  ])('%j gets no such line: the name was removed from another group', async (args, name) => {
    const json = await cli(['--output', 'json', ...args]);
    if (name !== undefined)
      expect(envelopeOf(json.stderr).message).toBe(`error: unknown command '${name}'`);
    expect(String(envelopeOf(json.stderr).nextAction)).not.toContain('was removed');
  });
});

describe('a removed option', () => {
  const ENV_CREATE =
    'set it on an environment: testsprite project env create <project-id> --name default --url <url>, which takes the sign-in flags';
  const ENV_UPDATE =
    'set it on an environment: testsprite project env update <project-id> <name> with the same flag';

  it.each([
    [
      ['run', '--all', '--project', 'p_1'],
      '--all',
      '`run` takes no `--all`; run a whole project with testsprite run --project <project-id>',
    ],
    [
      ['run', 'test_1', '--testlist', 'list_1', '--case', 'test_2'],
      '--case',
      '`run` takes no `--case`; name the tests: testsprite run <test-id...> --testlist <list-id>',
    ],
    [
      [
        'project',
        'create',
        '--type',
        'frontend',
        '--name',
        'shop',
        '--url',
        'https://shop.example',
      ],
      '--url',
      `\`project create --url\` was removed in 0.17.0; ${ENV_CREATE}`,
    ],
    [
      ['project', 'update', 'p_1', '--local', '3000'],
      '--local',
      `\`project update --local\` was removed in 0.17.0; ${ENV_UPDATE}`,
    ],
    [
      ['run', 'test_1', '--skip-terminal'],
      '--skip-terminal',
      '`run` takes no `--skip-terminal`; there is no replacement: name the tests to run, testsprite run <test-id...>',
    ],
    [
      ['run', '--project', 'p_1', '--status', 'failed'],
      '--status',
      '`run` takes no `--status`; name the tests: testsprite run <test-id...> with the caseKey of each result that testsprite result list --run <run-id> --status failed,blocked lists',
    ],
    [
      ['project', 'create', '--name', 'shop', '--description', 'a shop'],
      '--description',
      '`project create --description` was removed in 0.17.0; there is no replacement: a project has no description, so omit it',
    ],
    [
      ['test', 'list', '--project', 'p_1', '--status', 'failed'],
      '--status',
      '`test list --status` was removed in 0.17.0; a test case carries no result; read its results with testsprite result list --test <test-id> (--limit 1 for the latest)',
    ],
    [
      ['run', 'test_1', '--local', '3000'],
      '--local',
      '`run --local` was removed in 0.18.0; the address lives on the environment: testsprite project env create <project-id> --name local --url http://localhost:<port>, then testsprite run <test-id...> --env local (no flag when it is the default) opens the tunnel',
    ],
    [
      ['run', 'test_1', '--local-host', '127.0.0.1'],
      '--local-host',
      '`run --local-host` was removed in 0.18.0; the host lives on the environment: testsprite project env create <project-id> --name local --url http://127.0.0.1:<port> (or http://[::1]:<port>)',
    ],
    [
      ['run', 'test_1', '--target-url', 'http://localhost:3000'],
      '--target-url',
      "`run --target-url` was removed in 0.18.0; a run's address is its environment's: testsprite project env create <project-id> --name <name> --url <url>, then testsprite run <test-id...> --env <name>; for a pull request preview, testsprite ci run --env <name> --target-url <url>",
    ],
  ])('%j exits 5 as an unknown option that says where it went', async (args, option, pointer) => {
    const printed = await cli(args);
    expect(printed.exit).toBe(5);
    expect(printed.stdout).toBe('');
    expect(printed.stderr).toBe(`error: unknown option '${option}'\n${pointer}\n`);

    const json = await cli(['--output', 'json', ...args]);
    expect(json.exit).toBe(5);
    expect(envelopeOf(json.stderr)).toEqual({
      code: 'VALIDATION_ERROR',
      message: `error: unknown option '${option}'`,
      nextAction: pointer,
      requestId: 'local',
    });
  });

  it.each([
    [['project', 'create', '--name', 'shop', '--password=hunter2'], 'create', ENV_CREATE],
    [['project', 'create', '--name', 'shop', '--password', 'hunter2'], 'create', ENV_CREATE],
    [['project', 'update', 'p_1', '--password=hunter2'], 'update', ENV_UPDATE],
    [['project', 'update', 'p_1', '--password', 'hunter2'], 'update', ENV_UPDATE],
  ])('%j names the option and never prints its value', async (args, leaf, replacement) => {
    const pointer = `\`project ${leaf} --password\` was removed in 0.17.0; ${replacement}`;
    const printed = await cli(args);
    expect(printed.exit).toBe(5);
    expect(printed.stderr).toContain(`${pointer}\n`);
    expect(printed.stdout + printed.stderr).not.toContain('hunter2');

    const json = await cli(['--output', 'json', ...args]);
    expect(json.exit).toBe(5);
    expect(envelopeOf(json.stderr).nextAction).toBe(pointer);
    expect(json.stdout + json.stderr).not.toContain('hunter2');
  });

  it.each([
    ['--url=https://u:s3cret@host.example/x'],
    ['--url', 'https://u:s3cret@host.example/x'],
  ])('project create %j never prints the credentials in the URL', async (...url) => {
    const args = ['project', 'create', '--name', 'shop', '--type', 'frontend', ...url];
    const pointer = `\`project create --url\` was removed in 0.17.0; ${ENV_CREATE}`;
    const printed = await cli(args);
    expect(printed.exit).toBe(5);
    expect(printed.stderr).toContain(`${pointer}\n`);
    expect(printed.stdout + printed.stderr).not.toContain('s3cret');

    const json = await cli(['--output', 'json', ...args]);
    expect(json.exit).toBe(5);
    expect(envelopeOf(json.stderr).nextAction).toBe(pointer);
    expect(json.stdout + json.stderr).not.toContain('s3cret');
  });

  it.each([
    [['run', 'wait', 'run_1', '--all']],
    [['run', '--bogus']],
    [['project', 'env', 'create', 'p_1', '--case', 'x']],
    [['project', 'update', 'p_1', '--description', 'a shop']],
  ])('%j, not a removed option of that command, gets no such line', async args => {
    const json = await cli(['--output', 'json', ...args]);
    expect(json.exit).toBe(5);
    expect(envelopeOf(json.stderr).nextAction).toBe(
      'Run testsprite --help or testsprite <command> --help for usage.',
    );
  });
});
