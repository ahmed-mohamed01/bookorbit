import { computed, ref, type Ref } from 'vue'
import type { MonitoredBulkRequestFormat, MonitoredBulkWorkPatch, MonitoredWork } from '@bookorbit/types'
import { monitoredBulkFormats } from '@bookorbit/types'
import { useMonitoredBulkActions } from './useMonitoredBulkActions'
import { useRequestSources } from './useRequestSources'
import { useMonitoredWorkSelection } from './useMonitoredWorkSelection'

export interface MonitoredBulkSelectionOptions {
  /** Works the viewer can pick, in the order they are listed, one entry per work id. */
  works: Ref<MonitoredWork[]>
  /** The ids a shift-click may sweep across; defaults to every pickable work. */
  rangeIds?: Ref<string[]>
  applyWork: (work: MonitoredWork) => void
  onChanged?: () => void
  onPatched?: (workIds: string[], patch: MonitoredBulkWorkPatch) => void
}

/** Everything a page needs to run select mode over monitored works, so the views only wire it up. */
export function useMonitoredBulkSelection(options: MonitoredBulkSelectionOptions) {
  const workIds = computed(() => options.works.value.map((work) => work.id))
  const selection = useMonitoredWorkSelection(options.rangeIds ?? workIds, { presentIds: workIds })
  const actions = useMonitoredBulkActions({ applyWork: options.applyWork, onChanged: options.onChanged, onPatched: options.onPatched })
  const format = ref<MonitoredBulkRequestFormat>('ebook')
  const autoDownload = ref(true)
  const requestSources = useRequestSources(selection.selectionMode, format)

  const selectedWorks = computed(() => options.works.value.filter((work) => selection.selectedIds.value.has(work.id)))

  function keepFailed(failedWorkIds: string[]) {
    if (failedWorkIds.length === 0) selection.exitSelectionMode()
    else selection.replaceSelection(failedWorkIds)
  }

  async function requestSelected() {
    const outcome = await actions.requestSelected(
      selectedWorks.value,
      format.value,
      autoDownload.value,
      requestSources.payloadFor(monitoredBulkFormats(format.value)),
    )
    keepFailed(outcome.failedWorkIds)
  }

  async function updateSelected(patch: MonitoredBulkWorkPatch) {
    const outcome = await actions.updateSelected(selectedWorks.value, patch)
    keepFailed(outcome.failedWorkIds)
  }

  function handleSelectWork(work: MonitoredWork, event: MouseEvent) {
    selection.handleSelect(work.id, event)
  }

  /** A long press enters select mode with that work picked, without ever unpicking it. */
  function startSelectingWith(work: MonitoredWork) {
    if (!selection.selectionMode.value) selection.enterSelectionMode()
    if (!selection.selectedIds.value.has(work.id)) selection.toggleBook(work.id)
  }

  function addMany(ids: string[]) {
    selection.selectMany(ids)
  }

  return {
    ...selection,
    format,
    autoDownload,
    sourceGroups: requestSources.groups,
    toggleSource: requestSources.toggle,
    useAllSources: requestSources.useAll,
    running: actions.running,
    selectedWorks,
    requestSelected,
    updateSelected,
    addMany,
    handleSelectWork,
    startSelectingWith,
  }
}
