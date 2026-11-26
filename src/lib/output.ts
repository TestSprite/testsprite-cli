import { localValidationError } from './errors.js';
import { redactDeep } from './redact.js';
import { jsonForTerminal, terminalSafe, terminalSafeLine } from './terminal-text.js';

export type OutputMode = 'json' | 'text';

/**
 * Help-text footer pointing at the global options surface so users
 * looking at any subcommand `--help` don't miss `--dry-run`, `--output`,
 * `--profile`, `--request-timeout`, `--debug`.
 */
export const GLOBAL_OPTS_HINT =
  '\nGlobal options (--dry-run, --output, --profile, --request-timeout, --verbose, --debug):' +
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
}

export class Output {
  private readonly mode: OutputMode;
  private readonly stdoutWrite: (line: string) => void;
  private readonly stderrWrite: (line: string) => void;

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
  }

  print(data: unknown, textRenderer?: (data: unknown) => string): void {
    // Success data is the caller's OWN content — generated test code, plans,
    // backend-test fixtures — and JSON must round-trip it unchanged, even when it
    // legitimately contains a literal `Authorization: Bearer …` header or a
    // `password` fixture key. Never redacted here, in either mode. Secret
    // redaction (see `redact.ts`) applies only at error and request-trace
    // boundaries — `Output.error` below, the ApiError envelope in
    // `index.ts`, and `--debug` tracing in `client-factory.ts` — never to a
    // success payload.
    if (this.mode === 'json' || !textRenderer) {
      this.stdoutWrite(jsonForTerminal(data, 2));
      return;
    }
    // Every text renderer prints server values (titles, names, errors, URLs):
    // on a terminal they carry no escape sequence or control character.
    this.stdoutWrite(terminalSafe(textRenderer(data)));
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
      this.stderrWrite(jsonForTerminal(envelope, 2));
      return;
    }
    // A message may embed a server value: on a terminal it prints on one line
    // with no escape sequence. The JSON envelope above keeps it as it is.
    this.stderrWrite(`Error: ${terminalSafeLine(input.message)}`);
  }
}
