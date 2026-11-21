# loud-cron

[![Latest release](https://img.shields.io/github/v/release/WJDdidi-1/loud-cron?display_name=tag)](https://github.com/WJDdidi-1/loud-cron/releases/latest)

Local cron runner with a durable run ledger that reports missed and hung jobs.
It also validates cron job files before they reach a scheduler.

**Status: MVP.** `check`, `run`, `tick`, and `doctor` are implemented and
tested. The
[latest tagged release, 0.1.0](https://github.com/WJDdidi-1/loud-cron/releases/tag/0.1.0),
contains the `check` validator only; the runner and ledger are on `main` for the
next release. The npm package is not published yet. See the
[0.1.0 release notes](docs/releases/0.1.0.md).

## The problem

Cron-style schedulers tend to fail quietly. A truncated expression, a duplicate
job definition, a misspelled field, or a missing command can leave a job that
never fires. Restarts drop occurrences, a hung process holds a lock forever, and
the first signal is usually a person noticing that work did not happen.

`loud-cron` makes those failures loud:

- `check` validates the whole job file up front and reports every problem in
  one pass as JSON, with the path to fix.
- `run` executes due jobs through the shell and appends every attempt to an
  fsynced JSONL ledger.
- `tick` reconciles scheduled occurrences against that ledger and writes a
  `missed` record instead of silently skipping one.
- `doctor` reports missed, failed, timed-out, overlapped, overdue, and hung
  jobs, and can run a local `--on-failure` hook.

It is a local runner and a staging validator, not a hosted monitoring service.

## Who it is for

Developers who keep scheduled jobs in a JSON file inside Node apps, agent
frameworks, Docker containers, or macOS laptops, and who want both a bad
definition and a missing run to be visible without adding a hosted account.

## Why not just `crontab`?

`crontab` validates very little. It accepts a line that is syntactically valid
but wrong for your job, it does not understand a JSON job file, and it does not
report duplicate job definitions or unknown fields. It also has no local record
of an occurrence that never happened, so a restart or a bad expression is
silent.

`cron+MAILTO` only mails job output; it cannot report a run that did not
happen. systemd timers cover Linux hosts but not macOS, containers, or
in-process schedules. A hosted health-check service needs an account, outbound
network, and a ping added to every job. `loud-cron` keeps the definitions and
the expected-versus-actual run record local.

## Install

The package is not published to npm yet. Install from a checkout with Node.js
18 or newer:

```sh
git clone https://github.com/WJDdidi-1/loud-cron.git
cd loud-cron
npm install -g .
loud-cron --version
```

Or run it without a global install:

```sh
node ./bin/loud-cron.mjs --help
```

The tagged source is also available as a zip or tarball from the
[0.1.0 release page](https://github.com/WJDdidi-1/loud-cron/releases/tag/0.1.0).
There are no runtime dependencies.

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

`run` without `--once` is the long-running runner. It ticks every 60 seconds by
default, so it can stay in a container entrypoint or agent process. `tick` is
the audit-only version: it records missed occurrences but never executes
commands.

## Commands

### `loud-cron check <jobs.json>`

Parses and validates a jobs file without running anything. Always prints JSON on
stdout and exits 0 for a valid file, 1 for errors, 2 for usage errors.

It rejects unparseable or truncated expressions, expressions that can never
match a real date (such as `0 0 31 2 *`), duplicate IDs, unknown fields, and
missing commands, reporting every problem it can find in one pass.

A valid file prints:

```json
{
  "ok": true,
  "file": "jobs.json",
  "jobCount": 1,
  "errors": []
}
```

A file with problems prints every error and exits `1`:

```json
{
  "ok": false,
  "file": "jobs.json",
  "jobCount": 2,
  "errors": [
    {
      "code": "cron_truncated",
      "message": "cron expression has 4 fields; expected 5 (minute hour day-of-month month day-of-week)",
      "path": "jobs[0].schedule",
      "jobId": "nightly-report"
    }
  ]
}
```

`--json` is accepted for scripts that want to be explicit; JSON is already the
default for `check`.

### `loud-cron run [jobs.json]`

Executes the newest due occurrence of every enabled job through the shell and
appends every attempt to the ledger. Options:

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

Job stdout/stderr is forwarded to stderr, so `--json` stdout remains parseable.
`run` exits 0 once outcomes are recorded; a failing job is data for `doctor`,
not a runner failure.

### `loud-cron tick [jobs.json]`

Reconciles scheduled occurrences against the ledger without executing anything.
Every occurrence between the newest ledger entry for a job and `--now` that has
no ledger entry becomes a `missed` record. With no ledger entry for a job, the
most recent scheduled occurrence is reconciled. Supports `--now`, `--since`,
`--ledger`, and `--json`.

### `loud-cron doctor [jobs.json]`

Prints a health report and exits 1 when any job needs attention. It reports:

- the newest recorded attempt per job being `missed`, `failed`, `timeout`,
  `overlap`, or `error`;
- a scheduled occurrence newer than the newest ledger entry (an `overdue` job);
- a live lock held longer than the job's timeout (one hour when no timeout is
  configured) as a `hung` job;
- a corrupt ledger.

`--json` prints the report as JSON. `--on-failure <command>` runs a local shell
hook when there are problems; the problems are passed as JSON in
`LOUD_CRON_PROBLEMS`. The hook inherits the runner environment; its output goes
to stderr so `--json` stdout stays parseable. It accepts `--now`, `--since`, and
`--ledger` too.

## Jobs file

A jobs file is either an object with a `jobs` array (plus an optional `version`)
or a bare array of job objects. Unknown fields are errors, not warnings, because
silently ignoring a typo is how a scheduler does the wrong thing at 3am.

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

Five fields are required in an expression: minute, hour, day-of-month, month,
day-of-week. Seconds are deliberately rejected rather than guessed at. Day names
(`MON-FRI`) and month names (`JAN`) are accepted. When both day-of-month and
day-of-week are restricted, classic cron's OR rule applies.

Full field, cron-syntax, and error-code reference:
[`docs/jobs-file.md`](docs/jobs-file.md).

## Run ledger

Every attempt appends one JSON object per line to the ledger and fsyncs the file
before continuing. The default path is `.loud-cron/ledger.jsonl` next to the
jobs file; `--ledger` overrides it. A missing ledger simply means no attempt has
been recorded yet.

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

Execution records are appended while the job lock is held, so a concurrent
runner cannot duplicate the same occurrence. A malformed ledger line is reported
as `ledger_corrupt`; `run` and `tick` refuse to append to it rather than
compounding the damage. Locks live in `.loud-cron/locks/` next to the ledger and
stale locks from dead processes are reclaimed.

## Missed runs and restarts

For each job, loud-cron finds the newest ledger entry and looks for scheduled
occurrences after it. The newest occurrence executes only when it is no later
than `--grace`; anything older is written as `missed`, so a restart after
downtime produces a record instead of silence. If a job has no ledger entries at
all, `run` executes its most recent scheduled occurrence once (a first-run
catch-up) and `tick` records that occurrence as missed; a fresh install neither
invents a lifetime of missed runs nor silently drops the latest due run. Use
`--since` to bound reconciliation explicitly. A single reconcile pass handles at
most 10,000 occurrences; after a very long outage, run `tick` or `run` again to
continue from the newest ledger record.

## Timeouts, overlap and hung jobs

A job with `timeout`/`timeoutMs` receives SIGTERM when it runs too long, then
SIGKILL after `--kill-grace`. On Windows the process tree is ended with
`taskkill /T /F`. The attempt is recorded as `timeout` even if the command
ignores SIGTERM.

While a job runs, an atomic lock file is held. A second attempt sees the live
holder and records `overlap` rather than starting a duplicate. `doctor` also
reports a lock held far past the job's timeout as `hung`.

## Runnable example

[`examples/`](examples/) contains a valid job file, a deliberately broken one,
and the exact output from checking each.
[`examples/preflight.mjs`](examples/preflight.mjs) runs `check` against the
valid example, the broken example, and a missing path, then asserts that each
exit status and set of error codes matches the contract documented above:

```sh
npm run demo
```

The script exits non-zero if the behavior it checks and the documented contract
ever diverge. It never executes a job command; `check` only parses and
validates. To validate the shipped example from a checkout:

```sh
npm run check:example
```

## FAQ

**Does `loud-cron` run my jobs?**

Yes, with `loud-cron run`. `check` never executes a command; it only parses and
validates the file. `run` executes the newest due occurrence of each enabled
job and records every attempt in the ledger.

**Why does `check` reject a six-field cron expression?**

Seconds are not supported. `loud-cron` accepts the classic five fields (minute
hour day-of-month month day-of-week) and rejects extra fields rather than
silently dropping one. A six-field schedule fails with `cron_too_many_fields`;
`node ./bin/loud-cron.mjs check examples/invalid-jobs.json` shows it alongside
five other errors.

**Why is a typo like `commnd` an error instead of a warning?**

Because a silently ignored field is how a job ends up not doing what you meant.
Unknown top-level and per-job fields fail with `unknown_field`; with `commnd`,
the required `command` is also reported missing. The same example file shows
both errors.

**Does a passing check mean my jobs will run?**

No. Exit `0` only means the file is well formed: every job has a unique ID, a
valid five-field schedule, and a non-empty command. It does not prove the
command exists, succeeds, or is scheduled by anything. Use `run` for execution
and `doctor` to see whether the expected runs actually happened.

**What happens when the runner is down and comes back?**

`run` and `tick` reconcile scheduled occurrences after the newest ledger entry.
The newest occurrence runs if it is within `--grace`; older unrecorded
occurrences are written as `missed`, so downtime produces a record instead of
silence.

**What does `hung` mean?**

A job holds an atomic lock while it runs. If a lock is still held long past the
job's timeout (one hour when no timeout is configured), `doctor` reports the job
as `hung` rather than waiting forever for an attempt that may never finish.

**How do I find the field that needs fixing?**

Read the `path` in each error, such as `jobs[1].schedule`, plus the `jobId` when
one was parsed. All problems in the file are returned in a single pass, so one
`loud-cron check jobs.json` run lists everything it can find.

**Is `--json` required?**

No. JSON is already the default output for `check`; `--json` is accepted so
scripts can be explicit about the contract. For `run`, `tick`, and `doctor`,
`--json` makes stdout machine-readable while job output stays on stderr.

**Can I run it in CI?**

Yes. The exit status is the contract: `check` exits `0` valid, `1` invalid or
unreadable, `2` usage error. From a checkout without a global install,
`node ./bin/loud-cron.mjs check jobs.json` fails the build on a bad definition.
Use `doctor` in a scheduled job to alert on missed or hung runs.

**Is it on npm?**

Not yet. Install from a checkout with `npm install -g .`, then
`loud-cron --version`. Until an npm package exists, `npx loud-cron` is not
available; see [Install](#install).

**Which cron syntax is unsupported?**

`@reboot`, Quartz-style `?`/`L`/`W`/`#`, and seconds. Supported aliases are
`@yearly`/`@annually`, `@monthly`, `@weekly`, `@daily`/`@midnight`, and
`@hourly`. See [`docs/jobs-file.md`](docs/jobs-file.md) for the full syntax and
error-code reference.

## How we know it works

`npm test` runs the `node:test` suite and then the runnable example. It spawns
the real CLI and real shell jobs; there is no demo script that can drift from
the code.

- `test/check.test.mjs` validates the jobs file contract, including
  unparseable, truncated, never-matching and duplicate definitions.
- `test/cron.test.mjs` covers field parsing, day-of-month/day-of-week semantics,
  aliases and occurrence math.
- `test/run.test.mjs` executes real jobs and checks the appended ledger records,
  tick reconciliation, restart/missed behavior, first-install catch-up,
  cwd/env/shell handling, timeout (SIGTERM then SIGKILL and numeric
  `timeoutMs`), start errors, live/stale/`allow` overlap locks, invalid-file
  refusal, corrupt-ledger refusal, and clean `--json` output.
- `test/doctor.test.mjs` checks healthy/invalid reports, overdue jobs, the
  `--since` window, newest-record recovery, configured and default hung locks,
  and the `--on-failure` hook.
- `test/loud-cron.test.mjs` checks version and help output.

CI runs the suite on Linux, macOS, and Windows with Node 18, 20, and 22.

## Licence

Apache-2.0.
