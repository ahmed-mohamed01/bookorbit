import { describe, expect, it } from 'vitest';

import { releaseDateRange, releaseDateWithinWindow } from './release-window';

describe('releaseDateRange', () => {
  it('expands a year to the whole calendar year', () => {
    expect(releaseDateRange('2026', 'year')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });

  it('expands a month to its real last day, including February in a leap year', () => {
    expect(releaseDateRange('2026-11', 'month')).toEqual({ start: '2026-11-01', end: '2026-11-30' });
    expect(releaseDateRange('2026-02', 'month')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(releaseDateRange('2024-02', 'month')).toEqual({ start: '2024-02-01', end: '2024-02-29' });
  });

  it('keeps a day exact', () => {
    expect(releaseDateRange('2026-11-17', 'day')).toEqual({ start: '2026-11-17', end: '2026-11-17' });
  });

  it('infers the precision from the value shape when none is stored', () => {
    expect(releaseDateRange('2026', null)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(releaseDateRange('2026-11', null)).toEqual({ start: '2026-11-01', end: '2026-11-30' });
    expect(releaseDateRange('2026-11-17', null)).toEqual({ start: '2026-11-17', end: '2026-11-17' });
  });

  it('rejects a value that cannot supply the claimed precision', () => {
    expect(releaseDateRange('2026', 'day')).toBeNull();
    expect(releaseDateRange('2026', 'month')).toBeNull();
    expect(releaseDateRange('not a date', null)).toBeNull();
    expect(releaseDateRange('', null)).toBeNull();
  });
});

describe('releaseDateWithinWindow', () => {
  it('matches a year-precision release against any window inside that year', () => {
    expect(releaseDateWithinWindow('2026', 'year', '2026-11-01', '2026-11-30')).toBe(true);
    expect(releaseDateWithinWindow('2026', 'year', '2025-01-01', '2025-12-31')).toBe(false);
  });

  it('matches a month-precision release only against overlapping days', () => {
    expect(releaseDateWithinWindow('2026-11', 'month', '2026-11-30', '2026-12-05')).toBe(true);
    expect(releaseDateWithinWindow('2026-11', 'month', '2026-12-01', '2026-12-31')).toBe(false);
  });

  it('treats a day-precision release as a single day, inclusive at both edges', () => {
    expect(releaseDateWithinWindow('2026-11-17', 'day', '2026-11-17', '2026-11-17')).toBe(true);
    expect(releaseDateWithinWindow('2026-11-17', 'day', '2026-11-18', '2026-12-01')).toBe(false);
    expect(releaseDateWithinWindow('2026-11-17', 'day', '2026-01-01', '2026-11-17')).toBe(true);
  });

  it('is false for an unparseable release date', () => {
    expect(releaseDateWithinWindow('soon', null, '2026-01-01', '2026-12-31')).toBe(false);
  });
});
