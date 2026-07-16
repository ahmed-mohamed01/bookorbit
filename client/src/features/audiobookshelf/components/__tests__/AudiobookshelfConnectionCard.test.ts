import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import AudiobookshelfConnectionCard from '../AudiobookshelfConnectionCard.vue'
import type { AudiobookshelfSettingsResponse } from '../../api/audiobookshelf.api'

const settings = ref<AudiobookshelfSettingsResponse | null>(null)
const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const settingsError = ref<string | null>(null)
const syncing = ref(false)
const isFullResync = ref(false)

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn<() => Promise<void>>(),
  saveSettings: vi.fn<() => Promise<boolean>>(),
  disconnect: vi.fn<() => Promise<boolean>>(),
  testConnection: vi.fn<() => Promise<{ valid: boolean }>>(),
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
    ...mocks,
  }),
}))

vi.mock('../../composables/useAudiobookshelfSync', () => ({
  useAudiobookshelfSync: () => ({ syncing, isFullResync, syncNow: mocks.syncNow, fullResync: mocks.fullResync }),
}))

vi.mock('vue-sonner', () => ({ toast: { success: vi.fn<() => void>(), error: vi.fn<() => void>() } }))

function configuredSettings(overrides: Partial<AudiobookshelfSettingsResponse> = {}): AudiobookshelfSettingsResponse {
  return {
    serverUrl: 'https://abs.example.com',
    tokenConfigured: true,
    enabled: true,
    syncStatus: true,
    syncPosition: true,
    syncSessions: true,
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
    syncing.value = false
    isFullResync.value = false
    mocks.fetchSettings.mockResolvedValue()
    mocks.saveSettings.mockResolvedValue(true)
    mocks.disconnect.mockResolvedValue(true)
    mocks.testConnection.mockResolvedValue({ valid: true })
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
})
