import { describe, expect, it } from 'vitest';
import type { CompletionSpec } from './completion.js';
import { createCompletionCommand, detectShell, isShell, renderCompletion, normalizeShell } from './completion.js';

const SPEC: CompletionSpec = {
  program: 'testsprite',
  commands: ['setup', 'auth', 'test', 'doctor', 'completion', 'help'],
  subcommands: { auth: ['status', 'remove'], test: ['run', 'wait'] },
  globalFlags: ['--output', '--profile', '--help'],
};

describe('isShell / detectShell', () => {
  it('recognizes the supported shells', () => {
    expect(isShell('bash')).toBe(true);
    expect(isShell('zsh')).toBe(true);
    expect(isShell('fish')).toBe(true);
    expect(isShell('powershell')).toBe(true);
    expect(isShell('cmd')).toBe(false);
  });

  it('normalises the pwsh alias to powershell', () => {
    expect(normalizeShell('pwsh')).toBe('powershell');
    expect(normalizeShell('PowerShell.EXE')).toBe('powershell');
    expect(normalizeShell('bash')).toBe('bash');
    expect(normalizeShell('cmd')).toBeUndefined();
  });

  it('detects powershell from PSModulePath when $SHELL is unset', () => {
    // Windows leaves $SHELL unset, including inside PowerShell.
    expect(detectShell({ PSModulePath: 'C:\\Program Files\\WindowsPowerShell\\Modules' }))
      .toBe('powershell');
    // $SHELL wins when both are present.
    expect(detectShell({ SHELL: '/bin/bash', PSModulePath: 'x' })).toBe('bash');
    // Neither present.
    expect(detectShell({})).toBeUndefined();
  });

  it('detects the shell from a $SHELL path', () => {
    expect(detectShell({ SHELL: '/bin/bash' })).toBe('bash');
    expect(detectShell({ SHELL: '/usr/bin/zsh' })).toBe('zsh');
    expect(detectShell({ SHELL: '/usr/local/bin/fish' })).toBe('fish');
  });

  it('detects shells with Windows backslashes, .exe suffixes, and uppercase paths', () => {
    expect(detectShell({ SHELL: 'C:\\Program Files\\Git\\bin\\bash.exe' })).toBe('bash');
    expect(detectShell({ SHELL: 'C:\\tools\\zsh.exe' })).toBe('zsh');
    expect(detectShell({ SHELL: '/usr/bin/FISH.EXE' })).toBe('fish');
    expect(detectShell({ SHELL: 'C:/Program Files\\Git\\bin/bash.exe' })).toBe('bash');
  });

  it('returns undefined for an unknown or missing shell', () => {
    expect(detectShell({ SHELL: '/bin/sh' })).toBeUndefined();
    expect(detectShell({ SHELL: 'C:\\Windows\\System32\\cmd.exe' })).toBeUndefined();
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

describe('renderCompletion -- powershell', () => {
  const script = renderCompletion('powershell', SPEC);

  it('registers a native argument completer for the program', () => {
    expect(script).toContain(
      `Register-ArgumentCompleter -Native -CommandName '${SPEC.program}' -ScriptBlock {`,
    );
  });

  it('embeds commands, subcommands and global flags from the spec', () => {
    for (const command of SPEC.commands) expect(script).toContain(`'${command}'`);
    for (const [group, subs] of Object.entries(SPEC.subcommands)) {
      expect(script).toContain(`'${group}' = @(`);
      for (const sub of subs) expect(script).toContain(`'${sub}'`);
    }
    for (const flag of SPEC.globalFlags) expect(script).toContain(`'${flag}'`);
  });

  it('completes a subcommand only after its group, and flags once one is typed', () => {
    // The branch order in the script decides this, so assert the guards themselves.
    expect(script).toContain('$subcommands.ContainsKey($previous)');
    expect(script).toContain("$wordToComplete -like '-*'");
    expect(script).toContain('$subcommands.ContainsKey($first)');
  });

  it('filters candidates by the word being completed and returns CompletionResult', () => {
    expect(script).toContain('Where-Object { $_ -like "$wordToComplete*" }');
    expect(script).toContain('[System.Management.Automation.CompletionResult]::new(');
  });

  it('is emitted end to end by the command', async () => {
    const chunks: string[] = [];
    const cmd = createCompletionCommand(() => SPEC, {
      env: {},
      stdout: (line: string) => chunks.push(line),
    });
    await cmd.parseAsync(['pwsh'], { from: 'user' });
    expect(chunks.join('\n')).toContain('Register-ArgumentCompleter -Native');
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
    await expect(cmd.parseAsync(['cmd'], { from: 'user' })).rejects.toMatchObject({
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
