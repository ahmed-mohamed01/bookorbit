import { invalidateEditionSyncSettings } from '../useEditionSyncSettings'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import type { EditionSyncBookState, EditionSyncSettings } from '@bookorbit/types'

const mocks = vi.hoisted(() => ({
  hasPermission: vi.fn<(name: string) => boolean>(),
  fetchState: vi.fn<(bookId: number) => Promise<EditionSyncBookState>>(),
  updateState: vi.fn<(bookId: number, payload: { syncEnabled: boolean }) => Promise<EditionSyncBookState>>(),
  runNow: vi.fn<(bookId: number) => Promise<EditionSyncBookState>>(),
  retry: vi.fn<(bookId: number) => Promise<EditionSyncBookState>>(),
  fetchSettings: vi.fn<() => Promise<EditionSyncSettings>>(),
}))

vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: mocks.hasPermission }) }))
vi.mock('../../api/edition-sync.api', () => ({
  fetchEditionSyncSettings: mocks.fetchSettings,
  updateEditionSyncSettings: vi.fn<() => Promise<EditionSyncSettings>>(),
  fetchEditionSyncBookState: mocks.fetchState,
  updateEditionSyncBookState: mocks.updateState,
  runEditionSyncBookNow: mocks.runNow,
  retryEditionSyncBook: mocks.retry,
}))

import { EDITION_SYNC_POLL_MS, EDITION_SYNC_QUEUED_POLL_MS, EDITION_SYNC_VIEW_REFRESH_MS, useEditionSyncBookState } from '../useEditionSyncBookState'

function makeState(status: EditionSyncBookState['index']['status'] = 'ready', overrides: Partial<EditionSyncBookState> = {}): EditionSyncBookState {
  return {
    bookId: 1,
    eligible: true,
    editionCount: 2,
    syncOverride: null,
    syncEnabled: true,
    effectiveReason: null,
    wanted: true,
    canRunNow: false,
    canRetry: false,
    hasReadAlong: false,
    hasAudio: true,
    pinned: false,
    runActive: false,
    index: {
      status,
      stage: null,
      progress: null,
      queuePosition: null,
      nextRunAt: null,
      indexedAt: null,
      indexFileId: null,
      sentences: null,
      matchedSentences: null,
      failedAt: null,
      errorCode: null,
      error: null,
      attemptCount: 0,
      whisperFallback: false,
      workerVersion: null,
    },
    ...overrides,
  }
}

const SETTINGS: EditionSyncSettings = { enabled: true, effectiveEnabled: true, disabledReason: null, bookSyncMode: 'all_eligible' }

async function settle() {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await nextTick()
}

function setup(bookId = 1) {
  const scope = effectScope()
  const id = ref(bookId)
  const filesKey = ref('1,2')
  const api = scope.run(() => useEditionSyncBookState(id, () => filesKey.value))!
  return { scope, id, filesKey, api }
}

describe('useEditionSyncBookState', () => {
  beforeEach(() => {
    invalidateEditionSyncSettings()
    vi.useFakeTimers()
    Object.values(mocks).forEach((mock) => mock.mockReset())
    mocks.hasPermission.mockReturnValue(true)
    mocks.fetchSettings.mockResolvedValue(SETTINGS)
    mocks.fetchState.mockResolvedValue(makeState())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays hidden and makes no request without the permission', async () => {
    mocks.hasPermission.mockReturnValue(false)
    const { scope, api } = setup()
    await settle()

    expect(api.visible.value).toBe(false)
    expect(mocks.fetchSettings).not.toHaveBeenCalled()
    expect(mocks.fetchState).not.toHaveBeenCalled()
    scope.stop()
  })

  it('stays hidden when edition sync is off for the user', async () => {
    mocks.fetchSettings.mockResolvedValue({ ...SETTINGS, enabled: false, effectiveEnabled: false, disabledReason: 'user_disabled' })
    const { scope, api } = setup()
    await settle()

    expect(api.visible.value).toBe(false)
    expect(mocks.fetchState).not.toHaveBeenCalled()
    scope.stop()
  })

  it('stays hidden when an admin has turned edition sync off for the server', async () => {
    mocks.fetchSettings.mockResolvedValue({ ...SETTINGS, effectiveEnabled: false, disabledReason: 'server_disabled' })
    const { scope, api } = setup()
    await settle()

    expect(api.visible.value).toBe(false)
    expect(mocks.fetchState).not.toHaveBeenCalled()
    scope.stop()
  })

  describe('refresh when the page is viewed again', () => {
    let visibility: DocumentVisibilityState = 'visible'
    beforeEach(() => {
      visibility = 'visible'
      vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    function showPage(): void {
      visibility = 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
    }

    it('refetches a ready state when the page becomes visible after the throttle window', async () => {
      const { scope, api } = setup()
      await settle()
      expect(mocks.fetchState).toHaveBeenCalledTimes(1)
      mocks.fetchState.mockResolvedValue(makeState('stale'))

      vi.setSystemTime(Date.now() + EDITION_SYNC_VIEW_REFRESH_MS + 1)
      showPage()
      await settle()

      expect(mocks.fetchState).toHaveBeenCalledTimes(2)
      expect(api.state.value?.index.status).toBe('stale')
      scope.stop()
    })

    it('makes at most one request per throttle window', async () => {
      const { scope } = setup()
      await settle()
      showPage()
      vi.setSystemTime(Date.now() + EDITION_SYNC_VIEW_REFRESH_MS - 1)
      showPage()
      await settle()
      expect(mocks.fetchState).toHaveBeenCalledTimes(1)

      vi.setSystemTime(Date.now() + 2)
      showPage()
      showPage()
      await settle()
      expect(mocks.fetchState).toHaveBeenCalledTimes(2)
      scope.stop()
    })

    it('ignores the page being hidden and stops listening once disposed', async () => {
      const { scope } = setup()
      await settle()
      vi.setSystemTime(Date.now() + EDITION_SYNC_VIEW_REFRESH_MS + 1)
      visibility = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
      await settle()
      expect(mocks.fetchState).toHaveBeenCalledTimes(1)

      scope.stop()
      showPage()
      await settle()
      expect(mocks.fetchState).toHaveBeenCalledTimes(1)
    })
  })

  it('loads the book state once the settings allow it', async () => {
    mocks.fetchState.mockResolvedValue(makeState('ready', { editionCount: 3 }))
    const { scope, api } = setup()
    await settle()

    expect(api.visible.value).toBe(true)
    expect(api.syncEnabled.value).toBe(true)
    expect(api.editionCount.value).toBe(3)
    scope.stop()
  })

  it('saves the toggle and keeps the server answer', async () => {
    mocks.updateState.mockResolvedValue(makeState('none', { syncEnabled: false }))
    const { scope, api } = setup()
    await settle()
    await api.setSyncEnabled(false)

    expect(mocks.updateState).toHaveBeenCalledWith(1, { syncEnabled: false })
    expect(api.syncEnabled.value).toBe(false)
    scope.stop()
  })

  it('restores the previous state and reports an error when saving fails', async () => {
    mocks.updateState.mockRejectedValue(new Error('nope'))
    const { scope, api } = setup()
    await settle()
    await api.setSyncEnabled(false)

    expect(api.syncEnabled.value).toBe(true)
    expect(api.error.value).toBeTruthy()
    scope.stop()
  })

  it('runs and retries through the matching endpoints', async () => {
    mocks.runNow.mockResolvedValue(makeState('running'))
    mocks.retry.mockResolvedValue(makeState('queued'))
    const { scope, api } = setup()
    await settle()

    await api.runNow()
    expect(mocks.runNow).toHaveBeenCalledWith(1)
    expect(api.state.value?.index.status).toBe('running')
    await api.retry()
    expect(mocks.retry).toHaveBeenCalledWith(1)
    expect(api.state.value?.index.status).toBe('queued')
    scope.stop()
  })

  it('polls while the index is queued or running and stops once it is ready', async () => {
    mocks.fetchState.mockResolvedValueOnce(makeState('running')).mockResolvedValueOnce(makeState('running')).mockResolvedValue(makeState('ready'))
    const { scope } = setup()
    await settle()
    expect(mocks.fetchState).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(EDITION_SYNC_POLL_MS)
    await settle()
    expect(mocks.fetchState).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(EDITION_SYNC_POLL_MS)
    await settle()
    expect(mocks.fetchState).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(EDITION_SYNC_POLL_MS * 3)
    expect(mocks.fetchState).toHaveBeenCalledTimes(3)
    scope.stop()
  })

  it('stops polling when its scope ends', async () => {
    mocks.fetchState.mockResolvedValue(makeState('queued', { pinned: true }))
    const { scope } = setup()
    await settle()
    scope.stop()
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_POLL_MS * 3)

    expect(mocks.fetchState).toHaveBeenCalledTimes(1)
  })

  it('polls a queued book every 10 s while it is pinned or a run is active, and every 60 s otherwise', async () => {
    mocks.fetchState.mockResolvedValue(makeState('queued', { runActive: true }))
    const active = setup()
    await settle()
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_POLL_MS)
    expect(mocks.fetchState).toHaveBeenCalledTimes(2)
    active.scope.stop()

    mocks.fetchState.mockReset()
    mocks.fetchState.mockResolvedValue(makeState('queued'))
    const idle = setup()
    await settle()
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_POLL_MS * 5)
    expect(mocks.fetchState).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_QUEUED_POLL_MS - EDITION_SYNC_POLL_MS * 5)
    expect(mocks.fetchState).toHaveBeenCalledTimes(2)
    idle.scope.stop()
  })

  it('refetches the state when the book files change', async () => {
    const { scope, filesKey } = setup()
    await settle()
    expect(mocks.fetchState).toHaveBeenCalledTimes(1)

    filesKey.value = '1,2,3'
    await settle()
    expect(mocks.fetchState).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('reports whether the toggle saved, and drops a poll answer that was already in flight', async () => {
    const { scope, api } = setup()
    await settle()

    let resolvePoll: (value: EditionSyncBookState) => void = () => undefined
    mocks.fetchState.mockImplementationOnce(() => new Promise<EditionSyncBookState>((resolve) => (resolvePoll = resolve)))
    const poll = api.refresh()
    mocks.updateState.mockResolvedValue(makeState('none', { syncEnabled: false }))
    expect(await api.setSyncEnabled(false)).toBe(true)
    resolvePoll(makeState('ready', { syncEnabled: true }))
    await poll

    expect(api.syncEnabled.value).toBe(false)
    mocks.updateState.mockRejectedValue(new Error('nope'))
    expect(await api.setSyncEnabled(true)).toBe(false)
    scope.stop()
  })

  it('does not let an in-flight poll overwrite the answer of a run now', async () => {
    mocks.fetchState.mockResolvedValue(makeState('queued', { pinned: false, canRunNow: true }))
    const { scope, api } = setup()
    await settle()

    let resolvePoll: (value: EditionSyncBookState) => void = () => undefined
    mocks.fetchState.mockImplementationOnce(() => new Promise<EditionSyncBookState>((resolve) => (resolvePoll = resolve)))
    const poll = api.refresh()
    mocks.runNow.mockResolvedValue(makeState('queued', { pinned: true }))
    await api.runNow()
    resolvePoll(makeState('queued', { pinned: false }))
    await poll

    expect(api.state.value?.pinned).toBe(true)
    scope.stop()
  })

  it('polls a stale book', async () => {
    mocks.fetchState.mockResolvedValue(makeState('stale'))
    const { scope } = setup()
    await settle()
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_POLL_MS)
    expect(mocks.fetchState).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('clears loading when a refresh starts while the first state load is still in flight', async () => {
    let resolveInitial: (value: EditionSyncBookState) => void = () => undefined
    mocks.fetchState.mockImplementationOnce(() => new Promise<EditionSyncBookState>((resolve) => (resolveInitial = resolve)))
    const { scope, api } = setup()
    await settle()
    expect(api.busy.value).toBe(true)

    mocks.fetchState.mockResolvedValueOnce(makeState('ready', { syncEnabled: true }))
    await api.refresh()
    resolveInitial(makeState('ready', { syncEnabled: false }))
    await settle()

    expect(api.busy.value).toBe(false)
    expect(api.syncEnabled.value).toBe(true)
    scope.stop()
  })

  it('does not poll again after disposal while a refresh is pending', async () => {
    mocks.fetchState.mockResolvedValueOnce(makeState('queued', { pinned: true }))
    const { scope, api } = setup()
    await settle()

    let resolvePending: (value: EditionSyncBookState) => void = () => undefined
    mocks.fetchState.mockImplementationOnce(() => new Promise<EditionSyncBookState>((resolve) => (resolvePending = resolve)))
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_POLL_MS)
    expect(mocks.fetchState).toHaveBeenCalledTimes(2)

    scope.stop()
    resolvePending(makeState('queued'))
    await settle()
    await vi.advanceTimersByTimeAsync(EDITION_SYNC_POLL_MS * 3)

    expect(mocks.fetchState).toHaveBeenCalledTimes(2)
    expect(api.state.value?.index.status).toBe('queued')
  })
})
