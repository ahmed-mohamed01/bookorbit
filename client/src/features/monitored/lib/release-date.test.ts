import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { monitoredDateTime, monitoredReleaseWindowStarted, parseMonitoredDate } from './release-date'

describe('parseMonitoredDate', () => {
  it('parses year, month and day precision without naive Date parsing', () => {
    expect(parseMonitoredDate('2026')).toEqual({ date: new Date(2026, 0, 1), precision: 'year' })
    expect(parseMonitoredDate('2026-03')).toEqual({ date: new Date(2026, 2, 1), precision: 'month' })
    expect(parseMonitoredDate('2026-03-14')).toEqual({ date: new Date(2026, 2, 14), precision: 'day' })
  })

  it('never claims more precision than the value carries', () => {
    expect(parseMonitoredDate('2026', 'day')?.precision).toBe('year')
    expect(parseMonitoredDate('2026-03-14', 'year')?.precision).toBe('year')
    expect(parseMonitoredDate('2026-03-14', 'month')?.precision).toBe('month')
  })

  it('rejects empty, malformed and out-of-range values', () => {
    expect(parseMonitoredDate(null)).toBeNull()
    expect(parseMonitoredDate('')).toBeNull()
    expect(parseMonitoredDate('not a date')).toBeNull()
    expect(parseMonitoredDate('2026-13')).toBeNull()
    expect(parseMonitoredDate('2026-02-31')).toBeNull()
  })

  it('reports the start of the period as a timestamp', () => {
    expect(monitoredDateTime('2026')).toBe(new Date(2026, 0, 1).getTime())
    expect(monitoredDateTime('nope')).toBeNull()
  })
})

describe('monitoredReleaseWindowStarted', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-05T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses the exact date for day precision, including today', () => {
    expect(monitoredReleaseWindowStarted('2026-09-04', 'day')).toBe(true)
    expect(monitoredReleaseWindowStarted('2026-09-05', 'day')).toBe(true)
    expect(monitoredReleaseWindowStarted('2026-09-06', 'day')).toBe(false)
  })

  it('uses the first of the month for month precision', () => {
    expect(monitoredReleaseWindowStarted('2026-09-30', 'month')).toBe(true)
    expect(monitoredReleaseWindowStarted('2026-10', 'month')).toBe(false)
  })

  it('uses January 1 for year precision', () => {
    expect(monitoredReleaseWindowStarted('2026-12-31', 'year')).toBe(true)
    expect(monitoredReleaseWindowStarted('2027', 'year')).toBe(false)
  })

  it('rejects absent, malformed and precision-incomplete dates', () => {
    expect(monitoredReleaseWindowStarted(null, 'day')).toBe(false)
    expect(monitoredReleaseWindowStarted(undefined, undefined)).toBe(false)
    expect(monitoredReleaseWindowStarted('garbage', null)).toBe(false)
    expect(monitoredReleaseWindowStarted('2026-09', 'day')).toBe(false)
  })
})
