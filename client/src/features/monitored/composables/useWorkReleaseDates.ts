import { ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type {
  MonitoredFormat,
  MonitoredReleaseDateCandidate,
  MonitoredReleaseDateLookup,
  MonitoredReleaseLookupSource,
  MonitoredWork,
} from '@bookorbit/types'
import { fetchWorkReleaseDateCandidates, refreshWorkReleaseDates, setWorkReleaseDate } from '../api/monitored'
import { MonitoredApiError, monitoredErrorText } from '../lib/api-error'

export type MonitoredReleaseDateUnavailable = MonitoredReleaseDateLookup['unavailable'][number]

/** A listing that disagrees with the owner's own date, in the words the row's alert and the popover share. */
export interface MonitoredReleaseDateSuggestion {
  releaseDate: string
  /** Null for a month or a year: the API only takes a full date, so there is nothing to apply directly. */
  applicableDate: string | null
  text: string
}

export interface MonitoredReleaseDateState {
  candidates: MonitoredReleaseDateCandidate[]
  /** Providers that could not be asked, so an empty list never reads as "no date exists". */
  unavailable: MonitoredReleaseDateUnavailable[]
  /** Providers that answered with no dated match, so the owner can see who was checked. */
  empty: MonitoredReleaseLookupSource[]
  loading: boolean
  /** True once a lookup has answered, which is what tells an empty list apart from an unasked one. */
  loaded: boolean
  error: string | null
  saving: boolean
}

function emptyState(): MonitoredReleaseDateState {
  return { candidates: [], unavailable: [], empty: [], loading: false, loaded: false, error: null, saving: false }
}

function emptyStates(): Record<MonitoredFormat, MonitoredReleaseDateState> {
  return { ebook: emptyState(), audiobook: emptyState() }
}

/**
 * The release date a work carries per format: what the providers offer, what the owner picks, and
 * the on-demand re-check. Every call answers with the whole work, so the caller can hand the fresh
 * one to the lists and the panel rather than guessing what changed.
 */
export function useWorkReleaseDates(workId: Ref<string | null>) {
  const { t } = useI18n()
  const states = ref<Record<MonitoredFormat, MonitoredReleaseDateState>>(emptyStates())
  const refreshing = ref(false)

  // A panel moving to another book must not show the previous one's candidates for a beat.
  watch(workId, () => {
    states.value = emptyStates()
  })

  // Every release date route answers 409 while the check is switched off; the server's own sentence
  // is English, so the switch-off is named in the viewer's language instead.
  function errorText(cause: unknown, fallback: string): string {
    if (cause instanceof MonitoredApiError && cause.status === 409) return t('monitored.panel.releaseDates.refreshDisabled')
    return monitoredErrorText(cause, fallback)
  }

  function stateFor(format: MonitoredFormat): MonitoredReleaseDateState {
    return states.value[format]
  }

  async function loadCandidates(format: MonitoredFormat): Promise<void> {
    const requestedWorkId = workId.value
    if (requestedWorkId === null) return
    const state = states.value[format]
    if (state.loading) return

    state.loading = true
    state.error = null
    try {
      const lookup = await fetchWorkReleaseDateCandidates(requestedWorkId, format)
      if (workId.value !== requestedWorkId) return
      state.candidates = lookup.candidates
      state.unavailable = lookup.unavailable
      state.empty = lookup.empty
      state.loaded = true
    } catch (cause) {
      if (workId.value !== requestedWorkId) return
      state.candidates = []
      state.unavailable = []
      state.empty = []
      state.loaded = true
      state.error = errorText(cause, t('monitored.panel.releaseDates.loadFailed'))
    } finally {
      state.loading = false
    }
  }

  /** Resolves to the fresh work on success, or null once the failure has been reported in place. */
  async function setDate(format: MonitoredFormat, releaseDate: string | null): Promise<MonitoredWork | null> {
    const requestedWorkId = workId.value
    if (requestedWorkId === null) return null
    const state = states.value[format]
    if (state.saving) return null

    state.saving = true
    state.error = null
    try {
      return await setWorkReleaseDate(requestedWorkId, format, releaseDate)
    } catch (cause) {
      const fallback = releaseDate === null ? t('monitored.panel.releaseDates.clearFailed') : t('monitored.panel.releaseDates.setFailed')
      state.error = errorText(cause, fallback)
      return null
    } finally {
      state.saving = false
    }
  }

  function refreshErrorText(cause: unknown): string {
    if (cause instanceof MonitoredApiError && cause.status === 429) return t('monitored.panel.releaseDates.refreshThrottled')
    return errorText(cause, t('monitored.panel.releaseDates.refreshFailed'))
  }

  /** The re-check has no surface of its own to fail into, so it says so in a toast. */
  async function refresh(): Promise<MonitoredWork | null> {
    const requestedWorkId = workId.value
    if (requestedWorkId === null || refreshing.value) return null

    refreshing.value = true
    try {
      return await refreshWorkReleaseDates(requestedWorkId)
    } catch (cause) {
      toast.error(refreshErrorText(cause))
      return null
    } finally {
      refreshing.value = false
    }
  }

  return { states, stateFor, refreshing, loadCandidates, setDate, refresh }
}
