import { computed, getCurrentInstance, onActivated, onDeactivated, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  MonitoredAuthorItem,
  MonitoredAuthorListSort,
  MonitoredBookItem,
  MonitoredBookListSort,
  MonitoredListOrder,
  MonitoredReleaseFilter,
  MonitoredReleaseItem,
  MonitoredReleaseListSort,
  MonitoredSummary,
} from '@bookorbit/types'
import { fetchMonitoredAuthors, fetchMonitoredBooks, fetchMonitoredReleases, fetchMonitoredSummary } from '../api/monitored'
import { appendUnique } from '../lib/append-unique'
import { monitoredErrorText } from '../lib/api-error'
import { appendBoundedPage, type RetainedPage } from '../lib/bounded-page-retention'

export const MONITORED_TABS = ['authors', 'books', 'releases', 'add'] as const
export type MonitoredTab = (typeof MONITORED_TABS)[number]

/** Grouping has to survive pagination: author buckets would reshuffle as later pages arrive. */
export const MONITORED_RELEASE_GROUPS = ['status', 'none'] as const
export type MonitoredReleaseGroup = (typeof MONITORED_RELEASE_GROUPS)[number]

const EMPTY_SUMMARY: MonitoredSummary = { authors: 0, books: 0, releases: 0 }
const PAGE_SIZE = 50
export const MONITORED_MAX_RETAINED_ITEMS = 1500
export const MONITORED_IDLE_TRIM_MS = 10 * 60 * 1000

export function useMonitored() {
  const { t } = useI18n()
  const summary = ref<MonitoredSummary>({ ...EMPTY_SUMMARY })
  const authors = ref<MonitoredAuthorItem[]>([])
  const books = ref<MonitoredBookItem[]>([])
  const releases = ref<MonitoredReleaseItem[]>([])
  const authorTotal = ref(0)
  const bookTotal = ref(0)
  const releaseTotal = ref(0)
  const authorPage = ref(0)
  const bookPage = ref(0)
  const releasePage = ref(0)
  const authorDroppedOffset = ref(0)
  const bookDroppedOffset = ref(0)
  const releaseDroppedOffset = ref(0)
  const idleTrimmed = ref(false)
  const authorLoading = ref(false)
  const bookLoading = ref(false)
  const releaseLoading = ref(false)
  const summaryLoading = ref(false)
  const error = ref<string | null>(null)
  let authorToken = 0
  let bookToken = 0
  let releaseToken = 0
  let authorPages: RetainedPage<MonitoredAuthorItem>[] = []
  let bookPages: RetainedPage<MonitoredBookItem>[] = []
  let releasePages: RetainedPage<MonitoredReleaseItem>[] = []
  let authorFirstPage: MonitoredAuthorItem[] = []
  let bookFirstPage: MonitoredBookItem[] = []
  let releaseFirstPage: MonitoredReleaseItem[] = []
  let idleTrimTimer: ReturnType<typeof setTimeout> | null = null

  // A reset refetch keeps the current page rendered until the new one lands; blanking the list
  // first turns every search keystroke into an empty-state flash.
  const counts = computed<Record<Exclude<MonitoredTab, 'add'>, number>>(() => ({
    authors: summary.value.authors,
    books: summary.value.books,
    releases: summary.value.releases,
  }))
  const authorHasMore = computed(() => authorPage.value * PAGE_SIZE < authorTotal.value)
  const bookHasMore = computed(() => bookPage.value * PAGE_SIZE < bookTotal.value)
  const releaseHasMore = computed(() => releasePage.value * PAGE_SIZE < releaseTotal.value)

  function cancelIdleTrim(): void {
    if (idleTrimTimer === null) return
    clearTimeout(idleTrimTimer)
    idleTrimTimer = null
  }

  function trimToFirstPages(): void {
    authorToken += 1
    bookToken += 1
    releaseToken += 1
    authorLoading.value = false
    bookLoading.value = false
    releaseLoading.value = false
    authors.value = [...authorFirstPage]
    books.value = [...bookFirstPage]
    releases.value = [...releaseFirstPage]
    authorPages = authorFirstPage.length ? [{ page: 0, items: [...authorFirstPage] }] : []
    bookPages = bookFirstPage.length ? [{ page: 0, items: [...bookFirstPage] }] : []
    releasePages = releaseFirstPage.length ? [{ page: 0, items: [...releaseFirstPage] }] : []
    authorPage.value = authorFirstPage.length ? 1 : 0
    bookPage.value = bookFirstPage.length ? 1 : 0
    releasePage.value = releaseFirstPage.length ? 1 : 0
    authorDroppedOffset.value = 0
    bookDroppedOffset.value = 0
    releaseDroppedOffset.value = 0
    idleTrimmed.value = true
    idleTrimTimer = null
  }

  function scheduleIdleTrim(): void {
    cancelIdleTrim()
    idleTrimTimer = setTimeout(trimToFirstPages, MONITORED_IDLE_TRIM_MS)
  }

  if (getCurrentInstance()) {
    onActivated(cancelIdleTrim)
    onDeactivated(scheduleIdleTrim)
    onUnmounted(cancelIdleTrim)
  }

  async function loadSummary(): Promise<void> {
    summaryLoading.value = true
    error.value = null
    try {
      summary.value = await fetchMonitoredSummary()
    } catch (cause) {
      error.value = monitoredErrorText(cause, t('monitored.errors.load'))
    } finally {
      summaryLoading.value = false
    }
  }

  async function loadAuthors(options: { q?: string; sort: MonitoredAuthorListSort; order: MonitoredListOrder }, reset = false): Promise<void> {
    if (!reset && (authorLoading.value || !authorHasMore.value)) return
    const token = ++authorToken
    const requestPage = reset ? 0 : authorPage.value
    authorLoading.value = true
    error.value = null
    try {
      const result = await fetchMonitoredAuthors({ ...options, page: requestPage, size: PAGE_SIZE })
      if (token !== authorToken) return
      if (reset) {
        const items = appendUnique([], result.items, (item) => item.id)
        authorFirstPage = [...items]
        authorPages = [{ page: result.page, items }]
        authors.value = items
        authorDroppedOffset.value = 0
      } else {
        const retained = appendBoundedPage(
          authorPages,
          { page: result.page, items: result.items },
          PAGE_SIZE,
          MONITORED_MAX_RETAINED_ITEMS,
          (item) => item.id,
        )
        authorPages = retained.pages
        authors.value = retained.items
        authorDroppedOffset.value = retained.droppedOffset
      }
      authorTotal.value = result.total
      authorPage.value = requestPage + 1
    } catch (cause) {
      if (token === authorToken) error.value = monitoredErrorText(cause, t('monitored.errors.load'))
    } finally {
      if (token === authorToken) authorLoading.value = false
    }
  }

  async function loadBooks(options: { q?: string; sort: MonitoredBookListSort; order: MonitoredListOrder }, reset = false): Promise<void> {
    if (!reset && (bookLoading.value || !bookHasMore.value)) return
    const token = ++bookToken
    const requestPage = reset ? 0 : bookPage.value
    bookLoading.value = true
    error.value = null
    try {
      const result = await fetchMonitoredBooks({ ...options, page: requestPage, size: PAGE_SIZE })
      if (token !== bookToken) return
      if (reset) {
        const items = appendUnique([], result.items, (item) => item.id)
        bookFirstPage = [...items]
        bookPages = [{ page: result.page, items }]
        books.value = items
        bookDroppedOffset.value = 0
      } else {
        const retained = appendBoundedPage(
          bookPages,
          { page: result.page, items: result.items },
          PAGE_SIZE,
          MONITORED_MAX_RETAINED_ITEMS,
          (item) => item.id,
        )
        bookPages = retained.pages
        books.value = retained.items
        bookDroppedOffset.value = retained.droppedOffset
      }
      bookTotal.value = result.total
      bookPage.value = requestPage + 1
    } catch (cause) {
      if (token === bookToken) error.value = monitoredErrorText(cause, t('monitored.errors.load'))
    } finally {
      if (token === bookToken) bookLoading.value = false
    }
  }

  async function loadReleases(
    options: { q?: string; sort: MonitoredReleaseListSort; order: MonitoredListOrder; filter: MonitoredReleaseFilter },
    reset = false,
  ): Promise<void> {
    if (!reset && (releaseLoading.value || !releaseHasMore.value)) return
    const token = ++releaseToken
    const requestPage = reset ? 0 : releasePage.value
    releaseLoading.value = true
    error.value = null
    try {
      const result = await fetchMonitoredReleases({ ...options, page: requestPage, size: PAGE_SIZE })
      if (token !== releaseToken) return
      if (reset) {
        const items = appendUnique([], result.items, (item) => `${item.workId}:${item.format}`)
        releaseFirstPage = [...items]
        releasePages = [{ page: result.page, items }]
        releases.value = items
        releaseDroppedOffset.value = 0
      } else {
        const retained = appendBoundedPage(
          releasePages,
          { page: result.page, items: result.items },
          PAGE_SIZE,
          MONITORED_MAX_RETAINED_ITEMS,
          (item) => `${item.workId}:${item.format}`,
        )
        releasePages = retained.pages
        releases.value = retained.items
        releaseDroppedOffset.value = retained.droppedOffset
      }
      releaseTotal.value = result.total
      releasePage.value = requestPage + 1
    } catch (cause) {
      if (token === releaseToken) error.value = monitoredErrorText(cause, t('monitored.errors.load'))
    } finally {
      if (token === releaseToken) releaseLoading.value = false
    }
  }

  return {
    authors,
    books,
    releases,
    authorTotal,
    bookTotal,
    releaseTotal,
    authorDroppedOffset,
    bookDroppedOffset,
    releaseDroppedOffset,
    idleTrimmed,
    authorLoading,
    bookLoading,
    releaseLoading,
    summaryLoading,
    authorHasMore,
    bookHasMore,
    releaseHasMore,
    counts,
    error,
    loadSummary,
    loadAuthors,
    loadBooks,
    loadReleases,
    trimToFirstPages,
  }
}
