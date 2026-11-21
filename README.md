# loud-cron

Local cron runner with a durable run ledger that reports missed and hung jobs.

## Who it is for

Developers who schedule jobs inside Node apps, agent frameworks, Docker containers, or macOS laptops, where systemd timers are unavailable and cron output goes unread.

## The problem

Schedulers silently skip, truncate, or never fire jobs: bad expressions, restarts, hung processes, and duplicate definitions drop runs with no error and no record, so the first signal is a user noticing missing work.

## Why not the obvious answer

cron+MAILTO, systemd timers, and healthchecks.io. MAILTO only mails job output, never reports runs that did not happen, and needs a working MTA; systemd's Persistent=/OnFailure=/TimeoutStartSec= covers Linux hosts but not macOS, containers, or in-process schedules, and cannot flag a timer that fired into a silent no-op; healthchecks.io needs an account, outbound network, and a ping added to every job. None strictly validate the job file or keep a local audit trail of expected versus actual runs.

## Install

```sh
npm install -g loud-cron
```

Or run it straight from a checkout without installing:

```sh
npx loud-cron --help
```

Node.js 18 or newer. There are no runtime dependencies.

## Quick start

Put schedules in `jobs.json`:

```json
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
```

Validate the file, run one tick, then inspect health:

```sh
loud-cron check jobs.json
loud-cron run jobs.json --once
loud-cron doctor jobs.json --json
```

`run` without `--once` is the long-running runner. It ticks every 60 seconds by default, so it can stay in a container entrypoint or agent process. `tick` is the audit-only version: it records missed occurrences but never executes commands.

## Commands

### `loud-cron check <jobs.json>`

Parses and validates a jobs file without running anything. Always prints JSON on stdout and exits 0 for a valid file, 1 for errors, 2 for usage errors.

It rejects unparseable or truncated expressions, expressions that can never match a real date (such as `0 0 31 2 *`), duplicate IDs, unknown fields, and missing commands, reporting every problem it can find in one pass.

### `loud-cron run [jobs.json]`

Executes the newest due occurrence of every enabled job through the shell and appends every attempt to the ledger. Options:

| Option | Meaning |
| --- | --- |
| `--once` | Perform one tick and exit instead of looping. |
| `--now <time>` | Pretend the current time is `<time>` (parseable by `Date`). |
| `--ledger <file>` | Ledger path. Default: `.loud-cron/ledger.jsonl` next to the jobs file. |
| `--grace <duration>` | How late the newest due occurrence may be and still execute. Default `60s`. |
| `--interval <duration>` | Loop interval for the long-running runner. Default `60s`. |
| `--kill-grace <duration>` | Wait after SIGTERM before SIGKILL. Default `2s`. |
| `--since <time>` | Ignore occurrences before this time when reconciling. |
| `--json` | Print one machine-readable summary object per tick on stdout. |

Job stdout/stderr is forwarded to stderr, so `--json` stdout remains parseable. `run` exits 0 once outcomes are recorded; a failing job is data for `doctor`, not a runner failure.

### `loud-cron tick [jobs.json]`

Reconciles scheduled occurrences against the ledger without executing anything. Every occurrence between the newest ledger entry for a job and `--now` that has no ledger entry becomes a `missed` record. With no ledger entry for a job, the most recent scheduled occurrence is reconciled. Supports `--now`, `--since`, `--ledger`, and `--json`.

### `loud-cron doctor [jobs.json]`

Prints a health report and exits 1 when any job needs attention. It reports:

- the newest recorded attempt per job being `missed`, `failed`, `timeout`, `overlap`, or `error`;
- a scheduled occurrence newer than the newest ledger entry (an `overdue` job);
- a live lock held longer than the job's timeout (one hour when no timeout is configured) as a `hung` job;
- a corrupt ledger.

`--json` prints the report as JSON. `--on-failure <command>` runs a local shell hook when there are problems; the problems are passed as JSON in `LOUD_CRON_PROBLEMS`. The hook inherits the runner environment; its output goes to stderr so `--json` stdout stays parseable. It accepts `--now`, `--since`, and `--ledger` too.

## Jobs file

A jobs file is either an object with a `jobs` array (plus an optional `version`) or a bare array of job objects. Unknown fields are errors, not warnings, because silently ignoring a typo is how a scheduler does the wrong thing at 3am.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique, non-empty job name. Used in the ledger and lock file. |
| `schedule` / `cron` | yes | Classic five-field cron expression, evaluated in local time. Aliases such as `@daily` are supported. Set only one of the two names. |
| `command` | yes | Shell command to execute. |
| `description` | no | Human-readable note. |
| `cwd` | no | Working directory for the command. Defaults to the runner's current directory. |
| `env` | no | Object of extra environment variables (string values). Inherits the runner environment. |
| `timeoutMs` / `timeout` | no | Positive milliseconds, or a duration such as `500ms`, `30s`, `5m`, `1h`, `1d`. |
| `enabled` | no | Set `false` to leave a job in the file without scheduling it. |
| `shell` | no | `true` (default), `false`, or a shell path. |
| `overlap` | no | `skip` (default) holds an atomic per-job lock and records an overlap instead of running concurrently; `allow` permits concurrency. |

Five fields are required in an expression: minute, hour, day-of-month, month, day-of-week. Seconds are deliberately rejected rather than guessed at. Day names (`MON-FRI`) and month names (`JAN`) are accepted. When both day-of-month and day-of-week are restricted, classic cron's OR rule applies.

## Run ledger

Every attempt appends one JSON object per line to the ledger and fsyncs the file before continuing. The default path is `.loud-cron/ledger.jsonl` next to the jobs file; `--ledger` overrides it. A missing ledger simply means no attempt has been recorded yet.

Example record:

```json
{"jobId":"nightly-report","scheduledFor":"2026-01-01T02:00:00.000Z","startedAt":"2026-01-01T02:00:00.412Z","finishedAt":"2026-01-01T02:00:03.901Z","durationMs":3489,"exitCode":0,"signal":null,"status":"ok","pid":4123,"attempt":1}
```

Statuses:

| Status | Meaning |
| --- | --- |
| `ok` | Command exited 0. |
| `failed` | Command exited non-zero. |
| `timeout` | Command exceeded its timeout and was terminated. |
| `overlap` | The job's lock was held by a live process, so this attempt did not run. |
| `missed` | A scheduled occurrence had no attempt, so it was reconciled as missed. |
| `error` | The command could not be started. |

Execution records are appended while the job lock is held, so a concurrent runner cannot duplicate the same occurrence. A malformed ledger line is reported as `ledger_corrupt`; `run` and `tick` refuse to append to it rather than compounding the damage. Locks live in `.loud-cron/locks/` next to the ledger and stale locks from dead processes are reclaimed.

## Missed runs and restarts

For each job, loud-cron finds the newest ledger entry and looks for scheduled occurrences after it. The newest occurrence executes only when it is no later than `--grace`; anything older is written as `missed`, so a restart after downtime produces a record instead of silence. If a job has no ledger entries at all, `run` executes its most recent scheduled occurrence once (a first-run catch-up) and `tick` records that occurrence as missed; a fresh install neither invents a lifetime of missed runs nor silently drops the latest due run. Use `--since` to bound reconciliation explicitly. A single reconcile pass handles at most 10,000 occurrences; after a very long outage, run `tick` or `run` again to continue from the newest ledger record.

## Timeouts, overlap and hung jobs

A job with `timeout`/`timeoutMs` receives SIGTERM when it runs too long, then SIGKILL after `--kill-grace`. On Windows the process tree is ended with `taskkill /T /F`. The attempt is recorded as `timeout` even if the command ignores SIGTERM.

While a job runs, an atomic lock file is held. A second attempt sees the live holder and records `overlap` rather than starting a duplicate. `doctor` also reports a lock held far past the job's timeout as `hung`.

## How we know it works

`npm test` runs the `node:test` suite. It spawns the real CLI and real shell jobs; there is no demo script that can drift from the code.

- `test/check.test.mjs` validates the jobs file contract, including unparseable, truncated, never-matching and duplicate definitions.
- `test/cron.test.mjs` covers field parsing, day-of-month/day-of-week semantics, aliases and occurrence math.
- `test/run.test.mjs` executes real jobs and checks the appended ledger records, tick reconciliation, restart/missed behavior, first-install catch-up, cwd/env/shell handling, timeout (SIGTERM then SIGKILL and numeric `timeoutMs`), start errors, live/stale/`allow` overlap locks, invalid-file refusal, corrupt-ledger refusal, and clean `--json` output.
- `test/doctor.test.mjs` checks healthy/invalid reports, overdue jobs, the `--since` window, newest-record recovery, configured and default hung locks, and the `--on-failure` hook.
- `test/loud-cron.test.mjs` checks version and help output.

## Status

Early MVP. The features above are the scope; anything not listed is not built yet.

## Licence

Apache-2.0.
