import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { MONITORED_WORK_SEARCH_PAGE_SIZE, type MonitoredWork, type MonitoredWorkSearchItem } from '@bookorbit/types'
import { searchMonitoredWorks } from '../api/monitored'
import { appendBoundedPage, type RetainedPage } from '../lib/bounded-page-retention'
import { MONITORED_MAX_RETAINED_ITEMS } from './useMonitored'
import { isSearchReady } from '../lib/search-query'
import { monitoredErrorText } from '../lib/api-error'

const PAGE_SIZE = MONITORED_WORK_SEARCH_PAGE_SIZE

export function useMonitoredWorkSearch() {
  const { t } = useI18n()
  const items = ref<MonitoredWorkSearchItem[]>([])
  const total = ref(0)
  const page = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const hasMore = computed(() => page.value * PAGE_SIZE < total.value)
  let generation = 0
  let itemsQuery = ''
  let pages: RetainedPage<MonitoredWorkSearchItem>[] = []
  const droppedOffset = ref(0)

  function clearItems() {
    items.value = []
    total.value = 0
    page.value = 0
    droppedOffset.value = 0
    pages = []
  }

  function invalidate(q = itemsQuery) {
    q = q.trim()
    if (q !== itemsQuery) {
      clearItems()
      itemsQuery = q
    }
    generation += 1
    loading.value = false
    error.value = null
  }

  async function load(q: string, reset = false): Promise<void> {
    q = q.trim()
    if (!isSearchReady(q)) {
      invalidate(q)
      return
    }
    if (!reset && (loading.value || !hasMore.value)) return
    if (reset && q !== itemsQuery) clearItems()
    itemsQuery = q
    const token = ++generation
    const requestPage = reset ? 0 : page.value
    loading.value = true
    error.value = null
    try {
      const result = await searchMonitoredWorks({ q, page: requestPage, size: PAGE_SIZE })
      if (token !== generation) return
      const retained = appendBoundedPage(
        reset ? [] : pages,
        { page: requestPage, items: result.items },
        PAGE_SIZE,
        MONITORED_MAX_RETAINED_ITEMS,
        (item) => item.work.id,
      )
      pages = retained.pages
      items.value = retained.items
      droppedOffset.value = retained.droppedOffset
      total.value = result.total
      page.value = requestPage + 1
    } catch (cause) {
      if (token === generation) {
        if (reset) clearItems()
        error.value = monitoredErrorText(cause, t('monitored.errors.load'))
      }
    } finally {
      if (token === generation) loading.value = false
    }
  }

  function applyWorkUpdate(work: MonitoredWork) {
    pages = pages.map((entry) => ({ ...entry, items: entry.items.map((item) => (item.work.id === work.id ? { ...item, work } : item)) }))
    items.value = pages.flatMap((entry) => entry.items)
  }

  function removeWork(id: string) {
    if (!items.value.some((item) => item.work.id === id)) return
    pages = pages.map((entry) => ({ ...entry, items: entry.items.filter((item) => item.work.id !== id) }))
    items.value = pages.flatMap((entry) => entry.items)
    total.value = Math.max(0, total.value - 1)
  }

  return { droppedOffset, removeWork, items, total, page, loading, error, hasMore, load, invalidate, applyWorkUpdate }
}
