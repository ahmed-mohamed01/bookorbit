<script setup lang="ts">
import { useLibraryCheckSettlement } from '../composables/useLibraryCheckSettlement'
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, watch } from 'vue'
import { Check, Loader2, Minus, Plus, RefreshCw } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import {
  MONITORED_AUTHOR_LIST_SORTS,
  MONITORED_LIST_ORDERS,
  MONITORED_RELEASE_FILTERS,
  MONITORED_RELEASE_LIST_SORTS,
  isDefaultClassSelection,
  monitoredAcquisitionState,
  Permission,
} from '@bookorbit/types'
import type {
  MonitorMode,
  MonitoredAuthorItem,
  MonitoredAuthorListSort,
  MonitoredClassSelection,
  MonitoredFormat,
  MonitoredMarkKind,
  MonitoredStatusFilter,
  MonitoredReleaseFilter,
  MonitoredReleaseItem,
  MonitoredReleaseListSort,
  MonitoredReleaseStatus,
  MonitoredWork,
  MonitoredWorkPatch,
  TableDensity,
} from '@bookorbit/types'
import { Button } from '@/components/ui/button'
import { formatNumber } from '@/i18n/formatters'
import BrowseHeader from '@/components/browse-header/BrowseHeader.vue'
import BrowseSearchField from '@/components/browse-header/BrowseSearchField.vue'
import BrowseViewControls from '@/components/browse-header/BrowseViewControls.vue'
import { barDivider, outlineButton } from '@/components/browse-header/browse-header'
import ViewHeaderDisplayControls from '@/components/view-header/ViewHeaderDisplayControls.vue'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { useDisplaySettings, type BookViewMode } from '@/composables/useDisplaySettings'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useScrollRestoreOnActivate } from '@/features/book/composables/useScrollRestoreOnActivate'
import { useBookRequestProgress } from '@/features/book-requests/composables/useBookRequestProgress'
import {
  deleteMonitoredAuthor,
  fetchClassCounts,
  fetchMonitoredAuthorDetail,
  fetchOwnedMonitoredAuthorIds,
  refreshMonitoredAuthor,
  requestMonitoredWork,
  updateMonitoredAuthor,
  updateMonitoredWork,
} from '../api/monitored'
import { useMonitoredFetchEvents } from '../composables/useMonitoredFetchEvents'
import { monitoredErrorText } from '../lib/api-error'
import { isMonitoredAcquisitionState } from '../lib/monitored-format-state'
import { refreshAllAuthorsSequentially, type MonitoredRefreshSummary } from '../lib/refresh-summary'
import { releaseItemHasFormatToGet, sweptRowWorkIds } from '../lib/bulk-select'
import { collapseReleaseItems, releaseDateForWork, releaseDateMoved, type MonitoredReleaseEntry } from '../lib/grouping'
import AddMonitoredPanel from '../components/AddMonitoredPanel.vue'
import MonitoredAuthorCard from '../components/MonitoredAuthorCard.vue'
import MonitoredBookPanel from '../components/MonitoredBookPanel.vue'
import MonitoredEmptyState from '../components/MonitoredEmptyState.vue'
import MonitoredGroupMenu from '../components/MonitoredGroupMenu.vue'
import MonitoredAudibleNotice from '../components/MonitoredAudibleNotice.vue'
import MonitoredHardcoverNotice from '../components/MonitoredHardcoverNotice.vue'
import MonitoredReleaseFilterBar from '../components/MonitoredReleaseFilterBar.vue'
import { releaseSectionOf, releaseCount, type MonitoredReleaseSection, releaseGroup, releasesView } from '../lib/release-view'
import MonitoredReleaseRow from '../components/MonitoredReleaseRow.vue'
import MonitoredSortMenu from '../components/MonitoredSortMenu.vue'
import MonitoredVirtualGrid from '../components/MonitoredVirtualGrid.vue'
import MonitoredWorkCard from '../components/MonitoredWorkCard.vue'
import MonitoredFiltersMenu from '../components/MonitoredFiltersMenu.vue'
import MonitoredQuickSelect from '../components/MonitoredQuickSelect.vue'
import MonitoredSelectionBar from '../components/MonitoredSelectionBar.vue'
import { useMonitoredBulkSelection } from '../composables/useMonitoredBulkSelection'
import { RELEASE_STATUS_OPTIONS, readStatusFilters } from '../lib/status-filter'
import { readFilterSections, type MonitoredFilterSection } from '../lib/filter-sections'
import {
  classChangeLeavesQueue,
  countWorkClasses,
  readClassSelection,
  workClassChanged,
  toClassSelection,
  toReleaseDisplay,
  type MonitoredDisplayOptions,
} from '../lib/work-visibility'
import { releaseTimeBadge, type TimeBadge } from '../lib/time-badge'
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
  releases,
  authorTotal,
  releaseTotal,
  releaseCardTotal,
  authorDroppedOffset,
  releaseDroppedOffset,
  authorLoading,
  releaseLoading,
  summaryLoading,
  authorHasMore,
  releaseHasMore,
  counts,
  summaryReleaseCards,
  hardcoverConfigured,
  audibleConfigured,
  error,
  loadSummary,
  loadAuthors,
  loadReleases,
} = useMonitored(() => {
  if (authors.value.some((author) => author.fetch.state !== 'idle')) void reloadActive(true)
})
const { onRequestsChanged } = useBookRequestProgress()
const { monitoredReleaseRowDensity } = useDisplaySettings()
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
const panelAuthorId = ref<string | null>(null)
const panelModes = ref<Partial<Record<MonitoredFormat, MonitorMode>>>({})
const panelCheckedAt = ref<string | null>(null)
/** Authors whose refresh this page started and is still waiting on; the panel follows whichever one it shows. */
const checkingAuthorIds = ref(new Set<string>())
const panelChecking = computed(() => refreshAllRunning.value || (panelAuthorId.value !== null && checkingAuthorIds.value.has(panelAuthorId.value)))

function entryModes(entry: MonitoredReleaseEntry): Partial<Record<MonitoredFormat, MonitorMode>> {
  return entry.items[0]?.authorModes ?? {}
}

function entryFormats(entry: MonitoredReleaseEntry): MonitoredFormat[] | undefined {
  const modes = entry.items[0]?.authorModes
  if (!modes) return undefined
  return (Object.keys(modes) as MonitoredFormat[]).filter((format) => modes[format] !== 'off')
}

function openItemPanel(item: MonitoredReleaseItem) {
  const entry = releaseSections.value.flatMap((section) => section.entries).find((candidate) => candidate.items.includes(item))
  if (entry) openEntryPanel(entry)
}

function openEntryPanel(entry: MonitoredReleaseEntry) {
  panelOwned.value = entryCanManage(entry)
  panelWork.value = entry.work
  panelAuthorName.value = entry.authorName
  panelFormats.value = entryFormats(entry)
  panelAuthorId.value = entry.items[0]?.monitorAuthorId ?? null
  panelModes.value = entryModes(entry)
  panelCheckedAt.value = entry.items[0]?.authorLastRefreshedAt ?? null
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
  work.requestStatuses = { ...work.requestStatuses, [format]: 'grabbed' }
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
  const reloaded = releases.value.find((item) => item.workId === work.id)?.work
  if (reloaded) panelWork.value = reloaded
}

/**
 * One work, one object. The server's answer replaces the work every list renders from, so the card,
 * its release rows and the open panel cannot drift apart while the page waits for its refetch.
 */
function applyWorkUpdate(updated: MonitoredWork): void {
  for (const item of releases.value) if (item.workId === updated.id) item.work = updated
  if (panelWork.value?.id === updated.id) panelWork.value = updated
}

// A release row is listed, grouped and counted by its date, so only a date that actually moved is
// worth a reload: the refresh button usually changes nothing, and a reload drops the scrolled pages.
function handleWorkUpdated(updated: MonitoredWork): void {
  const before = panelWork.value?.id === updated.id ? panelWork.value : null
  const previous = before ?? releases.value.find((item) => item.workId === updated.id)?.work ?? null
  if (workClassChanged(previous, updated)) refreshReleaseClassCounts()
  const moved = releaseDateMoved(before, updated)
  applyWorkUpdate(updated)
  // In the review queue the row leaves the list once its class no longer matches the selection.
  const leavesQueue = classChangeLeavesQueue(previous, updated, effectiveReleaseClasses.value)
  if (!moved && !leavesQueue) return
  if (moved) void loadSummary()
  void reloadActive(true)
}

async function requestWorkFormat(work: MonitoredWork, format: MonitoredFormat, autoDownload?: boolean) {
  if (!canManage.value) return
  try {
    const updated = await requestMonitoredWork(work.id, {
      format,
      ...(autoDownload !== undefined ? { autoDownload } : {}),
    })
    applyWorkUpdate(updated)
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
    if (workClassChanged(work, updated)) refreshReleaseClassCounts()
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

function handleSetAutomatic(work: MonitoredWork) {
  void patchWork(work, { automaticVisibility: true })
}

function handleSetKind(work: MonitoredWork, kind: MonitoredMarkKind) {
  void patchWork(work, { kind })
}

function clearChecking(authorId: string): void {
  const next = new Set(checkingAuthorIds.value)
  next.delete(authorId)
  checkingAuthorIds.value = next
}

const settleLibraryCheck = useLibraryCheckSettlement((authorId) => checkingAuthorIds.value.has(authorId), settleLibraryCheckAttempt)
async function settleLibraryCheckAttempt(authorId: string): Promise<void> {
  try {
    const detail = await fetchMonitoredAuthorDetail(authorId, { sort: 'releaseDate', order: 'desc', includeHidden: true })
    if (detail.author.fetch.state === 'queued' || detail.author.fetch.state === 'fetching') return
    if (panelAuthorId.value === authorId) {
      panelCheckedAt.value = detail.author.lastRefreshedAt
      const reloaded = detail.works.find((work) => work.id === panelWork.value?.id)
      if (reloaded) panelWork.value = reloaded
    }
    clearChecking(authorId)
    void reloadActive(true)
  } catch (cause) {
    clearChecking(authorId)
    toast.error(monitoredErrorText(cause, t('monitored.toast.refreshFailed')))
  }
}

useMonitoredFetchEvents({
  onItem(item) {
    if (item.fetch.state === 'idle' || item.fetch.state === 'failed') void settleLibraryCheck(item.id)
  },
  onReconnect() {
    for (const id of checkingAuthorIds.value) void settleLibraryCheck(id)
  },
})

async function handleCheckLibrary() {
  const authorId = panelAuthorId.value
  if (!authorId || panelChecking.value) return
  checkingAuthorIds.value = new Set([...checkingAuthorIds.value, authorId])
  try {
    const item = await refreshMonitoredAuthor(authorId)
    handleAuthorUpdated(item)
  } catch (cause) {
    clearChecking(authorId)
    toast.error(monitoredErrorText(cause, t('monitored.toast.refreshFailed')))
  }
}

function handleToggleHidden(work: MonitoredWork, value: boolean) {
  void patchWork(work, { hidden: value })
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

const DEFAULT_SORT = { authors: 'name', releases: 'date' } as const
const DEFAULT_ORDER = { authors: 'asc', releases: 'asc' } as const
// Adding an author is the page's main action, so its tab keeps the accent colour even when inactive.
const TAB_CLASSES = {
  default: { active: 'border-primary text-foreground', inactive: 'border-transparent text-muted-foreground hover:text-foreground' },
  add: { active: 'border-primary text-primary', inactive: 'border-transparent text-primary' },
}

function tabClass(id: MonitoredTab): string {
  const classes = id === 'add' ? TAB_CLASSES.add : TAB_CLASSES.default
  return activeTab.value === id ? classes.active : classes.inactive
}

const tabs = computed(() => [
  { id: 'authors' as const, label: t('monitored.tabs.authors'), count: counts.value.authors },
  { id: 'releases' as const, label: t('monitored.tabs.releases'), count: releaseCount(counts.value.releases, summaryReleaseCards.value) },
  ...(canManage.value ? [{ id: 'add' as const, label: t('monitored.tabs.add'), count: null }] : []),
])
// ---- View mode, filter, sort and grouping (persisted; Shelfmark-style, Book Orbit visuals) ----
type ReleaseFilter = MonitoredReleaseFilter
type ReleaseSort = MonitoredReleaseListSort
type ReleaseGroup = MonitoredReleaseGroup

function persisted<T extends string>(key: string, fallback: T, allowed: readonly T[]) {
  const value = ref<T>(
    (allowed as readonly string[]).includes(storage.get<string | null>(key, null) ?? '') ? (storage.get<string>(key, fallback) as T) : fallback,
  )
  watch(value, (next) => storage.set(key, next))
  return value
}

const releaseFilter = persisted<ReleaseFilter>('monitored:releases:filter', 'all', MONITORED_RELEASE_FILTERS)
const releaseSort = persisted<ReleaseSort>('monitored:releases:sort', 'date', MONITORED_RELEASE_LIST_SORTS)
const releaseOrder = persisted<'asc' | 'desc'>('monitored:releases:order', 'asc', MONITORED_LIST_ORDERS)
const RELEASE_STATUS_STORAGE_KEY = 'monitored:releases:status'
const releaseStatus = ref<MonitoredStatusFilter[]>(readStatusFilters(storage.get<unknown>(RELEASE_STATUS_STORAGE_KEY, null)))
watch(releaseStatus, (next) => storage.set(RELEASE_STATUS_STORAGE_KEY, next))

// Only the class half of the display options reaches the server here; the time chips cover released/upcoming.
const RELEASE_CLASSES_STORAGE_KEY = 'monitored:releases:classes'
const releaseClasses = ref<MonitoredClassSelection>(readClassSelection(storage.get<unknown>(RELEASE_CLASSES_STORAGE_KEY, null)))
watch(releaseClasses, (next) => storage.set(RELEASE_CLASSES_STORAGE_KEY, next))
// A user who cannot curate has no More section, so a stored selection from it must not narrow the list.
const effectiveReleaseClasses = computed<MonitoredClassSelection>(() =>
  canManage.value ? releaseClasses.value : { kinds: releaseClasses.value.kinds, more: [] },
)
const releaseDisplay = computed(() => toReleaseDisplay(effectiveReleaseClasses.value))

const RELEASE_FILTER_SECTIONS_STORAGE_KEY = 'monitored:releases:filterSections'
const releaseFilterSections = ref(readFilterSections(storage.get<unknown>(RELEASE_FILTER_SECTIONS_STORAGE_KEY, null)))

function handleReleaseFilterSectionToggle(key: MonitoredFilterSection) {
  releaseFilterSections.value = { ...releaseFilterSections.value, [key]: !releaseFilterSections.value[key] }
  storage.set(RELEASE_FILTER_SECTIONS_STORAGE_KEY, releaseFilterSections.value)
}

function handleReleaseStatusChange(value: MonitoredStatusFilter[]) {
  // A list filtered to no status at all could not say why it is empty, so the last tick stays.
  if (value.length) releaseStatus.value = value
}

function handleReleaseDisplayChange(value: MonitoredDisplayOptions) {
  releaseClasses.value = toClassSelection(value)
}

const releaseClassCounts = ref(countWorkClasses([]))
let releaseClassCountsLoaded = false

async function loadReleaseClassCounts(): Promise<void> {
  try {
    releaseClassCounts.value = await fetchClassCounts()
    releaseClassCountsLoaded = true
  } catch {
    // The counts are a convenience on the menu: a failed fetch leaves the previous ones and the next open retries.
  }
}

function handleReleaseFiltersOpenChange(open: boolean) {
  if (open) void loadReleaseClassCounts()
}

function refreshReleaseClassCounts() {
  if (releaseClassCountsLoaded) void loadReleaseClassCounts()
}

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
const showDisplayControls = computed(() => activeTab.value === 'authors' || activeTab.value === 'releases')
const showReleaseRows = computed(() => activeTab.value === 'releases' && releasesView.value === 'table')
const headerRowDensity = computed(() => (showReleaseRows.value ? monitoredReleaseRowDensity.value : undefined))
const sortedAuthors = computed(() => authors.value)

const releaseSortOptions = computed<{ value: ReleaseSort; label: string }[]>(() => [
  { value: 'date', label: t('monitored.controlsBar.sortDate') },
  { value: 'title', label: t('monitored.controlsBar.sortTitle') },
  { value: 'author', label: t('monitored.controlsBar.sortAuthor') },
])
const releaseGroupOptions = computed<{ value: ReleaseGroup; label: string }[]>(() => [
  { value: 'status', label: t('monitored.controlsBar.groupStatus') },
  { value: 'none', label: t('monitored.controlsBar.groupNone') },
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

function handleAuthorSortChange(value: AuthorSort) {
  authorSort.value = value
}

function handleAuthorOrderChange(value: 'asc' | 'desc') {
  authorOrder.value = value
}

const headerViewMode = computed<BookViewMode>(() => (releasesView.value === 'cards' ? 'grid' : 'list'))

function handleHeaderViewMode(mode: BookViewMode) {
  releasesView.value = mode === 'grid' ? 'cards' : 'table'
}

function handleRowDensityUpdate(value: TableDensity) {
  monitoredReleaseRowDensity.value = value
}

function handleSearchUpdate(value: string) {
  filterQuery.value = value
}

function handleSearchClear() {
  filterQuery.value = ''
}

function handleCardSizeUpdate(value: number) {
  activeCardSize.value = value
}

function handleCardGapUpdate(value: number) {
  cardGap.value = value
}

const sortedReleases = computed(() => releases.value)

const releaseGroups = computed<{ key: string; label: string | null; items: MonitoredReleaseItem[] }[]>(() => {
  const items = sortedReleases.value
  if (releaseGroup.value === 'none') return [{ key: 'all', label: null, items }]
  const todayUtc = new Date().toISOString().slice(0, 10)
  const bySection: Record<MonitoredReleaseSection, MonitoredReleaseItem[]> = { released: [], upcoming: [], undated: [] }
  for (const item of items) bySection[releaseSectionOf(item.releaseDate, todayUtc)].push(item)
  return [
    { key: 'released', label: t('monitored.controlsBar.sectionReleased'), items: bySection.released },
    { key: 'upcoming', label: t('monitored.controlsBar.sectionUpcoming'), items: bySection.upcoming },
    { key: 'undated', label: t('monitored.releases.sections.undated'), items: bySection.undated },
  ].filter((group) => group.items.length > 0)
})

const releaseSections = computed(() =>
  releaseGroups.value.map((group) => {
    const entries = collapseReleaseItems(group.items)
    const count = releasesView.value === 'table' ? group.items.length : entries.length
    return { ...group, entries, count: releaseHasMore.value ? null : count }
  }),
)

const selectionAvailable = computed(() => activeTab.value === 'releases' && canManage.value)

// Review classes (unconfirmed, hidden, other kinds) are picked to be kept or marked, not downloaded,
// so a row with nothing left to get is still a valid pick there.
const reviewClassesActive = computed(() => !isDefaultClassSelection(effectiveReleaseClasses.value))

/**
 * Works a list row may be picked for: yours to manage, with a watched format still to get. Decided once
 * per work so both of its rows agree, and once per list change rather than per row on every render.
 */
const selectableRowWorkIds = computed(() => {
  const ids = new Set<string>()
  if (!canManage.value) return ids
  for (const section of releaseSections.value) {
    for (const item of section.items) {
      if (!ids.has(item.workId) && item.isOwner && (reviewClassesActive.value || releaseItemHasFormatToGet(item))) ids.add(item.workId)
    }
  }
  return ids
})

function rowSelectable(item: MonitoredReleaseItem): boolean {
  return selectableRowWorkIds.value.has(item.workId)
}

/** The works each group offers to the selection, once each: list rows that have something left, or manageable cards. */
const groupSelectableIds = computed(
  () =>
    new Map(
      releaseSections.value.map((group) => {
        const ids =
          releasesView.value === 'table'
            ? group.items.filter(rowSelectable).map((item) => item.workId)
            : group.entries.filter(entryCanManage).map((entry) => entry.work.id)
        return [group.key, [...new Set(ids)]]
      }),
    ),
)
// One work can sit in more than one section, so it is listed once, by first appearance.
const selectableWorks = computed(() => {
  if (!selectionAvailable.value) return []
  if (releasesView.value === 'table') {
    const items = releaseSections.value.flatMap((section) => section.items).filter(rowSelectable)
    return [...new Map(items.map((item) => [item.workId, item.work])).values()]
  }
  const entries = releaseSections.value.flatMap((section) => section.entries).filter(entryCanManage)
  return [...new Map(entries.map((entry) => [entry.work.id, entry.work])).values()]
})
const {
  selectionMode,
  selectedIds,
  selectedWorks,
  format: bulkFormat,
  autoDownload: bulkAutoDownload,
  running: bulkRunning,
  sourceGroups,
  toggleSource,
  useAllSources,
  handleSelectWork,
  startSelectingWith,
  toggleSelectionMode,
  exitSelectionMode,
  replaceSelection,
  addMany,
  selectMany,
  deselectMany,
  toggleBook,
  requestSelected,
  updateSelected,
} = useMonitoredBulkSelection({
  works: selectableWorks,
  applyWork: applyWorkUpdate,
  onChanged: () => {
    refreshReleaseClassCounts()
    void reloadActive(true)
  },
})

type ReleaseSection = (typeof releaseSections.value)[number]
interface GroupSelection {
  ids: string[]
  selected: number
  state: 'none' | 'some' | 'all'
  ariaChecked: 'true' | 'false' | 'mixed'
}

const NO_GROUP_SELECTION: GroupSelection = { ids: [], selected: 0, state: 'none', ariaChecked: 'false' }

const groupSelections = computed(() => {
  const byGroup = new Map<string, GroupSelection>()
  for (const [key, ids] of groupSelectableIds.value) {
    const selected = ids.filter((id) => selectedIds.value.has(id)).length
    const state = selected === 0 ? 'none' : selected === ids.length ? 'all' : 'some'
    byGroup.set(key, { ids, selected, state, ariaChecked: state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false' })
  }
  return byGroup
})

function groupSelection(group: ReleaseSection): GroupSelection {
  return groupSelections.value.get(group.key) ?? NO_GROUP_SELECTION
}

function handleGroupSelect(group: ReleaseSection) {
  const { ids, state } = groupSelection(group)
  if (state === 'all') deselectMany(ids)
  else selectMany(ids)
}

/** The list row a shift-click sweeps from. Rows, not works: one work has a row per format, often far apart. */
const rowAnchor = ref<string | null>(null)

function handleRowSelect(item: MonitoredReleaseItem, event: MouseEvent) {
  const key = releaseKey(item)
  const anchor = rowAnchor.value
  rowAnchor.value = key
  const rows = releaseSections.value.flatMap((section) => section.items)
  const swept = event.shiftKey && anchor !== null ? sweptRowWorkIds(rows, anchor, key, releaseKey, rowSelectable) : null
  if (swept) selectMany(swept)
  else toggleBook(item.workId)
}

function handleRowLongPress(item: MonitoredReleaseItem) {
  rowAnchor.value = releaseKey(item)
  startSelectingWith(item.work)
}

watch(selectionMode, (on) => {
  if (!on) rowAnchor.value = null
})
watch(
  [activeTab, releasesView, filterQuery, releaseSort, releaseOrder, releaseFilter, releaseStatus, releaseClasses, releaseGroup],
  exitSelectionMode,
)
watch(selectionAvailable, (available) => {
  if (!available) exitSelectionMode()
})

// Audiobook release dates are sourced from Audible alone, so with that provider off the feed is
// silently ebook-only rather than empty. The notice belongs where that gap is visible.
const showAudibleNotice = computed(() => activeTab.value === 'releases' && !audibleConfigured.value)

const activeTotal = computed(() => {
  if (activeTab.value === 'add') return 0
  if (activeTab.value === 'authors') return authorTotal.value
  return releaseCount(releaseTotal.value, releaseCardTotal.value)
})

const foldedCount = computed(() => (activeTab.value === 'add' ? undefined : formatNumber(activeTotal.value)))
const factsLabel = computed(() =>
  activeTab.value === 'authors'
    ? t('components.browseHeader.facts.authors', { count: activeTotal.value })
    : t('monitored.facts.releases', { count: activeTotal.value }),
)

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
  return t('monitored.list.allLoadedReleases', { total })
})

// Skeleton only before a tab's first page ever lands. Search keystrokes, sorts and filter chips
// refetch constantly, and swapping content for a skeleton on each one is a flicker, not a state.
const initialLoaded = computed(() => activeTab.value === 'add' || loadedTabs.value.has(activeTab.value))

const loading = computed(() => {
  if (activeTab.value === 'authors') return authorLoading.value
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
  if (activeTab.value === 'releases') return releaseHasMore.value
  return false
})
const activeItemsLength = computed(() => {
  if (activeTab.value === 'authors') return authors.value.length
  if (activeTab.value === 'releases') return releases.value.length
  return 0
})
/** > 0 once the retention cap has dropped the earliest pages of the active list from memory. */
const activeDroppedOffset = computed(() => {
  if (activeTab.value === 'authors') return authorDroppedOffset.value
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
  } else if (tab === 'releases') {
    await loadReleases(
      {
        q,
        sort: releaseSort.value,
        order: releaseOrder.value,
        filter: releaseFilter.value,
        status: releaseStatus.value,
        classes: effectiveReleaseClasses.value,
      },
      reset,
    )
  } else {
    return
  }
  if (!loadedTabs.value.has(tab)) loadedTabs.value = new Set([...loadedTabs.value, tab])
}

function activeSort(): string | null {
  if (activeTab.value === 'authors') return authorSort.value
  if (activeTab.value === 'releases') return releaseSort.value
  return null
}

function activeOrder(): 'asc' | 'desc' | null {
  if (activeTab.value === 'authors') return authorOrder.value
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
    else if (activeTab.value === 'releases') releaseOrder.value = order
  }
  if (sort) {
    if (activeTab.value === 'authors' && (MONITORED_AUTHOR_LIST_SORTS as readonly string[]).includes(sort)) {
      authorSort.value = sort as AuthorSort
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
  let summary: MonitoredRefreshSummary = { queued: 0, refreshed: 0, skipped: 0, failed: 0 }
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
    if (summary.skipped > 0 || summary.failed > 0) {
      toast.success(t('monitored.fetch.queuedSummaryPartial', { count: summary.queued, skipped: summary.skipped, failed: summary.failed }))
    } else toast.success(t('monitored.fetch.queuedSummary', { count: summary.queued }))
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

function releaseKey(item: MonitoredReleaseItem): string {
  return `${item.workId}:${item.format}`
}

/** The row a request was just filed from reads that request's phase; anything else leaves it be. */
function releaseStatusForWork(work: MonitoredWork, format: MonitoredFormat, fallback: MonitoredReleaseStatus): MonitoredReleaseStatus {
  return monitoredAcquisitionState(work.requestStatuses?.[format]) ?? fallback
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
  return entry.items.some((item) => isReleaseRequesting(item) || isMonitoredAcquisitionState(item.status))
}

function entryFormatQueued(entry: MonitoredReleaseEntry, format: MonitoredFormat): boolean {
  return entry.items.some((item) => item.format === format && (isReleaseRequesting(item) || isMonitoredAcquisitionState(item.status)))
}

function entryCanManage(entry: MonitoredReleaseEntry): boolean {
  return canManage.value && (entry.items[0]?.isOwner ?? false)
}

function entryTimeBadge(entry: MonitoredReleaseEntry): TimeBadge | null {
  const workDate = releaseDateForWork(entry.work)
  const shown = entry.items.find((item) => item.releaseDate === workDate) ?? entry.items[0]
  return shown ? releaseTimeBadge(shown.releaseDate, t) : null
}

async function handleReleaseRequest(item: MonitoredReleaseItem) {
  const key = releaseKey(item)
  if (!canManage.value || requestingReleases.value.has(key)) return
  requestingReleases.value = new Set([...requestingReleases.value, key])
  const previousStatus = item.status
  item.status = 'queued'
  try {
    const result = await requestMonitoredWork(item.workId, { format: item.format })
    applyWorkUpdate(result)
    for (const candidate of releases.value) {
      if (candidate.workId === item.workId && candidate.format === item.format) {
        candidate.requestId = result.requestIds[item.format] ?? null
        candidate.status = releaseStatusForWork(result, item.format, previousStatus)
      }
    }
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
watch([releaseSort, releaseOrder, releaseFilter, releaseStatus, effectiveReleaseClasses], () => {
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
})

defineOptions({ name: 'MonitoredView' })
</script>

<template>
  <section class="flex h-full flex-col">
    <BrowseHeader
      :eyebrow="t('components.browseHeader.eyebrow.browse')"
      :title="t('monitored.title')"
      icon="Bell"
      fallback-icon="Bell"
      :folded-count="foldedCount"
      :scroll-container="mainRef"
    >
      <template v-if="activeTab !== 'add'" #facts>
        <span class="truncate">{{ factsLabel }}</span>
      </template>

      <template v-if="canManage" #actions>
        <button
          type="button"
          :class="outlineButton"
          :disabled="refreshState === 'loading' || refreshAllRunning"
          :aria-label="refreshLabel"
          :title="refreshLabel"
          @click="handleRefresh"
        >
          <Loader2 v-if="refreshState === 'loading'" class="animate-spin" :size="14" aria-hidden="true" />
          <Check v-else-if="refreshState === 'done'" class="text-[var(--pill-success)]" :size="14" aria-hidden="true" />
          <RefreshCw v-else :size="14" aria-hidden="true" />
          <span v-if="refreshAllProgress" class="text-[12px] tabular-nums text-muted-foreground" aria-hidden="true">
            {{ formatNumber(refreshAllProgress.processed) }}/{{ formatNumber(refreshAllProgress.total) }}
          </span>
        </button>
      </template>

      <template #bar>
        <BrowseSearchField
          v-if="activeTab !== 'add'"
          :model-value="filterQuery"
          :placeholder="t('monitored.searchPlaceholder')"
          :active="filterQuery.trim().length > 0"
          @update:model-value="handleSearchUpdate"
          @clear="handleSearchClear"
        />
        <template v-if="activeTab === 'releases'">
          <span :class="barDivider" aria-hidden="true" />
          <MonitoredSortMenu
            :options="releaseSortOptions"
            :model-value="releaseSort"
            :order="releaseOrder"
            default-value="date"
            default-order="asc"
            @update:model-value="handleReleaseSortChange"
            @update:order="handleReleaseOrderChange"
          />
          <MonitoredFiltersMenu
            :model-value="releaseDisplay"
            :counts="releaseClassCounts"
            :sections="releaseFilterSections"
            :can-curate="canManage"
            :status-filters="releaseStatus"
            :status-options="RELEASE_STATUS_OPTIONS"
            :show-release="false"
            commit-on-close
            @toggle-section="handleReleaseFilterSectionToggle"
            @update:status-filters="handleReleaseStatusChange"
            @update:model-value="handleReleaseDisplayChange"
            @open-change="handleReleaseFiltersOpenChange"
          />
          <MonitoredGroupMenu
            :options="releaseGroupOptions"
            :model-value="releaseGroup"
            default-value="status"
            @update:model-value="handleReleaseGroupChange"
          />
          <div class="hidden min-w-0 md:block">
            <MonitoredReleaseFilterBar v-model="releaseFilter" />
          </div>
        </template>
        <template v-else-if="activeTab === 'authors'">
          <span :class="barDivider" aria-hidden="true" />
          <MonitoredSortMenu
            :options="authorSortOptions"
            :model-value="authorSort"
            :order="authorOrder"
            default-value="name"
            default-order="asc"
            @update:model-value="handleAuthorSortChange"
            @update:order="handleAuthorOrderChange"
          />
        </template>
        <template v-if="showDisplayControls">
          <span class="flex-1" aria-hidden="true" />
          <BrowseViewControls
            :view-mode="headerViewMode"
            :allowed-view-modes="activeTab === 'releases' ? ['grid', 'list'] : ['grid']"
            :show-selection="selectionAvailable"
            :selection-mode="selectionMode"
            @update:view-mode="handleHeaderViewMode"
            @toggle-selection="toggleSelectionMode"
          >
            <template #display>
              <ViewHeaderDisplayControls
                :view-mode="headerViewMode"
                :cover-size="activeCardSize"
                :grid-gap="cardGap"
                :row-density="headerRowDensity"
                :hide-size-controls="showReleaseRows"
                :cover-size-min="activeCardSizeConfig.min"
                :cover-size-max="activeCardSizeConfig.max"
                :cover-size-step="4"
                @update:cover-size="handleCardSizeUpdate"
                @update:grid-gap="handleCardGapUpdate"
                @update:row-density="handleRowDensityUpdate"
              />
            </template>
          </BrowseViewControls>
        </template>
      </template>
    </BrowseHeader>

    <div class="mb-3 flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-1">
      <div class="monitored-tabs no-scrollbar flex max-w-full gap-1 overflow-x-auto" role="tablist" :aria-label="t('monitored.tabs.label')">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.id"
          class="inline-flex shrink-0 items-center gap-1 border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
          :class="tabClass(tab.id)"
          @click="selectTab(tab.id)"
        >
          <Plus v-if="tab.id === 'add'" :size="14" aria-hidden="true" />
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

      <!-- The header row has no room for the filter on narrow screens, so it stays beside the tabs there. -->
      <div v-if="activeTab === 'releases'" class="min-w-0 md:hidden">
        <MonitoredReleaseFilterBar v-model="releaseFilter" />
      </div>
    </div>

    <main ref="mainRef" class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pr-0 sm:pr-2">
      <div class="mx-auto w-full max-w-7xl pb-8">
        <div
          v-if="error"
          role="alert"
          class="mx-1 mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <span class="min-w-0">{{ error }}</span>
          <Button variant="outline" size="sm" @click="handleRetry">{{ t('common.retry') }}</Button>
        </div>
        <MonitoredHardcoverNotice v-if="!hardcoverConfigured" class="mx-1 mt-4" />
        <MonitoredAudibleNotice v-if="showAudibleNotice" class="mx-1 mt-4" />
        <!-- Retention drops the earliest pages once a list passes the cap; scrolling back to this edge
           means the top of the render is no longer page 0, so a reset is the only way back to it. -->
        <div v-if="activeTab !== 'add'" ref="topSentinel" aria-hidden="true" />
        <!-- Skeleton only before a tab's first page lands; a refetch keeps the current rows on screen. -->
        <div v-if="showSkeleton" class="mt-4 px-1" aria-hidden="true">
          <div v-if="activeTab === 'authors' || releasesView === 'cards'" class="grid" :style="skeletonGridStyle">
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

        <section v-else-if="activeTab === 'releases'" class="mt-4 space-y-6 px-1" :class="selectionMode ? 'pb-28' : ''">
          <MonitoredQuickSelect
            v-if="selectionMode"
            :works="selectableWorks"
            :selected-ids="selectedIds"
            :format="bulkFormat"
            @add="addMany"
            @keep="replaceSelection"
          />
          <section v-for="group in releaseSections" :key="group.key">
            <div v-if="group.label || (selectionMode && groupSelection(group).ids.length)" class="mb-3 flex items-center gap-2">
              <template v-if="group.label">
                <h3 class="text-xs font-semibold text-foreground">{{ group.label }}</h3>
                <span v-if="group.count !== null" class="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">{{
                  formatNumber(group.count)
                }}</span>
              </template>
              <div class="h-px flex-1 bg-border" />
              <div v-if="selectionMode && groupSelection(group).ids.length" class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                <button
                  type="button"
                  role="checkbox"
                  :aria-checked="groupSelection(group).ariaChecked"
                  :aria-label="t('monitored.selection.group.selectAll', { name: group.label ?? t('monitored.tabs.releases') })"
                  class="flex size-5 shrink-0 items-center justify-center rounded-xs border transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  :class="
                    groupSelection(group).state === 'none'
                      ? 'border-border bg-background hover:border-primary'
                      : 'border-primary bg-primary text-primary-foreground'
                  "
                  data-testid="group-select"
                  @click="handleGroupSelect(group)"
                >
                  <Check v-if="groupSelection(group).state === 'all'" :size="12" aria-hidden="true" />
                  <Minus v-else-if="groupSelection(group).state === 'some'" :size="12" aria-hidden="true" />
                </button>
                <span class="tabular-nums" data-testid="group-progress">{{
                  t('monitored.selection.group.progress', { selected: groupSelection(group).selected, total: groupSelection(group).ids.length })
                }}</span>
              </div>
            </div>
            <div v-if="releasesView === 'table'" class="space-y-3">
              <MonitoredReleaseRow
                v-for="item in group.items"
                :key="releaseKey(item)"
                :item="item"
                :density="monitoredReleaseRowDensity"
                :can-manage="canManage && item.isOwner"
                :requesting="isReleaseRequesting(item)"
                :selection-mode="selectionMode"
                :selected="selectedIds.has(item.workId)"
                :selectable="rowSelectable(item)"
                @request="handleReleaseRequest"
                @preview="openItemPanel"
                :long-press-select="selectionAvailable"
                @select="handleRowSelect"
                @long-press="handleRowLongPress"
              />
            </div>
            <MonitoredVirtualGrid v-else :virtualized="releaseGroup === 'none'" :items="group.entries" :card-size="workCardSize" :grid-gap="cardGap">
              <template #default="{ item: entry }">
                <MonitoredWorkCard
                  :work="entry.work"
                  :queued="entryQueued(entry)"
                  :ebook-queued="entryFormatQueued(entry, 'ebook')"
                  :audiobook-queued="entryFormatQueued(entry, 'audiobook')"
                  :time-badge="entryTimeBadge(entry)"
                  :author-name="entry.authorName"
                  :monitored-formats="entryFormats(entry)"
                  :format-modes="entryModes(entry)"
                  :can-manage="entryCanManage(entry)"
                  :selection-mode="selectionMode"
                  :selectable="entryCanManage(entry)"
                  :selected="selectedIds.has(entry.work.id)"
                  :long-press-select="selectionAvailable && entryCanManage(entry)"
                  @select="handleSelectWork"
                  @long-press="startSelectingWith"
                  @preview="openEntryPanel(entry)"
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
      <MonitoredSelectionBar
        :visible="selectionMode"
        :works="selectedWorks"
        v-model:format="bulkFormat"
        v-model:auto-download="bulkAutoDownload"
        :running="bulkRunning"
        :source-groups="sourceGroups"
        @toggle-source="toggleSource"
        @use-all-sources="useAllSources"
        @patch="updateSelected"
        @request="requestSelected"
        @exit="exitSelectionMode"
      />
      <ConfirmDialog
        :open="pendingAuthorRemoval !== null"
        :title="t('monitored.detail.stopDialog.title')"
        :description="t('monitored.detail.stopDialog.description')"
        :confirm-label="t('monitored.actions.stopMonitoring')"
        :busy="removing"
        @confirm="confirmAuthorRemove"
        @cancel="cancelAuthorRemove"
      />
      <MonitoredBookPanel
        :work="panelWork"
        :author-name="panelAuthorName"
        :monitored-formats="panelFormats"
        :author-id="panelAuthorId"
        :format-modes="panelModes"
        :can-manage="canManage && panelOwned"
        :checked-at="panelCheckedAt"
        :checking="panelChecking"
        :open="panelOpen"
        @update:open="handlePanelOpen"
        @request="handlePanelRequest"
        @grabbed="handlePanelGrabbed"
        @filed="handlePanelFiled"
        @toggle-monitor="handleToggleMonitor"
        @toggle-hidden="handleToggleHidden"
        @set-automatic="handleSetAutomatic"
        @set-kind="handleSetKind"
        @check-library="handleCheckLibrary"
        @work-updated="handleWorkUpdated"
      />
    </main>
  </section>
</template>

<style scoped>
/* Below the point where every tab fits, the strip scrolls; the fade is the only cue it can. */
@media (max-width: 639px) {
  .monitored-tabs {
    mask-image: linear-gradient(90deg, #000 calc(100% - 22px), transparent 100%);
  }
}
</style>
