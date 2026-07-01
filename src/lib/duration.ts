/**
 * Human-readable duration parser and formatter.
 *
 * Parses strings like `"4h"`, `"30m"`, `"45s"`, `"1h30m"`, `"2h15m30s"`
 * into milliseconds, and formats milliseconds back into concise
 * human-readable text.
 *
 * Design notes:
 *   - Only hours (`h`), minutes (`m`), and seconds (`s`) are supported.
 *     Days and larger units are intentionally omitted — they introduce
 *     DST and calendar ambiguity that a CLI should not silently absorb.
 *   - Bare numbers without a unit are rejected. This avoids the
 *     "is 120 seconds or minutes?" ambiguity that plagues many CLIs.
 *   - The parser is case-insensitive (`4H30M` works).
 *   - Fractional values (e.g. `1.5h`) are supported within each segment.
 *   - Negative durations and zero are rejected; a duration represents a
 *     strictly positive time span.
 *   - Maximum duration is capped at 24 hours to prevent accidental
 *     multi-day sessions.
 *   - Integrates with the existing `localValidationError` helper so
 *     error wording and exit codes stay consistent with the rest of
 *     the CLI (exit 5, VALIDATION_ERROR).
 *
 * @example
 *   parseDuration('4h');        // 14_400_000
 *   parseDuration('30m');       //  1_800_000
 *   parseDuration('1h30m');     //  5_400_000
 *   parseDuration('2h15m30s'); //  8_130_000
 *   formatDuration(5_400_000); // '1h 30m'
 */

import { localValidationError } from './errors.js';

/** 24 hours in milliseconds — hard ceiling for parsed durations. */
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Matches one or more `<number><unit>` segments. Each segment is a
 * (possibly fractional) number followed by one of `h`, `m`, `s`.
 *
 * The regex validates that the ENTIRE string is composed exclusively
 * of `<number><unit>` segments with no stray characters.
 *
 * Examples that match: `4h`, `30m`, `1h30m`, `2h15m30s`, `1.5h`
 * Examples that don't: `4`, `h30`, `4h 30m` (space), `4x`, ``
 */
const DURATION_RE = /^(?:\d+(?:\.\d+)?[hms])+$/i;

/**
 * Captures individual `<number><unit>` segments for iteration.
 * Used with `matchAll` after the full-string regex has validated shape.
 */
const SEGMENT_RE = /(\d+(?:\.\d+)?)([hms])/gi;

/** Unit multipliers to convert each segment to milliseconds. */
const UNIT_MS: Record<string, number> = {
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
};

/**
 * Parse a human-readable duration string into milliseconds.
 *
 * Accepted formats:
 *   - `"4h"` — 4 hours
 *   - `"30m"` — 30 minutes
 *   - `"45s"` — 45 seconds
 *   - `"1h30m"` — 1 hour 30 minutes
 *   - `"2h15m30s"` — 2 hours 15 minutes 30 seconds
 *   - `"1.5h"` — 1 hour 30 minutes (fractional)
 *
 * @param input  The raw duration string.
 * @param field  Field name for error messages (default: `'duration'`).
 *               Passed as a CLI flag name to `localValidationError`.
 * @returns Duration in milliseconds (always a positive integer).
 *
 * @throws {ApiError} VALIDATION_ERROR (exit 5) when the input is
 *   empty, malformed, zero, negative (impossible given the grammar),
 *   or exceeds the 24-hour ceiling.
 */
export function parseDuration(input: string, field = 'duration'): number {
  const trimmed = input.trim();

  if (trimmed === '') {
    throw localValidationError(
      field,
      'must be a duration string (e.g. "4h", "30m", "1h30m")',
      undefined,
      'flag',
    );
  }

  if (!DURATION_RE.test(trimmed)) {
    throw localValidationError(
      field,
      'must be a duration string using h (hours), m (minutes), s (seconds) — e.g. "4h", "30m", "1h30m", "2h15m30s"',
      undefined,
      'flag',
    );
  }

  // Track which units have been seen to reject duplicates like `1h2h`.
  const seen = new Set<string>();
  let totalMs = 0;

  for (const match of trimmed.matchAll(SEGMENT_RE)) {
    const value = parseFloat(match[1]!);
    const unit = match[2]!.toLowerCase();

    if (seen.has(unit)) {
      throw localValidationError(
        field,
        `contains duplicate unit "${unit}" — each unit (h, m, s) may appear at most once`,
        undefined,
        'flag',
      );
    }
    seen.add(unit);

    totalMs += value * UNIT_MS[unit]!;
  }

  // Round to the nearest integer millisecond to avoid floating-point drift
  // from fractional segments like `1.5h`.
  totalMs = Math.round(totalMs);

  if (totalMs <= 0) {
    throw localValidationError(field, 'must be a positive duration', undefined, 'flag');
  }

  if (totalMs > MAX_DURATION_MS) {
    throw localValidationError(
      field,
      `must not exceed 24 hours (got ${formatDuration(totalMs)})`,
      undefined,
      'flag',
    );
  }

  return totalMs;
}

/**
 * Format a duration in milliseconds to a concise human-readable string.
 *
 * Output uses the largest applicable units with no leading zeros:
 *   - `formatDuration(5_400_000)` → `"1h 30m"`
 *   - `formatDuration(90_000)` → `"1m 30s"`
 *   - `formatDuration(3_600_000)` → `"1h"`
 *   - `formatDuration(1_000)` → `"1s"`
 *   - `formatDuration(500)` → `"<1s"`
 *
 * @param ms Non-negative duration in milliseconds.
 * @returns Human-readable duration string.
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return '0s';
  if (ms < 1000) return ms > 0 ? '<1s' : '0s';

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);

  return parts.join(' ') || '0s';
}

/**
 * Convenience: validate that a raw string is a valid duration within
 * the given bounds. Returns the parsed milliseconds.
 *
 * @param input  Raw duration string.
 * @param field  Flag/field name for error messages.
 * @param opts.min  Minimum duration in milliseconds (inclusive).
 * @param opts.max  Maximum duration in milliseconds (inclusive).
 *                  Defaults to 24 hours.
 */
export function requireDuration(
  input: string,
  field = 'duration',
  opts: { min?: number; max?: number } = {},
): number {
  const ms = parseDuration(input, field);
  const { min, max } = opts;

  if (min !== undefined && ms < min) {
    throw localValidationError(
      field,
      `must be at least ${formatDuration(min)} (got ${formatDuration(ms)})`,
      undefined,
      'flag',
    );
  }

  if (max !== undefined && ms > max) {
    throw localValidationError(
      field,
      `must not exceed ${formatDuration(max)} (got ${formatDuration(ms)})`,
      undefined,
      'flag',
    );
  }

  return ms;
}
