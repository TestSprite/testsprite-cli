import { localValidationError } from './errors.js';
import { redactDeep } from './redact.js';

export type OutputMode = 'json' | 'text';

/**
 * Help-text footer pointing at the global options surface so users
 * looking at any subcommand `--help` don't miss `--dry-run`, `--output`,
 * `--profile`, `--endpoint-url`, `--request-timeout`, `--debug`.
 */
export const GLOBAL_OPTS_HINT =
  '\nGlobal options (--dry-run, --output, --profile, --endpoint-url, --request-timeout, --verbose, --debug):' +
  '\n  testsprite --help';

export function isOutputMode(value: unknown): value is OutputMode {
  return value === 'json' || value === 'text';
}

/**
 * Row formats `--output` accepts on list commands only (issue #164). They are
 * not {@link OutputMode}s: every other command rejects them while resolving
 * its options, before any request is sent.
 */
export type ListFormat = 'csv' | 'ndjson';

/** The commands that accept a {@link ListFormat}, for help and error text. */
export const LIST_FORMAT_COMMANDS = 'project list, test list, test result --history';

export function isListFormat(value: unknown): value is ListFormat {
  return value === 'csv' || value === 'ndjson';
}

/**
 * Resolve a raw `--output` flag value to a concrete {@link OutputMode}.
 *
 * `undefined` (flag omitted) resolves to the default `'text'`. Any other
 * value that is not `'json'` or `'text'` throws a typed VALIDATION_ERROR
 * (exit 5) with an actionable message.
 *
 * The alternative — silently falling back to `'text'` — is a footgun for the
 * CLI's primary consumer (coding agents): a caller that asks for
 * `--output json` but mistypes it (`--output josn`) would otherwise receive a
 * human-readable text payload and fail to parse it as JSON, with no signal as
 * to why. Every command group routes its global-option resolution through this
 * helper so the validation is uniform.
 */
export function resolveOutputMode(raw: unknown): OutputMode {
  if (raw === undefined) return 'text';
  if (isOutputMode(raw)) return raw;
  if (isListFormat(raw)) {
    throw localValidationError(
      'output',
      `${raw} is only supported by list commands (${LIST_FORMAT_COMMANDS}); use json or text here`,
      ['json', 'text'],
    );
  }
  throw localValidationError('output', 'must be one of: json, text', ['json', 'text']);
}

/**
 * {@link resolveOutputMode} for a list command, which also accepts a
 * {@link ListFormat}. A row format resolves to `output: 'json'` so the
 * command's machine-output gates (no text-only hints or column checks) apply
 * unchanged; the command branches on `format` only where it prints.
 */
export function resolveListOutput(raw: unknown): { output: OutputMode; format?: ListFormat } {
  if (isListFormat(raw)) return { output: 'json', format: raw };
  if (raw === undefined || isOutputMode(raw)) return { output: resolveOutputMode(raw) };
  throw localValidationError('output', 'must be one of: json, text, csv, ndjson', [
    'json',
    'text',
    'csv',
    'ndjson',
  ]);
}

/**
 * CSV columns for a list row type, keyed by every field of `T` so a field
 * added to the wire type fails typecheck until it is given a column (`true`
 * copies the value, a function derives the cell) or left out (`false`, for a
 * nested shape one cell cannot hold). Headers are the field names, in key
 * order, so they always match the `--output json` / `ndjson` field names.
 */
export type CsvColumns<T> = { readonly [K in keyof T]-?: boolean | ((row: T) => unknown) };

/**
 * Cells starting with one of these are run as a formula when the file is
 * opened in Excel or Sheets, and test names / failure text are user-supplied.
 */
const CSV_FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * One CSV field: `null` / absent is empty, an array is comma-joined, and an
 * object is its JSON. A value starting with `=`, `+`, `-`, `@`, a tab or a CR
 * gets a leading `'` (the OWASP formula-injection guard, part of the
 * documented contract), then RFC 4180 quoting applies: a field with a comma,
 * double quote, CR or LF is wrapped in double quotes with `"` doubled.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (Array.isArray(value)) text = value.join(',');
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  if (CSV_FORMULA_TRIGGER.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 table: a header record, then one record per row, each ended by CRLF. */
export function renderCsv<T>(rows: readonly T[], columns: CsvColumns<T>): string {
  const fields = (Object.keys(columns) as Array<keyof T & string>).filter(
    key => columns[key] !== false,
  );
  const records = [fields.map(csvField).join(',')];
  for (const row of rows) {
    records.push(
      fields
        .map(key => {
          const column = columns[key];
          return csvField(typeof column === 'function' ? column(row) : row[key]);
        })
        .join(','),
    );
  }
  return records.map(record => `${record}\r\n`).join('');
}

/** One compact JSON object per line, no wrapping array; empty for no rows. */
export function renderNdjson(rows: readonly unknown[]): string {
  return rows.map(row => `${JSON.stringify(row)}\n`).join('');
}

/**
 * Input to {@link Output.error} — the same 5-key shape as the hand-built
 * envelopes in `index.ts`'s ApiError / InterruptError / RequestTimeoutError
 * catch branches (`{error:{code,message,nextAction,requestId,details}}`).
 * Only `code` and `message` are required; the rest default to the
 * client-local values (`''`, `'local'`, `{}`) so every `--output json` error
 * — regardless of which catch branch produced it — renders the identical
 * envelope shape.
 */
export interface ErrorEnvelopeInput {
  code: string;
  message: string;
  nextAction?: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

export interface OutputStreams {
  /**
   * Line-oriented stdout writer. Each call is one logical line; the
   * default (`console.log`) appends a newline. Use this for JSON
   * envelopes, headers, summaries, and any output where the framework
   * owns line termination.
   */
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /**
   * Raw byte-oriented stdout writer. Each call writes its argument
   * verbatim, no trailing newline. Use {@link Output.writeChunk} to
   * stream content where preserving the exact byte stream matters —
   * e.g. dumping presigned source code to stdout for `> file.ts`
   * piping.
   *
   * Returning a `Promise` is the contract for honoring backpressure:
   * the default implementation returns a promise that resolves when
   * `process.stdout.write` returns `true` synchronously, or when the
   * stream's `'drain'` event fires if the kernel buffer was full.
   * Callers (e.g. the streaming loop in `streamPresignedBody`) MUST
   * `await` `writeChunk` so the upstream reader pauses instead of
   * silently piling chunks into V8's heap. Tests that ignore
   * backpressure may pass a sync `(text) => void` impl — the
   * `void | Promise<void>` return type is intentionally loose so
   * trivial in-memory test sinks don't have to manufacture
   * Promises.
   */
  rawStdout?: (text: string) => void | Promise<void>;
}

export class Output {
  private readonly mode: OutputMode;
  private readonly stdoutWrite: (line: string) => void;
  private readonly stderrWrite: (line: string) => void;
  private readonly rawStdoutWrite: (text: string) => void | Promise<void>;

  constructor(mode: OutputMode = 'text', streams: OutputStreams = {}) {
    this.mode = mode;
    this.stdoutWrite =
      streams.stdout ??
      (line => {
        console.log(line);
      });
    this.stderrWrite =
      streams.stderr ??
      (line => {
        console.error(line);
      });
    this.rawStdoutWrite = streams.rawStdout ?? defaultRawStdout;
  }

  print(data: unknown, textRenderer?: (data: unknown) => string): void {
    // Success data is the caller's OWN content — generated test code, plans,
    // backend-test fixtures — and must round-trip byte-identical (`test code
    // get --output json` -> edit -> `test code put`), even when it
    // legitimately contains a literal `Authorization: Bearer …` header or a
    // `password` fixture key. Never redacted here, in either mode. Secret
    // redaction (see `redact.ts`) applies only at error and request-trace
    // boundaries — `Output.error` below, the ApiError envelope in
    // `index.ts`, and `--debug` tracing in `client-factory.ts` — never to a
    // success payload.
    if (this.mode === 'json' || !textRenderer) {
      this.stdoutWrite(JSON.stringify(data, null, 2));
      return;
    }
    this.stdoutWrite(textRenderer(data));
  }

  /**
   * Write list rows to stdout as CSV or NDJSON, verbatim (CSV records end in
   * CRLF, which the line writer would not preserve). Like `print`, success
   * data is never redacted.
   */
  async printRows<T>(
    format: ListFormat,
    rows: readonly T[],
    columns: CsvColumns<T>,
  ): Promise<void> {
    const text = format === 'csv' ? renderCsv(rows, columns) : renderNdjson(rows);
    if (text !== '') await this.rawStdoutWrite(text);
  }

  /**
   * Write a chunk of bytes to stdout verbatim. Awaits any
   * Promise the rawStdout writer returns so a slow downstream
   * consumer pauses the upstream reader instead of buffering chunks
   * in memory. See `OutputStreams.rawStdout` for the backpressure
   * contract.
   */
  async writeChunk(text: string): Promise<void> {
    await this.rawStdoutWrite(text);
  }

  /**
   * Render a terminal error. JSON mode always emits the SAME 5-key envelope
   * shape as the ApiError / InterruptError / RequestTimeoutError branches
   * hand-build in `index.ts`'s catch (`{error:{code,message,nextAction,
   * requestId,details}}`) — before this, the only two callers of
   * this method (the plain-CLIError and uncaught-exception catch branches)
   * fell through to a bare `{"error":"<message>"}` string, breaking the
   * envelope contract that machine consumers (`--output json` scripts/CI/
   * agents) rely on for every other error path.
   */
  error(input: ErrorEnvelopeInput): void {
    if (this.mode === 'json') {
      const envelope = {
        error: {
          code: input.code,
          message: input.message,
          nextAction: input.nextAction ?? '',
          requestId: input.requestId ?? 'local',
          // Defence in depth: `details` from a server envelope is already
          // redacted server-side and (for an ApiError) at construction — see
          // `errors.ts` — but this render boundary redacts again so no path
          // that builds an envelope by hand here can ever skip it.
          details: redactDeep(input.details ?? {}),
        },
      };
      this.stderrWrite(JSON.stringify(envelope, null, 2));
      return;
    }
    this.stderrWrite(`Error: ${input.message}`);
  }
}

/**
 * Default rawStdout writer. Honors stdout backpressure: when
 * `process.stdout.write` returns `false` the OS buffer is full, so
 * resolve only when `'drain'` fires. Without this an upstream stream
 * reader keeps pulling chunks into memory — the documented streaming
 * guarantee for `test code get` would silently degrade into "buffered
 * download piped to a slow consumer."
 */
function defaultRawStdout(text: string): void | Promise<void> {
  if (process.stdout.write(text)) return;
  return new Promise(resolve => {
    process.stdout.once('drain', () => resolve());
  });
}
