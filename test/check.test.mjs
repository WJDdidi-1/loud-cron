import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const bin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'loud-cron.mjs',
);

function run(args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
}

function check(content, extraArgs = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'loud-cron-check-'));
  try {
    const file = path.join(dir, 'jobs.json');
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    const result = run(['check', file, ...extraArgs]);
    let json = null;
    if (result.stdout.trim() !== '') json = JSON.parse(result.stdout);
    return { ...result, json, file };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function codes(json) {
  return json.errors.map((error) => error.code);
}

test('check accepts a valid jobs object with the documented optional fields', () => {
  const result = check({
    version: 1,
    jobs: [
      {
        id: 'fast',
        schedule: '*/15 * * * *',
        command: 'node -e "console.log(1)"',
        description: 'every fifteen minutes',
        cwd: '/tmp',
        env: { NODE_ENV: 'test' },
        timeoutMs: 30000,
        enabled: true,
        shell: true,
        overlap: 'skip',
      },
      {
        id: 'named',
        schedule: '0 2 * JAN MON-FRI',
        command: 'echo named',
        timeout: '5m',
      },
      {
        id: 'aliased',
        cron: '@daily',
        command: 'echo alias',
      },
    ],
  });

  assert.equal(result.status, 0);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.jobCount, 3);
  assert.deepEqual(result.json.errors, []);
});

test('check accepts a bare array of jobs and --json flag', () => {
  const result = check(
    [{ id: 'one', schedule: '0 * * * *', command: 'echo one' }],
    ['--json'],
  );

  assert.equal(result.status, 0);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.jobCount, 1);
});

test('check rejects invalid JSON with a JSON error', () => {
  const result = check('{ "jobs": [');

  assert.equal(result.status, 1);
  assert.equal(result.json.ok, false);
  assert.deepEqual(codes(result.json), ['invalid_json']);
});

test('check rejects truncated and empty cron expressions', () => {
  const result = check({
    jobs: [
      { id: 'short', schedule: '0 2 * *', command: 'echo short' },
      { id: 'empty', schedule: '', command: 'echo empty' },
    ],
  });

  assert.equal(result.status, 1);
  assert.equal(result.json.ok, false);
  assert.deepEqual(codes(result.json), ['cron_truncated', 'cron_empty']);
  assert.deepEqual(
    result.json.errors.map((error) => error.path),
    ['jobs[0].schedule', 'jobs[1].schedule'],
  );
});

test('check rejects a six-field expression instead of guessing at seconds', () => {
  const result = check({
    jobs: [{ id: 'seconds', schedule: '0 0 2 * * *', command: 'echo nope' }],
  });

  assert.equal(result.status, 1);
  assert.deepEqual(codes(result.json), ['cron_too_many_fields']);
});

test('check rejects out-of-range values, bad steps, reversed ranges and aliases', () => {
  const result = check({
    jobs: [
      { id: 'minute', schedule: '60 * * * *', command: 'echo x' },
      { id: 'month', schedule: '0 0 * 13 *', command: 'echo x' },
      { id: 'step', schedule: '*/0 * * * *', command: 'echo x' },
      { id: 'range', schedule: '0 0 * * 5-1', command: 'echo x' },
      { id: 'alias', schedule: '@reboot', command: 'echo x' },
    ],
  });

  assert.equal(result.status, 1);
  assert.deepEqual(codes(result.json), [
    'cron_out_of_range',
    'cron_out_of_range',
    'cron_invalid_step',
    'cron_invalid_range',
    'cron_unknown_alias',
  ]);
});

test('check reports duplicate job IDs with both locations', () => {
  const result = check({
    jobs: [
      { id: 'same', schedule: '0 * * * *', command: 'echo first' },
      { id: 'same', schedule: '0 * * * *', command: 'echo second' },
    ],
  });

  assert.equal(result.status, 1);
  assert.deepEqual(codes(result.json), ['duplicate_id']);
  assert.equal(result.json.errors[0].path, 'jobs[1].id');
  assert.match(result.json.errors[0].message, /jobs\[0\]/);
});

test('check rejects unknown fields at the top level and on a job', () => {
  const result = check({
    extraTopLevel: true,
    jobs: [
      {
        id: 'typo',
        schedule: '0 * * * *',
        command: 'echo typo',
        typo: 'silently ignored would be bad',
      },
    ],
  });

  assert.equal(result.status, 1);
  assert.deepEqual(codes(result.json), ['unknown_field', 'unknown_field']);
  assert.deepEqual(
    result.json.errors.map((error) => error.path),
    ['extraTopLevel', 'jobs[0].typo'],
  );
});

test('check rejects missing and empty commands', () => {
  const result = check({
    jobs: [
      { id: 'absent', schedule: '0 * * * *' },
      { id: 'blank', schedule: '0 * * * *', command: '   ' },
      { id: 'not-string', schedule: '0 * * * *', command: ['echo', 'x'] },
    ],
  });

  assert.equal(result.status, 1);
  assert.deepEqual(codes(result.json), [
    'missing_command',
    'missing_command',
    'invalid_field',
  ]);
});

test('check rejects missing IDs and missing schedules', () => {
  const result = check({
    jobs: [
      { schedule: '0 * * * *', command: 'echo no id' },
      { id: 'no-schedule', command: 'echo no schedule' },
    ],
  });

  assert.equal(result.status, 1);
  assert.deepEqual(codes(result.json), ['missing_id', 'missing_schedule']);
});

test('check rejects invalid optional fields and schedule aliases that conflict', () => {
  const result = check({
    jobs: [
      {
        id: 'conflict',
        schedule: '0 * * * *',
        cron: '0 * * * *',
        command: 'echo conflict',
      },
      {
        id: 'optional',
        schedule: '0 * * * *',
        command: 'echo optional',
        description: 1,
        cwd: '',
        env: { GOOD: 'value', BAD: 2 },
        timeoutMs: 0,
        timeout: '0s',
        enabled: 'yes',
        shell: '',
        overlap: 'sometimes',
      },
    ],
  });

  assert.equal(result.status, 1);
  assert.deepEqual(codes(result.json).sort(), [
    'conflicting_field',
    'invalid_field',
    'invalid_field',
    'invalid_field',
    'invalid_field',
    'invalid_field',
    'invalid_field',
    'invalid_field',
    'invalid_field',
  ]);
});

test('check rejects timeout durations the runner could not enforce', () => {
  const rejected = check({
    jobs: [
      {
        id: 'tiny',
        schedule: '0 * * * *',
        command: 'echo tiny',
        timeout: '0.1ms',
      },
      {
        id: 'overflow',
        schedule: '0 * * * *',
        command: 'echo overflow',
        timeout: '999999999999999999999d',
      },
    ],
  });

  assert.equal(rejected.status, 1);
  assert.deepEqual(codes(rejected.json), ['invalid_field', 'invalid_field']);

  // A fractional duration that still rounds to a positive millisecond is fine.
  const accepted = check({
    jobs: [
      {
        id: 'half',
        schedule: '0 * * * *',
        command: 'echo half',
        timeout: '0.5ms',
      },
    ],
  });
  assert.equal(accepted.status, 0);
  assert.deepEqual(accepted.json.errors, []);
});

test('check enforces the top-level document shape', () => {
  const empty = check('[]');
  assert.equal(empty.status, 0);
  assert.equal(empty.json.jobCount, 0);
  assert.deepEqual(codes(empty.json), []);

  const missing = check({});
  assert.equal(missing.status, 1);
  assert.deepEqual(codes(missing.json), ['missing_jobs']);

  const wrongJobsType = check({ jobs: {} });
  assert.equal(wrongJobsType.status, 1);
  assert.deepEqual(codes(wrongJobsType.json), ['invalid_field']);

  const wrongJobType = check({ jobs: [null] });
  assert.equal(wrongJobType.status, 1);
  assert.deepEqual(codes(wrongJobType.json), ['invalid_job']);
});

test('check reports every problem it can find in one pass', () => {
  const result = check({
    jobs: [
      {
        id: 'dup',
        schedule: '0 * * * *',
        command: 'echo first',
        unknownA: 1,
      },
      {
        id: 'dup',
        schedule: '0 * * *',
        unknownB: 2,
      },
    ],
  });

  assert.equal(result.status, 1);
  assert.deepEqual(codes(result.json).sort(), [
    'cron_truncated',
    'duplicate_id',
    'missing_command',
    'unknown_field',
    'unknown_field',
  ]);
});

test('check reports an unreadable jobs file as JSON', () => {
  const result = run(['check', path.join(tmpdir(), 'loud-cron-does-not-exist.json')]);

  assert.equal(result.status, 1);
  const json = JSON.parse(result.stdout);
  assert.equal(json.ok, false);
  assert.deepEqual(codes(json), ['file_not_found']);
});

test('check usage errors exit 2', () => {
  const result = run(['check']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /exactly one jobs file/);
});

test('check rejects a cron expression that can never match a real date', () => {
  const result = check({
    jobs: [{ id: 'never', schedule: '0 0 31 2 *', command: 'echo never' }],
  });

  assert.equal(result.status, 1);
  assert.deepEqual(codes(result.json), ['cron_never_matches']);
  assert.equal(result.json.errors[0].path, 'jobs[0].schedule');
});
