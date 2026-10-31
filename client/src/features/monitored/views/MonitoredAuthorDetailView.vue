<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, provide, ref, watch } from 'vue'
import {
  BookCopy,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronsDownUp,
  ChevronsUpDown,
  CheckSquare,
  Headphones,
  Layers,
  SlidersHorizontal,
  Loader2,
  Minus,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Square,
  Trash2,
} from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Permission } from '@bookorbit/types'
import type {
  MonitoredAuthorItem,
  MonitoredFormat,
  MonitoredGrouping,
  MonitoredMarkKind,
  MonitoredSort,
  MonitoredStatusFilter,
  MonitoredWork,
} from '@bookorbit/types'
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import ViewHeaderDisplayControls from '@/components/view-header/ViewHeaderDisplayControls.vue'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import AuthorPlaceholder from '@/features/author/components/AuthorPlaceholder.vue'
import { usePermissions } from '@/features/auth/composables/usePermissions'
import { useScrollRestoreOnActivate } from '@/features/book/composables/useScrollRestoreOnActivate'
import { useBookRequestProgress } from '@/features/book-requests/composables/useBookRequestProgress'
import { deleteMonitoredAuthor } from '../api/monitored'
import { monitoredErrorText } from '../lib/api-error'
import { monitoredPortraitUrl } from '../lib/portrait-url'
import MonitorAuthorModal from '../components/MonitorAuthorModal.vue'
import MonitoredFetchFailedBanner from '../components/MonitoredFetchFailedBanner.vue'
import MonitoredWorkCard from '../components/MonitoredWorkCard.vue'
import MonitoredBookPanel from '../components/MonitoredBookPanel.vue'
import MonitoredGroupOptions from '../components/MonitoredGroupOptions.vue'
import MonitoredFiltersMenu from '../components/MonitoredFiltersMenu.vue'
import MonitoredSortOptions from '../components/MonitoredSortOptions.vue'
import BrowseSearchField from '@/components/browse-header/BrowseSearchField.vue'
import BrowseSortControl from '@/components/browse-header/BrowseSortControl.vue'
import { barButton, barButtonOn, barIconButton, barDivider, BROWSE_BAR_KEY } from '@/components/browse-header/browse-header'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMonitoredPinnedBar } from '../composables/useMonitoredPinnedBar'
import MonitoredVirtualGrid from '../components/MonitoredVirtualGrid.vue'
import MonitoredQuickSelect from '../components/MonitoredQuickSelect.vue'
import MonitoredSelectionBar from '../components/MonitoredSelectionBar.vue'
import { useMonitoredBulkSelection } from '../composables/useMonitoredBulkSelection'
import { CARD_GAP, useMonitoredCardDisplay, WORK_CARD_SIZE } from '../composables/useMonitoredCardDisplay'
import type { MonitoredWorkGroup } from '../lib/grouping'
import { barLabel, barChevron, barCompactPadding, barLabelScreenReader } from '../lib/author-bar'
import { useMonitoredAuthorDetail } from '../composables/useMonitoredAuthorDetail'
import { useRefreshFeedback } from '../composables/useRefreshFeedback'
import { seriesMembershipForGroup } from '../lib/grouping'
import { useLinkedWorkParam } from '../composables/useLinkedWorkParam'

const { t, d } = useI18n()
const route = useRoute()
const router = useRouter()
const { hasPermission } = usePermissions()
const {
  detail,
  searchQuery,
  setSearchQuery,
  fetchStatus,
  loading,
  error,
  updating,
  sort,
  order,
  grouping,
  groups,
  allGroupsCollapsed,
  isGroupCollapsed,
  toggleGroup,
  toggleAllGroups,
  visibleWorks,
  loadedWorks,
  filtersAreDefault,
  display,
  filterCounts,
  filterSections,
  toggleFilterSection,
  monitoredFormats,
  formatModes,
  statusFilters,
  setStatusFilters,
  load,
  refreshAuthor,
  setSort,
  setOrder,
  toggleOrder,
  sortIsDefault,
  groupingIsDefault,
  setGrouping,
  setDisplay,
  resetDisplay,
  setPaused,
  queueWork,
  markQueued,
  isQueued,
  applyWorkUpdate,
  updateWork,
  recordVisibilityChange,
} = useMonitoredAuthorDetail()
const { state: refreshState, run: runRefresh } = useRefreshFeedback()
const { onRequestsChanged } = useBookRequestProgress()
const mainRef = ref<HTMLElement | null>(null)
useScrollRestoreOnActivate(mainRef)
const barRef = ref<HTMLElement | null>(null)
const sentinelRef = ref<HTMLElement | null>(null)
provide(BROWSE_BAR_KEY, barRef)
const { pinned } = useMonitoredPinnedBar(mainRef, sentinelRef)
function clearSearch() {
  setSearchQuery('')
}
const confirmStopOpen = ref(false)
const editOpen = ref(false)
const imageFailed = ref(false)
// The header's prose and links cost a full viewport on a phone, so they stay behind a toggle there.
const detailsExpanded = ref(false)
const panelWork = ref<MonitoredWork | null>(null)
const panelOpen = ref(false)
// Deferred server reconciliation runs when this kept-alive view returns.
let reloadOnActivate = false
const viewActive = ref(true)
const initialLoadComplete = ref(false)
let requestRefreshPending = false
let requestRefreshTimer: ReturnType<typeof setTimeout> | null = null
const REQUEST_CHANGE_DEBOUNCE_MS = 1500
const { workCardSize, cardGap } = useMonitoredCardDisplay()
const displayOpen = ref(false)

function handleDisplayOpenChange(value: boolean) {
  displayOpen.value = value
}

function handleCardSizeUpdate(value: number) {
  workCardSize.value = value
}

function handleCardGapUpdate(value: number) {
  cardGap.value = value
}

const canManage = computed(() => hasPermission(Permission.BookRequestAccess))
const canEdit = computed(() => canManage.value && (detail.value?.author.isOwner ?? false))
// The owner's filters can show every kind, so their total is the whole catalog, not just the default list.
const catalogTotal = computed(() => {
  const author = detail.value?.author
  if (!author?.counts) return 0
  return author.isOwner ? author.counts.total + author.counts.hidden : author.counts.total
})
const author = computed(() => detail.value?.author ?? null)
const countTooltip = computed(() => {
  const shown = visibleWorks.value.length
  const total = catalogTotal.value
  if (shown >= total) return t('monitored.detail.booksCountAll', { total })
  const key = searchQuery.value ? 'monitored.detail.booksCountHiddenSearch' : 'monitored.detail.booksCountHidden'
  return t(key, { shown, total, rest: total - shown })
})
const portraitUrl = computed(() => (author.value?.portraitAuthorId == null ? null : monitoredPortraitUrl(author.value.id)))
const hasCatalog = computed(() => author.value?.lastRefreshedAt != null)
const ebookCount = computed(() => (hasCatalog.value ? `${author.value?.counts.ebookOwned}/${author.value?.counts.total}` : '-'))
const audioCount = computed(() => (hasCatalog.value ? `${author.value?.counts.audioOwned}/${author.value?.counts.total}` : '-'))
const fetchBusy = computed(() => fetchStatus.value.state === 'queued' || fetchStatus.value.state === 'fetching')
const nextRelease = computed(() => {
  if (!author.value?.nextReleaseAt) return t('monitored.common.tba')
  return d(new Date(author.value.nextReleaseAt), { year: 'numeric', month: 'short', day: 'numeric' })
})
const bio = computed(() => author.value?.description?.trim() ?? '')
const genres = computed(() => author.value?.genres ?? [])
const hasDetails = computed(() => Boolean(bio.value || author.value?.website || genres.value.length))
const sortOptions = computed<{ value: MonitoredSort; label: string }[]>(() => [
  { value: 'releaseDate', label: t('monitored.detail.controls.releaseDate') },
  { value: 'title', label: t('monitored.detail.controls.title') },
])
const groupOptions = computed<{ value: MonitoredGrouping; label: string }[]>(() => [
  { value: 'none', label: t('monitored.detail.controls.none') },
  { value: 'series', label: t('monitored.detail.controls.series') },
  { value: 'year', label: t('monitored.detail.controls.year') },
  { value: 'status', label: t('monitored.detail.controls.status') },
])
const sortLabel = computed(() => sortOptions.value.find((option) => option.value === sort.value)?.label ?? '')
const groupingLabel = computed(() => groupOptions.value.find((option) => option.value === grouping.value)?.label ?? '')
const collapseAllLabel = computed(() => t(allGroupsCollapsed.value ? 'monitored.detail.controls.expandAll' : 'monitored.detail.controls.collapseAll'))
const bioExpanded = ref(false)
watch(bio, () => {
  bioExpanded.value = false
})

function toggleBio() {
  bioExpanded.value = !bioExpanded.value
}

function toggleDetails() {
  detailsExpanded.value = !detailsExpanded.value
}

function goBack() {
  const from = typeof route.query.from === 'string' ? route.query.from : ''
  if (from.startsWith('/watchlist') || from.startsWith('/monitored')) {
    void router.push(from)
    return
  }
  void router.push({ name: 'monitored' })
}

function handleImageError() {
  imageFailed.value = true
}

async function handleToggleMonitoring() {
  if (!author.value || !canEdit.value) return
  const paused = !author.value.paused
  try {
    await setPaused(paused)
    toast.success(t(paused ? 'monitored.toast.paused' : 'monitored.toast.resumed', { name: author.value.authorName }))
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  }
}

async function handleRefresh() {
  if (!author.value) return
  try {
    await runRefresh(async () => {
      await refreshAuthor()
    })
    toast.success(t('monitored.fetch.queued'))
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.refreshFailed')))
  }
}

function openEdit() {
  editOpen.value = true
}

function closeEdit() {
  editOpen.value = false
}

function handleAuthorUpdated(item: MonitoredAuthorItem) {
  if (detail.value) detail.value.author = item
  editOpen.value = false
  toast.success(t('monitored.toast.settingsSaved', { name: item.authorName }))
}

function promptStopAuthor() {
  confirmStopOpen.value = true
}

function cancelStopAuthor() {
  confirmStopOpen.value = false
}

async function confirmStopAuthor() {
  if (!author.value) return
  try {
    await deleteMonitoredAuthor(author.value.id)
    toast.success(t('monitored.toast.stopped', { name: author.value.authorName }))
    await router.push({ name: 'monitored' })
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  } finally {
    confirmStopOpen.value = false
  }
}

function handleQuickView(work: MonitoredWork) {
  if (work.matchedBookId !== null) void router.push({ name: 'book-detail', params: { bookId: work.matchedBookId } })
}

function handlePreview(work: MonitoredWork) {
  panelWork.value = work
  panelOpen.value = true
}

function handlePanelOpen(value: boolean) {
  panelOpen.value = value
}

async function handlePanelRequest(work: MonitoredWork, format: MonitoredFormat, autoDownload: boolean) {
  await queue(work, format, autoDownload)
}

/**
 * The panel keeps the grab and reports its progress in place, so this only flips the card behind
 * it to queued now and refetches the page on the next visit, by which point the download may
 * already have been filed.
 */
function handlePanelGrabbed(work: MonitoredWork, format: MonitoredFormat, requestId: number) {
  markQueued(work.id, format, requestId)
  reloadOnActivate = true
}

/**
 * The download the panel was watching has landed in the library. What the work owns is the server's
 * to decide, so the page reloads and the open panel re-points at the work that came back with it.
 */
async function handlePanelFiled(work: MonitoredWork) {
  await load()
  void openLinkedWork()
  panelWork.value = detail.value?.works.find((candidate) => candidate.id === work.id) ?? panelWork.value
}

function handleWorkUpdated(updated: MonitoredWork) {
  applyWorkUpdate(updated)
  if (panelWork.value?.id === updated.id) panelWork.value = updated
}

// A series grouping can list one work under several series, so ids are deduplicated by first appearance.
const selectableWorks = computed(() => [...new Map(visibleWorks.value.map((work) => [work.id, work])).values()])
const expandedWorkIds = computed(() => [
  ...new Set(groups.value.filter((group) => !isGroupCollapsed(group.key)).flatMap((group) => group.works.map((work) => work.id))),
])
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
  selectMany,
  deselectMany,
  replaceSelection,
  addMany,
  requestSelected,
  updateSelected,
} = useMonitoredBulkSelection({
  works: selectableWorks,
  rangeIds: expandedWorkIds,
  applyWork: handleWorkUpdated,
  onPatched: recordVisibilityChange,
})

function groupSelectedCount(group: MonitoredWorkGroup): number {
  return group.works.filter((work) => selectedIds.value.has(work.id)).length
}

function groupCheckState(group: MonitoredWorkGroup): 'none' | 'some' | 'all' {
  const selected = groupSelectedCount(group)
  if (selected === 0) return 'none'
  return selected === group.works.length ? 'all' : 'some'
}

function groupAriaChecked(group: MonitoredWorkGroup): 'true' | 'false' | 'mixed' {
  const state = groupCheckState(group)
  return state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'
}

function handleGroupSelect(group: MonitoredWorkGroup) {
  const ids = group.works.map((work) => work.id)
  if (groupCheckState(group) === 'all') deselectMany(ids)
  else selectMany(ids)
}

function handleSelectionKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && selectionMode.value && !panelOpen.value && !event.defaultPrevented) exitSelectionMode()
}

const selectionLabel = computed(() => (selectionMode.value ? t('monitored.selection.done') : t('monitored.selection.select')))

watch(selectionMode, (on) => {
  if (on) window.addEventListener('keydown', handleSelectionKeydown)
  else window.removeEventListener('keydown', handleSelectionKeydown)
})

async function handleToggleMonitor(work: MonitoredWork, format: MonitoredFormat, value: boolean) {
  try {
    await updateWork(work.id, format === 'ebook' ? { monitorEbook: value } : { monitorAudiobook: value })
    panelWork.value = detail.value?.works.find((candidate) => candidate.id === work.id) ?? panelWork.value
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  }
}

async function handleToggleAutoDownload(work: MonitoredWork, format: MonitoredFormat, value: boolean | null) {
  try {
    await updateWork(work.id, format === 'ebook' ? { autoDownloadEbook: value } : { autoDownloadAudiobook: value })
    panelWork.value = detail.value?.works.find((candidate) => candidate.id === work.id) ?? panelWork.value
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  }
}

async function handleSetAutomatic(work: MonitoredWork) {
  try {
    await updateWork(work.id, { automaticVisibility: true })
    panelWork.value = detail.value?.works.find((candidate) => candidate.id === work.id) ?? panelWork.value
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  }
}

async function handleResumeAuthor() {
  if (!author.value?.paused) return
  await handleToggleMonitoring()
}

function handleStatusFiltersChange(value: MonitoredStatusFilter[]) {
  setStatusFilters(value)
}

async function handleToggleHidden(work: MonitoredWork, value: boolean) {
  try {
    await updateWork(work.id, { hidden: value })
    panelWork.value = detail.value?.works.find((candidate) => candidate.id === work.id) ?? panelWork.value
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  }
}

async function handleSetKind(work: MonitoredWork, kind: MonitoredMarkKind) {
  try {
    await updateWork(work.id, { kind })
    panelWork.value = detail.value?.works.find((candidate) => candidate.id === work.id) ?? panelWork.value
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  }
}

const checkingLibrary = ref(false)
watch(detail, (loaded) => {
  if (!loaded || !checkingLibrary.value || fetchBusy.value) return
  const workId = panelWork.value?.id
  if (workId) panelWork.value = loaded.works.find((candidate) => candidate.id === workId) ?? panelWork.value
  checkingLibrary.value = false
})
watch(fetchStatus, (status) => {
  if (checkingLibrary.value && status.state === 'failed') void load()
})
async function handleCheckLibrary() {
  if (checkingLibrary.value || fetchBusy.value) return
  checkingLibrary.value = true
  try {
    await refreshAuthor()
  } catch (cause) {
    checkingLibrary.value = false
    toast.error(monitoredErrorText(cause, t('monitored.toast.refreshFailed')))
  }
}

async function queue(work: MonitoredWork, format: MonitoredFormat, autoDownload?: boolean) {
  if (!canEdit.value || isQueued(work.id, format)) return
  try {
    await queueWork(work.id, format, autoDownload)
    if (panelWork.value?.id === work.id) panelWork.value = detail.value?.works.find((candidate) => candidate.id === work.id) ?? panelWork.value
    toast.success(t('monitored.toast.sendingToRequests', { title: work.title, format: t(`monitored.formats.${format}`) }))
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.queueFailed')))
  }
}

function handleDownloadEbook(work: MonitoredWork) {
  void queue(work, 'ebook')
}

function handleDownloadAudiobook(work: MonitoredWork) {
  void queue(work, 'audiobook')
}

async function handleStopWork(work: MonitoredWork) {
  try {
    await updateWork(work.id, { hidden: true })
    toast.success(t('monitored.toast.workStopped', { title: work.title }))
  } catch (cause) {
    toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
  }
}

function groupLabel(key: string, fallback: string): string {
  if (key === 'all') return t('monitored.detail.groups.all')
  if (key === 'standalone') return t('monitored.detail.groups.standalone')
  if (key === 'unknown') return t('monitored.detail.groups.unknownYear')
  if (key === 'upcoming') return t('monitored.detail.groups.upcoming')
  if (key === 'recent') return t('monitored.detail.groups.recent')
  if (key === 'backlist') return t('monitored.detail.groups.backlist')
  return fallback
}

function flushRequestRefresh(): void {
  if (!requestRefreshPending || !initialLoadComplete.value || loading.value) return
  requestRefreshPending = false
  if (!viewActive.value) {
    reloadOnActivate = true
    return
  }
  void load().then(openLinkedWork)
}

function handleRequestsChanged(): void {
  if (requestRefreshTimer) clearTimeout(requestRefreshTimer)
  requestRefreshTimer = setTimeout(() => {
    requestRefreshTimer = null
    if (!viewActive.value) {
      reloadOnActivate = true
      return
    }
    requestRefreshPending = true
    flushRequestRefresh()
  }, REQUEST_CHANGE_DEBOUNCE_MS)
}

onRequestsChanged(handleRequestsChanged)

watch(loading, (isLoading) => {
  if (!isLoading) flushRequestRefresh()
})

const { openLinkedWork } = useLinkedWorkParam({
  works: computed(() => detail.value?.works ?? []),
  ready: initialLoadComplete,
  active: viewActive,
  load,
  open: handlePreview,
})

onMounted(async () => {
  await load()
  initialLoadComplete.value = true
  void openLinkedWork()
  flushRequestRefresh()
})

onActivated(() => {
  viewActive.value = true
  void openLinkedWork()
  if (!reloadOnActivate) return
  reloadOnActivate = false
  void load().then(openLinkedWork)
})

onDeactivated(() => {
  viewActive.value = false
  exitSelectionMode()
})

onUnmounted(() => {
  viewActive.value = false
  window.removeEventListener('keydown', handleSelectionKeydown)
  exitSelectionMode()
  if (requestRefreshTimer) clearTimeout(requestRefreshTimer)
})

defineOptions({ name: 'MonitoredAuthorDetailView' })
</script>

<template>
  <main ref="mainRef" class="h-full overflow-y-auto pr-0 sm:pr-2">
    <div class="mx-auto w-full max-w-7xl pb-8">
      <Button variant="outline" size="sm" class="mt-3" @click="goBack">
        <ChevronLeft :size="14" />
        {{ t('monitored.detail.back') }}
      </Button>

      <div v-if="loading && !detail" class="flex min-h-80 items-center justify-center text-muted-foreground">
        <Loader2 class="animate-spin" :size="24" />
      </div>
      <div v-else-if="error && !detail" class="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {{ error }}
      </div>

      <template v-else-if="author">
        <section class="mt-4 overflow-hidden rounded-xl border border-border bg-card/80">
          <div class="bg-linear-to-b from-primary/8 via-background/0 to-transparent p-3 sm:p-5">
            <div class="flex gap-3 sm:gap-4">
              <div class="relative h-24 w-16 shrink-0 overflow-hidden rounded-lg border border-border bg-muted shadow-sm sm:h-44 sm:w-32">
                <img
                  v-if="portraitUrl && !imageFailed"
                  :src="portraitUrl"
                  :alt="author.authorName"
                  class="size-full object-cover"
                  @error="handleImageError"
                />
                <AuthorPlaceholder v-else :name="author.authorName" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <h1 class="min-w-0 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{{ author.authorName }}</h1>
                  <div class="flex items-center gap-2">
                    <button
                      v-if="canEdit"
                      type="button"
                      class="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-bold"
                      :class="
                        author.paused
                          ? 'border-border bg-muted text-muted-foreground'
                          : 'border-[var(--pill-success)]/40 bg-[var(--pill-success)]/10 text-[var(--pill-success)]'
                      "
                      :disabled="updating"
                      @click="handleToggleMonitoring"
                    >
                      <span class="size-2 rounded-full bg-current" />
                      {{ author.paused ? t('monitored.status.paused') : t('monitored.status.monitoring') }}
                    </button>
                    <DropdownMenu v-if="canEdit">
                      <DropdownMenuTrigger as-child>
                        <Button variant="outline" size="sm">
                          <Loader2 v-if="refreshState === 'loading'" class="animate-spin" />
                          <Check v-else-if="refreshState === 'done'" class="text-[var(--pill-success)]" />
                          <MoreHorizontal v-else />
                          {{ t('monitored.actions.actions') }}
                          <span v-if="fetchBusy && hasCatalog" class="text-xs text-muted-foreground">{{ t('monitored.fetch.refreshing') }}</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem :disabled="fetchBusy || refreshState === 'loading'" @click="handleRefresh"
                          ><RefreshCw :class="refreshState === 'loading' ? 'animate-spin' : ''" />{{
                            t('monitored.actions.refresh')
                          }}</DropdownMenuItem
                        >
                        <DropdownMenuItem @click="openEdit"><Pencil />{{ t('monitored.actions.editSettings') }}</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" @click="promptStopAuthor"
                          ><Trash2 />{{ t('monitored.actions.stopMonitoring') }}</DropdownMenuItem
                        >
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm sm:hidden">
                  <span class="flex items-center gap-1 font-semibold text-foreground">
                    <BookCopy :size="14" role="img" :aria-label="t('monitored.detail.stats.books')" />{{ hasCatalog ? author.counts.total : '-' }}
                  </span>
                  <span class="flex items-center gap-1 font-semibold text-[var(--pill-media-ebook)]">
                    <BookOpen :size="14" role="img" :aria-label="t('monitored.formats.ebooks')" />{{ ebookCount }}
                  </span>
                  <span class="flex items-center gap-1 font-semibold text-[var(--pill-media-audiobook)]">
                    <Headphones :size="14" role="img" :aria-label="t('monitored.formats.audiobooks')" />{{
                      hasCatalog ? author.counts.audioOwned : '-'
                    }}/{{ hasCatalog ? author.counts.total : '-' }}
                  </span>
                  <span class="flex items-center gap-1 font-semibold text-[var(--pill-warning)]">
                    <CalendarDays :size="14" role="img" :aria-label="t('monitored.detail.stats.nextRelease')" />{{ hasCatalog ? nextRelease : '-' }}
                  </span>
                </div>

                <button
                  v-if="hasDetails"
                  type="button"
                  class="mt-2 text-xs font-medium text-primary transition-colors sm:hidden"
                  @click="toggleDetails"
                >
                  {{ detailsExpanded ? t('monitored.detail.hideDetails') : t('monitored.detail.showDetails') }}
                </button>

                <div :class="detailsExpanded ? '' : 'hidden sm:block'">
                  <div class="mt-3">
                    <p v-if="bio" :class="bioExpanded ? 'text-sm leading-6 text-foreground' : 'text-sm leading-6 text-foreground line-clamp-4'">
                      {{ bio }}
                    </p>
                    <button
                      v-if="bio"
                      type="button"
                      class="mt-1 text-xs font-medium text-primary transition-colors hover:text-primary"
                      @click="toggleBio"
                    >
                      {{ bioExpanded ? t('author.header.showLess') : t('author.header.showMore') }}
                    </button>
                    <p v-else class="hidden text-sm text-muted-foreground sm:block">{{ t('monitored.detail.headerDescription') }}</p>
                  </div>

                  <dl v-if="author.website || genres.length" class="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                    <div v-if="author.website" class="flex min-w-0 gap-1.5">
                      <dt class="text-muted-foreground">{{ t('author.header.website') }}</dt>
                      <dd class="min-w-0 truncate">
                        <a :href="author.website" target="_blank" rel="noopener noreferrer" class="text-foreground underline underline-offset-2">{{
                          author.website
                        }}</a>
                      </dd>
                    </div>
                    <div v-if="genres.length" class="flex min-w-0 gap-1.5">
                      <dt class="text-muted-foreground">{{ t('author.header.genres') }}</dt>
                      <dd class="min-w-0 text-foreground">{{ genres.join(', ') }}</dd>
                    </div>
                  </dl>
                </div>

                <div class="mt-5 hidden grid-cols-2 gap-2 sm:grid lg:grid-cols-4">
                  <div class="rounded-lg border border-border bg-background/40 px-3 py-2.5">
                    <p class="flex items-center gap-1.5 text-base font-semibold text-foreground">
                      <BookCopy :size="15" />{{ hasCatalog ? author.counts.total : '-' }}
                    </p>
                    <p class="text-xs text-muted-foreground">{{ t('monitored.detail.stats.books') }}</p>
                  </div>
                  <div class="rounded-lg border border-border bg-background/40 px-3 py-2.5">
                    <p class="flex items-center gap-1.5 text-base font-semibold text-[var(--pill-media-ebook)]">
                      <BookOpen :size="15" />{{ ebookCount }}
                    </p>
                    <p class="text-xs text-muted-foreground">{{ t('monitored.formats.ebooks') }}</p>
                  </div>
                  <div class="rounded-lg border border-border bg-background/40 px-3 py-2.5">
                    <p class="flex items-center gap-1.5 text-base font-semibold text-[var(--pill-media-audiobook)]">
                      <Headphones :size="15" />{{ audioCount }}
                    </p>
                    <p class="text-xs text-muted-foreground">{{ t('monitored.formats.audiobooks') }}</p>
                  </div>
                  <div class="rounded-lg border border-border bg-background/40 px-3 py-2.5">
                    <p class="flex items-center gap-1.5 text-sm font-semibold text-[var(--pill-warning)]">
                      <CalendarDays :size="15" />{{ hasCatalog ? nextRelease : '-' }}
                    </p>
                    <p class="text-xs text-muted-foreground">{{ t('monitored.detail.stats.nextRelease') }}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <MonitoredFetchFailedBanner
          v-if="fetchStatus.state === 'failed'"
          class="mt-4"
          :status="fetchStatus"
          :has-catalog="hasCatalog"
          :last-refreshed-at="author.lastRefreshedAt"
          @retry="handleRefresh"
        >
          <template #retry>
            <Button v-if="canEdit" variant="outline" size="sm" @click="handleRefresh">{{ t('monitored.fetch.retryNow') }}</Button>
          </template>
        </MonitoredFetchFailedBanner>
        <section class="mt-4 rounded-xl border border-border bg-card/75 p-3 sm:p-4">
          <div ref="sentinelRef" class="h-px" aria-hidden="true" />
          <div class="sticky top-0 z-20 bg-card py-1">
            <div
              ref="barRef"
              class="@container/bar flex h-12 min-w-0 items-center gap-1 rounded-[10px] [&_input]:min-w-0 border border-border bg-card px-[7px] shadow-xs"
            >
              <div class="flex shrink-0 items-center gap-2 ps-1">
                <div v-if="pinned" class="hidden size-[26px] shrink-0 overflow-hidden rounded bg-muted sm:block">
                  <img v-if="portraitUrl && !imageFailed" :src="portraitUrl" alt="" class="size-full object-cover" />
                  <AuthorPlaceholder v-else :name="author.authorName" />
                </div>
                <span v-if="pinned" class="hidden max-w-[10rem] truncate text-[15px] font-bold lg:inline">{{ author.authorName }}</span>
                <h2 v-else class="hidden text-[15px] font-bold sm:block">{{ t('monitored.detail.booksTitle') }}</h2>
                <Tooltip v-if="hasCatalog">
                  <TooltipTrigger as-child>
                    <span tabindex="0" class="cursor-default rounded text-[12.5px] text-muted-foreground tabular-nums">{{
                      t('monitored.detail.booksCountShort', { shown: visibleWorks.length, total: catalogTotal })
                    }}</span>
                  </TooltipTrigger>
                  <TooltipContent>{{ countTooltip }}</TooltipContent>
                </Tooltip>
                <span :class="barDivider" aria-hidden="true" />
              </div>
              <BrowseSearchField
                :model-value="searchQuery"
                :placeholder="t('monitored.detail.booksSearchPlaceholder')"
                @update:model-value="setSearchQuery"
                @clear="clearSearch"
              />
              <span :class="[barDivider, 'hidden sm:block']" aria-hidden="true" />
              <BrowseSortControl
                :label="sortLabel"
                :direction="order"
                :changed="!sortIsDefault"
                popover-class="w-56 p-2"
                @toggle-direction="toggleOrder"
              >
                <MonitoredSortOptions
                  :options="sortOptions"
                  :model-value="sort"
                  :order="order"
                  @update:model-value="setSort"
                  @update:order="setOrder"
                />
              </BrowseSortControl>
              <Popover>
                <PopoverTrigger as-child>
                  <button
                    type="button"
                    :class="cn(barButton, barCompactPadding, !groupingIsDefault && barButtonOn)"
                    :aria-label="t('monitored.detail.controls.group')"
                    :title="groupingLabel"
                  >
                    <Layers :size="14" />
                    <span :class="barLabel">{{ groupingLabel }}</span>
                    <ChevronDown :size="13" :class="barChevron" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" class="w-56 p-2">
                  <MonitoredGroupOptions :options="groupOptions" :model-value="grouping" @update:model-value="setGrouping" />
                </PopoverContent>
              </Popover>
              <button
                v-if="groups.length > 1"
                type="button"
                :class="cn(barIconButton, 'hidden sm:inline-grid', allGroupsCollapsed && barButtonOn)"
                :aria-label="collapseAllLabel"
                :title="collapseAllLabel"
                @click="toggleAllGroups"
              >
                <ChevronsUpDown v-if="allGroupsCollapsed" :size="14" />
                <ChevronsDownUp v-else :size="14" />
              </button>
              <span :class="[barDivider, 'hidden sm:block']" aria-hidden="true" />
              <MonitoredFiltersMenu
                variant="bar"
                :model-value="display"
                :counts="filterCounts"
                :sections="filterSections"
                :can-curate="canEdit"
                :status-filters="statusFilters"
                @toggle-section="toggleFilterSection"
                @update:status-filters="handleStatusFiltersChange"
                @update:model-value="setDisplay"
                @reset="resetDisplay"
              />
              <button
                v-if="canEdit"
                type="button"
                :class="cn(barButton, barCompactPadding, selectionMode && barButtonOn)"
                :aria-pressed="selectionMode"
                data-testid="toggle-selection"
                @click="toggleSelectionMode"
              >
                <CheckSquare v-if="selectionMode" :size="13" aria-hidden="true" />
                <Square v-else :size="13" aria-hidden="true" />
                <span :class="barLabel">{{ selectionLabel }}</span>
                <span :class="barLabelScreenReader">{{ selectionLabel }}</span>
              </button>
              <span :class="[barDivider, 'hidden sm:block']" aria-hidden="true" />
              <Popover :open="displayOpen" @update:open="handleDisplayOpenChange">
                <PopoverTrigger as-child>
                  <button
                    type="button"
                    :class="cn(barIconButton, displayOpen && barButtonOn)"
                    :aria-label="t('components.viewHeader.display')"
                    :title="t('components.viewHeader.display')"
                    data-testid="author-display"
                  >
                    <SlidersHorizontal :size="15" aria-hidden="true" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" :side-offset="8" class="w-64 p-4">
                  <ViewHeaderDisplayControls
                    view-mode="grid"
                    :cover-size="workCardSize"
                    :grid-gap="cardGap"
                    :cover-size-min="WORK_CARD_SIZE.min"
                    :cover-size-max="WORK_CARD_SIZE.max"
                    :cover-size-step="4"
                    :grid-gap-min="CARD_GAP.min"
                    :grid-gap-max="CARD_GAP.max"
                    @update:cover-size="handleCardSizeUpdate"
                    @update:grid-gap="handleCardGapUpdate"
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <MonitoredQuickSelect
            v-if="selectionMode"
            class="mt-3"
            :works="selectableWorks"
            :selected-ids="selectedIds"
            :format="bulkFormat"
            @add="addMany"
            @keep="replaceSelection"
          />

          <div
            v-if="!loading && !error && visibleWorks.length === 0 && loadedWorks.length > 0 && !filtersAreDefault"
            class="mt-5 text-center text-sm text-muted-foreground"
            data-testid="filters-empty"
          >
            {{ t('monitored.filters.empty') }}
            <button type="button" class="ml-2 text-primary hover:underline" @click="resetDisplay">{{ t('monitored.filters.reset') }}</button>
          </div>

          <div v-if="!hasCatalog" role="status" class="mt-5 flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 v-if="fetchBusy" :size="20" class="animate-spin" aria-hidden="true" />
            {{ t(fetchBusy ? 'monitored.fetch.fetching' : 'monitored.fetch.noBooksYet') }}
          </div>
          <!-- Cards use z-30/z-40 for badges and menus, so isolate keeps them from painting over the pinned bar. -->
          <div class="isolate mt-5 space-y-6" :class="selectionMode ? 'pb-28' : ''">
            <section v-for="group in groups" :key="group.key">
              <div class="mb-3 flex items-center gap-2">
                <button
                  v-if="selectionMode"
                  type="button"
                  role="checkbox"
                  :aria-checked="groupAriaChecked(group)"
                  :aria-label="t('monitored.selection.group.selectAll', { name: groupLabel(group.key, group.label) })"
                  class="flex size-5 shrink-0 items-center justify-center rounded-xs border transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  :class="
                    groupCheckState(group) === 'none'
                      ? 'border-border bg-background hover:border-primary'
                      : 'border-primary bg-primary text-primary-foreground'
                  "
                  data-testid="group-select"
                  @click="handleGroupSelect(group)"
                >
                  <Check v-if="groupCheckState(group) === 'all'" :size="12" aria-hidden="true" />
                  <Minus v-else-if="groupCheckState(group) === 'some'" :size="12" aria-hidden="true" />
                </button>
                <h3 class="min-w-0">
                  <button
                    type="button"
                    class="flex min-w-0 items-center gap-2 rounded-md text-left transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    :aria-expanded="!isGroupCollapsed(group.key)"
                    @click="toggleGroup(group.key)"
                  >
                    <ChevronDown
                      :size="14"
                      class="shrink-0 text-muted-foreground transition-transform"
                      :class="{ '-rotate-90': isGroupCollapsed(group.key) }"
                      aria-hidden="true"
                    />
                    <span class="truncate text-xs font-semibold text-foreground">{{ groupLabel(group.key, group.label) }}</span>
                    <span
                      class="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground"
                      :data-testid="selectionMode ? 'group-progress' : undefined"
                      >{{
                        selectionMode
                          ? t('monitored.selection.group.progress', { selected: groupSelectedCount(group), total: group.works.length })
                          : group.works.length
                      }}</span
                    >
                  </button>
                </h3>
                <div class="h-px flex-1 bg-border" />
              </div>
              <MonitoredVirtualGrid
                v-if="!isGroupCollapsed(group.key)"
                :virtualized="grouping === 'none'"
                :items="group.works"
                :card-size="workCardSize"
                :grid-gap="cardGap"
              >
                <template #default="{ item: work }">
                  <MonitoredWorkCard
                    :work="work"
                    :cover-author-name="author?.authorName"
                    :ebook-queued="isQueued(work.id, 'ebook')"
                    :audiobook-queued="isQueued(work.id, 'audiobook')"
                    :series-membership="grouping === 'series' ? seriesMembershipForGroup(work, group.key) : undefined"
                    :monitored-formats="monitoredFormats"
                    :format-modes="formatModes"
                    :author-paused="author?.paused ?? false"
                    :can-manage="canEdit"
                    :selection-mode="selectionMode"
                    :selected="selectedIds.has(work.id)"
                    :long-press-select="canEdit"
                    @select="handleSelectWork"
                    @long-press="startSelectingWith"
                    @preview="handlePreview"
                    @quick-view="handleQuickView"
                    @download-ebook="handleDownloadEbook"
                    @download-audiobook="handleDownloadAudiobook"
                    @stop="handleStopWork"
                  />
                </template>
              </MonitoredVirtualGrid>
            </section>
          </div>
        </section>
      </template>
    </div>

    <MonitoredSelectionBar
      :visible="selectionMode && canEdit"
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

    <MonitorAuthorModal :open="editOpen" :result="null" :initial-formats="[]" :author="author" @close="closeEdit" @updated="handleAuthorUpdated" />

    <ConfirmDialog
      :open="confirmStopOpen"
      :title="t('monitored.detail.stopDialog.title')"
      :description="t('monitored.detail.stopDialog.description')"
      :confirm-label="t('monitored.actions.stopMonitoring')"
      @confirm="confirmStopAuthor"
      @cancel="cancelStopAuthor"
    />

    <MonitoredBookPanel
      :work="panelWork"
      :author-name="author?.authorName ?? ''"
      :monitored-formats="monitoredFormats"
      :author-id="author?.id ?? null"
      :author-genres="author?.genres"
      :link-author="false"
      :format-modes="formatModes"
      :author-paused="author?.paused ?? false"
      :can-resume-author="canEdit"
      :can-manage="canEdit"
      :checked-at="author?.lastRefreshedAt ?? null"
      :checking="checkingLibrary || fetchBusy || refreshState === 'loading'"
      :open="panelOpen"
      @update:open="handlePanelOpen"
      @request="handlePanelRequest"
      @grabbed="handlePanelGrabbed"
      @filed="handlePanelFiled"
      @toggle-monitor="handleToggleMonitor"
      @toggle-auto-download="handleToggleAutoDownload"
      @toggle-hidden="handleToggleHidden"
      @set-automatic="handleSetAutomatic"
      @set-kind="handleSetKind"
      @check-library="handleCheckLibrary"
      @resume-author="handleResumeAuthor"
      @work-updated="handleWorkUpdated"
    />
  </main>
</template>
