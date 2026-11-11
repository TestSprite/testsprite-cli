import { Command, Argument } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { formatArgumentName, validatePositionalArgs } from './args.js';
import { createProjectCommand } from '../commands/project.js';
import { createTestCommand } from '../commands/test.js';

describe('formatArgumentName', () => {
  it('formats required positional argument as <name>', () => {
    const arg = new Argument('<project-id>');
    expect(formatArgumentName(arg)).toBe('<project-id>');
  });

  it('formats optional positional argument as [name]', () => {
    const arg = new Argument('[environment]');
    expect(formatArgumentName(arg)).toBe('[environment]');
  });

  it('formats required variadic argument as <name...>', () => {
    const arg = new Argument('<run-id...>');
    expect(formatArgumentName(arg)).toBe('<run-id...>');
  });

  it('formats optional variadic argument as [name...]', () => {
    const arg = new Argument('[test-ids...]');
    expect(formatArgumentName(arg)).toBe('[test-ids...]');
  });
});

describe('validatePositionalArgs with throwaway Commander program', () => {
  function makeProgram(actionFn = vi.fn()) {
    const program = new Command();
    program.exitOverride();
    program.hook('preAction', (_thisCmd, actionCmd) => {
      validatePositionalArgs(actionCmd);
    });

    program.command('test-req <id>').action(actionFn);

    program.command('test-opt [opt]').action(actionFn);

    program.command('test-var <first> [rest...]').action(actionFn);

    return { program, actionFn };
  }

  it('passes when valid positional arguments are provided', async () => {
    const { program, actionFn } = makeProgram();
    await program.parseAsync(['node', 'test', 'test-req', 'valid-id']);
    expect(actionFn).toHaveBeenCalledWith('valid-id', expect.anything(), expect.anything());
  });

  it('rejects empty string required positional with VALIDATION_ERROR (exit 5)', async () => {
    const { program, actionFn } = makeProgram();
    await expect(program.parseAsync(['node', 'test', 'test-req', ''])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      nextAction: 'Argument `<id>` is invalid: cannot be empty or whitespace-only.',
      details: {
        field: '<id>',
        reason: 'cannot be empty or whitespace-only',
      },
    });
    expect(actionFn).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only required positional with VALIDATION_ERROR (exit 5)', async () => {
    const { program, actionFn } = makeProgram();
    await expect(program.parseAsync(['node', 'test', 'test-req', '   \t  '])).rejects.toMatchObject(
      {
        code: 'VALIDATION_ERROR',
        exitCode: 5,
        nextAction: 'Argument `<id>` is invalid: cannot be empty or whitespace-only.',
      },
    );
    expect(actionFn).not.toHaveBeenCalled();
  });

  it('passes when optional positional is omitted', async () => {
    const { program, actionFn } = makeProgram();
    await program.parseAsync(['node', 'test', 'test-opt']);
    expect(actionFn).toHaveBeenCalled();
  });

  it('rejects empty string optional positional when passed explicitly', async () => {
    const { program, actionFn } = makeProgram();
    await expect(program.parseAsync(['node', 'test', 'test-opt', ''])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      nextAction: 'Argument `[opt]` is invalid: cannot be empty or whitespace-only.',
    });
    expect(actionFn).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only optional positional when passed explicitly', async () => {
    const { program, actionFn } = makeProgram();
    await expect(program.parseAsync(['node', 'test', 'test-opt', '   '])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      nextAction: 'Argument `[opt]` is invalid: cannot be empty or whitespace-only.',
    });
    expect(actionFn).not.toHaveBeenCalled();
  });

  it('rejects empty or whitespace elements in variadic positional arguments', async () => {
    const { program, actionFn } = makeProgram();
    await expect(
      program.parseAsync(['node', 'test', 'test-var', 'ok-first', 'valid-item', '   ']),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      nextAction: 'Argument `[rest...]` is invalid: cannot be empty or whitespace-only.',
    });
    expect(actionFn).not.toHaveBeenCalled();
  });
});

describe('command validation via parseAsync with real commands', () => {
  function makeCliProgram(cmd: Command) {
    const program = new Command();
    program.option('--dry-run', 'dry run mode');
    program.hook('preAction', (_thisCmd, actionCmd) => {
      validatePositionalArgs(actionCmd);
    });
    program.addCommand(cmd);

    function applyExitOverride(c: Command): void {
      c.exitOverride();
      for (const sub of c.commands) {
        applyExitOverride(sub);
      }
    }
    applyExitOverride(program);
    return program;
  }

  it('rejects project get with whitespace project id', async () => {
    const program = makeCliProgram(createProjectCommand());

    await expect(
      program.parseAsync(['node', 'testsprite', 'project', 'get', '   ']),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      nextAction: 'Argument `<project-id>` is invalid: cannot be empty or whitespace-only.',
      details: {
        field: '<project-id>',
        reason: 'cannot be empty or whitespace-only',
      },
    });
  });

  it('rejects test get with empty test id under --dry-run', async () => {
    const program = makeCliProgram(createTestCommand());

    await expect(
      program.parseAsync(['node', 'testsprite', 'test', 'get', '', '--dry-run']),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      exitCode: 5,
      nextAction: 'Argument `<test-id>` is invalid: cannot be empty or whitespace-only.',
    });
  });
});
