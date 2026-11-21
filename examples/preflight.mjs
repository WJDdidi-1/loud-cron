#!/usr/bin/env node
/**
 * Runnable example: run `loud-cron check` against the example job files and
 * confirm the documented exit-code contract.
 *
 *   node examples/preflight.mjs
 *   npm run demo
 *
 * It uses only Node.js built-ins. `check` only parses and validates, so no
 * command from the example job files is ever executed.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const examplesDir = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(examplesDir, '..', 'bin', 'loud-cron.mjs');

// Each case states what the documented contract promises for that input.
const cases = [
  {
    name: 'valid file',
    file: 'jobs.json',
    status: 0,
    ok: true,
    errors: [],
  },
  {
    name: 'file with several problems',
    file: 'invalid-jobs.json',
    status: 1,
    ok: false,
    errors: [
      'cron_truncated',
      'duplicate_id',
      'unknown_field',
      'cron_invalid_step',
      'missing_command',
      'cron_too_many_fields',
    ],
  },
  {
    name: 'missing file',
    file: 'does-not-exist.json',
    status: 1,
    ok: false,
    errors: ['file_not_found'],
  },
];

let failures = 0;

for (const testCase of cases) {
  const result = spawnSync(process.execPath, [cli, 'check', testCase.file], {
    cwd: examplesDir,
    encoding: 'utf8',
  });

  let report = null;
  let parseError = null;
  if (result.stdout.trim() !== '') {
    try {
      report = JSON.parse(result.stdout);
    } catch (error) {
      parseError = error.message;
    }
  }

  const actualStatus = result.status;
  const actualOk = report ? report.ok : null;
  const actualCodes = report ? report.errors.map((error) => error.code) : null;

  const problems = [];
  if (actualStatus !== testCase.status) {
    problems.push(`expected exit ${testCase.status}, got ${actualStatus}`);
  }
  if (actualOk !== testCase.ok) {
    problems.push(`expected "ok": ${testCase.ok}, got ${actualOk}`);
  }
  if (parseError !== null) {
    problems.push(`stdout was not JSON: ${parseError}`);
  } else if (
    actualCodes !== null &&
    JSON.stringify(actualCodes) !== JSON.stringify(testCase.errors)
  ) {
    problems.push(
      `expected error codes ${JSON.stringify(testCase.errors)}, got ${JSON.stringify(actualCodes)}`,
    );
  }
  if (report === null && result.stderr.trim() !== '') {
    problems.push(`unexpected stderr: ${result.stderr.trim()}`);
  }

  console.log(`\n== ${testCase.name}: ${testCase.file}`);
  console.log(
    `   expected exit ${testCase.status}, "ok": ${testCase.ok}, ${testCase.errors.length} error(s)`,
  );
  console.log(
    `   actual   exit ${actualStatus}, "ok": ${actualOk}, ${actualCodes ? actualCodes.length : 0} error(s)`,
  );

  if (report !== null) {
    console.log(JSON.stringify(report, null, 2).replace(/^/gm, '   '));
  }

  if (problems.length === 0) {
    console.log('   ✓ matches the documented behavior');
  } else {
    failures += 1;
    for (const problem of problems) {
      console.log(`   ✗ ${problem}`);
    }
  }
}

console.log(
  failures === 0
    ? `\nAll ${cases.length} examples matched the documented behavior.`
    : `\n${failures} of ${cases.length} examples did not match the documented behavior.`,
);
process.exitCode = failures === 0 ? 0 : 1;
