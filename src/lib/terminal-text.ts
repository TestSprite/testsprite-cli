/*
 * The patterns below match control characters on purpose: finding them is
 * their whole job.
 */
/* eslint-disable no-control-regex */

/**
 * Escape sequences that carry a string, through their terminator: OSC (window
 * titles, hyperlinks), DCS, SOS, PM and APC, started by ESC and ended by ST
 * (7-bit or 8-bit), BEL, or the CAN or SUB that aborts them, on the same line.
 * An introducer that nothing on its line ends is not one: the later passes
 * remove it alone and keep the text after it. So a sequence opened in one
 * server value and ended in another can never take the lines the CLI wrote
 * between them.
 *
 * The 8-bit introducers (U+0090, U+0098, U+009D–U+009F) do not start one
 * here: in badly decoded text they are ordinary characters' second bytes (a
 * curly quote read as Latin-1 ends in U+009D), and taking the text up to the
 * next U+009C would drop words. The CONTROL pass removes each of them alone,
 * so a terminal never receives one, and what followed it is printed as text.
 */
const STRING_SEQUENCE = /\u001b[\]PX^_][^\n]*?(?:\u0007|\u0018|\u001a|\u001b\\|\u009c)/g;

/**
 * An ESC that starts nothing, with its intermediate bytes (0x20–0x2F) if it
 * has any: one whose intermediates no final byte (0x30–0x7E) follows, so what
 * comes next is not printable ASCII (another ESC, a C1 control, a line break,
 * the end). Removed first, so that removing a sequence after it can never join
 * it to the next visible character: `ESC (` before an OSC would otherwise take
 * the character after the OSC as its final byte. A complete escape such as
 * `ESC ( B` never matches: at every split of its intermediates the next
 * character is printable. Intermediates are never a line break or an ESC, so
 * each ESC's backtracking is bounded by its own run of them and the pass stays
 * linear.
 */
const LONE_ESCAPE = /\u001b[ -/]*(?![ -~])/g;

/**
 * Control sequences (colours, cursor moves, clearing the screen), 7-bit and
 * 8-bit, or else any other escape: ESC, any intermediate bytes, and its final
 * byte if there is one. One pass, so one removal cannot make the next match.
 */
const CSI_OR_ESCAPE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]?/g;

/**
 * C0 and C1 control characters, tab and line feed excepted, and the bidi
 * controls (embeddings, overrides, isolates and marks) that reorder how the
 * rest of a line reads.
 */
const CONTROL =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/* eslint-enable no-control-regex */

/**
 * Text from the server, made safe to print on a terminal.
 *
 * Titles, step descriptions, errors and URLs come from the server, and
 * through it from the pages a test visited and from model output, so they can
 * carry escape sequences that set the window title, open a hyperlink, clear
 * the screen or colour what follows, and bidi controls that reorder a line.
 * This removes every escape sequence and every other control character, and
 * keeps line breaks and tabs. A carriage return becomes a line break, so it
 * cannot return over a printed line.
 *
 * For text output only; JSON keeps the server's text and escapes these
 * characters instead (see {@link jsonForTerminal}).
 */
export function terminalSafe(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(LONE_ESCAPE, '')
    .split('\n')
    .map(withoutStringSequences)
    .join('\n')
    .replace(CSI_OR_ESCAPE, '')
    .replace(CONTROL, '');
}

/**
 * One line without its string sequences. A sequence ends at a terminator on
 * its line, so none can match after the line's last one. Matching only up to
 * it keeps the pass linear: from an introducer that nothing ends, the lazy
 * match would scan to the end of the line, once per introducer.
 */
function withoutStringSequences(line: string): string {
  const end = endOfLastTerminator(line);
  return line.slice(0, end).replace(STRING_SEQUENCE, '') + line.slice(end);
}

/** The index just past the last string-sequence terminator in `text`, or 0. */
function endOfLastTerminator(text: string): number {
  const st = text.lastIndexOf('\u001b\\');
  return Math.max(
    text.lastIndexOf('\u0007') + 1,
    text.lastIndexOf('\u0018') + 1,
    text.lastIndexOf('\u001a') + 1,
    text.lastIndexOf('\u009c') + 1,
    st === -1 ? 0 : st + 2,
  );
}

/**
 * {@link terminalSafe} on one line: every run of whitespace, line breaks
 * included, becomes one space. For a value printed inside a line (a cell, an
 * id in a message), where a line break would start a line the server wrote.
 */
export function terminalSafeLine(text: string): string {
  return terminalSafe(text).replace(/\s+/g, ' ').trim();
}

/**
 * A line writer whose every line goes through {@link terminalSafe} first: the
 * stderr a command writes its own lines to (progress, hints, advisories), each
 * of which may carry a server value. With no writer, lines go to the process's
 * stderr. Never for JSON: a JSON line goes out through {@link jsonForTerminal}.
 */
export function terminalSafeWriter(write?: (line: string) => void): (line: string) => void {
  const target = write ?? ((line: string) => process.stderr.write(`${line}\n`));
  return line => target(terminalSafe(line));
}

/**
 * The `--verbose` writer: each transition the HTTP client or a poll reports
 * (which may name a server id) as one `[verbose]` line on `stderr`.
 */
export function verboseWriter(stderr: (line: string) => void): (msg: string) => void {
  return msg => stderr(`[verbose] ${terminalSafeLine(msg)}`);
}

/**
 * DEL, the C1 controls and the bidi controls (embeddings, overrides, isolates
 * and marks), which `JSON.stringify` leaves as they are.
 */
const JSON_RAW_CONTROL = /[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * `JSON.stringify` for output a terminal may show. It escapes C0 controls
 * itself but leaves DEL, the C1 controls and the bidi controls raw: U+009B and
 * U+009D are the 8-bit CSI and OSC, and U+202E reorders the rest of a line.
 * This writes those as `\uXXXX` too: the same JSON value, with nothing a
 * terminal acts on.
 */
export function jsonForTerminal(value: unknown, space?: number): string {
  return String(JSON.stringify(value, null, space)).replace(
    JSON_RAW_CONTROL,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
