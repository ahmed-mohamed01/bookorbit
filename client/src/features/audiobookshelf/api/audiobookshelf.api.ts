import { api } from '@/lib/api'
import type {
  AudiobookshelfConnectionTestPayload,
  AudiobookshelfConnectionTestResult,
  AudiobookshelfSettings,
  UpsertAudiobookshelfSettingsPayload,
} from '@bookorbit/types'

const BASE = '/api/v1/audiobookshelf'
const BOOK_SEARCH_PATH = '/api/v1/books/search'

export type AudiobookshelfMatchBucket = 'linked' | 'needs-review' | 'unmatched'

export interface AudiobookshelfBookState {
  absLibraryItemId: string
  absTitle: string
  absAuthorName: string | null
  absCoverUrl: string | null
  bookId: number | null
  bookTitle: string | null
  bookAuthorName: string | null
  matchMethod: 'asin' | 'isbn' | 'title_author_series' | 'manual' | null
  matchConfidence: number | null
  needsReview: boolean
  matchError: string | null
  syncExcluded: boolean
  syncError: string | null
  lastSyncedAt: string | null
}

export interface AudiobookshelfBookStatePage {
  items: AudiobookshelfBookState[]
  total: number
  page: number
  pageSize: number
}

export interface BookSearchOption {
  id: number
  title: string | null
  authors: string[]
  seriesName: string | null
  libraryName: string
  formats: string[]
}

export interface AudiobookshelfSyncResult {
  matched: number
  statusApplied: number
  positionApplied: number
  sessionsApplied: number
  skipped: number
  failed: number
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const body = await response.json().catch(() => ({}))
  return new Error((body as { message?: string }).message ?? fallback)
}

export async function fetchAudiobookshelfSettings(): Promise<AudiobookshelfSettings> {
  const response = await api(`${BASE}/settings`)
  if (!response.ok) throw await responseError(response, 'Failed to load Audiobookshelf settings')
  return response.json()
}

export async function updateAudiobookshelfSettings(payload: UpsertAudiobookshelfSettingsPayload): Promise<AudiobookshelfSettings> {
  const response = await api(`${BASE}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw await responseError(response, 'Failed to save Audiobookshelf settings')
  return response.json()
}

export async function disconnectAudiobookshelf(): Promise<void> {
  const response = await api(`${BASE}/settings`, { method: 'DELETE' })
  if (!response.ok) throw await responseError(response, 'Failed to disconnect Audiobookshelf')
}

export async function testAudiobookshelfConnection(payload: AudiobookshelfConnectionTestPayload): Promise<AudiobookshelfConnectionTestResult> {
  const response = await api(`${BASE}/test-connection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw await responseError(response, 'Failed to test Audiobookshelf connection')
  return response.json()
}

export async function fetchAudiobookshelfBookStates(
  bucket: AudiobookshelfMatchBucket,
  page: number,
  pageSize: number,
): Promise<AudiobookshelfBookStatePage> {
  const params = new URLSearchParams({ bucket, page: String(page), pageSize: String(pageSize) })
  const response = await api(`${BASE}/books?${params.toString()}`)
  if (!response.ok) throw await responseError(response, 'Failed to load Audiobookshelf books')
  return response.json()
}

export async function confirmAudiobookshelfMatch(absLibraryItemId: string): Promise<AudiobookshelfBookState> {
  const response = await api(`${BASE}/books/${encodeURIComponent(absLibraryItemId)}/confirm`, { method: 'POST' })
  if (!response.ok) throw await responseError(response, 'Failed to confirm Audiobookshelf match')
  return response.json()
}

export async function linkAudiobookshelfBook(absLibraryItemId: string, bookId: number): Promise<AudiobookshelfBookState> {
  const response = await api(`${BASE}/books/${encodeURIComponent(absLibraryItemId)}/link`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bookId }),
  })
  if (!response.ok) throw await responseError(response, 'Failed to link Audiobookshelf book')
  return response.json()
}

export async function unlinkAudiobookshelfBook(absLibraryItemId: string): Promise<AudiobookshelfBookState> {
  const response = await api(`${BASE}/books/${encodeURIComponent(absLibraryItemId)}/link`, { method: 'DELETE' })
  if (!response.ok) throw await responseError(response, 'Failed to unlink Audiobookshelf book')
  return response.json()
}

export async function updateAudiobookshelfBookExclusion(absLibraryItemId: string, syncExcluded: boolean): Promise<AudiobookshelfBookState> {
  const response = await api(`${BASE}/books/${encodeURIComponent(absLibraryItemId)}/exclusion`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ syncExcluded }),
  })
  if (!response.ok) throw await responseError(response, 'Failed to update Audiobookshelf book')
  return response.json()
}

export async function rescanAudiobookshelfMatches(): Promise<{ queued: number }> {
  const response = await api(`${BASE}/books/rescan`, { method: 'POST' })
  if (!response.ok) throw await responseError(response, 'Failed to rescan Audiobookshelf matches')
  return response.json()
}

export async function searchAudiobookshelfLinkCandidates(query: string, limit = 10): Promise<BookSearchOption[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) })
  const response = await api(`${BOOK_SEARCH_PATH}?${params.toString()}`)
  if (!response.ok) throw await responseError(response, 'Failed to search books')
  return response.json()
}

export async function startAudiobookshelfSync(): Promise<AudiobookshelfSyncResult> {
  const response = await api(`${BASE}/sync`, { method: 'POST' })
  if (!response.ok) throw await responseError(response, 'Failed to sync Audiobookshelf')
  return response.json()
}

export async function startAudiobookshelfFullResync(): Promise<AudiobookshelfSyncResult> {
  const response = await api(`${BASE}/full-resync`, { method: 'POST' })
  if (!response.ok) throw await responseError(response, 'Failed to fully resync Audiobookshelf')
  return response.json()
}
