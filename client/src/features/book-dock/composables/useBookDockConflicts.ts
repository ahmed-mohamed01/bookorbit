import { ref } from 'vue'
import type { BookDockFinalizePreviewItem, BookDockFinalizePreviewResult, BookDockFinalizePreviewStatus } from '@bookorbit/types'
import { api } from '@/lib/api'

export type BookDockConflict = {
  status: BookDockFinalizePreviewStatus
  message?: string
  existingBookId?: number
}

/** Only states worth interrupting the user for; everything else is the happy path. */
const BLOCKING: BookDockFinalizePreviewStatus[] = ['duplicate', 'destination_conflict', 'invalid_target', 'access_denied', 'invalid_format', 'error']

/**
 * The finalize preview already knows which files would be refused or would collide
 * with an existing book. Asking it for the visible page turns that into a warning on
 * the row instead of a surprise after a finalize run.
 */
export function useBookDockConflicts() {
  const conflicts = ref<Record<number, BookDockConflict>>({})
  let timer: ReturnType<typeof setTimeout> | null = null
  let seq = 0

  async function fetchConflicts(fileIds: number[]) {
    if (!fileIds.length) {
      conflicts.value = {}
      return
    }
    const reqId = ++seq
    try {
      const res = await api('/api/v1/book-dock/finalize/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds }),
      })
      if (!res.ok || reqId !== seq) return
      const result: BookDockFinalizePreviewResult = await res.json()
      if (reqId !== seq) return

      const next: Record<number, BookDockConflict> = {}
      for (const item of result.items as BookDockFinalizePreviewItem[]) {
        if (!BLOCKING.includes(item.status)) continue
        next[item.fileId] = { status: item.status, message: item.message, existingBookId: item.existingBookId }
      }
      conflicts.value = next
    } catch {
      // Advisory only: a failed preview must never block the list from rendering.
      if (reqId === seq) conflicts.value = {}
    }
  }

  function scheduleConflicts(fileIds: number[]) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void fetchConflicts(fileIds), 200)
  }

  function cancelConflicts() {
    if (timer) clearTimeout(timer)
    timer = null
    seq++
  }

  return { conflicts, fetchConflicts, scheduleConflicts, cancelConflicts }
}
