import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type {
  MonitorMode,
  MonitoredAuthorDetail,
  MonitoredFormat,
  MonitoredFetchStatus,
  MonitoredGrouping,
  MonitoredSort,
  MonitoredStatusFilter,
  MonitoredWork,
  MonitoredWorkPatch,
} from '@bookorbit/types'
import { useMonitoredFetchEvents } from './useMonitoredFetchEvents'
import { storage } from '@/services/storage'
import {
  fetchMonitoredAuthorDetail,
  refreshMonitoredAuthor,
  requestMonitoredWork,
  updateMonitoredAuthor,
  updateMonitoredWork,
} from '../api/monitored'
import { monitoredErrorText } from '../lib/api-error'
import { collapseEntryFor, emptyCollapseEntry, readCollapseStore, writeCollapseEntry, type MonitoredCollapseEntry } from '../lib/group-collapse'
import { readFilterSections, type MonitoredFilterSection } from '../lib/filter-sections'
import { groupWorks, sortWorks } from '../lib/grouping'
import { defaultAuthorStatusFilters, isDefaultAuthorFilters, readAuthorStatusFilters, workMatchesAuthorStatus } from '../lib/status-filter'
import { todayUtc } from '../lib/format-status'
import {
  countWorkClasses,
  DEFAULT_MONITORED_DISPLAY,
  isWorkDisplayed,
  readDisplayOptions,
  type MonitoredDisplayOptions,
} from '../lib/work-visibility'

type SortOrder = 'asc' | 'desc'

const SORT_STORAGE_KEY = 'monitored:authorDetail:sort'
const ORDER_STORAGE_KEY = 'monitored:authorDetail:order'
const GROUP_STORAGE_KEY = 'monitored:authorDetail:group'
const DISPLAY_STORAGE_KEY = 'monitored:authorDetail:display:v3'
const COLLAPSE_STORAGE_KEY = 'monitored:authorDetail:collapsed'
const STATUS_STORAGE_KEY = 'monitored:authorDetail:status:v2'
const FILTER_SECTIONS_STORAGE_KEY = 'monitored:authorDetail:filterSections:v2'

function firstQueryValue(value: unknown): string | undefined {
  return Array.isArray(value) ? value[0] : typeof value === 'string' ? value : undefined
}

function parseSort(value: unknown): MonitoredSort {
  return firstQueryValue(value) === 'title' ? 'title' : 'releaseDate'
}

function parseOrder(value: unknown): SortOrder {
  return firstQueryValue(value) === 'asc' ? 'asc' : 'desc'
}

function parseGrouping(value: unknown): MonitoredGrouping {
  const normalized = firstQueryValue(value)
  return normalized === 'none' || normalized === 'year' || normalized === 'status' ? normalized : 'series'
}

export function useMonitoredAuthorDetail() {
  const { t } = useI18n()
  const route = useRoute()
  const router = useRouter()
  const detail = ref<MonitoredAuthorDetail | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const updating = ref(false)
  const display = ref<MonitoredDisplayOptions>(readDisplayOptions(storage.get<unknown>(DISPLAY_STORAGE_KEY, null)))
  const queued = ref(new Map<string, Set<MonitoredFormat>>())
  const hiddenWorkIds = ref(new Set<string>())
  const sort = ref<MonitoredSort>(parseSort(route.query.sort ?? storage.get<string | null>(SORT_STORAGE_KEY, null)))
  const order = ref<SortOrder>(parseOrder(route.query.order ?? storage.get<string | null>(ORDER_STORAGE_KEY, null)))
  const grouping = ref<MonitoredGrouping>(parseGrouping(route.query.group ?? storage.get<string | null>(GROUP_STORAGE_KEY, null)))
  const collapse = ref<MonitoredCollapseEntry>(emptyCollapseEntry())
  const statusFilters = ref<MonitoredStatusFilter[]>(readAuthorStatusFilters(storage.get<unknown>(STATUS_STORAGE_KEY, null)))

  const filterSections = ref(readFilterSections(storage.get<unknown>(FILTER_SECTIONS_STORAGE_KEY, null)))
  function toggleFilterSection(key: MonitoredFilterSection) {
    filterSections.value = { ...filterSections.value, [key]: !filterSections.value[key] }
    storage.set(FILTER_SECTIONS_STORAGE_KEY, filterSections.value)
  }

  const authorId = ref(String(route.params.id ?? ''))
  const monitoredFormats = computed<MonitoredFormat[]>(() => {
    const formats = detail.value?.author.formats
    if (!formats) return ['ebook', 'audiobook']
    return (Object.keys(formats) as MonitoredFormat[]).filter((format) => formats[format]?.mode !== 'off')
  })
  const formatModes = computed<Partial<Record<MonitoredFormat, MonitorMode>>>(() => {
    const formats = detail.value?.author.formats
    if (!formats) return {}
    return Object.fromEntries((Object.keys(formats) as MonitoredFormat[]).map((format) => [format, formats[format].mode]))
  })
  // Collapsed sections are remembered per author, so returning to one finds the catalog as it was
  // left and a sibling author is untouched by it.
  watch(
    authorId,
    (id) => {
      collapse.value = collapseEntryFor(readCollapseStore(storage.get<unknown>(COLLAPSE_STORAGE_KEY, null)), id)
    },
    { immediate: true },
  )
  const loadedWorks = computed(() => detail.value?.works ?? [])
  const filterCounts = computed(() => countWorkClasses(loadedWorks.value))
  const visibleWorks = computed(() => {
    const today = todayUtc()
    return loadedWorks.value.filter(
      (work) =>
        (display.value.hidden || !hiddenWorkIds.value.has(work.id)) &&
        isWorkDisplayed(work, display.value) &&
        workMatchesAuthorStatus(work, statusFilters.value, formatModes.value, today),
    )
  })
  const sortedWorks = computed(() => sortWorks(visibleWorks.value, sort.value, order.value))
  const groups = computed(() => groupWorks(sortedWorks.value, grouping.value, order.value, sort.value))
  const allGroupsCollapsed = computed(() => groups.value.length > 0 && groups.value.every((group) => isGroupCollapsed(group.key)))
  const filtersAreDefault = computed(() => isDefaultAuthorFilters(display.value, statusFilters.value))

  function syncRouteQuery() {
    void router.replace({
      name: 'monitored-author',
      params: { id: authorId.value },
      query: {
        ...route.query,
        sort: sort.value === 'releaseDate' ? undefined : sort.value,
        order: order.value === 'desc' ? undefined : order.value,
        group: grouping.value === 'series' ? undefined : grouping.value,
      },
    })
  }

  let loadSequence = 0
  const fetchStatus = computed<MonitoredFetchStatus>(
    () => detail.value?.author.fetch ?? { state: 'idle', errorKind: null, errorAt: null, retryAt: null },
  )
  useMonitoredFetchEvents({
    onItem(item) {
      if (item.id !== authorId.value) return
      loadSequence += 1
      loading.value = false
      if (detail.value) detail.value.author = item
      if (!detail.value || item.fetch.state === 'idle') void load()
    },
    onReconnect() {
      if (fetchStatus.value.state !== 'idle') void load()
    },
  })

  async function load(): Promise<void> {
    if (!authorId.value) return
    const sequence = ++loadSequence
    loading.value = true
    error.value = null
    try {
      const loaded = await fetchMonitoredAuthorDetail(authorId.value, {
        sort: sort.value,
        order: order.value,
        // Every class is fetched every time so the Filters menu can state its counts the moment it
        // opens. The withheld classes measured 13-59 kB of extra text on the largest catalogs here.
        includeHidden: true,
      })
      if (sequence === loadSequence) {
        detail.value = loaded
        hiddenWorkIds.value = new Set()
      }
    } catch (cause) {
      if (sequence === loadSequence) error.value = monitoredErrorText(cause, t('monitored.errors.loadAuthor'))
    } finally {
      if (sequence === loadSequence) loading.value = false
    }
  }

  async function refreshAuthor(): Promise<void> {
    if (!authorId.value) return
    const sequence = loadSequence
    const item = await refreshMonitoredAuthor(authorId.value)
    if (sequence === loadSequence && detail.value && item.id === authorId.value) detail.value.author = item
  }

  function setSort(value: MonitoredSort) {
    if (sort.value === value) return
    sort.value = value
    storage.set(SORT_STORAGE_KEY, value)
    syncRouteQuery()
  }

  function setOrder(value: SortOrder) {
    if (order.value === value) return
    order.value = value
    storage.set(ORDER_STORAGE_KEY, value)
    syncRouteQuery()
  }

  /**
   * The same name means different things under another grouping, and a section named like a year or
   * a status would otherwise inherit that section's state, so each grouping keeps its own record.
   */
  function groupCollapseKey(key: string): string {
    return `${grouping.value}:${key}`
  }

  // Read as a boolean rather than for absence: series names are provider data, and one matching a
  // member of the record's prototype would otherwise read as permanently collapsed.
  function isGroupCollapsed(key: string): boolean {
    const stored = collapse.value.groups[groupCollapseKey(key)]
    return typeof stored === 'boolean' ? stored : collapse.value.all
  }

  /**
   * Several author pages stay mounted at once, so the record is reread on the way out rather than
   * held: a copy taken when this page opened would write back over whatever the others have since
   * remembered.
   */
  function persistCollapse(entry: MonitoredCollapseEntry): void {
    collapse.value = entry
    const stored = readCollapseStore(storage.get<unknown>(COLLAPSE_STORAGE_KEY, null))
    storage.set(COLLAPSE_STORAGE_KEY, writeCollapseEntry(stored, authorId.value, entry))
  }

  function toggleGroup(key: string): void {
    const collapsed = !isGroupCollapsed(key)
    const stored = groupCollapseKey(key)
    // A section back in step with the collapse-all state has nothing left worth remembering.
    if (collapsed === collapse.value.all) {
      const groups = { ...collapse.value.groups }
      delete groups[stored]
      persistCollapse({ all: collapse.value.all, groups })
      return
    }
    persistCollapse({ all: collapse.value.all, groups: { ...collapse.value.groups, [stored]: collapsed } })
  }

  function setAllGroupsCollapsed(collapsed: boolean): void {
    persistCollapse({ all: collapsed, groups: {} })
  }

  function toggleAllGroups(): void {
    setAllGroupsCollapsed(!allGroupsCollapsed.value)
  }

  function setGrouping(value: MonitoredGrouping) {
    grouping.value = value
    storage.set(GROUP_STORAGE_KEY, value)
    syncRouteQuery()
  }

  function setDisplay(value: MonitoredDisplayOptions): void {
    display.value = value
    storage.set(DISPLAY_STORAGE_KEY, value)
  }

  function resetDisplay(): void {
    setDisplay({ ...DEFAULT_MONITORED_DISPLAY })
    setStatusFilters(defaultAuthorStatusFilters())
  }

  function setStatusFilters(value: MonitoredStatusFilter[]): void {
    statusFilters.value = value
    storage.set(STATUS_STORAGE_KEY, value)
  }

  async function setPaused(paused: boolean): Promise<void> {
    if (!detail.value || updating.value) return
    const previous = detail.value.author.paused
    detail.value.author.paused = paused
    updating.value = true
    try {
      detail.value.author = await updateMonitoredAuthor(authorId.value, { paused })
    } catch (cause) {
      detail.value.author.paused = previous
      throw cause
    } finally {
      updating.value = false
    }
  }

  function forgetOptimisticQueue(workId: string, format: MonitoredFormat): void {
    const next = new Map(queued.value)
    const formats = new Set(next.get(workId) ?? [])
    formats.delete(format)
    if (formats.size === 0) next.delete(workId)
    else next.set(workId, formats)
    queued.value = next
  }

  async function queueWork(workId: string, format: MonitoredFormat, autoDownload?: boolean): Promise<number | null> {
    const current = new Map(queued.value)
    current.set(workId, new Set([...(current.get(workId) ?? []), format]))
    queued.value = current
    try {
      const updated = await requestMonitoredWork(workId, {
        format,
        ...(autoDownload !== undefined ? { autoDownload } : {}),
      })
      const works = detail.value?.works
      const index = works?.findIndex((candidate) => candidate.id === workId) ?? -1
      // The optimistic mark is only safe to drop once the server's own state is on the work in its
      // place. A work the list no longer holds has nothing to read that state from, so it keeps it.
      if (works && index >= 0) {
        works.splice(index, 1, updated)
        forgetOptimisticQueue(workId, format)
      }
      return updated.requestIds[format] ?? null
    } catch (cause) {
      forgetOptimisticQueue(workId, format)
      throw cause
    }
  }

  /**
   * A release grabbed from the panel already has its book request, so the card behind it flips to
   * queued without a round trip. The server status replaces this optimistic state on the next read.
   */
  function markQueued(workId: string, format: MonitoredFormat, requestId: number): void {
    const work = detail.value?.works.find((candidate) => candidate.id === workId)
    if (work) {
      work.requestIds = { ...work.requestIds, [format]: requestId }
      work.requestStatuses = { ...work.requestStatuses, [format]: 'grabbed' }
    }
  }

  function isQueued(workId: string, format?: MonitoredFormat): boolean {
    const formats = queued.value.get(workId)
    return format ? Boolean(formats?.has(format)) : Boolean(formats?.size)
  }

  /**
   * One work, one object. A work the server has already answered with replaces the one every list
   * renders from, so the cards and the open panel cannot drift apart before the next refetch.
   */
  function applyWorkUpdate(updated: MonitoredWork): void {
    const works = detail.value?.works
    const index = works?.findIndex((candidate) => candidate.id === updated.id) ?? -1
    if (works && index >= 0) works.splice(index, 1, updated)
  }

  /**
   * While the Hidden filter is off, hiding takes a work off the page the moment the server confirms it,
   * instead of leaving it dimmed until the next refetch. An unhide or a return to the automatic verdict
   * brings it straight back.
   */
  function recordVisibilityChange(workIds: string[], patch: MonitoredWorkPatch): void {
    if (patch.hidden === undefined && !patch.automaticVisibility) return
    const next = new Set(hiddenWorkIds.value)
    for (const workId of workIds) {
      if (patch.hidden) next.add(workId)
      else next.delete(workId)
    }
    hiddenWorkIds.value = next
  }

  /** Persist per-work monitor/hide toggles and reflect them in the loaded detail. */
  async function updateWork(workId: string, patch: MonitoredWorkPatch): Promise<void> {
    const works = detail.value?.works
    const index = works?.findIndex((candidate) => candidate.id === workId) ?? -1
    if (!works || index < 0) return
    const updated = await updateMonitoredWork(workId, patch)
    works.splice(index, 1, updated)
    recordVisibilityChange([workId], patch)
  }

  return {
    detail,
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
  }
}
