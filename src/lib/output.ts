import { localValidationError } from './errors.js';

export type OutputMode = 'json' | 'text' | 'csv' | 'ndjson';

/**
 * Output modes accepted by the `--output` flag. `csv` and `ndjson` are only
 * meaningful for list-style commands (`project list`, `test list`,
 * `test result --history`) — every other command rejects them via
 * {@link Output.print} (see that method's doc comment).
 */
const OUTPUT_MODES: readonly OutputMode[] = ['json', 'text', 'csv', 'ndjson'];

/**
 * Help-text footer pointing at the global options surface so users
 * looking at any subcommand `--help` don't miss `--dry-run`, `--output`,
 * `--profile`, `--endpoint-url`, `--request-timeout`, `--debug`.
 */
export const GLOBAL_OPTS_HINT =
  '\nGlobal options (--dry-run, --output, --profile, --endpoint-url, --request-timeout, --verbose, --debug):' +
  '\n  testsprite --help';

export function isOutputMode(value: unknown): value is OutputMode {
  return (OUTPUT_MODES as readonly unknown[]).includes(value);
}

/**
 * Resolve a raw `--output` flag value to a concrete {@link OutputMode}.
 *
 * `undefined` (flag omitted) resolves to the default `'text'`. Any other
 * value that is not one of `'json' | 'text' | 'csv' | 'ndjson'` throws a
 * typed VALIDATION_ERROR (exit 5) with an actionable message.
 *
 * The alternative — silently falling back to `'text'` — is a footgun for the
 * CLI's primary consumer (coding agents): a caller that asks for
 * `--output json` but mistypes it (`--output josn`) would otherwise receive a
 * human-readable text payload and fail to parse it as JSON, with no signal as
 * to why. Every command group routes its global-option resolution through this
 * helper so the validation is uniform.
 *
 * `csv` and `ndjson` are accepted here (so `--output csv` on any command
 * parses) but are only actually rendered by list commands; every other
 * command rejects them at print time via {@link Output.print}.
 */
export function resolveOutputMode(raw: unknown): OutputMode {
  if (raw === undefined) return 'text';
  if (isOutputMode(raw)) return raw;
  throw localValidationError('output', 'must be one of: json, text, csv, ndjson', OUTPUT_MODES);
}

/**
 * One column of a CSV/NDJSON list rendering, derived straight from a
 * source-of-truth wire type (e.g. `CliProject`, `CliTest`,
 * `RunHistoryItem`) rather than the (possibly reordered/truncated) text
 * table columns used for `--output text`.
 */
export interface ListColumn<T> {
  /** CSV header cell / JSON-ish field name for this column. */
  header: string;
  /** Extract the raw value for this column from one row. */
  value: (row: T) => unknown;
}

/**
 * Escape one CSV field per RFC 4180 §2:
 *   - `null`/`undefined` render as the empty string.
 *   - Fields containing a comma, double quote, or CR/LF are wrapped in
 *     double quotes, with embedded double quotes doubled (`"` → `""`).
 */
export function csvEscapeField(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  const s = String(raw);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Render rows as an RFC 4180 CSV table: a header row followed by one row
 * per item, fields joined with `,` and records joined with the RFC-mandated
 * `\r\n` line terminator (no trailing terminator on the final record).
 */
export function renderCsv<T>(rows: readonly T[], columns: readonly ListColumn<T>[]): string {
  const header = columns.map(column => csvEscapeField(column.header)).join(',');
  const body = rows.map(row => columns.map(column => csvEscapeField(column.value(row))).join(','));
  return [header, ...body].join('\r\n');
}

/**
 * Render rows as newline-delimited JSON: one compact `JSON.stringify`'d
 * object per line, no wrapping array. Returns `''` (no lines) for an empty
 * `rows` array — callers should skip the stdout write entirely in that case
 * so no stray blank line is emitted.
 */
export function renderNdjson<T>(rows: readonly T[]): string {
  return rows.map(row => JSON.stringify(row)).join('\n');
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

  /**
   * Print a single JSON/text envelope. `csv`/`ndjson` are rejected here with
   * a VALIDATION_ERROR (exit 5): those two modes only make sense for a table
   * of rows, and every non-list command (get/create/update/delete/...)
   * renders its single-object result through this method — centralizing the
   * rejection here means every such command rejects `--output csv|ndjson`
   * without each of them needing its own guard. List commands (`project
   * list`, `test list`, `test result --history`) branch on `csv`/`ndjson`
   * *before* reaching this method and call {@link Output.printCsv} /
   * {@link Output.printNdjson} instead.
   */
  print(data: unknown, textRenderer?: (data: unknown) => string): void {
    if (this.mode === 'csv' || this.mode === 'ndjson') {
      throw localValidationError(
        'output',
        `'${this.mode}' is only supported by list commands (project list, test list, ` +
          'test result --history); use --output json or --output text here',
      );
    }
    if (this.mode === 'json' || !textRenderer) {
      this.stdoutWrite(JSON.stringify(data, null, 2));
      return;
    }
    this.stdoutWrite(textRenderer(data));
  }

  /**
   * Render `rows` as an RFC 4180 CSV table (header + one row per item) and
   * write it to stdout as a single chunk. No-op guard against being called
   * with a non-`csv` mode is intentionally omitted — callers already branch
   * on `opts.output === 'csv'` before reaching here.
   */
  printCsv<T>(rows: readonly T[], columns: readonly ListColumn<T>[]): void {
    this.stdoutWrite(renderCsv(rows, columns));
  }

  /**
   * Render `rows` as newline-delimited JSON and write it to stdout as a
   * single chunk. Writes nothing when `rows` is empty, so an empty list
   * never emits a stray blank line on stdout.
   */
  printNdjson<T>(rows: readonly T[]): void {
    const body = renderNdjson(rows);
    if (body.length > 0) this.stdoutWrite(body);
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

  error(message: string): void {
    if (this.mode === 'json') {
      this.stderrWrite(JSON.stringify({ error: message }, null, 2));
      return;
    }
    this.stderrWrite(`Error: ${message}`);
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
