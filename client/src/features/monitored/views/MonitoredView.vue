<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { Check, Loader2, RefreshCw } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import {
  MONITORED_AUTHOR_LIST_SORTS,
  MONITORED_BOOK_LIST_SORTS,
  MONITORED_LIST_ORDERS,
  MONITORED_RELEASE_FILTERS,
  MONITORED_RELEASE_LIST_SORTS,
  Permission,
} from '@bookorbit/types'
import type {
  MonitoredAuthorItem,
  MonitoredAuthorListSort,
  MonitoredBookItem,
  MonitoredBookListSort,
  MonitoredFormat,
  MonitoredReleaseFilter,
  MonitoredReleaseItem,
  MonitoredReleaseListSort,
  MonitoredWork,
  MonitoredWorkPatch,
} from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { formatNumber } from '@/i18n/formatters'
import ViewHeader from '@/components/ViewHeader.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { useDisplaySettings, type BookViewMode } from '@/composables/useDisplaySettings'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useScrollRestoreOnActivate } from '@/features/book/composables/useScrollRestoreOnActivate'
import { useBookRequestProgress } from '@/features/book-requests/composables/useBookRequestProgress'
import {
  deleteMonitoredAuthor,
  deleteMonitoredBook,
  fetchOwnedMonitoredAuthorIds,
  refreshMonitoredAuthor,
  requestMonitoredWork,
  updateMonitoredAuthor,
  updateMonitoredBook,
  updateMonitoredWork,
} from '../api/monitored'
import { monitoredErrorText } from '../lib/api-error'
import { onMonitoredBookCreated } from '../lib/monitored-book-state'
import { refreshAllAuthorsSequentially, type MonitoredRefreshSummary } from '../lib/refresh-summary'
import { collapseReleaseItems, type MonitoredReleaseEntry } from '../lib/grouping'
import { monitoredDateTime } from '../lib/release-date'
import AddMonitoredPanel from '../components/AddMonitoredPanel.vue'
import MonitoredAuthorCard from '../components/MonitoredAuthorCard.vue'
import MonitoredBookPanel from '../components/MonitoredBookPanel.vue'
import MonitoredBookRow from '../components/MonitoredBookRow.vue'
import MonitoredEmptyState from '../components/MonitoredEmptyState.vue'
import MonitoredGroupMenu from '../components/MonitoredGroupMenu.vue'
import MonitoredHardcoverNotice from '../components/MonitoredHardcoverNotice.vue'
import MonitoredReleaseRow from '../components/MonitoredReleaseRow.vue'
import MonitoredSortMenu from '../components/MonitoredSortMenu.vue'
import MonitoredVirtualGrid from '../components/MonitoredVirtualGrid.vue'
import MonitoredWorkCard from '../components/MonitoredWorkCard.vue'
import { MONITORED_RELEASE_GROUPS, MONITORED_TABS, type MonitoredReleaseGroup, type MonitoredTab, useMonitored } from '../composables/useMonitored'
import { useMonitoredRefreshAll } from '../composables/useMonitoredRefreshAll'
import { usePageRetryGuard } from '../composables/usePageRetryGuard'
import { useRefreshFeedback } from '../composables/useRefreshFeedback'
import { storage } from '@/services/storage'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const { hasPermission } = usePermissions()
const {
  authors,
  books,
  releases,
  authorTotal,
  bookTotal,
  releaseTotal,
  authorDroppedOffset,
  bookDroppedOffset,
  releaseDroppedOffset,
  authorLoading,
  bookLoading,
  releaseLoading,
  summaryLoading,
  authorHasMore,
  bookHasMore,
  releaseHasMore,
  counts,
  hardcoverConfigured,
  error,
  loadSummary,
  loadAuthors,
  loadBooks,
  loadReleases,
} = useMonitored()
const { onRequestsChanged } = useBookRequestProgress()
const { cardInfoMode } = useDisplaySettings()
const { state: refreshState, run: runRefresh } = useRefreshFeedback()
const {
  running: refreshAllRunning,
  progress: refreshAllProgress,
  start: startRefreshAll,
  report: reportRefreshAll,
  finish: finishRefreshAll,
} = useMonitoredRefreshAll()
const filterQuery = ref('')
const mainRef = ref<HTMLElement | null>(null)
useScrollRestoreOnActivate(mainRef)
const sentinel = ref<HTMLElement | null>(null)
const topSentinel = ref<HTMLElement | null>(null)
const requestingReleases = ref(new Set<string>())
const canManage = computed(() => hasPermission(Permission.BookRequestAccess))
const INITIAL_SKELETON_COUNT = 18
const loadedTabs = ref(new Set<string>())
let hydrating = true
let observer: IntersectionObserver | null = null
let topObserver: IntersectionObserver | null = null
let searchTimer: ReturnType<typeof setTimeout> | null = null
let suppressSearchReload = false
let unsubscribeMonitoredBookCreated: (() => void) | null = null
// Deferred server reconciliation runs when this kept-alive view returns.
let reloadOnActivate = false
let viewActive = true
let initialLoadComplete = false
let requestRefreshPending = false
let requestRefreshTimer: ReturnType<typeof setTimeout> | null = null
const REQUEST_CHANGE_DEBOUNCE_MS = 1500

// Shared book side panel, same as the author page: cards open it on click.
const panelWork = ref<MonitoredWork | null>(null)
const panelAuthorName = ref('')
const panelFormats = ref<MonitoredFormat[] | undefined>(undefined)
const panelOwned = ref(true)
const panelOpen = ref(false)

function openWorkPanel(work: MonitoredWork, authorName: string, formats?: MonitoredFormat[], owned = true) {
  panelOwned.value = owned
  panelWork.value = work
  panelAuthorName.value = authorName
  panelFormats.value = formats
  panelOpen.value = true
}

function handlePanelOpen(value: boolean) {
  panelOpen.value = value
}

/**
 * The panel keeps the grab and reports its progress in place, so this only has to keep the list
 * behind it honest: the card and any release row for this work read as queued straight away, and
 * the tab refetches on the next visit, by which point the download may already have been filed.
 */
function handlePanelGrabbed(work: MonitoredWork, format: MonitoredFormat, requestId: number) {
  work.requestIds = { ...work.requestIds, [format]: requestId }
  for (const item of releases.value) {
    if (item.workId === work.id && item.format === format) {
      item.status = 'queued'
      item.requestId = requestId
    }
  }
  reloadOnActivate = true
}

/**
 * The download the panel was watching has landed in the library. Only the server can say what the
 * work owns now, so the tab refetches and the open panel re-points at the row that came back.
 */
async function handlePanelFiled(work: MonitoredWork) {
  await Promise.all([loadSummary(), reloadActive(true)])
  const reloaded = releases.value.find((item) => item.workId === work.id)?.work ?? books.value.find((item) => item.work.id === work.id)?.work
  if (reloaded) panelWork.value = reloaded
}

async function requestWorkFormat(work: MonitoredWork, format: MonitoredFormat, autoDownload?: boolean) {
  if (!canManage.value) return
  try {
    await requestMonitoredWork(work.id, {
      format,
      ...(autoDownload !== undefined ? { autoDownload } : {}),
    })
    toast.success(t('monitored.toast.sendingToRequests', { title: work.title, format: t(`monitored.formats.${format}`) }))
    void reloadActive(true)
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.queueFailed')))
  }
}

async function handlePanelRequest(work: MonitoredWork, format: MonitoredFormat, autoDownload: boolean) {
  await requestWorkFormat(work, format, autoDownload)
}

async function patchWork(work: MonitoredWork, patch: MonitoredWorkPatch) {
  if (!canManage.value) return
  try {
    const updated = await updateMonitoredWork(work.id, patch)
    if (panelWork.value?.id === work.id) panelWork.value = updated
    void reloadActive(true)
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  }
}

function handleDownloadEbook(work: MonitoredWork) {
  void requestWorkFormat(work, 'ebook')
}

function handleDownloadAudiobook(work: MonitoredWork) {
  void requestWorkFormat(work, 'audiobook')
}

function handleHideWork(work: MonitoredWork) {
  void patchWork(work, { hidden: true })
}

function handleToggleMonitor(work: MonitoredWork, format: MonitoredFormat, value: boolean) {
  void patchWork(work, format === 'ebook' ? { monitorEbook: value } : { monitorAudiobook: value })
}

function handleToggleHidden(work: MonitoredWork, value: boolean) {
  void patchWork(work, { hidden: value })
}

function releaseTimeBadge(item: MonitoredReleaseItem): string | null {
  const time = monitoredDateTime(item.releaseDate)
  if (time === null) return null
  const days = Math.round((time - Date.now()) / 86_400_000)
  if (days === 0) return t('monitored.releases.today')
  return days > 0 ? t('monitored.releases.inDays', { count: days }) : t('monitored.releases.daysAgo', { count: Math.abs(days) })
}

function handleCardQuickView(work: MonitoredWork) {
  if (work.matchedBookId !== null) void router.push({ name: 'book-detail', params: { bookId: work.matchedBookId } })
}

function parseTab(value: unknown): MonitoredTab {
  const normalized = Array.isArray(value) ? value[0] : value
  if (normalized === 'add' && !canManage.value) return 'authors'
  return MONITORED_TABS.includes(normalized as MonitoredTab) ? (normalized as MonitoredTab) : 'authors'
}

const activeTab = ref<MonitoredTab>(parseTab(route.query.tab))

const DEFAULT_SORT = { authors: 'name', books: 'added', releases: 'date' } as const
const DEFAULT_ORDER = { authors: 'asc', books: 'desc', releases: 'asc' } as const
const tabs = computed(() => [
  { id: 'authors' as const, label: t('monitored.tabs.authors'), count: counts.value.authors },
  { id: 'books' as const, label: t('monitored.tabs.books'), count: counts.value.books },
  { id: 'releases' as const, label: t('monitored.tabs.releases'), count: counts.value.releases },
  ...(canManage.value ? [{ id: 'add' as const, label: t('monitored.tabs.add'), count: null }] : []),
])
// ---- View mode, filter, sort and grouping (persisted; Shelfmark-style, Book Orbit visuals) ----
type ListView = 'table' | 'cards'
type ReleaseFilter = MonitoredReleaseFilter
type ReleaseSort = MonitoredReleaseListSort
type ReleaseGroup = MonitoredReleaseGroup
type BookSort = MonitoredBookListSort

function persisted<T extends string>(key: string, fallback: T, allowed: readonly T[]) {
  const value = ref<T>(
    (allowed as readonly string[]).includes(storage.get<string | null>(key, null) ?? '') ? (storage.get<string>(key, fallback) as T) : fallback,
  )
  watch(value, (next) => storage.set(key, next))
  return value
}

const releasesView = persisted<ListView>('monitored:view:releases', 'table', ['table', 'cards'])
const booksView = persisted<ListView>('monitored:view:books', 'table', ['table', 'cards'])
const releaseFilter = persisted<ReleaseFilter>('monitored:releases:filter', 'all', MONITORED_RELEASE_FILTERS)
const releaseSort = persisted<ReleaseSort>('monitored:releases:sort', 'date', MONITORED_RELEASE_LIST_SORTS)
const releaseOrder = persisted<'asc' | 'desc'>('monitored:releases:order', 'asc', MONITORED_LIST_ORDERS)
const releaseGroup = persisted<ReleaseGroup>('monitored:releases:group', 'status', MONITORED_RELEASE_GROUPS)
const bookSort = persisted<BookSort>('monitored:books:sort', 'added', MONITORED_BOOK_LIST_SORTS)
const bookOrder = persisted<'asc' | 'desc'>('monitored:books:order', 'desc', MONITORED_LIST_ORDERS)

type AuthorSort = MonitoredAuthorListSort

function persistedNumber(key: string, fallback: number, min: number, max: number) {
  const raw = Number(storage.get<number | string | null>(key, null))
  const value = ref(Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback)
  watch(value, (next) => storage.set(key, next))
  return value
}

const authorSort = persisted<AuthorSort>('monitored:authors:sort', 'name', MONITORED_AUTHOR_LIST_SORTS)
const authorOrder = persisted<'asc' | 'desc'>('monitored:authors:order', 'asc', MONITORED_LIST_ORDERS)

// Card sizing, adjustable from the same slider popover the main app views use.
const AUTHOR_CARD_SIZE = { min: 72, max: 240, fallback: 150 }
const WORK_CARD_SIZE = { min: 90, max: 240, fallback: 122 }
const authorCardSize = persistedNumber('monitored:authors:size', AUTHOR_CARD_SIZE.fallback, AUTHOR_CARD_SIZE.min, AUTHOR_CARD_SIZE.max)
const workCardSize = persistedNumber('monitored:cards:size', WORK_CARD_SIZE.fallback, WORK_CARD_SIZE.min, WORK_CARD_SIZE.max)
const cardGap = persistedNumber('monitored:cards:gap', 16, 4, 40)

const activeCardSizeConfig = computed(() => (activeTab.value === 'authors' ? AUTHOR_CARD_SIZE : WORK_CARD_SIZE))
const activeCardSize = computed({
  get: () => (activeTab.value === 'authors' ? authorCardSize.value : workCardSize.value),
  set: (next: number) => {
    if (activeTab.value === 'authors') authorCardSize.value = next
    else workCardSize.value = next
  },
})
const showDisplayControls = computed(
  () => activeTab.value === 'authors' || ((activeTab.value === 'books' || activeTab.value === 'releases') && activeView.value === 'cards'),
)
const workCardExtraHeight = computed(() => (cardInfoMode.value === 'below-cover' ? 40 : 0))
const sortedAuthors = computed(() => authors.value)

const activeView = computed(() => (activeTab.value === 'books' ? booksView.value : releasesView.value))
function setActiveView(view: ListView) {
  if (activeTab.value === 'books') booksView.value = view
  else releasesView.value = view
}

const releaseSortOptions = computed<{ value: ReleaseSort; label: string }[]>(() => [
  { value: 'date', label: t('monitored.controlsBar.sortDate') },
  { value: 'title', label: t('monitored.controlsBar.sortTitle') },
  { value: 'author', label: t('monitored.controlsBar.sortAuthor') },
])
const releaseGroupOptions = computed<{ value: ReleaseGroup; label: string }[]>(() => [
  { value: 'status', label: t('monitored.controlsBar.groupStatus') },
  { value: 'none', label: t('monitored.controlsBar.groupNone') },
])
const bookSortOptions = computed<{ value: BookSort; label: string }[]>(() => [
  { value: 'added', label: t('monitored.controlsBar.sortAdded') },
  { value: 'title', label: t('monitored.controlsBar.sortTitle') },
  { value: 'author', label: t('monitored.controlsBar.sortAuthor') },
])
const authorSortOptions = computed<{ value: AuthorSort; label: string }[]>(() => [
  { value: 'name', label: t('monitored.controlsBar.sortName') },
  { value: 'added', label: t('monitored.controlsBar.sortAdded') },
  { value: 'books', label: t('monitored.controlsBar.sortBooks') },
  { value: 'progress', label: t('monitored.controlsBar.sortProgress') },
])

function handleReleaseSortChange(value: ReleaseSort) {
  releaseSort.value = value
}

function handleReleaseOrderChange(value: 'asc' | 'desc') {
  releaseOrder.value = value
}

function handleReleaseGroupChange(value: ReleaseGroup) {
  releaseGroup.value = value
}

function handleBookSortChange(value: BookSort) {
  bookSort.value = value
}

function handleBookOrderChange(value: 'asc' | 'desc') {
  bookOrder.value = value
}

function handleAuthorSortChange(value: AuthorSort) {
  authorSort.value = value
}

function handleAuthorOrderChange(value: 'asc' | 'desc') {
  authorOrder.value = value
}

const headerViewMode = computed<BookViewMode>(() => (activeView.value === 'cards' ? 'grid' : 'list'))

function handleHeaderViewMode(mode: BookViewMode) {
  setActiveView(mode === 'grid' ? 'cards' : 'table')
}

function handleSearchUpdate(value: string) {
  filterQuery.value = value
}

function selectReleaseFilter(filter: ReleaseFilter) {
  releaseFilter.value = filter
}

const releaseFilters: { id: ReleaseFilter; label: string }[] = [
  { id: 'all', label: 'monitored.controlsBar.filterAll' },
  { id: 'recent', label: 'monitored.controlsBar.filterRecent' },
  { id: 'soon', label: 'monitored.controlsBar.filterSoon' },
  { id: 'year', label: 'monitored.controlsBar.filterYear' },
]

const sortedReleases = computed(() => releases.value)

const releaseGroups = computed<{ key: string; label: string | null; items: MonitoredReleaseItem[] }[]>(() => {
  const items = sortedReleases.value
  if (releaseGroup.value === 'none') return [{ key: 'all', label: null, items }]
  const now = Date.now()
  const isReleased = (item: MonitoredReleaseItem) => {
    const time = monitoredDateTime(item.releaseDate)
    return time !== null && time <= now
  }
  const released = items.filter(isReleased)
  const upcoming = items.filter((item) => !isReleased(item))
  return [
    { key: 'released', label: t('monitored.controlsBar.sectionReleased'), items: released },
    { key: 'upcoming', label: t('monitored.controlsBar.sectionUpcoming'), items: upcoming },
  ].filter((group) => group.items.length > 0)
})

const releaseSections = computed(() =>
  releaseGroups.value.map((group) => {
    const entries = collapseReleaseItems(group.items)
    const count = releasesView.value === 'table' ? group.items.length : entries.length
    return { ...group, entries, count: releaseHasMore.value ? null : count }
  }),
)

const sortedBooks = computed(() => books.value)

const activeTotal = computed(() => {
  if (activeTab.value === 'add') return 0
  if (activeTab.value === 'authors') return authorTotal.value
  if (activeTab.value === 'books') return bookTotal.value
  return releaseTotal.value
})

const showSkeleton = computed(() => activeTab.value !== 'add' && !initialLoaded.value && loading.value)
const showEmpty = computed(() => initialLoaded.value && !loading.value && activeItemsLength.value === 0)
const skeletonGridStyle = computed(() => ({
  gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${activeCardSize.value}px), 1fr))`,
  gap: `${cardGap.value}px`,
}))

const refreshLabel = computed(() =>
  refreshAllProgress.value
    ? t('monitored.actions.refreshProgress', {
        processed: formatNumber(refreshAllProgress.value.processed),
        total: formatNumber(refreshAllProgress.value.total),
      })
    : t('monitored.actions.refresh'),
)

const allLoadedLabel = computed(() => {
  const total = formatNumber(activeTotal.value)
  if (activeTab.value === 'authors') return t('monitored.list.allLoadedAuthors', { total })
  if (activeTab.value === 'books') return t('monitored.list.allLoadedBooks', { total })
  return t('monitored.list.allLoadedReleases', { total })
})

// Skeleton only before a tab's first page ever lands. Search keystrokes, sorts and filter chips
// refetch constantly, and swapping content for a skeleton on each one is a flicker, not a state.
const initialLoaded = computed(() => activeTab.value === 'add' || loadedTabs.value.has(activeTab.value))

const loading = computed(() => {
  if (activeTab.value === 'authors') return authorLoading.value
  if (activeTab.value === 'books') return bookLoading.value
  if (activeTab.value === 'releases') return releaseLoading.value
  return summaryLoading.value
})

function flushRequestRefresh(): void {
  if (!requestRefreshPending || !initialLoadComplete || loading.value || summaryLoading.value) return
  requestRefreshPending = false
  if (!viewActive) {
    reloadOnActivate = true
    return
  }
  handleChanged()
}

function handleRequestsChanged(): void {
  if (requestRefreshTimer) clearTimeout(requestRefreshTimer)
  requestRefreshTimer = setTimeout(() => {
    requestRefreshTimer = null
    if (!viewActive) {
      reloadOnActivate = true
      return
    }
    requestRefreshPending = true
    flushRequestRefresh()
  }, REQUEST_CHANGE_DEBOUNCE_MS)
}

onRequestsChanged(handleRequestsChanged)

watch([loading, summaryLoading], ([isLoading, isSummaryLoading]) => {
  if (!isLoading && !isSummaryLoading) flushRequestRefresh()
})
const hasMore = computed(() => {
  if (activeTab.value === 'authors') return authorHasMore.value
  if (activeTab.value === 'books') return bookHasMore.value
  if (activeTab.value === 'releases') return releaseHasMore.value
  return false
})
const activeItemsLength = computed(() => {
  if (activeTab.value === 'authors') return authors.value.length
  if (activeTab.value === 'books') return books.value.length
  if (activeTab.value === 'releases') return releases.value.length
  return 0
})
/** > 0 once the retention cap has dropped the earliest pages of the active list from memory. */
const activeDroppedOffset = computed(() => {
  if (activeTab.value === 'authors') return authorDroppedOffset.value
  if (activeTab.value === 'books') return bookDroppedOffset.value
  if (activeTab.value === 'releases') return releaseDroppedOffset.value
  return 0
})

const { blocked: autoLoadBlocked, record: recordPageResult, reset: resetPageRetries } = usePageRetryGuard()

async function reloadActive(reset = false): Promise<void> {
  if (reset) resetPageRetries()
  const tab = activeTab.value
  const q = filterQuery.value.trim() || undefined
  if (tab === 'authors') {
    await loadAuthors({ q, sort: authorSort.value, order: authorOrder.value }, reset)
  } else if (tab === 'books') {
    await loadBooks({ q, sort: bookSort.value, order: bookOrder.value }, reset)
  } else if (tab === 'releases') {
    await loadReleases({ q, sort: releaseSort.value, order: releaseOrder.value, filter: releaseFilter.value }, reset)
  } else {
    return
  }
  if (!loadedTabs.value.has(tab)) loadedTabs.value = new Set([...loadedTabs.value, tab])
}

function activeSort(): string | null {
  if (activeTab.value === 'authors') return authorSort.value
  if (activeTab.value === 'books') return bookSort.value
  if (activeTab.value === 'releases') return releaseSort.value
  return null
}

function activeOrder(): 'asc' | 'desc' | null {
  if (activeTab.value === 'authors') return authorOrder.value
  if (activeTab.value === 'books') return bookOrder.value
  if (activeTab.value === 'releases') return releaseOrder.value
  return null
}

/** Only non-default state reaches the URL, so a plain visit keeps a clean address. */
function syncRouteQuery() {
  const tab = activeTab.value
  const sort = activeSort()
  const order = activeOrder()
  void router.replace({
    name: 'monitored',
    query: {
      tab: tab === 'authors' ? undefined : tab,
      q: filterQuery.value.trim() || undefined,
      sort: tab !== 'add' && sort !== DEFAULT_SORT[tab] ? sort : undefined,
      order: tab !== 'add' && order !== DEFAULT_ORDER[tab] ? order : undefined,
      group: tab === 'releases' && releaseGroup.value !== 'status' ? releaseGroup.value : undefined,
      filter: tab === 'releases' && releaseFilter.value !== 'all' ? releaseFilter.value : undefined,
    },
  })
}

function hydrateFromRoute() {
  const query = route.query
  if (typeof query.q === 'string') filterQuery.value = query.q
  const sort = typeof query.sort === 'string' ? query.sort : null
  const order = typeof query.order === 'string' ? query.order : null
  if (order === 'asc' || order === 'desc') {
    if (activeTab.value === 'authors') authorOrder.value = order
    else if (activeTab.value === 'books') bookOrder.value = order
    else if (activeTab.value === 'releases') releaseOrder.value = order
  }
  if (sort) {
    if (activeTab.value === 'authors' && (MONITORED_AUTHOR_LIST_SORTS as readonly string[]).includes(sort)) {
      authorSort.value = sort as AuthorSort
    } else if (activeTab.value === 'books' && (MONITORED_BOOK_LIST_SORTS as readonly string[]).includes(sort)) {
      bookSort.value = sort as BookSort
    } else if (activeTab.value === 'releases' && (MONITORED_RELEASE_LIST_SORTS as readonly string[]).includes(sort)) {
      releaseSort.value = sort as ReleaseSort
    }
  }
  const group = typeof query.group === 'string' ? query.group : null
  if (group && (MONITORED_RELEASE_GROUPS as readonly string[]).includes(group)) releaseGroup.value = group as ReleaseGroup
  const filter = typeof query.filter === 'string' ? query.filter : null
  if (filter && (MONITORED_RELEASE_FILTERS as readonly string[]).includes(filter)) releaseFilter.value = filter as ReleaseFilter
}

function selectTab(tab: MonitoredTab) {
  if (tab === 'add' && !canManage.value) return
  suppressSearchReload = true
  activeTab.value = tab
  filterQuery.value = ''
  mainRef.value?.scrollTo({ top: 0 })
  syncRouteQuery()
  void nextTick(async () => {
    suppressSearchReload = false
    await reloadActive(true)
    loadIfSentinelVisible()
  })
}

function openAddTab() {
  selectTab('add')
}

function openAuthor(id: string) {
  void router.push({ name: 'monitored-author', params: { id }, query: { from: route.fullPath } })
}

async function handleRefresh() {
  let summary: MonitoredRefreshSummary = { refreshed: 0, skipped: 0, failed: 0 }
  if (!startRefreshAll()) return
  try {
    await runRefresh(async () => {
      try {
        summary = await refreshAllAuthorsSequentially((page) => fetchOwnedMonitoredAuthorIds(page, 200), refreshMonitoredAuthor, reportRefreshAll)
      } finally {
        finishRefreshAll()
      }
      await Promise.all([loadSummary(), reloadActive(true)])
      if (error.value) throw new Error(error.value)
    })
    if (summary.skipped > 0 || summary.failed > 0) toast.success(t('monitored.toast.refreshedAllPartial', { ...summary }))
    else toast.success(t('monitored.toast.refreshedAll', { ...summary }))
  } catch {
    // The failure is surfaced via the error banner; keep the button from showing a success tick.
  }
}

function handleAuthorUpdated(updated: MonitoredAuthorItem) {
  const index = authors.value.findIndex((item) => item.id === updated.id)
  if (index !== -1) authors.value[index] = updated
}

async function handleAuthorPause(author: MonitoredAuthorItem) {
  const paused = !author.paused
  try {
    const updated = await updateMonitoredAuthor(author.id, { paused })
    Object.assign(author, updated)
    toast.success(t(paused ? 'monitored.toast.paused' : 'monitored.toast.resumed', { name: author.authorName }))
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  }
}

// Removing a monitored row is destructive and unrecoverable from the list, so it asks first.
const pendingAuthorRemoval = ref<MonitoredAuthorItem | null>(null)
const pendingBookRemoval = ref<MonitoredBookItem | null>(null)
const removing = ref(false)

function handleAuthorRemove(author: MonitoredAuthorItem) {
  if (!removing.value) pendingAuthorRemoval.value = author
}

function cancelAuthorRemove() {
  if (!removing.value) pendingAuthorRemoval.value = null
}

async function confirmAuthorRemove() {
  const author = pendingAuthorRemoval.value
  if (!author || removing.value) return
  removing.value = true
  try {
    await deleteMonitoredAuthor(author.id)
    authors.value = authors.value.filter((item) => item.id !== author.id)
    await Promise.all([loadSummary(), reloadActive(true)])
    toast.success(t('monitored.toast.stopped', { name: author.authorName }))
    pendingAuthorRemoval.value = null
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  } finally {
    removing.value = false
  }
}

async function handleBookPause(item: MonitoredBookItem) {
  const previous = item.paused
  item.paused = !previous
  try {
    await updateMonitoredBook(item.id, { paused: item.paused })
    toast.success(t(item.paused ? 'monitored.toast.bookPaused' : 'monitored.toast.bookResumed', { title: item.work.title }))
  } catch (cause) {
    item.paused = previous
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  }
}

function handleBookRemove(item: MonitoredBookItem) {
  if (!removing.value) pendingBookRemoval.value = item
}

function cancelBookRemove() {
  if (!removing.value) pendingBookRemoval.value = null
}

async function confirmBookRemove() {
  const item = pendingBookRemoval.value
  if (!item || removing.value) return
  removing.value = true
  try {
    await deleteMonitoredBook(item.id)
    books.value = books.value.filter((book) => book.id !== item.id)
    await Promise.all([loadSummary(), reloadActive(true)])
    toast.success(t('monitored.toast.bookStopped', { title: item.work.title }))
    pendingBookRemoval.value = null
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  } finally {
    removing.value = false
  }
}

function releaseKey(item: MonitoredReleaseItem): string {
  return `${item.workId}:${item.format}`
}

function isReleaseRequesting(item: MonitoredReleaseItem): boolean {
  return requestingReleases.value.has(releaseKey(item))
}

/**
 * Queued covers both halves of the wait: the request this view is still sending, and one the server
 * already reports as sent. Without the second half a grab would leave the card showing its release
 * date, which is exactly the state it was in before the download started.
 */
function entryQueued(entry: MonitoredReleaseEntry): boolean {
  return entry.items.some((item) => isReleaseRequesting(item) || item.status === 'queued')
}

function entryFormatQueued(entry: MonitoredReleaseEntry, format: MonitoredFormat): boolean {
  return entry.items.some((item) => item.format === format && (isReleaseRequesting(item) || item.status === 'queued'))
}

function entryCanManage(entry: MonitoredReleaseEntry): boolean {
  return canManage.value && (entry.items[0]?.isOwner ?? false)
}

function entryTimeBadge(entry: MonitoredReleaseEntry): string | null {
  const first = entry.items[0]
  return first ? releaseTimeBadge(first) : null
}

async function handleReleaseRequest(item: MonitoredReleaseItem) {
  const key = releaseKey(item)
  if (!canManage.value || requestingReleases.value.has(key)) return
  requestingReleases.value = new Set([...requestingReleases.value, key])
  const previousStatus = item.status
  item.status = 'queued'
  try {
    const result = await requestMonitoredWork(item.workId, { format: item.format })
    item.requestId = result.requestIds[item.format] ?? null
    toast.success(t('monitored.toast.queued', { title: item.title, format: t(`monitored.formats.${item.format}`) }))
  } catch (cause) {
    item.status = previousStatus
    toast.error(monitoredErrorText(cause, t('monitored.toast.queueFailed')))
  } finally {
    const next = new Set(requestingReleases.value)
    next.delete(key)
    requestingReleases.value = next
  }
}

function handleChanged() {
  void Promise.all([loadSummary(), reloadActive(true)])
}

// A book can be individually monitored from the author-detail page, a separate kept-alive
// component with its own useMonitored() instance; this view's badge and Books tab only pick that
// up via this cross-view signal.
function handleMonitoredBookCreated() {
  void loadSummary()
  if (activeTab.value === 'books') void reloadActive(true)
}

async function loadMore(): Promise<void> {
  if (autoLoadBlocked.value || loading.value || !hasMore.value) return
  await reloadActive()
  recordPageResult(Boolean(error.value))
}

function handleRetry() {
  resetPageRetries()
  void reloadActive(activeItemsLength.value === 0)
}

function loadIfSentinelVisible() {
  if (autoLoadBlocked.value || loading.value || !hasMore.value || !sentinel.value) return
  if (sentinel.value.getBoundingClientRect().top < window.innerHeight + 250) void loadMore()
}

/**
 * Once the cap has dropped the earliest pages, the top of the render is no longer page 0. Rather
 * than render a hole, scrolling back up to that edge resets the list to a fresh page 0 fetch.
 */
function handleScrolledToTop() {
  if (activeDroppedOffset.value <= 0 || loading.value) return
  void reloadActive(true)
}

watch([authorSort, authorOrder], () => {
  if (hydrating || activeTab.value !== 'authors') return
  syncRouteQuery()
  void reloadActive(true)
})
watch([bookSort, bookOrder], () => {
  if (hydrating || activeTab.value !== 'books') return
  syncRouteQuery()
  void reloadActive(true)
})
watch([releaseSort, releaseOrder, releaseFilter], () => {
  if (hydrating || activeTab.value !== 'releases') return
  syncRouteQuery()
  void reloadActive(true)
})
watch(releaseGroup, () => {
  if (hydrating || activeTab.value !== 'releases') return
  syncRouteQuery()
})
watch(filterQuery, () => {
  if (searchTimer) clearTimeout(searchTimer)
  if (hydrating || suppressSearchReload) return
  searchTimer = setTimeout(() => {
    syncRouteQuery()
    void reloadActive(true)
  }, 250)
})
watch(
  loading,
  (isLoading) => {
    if (!isLoading) void nextTick(loadIfSentinelVisible)
  },
  { flush: 'post' },
)

onMounted(async () => {
  hydrateFromRoute()
  // Let the hydration writes flush before the watchers go live, or a deep link refetches twice.
  await nextTick()
  hydrating = false
  await Promise.all([loadSummary(), reloadActive(true)])
  initialLoadComplete = true
  flushRequestRefresh()
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) void loadMore()
    },
    { root: mainRef.value, rootMargin: '280px' },
  )
  await nextTick()
  if (sentinel.value) observer.observe(sentinel.value)
  loadIfSentinelVisible()
  topObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) handleScrolledToTop()
    },
    { root: mainRef.value, rootMargin: '280px 0px 0px 0px' },
  )
  if (topSentinel.value) topObserver.observe(topSentinel.value)
  unsubscribeMonitoredBookCreated = onMonitoredBookCreated(handleMonitoredBookCreated)
})

onActivated(() => {
  viewActive = true
  if (reloadOnActivate) {
    reloadOnActivate = false
    handleChanged()
    return
  }
  // A user who left to connect Hardcover must see the notice clear on return.
  if (initialLoadComplete) void loadSummary()
})

onDeactivated(() => {
  viewActive = false
})

onUnmounted(() => {
  viewActive = false
  observer?.disconnect()
  topObserver?.disconnect()
  if (searchTimer) clearTimeout(searchTimer)
  if (requestRefreshTimer) clearTimeout(requestRefreshTimer)
  unsubscribeMonitoredBookCreated?.()
})

defineOptions({ name: 'MonitoredView' })
</script>

<template>
  <main ref="mainRef" class="h-full overflow-y-auto pr-0 sm:pr-2">
    <div class="mx-auto w-full max-w-7xl pb-8">
      <!-- The app's shared view header, pinned like the library and series pages. -->
      <div class="sticky top-0 z-40 mb-3 border-b border-border bg-background/85 pb-2.5 pt-0.5 backdrop-blur-md">
        <ViewHeader
          :title="t('monitored.title')"
          icon="Bell"
          fallback-icon="Bell"
          :total="activeTotal"
          :searchable="activeTab !== 'add'"
          :search-query="filterQuery"
          :search-placeholder="t('monitored.searchPlaceholder')"
          :view-mode="headerViewMode"
          :allowed-view-modes="['grid', 'list']"
          :show-view-mode-toggle="activeTab === 'books' || activeTab === 'releases'"
          :show-selection="false"
          :show-display-controls="showDisplayControls"
          v-model:coverSize="activeCardSize"
          v-model:gridGap="cardGap"
          :cover-size-min="activeCardSizeConfig.min"
          :cover-size-max="activeCardSizeConfig.max"
          :cover-size-step="4"
          @update:search-query="handleSearchUpdate"
          @update:view-mode="handleHeaderViewMode"
        >
          <template #toolbar>
            <MonitoredSortMenu
              v-if="activeTab === 'releases'"
              :options="releaseSortOptions"
              :model-value="releaseSort"
              :order="releaseOrder"
              default-value="date"
              default-order="asc"
              @update:model-value="handleReleaseSortChange"
              @update:order="handleReleaseOrderChange"
            />
            <MonitoredGroupMenu
              v-if="activeTab === 'releases'"
              :options="releaseGroupOptions"
              :model-value="releaseGroup"
              default-value="status"
              @update:model-value="handleReleaseGroupChange"
            />
            <MonitoredSortMenu
              v-else-if="activeTab === 'books'"
              :options="bookSortOptions"
              :model-value="bookSort"
              :order="bookOrder"
              default-value="added"
              default-order="desc"
              @update:model-value="handleBookSortChange"
              @update:order="handleBookOrderChange"
            />
            <MonitoredSortMenu
              v-else-if="activeTab === 'authors'"
              :options="authorSortOptions"
              :model-value="authorSort"
              :order="authorOrder"
              default-value="name"
              default-order="asc"
              @update:model-value="handleAuthorSortChange"
              @update:order="handleAuthorOrderChange"
            />
          </template>
          <template #actions>
            <Button
              v-if="canManage"
              variant="ghost"
              size="icon"
              class="size-8 rounded-lg text-muted-foreground hover:text-foreground"
              :disabled="refreshState === 'loading' || refreshAllRunning"
              :aria-label="refreshLabel"
              :title="refreshLabel"
              @click="handleRefresh"
            >
              <Loader2 v-if="refreshState === 'loading'" class="animate-spin" :size="14" />
              <Check v-else-if="refreshState === 'done'" class="text-[var(--pill-success)]" :size="14" />
              <RefreshCw v-else :size="14" />
            </Button>
            <span v-if="refreshAllProgress" class="text-[11px] tabular-nums text-muted-foreground" aria-hidden="true">
              {{ formatNumber(refreshAllProgress.processed) }}/{{ formatNumber(refreshAllProgress.total) }}
            </span>
          </template>
        </ViewHeader>

        <div class="flex min-w-0 flex-wrap items-center gap-2 px-1">
          <div class="monitored-tabs no-scrollbar flex max-w-full gap-1 overflow-x-auto" role="tablist" :aria-label="t('monitored.tabs.label')">
            <button
              v-for="tab in tabs"
              :key="tab.id"
              type="button"
              role="tab"
              :aria-selected="activeTab === tab.id"
              class="shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
              :class="activeTab === tab.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
              @click="selectTab(tab.id)"
            >
              {{ tab.label }}
              <template v-if="tab.count !== null">
                <span
                  class="ms-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1.5 text-xs font-semibold text-primary tabular-nums"
                  aria-hidden="true"
                >
                  {{ formatNumber(tab.count) }}
                </span>
                <span class="sr-only">{{ formatNumber(tab.count) }}</span>
              </template>
            </button>
          </div>

          <div
            v-if="activeTab === 'releases'"
            class="no-scrollbar flex min-w-0 gap-1 overflow-x-auto rounded-lg bg-muted p-0.5"
            role="group"
            :aria-label="t('monitored.controlsBar.filter')"
          >
            <button
              v-for="option in releaseFilters"
              :key="option.id"
              type="button"
              class="h-7 shrink-0 rounded-md px-2.5 text-xs font-semibold transition-colors"
              :class="releaseFilter === option.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
              :aria-pressed="releaseFilter === option.id"
              @click="selectReleaseFilter(option.id)"
            >
              {{ t(option.label) }}
            </button>
          </div>
        </div>
      </div>

      <div
        v-if="error"
        role="alert"
        class="mx-1 mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
      >
        <span class="min-w-0">{{ error }}</span>
        <Button variant="outline" size="sm" @click="handleRetry">{{ t('common.retry') }}</Button>
      </div>
      <MonitoredHardcoverNotice v-if="!hardcoverConfigured" class="mx-1 mt-4" />
      <!-- Retention drops the earliest pages once a list passes the cap; scrolling back to this edge
           means the top of the render is no longer page 0, so a reset is the only way back to it. -->
      <div v-if="activeTab !== 'add'" ref="topSentinel" aria-hidden="true" />
      <!-- Skeleton only before a tab's first page lands; a refetch keeps the current rows on screen. -->
      <div v-if="showSkeleton" class="mt-4 px-1" aria-hidden="true">
        <div v-if="activeTab === 'authors' || activeView === 'cards'" class="grid" :style="skeletonGridStyle">
          <div v-for="index in INITIAL_SKELETON_COUNT" :key="`monitored-skeleton-${index}`" class="flex flex-col gap-1.5">
            <div class="aspect-2/3 w-full animate-pulse rounded-md bg-muted/60" />
          </div>
        </div>
        <div v-else class="space-y-3">
          <div
            v-for="index in INITIAL_SKELETON_COUNT"
            :key="`monitored-skeleton-row-${index}`"
            class="h-[104px] animate-pulse rounded-xl bg-muted/50"
          />
        </div>
      </div>

      <section v-else-if="activeTab === 'authors'" class="mt-4 px-1">
        <MonitoredVirtualGrid v-if="sortedAuthors.length > 0" :items="sortedAuthors" :card-size="authorCardSize" :grid-gap="cardGap">
          <template #default="{ item: author }">
            <MonitoredAuthorCard
              :author="author"
              :can-manage="canManage && author.isOwner"
              @open="openAuthor"
              @pause="handleAuthorPause"
              @remove="handleAuthorRemove"
              @updated="handleAuthorUpdated"
            />
          </template>
        </MonitoredVirtualGrid>
        <MonitoredEmptyState
          v-else-if="showEmpty"
          :title="t('monitored.empty.authorsTitle')"
          :description="t('monitored.empty.authorsDescription')"
          :action-label="canManage ? t('monitored.tabs.add') : undefined"
          @action="openAddTab"
        />
      </section>

      <section v-else-if="activeTab === 'books'" class="mt-4 px-1">
        <div v-if="booksView === 'table'" class="space-y-3">
          <MonitoredBookRow
            v-for="item in sortedBooks"
            :key="item.id"
            :item="item"
            :can-manage="canManage && item.isOwner"
            @pause="handleBookPause"
            @remove="handleBookRemove"
          />
        </div>
        <MonitoredVirtualGrid v-else :items="sortedBooks" :card-size="workCardSize" :grid-gap="cardGap" :extra-height="workCardExtraHeight">
          <template #default="{ item }">
            <MonitoredWorkCard
              :work="item.work"
              :queued="false"
              :ebook-queued="false"
              :audiobook-queued="false"
              :monitored-formats="item.formats"
              :can-manage="canManage && item.isOwner"
              @preview="openWorkPanel(item.work, item.authorName, item.formats, item.isOwner)"
              @quick-view="handleCardQuickView"
              @download-ebook="handleDownloadEbook"
              @download-audiobook="handleDownloadAudiobook"
              @stop="handleBookRemove(item)"
            />
          </template>
        </MonitoredVirtualGrid>
        <MonitoredEmptyState v-if="showEmpty" :title="t('monitored.empty.booksTitle')" :description="t('monitored.empty.booksDescription')" />
      </section>

      <section v-else-if="activeTab === 'releases'" class="mt-4 space-y-6 px-1">
        <section v-for="group in releaseSections" :key="group.key">
          <div v-if="group.label" class="mb-3 flex items-center gap-2">
            <h3 class="text-xs font-semibold text-foreground">{{ group.label }}</h3>
            <span v-if="group.count !== null" class="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">{{
              formatNumber(group.count)
            }}</span>
            <div class="h-px flex-1 bg-border" />
          </div>
          <div v-if="releasesView === 'table'" class="space-y-3">
            <MonitoredReleaseRow
              v-for="item in group.items"
              :key="releaseKey(item)"
              :item="item"
              :can-manage="canManage && item.isOwner"
              :requesting="isReleaseRequesting(item)"
              @request="handleReleaseRequest"
            />
          </div>
          <MonitoredVirtualGrid
            v-else
            :virtualized="releaseGroup === 'none'"
            :items="group.entries"
            :card-size="workCardSize"
            :grid-gap="cardGap"
            :extra-height="workCardExtraHeight"
          >
            <template #default="{ item: entry }">
              <MonitoredWorkCard
                :work="entry.work"
                :queued="entryQueued(entry)"
                :ebook-queued="entryFormatQueued(entry, 'ebook')"
                :audiobook-queued="entryFormatQueued(entry, 'audiobook')"
                :time-badge="entryTimeBadge(entry)"
                :can-manage="entryCanManage(entry)"
                @preview="openWorkPanel(entry.work, entry.authorName, undefined, entryCanManage(entry))"
                @quick-view="handleCardQuickView"
                @download-ebook="handleDownloadEbook"
                @download-audiobook="handleDownloadAudiobook"
                @stop="handleHideWork"
              />
            </template>
          </MonitoredVirtualGrid>
        </section>
        <MonitoredEmptyState v-if="showEmpty" :title="t('monitored.empty.releasesTitle')" :description="t('monitored.empty.releasesDescription')" />
      </section>

      <div v-else class="mt-4 px-1">
        <AddMonitoredPanel @changed="handleChanged" />
      </div>

      <div v-if="activeTab !== 'add'" ref="sentinel" class="flex h-8 items-center justify-center">
        <span v-if="loading && activeItemsLength > 0" class="text-xs text-muted-foreground">{{ t('common.loading') }}</span>
        <span v-else-if="initialLoaded && !hasMore && activeItemsLength > 0" class="text-xs text-muted-foreground">{{ allLoadedLabel }}</span>
      </div>
    </div>
    <ConfirmDialog
      :open="pendingAuthorRemoval !== null"
      :title="t('monitored.detail.stopDialog.title')"
      :description="t('monitored.detail.stopDialog.description')"
      :confirm-label="t('monitored.actions.stopMonitoring')"
      :busy="removing"
      @confirm="confirmAuthorRemove"
      @cancel="cancelAuthorRemove"
    />
    <ConfirmDialog
      :open="pendingBookRemoval !== null"
      :title="t('monitored.list.stopBookDialog.title')"
      :description="t('monitored.list.stopBookDialog.description')"
      :confirm-label="t('monitored.actions.stopMonitoring')"
      :busy="removing"
      @confirm="confirmBookRemove"
      @cancel="cancelBookRemove"
    />
    <MonitoredBookPanel
      :work="panelWork"
      :author-name="panelAuthorName"
      :monitored-formats="panelFormats"
      :can-manage="canManage && panelOwned"
      :open="panelOpen"
      @update:open="handlePanelOpen"
      @request="handlePanelRequest"
      @grabbed="handlePanelGrabbed"
      @filed="handlePanelFiled"
      @toggle-monitor="handleToggleMonitor"
      @toggle-hidden="handleToggleHidden"
    />
  </main>
</template>

<style scoped>
/* Below the point where every tab fits, the strip scrolls; the fade is the only cue it can. */
@media (max-width: 639px) {
  .monitored-tabs {
    mask-image: linear-gradient(90deg, #000 calc(100% - 22px), transparent 100%);
  }
}
</style>
