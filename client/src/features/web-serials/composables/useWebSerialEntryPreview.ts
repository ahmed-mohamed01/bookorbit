import { computed, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { WebSerialCatalogEntry, WebSerialSeriesDetail, WebSerialSeriesMatch, WebSerialSourceOption, WebSerialSuggestion } from '@bookorbit/types'
import { fetchDiscoverSources, fetchSeries } from '../api/webSerials'
import { messageOf } from '../lib/messageOf'
import { isAbort, loadWhileSeriesLoads } from '../lib/seriesLoading'
import { optionsFromSuggestion, preselectedOption } from '../lib/serialSuggest'

/**
 * finding: asking the server which of the user's sources carry the series. opening: the most complete one is chosen and its
 * chapters are loading. ready: a source series is in hand. none: no enabled source has it. error: the check or the load failed,
 * or the sheet closed while a long chapter list was still loading (reopening asks again).
 */
export type WebSerialEntryPreviewState = 'idle' | 'finding' | 'opening' | 'ready' | 'none' | 'error'

export function matchOfEntry(entry: WebSerialCatalogEntry): WebSerialSeriesMatch {
  return {
    provider: 'mangabaka',
    id: entry.matchId,
    title: entry.title,
    url: entry.url,
    year: entry.year,
    authors: entry.authors,
    artists: entry.artists,
    status: entry.status,
    genres: entry.genres,
    ...(entry.publication ? { publication: entry.publication } : {}),
  }
}

/**
 * A series opened from the series database has no source series yet. This looks for the sources carrying it, preselects the
 * most complete one and loads it, so the rest of the preview behaves exactly as if that source had been opened directly.
 * A `suggestion` (chosen from the search box) already lists its copies: they become the alternatives at once, one is opened,
 * and the others' chapter counts are loaded one at a time afterwards, only while the sheet is `open`.
 */
export function useWebSerialEntryPreview(
  entry: Ref<WebSerialCatalogEntry | null>,
  suggestion?: Ref<WebSerialSuggestion | null>,
  open: Ref<boolean> = ref(true),
  deferred?: Ref<boolean>,
) {
  const state = ref<WebSerialEntryPreviewState>('idle')
  const options = ref<WebSerialSourceOption[]>([])
  const failedSources = ref<string[]>([])
  const detail = ref<WebSerialSeriesDetail | null>(null)
  const error = ref<string | null>(null)
  const chosenKey = ref<string | null>(null)
  /** The site whose long chapter list the server is still loading, while the preview waits for it. */
  const pendingSource = ref<string | null>(null)
  const preselectedKey = computed(() => chosenKey.value ?? options.value[0]?.seriesKey ?? null)
  let token = 0
  let controller: AbortController | null = null
  let counting: AbortController | null = null
  let countTarget: { openedKey: string; matchId: string | undefined } | null = null
  let loadedAt = 0

  function chaptersOf(opened: WebSerialSeriesDetail): Pick<WebSerialSourceOption, 'chapterCount' | 'latestAt'> {
    const times = opened.units.map((unit) => (unit.publishedAt ? new Date(unit.publishedAt).getTime() : Number.NaN)).filter(Number.isFinite)
    // A unit can be a whole volume of chapters, so count chapters, not units.
    const chapterCount = opened.units.reduce((sum, unit) => sum + (unit.chapterCount || 1), 0)
    return { chapterCount, latestAt: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null }
  }

  function settleOption(seriesKey: string, patch: Partial<WebSerialSourceOption>): void {
    options.value = options.value.map((option) => (option.seriesKey === seriesKey ? { ...option, ...patch } : option))
  }

  function markMostComplete(): void {
    if (options.value.some((option) => option.chaptersUnknown)) return
    const top = Math.max(...options.value.map((option) => option.chapterCount))
    options.value = options.value.map((option) => ({ ...option, mostComplete: option.chapterCount === top && top > 0 }))
  }

  function stopCounting(): void {
    counting?.abort()
    counting = null
  }

  /** Each count is a full chapter-list load from the site, so it runs one at a time and stops when the sheet closes. */
  async function countOthers(mine: number): Promise<void> {
    const target = countTarget
    if (!target || counting || !open.value) return
    const current = new AbortController()
    counting = current
    try {
      for (const option of options.value) {
        if (option.seriesKey === target.openedKey || !option.chaptersUnknown) continue
        try {
          const other = await fetchSeries(option.seriesKey, target.matchId, current.signal)
          if (mine !== token || current.signal.aborted) return
          settleOption(option.seriesKey, { ...chaptersOf(other), chaptersUnknown: false })
        } catch {
          if (mine !== token || current.signal.aborted) return
        }
      }
      if (mine === token) markMostComplete()
    } finally {
      if (counting === current) counting = null
    }
  }

  /** Opens the chosen copy, asking again while the server is still loading a long chapter list. */
  async function openSeries(option: WebSerialSourceOption, matchId: string | undefined, mine: number): Promise<WebSerialSeriesDetail> {
    const current = new AbortController()
    controller = current
    try {
      return await loadWhileSeriesLoads(() => fetchSeries(option.seriesKey, matchId, current.signal), {
        signal: current.signal,
        onPending: () => {
          if (mine === token) pendingSource.value = option.sourceName
        },
      })
    } finally {
      if (mine === token) pendingSource.value = null
    }
  }

  function failOpening(cause: unknown): void {
    error.value = isAbort(cause) ? null : messageOf(cause, 'webSerials.api.openSeries')
    state.value = 'error'
  }

  async function loadSuggestion(current: WebSerialSuggestion, mine: number): Promise<void> {
    const listed = optionsFromSuggestion(current)
    options.value = listed
    const first = preselectedOption(listed)
    chosenKey.value = first?.seriesKey ?? null
    if (!first) {
      state.value = 'none'
      return
    }
    state.value = 'opening'
    const matchId = current.matchId
    try {
      const opened = await openSeries(first, matchId, mine)
      if (mine !== token) return
      settleOption(first.seriesKey, { ...chaptersOf(opened), chaptersUnknown: false })
      countTarget = { openedKey: first.seriesKey, matchId }
      detail.value = opened
      loadedAt = Date.now()
      state.value = 'ready'
    } catch (cause) {
      if (mine !== token) return
      failOpening(cause)
      return
    }
    await countOthers(mine)
  }

  async function load(refresh = false): Promise<void> {
    const current = entry.value
    const suggested = suggestion?.value ?? null
    const mine = ++token
    controller?.abort()
    controller = null
    stopCounting()
    countTarget = null
    options.value = []
    failedSources.value = []
    detail.value = null
    chosenKey.value = null
    error.value = null
    pendingSource.value = null
    if (deferred?.value) {
      state.value = 'idle'
      return
    }
    if (suggested && open.value) {
      await loadSuggestion(suggested, mine)
      return
    }
    if (!current || !open.value) {
      state.value = 'idle'
      return
    }
    state.value = 'finding'
    controller = new AbortController()
    let first: WebSerialSourceOption | undefined
    try {
      const result = await fetchDiscoverSources(current.kind, current.matchId, controller.signal, refresh)
      if (mine !== token) return
      options.value = result.options
      failedSources.value = result.failedSources
      first = result.options[0]
    } catch (cause) {
      if (mine !== token) return
      error.value = messageOf(cause, 'webSerials.api.discoverSources')
      state.value = 'error'
      return
    }
    if (!first) {
      state.value = 'none'
      return
    }
    state.value = 'opening'
    try {
      const opened = await openSeries(first, current.matchId, mine)
      if (mine !== token) return
      detail.value = opened
      loadedAt = Date.now()
      state.value = 'ready'
    } catch (cause) {
      if (mine !== token) return
      failOpening(cause)
    }
  }

  /** Closing mid-load drops that load entirely, so nothing keeps asking the server and reopening starts afresh. */
  function abandonLoad(): void {
    token++
    controller?.abort()
    controller = null
    pendingSource.value = null
    error.value = null
    state.value = 'error'
  }

  /** Reopening the same series reuses its answer only while it is fresh, so a finished download shows as in the library. */
  function refreshIfStale(maxAgeMs: number): Promise<void> | null {
    if (state.value === 'idle' || state.value === 'none' || state.value === 'error') return load()
    if (state.value === 'ready' && Date.now() - loadedAt > maxAgeMs) return load()
    return null
  }

  watch([entry, suggestion ?? ref(null), deferred ?? ref(false)], () => void load(), { immediate: true })

  watch(open, (isOpen) => {
    if (isOpen) {
      if (state.value === 'ready') void countOthers(token)
      return
    }
    stopCounting()
    if (state.value === 'finding' || state.value === 'opening') abandonLoad()
  })

  onScopeDispose(() => {
    stopCounting()
    controller?.abort()
  })

  return {
    state,
    options,
    failedSources,
    detail,
    error,
    pendingSource,
    preselectedKey,
    refreshIfStale,
    retry: () => load(),
    retryFailed: () => load(true),
  }
}
