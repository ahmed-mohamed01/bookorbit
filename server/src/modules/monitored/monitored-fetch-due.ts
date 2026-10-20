import { and, eq, isNull, lt, lte, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { MonitoredFetchErrorKind, MonitoredFetchState } from '@bookorbit/types';
import { monitoredAuthors as t } from './schema/monitored.schema';

export const NEEDS_USER_KINDS: ReadonlySet<MonitoredFetchErrorKind> = new Set(['auth_failed', 'author_gone', 'not_configured']);

export function isDueForAutomaticFetch(
  row: {
    paused: boolean;
    anyFormatOn: boolean;
    fetchState: MonitoredFetchState;
    fetchErrorKind: MonitoredFetchErrorKind | null;
    fetchRetryAt: Date | null;
    lastSyncAttemptedAt: Date | null;
    lastRefreshedAt: Date | null;
  },
  now: Date,
  syncIntervalHours: number,
): boolean {
  if (row.paused || !row.anyFormatOn) return false;
  if (row.fetchState !== 'idle' && row.fetchState !== 'failed') return false;
  if (row.fetchState === 'failed' && row.fetchErrorKind !== null && NEEDS_USER_KINDS.has(row.fetchErrorKind)) return false;
  if (row.fetchRetryAt !== null) return row.fetchRetryAt.getTime() <= now.getTime();
  const stamps = [row.lastSyncAttemptedAt, row.lastRefreshedAt].filter((stamp): stamp is Date => stamp !== null);
  return stamps.length === 0 || Math.max(...stamps.map((stamp) => stamp.getTime())) < now.getTime() - syncIntervalHours * 3_600_000;
}

export function dueForAutomaticFetchSql(now: Date, syncIntervalHours: number): SQL {
  const lastAttempt = sql`greatest(${t.lastSyncAttemptedAt}, ${t.lastRefreshedAt})`;
  return and(
    ne(t.paused, true),
    or(ne(t.ebookMode, 'off'), ne(t.audiobookMode, 'off')),
    or(eq(t.fetchState, 'idle'), and(eq(t.fetchState, 'failed'), or(isNull(t.fetchErrorKind), notInArray(t.fetchErrorKind, [...NEEDS_USER_KINDS])))),
    or(
      lte(t.fetchRetryAt, now),
      and(isNull(t.fetchRetryAt), or(isNull(lastAttempt), lt(lastAttempt, new Date(now.getTime() - syncIntervalHours * 3_600_000)))),
    ),
  )!;
}
