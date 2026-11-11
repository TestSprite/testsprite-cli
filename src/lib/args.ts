import type { Argument, Command } from 'commander';
import { localValidationError } from './errors.js';

/**
 * Returns the formatted argument label matching Commander's display convention:
 * `<name>` for required arguments, `[name]` for optional arguments, with `...`
 * appended for variadic arguments.
 */
export function formatArgumentName(arg: Argument): string {
  const name = arg.name() + (arg.variadic ? '...' : '');
  return arg.required ? `<${name}>` : `[${name}]`;
}

/**
 * Validates positional arguments on a Commander command before its action executes.
 * Rejects any empty string or whitespace-only positional argument (including variadics)
 * with exit 5 VALIDATION_ERROR.
 */
export function validatePositionalArgs(command: Command): void {
  const registeredArgs = command.registeredArguments;
  if (!registeredArgs || registeredArgs.length === 0) {
    return;
  }
  const processedArgs = command.processedArgs;
  if (!processedArgs || processedArgs.length === 0) {
    return;
  }

  for (let i = 0; i < registeredArgs.length; i++) {
    const argDef = registeredArgs[i];
    if (!argDef) {
      continue;
    }
    const val = processedArgs[i];

    if (val === undefined) {
      continue;
    }

    const argLabel = formatArgumentName(argDef);

    if (typeof val === 'string') {
      if (val.trim().length === 0) {
        throw localValidationError(
          argLabel,
          'cannot be empty or whitespace-only',
          undefined,
          'argument',
        );
      }
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string' && item.trim().length === 0) {
          throw localValidationError(
            argLabel,
            'cannot be empty or whitespace-only',
            undefined,
            'argument',
          );
        }
      }
    }
  }
}
