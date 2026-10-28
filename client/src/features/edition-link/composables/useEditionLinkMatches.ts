import { computed, onActivated, onDeactivated, onUnmounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { useI18n } from 'vue-i18n'
import type {
  EditionLinkMatch,
  EditionLinkMatchBucket,
  EditionLinkMatchDismissal,
  EditionLinkScanStatus,
  LinkAllStrongResult,
} from '@bookorbit/types'

import {
  dismissMatch,
  getActiveMatchScan,
  getMatchDismissals,
  getMatches,
  linkAllStrongMatches,
  linkMatch,
  restoreMatchDismissal,
  startMatchScan,
  unlinkEditionBook,
} from '../api/work'

const POLL_INTERVAL_MS = 2000
export const MATCH_PAGE_SIZE = 50

export type EditionLinkFilter = 'fix' | 'review' | 'ready' | 'linked'

export const FILTER_BUCKETS: Record<EditionLinkFilter, EditionLinkMatchBucket[]> = {
  fix: ['linked_suspect', 'conflict'],
  review: ['weak'],
  ready: ['strong'],
  linked: ['linked_ok'],
}

export function filterCount(status: EditionLinkScanStatus | null, filter: EditionLinkFilter): number {
  if (!status) return 0
  return FILTER_BUCKETS[filter].reduce((sum, bucket) => sum + (status.counts[bucket] ?? 0), 0)
}

export function useEditionLinkMatches() {
  const { t } = useI18n()
  const scan = ref<EditionLinkScanStatus | null>(null)
  const matches = ref<EditionLinkMatch[]>([])
  const total = ref(0)
  const page = ref(1)
  const filter = ref<EditionLinkFilter | undefined>()
  const libraryId = ref<number | undefined>()
  const expandedIds = ref(new Set<number>())
  const busyIds = ref(new Set<number>())
  const dismissals = ref<EditionLinkMatchDismissal[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const linkingAll = ref(false)
  const error = ref<string | null>(null)
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let active = true
  let disposed = false
  let requestId = 0

  const scanning = computed(() => scan.value?.state === 'running')
  const scanFinished = computed(() => scan.value?.state === 'done')
  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / MATCH_PAGE_SIZE)))

  onActivated(() => {
    active = true
    if (scanning.value) schedulePoll()
  })
  onDeactivated(() => {
    active = false
    stopPolling()
  })
  onUnmounted(() => {
    disposed = true
    stopPolling()
  })

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  function schedulePoll(): void {
    stopPolling()
    if (!active || disposed) return
    pollTimer = setTimeout(pollScan, POLL_INTERVAL_MS)
  }

  async function pollScan(): Promise<void> {
    try {
      const next = await getActiveMatchScan()
      if (disposed) return
      scan.value = next
      error.value = null
      if (next.state === 'running') {
        schedulePoll()
        return
      }
      if (next.state === 'failed') error.value = t('tools.editionLinks.errors.scan')
      else if (next.state === 'done') await fetchMatches()
    } catch {
      error.value = t('tools.editionLinks.errors.status')
      schedulePoll()
    }
  }

  async function resumeScan(): Promise<void> {
    loading.value = true
    try {
      const status = await getActiveMatchScan()
      if (disposed) return
      scan.value = status
      error.value = null
      if (status.state === 'running') schedulePoll()
      else if (status.state === 'done') await fetchMatches()
    } catch {
      error.value = t('tools.editionLinks.errors.status')
    } finally {
      loading.value = false
    }
  }

  async function startScan(nextLibraryId: number | undefined): Promise<void> {
    stopPolling()
    requestId += 1
    loading.value = true
    error.value = null
    matches.value = []
    total.value = 0
    page.value = 1
    loaded.value = false
    expandedIds.value = new Set()
    libraryId.value = nextLibraryId
    try {
      scan.value = await startMatchScan()
      schedulePoll()
    } catch {
      error.value = t('tools.editionLinks.errors.start')
    } finally {
      loading.value = false
    }
  }

  async function fetchMatches(): Promise<void> {
    if (!scan.value || scan.value.state !== 'done') return
    const current = ++requestId
    loading.value = true
    error.value = null
    try {
      const response = await getMatches({
        page: page.value,
        pageSize: MATCH_PAGE_SIZE,
        buckets: filter.value ? FILTER_BUCKETS[filter.value] : undefined,
        libraryId: libraryId.value,
      })
      if (current !== requestId || disposed) return
      matches.value = response.items
      total.value = response.total
      page.value = response.page
      loaded.value = true
    } catch {
      error.value = t('tools.editionLinks.errors.results')
    } finally {
      if (current === requestId) loading.value = false
    }
  }

  async function refreshAfterWrite(): Promise<void> {
    try {
      scan.value = await getActiveMatchScan()
    } catch {
      // The counts catch up on the next scan; the ledger below is what matters now.
    }
    await fetchMatches()
  }

  async function setFilter(next: EditionLinkFilter | undefined): Promise<void> {
    filter.value = next
    page.value = 1
    await fetchMatches()
  }

  async function setLibrary(next: number | undefined): Promise<void> {
    libraryId.value = next
    page.value = 1
    await fetchMatches()
  }

  async function setPage(next: number): Promise<void> {
    page.value = Math.min(Math.max(1, next), totalPages.value)
    await fetchMatches()
  }

  function toggleExpanded(id: number): void {
    const next = new Set(expandedIds.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    expandedIds.value = next
  }

  async function runForMatch(matchId: number, action: () => Promise<void>, failure: string): Promise<boolean> {
    busyIds.value = new Set(busyIds.value).add(matchId)
    try {
      await action()
      await refreshAfterWrite()
      return true
    } catch {
      toast.error(failure)
      return false
    } finally {
      const next = new Set(busyIds.value)
      next.delete(matchId)
      busyIds.value = next
    }
  }

  function link(match: EditionLinkMatch): Promise<boolean> {
    return runForMatch(match.id, () => linkMatch(match.id), t('tools.editionLinks.errors.link'))
  }

  function dismiss(match: EditionLinkMatch): Promise<boolean> {
    return runForMatch(
      match.id,
      async () => {
        await dismissMatch(match.id)
        await fetchDismissals()
      },
      t('tools.editionLinks.errors.dismiss'),
    )
  }

  function unlink(match: EditionLinkMatch): Promise<boolean> {
    return runForMatch(match.id, () => unlinkEditionBook(match.source.id), t('tools.editionLinks.errors.unlink'))
  }

  async function linkAllStrong(): Promise<LinkAllStrongResult | null> {
    linkingAll.value = true
    try {
      const result = await linkAllStrongMatches()
      await refreshAfterWrite()
      return result
    } catch {
      toast.error(t('tools.editionLinks.errors.linkAll'))
      return null
    } finally {
      linkingAll.value = false
    }
  }

  async function fetchDismissals(): Promise<void> {
    try {
      dismissals.value = await getMatchDismissals()
    } catch {
      dismissals.value = []
    }
  }

  async function restoreDismissal(bookIdA: number, bookIdB: number): Promise<void> {
    try {
      await restoreMatchDismissal(bookIdA, bookIdB)
      await fetchDismissals()
      await refreshAfterWrite()
    } catch {
      toast.error(t('tools.editionLinks.errors.restore'))
    }
  }

  return {
    scan,
    matches,
    total,
    page,
    filter,
    libraryId,
    expandedIds,
    busyIds,
    dismissals,
    loading,
    loaded,
    linkingAll,
    error,
    scanning,
    scanFinished,
    totalPages,
    resumeScan,
    startScan,
    fetchMatches,
    setFilter,
    setLibrary,
    setPage,
    toggleExpanded,
    link,
    dismiss,
    unlink,
    linkAllStrong,
    fetchDismissals,
    restoreDismissal,
  }
}
