import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { BookRequestItem, MonitoredBookItem, MonitoredReleaseDateLookup } from '@bookorbit/types'
import {
  bulkRequestMonitoredWorks,
  bulkUpdateMonitoredWorks,
  fetchMonitoredAuthorDetail,
  fetchMonitoredReleases,
  fetchWorkReleaseDateCandidates,
  grabWorkRelease,
  refreshWorkReleaseDates,
  setWorkReleaseDate,
} from './monitored'

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

describe('status filters', () => {
  it('joins a typed selection into the canonical query value for the release list', async () => {
    mockedApi.mockResolvedValue(mockOkResponse({}))

    await fetchMonitoredReleases({ page: 0, size: 24, sort: 'date', order: 'asc', filter: 'all', status: ['upcoming', 'missing'] })

    expect(String(mockedApi.mock.calls[0]?.[0])).toContain('status=missing%2Cupcoming')
  })

  it('leaves the status out when no selection is sent', async () => {
    mockedApi.mockResolvedValue(mockOkResponse({}))

    await fetchMonitoredReleases({ page: 0, size: 24, sort: 'date', order: 'asc', filter: 'all' })

    expect(String(mockedApi.mock.calls[0]?.[0])).not.toContain('status=')
  })

  it('joins the selection for an author page too', async () => {
    mockedApi.mockResolvedValue(mockOkResponse({}))

    await fetchMonitoredAuthorDetail('author-1', { sort: 'releaseDate', order: 'asc', status: ['upcoming', 'hidden'] })

    expect(String(mockedApi.mock.calls[0]?.[0])).toContain('status=upcoming%2Chidden')
  })
})

describe('bulk work calls', () => {
  it('POSTs the ids, format and auto-grab choice to the bulk request route', async () => {
    const response = { results: [], works: [] }
    mockedApi.mockResolvedValue(mockOkResponse(response))

    const result = await bulkRequestMonitoredWorks({ workIds: ['w1', 'w2'], format: 'both', autoDownload: true })

    expect(mockedApi).toHaveBeenCalledWith(
      '/api/v1/monitored/works/bulk-request',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workIds: ['w1', 'w2'], format: 'both', autoDownload: true }),
      }),
    )
    expect(result).toEqual(response)
  })

  it('PATCHes one patch over many works', async () => {
    mockedApi.mockResolvedValue(mockOkResponse({ works: [], failed: [] }))

    await bulkUpdateMonitoredWorks({ workIds: ['w1'], patch: { hidden: true } })

    expect(mockedApi).toHaveBeenCalledWith(
      '/api/v1/monitored/works/bulk',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ workIds: ['w1'], patch: { hidden: true } }) }),
    )
  })

  it('throws with the server message on a refused bulk request', async () => {
    mockedApi.mockResolvedValue(mockErrorResponse(400, 'too many works'))

    await expect(bulkRequestMonitoredWorks({ workIds: [], format: 'ebook' })).rejects.toThrow('too many works')
  })
})
