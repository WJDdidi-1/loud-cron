#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { validateJobsDocument } from '../src/jobs.mjs';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const USAGE = `loud-cron: a local cron runner with a durable run ledger

Usage:
  loud-cron check <jobs.json> [--json]
  loud-cron --help
  loud-cron --version

check parses and validates a jobs file without running anything. It exits 0
when the file is valid and non-zero when it is not, and always prints a JSON
report on stdout:

  { "ok": true, "file": "jobs.json", "jobCount": 2, "errors": [] }
  { "ok": false, "file": "jobs.json", "jobCount": 2, "errors": [
      { "code": "duplicate_id", "message": "...", "path": "jobs[1].id" } ] }

Jobs file:
  {
    "jobs": [
      {
        "id": "nightly-report",
        "schedule": "0 2 * * *",
        "command": "node scripts/report.mjs",
        "timeout": "5m"
      }
    ]
  }

The schedule is a classic five-field cron expression
(minute hour day-of-month month day-of-week). A bare array of job objects is
also accepted. Unknown fields are errors, not warnings.

Planned for the rest of the MVP:
  - loud-cron run executes due jobs through the shell and appends every attempt
    (scheduled time, start, duration, exit code, status) to an fsynced JSONL
    ledger.
  - On every tick and restart, reconciles scheduled occurrences against the
    ledger and records and reports \`missed\` runs instead of skipping them.
  - Per-job timeout (SIGTERM then SIGKILL) plus an atomic overlap lock,
    recording \`timeout\` and \`overlap\` as failures rather than silence.
  - loud-cron doctor --json exits 1 on any missed, failed, timed-out, or
    overdue job; --on-failure <cmd> runs a local hook.
`;

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usageError(message) {
  process.stderr.write(`loud-cron: ${message}\n\n${USAGE}`);
  process.exitCode = 2;
}

function checkFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = error && error.code === 'ENOENT' ? 'file_not_found' : 'file_unreadable';
    printJson({
      ok: false,
      file,
      jobCount: 0,
      errors: [
        {
          code,
          message: `cannot read jobs file "${file}": ${error.message}`,
          path: null,
        },
      ],
    });
    process.exitCode = 1;
    return;
  }

  let document;
  try {
    document = JSON.parse(text.replace(/^\uFEFF/u, ''));
  } catch (error) {
    printJson({
      ok: false,
      file,
      jobCount: 0,
      errors: [
        {
          code: 'invalid_json',
          message: `jobs file is not valid JSON: ${error.message}`,
          path: null,
        },
      ],
    });
    process.exitCode = 1;
    return;
  }

  const result = validateJobsDocument(document);
  printJson({
    ok: result.ok,
    file,
    jobCount: result.jobCount,
    errors: result.errors,
  });
  process.exitCode = result.ok ? 0 : 1;
}

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(USAGE);
} else if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(`${VERSION}\n`);
} else {
  const positional = [];
  let json = false;
  let badFlag = null;

  for (const argument of argv) {
    if (argument === '--json') {
      json = true;
    } else if (argument.startsWith('-')) {
      badFlag = argument;
    } else {
      positional.push(argument);
    }
  }

  if (badFlag !== null) {
    usageError(`unknown option "${badFlag}"`);
  } else {
    const [command, ...rest] = positional;
    if (command === 'check') {
      if (rest.length !== 1) {
        usageError('check requires exactly one jobs file path');
      } else {
        // JSON output is the default; --json is accepted so scripts can be
        // explicit about the contract they depend on.
        void json;
        checkFile(rest[0]);
      }
    } else if (command === undefined) {
      usageError('missing command');
    } else {
      usageError(`unknown command "${command}"`);
    }
  }
}
