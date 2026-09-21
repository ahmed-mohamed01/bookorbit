import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { BookRequestItem, MonitoredBookItem, MonitoredReleaseDateLookup } from '@bookorbit/types'
import { createMonitoredBook, fetchWorkReleaseDateCandidates, grabWorkRelease, refreshWorkReleaseDates, setWorkReleaseDate } from './monitored'

vi.mock('@/lib/api', () => ({ api: vi.fn<(...args: unknown[]) => unknown>() }))

const mockedApi = vi.mocked(api)

function mockOkResponse(data: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(data) } as Response
}

function mockErrorResponse(status = 500, message?: string): Response {
  return { ok: false, status, json: () => Promise.resolve(message ? { message } : {}) } as Response
}

function bookItem(): MonitoredBookItem {
  return {
    id: 'book-1',
    ownerUserId: 1,
    monitorAuthorId: 'author-1',
    workId: 'work-1',
    formats: ['ebook'],
    paused: false,
    addedAt: '2026-01-01',
    isOwner: true,
    authorName: 'A Writer',
    work: {
      id: 'work-1',
      title: 'A Book',
      subtitle: null,
      seriesName: null,
      seriesIndex: null,
      seriesMemberships: [],
      releaseYear: null,
      ebookReleaseDate: null,
      ebookDatePrecision: null,
      audioReleaseDate: null,
      audioDatePrecision: null,
      coverUrl: null,
      description: null,
      verdict: 'verified',
      flags: [],
      sources: [],
      providerWorkIds: {},
      monitorState: 'monitoring',
      matchedBookId: null,
      ownedFormats: [],
      requestIds: {},
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createMonitoredBook', () => {
  it('POSTs exactly monitorAuthorId, workId, and formats to /monitored/books', async () => {
    const data = bookItem()
    mockedApi.mockResolvedValue(mockOkResponse(data))

    const result = await createMonitoredBook({ monitorAuthorId: 'author-1', workId: 'work-1', formats: ['ebook', 'audiobook'] })

    expect(mockedApi).toHaveBeenCalledWith(
      '/api/v1/monitored/books',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monitorAuthorId: 'author-1', workId: 'work-1', formats: ['ebook', 'audiobook'] }),
      }),
    )
    expect(result).toEqual(data)
  })

  it('does not send any field beyond the DTO shape', async () => {
    mockedApi.mockResolvedValue(mockOkResponse(bookItem()))

    await createMonitoredBook({ monitorAuthorId: 'author-1', workId: 'work-1', formats: ['ebook'] })

    const [, init] = mockedApi.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['formats', 'monitorAuthorId', 'workId'])
  })

  it('throws with the server message on a non-ok response', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse(400, 'This author is already monitored'))

    await expect(createMonitoredBook({ monitorAuthorId: 'author-1', workId: 'work-1', formats: ['ebook'] })).rejects.toThrow(
      'This author is already monitored',
    )
  })
})

describe('grabWorkRelease', () => {
  it('returns the book request the grab runs under, so the caller can open its progress', async () => {
    const grabbed = { id: 4242, status: 'grabbed' } as BookRequestItem
    mockedApi.mockResolvedValue(mockOkResponse(grabbed))

    const result = await grabWorkRelease('work-1', { format: 'ebook', indexerId: 7, releaseGuid: 'release-1' })

    expect(mockedApi).toHaveBeenCalledWith(
      '/api/v1/monitored/works/work-1/releases/grab',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'ebook', indexerId: 7, releaseGuid: 'release-1' }),
      }),
    )
    expect(result.id).toBe(4242)
  })

  it('throws with the server message on a non-ok response', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse(400, 'Another release is already being sent for this request'))

    await expect(grabWorkRelease('work-1', { format: 'ebook', indexerId: 7, releaseGuid: 'release-1' })).rejects.toThrow(
      'Another release is already being sent for this request',
    )
  })
})

describe('release date lookup and choice', () => {
  const lookup: MonitoredReleaseDateLookup = {
    format: 'ebook',
    candidates: [{ source: 'apple', releaseDate: '2026-07-15', precision: 'day', label: 'Kindle, Orbit', weak: false, url: null }],
    unavailable: [{ source: 'audible', reason: 'not_configured' }],
    empty: ['hardcover_edition'],
  }

  it('asks the providers what they have for one format of one work', async () => {
    mockedApi.mockResolvedValue(mockOkResponse(lookup))

    const result = await fetchWorkReleaseDateCandidates('author:1:work:2', 'ebook')

    expect(mockedApi).toHaveBeenCalledWith('/api/v1/monitored/works/author%3A1%3Awork%3A2/release-dates/ebook/candidates')
    expect(result).toEqual(lookup)
  })

  it('PUTs only the release date and answers with the fresh work', async () => {
    const work = bookItem().work
    mockedApi.mockResolvedValue(mockOkResponse(work))

    const result = await setWorkReleaseDate('work-1', 'audiobook', '2026-11-03')

    expect(mockedApi).toHaveBeenCalledWith(
      '/api/v1/monitored/works/work-1/release-dates/audiobook',
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ releaseDate: '2026-11-03' }),
      }),
    )
    expect(result).toEqual(work)
  })

  it('sends a null date to hand the format back to the automatic check', async () => {
    mockedApi.mockResolvedValue(mockOkResponse(bookItem().work))

    await setWorkReleaseDate('work-1', 'ebook', null)

    const [, init] = mockedApi.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ releaseDate: null })
  })

  it('POSTs the re-check and answers with the fresh work', async () => {
    const work = bookItem().work
    mockedApi.mockResolvedValue(mockOkResponse(work))

    const result = await refreshWorkReleaseDates('work-1')

    expect(mockedApi).toHaveBeenCalledWith('/api/v1/monitored/works/work-1/release-dates/refresh', expect.objectContaining({ method: 'POST' }))
    expect(result).toEqual(work)
  })

  it('carries the status of a refused re-check so the caller can name it', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse(429))

    await expect(refreshWorkReleaseDates('work-1')).rejects.toMatchObject({ status: 429 })
  })

  it('throws with the server message when a date is refused', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse(400, 'releaseDate must be a valid date'))

    await expect(setWorkReleaseDate('work-1', 'ebook', 'nope')).rejects.toThrow('releaseDate must be a valid date')
  })
})
