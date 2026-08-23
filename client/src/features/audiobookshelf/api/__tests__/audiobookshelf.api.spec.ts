import { beforeEach, describe, expect, it, vi } from 'vitest'

type ApiFn = (input: RequestInfo | URL, init?: RequestInit & { _isRetry?: boolean }) => Promise<Response>

vi.mock('@/lib/api', () => ({
  api: vi.fn<ApiFn>(),
}))

import { api } from '@/lib/api'
import {
  confirmAudiobookshelfMatch,
  disconnectAudiobookshelf,
  fetchAudiobookshelfBookStates,
  fetchAudiobookshelfLibraries,
  fetchAudiobookshelfSettings,
  linkAudiobookshelfBook,
  rescanAudiobookshelfMatches,
  searchAudiobookshelfLinkCandidates,
  startAudiobookshelfFullResync,
  startAudiobookshelfSync,
  testAudiobookshelfConnection,
  unlinkAudiobookshelfBook,
  updateAudiobookshelfBookExclusion,
  updateAudiobookshelfSettings,
} from '../audiobookshelf.api'

const mockApi = vi.mocked(api)

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: vi.fn<() => Promise<unknown>>().mockResolvedValue(body),
  } as unknown as Response
}

describe('audiobookshelf.api', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  it('fetches settings and libraries with GET requests', async () => {
    mockApi
      .mockResolvedValueOnce(jsonResponse({ serverUrl: 'https://abs.example.com', tokenConfigured: true }))
      .mockResolvedValueOnce(jsonResponse({ libraries: [{ id: 'lib-1', name: 'Audiobooks' }] }))

    await expect(fetchAudiobookshelfSettings()).resolves.toEqual({ serverUrl: 'https://abs.example.com', tokenConfigured: true })
    await expect(fetchAudiobookshelfLibraries()).resolves.toEqual({ libraries: [{ id: 'lib-1', name: 'Audiobooks' }] })

    expect(mockApi).toHaveBeenNthCalledWith(1, '/api/v1/audiobookshelf/settings')
    expect(mockApi).toHaveBeenNthCalledWith(2, '/api/v1/audiobookshelf/libraries')
  })

  it('updates settings with a PATCH and serialized body', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({ tokenConfigured: true, enabled: true }))

    await expect(updateAudiobookshelfSettings({ apiToken: 'tok', enabled: true })).resolves.toEqual({ tokenConfigured: true, enabled: true })

    expect(mockApi).toHaveBeenCalledWith(
      '/api/v1/audiobookshelf/settings',
      expect.objectContaining({
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiToken: 'tok', enabled: true }),
      }),
    )
  })

  it('disconnects with a DELETE and resolves to undefined', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse(null))

    await expect(disconnectAudiobookshelf()).resolves.toBeUndefined()
    expect(mockApi).toHaveBeenCalledWith('/api/v1/audiobookshelf/settings', { method: 'DELETE' })
  })

  it('tests the connection with a POST body', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({ success: true, username: 'neon' }))

    await expect(testAudiobookshelfConnection({ serverUrl: 'https://abs.example.com', apiToken: 'tok' })).resolves.toEqual({
      success: true,
      username: 'neon',
    })

    expect(mockApi).toHaveBeenCalledWith(
      '/api/v1/audiobookshelf/test-connection',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ serverUrl: 'https://abs.example.com', apiToken: 'tok' }),
      }),
    )
  })

  it('fetches book states with bucket/page/pageSize query params', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({ items: [], total: 0, page: 1, pageSize: 20 }))

    await expect(fetchAudiobookshelfBookStates('needs-review', 1, 20)).resolves.toEqual({ items: [], total: 0, page: 1, pageSize: 20 })

    expect(mockApi).toHaveBeenCalledWith('/api/v1/audiobookshelf/books?bucket=needs-review&page=1&pageSize=20')
  })

  it('includes a q query param when a search term is given', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({ items: [], total: 0, page: 0, pageSize: 20 }))

    await fetchAudiobookshelfBookStates('linked', 0, 20, 'dune')

    expect(mockApi).toHaveBeenCalledWith('/api/v1/audiobookshelf/books?bucket=linked&page=0&pageSize=20&q=dune')
  })

  it('omits the q query param when the search term is empty', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({ items: [], total: 0, page: 0, pageSize: 20 }))

    await fetchAudiobookshelfBookStates('linked', 0, 20, '')

    expect(mockApi).toHaveBeenCalledWith('/api/v1/audiobookshelf/books?bucket=linked&page=0&pageSize=20')
  })

  it('confirms a match and URL-encodes the library item id', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({ absLibraryItemId: 'li/abc' }))

    await expect(confirmAudiobookshelfMatch('li/abc')).resolves.toEqual({ absLibraryItemId: 'li/abc' })
    expect(mockApi).toHaveBeenCalledWith('/api/v1/audiobookshelf/books/li%2Fabc/confirm', { method: 'POST' })
  })

  it('links a book with a PATCH body and encoded id', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({ absLibraryItemId: 'li 1', bookId: 42 }))

    await expect(linkAudiobookshelfBook('li 1', 42)).resolves.toEqual({ absLibraryItemId: 'li 1', bookId: 42 })
    expect(mockApi).toHaveBeenCalledWith(
      '/api/v1/audiobookshelf/books/li%201/link',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ bookId: 42 }) }),
    )
  })

  it('unlinks a book with a DELETE', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({ absLibraryItemId: 'li-1', bookId: null }))

    await expect(unlinkAudiobookshelfBook('li-1')).resolves.toEqual({ absLibraryItemId: 'li-1', bookId: null })
    expect(mockApi).toHaveBeenCalledWith('/api/v1/audiobookshelf/books/li-1/link', { method: 'DELETE' })
  })

  it('updates book exclusion with a PATCH body', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({ absLibraryItemId: 'li-1', syncExcluded: true }))

    await expect(updateAudiobookshelfBookExclusion('li-1', true)).resolves.toEqual({ absLibraryItemId: 'li-1', syncExcluded: true })
    expect(mockApi).toHaveBeenCalledWith(
      '/api/v1/audiobookshelf/books/li-1/exclusion',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ syncExcluded: true }) }),
    )
  })

  it('rescans matches with a POST', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({ queued: 3 }))

    await expect(rescanAudiobookshelfMatches()).resolves.toEqual({ queued: 3 })
    expect(mockApi).toHaveBeenCalledWith('/api/v1/audiobookshelf/books/rescan', { method: 'POST' })
  })

  it('searches link candidates against the shared book search endpoint', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse([{ id: 1, title: 'Dune' }]))

    await expect(searchAudiobookshelfLinkCandidates('dune', 5)).resolves.toEqual([{ id: 1, title: 'Dune' }])
    expect(mockApi).toHaveBeenCalledWith('/api/v1/books/search?q=dune&limit=5')
  })

  it('starts incremental and full syncs with POST requests', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({ matched: 1 })).mockResolvedValueOnce(jsonResponse({ matched: 2 }))

    await expect(startAudiobookshelfSync()).resolves.toEqual({ matched: 1 })
    await expect(startAudiobookshelfFullResync()).resolves.toEqual({ matched: 2 })

    expect(mockApi).toHaveBeenNthCalledWith(1, '/api/v1/audiobookshelf/sync', { method: 'POST' })
    expect(mockApi).toHaveBeenNthCalledWith(2, '/api/v1/audiobookshelf/full-resync', { method: 'POST' })
  })

  it('extracts the server message from a non-ok response body', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({ message: 'Server URL is unreachable' }, false))

    await expect(fetchAudiobookshelfSettings()).rejects.toThrow('Server URL is unreachable')
  })

  it('falls back to the default message when the error body has no message', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({}, false))

    await expect(fetchAudiobookshelfLibraries()).rejects.toThrow('Failed to load Audiobookshelf libraries')
  })

  it('tolerates a non-JSON error body and still throws the fallback', async () => {
    const badBody = {
      ok: false,
      status: 500,
      json: vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error('not json')),
    } as unknown as Response
    mockApi.mockResolvedValueOnce(badBody)

    await expect(disconnectAudiobookshelf()).rejects.toThrow('Failed to disconnect Audiobookshelf')
  })

  it('maps a 409 on sync to the "already running" conflict message', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({}, false, 409))

    await expect(startAudiobookshelfSync()).rejects.toThrow('An Audiobookshelf sync is already running')
  })

  it('maps a 409 on full resync to the conflict message', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({}, false, 409))

    await expect(startAudiobookshelfFullResync()).rejects.toThrow('An Audiobookshelf sync is already running')
  })

  it('does not apply the conflict message to endpoints without one', async () => {
    mockApi.mockResolvedValueOnce(jsonResponse({}, false, 409))

    await expect(fetchAudiobookshelfSettings()).rejects.toThrow('Failed to load Audiobookshelf settings')
  })
})
