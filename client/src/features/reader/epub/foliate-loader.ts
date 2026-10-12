import { api, getAccessToken } from '@/lib/api'
import type { EpubBookInfo } from '@bookorbit/types'
import { ensureMediaOverlayActiveClass } from '../media-overlay/lib/media-overlay-highlight'

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

// view.js registers the <foliate-view> element and defines window.makeStreamingBook; defining the
// element twice throws, so every caller shares one load.
export function loadFoliate(): Promise<void> {
  if (customElements.get('foliate-view')) return Promise.resolve()
  loading ??= (async () => {
    const src = import.meta.env.DEV ? `/assets/foliate/view.js?v=${Date.now()}` : '/assets/foliate/view.js'
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

export async function openStreamingEpub(bookId: number, fileId: number): Promise<{ book: unknown; info: EpubBookInfo }> {
  const infoRes = await api(`/api/v1/epub/${bookId}/info?fileId=${fileId}`)
  if (!infoRes.ok) throw new Error(`Failed to fetch EPUB info: ${infoRes.status}`)
  const info = (await infoRes.json()) as EpubBookInfo
  const makeStreamingBook = (window as unknown as { makeStreamingBook?: MakeStreamingBook }).makeStreamingBook
  if (!makeStreamingBook) throw new Error('makeStreamingBook not available')
  const book = await makeStreamingBook(bookId, '/api/v1/epub', info, makeFoliateFetchFile(), null, fileId)
  ensureMediaOverlayActiveClass(book)
  return { book, info }
}
