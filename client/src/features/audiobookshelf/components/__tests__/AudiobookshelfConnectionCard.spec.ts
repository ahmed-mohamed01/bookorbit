import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { AudiobookshelfConnectionTestResult, AudiobookshelfSettings, UpsertAudiobookshelfSettingsPayload } from '@bookorbit/types'
import AudiobookshelfConnectionCard from '../AudiobookshelfConnectionCard.vue'

const settings = ref<AudiobookshelfSettings | null>(null)
const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const error = ref<string | null>(null)
const testError = ref<string | null>(null)
const syncing = ref(false)
const isFullResync = ref(false)

const mocks = vi.hoisted(() => ({
  saveSettings: vi.fn<(payload: UpsertAudiobookshelfSettingsPayload) => Promise<boolean>>(),
  disconnect: vi.fn<() => Promise<boolean>>(),
  testConnection: vi.fn<() => Promise<AudiobookshelfConnectionTestResult>>(),
  syncNow: vi.fn<() => Promise<boolean>>(),
  fullResync: vi.fn<() => Promise<boolean>>(),
}))

const toastSuccess = vi.hoisted(() => vi.fn<(message: string) => void>())
const toastError = vi.hoisted(() => vi.fn<(message: string) => void>())

vi.mock('../../composables/useAudiobookshelfSettings', () => ({
  useAudiobookshelfSettings: () => ({
    settings,
    loading,
    saving,
    testing,
    error,
    testError,
    saveSettings: mocks.saveSettings,
    disconnect: mocks.disconnect,
    testConnection: mocks.testConnection,
  }),
}))

vi.mock('../../composables/useAudiobookshelfSync', () => ({
  useAudiobookshelfSync: () => ({
    syncing,
    isFullResync,
    syncNow: mocks.syncNow,
    fullResync: mocks.fullResync,
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

type Wrapper = ReturnType<typeof mount>

function findButton(wrapper: Wrapper, label: string) {
  return wrapper.findAll('button').find((b) => b.text().includes(label))
}

function serverInput(wrapper: Wrapper) {
  return wrapper.get('#audiobookshelf-server-url')
}

function tokenInput(wrapper: Wrapper) {
  return wrapper.get('#audiobookshelf-token')
}

describe('AudiobookshelfConnectionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settings.value = makeSettings()
    loading.value = false
    saving.value = false
    testing.value = false
    error.value = null
    testError.value = null
    syncing.value = false
    isFullResync.value = false
    mocks.saveSettings.mockResolvedValue(true)
    mocks.disconnect.mockResolvedValue(true)
    mocks.testConnection.mockResolvedValue({ success: true, username: 'neon' })
    mocks.syncNow.mockResolvedValue(true)
    mocks.fullResync.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never renders the saved token: input is empty with a keep-token placeholder', async () => {
    const wrapper = mount(AudiobookshelfConnectionCard)
    await flushPromises()

    const token = tokenInput(wrapper)
    expect((token.element as HTMLInputElement).value).toBe('')
    expect(token.attributes('type')).toBe('text')
    expect(token.classes()).toContain('input-secret')
    expect(token.attributes('placeholder')).toBe('Leave blank to keep the saved token')
    expect(wrapper.text()).toContain('Connected')
  })

  it('has no apiToken field to leak: the settings shape carries only tokenConfigured', async () => {
    const wrapper = mount(AudiobookshelfConnectionCard)
    await flushPromises()

    expect(settings.value).not.toHaveProperty('apiToken')
    expect(wrapper.html()).not.toContain('apiToken')
  })

  it('shows a paste-token placeholder when the connection is not configured', async () => {
    settings.value = makeSettings({ tokenConfigured: false, serverUrl: null })
    const wrapper = mount(AudiobookshelfConnectionCard)
    await flushPromises()

    expect(tokenInput(wrapper).attributes('placeholder')).toBe('Paste your Audiobookshelf API token')
    expect(wrapper.text()).toContain('Not configured')
  })

  it('blocks Save with an empty server URL and never calls the api', async () => {
    settings.value = makeSettings({ serverUrl: null, tokenConfigured: false })
    const wrapper = mount(AudiobookshelfConnectionCard)
    await flushPromises()

    await serverInput(wrapper).setValue('')
    await findButton(wrapper, 'Save connection')!.trigger('click')
    await flushPromises()

    expect(toastError).toHaveBeenCalledWith('Enter your Audiobookshelf server URL')
    expect(mocks.saveSettings).not.toHaveBeenCalled()
  })

  it('blocks Save with an empty token when the connection is not configured', async () => {
    settings.value = makeSettings({ serverUrl: null, tokenConfigured: false })
    const wrapper = mount(AudiobookshelfConnectionCard)
    await flushPromises()

    await serverInput(wrapper).setValue('https://new.example.com')
    await findButton(wrapper, 'Save connection')!.trigger('click')
    await flushPromises()

    expect(toastError).toHaveBeenCalledWith('Enter your Audiobookshelf API token')
    expect(mocks.saveSettings).not.toHaveBeenCalled()
  })

  it('blocks Test connection with an empty server URL', async () => {
    settings.value = makeSettings({ serverUrl: null, tokenConfigured: false })
    const wrapper = mount(AudiobookshelfConnectionCard)
    await flushPromises()

    await serverInput(wrapper).setValue('')
    await findButton(wrapper, 'Test connection')!.trigger('click')
    await flushPromises()

    expect(toastError).toHaveBeenCalledWith('Enter your Audiobookshelf server URL')
    expect(mocks.testConnection).not.toHaveBeenCalled()
  })

  it('saves with a trimmed token payload and clears the token input on success', async () => {
    const wrapper = mount(AudiobookshelfConnectionCard)
    await flushPromises()

    await tokenInput(wrapper).setValue('  fresh-token  ')
    await findButton(wrapper, 'Save connection')!.trigger('click')
    await flushPromises()

    expect(mocks.saveSettings).toHaveBeenCalledWith({ apiToken: 'fresh-token' })
    expect(toastSuccess).toHaveBeenCalledWith('Audiobookshelf connection saved')
    expect((tokenInput(wrapper).element as HTMLInputElement).value).toBe('')
  })

  it('tests the connection with a trimmed payload and shows success', async () => {
    const wrapper = mount(AudiobookshelfConnectionCard)
    await flushPromises()

    await tokenInput(wrapper).setValue('  probe-token  ')
    await findButton(wrapper, 'Test connection')!.trigger('click')
    await flushPromises()

    expect(mocks.testConnection).toHaveBeenCalledWith({ serverUrl: 'https://abs.example.com', apiToken: 'probe-token' })
    expect(toastSuccess).toHaveBeenCalledWith('Audiobookshelf connection successful')
  })

  it('disconnects and resets the form fields', async () => {
    const wrapper = mount(AudiobookshelfConnectionCard)
    await flushPromises()

    await tokenInput(wrapper).setValue('typed-token')
    await findButton(wrapper, 'Disconnect')!.trigger('click')
    await flushPromises()

    expect(mocks.disconnect).toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalledWith('Audiobookshelf disconnected')
    expect((tokenInput(wrapper).element as HTMLInputElement).value).toBe('')
  })

  it('disables Save and Test while saving is in flight', async () => {
    saving.value = true
    const wrapper = mount(AudiobookshelfConnectionCard)
    await flushPromises()

    expect(findButton(wrapper, 'Save connection')!.attributes('disabled')).toBeDefined()
    expect(findButton(wrapper, 'Test connection')!.attributes('disabled')).toBeDefined()
    expect(findButton(wrapper, 'Disconnect')!.attributes('disabled')).toBeDefined()
  })

  it('disables Test connection while a test is running', async () => {
    testing.value = true
    const wrapper = mount(AudiobookshelfConnectionCard)
    await flushPromises()

    expect(findButton(wrapper, 'Test connection')!.attributes('disabled')).toBeDefined()
  })
})
