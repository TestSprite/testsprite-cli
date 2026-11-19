import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = join(resolve(__dirname, '..'), 'dist', 'index.js');

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<SpawnResult> {
  return new Promise(resolveRun => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      env: {
        ...process.env,
        TESTSPRITE_NO_SKILL_WARNING: '1',
        TESTSPRITE_NO_UPDATE_NOTIFIER: '1',
        TESTSPRITE_NO_TELEMETRY: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', exitCode => resolveRun({ exitCode, stdout, stderr }));
  });
}

describe('unknown command help handling', () => {
  it('exits 5 without printing root help', async () => {
    const result = await runCli(['config', '--help']);
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("error: unknown command 'config'");
    expect(result.stderr).not.toContain('Usage: testsprite');
  });

  it('emits a JSON VALIDATION_ERROR envelope', async () => {
    const result = await runCli(['config', '--help', '--output', 'json']);
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe('');
    const parsed = JSON.parse(result.stderr) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
    expect(parsed.error.message).toContain("unknown command 'config'");
  });

  it('rejects the equivalent help subcommand form', async () => {
    const result = await runCli(['help', 'config']);
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("error: unknown command 'config'");
    expect(result.stderr).not.toContain('Usage: testsprite');
  });
});

describe('an unknown subcommand of a group, masked by help', () => {
  // `test result` was removed; a group's help must not stand in for it.
  it.each([
    [['test', 'result', '--help'], 'result'],
    [['test', 'result', '-h'], 'result'],
    [['help', 'test', 'result'], 'result'],
    [['test', 'help', 'result'], 'result'],
    [['project', 'env', 'bogus', '--help'], 'bogus'],
    [['help', 'project', 'env', 'bogus'], 'bogus'],
    [['project', 'bogus', 'env', '--help'], 'bogus'],
    // Help before the unknown name, at any level.
    [['test', '--help', 'result'], 'result'],
    [['test', '-h', 'result'], 'result'],
    [['project', '--help', 'bogus', 'env'], 'bogus'],
    [['--help', 'config'], 'config'],
  ])('%j exits 5 before any help is printed', async (args, unknown) => {
    const result = await runCli(args);
    expect(result.exitCode, result.stderr).toBe(5);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`error: unknown command '${unknown}'`);
    expect(result.stderr).not.toContain('Usage: testsprite');
  });

  it('emits a JSON VALIDATION_ERROR envelope', async () => {
    const result = await runCli(['--output', 'json', 'test', 'result', '--help']);
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe('');
    const parsed = JSON.parse(result.stderr) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
    expect(parsed.error.message).toContain("unknown command 'result'");
  });

  it.each([
    [['test', '--help'], 'Usage: testsprite test [options] [command]'],
    [['help', 'test'], 'Usage: testsprite test [options] [command]'],
    [['test', 'help'], 'Usage: testsprite test [options] [command]'],
    [['run', '--help'], 'Usage: testsprite run [options]'],
    [['run', 'help', 'wait'], 'Usage: testsprite run wait [options]'],
    [['run', 'wait', '--help'], 'Usage: testsprite run wait [options]'],
    [['run', 'cancel', '--help'], 'Usage: testsprite run cancel [options]'],
    [['run', 'some-test-id', '--help'], 'Usage: testsprite run [options]'],
    [['run', '--help', 'some-test-id'], 'Usage: testsprite run [options]'],
    [['run', 'some-test-id', 'another-test-id', '--help'], 'Usage: testsprite run [options]'],
    [['test', 'list', '--help'], 'Usage: testsprite test list [options]'],
    [['test', 'get', '--help'], 'Usage: testsprite test get [options]'],
    [['testlist', 'list', '--help'], 'Usage: testsprite testlist list [options]'],
    [['testlist', 'get', '--help'], 'Usage: testsprite testlist get [options]'],
    [['testlist', 'create', '--help'], 'Usage: testsprite testlist create [options]'],
    [['testlist', 'update', '--help'], 'Usage: testsprite testlist update [options]'],
    [['testlist', 'delete', '--help'], 'Usage: testsprite testlist delete [options]'],
    [['testlist', 'add', '--help'], 'Usage: testsprite testlist add [options]'],
    [['testlist', 'remove', '--help'], 'Usage: testsprite testlist remove [options]'],
    [['ci', 'run', '--help'], 'Usage: testsprite ci run [options]'],
    [['result', 'list', '--help'], 'Usage: testsprite result list [options]'],
    [['result', 'get', '--help'], 'Usage: testsprite result get [options]'],
    [['project', 'env', '--help'], 'Usage: testsprite project env [options] [command]'],
    [['--output', 'json', 'test', '--help'], 'Usage: testsprite test [options] [command]'],
  ])('a registered path %j still prints its help and exits 0', async (args, usage) => {
    const result = await runCli(args);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(usage);
  });

  it('`help run wait` retains native Commander help behavior', async () => {
    // Commander's root `help` reads one name, so this prints root run help.
    const result = await runCli(['help', 'run', 'wait']);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('unknown command');
    expect(result.stdout).toContain('Usage: testsprite run');
  });
});

it.each([
  ['text', 'wait'],
  ['json', 'wait'],
  ['text', 'cancel'],
  ['json', 'cancel'],
])('rejects a lifecycle concurrency option in %s output for %s', async (output, child) => {
  const result = await runCli([
    '--dry-run',
    '--output',
    output,
    'run',
    child,
    'run-a',
    '--max-concurrency',
    '2',
  ]);
  expect(result.exitCode).toBe(5);
  expect(result.stdout).toBe('');
  const message = output === 'json' ? JSON.parse(result.stderr).error.message : result.stderr;
  expect(message).toContain("unknown option '--max-concurrency'");
});

describe('hybrid root run help', () => {
  it.each([
    ['run', 'help', 'unknown'],
    ['run', 'help', 'unknown', '--help'],
  ])('rejects an unknown explicit help path %j without launch help', async (...args) => {
    const result = await runCli(args);
    expect(result.exitCode, result.stderr).toBe(5);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("unknown command 'unknown'");
    expect(result.stderr).not.toContain('Usage: testsprite');
  });

  it('advertises the root selectors and lifecycle children without retired selectors', async () => {
    const result = await runCli(['run', '--help']);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('--project');
    expect(result.stdout).toContain('--testlist');
    expect(result.stdout).toContain('wait [options] <run-id...>');
    expect(result.stdout).toContain('cancel <run-id...>');
    expect(result.stdout).not.toMatch(/--all(?:[ ,=]|$)/m);
    expect(result.stdout).not.toMatch(/--case(?:[ ,=]|$)/m);
  });

  it.each([
    ['test', ['run', 'wait', 'cancel']],
    ['testlist', ['run']],
  ] as const)('removes retired registrations from %s help', async (group, retired) => {
    const result = await runCli([group, '--help']);
    expect(result.exitCode, result.stderr).toBe(0);
    for (const command of retired) {
      expect(result.stdout).not.toMatch(new RegExp(`^  ${command}(?: |$)`, 'm'));
    }
  });
});
