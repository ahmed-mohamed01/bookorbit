import { api, getAccessToken } from '@/lib/api'
import type { EpubBookInfo, EpubMediaOverlayPlaylist } from '@bookorbit/types'
import type { FoliateMediaOverlay } from './composables/useFoliate'
import { PlaylistNarration, type NarrationBook } from '../media-overlay/engine/playlist-narration'
import { attachIndexNarration } from '../media-overlay/lib/index-narration'
import { ensureMediaOverlayActiveClass } from '../media-overlay/lib/media-overlay-highlight'
import { forgetMediaOverlayPlaylist, loadMediaOverlayPlaylist } from '../media-overlay/lib/media-overlay-playlist'

type FoliateFetchFile = ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) & {
  toString: () => string
  [Symbol.toPrimitive]: () => string
}

type MakeStreamingBook = (
  id: number,
  base: string,
  info: unknown,
  fetchFile: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  bookType: null,
  fileId: number,
) => Promise<unknown>

let loading: Promise<void> | null = null

/** How long opening a book waits for the playlist a timing index reads along from. */
export const INDEX_NARRATION_WAIT_MS = 10_000

// Fork: a playlist that is slow to come only means the book opens without index narration. Its
// request runs on, so the server finishes building it for the next open.
function indexNarrationPlaylist(bookId: number, fileId: number, wait: boolean): Promise<EpubMediaOverlayPlaylist | null> {
  const playlist = loadMediaOverlayPlaylist(bookId, fileId).catch(() => null)
  if (wait) return playlist
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), INDEX_NARRATION_WAIT_MS)
  })
  return Promise.race([playlist, timeout]).finally(() => clearTimeout(timer))
}

// view.js registers the <foliate-view> element and defines window.makeStreamingBook; defining the
// element twice throws, so every caller shares one load.
export function loadFoliate(): Promise<void> {
  if (customElements.get('foliate-view')) return Promise.resolve()
  loading ??= (async () => {
    const src = import.meta.env.DEV ? `/assets/foliate/view.js?v=${Date.now()}` : `/assets/foliate/${import.meta.env.VITE_FOLIATE_VERSION}/view.js`
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.type = 'module'
      script.src = src
      script.onload = () => setTimeout(resolve, 100)
      script.onerror = () => reject(new Error('Failed to load foliate/view.js'))
      document.head.appendChild(script)
    })
    await customElements.whenDefined('foliate-view')
  })().catch((e: unknown) => {
    loading = null
    throw e
  })
  return loading
}

// The loader reads the token when it builds each request, so it must stay current across refreshes.
export function makeFoliateFetchFile(): FoliateFetchFile {
  const fetchFile = ((input: RequestInfo | URL, init?: RequestInit) => api(input, init)) as FoliateFetchFile
  const currentToken = () => getAccessToken() ?? ''
  fetchFile.toString = currentToken
  fetchFile[Symbol.toPrimitive] = currentToken
  return fetchFile
}

export interface OpenStreamingEpubOptions {
  /** Fork: wait for a timing index's playlist however long it takes, rather than opening without it. */
  waitForIndexNarration?: boolean
  /** Fork: reuse the playlist already loaded for this file, the one `awaitIndexNarration` waited for. */
  keepIndexNarration?: boolean
}

export interface OpenedStreamingEpub {
  book: unknown
  info: EpubBookInfo
  /** Fork: the book reads along from a timing index, but its playlist did not come in time to narrate. */
  indexNarrationMissing: boolean
}

/**
 * Fork: waits, however long it takes, for the playlist of a book whose index narration did not come
 * at open. True once it is here: the next open (with `keepIndexNarration`) narrates from it. A
 * request still running is not repeated.
 */
export async function awaitIndexNarration(bookId: number, fileId: number): Promise<boolean> {
  return (await loadMediaOverlayPlaylist(bookId, fileId).catch(() => null)) !== null
}

export async function openStreamingEpub(bookId: number, fileId: number, options: OpenStreamingEpubOptions = {}): Promise<OpenedStreamingEpub> {
  if (!options.keepIndexNarration) forgetMediaOverlayPlaylist(fileId)
  const infoRes = await api(`/api/v1/epub/${bookId}/info?fileId=${fileId}`)
  if (!infoRes.ok) throw new Error(`Failed to fetch EPUB info: ${infoRes.status}`)
  const info = (await infoRes.json()) as EpubBookInfo
  const makeStreamingBook = (window as unknown as { makeStreamingBook?: MakeStreamingBook }).makeStreamingBook
  if (!makeStreamingBook) throw new Error('makeStreamingBook not available')
  const book = await makeStreamingBook(bookId, '/api/v1/epub', info, makeFoliateFetchFile(), null, fileId)
  // Fork: a plain EPUB its book's timing index reads along narrates with the audiobook. Asked
  // before the view opens, since that is when foliate looks for narration; a failure or a slow
  // answer only means the book opens without it.
  const indexNarrationMissing =
    !!info.timingIndexNarration && !attachIndexNarration(book, await indexNarrationPlaylist(bookId, fileId, !!options.waitForIndexNarration))
  ensureMediaOverlayActiveClass(book)
  const narrated = book as NarrationBook & { createMediaOverlay?: (fallback: () => FoliateMediaOverlay) => FoliateMediaOverlay }
  narrated.createMediaOverlay = (fallback) =>
    new PlaylistNarration({ book: narrated, loadPlaylist: () => loadMediaOverlayPlaylist(bookId, fileId), fallback })
  return { book, info, indexNarrationMissing }
}
