import { beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'
import {
  cancelVolumeRequest,
  createVolumeRequest,
  fetchBookRequest,
  fetchPublishedRequests,
  fetchRequestReleases,
  fetchRequestSourceStatus,
  grabRequestRelease,
  recordPublishedRequest,
} from '../api/bookRequests'
import { messageOf } from '../lib/messageOf'

const http = vi.hoisted(() => ({ api: vi.fn<(input: string, init?: RequestInit) => Promise<Response>>() }))

vi.mock('@/lib/api', () => http)

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  http.api.mockReset()
})

describe('Book Requests calls from Web Serials', () => {
  it('reads the source status from the existing route', async () => {
    http.api.mockResolvedValue(respond({ configured: 1, enabled: 1 }))
    await expect(fetchRequestSourceStatus()).resolves.toEqual({ configured: 1, enabled: 1 })
    expect(http.api).toHaveBeenCalledWith('/api/v1/book-requests/source-status', undefined)
  })

  it('reads one request by id and treats 404 and 403 as not requested', async () => {
    http.api.mockResolvedValueOnce(respond({ id: 7, status: 'pending' }))
    await expect(fetchBookRequest(7)).resolves.toMatchObject({ id: 7 })
    expect(http.api).toHaveBeenLastCalledWith('/api/v1/book-requests/7')

    http.api.mockResolvedValueOnce(respond({ message: 'gone' }, 404))
    await expect(fetchBookRequest(8)).resolves.toBeNull()
    http.api.mockResolvedValueOnce(respond({ message: 'no' }, 403))
    await expect(fetchBookRequest(9)).resolves.toBeNull()
    http.api.mockResolvedValueOnce(respond({ message: 'boom' }, 500))
    await expect(fetchBookRequest(10)).rejects.toMatchObject({ status: 500 })
  })

  it('reads and records the Web Serials own record, never scanning the request list', async () => {
    http.api.mockResolvedValueOnce(respond([{ volume: '2', bookRequestId: 7 }]))
    await expect(fetchPublishedRequests('novel', '1234')).resolves.toEqual([{ volume: '2', bookRequestId: 7 }])
    const url = new URL(http.api.mock.calls[0]![0], 'http://x')
    expect(url.pathname).toBe('/api/v1/web-serials/published-requests')
    expect(Object.fromEntries(url.searchParams)).toEqual({ kind: 'novel', matchId: '1234' })

    http.api.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await recordPublishedRequest({ kind: 'novel', matchId: '1234', volume: '2', bookRequestId: 7 })
    const [path, init] = http.api.mock.calls[1]!
    expect(path).toBe('/api/v1/web-serials/published-requests')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ kind: 'novel', matchId: '1234', volume: '2', bookRequestId: 7 })
    expect(http.api.mock.calls.every(([called]) => !String(called).startsWith('/api/v1/book-requests?'))).toBe(true)
  })

  it('posts a volume request and translates a coded refusal', async () => {
    http.api.mockResolvedValueOnce(respond({ request: { id: 3 }, subscribed: false }))
    await expect(createVolumeRequest({ title: 'A Vol. 1', mediaKind: 'ebook' })).resolves.toEqual({ request: { id: 3 }, subscribed: false })
    const [path, init] = http.api.mock.calls[0]!
    expect(path).toBe('/api/v1/book-requests')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ title: 'A Vol. 1', mediaKind: 'ebook' })

    http.api.mockResolvedValueOnce(respond({ message: 'english', errorCode: 'SUBMIT_DESTINATION_REQUIRED' }, 400))
    await expect(createVolumeRequest({ title: 'A Vol. 2', mediaKind: 'ebook' })).rejects.toMatchObject({
      message: i18n.global.t('bookRequests.submitError.SUBMIT_DESTINATION_REQUIRED'),
      status: 400,
    })
  })

  it('searches and grabs through the admin request routes', async () => {
    http.api.mockResolvedValueOnce(respond({ releases: [] }))
    await fetchRequestReleases(41)
    expect(http.api).toHaveBeenLastCalledWith('/api/v1/admin/book-requests/41/releases', undefined)

    http.api.mockResolvedValueOnce(respond({ id: 41, status: 'grabbed' }))
    await expect(grabRequestRelease(41, 2, 'guid-1')).resolves.toMatchObject({ status: 'grabbed' })
    const [path, init] = http.api.mock.calls[1]!
    expect(path).toBe('/api/v1/admin/book-requests/41/grab')
    expect(JSON.parse(init?.body as string)).toEqual({ indexerId: 2, releaseGuid: 'guid-1' })
  })

  it('shows the tracker refusal of a grab, the way the Requests page does', async () => {
    http.api.mockResolvedValueOnce(respond({ message: 'Tracker refused: ratio too low', errorCode: 'GRAB_SOURCE_REFUSED' }, 502))
    const refusal = await grabRequestRelease(41, 2, 'g').catch((cause: unknown) => cause)

    expect(refusal).toMatchObject({ status: 502, errorCode: 'GRAB_SOURCE_REFUSED' })
    expect(messageOf(refusal, 'webSerials.api.grab')).toBe('Tracker refused: ratio too low')
  })

  it('shows an uncoded grab refusal verbatim and falls back only when the server said nothing', async () => {
    http.api.mockResolvedValueOnce(respond({ message: 'A request that is pending cannot be sent to a download client' }, 400))
    const refusal = await grabRequestRelease(41, 2, 'g').catch((cause: unknown) => cause)
    expect(messageOf(refusal, 'webSerials.api.grab')).toBe('A request that is pending cannot be sent to a download client')

    http.api.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))
    const silent = await grabRequestRelease(41, 2, 'g').catch((cause: unknown) => cause)
    expect(messageOf(silent, 'webSerials.api.grab')).toBe(i18n.global.t('webSerials.api.grab'))
  })

  it('cancels through the requester route and translates a coded refusal', async () => {
    http.api.mockResolvedValueOnce(respond({ id: 7, status: 'cancelled' }))
    await expect(cancelVolumeRequest(7)).resolves.toMatchObject({ status: 'cancelled' })
    const [path, init] = http.api.mock.calls[0]!
    expect(path).toBe('/api/v1/book-requests/7/cancel')
    expect(init?.method).toBe('POST')

    http.api.mockResolvedValueOnce(
      respond({ message: 'english', errorCode: 'BOOK_REQUEST_NOT_CANCELLABLE', errorMeta: { status: 'completed' } }, 409),
    )
    const refusal = await cancelVolumeRequest(7).catch((cause: unknown) => cause)
    expect(messageOf(refusal, 'webSerials.api.cancelRequest')).toBe(
      i18n.global.t('bookRequests.actionError.BOOK_REQUEST_NOT_CANCELLABLE', { status: 'completed' }),
    )
  })

  it('shows the download client refusal of a cancel verbatim', async () => {
    http.api.mockResolvedValueOnce(respond({ message: 'Download client refused: torrent is locked', errorCode: 'GRAB_CLIENT_REFUSED' }, 502))
    const refusal = await cancelVolumeRequest(7).catch((cause: unknown) => cause)

    expect(messageOf(refusal, 'webSerials.api.cancelRequest')).toBe('Download client refused: torrent is locked')
  })
})

describe('Book Requests calls from Web Serials stay inside the feature', () => {
  it('reads refusals with its own code, not the Book Requests feature internals', async () => {
    const source = (await import('../api/bookRequests.ts?raw')).default
    expect(source).not.toContain('@/features/book-requests')
  })

  it('falls back to the server sentence for an uncoded refused create', async () => {
    http.api.mockResolvedValue(respond({ message: ['title must be shorter'] }, 400))
    await expect(createVolumeRequest({} as never)).rejects.toMatchObject({ message: 'title must be shorter', errorCode: null })
  })
})
