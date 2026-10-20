import { onActivated, onDeactivated, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { MonitoredAuthorItem, MonitoredAuthorSearchResult, MonitoredFormat } from '@bookorbit/types'
import { deleteMonitoredAuthor, fetchMonitoredLocalAuthors, searchMonitoredAuthors } from '../api/monitored'
import { MonitoredApiError, monitoredErrorText } from '../lib/api-error'

export interface MonitorAuthorCandidate {
  id: number
  name: string
  bookCount: number
}

const initialFormats: MonitoredFormat[] = ['ebook', 'audiobook']
const LOOKUP_BATCH_SIZE = 200

/**
 * Turns a local library author into the search result the monitor modal expects, so a list view
 * only has to hand over the author it already has.
 */
export function useMonitorAuthorAction() {
  const { t } = useI18n()
  const resolvingId = ref<number | null>(null)
  const target = ref<MonitoredAuthorSearchResult | null>(null)
  let targetLocalId: number | null = null
  /** Library author id to the viewer's monitor id, for the authors looked up so far. */
  const monitoredIds = ref<Record<number, string>>({})
  const lookedUp = new Set<number>()
  const stopTarget = ref<{ localId: number; monitoredId: string; name: string } | null>(null)
  const stopping = ref(false)

  function monitoredIdFor(authorId: number): string | null {
    return monitoredIds.value[authorId] ?? null
  }

  async function fetchStatus(authorIds: number[]): Promise<void> {
    for (let start = 0; start < authorIds.length; start += LOOKUP_BATCH_SIZE) {
      const batch = authorIds.slice(start, start + LOOKUP_BATCH_SIZE)
      try {
        const found = await fetchMonitoredLocalAuthors(batch)
        const next = { ...monitoredIds.value }
        for (const id of batch) {
          if (found[id]) next[id] = found[id]
          else delete next[id]
        }
        monitoredIds.value = next
      } catch {
        // Without the answer the add action still works and reports a duplicate, so retry later instead of erroring.
        for (const id of batch) lookedUp.delete(id)
      }
    }
  }

  async function loadMonitoredStatus(authorIds: number[]): Promise<void> {
    const pending = [...new Set(authorIds)].filter((id) => !lookedUp.has(id))
    if (pending.length === 0) return
    for (const id of pending) lookedUp.add(id)
    await fetchStatus(pending)
  }

  // Author views stay cached while the watchlist itself changes, so a view coming back asks again.
  let deactivated = false
  onDeactivated(() => {
    deactivated = true
  })
  onActivated(() => {
    if (deactivated) void fetchStatus([...lookedUp])
  })

  async function beginMonitor(author: MonitorAuthorCandidate): Promise<void> {
    if (resolvingId.value !== null) return

    resolvingId.value = author.id
    try {
      const results = await searchMonitoredAuthors(author.name)
      // A result carrying some other author's id would bind the monitor to that author, so only an
      // unbound result may be claimed by name.
      const match =
        results.find((result) => result.localAuthorId === author.id) ??
        results.find((result) => result.localAuthorId === null && result.name.trim().toLowerCase() === author.name.trim().toLowerCase())

      if (match?.alreadyMonitoredId) {
        monitoredIds.value = { ...monitoredIds.value, [author.id]: match.alreadyMonitoredId }
        toast.info(t('monitored.actions.alreadyMonitoring', { name: match.name }))
        return
      }

      targetLocalId = author.id
      target.value = match ?? {
        name: author.name,
        providerIds: {},
        localAuthorId: author.id,
        bookCount: author.bookCount,
        imageUrl: null,
        genres: [],
        alreadyMonitoredId: null,
      }
    } catch (cause) {
      toast.error(monitoredErrorText(cause, t('monitored.add.searchFailed')))
    } finally {
      resolvingId.value = null
    }
  }

  function closeModal() {
    target.value = null
    targetLocalId = null
  }

  function handleCreated(detail: MonitoredAuthorItem) {
    target.value = null
    if (targetLocalId !== null) monitoredIds.value = { ...monitoredIds.value, [targetLocalId]: detail.id }
    targetLocalId = null
    toast.success(t('monitored.toast.monitoring', { name: detail.authorName }))
  }

  function beginStop(author: { id: number; name: string }) {
    const monitoredId = monitoredIdFor(author.id)
    if (monitoredId) stopTarget.value = { localId: author.id, monitoredId, name: author.name }
  }

  function cancelStop() {
    if (!stopping.value) stopTarget.value = null
  }

  async function confirmStop(): Promise<void> {
    const pending = stopTarget.value
    if (!pending || stopping.value) return
    stopping.value = true
    try {
      await deleteMonitoredAuthor(pending.monitoredId)
      const { [pending.localId]: _removed, ...rest } = monitoredIds.value
      monitoredIds.value = rest
      toast.success(t('monitored.toast.stopped', { name: pending.name }))
    } catch (cause) {
      if (cause instanceof MonitoredApiError && cause.status === 404) {
        const { [pending.localId]: _gone, ...rest } = monitoredIds.value
        monitoredIds.value = rest
      }
      toast.error(monitoredErrorText(cause, t('monitored.toast.updateFailed')))
    } finally {
      stopping.value = false
      stopTarget.value = null
    }
  }

  return {
    resolvingId,
    target,
    initialFormats,
    beginMonitor,
    closeModal,
    handleCreated,
    monitoredIdFor,
    loadMonitoredStatus,
    stopTarget,
    stopping,
    beginStop,
    cancelStop,
    confirmStop,
  }
}
