import { describe, expect, it } from 'vitest';
import { describeCron, formatScheduleFrequencyAdvisory, runsPerMonth } from './cron.js';

/** The advisory rounds, so the tests compare the same whole numbers a user sees. */
function runs(cron: string): number {
  const value = runsPerMonth(cron);
  expect(value).not.toBeNull();
  return Math.round(value!);
}

describe('runsPerMonth', () => {
  it('counts the common shapes', () => {
    expect(runs('0 * * * *')).toBe(730); // hourly
    expect(runs('0 3 * * *')).toBe(30); // daily
    expect(runs('0 3 * * 1')).toBe(4); // weekly
    expect(runs('0 3 1 * *')).toBe(1); // monthly
    expect(runs('* * * * *')).toBe(730 * 60); // every minute
  });

  it('counts a finer wildcard under a pinned coarser field', () => {
    // These are the shapes a coarsest-field-wins count got badly wrong: it
    // stopped at the pinned hour and reported the daily rate.
    expect(runs('* 3 * * *')).toBe(1825); // every minute of one hour
    expect(runs('* 9-17 * * *')).toBe(16425); // every minute of nine hours
    expect(runs('*/5 9 * * 1-5')).toBe(261); // every 5 min, one hour, weekdays
  });

  it('counts a stepped field by its actual values', () => {
    expect(runs('0 */6 * * *')).toBe(122); // 4 hours a day
    expect(runs('0 3 * * 1-5/2')).toBe(13); // Mon, Wed, Fri
  });

  it('ORs day-of-month with day-of-week when both are restricted', () => {
    // Standard cron fires on day 1 OR any Monday, not on their intersection.
    // A schedule cannot be created with both day fields constrained, so this
    // arithmetic is unreachable in practice; it is kept because the model here
    // is standard cron, not a subset of it.
    expect(runs('0 3 1 * 1')).toBe(5);
  });

  it('counts the two spellings of Sunday once', () => {
    expect(runs('0 3 * * 0,7')).toBe(runs('0 3 * * 0'));
  });

  it('counts overlapping list entries once', () => {
    expect(runs('0 3 * * 1-5,3')).toBe(runs('0 3 * * 1-5'));
  });

  it('scales by the month field', () => {
    expect(runs('0 3 * * *')).toBe(30);
    expect(runs('0 3 * 1,7 *')).toBe(5); // two months of the year
  });

  it('tolerates surrounding and repeated whitespace', () => {
    expect(runs('  0   3  *  *  *  ')).toBe(30);
  });

  it('reads the shapes real schedules use', () => {
    // Common shapes rather than invented ones, so a change that makes the
    // advisory silent for real users fails here first.
    expect(runs('0 */1 * * *')).toBe(730);
    expect(runs('0 1 * * *')).toBe(30);
    expect(runs('0 0 */1 * *')).toBe(30);
    expect(runs('0 9 * * *')).toBe(30);
    expect(runs('0 3 * * 1')).toBe(4);
  });

  it('returns null rather than a wrong number for an unreadable expression', () => {
    for (const cron of [
      '0 0 3 * * *', // 6-field Quartz — every index shifts
      '0 3 * * MON', // day names
      '0 3 L * *', // day-of-month extension
      '0 3 * * 5#2', // nth-weekday extension
      '99 3 * * *', // out of range
      '0 3 32 * *', // out of range
      '0 3 * *', // too few fields
      '',
      'not a cron',
    ]) {
      expect(runsPerMonth(cron), cron).toBeNull();
    }
  });
});

describe('describeCron', () => {
  it('describes an exact daily time', () => {
    expect(describeCron('0 3 * * *')).toBe('daily at 03:00');
    expect(describeCron('30 14 * * *')).toBe('daily at 14:30');
  });

  it('names the weekday for a weekly schedule', () => {
    expect(describeCron('0 3 * * 1')).toBe('weekly on Monday at 03:00');
    expect(describeCron('0 3 * * 0')).toBe('weekly on Sunday at 03:00');
  });

  it('accepts 7 as Sunday', () => {
    expect(describeCron('0 3 * * 7')).toBe('weekly on Sunday at 03:00');
  });

  it('describes a monthly schedule by day number', () => {
    expect(describeCron('0 3 1 * *')).toBe('monthly on day 1 at 03:00');
  });

  it('returns the raw expression when it names no exact time', () => {
    for (const cron of ['0 */6 * * *', '*/7 2-5 * * *', '0 3 1 * 1', '* * * * *']) {
      expect(describeCron(cron)).toBe(cron);
    }
  });

  it('returns the raw expression when the field count is not 5', () => {
    // A 6-field Quartz cron shifts every index, so reading f[1] as the hour
    // would describe a time the schedule never runs at.
    expect(describeCron('0 0 3 * * *')).toBe('0 0 3 * * *');
    expect(describeCron('0 3 * *')).toBe('0 3 * *');
  });

  it('trims the raw expression it falls back to', () => {
    expect(describeCron('  */7 2-5 * * *  ')).toBe('*/7 2-5 * * *');
  });
});

describe('formatScheduleFrequencyAdvisory', () => {
  it('states the frequency in both forms and that each run is a full run', () => {
    const out = formatScheduleFrequencyAdvisory('0 3 * * *');
    expect(out).toContain('~30 time(s)/month');
    expect(out).toContain('daily at 03:00');
    expect(out).toContain('full test run');
  });

  it('quotes no credit figure', () => {
    // No per-action rate for the workspace wallet is available, so any number
    // would be derived from something that is not the real price.
    for (const cron of ['0 * * * *', '0 3 * * *', '0 3 1 * *', '* * * * *']) {
      expect(formatScheduleFrequencyAdvisory(cron)).not.toMatch(/\d+(\.\d+)?\s*credits/);
    }
  });

  it('points at the balance command rather than guessing affordability', () => {
    expect(formatScheduleFrequencyAdvisory('0 3 * * *')).toContain('testsprite usage');
  });

  it('says so in words when a schedule runs less than monthly', () => {
    const out = formatScheduleFrequencyAdvisory('0 3 1 1 *');
    expect(out).toContain('less than once a month');
    expect(out).not.toContain('~0 time');
  });

  it('still advises, without a frequency, for an expression it cannot read', () => {
    const out = formatScheduleFrequencyAdvisory('0 0 3 * * *');
    expect(out).toContain('0 0 3 * * *');
    expect(out).toContain('full test run');
    expect(out).not.toMatch(/time\(s\)\/month/);
  });
});
