import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { monitoredWorkIsAudiobookOnly, type HardcoverSearchBook, type MonitoredCatalogSearchHit, type MonitoredFormat } from '@bookorbit/types'
import { useBookRequestVisibility } from '@/features/book-requests/composables/useBookRequestVisibility'
import { requestMonitoredWork } from '@/features/monitored/api/monitored'
import { useMonitorGroupAction } from '@/features/monitored/composables/useMonitorGroupAction'
import { editionRowAction, workFormatStatus } from '@/features/monitored/lib/format-status'

const FORMATS: MonitoredFormat[] = ['ebook', 'audiobook']

export function usePaletteRowActions() {
  const { t } = useI18n()
  const requestBusy = ref(new Set<string>())
  const requestedRows = ref(new WeakSet<MonitoredCatalogSearchHit>())
  const { monitorGroupAuthor, isGroupMonitored, isGroupMonitoring } = useMonitorGroupAction()
  const { showBookRequests } = useBookRequestVisibility()

  function watchedFormats(hit: MonitoredCatalogSearchHit) {
    return FORMATS.filter((format) => hit.authorModes[format] !== 'off')
      .map((format) => ({ format, status: workFormatStatus(hit.work, format, { authorWatches: true }) }))
      .filter(({ status }) => status !== 'not_watching' && status !== 'unannounced')
  }

  function requestFormat(hit: MonitoredCatalogSearchHit) {
    if (!showBookRequests.value || requestedRows.value.has(hit)) return undefined
    return watchedFormats(hit).find(
      ({ format, status }) =>
        !(format === 'ebook' && monitoredWorkIsAudiobookOnly(hit.work)) && editionRowAction(hit.work, format, status, true) === 'request',
    )?.format
  }

  async function requestWork(hit: MonitoredCatalogSearchHit) {
    const format = requestFormat(hit)
    if (!format || requestBusy.value.has(hit.work.id)) return
    requestBusy.value.add(hit.work.id)
    try {
      const work = await requestMonitoredWork(hit.work.id, { format })
      requestedRows.value.add(hit)
      hit.work = work
    } catch {
      toast.error(t('monitored.modal.failed'))
    } finally {
      requestBusy.value.delete(hit.work.id)
    }
  }

  // Follow state is keyed on the exact name, so every spelling of one author maps to the first one seen.
  const authorNames = new Map<string, string>()
  function followTarget(book: HardcoverSearchBook) {
    const name = book.authorNames[0]?.trim().toLocaleLowerCase() ?? ''
    return { key: `follow:${name}`, authors: name ? [authorNames.get(name) ?? book.authorNames[0]!.trim()] : [] }
  }
  function followAuthor(book: HardcoverSearchBook) {
    const name = book.authorNames[0]?.trim() ?? ''
    const key = name.toLocaleLowerCase()
    if (key && !authorNames.has(key)) authorNames.set(key, name)
    return monitorGroupAuthor(followTarget(book))
  }
  function isFollowed(book: HardcoverSearchBook) {
    return isGroupMonitored(followTarget(book))
  }
  function isFollowing(book: HardcoverSearchBook) {
    return isGroupMonitoring(followTarget(book))
  }
  return { watchedFormats, requestFormat, requestWork, requestBusy, followAuthor, isFollowed, isFollowing }
}
