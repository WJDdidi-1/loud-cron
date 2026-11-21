# Jobs file reference

`loud-cron check <jobs.json>` reads one JSON file and validates it without
running anything. This page documents the file format, the cron syntax, the
JSON report, and every error code the checker can emit.

## Document shape

The file is either a bare array of job objects:

```json
[
  { "id": "hourly-sync", "schedule": "@hourly", "command": "node sync.mjs" }
]
```

or an object with a required `jobs` array and an optional `version`:

```json
{
  "version": 1,
  "jobs": [
    { "id": "hourly-sync", "schedule": "@hourly", "command": "node sync.mjs" }
  ]
}
```

- `version` may be a number or a non-empty string.
- `jobs` must be an array; an empty array is valid and reports `jobCount: 0`.
- Unknown top-level fields are errors, not warnings.
- A bare object without `jobs` is rejected.

## Job fields

Every job must be an object with `id`, a schedule, and `command`. The remaining
fields are optional and validated for type and range. None of them are executed
or acted on yet: `check` only validates.

| Field | Required | Accepted value |
| --- | --- | --- |
| `id` | yes | Non-empty string, unique within the file |
| `schedule` | one of `schedule`/`cron` | Five-field cron expression (string) |
| `cron` | one of `schedule`/`cron` | Alias for `schedule`; setting both is an error |
| `command` | yes | Non-empty string |
| `description` | no | Any string |
| `cwd` | no | Non-empty string |
| `env` | no | Object whose keys are non-empty and whose values are strings |
| `timeoutMs` | no | Positive whole number of milliseconds |
| `timeout` | no | Positive number of milliseconds, or a duration string such as `"500ms"`, `"30s"`, `"5m"`, `"2h"`, `"1d"` |
| `enabled` | no | Boolean |
| `shell` | no | Boolean or a non-empty shell path |
| `overlap` | no | `"skip"` or `"allow"` |

Notes:

- `schedule` and `cron` are mutually exclusive. Use one.
- `timeout` strings are case-insensitive and accept a decimal number, e.g.
  `"1.5h"`.
- `cwd` and `shell` are only checked for a non-empty value; `check` does not
  resolve the directory or the shell binary.
- `env` values are not expanded or resolved.
- Unknown fields on a job are errors. A misspelled field such as `commnd` is
  reported as `unknown_field` (and the missing required `command` is reported
  too).

## Cron syntax

Expressions use the classic five fields:

```
minute hour day-of-month month day-of-week
```

- `minute`: `0-59`
- `hour`: `0-23`
- `day-of-month`: `1-31`
- `month`: `1-12`, or `JAN`-`DEC` / full month names, case-insensitive
- `day-of-week`: `0-7`, or `SUN`-`SAT` / full day names, case-insensitive

Supported forms in each field:

- wildcard: `*`
- single value: `5`
- list: `1,15,30`
- range: `1-5`
- step: `*/15`, `0-30/10`, `5/10`
- names in the month and day-of-week fields: `JAN-MAR`, `MON-FRI`

Details:

- `7` in the day-of-week field means Sunday and is normalised to `0`.
- Ranges must be ascending; `MON-SUN` is rejected as a reversed range.
- Steps must be at least `1`; `*/0` is rejected.
- Seconds are not supported. A six-field expression is rejected rather than
  guessed at.
- Extended syntax such as `?`, `L`, `W`, and `#` is not supported.
- The parser accepts these aliases:

| Alias | Expands to |
| --- | --- |
| `@yearly`, `@annually` | `0 0 1 1 *` |
| `@monthly` | `0 0 1 * *` |
| `@weekly` | `0 0 * * 0` |
| `@daily`, `@midnight` | `0 0 * * *` |
| `@hourly` | `0 * * * *` |

`@reboot` is not supported, because a local process cannot know when the
machine rebooted from within a file check.

## Command line

```sh
loud-cron check <jobs.json> [--json]
loud-cron --help
loud-cron --version
```

`--json` is accepted for scripts that want to be explicit about the output
contract. JSON is already the default for `check`.

For a runnable demonstration of the rules on this page, run `npm run demo` from
the repository root (or `node examples/preflight.mjs`). It checks the two
example job files plus a missing path and verifies the exit status and error
codes; it never executes a job command.

For a readable jobs file, `check` always writes a JSON report to stdout:

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

Every error object has a stable `code`, a human-readable `message`, and a
`path` such as `jobs[0].schedule` (or `null` for file-level problems). Some
errors also include the `jobId` when one was parsed. All problems found in the
document are returned in one pass.

Usage mistakes (missing file argument, unknown option, unknown command) write a
message and the usage text to stderr, print no JSON, and exit `2`.

## Exit status

| Status | Meaning |
| --- | --- |
| `0` | The file is valid |
| `1` | The file is invalid, unreadable, or not valid JSON |
| `2` | Usage error (bad or missing arguments) |

A valid file only means the file is well formed. It does not mean the commands
exist, succeed, or are scheduled by anything.

## Error codes

### File and document

| Code | Meaning |
| --- | --- |
| `file_not_found` | The jobs file path does not exist |
| `file_unreadable` | The file exists but could not be read |
| `invalid_json` | The file is not parseable JSON (a BOM is tolerated) |
| `invalid_shape` | The document is neither an array nor an object |
| `missing_jobs` | An object document has no `jobs` field |
| `invalid_job` | A `jobs` entry is not an object |
| `invalid_field` | A field has the wrong type or an invalid value |
| `unknown_field` | A top-level or job field is not recognised |

### Job identity and required fields

| Code | Meaning |
| --- | --- |
| `missing_id` | `id` is absent, not a string, or empty after trimming |
| `duplicate_id` | Two jobs use the same `id`; the message names the first location |
| `missing_schedule` | Neither `schedule` nor `cron` is present |
| `conflicting_field` | Both `schedule` and `cron` are present |
| `missing_command` | `command` is absent, not a string, or empty after trimming |

### Cron expression

| Code | Meaning |
| --- | --- |
| `cron_empty` | The expression is empty or whitespace |
| `cron_truncated` | Fewer than five fields |
| `cron_too_many_fields` | More than five fields (seconds are unsupported) |
| `cron_unknown_alias` | An `@` alias is not one of the supported aliases |
| `cron_invalid_value` | A field value is not a number or a known name |
| `cron_out_of_range` | A value is outside the field's allowed range |
| `cron_invalid_step` | A step is missing, non-numeric, or less than `1` |
| `cron_invalid_range` | A range is malformed or reversed |
| `cron_invalid` | A field is empty, has an empty list item, or matches no values |
| `cron_invalid_type` | The parser was given a non-string (not reachable from a jobs file, which rejects non-strings first) |

## What this does not do yet

The current MVP implements `check` only. There is no `run`, `tick`, daemon
loop, durable ledger, missed-run reconciliation, timeout enforcement, overlap
lock, or `doctor` command yet; those are the remaining milestones, not current
features. `check` never executes a command from the file.
