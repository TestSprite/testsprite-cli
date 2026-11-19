import { describe, expect, it } from 'vitest';
import {
  jsonForTerminal,
  terminalSafe,
  terminalSafeLine,
  terminalSafeWriter,
  verboseWriter,
} from './terminal-text.js';

/** Any C0 or C1 control character but tab and line feed, ESC included, or a bidi control. */
const CONTROL =
  // eslint-disable-next-line no-control-regex -- finding control characters is the point.
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

describe('terminalSafe', () => {
  it('leaves ordinary text alone, line breaks, tabs and any script included', () => {
    const text = 'Checkout — 結帳 ✅ مرحبا\n\tsecond line';
    expect(terminalSafe(text)).toBe(text);
  });

  it.each([
    ['a colour (CSI)', 'red \u001b[31mtext\u001b[0m', 'red text'],
    ['a clear-screen and cursor move (CSI)', '\u001b[2J\u001b[1;1Hhome', 'home'],
    ['a window title (OSC, BEL)', '\u001b]0;pwned\u0007title', 'title'],
    ['a window title (OSC, ST)', '\u001b]2;pwned\u001b\\title', 'title'],
    [
      'a hyperlink (OSC 8)',
      '\u001b]8;;https://evil.example\u001b\\click\u001b]8;;\u001b\\',
      'click',
    ],
    ['a device control string (DCS)', 'a\u001bPq#0;2;0\u001b\\b', 'ab'],
    ['an 8-bit CSI', 'x\u009b31my', 'xy'],
    // An 8-bit introducer starts no sequence: removed alone, what followed is text.
    ['an 8-bit OSC', 'x\u009d0;pwned\u009cy', 'x0;pwnedy'],
    ['an OSC that CAN aborts', 'x\u001b]0;title\u0018visible after CAN', 'xvisible after CAN'],
    ['an OSC that SUB aborts', 'x\u001b]0;title\u001avisible after SUB', 'xvisible after SUB'],
    ['a two-byte escape', 'x\u001bcy\u001b(By', 'xyy'],
    ['a lone ESC', 'x\u001b', 'x'],
    ['other controls', 'a\u0000b\u0008c\u007fd\u0085e\u0007f', 'abcdef'],
  ])('removes %s', (_what, text, safe) => {
    expect(terminalSafe(text)).toBe(safe);
    expect(terminalSafe(text)).not.toMatch(CONTROL);
  });

  it('removes only the introducer of a string sequence that never ends, and keeps the text after it', () => {
    expect(terminalSafe('x\u001b]0;pwned')).toBe('x0;pwned');
  });

  it.each([
    [
      'Expected â€œWelcomeâ€\u009d but the page showed an error banner',
      'Expected â€œWelcomeâ€ but the page showed an error banner',
    ],
    [
      'Price â\u0094\u0090 total shown wrong; rest of message',
      'Price â total shown wrong; rest of message',
    ],
  ])('keeps the rest of a mojibake value that holds a stray 8-bit control: %j', (text, safe) => {
    expect(terminalSafe(text)).toBe(safe);
  });

  it('removes the bidi controls that reorder what follows them', () => {
    const marks = '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200e\u200f\u061c';
    expect(terminalSafe(`Checkout \u202edeliaf\u202c ok ${marks}`)).toBe('Checkout deliaf ok ');
  });

  it('takes linear time on a long run of string-sequence starts that nothing ends', () => {
    // 200k characters: each start would otherwise be scanned to the end of the text.
    const started = Date.now();
    expect(terminalSafe('\u001b]'.repeat(100_000))).toBe('');
    expect(terminalSafe(`${'\u009d'.repeat(200_000)}tail`)).toBe('tail');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it.each([
    ['a CSI', 'a\u001b\u009b31mb'],
    ['a string sequence', 'a\u001b\u001b]0;title\u0007b'],
    ['a C1 control', 'a\u001b\u0085b'],
  ])('keeps the character after a lone ESC that precedes %s', (_what, text) => {
    expect(terminalSafe(text)).toBe('ab');
  });

  it.each([
    ['ESC (', 'a\u001b(\u001b]0;t\u0007Bb', 'aBb'],
    ['ESC #', 'a\u001b#\u001b]0;t\u0007xb', 'axb'],
  ])(
    'keeps the character after an unfinished escape (%s) that precedes a string sequence',
    (_what, text, safe) => {
      expect(terminalSafe(text)).toBe(safe);
    },
  );

  it('takes linear time on escapes whose intermediate bytes nothing finishes', () => {
    const started = Date.now();
    expect(terminalSafe(`${'\u001b('.repeat(100_000)}B`)).toBe('');
    expect(terminalSafe(`\u001b${' '.repeat(200_000)}\u001b]0;t\u0007tail`)).toBe('tail');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('turns a carriage return into a line break, so it cannot print over a line', () => {
    expect(terminalSafe('fake\rreal')).toBe('fake\nreal');
    expect(terminalSafe('one\r\ntwo')).toBe('one\ntwo');
  });
});

describe('terminalSafeLine', () => {
  it('is the safe text on one line: every run of whitespace, line breaks included, is one space', () => {
    expect(terminalSafeLine('  r1\nrequestId: req_fake\r\n\tx \u001b[31my  ')).toBe(
      'r1 requestId: req_fake x y',
    );
  });

  it('is empty for text that was only controls and whitespace', () => {
    expect(terminalSafeLine('\u001b[2J \n ')).toBe('');
  });
});

describe('terminalSafeWriter', () => {
  it('writes each line through terminalSafe, line breaks kept', () => {
    const lines: string[] = [];
    const write = terminalSafeWriter(line => lines.push(line));
    write('Run \u001b]0;pwned\u0007r1\u009b2J: 2 tests\n  next line');
    expect(lines).toEqual(['Run r1: 2 tests\n  next line']);
  });
});

describe('verboseWriter', () => {
  it('writes a transition as one [verbose] line, a server line break and escapes gone', () => {
    const lines: string[] = [];
    verboseWriter(line => lines.push(line))('poll run_a\u001b]0;pwned\u0007\nforged: line');
    expect(lines).toEqual(['[verbose] poll run_a forged: line']);
  });
});

describe('jsonForTerminal', () => {
  const value = { message: 'a\u009b31mb\u009d0;x\u009cc\u007fd', esc: '\u001b[2J', plain: 'ok' };

  it('escapes DEL and the C1 controls, which JSON.stringify leaves raw', () => {
    const json = jsonForTerminal(value, 2);
    expect(json).not.toMatch(CONTROL);
    expect(json).toContain('a\\u009b31mb\\u009d0;x\\u009cc\\u007fd');
    expect(json).toContain('\\u001b[2J');
  });

  it('is the same JSON value, indented as asked', () => {
    expect(JSON.parse(jsonForTerminal(value, 2))).toEqual(value);
    expect(jsonForTerminal(value, 2).split('\n')).toHaveLength(5);
    expect(jsonForTerminal([1, 'x'])).toBe('[1,"x"]');
  });
});

describe('terminalSafe: a string sequence stays on its line', () => {
  it('an introducer and a terminator on different lines remove nothing between them', () => {
    expect(terminalSafe('row one\u001b]0;\nrow two\nrow three\u0007')).toBe(
      'row one0;\nrow two\nrow three',
    );
  });

  it('the same, in the 8-bit form', () => {
    expect(terminalSafe('row one\u009d0;\nrow two\nrow three\u009c')).toBe(
      'row one0;\nrow two\nrow three',
    );
  });

  it('keeps the words between two mojibake quotes on one line', () => {
    // “hi” and “bye” as UTF-8 read as Latin-1: â\u0080\u009c … â\u0080\u009d.
    const mojibake =
      'He said â\u0080\u009chiâ\u0080\u009d and then â\u0080\u009cbyeâ\u0080\u009d ok';
    expect(terminalSafe(mojibake)).toBe('He said âhiâ and then âbyeâ ok');
  });

  it('takes linear time on a line of starts that nothing on that line ends', () => {
    const started = Date.now();
    expect(terminalSafe(`${'\u001b]'.repeat(100_000)}\n\u0007`)).toBe('\n');
    expect(terminalSafe(`${'\u009d'.repeat(200_000)}\nend\u009c`)).toBe('\nend');
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
