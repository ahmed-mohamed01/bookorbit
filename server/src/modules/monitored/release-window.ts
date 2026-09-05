import type { MonitoredDatePrecision } from '@bookorbit/types';

const DATE_SHAPE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/**
 * The calendar span a stored release date actually covers. A catalog date is only as precise as the
 * provider that supplied it: year precision '2026' means somewhere in 2026, month precision
 * '2026-11' means somewhere in November. Comparing those strings directly against a day window
 * silently treats them as January 1st and drops genuinely matching releases.
 */
export function releaseDateRange(value: string, precision: MonitoredDatePrecision | null): { start: string; end: string } | null {
  const match = DATE_SHAPE.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const effective = precision ?? (day ? 'day' : month ? 'month' : 'year');
  if (effective === 'day') return day ? { start: `${year}-${month}-${day}`, end: `${year}-${month}-${day}` } : null;
  if (effective === 'month') {
    if (!month) return null;
    const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
    return { start: `${year}-${month}-01`, end: `${year}-${month}-${String(lastDay).padStart(2, '0')}` };
  }
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

/** True when the release could fall inside the inclusive `earliest`..`latest` day window. */
export function releaseDateWithinWindow(value: string, precision: MonitoredDatePrecision | null, earliest: string, latest: string): boolean {
  const range = releaseDateRange(value, precision);
  if (!range) return false;
  return range.start <= latest && range.end >= earliest;
}
