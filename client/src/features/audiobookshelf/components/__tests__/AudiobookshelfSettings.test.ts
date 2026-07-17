import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { AudiobookshelfLibrary, AudiobookshelfSettings as AudiobookshelfSettingsType } from '@bookorbit/types'
import AudiobookshelfSettings from '../AudiobookshelfSettings.vue'

const settings = ref<AudiobookshelfSettingsType | null>(null)
const libraries = ref<AudiobookshelfLibrary[]>([])
const saving = ref(false)
const error = ref<string | null>(null)
const librariesLoading = ref(false)
const librariesError = ref<string | null>(null)

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn<() => Promise<void>>(),
  fetchLibraries: vi.fn<() => Promise<void>>(),
  saveSettings: vi.fn<() => Promise<boolean>>(),
}))

vi.mock('../../composables/useAudiobookshelfSettings', () => ({
  useAudiobookshelfSettings: () => ({
    settings,
    libraries,
    saving,
    error,
    librariesLoading,
    librariesError,
    ...mocks,
  }),
}))

vi.mock('vue-sonner', () => ({ toast: { success: vi.fn<() => void>(), error: vi.fn<() => void>() } }))

describe('AudiobookshelfSettings library selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settings.value = {
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
    }
    libraries.value = [
      { id: 'fiction', name: 'Fiction', mediaType: 'book', provider: 'audible', excluded: false },
      { id: 'blinkist', name: 'Blinkist', mediaType: 'book', provider: 'audible', excluded: false },
    ]
    saving.value = false
    error.value = null
    librariesLoading.value = false
    librariesError.value = null
    mocks.fetchSettings.mockResolvedValue()
    mocks.fetchLibraries.mockResolvedValue()
    mocks.saveSettings.mockResolvedValue(true)
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
})
