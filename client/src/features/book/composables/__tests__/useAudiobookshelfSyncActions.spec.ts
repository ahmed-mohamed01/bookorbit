import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import type {
  AudiobookshelfBookState,
  AudiobookshelfBookStatePage,
  AudiobookshelfBookSyncLink,
  AudiobookshelfBookSyncLive,
  AudiobookshelfReconcileDirection,
} from '@bookorbit/types'
import { AudiobookshelfReconcileError } from '@/features/audiobookshelf/api/audiobookshelf.api'
import { useAudiobookshelfSyncActions, type AudiobookshelfSyncHandle } from '../useAudiobookshelfSyncActions'

const toastMocks = vi.hoisted(() => ({ success: vi.fn<(message: string) => void>(), error: vi.fn<(message: string) => void>() }))
vi.mock('vue-sonner', () => ({ toast: toastMocks }))

const apiMocks = vi.hoisted(() => ({
  reconcile: vi.fn<(id: string, direction: AudiobookshelfReconcileDirection) => Promise<AudiobookshelfBookSyncLive>>(),
  exclusion: vi.fn<(id: string, excluded: boolean) => Promise<AudiobookshelfBookState>>(),
  confirm: vi.fn<(id: string) => Promise<AudiobookshelfBookState>>(),
  states: vi.fn<(bucket: string, page: number, pageSize: number, q?: string) => Promise<AudiobookshelfBookStatePage>>(),
  link: vi.fn<(id: string, bookId: number) => Promise<AudiobookshelfBookState>>(),
  unlink: vi.fn<(id: string) => Promise<AudiobookshelfBookState>>(),
}))

vi.mock('@/features/audiobookshelf/api/audiobookshelf.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/audiobookshelf/api/audiobookshelf.api')>()),
  reconcileAudiobookshelfPosition: apiMocks.reconcile,
  updateAudiobookshelfBookExclusion: apiMocks.exclusion,
  confirmAudiobookshelfMatch: apiMocks.confirm,
  fetchAudiobookshelfBookStates: apiMocks.states,
  linkAudiobookshelfBook: apiMocks.link,
  unlinkAudiobookshelfBook: apiMocks.unlink,
}))

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

const synced: AudiobookshelfBookSyncLive = { status: 'synced', progress: null, local: null, divergedReason: null }

function makeState(id: string): AudiobookshelfBookState {
  return { absLibraryItemId: id, absTitle: `Item ${id}` } as AudiobookshelfBookState
}

function createHandle(link: AudiobookshelfBookSyncLink | null = makeLink()) {
  const handle = {
    link: ref<AudiobookshelfBookSyncLink | null>(link),
    live: ref<AudiobookshelfBookSyncLive | null>(null),
    refreshLive: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    applyLive: vi.fn<(status: AudiobookshelfBookSyncLive) => void>(),
    reload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }
  handle.applyLive.mockImplementation((status) => {
    handle.live.value = status
  })
  return handle satisfies AudiobookshelfSyncHandle
}

function mountActions(handle = createHandle(), audioBookId: number | null = 20) {
  let actions!: ReturnType<typeof useAudiobookshelfSyncActions>
  mount(
    defineComponent({
      setup() {
        actions = useAudiobookshelfSyncActions(handle, () => audioBookId)
        return () => null
      },
    }),
  )
  return actions
}

describe('useAudiobookshelfSyncActions', () => {
  beforeEach(() => {
    for (const mock of Object.values(apiMocks)) mock.mockReset()
    toastMocks.success.mockReset()
    toastMocks.error.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('reconcile', () => {
    it('applies the status the reconcile answered with, busy only while it runs', async () => {
      const handle = createHandle()
      const actions = mountActions(handle)
      apiMocks.reconcile.mockResolvedValueOnce(synced)

      const running = actions.reconcile('push')
      expect(actions.busy.value).toBe('push')
      await running

      expect(apiMocks.reconcile).toHaveBeenCalledWith('abs-1', 'push')
      expect(handle.applyLive).toHaveBeenCalledWith(synced)
      expect(actions.busy.value).toBeNull()
    })

    it.each([
      [409, 'Sync is busy, try again in a moment.'],
      [502, 'Could not reach Audiobookshelf.'],
      [500, 'Could not update the position. Try again.'],
    ])('says why a reconcile failed with %s', async (status, message) => {
      const actions = mountActions()
      apiMocks.reconcile.mockRejectedValueOnce(new AudiobookshelfReconcileError('nope', status))

      await actions.reconcile('pull')

      expect(actions.actionError.value).toBe(message)
      expect(actions.busy.value).toBeNull()
    })
  })

  describe('retry', () => {
    it('stays busy until the refresh settles', async () => {
      const handle = createHandle()
      let settle!: () => void
      handle.refreshLive.mockReturnValueOnce(new Promise<void>((resolve) => (settle = resolve)))
      const actions = mountActions(handle)

      const running = actions.retry()
      expect(handle.refreshLive).toHaveBeenCalledTimes(1)
      expect(actions.busy.value).toBe('retry')

      settle()
      await running
      expect(actions.busy.value).toBeNull()
    })

    it('is not left busy when the refresh was superseded by another request', async () => {
      const handle = createHandle()
      handle.refreshLive.mockResolvedValueOnce(undefined)
      const actions = mountActions(handle)

      await actions.retry()

      expect(handle.live.value).toBeNull()
      expect(actions.busy.value).toBeNull()
    })
  })

  it('clears an earlier action error', async () => {
    const actions = mountActions()
    apiMocks.reconcile.mockRejectedValueOnce(new AudiobookshelfReconcileError('nope', 500))
    await actions.reconcile('push')
    expect(actions.actionError.value).not.toBeNull()

    actions.clearError()

    expect(actions.actionError.value).toBeNull()
  })

  it.each([
    ['resume', false, 'Syncing with Audiobookshelf.'],
    ['pause', true, 'Stopped syncing with Audiobookshelf.'],
  ] as const)('%s sets the exclusion, reloads the match and says so', async (action, excluded, message) => {
    const handle = createHandle()
    const actions = mountActions(handle)
    apiMocks.exclusion.mockResolvedValueOnce(makeState('abs-1'))

    await expect(actions[action]()).resolves.toBe(true)

    expect(apiMocks.exclusion).toHaveBeenCalledWith('abs-1', excluded)
    expect(handle.reload).toHaveBeenCalledTimes(1)
    expect(toastMocks.success).toHaveBeenCalledWith(message)
  })

  it('confirms a match under review and reloads it', async () => {
    const handle = createHandle(makeLink({ syncing: false, pausedReason: 'needs_review' }))
    const actions = mountActions(handle)
    apiMocks.confirm.mockResolvedValueOnce(makeState('abs-1'))

    await expect(actions.confirm()).resolves.toBe(true)

    expect(apiMocks.confirm).toHaveBeenCalledWith('abs-1')
    expect(handle.reload).toHaveBeenCalledTimes(1)
  })

  it.each([
    [true, 1],
    [false, 0],
  ])('after confirming, a reloaded match that syncs=%s says so %s time(s)', async (syncing, toasts) => {
    const handle = createHandle(makeLink({ syncing: false, pausedReason: 'needs_review' }))
    handle.reload.mockImplementation(async () => {
      handle.link.value = makeLink({ syncing, pausedReason: syncing ? null : 'excluded' })
    })
    const actions = mountActions(handle)
    apiMocks.confirm.mockResolvedValueOnce(makeState('abs-1'))

    await actions.confirm()

    expect(toastMocks.success).toHaveBeenCalledTimes(toasts)
  })

  it('reports a refused match change and leaves the match as it was', async () => {
    const handle = createHandle()
    const actions = mountActions(handle)
    apiMocks.exclusion.mockRejectedValueOnce(new Error('down'))

    await expect(actions.pause()).resolves.toBe(false)

    expect(handle.reload).not.toHaveBeenCalled()
    expect(toastMocks.error).toHaveBeenCalledWith("Couldn't update Audiobookshelf sync.")
    expect(actions.busy.value).toBeNull()
  })

  describe('change', () => {
    it('searches unmatched items, debounced', async () => {
      vi.useFakeTimers()
      const actions = mountActions()
      apiMocks.states.mockResolvedValue({ items: [makeState('abs-2')], total: 1, page: 0, pageSize: 10 })

      actions.search.setQuery('du')
      actions.search.setQuery('dune')
      expect(actions.search.searching.value).toBe(true)
      await vi.advanceTimersByTimeAsync(250)

      expect(apiMocks.states).toHaveBeenCalledTimes(1)
      expect(apiMocks.states).toHaveBeenCalledWith('unmatched', 0, 10, 'dune')
      expect(actions.search.results.value).toEqual([makeState('abs-2')])
      expect(actions.search.searching.value).toBe(false)
      expect(actions.search.hasSearched.value).toBe(true)
    })

    it('unmatches the previous item first, links the picked one and reloads', async () => {
      const handle = createHandle()
      const actions = mountActions(handle)
      const order: string[] = []
      apiMocks.unlink.mockImplementationOnce(async () => {
        order.push('unlink')
        return makeState('abs-1')
      })
      apiMocks.link.mockImplementationOnce(async () => {
        order.push('link')
        return makeState('abs-2')
      })

      await expect(actions.change(makeState('abs-2'))).resolves.toBe(true)

      expect(order).toEqual(['unlink', 'link'])
      expect(apiMocks.link).toHaveBeenCalledWith('abs-2', 20)
      expect(apiMocks.unlink).toHaveBeenCalledWith('abs-1')
      expect(handle.reload).toHaveBeenCalledTimes(1)
      expect(toastMocks.success).toHaveBeenCalledWith('Audiobookshelf item changed.')
    })

    it('links the previous item again when linking the new one is refused', async () => {
      const handle = createHandle()
      const actions = mountActions(handle)
      apiMocks.unlink.mockResolvedValueOnce(makeState('abs-1'))
      apiMocks.link.mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce(makeState('abs-1'))

      await expect(actions.change(makeState('abs-2'))).resolves.toBe(false)

      expect(apiMocks.link).toHaveBeenNthCalledWith(1, 'abs-2', 20)
      expect(apiMocks.link).toHaveBeenNthCalledWith(2, 'abs-1', 20)
      expect(handle.reload).toHaveBeenCalledTimes(1)
      expect(toastMocks.error).toHaveBeenCalledWith("Couldn't update Audiobookshelf sync.")
    })

    it('still reports the failure when the rollback fails too', async () => {
      const handle = createHandle()
      const actions = mountActions(handle)
      apiMocks.unlink.mockResolvedValueOnce(makeState('abs-1'))
      apiMocks.link.mockRejectedValue(new Error('down'))

      await expect(actions.change(makeState('abs-2'))).resolves.toBe(false)

      expect(handle.reload).toHaveBeenCalledTimes(1)
      expect(toastMocks.error).toHaveBeenCalledTimes(1)
      expect(actions.busy.value).toBeNull()
    })

    it('keeps the change reported as done when only the reload fails', async () => {
      const handle = createHandle()
      const actions = mountActions(handle)
      handle.reload.mockRejectedValueOnce(new Error('down'))
      apiMocks.link.mockResolvedValueOnce(makeState('abs-2'))
      apiMocks.unlink.mockResolvedValueOnce(makeState('abs-1'))

      await expect(actions.change(makeState('abs-2'))).resolves.toBe(true)

      expect(toastMocks.success).toHaveBeenCalledWith('Audiobookshelf item changed.')
      expect(toastMocks.error).not.toHaveBeenCalled()
      expect(actions.busy.value).toBeNull()
    })

    it('does not link when unmatching the previous item is refused', async () => {
      const handle = createHandle()
      const actions = mountActions(handle)
      apiMocks.unlink.mockRejectedValueOnce(new Error('nope'))

      await expect(actions.change(makeState('abs-2'))).resolves.toBe(false)
      await flushPromises()

      expect(apiMocks.link).not.toHaveBeenCalled()
      expect(handle.reload).toHaveBeenCalledTimes(1)
      expect(toastMocks.error).toHaveBeenCalledWith("Couldn't update Audiobookshelf sync.")
    })
  })
})
