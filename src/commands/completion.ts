/**
 * `testsprite completion [bash|zsh|fish]` — emit a shell completion script.
 *
 * The command names, per-group subcommands, and global flags are NOT hardcoded:
 * `index.ts` builds a {@link CompletionSpec} by walking the fully-assembled
 * Commander program and passes it in, so the generated script can never drift
 * from the real command tree. `renderCompletion` is a pure function of the spec,
 * which keeps it unit-testable without a live program.
 *
 * Usage:
 *   bash:  eval "$(testsprite completion bash)"          (add to ~/.bashrc)
 *   zsh:   testsprite completion zsh > ~/.zsh/_testsprite (on your fpath)
 *   fish:  testsprite completion fish | source           (add to config.fish)
 */

import { Command } from 'commander';
import { localValidationError } from '../lib/errors.js';

export const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type Shell = (typeof SUPPORTED_SHELLS)[number];

export interface CompletionSpec {
  /** Binary name, e.g. "testsprite". */
  program: string;
  /** Top-level command names. */
  commands: string[];
  /** command name -> its subcommand names (only groups that have subcommands). */
  subcommands: Record<string, string[]>;
  /** Global long option flags (e.g. "--output"). */
  globalFlags: string[];
}

export interface CompletionDeps {
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
}

export function isShell(value: string): value is Shell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(value);
}

/** Best-effort shell detection from `$SHELL` (e.g. "/bin/zsh" -> "zsh"). */
export function detectShell(env: NodeJS.ProcessEnv): Shell | undefined {
  const shellPath = env.SHELL ?? '';
  const base = shellPath.slice(shellPath.lastIndexOf('/') + 1);
  return isShell(base) ? base : undefined;
}

export function renderCompletion(shell: Shell, spec: CompletionSpec): string {
  switch (shell) {
    case 'bash':
      return renderBash(spec);
    case 'zsh':
      return renderZsh(spec);
    case 'fish':
      return renderFish(spec);
  }
}

function renderBash(spec: CompletionSpec): string {
  const fn = `_${spec.program}_completion`;
  const lines = [
    `# ${spec.program} bash completion. Enable with:  eval "$(${spec.program} completion bash)"`,
    `${fn}() {`,
    '  local cur prev',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    `  local commands="${spec.commands.join(' ')}"`,
    `  local global_flags="${spec.globalFlags.join(' ')}"`,
    '  case "$prev" in',
    ...Object.entries(spec.subcommands).map(
      ([group, subs]) =>
        `    ${group}) COMPREPLY=( $(compgen -W "${subs.join(' ')}" -- "$cur") ); return;;`,
    ),
    '  esac',
    '  if [[ "$cur" == -* ]]; then',
    '    COMPREPLY=( $(compgen -W "$global_flags" -- "$cur") ); return',
    '  fi',
    '  COMPREPLY=( $(compgen -W "$commands" -- "$cur") )',
    '}',
    `complete -F ${fn} ${spec.program}`,
  ];
  return lines.join('\n');
}

function renderZsh(spec: CompletionSpec): string {
  const fn = `_${spec.program}`;
  const lines = [
    `#compdef ${spec.program}`,
    `# ${spec.program} zsh completion. Enable with:  ${spec.program} completion zsh > "$fpath[1]/_${spec.program}"`,
    `${fn}() {`,
    '  local -a commands',
    `  commands=(${spec.commands.join(' ')})`,
    '  if (( CURRENT == 2 )); then',
    "    _describe 'command' commands",
    '    return',
    '  fi',
    '  case "${words[2]}" in',
    ...Object.entries(spec.subcommands).map(
      ([group, subs]) =>
        `    ${group}) local -a subs; subs=(${subs.join(' ')}); _describe 'subcommand' subs;;`,
    ),
    '  esac',
    '}',
    `compdef ${fn} ${spec.program}`,
  ];
  return lines.join('\n');
}

function renderFish(spec: CompletionSpec): string {
  const lines = [
    `# ${spec.program} fish completion. Enable with:  ${spec.program} completion fish | source`,
    `complete -c ${spec.program} -f`,
    ...spec.commands.map(
      command => `complete -c ${spec.program} -n '__fish_use_subcommand' -a '${command}'`,
    ),
    ...Object.entries(spec.subcommands).flatMap(([group, subs]) =>
      subs.map(
        sub => `complete -c ${spec.program} -n '__fish_seen_subcommand_from ${group}' -a '${sub}'`,
      ),
    ),
    ...spec.globalFlags.map(flag => `complete -c ${spec.program} -l ${flag.replace(/^--/, '')}`),
  ];
  return lines.join('\n');
}

export function createCompletionCommand(
  getSpec: () => CompletionSpec,
  deps: CompletionDeps = {},
): Command {
  return new Command('completion')
    .description('Print a shell completion script (bash|zsh|fish)')
    .argument(
      '[shell]',
      'Shell to generate for (bash|zsh|fish); auto-detected from $SHELL when omitted',
    )
    .addHelpText(
      'after',
      '\nExamples:\n' +
        '  eval "$(testsprite completion bash)"       # bash, current session\n' +
        '  testsprite completion zsh > ~/.zsh/_testsprite\n' +
        '  testsprite completion fish | source        # fish, current session',
    )
    .action((shellArg: string | undefined, _cmdOpts: unknown) => {
      const env = deps.env ?? process.env;
      const shell = shellArg ?? detectShell(env);
      if (shell === undefined) {
        throw localValidationError(
          'shell',
          `could not detect the shell from $SHELL; pass one explicitly (${SUPPORTED_SHELLS.join(', ')})`,
          [...SUPPORTED_SHELLS],
        );
      }
      if (!isShell(shell)) {
        throw localValidationError(
          'shell',
          `unsupported shell "${shell}"; use one of: ${SUPPORTED_SHELLS.join(', ')}`,
          [...SUPPORTED_SHELLS],
        );
      }
      const write = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
      write(renderCompletion(shell, getSpec()));
    });
}
