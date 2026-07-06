import { describe, expect, it } from 'vitest';
import type { CompletionSpec } from './completion.js';
import { createCompletionCommand, detectShell, isShell, renderCompletion } from './completion.js';

const SPEC: CompletionSpec = {
  program: 'testsprite',
  commands: ['setup', 'auth', 'test', 'doctor', 'completion', 'help'],
  subcommands: { auth: ['status', 'remove'], test: ['run', 'wait'] },
  globalFlags: ['--output', '--profile', '--help'],
};

describe('isShell / detectShell', () => {
  it('recognizes the three supported shells', () => {
    expect(isShell('bash')).toBe(true);
    expect(isShell('zsh')).toBe(true);
    expect(isShell('fish')).toBe(true);
    expect(isShell('powershell')).toBe(false);
  });

  it('detects the shell from a $SHELL path', () => {
    expect(detectShell({ SHELL: '/bin/bash' })).toBe('bash');
    expect(detectShell({ SHELL: '/usr/bin/zsh' })).toBe('zsh');
    expect(detectShell({ SHELL: '/usr/local/bin/fish' })).toBe('fish');
  });

  it('returns undefined for an unknown or missing shell', () => {
    expect(detectShell({ SHELL: '/bin/sh' })).toBeUndefined();
    expect(detectShell({})).toBeUndefined();
  });
});

describe('renderCompletion', () => {
  it('bash script wires a completion function and lists commands, subcommands, flags', () => {
    const script = renderCompletion('bash', SPEC);
    expect(script).toContain('complete -F _testsprite_completion testsprite');
    expect(script).toContain('setup');
    expect(script).toContain('auth) COMPREPLY');
    expect(script).toContain('status remove');
    expect(script).toContain('--output');
  });

  it('zsh script declares #compdef and per-group subcommands', () => {
    const script = renderCompletion('zsh', SPEC);
    expect(script.startsWith('#compdef testsprite')).toBe(true);
    expect(script).toContain('compdef _testsprite testsprite');
    expect(script).toContain('run wait');
  });

  it('fish script uses complete -c with subcommand conditions and flags', () => {
    const script = renderCompletion('fish', SPEC);
    expect(script).toContain('complete -c testsprite -f');
    expect(script).toContain('__fish_seen_subcommand_from auth');
    expect(script).toContain('-l output');
  });
});

describe('createCompletionCommand', () => {
  function run(args: string[], env: NodeJS.ProcessEnv): Promise<string[]> {
    const out: string[] = [];
    const cmd = createCompletionCommand(() => SPEC, { env, stdout: line => out.push(line) });
    return cmd.parseAsync(args, { from: 'user' }).then(() => out);
  }

  it('prints the requested shell script from an explicit argument', async () => {
    const out = await run(['bash'], {});
    expect(out.join('\n')).toContain('complete -F');
  });

  it('auto-detects the shell from $SHELL when no argument is given', async () => {
    const out = await run([], { SHELL: '/usr/bin/zsh' });
    expect(out.join('\n')).toContain('#compdef testsprite');
  });

  it('rejects an unsupported shell with VALIDATION_ERROR (exit 5)', async () => {
    const cmd = createCompletionCommand(() => SPEC, { env: {}, stdout: () => undefined });
    await expect(cmd.parseAsync(['powershell'], { from: 'user' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('errors when the shell cannot be detected and none is given', async () => {
    const cmd = createCompletionCommand(() => SPEC, { env: {}, stdout: () => undefined });
    await expect(cmd.parseAsync([], { from: 'user' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('is named "completion"', () => {
    expect(createCompletionCommand(() => SPEC).name()).toBe('completion');
  });
});
