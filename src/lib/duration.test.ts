import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration, requireDuration } from './duration.js';
import { ApiError } from './errors.js';

describe('parseDuration', () => {
  describe('valid inputs', () => {
    it('parses hours', () => {
      expect(parseDuration('4h')).toBe(4 * 3_600_000);
    });

    it('parses minutes', () => {
      expect(parseDuration('30m')).toBe(30 * 60_000);
    });

    it('parses seconds', () => {
      expect(parseDuration('45s')).toBe(45 * 1_000);
    });

    it('parses compound h+m', () => {
      expect(parseDuration('1h30m')).toBe(1 * 3_600_000 + 30 * 60_000);
    });

    it('parses compound h+m+s', () => {
      expect(parseDuration('2h15m30s')).toBe(2 * 3_600_000 + 15 * 60_000 + 30 * 1_000);
    });

    it('parses compound m+s', () => {
      expect(parseDuration('5m30s')).toBe(5 * 60_000 + 30 * 1_000);
    });

    it('parses fractional hours', () => {
      expect(parseDuration('1.5h')).toBe(5_400_000);
    });

    it('parses fractional minutes', () => {
      expect(parseDuration('2.5m')).toBe(150_000);
    });

    it('parses fractional seconds', () => {
      expect(parseDuration('1.5s')).toBe(1_500);
    });

    it('is case-insensitive', () => {
      expect(parseDuration('4H')).toBe(4 * 3_600_000);
      expect(parseDuration('30M')).toBe(30 * 60_000);
      expect(parseDuration('45S')).toBe(45 * 1_000);
      expect(parseDuration('1H30M')).toBe(1 * 3_600_000 + 30 * 60_000);
    });

    it('trims whitespace', () => {
      expect(parseDuration('  4h  ')).toBe(4 * 3_600_000);
    });

    it('parses 1s (minimum practical duration)', () => {
      expect(parseDuration('1s')).toBe(1_000);
    });

    it('parses 24h (maximum allowed)', () => {
      expect(parseDuration('24h')).toBe(24 * 3_600_000);
    });
  });

  describe('invalid inputs', () => {
    it('rejects empty string', () => {
      expect(() => parseDuration('')).toThrow(ApiError);
    });

    it('rejects whitespace-only string', () => {
      expect(() => parseDuration('   ')).toThrow(ApiError);
    });

    it('rejects bare number without unit', () => {
      expect(() => parseDuration('120')).toThrow(ApiError);
    });

    it('rejects unit without number', () => {
      expect(() => parseDuration('h')).toThrow(ApiError);
    });

    it('rejects unsupported units', () => {
      expect(() => parseDuration('4d')).toThrow(ApiError);
      expect(() => parseDuration('2w')).toThrow(ApiError);
    });

    it('rejects spaces between segments', () => {
      expect(() => parseDuration('1h 30m')).toThrow(ApiError);
    });

    it('rejects duplicate units', () => {
      expect(() => parseDuration('1h2h')).toThrow(ApiError);
      expect(() => parseDuration('1m2m')).toThrow(ApiError);
      expect(() => parseDuration('1s2s')).toThrow(ApiError);
    });

    it('rejects zero duration', () => {
      expect(() => parseDuration('0h')).toThrow(ApiError);
      expect(() => parseDuration('0m')).toThrow(ApiError);
      expect(() => parseDuration('0s')).toThrow(ApiError);
      expect(() => parseDuration('0h0m0s')).toThrow(ApiError);
    });

    it('rejects duration exceeding 24 hours', () => {
      expect(() => parseDuration('25h')).toThrow(ApiError);
      expect(() => parseDuration('24h1s')).toThrow(ApiError);
      expect(() => parseDuration('1500m')).toThrow(ApiError);
    });

    it('rejects non-string-like inputs via the grammar', () => {
      expect(() => parseDuration('abc')).toThrow(ApiError);
      expect(() => parseDuration('--4h')).toThrow(ApiError);
      expect(() => parseDuration('4h-')).toThrow(ApiError);
    });
  });

  describe('error messages', () => {
    it('includes the field name in the error', () => {
      try {
        parseDuration('', 'maxDuration');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.code).toBe('VALIDATION_ERROR');
        expect(apiErr.exitCode).toBe(5);
        expect(apiErr.nextAction).toContain('--max-duration');
      }
    });

    it('uses the default field name when not specified', () => {
      try {
        parseDuration('');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.nextAction).toContain('--duration');
      }
    });

    it('includes the formatted excess duration in the message', () => {
      try {
        parseDuration('25h');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.nextAction).toContain('24 hours');
      }
    });

    it('mentions duplicate unit in the message', () => {
      try {
        parseDuration('1h2h');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.nextAction).toContain('duplicate');
        expect(apiErr.nextAction).toContain('"h"');
      }
    });
  });
});

describe('formatDuration', () => {
  it('formats hours only', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(7_200_000)).toBe('2h');
  });

  it('formats minutes only', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(1_800_000)).toBe('30m');
  });

  it('formats seconds only', () => {
    expect(formatDuration(1_000)).toBe('1s');
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('formats hours + minutes', () => {
    expect(formatDuration(5_400_000)).toBe('1h 30m');
  });

  it('formats hours + minutes + seconds', () => {
    expect(formatDuration(8_130_000)).toBe('2h 15m 30s');
  });

  it('formats minutes + seconds', () => {
    expect(formatDuration(90_000)).toBe('1m 30s');
  });

  it('formats sub-second as "<1s"', () => {
    expect(formatDuration(500)).toBe('<1s');
    expect(formatDuration(1)).toBe('<1s');
    expect(formatDuration(999)).toBe('<1s');
  });

  it('formats zero as "0s"', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('formats negative as "0s"', () => {
    expect(formatDuration(-1000)).toBe('0s');
  });

  it('truncates fractional seconds (floor)', () => {
    // 1500ms = 1s + 500ms remainder → "1s" (floor to whole seconds)
    expect(formatDuration(1_500)).toBe('1s');
  });

  it('formats large durations', () => {
    expect(formatDuration(24 * 3_600_000)).toBe('24h');
    expect(formatDuration(23 * 3_600_000 + 59 * 60_000 + 59 * 1_000)).toBe('23h 59m 59s');
  });
});

describe('requireDuration', () => {
  it('returns milliseconds for valid input', () => {
    expect(requireDuration('4h')).toBe(4 * 3_600_000);
  });

  it('rejects below minimum', () => {
    expect(() => requireDuration('30s', 'maxDuration', { min: 60_000 })).toThrow(ApiError);
    try {
      requireDuration('30s', 'maxDuration', { min: 60_000 });
      expect.fail('should have thrown');
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.nextAction).toContain('at least');
      expect(apiErr.nextAction).toContain('1m');
    }
  });

  it('rejects above maximum', () => {
    expect(() => requireDuration('5h', 'maxDuration', { max: 4 * 3_600_000 })).toThrow(ApiError);
    try {
      requireDuration('5h', 'maxDuration', { max: 4 * 3_600_000 });
      expect.fail('should have thrown');
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.nextAction).toContain('must not exceed');
      expect(apiErr.nextAction).toContain('4h');
    }
  });

  it('accepts value at minimum boundary', () => {
    expect(requireDuration('1m', 'timeout', { min: 60_000 })).toBe(60_000);
  });

  it('accepts value at maximum boundary', () => {
    expect(requireDuration('4h', 'timeout', { max: 4 * 3_600_000 })).toBe(4 * 3_600_000);
  });

  it('accepts value within both bounds', () => {
    expect(requireDuration('2h', 'timeout', { min: 60_000, max: 4 * 3_600_000 })).toBe(7_200_000);
  });

  it('propagates parse errors', () => {
    expect(() => requireDuration('abc')).toThrow(ApiError);
  });
});
