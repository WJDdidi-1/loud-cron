import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cronMatchesDate,
  nextOccurrence,
  occurrencesBetween,
  parseCronExpression,
  previousOccurrence,
  validateCronExpression,
} from '../src/cron.mjs';

function sorted(values) {
  return [...values].sort((left, right) => left - right);
}

test('parser expands lists, ranges and steps', () => {
  const parsed = parseCronExpression('*/15 1-3,5 * * *');

  assert.deepEqual(sorted(parsed.minute), [0, 15, 30, 45]);
  assert.deepEqual(sorted(parsed.hour), [1, 2, 3, 5]);
  assert.deepEqual(sorted(parsed.dayOfMonth).length, 31);
});

test('parser normalises Sunday 7 to 0 and understands day names', () => {
  assert.deepEqual(sorted(parseCronExpression('0 0 * * 7').dayOfWeek), [0]);
  assert.deepEqual(
    sorted(parseCronExpression('0 0 * * MON-FRI').dayOfWeek),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    sorted(parseCronExpression('0 0 * JAN-mar *').month),
    [1, 2, 3],
  );
});

test('parser expands the classic aliases', () => {
  const parsed = parseCronExpression('@daily');
  assert.deepEqual(sorted(parsed.minute), [0]);
  assert.deepEqual(sorted(parsed.hour), [0]);
});

test('parser rejects empty, truncated and over-long expressions', () => {
  assert.equal(validateCronExpression('').code, 'cron_empty');
  assert.equal(validateCronExpression('* * * *').code, 'cron_truncated');
  assert.equal(validateCronExpression('* * * * * *').code, 'cron_too_many_fields');
});

test('parser rejects values, steps and ranges cron cannot represent', () => {
  assert.equal(validateCronExpression('60 * * * *').code, 'cron_out_of_range');
  assert.equal(validateCronExpression('* 24 * * *').code, 'cron_out_of_range');
  assert.equal(validateCronExpression('* * 0 * *').code, 'cron_out_of_range');
  assert.equal(validateCronExpression('* * * * MON-SUN').code, 'cron_invalid_range');
  assert.equal(validateCronExpression('1-5/0 * * * *').code, 'cron_invalid_step');
  assert.equal(validateCronExpression('1,,2 * * * *').code, 'cron_invalid');
  assert.equal(validateCronExpression('*/x * * * *').code, 'cron_invalid_step');
  assert.equal(validateCronExpression('? * * * *').code, 'cron_invalid_value');
});

test('occurrence helpers align to minute boundaries and advance strictly', () => {
  const parsed = parseCronExpression('*/15 * * * *');
  const during = new Date(2026, 0, 1, 12, 7, 30);

  assert.equal(previousOccurrence(parsed, during).getTime(), new Date(2026, 0, 1, 12, 0).getTime());
  assert.equal(nextOccurrence(parsed, during).getTime(), new Date(2026, 0, 1, 12, 15).getTime());
  assert.equal(
    nextOccurrence(parsed, new Date(2026, 0, 1, 12, 15)).getTime(),
    new Date(2026, 0, 1, 12, 30).getTime(),
  );

  const occurrences = occurrencesBetween(
    parsed,
    new Date(2026, 0, 1, 12, 0),
    new Date(2026, 0, 1, 12, 45),
  );
  assert.deepEqual(
    occurrences.map((date) => date.getMinutes()),
    [15, 30, 45],
  );
});

test('occurrence helpers cap a single reconciliation pass', () => {
  const parsed = parseCronExpression('* * * * *');
  const occurrences = occurrencesBetween(
    parsed,
    new Date(2026, 0, 1, 12, 0),
    new Date(2026, 0, 1, 13, 0),
    { limit: 3 },
  );

  assert.equal(occurrences.length, 3);
  assert.deepEqual(
    occurrences.map((date) => date.getMinutes()),
    [1, 2, 3],
  );
});

test('day-of-month and day-of-week are ORed when both are restricted', () => {
  const parsed = parseCronExpression('0 0 1 * MON');

  // 2026-01-01 is a Thursday but matches day-of-month 1.
  assert.equal(cronMatchesDate(parsed, new Date(2026, 0, 1, 0, 0)), true);
  // 2026-01-05 is a Monday but not the first.
  assert.equal(cronMatchesDate(parsed, new Date(2026, 0, 5, 0, 0)), true);
  // 2026-01-06 is a Tuesday and not the first.
  assert.equal(cronMatchesDate(parsed, new Date(2026, 0, 6, 0, 0)), false);
});

test('parser rejects expressions that can never match a real date', () => {
  assert.equal(validateCronExpression('0 0 31 2 *').code, 'cron_never_matches');
  assert.equal(validateCronExpression('0 0 30 2 *').code, 'cron_never_matches');
  assert.equal(validateCronExpression('0 0 29 2 *').ok, true);
});
