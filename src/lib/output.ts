import { localValidationError } from './errors.js';

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
  throw localValidationError('output', 'must be one of: json, text', ['json', 'text']);
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
    if (this.mode === 'json' || !textRenderer) {
      this.stdoutWrite(JSON.stringify(data, null, 2));
      return;
    }
    this.stdoutWrite(textRenderer(data));
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
          details: input.details ?? {},
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
