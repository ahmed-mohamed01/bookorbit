import { flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Permission, type AudiobookshelfBookSyncLink, type AudiobookshelfBookSyncLive } from '@bookorbit/types'

const apiMocks = vi.hoisted(() => ({
  fetchAudiobookshelfSyncLink: vi.fn<(bookId: number) => Promise<AudiobookshelfBookSyncLink | null>>(),
  fetchAudiobookshelfSyncLive: vi.fn<(absLibraryItemId: string) => Promise<AudiobookshelfBookSyncLive>>(),
}))
vi.mock('@/features/audiobookshelf/api/audiobookshelf.api', () => apiMocks)

const permissionMocks = vi.hoisted(() => ({ hasPermission: vi.fn<(name: string) => boolean>() }))
vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: permissionMocks.hasPermission }),
}))

import { useAudiobookshelfSyncLink } from '../useAudiobookshelfSyncLink'

function makeLink(overrides: Partial<AudiobookshelfBookSyncLink> = {}): AudiobookshelfBookSyncLink {
  return {
    audioBookId: 20,
    absLibraryItemId: 'abs-1',
    title: 'Dune',
    authorName: null,
    libraryName: 'Fiction',
    direction: 'two_way',
    webUrl: null,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const synced: AudiobookshelfBookSyncLive = { status: 'synced', progress: { percentage: 3, isFinished: false, lastUpdate: 1 } }

describe('useAudiobookshelfSyncLink', () => {
  beforeEach(() => {
    apiMocks.fetchAudiobookshelfSyncLink.mockReset()
    apiMocks.fetchAudiobookshelfSyncLive.mockReset()
    permissionMocks.hasPermission.mockReset()
    permissionMocks.hasPermission.mockReturnValue(true)
  })

  it('loads the link, then its live status, and follows a changed audiobook', async () => {
    apiMocks.fetchAudiobookshelfSyncLink.mockResolvedValueOnce(makeLink())
    apiMocks.fetchAudiobookshelfSyncLive.mockResolvedValueOnce(synced)
    const bookId = ref<number | null>(20)
    const { link, live, checking } = useAudiobookshelfSyncLink(bookId)
    await flushPromises()

    expect(apiMocks.fetchAudiobookshelfSyncLink).toHaveBeenCalledWith(20)
    expect(apiMocks.fetchAudiobookshelfSyncLive).toHaveBeenCalledWith('abs-1')
    expect(link.value).toEqual(makeLink())
    expect(live.value).toEqual(synced)
    expect(checking.value).toBe(false)

    apiMocks.fetchAudiobookshelfSyncLink.mockResolvedValue(null)
    bookId.value = 21
    await nextTick()
    await flushPromises()

    expect(apiMocks.fetchAudiobookshelfSyncLink).toHaveBeenLastCalledWith(21)
    expect(link.value).toBeNull()
    expect(live.value).toBeNull()
  })

  it('asks nothing without the Audiobookshelf sync permission or an audiobook', async () => {
    permissionMocks.hasPermission.mockImplementation((name) => name !== Permission.AudiobookshelfSync)
    const { link: withoutPermission } = useAudiobookshelfSyncLink(ref(20))
    const { link: withoutBook } = useAudiobookshelfSyncLink(ref(null))
    await flushPromises()

    expect(apiMocks.fetchAudiobookshelfSyncLink).not.toHaveBeenCalled()
    expect(withoutPermission.value).toBeNull()
    expect(withoutBook.value).toBeNull()
  })

  it('keeps the link and reports Audiobookshelf unreachable when the live check fails', async () => {
    apiMocks.fetchAudiobookshelfSyncLink.mockResolvedValue(makeLink())
    apiMocks.fetchAudiobookshelfSyncLive
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockRejectedValueOnce(new Error('Failed to check Audiobookshelf'))
    const thrown = useAudiobookshelfSyncLink(ref(20))
    const failed = useAudiobookshelfSyncLink(ref(20))
    await flushPromises()

    for (const result of [thrown, failed]) {
      expect(result.link.value).toEqual(makeLink())
      expect(result.live.value).toEqual({ status: 'unreachable', progress: null })
      expect(result.checking.value).toBe(false)
    }
  })

  it('shows nothing when the link lookup fails', async () => {
    apiMocks.fetchAudiobookshelfSyncLink.mockRejectedValue(new Error('offline'))
    const { link, live, checking } = useAudiobookshelfSyncLink(ref(20))
    await flushPromises()

    expect(link.value).toBeNull()
    expect(live.value).toBeNull()
    expect(checking.value).toBe(false)
  })

  it('clears the previous link as soon as the audiobook changes', async () => {
    apiMocks.fetchAudiobookshelfSyncLink.mockResolvedValueOnce(makeLink()).mockReturnValueOnce(new Promise(() => {}))
    apiMocks.fetchAudiobookshelfSyncLive.mockResolvedValue(synced)
    const bookId = ref<number | null>(20)
    const { link, live } = useAudiobookshelfSyncLink(bookId)
    await flushPromises()
    expect(link.value).not.toBeNull()

    bookId.value = 21
    await nextTick()
    expect(link.value).toBeNull()
    expect(live.value).toBeNull()
  })

  it('drops a late link from the previous audiobook and keeps none when the new lookup fails', async () => {
    const linkA = deferred<AudiobookshelfBookSyncLink | null>()
    const linkB = deferred<AudiobookshelfBookSyncLink | null>()
    apiMocks.fetchAudiobookshelfSyncLink.mockReturnValueOnce(linkA.promise).mockReturnValueOnce(linkB.promise)
    apiMocks.fetchAudiobookshelfSyncLive.mockResolvedValue(synced)
    const bookId = ref<number | null>(20)
    const { link, live } = useAudiobookshelfSyncLink(bookId)

    bookId.value = 21
    await nextTick()
    linkA.resolve(makeLink())
    await flushPromises()
    expect(link.value).toBeNull()
    expect(apiMocks.fetchAudiobookshelfSyncLive).not.toHaveBeenCalled()

    linkB.reject(new Error('offline'))
    await flushPromises()
    expect(link.value).toBeNull()
    expect(live.value).toBeNull()
  })

  it('drops a late live status from the previous audiobook', async () => {
    const liveA = deferred<AudiobookshelfBookSyncLive>()
    const liveB = deferred<AudiobookshelfBookSyncLive>()
    const linkB = makeLink({ audioBookId: 21, absLibraryItemId: 'abs-2' })
    apiMocks.fetchAudiobookshelfSyncLink.mockResolvedValueOnce(makeLink()).mockResolvedValueOnce(linkB)
    apiMocks.fetchAudiobookshelfSyncLive.mockReturnValueOnce(liveA.promise).mockReturnValueOnce(liveB.promise)
    const bookId = ref<number | null>(20)
    const { link, live, checking } = useAudiobookshelfSyncLink(bookId)
    await flushPromises()

    bookId.value = 21
    await nextTick()
    await flushPromises()
    liveA.resolve({ status: 'receiving', progress: null })
    await flushPromises()
    expect(link.value).toEqual(linkB)
    expect(live.value).toBeNull()
    expect(checking.value).toBe(true)

    liveB.resolve(synced)
    await flushPromises()
    expect(live.value).toEqual(synced)
    expect(checking.value).toBe(false)
  })

  it('refreshes the live status on request while keeping the last one on screen', async () => {
    apiMocks.fetchAudiobookshelfSyncLink.mockResolvedValue(makeLink())
    apiMocks.fetchAudiobookshelfSyncLive.mockResolvedValueOnce(synced)
    const { live, checking, refreshLive } = useAudiobookshelfSyncLink(ref(20))
    await flushPromises()
    expect(live.value).toEqual(synced)

    const next = deferred<AudiobookshelfBookSyncLive>()
    apiMocks.fetchAudiobookshelfSyncLive.mockReturnValueOnce(next.promise)
    refreshLive()
    await nextTick()
    expect(checking.value).toBe(false)
    expect(live.value).toEqual(synced)

    const newer: AudiobookshelfBookSyncLive = { status: 'receiving', progress: { percentage: 9, isFinished: false, lastUpdate: 2 } }
    next.resolve(newer)
    await flushPromises()
    expect(apiMocks.fetchAudiobookshelfSyncLive).toHaveBeenLastCalledWith('abs-1')
    expect(live.value).toEqual(newer)
  })

  it('does nothing on refresh before a link is known', async () => {
    apiMocks.fetchAudiobookshelfSyncLink.mockResolvedValue(null)
    const { refreshLive } = useAudiobookshelfSyncLink(ref(20))
    await flushPromises()
    refreshLive()
    await flushPromises()
    expect(apiMocks.fetchAudiobookshelfSyncLive).not.toHaveBeenCalled()
  })
})
