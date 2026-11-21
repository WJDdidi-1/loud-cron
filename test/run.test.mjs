import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { lockPathFor } from '../src/runner.mjs';
import {
  MARKER_COMMAND,
  bin as binForRun,
  jsonOutput,
  makeWorkspace,
  readLedger,
  runCli,
  writeLedger,
} from './helpers.mjs';

const T0 = '2026-01-01T12:00:00.000Z';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch {
      // the runner may be between write and fsync; retry
    }
    await sleep(50);
  }
  throw new Error('timed out waiting for the runner');
}

function markerJob(workspace, overrides = {}) {
  return {
    id: 'fast',
    schedule: '* * * * *',
    command: MARKER_COMMAND,
    env: { MARKER: path.join(workspace.directory, 'marker.txt') },
    ...overrides,
  };
}

function markerContents(workspace) {
  const file = path.join(workspace.directory, 'marker.txt');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

test('run executes the newest due job through the shell and appends an fsynced JSONL ledger', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify({ jobs: [markerJob(workspace)] }, null, 2),
    );

    const first = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);

    assert.equal(first.status, 0, first.stderr);
    const firstJson = jsonOutput(first);
    assert.equal(firstJson.ok, true);
    assert.equal(firstJson.executed, 1);
    assert.equal(firstJson.missed, 0);
    assert.equal(firstJson.results[0].status, 'ok');
    assert.equal(markerContents(workspace), 'x');

    const records = readLedger(workspace.ledger);
    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record.jobId, 'fast');
    assert.equal(record.scheduledFor, T0);
    assert.equal(record.status, 'ok');
    assert.equal(record.exitCode, 0);
    assert.equal(record.attempt, 1);
    assert.equal(typeof record.durationMs, 'number');
    assert.ok(record.durationMs >= 0);
    assert.ok(Number.isFinite(Date.parse(record.startedAt)));
    assert.ok(Number.isFinite(Date.parse(record.finishedAt)));

    // A second process appends rather than replacing, and attempts advance.
    const second = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      '2026-01-01T12:01:00.000Z',
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(jsonOutput(second).results[0].status, 'ok');
    const appended = readLedger(workspace.ledger);
    assert.equal(appended.length, 2);
    assert.deepEqual(
      appended.map((item) => item.scheduledFor),
      [T0, '2026-01-01T12:01:00.000Z'],
    );
    assert.deepEqual(
      appended.map((item) => item.attempt),
      [1, 2],
    );
    assert.equal(markerContents(workspace), 'xx');
  } finally {
    workspace.cleanup();
  }
});

test('tick reconciles the gap since the newest ledger record and doctor reports it', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify(
        { jobs: [markerJob(workspace, { schedule: '*/5 * * * *' })] },
        null,
        2,
      ),
    );

    const ran = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(markerContents(workspace), 'x');

    const tick = runCli([
      'tick',
      workspace.jobsFile,
      '--now',
      '2026-01-01T12:10:00.000Z',
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(tick.status, 0, tick.stderr);
    const tickJson = jsonOutput(tick);
    assert.equal(tickJson.executed, 0);
    assert.equal(tickJson.missed, 2);
    assert.deepEqual(
      tickJson.results.map((result) => result.scheduledFor),
      ['2026-01-01T12:05:00.000Z', '2026-01-01T12:10:00.000Z'],
    );
    assert.deepEqual(
      tickJson.results.map((result) => result.status),
      ['missed', 'missed'],
    );
    // tick must not execute the command.
    assert.equal(markerContents(workspace), 'x');

    const records = readLedger(workspace.ledger);
    assert.deepEqual(
      records.map((record) => record.status),
      ['ok', 'missed', 'missed'],
    );

    const doctor = runCli([
      'doctor',
      workspace.jobsFile,
      '--now',
      '2026-01-01T12:10:00.000Z',
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(doctor.status, 1);
    const doctorJson = jsonOutput(doctor);
    assert.equal(doctorJson.ok, false);
    assert.equal(doctorJson.jobs[0].status, 'missed');
    assert.ok(doctorJson.problems.some((problem) => problem.code === 'missed_run'));
  } finally {
    workspace.cleanup();
  }
});

test('run records missed occurrences after a restart instead of skipping them', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify(
        { jobs: [markerJob(workspace, { schedule: '*/5 * * * *' })] },
        null,
        2,
      ),
    );
    writeLedger(workspace.ledger, [
      {
        jobId: 'fast',
        scheduledFor: T0,
        startedAt: T0,
        finishedAt: T0,
        durationMs: 0,
        exitCode: 0,
        status: 'ok',
        attempt: 1,
      },
    ]);

    // The runner was gone at 12:05 and 12:10 and comes back at 12:10:30.
    const restarted = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      '2026-01-01T12:10:30.000Z',
      '--grace',
      '1s',
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(restarted.status, 0, restarted.stderr);
    const restartedJson = jsonOutput(restarted);
    assert.equal(restartedJson.executed, 0);
    assert.equal(restartedJson.missed, 2);
    assert.deepEqual(
      restartedJson.results.map((result) => result.status),
      ['missed', 'missed'],
    );
    assert.equal(markerContents(workspace), '');

    const records = readLedger(workspace.ledger);
    assert.deepEqual(
      records.map((record) => [record.scheduledFor, record.status]),
      [
        [T0, 'ok'],
        ['2026-01-01T12:05:00.000Z', 'missed'],
        ['2026-01-01T12:10:00.000Z', 'missed'],
      ],
    );
  } finally {
    workspace.cleanup();
  }
});

test('run executes the newest on-time occurrence and records older ones as missed', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify(
        { jobs: [markerJob(workspace, { schedule: '*/5 * * * *' })] },
        null,
        2,
      ),
    );
    writeLedger(workspace.ledger, [
      { jobId: 'fast', scheduledFor: T0, status: 'ok', attempt: 1 },
    ]);

    const result = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      '2026-01-01T12:10:05.000Z',
      '--grace',
      '30s',
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const summary = jsonOutput(result);
    assert.equal(summary.missed, 1);
    assert.equal(summary.executed, 1);
    assert.deepEqual(
      summary.results.map((item) => item.status),
      ['missed', 'ok'],
    );
    assert.equal(markerContents(workspace), 'x');
  } finally {
    workspace.cleanup();
  }
});

test('a hung job is killed at its timeout and recorded as timeout', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify(
        {
          jobs: [
            {
              id: 'hang',
              schedule: '* * * * *',
              command: 'node -e "setInterval(()=>{},1000)"',
              timeout: '300ms',
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const summary = jsonOutput(result);
    assert.equal(summary.results[0].status, 'timeout');
    assert.ok(summary.results[0].durationMs >= 250);

    const [record] = readLedger(workspace.ledger);
    assert.equal(record.status, 'timeout');
    assert.equal(record.timedOut, true);
    assert.equal(record.exitCode, null);
    assert.match(record.reason, /timeout/u);

    const doctor = runCli([
      'doctor',
      workspace.jobsFile,
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(doctor.status, 1);
    assert.ok(jsonOutput(doctor).problems.some((problem) => problem.code === 'timed_out'));
  } finally {
    workspace.cleanup();
  }
});

test(
  'timeout sends SIGTERM before SIGKILL',
  { skip: process.platform === 'win32' ? 'POSIX signals are used on Unix only' : false },
  () => {
    const workspace = makeWorkspace([]);
    try {
      const marker = path.join(workspace.directory, 'marker.txt');
      writeFileSync(
        workspace.jobsFile,
        JSON.stringify(
          {
            jobs: [
              {
                id: 'stubborn',
                schedule: '* * * * *',
                command:
                  'node -e "process.on(\'SIGTERM\',()=>{require(\'fs\').writeFileSync(process.env.MARKER,\'term\')});setInterval(()=>{},1000)"',
                env: { MARKER: marker },
                timeout: '200ms',
              },
            ],
          },
          null,
          2,
        ),
      );

      const result = runCli([
        'run',
        workspace.jobsFile,
        '--once',
        '--now',
        T0,
        '--kill-grace',
        '300ms',
        '--ledger',
        workspace.ledger,
        '--json',
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(marker, 'utf8'), 'term');
      const [record] = readLedger(workspace.ledger);
      assert.equal(record.status, 'timeout');
      assert.equal(record.signal, 'SIGKILL');
    } finally {
      workspace.cleanup();
    }
  },
);

test('a live overlap lock records overlap and leaves the running job alone', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify(
        { jobs: [markerJob(workspace, { id: 'busy', overlap: 'skip' })] },
        null,
        2,
      ),
    );
    const lockFile = lockPathFor(workspace.ledger, 'busy');
    mkdirSync(path.dirname(lockFile), { recursive: true });
    writeFileSync(
      lockFile,
      JSON.stringify({
        jobId: 'busy',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        scheduledFor: T0,
        token: 'held-by-test',
      }),
    );

    const result = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(jsonOutput(result).results[0].status, 'overlap');
    assert.equal(markerContents(workspace), '');
    assert.ok(existsSync(lockFile), 'the live holder lock must survive');

    const [record] = readLedger(workspace.ledger);
    assert.equal(record.status, 'overlap');
    assert.equal(record.exitCode, null);

    const doctor = runCli([
      'doctor',
      workspace.jobsFile,
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(doctor.status, 1);
    assert.ok(jsonOutput(doctor).problems.some((problem) => problem.code === 'overlapped'));

    unlinkSync(lockFile);
    const next = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      '2026-01-01T12:01:00.000Z',
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(next.status, 0, next.stderr);
    assert.equal(jsonOutput(next).results[0].status, 'ok');
    assert.equal(markerContents(workspace), 'x');
    assert.equal(existsSync(lockFile), false);
  } finally {
    workspace.cleanup();
  }
});

test('a stale lock from a dead process is reclaimed', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify({ jobs: [markerJob(workspace, { id: 'stale' })] }, null, 2),
    );
    const dead = spawnSync(process.execPath, ['-e', '']);
    const lockFile = lockPathFor(workspace.ledger, 'stale');
    mkdirSync(path.dirname(lockFile), { recursive: true });
    writeFileSync(
      lockFile,
      JSON.stringify({
        jobId: 'stale',
        pid: dead.pid,
        startedAt: new Date().toISOString(),
        scheduledFor: T0,
        token: 'dead-holder',
      }),
    );

    const result = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(jsonOutput(result).results[0].status, 'ok');
    assert.equal(readLedger(workspace.ledger)[0].status, 'ok');
    assert.equal(existsSync(lockFile), false);
    assert.equal(markerContents(workspace), 'x');
  } finally {
    workspace.cleanup();
  }
});

test('a corrupt ledger is reported and blocks new appends', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify({ jobs: [markerJob(workspace)] }, null, 2),
    );
    mkdirSync(path.dirname(workspace.ledger), { recursive: true });
    writeFileSync(workspace.ledger, '{"jobId":"fast","scheduledFor":\n');

    const result = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(result.status, 1);
    const json = jsonOutput(result);
    assert.equal(json.ok, false);
    assert.equal(json.errors[0].code, 'ledger_corrupt');
    assert.equal(markerContents(workspace), '');

    const doctor = runCli([
      'doctor',
      workspace.jobsFile,
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(doctor.status, 1);
    assert.ok(
      jsonOutput(doctor).problems.some((problem) => problem.code === 'ledger_corrupt'),
    );
  } finally {
    workspace.cleanup();
  }
});

test('job output goes to stderr so --json stdout stays parseable', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify(
        {
          jobs: [
            {
              id: 'chatty',
              schedule: '* * * * *',
              command: 'node -e "console.log(\'job-says-hi\')"',
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(jsonOutput(result).results[0].status, 'ok');
    assert.match(result.stderr, /job-says-hi/u);
  } finally {
    workspace.cleanup();
  }
});

test('disabled jobs are skipped by run and by doctor', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify(
        {
          jobs: [
            markerJob(workspace, {
              id: 'paused',
              schedule: '* * * * *',
              enabled: false,
            }),
          ],
        },
        null,
        2,
      ),
    );

    const run = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(run.status, 0, run.stderr);
    const summary = jsonOutput(run);
    assert.equal(summary.executed, 0);
    assert.equal(summary.results[0].status, 'disabled');
    assert.equal(markerContents(workspace), '');
    assert.equal(existsSync(workspace.ledger), false);

    const doctor = runCli([
      'doctor',
      workspace.jobsFile,
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(jsonOutput(doctor).jobs[0].status, 'disabled');
  } finally {
    workspace.cleanup();
  }
});

test('--since bounds the reconciliation window', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify({ jobs: [markerJob(workspace)] }, null, 2),
    );

    const tick = runCli([
      'tick',
      workspace.jobsFile,
      '--now',
      '2026-01-01T12:10:00.000Z',
      '--since',
      '2026-01-01T12:08:00.000Z',
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(tick.status, 0, tick.stderr);
    const summary = jsonOutput(tick);
    assert.equal(summary.missed, 2);
    assert.deepEqual(
      summary.results.map((result) => result.scheduledFor),
      ['2026-01-01T12:09:00.000Z', '2026-01-01T12:10:00.000Z'],
    );
    assert.equal(markerContents(workspace), '');
  } finally {
    workspace.cleanup();
  }
});

test('a first run executes the most recent due occurrence even when it is older than grace', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify(
        { jobs: [markerJob(workspace, { schedule: '*/15 * * * *' })] },
        null,
        2,
      ),
    );

    const result = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      '2026-01-01T12:07:00.000Z',
      '--grace',
      '1s',
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    const summary = jsonOutput(result);
    assert.equal(summary.executed, 1);
    assert.equal(summary.missed, 0);
    assert.equal(summary.results[0].scheduledFor, T0);
    assert.equal(summary.results[0].status, 'ok');
    assert.equal(markerContents(workspace), 'x');
  } finally {
    workspace.cleanup();
  }
});

test('run executes commands through the shell, not as a bare executable', () => {
  const workspace = makeWorkspace([]);
  try {
    const marker = path.join(workspace.directory, 'marker.txt');
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify(
        {
          jobs: [
            {
              id: 'shell',
              schedule: '* * * * *',
              command:
                'node -e "require(\'fs\').appendFileSync(process.env.MARKER,\'a\')" && ' +
                'node -e "require(\'fs\').appendFileSync(process.env.MARKER,\'b\')"',
              env: { MARKER: marker },
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(jsonOutput(result).results[0].status, 'ok');
    assert.equal(readFileSync(marker, 'utf8'), 'ab');
  } finally {
    workspace.cleanup();
  }
});

test('run applies cwd and env to the spawned command', () => {
  const workspace = makeWorkspace([]);
  try {
    const subdirectory = path.join(workspace.directory, 'sub');
    mkdirSync(subdirectory);
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify(
        {
          jobs: [
            {
              id: 'context',
              schedule: '* * * * *',
              command:
                'node -e "require(\'fs\').writeFileSync(\'context.txt\', process.env.GREETING)"',
              cwd: 'sub',
              env: { GREETING: 'hello-from-env' },
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = runCli(
      [
        'run',
        workspace.jobsFile,
        '--once',
        '--now',
        T0,
        '--ledger',
        workspace.ledger,
        '--json',
      ],
      { cwd: workspace.directory },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(jsonOutput(result).results[0].status, 'ok');
    assert.equal(
      readFileSync(path.join(subdirectory, 'context.txt'), 'utf8'),
      'hello-from-env',
    );
  } finally {
    workspace.cleanup();
  }
});

test('run records error when a shell:false command cannot be started', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify(
        {
          jobs: [
            {
              id: 'missing-binary',
              schedule: '* * * * *',
              command: path.join(workspace.directory, 'definitely-not-a-real-binary'),
              shell: false,
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(jsonOutput(result).results[0].status, 'error');

    const [record] = readLedger(workspace.ledger);
    assert.equal(record.status, 'error');
    assert.equal(record.exitCode, null);
    assert.match(record.reason, /ENOENT/u);

    const doctor = runCli([
      'doctor',
      workspace.jobsFile,
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(doctor.status, 1);
    assert.ok(jsonOutput(doctor).problems.some((problem) => problem.code === 'run_error'));
  } finally {
    workspace.cleanup();
  }
});

test('a numeric timeoutMs is enforced and recorded as timeout', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify(
        {
          jobs: [
            {
              id: 'numeric-timeout',
              schedule: '* * * * *',
              command: 'node -e "setInterval(()=>{},1000)"',
              timeoutMs: 200,
            },
          ],
        },
        null,
        2,
      ),
    );

    const result = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(jsonOutput(result).results[0].status, 'timeout');

    const [record] = readLedger(workspace.ledger);
    assert.equal(record.status, 'timeout');
    assert.equal(record.timedOut, true);
    assert.match(record.reason, /200ms timeout/u);
  } finally {
    workspace.cleanup();
  }
});

test('overlap: allow ignores a held lock and runs the job', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify(
        {
          jobs: [
            markerJob(workspace, {
              id: 'concurrent',
              overlap: 'allow',
            }),
          ],
        },
        null,
        2,
      ),
    );
    const lockFile = lockPathFor(workspace.ledger, 'concurrent');
    mkdirSync(path.dirname(lockFile), { recursive: true });
    writeFileSync(
      lockFile,
      JSON.stringify({
        jobId: 'concurrent',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        scheduledFor: T0,
        token: 'held-by-test',
      }),
    );

    const result = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(jsonOutput(result).results[0].status, 'ok');
    assert.equal(markerContents(workspace), 'x');
    assert.equal(readLedger(workspace.ledger)[0].status, 'ok');
    // overlap: allow neither waits for nor removes another holder's lock.
    assert.ok(existsSync(lockFile));
  } finally {
    workspace.cleanup();
  }
});

test(
  'a custom shell path is used to execute the command',
  { skip: process.platform === 'win32' ? 'POSIX shell path' : false },
  () => {
    const workspace = makeWorkspace([]);
    try {
      const marker = path.join(workspace.directory, 'marker.txt');
      const customShellMarker = path.join(workspace.directory, 'custom-shell.txt');
      const shellPath = path.join(workspace.directory, 'custom-shell.sh');
      writeFileSync(
        shellPath,
        '#!/bin/sh\nprintf custom >> "$CUSTOM_SHELL_MARKER"\nexec /bin/sh "$@"\n',
      );
      chmodSync(shellPath, 0o755);
      writeFileSync(
        workspace.jobsFile,
        JSON.stringify(
          {
            jobs: [
              {
                id: 'custom-shell',
                schedule: '* * * * *',
                command: MARKER_COMMAND,
                env: { MARKER: marker, CUSTOM_SHELL_MARKER: customShellMarker },
                shell: shellPath,
              },
            ],
          },
          null,
          2,
        ),
      );

      const result = runCli([
        'run',
        workspace.jobsFile,
        '--once',
        '--now',
        T0,
        '--ledger',
        workspace.ledger,
        '--json',
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(jsonOutput(result).results[0].status, 'ok');
      assert.equal(markerContents(workspace), 'x');
      assert.equal(readFileSync(customShellMarker, 'utf8'), 'custom');
    } finally {
      workspace.cleanup();
    }
  },
);

test('run refuses an invalid jobs file and executes nothing', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify(
        {
          jobs: [
            markerJob(workspace, { id: 'duplicate' }),
            markerJob(workspace, { id: 'duplicate' }),
          ],
        },
        null,
        2,
      ),
    );

    const result = runCli([
      'run',
      workspace.jobsFile,
      '--once',
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(result.status, 1);
    const failure = jsonOutput(result);
    assert.equal(failure.ok, false);
    assert.ok(failure.errors.some((error) => error.code === 'duplicate_id'));
    assert.equal(markerContents(workspace), '');
    assert.equal(existsSync(workspace.ledger), false);
  } finally {
    workspace.cleanup();
  }
});

test('tick on a fresh install records the newest occurrence as missed', () => {
  const workspace = makeWorkspace([]);
  try {
    writeFileSync(
      workspace.jobsFile,
      JSON.stringify(
        { jobs: [markerJob(workspace, { schedule: '*/5 * * * *' })] },
        null,
        2,
      ),
    );

    const tick = runCli([
      'tick',
      workspace.jobsFile,
      '--now',
      '2026-01-01T12:10:00.000Z',
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(tick.status, 0, tick.stderr);
    const summary = jsonOutput(tick);
    assert.equal(summary.missed, 1);
    assert.equal(summary.results[0].scheduledFor, '2026-01-01T12:10:00.000Z');
    assert.equal(summary.results[0].status, 'missed');
    assert.equal(markerContents(workspace), '');
    assert.deepEqual(
      readLedger(workspace.ledger).map((record) => record.status),
      ['missed'],
    );
  } finally {
    workspace.cleanup();
  }
});

test(
  'the long-running runner ticks until SIGTERM and exits cleanly',
  { skip: process.platform === 'win32' ? 'POSIX signal shutdown' : false },
  async () => {
    const workspace = makeWorkspace([]);
    let child = null;
    try {
      writeFileSync(
        workspace.jobsFile,
        JSON.stringify({ jobs: [markerJob(workspace)] }, null, 2),
      );

      child = spawn(
        process.execPath,
        [
          binForRun,
          'run',
          workspace.jobsFile,
          '--now',
          T0,
          '--interval',
          '100ms',
          '--ledger',
          workspace.ledger,
        ],
        {
          stdio: 'ignore',
          env: { ...process.env, TZ: 'UTC' },
        },
      );

      await waitFor(() => readLedger(workspace.ledger).length === 1);
      assert.equal(markerContents(workspace), 'x');

      child.kill('SIGTERM');
      const [code] = await once(child, 'exit');
      assert.equal(code, 0);
    } finally {
      if (child !== null && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      workspace.cleanup();
    }
  },
);
