// Execution, reconciliation and health reporting for loud-cron.

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  occurrencesBetween,
  parseCronExpression,
  previousOccurrence,
} from './cron.mjs';
import { parseDurationMs } from './duration.mjs';
import { appendLedgerRecord, readLedger } from './ledger.mjs';

export { parseDurationMs };

export const DEFAULT_GRACE_MS = 60_000;
export const DEFAULT_INTERVAL_MS = 60_000;
export const DEFAULT_KILL_GRACE_MS = 2_000;
export const DEFAULT_HUNG_AFTER_MS = 60 * 60 * 1000;

// How many occurrences to reconcile in one pass. A very long outage is
// reported in chunks instead of blocking forever or filling the disk.
const MAX_OCCURRENCES_PER_TICK = 10000;

export function timeoutMsFor(job) {
  if (job.timeoutMs !== undefined) return job.timeoutMs;
  if (job.timeout !== undefined) return parseDurationMs(job.timeout);
  return null;
}

export function defaultLedgerPath(jobsFile) {
  return path.join(path.dirname(path.resolve(jobsFile)), '.loud-cron', 'ledger.jsonl');
}

export function lockPathFor(ledgerFile, jobId) {
  return path.join(
    path.dirname(path.resolve(ledgerFile)),
    'locks',
    `${encodeURIComponent(jobId)}.lock`,
  );
}

export function recordKey(jobId, scheduledFor) {
  return `${jobId}\u0000${scheduledFor}`;
}

function readLedgerOrThrow(file) {
  const ledger = readLedger(file);
  if (ledger.errors.length > 0) {
    const error = new Error(`ledger "${file}" is corrupt`);
    error.code = 'ledger_corrupt';
    error.errors = ledger.errors;
    throw error;
  }
  return ledger;
}

function newestRecordByJob(records) {
  const newest = new Map();
  for (const record of records) {
    const current = newest.get(record.jobId);
    if (current === undefined) {
      newest.set(record.jobId, record);
      continue;
    }
    const recordTime = Date.parse(record.scheduledFor);
    const currentTime = Date.parse(current.scheduledFor);
    if (
      recordTime > currentTime ||
      (recordTime === currentTime && (record.attempt ?? 0) >= (current.attempt ?? 0))
    ) {
      newest.set(record.jobId, record);
    }
  }
  return newest;
}

// Attempts that represent a command actually having run. An occurrence with
// one of these records must never be executed a second time.
const COMPLETED_STATUSES = new Set(['ok', 'failed', 'timeout', 'error']);

function findCompletedAttempt(records, jobId, scheduledFor) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (
      record.jobId === jobId &&
      record.scheduledFor === scheduledFor &&
      COMPLETED_STATUSES.has(record.status)
    ) {
      return record;
    }
  }
  return null;
}

function countRecordsByJob(records) {
  const counts = new Map();
  for (const record of records) {
    counts.set(record.jobId, (counts.get(record.jobId) ?? 0) + 1);
  }
  return counts;
}

function missedRecord(job, scheduledFor, reason, attempt) {
  return {
    jobId: job.id,
    scheduledFor: scheduledFor.toISOString(),
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    exitCode: null,
    signal: null,
    status: 'missed',
    reason,
    attempt,
  };
}

function describeAge(milliseconds) {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1000)}s`;
  if (milliseconds < 3_600_000) return `${Math.round(milliseconds / 60_000)}m`;
  return `${Math.round(milliseconds / 3_600_000)}h`;
}

function summaryOf(record) {
  const summary = {
    jobId: record.jobId,
    scheduledFor: record.scheduledFor,
    status: record.status,
    attempt: record.attempt,
    durationMs: record.durationMs,
    exitCode: record.exitCode,
  };
  if (record.reason !== undefined) summary.reason = record.reason;
  return summary;
}

function writeAll(fd, text) {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function readLockRaw(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parseLock(raw) {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object') return null;
    return value;
  } catch {
    return null;
  }
}

function readLock(file) {
  return parseLock(readLockRaw(file));
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function acquireLock(file, job, scheduledFor) {
  mkdirSync(path.dirname(file), { recursive: true });
  const token = randomUUID();
  const payload = `${JSON.stringify({
    jobId: job.id,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    scheduledFor: scheduledFor.toISOString(),
    token,
  })}\n`;

  // Three attempts: take a free lock, reclaim one whose owner is gone, or
  // retry when another process changed the lock between our read and unlink.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeAll(fd, payload);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return { ok: true, token, file };
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error;
      const raw = readLockRaw(file);
      const holder = parseLock(raw);
      if (holder !== null && isProcessAlive(holder.pid)) {
        return { ok: false, holder, file };
      }
      // Only unlink the lock we actually inspected. If another process
      // replaced it between the read and the unlink, leave it alone and retry.
      if (raw === null || readLockRaw(file) !== raw) continue;
      try {
        unlinkSync(file);
      } catch (unlinkError) {
        if (unlinkError && unlinkError.code !== 'ENOENT') throw unlinkError;
      }
    }
  }

  return { ok: false, holder: readLock(file), file };
}

function releaseLock(file, token) {
  const holder = readLock(file);
  if (holder === null || holder.token !== token) return;
  try {
    unlinkSync(file);
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
}

function terminateTree(child, signal) {
  if (child === null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    // Windows has no process-group signals; taskkill /T /F ends the tree.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    // Children are spawned detached, so a negative pid signals the whole
    // process group (shell plus its descendants).
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function runCommand(job, timeoutMs, killGraceMs) {
  return new Promise((resolve) => {
    const shell =
      job.shell === false ? false : typeof job.shell === 'string' ? job.shell : true;
    const environment = { ...process.env, ...(job.env ?? {}) };
    const cwd = job.cwd === undefined ? process.cwd() : path.resolve(process.cwd(), job.cwd);

    let child;
    try {
      child = spawn(job.command, [], {
        cwd,
        env: environment,
        shell,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        timedOut: false,
        error,
        stdout: '',
        stderr: '',
        pid: null,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    const capture = (current, chunk) => {
      if (current.length >= 16 * 1024) return current;
      return `${current}${chunk.toString('utf8')}`.slice(0, 16 * 1024);
    };
    child.stdout?.on('data', (chunk) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = capture(stderr, chunk);
    });

    let settled = false;
    let timedOut = false;
    let escalated = false;
    let pendingClose = null;
    let pollTimer = null;
    let timeoutTimer = null;
    let killTimer = null;
    let escapeTimer = null;

    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (escapeTimer !== null) clearTimeout(escapeTimer);
      if (pollTimer !== null) clearTimeout(pollTimer);
      resolve({
        code,
        signal,
        timedOut,
        error: error ?? null,
        stdout,
        stderr,
        pid: child.pid ?? null,
      });
    };

    // The direct child is the shell. On Linux `sh -c` may not exec a single
    // command, so a job that traps SIGTERM keeps running in the process group
    // after the shell itself has exited — waiting on the shell's "close" alone
    // recorded SIGTERM while the runner had already escalated to SIGKILL
    // (ubuntu and windows CI failed this way on 2026-11-22 while macOS passed).
    const groupAlive = () => {
      if (child.pid === undefined || process.platform === 'win32') return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error && error.code === 'EPERM';
      }
    };

    const settleAfterClose = (code, signal) => {
      if (!timedOut) {
        finish(code, signal, null);
        return;
      }
      pendingClose = { code, signal };
      const check = () => {
        if (settled) return;
        if (!groupAlive()) {
          finish(pendingClose.code, escalated ? 'SIGKILL' : pendingClose.signal, null);
          return;
        }
        pollTimer = setTimeout(check, 25);
      };
      check();
    };

    child.on('error', (error) => finish(null, null, error));
    child.on('close', (code, signal) => settleAfterClose(code, signal));

    if (timeoutMs !== null && timeoutMs !== undefined && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminateTree(child, 'SIGTERM');
        killTimer = setTimeout(() => {
          escalated = true;
          terminateTree(child, 'SIGKILL');
          // A killed process should close immediately. This escape hatch
          // keeps the runner (and its report) moving if the OS disagrees.
          escapeTimer = setTimeout(() => finish(null, 'SIGKILL', null), Math.max(killGraceMs, 1000));
        }, killGraceMs);
      }, timeoutMs);
    }
  });
}

/**
 * Run one job occurrence through the shell and return the ledger record.
 *
 * The caller appends the record so a single place owns durability and attempt
 * numbering. A held lock produces an `overlap` record instead of silence.
 */
export async function executeJob({
  job,
  scheduledFor,
  ledgerFile,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  attempt,
}) {
  const lockFile = lockPathFor(ledgerFile, job.id);
  let lock = { ok: true, token: null, file: lockFile };

  if (job.overlap !== 'allow') {
    lock = acquireLock(lockFile, job, scheduledFor);
    if (!lock.ok) {
      const now = new Date();
      const holderPid = lock.holder === null ? null : lock.holder.pid;
      const record = {
        jobId: job.id,
        scheduledFor: scheduledFor.toISOString(),
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        durationMs: 0,
        exitCode: null,
        signal: null,
        status: 'overlap',
        reason:
          holderPid === null
            ? 'job is already running (lock is held by another process)'
            : `job is already running (pid ${holderPid})`,
        pid: holderPid,
        attempt,
      };
      appendLedgerRecord(ledgerFile, record);
      return { record, stdout: '', stderr: '' };
    }
  }

  const startedAt = new Date();
  try {
    if (lock.token !== null) {
      // Another runner may have finished this exact occurrence between our
      // ledger read and our lock acquisition. Holding the lock now makes this
      // re-check authoritative: never execute an attempt already recorded.
      const ledger = readLedger(ledgerFile);
      if (ledger.errors.length === 0) {
        const existing = findCompletedAttempt(
          ledger.records,
          job.id,
          scheduledFor.toISOString(),
        );
        if (existing !== null) {
          return { record: existing, stdout: '', stderr: '' };
        }
      }
    }

    const timeoutMs = timeoutMsFor(job);
    const result = await runCommand(job, timeoutMs, killGraceMs);
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    let status;
    if (result.timedOut) status = 'timeout';
    else if (result.error !== null) status = 'error';
    else if (result.code === 0) status = 'ok';
    else status = 'failed';

    const record = {
      jobId: job.id,
      scheduledFor: scheduledFor.toISOString(),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      exitCode: result.code === undefined ? null : result.code,
      signal: result.signal === undefined ? null : result.signal,
      status,
      pid: result.pid ?? null,
      attempt,
    };

    if (result.timedOut) {
      record.timedOut = true;
      record.reason = `command exceeded its ${timeoutMs}ms timeout`;
    } else if (result.error !== null) {
      record.reason = result.error.message;
    } else if (status === 'failed') {
      record.reason = `command exited with code ${result.code}`;
    }

    // Append before releasing the lock: the next process must see this
    // occurrence in the ledger before it can consider the job due again.
    appendLedgerRecord(ledgerFile, record);
    return { record, stdout: result.stdout, stderr: result.stderr };
  } finally {
    if (lock.ok && lock.token !== null) releaseLock(lock.file, lock.token);
  }
}

/**
 * Reconcile every enabled job against the ledger, optionally executing the
 * newest due occurrence. With `execute: false` this is `loud-cron tick`:
 * every unrecorded occurrence in the window becomes a `missed` record.
 */
export async function runTick({
  jobs,
  ledgerFile,
  now = new Date(),
  execute = true,
  graceMs = DEFAULT_GRACE_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  since = null,
  onJobOutput = null,
}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(nowDate.getTime())) throw new Error('invalid current time');
  const sinceDate = since === null ? null : since instanceof Date ? since : new Date(since);
  if (sinceDate !== null && Number.isNaN(sinceDate.getTime())) {
    throw new Error('invalid --since time');
  }

  const ledger = readLedgerOrThrow(ledgerFile);
  const known = new Set();
  for (const record of ledger.records) {
    known.add(recordKey(record.jobId, record.scheduledFor));
  }
  const newest = newestRecordByJob(ledger.records);
  const attempts = countRecordsByJob(ledger.records);

  const results = [];

  for (const job of jobs) {
    if (job.enabled === false) {
      results.push({ jobId: job.id, status: 'disabled' });
      continue;
    }

    const expression = job.schedule === undefined ? job.cron : job.schedule;
    const parsed = parseCronExpression(expression);

    // Reconcile from the newest record for this job, or from --since when the
    // operator asked to ignore history. With neither, only the most recent
    // scheduled occurrence is considered: a fresh install should not invent
    // a lifetime of missed runs.
    let windowStart = newest.get(job.id)?.scheduledFor ?? null;
    if (
      sinceDate !== null &&
      (windowStart === null || sinceDate.getTime() > Date.parse(windowStart))
    ) {
      windowStart = sinceDate.toISOString();
    }

    let occurrences;
    if (windowStart !== null) {
      occurrences = occurrencesBetween(parsed, new Date(windowStart), nowDate, {
        limit: MAX_OCCURRENCES_PER_TICK,
      });
    } else {
      const latest = previousOccurrence(parsed, nowDate);
      occurrences = latest === null ? [] : [latest];
    }

    const pending = occurrences.filter(
      (occurrence) => !known.has(recordKey(job.id, occurrence.toISOString())),
    );
    // A brand-new job (no ledger entry and no explicit --since) gets one
    // first-run catch-up instead of being reported missed for a time when the
    // runner did not exist yet. Once history exists, normal grace applies.
    const firstSight = !newest.has(job.id) && sinceDate === null;

    const plan = [];
    if (execute) {
      // Everything before the newest occurrence is already too late to run
      // as a normal tick; record it as missed instead of silently collapsing
      // several runs into one.
      for (const occurrence of pending.slice(0, -1)) {
        plan.push({
          occurrence,
          missed: true,
          reason: 'occurrence was skipped while the runner was not executing it',
        });
      }
      if (pending.length > 0) {
        const latest = pending[pending.length - 1];
        const age = nowDate.getTime() - latest.getTime();
        if (firstSight || age <= graceMs) {
          plan.push({ occurrence: latest, missed: false });
        } else {
          plan.push({
            occurrence: latest,
            missed: true,
            reason: `occurrence was ${describeAge(age)} late (grace ${graceMs}ms)`,
          });
        }
      }
    } else {
      for (const occurrence of pending) {
        plan.push({
          occurrence,
          missed: true,
          reason: 'no ledger entry existed for this occurrence',
        });
      }
    }

    for (const item of plan) {
      const attempt = (attempts.get(job.id) ?? 0) + 1;
      attempts.set(job.id, attempt);

      if (item.missed) {
        const record = missedRecord(job, item.occurrence, item.reason, attempt);
        appendLedgerRecord(ledgerFile, record);
        known.add(recordKey(record.jobId, record.scheduledFor));
        results.push(summaryOf(record));
        continue;
      }

      const outcome = await executeJob({
        job,
        scheduledFor: item.occurrence,
        ledgerFile,
        killGraceMs,
        attempt,
      });
      const record = outcome.record;
      known.add(recordKey(record.jobId, record.scheduledFor));
      if (onJobOutput !== null && (outcome.stdout !== '' || outcome.stderr !== '')) {
        onJobOutput(job, outcome);
      }
      results.push(summaryOf(record));
    }
  }

  return {
    now: nowDate.toISOString(),
    ledger: ledgerFile,
    executed: results.filter(
      (result) => result.status !== 'missed' && result.status !== 'disabled',
    ).length,
    missed: results.filter((result) => result.status === 'missed').length,
    results,
  };
}

function problemFor(status, job, detail) {
  const codes = {
    missed: 'missed_run',
    failed: 'failed_run',
    timeout: 'timed_out',
    overlap: 'overlapped',
    error: 'run_error',
  };
  return {
    code: codes[status] ?? `${status}_run`,
    jobId: job.id,
    message: detail,
  };
}

/**
 * Health report for the jobs file.
 *
 * The newest record per job decides whether that job is healthy; an occurrence
 * newer than that record (or any occurrence when there is no record) is
 * overdue. A live lock is reported as running, and a lock held longer than the
 * job's timeout is reported as hung.
 */
export function diagnose({ jobs, ledgerFile, now = new Date(), since = null }) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const sinceDate = since === null ? null : since instanceof Date ? since : new Date(since);
  const ledger = readLedger(ledgerFile);
  const newest = newestRecordByJob(ledger.records);
  const problems = [];

  for (const issue of ledger.errors) {
    problems.push({
      code: issue.code,
      jobId: null,
      message: issue.message,
    });
  }

  const jobReports = [];

  for (const job of jobs) {
    if (job.enabled === false) {
      jobReports.push({ id: job.id, status: 'disabled', lastRun: null, overdueFor: null });
      continue;
    }

    const expression = job.schedule === undefined ? job.cron : job.schedule;
    const parsed = parseCronExpression(expression);
    const latest = previousOccurrence(parsed, nowDate);
    const inWindow =
      latest !== null && (sinceDate === null || latest.getTime() >= sinceDate.getTime());

    const last = newest.get(job.id) ?? null;
    const lockFile = lockPathFor(ledgerFile, job.id);
    const lock = readLock(lockFile);
    const lockAlive = lock !== null && isProcessAlive(lock.pid);

    let status = last === null ? 'never_run' : last.status;
    let overdueFor = null;

    // A recorded failure is a failure event even if another attempt is
    // currently in progress; the ledger's newest record decides health.
    if (last !== null && last.status !== 'ok') {
      problems.push(
        problemFor(
          last.status,
          job,
          last.reason ?? `newest recorded attempt for ${last.scheduledFor} is ${last.status}`,
        ),
      );
    }

    if (lockAlive) {
      if (status === 'never_run' || status === 'ok') status = 'running';
      const started = Date.parse(lock.startedAt);
      const hungAfter = timeoutMsFor(job) ?? DEFAULT_HUNG_AFTER_MS;
      if (Number.isFinite(started) && nowDate.getTime() - started > hungAfter) {
        status = 'hung';
        problems.push({
          code: 'hung',
          jobId: job.id,
          message: `job has held its lock since ${lock.startedAt} without finishing`,
        });
      }
    }

    if (inWindow && !lockAlive) {
      if (last === null || latest.getTime() > Date.parse(last.scheduledFor)) {
        overdueFor = latest.toISOString();
        if (status === 'never_run' || status === 'ok') status = 'overdue';
        problems.push({
          code: 'overdue',
          jobId: job.id,
          message: `no recorded attempt for scheduled occurrence ${latest.toISOString()}`,
        });
      }
    }

    jobReports.push({
      id: job.id,
      status,
      lastRun:
        last === null
          ? null
          : {
              scheduledFor: last.scheduledFor,
              status: last.status,
              exitCode: last.exitCode ?? null,
              durationMs: last.durationMs ?? null,
            },
      overdueFor,
    });
  }

  return {
    ok: problems.length === 0,
    now: nowDate.toISOString(),
    ledger: ledgerFile,
    jobs: jobReports,
    problems,
  };
}
