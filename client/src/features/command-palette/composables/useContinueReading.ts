import { ref, watch, type Ref } from 'vue'
import type { BookCard, DashboardScrollerBatchResponse } from '@bookorbit/types'
import { api } from '@/lib/api'
const CONTINUE_READING_LIMIT = 4
const CONTINUE_READING_TTL_MS = 60_000
export function useContinueReading(isOpen: Ref<boolean>) {
  const continueReading = ref<BookCard[]>([])
  let continueReadingFetchedAt = 0

  async function refreshContinueReading() {
    if (Date.now() - continueReadingFetchedAt < CONTINUE_READING_TTL_MS) return
    continueReadingFetchedAt = Date.now()
    try {
      const res = await api('/api/v1/dashboard/scrollers/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: 'command-palette', type: 'continue-reading', limit: CONTINUE_READING_LIMIT }] }),
      })
      if (!res.ok) return
      const payload: DashboardScrollerBatchResponse = await res.json()
      continueReading.value = payload.items[0]?.books ?? []
    } catch {
      continueReadingFetchedAt = 0
    }
  }

  watch(
    isOpen,
    (open) => {
      if (open) void refreshContinueReading()
    },
    { immediate: true },
  )
  return continueReading
}
