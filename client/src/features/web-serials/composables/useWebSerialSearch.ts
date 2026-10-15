import { computed, ref } from 'vue'
import { WebSerialErrorCode } from '@bookorbit/types'
import type {
  WebSerialCapabilities,
  WebSerialCatalogEntry,
  WebSerialDiscoverFallback,
  WebSerialSearchHit,
  WebSerialSeriesDetail,
} from '@bookorbit/types'
import { discoverSerials, fetchCapabilities, fetchSeries, resolveSerialUrl, searchSerials, type WebSerialSearchScope } from '../api/webSerials'
import {
  CATALOG_SORTS,
  filterHitsBySource,
  filterMachineTranslations,
  hasMachineTranslations,
  RESULT_DENSITIES,
  RESULT_SORTS,
  sortCatalogEntries,
  sortSearchHits,
  sourceOptionsOf,
  type WebSerialCatalogSort,
  type WebSerialResultDensity,
  type WebSerialResultSort,
} from '../lib/serialPresentation'
import { isSerialLink } from '../lib/serialUrl'
import type { StoredWebSerialSearch } from './webSerialSearchStore'
import { i18n } from '@/i18n'
import { messageOf } from '../lib/messageOf'
import { isAbort, loadWhileSeriesLoads } from '../lib/seriesLoading'

export const MIN_QUERY_LENGTH = 2

const SORT_STORAGE_KEY = 'bookorbit.webSerials.resultSort'
const DENSITY_STORAGE_KEY = 'bookorbit.webSerials.resultDensity'

function readChoice<T extends string>(key: string, allowed: readonly T[]): T {
  try {
    const stored = localStorage.getItem(key)
    return allowed.find((value) => value === stored) ?? allowed[0]!
  } catch {
    return allowed[0]!
  }
}

function writeChoice(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* preference stays in memory */
  }
}

export type WebSerialSearchKind = 'manga' | 'novel'

/** series: one row per series from the series database. sites: the release sources searched directly. */
export type WebSerialSearchMode = 'series' | 'sites'

interface SearchRun {
  /** Keep the current results on screen and swap them for the new answer when it arrives. */
  quiet?: boolean
  /** Ask the server to skip its cached answer. */
  refresh?: boolean
  text?: string
}

export function hitIdentity(hit: WebSerialSearchHit): string {
  return hit.seriesKey ?? hit.url ?? hit.title
}

export function useWebSerialSearch() {
  const query = ref('')
  const scope = ref<WebSerialSearchScope>('all')
  const mangaHits = ref<WebSerialSearchHit[]>([])
  const novelHits = ref<WebSerialSearchHit[]>([])
  const allHits = computed(() => [...mangaHits.value, ...novelHits.value])
  const showMachineTranslations = ref(false)
  const hasMtlHits = computed(() => hasMachineTranslations(allHits.value))
  const hits = computed(() => filterMachineTranslations(allHits.value, showMachineTranslations.value))
  const selectedSource = ref<string | null>(null)
  const sourceOptions = computed(() => sourceOptionsOf(hits.value))
  const activeSource = computed(() =>
    selectedSource.value !== null && sourceOptions.value.some((option) => option.sourceName === selectedSource.value) ? selectedSource.value : null,
  )
  const resultSort = ref<WebSerialResultSort>(readChoice(SORT_STORAGE_KEY, RESULT_SORTS))
  const resultDensity = ref<WebSerialResultDensity>(readChoice(DENSITY_STORAGE_KEY, RESULT_DENSITIES))
  const visibleHits = computed(() => sortSearchHits(filterHitsBySource(hits.value, activeSource.value), resultSort.value))
  const mode = ref<WebSerialSearchMode>('series')
  const entries = ref<WebSerialCatalogEntry[]>([])
  const entriesQuery = ref('')
  const discovering = ref(false)
  const fallbackReason = ref<WebSerialDiscoverFallback | null>(null)
  // The series list has no per-source results, so the Source sort does not apply to it.
  const catalogSort = computed<WebSerialCatalogSort>(() => CATALOG_SORTS.find((value) => value === resultSort.value) ?? 'relevance')
  const visibleEntries = computed(() => sortCatalogEntries(entries.value, catalogSort.value))
  const canReturnToSeries = computed(() => mode.value === 'sites' && entries.value.length > 0)
  const failedSources = ref<string[]>([])
  const novelSourcesDisabled = ref(false)
  const pendingKinds = ref<WebSerialSearchKind[]>([])
  const searching = computed(() => pendingKinds.value.length > 0 || discovering.value)
  const resolvingLink = ref(false)
  const openingKey = ref<string | null>(null)
  const hasSearched = ref(false)
  const fetchedAt = ref<number | null>(null)
  const refreshing = ref(false)
  const refreshFailed = ref(false)
  let fetchedQuery = ''
  let fetchedKind: WebSerialSearchScope = 'all'
  const searchError = ref<string | null>(null)
  const previewError = ref<string | null>(null)
  /** Set while the server is still loading a long chapter list for the preview being opened; `source` is null for a link. */
  const previewPending = ref<{ source: string | null } | null>(null)
  const capabilities = ref<WebSerialCapabilities | null>(null)
  const capabilitiesFailed = ref(false)
  const error = computed(() => searchError.value ?? previewError.value)

  let searchController: AbortController | null = null
  let previewController: AbortController | null = null

  /** Opens a series for the preview, asking again while its chapter list is still loading, until `cancelPreview`. */
  async function loadPreview(load: (signal: AbortSignal) => Promise<WebSerialSeriesDetail>, source: string | null): Promise<WebSerialSeriesDetail> {
    previewController?.abort()
    const current = new AbortController()
    previewController = current
    try {
      return await loadWhileSeriesLoads(() => load(current.signal), {
        signal: current.signal,
        onPending: () => {
          if (previewController === current) previewPending.value = { source }
        },
      })
    } finally {
      if (previewController === current) {
        previewController = null
        previewPending.value = null
      }
    }
  }

  function cancelPreview(): void {
    previewController?.abort()
  }

  const isLink = computed(() => isSerialLink(query.value))
  const canSubmit = computed(() => !resolvingLink.value && (isLink.value || query.value.trim().length >= MIN_QUERY_LENGTH))
  const novelLinksOnly = computed(() => capabilities.value !== null && capabilities.value.novel.available && !capabilities.value.novel.searchable)
  const availableScopes = computed<WebSerialSearchScope[]>(() => {
    const value = capabilities.value
    if (!value) return ['all', 'manga', 'novel']
    const scopes: WebSerialSearchScope[] = []
    if (value.manga.available && value.novel.available) scopes.push('all')
    if (value.manga.available) scopes.push('manga')
    if (value.novel.available) scopes.push('novel')
    return scopes
  })
  const nothingAvailable = computed(() => capabilities.value !== null && !capabilities.value.manga.available && !capabilities.value.novel.available)

  async function loadCapabilities(): Promise<void> {
    capabilitiesFailed.value = false
    try {
      capabilities.value = await fetchCapabilities()
      if (!availableScopes.value.includes(scope.value)) scope.value = availableScopes.value[0] ?? 'all'
    } catch {
      capabilitiesFailed.value = true
    }
  }

  function setScope(next: WebSerialSearchScope): void {
    scope.value = next
  }

  function setSource(next: string | null): void {
    selectedSource.value = next
  }

  function setShowMachineTranslations(next: boolean): void {
    showMachineTranslations.value = next
  }

  function setResultSort(next: WebSerialResultSort): void {
    resultSort.value = next
    writeChoice(SORT_STORAGE_KEY, next)
  }

  function setResultDensity(next: WebSerialResultDensity): void {
    resultDensity.value = next
    writeChoice(DENSITY_STORAGE_KEY, next)
  }

  function kindsToSearch(): WebSerialSearchKind[] {
    if (scope.value !== 'all') return [scope.value]
    const value = capabilities.value
    if (!value) return ['manga', 'novel']
    const kinds: WebSerialSearchKind[] = []
    if (value.manga.available && value.manga.searchable) kinds.push('manga')
    if (value.novel.available && value.novel.searchable) kinds.push('novel')
    return kinds
  }

  interface SiteSink {
    quiet: boolean
    apply: (kind: WebSerialSearchKind, result: { hits: WebSerialSearchHit[]; failedSources: string[] }) => void
    addFailed: (sources: string[]) => void
    flush: () => void
  }

  /** Quiet runs gather the whole answer first so the list on screen is replaced once, not emptied and refilled. */
  function siteSink(quiet: boolean): SiteSink {
    const gathered = { manga: [] as WebSerialSearchHit[], novel: [] as WebSerialSearchHit[], failed: [] as string[], disabled: false }
    return {
      quiet,
      apply(kind, result) {
        const failed = result.failedSources.filter((source) => source !== WebSerialErrorCode.NovelSourcesAllDisabled)
        const disabled = result.failedSources.includes(WebSerialErrorCode.NovelSourcesAllDisabled)
        if (quiet) {
          gathered[kind] = result.hits
          gathered.failed.push(...failed)
          gathered.disabled ||= disabled
          return
        }
        if (kind === 'manga') mangaHits.value = result.hits
        else novelHits.value = result.hits
        if (disabled) novelSourcesDisabled.value = true
        failedSources.value = [...failedSources.value, ...failed]
      },
      addFailed(sources) {
        if (quiet) gathered.failed.push(...sources)
        else failedSources.value = [...failedSources.value, ...sources]
      },
      flush() {
        if (!quiet) return
        mangaHits.value = gathered.manga
        novelHits.value = gathered.novel
        failedSources.value = gathered.failed
        novelSourcesDisabled.value = gathered.disabled
      },
    }
  }

  async function searchKind(
    kind: WebSerialSearchKind,
    text: string,
    controller: AbortController,
    failedKinds: Map<WebSerialSearchKind, string>,
    sink: SiteSink,
    refresh: boolean,
  ): Promise<void> {
    try {
      // Novels answer from the light novel index at once; the full search only follows when some sources are not indexed yet.
      if (kind === 'novel' && !sink.quiet) {
        const indexed = await searchSerials(text, kind, controller.signal, refresh, 'index')
        if (controller.signal.aborted) return
        sink.apply(kind, indexed)
        if (!indexed.livePending) return
      }
      const result = await searchSerials(text, kind, controller.signal, refresh)
      if (controller.signal.aborted) return
      sink.apply(kind, result)
    } catch (cause) {
      if (controller.signal.aborted) return
      failedKinds.set(kind, messageOf(cause, 'webSerials.api.search'))
    } finally {
      if (!controller.signal.aborted) pendingKinds.value = pendingKinds.value.filter((pending) => pending !== kind)
    }
  }

  function markFetched(text: string): void {
    fetchedQuery = text
    fetchedKind = scope.value
    fetchedAt.value = Date.now()
    refreshing.value = false
    refreshFailed.value = false
  }

  async function runSearch(run: SearchRun = {}): Promise<void> {
    const quiet = run.quiet === true
    searchController?.abort()
    const controller = new AbortController()
    searchController = controller
    const text = run.text ?? query.value.trim()
    const kinds = kindsToSearch()
    if (kinds.length === 0) {
      searchController = null
      if (quiet) {
        refreshing.value = false
        return
      }
      mangaHits.value = []
      novelHits.value = []
      failedSources.value = []
      novelSourcesDisabled.value = false
      pendingKinds.value = []
      searchError.value = i18n.global.t('webSerials.api.searchUnavailable')
      hasSearched.value = true
      return
    }
    if (quiet) {
      refreshing.value = true
      refreshFailed.value = false
    } else {
      refreshing.value = false
      selectedSource.value = null
      mangaHits.value = []
      novelHits.value = []
      failedSources.value = []
      novelSourcesDisabled.value = false
      searchError.value = null
      pendingKinds.value = kinds
    }
    const sink = siteSink(quiet)
    const failedKinds = new Map<WebSerialSearchKind, string>()
    await Promise.all(kinds.map((kind) => searchKind(kind, text, controller, failedKinds, sink, run.refresh === true)))
    if (controller.signal.aborted) return
    searchController = null
    if (quiet && failedKinds.size === kinds.length) {
      refreshing.value = false
      refreshFailed.value = true
      return
    }
    const allFailed = failedKinds.size === kinds.length
    if (failedKinds.size > 0 && !allFailed) sink.addFailed([...failedKinds.keys()])
    sink.flush()
    hasSearched.value = true
    if (allFailed) searchError.value = [...failedKinds.values()][0] ?? null
    else markFetched(text)
  }

  async function runSeriesSearch(run: SearchRun = {}): Promise<void> {
    const quiet = run.quiet === true
    searchController?.abort()
    const controller = new AbortController()
    searchController = controller
    const text = run.text ?? query.value.trim()
    const kinds = kindsToSearch()
    if (kinds.length === 0) {
      searchController = null
      if (quiet) {
        refreshing.value = false
        return
      }
      resetSiteResults()
      entries.value = []
      pendingKinds.value = []
      discovering.value = false
      searchError.value = i18n.global.t('webSerials.api.searchUnavailable')
      hasSearched.value = true
      return
    }
    if (quiet) {
      refreshing.value = true
      refreshFailed.value = false
    } else {
      refreshing.value = false
      resetSiteResults()
      searchError.value = null
      fallbackReason.value = null
      pendingKinds.value = []
      discovering.value = true
      mode.value = 'series'
    }
    let reason: WebSerialDiscoverFallback | null = null
    let found: WebSerialCatalogEntry[] = []
    try {
      const result = await discoverSerials(text, kinds.length === 2 ? 'all' : kinds[0]!, controller.signal, run.refresh === true)
      if (controller.signal.aborted) return
      found = result.results
      reason = result.fallback
    } catch {
      if (controller.signal.aborted) return
      reason = 'unavailable'
    }
    searchController = null
    if (quiet) {
      refreshing.value = false
      if (reason !== null) {
        refreshFailed.value = reason === 'unavailable'
        return
      }
      entries.value = found
      entriesQuery.value = text
      selectedSource.value = null
      markFetched(text)
      return
    }
    discovering.value = false
    if (reason === null) {
      entries.value = found
      entriesQuery.value = text
      hasSearched.value = true
      markFetched(text)
      return
    }
    entries.value = []
    fallbackReason.value = reason
    mode.value = 'sites'
    await runSearch()
  }

  function resetSiteResults(): void {
    selectedSource.value = null
    mangaHits.value = []
    novelHits.value = []
    failedSources.value = []
    novelSourcesDisabled.value = false
  }

  /** A pasted link goes straight to the preview; anything else is a title search, series database first. */
  async function submit(): Promise<WebSerialSeriesDetail | null> {
    if (!canSubmit.value) return null
    if (!isLink.value) {
      await runSeriesSearch()
      return null
    }
    resolvingLink.value = true
    previewError.value = null
    const url = query.value.trim()
    try {
      return await loadPreview((signal) => resolveSerialUrl({ url }, signal), null)
    } catch (cause) {
      if (!isAbort(cause)) previewError.value = messageOf(cause, 'webSerials.api.resolve')
      return null
    } finally {
      resolvingLink.value = false
    }
  }

  /** The release sources searched directly, for a series the series database does not know. `title` replaces the query. */
  async function searchSites(title?: string): Promise<void> {
    if (title !== undefined) query.value = title
    if (query.value.trim().length < MIN_QUERY_LENGTH) return
    fallbackReason.value = null
    mode.value = 'sites'
    discovering.value = false
    await runSearch()
  }

  /** Search again behind the results already shown. `refresh` also tells the server to skip its cache. */
  async function rerun(refresh: boolean): Promise<void> {
    if (fetchedQuery.length < MIN_QUERY_LENGTH || searching.value) return
    if (mode.value === 'sites') await runSearch({ quiet: true, refresh, text: fetchedQuery })
    else await runSeriesSearch({ quiet: true, refresh, text: fetchedQuery })
  }

  function refresh(): Promise<void> {
    return rerun(true)
  }

  function refreshInBackground(): Promise<void> {
    return rerun(false)
  }

  function snapshot(): StoredWebSerialSearch | null {
    if (fetchedAt.value === null || !hasSearched.value || searching.value || searchError.value !== null) return null
    return {
      q: mode.value === 'series' && entriesQuery.value ? entriesQuery.value : fetchedQuery,
      kind: fetchedKind,
      mode: mode.value,
      source: activeSource.value,
      showMachineTranslations: showMachineTranslations.value,
      entries: entries.value,
      entriesQuery: entriesQuery.value,
      mangaHits: mangaHits.value,
      novelHits: novelHits.value,
      failedSources: failedSources.value,
      novelSourcesDisabled: novelSourcesDisabled.value,
      fallbackReason: fallbackReason.value,
      fetchedAt: fetchedAt.value,
    }
  }

  /** Show a stored search without asking anything: the lists, filters and notes exactly as they were. */
  function restoreSnapshot(stored: StoredWebSerialSearch): void {
    searchController?.abort()
    searchController = null
    pendingKinds.value = []
    discovering.value = false
    refreshing.value = false
    refreshFailed.value = false
    searchError.value = null
    previewError.value = null
    query.value = stored.q
    scope.value = stored.kind
    mode.value = stored.mode
    entries.value = stored.entries
    entriesQuery.value = stored.entriesQuery
    mangaHits.value = stored.mangaHits
    novelHits.value = stored.novelHits
    failedSources.value = stored.failedSources
    novelSourcesDisabled.value = stored.novelSourcesDisabled
    fallbackReason.value = stored.fallbackReason
    showMachineTranslations.value = stored.showMachineTranslations
    selectedSource.value = stored.source
    fetchedQuery = stored.q
    fetchedKind = stored.kind
    fetchedAt.value = stored.fetchedAt
    hasSearched.value = true
  }

  function backToSeries(): void {
    if (entries.value.length === 0) return
    searchController?.abort()
    searchController = null
    pendingKinds.value = []
    fallbackReason.value = null
    mode.value = 'series'
    query.value = entriesQuery.value
  }

  /** Novel hits carry only a url until the engine has seen them, so those resolve before the preview opens. */
  async function openHit(hit: WebSerialSearchHit): Promise<WebSerialSeriesDetail | null> {
    if (openingKey.value !== null) return null
    openingKey.value = hitIdentity(hit)
    previewError.value = null
    const { seriesKey, url } = hit
    try {
      if (seriesKey) return await loadPreview((signal) => fetchSeries(seriesKey, undefined, signal), hit.sourceName)
      if (url) return await loadPreview((signal) => resolveSerialUrl({ url }, signal), hit.sourceName)
      return null
    } catch (cause) {
      if (!isAbort(cause)) previewError.value = messageOf(cause, 'webSerials.api.openSeries')
      return null
    } finally {
      openingKey.value = null
    }
  }

  function dispose(): void {
    searchController?.abort()
    previewController?.abort()
    pendingKinds.value = []
    discovering.value = false
    refreshing.value = false
  }

  function clearPreviewError(): void {
    previewError.value = null
  }

  return {
    query,
    scope,
    hits,
    visibleHits,
    showMachineTranslations,
    hasMtlHits,
    resultSort,
    resultDensity,
    mode,
    entries,
    visibleEntries,
    catalogSort,
    discovering,
    fallbackReason,
    canReturnToSeries,
    sourceOptions,
    activeSource,
    failedSources,
    novelSourcesDisabled,
    pendingKinds,
    searching,
    resolvingLink,
    openingKey,
    hasSearched,
    fetchedAt,
    refreshing,
    refreshFailed,
    searchError,
    previewError,
    previewPending,
    error,
    capabilities,
    capabilitiesFailed,
    isLink,
    canSubmit,
    novelLinksOnly,
    availableScopes,
    nothingAvailable,
    loadCapabilities,
    setScope,
    setSource,
    setShowMachineTranslations,
    setResultSort,
    setResultDensity,
    submit,
    searchSites,
    refresh,
    refreshInBackground,
    snapshot,
    restoreSnapshot,
    backToSeries,
    openHit,
    cancelPreview,
    clearPreviewError,
    dispose,
  }
}
