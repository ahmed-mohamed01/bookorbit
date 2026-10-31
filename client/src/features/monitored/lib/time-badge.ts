import { formatRelativeTime } from '@/i18n/formatters'
import { daysUntil } from './format-status'
import { parseMonitoredDate } from './release-date'

export interface TimeBadge {
  label: string
  /** True while the date is still ahead, so the colour always follows the same date as the label. */
  upcoming: boolean
}

const DAY_LIMIT = 90
const DAYS_PER_MONTH = 365.25 / 12
const MONTHS_PER_YEAR = 12

/** "in 12 days" up to 90 days away, then months, then years, in either direction. */
export function relativeReleaseLabel(days: number): string {
  const distance = Math.abs(days)
  if (distance <= DAY_LIMIT) return formatRelativeTime(days, 'day')
  const months = Math.round(distance / DAYS_PER_MONTH)
  if (months < MONTHS_PER_YEAR) return formatRelativeTime(Math.sign(days) * months, 'month')
  return formatRelativeTime(Math.sign(days) * Math.round(months / MONTHS_PER_YEAR), 'year')
}

/** The label a card cover wears ("in 7 days", "in 4 months", "in 2 years", or the year of a release over a year old) and whether it points forward. */
export function releaseTimeBadge(date: string | null | undefined, now: Date = new Date()): TimeBadge | null {
  const parsed = parseMonitoredDate(date)
  if (!parsed) return null
  const days = daysUntil(parsed.date, now)
  if (days < 0 && Math.round(-days / DAYS_PER_MONTH) >= MONTHS_PER_YEAR) return { label: String(parsed.date.getFullYear()), upcoming: false }
  return { label: relativeReleaseLabel(days), upcoming: days > 0 }
}
