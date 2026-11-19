/** Native run/result references and human-readable command hints. */
import { terminalSafeLine } from './terminal-text.js';
export interface RunRef {
  runId?: string | null;
  resultId?: string | null;
  joined?: boolean;
}
const idOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
const inLine = terminalSafeLine;

export function resultCount(n: number): string {
  return `${n} result${n === 1 ? '' : 's'}`;
}

/** A count of runs in prose: "1 run", "2 runs". */
export function runCount(n: number): string {
  return `${n} run${n === 1 ? '' : 's'}`;
}

/** The launches these results belong to, each once, in first-seen order. */
export function launchIds(refs: ReadonlyArray<RunRef>): string[] {
  const ids: string[] = [];
  for (const ref of refs) {
    const launchId = idOf(ref.runId);
    if (launchId !== undefined && !ids.includes(launchId)) ids.push(launchId);
  }
  return ids;
}

/**
 * The one launch all of these results belong to. `undefined` when they span
 * several launches, or when the backend named no launch for one of them: a
 * launch id is never stated for results it may not cover. An entry that never
 * got a result id (a test that was not dispatched) does not count.
 */
export function sharedLaunchId(refs: ReadonlyArray<RunRef>): string | undefined {
  const dispatched = refs.filter(ref => idOf(ref.resultId) !== undefined);
  const ids = launchIds(dispatched);
  return ids.length === 1 && dispatched.every(ref => idOf(ref.runId) !== undefined)
    ? ids[0]
    : undefined;
}

/**
 * The command that waits for these results' launches, or `undefined` when no
 * launch is known: `run wait` takes a launch id, so a result id is never
 * offered in its place.
 */
export function waitCommand(refs: ReadonlyArray<RunRef>): string | undefined {
  const ids = launchIds(refs).map(inLine);
  return ids.length > 0 ? `testsprite run wait ${ids.join(' ')}` : undefined;
}

/**
 * The read that shows what was cancelled in these results' launches, one
 * `result list --run <run-id> --status cancelled` per launch: after a closing
 * tunnel has cancelled them, `run cancel` would stop everything else still
 * running in the launch.
 */
export function cancelledResultsCommand(refs: ReadonlyArray<RunRef>): string | undefined {
  const ids = launchIds(refs).map(inLine);
  return ids.length > 0
    ? ids.map(id => `testsprite result list --run ${id} --status cancelled`).join('; ')
    : undefined;
}

/**
 * What `run cancel` does to a launch: it takes the launch id, so it stops
 * every test in that run, not one of them.
 */
export const CANCEL_STOPS_WHOLE_RUN = 'stops every test in that run';

/** The same, said of several launches at once. */
const CANCEL_STOPS_WHOLE_RUNS = 'stops every test in those runs';

/**
 * The command that cancels these results' launches; see {@link waitCommand}.
 * A launch this invocation started is its own to cancel, so the command stands
 * alone. For a launch it only joined, the command is followed by what
 * cancelling it stops.
 */
export function cancelCommand(refs: ReadonlyArray<RunRef>): string | undefined {
  const ids = launchIds(refs).map(inLine);
  if (ids.length === 0) return undefined;
  const joined = launchIds(refs.filter(ref => ref.joined === true)).map(inLine);
  const command = `testsprite run cancel ${ids.join(' ')}`;
  if (joined.length === 0) return command;
  const scope = joined.length === 1 ? CANCEL_STOPS_WHOLE_RUN : CANCEL_STOPS_WHOLE_RUNS;
  return (
    `${command} (cancelling ${joined.join(' or ')} ${scope}, ` +
    'which this command joined and did not start)'
  );
}

/**
 * What is true of work a wait let go of: it keeps executing, and billing, on
 * the server. One result is named by its launch (`Run <id>`), or as
 * `Result <id>` when the backend named no launch. Several are counted as
 * tests, since they may all belong to one run, and refs that name only a
 * launch (a run whose results were never listed) as runs.
 */
export function stillRunningAndBillingSubject(refs: ReadonlyArray<RunRef>): string {
  if (refs.length === 1) {
    return `${runLabel(refs[0]!)} is still executing on the server and will keep running (and billing) until it finishes.`;
  }
  const tests = refs.filter(ref => idOf(ref.resultId) !== undefined).length;
  const runs = refs.length - tests;
  const counted = [
    ...(tests > 0 ? [`${tests} test${tests === 1 ? '' : 's'}`] : []),
    ...(runs > 0 ? [runCount(runs)] : []),
  ].join(' and ');
  return `${counted} are still executing on the server and will keep running (and billing) until they finish.`;
}

/**
 * The two indented lines under a detach message: how to re-attach and how to
 * cancel. Both commands take the launch, so they name each launch once; when
 * the backend named no launch there is nothing to offer and no line is added.
 */
export function reattachLines(refs: ReadonlyArray<RunRef>): string {
  const wait = waitCommand(refs);
  const cancel = cancelCommand(refs);
  return (
    (wait ? `\n  Re-attach with: ${wait}` : '') + (cancel ? `\n  Cancel with:    ${cancel}` : '')
  );
}

/** The same two commands as one trailing sentence, or nothing when no launch is known. */
export function reattachSentence(refs: ReadonlyArray<RunRef>): string {
  const wait = waitCommand(refs);
  const cancel = cancelCommand(refs);
  return wait && cancel ? ` Re-attach with: ${wait}, or cancel with: ${cancel}` : '';
}

/**
 * What a wait says when Ctrl-C ends it: only the local wait stopped, the work
 * keeps executing and billing, and these are the commands to re-attach to it
 * or to really stop it.
 */
export function interruptDetachMessage(
  interrupt: { signal: string },
  refs: ReadonlyArray<RunRef>,
): string {
  return (
    `Interrupted (${interrupt.signal}). ${stillRunningAndBillingSubject(refs)}` +
    reattachLines(refs)
  );
}

/** One piece of work to look up later, by whatever ids are known (wire names). */
export interface LaterLookup {
  testId?: string | null;
  /** The result id. */
  resultId?: string | null;
  /**
   * Look the result itself up rather than the test's results. Set for a
   * result the CLI cancelled: result lists leave cancelled results out, so
   * the test's list would show an older verdict as if it were this one.
   */
  byResult?: boolean;
}

/** How many lookups a hint lists before it counts the rest. */
export const CHECK_LATER_LIMIT = 10;

/**
 * What a wait that gave up can still point at when no launch is known (so
 * neither `run wait` nor `run cancel` can be offered): one line per piece of
 * work, the first ten, then a count of the rest. A test is looked up by its
 * results; with no test id, or for a result named with `byResult`, the result
 * is looked up itself. No line carries a placeholder. Empty when nothing can
 * be looked up.
 */
export function checkLaterHint(lookups: ReadonlyArray<LaterLookup>): string {
  const commands: string[] = [];
  for (const lookup of lookups) {
    const testId = idOf(lookup.testId);
    const resultId = idOf(lookup.resultId);
    const command =
      testId !== undefined && lookup.byResult !== true
        ? `testsprite result list --test ${inLine(testId)}`
        : resultId !== undefined
          ? `testsprite result get ${inLine(resultId)}`
          : undefined;
    if (command !== undefined && !commands.includes(command)) commands.push(command);
  }
  const lines = commands
    .slice(0, CHECK_LATER_LIMIT)
    .map(command => `Check the verdict later with: ${command}`);
  if (commands.length > CHECK_LATER_LIMIT) {
    lines.push(`… ${commands.length - CHECK_LATER_LIMIT} more`);
  }
  return lines.join('\n');
}

/**
 * How prose names one result's work: `Run <launch id>` when the launch is
 * known, otherwise `Result <result id>`. A result id is never called a run.
 * With neither id it is just `The run`.
 */
export function runLabel(ref: RunRef, letterCase: 'upper' | 'lower' = 'upper'): string {
  const launchId = idOf(ref.runId);
  const resultId = idOf(ref.resultId);
  const label =
    launchId !== undefined
      ? `Run ${inLine(launchId)}`
      : resultId !== undefined
        ? `Result ${inLine(resultId)}`
        : 'The run';
  return letterCase === 'lower' ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

/**
 * The id of one result's work as a `name: value` note: `resultId: <launch id>`
 * when the launch is known, otherwise `resultId: <result id>`.
 */
export function runIdNote(ref: RunRef): string {
  const launchId = idOf(ref.runId);
  const resultId = idOf(ref.resultId);
  return launchId !== undefined
    ? `runId: ${inLine(launchId)}`
    : `resultId: ${resultId !== undefined ? inLine(resultId) : '(unknown)'}`;
}

export const OLDER_CLI_RESULT_ID_HINT =
  'a result id printed by an older CLI is not one. Look a result up with: testsprite result get <result-id>';
