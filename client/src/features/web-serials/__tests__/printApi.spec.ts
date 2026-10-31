import type { api } from '@/lib/api'
import { beforeEach, expect, it, vi } from 'vitest'
const http = vi.hoisted(() => ({ api: vi.fn<typeof api>() }))
vi.mock('@/lib/api', () => http)
import { fetchPrintState, requestPrintVolumes } from '../api/webSerials'
const input = { title: 'Story', altTitles: [], authors: [], url: 'https://example.com', volumeCount: 2 }
const state = { seriesRequestId: 3, bookRequestId: 99, volumes: [] }
beforeEach(() => {
  http.api.mockReset()
})
it('posts the print-state DTO and preserves both request ids', async () => {
  http.api.mockResolvedValue(new Response(JSON.stringify(state)))
  expect(await fetchPrintState('a/b', input)).toEqual(state)
  expect(http.api).toHaveBeenCalledWith(
    '/api/v1/web-serials/novel/a%2Fb/print-state',
    expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
  )
})
it('posts only the volume request fields', async () => {
  http.api.mockResolvedValue(new Response(JSON.stringify(state)))
  await requestPrintVolumes('12', { ...input, volumes: [1] })
  expect(http.api).toHaveBeenCalledWith(
    '/api/v1/web-serials/novel/12/series-request',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ ...input, volumes: [1] }) }),
  )
})
it('maps server refusals through the Web Serials error mapper', async () => {
  http.api.mockResolvedValue(new Response(JSON.stringify({ errorCode: 'UNKNOWN', message: 'Refused' }), { status: 403 }))
  await expect(fetchPrintState('12', input)).rejects.toMatchObject({ status: 403, errorCode: 'UNKNOWN', serverMessage: 'Refused' })
})
