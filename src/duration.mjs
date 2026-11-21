// Duration parsing shared by the jobs-file validator and the runner.
//
// Keeping one parser means a duration the validator accepts is exactly a
// duration the runner can enforce. A sub-millisecond or overflowing value is
// rejected instead of silently disabling a timeout.

const DURATION_UNITS = new Map([
  ['ms', 1],
  ['s', 1000],
  ['m', 60 * 1000],
  ['h', 60 * 60 * 1000],
  ['d', 24 * 60 * 60 * 1000],
]);

export function parseDurationMs(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/iu.exec(value.trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = DURATION_UNITS.get(match[2].toLowerCase());
  const milliseconds = Math.round(amount * unit);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) return null;
  return milliseconds;
}
