import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => vi.fn<(url: string) => Promise<Response>>())
vi.mock('@/lib/api', () => ({ api }))

import { forgetMediaOverlayPlaylist, loadMediaOverlayPlaylist } from './media-overlay-playlist'

const playlist = { bookId: 1, fileId: 2, items: [] }
const ok = () => Promise.resolve(new Response(JSON.stringify(playlist), { status: 200 }))
const notFound = () => Promise.resolve(new Response('', { status: 404 }))

describe('loadMediaOverlayPlaylist', () => {
  beforeEach(() => {
    api.mockReset()
    forgetMediaOverlayPlaylist(2)
  })

  it('serves every reader of a book from one request', async () => {
    api.mockImplementation(ok)
    await expect(loadMediaOverlayPlaylist(1, 2)).resolves.toEqual(playlist)
    await expect(loadMediaOverlayPlaylist(1, 2)).resolves.toEqual(playlist)
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('asks again after the server gave no playlist', async () => {
    api.mockImplementationOnce(notFound).mockImplementation(ok)
    await expect(loadMediaOverlayPlaylist(1, 2)).resolves.toBeNull()
    await expect(loadMediaOverlayPlaylist(1, 2)).resolves.toEqual(playlist)
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('asks again after a request that failed', async () => {
    api.mockImplementationOnce(() => Promise.reject(new Error('offline'))).mockImplementation(ok)
    await expect(loadMediaOverlayPlaylist(1, 2)).rejects.toThrow('offline')
    await expect(loadMediaOverlayPlaylist(1, 2)).resolves.toEqual(playlist)
  })

  it('asks again once the playlist is forgotten', async () => {
    api.mockImplementation(ok)
    await loadMediaOverlayPlaylist(1, 2)
    forgetMediaOverlayPlaylist(2)
    await loadMediaOverlayPlaylist(1, 2)
    expect(api).toHaveBeenCalledTimes(2)
  })
})
