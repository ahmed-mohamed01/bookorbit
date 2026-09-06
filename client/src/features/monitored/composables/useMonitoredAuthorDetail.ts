import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import type {
  MonitoredAuthorDetail,
  MonitoredBookEntry,
  MonitoredFormat,
  MonitoredGrouping,
  MonitoredSort,
  MonitoredWork,
  MonitoredWorkPatch,
} from '@bookorbit/types'
import { storage } from '@/services/storage'
import {
  createMonitoredBook,
  fetchMonitoredAuthorDetail,
  fetchMonitoredBooks,
  requestMonitoredWork,
  updateMonitoredAuthor,
  updateMonitoredWork,
} from '../api/monitored'
import { monitoredErrorText } from '../lib/api-error'
import { groupWorks, sortWorks } from '../lib/grouping'
import { isMonitoredBookForWork, notifyMonitoredBookCreated } from '../lib/monitored-book-state'
import { MONITORED_MAX_RETAINED_ITEMS } from './useMonitored'

const BOOK_MEMBERSHIP_PAGE_SIZE = 200

type SortOrder = 'asc' | 'desc'

const SORT_STORAGE_KEY = 'monitored:authorDetail:sort'
const ORDER_STORAGE_KEY = 'monitored:authorDetail:order'
const GROUP_STORAGE_KEY = 'monitored:authorDetail:group'

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
  const showReview = ref(false)
  const queued = ref(new Map<string, Set<MonitoredFormat>>())
  const hiddenWorkIds = ref(new Set<string>())
  const bookEntries = ref<MonitoredBookEntry[]>([])
  const monitoringWorkIds = ref(new Set<string>())
  const sort = ref<MonitoredSort>(parseSort(route.query.sort ?? storage.get<string | null>(SORT_STORAGE_KEY, null)))
  const order = ref<SortOrder>(parseOrder(route.query.order ?? storage.get<string | null>(ORDER_STORAGE_KEY, null)))
  const grouping = ref<MonitoredGrouping>(parseGrouping(route.query.group ?? storage.get<string | null>(GROUP_STORAGE_KEY, null)))

  const authorId = computed(() => String(route.params.id ?? ''))
  const reviewCount = computed(() => detail.value?.author.counts.hidden ?? 0)
  const visibleWorks = computed(() => detail.value?.works.filter((work) => !hiddenWorkIds.value.has(work.id)) ?? [])
  const sortedWorks = computed(() => sortWorks(visibleWorks.value, sort.value, order.value))
  const groups = computed(() => groupWorks(sortedWorks.value, grouping.value, order.value, sort.value))
  const monitoredFormats = computed<MonitoredFormat[]>(() => {
    const formats = detail.value?.author.formats
    if (!formats) return ['ebook', 'audiobook']
    return (Object.keys(formats) as MonitoredFormat[]).filter((format) => formats[format]?.mode !== 'off')
  })

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

  async function load(): Promise<void> {
    if (!authorId.value) return
    loading.value = true
    error.value = null
    try {
      const loaded = await fetchMonitoredAuthorDetail(authorId.value, {
        sort: sort.value,
        order: order.value,
        includeHidden: showReview.value,
      })
      detail.value = loaded
    } catch (cause) {
      error.value = monitoredErrorText(cause, t('monitored.errors.loadAuthor'))
    } finally {
      loading.value = false
    }
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

  function setGrouping(value: MonitoredGrouping) {
    grouping.value = value
    storage.set(GROUP_STORAGE_KEY, value)
    syncRouteQuery()
  }

  async function toggleReview(): Promise<void> {
    showReview.value = !showReview.value
    await load()
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
   * There is no server-side filter for "books individually monitored under this author", so this
   * scans the owner's whole books list once per page load, capped the same as the Books tab itself
   * so a large monitored-books collection cannot balloon this check into an unbounded fetch.
   */
  async function loadMonitoredBooks(): Promise<void> {
    const collected: MonitoredBookEntry[] = []
    let page = 0
    try {
      for (;;) {
        const result = await fetchMonitoredBooks({ page, size: BOOK_MEMBERSHIP_PAGE_SIZE, sort: 'added', order: 'desc' })
        collected.push(...result.items)
        page += 1
        if (result.items.length === 0 || collected.length >= result.total || collected.length >= MONITORED_MAX_RETAINED_ITEMS) break
      }
      bookEntries.value = collected
    } catch {
      // Best-effort: a failed membership scan just leaves "already monitored" state stale, not the page.
    }
  }

  function isBookMonitored(workId: string): boolean {
    return isMonitoredBookForWork(bookEntries.value, authorId.value, workId)
  }

  function isMonitoringBook(workId: string): boolean {
    return monitoringWorkIds.value.has(workId)
  }

  async function monitorBook(work: MonitoredWork): Promise<void> {
    if (isBookMonitored(work.id) || isMonitoringBook(work.id)) return
    const formats = monitoredFormats.value
    if (formats.length === 0) return
    const next = new Set(monitoringWorkIds.value)
    next.add(work.id)
    monitoringWorkIds.value = next
    try {
      const created = await createMonitoredBook({ monitorAuthorId: authorId.value, workId: work.id, formats })
      bookEntries.value = [...bookEntries.value, created]
      notifyMonitoredBookCreated()
    } finally {
      const reverted = new Set(monitoringWorkIds.value)
      reverted.delete(work.id)
      monitoringWorkIds.value = reverted
    }
  }

  /** Persist per-work monitor/hide toggles and reflect them in the loaded detail. */
  async function updateWork(workId: string, patch: MonitoredWorkPatch): Promise<void> {
    const works = detail.value?.works
    const index = works?.findIndex((candidate) => candidate.id === workId) ?? -1
    if (!works || index < 0) return
    const updated = await updateMonitoredWork(workId, patch)
    works.splice(index, 1, updated)
    if (patch.hidden !== undefined) {
      const next = new Set(hiddenWorkIds.value)
      if (patch.hidden) next.add(workId)
      else next.delete(workId)
      hiddenWorkIds.value = next
    }
  }

  return {
    detail,
    loading,
    error,
    updating,
    sort,
    order,
    grouping,
    groups,
    visibleWorks,
    showReview,
    reviewCount,
    monitoredFormats,
    load,
    setSort,
    setOrder,
    setGrouping,
    toggleReview,
    setPaused,
    queueWork,
    markQueued,
    isQueued,
    updateWork,
    loadMonitoredBooks,
    isBookMonitored,
    isMonitoringBook,
    monitorBook,
  }
}
