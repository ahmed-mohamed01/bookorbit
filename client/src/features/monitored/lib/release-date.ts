import type { MonitoredDatePrecision } from '@bookorbit/types'

const PARTIAL_DATE = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/
const PRECISION_RANK: Record<MonitoredDatePrecision, number> = { year: 0, month: 1, day: 2 }

export interface MonitoredDateValue {
  date: Date
  precision: MonitoredDatePrecision
}

/**
 * Catalog release dates arrive at year, month or day precision, so `new Date('2026T00:00:00')`
 * produces an invalid date and the label silently disappears. Parsing the parts keeps every
 * precision usable, and the reported precision never claims more detail than the value carries.
 */
export function parseMonitoredDate(value: string | null | undefined, precision: MonitoredDatePrecision | null = null): MonitoredDateValue | null {
  const match = PARTIAL_DATE.exec(value?.trim() ?? '')
  if (!match) return null

  const [, year, month, day] = match
  const date = new Date(Number(year), month ? Number(month) - 1 : 0, day ? Number(day) : 1)
  if (Number.isNaN(date.getTime())) return null
  if (date.getFullYear() !== Number(year)) return null
  if (month && date.getMonth() !== Number(month) - 1) return null
  if (day && date.getDate() !== Number(day)) return null

  const parsed: MonitoredDatePrecision = day ? 'day' : month ? 'month' : 'year'
  const claimed = precision && PRECISION_RANK[precision] < PRECISION_RANK[parsed] ? precision : parsed
  return { date, precision: claimed }
}

export function monitoredDateTime(value: string | null | undefined): number | null {
  return parseMonitoredDate(value)?.date.getTime() ?? null
}

export function monitoredReleaseWindowStarted(value: string | null | undefined, precision: MonitoredDatePrecision | null | undefined): boolean {
  const parsed = parseMonitoredDate(value)
  if (!parsed) return false

  const effectivePrecision = precision ?? parsed.precision
  const trimmed = value?.trim() ?? ''
  if (effectivePrecision === 'day' && trimmed.length !== 10) return false
  if (effectivePrecision === 'month' && trimmed.length < 7) return false

  // The server gates auto-requests on the UTC day, so the button has to read the same clock:
  // comparing the ISO strings keeps both sides flipping on the same date everywhere.
  const start =
    effectivePrecision === 'year' ? `${trimmed.slice(0, 4)}-01-01` : effectivePrecision === 'month' ? `${trimmed.slice(0, 7)}-01` : trimmed
  const todayUtc = new Date().toISOString().slice(0, 10)
  return start <= todayUtc
}
