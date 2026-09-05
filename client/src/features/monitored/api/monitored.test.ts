import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { BookRequestItem, MonitoredBookItem } from '@bookorbit/types'
import { createMonitoredBook, grabWorkRelease } from './monitored'

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
    isShared: false,
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
