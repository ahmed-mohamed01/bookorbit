import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { monitorAuthor } from '../api/monitored'
import { MonitoredApiError, monitoredErrorText } from '../lib/api-error'

/** All a quick-monitor needs from a search result row: who to monitor, and what to key the in-flight marker on. */
export interface MonitorGroupTarget {
  key: string
  authors: string[]
}

/**
 * Monitors the author of a search result row in one click, and remembers the rows that already
 * fired so the same author cannot be monitored twice from the same list.
 */
export function useMonitorGroupAction() {
  const { t } = useI18n()
  const monitoringKeys = ref(new Set<string>())
  // A bell that already fired stops inviting a second click.
  const monitoredAuthorNames = ref(new Set<string>())

  function isGroupMonitored(group: MonitorGroupTarget): boolean {
    const name = group.authors[0]
    return name !== undefined && monitoredAuthorNames.value.has(name)
  }

  function isGroupMonitoring(group: MonitorGroupTarget): boolean {
    return monitoringKeys.value.has(group.key)
  }

  function monitorAuthorLabel(group: MonitorGroupTarget): string {
    const name = group.authors[0] ?? ''
    return isGroupMonitored(group) ? t('monitored.actions.alreadyMonitoring', { name }) : t('monitored.actions.quickMonitor', { name })
  }

  function markGroupMonitored(name: string) {
    monitoredAuthorNames.value = new Set([...monitoredAuthorNames.value, name])
  }

  /**
   * Quick-monitor is deliberately opinionated: ebook notifications, no target library. The full
   * choice lives on the Monitored page, so this stays one click.
   */
  async function monitorGroupAuthor(group: MonitorGroupTarget): Promise<void> {
    const name = group.authors[0]
    if (!name || isGroupMonitoring(group) || isGroupMonitored(group)) return
    monitoringKeys.value = new Set([...monitoringKeys.value, group.key])
    try {
      await monitorAuthor({
        authorName: name,
        formats: {
          ebook: { mode: 'notify', libraryId: null, folderId: null },
          audiobook: { mode: 'off', libraryId: null, folderId: null },
        },
      })
      markGroupMonitored(name)
      toast.success(t('monitored.toast.monitoring', { name }))
    } catch (cause) {
      // The one refusal this well-formed request can draw is the duplicate guard, so show the row
      // as monitored rather than as a failure the reader cannot act on.
      if (cause instanceof MonitoredApiError && cause.status === 400) {
        markGroupMonitored(name)
        toast.info(cause.serverMessage ?? t('monitored.actions.alreadyMonitoring', { name }))
      } else {
        toast.error(monitoredErrorText(cause, t('monitored.modal.failed')))
      }
    } finally {
      const next = new Set(monitoringKeys.value)
      next.delete(group.key)
      monitoringKeys.value = next
    }
  }

  return { isGroupMonitored, isGroupMonitoring, monitorAuthorLabel, markGroupMonitored, monitorGroupAuthor }
}
