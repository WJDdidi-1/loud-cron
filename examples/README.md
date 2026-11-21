# Examples

These files show the shape of a `loud-cron` jobs file and what `check` reports
when a file is wrong. `check` only parses and validates; it never executes the
commands in `examples/jobs.json`.

Run them from this directory with the CLI checked out beside it:

```sh
node ../bin/loud-cron.mjs check jobs.json
```

## Run every case at once

`preflight.mjs` is a zero-dependency, runnable example. It runs `check` against
the valid file, the file with several problems, and a missing path, then
compares each exit status and set of error codes with the documented contract.
It exits `0` only if all three match, so it also shows the exit-code contract a
CI job can rely on:

```sh
node preflight.mjs
```

From the repository root, `npm run demo` runs the same script. The output is the
JSON report `check` prints for each case, followed by:

```text
All 3 examples matched the documented behavior.
```

`check` only parses and validates, so the demo never runs a command from the
example job files.

## A valid file: `jobs.json`

```json
{
  "ok": true,
  "file": "jobs.json",
  "jobCount": 3,
  "errors": []
}
```

Exit status is `0`. From the repository root, `npm run check:example` runs the
same check.

The three jobs demonstrate the schedule forms the validator accepts: a classic
five-field expression, names in the day-of-week field (`MON-FRI`), and the
`@hourly` alias in the `cron` field instead of `schedule`.

## A file with several problems: `invalid-jobs.json`

```sh
node ../bin/loud-cron.mjs check invalid-jobs.json
```

```json
{
  "ok": false,
  "file": "invalid-jobs.json",
  "jobCount": 4,
  "errors": [
    {
      "code": "cron_truncated",
      "message": "cron expression has 4 fields; expected 5 (minute hour day-of-month month day-of-week)",
      "path": "jobs[1].schedule",
      "jobId": "nightly-report"
    },
    {
      "code": "duplicate_id",
      "message": "duplicate job id \"nightly-report\" (already defined at jobs[0])",
      "path": "jobs[1].id",
      "jobId": "nightly-report"
    },
    {
      "code": "unknown_field",
      "message": "unknown job field \"commnd\"",
      "path": "jobs[2].commnd"
    },
    {
      "code": "cron_invalid_step",
      "message": "minute field segment \"*/0\" must use a step of at least 1",
      "path": "jobs[2].schedule",
      "jobId": "retry-sync"
    },
    {
      "code": "missing_command",
      "message": "job is missing the required \"command\" field",
      "path": "jobs[2].command",
      "jobId": "retry-sync"
    },
    {
      "code": "cron_too_many_fields",
      "message": "cron expression has 6 fields; expected 5 (seconds are not supported)",
      "path": "jobs[3].schedule",
      "jobId": "six-fields"
    }
  ]
}
```

Exit status is `1`. Every problem found in the file is reported in one pass;
`path` points at the field to fix. The second job has two errors because its
schedule is truncated and it reuses an existing ID. The third job has a
misspelled `commnd` field, which strict validation treats as an unknown field
(and therefore also reports the missing `command`).

Use this check in CI before deploying a schedule change, so a typo fails the
build instead of turning into a job that never runs. Once the package is
published to npm, the CI step is `npx loud-cron check jobs.json`; until then,
run `node path/to/loud-cron/bin/loud-cron.mjs check jobs.json` from the
checkout.

See [../docs/jobs-file.md](../docs/jobs-file.md) for the complete field
reference.
