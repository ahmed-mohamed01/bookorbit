import { useI18n } from 'vue-i18n'
import { monitoredFormatReleaseDate, type MonitorMode, type MonitoredDatePrecision, type MonitoredFormat, type MonitoredWork } from '@bookorbit/types'
import { formatPercent } from '@/i18n/formatters'
import { daysUntil, type MonitoredFormatStatus } from '../lib/format-status'
import { formatReleaseState } from '../lib/format-release'
import { parseMonitoredDate } from '../lib/release-date'
import { relativeReleaseLabel } from '../lib/time-badge'
import { useMonitoredDateLabel } from './useMonitoredDateLabel'

export interface FormatStatusText {
  /** The headline: "Downloading 42%", "No ebook yet", "Out Jan 27, 2027". */
  title: string
  /** The line under it, when there is one: "Released Dec 20, 2016", "in 106 days". */
  detail: string | null
  /** What happens on release, for an upcoming format the author mode decides. */
  note: string | null
  /** A short label for a compact chip. */
  short: string
}

export interface FormatStatusTextOptions {
  mode?: MonitorMode | null
  /** A live download percentage, 0 to 100. */
  downloadPercent?: number | null
}

/** Every sentence a format's status is stated in, so the drawer, card and row read the same. */
export function useFormatStatusText() {
  const { t, d } = useI18n()
  const dateLabel = useMonitoredDateLabel('short')

  function releaseColumn(work: MonitoredWork, format: MonitoredFormat) {
    const { date, precision } = monitoredFormatReleaseDate(work, format)
    return { value: date, precision }
  }

  function relative(value: string | null): string | null {
    const parsed = parseMonitoredDate(value)
    if (!parsed) return null
    return relativeReleaseLabel(daysUntil(parsed.date))
  }

  /** A chip has room for a day this year, or a month and year further out, never both. */
  function shortDate(date: Date, precision: MonitoredDatePrecision): string {
    if (precision === 'year') return String(date.getFullYear())
    if (precision === 'day' && date.getFullYear() === new Date().getFullYear()) return d(date, { month: 'short', day: 'numeric' })
    return d(date, { month: 'short', year: 'numeric' })
  }

  const outOn = (date: string) => t('monitored.formatStatus.outOn', { date })
  const expectedOn = (date: string) => t('monitored.panel.formatExpected', { date })
  const releasedOn = (date: string) => t('monitored.formatStatus.releasedOn', { date })

  /** The one sentence that says when a format is out or due, or null when no date is known. */
  function releaseLine(work: MonitoredWork, format: MonitoredFormat): string | null {
    const state = formatReleaseState(work, format)
    const date = dateLabel(state.date, state.precision)
    if (!date) return null
    if (state.kind === 'upcoming') return outOn(date)
    if (state.kind === 'expected') return expectedOn(date)
    return releasedOn(date)
  }

  function modeNote(mode: MonitorMode | null | undefined): string | null {
    if (mode === 'auto-upcoming' || mode === 'auto-all') return t('monitored.formatStatus.autoGrab')
    if (mode === 'notify') return t('monitored.formatStatus.notifyOnly')
    return null
  }

  function describe(
    work: MonitoredWork,
    format: MonitoredFormat,
    status: MonitoredFormatStatus,
    options: FormatStatusTextOptions = {},
  ): FormatStatusText {
    const release = releaseColumn(work, format)
    const date = dateLabel(release.value, release.precision)
    const percent = options.downloadPercent
    switch (status) {
      case 'owned':
        return { title: t('monitored.formatStatus.owned'), detail: null, note: null, short: t('monitored.formatStatus.short.owned') }
      case 'downloading': {
        const label = percent != null ? formatPercent(Math.max(0, Math.min(100, percent)) / 100) : null
        return {
          title: label ? t('monitored.formatStatus.downloadingPercent', { percent: label }) : t('monitored.formatStatus.downloading'),
          detail: null,
          note: null,
          short: label ?? t('monitored.formatStatus.short.downloading'),
        }
      }
      case 'importing':
        return { title: t('monitored.formatStatus.importing'), detail: null, note: null, short: t('monitored.formatStatus.short.importing') }
      case 'queued':
        return { title: t('monitored.formatStatus.queued'), detail: null, note: null, short: t('monitored.formatStatus.short.queued') }
      case 'needs_choice':
        return { title: t('monitored.formatStatus.needsChoice'), detail: null, note: null, short: t('monitored.formatStatus.short.needsChoice') }
      case 'failed':
        return { title: t('monitored.formatStatus.failed'), detail: null, note: null, short: t('monitored.formatStatus.short.failed') }
      case 'not_watching':
        return { title: t('monitored.formatStatus.notWatching'), detail: null, note: null, short: t('monitored.formatStatus.short.notWatching') }
      case 'missing':
        return {
          title: t(format === 'ebook' ? 'monitored.formatStatus.missingEbook' : 'monitored.formatStatus.missingAudiobook'),
          detail: date ? releasedOn(date) : null,
          note: null,
          short: t('monitored.formatStatus.short.missing'),
        }
      case 'upcoming': {
        const parsed = parseMonitoredDate(release.value, release.precision)
        const short = parsed ? shortDate(parsed.date, parsed.precision) : ''
        const probeStatus = work.formatReleases?.[format]?.status
        const hinted = probeStatus === 'expected' || probeStatus === 'pending'
        return {
          title: date ? (hinted ? expectedOn(date) : outOn(date)) : t('monitored.formatStatus.upcoming'),
          detail: relative(release.value),
          note: modeNote(options.mode),
          short: short || t('monitored.formatStatus.short.upcoming'),
        }
      }
      case 'unannounced':
        return {
          title: t(format === 'ebook' ? 'monitored.formatStatus.unannouncedEbook' : 'monitored.formatStatus.unannouncedAudiobook'),
          detail: null,
          note: null,
          short: t('monitored.formatStatus.short.unannounced'),
        }
    }
  }

  /** The full sentence a chip's tooltip reads, format first. */
  function sentence(work: MonitoredWork, format: MonitoredFormat, status: MonitoredFormatStatus, options: FormatStatusTextOptions = {}): string {
    const text = describe(work, format, status, options)
    const parts = [text.title, text.detail, text.note].filter((part): part is string => Boolean(part))
    return t('monitored.formatStatus.tooltip', { format: t(`monitored.formats.${format}`), status: parts.join(', ') })
  }

  return { describe, sentence, releaseLine }
}
