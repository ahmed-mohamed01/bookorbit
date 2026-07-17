import { beforeEach, describe, expect, it, vi } from 'vitest'

type ApiFn = (input: RequestInfo | URL, init?: RequestInit & { _isRetry?: boolean }) => Promise<Response>

vi.mock('@/lib/api', () => ({ api: vi.fn<ApiFn>() }))

import { api } from '@/lib/api'
import {
  confirmAudiobookshelfMatch,
  disconnectAudiobookshelf,
  fetchAudiobookshelfBookStates,
  fetchAudiobookshelfLibraries,
  fetchAudiobookshelfSettings,
  linkAudiobookshelfBook,
  rescanAudiobookshelfMatches,
  startAudiobookshelfFullResync,
  startAudiobookshelfSync,
  testAudiobookshelfConnection,
  unlinkAudiobookshelfBook,
  updateAudiobookshelfSettings,
  updateAudiobookshelfBookExclusion,
} from '../audiobookshelf.api'

const mockApi = vi.mocked(api)

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: vi.fn<() => Promise<unknown>>().mockResolvedValue(body) } as unknown as Response
}

describe('audiobookshelf.api settings contract', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  it('fetches settings from the verified server route', async () => {
    const settings = { serverUrl: 'https://abs.example.com', tokenConfigured: true, effectiveEnabled: true }
    mockApi.mockResolvedValue(jsonResponse(settings))

    await expect(fetchAudiobookshelfSettings()).resolves.toEqual(settings)
    expect(mockApi).toHaveBeenCalledWith('/api/v1/audiobookshelf/settings')
  })

  it('sends only the provided settings fields', async () => {
    mockApi.mockResolvedValue(jsonResponse({ enabled: false }))

    await updateAudiobookshelfSettings({ enabled: false })

    expect(mockApi).toHaveBeenCalledWith(
      '/api/v1/audiobookshelf/settings',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: false }) }),
    )
  })

  it('fetches the current book-library selection options', async () => {
    const response = { libraries: [{ id: 'fiction', name: 'Fiction', mediaType: 'book', provider: 'audible', excluded: false }] }
    mockApi.mockResolvedValue(jsonResponse(response))

    await expect(fetchAudiobookshelfLibraries()).resolves.toEqual(response)
    expect(mockApi).toHaveBeenCalledWith('/api/v1/audiobookshelf/libraries')
  })

  it('uses the verified disconnect and connection-test routes', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse(null)).mockResolvedValueOnce(jsonResponse({ success: true, username: 'listener' }))

    await expect(disconnectAudiobookshelf()).resolves.toBeUndefined()
    await expect(testAudiobookshelfConnection({ serverUrl: 'https://abs.example.com' })).resolves.toEqual({
      success: true,
      username: 'listener',
    })

    expect(mockApi).toHaveBeenNthCalledWith(1, '/api/v1/audiobookshelf/settings', { method: 'DELETE' })
    expect(mockApi).toHaveBeenNthCalledWith(
      2,
      '/api/v1/audiobookshelf/test-connection',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ serverUrl: 'https://abs.example.com' }) }),
    )
  })

  it('uses the verified paginated linked-book routes', async () => {
    const state = { absLibraryItemId: 'abs/item', bookId: 42 }
    mockApi
      .mockResolvedValueOnce(jsonResponse({ items: [state], total: 1, page: 0, pageSize: 20 }))
      .mockResolvedValueOnce(jsonResponse(state))
      .mockResolvedValueOnce(jsonResponse(state))
      .mockResolvedValueOnce(jsonResponse({ ...state, bookId: null }))
      .mockResolvedValueOnce(jsonResponse({ ...state, syncExcluded: true }))
      .mockResolvedValueOnce(jsonResponse({ queued: 3 }))

    await fetchAudiobookshelfBookStates('linked', 0, 20)
    await confirmAudiobookshelfMatch('abs/item')
    await linkAudiobookshelfBook('abs/item', 42)
    await unlinkAudiobookshelfBook('abs/item')
    await updateAudiobookshelfBookExclusion('abs/item', true)
    await expect(rescanAudiobookshelfMatches()).resolves.toEqual({ queued: 3 })

    expect(mockApi).toHaveBeenNthCalledWith(1, '/api/v1/audiobookshelf/books?bucket=linked&page=0&pageSize=20')
    expect(mockApi).toHaveBeenNthCalledWith(2, '/api/v1/audiobookshelf/books/abs%2Fitem/confirm', { method: 'POST' })
    expect(mockApi).toHaveBeenNthCalledWith(
      3,
      '/api/v1/audiobookshelf/books/abs%2Fitem/link',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ bookId: 42 }) }),
    )
    expect(mockApi).toHaveBeenNthCalledWith(4, '/api/v1/audiobookshelf/books/abs%2Fitem/link', { method: 'DELETE' })
    expect(mockApi).toHaveBeenNthCalledWith(
      5,
      '/api/v1/audiobookshelf/books/abs%2Fitem/exclusion',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ syncExcluded: true }) }),
    )
    expect(mockApi).toHaveBeenNthCalledWith(6, '/api/v1/audiobookshelf/books/rescan', { method: 'POST' })
  })

  it('uses both verified synchronous sync routes', async () => {
    const result = { matched: 2, statusApplied: 1, positionApplied: 1, sessionsApplied: 4, skipped: 3, failed: 0 }
    mockApi.mockResolvedValueOnce(jsonResponse(result)).mockResolvedValueOnce(jsonResponse(result))

    await expect(startAudiobookshelfSync()).resolves.toEqual(result)
    await expect(startAudiobookshelfFullResync()).resolves.toEqual(result)

    expect(mockApi).toHaveBeenNthCalledWith(1, '/api/v1/audiobookshelf/sync', { method: 'POST' })
    expect(mockApi).toHaveBeenNthCalledWith(2, '/api/v1/audiobookshelf/full-resync', { method: 'POST' })
  })

  it('maps concurrent sync conflicts to a clear message', async () => {
    mockApi.mockResolvedValue(jsonResponse({ message: 'Conflict' }, 409))

    await expect(startAudiobookshelfSync()).rejects.toThrow('An Audiobookshelf sync is already running')
    await expect(startAudiobookshelfFullResync()).rejects.toThrow('An Audiobookshelf sync is already running')
  })
})
