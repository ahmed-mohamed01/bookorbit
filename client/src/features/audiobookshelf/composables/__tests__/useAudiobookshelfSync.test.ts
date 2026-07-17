import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudiobookshelfSyncResult } from '../../api/audiobookshelf.api'
import { startAudiobookshelfFullResync, startAudiobookshelfSync } from '../../api/audiobookshelf.api'

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn<() => Promise<void>>(),
  loadAllBuckets: vi.fn<() => Promise<void>>(),
}))

vi.mock('../../api/audiobookshelf.api', () => ({
  startAudiobookshelfSync: vi.fn<() => Promise<AudiobookshelfSyncResult>>(),
  startAudiobookshelfFullResync: vi.fn<() => Promise<AudiobookshelfSyncResult>>(),
}))

vi.mock('../useAudiobookshelfSettings', () => ({
  useAudiobookshelfSettings: () => ({ fetchSettings: mocks.fetchSettings }),
}))

vi.mock('../useAudiobookshelfLinkedBooks', () => ({
  useAudiobookshelfLinkedBooks: () => ({ loadAllBuckets: mocks.loadAllBuckets }),
}))

const mockStartSync = vi.mocked(startAudiobookshelfSync)
const mockStartFullResync = vi.mocked(startAudiobookshelfFullResync)

const result: AudiobookshelfSyncResult = {
  matched: 2,
  statusApplied: 1,
  positionApplied: 1,
  sessionsApplied: 3,
  skipped: 4,
  failed: 0,
}

async function loadComposable() {
  const { useAudiobookshelfSync } = await import('../useAudiobookshelfSync')
  return useAudiobookshelfSync()
}

describe('useAudiobookshelfSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    mockStartSync.mockResolvedValue(result)
    mockStartFullResync.mockResolvedValue(result)
    mocks.fetchSettings.mockResolvedValue()
    mocks.loadAllBuckets.mockResolvedValue()
  })

  it('refreshes linked-book buckets after a successful incremental sync', async () => {
    const sync = await loadComposable()

    await expect(sync.syncNow()).resolves.toBe(true)

    expect(mockStartSync).toHaveBeenCalledTimes(1)
    expect(mocks.fetchSettings).toHaveBeenCalledTimes(1)
    expect(mocks.loadAllBuckets).toHaveBeenCalledTimes(1)
    expect(sync.lastResult.value).toEqual(result)
  })

  it('refreshes linked-book buckets after a successful full resync', async () => {
    const sync = await loadComposable()

    await expect(sync.fullResync()).resolves.toBe(true)

    expect(mockStartFullResync).toHaveBeenCalledTimes(1)
    expect(mocks.fetchSettings).toHaveBeenCalledTimes(1)
    expect(mocks.loadAllBuckets).toHaveBeenCalledTimes(1)
    expect(sync.lastResult.value).toEqual(result)
  })

  it('keeps a successful sync result when the follow-up bucket refresh fails', async () => {
    mocks.loadAllBuckets.mockRejectedValue(new Error('bucket refresh failed'))
    const sync = await loadComposable()

    await expect(sync.syncNow()).resolves.toBe(true)

    expect(sync.error.value).toBeNull()
    expect(sync.lastResult.value).toEqual(result)
  })
})
