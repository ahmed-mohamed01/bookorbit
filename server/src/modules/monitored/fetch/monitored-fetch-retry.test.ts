import { expect, it } from 'vitest';
import { nextRetryAt } from './monitored-fetch-retry';
const now = new Date('2026-10-20T12:00:00Z');
it.each([
  ['timeout', 1, null, 300],
  ['timeout', 2, null, 1800],
  ['timeout', 3, null, null],
  ['unavailable', 1, null, 300],
  ['unavailable', 2, null, 1800],
  ['unavailable', 3, null, null],
  ['rate_limited', 1, 120, 120],
  ['rate_limited', 1, 5, 30],
  ['rate_limited', 1, 99999, 3600],
  ['rate_limited', 3, null, 300],
  ['author_gone', 1, null, null],
  ['auth_failed', 1, null, null],
  ['not_configured', 1, null, null],
] as const)('computes retry for %s attempt %s hint %s', (kind, attempts, hint, seconds) => {
  expect(nextRetryAt(kind, attempts, hint, now)).toEqual(seconds === null ? null : new Date(now.getTime() + seconds * 1000));
});
