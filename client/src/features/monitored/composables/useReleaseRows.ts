import { computed, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { MONITORED_FORMATS, type MonitoredFormat, type MonitoredReleaseDateSource, type MonitoredWork } from '@bookorbit/types'
import { relativeTimestamp } from '@/lib/relative-time'
import { formatReleaseState, type MonitoredFormatReleaseState } from '../lib/format-release'
import { useMonitoredDateLabel } from './useMonitoredDateLabel'
import type { MonitoredReleaseDateState, MonitoredReleaseDateSuggestion } from './useWorkReleaseDates'

const RELEASE_ROW_LABEL_KEYS: Record<MonitoredFormat, string> = {
  ebook: 'monitored.panel.ebookRelease',
  audiobook: 'monitored.panel.audioRelease',
}

export interface MonitoredReleaseRow {
  format: MonitoredFormat
  label: string
  value: string
  date: string | null
  muted: boolean
  unconfirmed: boolean
  unconfirmedHint: string
  source: MonitoredReleaseDateSource | null
  /** Where the date came from, how it moved and how fresh it is: hover on the row, header in the popover. */
  details: string[]
  suggestion: MonitoredReleaseDateSuggestion | null
  suggestionHint: string
  editable: boolean
  dates: MonitoredReleaseDateState
}

/**
 * What the panel says about each format's release date. The wording depends on who is looking: only
 * someone who can manage the work can look a date up or settle an alert, so nobody else is told to.
 */
export function useReleaseRows(
  work: Ref<MonitoredWork | null>,
  canManage: Ref<boolean>,
  stateFor: (format: MonitoredFormat) => MonitoredReleaseDateState,
): ComputedRef<MonitoredReleaseRow[]> {
  const { t, d } = useI18n()
  const monitoredDateLabel = useMonitoredDateLabel()

  function value(state: MonitoredFormatReleaseState): string {
    if (state.kind === 'unlisted') return t('monitored.panel.formatNotAnnounced')
    const date = monitoredDateLabel(state.date, state.precision)
    if (state.kind === 'expected') return date ? t('monitored.panel.formatExpected', { date }) : t('monitored.panel.formatNotAnnounced')
    return date ?? t('monitored.common.tba')
  }

  function provenance(state: MonitoredFormatReleaseState): string | null {
    // Only the owner can set a date, so a viewer who cannot manage the work is never "you".
    if (state.source === 'user') return t(canManage.value ? 'monitored.panel.releaseDates.setByYou' : 'monitored.panel.releaseDates.setByOwner')
    if (state.kind === 'owned' || !state.source) return null
    const source = t(`monitored.panel.source.${state.source}`)
    if (state.kind === 'unlisted') return t('monitored.panel.releaseDates.asPerUnlisted', { source })
    if (state.kind === 'expected') return t('monitored.panel.releaseDates.asPerExpected', { source })
    return t('monitored.panel.releaseDates.asPer', { source })
  }

  function history(state: MonitoredFormatReleaseState): string | null {
    // A date the owner typed was never sighted anywhere, so it has no history of its own to report.
    if (state.kind === 'owned' || state.source === 'user' || !state.date || !state.changedAt) return null
    if (state.previousDate) {
      return t('monitored.panel.releaseDates.changedFrom', {
        from: monitoredDateLabel(state.previousDate, state.previousPrecision) ?? state.previousDate,
        to: monitoredDateLabel(state.date, state.precision) ?? state.date,
        when: relativeTimestamp(state.changedAt),
      })
    }
    return t('monitored.panel.releaseDates.unchangedSince', {
      date: d(new Date(state.changedAt), { year: 'numeric', month: 'long', day: 'numeric' }),
    })
  }

  // A date the owner typed was never checked against anything, so it carries no "checked" age.
  function checked(state: MonitoredFormatReleaseState): string | null {
    if (state.kind === 'owned' || state.source === 'user' || !state.checkedAt) return null
    return t('monitored.panel.checkedAgo', { when: relativeTimestamp(state.checkedAt) })
  }

  function suggestion(state: MonitoredFormatReleaseState): MonitoredReleaseDateSuggestion | null {
    const suggested = state.suggested
    if (!suggested) return null
    const date = monitoredDateLabel(suggested.releaseDate, suggested.precision) ?? suggested.releaseDate
    const when = relativeTimestamp(suggested.changedAt)
    return {
      releaseDate: suggested.releaseDate,
      applicableDate: suggested.precision === 'day' && suggested.releaseDate.length === 10 ? suggested.releaseDate : null,
      text: suggested.source
        ? t('monitored.panel.releaseDates.suggestedBy', { source: t(`monitored.panel.source.${suggested.source}`), date, when })
        : t('monitored.panel.releaseDates.suggested', { date, when }),
    }
  }

  return computed(() => {
    const current = work.value
    if (!current) return []
    // Whoever manages the work can always look a date up: an unconfirmed marker or an alert on a
    // format they stopped monitoring would otherwise be a dead end.
    const editable = canManage.value
    return MONITORED_FORMATS.map((format) => {
      const state = formatReleaseState(current, format)
      const found = suggestion(state)
      return {
        format,
        label: t(RELEASE_ROW_LABEL_KEYS[format]),
        value: value(state),
        date: state.date,
        muted: state.kind === 'unlisted' || state.kind === 'unknown',
        unconfirmed: state.kind === 'expected',
        unconfirmedHint: editable ? t('monitored.panel.releaseDates.notConfirmedHint') : t('monitored.panel.releaseDates.notConfirmedReadOnly'),
        // The popover offers "Clear my date" from this, owned format or not.
        source: state.kind === 'owned' && state.source !== 'user' ? null : state.source,
        details: [provenance(state), history(state), checked(state)].filter((line): line is string => line !== null),
        suggestion: found,
        // A listing known only to the month cannot be applied as it stands, so the hint does not promise that.
        suggestionHint: found?.applicableDate
          ? t('monitored.panel.releaseDates.suggestedHint')
          : t('monitored.panel.releaseDates.suggestedHintReview'),
        editable,
        dates: stateFor(format),
      }
    })
  })
}
