import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  forget: vi.fn<(fileId: number) => void>(),
  api: vi.fn<(url: string) => Promise<Response>>(),
  loadPlaylist: vi.fn<() => Promise<unknown>>(),
  attach: vi.fn<(book: unknown, playlist: unknown) => boolean>(),
}))

vi.mock('@/lib/api', () => ({ api: mocks.api, getAccessToken: () => 'token' }))
vi.mock('../media-overlay/lib/media-overlay-playlist', () => ({
  loadMediaOverlayPlaylist: mocks.loadPlaylist,
  forgetMediaOverlayPlaylist: mocks.forget,
}))
vi.mock('../media-overlay/lib/index-narration', () => ({ attachIndexNarration: mocks.attach }))

import { INDEX_NARRATION_WAIT_MS, openStreamingEpub, awaitIndexNarration } from './foliate-loader'

describe('openStreamingEpub', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.attach.mockReturnValue(false)
    mocks.api.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ timingIndexNarration: true }), { status: 200 })))
    Object.assign(window, { makeStreamingBook: () => Promise.resolve({ sections: [], media: {} }) })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('opens the book without index narration when the playlist is slow to come', async () => {
    mocks.loadPlaylist.mockReturnValue(new Promise(() => {}))
    const opened = openStreamingEpub(1, 2)
    await vi.advanceTimersByTimeAsync(INDEX_NARRATION_WAIT_MS)
    await expect(opened).resolves.toMatchObject({ info: { timingIndexNarration: true }, indexNarrationMissing: true })
    expect(mocks.attach).toHaveBeenCalledWith(expect.anything(), null)
  })

  it('waits past the cap for a playlist when asked to', async () => {
    const playlist = { source: 'timing-index' }
    let arrive: (value: unknown) => void = () => {}
    mocks.loadPlaylist.mockReturnValue(new Promise((resolve) => (arrive = resolve)))
    mocks.attach.mockReturnValue(true)
    let settled = false
    const opened = openStreamingEpub(1, 2, { waitForIndexNarration: true }).finally(() => (settled = true))
    await vi.advanceTimersByTimeAsync(INDEX_NARRATION_WAIT_MS * 3)
    expect(settled).toBe(false)
    arrive(playlist)
    await expect(opened).resolves.toMatchObject({ indexNarrationMissing: false })
    expect(mocks.attach).toHaveBeenCalledWith(expect.anything(), playlist)
  })

  it('says nothing is missing for a book that does not read along from an index', async () => {
    mocks.api.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    await expect(openStreamingEpub(1, 2)).resolves.toMatchObject({ indexNarrationMissing: false })
    expect(mocks.loadPlaylist).not.toHaveBeenCalled()
  })

  it('waits for a playlist that did not come, and says whether it did, without an unhandled failure', async () => {
    mocks.loadPlaylist.mockRejectedValueOnce(new Error('offline'))
    await expect(awaitIndexNarration(1, 2)).resolves.toBe(false)
    mocks.loadPlaylist.mockResolvedValueOnce({ source: 'timing-index' })
    await expect(awaitIndexNarration(1, 2)).resolves.toBe(true)
    expect(mocks.loadPlaylist).toHaveBeenCalledWith(1, 2)
  })

  it('keeps the playlist it waited for when reopening for it', async () => {
    mocks.loadPlaylist.mockResolvedValue({ source: 'timing-index' })
    mocks.attach.mockReturnValue(true)
    await openStreamingEpub(1, 2, { keepIndexNarration: true })
    expect(mocks.forget).not.toHaveBeenCalled()
    await openStreamingEpub(1, 2)
    expect(mocks.forget).toHaveBeenCalledWith(2)
  })

  it('reads along from a playlist that comes in time', async () => {
    const playlist = { source: 'timing-index' }
    mocks.loadPlaylist.mockResolvedValue(playlist)
    mocks.attach.mockReturnValue(true)
    await expect(openStreamingEpub(1, 2)).resolves.toMatchObject({ indexNarrationMissing: false })
    expect(mocks.attach).toHaveBeenCalledWith(expect.anything(), playlist)
  })
})
