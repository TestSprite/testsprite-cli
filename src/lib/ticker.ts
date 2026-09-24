/**
 * TTY-gated single-line stderr progress ticker for `test run --wait`
 * and `test wait`. On non-TTY (CI) the ticker is completely silent —
 * logs stay clean for shell-script consumers.
 *
 * Behavior:
 *  - Updates on every poll
 *  - Uses `\r` + ANSI clear-line to overwrite in place on TTY
 *  - On terminal, emits one final line + newline then prints the result
 *  - `--output json` disables the ticker (caller doesn't create one)
 *  - Respects the NO_COLOR env var (https://no-color.org/): when set,
 *    ANSI escape sequences are suppressed and updates are emitted as
 *    plain lines instead of in-place overwrites.
 *
 * Overhead: <2ms per update (no syscalls beyond a single write).
 *
 * Timestamps: each tick prefixes an ISO 8601 timestamp so engineers
 * can correlate spinner output with --debug logs (dogfood item 2).
 */

export interface Ticker {
  /** Update the in-place progress line. No-op on non-TTY. */
  update(line: string): void;
  /**
   * Print the final line (with a trailing newline so the prompt
   * doesn't run into the result block). No-op on non-TTY.
   */
  finalize(line?: string): void;
  /**
   * True only when `update()` redraws the SAME terminal line (TTY, ANSI
   * allowed). False on a non-TTY (updates are no-ops) and under NO_COLOR
   * (every update prints a new line). The one signal a between-polls
   * refresher may key on — re-deriving it from process globals elsewhere
   * is how the two decisions drift apart.
   */
  readonly redrawsInPlace: boolean;
}

/**
 * Returns true when NO_COLOR is present in the environment and is not
 * an empty string, per https://no-color.org/.
 */
export function isNoColor(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NO_COLOR;
  return typeof value === 'string' && value.length > 0;
}

const DEFAULT_TERMINAL_COLUMNS = 80;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const markPattern = /^\p{Mark}$/u;
const emojiPattern = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u;

/**
 * Return whether a Unicode code point normally occupies two terminal columns.
 *
 * @param codePoint - Unicode scalar value to classify.
 * @returns Whether the code point is full-width in a terminal.
 */
function isFullwidthCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1b000 && codePoint <= 0x1b001) ||
      (codePoint >= 0x1f200 && codePoint <= 0x1f251) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

/**
 * Measure one grapheme cluster in terminal display columns.
 *
 * @param grapheme - User-perceived character produced by the segmenter.
 * @returns The number of terminal columns occupied by the grapheme.
 */
function graphemeWidth(grapheme: string): number {
  if (emojiPattern.test(grapheme)) return 2;

  let width = 0;
  for (const character of grapheme) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0x200d ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
      (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      markPattern.test(character)
    ) {
      continue;
    }
    width += isFullwidthCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

/**
 * Measure a complete string in terminal display columns.
 *
 * @param text - Text to measure.
 * @returns The number of terminal columns occupied by the text.
 */
function terminalWidth(text: string): number {
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    width += graphemeWidth(segment);
  }
  return width;
}

/**
 * Keep a ticker frame inside the terminal's last safe column. Terminal width is
 * read for every frame so an in-progress ticker follows live resizes.
 */
function fitToTerminal(line: string): string {
  const reportedColumns = typeof process !== 'undefined' ? process.stderr.columns : undefined;
  const columns =
    typeof reportedColumns === 'number' && Number.isFinite(reportedColumns) && reportedColumns > 0
      ? Math.floor(reportedColumns)
      : DEFAULT_TERMINAL_COLUMNS;
  const maxWidth = Math.max(0, columns - 1);

  if (terminalWidth(line) <= maxWidth) return line;
  if (maxWidth === 0) return '';

  const contentWidth = maxWidth - 1;
  let fitted = '';
  let fittedWidth = 0;
  for (const { segment } of graphemeSegmenter.segment(line)) {
    const width = graphemeWidth(segment);
    if (fittedWidth + width > contentWidth) break;
    fitted += segment;
    fittedWidth += width;
  }
  return `${fitted}…`;
}

/**
 * Create a ticker bound to the given stderr writer. Respects
 * `isTTY` to silently no-op in CI environments.
 *
 * @param stderrWrite - single-line writer (appends \n)
 * @param isTTY - whether the terminal supports in-place updates.
 *   Defaults to `process.stderr.isTTY`. Pass a boolean in tests.
 * @param stderrRaw - optional raw writer (no \n appended); used for
 *   the carriage-return + clear-line trick. Defaults to
 *   `process.stderr.write.bind(process.stderr)`.
 * @param noColor - whether to suppress ANSI escape sequences.
 *   Defaults to checking `NO_COLOR` env var per https://no-color.org/.
 */
export function createTicker(
  stderrWrite: (line: string) => void,
  isTTY?: boolean,
  stderrRaw?: (text: string) => void,
  noColor?: boolean,
): Ticker {
  const tty = isTTY ?? (typeof process !== 'undefined' ? process.stderr.isTTY === true : false);
  const rawWrite =
    stderrRaw ??
    (typeof process !== 'undefined'
      ? (text: string) => process.stderr.write(text)
      : (_text: string) => undefined);
  const suppressAnsi = noColor ?? isNoColor();

  let lastLength = 0;

  if (!tty) {
    // Non-TTY: completely silent.
    return {
      redrawsInPlace: false,
      update: () => undefined,
      finalize: () => undefined,
    };
  }

  if (suppressAnsi) {
    // TTY but NO_COLOR: emit plain-text lines without ANSI escape sequences.
    return {
      redrawsInPlace: false,
      update(line: string): void {
        const stamped = fitToTerminal(`${new Date().toISOString()} ${line}`);
        stderrWrite(stamped);
        lastLength = stamped.length;
      },
      finalize(line?: string): void {
        if (line !== undefined) {
          const stamped = fitToTerminal(`${new Date().toISOString()} ${line}`);
          stderrWrite(stamped);
          lastLength = stamped.length;
        }
        void stderrWrite;
      },
    };
  }

  return {
    redrawsInPlace: true,
    update(line: string): void {
      // ANSI ESC[2K clears the entire line; \r moves to column 0.
      const stamped = fitToTerminal(`${new Date().toISOString()} ${line}`);
      rawWrite(`\x1b[2K\r${stamped}`);
      lastLength = stamped.length;
    },
    finalize(line?: string): void {
      if (line !== undefined) {
        const stamped = fitToTerminal(`${new Date().toISOString()} ${line}`);
        rawWrite(`\x1b[2K\r${stamped}`);
        lastLength = stamped.length;
      }
      if (lastLength > 0) {
        // Move to a fresh line so the result block doesn't run into the ticker.
        rawWrite('\n');
      }
      void stderrWrite; // reference to suppress unused warning
    },
  };
}
