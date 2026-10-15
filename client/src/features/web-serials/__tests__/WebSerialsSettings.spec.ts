import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import type { WebSerialSettings } from '@bookorbit/types'
import { i18n } from '@/i18n'

const api = vi.hoisted(() => ({
  fetchWebSerialSettings: vi.fn<() => Promise<unknown>>(),
  saveWebSerialSettings: vi.fn<(payload: unknown) => Promise<unknown>>(),
  testWebSerialEngine: vi.fn<(input: unknown) => Promise<unknown>>(),
  fetchNovelSources: vi.fn<() => Promise<unknown>>(),
  fetchMangaSources: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('../api/webSerials', () => api)
vi.mock('vue-sonner', () => ({ toast: { success: vi.fn<() => void>(), error: vi.fn<() => void>() } }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => true }) }))
vi.mock('@/features/library/composables/useLibraries', () => {
  const libraries = ref([
    { id: 1, type: 'books', name: 'Comics', allowedFormats: ['cbz'], folders: [{ id: 11, path: '/comics' }] },
    {
      id: 2,
      type: 'books',
      name: 'Novels',
      allowedFormats: ['epub'],
      folders: [
        { id: 21, path: '/n1' },
        { id: 22, path: '/n2' },
      ],
    },
    { id: 3, type: 'books', name: 'Everything', allowedFormats: [], folders: [{ id: 31, path: '/all' }] },
  ])
  return { useLibraries: () => ({ libraries, fetchLibraries: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) }) }
})

import WebSerialsSettings from '../components/WebSerialsSettings.vue'

const passthrough = defineComponent({ template: '<div><slot /></div>' })
const sheetStubs = { Sheet: passthrough, SheetContent: passthrough, SheetTitle: passthrough, SheetDescription: passthrough }

function settings(overrides: Partial<WebSerialSettings> = {}): WebSerialSettings {
  return {
    manga: {
      url: 'http://localhost:4567',
      username: null,
      passwordConfigured: false,
      lastCheck: { ok: true, checkedAt: new Date().toISOString(), version: 'v2.4.2366', searchableSources: 3, error: null },
      sourceIds: null,
      languages: ['en'],
      targetLibraryId: 1,
      targetFolderId: 11,
    },
    novel: {
      engine: 'lnreader',
      url: null,
      username: null,
      passwordConfigured: false,
      lastCheck: null,
      searchDomains: [],
      sourceIds: [],
      targetLibraryId: null,
      targetFolderId: null,
      defaultPackaging: 'volume',
      indexDailyBudget: 1500,
    },
    maxConcurrentJobs: 2,
    lookup: { enabled: true, lastCheck: null },
    ...overrides,
  }
}

function sourceChip(wrapper: Awaited<ReturnType<typeof mountPage>>, name: string) {
  return wrapper.findAll('button[aria-pressed]').find((button) => button.text() === name)!
}

function groupButton(wrapper: Awaited<ReturnType<typeof mountPage>>, language: string, label: string) {
  const group = wrapper.findAll('div.rounded-lg').find((div) => div.text().startsWith(language))!
  return group.findAll('button').find((button) => button.text() === label)!
}

async function mountPage() {
  const wrapper = mount(WebSerialsSettings, { global: { plugins: [i18n], stubs: sheetStubs } })
  await flushPromises()
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchWebSerialSettings.mockResolvedValue(settings())
  api.fetchMangaSources.mockResolvedValue([
    { id: '1', name: 'Mangabat (EN)', lang: 'en', nsfw: false },
    { id: '2', name: 'AllManga (EN)', lang: 'en', nsfw: false },
    { id: '3', name: 'NovelCool (ES)', lang: 'es', nsfw: false },
  ])
  api.fetchNovelSources.mockResolvedValue([])
})

describe('WebSerialsSettings', () => {
  it('shows the legacy language selection as selected sources without marking anything dirty', async () => {
    const wrapper = await mountPage()

    expect(sourceChip(wrapper, 'Mangabat').attributes('aria-pressed')).toBe('true')
    expect(sourceChip(wrapper, 'AllManga').attributes('aria-pressed')).toBe('true')
    expect(sourceChip(wrapper, 'NovelCool').attributes('aria-pressed')).toBe('false')
    expect(wrapper.text()).toContain('2 of 3 sources searched')
    expect(wrapper.text()).toContain('Only selected sources are searched. Sources you install later start off.')
    expect(wrapper.text()).not.toContain('Unsaved changes')
  })

  it('toggles a single source and saves explicit source ids', async () => {
    const wrapper = await mountPage()

    await sourceChip(wrapper, 'Mangabat').trigger('click')
    expect(sourceChip(wrapper, 'Mangabat').attributes('aria-pressed')).toBe('false')
    expect(wrapper.text()).toContain('1 of 3 sources searched')

    api.saveWebSerialSettings.mockResolvedValue(settings())
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Save changes'))!
      .trigger('click')
    await flushPromises()

    expect(api.saveWebSerialSettings).toHaveBeenCalledWith({ manga: { sourceIds: ['2'] } })
  })

  it('selects and clears a whole language group with All and None', async () => {
    const wrapper = await mountPage()

    await groupButton(wrapper, 'Spanish', 'All').trigger('click')
    expect(sourceChip(wrapper, 'NovelCool').attributes('aria-pressed')).toBe('true')
    expect(wrapper.text()).toContain('3 of 3 sources searched')

    await groupButton(wrapper, 'English', 'None').trigger('click')
    expect(sourceChip(wrapper, 'Mangabat').attributes('aria-pressed')).toBe('false')
    expect(sourceChip(wrapper, 'AllManga').attributes('aria-pressed')).toBe('false')
    expect(wrapper.text()).toContain('1 of 3 sources searched')

    api.saveWebSerialSettings.mockResolvedValue(settings())
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Save changes'))!
      .trigger('click')
    await flushPromises()
    expect(api.saveWebSerialSettings).toHaveBeenCalledWith({ manga: { sourceIds: ['3'] } })
  })

  it('shows the stored explicit selection instead of the languages', async () => {
    api.fetchWebSerialSettings.mockResolvedValue(settings({ manga: { ...settings().manga, sourceIds: ['3'] } }))
    const wrapper = await mountPage()

    expect(sourceChip(wrapper, 'NovelCool').attributes('aria-pressed')).toBe('true')
    expect(sourceChip(wrapper, 'Mangabat').attributes('aria-pressed')).toBe('false')
    expect(wrapper.text()).toContain('1 of 3 sources searched')
  })

  it('shows the connection meta line and language groups with per-source chips', async () => {
    const wrapper = await mountPage()

    expect(wrapper.text()).toContain('http://localhost:4567')
    expect(wrapper.text()).toContain('v2.4.2366')
    expect(wrapper.text()).toContain('Mangabat')
    expect(wrapper.text()).not.toContain('Mangabat (EN)')
    expect(wrapper.findAll('[role="switch"]')).toHaveLength(1)
  })

  it('shows a connect state for an unconfigured engine', async () => {
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('Connect')
    expect(api.fetchNovelSources).not.toHaveBeenCalled()
  })

  it('offers only libraries that accept the kind and hides the folder select for a single folder', async () => {
    const wrapper = await mountPage()

    const manga = wrapper
      .find('#web-serials-manga-library')
      .findAll('option')
      .map((option) => option.text())
    const novel = wrapper
      .find('#web-serials-novel-library')
      .findAll('option')
      .map((option) => option.text())

    expect(manga).toEqual(['No default', 'Comics', 'Everything'])
    expect(novel).toEqual(['No default', 'Novels', 'Everything'])
    expect(wrapper.findAll('select[aria-label="Folder"]')).toHaveLength(0)
  })

  it('appears with the save bar only after a change and saves only the page fields', async () => {
    const wrapper = await mountPage()
    expect(wrapper.text()).not.toContain('Unsaved changes')

    await sourceChip(wrapper, 'NovelCool').trigger('click')
    expect(wrapper.text()).toContain('Unsaved changes')

    api.saveWebSerialSettings.mockResolvedValue(settings())
    const save = wrapper.findAll('button').find((button) => button.text().includes('Save changes'))!
    await save.trigger('click')
    await flushPromises()

    expect(api.saveWebSerialSettings).toHaveBeenCalledWith({ manga: { sourceIds: ['1', '2', '3'] } })
  })

  it('shows the series details card and saves its toggle through the page save bar', async () => {
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('Series details')
    expect(wrapper.text()).toContain('Looks up each manga and light novel in MangaBaka')

    await wrapper.find('[role="switch"]').trigger('click')
    expect(wrapper.text()).toContain('Unsaved changes')

    api.saveWebSerialSettings.mockResolvedValue(settings({ lookup: { enabled: false, lastCheck: null } }))
    await wrapper
      .findAll('button')
      .find((button) => button.text().includes('Save changes'))!
      .trigger('click')
    await flushPromises()
    expect(api.saveWebSerialSettings).toHaveBeenCalledWith({ lookup: { enabled: false } })
  })

  it('discards page changes', async () => {
    const wrapper = await mountPage()
    await sourceChip(wrapper, 'NovelCool').trigger('click')
    const discard = wrapper.findAll('button').find((button) => button.text() === 'Discard')!
    await discard.trigger('click')

    expect(wrapper.text()).not.toContain('Unsaved changes')
  })

  it('renders a failed check with the plain-language hint', async () => {
    api.fetchWebSerialSettings.mockResolvedValue(
      settings({
        manga: {
          ...settings().manga,
          lastCheck: { ok: false, checkedAt: new Date().toISOString(), version: null, searchableSources: 0, error: 'ECONNREFUSED' },
        },
      }),
    )
    const wrapper = await mountPage()

    expect(wrapper.find('[role="alert"]').text()).toContain('ECONNREFUSED')
    expect(wrapper.text()).toContain('Check the container is running')
  })
  it('points an empty source list at the in-app extension manager, not Suwayomi', async () => {
    api.fetchMangaSources.mockResolvedValue([])
    const wrapper = await mountPage()
    expect(wrapper.text()).toContain('Manage sources')
    expect(wrapper.text()).toContain('Use Manage sources to install extensions.')
    expect(wrapper.text()).not.toContain('in Suwayomi')
  })
})
