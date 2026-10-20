import { describe, expect, it } from 'vitest';
import type { MonitoredFetchErrorKind, MonitoredFetchState } from '@bookorbit/types';
import { isDueForAutomaticFetch, NEEDS_USER_KINDS } from './monitored-fetch-due';

export const dueNow = new Date('2026-10-20T12:00:00Z');
const past = new Date('2026-10-20T10:00:00Z');
const recent = new Date('2026-10-20T11:30:00Z');
const future = new Date('2026-10-20T13:00:00Z');
const base = {
  paused: false,
  anyFormatOn: true,
  fetchState: 'idle' as MonitoredFetchState,
  fetchErrorKind: null as MonitoredFetchErrorKind | null,
  fetchRetryAt: null as Date | null,
  lastSyncAttemptedAt: null as Date | null,
  lastRefreshedAt: past as Date | null,
};
export const dueCases = [
  ['paused', { paused: true }, false],
  ['formats off', { anyFormatOn: false }, false],
  ['queued', { fetchState: 'queued' }, false],
  ['fetching', { fetchState: 'fetching' }, false],
  ...['author_gone', 'auth_failed', 'not_configured'].map((kind) => [kind, { fetchState: 'failed', fetchErrorKind: kind }, false]),
  ['future retry suppresses elapsed interval', { fetchState: 'failed', fetchErrorKind: 'timeout', fetchRetryAt: future }, false],
  ['past retry overrides interval', { fetchState: 'failed', fetchErrorKind: 'timeout', fetchRetryAt: past, lastRefreshedAt: recent }, true],
  ['idle elapsed', {}, true],
  ['idle recent', { lastRefreshedAt: recent }, false],
  ['failed without retry elapsed', { fetchState: 'failed', fetchErrorKind: 'timeout' }, true],
  ['never attempted', { lastRefreshedAt: null }, true],
  ['recent attempt overrides old success', { lastSyncAttemptedAt: recent }, false],
  ['old attempt does not override recent success', { lastSyncAttemptedAt: past, lastRefreshedAt: recent }, false],
  ['retry exactly now', { fetchRetryAt: dueNow }, true],
  ['interval boundary is not stale', { lastRefreshedAt: new Date('2026-10-20T11:00:00Z') }, false],
  ['failed without kind', { fetchState: 'failed' }, true],
].map(([name, patch, expected]) => ({ name: name as string, row: { ...base, ...(patch as Partial<typeof base>) }, expected: expected as boolean }));

describe('isDueForAutomaticFetch', () => {
  it.each(dueCases)('$name', ({ row, expected }) => {
    expect(isDueForAutomaticFetch(row, dueNow, 1)).toBe(expected);
  });

  it('declares exactly the kinds requiring user intervention', () => {
    expect([...NEEDS_USER_KINDS].sort()).toEqual(['auth_failed', 'author_gone', 'not_configured']);
  });
});
