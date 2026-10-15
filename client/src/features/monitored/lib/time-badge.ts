import { daysUntil } from './format-status'
import { parseMonitoredDate } from './release-date'

export interface TimeBadge {
  label: string
  /** True while the date is still ahead, so the colour always follows the same date as the label. */
  upcoming: boolean
}

type Translate = (key: string, named?: Record<string, unknown>) => string

/** The label a card cover wears ("in 7 days", "80 days ago", or the year once it is over a year old) and whether it points forward. */
export function releaseTimeBadge(date: string | null | undefined, translate: Translate, now: Date = new Date()): TimeBadge | null {
  const parsed = parseMonitoredDate(date)
  if (!parsed) return null
  const days = daysUntil(parsed.date, now)
  if (days === 0) return { label: translate('monitored.releases.today'), upcoming: false }
  if (days < -365) return { label: String(parsed.date.getFullYear()), upcoming: false }
  const label =
    days > 0 ? translate('monitored.releases.inDays', { count: days }) : translate('monitored.releases.daysAgo', { count: Math.abs(days) })
  return { label, upcoming: days > 0 }
}
