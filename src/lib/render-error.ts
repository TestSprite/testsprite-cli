/**
 * Shared error rendering helpers for `src/index.ts`.
 *
 * Extracted so the output-interceptor rephrasing logic (P10) is
 * unit-testable without spawning a full CLI process.
 */
import type { TunnelInterruptDetach } from '../commands/test.js';
import type { InterruptError } from './errors.js';
import type { OutputMode } from './output.js';
import { isSecretKey, REDACTED } from './redact.js';
import { cancelCommand, waitCommand, type RunRef } from './run-render.js';
import { jsonForTerminal, terminalSafe, terminalSafeLine } from './terminal-text.js';

/** The JSON-mode stderr envelope for a signal detach (errors.md §8.1). */
export interface InterruptEnvelope {
  error: {
    code: 'INTERRUPTED';
    message: string;
    nextAction: string;
    requestId: 'local';
    details: Record<string, unknown>;
  };
}

/** An interrupted run wait, with the results it was still following (wire ids). */
type RunWaitInterrupt = InterruptError & { waitedRuns?: ReadonlyArray<RunRef> };

/**
 * Record on an interrupt that it cut a run wait short, and which results the
 * wait was still following. The envelope's hint is built from them, so it
 * names the same launches as the stderr line the command prints, and says what
 * cancelling stops where the command only joined a run.
 */
export function markRunWaitInterrupt(err: InterruptError, waitedRuns: ReadonlyArray<RunRef>): void {
  err.runWaitContext = true;
  (err as RunWaitInterrupt).waitedRuns = waitedRuns;
}

/**
 * Build the `INTERRUPTED` envelope from whatever the interrupted command
 * attached to the error. A tunnel run attaches `tunnelDetach`, which carries
 * its own `nextAction` so the envelope never contradicts the text line the
 * catch block already printed. Otherwise a run wait gets the run-detach story
 * (`run wait` / `run cancel`, naming the launches when they are known) and
 * any other request gets the generic check-state hint.
 */
export function buildInterruptEnvelope(err: InterruptError): InterruptEnvelope {
  const { tunnelDetach } = err as InterruptError & {
    tunnelDetach?: TunnelInterruptDetach;
  };
  const waitedRuns = (err as RunWaitInterrupt).waitedRuns ?? [];
  const wait = waitCommand(waitedRuns);
  const cancel = cancelCommand(waitedRuns);
  const nextAction =
    tunnelDetach?.nextAction ??
    (err.runWaitContext
      ? wait && cancel
        ? 'The server-side run keeps executing and billing. ' +
          `Re-attach with: ${wait}, or stop it with: ${cancel}.`
        : 'The server-side run (if any) keeps executing and billing. ' +
          'Re-attach with: testsprite run wait <run-id>, or stop it with: testsprite run cancel <run-id> ' +
          '(the partial JSON on stdout carries the runId when the backend reports one).'
      : 'The request was interrupted. Check the current state before retrying; ' +
        'a multi-item command may have processed some items.');
  const details: Record<string, unknown> = { signal: err.signal };
  if (tunnelDetach) {
    // Keep native execution and result IDs when the command knows them.
    Object.assign(details, {
      ...(tunnelDetach.runId ? { runId: tunnelDetach.runId } : {}),
      ...(tunnelDetach.resultId ? { resultId: tunnelDetach.resultId } : {}),
    });
    details.cancelOutcome = tunnelDetach.cancel;
  }
  return {
    error: { code: 'INTERRUPTED', message: err.message, nextAction, requestId: 'local', details },
  };
}

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
 * removedPointer: where a removed command or option went: a line after the
 *             message in text, the `nextAction` in JSON. It takes the place
 *             of Commander's "(Did you mean …?)" line, which names a
 *             similarly spelled command that is not the replacement.
 */
export function renderCommanderError(
  pendingMsg: string | null,
  fallbackMsg: string,
  mode: OutputMode,
  removedPointer?: string,
): string {
  const rawMsg = withoutSuggestion((pendingMsg ?? fallbackMsg).trim(), removedPointer);
  if (mode === 'json') {
    return (
      jsonForTerminal(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: rawMsg,
            nextAction:
              removedPointer ?? 'Run testsprite --help or testsprite <command> --help for usage.',
            requestId: 'local',
          },
        },
        2,
      ) + '\n'
    );
  }
  // Text mode: emit the buffered message as formatted by Commander (or
  // rephrased by rephraseUnknownOption), its lines kept and any control
  // character an argument carried removed. Synthesize when null. A removed
  // command's pointer follows on a line of its own.
  if (removedPointer === undefined) return terminalSafe(pendingMsg ?? `${rawMsg}\n`);
  return `${terminalSafe(rawMsg)}\n${removedPointer}\n`;
}

/**
 * The message without the suggestion line Commander ends it with, when a
 * removal pointer follows. Only a line that ends the message is dropped, so
 * the same text inside a quoted argument stays.
 */
function withoutSuggestion(message: string, removedPointer: string | undefined): string {
  return removedPointer === undefined
    ? message
    : message.replace(/\n\(Did you mean [^\n]*\?\)$/, '');
}

/**
 * Text-mode rendering for the `AMBIGUOUS_ORG` conflict (`details.candidates[]`
 * — an array of `{ projectId, orgId }` pairs the same testId resolved to,
 * across the caller's organizations). Renders one actionable `candidate:`
 * line per well-formed entry, plus a trailing hint to disambiguate with
 * `--project <id>`.
 *
 * Defensive by design: any entry missing `projectId`/`orgId` (or a
 * malformed/empty/absent `candidates` value) is silently skipped rather than
 * thrown — this is best-effort stderr decoration on top of an error that
 * already renders correctly via the generic envelope, so a future server
 * shape change must never crash the CLI's error path.
 */
export function renderAmbiguousOrgCandidates(candidates: unknown): string[] {
  if (!Array.isArray(candidates)) return [];
  const lines: string[] = [];
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const { projectId, orgId } = candidate as { projectId?: unknown; orgId?: unknown };
    if (typeof projectId !== 'string' || typeof orgId !== 'string') continue;
    lines.push(
      `  candidate: project ${terminalSafeLine(projectId)} (org ${terminalSafeLine(orgId)})`,
    );
  }
  if (lines.length === 0) return [];
  lines.push('  hint: re-run with --project <id> to disambiguate.');
  return lines;
}

/** Text-mode recovery handles for the account's tunnel binding limit. */
export function renderTunnelBindingLimitIds(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  const ids = details.filter((value): value is string => typeof value === 'string');
  if (ids.length === 0) return [];
  const lines = ids.slice(0, 20).map(id => `  tunnel: ${terminalSafeLine(id)}`);
  if (ids.length > 20) lines.push(`  … and ${ids.length - 20} more`);
  lines.push(
    '  hint: testsprite tunnel list · testsprite tunnel stop <client-id> · testsprite tunnel stop --all --confirm',
  );
  return lines;
}

/** A URL with a user or password before its host. */
const URL_WITH_CREDENTIALS_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i;

/**
 * Commander quotes the whole token in "unknown option '--password=hunter2'".
 * A flag this CLI no longer registers can still arrive with a secret from an
 * older script, so the value is hidden before the message is buffered. So is
 * a URL that carries credentials (`https://user:password@host`), whatever the
 * flag is called.
 *
 * The value runs to the quote Commander closes the token with, which is the
 * last `'` in the message: all Commander adds after it is its "(Did you mean
 * …?)" line, and an option name holds no quote. A quote or a line break
 * inside the value therefore never ends what is hidden.
 */
export function redactUnknownOptionValue(raw: string): string {
  const token = /unknown option '(--[^='\s]+)=/.exec(raw);
  if (token === null) return raw;
  const valueStart = token.index + token[0].length;
  const closingQuote = raw.lastIndexOf("'");
  if (closingQuote <= valueStart) return raw;
  if (
    !isSecretKey(token[1]!.slice(2)) &&
    !URL_WITH_CREDENTIALS_RE.test(raw.slice(valueStart, closingQuote))
  )
    return raw;
  return `${raw.slice(0, valueStart)}${REDACTED}${raw.slice(closingQuote)}`;
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
