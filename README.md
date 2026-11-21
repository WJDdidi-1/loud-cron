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

## Use

```sh
loud-cron --help
```

## What the MVP does

- `loud-cron check jobs.json` rejects unparseable or truncated expressions, duplicate IDs, unknown fields, and missing commands with a non-zero exit and JSON errors.
- `loud-cron run` executes due jobs through the shell and appends every attempt (scheduled time, start, duration, exit code, status) to an fsynced JSONL ledger.
- On every tick and restart, reconciles scheduled occurrences against the ledger and records and reports `missed` runs instead of skipping them.
- Per-job timeout (SIGTERM then SIGKILL) plus an atomic overlap lock, recording `timeout` and `overlap` as failures rather than silence.
- `loud-cron doctor --json` exits 1 on any missed, failed, timed-out, or overdue job; `--on-failure <cmd>` runs a local hook.

## How we know it works

`npm test` runs scripts/demo.sh in a temp dir: (1) a jobs file with a 6-field expression and a duplicate ID makes `check` exit 1 naming both; (2) `tick --now <T>` over a window with no ledger entries writes `missed` and `doctor --json` exits 1; (3) a `sleep 5` job with a 1s timeout run via `run --once` records `timeout` and `doctor` exits 1; (4) a fast job records `ok` and `doctor` exits 0.

## Status

Early MVP. The features above are the scope; anything not listed is not built yet.

## Licence

Apache-2.0.
