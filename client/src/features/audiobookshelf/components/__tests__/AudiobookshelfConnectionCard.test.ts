import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { AudiobookshelfSettings } from '@bookorbit/types'
import AudiobookshelfConnectionCard from '../AudiobookshelfConnectionCard.vue'

const settings = ref<AudiobookshelfSettings | null>(null)
const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const settingsError = ref<string | null>(null)
const testError = ref<string | null>(null)
const syncing = ref(false)
const isFullResync = ref(false)

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn<() => Promise<void>>(),
  fetchLibraries: vi.fn<() => Promise<void>>(),
  saveSettings: vi.fn<() => Promise<boolean>>(),
  disconnect: vi.fn<() => Promise<boolean>>(),
  testConnection: vi.fn<() => Promise<{ success: boolean }>>(),
  syncNow: vi.fn<() => Promise<boolean>>(),
  fullResync: vi.fn<() => Promise<boolean>>(),
}))

vi.mock('../../composables/useAudiobookshelfSettings', () => ({
  useAudiobookshelfSettings: () => ({
    settings,
    loading,
    saving,
    testing,
    error: settingsError,
    testError,
    ...mocks,
  }),
}))

vi.mock('../../composables/useAudiobookshelfSync', () => ({
  useAudiobookshelfSync: () => ({ syncing, isFullResync, syncNow: mocks.syncNow, fullResync: mocks.fullResync }),
}))

vi.mock('vue-sonner', () => ({ toast: { success: vi.fn<() => void>(), error: vi.fn<() => void>() } }))

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
    lastSyncedAt: '2026-07-15T10:30:00.000Z',
    lastSyncError: null,
    ...overrides,
  }
}

async function mountCard() {
  const wrapper = mount(AudiobookshelfConnectionCard, {
    global: {
      stubs: {
        ToggleSwitch: { props: ['modelValue'], template: '<button type="button" data-testid="toggle">toggle</button>' },
      },
    },
  })
  await flushPromises()
  return wrapper
}

describe('AudiobookshelfConnectionCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settings.value = null
    loading.value = false
    saving.value = false
    testing.value = false
    settingsError.value = null
    testError.value = null
    syncing.value = false
    isFullResync.value = false
    mocks.fetchSettings.mockResolvedValue()
    mocks.fetchLibraries.mockResolvedValue()
    mocks.saveSettings.mockResolvedValue(true)
    mocks.disconnect.mockResolvedValue(true)
    mocks.testConnection.mockResolvedValue({ success: true })
    mocks.syncNow.mockResolvedValue(true)
    mocks.fullResync.mockResolvedValue(true)
  })

  it('renders the unconfigured state', async () => {
    const wrapper = await mountCard()

    expect(wrapper.get('[data-testid="connection-status"]').text()).toContain('Not configured')
    expect(wrapper.get('#audiobookshelf-server-url').attributes('placeholder')).toBe('https://audiobooks.example.com')
    expect(wrapper.findAll('button').some((button) => button.text() === 'Sync now')).toBe(false)
  })

  it('renders the connected state and sync actions', async () => {
    settings.value = configuredSettings()
    const wrapper = await mountCard()

    expect(wrapper.get('[data-testid="connection-status"]').text()).toContain('Connected')
    expect((wrapper.get('#audiobookshelf-server-url').element as HTMLInputElement).value).toBe('https://abs.example.com')
    expect(wrapper.get('[data-testid="last-sync-error"]').text()).toBe('None')
    expect(wrapper.findAll('button').map((button) => button.text())).toContain('Sync now')
    expect(wrapper.findAll('button').map((button) => button.text())).toContain('Full resync')
  })

  it('surfaces the last sync error from a configured connection', async () => {
    settings.value = configuredSettings({ lastSyncError: 'Audiobookshelf request timed out' })
    const wrapper = await mountCard()

    const lastError = wrapper.get('[data-testid="last-sync-error"]')
    expect(lastError.text()).toBe('Audiobookshelf request timed out')
    expect(lastError.classes()).toContain('text-destructive')
  })

  it('saves a replacement token without owning library discovery', async () => {
    settings.value = configuredSettings()
    const wrapper = await mountCard()

    await wrapper.get('#audiobookshelf-token').setValue('replacement-token')
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Save connection'))!
      .trigger('click')
    await flushPromises()

    expect(mocks.saveSettings).toHaveBeenCalledWith({ apiToken: 'replacement-token' })
    expect(mocks.fetchLibraries).not.toHaveBeenCalled()
  })

  it('disables connection testing during save or disconnect mutations', async () => {
    saving.value = true
    settings.value = configuredSettings()
    const wrapper = await mountCard()

    const testButton = wrapper.findAll('button').find((button) => button.text().includes('Test connection'))
    expect(testButton?.attributes('disabled')).toBeDefined()

    await testButton!.trigger('click')
    await flushPromises()

    expect(mocks.testConnection).not.toHaveBeenCalled()
  })
})
