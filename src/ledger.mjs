// The durable run ledger.
//
// One JSON object per line. Every append is a single write followed by fsync,
// so a crash can lose at most an incomplete trailing line - and that line is
// reported as corruption instead of being silently ignored.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';

const REQUIRED_STRING_FIELDS = ['jobId', 'scheduledFor', 'status'];

function lineIssue(line, message) {
  return { code: 'ledger_corrupt', line, message };
}

function validateRecord(value, line) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return lineIssue(line, `ledger line ${line} is not a JSON object`);
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof value[field] !== 'string' || value[field] === '') {
      return lineIssue(line, `ledger line ${line} is missing string field "${field}"`);
    }
  }
  if (Number.isNaN(Date.parse(value.scheduledFor))) {
    return lineIssue(
      line,
      `ledger line ${line} has an unparseable scheduledFor "${value.scheduledFor}"`,
    );
  }
  return null;
}

/**
 * Read and validate a JSONL ledger.
 *
 * A missing file is not an error: it simply means no attempt has been recorded
 * yet. Malformed lines are returned as errors so callers can refuse to append
 * to a ledger they do not understand.
 */
export function readLedger(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { exists: false, records: [], errors: [] };
    }
    return {
      exists: false,
      records: [],
      errors: [
        {
          code: 'ledger_unreadable',
          line: null,
          message: `cannot read ledger "${file}": ${error.message}`,
        },
      ],
    };
  }

  const records = [];
  const errors = [];
  const lines = text.split(/\r?\n/u);

  lines.forEach((rawLine, index) => {
    if (rawLine.trim() === '') return;
    let value;
    try {
      value = JSON.parse(rawLine);
    } catch (error) {
      errors.push(lineIssue(index + 1, `ledger line ${index + 1} is not valid JSON: ${error.message}`));
      return;
    }
    const issue = validateRecord(value, index + 1);
    if (issue !== null) {
      errors.push(issue);
      return;
    }
    records.push(value);
  });

  return { exists: true, records, errors };
}

function writeAll(fd, text) {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    offset += writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

/**
 * Append one record and fsync it before returning.
 *
 * The directory is fsynced too when this call created the ledger, so the file
 * itself survives a crash as well.
 */
export function appendLedgerRecord(file, record) {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true });
  const creating = !existsSync(file);
  const fd = openSync(file, 'a', 0o600);
  try {
    writeAll(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  if (creating) {
    // Directory fsync is not available on every platform (notably Windows).
    // The record is already fsynced; this only hardens first-time creation.
    try {
      const directoryFd = openSync(directory, 'r');
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch {
      // best effort
    }
  }

  return record;
}
