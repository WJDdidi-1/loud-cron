import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { lockPathFor } from '../src/runner.mjs';
import {
  jsonOutput,
  makeWorkspace,
  readLedger,
  runCli,
  writeLedger,
} from './helpers.mjs';

const T0 = '2026-01-01T12:00:00.000Z';
const T1 = '2026-01-01T12:01:00.000Z';

test('doctor exits 0 when the newest attempt for every job is ok', () => {
  const workspace = makeWorkspace([
    {
      id: 'healthy',
      schedule: '* * * * *',
      command: 'node -e ""',
    },
  ]);
  try {
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
    const report = jsonOutput(doctor);
    assert.equal(report.ok, true);
    assert.deepEqual(report.problems, []);
    assert.equal(report.jobs[0].status, 'ok');
  } finally {
    workspace.cleanup();
  }
});

test('doctor reports a failed exit code and runs --on-failure with the problems', () => {
  const workspace = makeWorkspace([
    {
      id: 'broken',
      schedule: '* * * * *',
      command: 'node -e "process.exit(3)"',
    },
  ]);
  try {
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
    assert.equal(jsonOutput(run).results[0].status, 'failed');
    assert.equal(readLedger(workspace.ledger)[0].exitCode, 3);

    const hookMarker = path.join(workspace.directory, 'hook.txt');
    const doctor = runCli(
      [
        'doctor',
        workspace.jobsFile,
        '--now',
        T0,
        '--ledger',
        workspace.ledger,
        '--json',
        '--on-failure',
        'node -e "require(\'fs\').writeFileSync(process.env.HOOK_MARKER, process.env.LOUD_CRON_PROBLEMS)"',
      ],
      { env: { HOOK_MARKER: hookMarker } },
    );
    assert.equal(doctor.status, 1);
    const report = jsonOutput(doctor);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.code === 'failed_run'));
    assert.equal(report.onFailure.command.startsWith('node -e'), true);
    assert.equal(report.onFailure.exitCode, 0);

    const hookProblems = JSON.parse(readFileSync(hookMarker, 'utf8'));
    assert.equal(hookProblems[0].code, 'failed_run');
    assert.equal(hookProblems[0].jobId, 'broken');
  } finally {
    workspace.cleanup();
  }
});

test('doctor --on-failure output stays off --json stdout', () => {
  const workspace = makeWorkspace([
    { id: 'broken', schedule: '* * * * *', command: 'true' },
  ]);
  try {
    writeLedger(workspace.ledger, [
      {
        jobId: 'broken',
        scheduledFor: T0,
        startedAt: T0,
        finishedAt: T0,
        durationMs: 1,
        exitCode: 1,
        status: 'failed',
        attempt: 1,
      },
    ]);

    const doctor = runCli([
      'doctor',
      workspace.jobsFile,
      '--now',
      T0,
      '--ledger',
      workspace.ledger,
      '--json',
      '--on-failure',
      'node -e "console.log(\'hook-says-hi\')"',
    ]);
    assert.equal(doctor.status, 1);
    // jsonOutput throws if the hook wrote anything to stdout.
    const report = jsonOutput(doctor);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.code === 'failed_run'));
    assert.match(doctor.stderr, /hook-says-hi/u);
  } finally {
    workspace.cleanup();
  }
});

test('doctor does not run --on-failure when the report is healthy', () => {
  const workspace = makeWorkspace([
    { id: 'healthy', schedule: '* * * * *', command: 'node -e ""' },
  ]);
  try {
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

    const hookMarker = path.join(workspace.directory, 'hook.txt');
    const doctor = runCli(
      [
        'doctor',
        workspace.jobsFile,
        '--now',
        T0,
        '--ledger',
        workspace.ledger,
        '--json',
        '--on-failure',
        'node -e "require(\'fs\').writeFileSync(process.env.HOOK_MARKER, \'ran\')"',
      ],
      { env: { HOOK_MARKER: hookMarker } },
    );
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(jsonOutput(doctor).ok, true);
    assert.equal(existsSync(hookMarker), false);
  } finally {
    workspace.cleanup();
  }
});

test('doctor reports an overdue job when no ledger entry exists', () => {
  const workspace = makeWorkspace([
    { id: 'never-run', schedule: '*/5 * * * *', command: 'true' },
  ]);
  try {
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
    const report = jsonOutput(doctor);
    assert.equal(report.ok, false);
    assert.equal(report.jobs[0].status, 'overdue');
    assert.equal(report.jobs[0].overdueFor, T0);
    assert.ok(report.problems.some((problem) => problem.code === 'overdue'));
  } finally {
    workspace.cleanup();
  }
});

test('doctor judges the newest record per job, so a later ok run recovers', () => {
  const workspace = makeWorkspace([
    { id: 'recovering', schedule: '* * * * *', command: 'true' },
  ]);
  try {
    writeLedger(workspace.ledger, [
      {
        jobId: 'recovering',
        scheduledFor: T0,
        startedAt: T0,
        finishedAt: T0,
        durationMs: 5,
        exitCode: 1,
        status: 'failed',
        attempt: 1,
      },
      {
        jobId: 'recovering',
        scheduledFor: T1,
        startedAt: T1,
        finishedAt: T1,
        durationMs: 4,
        exitCode: 0,
        status: 'ok',
        attempt: 2,
      },
    ]);

    const doctor = runCli([
      'doctor',
      workspace.jobsFile,
      '--now',
      T1,
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(doctor.status, 0, doctor.stderr);
    const report = jsonOutput(doctor);
    assert.equal(report.ok, true);
    assert.equal(report.jobs[0].status, 'ok');
    assert.equal(report.jobs[0].lastRun.status, 'ok');
  } finally {
    workspace.cleanup();
  }
});

test('doctor reports a lock held far past the job timeout as hung', () => {
  const workspace = makeWorkspace([
    { id: 'hung', schedule: '* * * * *', command: 'true', timeout: '1m' },
  ]);
  try {
    const lockFile = lockPathFor(workspace.ledger, 'hung');
    mkdirSync(path.dirname(lockFile), { recursive: true });
    writeFileSync(
      lockFile,
      JSON.stringify({
        jobId: 'hung',
        pid: process.pid,
        startedAt: '2026-01-01T10:00:00.000Z',
        scheduledFor: T0,
        token: 'stuck',
      }),
    );

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
    const report = jsonOutput(doctor);
    assert.equal(report.ok, false);
    assert.equal(report.jobs[0].status, 'hung');
    assert.ok(report.problems.some((problem) => problem.code === 'hung'));
  } finally {
    workspace.cleanup();
  }
});

test('doctor assumes a one hour hung threshold when no timeout is configured', () => {
  const workspace = makeWorkspace([
    { id: 'no-timeout', schedule: '* * * * *', command: 'true' },
  ]);
  try {
    const lockFile = lockPathFor(workspace.ledger, 'no-timeout');
    mkdirSync(path.dirname(lockFile), { recursive: true });
    writeFileSync(
      lockFile,
      JSON.stringify({
        jobId: 'no-timeout',
        pid: process.pid,
        startedAt: '2026-01-01T10:00:00.000Z',
        scheduledFor: T0,
        token: 'stuck',
      }),
    );

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
    const report = jsonOutput(doctor);
    assert.equal(report.jobs[0].status, 'hung');
    assert.ok(report.problems.some((problem) => problem.code === 'hung'));
  } finally {
    workspace.cleanup();
  }
});

test('doctor --since ignores overdue occurrences older than the window', () => {
  const workspace = makeWorkspace([
    { id: 'daily', schedule: '0 0 * * *', command: 'true' },
  ]);
  try {
    const outside = runCli([
      'doctor',
      workspace.jobsFile,
      '--now',
      T0,
      '--since',
      '2026-01-01T06:00:00.000Z',
      '--ledger',
      workspace.ledger,
      '--json',
    ]);
    assert.equal(outside.status, 0, outside.stderr);
    const report = jsonOutput(outside);
    assert.equal(report.ok, true);
    assert.equal(report.jobs[0].status, 'never_run');
    assert.equal(report.jobs[0].overdueFor, null);
    assert.deepEqual(report.problems, []);
  } finally {
    workspace.cleanup();
  }
});
