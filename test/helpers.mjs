import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const bin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'bin',
  'loud-cron.mjs',
);

export function runCli(args, { cwd, env } = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, TZ: 'UTC', ...env },
  });
}

export function makeWorkspace(jobs) {
  const directory = mkdtempSync(path.join(tmpdir(), 'loud-cron-run-'));
  const jobsFile = path.join(directory, 'jobs.json');
  writeFileSync(jobsFile, JSON.stringify({ jobs }, null, 2));
  const ledger = path.join(directory, 'ledger.jsonl');
  return {
    directory,
    jobsFile,
    ledger,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function writeLedger(file, records) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    records.map((record) => `${JSON.stringify(record)}\n`).join(''),
  );
}

export function readLedger(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

export function jsonOutput(result) {
  return JSON.parse(result.stdout);
}

// Writes one byte to the file named by MARKER each time the job runs. Using a
// marker file makes "did the command really execute?" unambiguous.
export const MARKER_COMMAND =
  'node -e "require(\'fs\').appendFileSync(process.env.MARKER, \'x\')"';
