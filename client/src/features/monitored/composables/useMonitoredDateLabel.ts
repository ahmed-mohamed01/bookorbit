import { useI18n } from 'vue-i18n'
import type { MonitoredDatePrecision } from '@bookorbit/types'
import { parseMonitoredDate } from '../lib/release-date'

/**
 * One reading of a release date for every surface that shows one. A date the catalog only knows to
 * the month must never be printed as a day, so the label never claims more precision than it holds.
 */
export function useMonitoredDateLabel(monthStyle: 'long' | 'short' = 'long') {
  const { d } = useI18n()

  return function monitoredDateLabel(value: string | null | undefined, precision: MonitoredDatePrecision | null = null): string | null {
    const parsed = parseMonitoredDate(value, precision)
    if (!parsed) return null
    if (parsed.precision === 'year') return String(parsed.date.getFullYear())
    if (parsed.precision === 'month') return d(parsed.date, { year: 'numeric', month: monthStyle })
    return d(parsed.date, { year: 'numeric', month: monthStyle, day: 'numeric' })
  }
}
