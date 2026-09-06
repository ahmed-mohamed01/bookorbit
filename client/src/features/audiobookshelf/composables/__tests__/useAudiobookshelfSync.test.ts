import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudiobookshelfBookStatePage, AudiobookshelfSettings, AudiobookshelfSyncResult } from '@bookorbit/types'

vi.mock('../../api/audiobookshelf.api', () => ({
  startAudiobookshelfSync: vi.fn<() => Promise<AudiobookshelfSyncResult>>(),
  startAudiobookshelfFullResync: vi.fn<() => Promise<AudiobookshelfSyncResult>>(),
  fetchAudiobookshelfSettings: vi.fn<() => Promise<AudiobookshelfSettings>>(),
  fetchAudiobookshelfLibraries: vi.fn<() => Promise<unknown>>(),
  updateAudiobookshelfSettings: vi.fn<() => Promise<unknown>>(),
  disconnectAudiobookshelf: vi.fn<() => Promise<unknown>>(),
  testAudiobookshelfConnection: vi.fn<() => Promise<unknown>>(),
  fetchAudiobookshelfBookStates: vi.fn<() => Promise<AudiobookshelfBookStatePage>>(),
  confirmAudiobookshelfMatch: vi.fn<() => Promise<unknown>>(),
  linkAudiobookshelfBook: vi.fn<() => Promise<unknown>>(),
  unlinkAudiobookshelfBook: vi.fn<() => Promise<unknown>>(),
  updateAudiobookshelfBookExclusion: vi.fn<() => Promise<unknown>>(),
  rescanAudiobookshelfMatches: vi.fn<() => Promise<unknown>>(),
}))

import {
  fetchAudiobookshelfBookStates,
  fetchAudiobookshelfSettings,
  startAudiobookshelfFullResync,
  startAudiobookshelfSync,
} from '../../api/audiobookshelf.api'

const mockSync = vi.mocked(startAudiobookshelfSync)
const mockFullResync = vi.mocked(startAudiobookshelfFullResync)
const mockFetchSettings = vi.mocked(fetchAudiobookshelfSettings)
const mockFetchBookStates = vi.mocked(fetchAudiobookshelfBookStates)

const RESULT: AudiobookshelfSyncResult = {
  matched: 2,
  statusApplied: 1,
  positionApplied: 1,
  sessionsApplied: 0,
  skipped: 3,
  failed: 0,
}

function makeSettings(): AudiobookshelfSettings {
  return {
    serverUrl: 'https://abs.example.com',
    tokenConfigured: true,
    enabled: true,
    effectiveEnabled: true,
    disabledReason: null,
    syncStatus: true,
    syncPosition: true,
    syncSessions: true,
    excludedLibraryIds: [],
    pathMappings: [],
    lastSyncedAt: null,
    lastSyncError: null,
    staleCount: 0,
  }
}

function emptyPage(): AudiobookshelfBookStatePage {
  return { items: [], total: 0, page: 0, pageSize: 20 }
}

async function loadComposable() {
  const { useAudiobookshelfSync } = await import('../useAudiobookshelfSync')
  return useAudiobookshelfSync()
}

describe('useAudiobookshelfSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    mockFetchSettings.mockResolvedValue(makeSettings())
    mockFetchBookStates.mockResolvedValue(emptyPage())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('syncNow runs an incremental sync and reloads settings + book buckets', async () => {
    mockSync.mockResolvedValue(RESULT)
    const c = await loadComposable()

    const ok = await c.syncNow()

    expect(ok).toBe(true)
    expect(mockSync).toHaveBeenCalledTimes(1)
    expect(mockFullResync).not.toHaveBeenCalled()
    expect(c.lastResult.value).toEqual(RESULT)
    expect(c.syncing.value).toBe(false)
    expect(c.syncMode.value).toBeNull()
    expect(mockFetchSettings).toHaveBeenCalled()
    expect(mockFetchBookStates).toHaveBeenCalledTimes(3)
  })

  it('fullResync runs the full-resync endpoint', async () => {
    mockFullResync.mockResolvedValue(RESULT)
    const c = await loadComposable()

    const ok = await c.fullResync()

    expect(ok).toBe(true)
    expect(mockFullResync).toHaveBeenCalledTimes(1)
    expect(mockSync).not.toHaveBeenCalled()
    expect(c.lastResult.value).toEqual(RESULT)
  })

  it('records the error and still refreshes settings when a sync fails', async () => {
    mockSync.mockRejectedValue(new Error('An Audiobookshelf sync is already running'))
    const c = await loadComposable()

    const ok = await c.syncNow()

    expect(ok).toBe(false)
    expect(c.error.value).toBe('An Audiobookshelf sync is already running')
    expect(c.syncing.value).toBe(false)
    expect(mockFetchSettings).toHaveBeenCalled()
  })

  it('refuses to start a second sync while one is already running', async () => {
    const c = await loadComposable()
    c.syncing.value = true

    const ok = await c.syncNow()

    expect(ok).toBe(false)
    expect(mockSync).not.toHaveBeenCalled()
  })

  it('exposes isFullResync only while a full run is in flight', async () => {
    let resolveFull: (value: AudiobookshelfSyncResult) => void = () => {}
    mockFullResync.mockImplementation(() => new Promise<AudiobookshelfSyncResult>((resolve) => (resolveFull = resolve)))
    const c = await loadComposable()

    const pending = c.fullResync()
    expect(c.isFullResync.value).toBe(true)

    resolveFull(RESULT)
    await pending
    expect(c.isFullResync.value).toBe(false)
  })
})
