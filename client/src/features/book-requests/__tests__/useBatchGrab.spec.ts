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
})
