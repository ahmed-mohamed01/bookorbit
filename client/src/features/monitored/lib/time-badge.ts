import { daysUntil } from './format-status'
import { parseMonitoredDate } from './release-date'

export interface TimeBadge {
  label: string
  /** True while the date is still ahead, so the colour always follows the same date as the label. */
  upcoming: boolean
}

type Translate = (key: string, named?: Record<string, unknown>) => string

const DAY_LIMIT = 90
const DAYS_PER_MONTH = 365.25 / 12
const MONTHS_PER_YEAR = 12

/** "in 12 days" up to 90 days away, then months, then years, in either direction. */
export function relativeReleaseLabel(days: number, translate: Translate): string {
  if (days === 0) return translate('monitored.releases.today')
  const distance = Math.abs(days)
  const ahead = days > 0
  if (distance <= DAY_LIMIT) {
    return ahead ? translate('monitored.releases.inDays', { count: distance }) : translate('monitored.releases.daysAgo', { count: distance })
  }
  const months = Math.round(distance / DAYS_PER_MONTH)
  if (months < MONTHS_PER_YEAR) {
    return ahead ? translate('monitored.releases.inMonths', { count: months }) : translate('monitored.releases.monthsAgo', { count: months })
  }
  const years = Math.round(months / MONTHS_PER_YEAR)
  return ahead ? translate('monitored.releases.inYears', { count: years }) : translate('monitored.releases.yearsAgo', { count: years })
}

/** The label a card cover wears ("in 7 days", "in 4 months", "in 2 years", or the year of a release over a year old) and whether it points forward. */
export function releaseTimeBadge(date: string | null | undefined, translate: Translate, now: Date = new Date()): TimeBadge | null {
  const parsed = parseMonitoredDate(date)
  if (!parsed) return null
  const days = daysUntil(parsed.date, now)
  if (days < 0 && Math.round(-days / DAYS_PER_MONTH) >= MONTHS_PER_YEAR) return { label: String(parsed.date.getFullYear()), upcoming: false }
  return { label: relativeReleaseLabel(days, translate), upcoming: days > 0 }
}
