import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AudiobookshelfConnectionTestPayload,
  AudiobookshelfConnectionTestResult,
  AudiobookshelfLibrariesResponse,
  AudiobookshelfLibrary,
  AudiobookshelfSettings,
  UpsertAudiobookshelfSettingsPayload,
} from '@bookorbit/types'
import {
  disconnectAudiobookshelf,
  fetchAudiobookshelfLibraries,
  fetchAudiobookshelfSettings,
  updateAudiobookshelfSettings,
} from '../../api/audiobookshelf.api'

vi.mock('../../api/audiobookshelf.api', () => ({
  disconnectAudiobookshelf: vi.fn<() => Promise<void>>(),
  fetchAudiobookshelfLibraries: vi.fn<() => Promise<AudiobookshelfLibrariesResponse>>(),
  fetchAudiobookshelfSettings: vi.fn<() => Promise<AudiobookshelfSettings>>(),
  testAudiobookshelfConnection: vi.fn<(payload: AudiobookshelfConnectionTestPayload) => Promise<AudiobookshelfConnectionTestResult>>(),
  updateAudiobookshelfSettings: vi.fn<(payload: UpsertAudiobookshelfSettingsPayload) => Promise<AudiobookshelfSettings>>(),
}))

const mockFetchLibraries = vi.mocked(fetchAudiobookshelfLibraries)
const mockFetchSettings = vi.mocked(fetchAudiobookshelfSettings)
const mockUpdateSettings = vi.mocked(updateAudiobookshelfSettings)
const mockDisconnect = vi.mocked(disconnectAudiobookshelf)

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

function configuredSettings(overrides: Partial<AudiobookshelfSettings> = {}): AudiobookshelfSettings {
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

function library(id: string): AudiobookshelfLibrary {
  return { id, name: id, mediaType: 'book', provider: 'local', excluded: false }
}

async function loadComposable() {
  vi.resetModules()
  const { useAudiobookshelfSettings } = await import('../useAudiobookshelfSettings')
  return useAudiobookshelfSettings()
}

describe('useAudiobookshelfSettings credential discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchSettings.mockResolvedValue(configuredSettings())
    mockUpdateSettings.mockResolvedValue(configuredSettings())
    mockFetchLibraries.mockResolvedValue({ libraries: [library('fiction')] })
    mockDisconnect.mockResolvedValue()
  })

  it('discovers once for token replacement followed by a server URL change', async () => {
    mockUpdateSettings
      .mockResolvedValueOnce(configuredSettings())
      .mockResolvedValueOnce(configuredSettings({ serverUrl: 'https://next-abs.example.com' }))
    const settings = await loadComposable()

    await expect(settings.saveSettings({ apiToken: 'replacement-token' })).resolves.toBe(true)
    await expect(settings.saveSettings({ serverUrl: 'https://next-abs.example.com' })).resolves.toBe(true)

    expect(mockFetchLibraries).toHaveBeenCalledTimes(2)
    expect(settings.librariesError.value).toBeNull()
  })

  it('discovers once for a combined server URL and token save', async () => {
    mockUpdateSettings.mockResolvedValue(configuredSettings({ serverUrl: 'https://combined-abs.example.com' }))
    const settings = await loadComposable()

    await expect(
      settings.saveSettings({
        serverUrl: 'https://combined-abs.example.com',
        apiToken: 'replacement-token',
      }),
    ).resolves.toBe(true)

    expect(mockFetchLibraries).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['empty', []],
    ['non-empty', [library('existing')]],
  ])('discovers once for same-url token replacement with a %s current library list', async (_label, currentLibraries) => {
    const settings = await loadComposable()
    settings.libraries.value = currentLibraries

    await expect(settings.saveSettings({ apiToken: 'replacement-token' })).resolves.toBe(true)

    expect(mockFetchLibraries).toHaveBeenCalledTimes(1)
    expect(settings.libraries.value).toEqual([library('fiction')])
  })

  it('keeps save success and retries discovery after a failed follow-up discovery', async () => {
    mockFetchLibraries.mockRejectedValueOnce(new Error('library discovery failed')).mockResolvedValueOnce({ libraries: [library('retry')] })
    const settings = await loadComposable()

    await expect(settings.saveSettings({ apiToken: 'replacement-token' })).resolves.toBe(true)

    expect(settings.error.value).toBeNull()
    expect(settings.librariesError.value).toBe('library discovery failed')
    expect(mockFetchLibraries).toHaveBeenCalledTimes(1)

    await expect(settings.saveSettings({ apiToken: 'retry-token' })).resolves.toBe(true)

    expect(mockFetchLibraries).toHaveBeenCalledTimes(2)
    expect(settings.librariesError.value).toBeNull()
    expect(settings.libraries.value).toEqual([library('retry')])
  })

  it('does not discover for non-credential saves', async () => {
    const settings = await loadComposable()

    await expect(settings.saveSettings({ syncStatus: false })).resolves.toBe(true)

    expect(mockFetchLibraries).not.toHaveBeenCalled()
  })

  it('coalesces duplicate concurrent settings fetches', async () => {
    const settingsResult = deferred<AudiobookshelfSettings>()
    mockFetchSettings.mockReturnValueOnce(settingsResult.promise)
    const settings = await loadComposable()

    const firstFetch = settings.fetchSettings()
    const secondFetch = settings.fetchSettings()

    expect(mockFetchSettings).toHaveBeenCalledTimes(1)
    expect(settings.loading.value).toBe(true)

    settingsResult.resolve(configuredSettings({ serverUrl: 'https://coalesced.example.com' }))
    await Promise.all([firstFetch, secondFetch])

    expect(settings.loading.value).toBe(false)
    expect(settings.settings.value?.serverUrl).toBe('https://coalesced.example.com')
  })

  it('does not let a settings fetch started before a save overwrite the completed save', async () => {
    const staleFetch = deferred<AudiobookshelfSettings>()
    mockFetchSettings.mockReturnValueOnce(staleFetch.promise)
    mockUpdateSettings.mockResolvedValueOnce(configuredSettings({ serverUrl: 'https://saved.example.com' }))
    const settings = await loadComposable()

    const fetch = settings.fetchSettings()
    await expect(settings.saveSettings({ serverUrl: 'https://saved.example.com' })).resolves.toBe(true)
    staleFetch.resolve(configuredSettings({ serverUrl: 'https://stale.example.com' }))
    await fetch

    expect(settings.settings.value?.serverUrl).toBe('https://saved.example.com')
  })

  it('clears stale settings loading when an authoritative save completes before an older GET resolves', async () => {
    const staleFetch = deferred<AudiobookshelfSettings>()
    mockFetchSettings.mockReturnValueOnce(staleFetch.promise)
    mockUpdateSettings.mockResolvedValueOnce(configuredSettings({ serverUrl: 'https://saved.example.com' }))
    const settings = await loadComposable()

    const fetch = settings.fetchSettings()
    await expect(settings.saveSettings({ serverUrl: 'https://saved.example.com' })).resolves.toBe(true)

    expect(settings.loading.value).toBe(false)
    expect(settings.settings.value?.serverUrl).toBe('https://saved.example.com')

    staleFetch.resolve(configuredSettings({ serverUrl: 'https://stale.example.com' }))
    await fetch

    expect(settings.loading.value).toBe(false)
    expect(settings.settings.value?.serverUrl).toBe('https://saved.example.com')
  })

  it('keeps stale GET rejection from restoring loading or error after an authoritative save', async () => {
    const staleFetch = deferred<AudiobookshelfSettings>()
    mockFetchSettings.mockReturnValueOnce(staleFetch.promise)
    mockUpdateSettings.mockResolvedValueOnce(configuredSettings({ serverUrl: 'https://saved.example.com' }))
    const settings = await loadComposable()

    const fetch = settings.fetchSettings()
    await expect(settings.saveSettings({ serverUrl: 'https://saved.example.com' })).resolves.toBe(true)

    expect(settings.loading.value).toBe(false)
    staleFetch.reject(new Error('stale fetch failed'))
    await fetch

    expect(settings.loading.value).toBe(false)
    expect(settings.error.value).toBeNull()
    expect(settings.settings.value?.serverUrl).toBe('https://saved.example.com')
  })

  it('does not let a sync settings refresh started during a save overwrite the save result', async () => {
    const save = deferred<AudiobookshelfSettings>()
    const syncRefresh = deferred<AudiobookshelfSettings>()
    mockUpdateSettings.mockReturnValueOnce(save.promise)
    mockFetchSettings.mockReturnValueOnce(syncRefresh.promise)
    const settings = await loadComposable()

    const saveResult = settings.saveSettings({ serverUrl: 'https://saved.example.com' })
    const refresh = settings.fetchSettings()
    save.resolve(configuredSettings({ serverUrl: 'https://saved.example.com' }))
    await saveResult
    syncRefresh.resolve(configuredSettings({ serverUrl: 'https://sync-stale.example.com' }))
    await refresh

    expect(settings.settings.value?.serverUrl).toBe('https://saved.example.com')
  })

  it('lets only the newer overlapping save start discovery when the newer save resolves first', async () => {
    const olderSave = deferred<AudiobookshelfSettings>()
    const newerSave = deferred<AudiobookshelfSettings>()
    const newerDiscovery = deferred<AudiobookshelfLibrariesResponse>()
    mockUpdateSettings.mockReturnValueOnce(olderSave.promise).mockReturnValueOnce(newerSave.promise)
    mockFetchLibraries.mockReturnValueOnce(newerDiscovery.promise)
    const settings = await loadComposable()

    const olderResult = settings.saveSettings({ serverUrl: 'https://older.example.com' })
    const newerResult = settings.saveSettings({ serverUrl: 'https://newer.example.com' })
    newerSave.resolve(configuredSettings({ serverUrl: 'https://newer.example.com' }))
    await Promise.resolve()

    expect(mockFetchLibraries).toHaveBeenCalledTimes(1)
    newerDiscovery.resolve({ libraries: [library('newer')] })
    await expect(newerResult).resolves.toBe(true)
    olderSave.resolve(configuredSettings({ serverUrl: 'https://older.example.com' }))
    await expect(olderResult).resolves.toBe(true)

    expect(mockFetchLibraries).toHaveBeenCalledTimes(1)
    expect(settings.settings.value?.serverUrl).toBe('https://newer.example.com')
    expect(settings.libraries.value).toEqual([library('newer')])
  })

  it('lets only the newer overlapping save start discovery when the older save resolves first', async () => {
    const olderSave = deferred<AudiobookshelfSettings>()
    const newerSave = deferred<AudiobookshelfSettings>()
    const newerDiscovery = deferred<AudiobookshelfLibrariesResponse>()
    mockUpdateSettings.mockReturnValueOnce(olderSave.promise).mockReturnValueOnce(newerSave.promise)
    mockFetchLibraries.mockReturnValueOnce(newerDiscovery.promise)
    const settings = await loadComposable()

    const olderResult = settings.saveSettings({ serverUrl: 'https://older.example.com' })
    const newerResult = settings.saveSettings({ serverUrl: 'https://newer.example.com' })
    olderSave.resolve(configuredSettings({ serverUrl: 'https://older.example.com' }))
    await expect(olderResult).resolves.toBe(true)

    expect(mockFetchLibraries).not.toHaveBeenCalled()
    expect(settings.settings.value).toBeNull()

    newerSave.resolve(configuredSettings({ serverUrl: 'https://newer.example.com' }))
    await Promise.resolve()
    expect(mockFetchLibraries).toHaveBeenCalledTimes(1)
    newerDiscovery.resolve({ libraries: [library('newer')] })
    await expect(newerResult).resolves.toBe(true)

    expect(settings.settings.value?.serverUrl).toBe('https://newer.example.com')
    expect(settings.libraries.value).toEqual([library('newer')])
  })

  it('does not let an older save commit or discover after a newer save fails', async () => {
    const olderSave = deferred<AudiobookshelfSettings>()
    const newerSave = deferred<AudiobookshelfSettings>()
    mockUpdateSettings.mockReturnValueOnce(olderSave.promise).mockReturnValueOnce(newerSave.promise)
    const settings = await loadComposable()

    const olderResult = settings.saveSettings({ serverUrl: 'https://older.example.com' })
    const newerResult = settings.saveSettings({ serverUrl: 'https://newer.example.com' })
    newerSave.reject(new Error('newer save failed'))
    await expect(newerResult).resolves.toBe(false)
    olderSave.resolve(configuredSettings({ serverUrl: 'https://older.example.com' }))
    await expect(olderResult).resolves.toBe(true)

    expect(settings.settings.value).toBeNull()
    expect(settings.error.value).toBe('newer save failed')
    expect(mockFetchLibraries).not.toHaveBeenCalled()
  })

  it('does not let an older save restore settings or libraries after disconnect', async () => {
    const save = deferred<AudiobookshelfSettings>()
    const disconnect = deferred<void>()
    mockUpdateSettings.mockReturnValueOnce(save.promise)
    mockDisconnect.mockReturnValueOnce(disconnect.promise)
    const settings = await loadComposable()
    settings.settings.value = configuredSettings()
    settings.libraries.value = [library('current')]

    const saveResult = settings.saveSettings({ serverUrl: 'https://saved.example.com' })
    const disconnectResult = settings.disconnect()
    disconnect.resolve()
    await expect(disconnectResult).resolves.toBe(true)
    save.resolve(configuredSettings({ serverUrl: 'https://saved.example.com' }))
    await expect(saveResult).resolves.toBe(true)

    expect(settings.settings.value).toBeNull()
    expect(settings.libraries.value).toEqual([])
    expect(settings.librariesError.value).toBeNull()
    expect(settings.librariesLoading.value).toBe(false)
    expect(mockFetchLibraries).not.toHaveBeenCalled()
  })

  it('starts a fresh save-triggered discovery while initial discovery is pending', async () => {
    const initialDiscovery = deferred<AudiobookshelfLibrariesResponse>()
    const saveDiscovery = deferred<AudiobookshelfLibrariesResponse>()
    mockFetchLibraries.mockReturnValueOnce(initialDiscovery.promise).mockReturnValueOnce(saveDiscovery.promise)
    mockUpdateSettings.mockResolvedValueOnce(configuredSettings({ serverUrl: 'https://saved.example.com' }))
    const settings = await loadComposable()

    const initial = settings.fetchLibraries()
    const save = settings.saveSettings({ serverUrl: 'https://saved.example.com' })
    await Promise.resolve()

    expect(mockFetchLibraries).toHaveBeenCalledTimes(2)
    saveDiscovery.resolve({ libraries: [library('saved')] })
    await save
    expect(settings.libraries.value).toEqual([library('saved')])
    expect(settings.librariesLoading.value).toBe(false)

    initialDiscovery.resolve({ libraries: [library('initial')] })
    await initial

    expect(settings.libraries.value).toEqual([library('saved')])
    expect(settings.librariesError.value).toBeNull()
    expect(settings.librariesLoading.value).toBe(false)
  })

  it('ignores stale library success, error, and finally paths after a newer discovery starts', async () => {
    const initialDiscovery = deferred<AudiobookshelfLibrariesResponse>()
    const saveDiscovery = deferred<AudiobookshelfLibrariesResponse>()
    mockFetchLibraries.mockReturnValueOnce(initialDiscovery.promise).mockReturnValueOnce(saveDiscovery.promise)
    const settings = await loadComposable()

    const initial = settings.fetchLibraries()
    const save = settings.saveSettings({ apiToken: 'replacement-token' })
    await Promise.resolve()
    initialDiscovery.reject(new Error('stale discovery failed'))
    await initial

    expect(settings.librariesError.value).toBeNull()
    expect(settings.librariesLoading.value).toBe(true)

    saveDiscovery.resolve({ libraries: [library('fresh')] })
    await save

    expect(settings.libraries.value).toEqual([library('fresh')])
    expect(settings.librariesError.value).toBeNull()
    expect(settings.librariesLoading.value).toBe(false)
  })

  it('coalesces equivalent concurrent library discovery across composable instances', async () => {
    const discovery = deferred<AudiobookshelfLibrariesResponse>()
    mockFetchLibraries.mockReturnValueOnce(discovery.promise)
    const first = await loadComposable()
    const { useAudiobookshelfSettings } = await import('../useAudiobookshelfSettings')
    const second = useAudiobookshelfSettings()

    const firstLoad = first.fetchLibraries()
    const secondLoad = second.fetchLibraries()

    expect(mockFetchLibraries).toHaveBeenCalledTimes(1)
    discovery.resolve({ libraries: [library('shared')] })
    await Promise.all([firstLoad, secondLoad])

    expect(first.libraries.value).toEqual([library('shared')])
    expect(second.libraries.value).toEqual([library('shared')])
  })

  it('disconnect clears libraries and prevents a pending discovery from restoring them', async () => {
    const discovery = deferred<AudiobookshelfLibrariesResponse>()
    mockFetchLibraries.mockReturnValueOnce(discovery.promise)
    const settings = await loadComposable()
    settings.libraries.value = [library('current')]

    const load = settings.fetchLibraries()
    await expect(settings.disconnect()).resolves.toBe(true)
    discovery.resolve({ libraries: [library('stale')] })
    await load

    expect(settings.settings.value).toBeNull()
    expect(settings.libraries.value).toEqual([])
    expect(settings.librariesError.value).toBeNull()
    expect(settings.librariesLoading.value).toBe(false)
  })
})
