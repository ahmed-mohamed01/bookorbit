import { describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useBatchGrab } from '../composables/useBatchGrab'
vi.mock('@/lib/api', () => ({ api: vi.fn<(...args: [RequestInfo | URL, RequestInit?]) => Promise<Response>>() }))
describe('useBatchGrab', () => {
  it('sends exactly the payload fields', async () => {
    vi.mocked(api).mockResolvedValue(new Response(JSON.stringify({ requestId: 99 })))
    const batch = useBatchGrab(() => false)
    expect(await batch.send({ sourceRequestId: 1, indexerId: 2, releaseGuid: 'guid', downloadClientId: 3, unitIndexes: [0] })).toBe(99)
    const [url, options] = vi.mocked(api).mock.calls[0]!
    expect(url).toBe('/api/v1/book-request-fulfilment/batch')
    expect(Object.keys(JSON.parse(options!.body as string))).toEqual([
      'sourceRequestId',
      'indexerId',
      'releaseGuid',
      'downloadClientId',
      'unitIndexes',
    ])
  })

  it('retries through the admin route for a moderator and the fulfilment route otherwise', async () => {
    vi.mocked(api).mockClear()
    vi.mocked(api).mockResolvedValue(new Response('{}'))

    expect(await useBatchGrab(() => true).retry(7)).toBeNull()
    expect(await useBatchGrab(() => false).retry(8)).toBeNull()

    const calls = vi.mocked(api).mock.calls
    expect(calls[0]).toEqual(['/api/v1/admin/book-requests/batch/7/retry', { method: 'POST' }])
    expect(calls[1]).toEqual(['/api/v1/book-request-fulfilment/batch/8/retry', { method: 'POST' }])
  })

  it('resolves to the server message when the retry is refused', async () => {
    vi.mocked(api).mockResolvedValue(new Response(JSON.stringify({ message: 'Only a failed batch can be retried.' }), { status: 400 }))

    expect(await useBatchGrab(() => true).retry(7)).toBe('Only a failed batch can be retried.')
  })
})
