import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import type {
  AudiobookshelfLibrary,
  AudiobookshelfSettings as AudiobookshelfSettingsType,
  UpsertAudiobookshelfSettingsPayload,
} from '@bookorbit/types'
import AudiobookshelfSettings from '../AudiobookshelfSettings.vue'

const settings = ref<AudiobookshelfSettingsType | null>(null)
const libraries = ref<AudiobookshelfLibrary[]>([])
const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const error = ref<string | null>(null)
const librariesLoading = ref(false)
const librariesError = ref<string | null>(null)
const syncing = ref(false)
const isFullResync = ref(false)

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn<() => Promise<void>>(),
  fetchLibraries: vi.fn<() => Promise<void>>(),
  saveSettings: vi.fn<(payload: UpsertAudiobookshelfSettingsPayload) => Promise<boolean>>(),
  disconnect: vi.fn<() => Promise<boolean>>(),
  testConnection: vi.fn<() => Promise<{ success: boolean }>>(),
  syncNow: vi.fn<() => Promise<boolean>>(),
  fullResync: vi.fn<() => Promise<boolean>>(),
}))

vi.mock('../../composables/useAudiobookshelfSettings', () => ({
  useAudiobookshelfSettings: () => ({
    settings,
    loading,
    libraries,
    saving,
    testing,
    error,
    librariesLoading,
    librariesError,
    ...mocks,
  }),
}))

vi.mock('../../composables/useAudiobookshelfSync', () => ({
  useAudiobookshelfSync: () => ({ syncing, isFullResync, syncNow: mocks.syncNow, fullResync: mocks.fullResync }),
}))

vi.mock('vue-sonner', () => ({ toast: { success: vi.fn<() => void>(), error: vi.fn<() => void>() } }))

enableAutoUnmount(afterEach)

function configuredSettings(overrides: Partial<AudiobookshelfSettingsType> = {}): AudiobookshelfSettingsType {
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

const toggleSwitchStub = { props: ['modelValue', 'disabled'], template: '<button type="button" data-testid="toggle">toggle</button>' }

async function mountSettingsWithConnection() {
  const wrapper = mount(AudiobookshelfSettings, {
    props: { embedded: true },
    global: {
      stubs: {
        AudiobookshelfLinkedBooks: true,
        AudiobookshelfSyncProgress: true,
        ToggleSwitch: toggleSwitchStub,
      },
    },
  })
  await flushPromises()
  return wrapper
}

async function clickSaveConnection(wrapper: Awaited<ReturnType<typeof mountSettingsWithConnection>>): Promise<void> {
  await wrapper
    .findAll('button')
    .find((button) => button.text().includes('Save connection'))!
    .trigger('click')
  await flushPromises()
}

describe('AudiobookshelfSettings library selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settings.value = configuredSettings()
    libraries.value = [
      { id: 'fiction', name: 'Fiction', mediaType: 'book', provider: 'audible', excluded: false },
      { id: 'blinkist', name: 'Blinkist', mediaType: 'book', provider: 'audible', excluded: false },
    ]
    loading.value = false
    saving.value = false
    testing.value = false
    error.value = null
    librariesLoading.value = false
    librariesError.value = null
    syncing.value = false
    isFullResync.value = false
    mocks.fetchSettings.mockResolvedValue()
    mocks.fetchLibraries.mockResolvedValue()
    mocks.saveSettings.mockImplementation(async (payload) => {
      if (!settings.value) return true
      settings.value = {
        ...settings.value,
        ...(payload.serverUrl ? { serverUrl: payload.serverUrl } : {}),
        ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
        ...(payload.syncStatus !== undefined ? { syncStatus: payload.syncStatus } : {}),
        ...(payload.syncPosition !== undefined ? { syncPosition: payload.syncPosition } : {}),
        ...(payload.syncSessions !== undefined ? { syncSessions: payload.syncSessions } : {}),
        ...(payload.excludedLibraryIds ? { excludedLibraryIds: payload.excludedLibraryIds } : {}),
        tokenConfigured: payload.apiToken ? true : settings.value.tokenConfigured,
      }
      if ((payload.serverUrl || payload.apiToken) && settings.value.serverUrl && settings.value.tokenConfigured) {
        await mocks.fetchLibraries()
      }
      return true
    })
    mocks.disconnect.mockResolvedValue(true)
    mocks.testConnection.mockResolvedValue({ success: true })
    mocks.syncNow.mockResolvedValue(true)
    mocks.fullResync.mockResolvedValue(true)
  })

  it('renders libraries and saves a disabled library id', async () => {
    const wrapper = mount(AudiobookshelfSettings, {
      props: { embedded: true },
      global: {
        stubs: {
          AudiobookshelfConnectionCard: true,
          AudiobookshelfLinkedBooks: true,
          AudiobookshelfSyncProgress: true,
          ToggleSwitch: true,
        },
      },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Fiction')
    expect(wrapper.text()).toContain('Blinkist')

    const toggles = wrapper.findAllComponents({ name: 'ToggleSwitch' })
    await toggles[4]!.vm.$emit('update:modelValue', false)
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Save sync options'))!
      .trigger('click')

    expect(mocks.saveSettings).toHaveBeenCalledWith({ excludedLibraryIds: ['blinkist'] })
  })

  it('loads libraries once on initial configured mount', async () => {
    await mountSettingsWithConnection()

    expect(mocks.fetchLibraries).toHaveBeenCalledTimes(1)
  })

  it('refreshes libraries once after same-url token replacement with an empty current list', async () => {
    libraries.value = []
    const wrapper = await mountSettingsWithConnection()
    mocks.fetchLibraries.mockClear()

    await wrapper.get('#audiobookshelf-token').setValue('replacement-token')
    await clickSaveConnection(wrapper)

    expect(mocks.saveSettings).toHaveBeenCalledWith({ apiToken: 'replacement-token' })
    expect(mocks.fetchLibraries).toHaveBeenCalledTimes(1)
  })

  it('refreshes libraries once after same-url token replacement with a non-empty current list', async () => {
    const wrapper = await mountSettingsWithConnection()
    mocks.fetchLibraries.mockClear()

    await wrapper.get('#audiobookshelf-token').setValue('replacement-token')
    await clickSaveConnection(wrapper)

    expect(mocks.saveSettings).toHaveBeenCalledWith({ apiToken: 'replacement-token' })
    expect(mocks.fetchLibraries).toHaveBeenCalledTimes(1)
  })

  it('refreshes libraries once after a configured server URL change without token replacement', async () => {
    const wrapper = await mountSettingsWithConnection()
    mocks.fetchLibraries.mockClear()

    await wrapper.get('#audiobookshelf-server-url').setValue('https://new-abs.example.com')
    await clickSaveConnection(wrapper)

    expect(mocks.saveSettings).toHaveBeenCalledWith({ serverUrl: 'https://new-abs.example.com' })
    expect(mocks.fetchLibraries).toHaveBeenCalledTimes(1)
  })

  it('refreshes once for token replacement followed by a configured server URL change', async () => {
    const wrapper = await mountSettingsWithConnection()
    mocks.fetchLibraries.mockClear()

    await wrapper.get('#audiobookshelf-token').setValue('replacement-token')
    await clickSaveConnection(wrapper)
    await wrapper.get('#audiobookshelf-server-url').setValue('https://next-abs.example.com')
    await clickSaveConnection(wrapper)

    expect(mocks.saveSettings).toHaveBeenNthCalledWith(1, { apiToken: 'replacement-token' })
    expect(mocks.saveSettings).toHaveBeenNthCalledWith(2, { serverUrl: 'https://next-abs.example.com' })
    expect(mocks.fetchLibraries).toHaveBeenCalledTimes(2)
  })

  it('refreshes once after saving a configured server URL and replacement token together', async () => {
    const wrapper = await mountSettingsWithConnection()
    mocks.fetchLibraries.mockClear()

    await wrapper.get('#audiobookshelf-server-url').setValue('https://combined-abs.example.com')
    await wrapper.get('#audiobookshelf-token').setValue('replacement-token')
    await clickSaveConnection(wrapper)

    expect(mocks.saveSettings).toHaveBeenCalledWith({
      serverUrl: 'https://combined-abs.example.com',
      apiToken: 'replacement-token',
    })
    expect(mocks.fetchLibraries).toHaveBeenCalledTimes(1)
  })
})
