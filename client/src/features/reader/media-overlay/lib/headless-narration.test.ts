import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openStreamingEpub: vi.fn<(bookId: number, fileId: number, options?: { waitForIndexNarration?: boolean }) => Promise<unknown>>(),
}))

vi.mock('@/features/reader/epub/foliate-loader', () => ({
  loadFoliate: () => Promise.resolve(),
  openStreamingEpub: mocks.openStreamingEpub,
}))
vi.mock('@/features/reader/shared/lib/progress-writer', () => ({
  createNarrationProgressWriter: () => ({ load: () => Promise.resolve(), setMediaOverlayProgress: vi.fn<() => void>(), flush: vi.fn<() => void>() }),
}))
vi.mock('../composables/useNarrationChapters', () => ({ registerNarrationChapters: () => () => {} }))

import { openHeadlessNarration } from './headless-narration'

describe('openHeadlessNarration', () => {
  it('waits for a timing index playlist however long it takes', async () => {
    const mediaOverlay = {}
    mocks.openStreamingEpub.mockResolvedValue({ book: { getMediaOverlay: () => mediaOverlay }, info: {}, indexNarrationMissing: false })
    const book = { bookId: 1, bookFileId: 2, title: 'Book', author: null, coverUrl: null, totalChapters: 3 }

    const opened = await openHeadlessNarration(book, () => {}, false)

    expect(mocks.openStreamingEpub).toHaveBeenCalledWith(1, 2, { waitForIndexNarration: true })
    expect(opened.mediaOverlay).toBe(mediaOverlay)
  })
})
