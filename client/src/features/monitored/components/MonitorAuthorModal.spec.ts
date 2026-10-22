import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { createI18n } from 'vue-i18n'
import type { MonitoredAuthorItem } from '@bookorbit/types'
import en from '@/locales/en.json'
import { compileIcuCatalog } from '@/i18n/icu'
import MonitorAuthorModal from './MonitorAuthorModal.vue'

const mocks = vi.hoisted(() => ({
  monitorAuthor: vi.fn(),
  updateMonitoredAuthor: vi.fn(),
  refreshMonitoredAuthor: vi.fn(),
  loadRequestDestinations: vi.fn(),
  libraryState: {
    libraries: [] as unknown[],
    loaded: true,
    error: null as string | null,
  },
}))

vi.mock('../api/monitored', () => ({
  monitorAuthor: mocks.monitorAuthor,
  updateMonitoredAuthor: mocks.updateMonitoredAuthor,
  refreshMonitoredAuthor: mocks.refreshMonitoredAuthor,
}))
vi.mock('@/features/library/composables/useLibraries', () => ({
  useLibraries: () => ({
    libraries: ref(mocks.libraryState.libraries),
    loaded: ref(mocks.libraryState.loaded),
    error: ref(mocks.libraryState.error),
    fetchLibraries: vi.fn(),
    refreshLibraries: vi.fn(),
  }),
}))
vi.mock('@/features/book-requests/composables/useRequestDestinationDefault', () => ({
  useRequestDestinationDefault: () => ({ load: mocks.loadRequestDestinations, defaultFor: () => null }),
}))

const author = {
  id: 'm1',
  authorName: 'Jane Writer',
  portraitAuthorId: null,
  counts: { total: 4, ebookOwned: 0, audioOwned: 0 },
  formats: {
    ebook: { mode: 'notify', libraryId: 3, folderId: null },
    audiobook: { mode: 'off', libraryId: null, folderId: null },
  },
} as unknown as MonitoredAuthorItem

async function mountEdit(editedAuthor: MonitoredAuthorItem = author) {
  const wrapper = mount(MonitorAuthorModal, {
    props: { open: false, result: null, initialFormats: [], author: editedAuthor },
    attachTo: document.body,
    global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en: compileIcuCatalog(en, 'en') } })] },
  })
  await wrapper.setProps({ open: true })
  await flushPromises()
  return wrapper
}

function modeSelects(): HTMLSelectElement[] {
  return [...document.body.querySelectorAll<HTMLSelectElement>('select')].filter((select) => select.querySelector('option[value="auto-upcoming"]'))
}

function saveButton(): HTMLButtonElement {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Save changes'))!
}

describe('MonitorAuthorModal edit mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.libraryState.libraries = [{ id: 3, name: 'Main', folders: [{ id: 30 }] }]
    mocks.libraryState.loaded = true
    mocks.libraryState.error = null
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('starts from the author current modes and skips the add-time destination lookup', async () => {
    const wrapper = await mountEdit()
    const [ebook, audiobook] = modeSelects()
    expect(ebook!.value).toBe('notify')
    expect(audiobook!.value).toBe('off')
    expect(mocks.loadRequestDestinations).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('shows the new author modes when reopened for a different author', async () => {
    const wrapper = await mountEdit()
    await wrapper.setProps({ open: false })
    const other = {
      ...author,
      id: 'm2',
      formats: { ebook: { mode: 'auto-all', libraryId: 3, folderId: null }, audiobook: { mode: 'auto-upcoming', libraryId: 3, folderId: null } },
    } as unknown as MonitoredAuthorItem
    await wrapper.setProps({ author: other, open: true })
    await flushPromises()
    const [ebook, audiobook] = modeSelects()
    expect(ebook!.value).toBe('auto-all')
    expect(audiobook!.value).toBe('auto-upcoming')
    wrapper.unmount()
  })

  it('flags a deleted library, clears it, and blocks Save in an auto mode until another is chosen', async () => {
    const orphaned = {
      ...author,
      formats: { ...author.formats, ebook: { mode: 'auto-upcoming', libraryId: 99, folderId: null } },
    } as unknown as MonitoredAuthorItem
    const wrapper = await mountEdit(orphaned)

    expect(document.body.textContent).toContain('no longer available')
    expect(saveButton().disabled).toBe(true)

    const librarySelect = document.body.querySelectorAll<HTMLSelectElement>('select')[0]!
    librarySelect.value = '3'
    librarySelect.dispatchEvent(new Event('change'))
    await flushPromises()

    expect(document.body.textContent).not.toContain('no longer available')
    expect(saveButton().disabled).toBe(false)
    wrapper.unmount()
  })

  it('clears a deleted library on a notify format and still saves it', async () => {
    const orphaned = {
      ...author,
      formats: { ...author.formats, ebook: { mode: 'notify', libraryId: 99, folderId: null } },
    } as unknown as MonitoredAuthorItem
    mocks.updateMonitoredAuthor.mockResolvedValue(orphaned)
    mocks.refreshMonitoredAuthor.mockResolvedValue(orphaned)
    const wrapper = await mountEdit(orphaned)

    expect(document.body.textContent).toContain('no longer available')
    expect(saveButton().disabled).toBe(false)
    saveButton().click()
    await flushPromises()

    expect(mocks.updateMonitoredAuthor).toHaveBeenCalledWith('m1', {
      formats: expect.objectContaining({ ebook: { mode: 'notify', libraryId: null, folderId: null } }),
    })
    wrapper.unmount()
  })

  it('clears a deleted folder but keeps its library', async () => {
    const orphaned = {
      ...author,
      formats: { ...author.formats, ebook: { mode: 'notify', libraryId: 3, folderId: 99 } },
    } as unknown as MonitoredAuthorItem
    const wrapper = await mountEdit(orphaned)

    expect(document.body.textContent).toContain('no longer available')
    expect(modeSelects()[0]!.value).toBe('notify')
    expect(document.body.querySelectorAll<HTMLSelectElement>('select')[0]!.value).toBe('3')
    wrapper.unmount()
  })

  it('leaves saved destinations alone and blocks Save when the libraries failed to load', async () => {
    mocks.libraryState.libraries = []
    mocks.libraryState.loaded = false
    mocks.libraryState.error = 'HTTP 500'
    const wrapper = await mountEdit()

    expect(document.body.textContent).toContain('could not be loaded')
    expect(document.body.textContent).not.toContain('no longer available')
    expect(saveButton().disabled).toBe(true)
    saveButton().click()
    await flushPromises()
    expect(mocks.updateMonitoredAuthor).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('saves the changed mode, refreshes, and emits the refreshed author', async () => {
    const refreshed = { ...author, fetch: { state: 'queued' } }
    mocks.updateMonitoredAuthor.mockResolvedValue(author)
    mocks.refreshMonitoredAuthor.mockResolvedValue(refreshed)
    const wrapper = await mountEdit()
    const [ebook] = modeSelects()
    ebook!.value = 'auto-upcoming'
    ebook!.dispatchEvent(new Event('change'))
    await flushPromises()
    saveButton().click()
    await flushPromises()

    expect(mocks.updateMonitoredAuthor).toHaveBeenCalledWith('m1', {
      formats: {
        ebook: { mode: 'auto-upcoming', libraryId: 3, folderId: null },
        audiobook: { mode: 'off', libraryId: null, folderId: null },
      },
    })
    expect(mocks.refreshMonitoredAuthor).toHaveBeenCalledWith('m1')
    expect(wrapper.emitted('updated')?.[0]).toEqual([refreshed])
    expect(mocks.monitorAuthor).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('still reports the save when the refresh is refused', async () => {
    mocks.updateMonitoredAuthor.mockResolvedValue(author)
    mocks.refreshMonitoredAuthor.mockRejectedValue(new Error('cooldown'))
    const wrapper = await mountEdit()
    saveButton().click()
    await flushPromises()

    expect(wrapper.emitted('updated')?.[0]).toEqual([author])
    wrapper.unmount()
  })

  it('shows an error and emits nothing when the save fails', async () => {
    mocks.updateMonitoredAuthor.mockRejectedValue(new Error('boom'))
    const wrapper = await mountEdit()
    saveButton().click()
    await flushPromises()

    expect(wrapper.emitted('updated')).toBeUndefined()
    expect(mocks.refreshMonitoredAuthor).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Failed to update watch settings.')
    wrapper.unmount()
  })
})
