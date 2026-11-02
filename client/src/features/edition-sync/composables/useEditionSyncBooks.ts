import { computed, onScopeDispose, ref } from 'vue'
import { toast } from 'vue-sonner'
import {
  EDITION_SYNC_BOOK_LIST_PAGE_SIZE,
  type EditionSyncBookListFilter,
  type EditionSyncBookListItem,
  type EditionSyncBookState,
  type EditionSyncDisabledReason,
} from '@bookorbit/types'
import { i18n } from '@/i18n'
import { fetchEditionSyncBooks, retryEditionSyncBook, runEditionSyncBookNow, updateEditionSyncBookState } from '../api/edition-sync.api'
import { useEditionSyncSettings } from './useEditionSyncSettings'

export const EDITION_SYNC_BOOKS_SEARCH_DEBOUNCE_MS = 300
export const EDITION_SYNC_BOOKS_QUERY_MAX_LENGTH = 200

function messageOf(err: unknown, fallbackKey: string): string {
  return err instanceof Error && err.message ? err.message : i18n.global.t(fallbackKey)
}

/** A row takes the book's fresh state from a toggle, run or retry instead of reloading the page. */
export function applyBookState(item: EditionSyncBookListItem, state: EditionSyncBookState): EditionSyncBookListItem {
  return {
    ...item,
    syncEnabled: state.syncEnabled,
    syncOverride: state.syncOverride,
    status: state.syncEnabled ? state.index.status : 'off',
    stage: state.index.stage,
    progress: state.index.progress,
    indexedAt: state.index.indexedAt,
    error: state.index.error,
    whisperFallback: state.index.whisperFallback,
    canRunNow: state.canRunNow,
    canRetry: state.canRetry,
  }
}

/** The settings page's paged list of the books edition sync covers, by the reader's own sync state. */
export function useEditionSyncBooks() {
  const { settings } = useEditionSyncSettings()
  const filter = ref<EditionSyncBookListFilter>('all')
  const query = ref('')
  const page = ref(1)
  const items = ref<EditionSyncBookListItem[]>([])
  const total = ref(0)
  const pageSize = ref(EDITION_SYNC_BOOK_LIST_PAGE_SIZE)
  const counts = ref<Record<EditionSyncBookListFilter, number> | null>(null)
  const disabledReason = ref<EditionSyncDisabledReason | null>(null)
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref<string | null>(null)
  const pendingIds = ref<ReadonlySet<number>>(new Set())
  let requestId = 0
  let searchTimer: ReturnType<typeof setTimeout> | null = null

  const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
  const hasPrevious = computed(() => page.value > 1)
  const hasNext = computed(() => page.value < pageCount.value)
  const range = computed(() => {
    if (total.value === 0 || items.value.length === 0) return null
    const from = (page.value - 1) * pageSize.value + 1
    return { from, to: from + items.value.length - 1, total: total.value }
  })

  /**
   * While the user's own sync is off every row reads off, so the switch shows the stored per-book choice
   * instead and stays changeable; the server stores the override and applies it once sync is back on.
   */
  function toggleValue(item: EditionSyncBookListItem): boolean {
    if (disabledReason.value !== 'user_disabled') return item.syncEnabled
    const mode = settings.value?.bookSyncMode ?? 'all_eligible'
    return item.syncOverride === 'included' || (item.syncOverride === null && mode === 'all_eligible')
  }

  function canToggle(item: EditionSyncBookListItem): boolean {
    return !pendingIds.value.has(item.bookId) && (disabledReason.value === null || disabledReason.value === 'user_disabled')
  }

  async function load(): Promise<void> {
    const current = ++requestId
    loading.value = true
    error.value = null
    try {
      const response = await fetchEditionSyncBooks({ filter: filter.value, q: query.value.trim() || undefined, page: page.value })
      if (current !== requestId) return
      items.value = response.items
      total.value = response.total
      pageSize.value = response.pageSize
      counts.value = response.counts
      disabledReason.value = response.disabledReason
      // A page past the end, after the list shrank, falls back to the last one that exists.
      if (response.items.length === 0 && response.total > 0 && page.value > 1) {
        page.value = Math.max(1, Math.ceil(response.total / response.pageSize))
        void load()
        return
      }
      loaded.value = true
    } catch (err) {
      if (current === requestId) error.value = messageOf(err, 'editionSync.books.loadFailed')
    } finally {
      if (current === requestId) loading.value = false
    }
  }

  function clearSearchTimer(): void {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = null
  }

  function setFilter(value: EditionSyncBookListFilter): void {
    if (value === filter.value) return
    filter.value = value
    page.value = 1
    void load()
  }

  function setQuery(value: string): void {
    query.value = value.slice(0, EDITION_SYNC_BOOKS_QUERY_MAX_LENGTH)
    clearSearchTimer()
    searchTimer = setTimeout(() => {
      searchTimer = null
      page.value = 1
      void load()
    }, EDITION_SYNC_BOOKS_SEARCH_DEBOUNCE_MS)
  }

  function nextPage(): void {
    if (!hasNext.value || loading.value) return
    page.value += 1
    void load()
  }

  function previousPage(): void {
    if (!hasPrevious.value || loading.value) return
    page.value -= 1
    void load()
  }

  function setPending(bookId: number, pending: boolean): void {
    const next = new Set(pendingIds.value)
    if (pending) next.add(bookId)
    else next.delete(bookId)
    pendingIds.value = next
  }

  async function updateRow(bookId: number, call: () => Promise<EditionSyncBookState>, failureKey: string): Promise<boolean> {
    if (pendingIds.value.has(bookId)) return false
    setPending(bookId, true)
    try {
      const state = await call()
      items.value = items.value.map((item) => (item.bookId === bookId ? applyBookState(item, state) : item))
      // The row shows its new state at once; the page and counts follow, since filter membership may have changed.
      void load()
      return true
    } catch (err) {
      toast.error(messageOf(err, failureKey))
      return false
    } finally {
      setPending(bookId, false)
    }
  }

  function setSyncEnabled(bookId: number, value: boolean): Promise<boolean> {
    return updateRow(bookId, () => updateEditionSyncBookState(bookId, { syncEnabled: value }), 'editionSync.errors.saveFailed')
  }

  function runNow(bookId: number): Promise<boolean> {
    return updateRow(bookId, () => runEditionSyncBookNow(bookId), 'editionSync.errors.runFailed')
  }

  function retry(bookId: number): Promise<boolean> {
    return updateRow(bookId, () => retryEditionSyncBook(bookId), 'editionSync.errors.retryFailed')
  }

  onScopeDispose(() => {
    clearSearchTimer()
    requestId += 1
  })

  return {
    filter,
    query,
    page,
    items,
    total,
    pageSize,
    counts,
    disabledReason,
    loading,
    loaded,
    error,
    pendingIds,
    pageCount,
    hasPrevious,
    hasNext,
    range,
    load,
    setFilter,
    setQuery,
    nextPage,
    previousPage,
    toggleValue,
    canToggle,
    setSyncEnabled,
    runNow,
    retry,
  }
}
