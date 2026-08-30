import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import type {
  AudiobookshelfLibrary,
  AudiobookshelfMappingSuggestions,
  AudiobookshelfSettings,
  UpsertAudiobookshelfSettingsPayload,
} from '@bookorbit/types'
import AudiobookshelfSettingsPage from '../AudiobookshelfSettings.vue'

const settings = ref<AudiobookshelfSettings | null>(null)
const saving = ref(false)
const suggestingMappings = ref(false)
const error = ref<string | null>(null)
const libraries = ref<AudiobookshelfLibrary[]>([])
const librariesLoading = ref(false)
const librariesError = ref<string | null>(null)
const localFolderPaths = ref<string[]>([])

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn<() => Promise<void>>(),
  fetchLibraries: vi.fn<() => Promise<void>>(),
  saveSettings: vi.fn<(payload: UpsertAudiobookshelfSettingsPayload) => Promise<boolean>>(),
  suggestPathMappings: vi.fn<() => Promise<AudiobookshelfMappingSuggestions | null>>(),
}))

const toastSuccess = vi.hoisted(() => vi.fn<(message: string) => void>())
const toastError = vi.hoisted(() => vi.fn<(message: string) => void>())
const toastInfo = vi.hoisted(() => vi.fn<(message: string) => void>())

vi.mock('../../composables/useAudiobookshelfSettings', () => ({
  useAudiobookshelfSettings: () => ({
    settings,
    saving,
    suggestingMappings,
    error,
    libraries,
    librariesLoading,
    librariesError,
    localFolderPaths,
    fetchSettings: mocks.fetchSettings,
    fetchLibraries: mocks.fetchLibraries,
    saveSettings: mocks.saveSettings,
    suggestPathMappings: mocks.suggestPathMappings,
  }),
}))

vi.mock('vue-sonner', () => ({
  toast: { success: toastSuccess, error: toastError, info: toastInfo },
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
    pathMappings: [],
    lastSyncedAt: null,
    lastSyncError: null,
    staleCount: 0,
    ...overrides,
  }
}

function library(id: string, name: string): AudiobookshelfLibrary {
  return { id, name, mediaType: 'book', folderPaths: [`/abs/${id}`] }
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
    suggestingMappings.value = false
    error.value = null
    libraries.value = []
    librariesLoading.value = false
    librariesError.value = null
    localFolderPaths.value = []
    mocks.fetchSettings.mockResolvedValue(undefined)
    mocks.fetchLibraries.mockResolvedValue(undefined)
    mocks.saveSettings.mockResolvedValue(true)
    mocks.suggestPathMappings.mockResolvedValue({ suggestions: [], scannedItems: 0 })
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

  it('renders saved path mappings under the libraries and saves edits with the sync options', async () => {
    settings.value = makeSettings({ pathMappings: [{ absPrefix: '/audiobooks', localPrefix: '/books' }] })
    const wrapper = mountSettings()
    await flushPromises()

    const absPrefix = wrapper.get('[data-testid="abs-path-prefix"]')
    expect((absPrefix.element as HTMLInputElement).value).toBe('/audiobooks')

    await absPrefix.setValue('  /audiobooks/scifi  ')
    await findButton(wrapper, 'Save sync options')!.trigger('click')
    await flushPromises()

    expect(mocks.saveSettings).toHaveBeenCalledWith({ pathMappings: [{ absPrefix: '/audiobooks/scifi', localPrefix: '/books' }] })
  })

  it('omits pathMappings from the sync-options payload when the rows are unchanged', async () => {
    settings.value = makeSettings({ pathMappings: [{ absPrefix: '/audiobooks', localPrefix: '/books' }] })
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.findAll('[role="switch"]')[0]!.trigger('click')
    await findButton(wrapper, 'Save sync options')!.trigger('click')
    await flushPromises()

    expect(mocks.saveSettings).toHaveBeenCalledWith({ syncStatus: false })
  })

  it('drops a half-filled mapping row from the saved payload', async () => {
    settings.value = makeSettings()
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('[data-testid="add-path-mapping"]').trigger('click')
    await wrapper.get('[data-testid="abs-path-prefix"]').setValue('/audiobooks')
    await findButton(wrapper, 'Save sync options')!.trigger('click')
    await flushPromises()

    expect(mocks.saveSettings).toHaveBeenCalledWith({})
  })

  it('appends suggested mappings as rows, skipping pairs already listed', async () => {
    settings.value = makeSettings({ pathMappings: [{ absPrefix: '/audiobooks', localPrefix: '/books' }] })
    mocks.suggestPathMappings.mockResolvedValue({
      suggestions: [
        { absPrefix: '/audiobooks', localPrefix: '/books', supportCount: 300 },
        { absPrefix: '/media/abs', localPrefix: '/media/books', supportCount: 120 },
      ],
      scannedItems: 431,
    })
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('[data-testid="suggest-path-mappings"]').trigger('click')
    await flushPromises()

    const absPrefixes = wrapper.findAll('[data-testid="abs-path-prefix"]').map((input) => (input.element as HTMLInputElement).value)
    expect(absPrefixes).toEqual(['/audiobooks', '/media/abs'])
    expect(toastSuccess).toHaveBeenCalledWith('1 mapping suggested from 431 books (120 matching items)')

    // Suggestions are never auto-saved: they reach the server only through the normal save.
    expect(mocks.saveSettings).not.toHaveBeenCalled()
    await findButton(wrapper, 'Save sync options')!.trigger('click')
    await flushPromises()
    expect(mocks.saveSettings).toHaveBeenCalledWith({
      pathMappings: [
        { absPrefix: '/audiobooks', localPrefix: '/books' },
        { absPrefix: '/media/abs', localPrefix: '/media/books' },
      ],
    })
  })

  it('stops appending suggestions at the twenty-row cap', async () => {
    settings.value = makeSettings({ pathMappings: Array.from({ length: 19 }, (_, i) => ({ absPrefix: `/abs/${i}`, localPrefix: `/books/${i}` })) })
    mocks.suggestPathMappings.mockResolvedValue({
      suggestions: [
        { absPrefix: '/media/abs', localPrefix: '/media/books', supportCount: 40 },
        { absPrefix: '/other/abs', localPrefix: '/other/books', supportCount: 30 },
      ],
      scannedItems: 88,
    })
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('[data-testid="suggest-path-mappings"]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('[data-testid="abs-path-prefix"]')).toHaveLength(20)
    expect(toastSuccess).toHaveBeenCalledWith('1 mapping suggested from 88 books (40 matching items)')
  })

  it('reports a run that found nothing new with a neutral toast and adds no rows', async () => {
    settings.value = makeSettings({ pathMappings: [{ absPrefix: '/audiobooks', localPrefix: '/books' }] })
    mocks.suggestPathMappings.mockResolvedValue({ suggestions: [], scannedItems: 431 })
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('[data-testid="suggest-path-mappings"]').trigger('click')
    await flushPromises()

    expect(toastInfo).toHaveBeenCalledWith('No new folder mappings found in 431 books')
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(wrapper.findAll('[data-testid="abs-path-prefix"]')).toHaveLength(1)
  })

  it('surfaces the API message when a suggestion run fails', async () => {
    settings.value = makeSettings()
    mocks.suggestPathMappings.mockResolvedValue(null)
    error.value = 'An Audiobookshelf inventory walk is already running'
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('[data-testid="suggest-path-mappings"]').trigger('click')
    await flushPromises()

    expect(toastError).toHaveBeenCalledWith('An Audiobookshelf inventory walk is already running')
  })

  it('disables the mapping actions while a suggestion run is in flight', async () => {
    settings.value = makeSettings()
    let release: (value: AudiobookshelfMappingSuggestions) => void = () => {}
    mocks.suggestPathMappings.mockImplementation(() => {
      suggestingMappings.value = true
      return new Promise((resolve) => {
        release = resolve
      })
    })
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('[data-testid="suggest-path-mappings"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="suggest-path-mappings"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-testid="add-path-mapping"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('Scanning')

    suggestingMappings.value = false
    release({ suggestions: [], scannedItems: 12 })
    await flushPromises()

    expect(wrapper.get('[data-testid="suggest-path-mappings"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).toContain('Suggest mappings')
  })

  it('keeps unsaved mapping rows when a sync run refetches the settings', async () => {
    settings.value = makeSettings()
    mocks.suggestPathMappings.mockResolvedValue({
      suggestions: [{ absPrefix: '/media/abs', localPrefix: '/media/books', supportCount: 120 }],
      scannedItems: 431,
    })
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('[data-testid="suggest-path-mappings"]').trigger('click')
    await flushPromises()

    settings.value = makeSettings()
    await flushPromises()

    const absPrefixes = wrapper.findAll('[data-testid="abs-path-prefix"]').map((input) => (input.element as HTMLInputElement).value)
    expect(absPrefixes).toEqual(['/media/abs'])
  })

  it('follows a refetch that changes the saved settings while the editor is clean', async () => {
    settings.value = makeSettings()
    libraries.value = [library('lib-1', 'Audiobooks'), library('lib-2', 'Podcasts')]
    const wrapper = mountSettings()
    await flushPromises()

    settings.value = makeSettings({
      syncStatus: false,
      excludedLibraryIds: ['lib-2'],
      pathMappings: [{ absPrefix: '/audiobooks', localPrefix: '/books' }],
    })
    await flushPromises()

    const switches = wrapper.findAll('[role="switch"]')
    expect(switches[0]!.attributes('aria-checked')).toBe('false')
    expect(switches[4]!.attributes('aria-checked')).toBe('false')
    const absPrefixes = wrapper.findAll('[data-testid="abs-path-prefix"]').map((input) => (input.element as HTMLInputElement).value)
    expect(absPrefixes).toEqual(['/audiobooks'])
  })

  it('keeps an unsaved library exclusion when a sync run refetches the settings', async () => {
    settings.value = makeSettings()
    libraries.value = [library('lib-1', 'Audiobooks'), library('lib-2', 'Podcasts')]
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.findAll('[role="switch"]')[3]!.trigger('click')
    expect(wrapper.findAll('[role="switch"]')[3]!.attributes('aria-checked')).toBe('false')

    settings.value = makeSettings()
    await flushPromises()

    expect(wrapper.findAll('[role="switch"]')[3]!.attributes('aria-checked')).toBe('false')
    await findButton(wrapper, 'Save sync options')!.trigger('click')
    await flushPromises()

    expect(mocks.saveSettings).toHaveBeenCalledWith({ excludedLibraryIds: ['lib-1'] })
  })

  it('offers folder candidates from locally selected libraries only, deduped and sorted', async () => {
    settings.value = makeSettings({ pathMappings: [{ absPrefix: '', localPrefix: '' }], excludedLibraryIds: ['lib-3'] })
    libraries.value = [
      { id: 'lib-1', name: 'Audiobooks', mediaType: 'book', folderPaths: ['/media/audiobooks', '/audiobooks'] },
      { id: 'lib-2', name: 'More', mediaType: 'book', folderPaths: ['/audiobooks'] },
      { id: 'lib-3', name: 'Excluded', mediaType: 'book', folderPaths: ['/never'] },
    ]
    localFolderPaths.value = ['/books']
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('[data-testid="abs-path-prefix"]').trigger('focus')
    const absOptions = wrapper.get('[data-testid="abs-path-prefix-options"]').findAll('[role="option"]')
    expect(absOptions.map((option) => option.text())).toEqual(['/audiobooks', '/media/audiobooks'])

    await wrapper.get('[data-testid="local-path-prefix"]').trigger('focus')
    const localOptions = wrapper.get('[data-testid="local-path-prefix-options"]').findAll('[role="option"]')
    expect(localOptions.map((option) => option.text())).toEqual(['/books'])
  })
})
