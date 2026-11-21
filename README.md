# loud-cron

[![Latest release](https://img.shields.io/github/v/release/WJDdidi-1/loud-cron?display_name=tag)](https://github.com/WJDdidi-1/loud-cron/releases/latest)

Strict validation for cron job files: catch bad expressions, duplicate IDs,
unknown fields, and missing commands before a scheduler silently drops a run.

**Status: pre-runner MVP.** `check` is implemented and tested. `run`, the
durable run ledger, missed/hung detection, and `doctor` are not built yet.

**Latest release: [0.1.0](https://github.com/WJDdidi-1/loud-cron/releases/tag/0.1.0).**
It contains the `check` validator only, and the npm package is not published
yet. See the [0.1.0 release notes](docs/releases/0.1.0.md).

## The problem

Cron-style schedulers tend to fail quietly. A truncated expression, a duplicate
job definition, a misspelled field, or a missing command can leave a job that
never fires, and the first signal is usually a person noticing that work did not
happen.

`loud-cron check` makes the input loud: it parses the whole job file up front,
reports every problem it can find in one pass as JSON with the path to fix, and
exits non-zero. It is a cron expression parser and job-file validator you can
run locally or in CI, not another scheduler daemon.

## Who it is for

Developers who keep scheduled jobs in a JSON file inside Node apps, agent
frameworks, Docker containers, or macOS laptops, and who want a bad definition
to fail before deploy instead of becoming a run that never appears.

## Why not just `crontab`?

`crontab` validates very little. It accepts a line that is syntactically valid
but wrong for your job, it does not understand a JSON job file, and it does not
report duplicate job definitions or unknown fields. `loud-cron` is a pre-flight
check for the definitions you already maintain; it is not a `crontab`
replacement today.

## Install

The package is not published to npm yet. Install it from a checkout with
Node.js 18 or newer:

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

## Releases

- [`0.1.0`](https://github.com/WJDdidi-1/loud-cron/releases/tag/0.1.0)
  (2026-11-22) — first tagged release; the `check` validator only, no npm
  package yet. [Release notes](docs/releases/0.1.0.md).

The release tag is the version to cite. There are no earlier releases.

## Usage

From a checkout, validate the example file that ships with the repository. It
is valid, so the command exits `0`; `check` parses and reports but never runs a
job's command:

```sh
npm run check:example
```

To check your own file, pass its path:

```sh
loud-cron check jobs.json
```

A minimal jobs file looks like this:

```json
{
  "jobs": [
    {
      "id": "nightly-report",
      "schedule": "0 2 * * *",
      "command": "node scripts/report.mjs"
    }
  ]
}
```

A valid file prints a JSON report and exits `0`:

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
default for `check`. Usage mistakes exit `2` and print usage text to stderr.

See [`examples/`](examples/) for a valid job file, a deliberately broken one,
and the exact output from checking each.

## What `check` does today

- Parses classic five-field cron expressions (`minute hour day-of-month month
  day-of-week`) including lists, ranges, steps, month and weekday names, and the
  `@yearly`/`@monthly`/`@weekly`/`@daily`/`@hourly` aliases.
- Rejects truncated or over-long expressions instead of guessing. Seconds are
  not supported, so a six-field expression is an error.
- Rejects out-of-range values, reversed ranges, bad steps, unknown aliases, and
  extended syntax it does not implement.
- Requires every job to have a non-empty, unique `id`, a schedule, and a
  non-empty `command`.
- Rejects unknown top-level and per-job fields, so a typo like `commnd` is
  reported instead of silently ignored.
- Validates the optional fields: `description`, `cwd`, `env`, `timeoutMs`,
  `timeout`, `enabled`, `shell`, and `overlap`.
- Reports all problems found in a single run with stable error codes and a
  `path` such as `jobs[2].schedule`.
- Exits `0` for a valid file, `1` for an invalid or unreadable file, and `2` for
  a usage error.

Full field, cron-syntax, and error-code reference:
[`docs/jobs-file.md`](docs/jobs-file.md).

## FAQ

**Does `loud-cron` run my jobs?**

No. This commit implements `check` only: there is no `run`, scheduler loop, or
run ledger yet, and `check` never executes a command. Running
`node ./bin/loud-cron.mjs run examples/jobs.json` prints
`unknown command "run"` and exits `2`. Keep using cron, systemd timers, or your
platform scheduler to execute, and use `loud-cron check` to guard the
definitions.

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
command exists, succeeds, or is scheduled by anything. `npm run check:example`
shows a passing report.

**How do I find the field that needs fixing?**

Read the `path` in each error, such as `jobs[1].schedule`, plus the `jobId`
when one was parsed. All problems in the file are returned in a single pass, so
one `loud-cron check jobs.json` run lists everything it can find.

**Is `--json` required?**

No. JSON is already the default output for `check`; `--json` is accepted so
scripts can be explicit about the contract. `loud-cron check jobs.json --json`
and `loud-cron check jobs.json` produce the same report.

**Can I run it in CI?**

Yes. The exit status is the contract: `0` valid, `1` invalid or unreadable, `2`
usage error. From a checkout without a global install,
`node ./bin/loud-cron.mjs check jobs.json` fails the build on a bad definition.

**Is it on npm?**

Not yet. Install from a checkout with `npm install -g .`, then
`loud-cron --version`. Until an npm package exists, `npx loud-cron` is not
available; see [Install](#install).

**Which cron syntax is unsupported?**

`@reboot`, Quartz-style `?`/`L`/`W`/`#`, and seconds. Supported aliases are
`@yearly`/`@annually`, `@monthly`, `@weekly`, `@daily`/`@midnight`, and
`@hourly`. See [`docs/jobs-file.md`](docs/jobs-file.md) for the full syntax and
error-code reference.

## Use it as a cron job-file linter in CI

Run the check before deploying schedule changes, so a malformed job fails the
build instead of shipping:

```sh
loud-cron check jobs.json
```

Or, from a checkout without a global install:

```sh
node ./bin/loud-cron.mjs check jobs.json
```

The non-zero exit status is the contract CI needs; the JSON report gives the
developer the file path and field to fix.

## What is not built yet

The remaining MVP milestones are not in this commit:

- `loud-cron run` does not exist. No command from a jobs file is executed.
- There is no scheduler loop or `tick`, so nothing runs on a schedule.
- There is no durable run ledger, no reconciliation of missed runs, and no
  reporting of hung jobs.
- `timeout`, `timeoutMs`, `overlap`, `enabled`, and `shell` are validated as
  fields but are not applied by a runner.
- There is no `doctor` command, `--on-failure` hook, or notification channel.

Those are planned, not current behavior. If you need a runner today, keep using
cron, systemd timers, or your platform scheduler, and use `loud-cron check` to
guard the job definitions before they get there.

## How we know it works

```sh
npm test
```

runs Node's built-in test runner (`node --test`) against the cron parser, the
job-file validator, and the CLI. The suite currently has 22 tests, including
end-to-end checks that a valid file exits `0`, that invalid JSON, truncated
expressions, duplicate IDs, unknown fields, and missing commands exit `1` with
the expected error codes, and that usage errors exit `2`. CI runs the suite on
Linux, macOS, and Windows with Node 18, 20, and 22.

```sh
npm run check:example
```

validates the example file and exits `0`.

## Licence

Apache-2.0.
