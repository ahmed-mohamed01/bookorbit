import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AudiobookshelfConnectionTestResult,
  AudiobookshelfLibrariesResponse,
  AudiobookshelfSettings,
  UpsertAudiobookshelfSettingsPayload,
} from '@bookorbit/types'

vi.mock('../../api/audiobookshelf.api', () => ({
  fetchAudiobookshelfSettings: vi.fn<() => Promise<AudiobookshelfSettings>>(),
  fetchAudiobookshelfLibraries: vi.fn<() => Promise<AudiobookshelfLibrariesResponse>>(),
  updateAudiobookshelfSettings: vi.fn<(payload: UpsertAudiobookshelfSettingsPayload) => Promise<AudiobookshelfSettings>>(),
  disconnectAudiobookshelf: vi.fn<() => Promise<void>>(),
  testAudiobookshelfConnection: vi.fn<() => Promise<AudiobookshelfConnectionTestResult>>(),
}))

import {
  disconnectAudiobookshelf,
  fetchAudiobookshelfLibraries,
  fetchAudiobookshelfSettings,
  testAudiobookshelfConnection,
  updateAudiobookshelfSettings,
} from '../../api/audiobookshelf.api'

const mockFetchSettings = vi.mocked(fetchAudiobookshelfSettings)
const mockFetchLibraries = vi.mocked(fetchAudiobookshelfLibraries)
const mockUpdate = vi.mocked(updateAudiobookshelfSettings)
const mockDisconnect = vi.mocked(disconnectAudiobookshelf)
const mockTest = vi.mocked(testAudiobookshelfConnection)

function makeSettings(overrides: Partial<AudiobookshelfSettings> = {}): AudiobookshelfSettings {
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
    lastSyncedAt: null,
    lastSyncError: null,
    ...overrides,
  }
}

async function loadComposable() {
  const { useAudiobookshelfSettings } = await import('../useAudiobookshelfSettings')
  return useAudiobookshelfSettings()
}

describe('useAudiobookshelfSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    mockFetchLibraries.mockResolvedValue({ libraries: [] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetchSettings populates the shared ref on success', async () => {
    const settings = makeSettings()
    mockFetchSettings.mockResolvedValue(settings)
    const c = await loadComposable()

    await c.fetchSettings()

    expect(c.settings.value).toEqual(settings)
    expect(c.loading.value).toBe(false)
    expect(c.error.value).toBeNull()
  })

  it('fetchSettings records the error message on failure', async () => {
    mockFetchSettings.mockRejectedValue(new Error('Network down'))
    const c = await loadComposable()

    await c.fetchSettings()

    expect(c.settings.value).toBeNull()
    expect(c.error.value).toBe('Network down')
    expect(c.loading.value).toBe(false)
  })

  it('saveSettings returns true and stores the returned settings', async () => {
    const saved = makeSettings({ enabled: false })
    mockUpdate.mockResolvedValue(saved)
    const c = await loadComposable()

    const ok = await c.saveSettings({ enabled: false })

    expect(ok).toBe(true)
    expect(c.settings.value).toEqual(saved)
    expect(c.saving.value).toBe(false)
  })

  it('saveSettings returns false and sets error on failure', async () => {
    mockUpdate.mockRejectedValue(new Error('Invalid token'))
    const c = await loadComposable()

    const ok = await c.saveSettings({ apiToken: 'bad' })

    expect(ok).toBe(false)
    expect(c.error.value).toBe('Invalid token')
    expect(c.saving.value).toBe(false)
  })

  it('saveSettings reloads libraries when credentials change and the token is configured', async () => {
    mockUpdate.mockResolvedValue(makeSettings())
    mockFetchLibraries.mockResolvedValue({ libraries: [{ id: 'lib-1', name: 'Audiobooks', mediaType: 'book' }] })
    const c = await loadComposable()

    await c.saveSettings({ apiToken: 'new-token' })

    expect(mockFetchLibraries).toHaveBeenCalledTimes(1)
    expect(c.libraries.value).toEqual([{ id: 'lib-1', name: 'Audiobooks', mediaType: 'book' }])
  })

  it('saveSettings does not reload libraries for a non-credential change', async () => {
    mockUpdate.mockResolvedValue(makeSettings())
    const c = await loadComposable()

    await c.saveSettings({ syncStatus: false })

    expect(mockFetchLibraries).not.toHaveBeenCalled()
  })

  it('the composable never exposes the raw token in its settings ref', async () => {
    mockUpdate.mockResolvedValue(makeSettings())
    const c = await loadComposable()

    await c.saveSettings({ apiToken: 'super-secret-token' })

    expect(JSON.stringify(c.settings.value)).not.toContain('super-secret-token')
    expect(c.settings.value).not.toHaveProperty('apiToken')
    expect(Object.keys(c)).not.toContain('apiToken')
  })

  it('disconnect clears settings and library state', async () => {
    mockFetchSettings.mockResolvedValue(makeSettings())
    mockDisconnect.mockResolvedValue(undefined)
    mockFetchLibraries.mockResolvedValue({ libraries: [{ id: 'lib-1', name: 'Audiobooks', mediaType: 'book' }] })
    const c = await loadComposable()
    await c.fetchSettings()
    await c.fetchLibraries()
    expect(c.libraries.value.length).toBe(1)

    const ok = await c.disconnect()

    expect(ok).toBe(true)
    expect(c.settings.value).toBeNull()
    expect(c.libraries.value).toEqual([])
    expect(c.librariesError.value).toBeNull()
  })

  it('testConnection returns the api result on success', async () => {
    mockTest.mockResolvedValue({ success: true, username: 'neon' })
    const c = await loadComposable()

    const result = await c.testConnection({ serverUrl: 'https://abs.example.com', apiToken: 'tok' })

    expect(result).toEqual({ success: true, username: 'neon' })
    expect(c.testing.value).toBe(false)
  })

  it('testConnection surfaces the error message when the api rejects', async () => {
    mockTest.mockRejectedValue(new Error('Unauthorized'))
    const c = await loadComposable()

    const result = await c.testConnection({ serverUrl: 'https://abs.example.com', apiToken: 'tok' })

    expect(result.success).toBe(false)
    expect(result.error).toBe('Unauthorized')
    expect(c.testError.value).toBe('Unauthorized')
  })

  it('testConnection refuses to run while a save is in flight', async () => {
    const c = await loadComposable()
    c.saving.value = true

    const result = await c.testConnection({ serverUrl: 'https://abs.example.com' })

    expect(result.success).toBe(false)
    expect(mockTest).not.toHaveBeenCalled()
    expect(c.testError.value).toBe('Wait for the current Audiobookshelf settings change to finish')
  })

  it('fetchLibraries keeps only the latest response when calls overlap', async () => {
    const resolvers: Array<(value: AudiobookshelfLibrariesResponse) => void> = []
    mockFetchLibraries.mockImplementation(() => new Promise<AudiobookshelfLibrariesResponse>((resolve) => resolvers.push(resolve)))
    const c = await loadComposable()

    const first = c.fetchLibraries()
    const second = c.fetchLibraries()

    resolvers[1]!({ libraries: [{ id: 'fresh', name: 'Fresh', mediaType: 'book' }] })
    resolvers[0]!({ libraries: [{ id: 'stale', name: 'Stale', mediaType: 'book' }] })
    await Promise.all([first, second])

    expect(c.libraries.value).toEqual([{ id: 'fresh', name: 'Fresh', mediaType: 'book' }])
  })
})
