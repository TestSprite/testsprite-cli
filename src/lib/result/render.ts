import { terminalSafe, terminalSafeLine } from '../terminal-text.js';
import { renderTextTable, type TextTableColumn } from '../text-table.js';
import { RESULT_FILE, type WrittenEvidence } from './evidence.js';
import {
  isResultRunning,
  type ResultDetail,
  type ResultLine,
  type ResultList,
  type ResultSignIn,
  type ResultStep,
} from './types.js';

/**
 * Server text in a cell: safe for the terminal, and on one line, since a title
 * the server sent across lines would break one line per result.
 */
const cell = (value: string | null): string => terminalSafeLine(value ?? '') || '-';

/**
 * A server value with something to print in it, else null: the server sends
 * `''` as well as null for a value a result does not have (a passing test's
 * error, cause and fix), and a value that is only whitespace or escape
 * sequences prints nothing either.
 */
const present = (value: string | null | undefined): string | null =>
  value === null || value === undefined || terminalSafeLine(value) === '' ? null : value;

function statusCell({
  testStatus,
  processStatus,
}: Pick<ResultLine, 'testStatus' | 'processStatus'>): string {
  if (isResultRunning(testStatus) && processStatus?.toLowerCase() === 'idle') return 'QUEUED';
  return cell(testStatus);
}

const LIST_COLUMNS: readonly TextTableColumn<ResultLine>[] = [
  { header: 'CREATED', width: 0, render: line => cell(line.created) },
  { header: 'STATUS', width: 0, render: statusCell },
  { header: 'RESULT ID', width: 0, render: line => cell(line.resultId) },
  { header: 'RUN ID', width: 0, render: line => cell(line.runId) },
  { header: 'ENV', width: 0, render: line => cell(line.environmentName) },
  { header: 'TITLE', width: 0, render: line => cell(line.title) },
];

/**
 * One line per result, newest first, under a header: both ids are opaque, so
 * the header is what tells the result id from the run id.
 */
export function renderResultList(list: ResultList): string {
  if (list.results.length === 0) return 'No results.';
  return renderTextTable(list.results, LIST_COLUMNS);
}

/** Wide enough for the longest label, `processStatus:`, and two spaces. */
const LABEL_WIDTH = 16;

/**
 * `label: value`, the value made safe for the terminal and the lines after its
 * first indented under it: for prose, which may run over lines. A value that
 * is one line by nature goes through {@link lineField}.
 */
function field(label: string, value: string): string {
  const [first, ...rest] = terminalSafe(value).replace(/\s+$/, '').split('\n');
  const indent = ' '.repeat(LABEL_WIDTH);
  return [`${`${label}:`.padEnd(LABEL_WIDTH)}${first}`, ...rest.map(line => indent + line)].join(
    '\n',
  );
}

/**
 * `label: value` for a value that is one line by nature (an id, a status, a
 * URL): a line break the server put in it becomes a space, as in a cell.
 */
const lineField = (label: string, value: string): string =>
  `${`${label}:`.padEnd(LABEL_WIDTH)}${terminalSafeLine(value)}`;

/** A step as `<stepIndex>  <description>`; the description is the one the server redacted. */
const stepLine = (step: ResultStep): string =>
  `${present(step.stepIndex) ?? '-'}  ${present(step.description) ?? '(no description)'}`;

/** How many lines of a backend test's traceback, and of its output, the text prints. */
const LOG_LINES = 20;

/** How many characters of those lines it prints, so one long line cannot flood the terminal. */
const LOG_CHARS = 2000;

/** Characters, not UTF-16 code units: a surrogate pair is one character. */
const charCount = (text: string): number =>
  text.length - (text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0);

/**
 * `text` cut to its first or last {@link LOG_CHARS} characters, and how many
 * it lost. No character is split: each is at most two code units, so the
 * kept ones lie within twice as many code units from the kept end.
 */
function cutChars(text: string, keep: 'first' | 'last'): { kept: string; cut: number } {
  const cut = charCount(text) - LOG_CHARS;
  if (cut <= 0) return { kept: text, cut: 0 };
  const kept =
    keep === 'first'
      ? Array.from(text.slice(0, 2 * LOG_CHARS)).slice(0, LOG_CHARS)
      : Array.from(text.slice(-2 * LOG_CHARS)).slice(-LOG_CHARS);
  return { kept: kept.join(''), cut };
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * A backend test's traceback or output under its label, cut to
 * {@link LOG_LINES} lines and then to {@link LOG_CHARS} characters: a
 * traceback keeps its `last` ones, where the exception is, and an output its
 * `first`. What was cut is named where the cut is, above a traceback and below
 * an output. Lines are counted in the text made safe for the terminal, where a
 * carriage return is a line break. Blank lines around the value are dropped,
 * and a value with nothing else prints nothing.
 */
function logBlock(
  label: string,
  value: string | null | undefined,
  keep: 'first' | 'last',
): string[] {
  const text = terminalSafe(value ?? '')
    .replace(/^\s*\n/, '')
    .trimEnd();
  if (text === '') return [];
  const lines = text.split('\n');
  const shown = keep === 'first' ? lines.slice(0, LOG_LINES) : lines.slice(-LOG_LINES);
  const cutLines = lines.length - shown.length;
  const { kept, cut: cutCharacters } = cutChars(shown.join('\n'), keep);
  const keptLines = kept.split('\n');
  // A cut that falls on a line break leaves an empty line at the cut end.
  if (cutCharacters > 0 && keep === 'first' && keptLines.at(-1) === '') keptLines.pop();
  if (cutCharacters > 0 && keep === 'last' && keptLines[0] === '') keptLines.shift();
  const body = keptLines.map(line => `  ${line}`);
  if (cutLines === 0 && cutCharacters === 0) return [`${label}:`, ...body];
  const where = keep === 'first' ? 'more' : 'earlier';
  const what =
    cutLines === 0
      ? plural(cutCharacters, `${where} character`)
      : plural(cutLines, `${where} line`) +
        (cutCharacters === 0 ? '' : ` and ${plural(cutCharacters, 'character')}`);
  const pointer = `  (${what}: --output json, or --out <dir> for ${RESULT_FILE})`;
  return keep === 'first' ? [`${label}:`, ...body, pointer] : [`${label}:`, pointer, ...body];
}

function signInLines(signIn: ResultSignIn): string[] {
  const failed = signIn.steps.find(step => step.status === 'failed');
  const error = present(signIn.error);
  return [
    lineField('signIn', present(signIn.status) ?? '-'),
    ...(error !== null ? [field('  error', error)] : []),
    lineField('  stepCount', String(signIn.stepCount ?? signIn.steps.length)),
    ...(failed !== undefined ? [field('  failedStep', stepLine(failed))] : []),
  ];
}

/**
 * One screen about one result: what happened, why, and the failed step; for a
 * backend test, the end of its traceback and the start of its output. Each
 * step, and both of those in full, are in the JSON (and the evidence
 * download), not here.
 */
export function renderResultDetail(detail: ResultDetail): string {
  const failedSteps = detail.steps.filter(step => step.status === 'failed').length;
  const optional = (label: string, value: string | null): string[] => {
    const shown = present(value);
    return shown !== null ? [field(label, shown)] : [];
  };
  const optionalLine = (label: string, value: string | null): string[] => {
    const shown = present(value);
    return shown !== null ? [lineField(label, shown)] : [];
  };
  return [
    `${statusCell(detail)}  ${cell(detail.title)}`,
    lineField('resultId', detail.resultId),
    lineField('runId', present(detail.runId) ?? '-'),
    lineField('caseKey', present(detail.caseKey) ?? '-'),
    // While a result runs, its process status says where it is.
    ...(isResultRunning(detail.testStatus)
      ? optionalLine('processStatus', detail.processStatus)
      : []),
    ...optional('error', detail.error),
    // Some failures carry their reason only here (an integration flow that
    // could not start, say); others repeat the error, which prints once.
    ...(present(detail.processErrorMessage) !== present(detail.error)
      ? optional('processError', detail.processErrorMessage)
      : []),
    ...optional('cause', detail.cause),
    ...optional('fix', detail.fix),
    ...optional('blockedReason', detail.blockedReason),
    ...(detail.failedStep !== null
      ? [
          field('failedStep', stepLine(detail.failedStep)),
          ...optionalLine('  screenshot', detail.failedStep.screenshotSignedUrl),
        ]
      : []),
    field('steps', `${detail.steps.length} (${failedSteps} failed)`),
    ...optionalLine('videoUrl', detail.videoUrl),
    ...(detail.signIn !== null ? signInLines(detail.signIn) : []),
    ...logBlock('trace', detail.trace, 'last'),
    ...logBlock('apiOutput', detail.apiOutput, 'first'),
  ].join('\n');
}

const evidenceFiles = (count: number): string => `${count} evidence file${count === 1 ? '' : 's'}`;

/**
 * What a download wrote to its directory, one file a line, then each file it
 * could not download with the reason. `preview` is a dry run's plan. It counts
 * evidence files, result.json apart, as the error for a partial download does.
 */
export function renderEvidence(evidence: WrittenEvidence, preview = false): string {
  const { dir, written, failed } = evidence;
  const got = written.filter(file => file !== RESULT_FILE).length;
  const count =
    failed.length === 0 ? evidenceFiles(got) : `${got} of ${evidenceFiles(got + failed.length)}`;
  return [
    `${preview ? 'Would write' : 'Wrote'} ${count}, and ${RESULT_FILE}, to ${dir}`,
    ...written.map(file => `  ${terminalSafeLine(file)}`),
    ...(failed.length > 0
      ? [
          'Not downloaded:',
          ...failed.map(
            ({ file, reason, kept }) =>
              `  ${terminalSafeLine(file)}  ${terminalSafeLine(reason)}` +
              (kept ? ' (the earlier copy is kept)' : ''),
          ),
        ]
      : []),
  ].join('\n');
}
