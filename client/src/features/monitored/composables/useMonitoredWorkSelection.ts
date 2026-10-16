import { computed, watch, type Ref } from 'vue'
import { useBookSelection } from '@/features/book/composables/useBookSelection'

export interface MonitoredWorkSelectionOptions {
  selectionMode?: Ref<boolean>
  /** Every id still held by the page, when that is wider than the ids the user can range over (collapsed groups keep their picks). */
  presentIds?: Ref<string[]>
}

export function useMonitoredWorkSelection(orderedIds: Ref<string[]>, options: MonitoredWorkSelectionOptions = {}) {
  const selection = useBookSelection<string>(options.selectionMode)

  const onScreen = computed(() => new Set((options.presentIds ?? orderedIds).value))

  function handleSelect(id: string, event: MouseEvent) {
    if (event.shiftKey) {
      selection.rangeSelectTo(id, orderedIds.value)
      return
    }
    selection.toggleBook(id)
  }

  function toggleSelectionMode() {
    if (selection.selectionMode.value) selection.exitSelectionMode()
    else selection.enterSelectionMode()
  }

  function selectMany(ids: string[]) {
    selection.selectedIds.value = new Set([...selection.selectedIds.value, ...ids])
  }

  function deselectMany(ids: string[]) {
    selection.deselectAll(ids)
  }

  function replaceSelection(ids: string[]) {
    selection.selectAll(ids)
  }

  watch(onScreen, (visible) => {
    const kept = [...selection.selectedIds.value].filter((id) => visible.has(id))
    if (kept.length !== selection.selectedIds.value.size) selection.selectAll(kept)
  })

  return {
    ...selection,
    handleSelect,
    toggleSelectionMode,
    selectMany,
    deselectMany,
    replaceSelection,
  }
}
