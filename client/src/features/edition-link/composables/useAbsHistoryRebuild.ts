import { ref } from 'vue'
import type { AbsHistoryRebuildPreview, AbsHistoryRebuildResult } from '@bookorbit/types'
import { previewAbsHistoryRebuild, rebuildAbsHistory } from '../api/work'

export function useAbsHistoryRebuild() {
  const preview = ref<AbsHistoryRebuildPreview | null>(null)
  const result = ref<AbsHistoryRebuildResult | null>(null)
  const previewing = ref(false)
  const rebuilding = ref(false)
  const error = ref<string | null>(null)

  async function loadPreview(): Promise<boolean> {
    previewing.value = true
    error.value = null
    result.value = null
    try {
      preview.value = await previewAbsHistoryRebuild()
      return true
    } catch {
      error.value = 'abs_history_preview_failed'
      return false
    } finally {
      previewing.value = false
    }
  }

  async function rebuild(): Promise<boolean> {
    rebuilding.value = true
    error.value = null
    try {
      result.value = await rebuildAbsHistory()
      preview.value = null
      return true
    } catch {
      error.value = 'abs_history_rebuild_failed'
      return false
    } finally {
      rebuilding.value = false
    }
  }

  return { preview, result, previewing, rebuilding, error, loadPreview, rebuild }
}
