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
  };
  const keys = ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek'];

  fields.forEach((field, index) => {
    parsed[keys[index]] = parseField(field, FIELD_SPECS[index]);
  });

  return parsed;
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
