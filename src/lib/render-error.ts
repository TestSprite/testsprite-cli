/**
 * Shared error rendering helpers for `src/index.ts`.
 *
 * Extracted so the output-interceptor rephrasing logic (P10) is
 * unit-testable without spawning a full CLI process.
 */
import type { OutputMode } from './output.js';

/**
 * Global flags that belong before the subcommand, not after it.
 *
 * `boolean` flags (--dry-run, --debug, --verbose) take no value; emit
 * example without a placeholder. `value` flags (--output, --profile,
 * --endpoint-url, --request-timeout) take a single argument; emit example
 * with `<value>`.
 */
const GLOBAL_FLAG_ARITY: Record<string, 'boolean' | 'value'> = {
  'dry-run': 'boolean',
  output: 'value',
  profile: 'value',
  'endpoint-url': 'value',
  'request-timeout': 'value',
  debug: 'boolean',
  verbose: 'boolean',
};

/**
 * Rephrase Commander's "unknown option '--foo'" error when `--foo` is
 * a known global flag that was placed after the subcommand.
 *
 * Returns the rephrased string when the pattern matches, or `null` when
 * it is an ordinary unknown flag that should fall through to the original
 * Commander output.
 */
/**
 * Format a Commander parse-error message for the requested output mode.
 * Returns the string to write to stderr; the caller writes it.
 *
 * pendingMsg: message captured by configureOutput.outputError before the
 *             CommanderError was thrown (may already be rephrased by
 *             rephraseUnknownOption). Null only when Commander threw without
 *             first calling outputError (should not happen for parse errors).
 * fallbackMsg: err.message from CommanderError, used when pendingMsg is null.
 * mode: the output mode resolved from --output (or argv fallback).
 */
export function renderCommanderError(
  pendingMsg: string | null,
  fallbackMsg: string,
  mode: OutputMode,
): string {
  const rawMsg = (pendingMsg ?? fallbackMsg).trim();
  if (mode === 'json') {
    return (
      JSON.stringify(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: rawMsg,
            nextAction: 'Run testsprite --help or testsprite <command> --help for usage.',
            requestId: 'local',
          },
        },
        null,
        2,
      ) + '\n'
    );
  }
  // Text mode: emit the buffered message as-is (already formatted by Commander
  // or rephrased by rephraseUnknownOption). Synthesize when null.
  return pendingMsg ?? `${rawMsg}\n`;
}

export function rephraseUnknownOption(raw: string): string | null {
  // Commander emits: "error: unknown option '--foo'"
  const match = /unknown option\s+'--([^']+)'/.exec(raw);
  if (!match) return null;
  const name = match[1]!;
  const arity = GLOBAL_FLAG_ARITY[name];
  if (arity === undefined) return null;
  const example =
    arity === 'value'
      ? `testsprite --${name} <value> <subcommand> ...`
      : `testsprite --${name} <subcommand> ...`;
  return (
    `error: '--${name}' is a global flag; place it before the subcommand.\n` + `Example: ${example}`
  );
}
