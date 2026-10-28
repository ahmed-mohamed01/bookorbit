import { computed, getCurrentScope, onScopeDispose, ref, watch } from 'vue'
import type { WorkForBook, WorkVariant } from '@bookorbit/types'
import { useBookProgressRefresh } from '@/features/book/composables/useBookProgressRefresh'
import { getWorkForBook } from '../api/work'

export type WorkSyncState = 'sync' | 'catching' | 'off'

export function useWorkForBook(bookId: () => number) {
  const work = ref<WorkForBook | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  let requestId = 0
  let disposed = false

  const otherVariants = computed<WorkVariant[]>(() => work.value?.variants.filter((variant) => !variant.isThisBook) ?? [])
  const hasOtherVariants = computed(() => otherVariants.value.length > 0)
  const libraryCount = computed(() => new Set(work.value?.variants.map((variant) => variant.libraryId) ?? []).size)
  const hasAudioVariant = computed(() => work.value?.variants.some((variant) => variant.role === 'audio') ?? false)
  const syncState = computed<WorkSyncState>(() => {
    if (!work.value) return 'off'
    if (!work.value.sharedState) return 'off'
    return work.value.inSync ? 'sync' : 'catching'
  })

  async function load(): Promise<void> {
    const current = ++requestId
    loading.value = true
    try {
      const data = await getWorkForBook(bookId())
      if (current !== requestId || disposed) return
      work.value = data
      error.value = null
    } catch {
      if (current !== requestId || disposed) return
      error.value = 'work_load_failed'
    } finally {
      if (current === requestId) loading.value = false
    }
  }

  watch(bookId, () => {
    work.value = null
    void load()
  })

  useBookProgressRefresh(load)

  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true
    })
  }

  void load()

  return { work, loading, error, otherVariants, hasOtherVariants, libraryCount, hasAudioVariant, syncState, load }
}
