import type { EpubMediaOverlayPlaylist } from '@bookorbit/types'
import { api } from '@/lib/api'

const MAX_CACHED = 4
const cache = new Map<number, Promise<EpubMediaOverlayPlaylist | null>>()

// The reader and its narration engine both read the playlist, so one request serves them. Null
// means the book has none; a request that did not reach the server throws and is not kept.
export function loadMediaOverlayPlaylist(bookId: number, fileId: number): Promise<EpubMediaOverlayPlaylist | null> {
  const cached = cache.get(fileId)
  if (cached) return cached
  const request = api(`/api/v1/epub/${bookId}/media-overlay?fileId=${fileId}`).then((res) =>
    res.ok ? (res.json() as Promise<EpubMediaOverlayPlaylist>) : null,
  )
  request.catch(() => cache.delete(fileId))
  cache.set(fileId, request)
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!)
  return request
}
