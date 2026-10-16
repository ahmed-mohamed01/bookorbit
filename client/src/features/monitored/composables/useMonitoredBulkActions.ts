import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import {
  MONITORED_WORK_BULK_LIMIT,
  monitoredBulkFormats,
  monitoredBulkSkipReason,
  type MonitoredBulkRequestFormat,
  type MonitoredBulkRequestPayload,
  type MonitoredBulkSkipReason,
  type MonitoredBulkWorkPatch,
  type MonitoredWork,
} from '@bookorbit/types'
import { bulkRequestMonitoredWorks, bulkUpdateMonitoredWorks } from '../api/monitored'
import { chunk, emptySkipCounts } from '../lib/bulk-select'
import { todayUtc } from '../lib/format-status'

export interface MonitoredBulkOptions {
  /** The page's own update path, so every list and the open panel pick up the server's answer. */
  applyWork: (work: MonitoredWork) => void
  /** Runs once after any work changed, for pages that refetch their list. */
  onChanged?: () => void
  /** Runs once after a bulk update, naming only the works the server confirmed. */
  onPatched?: (workIds: string[], patch: MonitoredBulkWorkPatch) => void
}

export interface BulkRequestOutcome {
  requested: number
  skipped: Record<MonitoredBulkSkipReason, number>
  /** Works that were not filed, including the ones a stopped run never reached. */
  failed: number
  failedWorkIds: string[]
  works: MonitoredWork[]
}

export interface BulkUpdateOutcome {
  failed: number
  failedWorkIds: string[]
  works: MonitoredWork[]
}

export function useMonitoredBulkActions(options: MonitoredBulkOptions) {
  const { t } = useI18n()
  const running = ref(false)

  function finish(works: MonitoredWork[]): void {
    for (const work of works) options.applyWork(work)
    if (works.length > 0) options.onChanged?.()
  }

  async function requestSelected(
    works: readonly MonitoredWork[],
    format: MonitoredBulkRequestFormat,
    autoDownload: boolean,
    sources?: MonitoredBulkRequestPayload['sources'],
  ): Promise<BulkRequestOutcome> {
    const today = todayUtc()
    const formats = monitoredBulkFormats(format)
    const outcome: BulkRequestOutcome = { requested: 0, skipped: emptySkipCounts(), failed: 0, failedWorkIds: [], works: [] }
    const sendable: MonitoredWork[] = []
    for (const work of works) {
      const reasons = formats.map((each) => monitoredBulkSkipReason(work, each, today))
      if (reasons.every((reason) => reason !== null)) {
        for (const reason of reasons) if (reason) outcome.skipped[reason] += 1
      } else {
        sendable.push(work)
      }
    }

    running.value = true
    try {
      const chunks = chunk(sendable, MONITORED_WORK_BULK_LIMIT)
      for (const [index, group] of chunks.entries()) {
        try {
          const response = await bulkRequestMonitoredWorks({
            workIds: group.map((work) => work.id),
            format,
            autoDownload,
            ...(sources ? { sources } : {}),
          })
          const failedIds = new Set<string>()
          for (const result of response.results) {
            if (result.outcome === 'requested') outcome.requested += 1
            else if (result.outcome === 'skipped') outcome.skipped[result.reason] += 1
            else failedIds.add(result.workId)
          }
          outcome.failedWorkIds.push(...failedIds)
          outcome.works.push(...response.works)
        } catch {
          const unsent = chunks.slice(index).flat()
          outcome.failedWorkIds.push(...unsent.map((work) => work.id))
          break
        }
      }
    } finally {
      running.value = false
    }

    outcome.failed = outcome.failedWorkIds.length
    finish(outcome.works)
    const skipped = Object.values(outcome.skipped).reduce((sum, count) => sum + count, 0)
    if (outcome.failed === 0) toast.success(t('monitored.selection.toast.requested', { requested: outcome.requested, skipped }))
    else toast.error(t('monitored.selection.toast.requestPartial', { requested: outcome.requested, failed: outcome.failed }))
    return outcome
  }

  async function updateSelected(works: readonly MonitoredWork[], patch: MonitoredBulkWorkPatch): Promise<BulkUpdateOutcome> {
    const outcome: BulkUpdateOutcome = { failed: 0, failedWorkIds: [], works: [] }
    running.value = true
    try {
      const chunks = chunk(works, MONITORED_WORK_BULK_LIMIT)
      for (const [index, group] of chunks.entries()) {
        try {
          const response = await bulkUpdateMonitoredWorks({ workIds: group.map((work) => work.id), patch })
          outcome.works.push(...response.works)
          outcome.failedWorkIds.push(...response.failed.map((entry) => entry.workId))
        } catch {
          outcome.failedWorkIds.push(
            ...chunks
              .slice(index)
              .flat()
              .map((work) => work.id),
          )
          break
        }
      }
    } finally {
      running.value = false
    }

    outcome.failed = outcome.failedWorkIds.length
    finish(outcome.works)
    if (outcome.works.length > 0)
      options.onPatched?.(
        outcome.works.map((work) => work.id),
        patch,
      )
    if (outcome.failed === 0) toast.success(t('monitored.selection.toast.updated', { count: outcome.works.length }))
    else toast.error(t('monitored.selection.toast.updatePartial', { updated: outcome.works.length, failed: outcome.failed }))
    return outcome
  }

  return { running, requestSelected, updateSelected }
}
