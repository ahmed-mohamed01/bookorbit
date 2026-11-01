import { formatDate } from '@/i18n/formatters'

export type NextRunDay = 'today' | 'tonight' | 'tomorrow' | 'later'

export interface NextRunLabel {
  day: NextRunDay
  time: string
  date: string
}

const NIGHT_START_HOUR = 20
const NIGHT_END_HOUR = 5

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Buckets a run start relative to now so the status row can say "tonight 02:00" instead of a full date. */
export function describeNextRun(iso: string, now: Date = new Date()): NextRunLabel {
  const at = new Date(iso)
  const dayDiff = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000)
  const hour = at.getHours()
  const isNight = hour < NIGHT_END_HOUR || hour >= NIGHT_START_HOUR
  let day: NextRunDay = 'later'
  if (dayDiff === 0) day = isNight && hour >= NIGHT_START_HOUR ? 'tonight' : 'today'
  else if (dayDiff === 1) day = isNight && hour < NIGHT_END_HOUR ? 'tonight' : 'tomorrow'
  return {
    day,
    time: formatDate(at, { hour: '2-digit', minute: '2-digit' }),
    date: formatDate(at, { weekday: 'short', month: 'short', day: 'numeric' }),
  }
}
