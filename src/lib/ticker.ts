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
}

/**
 * Returns true when NO_COLOR is present in the environment and is not
 * an empty string, per https://no-color.org/.
 */
export function isNoColor(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NO_COLOR;
  return typeof value === 'string' && value.length > 0;
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
      update: () => undefined,
      finalize: () => undefined,
    };
  }

  if (suppressAnsi) {
    // TTY but NO_COLOR: emit plain-text lines without ANSI escape sequences.
    return {
      update(line: string): void {
        const stamped = `${new Date().toISOString()} ${line}`;
        stderrWrite(stamped);
        lastLength = stamped.length;
      },
      finalize(line?: string): void {
        if (line !== undefined) {
          const stamped = `${new Date().toISOString()} ${line}`;
          stderrWrite(stamped);
          lastLength = stamped.length;
        }
        void stderrWrite;
      },
    };
  }

  return {
    update(line: string): void {
      // ANSI ESC[2K clears the entire line; \r moves to column 0.
      const stamped = `${new Date().toISOString()} ${line}`;
      rawWrite(`\x1b[2K\r${stamped}`);
      lastLength = stamped.length;
    },
    finalize(line?: string): void {
      if (line !== undefined) {
        const stamped = `${new Date().toISOString()} ${line}`;
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
