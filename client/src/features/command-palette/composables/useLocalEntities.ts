import { onScopeDispose, ref, watch, type Ref } from 'vue'
import type { AuthorSummary, SeriesSummary, MonitoredCatalogSearchHit, WebSerialSuggestion } from '@bookorbit/types'
import { fetchAuthors } from '@/features/author/api/author'
import { fetchSeries } from '@/features/series/api/series'
import { searchCatalogWorks } from '@/features/monitored/api/monitored'
import { fetchCapabilities, suggestSerials } from '@/features/web-serials/api/webSerials'

const TAB_PAGE_SIZE = 20
const ENTITY_DEBOUNCE_MS = 250
const WATCHLIST_MIN_QUERY = 3
const WATCHLIST_TAB_LIMIT = 10
const PALETTE_MIN_QUERY = 2

export function useLocalEntities(query: Ref<string>, isOpen: Ref<boolean>, requestAccess: Ref<boolean>, webSerialAccess: Ref<boolean>) {
  const lightNovels = ref<WebSerialSuggestion[]>([])
  const novelsAllowed = ref(false)
  const mangaSearchable = ref(false)
  let capabilityGeneration = 0
  let capabilitiesReady: Promise<void> = Promise.resolve()
  const watchlist = ref<MonitoredCatalogSearchHit[]>([])
  const authors = ref<AuthorSummary[]>([])
  const authorTotal = ref(0)
  const series = ref<SeriesSummary[]>([])
  const seriesTotal = ref(0)
  const entitiesLoading = ref(false)
  let entityTimer: ReturnType<typeof setTimeout> | null = null
  let entityGeneration = 0
  let catalogController: AbortController | undefined

  async function loadEntities(q: string, generation: number) {
    await capabilitiesReady
    if (generation !== entityGeneration) return
    catalogController = new AbortController()
    const [[authorResult, seriesResult, novelResult], watchlistResult] = await Promise.all([
      Promise.allSettled([
        fetchAuthors({ q, page: 0, size: TAB_PAGE_SIZE, sort: 'name', order: 'asc' }),
        fetchSeries({ q, page: 0, size: TAB_PAGE_SIZE, sort: 'name', order: 'asc' }),
        novelsAllowed.value ? suggestSerials(q, catalogController.signal) : Promise.resolve({ suggestions: [] }),
      ]),
      requestAccess.value && q.length >= WATCHLIST_MIN_QUERY
        ? searchCatalogWorks(q, WATCHLIST_TAB_LIMIT, catalogController.signal)
        : Promise.resolve([]),
    ])
    if (generation !== entityGeneration) return
    lightNovels.value = novelResult.status === 'fulfilled' ? novelResult.value.suggestions : []
    watchlist.value = watchlistResult
    authors.value = authorResult.status === 'fulfilled' ? authorResult.value.items : []
    authorTotal.value = authorResult.status === 'fulfilled' ? authorResult.value.total : 0
    series.value = seriesResult.status === 'fulfilled' ? seriesResult.value.items : []
    seriesTotal.value = seriesResult.status === 'fulfilled' ? seriesResult.value.total : 0
    entitiesLoading.value = false
  }

  watch(query, (rawQuery) => {
    const q = rawQuery.trim()
    catalogController?.abort()
    watchlist.value = []
    lightNovels.value = []
    if (entityTimer) clearTimeout(entityTimer)
    entityGeneration += 1
    authors.value = []
    series.value = []
    authorTotal.value = 0
    seriesTotal.value = 0
    if (q.length < PALETTE_MIN_QUERY) {
      entitiesLoading.value = false
      return
    }
    entitiesLoading.value = true
    const generation = entityGeneration
    entityTimer = setTimeout(() => void loadEntities(q, generation), ENTITY_DEBOUNCE_MS)
  })

  watch(
    isOpen,
    (open) => {
      if (open) {
        const generation = ++capabilityGeneration
        novelsAllowed.value = false
        mangaSearchable.value = false
        capabilitiesReady = webSerialAccess.value
          ? fetchCapabilities()
              .then((result) => {
                if (generation !== capabilityGeneration || !isOpen.value) return
                novelsAllowed.value = result.novel.searchable
                mangaSearchable.value = result.manga.searchable
              })
              .catch(() => {})
          : Promise.resolve()
      } else {
        capabilityGeneration++
        novelsAllowed.value = false
        mangaSearchable.value = false
        catalogController?.abort()
        if (entityTimer) clearTimeout(entityTimer)
        entityGeneration++
        entitiesLoading.value = false
      }
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    catalogController?.abort()
    if (entityTimer) clearTimeout(entityTimer)
    entityGeneration += 1
  })

  return {
    lightNovels,
    novelsAllowed,
    mangaSearchable,
    watchlist,
    authors,
    authorTotal,
    series,
    seriesTotal,
    entitiesLoading,
    capabilitiesReady: () => capabilitiesReady,
  }
}
