// Parsing and validation for classic five-field cron expressions.
//
// loud-cron only accepts the traditional five fields:
//
//   minute hour day-of-month month day-of-week
//
// Seconds are intentionally not supported: a six-field expression is more
// likely a mistake (or a silently unsupported extension) than a deliberate
// schedule, so it is reported instead of guessed at.

const MONTH_NAMES = new Map([
  ['JAN', 1],
  ['FEB', 2],
  ['MAR', 3],
  ['APR', 4],
  ['MAY', 5],
  ['JUN', 6],
  ['JUL', 7],
  ['AUG', 8],
  ['SEP', 9],
  ['OCT', 10],
  ['NOV', 11],
  ['DEC', 12],
]);

const MONTH_FULL_NAMES = [
  'JANUARY',
  'FEBRUARY',
  'MARCH',
  'APRIL',
  'MAY',
  'JUNE',
  'JULY',
  'AUGUST',
  'SEPTEMBER',
  'OCTOBER',
  'NOVEMBER',
  'DECEMBER',
];
MONTH_FULL_NAMES.forEach((name, index) => MONTH_NAMES.set(name, index + 1));

const DOW_NAMES = new Map([
  ['SUN', 0],
  ['MON', 1],
  ['TUE', 2],
  ['WED', 3],
  ['THU', 4],
  ['FRI', 5],
  ['SAT', 6],
]);

const DOW_FULL_NAMES = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
];
DOW_FULL_NAMES.forEach((name, index) => DOW_NAMES.set(name, index));

const FIELD_SPECS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  {
    name: 'day of week',
    min: 0,
    max: 7,
    names: DOW_NAMES,
    // Classic cron lets 7 stand for Sunday as well as 0. Normalise it so
    // matching code only ever has to think about 0-6.
    normalise: (value) => (value === 7 ? 0 : value),
  },
];

const ALIASES = new Map([
  ['@yearly', '0 0 1 1 *'],
  ['@annually', '0 0 1 1 *'],
  ['@monthly', '0 0 1 * *'],
  ['@weekly', '0 0 * * 0'],
  ['@daily', '0 0 * * *'],
  ['@midnight', '0 0 * * *'],
  ['@hourly', '0 * * * *'],
]);

export class CronParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CronParseError';
    this.code = code;
  }
}

function parseValue(text, spec) {
  const upper = text.toUpperCase();
  if (spec.names !== undefined && spec.names.has(upper)) {
    return spec.names.get(upper);
  }
  if (!/^\d+$/.test(text)) {
    throw new CronParseError(
      'cron_invalid_value',
      `${spec.name} field has invalid value "${text}" (expected a number` +
        `${spec.names === undefined ? '' : ' or a name'})`,
    );
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
    throw new CronParseError(
      'cron_out_of_range',
      `${spec.name} field value "${text}" is outside ${spec.min}-${spec.max}`,
    );
  }
  return value;
}

function parseField(text, spec) {
  const values = new Set();
  const parts = text.split(',');
  if (parts.length === 0) {
    throw new CronParseError('cron_invalid', `${spec.name} field is empty`);
  }

  for (const part of parts) {
    if (part === '') {
      throw new CronParseError(
        'cron_invalid',
        `${spec.name} field "${text}" has an empty list item`,
      );
    }

    const slash = part.indexOf('/');
    if (slash !== part.lastIndexOf('/')) {
      throw new CronParseError(
        'cron_invalid_step',
        `${spec.name} field segment "${part}" has more than one step separator`,
      );
    }

    let base = part;
    let step = 1;
    if (slash !== -1) {
      const stepText = part.slice(slash + 1);
      base = part.slice(0, slash);
      if (!/^\d+$/.test(stepText)) {
        throw new CronParseError(
          'cron_invalid_step',
          `${spec.name} field segment "${part}" has an invalid step "${stepText}"`,
        );
      }
      step = Number(stepText);
      if (!Number.isSafeInteger(step) || step < 1) {
        throw new CronParseError(
          'cron_invalid_step',
          `${spec.name} field segment "${part}" must use a step of at least 1`,
        );
      }
      if (base === '') {
        throw new CronParseError(
          'cron_invalid',
          `${spec.name} field segment "${part}" is missing a value before "/"`,
        );
      }
    }

    let start;
    let end;
    if (base === '*') {
      start = spec.min;
      end = spec.max;
    } else if (base.includes('-')) {
      const rangeParts = base.split('-');
      if (rangeParts.length !== 2 || rangeParts[0] === '' || rangeParts[1] === '') {
        throw new CronParseError(
          'cron_invalid_range',
          `${spec.name} field segment "${part}" is not a valid range`,
        );
      }
      start = parseValue(rangeParts[0], spec);
      end = parseValue(rangeParts[1], spec);
      if (start > end) {
        throw new CronParseError(
          'cron_invalid_range',
          `${spec.name} field range "${base}" is reversed (${start} > ${end})`,
        );
      }
    } else {
      start = parseValue(base, spec);
      end = slash === -1 ? start : spec.max;
    }

    for (let value = start; value <= end; value += step) {
      const normalised = spec.normalise === undefined ? value : spec.normalise(value);
      values.add(normalised);
    }
  }

  if (values.size === 0) {
    throw new CronParseError('cron_invalid', `${spec.name} field matches no values`);
  }
  return values;
}

/**
 * Parse a five-field cron expression.
 *
 * @returns {{source: string, minute: Set<number>, hour: Set<number>,
 *   dayOfMonth: Set<number>, month: Set<number>, dayOfWeek: Set<number>}}
 * @throws {CronParseError} when the expression cannot be parsed.
 */
export function parseCronExpression(input) {
  if (typeof input !== 'string') {
    throw new CronParseError('cron_invalid_type', 'cron expression must be a string');
  }

  const source = input.trim();
  if (source === '') {
    throw new CronParseError('cron_empty', 'cron expression is empty');
  }

  const lower = source.toLowerCase();
  if (lower.startsWith('@')) {
    const expanded = ALIASES.get(lower);
    if (expanded === undefined) {
      throw new CronParseError(
        'cron_unknown_alias',
        `unknown cron alias "${source}" (known aliases: ${[...ALIASES.keys()].join(', ')})`,
      );
    }
    return parseCronExpression(expanded);
  }

  const fields = source.split(/\s+/);
  if (fields.length < FIELD_SPECS.length) {
    throw new CronParseError(
      'cron_truncated',
      `cron expression has ${fields.length} field${fields.length === 1 ? '' : 's'}; ` +
        `expected ${FIELD_SPECS.length} (minute hour day-of-month month day-of-week)`,
    );
  }
  if (fields.length > FIELD_SPECS.length) {
    throw new CronParseError(
      'cron_too_many_fields',
      `cron expression has ${fields.length} fields; expected ${FIELD_SPECS.length} ` +
        '(seconds are not supported)',
    );
  }

  const parsed = {
    source,
    minute: undefined,
    hour: undefined,
    dayOfMonth: undefined,
    month: undefined,
    dayOfWeek: undefined,
    // Classic cron ORs day-of-month and day-of-week when both are restricted.
    // A leading "*" means the field is unrestricted even if it has a step.
    dayOfMonthRestricted: !fields[2].startsWith('*'),
    dayOfWeekRestricted: !fields[4].startsWith('*'),
  };
  const keys = ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek'];

  fields.forEach((field, index) => {
    parsed[keys[index]] = parseField(field, FIELD_SPECS[index]);
  });

  // A syntactically valid expression can still never fire (for example
  // "0 0 31 2 *" - February never has 31 days). Silently accepting it would
  // reproduce exactly the silent-skip problem loud-cron exists to report.
  if (nextOccurrence(parsed, new Date(2000, 0, 1, 0, 0, 0, 0)) === null) {
    throw new CronParseError(
      'cron_never_matches',
      `cron expression "${source}" does not match any real date`,
    );
  }

  return parsed;
}

function sorted(values) {
  return [...values].sort((left, right) => left - right);
}

function cronDayMatches(parsed, date) {
  const domMatch = parsed.dayOfMonth.has(date.getDate());
  const dowMatch = parsed.dayOfWeek.has(date.getDay());
  if (parsed.dayOfMonthRestricted === true && parsed.dayOfWeekRestricted === true) {
    return domMatch || dowMatch;
  }
  return domMatch && dowMatch;
}

/**
 * Does `date` fall on a minute matched by the parsed expression?
 *
 * Schedules are evaluated in the host's local time, matching classic cron.
 */
export function cronMatchesDate(parsed, date) {
  if (Number.isNaN(date.getTime())) return false;
  if (!parsed.minute.has(date.getMinutes())) return false;
  if (!parsed.hour.has(date.getHours())) return false;
  if (!parsed.month.has(date.getMonth() + 1)) return false;
  return cronDayMatches(parsed, date);
}

/**
 * First occurrence strictly after `after`, at minute resolution.
 *
 * Returns null when no occurrence exists within eight years (a schedule that
 * can never fire, such as April 31).
 */
export function nextOccurrence(parsed, after) {
  if (!(after instanceof Date) || Number.isNaN(after.getTime())) return null;

  // Occurrences are minute-aligned. Move to the first minute strictly after
  // `after` so calling nextOccurrence(occurrence) always advances.
  const start = new Date(after.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const hours = sorted(parsed.hour);
  const minutes = sorted(parsed.minute);
  let day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const maxDays = 366 * 8 + 1;

  for (let index = 0; index < maxDays; index += 1) {
    if (parsed.month.has(day.getMonth() + 1) && cronDayMatches(parsed, day)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const candidate = new Date(
            day.getFullYear(),
            day.getMonth(),
            day.getDate(),
            hour,
            minute,
            0,
            0,
          );
          if (candidate.getTime() < start.getTime()) continue;
          // Guard against DST shifting the constructed wall-clock time.
          if (!cronMatchesDate(parsed, candidate)) continue;
          return candidate;
        }
      }
    }
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  }

  return null;
}

/**
 * Most recent occurrence at or before `at`.
 *
 * Returns null when no occurrence exists in the previous eight years.
 */
export function previousOccurrence(parsed, at) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return null;

  const hours = sorted(parsed.hour);
  const minutes = sorted(parsed.minute);
  let day = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const maxDays = 366 * 8 + 1;

  for (let index = 0; index < maxDays; index += 1) {
    const sameDay =
      day.getFullYear() === at.getFullYear() &&
      day.getMonth() === at.getMonth() &&
      day.getDate() === at.getDate();

    if (parsed.month.has(day.getMonth() + 1) && cronDayMatches(parsed, day)) {
      for (let hIndex = hours.length - 1; hIndex >= 0; hIndex -= 1) {
        const hour = hours[hIndex];
        if (sameDay && hour > at.getHours()) continue;
        for (let mIndex = minutes.length - 1; mIndex >= 0; mIndex -= 1) {
          const minute = minutes[mIndex];
          if (sameDay && hour === at.getHours() && minute > at.getMinutes()) {
            continue;
          }
          const candidate = new Date(
            day.getFullYear(),
            day.getMonth(),
            day.getDate(),
            hour,
            minute,
            0,
            0,
          );
          if (candidate.getTime() > at.getTime()) continue;
          if (!cronMatchesDate(parsed, candidate)) continue;
          return candidate;
        }
      }
    }
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1);
  }

  return null;
}

/**
 * Occurrences in `(afterExclusive, toInclusive]`, oldest first.
 *
 * `limit` protects the ledger from an unbounded catch-up after a very long
 * outage. The next reconcile continues from the newest record written.
 */
export function occurrencesBetween(
  parsed,
  afterExclusive,
  toInclusive,
  { limit = 10000 } = {},
) {
  const occurrences = [];
  if (
    !(afterExclusive instanceof Date) ||
    !(toInclusive instanceof Date) ||
    Number.isNaN(afterExclusive.getTime()) ||
    Number.isNaN(toInclusive.getTime()) ||
    toInclusive.getTime() <= afterExclusive.getTime()
  ) {
    return occurrences;
  }

  let cursor = afterExclusive;
  while (occurrences.length < limit) {
    const next = nextOccurrence(parsed, cursor);
    if (next === null || next.getTime() > toInclusive.getTime()) break;
    occurrences.push(next);
    cursor = next;
  }
  return occurrences;
}

/**
 * Non-throwing wrapper used by the jobs-file validator.
 */
export function validateCronExpression(input) {
  try {
    return { ok: true, parsed: parseCronExpression(input) };
  } catch (error) {
    if (error instanceof CronParseError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}
