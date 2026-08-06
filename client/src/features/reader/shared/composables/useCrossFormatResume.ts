import { api } from '@/lib/api'

// Bound the reader-open blocking wait: a stalled server or network must never hang book render. On
// timeout the request aborts and we fall back to the normal saved-position restore.
const RESOLVE_TIMEOUT_MS = 2500

// A precise cross-format resume point for opening the ebook when the audiobook is ahead. `phrase` is
// the exact narration text the audiobook reached (for a client-side text search); `spineIndex` scopes
// that search to the right section; `percentage` is a coarse whole-book fallback.
export interface CrossFormatEbookResume {
  spineIndex: number
  phrase: string
  percentage: number
}

async function requestResume(bookId: number, signal: AbortSignal): Promise<CrossFormatEbookResume | null> {
  try {
    const res = await api(`/api/v1/reading-alignment/books/${bookId}/cross-format-resume?target=ebook`, { signal })
    if (!res.ok) return null
    const data = (await res.json()) as {
      available?: boolean
      source?: string
      spineIndex?: unknown
      phrase?: unknown
      percentage?: unknown
    }
    if (data?.available !== true || data.source !== 'audio') return null
    if (typeof data.spineIndex !== 'number' || typeof data.phrase !== 'string' || typeof data.percentage !== 'number') return null
    if (!data.phrase.trim()) return null
    return { spineIndex: data.spineIndex, phrase: data.phrase, percentage: data.percentage }
  } catch {
    return null
  }
}

// Asks the server whether the audiobook is strictly ahead of the ebook and, if so, where to resume the
// ebook. Returns null when there is no linked pair / ready alignment, when the audiobook is not ahead,
// on timeout, or on any error - callers fall back to the normal saved-position restore.
//
// The deadline races the ENTIRE operation, not just the initial fetch: on a 401 `api()` performs a token
// refresh + retry that the AbortSignal does not reach, so signalling the fetch alone could still hang
// reader-open. Promise.race guarantees this resolves within RESOLVE_TIMEOUT_MS regardless.
export async function fetchEbookCrossFormatResume(bookId: number): Promise<CrossFormatEbookResume | null> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, RESOLVE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([requestResume(bookId, controller.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}
