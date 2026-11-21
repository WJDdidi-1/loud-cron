#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

const USAGE = `loud-cron: a small developer tool

Usage:
  loud-cron --help
  loud-cron --version

MVP features:
  - \`loud-cron check jobs.json\` rejects unparseable or truncated expressions, duplicate IDs, unknown fields, and missing commands with a non-zero exit and JSON errors.
  - \`loud-cron run\` executes due jobs through the shell and appends every attempt (scheduled time, start, duration, exit code, status) to an fsynced JSONL ledger.
  - On every tick and restart, reconciles scheduled occurrences against the ledger and records and reports \`missed\` runs instead of skipping them.
  - Per-job timeout (SIGTERM then SIGKILL) plus an atomic overlap lock, recording \`timeout\` and \`overlap\` as failures rather than silence.
  - \`loud-cron doctor --json\` exits 1 on any missed, failed, timed-out, or overdue job; \`--on-failure <cmd>\` runs a local hook.
`;

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION);
} else {
  console.log(USAGE);
}
