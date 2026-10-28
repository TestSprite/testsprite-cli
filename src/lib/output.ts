import { localValidationError } from './errors.js';
import { redactDeep } from './redact.js';

export type OutputMode = 'json' | 'text';

/**
 * Help-text footer pointing at the global options surface so users
 * looking at any subcommand `--help` don't miss `--dry-run`, `--output`,
 * `--profile`, `--endpoint-url`, `--request-timeout`, `--debug`.
 */
export const GLOBAL_OPTS_HINT =
  '\nGlobal options (--dry-run, --output, --fields, --profile, --endpoint-url, --request-timeout, --verbose, --debug):' +
  '\n  testsprite --help';

/**
 * `--fields` projection for `--output json`, set once per process from the
 * global flag (see `index.ts`) and applied by every {@link Output.print} — the
 * single path all success JSON takes — so no command has to thread it.
 * Each entry is one dot-separated path, split into segments.
 */
let jsonFieldPaths: readonly (readonly string[])[] | undefined;
const warnedUnmatchedFields = new Set<string>();

/**
 * Parse a raw `--fields` value (`id,name,latestResult.status`) into paths.
 * Whitespace around commas is ignored and duplicates are dropped; an empty
 * list or an empty path segment (`a..b`, `.a`) is a VALIDATION_ERROR.
 */
export function parseFieldsFlag(raw: string): string[] {
  const paths = [
    ...new Set(
      raw
        .split(',')
        .map(path => path.trim())
        .filter(Boolean),
    ),
  ];
  if (paths.length === 0) {
    throw localValidationError('fields', 'must list at least one field (e.g. --fields id,name)');
  }
  const malformed = paths.find(path => path.split('.').some(segment => segment === ''));
  if (malformed !== undefined) {
    throw localValidationError(
      'fields',
      `"${malformed}" is not a valid field path — use dot-separated keys like latestResult.status`,
    );
  }
  return paths;
}

/** Set (or clear, with `undefined`) the process-wide `--fields` projection. */
export function setJsonFields(paths: readonly string[] | undefined): void {
  jsonFieldPaths = paths?.map(path => path.split('.'));
  warnedUnmatchedFields.clear();
}

export function resetJsonFieldsForTesting(): void {
  setJsonFields(undefined);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A requested `--fields` path that matched nothing, with the keys found where it stopped. */
export interface UnmatchedField {
  path: string;
  /** Dot path of the object where the lookup stopped (`''` for the top level). */
  at: string;
  /** Keys present at `at`, to suggest the intended spelling; empty if no object was reached. */
  available: string[];
}

/**
 * Keep only the requested paths of `data`. An array met at any level (the
 * top-level value, or `items` in `items.id`) is mapped element by element, so
 * `--fields items.id,nextToken` trims every list item and keeps the cursor.
 * Returns the projected value plus the requested paths that matched nothing.
 */
export function projectFields(
  data: unknown,
  paths: readonly (readonly string[])[],
): { value: unknown; unmatched: UnmatchedField[] } {
  type Wanted = { index: number; rest: readonly string[] };
  // A path counts as matched once its last key is found anywhere — or when it
  // runs into an empty list or a null, neither of which can show it is wrong.
  const matched = new Set<number>();
  // For a path not (yet) matched: the deepest object it reached, and its keys.
  const stoppedAt = new Map<number, { depth: number; keys: Set<string> }>();
  const pick = (value: unknown, wanted: readonly Wanted[]): unknown => {
    if (value === null) {
      for (const { index } of wanted) matched.add(index);
      return null;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) for (const { index } of wanted) matched.add(index);
      // An item with nothing to keep (e.g. a string in a list of objects)
      // becomes null so the others keep their positions. A list where no item
      // has anything to keep is omitted rather than printed as `[null, null]`.
      const items = value.map(item => pick(item, wanted));
      if (value.length > 0 && items.every(item => item === undefined)) return undefined;
      return items.map(item => (item === undefined ? null : item));
    }
    if (!isPlainObject(value)) return undefined;
    const whole = new Set<string>();
    const nested = new Map<string, Wanted[]>();
    for (const { index, rest } of wanted) {
      const [key, ...tail] = rest;
      if (key === undefined) continue;
      if (!Object.hasOwn(value, key)) {
        const depth = (paths[index]?.length ?? 0) - rest.length;
        const stop = stoppedAt.get(index);
        if (stop === undefined || depth > stop.depth) {
          stoppedAt.set(index, { depth, keys: new Set(Object.keys(value)) });
        } else if (depth === stop.depth) {
          for (const name of Object.keys(value)) stop.keys.add(name);
        }
        continue;
      }
      if (tail.length === 0) {
        matched.add(index);
        whole.add(key);
      } else {
        nested.set(key, [...(nested.get(key) ?? []), { index, rest: tail }]);
      }
    }
    // Entries + Object.fromEntries rather than `result[key] = …`, so a key such
    // as `__proto__` stays an ordinary property instead of setting a prototype.
    const kept: [string, unknown][] = [];
    for (const [key, item] of Object.entries(value)) {
      if (whole.has(key)) {
        kept.push([key, item]);
        // The whole value is kept, but walk any child paths too so they are
        // reported only when they really are missing.
        if (nested.has(key)) pick(item, nested.get(key)!);
      } else if (nested.has(key)) {
        const inner = pick(item, nested.get(key)!);
        if (inner !== undefined) kept.push([key, inner]);
      }
    }
    return Object.fromEntries(kept);
  };
  const value = pick(
    data,
    paths.map((rest, index) => ({ index, rest })),
  );
  const unmatched = paths.flatMap((path, index): UnmatchedField[] => {
    if (matched.has(index)) return [];
    const stop = stoppedAt.get(index);
    return [
      {
        path: path.join('.'),
        at: stop === undefined ? '' : path.slice(0, stop.depth).join('.'),
        available: stop === undefined ? [] : [...stop.keys],
      },
    ];
  });
  // A list at the top level stays a list even when no item had anything to keep.
  const projected = value === undefined && Array.isArray(data) ? [] : value;
  return { value: projected === undefined ? data : projected, unmatched };
}

const MAX_HINTED_KEYS = 20;

/** ` (available: id, name)` / ` (available under items: id, name)`, or `''` with nothing to suggest. */
function availableHint(field: UnmatchedField): string {
  if (field.available.length === 0) return '';
  const shown = field.available.slice(0, MAX_HINTED_KEYS).join(', ');
  const more = field.available.length > MAX_HINTED_KEYS ? ', ...' : '';
  const where = field.at === '' ? '' : ` under ${field.at}`;
  return ` (available${where}: ${shown}${more})`;
}

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
    // Success data is the caller's OWN content — generated test code, plans,
    // backend-test fixtures — and must round-trip byte-identical (`test code
    // get --output json` -> edit -> `test code put`), even when it
    // legitimately contains a literal `Authorization: Bearer …` header or a
    // `password` fixture key. Never redacted here, in either mode. Secret
    // redaction (see `redact.ts`) applies only at error and request-trace
    // boundaries — `Output.error` below, the ApiError envelope in
    // `index.ts`, and `--debug` tracing in `client-factory.ts` — never to a
    // success payload.
    if (this.mode === 'json' && jsonFieldPaths !== undefined) {
      // `--fields` is an explicit request to trim the payload, so it is the
      // one exception to the byte-identical round-trip above.
      const { value, unmatched } = projectFields(data, jsonFieldPaths);
      for (const field of unmatched) {
        if (warnedUnmatchedFields.has(field.path)) continue;
        warnedUnmatchedFields.add(field.path);
        this.stderrWrite(
          `[warn] --fields "${field.path}" matched nothing in this output${availableHint(field)}`,
        );
      }
      this.stdoutWrite(JSON.stringify(value, null, 2));
      return;
    }
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
