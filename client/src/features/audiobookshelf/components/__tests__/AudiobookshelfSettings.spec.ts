import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { AudiobookshelfLibrary, AudiobookshelfSettings, UpsertAudiobookshelfSettingsPayload } from '@bookorbit/types'
import AudiobookshelfSettingsPage from '../AudiobookshelfSettings.vue'

const settings = ref<AudiobookshelfSettings | null>(null)
const saving = ref(false)
const error = ref<string | null>(null)
const libraries = ref<AudiobookshelfLibrary[]>([])
const librariesLoading = ref(false)
const librariesError = ref<string | null>(null)

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn<() => Promise<void>>(),
  fetchLibraries: vi.fn<() => Promise<void>>(),
  saveSettings: vi.fn<(payload: UpsertAudiobookshelfSettingsPayload) => Promise<boolean>>(),
}))

const toastSuccess = vi.hoisted(() => vi.fn<(message: string) => void>())
const toastError = vi.hoisted(() => vi.fn<(message: string) => void>())

vi.mock('../../composables/useAudiobookshelfSettings', () => ({
  useAudiobookshelfSettings: () => ({
    settings,
    saving,
    error,
    libraries,
    librariesLoading,
    librariesError,
    fetchSettings: mocks.fetchSettings,
    fetchLibraries: mocks.fetchLibraries,
    saveSettings: mocks.saveSettings,
  }),
}))

vi.mock('vue-sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
}))

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

function library(id: string, name: string): AudiobookshelfLibrary {
  return { id, name, mediaType: 'book', provider: 'audiobookshelf', excluded: false }
}

const stubs = {
  AudiobookshelfConnectionCard: true,
  AudiobookshelfSyncProgress: true,
  AudiobookshelfLinkedBooks: true,
  SettingsPageHeader: true,
}

type Wrapper = ReturnType<typeof mount>

function mountSettings() {
  return mount(AudiobookshelfSettingsPage, { global: { stubs } })
}

function findButton(wrapper: Wrapper, label: string) {
  return wrapper.findAll('button').find((b) => b.text().includes(label))
}

describe('AudiobookshelfSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settings.value = null
    saving.value = false
    error.value = null
    libraries.value = []
    librariesLoading.value = false
    librariesError.value = null
    mocks.fetchSettings.mockResolvedValue(undefined)
    mocks.fetchLibraries.mockResolvedValue(undefined)
    mocks.saveSettings.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches settings on mount when none are loaded yet', async () => {
    const wrapper = mountSettings()
    await flushPromises()

    expect(mocks.fetchSettings).toHaveBeenCalledTimes(1)
    expect(wrapper.exists()).toBe(true)
  })

  it('loads libraries on mount when already configured without re-fetching settings', async () => {
    settings.value = makeSettings()
    mountSettings()
    await flushPromises()

    expect(mocks.fetchSettings).not.toHaveBeenCalled()
    expect(mocks.fetchLibraries).toHaveBeenCalledTimes(1)
  })

  it('renders the three sync-option toggles when configured', async () => {
    settings.value = makeSettings()
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.text()).toContain('Reading status')
    expect(wrapper.text()).toContain('Playback position')
    expect(wrapper.text()).toContain('Listening sessions')
    expect(wrapper.findAll('[role="switch"]').length).toBeGreaterThanOrEqual(3)
  })

  it('does not render the sync-options section before a token is configured', async () => {
    settings.value = makeSettings({ tokenConfigured: false })
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.text()).not.toContain('Data to sync')
  })

  it('persists a toggled sync option through the composable', async () => {
    settings.value = makeSettings()
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.findAll('[role="switch"]')[0]!.trigger('click')
    await findButton(wrapper, 'Save sync options')!.trigger('click')
    await flushPromises()

    expect(mocks.saveSettings).toHaveBeenCalledWith({ syncStatus: false })
    expect(toastSuccess).toHaveBeenCalledWith('Audiobookshelf sync options saved')
  })

  it('renders the libraries list when configured', async () => {
    settings.value = makeSettings()
    libraries.value = [library('lib-1', 'Audiobooks'), library('lib-2', 'Podcasts')]
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.text()).toContain('Audiobooks')
    expect(wrapper.text()).toContain('Podcasts')
  })

  it('shows the library loading state while libraries are loading', async () => {
    settings.value = makeSettings()
    librariesLoading.value = true
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.text()).toContain('Loading libraries')
  })
})
