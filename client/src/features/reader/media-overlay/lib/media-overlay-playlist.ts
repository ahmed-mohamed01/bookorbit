import type { EpubMediaOverlayPlaylist } from '@bookorbit/types'
import { api } from '@/lib/api'

const MAX_CACHED = 4
const cache = new Map<number, Promise<EpubMediaOverlayPlaylist | null>>()

// The reader and its narration engine both read the playlist, so one request serves them. Null
// means the server gave none; that, and a request that did not reach the server, is not kept.
export function loadMediaOverlayPlaylist(bookId: number, fileId: number): Promise<EpubMediaOverlayPlaylist | null> {
  const cached = cache.get(fileId)
  if (cached) return cached
  const forget = () => {
    if (cache.get(fileId) === request) cache.delete(fileId)
  }
  const request: Promise<EpubMediaOverlayPlaylist | null> = api(`/api/v1/epub/${bookId}/media-overlay?fileId=${fileId}`).then((res) => {
    if (res.ok) return res.json() as Promise<EpubMediaOverlayPlaylist>
    forget()
    return null
  })
  request.catch(forget)
  cache.set(fileId, request)
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!)
  return request
}

/** Drops the playlist kept for `fileId`, so a book opened again picks up one the server rebuilt. */
export function forgetMediaOverlayPlaylist(fileId: number): void {
  cache.delete(fileId)
}
