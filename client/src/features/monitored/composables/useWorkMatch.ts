import { ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import type { MonitoredFormat, MonitoredWork, MonitoredWorkMatchPayload } from '@bookorbit/types'
import { setMonitoredWorkMatch } from '../api/monitored'
import { monitoredErrorText } from '../lib/api-error'

export type MonitoredMatchAnswer = MonitoredWorkMatchPayload

/**
 * The owner's answers about which library book is a work's book, per format. Every answer comes
 * back as the whole rematched work, for the panel and the lists to read from.
 */
export function useWorkMatch(workId: Ref<string | null>) {
  const { t } = useI18n()
  const saving = ref<Partial<Record<MonitoredFormat, boolean>>>({})

  watch(workId, () => {
    saving.value = {}
  })

  /** `targetWorkId` lets a late answer, such as an undo, reach the work it was given for after the panel moved on. */
  async function answer(
    format: MonitoredFormat,
    payload: MonitoredMatchAnswer,
    targetWorkId: string | null = workId.value,
  ): Promise<MonitoredWork | null> {
    const requestedWorkId = targetWorkId
    if (requestedWorkId === null || saving.value[format]) return null
    saving.value = { ...saving.value, [format]: true }
    try {
      return await setMonitoredWorkMatch(requestedWorkId, format, payload)
    } catch (cause) {
      toast.error(monitoredErrorText(cause, t('monitored.slot.match.failed')))
      return null
    } finally {
      saving.value = { ...saving.value, [format]: false }
    }
  }

  function isSaving(format: MonitoredFormat): boolean {
    return saving.value[format] === true
  }

  return { answer, isSaving }
}
