import { computed, watch, type Component, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RouteLocationRaw } from 'vue-router'
import { Moon, Settings, Sparkles, Sun, Upload } from '@lucide/vue'
import {
  Permission,
  type WebSerialCatalogEntry,
  type WebSerialSuggestion,
  type AuthorSummary,
  type BookCard,
  type HardcoverSearchBook,
  type MonitoredAuthorSearchResult,
  type MonitoredCatalogSearchHit,
  type SeriesSummary,
} from '@bookorbit/types'
import { formatNumber } from '@/i18n/formatters'
import { useSidebarNav } from '@/composables/useSidebarNav'
import { SIDEBAR_SECTIONS, type SidebarListKind } from '@/composables/useSidebarSections'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useBookRequestVisibility } from '@/features/book-requests/composables/useBookRequestVisibility'
import { useGlobalSearch } from '@/features/book/composables/useGlobalSearch'
import { useCollections } from '@/features/collection/composables/useCollections'
import { useLibraries } from '@/features/library/composables/useLibraries'
import { searchSettingsNav, visibleSettingsNav } from '@/features/settings/lib/settings-nav'
import { useSmartScopes } from '@/features/smart-scope/composables/useSmartScopes'
import { useThemeStore } from '@/stores/theme'
import { formatSeriesParam } from '@/features/web-serials/lib/serialUrl'
import { useExternalSearchText } from './useExternalSearchText'
import { useLocalEntities } from './useLocalEntities'
import { useContinueReading } from './useContinueReading'
import { useExternalSearch } from './useExternalSearch'
import { rankBooks, rankByRelevance, matchingAlternativeTitle } from '../lib/rank'
import { countStrongMatches } from '../lib/strong-match'

export const PALETTE_MIN_QUERY = 2

export type PaletteTab = 'all' | 'books' | 'authors' | 'series' | 'settings' | 'watchlist' | 'hardcover' | 'lightNovels' | 'manga'

export type PaletteItem =
  | { kind: 'lightNovel'; key: string; suggestion: WebSerialSuggestion }
  | { kind: 'lightNovelEntry'; key: string; entry: WebSerialCatalogEntry; aka?: string }
  | { kind: 'seriesMore'; key: string; seriesKind: 'manga' | 'novel' }
  | { kind: 'skeleton'; key: string; section: 'lightNovels' | 'manga' | 'hardcoverBooks' }
  | { kind: 'manga'; key: string; entry: WebSerialCatalogEntry; aka?: string }
  | { kind: 'watchlist'; key: string; hit: MonitoredCatalogSearchHit }
  | { kind: 'hardcoverBook'; key: string; book: HardcoverSearchBook }
  | { kind: 'hardcoverAuthor'; key: string; author: MonitoredAuthorSearchResult }
  | { kind: 'externalSearch'; key: string; label: string; description?: string; providers: Array<'hardcover' | 'manga' | 'lightNovels'> }
  | { kind: 'book'; key: string; book: BookCard }
  | { kind: 'reading'; key: string; book: BookCard }
  | { kind: 'author'; key: string; author: AuthorSummary }
  | { kind: 'series'; key: string; series: SeriesSummary }
  | { kind: 'place'; key: string; label: string; icon: Component | string; fallbackIcon?: Component; meta: string; to: RouteLocationRaw }
  | { kind: 'setting'; key: string; label: string; groupLabel: string; description: string; icon: Component; to: RouteLocationRaw }
  | { kind: 'action'; key: string; label: string; icon: Component; meta?: string; run: () => void }
  | { kind: 'more'; key: string; label: string; tab: PaletteTab }

export interface PaletteSection {
  id: string
  label: string
  count?: number
  items: PaletteItem[]
}

export interface PaletteTabOption {
  id: PaletteTab
  label: string
  count?: number
}

const ALL_TAB_LIMITS = {
  watchlist: 3,
  lightNovels: 3,
  manga: 3,
  hardcoverBooks: 5,
  hardcoverAuthors: 3,
  books: 5,
  authors: 3,
  series: 3,
  places: 5,
  settings: 4,
  actions: 3,
} as const

export const WATCHLIST_MIN_QUERY = 3
const WATCHLIST_TAB_LIMIT = 10

const ENTITY_KIND_LABEL_KEYS: Record<SidebarListKind, string> = {
  library: 'commandPalette.kinds.library',
  smartScope: 'commandPalette.kinds.smartScope',
  collection: 'commandPalette.kinds.collection',
}

interface PaletteActionHandlers {
  openUpload: () => void
  navigate: (to: RouteLocationRaw) => void
}

function matches(text: string, needle: string): boolean {
  return text.toLocaleLowerCase().includes(needle)
}

/**
 * Everything the palette lists, grouped the way it renders. Every request is bounded: books page
 * through the existing global search, authors and series ask for one small page, and the rest
 * filters lists the sidebar already holds.
 */
export function useCommandPaletteResults(query: Ref<string>, tab: Ref<PaletteTab>, isOpen: Ref<boolean>, handlers: PaletteActionHandlers) {
  const { t, locale } = useI18n()
  const { hasPermission, isSuperuser, userPermissions, isDemoRestrictedAccount } = usePermissions()
  const { showBookRequests } = useBookRequestVisibility()
  const { zones } = useSidebarNav()
  const { libraries } = useLibraries()
  const { bookScopes } = useSmartScopes()
  const { bookCollections } = useCollections()
  const themeStore = useThemeStore()

  const trimmed = computed(() => query.value.trim())
  const needle = computed(() => trimmed.value.toLocaleLowerCase())
  const isSearching = computed(() => trimmed.value.length >= PALETTE_MIN_QUERY)

  const books = useGlobalSearch(query)

  const requestAccess = computed(() => hasPermission(Permission.BookRequestAccess))
  const { lightNovels, novelsAllowed, mangaSearchable, watchlist, authors, authorTotal, series, seriesTotal, entitiesLoading, capabilitiesReady } =
    useLocalEntities(
      query,
      isOpen,
      requestAccess,
      computed(() => hasPermission(Permission.WebSerialAccess)),
    )
  const continueReading = useContinueReading(isOpen)

  const { members, anyLoading, anyIdle, searchExternal } = useExternalSearch({
    query: trimmed,
    tab,
    isOpen,
    hardcoverPermission: requestAccess,
    mangaSearchable,
    novelsSearchable: novelsAllowed,
    capabilitiesReady,
    localReady: computed(() => books.settled.value && !entitiesLoading.value),
    strongMatches: computed(() =>
      countStrongMatches(trimmed.value, { books: books.results.value, authors: authors.value, series: series.value, watchlist: watchlist.value }),
    ),
  })

  const { allowed: hardcoverAllowed, state: hardcoverState } = members.hardcover
  const { allowed: mangaAllowed, state: mangaState, items: manga } = members.manga
  const { allowed: externalNovelsAllowed, state: novelState, items: novelEntries } = members.novels
  const hardcoverBooks = computed(() => members.hardcover.items.value.books)
  const hardcoverAuthors = computed(() => members.hardcover.items.value.authors)
  // A Hardcover book row exists to be requested, so it goes away with the Requests feature.
  const requestableHardcoverBooks = computed(() => (showBookRequests.value ? hardcoverBooks.value : []))

  const places = computed<Extract<PaletteItem, { kind: 'place' }>[]>(() => {
    const pageMeta = t('commandPalette.kinds.page')
    const pages = zones.value.flatMap((zone) =>
      zone.entries.map((entry) => ({
        kind: 'place' as const,
        key: `page:${entry.id}`,
        label: entry.label,
        icon: entry.icon,
        meta: pageMeta,
        to: entry.to,
      })),
    )
    const lists: Record<SidebarListKind, { id: number; name: string; icon?: string | null; bookCount?: number | null }[]> = {
      library: libraries.value.filter((library) => library.type !== 'podcasts'),
      smartScope: bookScopes.value,
      collection: bookCollections.value,
    }
    const entities = SIDEBAR_SECTIONS.filter((definition) => definition.medium === 'books').flatMap((definition) =>
      lists[definition.kind].map((entity) => ({
        kind: 'place' as const,
        key: `${definition.kind}:${entity.id}`,
        label: entity.name,
        icon: entity.icon || definition.icon,
        fallbackIcon: definition.icon,
        meta:
          entity.bookCount != null
            ? `${t(ENTITY_KIND_LABEL_KEYS[definition.kind])} · ${formatNumber(entity.bookCount)}`
            : t(ENTITY_KIND_LABEL_KEYS[definition.kind]),
        to: { name: definition.routeName, params: { id: entity.id } },
      })),
    )
    return [...entities, ...pages]
  })

  const actions = computed<Extract<PaletteItem, { kind: 'action' }>[]>(() => {
    const list: Extract<PaletteItem, { kind: 'action' }>[] = []
    if (hasPermission('library_upload') && !isDemoRestrictedAccount.value) {
      list.push({ kind: 'action', key: 'action:upload', label: t('components.appHeader.uploadBooks'), icon: Upload, run: handlers.openUpload })
    }
    const toLight = themeStore.resolvedTheme === 'dark'
    list.push({
      kind: 'action',
      key: 'action:theme',
      label: toLight ? t('commandPalette.actions.lightTheme') : t('commandPalette.actions.darkTheme'),
      icon: toLight ? Sun : Moon,
      run: themeStore.toggleTheme,
    })
    list.push({
      kind: 'action',
      key: 'action:whats-new',
      label: t('components.appHeader.whatsNew'),
      icon: Sparkles,
      run: () => handlers.navigate({ name: 'whats-new' }),
    })
    list.push({
      kind: 'action',
      key: 'action:settings',
      label: t('components.appHeader.settings'),
      icon: Settings,
      run: () => handlers.navigate({ name: 'settings-libraries' }),
    })
    return list
  })

  const settingsHits = computed<Extract<PaletteItem, { kind: 'setting' }>[]>(() => {
    if (!isSearching.value) return []
    const groups = visibleSettingsNav({
      isSuperuser: isSuperuser.value,
      permissions: userPermissions.value,
      isDemoRestricted: isDemoRestrictedAccount.value,
      showBookRequests: showBookRequests.value,
    })
    return searchSettingsNav(groups, trimmed.value, t).map(({ item, group }) => ({
      kind: 'setting' as const,
      key: `setting:${item.id}`,
      label: t(item.labelKey),
      groupLabel: t(group.labelKey),
      description: item.descriptionKey ? t(item.descriptionKey) : '',
      icon: item.icon,
      to: { name: item.routeName },
    }))
  })

  const placeHits = computed(() => (isSearching.value ? places.value.filter((place) => matches(place.label, needle.value)) : []))
  const actionHits = computed(() => (isSearching.value ? actions.value.filter((action) => matches(action.label, needle.value)) : []))

  const visibleSuggestions = computed(() => lightNovels.value.filter((entry) => tab.value === 'lightNovels' || !entry.inLibrary))
  const visibleNovelEntries = computed(() => novelEntries.value.filter((entry) => tab.value === 'lightNovels' || !entry.inLibrary))
  const visibleManga = computed(() => manga.value.filter((entry) => tab.value === 'manga' || !entry.inLibrary))

  function aka(entry: WebSerialCatalogEntry) {
    const title = matchingAlternativeTitle(entry.title, entry.altTitles ?? [], trimmed.value)
    return title ? { aka: title } : {}
  }

  const novelItems = computed<PaletteItem[]>(() => {
    const ids = new Set(visibleSuggestions.value.map((suggestion) => suggestion.matchId).filter(Boolean))
    const merged: PaletteItem[] = [
      ...visibleSuggestions.value.map((suggestion, index): PaletteItem => ({
        kind: 'lightNovel',
        key: `lightNovel:${suggestion.matchId ?? ''}:${suggestion.entries[0]?.seriesKey ?? index}`,
        suggestion,
      })),
      ...visibleNovelEntries.value
        .filter((entry) => !ids.has(entry.matchId))
        .map((entry): PaletteItem => ({ kind: 'lightNovelEntry', key: `lightNovelEntry:${entry.matchId}`, entry, ...aka(entry) })),
    ]
    return rankByRelevance(
      merged,
      trimmed.value,
      (item) => (item.kind === 'lightNovel' ? item.suggestion.title : item.kind === 'lightNovelEntry' ? item.entry.title : ''),
      (item) => (item.kind === 'lightNovelEntry' ? item.entry.authors : []),
      (item) => (item.kind === 'lightNovelEntry' ? (item.entry.altTitles ?? []) : []),
    )
  })

  watch([requestableHardcoverBooks, hardcoverAuthors, hardcoverState], () => {
    if (tab.value === 'hardcover' && hardcoverState.value === 'done' && !requestableHardcoverBooks.value.length && !hardcoverAuthors.value.length)
      tab.value = 'all'
  })

  // Outside sources keep their own order inside a tier, but title matches lead, as they do for the library.
  const rankedWatchlist = computed(() =>
    rankByRelevance(
      watchlist.value,
      trimmed.value,
      (hit) => hit.work.title,
      (hit) => [hit.authorName],
    ),
  )
  const rankedManga = computed(() =>
    rankByRelevance(
      visibleManga.value,
      trimmed.value,
      (entry) => entry.title,
      (entry) => entry.authors,
      (entry) => entry.altTitles ?? [],
    ),
  )
  const rankedHardcoverBooks = computed(() =>
    rankByRelevance(
      requestableHardcoverBooks.value,
      trimmed.value,
      (book) => book.title,
      (book) => book.authorNames,
    ),
  )
  const rankedHardcoverAuthors = computed(() => rankByRelevance(hardcoverAuthors.value, trimmed.value, (author) => author.name))

  watch([novelItems, novelState, entitiesLoading], () => {
    if (tab.value === 'lightNovels' && novelState.value === 'done' && !entitiesLoading.value && !novelItems.value.length) tab.value = 'all'
  })

  const novelCount = computed(() => {
    const ids = new Set(lightNovels.value.map((entry) => entry.matchId).filter(Boolean))
    return lightNovels.value.length + novelEntries.value.filter((entry) => !ids.has(entry.matchId)).length
  })

  const tabs = computed<PaletteTabOption[]>(() => {
    if (!isSearching.value) return []
    const options: PaletteTabOption[] = [
      { id: 'books', label: t('commandPalette.tabs.books'), count: books.total.value },
      { id: 'authors', label: t('commandPalette.tabs.authors'), count: authorTotal.value },
      { id: 'series', label: t('commandPalette.tabs.series'), count: seriesTotal.value },
      { id: 'settings', label: t('commandPalette.tabs.settings'), count: settingsHits.value.length },
    ]
    if (watchlist.value.length) options.push({ id: 'watchlist', label: t('commandPalette.tabs.watchlist'), count: watchlist.value.length })
    if (hardcoverAllowed.value && (hardcoverState.value !== 'done' || requestableHardcoverBooks.value.length + hardcoverAuthors.value.length > 0))
      options.push({
        id: 'hardcover',
        label: t('commandPalette.tabs.hardcover'),
        ...(hardcoverState.value === 'done' ? { count: requestableHardcoverBooks.value.length + hardcoverAuthors.value.length } : {}),
      })
    if ((externalNovelsAllowed.value || novelCount.value > 0) && (novelState.value !== 'done' || entitiesLoading.value || novelCount.value))
      options.push({
        id: 'lightNovels',
        label: t('commandPalette.tabs.lightNovels'),
        ...(!externalNovelsAllowed.value || novelState.value === 'done' ? { count: novelCount.value } : {}),
      })
    if (mangaAllowed.value && (mangaState.value !== 'done' || manga.value.length))
      options.push({
        id: 'manga',
        label: t('commandPalette.tabs.manga'),
        ...(mangaState.value === 'done' ? { count: manga.value.length } : {}),
      })
    function allCount(option: PaletteTabOption): number {
      if (option.id === 'manga') return manga.value.filter((entry) => !entry.inLibrary).length
      if (option.id === 'lightNovels')
        return novelItems.value.filter((item) => {
          if (item.kind === 'lightNovel') return !item.suggestion.inLibrary
          return item.kind === 'lightNovelEntry' && !item.entry.inLibrary
        }).length
      return option.count ?? 0
    }
    const all = options.reduce((sum, option) => sum + allCount(option), 0) + placeHits.value.length
    return [
      { id: 'all', label: t('commandPalette.tabs.all'), count: all },
      ...options.filter((option) => (option.count ?? 0) > 0 || option.id === 'hardcover' || option.id === 'manga' || option.id === 'lightNovels'),
    ]
  })

  function moreRow(label: string, target: PaletteTab): PaletteItem {
    return { kind: 'more', key: `more:${target}`, label, tab: target }
  }

  const externalProviders = computed<Array<'hardcover' | 'manga' | 'lightNovels'>>(() => [
    ...(hardcoverAllowed.value ? ['hardcover' as const] : []),
    ...(mangaAllowed.value ? ['manga' as const] : []),
    ...(externalNovelsAllowed.value ? ['lightNovels' as const] : []),
  ])
  const manualText = useExternalSearchText(externalProviders, trimmed, showBookRequests, t, locale)
  function externalSection(): PaletteSection {
    return {
      id: 'external',
      label: externalSectionLabel.value,
      items: [{ kind: 'externalSearch', key: 'externalSearch', ...manualText.value, providers: externalProviders.value }],
    }
  }
  const externalSectionLabel = computed(() =>
    t(
      hardcoverAllowed.value
        ? externalProviders.value.length > 1
          ? 'commandPalette.external.moreSources'
          : 'commandPalette.tabs.hardcover'
        : 'commandPalette.external.webSerials',
    ),
  )

  const universalSections = computed<PaletteSection[]>(() => {
    const result: PaletteSection[] = []
    if (watchlist.value.length && ['all', 'watchlist'].includes(tab.value))
      result.push({
        id: 'watchlist',
        label: t('commandPalette.sections.watchlist'),
        items: rankedWatchlist.value
          .slice(0, tab.value === 'watchlist' ? WATCHLIST_TAB_LIMIT : ALL_TAB_LIMITS.watchlist)
          .map((hit) => ({ kind: 'watchlist', key: `watchlist:${hit.work.id}`, hit })),
      })
    if ((externalNovelsAllowed.value || novelItems.value.length > 0) && ['all', 'lightNovels'].includes(tab.value)) {
      const items: PaletteItem[] = novelItems.value.slice(0, tab.value === 'lightNovels' ? undefined : ALL_TAB_LIMITS.lightNovels)
      if (!items.length && ['waiting', 'loading'].includes(novelState.value))
        items.push(...[0, 1].map((i): PaletteItem => ({ kind: 'skeleton', section: 'lightNovels', key: `lightNovelSkeleton:${i}` })))
      if (tab.value === 'lightNovels' && externalNovelsAllowed.value && novelItems.value.length)
        items.push({ kind: 'seriesMore', seriesKind: 'novel', key: 'lightNovelMore' })
      if (items.length) result.push({ id: 'lightNovels', label: t('commandPalette.sections.lightNovels'), items })
    }
    if (mangaAllowed.value && ['all', 'manga'].includes(tab.value)) {
      const items: PaletteItem[] = ['waiting', 'loading'].includes(mangaState.value)
        ? [0, 1].map((i) => ({ kind: 'skeleton', section: 'manga', key: `mangaSkeleton:${i}` }))
        : rankedManga.value
            .slice(0, tab.value === 'manga' ? undefined : ALL_TAB_LIMITS.manga)
            .map((entry) => ({ kind: 'manga', key: `manga:${entry.matchId}`, entry, ...aka(entry) }))
      if (tab.value === 'manga' && manga.value.length) items.push({ kind: 'seriesMore', seriesKind: 'manga', key: 'mangaMore' })
      if (items.length) result.push({ id: 'manga', label: t('commandPalette.sections.manga'), items })
    }
    if (!['all', 'hardcover'].includes(tab.value)) return result
    const manual = books.settled.value && !entitiesLoading.value && anyIdle.value
    if (!hardcoverAllowed.value) {
      if (manual) result.push(externalSection())
      return result
    }
    const items: PaletteItem[] =
      showBookRequests.value && (hardcoverState.value === 'waiting' || hardcoverState.value === 'loading')
        ? [0, 1].map((i) => ({ kind: 'skeleton', section: 'hardcoverBooks', key: `hardcoverSkeleton:${i}` }))
        : rankedHardcoverBooks.value
            .slice(0, ALL_TAB_LIMITS.hardcoverBooks)
            .map((book) => ({ kind: 'hardcoverBook', key: `hardcoverBook:${book.slug}`, book }))
    if (manual) result.push(externalSection())
    if (items.length) result.push({ id: 'hardcoverBooks', label: t('commandPalette.sections.hardcoverBooks'), items })
    if (hardcoverAuthors.value.length)
      result.push({
        id: 'hardcoverAuthors',
        label: t('commandPalette.sections.hardcoverAuthors'),
        items: rankedHardcoverAuthors.value
          .slice(0, ALL_TAB_LIMITS.hardcoverAuthors)
          .map((author) => ({ kind: 'hardcoverAuthor', key: `hardcoverAuthor:${author.providerIds.hardcover ?? author.name}`, author })),
      })
    return result
  })

  const sections = computed<PaletteSection[]>(() => {
    if (!isSearching.value) {
      const result: PaletteSection[] = []
      if (continueReading.value.length) {
        result.push({
          id: 'continue',
          label: t('commandPalette.sections.continueReading'),
          items: continueReading.value.map((book) => ({ kind: 'reading', key: `reading:${book.id}`, book })),
        })
      }
      const libraryPlaces = places.value.filter((place) => place.key.startsWith('library:')).slice(0, ALL_TAB_LIMITS.places)
      if (libraryPlaces.length) result.push({ id: 'goto', label: t('commandPalette.sections.goTo'), items: libraryPlaces })
      result.push({ id: 'actions', label: t('commandPalette.sections.actions'), items: actions.value })
      return result
    }

    const bookItems: PaletteItem[] = books.results.value.map((book) => ({ kind: 'book', key: `book:${book.id}`, book }))
    const authorItems: PaletteItem[] = authors.value.map((author) => ({ kind: 'author', key: `author:${author.id}`, author }))
    const seriesItems: PaletteItem[] = series.value.map((entry) => ({ kind: 'series', key: `series:${entry.id}`, series: entry }))

    if (['watchlist', 'hardcover', 'lightNovels', 'manga'].includes(tab.value)) return universalSections.value
    if (tab.value === 'books') return [{ id: 'books', label: t('commandPalette.sections.books'), count: books.total.value, items: bookItems }]
    if (tab.value === 'authors') return [{ id: 'authors', label: t('commandPalette.sections.authors'), count: authorTotal.value, items: authorItems }]
    if (tab.value === 'series') return [{ id: 'series', label: t('commandPalette.sections.series'), count: seriesTotal.value, items: seriesItems }]
    if (tab.value === 'settings')
      return [{ id: 'settings', label: t('commandPalette.sections.settings'), count: settingsHits.value.length, items: settingsHits.value }]

    const result: PaletteSection[] = []
    if (bookItems.length) {
      const ranked = rankBooks(books.results.value, trimmed.value).slice(0, ALL_TAB_LIMITS.books)
      const items: PaletteItem[] = ranked.map((book) => ({ kind: 'book', key: `book:${book.id}`, book }))
      if (books.total.value > ALL_TAB_LIMITS.books) items.push(moreRow(t('commandPalette.showAllBooks', { count: books.total.value }), 'books'))
      result.push({ id: 'books', label: t('commandPalette.sections.books'), count: books.total.value, items })
    }
    if (authorItems.length) {
      const items = authorItems.slice(0, ALL_TAB_LIMITS.authors)
      if (authorTotal.value > ALL_TAB_LIMITS.authors) items.push(moreRow(t('commandPalette.showAllAuthors', { count: authorTotal.value }), 'authors'))
      result.push({ id: 'authors', label: t('commandPalette.sections.authors'), count: authorTotal.value, items })
    }
    if (seriesItems.length) {
      const items = seriesItems.slice(0, ALL_TAB_LIMITS.series)
      if (seriesTotal.value > ALL_TAB_LIMITS.series) items.push(moreRow(t('commandPalette.showAllSeries', { count: seriesTotal.value }), 'series'))
      result.push({ id: 'series', label: t('commandPalette.sections.series'), count: seriesTotal.value, items })
    }
    result.push(...universalSections.value)
    if (placeHits.value.length) {
      result.push({ id: 'goto', label: t('commandPalette.sections.goTo'), items: placeHits.value.slice(0, ALL_TAB_LIMITS.places) })
    }
    if (settingsHits.value.length) {
      const items: PaletteItem[] = settingsHits.value.slice(0, ALL_TAB_LIMITS.settings)
      if (settingsHits.value.length > ALL_TAB_LIMITS.settings) {
        items.push(moreRow(t('commandPalette.showAllSettings', { count: settingsHits.value.length }), 'settings'))
      }
      result.push({ id: 'settings', label: t('commandPalette.sections.settings'), count: settingsHits.value.length, items })
    }
    if (actionHits.value.length)
      result.push({ id: 'actions', label: t('commandPalette.sections.actions'), items: actionHits.value.slice(0, ALL_TAB_LIMITS.actions) })
    return result
  })

  const loading = computed(() => isSearching.value && (books.loading.value || entitiesLoading.value || anyLoading.value))
  const settled = computed(() => isSearching.value && books.settled.value && !entitiesLoading.value && !anyLoading.value)

  function clear() {
    books.clear()
  }

  function activate(item: PaletteItem): MonitoredAuthorSearchResult | undefined {
    switch (item.kind) {
      case 'manga':
      case 'lightNovelEntry':
        handlers.navigate({
          path: '/web-serials',
          query: { series: formatSeriesParam(item.kind === 'manga' ? 'manga' : 'novel', item.entry.matchId) },
        })
        break
      case 'lightNovel':
        handlers.navigate({
          path: '/web-serials',
          query: item.suggestion.matchId
            ? { series: formatSeriesParam('novel', item.suggestion.matchId) }
            : { q: item.suggestion.title, kind: 'novel' },
        })
        break
      case 'seriesMore':
        handlers.navigate({ path: '/web-serials', query: { q: trimmed.value, kind: item.seriesKind } })
        break
      case 'externalSearch':
        void searchExternal()
        break
      case 'watchlist':
        handlers.navigate({ path: `/watchlist/authors/${item.hit.monitorAuthorId}`, query: { work: item.hit.work.id } })
        break
      case 'hardcoverBook':
        handlers.navigate({ path: '/requests', query: { title: item.book.title, author: item.book.authorNames[0] ?? '' } })
        break
      case 'hardcoverAuthor':
        return item.author
      case 'book':
      case 'reading':
        handlers.navigate({ name: 'book-detail', params: { bookId: item.book.id } })
        break
      case 'author':
        handlers.navigate({ name: 'author-detail', params: { id: item.author.id } })
        break
      case 'series':
        handlers.navigate({ name: 'series-detail', params: { seriesId: item.series.id } })
        break
      case 'place':
      case 'setting':
        handlers.navigate(item.to)
        break
      case 'action':
        item.run()
        break
      case 'more':
        tab.value = item.tab
        break
    }
  }

  return {
    activate,
    sections,
    tabs,
    isSearching,
    loading,
    settled,
    hasMoreBooks: books.hasMore,
    loadingMoreBooks: books.loadingMore,
    loadMoreBooks: books.loadMore,
    clear,
  }
}
