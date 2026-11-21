import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCronExpression,
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
