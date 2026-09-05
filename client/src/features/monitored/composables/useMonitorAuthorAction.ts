import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { MonitoredAuthorDetail, MonitoredAuthorSearchResult, MonitoredFormat } from '@bookorbit/types'
import { searchMonitoredAuthors } from '../api/monitored'
import { monitoredErrorText } from '../lib/api-error'

export interface MonitorAuthorCandidate {
  id: number
  name: string
  bookCount: number
}

const initialFormats: MonitoredFormat[] = ['ebook', 'audiobook']

/**
 * Turns a local library author into the search result the monitor modal expects, so a list view
 * only has to hand over the author it already has.
 */
export function useMonitorAuthorAction() {
  const { t } = useI18n()
  const resolvingId = ref<number | null>(null)
  const target = ref<MonitoredAuthorSearchResult | null>(null)

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
        toast.info(t('monitored.actions.alreadyMonitoring', { name: match.name }))
        return
      }

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
  }

  function handleCreated(detail: MonitoredAuthorDetail) {
    target.value = null
    toast.success(t('monitored.toast.monitoring', { name: detail.author.authorName }))
  }

  return { resolvingId, target, initialFormats, beginMonitor, closeModal, handleCreated }
}
