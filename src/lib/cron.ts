/**
 * Cron helpers for the `schedule` commands.
 *
 * Everything here produces human-facing text only — none of it affects when a
 * schedule fires.
 *
 * Field order is standard 5-field cron: minute hour day-of-month month day-of-week.
 * That is the format the API takes on `schedule create`/`update` and hands back
 * on `schedule get`, so an expression read from one command is valid input to
 * the other.
 */

const FIELD_COUNT = 5;

/** 365/12, which makes an hourly cron come out at exactly 730 runs/month. */
const DAYS_PER_MONTH = 365 / 12;
const WEEKS_PER_MONTH = DAYS_PER_MONTH / 7;
const MONTHS_PER_YEAR = 12;

interface FieldRange {
  min: number;
  max: number;
  /** Modulus applied to each value, for fields with two spellings of one value. */
  wrap?: number;
}

const MINUTE: FieldRange = { min: 0, max: 59 };
const HOUR: FieldRange = { min: 0, max: 23 };
const DAY_OF_MONTH: FieldRange = { min: 1, max: 31 };
const MONTH: FieldRange = { min: 1, max: 12 };
/** 0 and 7 both mean Sunday, so wrap folds them together. */
const DAY_OF_WEEK: FieldRange = { min: 0, max: 7, wrap: 7 };

const DAYS_IN_MONTH_FIELD = DAY_OF_MONTH.max - DAY_OF_MONTH.min + 1;
const DAYS_IN_WEEK = 7;

function fields(cron: string): string[] {
  return cron.trim().split(/\s+/);
}

/** True for a field naming one value, e.g. `3`. */
function isPinned(field: string | undefined): boolean {
  return field !== undefined && /^\d+$/.test(field);
}

/** True for a field that varies rather than naming one value. */
function isWildcard(field: string | undefined): boolean {
  return field === undefined || field === '*';
}

/**
 * The values a single cron field matches, or null when the field is not a shape
 * we read (month/day names, the `L`/`W`/`#` extensions, a 6-field Quartz cron).
 *
 * A set rather than a count, so overlapping lists (`1-5,3`) and the two
 * spellings of Sunday (`0,7`) are each counted once and steps are exact.
 */
function expand(field: string | undefined, range: FieldRange): Set<number> | null {
  if (field === undefined) return null;
  const out = new Set<number>();

  for (const part of field.split(',')) {
    const segments = part.split('/');
    if (segments.length > 2) return null;
    const [spec, stepText] = segments;

    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return null;
      step = Number(stepText);
      if (step < 1) return null;
    }

    let lo: number;
    let hi: number;
    if (spec === '*') {
      lo = range.min;
      hi = range.max;
    } else if (spec !== undefined && /^\d+$/.test(spec)) {
      lo = Number(spec);
      // A step on a single value means "from here to the end of the range".
      hi = stepText === undefined ? lo : range.max;
    } else {
      const bounds = /^(\d+)-(\d+)$/.exec(spec ?? '');
      if (!bounds) return null;
      lo = Number(bounds[1]);
      hi = Number(bounds[2]);
    }

    if (lo < range.min || hi > range.max || lo > hi) return null;
    for (let value = lo; value <= hi; value += step) {
      out.add(range.wrap === undefined ? value : value % range.wrap);
    }
  }

  return out.size > 0 ? out : null;
}

/**
 * Approximate number of times a cron fires per month, or null when the
 * expression is not a 5-field cron we can read.
 *
 * Every field is counted, so a cron that pins a coarse field and leaves a finer
 * one open (`* 3 * * *` — every minute of 03:00) is not mistaken for its coarse
 * unit. day-of-month and day-of-week are OR'd when both are restricted, which
 * is what standard cron does.
 */
export function runsPerMonth(cron: string): number | null {
  const f = fields(cron);
  if (f.length !== FIELD_COUNT) return null;

  const minutes = expand(f[0], MINUTE);
  const hours = expand(f[1], HOUR);
  const daysOfMonth = expand(f[2], DAY_OF_MONTH);
  const months = expand(f[3], MONTH);
  const daysOfWeek = expand(f[4], DAY_OF_WEEK);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;

  const everyDayOfMonth = daysOfMonth.size === DAYS_IN_MONTH_FIELD;
  const everyDayOfWeek = daysOfWeek.size === DAYS_IN_WEEK;

  let days: number;
  if (everyDayOfMonth && everyDayOfWeek) {
    days = DAYS_PER_MONTH;
  } else if (everyDayOfWeek) {
    // Short months make a high day number fire less often than once a month;
    // capping at the average month length is close enough for an advisory.
    days = Math.min(daysOfMonth.size, DAYS_PER_MONTH);
  } else if (everyDayOfMonth) {
    days = daysOfWeek.size * WEEKS_PER_MONTH;
  } else {
    // Restricting both means a day matching EITHER fires. Adding them can
    // double-count a day that matches both, which errs high — the safe
    // direction for a warning about cost.
    days = Math.min(daysOfMonth.size + daysOfWeek.size * WEEKS_PER_MONTH, DAYS_PER_MONTH);
  }

  return minutes.size * hours.size * days * (months.size / MONTHS_PER_YEAR);
}

/**
 * Human phrasing for a cron, or the expression itself when it names no exact
 * time — a wrong description is worse than the raw expression.
 */
export function describeCron(cron: string): string {
  const f = fields(cron);
  if (f.length !== FIELD_COUNT) return cron.trim();
  const [minute, hour, dayOfMonth, month, dayOfWeek] = f;

  if (!isPinned(minute) || !isPinned(hour)) return cron.trim();
  // A restricted month makes every phrasing below wrong, because none of them
  // can say "except in the months this cron skips": `0 3 * 6 *` is not "daily
  // at 03:00", it is daily *during June*. runsPerMonth already divides by the
  // month count, so describing it as daily contradicts the frequency printed
  // beside it in the same sentence.
  if (!isWildcard(month)) return cron.trim();
  const at = `${hour!.padStart(2, '0')}:${minute!.padStart(2, '0')}`;

  if (isWildcard(dayOfMonth) && isWildcard(dayOfWeek)) return `daily at ${at}`;
  if (isWildcard(dayOfMonth) && isPinned(dayOfWeek)) {
    return `weekly on ${dayName(Number(dayOfWeek))} at ${at}`;
  }
  if (isPinned(dayOfMonth) && isWildcard(dayOfWeek)) {
    return `monthly on day ${Number(dayOfMonth)} at ${at}`;
  }
  return cron.trim();
}

/** Whole numbers read better here than decimals; under one, say it in words. */
function frequencyClause(runs: number): string {
  if (runs < 0.5) return 'less than once a month';
  return `~${Math.round(runs)} time(s)/month`;
}

/**
 * Advisory shown before a schedule is created: how often it will run, and that
 * each run is a full test run.
 *
 * States frequency only. Credit cost is deliberately not quoted — the API does
 * not expose a per-action rate for the workspace wallet, and a figure derived
 * from anything else would be wrong. Same reason `usage` does not print a
 * "~N runs" estimate.
 *
 * An expression we cannot read still gets the advisory, without a frequency —
 * the server is the authority on the cron, so refusing to say anything about a
 * schedule we are about to create would be worse than saying less.
 */
export function formatScheduleFrequencyAdvisory(cron: string): string {
  const tail = 'Each run is a full test run. Check your balance with `testsprite usage`.';
  const runs = runsPerMonth(cron);

  if (runs === null) {
    return `This schedule will run on the cron \`${cron.trim()}\`. ${tail}`;
  }
  return `This schedule will run ${frequencyClause(runs)} (${describeCron(cron)}). ${tail}`;
}

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Cron allows both 0 and 7 for Sunday. */
function dayName(dow: number): string {
  return DAY_NAMES[dow % 7] ?? String(dow);
}
