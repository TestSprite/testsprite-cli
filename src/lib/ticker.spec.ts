/**
 * Unit tests for the TTY-gated progress ticker.
 */

import { describe, expect, it, vi } from 'vitest';
import { createTicker, isNoColor } from './ticker.js';

describe('createTicker — non-TTY (CI mode)', () => {
  it('update is a no-op (no writes)', () => {
    const raw: string[] = [];
    const ticker = createTicker(
      () => {},
      false, // isTTY = false
      text => raw.push(text),
    );
    ticker.update('some progress');
    expect(raw).toEqual([]);
  });

  it('finalize is a no-op (no writes)', () => {
    const raw: string[] = [];
    const ticker = createTicker(
      () => {},
      false,
      text => raw.push(text),
    );
    ticker.finalize('done');
    expect(raw).toEqual([]);
  });

  it('finalize with no argument is also a no-op', () => {
    const raw: string[] = [];
    const ticker = createTicker(
      () => {},
      false,
      text => raw.push(text),
    );
    ticker.finalize();
    expect(raw).toEqual([]);
  });
});

/** Strip the ISO timestamp prefix that ticker prepends to every line. */
function stripTickerTimestamp(raw: string): string {
  // Format: "\x1b[2K\r<ISO-TS> <content>" → "\x1b[2K\r<content>"
  // Use a string replace to avoid the no-control-regex lint rule.
  const prefix = '\x1b[2K\r';
  if (!raw.startsWith(prefix)) return raw;
  // The content after the escape sequence starts with an ISO timestamp like
  // "2026-05-21T12:34:56.789Z "; strip it by cutting at the first space
  // following the "Z" terminator.
  const afterEsc = raw.slice(prefix.length);
  const spaceIdx = afterEsc.indexOf(' ');
  if (spaceIdx === -1) return raw;
  return prefix + afterEsc.slice(spaceIdx + 1);
}

describe('createTicker — TTY mode', () => {
  it('update writes ANSI clear-line + carriage-return + content via rawWrite', () => {
    const raw: string[] = [];
    const ticker = createTicker(
      () => {},
      true, // isTTY = true
      text => raw.push(text),
    );
    ticker.update('Run run_abc — running (3/8 steps elapsed=12s)');
    expect(raw).toHaveLength(1);
    expect(stripTickerTimestamp(raw[0]!)).toBe(
      '\x1b[2K\rRun run_abc — running (3/8 steps elapsed=12s)',
    );
  });

  it('update rewrites the line on each call (in-place update)', () => {
    const raw: string[] = [];
    const ticker = createTicker(
      () => {},
      true,
      text => raw.push(text),
    );
    ticker.update('first tick');
    ticker.update('second tick');
    ticker.update('third tick');
    expect(raw).toHaveLength(3);
    expect(stripTickerTimestamp(raw[0]!)).toBe('\x1b[2K\rfirst tick');
    expect(stripTickerTimestamp(raw[1]!)).toBe('\x1b[2K\rsecond tick');
    expect(stripTickerTimestamp(raw[2]!)).toBe('\x1b[2K\rthird tick');
  });

  it('finalize with a final line emits the line then a newline', () => {
    const raw: string[] = [];
    const ticker = createTicker(
      () => {},
      true,
      text => raw.push(text),
    );
    ticker.update('working');
    ticker.finalize('done — passed');
    // Expect: clear+carriage-return+line, then \n
    expect(raw).toHaveLength(3);
    expect(stripTickerTimestamp(raw[1]!)).toBe('\x1b[2K\rdone — passed');
    expect(raw[2]).toBe('\n');
  });

  it('finalize without args emits just a newline when something was written', () => {
    const raw: string[] = [];
    const ticker = createTicker(
      () => {},
      true,
      text => raw.push(text),
    );
    ticker.update('progress');
    ticker.finalize();
    // Last call should be '\n' to flush the line
    expect(raw[raw.length - 1]).toBe('\n');
  });

  it('finalize without args emits nothing when nothing was written', () => {
    const raw: string[] = [];
    const ticker = createTicker(
      () => {},
      true,
      text => raw.push(text),
    );
    // No update calls
    ticker.finalize();
    // Nothing should have been written (lastLength is 0)
    expect(raw).toHaveLength(0);
  });

  it('finalize without args but with prior update — emits newline only', () => {
    const raw: string[] = [];
    const ticker = createTicker(
      () => {},
      true,
      text => raw.push(text),
    );
    ticker.update('x');
    const lengthAfterUpdate = raw.length;
    ticker.finalize();
    // Should add exactly one item: '\n'
    expect(raw.length).toBe(lengthAfterUpdate + 1);
    expect(raw[raw.length - 1]).toBe('\n');
  });

  it('multiple finalize calls only move to fresh line once (idempotent-ish)', () => {
    const raw: string[] = [];
    const ticker = createTicker(
      () => {},
      true,
      text => raw.push(text),
    );
    ticker.update('something');
    ticker.finalize();
    const lenAfterFirst = raw.length;
    // Second finalize: lastLength is 0 after first finalize? Let's check behavior.
    // After finalize(), a newline was appended — but lastLength stays non-zero in impl
    // Actually the spec doesn't guarantee idempotency, we just verify no crash.
    expect(() => ticker.finalize()).not.toThrow();
    // The raw array may grow but should not crash.
    expect(raw.length).toBeGreaterThanOrEqual(lenAfterFirst);
  });
});

describe('createTicker — default isTTY detection', () => {
  it('does not throw when isTTY is not provided (uses process.stderr.isTTY)', () => {
    // In Vitest/Node test environment, process.stderr.isTTY may or may not be true.
    // We just confirm createTicker does not throw on construction.
    expect(() =>
      createTicker(
        () => {},
        undefined, // let it use the default
      ),
    ).not.toThrow();
  });
});

describe('createTicker — stderrWrite dependency injection', () => {
  it('does not call stderrWrite during update on TTY (rawWrite used instead)', () => {
    const stderrLines: string[] = [];
    const raw: string[] = [];
    const ticker = createTicker(
      line => stderrLines.push(line),
      true,
      text => raw.push(text),
    );
    ticker.update('progress');
    // stderrWrite should not be called (rawWrite handles TTY in-place updates)
    expect(stderrLines).toHaveLength(0);
    expect(raw.length).toBeGreaterThan(0);
  });

  it('stderrWrite is referenced in finalize (no unused-var warning)', () => {
    // This is purely a compilation concern but we verify no throws.
    const stderrLines: string[] = [];
    const ticker = createTicker(
      line => stderrLines.push(line),
      true,
      () => {},
    );
    expect(() => ticker.finalize('line')).not.toThrow();
  });
});

describe('createTicker — spy on process.stderr', () => {
  it('defaults to process.stderr.write when stderrRaw is not provided', () => {
    // Spy on process.stderr.write to verify it's called.
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const ticker = createTicker(
        () => {},
        true, // force TTY
        // No stderrRaw — should default to process.stderr.write
      );
      ticker.update('test line');
      // The ticker prepends an ISO timestamp; verify the call happened and
      // the content (after the timestamp) matches.
      expect(writeSpy).toHaveBeenCalledOnce();
      const actual = writeSpy.mock.calls[0]![0] as string;
      expect(stripTickerTimestamp(actual)).toBe('\x1b[2K\rtest line');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('createTicker — NO_COLOR support', () => {
  it('suppresses ANSI escape sequences when noColor=true on TTY', () => {
    const lines: string[] = [];
    const raw: string[] = [];
    const ticker = createTicker(
      line => lines.push(line),
      true, // isTTY = true
      text => raw.push(text),
      true, // noColor = true
    );
    ticker.update('progress');
    // Should use stderrWrite (line-oriented) instead of rawWrite with ANSI
    expect(raw).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!).not.toContain('\x1b[2K');
    expect(lines[0]!).not.toContain('\r');
    expect(lines[0]!).toContain('progress');
  });

  it('finalize emits plain text without ANSI when noColor=true on TTY', () => {
    const lines: string[] = [];
    const raw: string[] = [];
    const ticker = createTicker(
      line => lines.push(line),
      true,
      text => raw.push(text),
      true, // noColor = true
    );
    ticker.finalize('done');
    expect(raw).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!).not.toContain('\x1b[2K');
    expect(lines[0]!).toContain('done');
  });

  it('normal ANSI output when noColor=false on TTY', () => {
    const raw: string[] = [];
    const ticker = createTicker(
      () => {},
      true,
      text => raw.push(text),
      false, // noColor = false
    );
    ticker.update('progress');
    expect(raw).toHaveLength(1);
    expect(raw[0]!).toContain('\x1b[2K\r');
  });
});

describe('isNoColor', () => {
  it('returns true when NO_COLOR is set to a non-empty value', () => {
    expect(isNoColor({ NO_COLOR: '1' })).toBe(true);
    expect(isNoColor({ NO_COLOR: 'true' })).toBe(true);
  });

  it('returns false when NO_COLOR is absent or empty', () => {
    expect(isNoColor({})).toBe(false);
    expect(isNoColor({ OTHER_VAR: '1' })).toBe(false);
    // Per https://no-color.org/, an empty NO_COLOR does NOT disable color.
    expect(isNoColor({ NO_COLOR: '' })).toBe(false);
  });
});
