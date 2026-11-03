/**
 * Shared error rendering helpers for `src/index.ts`.
 *
 * Extracted so the output-interceptor rephrasing logic (P10) is
 * unit-testable without spawning a full CLI process.
 */
import type { PlanInterruptDetach, TunnelInterruptDetach } from '../commands/test.js';
import type { InterruptError } from './errors.js';
import type { OutputMode } from './output.js';

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

/**
 * Build the `INTERRUPTED` envelope from whatever the interrupted command
 * attached to the error. A tunnel run attaches `tunnelDetach` and
 * `test plan generate` attaches `planDetach`; each carries its own
 * `nextAction` so the envelope never contradicts the text line the catch
 * block already printed. Otherwise a run wait gets the run-detach story
 * (`test wait`) and any other request gets the generic check-state hint.
 */
export function buildInterruptEnvelope(err: InterruptError): InterruptEnvelope {
  const { tunnelDetach, planDetach } = err as InterruptError & {
    tunnelDetach?: TunnelInterruptDetach;
    planDetach?: PlanInterruptDetach;
  };
  const nextAction =
    tunnelDetach?.nextAction ??
    planDetach?.nextAction ??
    (err.runWaitContext
      ? 'The server-side run (if any) keeps executing and billing. ' +
        'Re-attach with: testsprite test wait <runId>, or stop it with: testsprite test cancel <runId> ' +
        '(runId is in the partial JSON on stdout).'
      : 'The request was interrupted. Check the current state before retrying; ' +
        'a multi-item command may have processed some items.');
  const details: Record<string, unknown> = { signal: err.signal };
  if (tunnelDetach) {
    details.runId = tunnelDetach.runId;
    details.cancelOutcome = tunnelDetach.cancel;
  } else if (planDetach) {
    details.projectId = planDetach.projectId;
    details.stagesRemaining = planDetach.stagesRemaining;
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
    lines.push(`  candidate: project ${projectId} (org ${orgId})`);
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
  const lines = ids.slice(0, 20).map(id => `  tunnel: ${id}`);
  if (ids.length > 20) lines.push(`  … and ${ids.length - 20} more`);
  lines.push(
    '  hint: testsprite tunnel list · testsprite tunnel stop <client-id> · testsprite tunnel stop --all --confirm',
  );
  return lines;
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
