import type { CrossFormatResume } from '@bookorbit/types'
import { api } from '@/lib/api'

// Bound the reader-open blocking wait: a stalled server or network must never hang book render. On
// timeout the request aborts and we fall back to the normal saved-position restore.
const RESOLVE_TIMEOUT_MS = 2500

export type CrossFormatEbookResume = Omit<Extract<CrossFormatResume, { available: true }>, 'available' | 'source'>

async function requestResume(bookId: number, fileId: number, signal: AbortSignal): Promise<CrossFormatEbookResume | null> {
  try {
    const res = await api(`/api/v1/reading-alignment/books/${bookId}/cross-format-resume?fileId=${fileId}`, { signal })
    if (!res.ok) return null
    const data = (await res.json()) as Partial<Record<keyof CrossFormatEbookResume | 'available' | 'source', unknown>> | null
    if (data?.available !== true || data.source !== 'audio') return null
    if (typeof data.spineIndex !== 'number' || typeof data.phrase !== 'string' || typeof data.percentage !== 'number') return null
    if (!data.phrase.trim()) return null
    return { spineIndex: data.spineIndex, phrase: data.phrase, percentage: data.percentage }
  } catch {
    return null
  }
}

// Asks the server whether the audiobook is strictly ahead of the opened EPUB and, if so, where to resume
// it. Returns null when the book has no ready alignment, when the opened file is not the aligned plain
// EPUB, when upstream's read-aloud sync covers the book, when the audiobook is not ahead, on timeout, or
// on any error - callers fall back to the normal saved-position restore.
//
// The deadline races the ENTIRE operation, not just the initial fetch: on a 401 `api()` performs a token
// refresh + retry that the AbortSignal does not reach, so signalling the fetch alone could still hang
// reader-open. Promise.race guarantees this resolves within RESOLVE_TIMEOUT_MS regardless.
export async function fetchEbookCrossFormatResume(bookId: number, fileId: number): Promise<CrossFormatEbookResume | null> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, RESOLVE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([requestResume(bookId, fileId, controller.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}
