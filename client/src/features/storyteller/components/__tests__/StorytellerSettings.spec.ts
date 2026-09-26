import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import type { Library, StorytellerConnectionTestResult, StorytellerSettings } from '@bookorbit/types'
import type { StorytellerSettingsDraft } from '../../composables/useStorytellerSettings'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import StorytellerSettingsPage from '../StorytellerSettings.vue'

const settings = ref<StorytellerSettings | null>(null)
const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const error = ref<string | null>(null)
const libraries = ref<Library[]>([])
const canManage = ref(true)

const mocks = vi.hoisted(() => ({
  fetchSettings: vi.fn<() => Promise<void>>(),
  saveSettings: vi.fn<(draft: StorytellerSettingsDraft) => Promise<boolean>>(),
  testConnection: vi.fn<() => Promise<StorytellerConnectionTestResult | null>>(),
  fetchLibraries: vi.fn<() => Promise<void>>(),
}))

const toastSuccess = vi.hoisted(() => vi.fn<(message: string) => void>())
const toastError = vi.hoisted(() => vi.fn<(message: string) => void>())

vi.mock('../../composables/useStorytellerSettings', () => ({
  useStorytellerSettings: () => ({
    settings,
    loading,
    saving,
    testing,
    error,
    fetchSettings: mocks.fetchSettings,
    saveSettings: mocks.saveSettings,
    testConnection: mocks.testConnection,
  }),
}))

vi.mock('@/features/auth/composables/usePermissions', () => ({
  usePermissions: () => ({ hasPermission: () => canManage.value }),
}))

vi.mock('@/features/library/composables/useLibraries', () => ({
  useLibraries: () => ({ libraries, fetchLibraries: mocks.fetchLibraries }),
}))

vi.mock('vue-sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
}))

function makeSettings(overrides: Partial<StorytellerSettings> = {}): StorytellerSettings {
  return {
    serverUrl: 'https://storyteller.example.com',
    username: 'bookorbit',
    passwordConfigured: true,
    pathMappings: [],
    targetLibraryId: null,
    targetFolderId: null,
    transport: 'auto',
    deleteRemoteAfterImport: false,
    collectionName: null,
    lastCheckedAt: null,
    lastCheck: null,
    ...overrides,
  }
}

function makeCheck(overrides: Partial<StorytellerConnectionTestResult> = {}): StorytellerConnectionTestResult {
  return {
    ok: true,
    checkedAt: '2026-09-22T10:30:00.000Z',
    serverVersion: '1.4.0',
    capabilities: ['read-along'],
    readaloudLocationType: 'CUSTOM_FOLDER',
    readaloudLocation: '/read-along',
    importMode: 'reference',
    aligner: 'ctc',
    sharedPathsReady: true,
    effectiveTransport: 'shared-paths',
    problems: [],
    error: null,
    ...overrides,
  }
}

function makeLibrary(overrides: Partial<Library> = {}): Library {
  return {
    id: 1,
    type: 'books',
    name: 'Read-along',
    displayOrder: 0,
    coverAspectRatio: '2/3',
    watch: false,
    metadataPrecedence: [],
    formatPriority: [],
    allowedFormats: ['epub'],
    organizationMode: 'book_per_file',
    addedAtSource: 'imported',
    excludePatterns: [],
    readingThreshold: 0.9,
    markAsFinishedPercentComplete: 0.98,
    fileWriteEnabled: false,
    fileWriteWriteCover: false,
    fileWriteEpubEnabled: false,
    fileWriteEpubMaxFileSizeMb: 0,
    fileWriteFb2Enabled: false,
    fileWriteFb2MaxFileSizeMb: 0,
    fileWritePdfEnabled: false,
    fileWritePdfMaxFileSizeMb: 0,
    fileWriteCbxEnabled: false,
    fileWriteCbxMaxFileSizeMb: 0,
    fileWriteKindleEnabled: false,
    fileWriteKindleMaxFileSizeMb: 0,
    fileWriteAudioEnabled: false,
    fileWriteAudioMaxFileSizeMb: 0,
    fileRenameEnabled: false,
    folders: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

// What /api/v1/libraries actually returns for anyone who is not a superuser: findAllForUser has no
// allowedFormats column, so the field never reaches the client.
function makeLibraryWithoutAllowedFormats(overrides: Partial<Library> = {}): Library {
  const library = makeLibrary(overrides)
  delete (library as Partial<Library>).allowedFormats
  return library
}

const stubs = { SettingsPageHeader: true }

function mountSettings() {
  return mount(StorytellerSettingsPage, { global: { stubs } })
}

describe('StorytellerSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settings.value = null
    loading.value = false
    saving.value = false
    testing.value = false
    error.value = null
    libraries.value = []
    canManage.value = true
    mocks.fetchSettings.mockResolvedValue(undefined)
    mocks.saveSettings.mockResolvedValue(true)
    mocks.testConnection.mockResolvedValue(null)
    mocks.fetchLibraries.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows a no-permission message and never fetches when the user lacks ManageAppSettings', async () => {
    canManage.value = false
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.text()).toContain('You do not have permission to use any integrations.')
    expect(mocks.fetchSettings).not.toHaveBeenCalled()
  })

  it('fetches settings and libraries on mount when permitted', async () => {
    settings.value = makeSettings()
    mountSettings()
    await flushPromises()

    expect(mocks.fetchSettings).toHaveBeenCalledTimes(1)
    expect(mocks.fetchLibraries).toHaveBeenCalledTimes(1)
  })

  it('shows the password-configured indicator when a password is already stored', async () => {
    settings.value = makeSettings({ passwordConfigured: true })
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.find('[data-testid="password-configured"]').exists()).toBe(true)
  })

  it('does not show the password-configured indicator before any password is stored', async () => {
    settings.value = makeSettings({ passwordConfigured: false })
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.find('[data-testid="password-configured"]').exists()).toBe(false)
  })

  it('saves the current form values and shows a success toast', async () => {
    settings.value = makeSettings({ serverUrl: 'https://storyteller.example.com', username: 'bookorbit' })
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('#storyteller-collection-name').setValue('BookOrbit')
    await wrapper.get('[data-testid="save-storyteller-settings"]').trigger('click')
    await flushPromises()

    expect(mocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: 'https://storyteller.example.com', username: 'bookorbit', collectionName: 'BookOrbit' }),
    )
    expect(toastSuccess).toHaveBeenCalledWith('Storyteller settings saved')
  })

  it('shows an error toast when saving fails', async () => {
    settings.value = makeSettings()
    mocks.saveSettings.mockResolvedValue(false)
    error.value = 'Invalid server URL'
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('[data-testid="save-storyteller-settings"]').trigger('click')
    await flushPromises()

    expect(toastError).toHaveBeenCalledWith('Invalid server URL')
  })

  describe('when the server URL is edited away from the one the saved password belongs to', () => {
    // The server clears the stored password on a host change that carries no password of its own, and
    // the save sends serverUrl on any diff. Inviting a blank save here silently destroys the
    // connection: getConnection() goes null and every read-along row reads 'not_configured'.
    it('stops promising to keep the password, says what would happen and refuses the save', async () => {
      settings.value = makeSettings({ serverUrl: 'http://storyteller.example.com', passwordConfigured: true })
      const wrapper = mountSettings()
      await flushPromises()

      expect(wrapper.get('#storyteller-password').attributes('placeholder')).toBe('Leave blank to keep the saved password')
      expect(wrapper.find('[data-testid="password-configured"]').exists()).toBe(true)

      await wrapper.get('#storyteller-server-url').setValue('https://storyteller.example.com')

      expect(wrapper.get('#storyteller-password').attributes('placeholder')).toBe('Enter the password for this Storyteller server')
      expect(wrapper.find('[data-testid="password-configured"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="password-cleared-warning"]').text()).toContain('belongs to the server URL that is stored')
      expect(wrapper.get('[data-testid="save-storyteller-settings"]').attributes('disabled')).toBeDefined()

      await wrapper.get('[data-testid="save-storyteller-settings"]').trigger('click')
      await flushPromises()
      expect(mocks.saveSettings).not.toHaveBeenCalled()
    })

    it('releases the save as soon as a password for the new server is typed', async () => {
      settings.value = makeSettings({ serverUrl: 'http://storyteller.example.com', passwordConfigured: true })
      const wrapper = mountSettings()
      await flushPromises()

      await wrapper.get('#storyteller-server-url').setValue('https://storyteller.example.com')
      await wrapper.get('#storyteller-password').setValue('new-password')

      expect(wrapper.find('[data-testid="password-cleared-warning"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="save-storyteller-settings"]').attributes('disabled')).toBeUndefined()
    })

    it('leaves a trailing slash and an unchanged URL alone, and says nothing before a password is stored', async () => {
      settings.value = makeSettings({ serverUrl: 'https://storyteller.example.com', passwordConfigured: true })
      const wrapper = mountSettings()
      await flushPromises()

      await wrapper.get('#storyteller-server-url').setValue('https://storyteller.example.com/')

      expect(wrapper.find('[data-testid="password-cleared-warning"]').exists()).toBe(false)
      expect(wrapper.get('[data-testid="save-storyteller-settings"]').attributes('disabled')).toBeUndefined()

      settings.value = makeSettings({ serverUrl: 'http://storyteller.example.com', passwordConfigured: false })
      const unset = mountSettings()
      await flushPromises()
      await unset.get('#storyteller-server-url').setValue('https://storyteller.example.com')

      expect(unset.find('[data-testid="password-cleared-warning"]').exists()).toBe(false)
      expect(unset.get('[data-testid="save-storyteller-settings"]').attributes('disabled')).toBeUndefined()
    })
  })

  it('renders a successful test-connection result with its details and problem hints', async () => {
    settings.value = makeSettings()
    mocks.testConnection.mockResolvedValue({
      ok: true,
      checkedAt: '2026-09-22T00:00:00.000Z',
      serverVersion: '1.4.0',
      capabilities: ['read-along'],
      readaloudLocationType: 'CUSTOM_FOLDER',
      readaloudLocation: '/read-along',
      importMode: 'reference',
      aligner: 'ctc',
      sharedPathsReady: false,
      effectiveTransport: 'api-transfer',
      problems: ['no_path_mappings'],
      error: null,
    })
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('[data-testid="test-connection"]').trigger('click')
    await flushPromises()

    const result = wrapper.get('[data-testid="test-result"]')
    expect(result.text()).toContain('1.4.0')
    expect(result.text()).toContain('Custom folder')
    expect(result.text()).toContain('/read-along')
    expect(result.text()).toContain('API transfer')
    expect(result.text()).toContain('Not ready')
    expect(result.text()).toContain("Add a path mapping so Storyteller can read BookOrbit's library folders")
  })

  it('disables the test-connection button until the connection is configured', async () => {
    settings.value = makeSettings({ serverUrl: null, username: null })
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.get('[data-testid="test-connection"]').attributes('disabled')).toBeDefined()
  })

  it('says the pinned shared-paths transport is unusable rather than unknown', async () => {
    settings.value = makeSettings({ transport: 'shared-paths' })
    mocks.testConnection.mockResolvedValue({
      ok: true,
      checkedAt: '2026-09-22T00:00:00.000Z',
      serverVersion: null,
      capabilities: [],
      readaloudLocationType: 'SUFFIX',
      readaloudLocation: '(readaloud)',
      importMode: 'reference',
      aligner: null,
      sharedPathsReady: false,
      effectiveTransport: null,
      problems: ['readaloud_location_not_custom_folder'],
      error: null,
    })
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('[data-testid="test-connection"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="test-result"]').text()).toContain('None: shared paths are not ready')
  })

  it('enables the test-connection button from the typed form before anything is saved', async () => {
    settings.value = makeSettings({ serverUrl: null, username: null, passwordConfigured: false })
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('#storyteller-server-url').setValue('https://storyteller.example.com')
    await wrapper.get('#storyteller-username').setValue('bookorbit')
    await wrapper.get('#storyteller-password').setValue('typed-password')

    expect(wrapper.get('[data-testid="test-connection"]').attributes('disabled')).toBeUndefined()
  })

  it('tests the typed form values rather than the stored connection', async () => {
    settings.value = makeSettings({ passwordConfigured: true })
    mocks.testConnection.mockResolvedValue(null)
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('#storyteller-server-url').setValue('https://draft.example.com')
    await wrapper.get('[data-testid="test-connection"]').trigger('click')
    await flushPromises()

    expect(mocks.testConnection).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: 'https://draft.example.com' }))
  })

  it('adds and removes path mapping rows', async () => {
    settings.value = makeSettings()
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('[data-testid="add-path-mapping"]').trigger('click')
    expect(wrapper.findAll('[data-testid="local-prefix"]')).toHaveLength(1)

    await wrapper.get('[data-testid="local-prefix"]').setValue('/books')
    await wrapper.get('[data-testid="remote-prefix"]').setValue('/data/books')
    await wrapper.get('[data-testid="save-storyteller-settings"]').trigger('click')
    await flushPromises()

    expect(mocks.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ pathMappings: [{ localPrefix: '/books', remotePrefix: '/data/books' }] }),
    )

    await wrapper.get('[data-testid="remove-path-mapping"]').trigger('click')
    expect(wrapper.findAll('[data-testid="local-prefix"]')).toHaveLength(0)
  })

  it('keeps the very same input focused while a path prefix is typed into it', async () => {
    settings.value = makeSettings()
    const wrapper = mount(StorytellerSettingsPage, { global: { stubs }, attachTo: document.body })
    await flushPromises()

    await wrapper.get('[data-testid="add-path-mapping"]').trigger('click')
    const input = wrapper.get('[data-testid="local-prefix"]').element as HTMLInputElement
    input.focus()
    expect(document.activeElement).toBe(input)

    // One keystroke. A key that includes the field's own value would unmount this element and mount a
    // replacement, so the caret would land on <body> and the next character would go nowhere.
    input.value = '/'
    await wrapper.get('[data-testid="local-prefix"]').trigger('input')

    expect(wrapper.get('[data-testid="local-prefix"]').element).toBe(input)
    expect(document.activeElement).toBe(input)

    input.value = '/books'
    await wrapper.get('[data-testid="local-prefix"]').trigger('input')
    expect(wrapper.get<HTMLInputElement>('[data-testid="local-prefix"]').element.value).toBe('/books')
    wrapper.unmount()
  })

  it('drops a half-filled mapping row from the saved payload', async () => {
    settings.value = makeSettings()
    const wrapper = mountSettings()
    await flushPromises()

    await wrapper.get('[data-testid="add-path-mapping"]').trigger('click')
    await wrapper.get('[data-testid="local-prefix"]').setValue('/books')
    await wrapper.get('[data-testid="save-storyteller-settings"]').trigger('click')
    await flushPromises()

    expect(mocks.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ pathMappings: [] }))
  })

  it('resets the chosen folder when the target library changes', async () => {
    const libraryOne = makeLibrary({ id: 1, name: 'Fiction', folders: [{ id: 10, path: '/books/fiction', role: 'local', createdAt: '' }] })
    const libraryTwo = makeLibrary({ id: 2, name: 'Read-along', folders: [{ id: 20, path: '/books/read-along', role: 'local', createdAt: '' }] })
    libraries.value = [libraryOne, libraryTwo]
    settings.value = makeSettings({ targetLibraryId: 1, targetFolderId: 10 })
    const wrapper = mountSettings()
    await flushPromises()

    expect((wrapper.get('#storyteller-target-folder').element as HTMLSelectElement).value).toBe('10')

    await wrapper.get('#storyteller-target-library').setValue('2')

    expect((wrapper.get('#storyteller-target-folder').element as HTMLSelectElement).value).toBe('')
  })

  it('only offers target libraries the read-along build would accept', async () => {
    libraries.value = [
      makeLibrary({ id: 1, name: 'Read-alongs', allowedFormats: ['epub'] }),
      makeLibrary({ id: 2, name: 'Anything', allowedFormats: [] }),
      makeLibrary({ id: 3, name: 'Audiobooks', allowedFormats: ['m4b'] }),
      makeLibrary({ id: 4, name: 'Podcasts', type: 'podcasts' }),
    ]
    settings.value = makeSettings()
    const wrapper = mountSettings()
    await flushPromises()

    const options = wrapper
      .get('#storyteller-target-library')
      .findAll('option')
      .map((option) => option.text())
    expect(options).toContain('Read-alongs')
    expect(options).toContain('Anything')
    expect(options).not.toContain('Audiobooks')
    expect(options).not.toContain('Podcasts')
  })

  it('offers a library the API described without a format list, instead of blanking the page', async () => {
    libraries.value = [makeLibraryWithoutAllowedFormats({ id: 1, name: 'Everything' }), makeLibrary({ id: 2, name: 'Read-alongs' })]
    settings.value = makeSettings()
    const wrapper = mountSettings()
    await flushPromises()

    const options = wrapper
      .get('#storyteller-target-library')
      .findAll('option')
      .map((option) => option.text())
    expect(options).toContain('Everything')
    expect(options).toContain('Read-alongs')
  })

  it('starts from the instance default of deleting the Storyteller copy after import', async () => {
    settings.value = null
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.getComponent(ToggleSwitch).props('modelValue')).toBe(true)
  })

  it('caps rows and the collection name where the DTO does, not below it', async () => {
    settings.value = makeSettings()
    const wrapper = mountSettings()
    await flushPromises()

    const add = wrapper.get('[data-testid="add-path-mapping"]')
    for (let i = 0; i < 20; i += 1) await add.trigger('click')

    expect(wrapper.findAll('[data-testid="local-prefix"]')).toHaveLength(20)
    expect(add.attributes('disabled')).toBeUndefined()
    expect(wrapper.get('#storyteller-collection-name').attributes('maxlength')).toBe('255')
  })

  it('hides the delete-remote-after-import toggle for the shared-paths transport', async () => {
    settings.value = makeSettings({ transport: 'shared-paths' })
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.text()).not.toContain('Delete the Storyteller copy after import')

    await wrapper.get('#storyteller-transport').setValue('api-transfer')

    expect(wrapper.text()).toContain('Delete the Storyteller copy after import')
  })

  // A failed settings load used to render an ordinary empty form, so a 503 or an expired session
  // looked exactly like "not configured". Every sibling integration card shows the error inline.
  it('shows a failed settings load instead of an empty form', async () => {
    error.value = 'Storyteller settings could not be loaded'
    const wrapper = mountSettings()
    await flushPromises()

    expect(wrapper.get('[data-testid="storyteller-settings-error"]').text()).toContain('could not be loaded')
  })

  // Audiobookshelf reads remote prefix on the left, BookOrbit on the right. Two mapping editors in
  // one settings section reading the same arrow in opposite directions is how a mapping gets typed
  // backwards, which silently downgrades every build to uploading the whole audiobook.
  it('orders the mapping row Storyteller first, matching the other mapping editor', async () => {
    settings.value = makeSettings({ pathMappings: [{ localPrefix: '/books', remotePrefix: '/libraries/ebooks' }] })
    const wrapper = mountSettings()
    await flushPromises()

    const inputs = wrapper.findAll('[data-testid="remote-prefix"], [data-testid="local-prefix"]')
    expect(inputs[0]!.attributes('data-testid')).toBe('remote-prefix')
    expect(inputs[1]!.attributes('data-testid')).toBe('local-prefix')
  })

  // A prefix that does not match is not an error, it is a silent downgrade to uploading the whole
  // audiobook. The panel already holds every library folder path, so nothing has to be retyped.
  describe('path prefix suggestions', () => {
    it('offers every library folder path for the BookOrbit prefix and saves the picked one', async () => {
      libraries.value = [
        makeLibrary({ id: 1, name: 'Ebooks', folders: [{ id: 10, path: '/books/ebooks', role: 'local', createdAt: '' }] }),
        makeLibrary({ id: 2, name: 'Audiobooks', folders: [{ id: 20, path: '/books/audio', role: 'local', createdAt: '' }] }),
      ]
      settings.value = makeSettings()
      const wrapper = mountSettings()
      await flushPromises()

      await wrapper.get('[data-testid="add-path-mapping"]').trigger('click')
      await wrapper.get('[data-testid="local-prefix"]').trigger('focus')

      const options = wrapper.get('[data-testid="local-prefix-options"]').findAll('[role="option"]')
      expect(options.map((option) => option.text())).toEqual(['/books/audio', '/books/ebooks'])

      await options[0]!.trigger('click')
      await wrapper.get('[data-testid="remote-prefix"]').setValue('/data/audio')
      await wrapper.get('[data-testid="save-storyteller-settings"]').trigger('click')
      await flushPromises()

      expect(mocks.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ pathMappings: [{ localPrefix: '/books/audio', remotePrefix: '/data/audio' }] }),
      )
    })

    it("offers Storyteller's own read-aloud folder for the Storyteller prefix once a check has reported one", async () => {
      settings.value = makeSettings({ lastCheck: makeCheck({ readaloudLocation: '/srv/storyteller/read-along' }) })
      const wrapper = mountSettings()
      await flushPromises()

      await wrapper.get('[data-testid="add-path-mapping"]').trigger('click')
      await wrapper.get('[data-testid="remote-prefix"]').trigger('focus')

      expect(wrapper.get('[data-testid="remote-prefix-options"]').text()).toContain('/srv/storyteller/read-along')
    })

    it('suggests nothing on the Storyteller side when the read-aloud location is not a real folder', async () => {
      settings.value = makeSettings({ lastCheck: makeCheck({ readaloudLocationType: 'SUFFIX', readaloudLocation: '(readaloud)' }) })
      const wrapper = mountSettings()
      await flushPromises()

      await wrapper.get('[data-testid="add-path-mapping"]').trigger('click')
      await wrapper.get('[data-testid="remote-prefix"]').trigger('focus')

      expect(wrapper.find('[data-testid="remote-prefix-options"]').exists()).toBe(false)
    })
  })

  // A failed saved check is what blocks every user's Generate button, so the page that owns the
  // connection has to say so without anyone pressing Test first.
  describe('saved connection status', () => {
    it('reports a passing saved check and when it ran', async () => {
      settings.value = makeSettings({ lastCheck: makeCheck(), lastCheckedAt: '2026-09-22T10:30:00.000Z' })
      const wrapper = mountSettings()
      await flushPromises()

      const status = wrapper.get('[data-testid="connection-status"]')
      expect(status.text()).toContain('Connected')
      expect(status.text()).toContain('Checked')
      expect(status.text()).toContain('2026')
    })

    it('reports a failing saved check and seeds the detail panel from it', async () => {
      settings.value = makeSettings({
        lastCheck: makeCheck({ ok: false, error: 'Storyteller rejected the credentials', problems: ['auth_failed'] }),
        lastCheckedAt: '2026-09-22T10:30:00.000Z',
      })
      const wrapper = mountSettings()
      await flushPromises()

      expect(wrapper.get('[data-testid="connection-status"]').text()).toContain('Connection failed')

      const result = wrapper.get('[data-testid="test-result"]')
      expect(result.text()).toContain('Storyteller rejected the credentials')
      expect(result.text()).toContain('Check the Storyteller username and password')
      expect(mocks.testConnection).not.toHaveBeenCalled()
    })

    it('says a stored connection has never been checked rather than claiming it works', async () => {
      settings.value = makeSettings()
      const wrapper = mountSettings()
      await flushPromises()

      expect(wrapper.get('[data-testid="connection-status"]').text()).toContain('Not checked yet')
      expect(wrapper.find('[data-testid="test-result"]').exists()).toBe(false)
    })

    it('says not configured while the connection is incomplete', async () => {
      settings.value = makeSettings({ serverUrl: null, username: null, passwordConfigured: false })
      const wrapper = mountSettings()
      await flushPromises()

      expect(wrapper.get('[data-testid="connection-status"]').text()).toContain('Not configured')
    })

    it('lets a manual test replace the seeded state', async () => {
      settings.value = makeSettings({ lastCheck: makeCheck({ ok: false, error: 'Connection refused' }) })
      mocks.testConnection.mockResolvedValue(makeCheck({ serverVersion: '1.5.0' }))
      const wrapper = mountSettings()
      await flushPromises()

      expect(wrapper.get('[data-testid="connection-status"]').text()).toContain('Connection failed')

      await wrapper.get('[data-testid="test-connection"]').trigger('click')
      await flushPromises()

      expect(wrapper.get('[data-testid="connection-status"]').text()).toContain('Connected')
      expect(wrapper.get('[data-testid="test-result"]').text()).toContain('1.5.0')
    })
  })

  // The seeded check describes the host it was run against. A save that points the connection at a
  // different host has to drop it, or the chip keeps reporting a host nobody has ever tested.
  describe('when a save changes the connected host', () => {
    it('drops the seeded check so the chip falls back to unchecked', async () => {
      settings.value = makeSettings({
        serverUrl: 'http://storyteller.example.com',
        passwordConfigured: true,
        lastCheck: makeCheck(),
        lastCheckedAt: '2026-09-22T10:30:00.000Z',
      })
      mocks.saveSettings.mockImplementation(async () => {
        settings.value = makeSettings({
          serverUrl: 'https://new-storyteller.example.com',
          passwordConfigured: true,
          lastCheck: null,
          lastCheckedAt: null,
        })
        return true
      })
      const wrapper = mountSettings()
      await flushPromises()

      expect(wrapper.get('[data-testid="connection-status"]').text()).toContain('Connected')

      await wrapper.get('#storyteller-server-url').setValue('https://new-storyteller.example.com')
      await wrapper.get('#storyteller-password').setValue('new-password')
      await wrapper.get('[data-testid="save-storyteller-settings"]').trigger('click')
      await flushPromises()

      const status = wrapper.get('[data-testid="connection-status"]')
      expect(status.text()).toContain('Not checked yet')
      expect(status.text()).not.toContain('Checked')
      expect(wrapper.find('[data-testid="test-result"]').exists()).toBe(false)
    })

    it('keeps the seeded check when only an unrelated field, like the collection name, changes', async () => {
      settings.value = makeSettings({
        serverUrl: 'https://storyteller.example.com',
        passwordConfigured: true,
        lastCheck: makeCheck(),
        lastCheckedAt: '2026-09-22T10:30:00.000Z',
      })
      mocks.saveSettings.mockImplementation(async () => {
        settings.value = makeSettings({
          serverUrl: 'https://storyteller.example.com',
          passwordConfigured: true,
          collectionName: 'BookOrbit',
          lastCheck: makeCheck(),
          lastCheckedAt: '2026-09-22T10:30:00.000Z',
        })
        return true
      })
      const wrapper = mountSettings()
      await flushPromises()

      await wrapper.get('#storyteller-collection-name').setValue('BookOrbit')
      await wrapper.get('[data-testid="save-storyteller-settings"]').trigger('click')
      await flushPromises()

      expect(wrapper.get('[data-testid="connection-status"]').text()).toContain('Connected')
    })
  })
})
