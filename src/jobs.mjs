// Validation for the loud-cron jobs file.
//
// A jobs file is either a bare array of job objects or an object with a
// "jobs" array (plus an optional "version"). Validation is deliberately
// strict: an unknown field is almost always a typo or a feature from a newer
// version, and silently ignoring it is how a scheduler ends up doing the
// wrong thing at 3am.

import { validateCronExpression } from './cron.mjs';

export const TOP_LEVEL_FIELDS = new Set(['version', 'jobs']);

export const JOB_FIELDS = new Set([
  'id',
  'schedule',
  'cron',
  'command',
  'description',
  'cwd',
  'env',
  'timeoutMs',
  'timeout',
  'enabled',
  'shell',
  'overlap',
]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function issue(code, message, path, extra = {}) {
  return { code, message, path, ...extra };
}

function pushTypeError(errors, value, expected, path, code = 'invalid_field') {
  const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  errors.push(issue(code, `expected ${expected}, got ${actual}`, path));
}

function validateVersion(value, errors) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    pushTypeError(errors, value, 'a number or string', 'version');
    return;
  }
  if (typeof value === 'string' && value.trim() === '') {
    errors.push(issue('invalid_field', 'version must not be empty', 'version'));
  }
}

function validateEnv(value, errors, path) {
  if (!isPlainObject(value)) {
    pushTypeError(errors, value, 'an object of environment variables', path);
    return;
  }
  for (const key of Object.keys(value)) {
    const envPath = `${path}.${key}`;
    if (key === '') {
      errors.push(issue('invalid_field', 'environment variable name must not be empty', envPath));
      continue;
    }
    if (typeof value[key] !== 'string') {
      pushTypeError(
        errors,
        value[key],
        'a string environment variable value',
        envPath,
      );
    }
  }
}

function validateTimeout(value, errors, path, { millisecondsOnly = false } = {}) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      errors.push(
        issue(
          'invalid_field',
          'timeout must be a positive whole number of milliseconds',
          path,
        ),
      );
    }
    return;
  }

  if (millisecondsOnly) {
    pushTypeError(errors, value, 'a positive whole number of milliseconds', path);
    return;
  }

  const match =
    typeof value === 'string'
      ? /^(\d+(?:\.\d+)?)\s*(?:ms|s|m|h|d)$/i.exec(value.trim())
      : null;
  if (match === null || Number(match[1]) <= 0) {
    errors.push(
      issue(
        'invalid_field',
        'timeout must be a positive number of milliseconds or a duration such as "500ms", "30s" or "5m"',
        path,
      ),
    );
  }
}

function validateJob(job, index, errors, firstIdIndexes) {
  const basePath = `jobs[${index}]`;
  if (!isPlainObject(job)) {
    pushTypeError(errors, job, 'an object', basePath, 'invalid_job');
    return;
  }

  for (const key of Object.keys(job).sort()) {
    if (!JOB_FIELDS.has(key)) {
      errors.push(
        issue('unknown_field', `unknown job field "${key}"`, `${basePath}.${key}`),
      );
    }
  }

  let jobId;
  if (!hasOwn(job, 'id')) {
    errors.push(
      issue('missing_id', 'job is missing the required "id" field', `${basePath}.id`),
    );
  } else if (typeof job.id !== 'string') {
    pushTypeError(errors, job.id, 'a non-empty string', `${basePath}.id`);
  } else if (job.id.trim() === '') {
    errors.push(
      issue('missing_id', 'job "id" must not be empty', `${basePath}.id`),
    );
  } else {
    jobId = job.id;
  }

  const hasSchedule = hasOwn(job, 'schedule');
  const hasCronAlias = hasOwn(job, 'cron');
  if (!hasSchedule && !hasCronAlias) {
    errors.push(
      issue(
        'missing_schedule',
        'job is missing the required "schedule" field',
        `${basePath}.schedule`,
      ),
    );
  } else if (hasSchedule && hasCronAlias) {
    errors.push(
      issue(
        'conflicting_field',
        'job must not set both "schedule" and its alias "cron"',
        `${basePath}.schedule`,
      ),
    );
  } else {
    const field = hasSchedule ? 'schedule' : 'cron';
    const value = job[field];
    const path = `${basePath}.${field}`;
    if (typeof value !== 'string') {
      pushTypeError(errors, value, 'a five-field cron expression string', path);
    } else {
      const result = validateCronExpression(value);
      if (!result.ok) {
        errors.push(
          issue(result.code, result.message, path, jobId === undefined ? {} : { jobId }),
        );
      }
    }
  }

  if (!hasOwn(job, 'command')) {
    errors.push(
      issue(
        'missing_command',
        'job is missing the required "command" field',
        `${basePath}.command`,
        jobId === undefined ? {} : { jobId },
      ),
    );
  } else if (typeof job.command !== 'string') {
    pushTypeError(errors, job.command, 'a non-empty command string', `${basePath}.command`);
  } else if (job.command.trim() === '') {
    errors.push(
      issue(
        'missing_command',
        'job "command" must not be empty',
        `${basePath}.command`,
        jobId === undefined ? {} : { jobId },
      ),
    );
  }

  if (hasOwn(job, 'description') && typeof job.description !== 'string') {
    pushTypeError(errors, job.description, 'a string', `${basePath}.description`);
  }

  if (hasOwn(job, 'cwd')) {
    if (typeof job.cwd !== 'string' || job.cwd.trim() === '') {
      errors.push(
        issue('invalid_field', 'cwd must be a non-empty string', `${basePath}.cwd`),
      );
    }
  }

  if (hasOwn(job, 'env')) {
    validateEnv(job.env, errors, `${basePath}.env`);
  }

  if (hasOwn(job, 'timeoutMs')) {
    validateTimeout(job.timeoutMs, errors, `${basePath}.timeoutMs`, {
      millisecondsOnly: true,
    });
  }

  if (hasOwn(job, 'timeout')) {
    validateTimeout(job.timeout, errors, `${basePath}.timeout`);
  }

  if (hasOwn(job, 'enabled') && typeof job.enabled !== 'boolean') {
    pushTypeError(errors, job.enabled, 'a boolean', `${basePath}.enabled`);
  }

  if (hasOwn(job, 'shell')) {
    const shell = job.shell;
    if (!(typeof shell === 'boolean' || (typeof shell === 'string' && shell.trim() !== ''))) {
      errors.push(
        issue(
          'invalid_field',
          'shell must be a boolean or a non-empty shell path',
          `${basePath}.shell`,
        ),
      );
    }
  }

  if (hasOwn(job, 'overlap')) {
    if (job.overlap !== 'skip' && job.overlap !== 'allow') {
      errors.push(
        issue(
          'invalid_field',
          'overlap must be "skip" or "allow"',
          `${basePath}.overlap`,
        ),
      );
    }
  }

  if (jobId !== undefined) {
    if (firstIdIndexes.has(jobId)) {
      errors.push(
        issue(
          'duplicate_id',
          `duplicate job id "${jobId}" (already defined at jobs[${firstIdIndexes.get(jobId)}])`,
          `${basePath}.id`,
          { jobId },
        ),
      );
    } else {
      firstIdIndexes.set(jobId, index);
    }
  }
}

/**
 * Validate a parsed jobs JSON document.
 *
 * Returns `{ ok, jobCount, errors }`. Errors are plain objects with a stable
 * `code`, a human-readable `message`, and a JSON-path-like `path`.
 */
export function validateJobsDocument(document) {
  const errors = [];
  let jobs = null;
  let jobCount = 0;

  if (Array.isArray(document)) {
    jobs = document;
  } else if (isPlainObject(document)) {
    for (const key of Object.keys(document).sort()) {
      if (!TOP_LEVEL_FIELDS.has(key)) {
        errors.push(
          issue('unknown_field', `unknown top-level field "${key}"`, key),
        );
      }
    }
    if (hasOwn(document, 'version')) {
      validateVersion(document.version, errors);
    }
    if (!hasOwn(document, 'jobs')) {
      errors.push(
        issue('missing_jobs', 'jobs file is missing the required "jobs" array', 'jobs'),
      );
    } else if (!Array.isArray(document.jobs)) {
      pushTypeError(errors, document.jobs, 'an array of jobs', 'jobs');
    } else {
      jobs = document.jobs;
    }
  } else {
    errors.push(
      issue(
        'invalid_shape',
        'jobs file must be an array of jobs or an object with a "jobs" array',
        null,
      ),
    );
  }

  if (jobs !== null) {
    jobCount = jobs.length;
    const firstIdIndexes = new Map();
    jobs.forEach((job, index) => {
      validateJob(job, index, errors, firstIdIndexes);
    });
  }

  return { ok: errors.length === 0, jobCount, errors };
}
