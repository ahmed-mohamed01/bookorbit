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
    syncing: true,
    pausedReason: null,
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

const synced: AudiobookshelfBookSyncLive = {
  status: 'synced',
  progress: { percentage: 3, isFinished: false, lastUpdate: 1 },
  local: null,
  divergedReason: null,
}

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
      expect(result.live.value).toEqual({ status: 'unreachable', progress: null, local: null, divergedReason: null })
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
    liveA.resolve({ status: 'receiving', progress: null, local: null, divergedReason: null })
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

    const newer: AudiobookshelfBookSyncLive = {
      status: 'receiving',
      progress: { percentage: 9, isFinished: false, lastUpdate: 2 },
      local: null,
      divergedReason: null,
    }
    next.resolve(newer)
    await flushPromises()
    expect(apiMocks.fetchAudiobookshelfSyncLive).toHaveBeenLastCalledWith('abs-1')
    expect(live.value).toEqual(newer)
  })

  it('settles a refresh when its answer lands, and also when the audiobook changed before it did', async () => {
    apiMocks.fetchAudiobookshelfSyncLink.mockResolvedValue(makeLink())
    apiMocks.fetchAudiobookshelfSyncLive.mockResolvedValueOnce(synced)
    const bookId = ref<number | null>(20)
    const { live, refreshLive } = useAudiobookshelfSyncLink(bookId)
    await flushPromises()

    const answered = deferred<AudiobookshelfBookSyncLive>()
    apiMocks.fetchAudiobookshelfSyncLive.mockReturnValueOnce(answered.promise)
    let settled = false
    const first = refreshLive().then(() => (settled = true))
    await flushPromises()
    expect(settled).toBe(false)
    answered.resolve(synced)
    await first
    expect(settled).toBe(true)

    const superseded = deferred<AudiobookshelfBookSyncLive>()
    apiMocks.fetchAudiobookshelfSyncLive.mockReturnValueOnce(superseded.promise)
    const second = refreshLive()
    apiMocks.fetchAudiobookshelfSyncLink.mockResolvedValue(null)
    bookId.value = 21
    await nextTick()
    superseded.resolve({ ...synced, status: 'receiving' })
    await second
    expect(live.value).toBeNull()
  })

  it('applies a status the server already answered with, without asking again', async () => {
    apiMocks.fetchAudiobookshelfSyncLink.mockResolvedValue(makeLink())
    apiMocks.fetchAudiobookshelfSyncLive.mockResolvedValueOnce(synced)
    const { live, applyLive } = useAudiobookshelfSyncLink(ref(20))
    await flushPromises()
    const diverged: AudiobookshelfBookSyncLive = { ...synced, status: 'diverged', divergedReason: 'stale' }

    applyLive(diverged)

    expect(live.value).toEqual(diverged)
    expect(apiMocks.fetchAudiobookshelfSyncLive).toHaveBeenCalledTimes(1)
  })

  it('reports a failed retry as a new unreachable answer', async () => {
    apiMocks.fetchAudiobookshelfSyncLink.mockResolvedValue(makeLink())
    apiMocks.fetchAudiobookshelfSyncLive.mockRejectedValue(new Error('down'))
    const { live, refreshLive } = useAudiobookshelfSyncLink(ref(20))
    await flushPromises()
    const first = live.value

    refreshLive()
    await flushPromises()

    expect(live.value).toEqual(first)
    expect(live.value).not.toBe(first)
  })

  it('passes a paused match through with its reason and never asks Audiobookshelf for its live status', async () => {
    const paused = makeLink({ syncing: false, pausedReason: 'excluded' })
    apiMocks.fetchAudiobookshelfSyncLink.mockResolvedValue(paused)
    const { link, live, checking, refreshLive } = useAudiobookshelfSyncLink(ref(20))
    await flushPromises()
    refreshLive()
    await flushPromises()

    expect(link.value).toEqual(paused)
    expect(live.value).toBeNull()
    expect(checking.value).toBe(false)
    expect(apiMocks.fetchAudiobookshelfSyncLive).not.toHaveBeenCalled()
  })

  it('reloads the match for the same audiobook, keeping the current one on screen until it answers', async () => {
    apiMocks.fetchAudiobookshelfSyncLink.mockResolvedValueOnce(makeLink({ syncing: false, pausedReason: 'excluded' }))
    const { link, live, reload } = useAudiobookshelfSyncLink(ref(20))
    await flushPromises()

    const next = deferred<AudiobookshelfBookSyncLink | null>()
    apiMocks.fetchAudiobookshelfSyncLink.mockReturnValueOnce(next.promise)
    apiMocks.fetchAudiobookshelfSyncLive.mockResolvedValueOnce(synced)
    const reloading = reload()
    await nextTick()
    expect(link.value?.syncing).toBe(false)

    next.resolve(makeLink())
    await reloading
    await flushPromises()
    expect(apiMocks.fetchAudiobookshelfSyncLink).toHaveBeenLastCalledWith(20)
    expect(link.value).toEqual(makeLink())
    expect(live.value).toEqual(synced)
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
