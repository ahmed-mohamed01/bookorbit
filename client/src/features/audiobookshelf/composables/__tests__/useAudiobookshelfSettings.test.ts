import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AudiobookshelfConnectionTestPayload,
  AudiobookshelfConnectionTestResult,
  AudiobookshelfLibrariesResponse,
  AudiobookshelfLibrary,
  AudiobookshelfSettings,
  UpsertAudiobookshelfSettingsPayload,
} from '@bookorbit/types'
import { fetchAudiobookshelfLibraries, updateAudiobookshelfSettings } from '../../api/audiobookshelf.api'

vi.mock('../../api/audiobookshelf.api', () => ({
  disconnectAudiobookshelf: vi.fn<() => Promise<void>>(),
  fetchAudiobookshelfLibraries: vi.fn<() => Promise<AudiobookshelfLibrariesResponse>>(),
  fetchAudiobookshelfSettings: vi.fn<() => Promise<AudiobookshelfSettings>>(),
  testAudiobookshelfConnection: vi.fn<(payload: AudiobookshelfConnectionTestPayload) => Promise<AudiobookshelfConnectionTestResult>>(),
  updateAudiobookshelfSettings: vi.fn<(payload: UpsertAudiobookshelfSettingsPayload) => Promise<AudiobookshelfSettings>>(),
}))

const mockFetchLibraries = vi.mocked(fetchAudiobookshelfLibraries)
const mockUpdateSettings = vi.mocked(updateAudiobookshelfSettings)

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
    mockUpdateSettings.mockResolvedValue(configuredSettings())
    mockFetchLibraries.mockResolvedValue({ libraries: [library('fiction')] })
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
})
