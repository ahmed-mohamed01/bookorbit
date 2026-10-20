import type { MonitoredFetchErrorKind } from '@bookorbit/types';

export function nextRetryAt(kind: MonitoredFetchErrorKind, attempts: number, retryAfterSeconds: number | null, now: Date): Date | null {
  let seconds: number;
  if (kind === 'rate_limited') seconds = Math.max(30, Math.min(3600, retryAfterSeconds ?? 300));
  else if ((kind === 'timeout' || kind === 'unavailable') && attempts < 3) seconds = attempts === 1 ? 300 : 1800;
  else return null;
  return new Date(now.getTime() + seconds * 1000);
}
