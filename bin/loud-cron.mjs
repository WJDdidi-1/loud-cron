#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { validateJobsDocument } from '../src/jobs.mjs';
import {
  DEFAULT_GRACE_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_KILL_GRACE_MS,
  defaultLedgerPath,
  diagnose,
  parseDurationMs,
  runTick,
} from '../src/runner.mjs';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const USAGE = `loud-cron: a local cron runner with a durable run ledger

Usage:
  loud-cron check <jobs.json> [--json]
  loud-cron run [<jobs.json>] [--once] [--now <time>] [--ledger <file>]
               [--grace <duration>] [--interval <duration>]
               [--kill-grace <duration>] [--since <time>] [--json]
  loud-cron tick [<jobs.json>] [--now <time>] [--since <time>]
                [--ledger <file>] [--json]
  loud-cron doctor [<jobs.json>] [--now <time>] [--since <time>]
                   [--ledger <file>] [--on-failure <command>] [--json]
  loud-cron --help
  loud-cron --version

Commands:
  check   Parse and validate a jobs file without running anything. Prints JSON
          and exits non-zero when the file is invalid.
  run     Execute the newest due occurrence of every enabled job. With --once
          it performs one tick and exits; otherwise it ticks every interval.
          Every attempt is appended to an fsynced JSONL ledger.
  tick    Reconcile the ledger without executing anything. Every scheduled
          occurrence missing from the ledger is recorded as "missed".
  doctor  Report missed, failed, timed-out, overlapped, overdue and hung jobs.
          Exits 1 when any job needs attention. --on-failure runs a local hook.

Job file:
  {
    "jobs": [
      {
        "id": "nightly-report",
        "schedule": "0 2 * * *",
        "command": "node scripts/report.mjs",
        "timeout": "5m",
        "overlap": "skip"
      }
    ]
  }

The schedule is a classic five-field cron expression
(minute hour day-of-month month day-of-week), evaluated in local time. A bare
array of job objects is also accepted. Unknown fields are errors, not warnings.

Ledger:
  Defaults to .loud-cron/ledger.jsonl next to the jobs file. Each line records
  jobId, scheduledFor, startedAt, finishedAt, durationMs, exitCode, signal,
  status and attempt. Status is one of ok, failed, timeout, overlap, missed or
  error. A missing ledger means no attempt has been recorded yet.

Reconciliation:
  For each job the runner finds the newest ledger entry and looks for scheduled
  occurrences after it. The newest occurrence runs only if it is no later than
  --grace (default 60s); older unrecorded occurrences become "missed" records.
  On a job with no ledger entries only the most recent occurrence is
  considered. --since ignores everything before that time.

Timeouts:
  timeout/timeoutMs send SIGTERM, then SIGKILL after --kill-grace (default 2s).
  While a job runs an atomic lock is held; a second attempt records "overlap"
  instead of disappearing. Stale locks from dead processes are reclaimed.
`;

class UsageError extends Error {}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usageError(message) {
  process.stderr.write(`loud-cron: ${message}\n\n${USAGE}`);
}

function loadJobsFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = error && error.code === 'ENOENT' ? 'file_not_found' : 'file_unreadable';
    return {
      ok: false,
      file,
      jobCount: 0,
      jobs: [],
      errors: [
        {
          code,
          message: `cannot read jobs file "${file}": ${error.message}`,
          path: null,
        },
      ],
    };
  }

  let document;
  try {
    document = JSON.parse(text.replace(/^\uFEFF/u, ''));
  } catch (error) {
    return {
      ok: false,
      file,
      jobCount: 0,
      jobs: [],
      errors: [
        {
          code: 'invalid_json',
          message: `jobs file is not valid JSON: ${error.message}`,
          path: null,
        },
      ],
    };
  }

  const result = validateJobsDocument(document);
  const jobs = Array.isArray(document)
    ? document
    : document !== null &&
        typeof document === 'object' &&
        Array.isArray(document.jobs)
      ? document.jobs
      : [];

  return { ...result, file, jobs };
}

function reportErrors(file, errors, json) {
  if (json) {
    printJson({ ok: false, file, jobCount: 0, errors });
    return;
  }
  for (const error of errors) {
    const location = error.path === null || error.path === undefined ? '' : `${error.path}: `;
    process.stderr.write(`loud-cron: ${file}: ${location}${error.message}\n`);
  }
}

function checkFile(file, json) {
  const result = loadJobsFile(file);
  // check's JSON contract predates --json; it always prints JSON on stdout.
  printJson({
    ok: result.ok,
    file,
    jobCount: result.jobCount,
    errors: result.errors,
  });
  void json;
  return result.ok ? 0 : 1;
}

function requireJobsFile(positionals, options, command) {
  if (positionals.length > 1) {
    throw new UsageError(`${command} accepts at most one jobs file path`);
  }
  if (options.jobs !== undefined && positionals.length === 1) {
    throw new UsageError(`${command} received both a jobs path and --jobs`);
  }
  return options.jobs ?? positionals[0] ?? 'jobs.json';
}

function parseTime(value, name, fallback = null) {
  if (value === undefined) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new UsageError(`${name} must be a parseable date, got "${value}"`);
  }
  return date;
}

function parseDurationOption(value, name, fallback) {
  if (value === undefined) return fallback;
  const milliseconds = parseDurationMs(value);
  if (milliseconds === null) {
    throw new UsageError(
      `${name} must be a positive duration such as 500ms, 30s or 5m`,
    );
  }
  return milliseconds;
}

function forwardJobOutput(job, outcome) {
  if (outcome.stdout !== '') {
    process.stderr.write(
      `[${job.id}] stdout:\n${outcome.stdout}${outcome.stdout.endsWith('\n') ? '' : '\n'}`,
    );
  }
  if (outcome.stderr !== '') {
    process.stderr.write(
      `[${job.id}] stderr:\n${outcome.stderr}${outcome.stderr.endsWith('\n') ? '' : '\n'}`,
    );
  }
}

function printTickSummary(command, summary, json) {
  if (json) {
    printJson({ ok: true, command, ...summary });
    return;
  }
  process.stdout.write(
    `loud-cron ${command} at ${summary.now}: ` +
      `${summary.executed} executed, ${summary.missed} missed (ledger ${summary.ledger})\n`,
  );
  for (const result of summary.results) {
    if (result.status === 'disabled') continue;
    const details =
      result.status === 'ok'
        ? ` (${result.durationMs}ms, exit 0)`
        : result.exitCode === null || result.exitCode === undefined
          ? ''
          : ` (exit ${result.exitCode})`;
    process.stdout.write(`  ${result.jobId} ${result.scheduledFor} ${result.status}${details}\n`);
  }
}

function printDoctorReport(report, json) {
  if (json) {
    printJson(report);
    return;
  }
  process.stdout.write(
    `loud-cron doctor at ${report.now}: ${report.ok ? 'healthy' : 'needs attention'} ` +
      `(ledger ${report.ledger})\n`,
  );
  for (const problem of report.problems) {
    const job = problem.jobId === null ? '' : `${problem.jobId}: `;
    process.stdout.write(`  ${problem.code}: ${job}${problem.message}\n`);
  }
  for (const job of report.jobs) {
    process.stdout.write(`  ${job.id}: ${job.status}\n`);
  }
}

function ledgerFailure(error, file, json) {
  if (error && error.code === 'ledger_corrupt') {
    reportErrors(file, error.errors, json);
    return true;
  }
  if (error && (error.code === 'ledger_unreadable' || error.code === 'EACCES')) {
    reportErrors(
      file,
      [{ code: error.code, message: error.message, path: null }],
      json,
    );
    return true;
  }
  return false;
}

async function commandRun(positionals, options) {
  const file = requireJobsFile(positionals, options, 'run');
  const now = parseTime(options.now, '--now');
  const since = parseTime(options.since, '--since');
  const graceMs = parseDurationOption(options.grace, '--grace', DEFAULT_GRACE_MS);
  const intervalMs = parseDurationOption(options.interval, '--interval', DEFAULT_INTERVAL_MS);
  const killGraceMs = parseDurationOption(
    options['kill-grace'],
    '--kill-grace',
    DEFAULT_KILL_GRACE_MS,
  );
  const ledgerFile =
    options.ledger === undefined ? defaultLedgerPath(file) : path.resolve(options.ledger);
  const json = options.json === true;

  const loaded = loadJobsFile(file);
  if (!loaded.ok) {
    reportErrors(file, loaded.errors, json);
    return 1;
  }

  const tickOnce = async () => {
    try {
      const summary = await runTick({
        jobs: loaded.jobs,
        ledgerFile,
        now: now ?? new Date(),
        execute: true,
        graceMs,
        killGraceMs,
        since,
        onJobOutput: forwardJobOutput,
      });
      printTickSummary('run', summary, json);
      return summary;
    } catch (error) {
      if (ledgerFailure(error, ledgerFile, json)) return null;
      throw error;
    }
  };

  if (options.once === true) {
    return (await tickOnce()) === null ? 1 : 0;
  }

  let stopping = false;
  let wake = null;
  const stop = () => {
    stopping = true;
    if (wake !== null) wake();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    while (!stopping) {
      const summary = await tickOnce();
      if (summary === null) return 1;
      if (stopping) break;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, intervalMs);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
      });
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  return 0;
}

async function commandTick(positionals, options) {
  const file = requireJobsFile(positionals, options, 'tick');
  const now = parseTime(options.now, '--now', new Date());
  const since = parseTime(options.since, '--since');
  const ledgerFile =
    options.ledger === undefined ? defaultLedgerPath(file) : path.resolve(options.ledger);
  const json = options.json === true;

  const loaded = loadJobsFile(file);
  if (!loaded.ok) {
    reportErrors(file, loaded.errors, json);
    return 1;
  }

  try {
    const summary = await runTick({
      jobs: loaded.jobs,
      ledgerFile,
      now,
      execute: false,
      since,
    });
    printTickSummary('tick', summary, json);
    return 0;
  } catch (error) {
    if (ledgerFailure(error, ledgerFile, json)) return 1;
    throw error;
  }
}

function commandDoctor(positionals, options) {
  const file = requireJobsFile(positionals, options, 'doctor');
  const now = parseTime(options.now, '--now', new Date());
  const since = parseTime(options.since, '--since');
  const ledgerFile =
    options.ledger === undefined ? defaultLedgerPath(file) : path.resolve(options.ledger);
  const json = options.json === true;

  const loaded = loadJobsFile(file);
  if (!loaded.ok) {
    reportErrors(file, loaded.errors, json);
    return 1;
  }

  const report = diagnose({
    jobs: loaded.jobs,
    ledgerFile,
    now,
    since,
  });

  if (options['on-failure'] !== undefined && !report.ok) {
    const hook = spawnSync(options['on-failure'], {
      shell: true,
      // Hook output is diagnostic: keep it off stdout so --json remains a
      // single parseable report even when the hook prints.
      stdio: ['ignore', 2, 2],
      env: {
        ...process.env,
        LOUD_CRON_PROBLEMS: JSON.stringify(report.problems),
      },
    });
    report.onFailure = {
      command: options['on-failure'],
      exitCode: hook.status,
      signal: hook.signal,
      error: hook.error === undefined ? null : hook.error.message,
    };
    if (hook.error !== undefined) {
      process.stderr.write(`loud-cron: on-failure hook failed to start: ${hook.error.message}\n`);
    } else if (hook.status !== 0) {
      process.stderr.write(`loud-cron: on-failure hook exited ${hook.status}\n`);
    }
  }

  printDoctorReport(report, json);
  return report.ok ? 0 : 1;
}

const FLAG_TYPES = new Map([
  ['json', 'boolean'],
  ['once', 'boolean'],
  ['now', 'value'],
  ['ledger', 'value'],
  ['jobs', 'value'],
  ['interval', 'value'],
  ['grace', 'value'],
  ['kill-grace', 'value'],
  ['since', 'value'],
  ['on-failure', 'value'],
]);

const COMMAND_FLAGS = new Map([
  ['check', new Set(['json'])],
  [
    'run',
    new Set([
      'json',
      'once',
      'now',
      'ledger',
      'jobs',
      'interval',
      'grace',
      'kill-grace',
      'since',
    ]),
  ],
  ['tick', new Set(['json', 'now', 'ledger', 'jobs', 'since'])],
  ['doctor', new Set(['json', 'now', 'ledger', 'jobs', 'since', 'on-failure'])],
]);

function parseArguments(argv) {
  const options = {};
  const positionals = [];
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--version' || argument === '-v') {
      version = true;
      continue;
    }
    if (argument === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=');
      const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
      let value = equals === -1 ? undefined : argument.slice(equals + 1);
      const type = FLAG_TYPES.get(name);
      if (type === undefined) {
        throw new UsageError(`unknown option "--${name}"`);
      }
      if (type === 'value') {
        if (value === undefined) {
          index += 1;
          if (index >= argv.length) {
            throw new UsageError(`--${name} requires a value`);
          }
          value = argv[index];
        }
        options[name] = value;
      } else {
        if (value !== undefined) {
          throw new UsageError(`--${name} does not take a value`);
        }
        options[name] = true;
      }
      continue;
    }
    if (argument.startsWith('-') && argument !== '-') {
      throw new UsageError(`unknown option "${argument}"`);
    }
    positionals.push(argument);
  }

  return { options, positionals, help, version };
}

async function main(argv) {
  const parsed = parseArguments(argv);

  if (parsed.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const [command, ...rest] = parsed.positionals;
  if (command === undefined) {
    throw new UsageError('missing command');
  }

  const allowed = COMMAND_FLAGS.get(command);
  if (allowed === undefined) {
    throw new UsageError(`unknown command "${command}"`);
  }
  for (const name of Object.keys(parsed.options)) {
    if (!allowed.has(name)) {
      throw new UsageError(`unknown option "--${name}" for ${command}`);
    }
  }

  if (command === 'check') {
    if (rest.length !== 1) {
      throw new UsageError('check requires exactly one jobs file path');
    }
    return checkFile(rest[0], parsed.options.json === true);
  }
  if (command === 'run') return commandRun(rest, parsed.options);
  if (command === 'tick') return commandTick(rest, parsed.options);
  return commandDoctor(rest, parsed.options);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    usageError(error.message);
    process.exitCode = 2;
  } else {
    process.stderr.write(`loud-cron: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
