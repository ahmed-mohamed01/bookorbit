import { reactive } from 'vue'
import type { WebSerialNovelSourceEntry } from '@bookorbit/types'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'
import WebSerialNovelSourcesSheet from '../components/settings/WebSerialNovelSourcesSheet.vue'

const api = vi.hoisted(() => ({
  fetchAvailableNovelSources: vi.fn<(lang?: string) => Promise<WebSerialNovelSourceEntry[]>>(),
  fetchInstalledNovelSources: vi.fn<() => Promise<WebSerialNovelSourceEntry[]>>(),
  runNovelSourceAction: vi.fn<(id: string, action: 'install' | 'update' | 'remove') => Promise<void>>(),
}))

const draft = reactive({ novel: { sourceIds: ['installed'] } })

vi.mock('../api/webSerials', () => api)
vi.mock('../components/settings/settingsContext', () => ({
  useWebSerialSettingsContext: () => ({ draft }),
}))

const source = (id: string, installed: boolean) => ({
  id,
  name: id === 'installed' ? 'Installed Source' : 'Available Source',
  site: `https://${id}.test`,
  lang: 'English',
  version: '1.0.0',
  iconUrl: null,
  installed,
  installedVersion: installed ? '1.0.0' : null,
  updateAvailable: installed,
  broken: false,
})

beforeEach(() => {
  draft.novel.sourceIds = ['installed']
  api.fetchAvailableNovelSources.mockReset().mockResolvedValue([source('installed', true), source('available', false)])
  api.fetchInstalledNovelSources.mockReset().mockResolvedValue([source('installed', true)])
  api.runNovelSourceAction.mockReset().mockResolvedValue(undefined)
})

const ConfirmStub = {
  name: 'ConfirmDialog',
  props: ['open', 'title', 'description', 'confirmLabel', 'busy'],
  emits: ['confirm', 'cancel'],
  template:
    '<div v-if="open" data-testid="confirm"><p>{{ title }}</p><button data-testid="confirm-yes" @click="$emit(\'confirm\')">yes</button></div>',
}

async function mountSheet() {
  const wrapper = mount(WebSerialNovelSourcesSheet, {
    props: { open: true },
    global: {
      plugins: [i18n],
      stubs: {
        Sheet: { template: '<div><slot /></div>' },
        SheetContent: { template: '<div><slot /></div>' },
        SheetTitle: { template: '<h2><slot /></h2>' },
        SheetDescription: { template: '<p><slot /></p>' },
        ConfirmDialog: ConfirmStub,
      },
    },
  })
  await flushPromises()
  return wrapper
}

describe('WebSerialNovelSourcesSheet', () => {
  it('loads, filters, toggles and runs install, update and remove actions', async () => {
    const wrapper = await mountSheet()

    expect(api.fetchAvailableNovelSources).toHaveBeenCalledWith('English')
    expect(wrapper.text()).toContain('Installed Source')
    expect(wrapper.text()).toContain('Available Source')

    await wrapper.find('input[type="search"]').setValue('Available')
    expect(wrapper.findAll('li')).toHaveLength(1)
    expect(wrapper.find('li').text()).toContain('Available Source')
    await wrapper.find('input[type="search"]').setValue('')

    await wrapper.find('select').setValue('Chinese')
    await flushPromises()
    expect(api.fetchAvailableNovelSources).toHaveBeenLastCalledWith('Chinese')

    const toggle = wrapper.find('[role="switch"]')
    expect(toggle.attributes('aria-checked')).toBe('true')
    await toggle.trigger('click')
    expect(draft.novel.sourceIds).toEqual([])

    const button = (label: string) => wrapper.findAll('button').find((entry) => entry.text().trim() === label)!
    await button('Install').trigger('click')
    await flushPromises()
    expect(api.runNovelSourceAction).toHaveBeenCalledWith('available', 'install')
    expect(draft.novel.sourceIds).toContain('available')

    await button('Update').trigger('click')
    await flushPromises()
    expect(api.runNovelSourceAction).toHaveBeenCalledWith('installed', 'update')

    draft.novel.sourceIds = ['available', 'installed']
    await button('Remove').trigger('click')
    expect(api.runNovelSourceAction).not.toHaveBeenCalledWith('installed', 'remove')
    expect(wrapper.get('[data-testid="confirm"]').text()).toContain('Remove Installed Source?')
    await wrapper.get('[data-testid="confirm-yes"]').trigger('click')
    await flushPromises()
    expect(api.runNovelSourceAction).toHaveBeenCalledWith('installed', 'remove')
    expect(draft.novel.sourceIds).not.toContain('installed')
  })

  it('keeps the source selected in the draft when the server refuses the removal', async () => {
    api.runNovelSourceAction.mockRejectedValue(new Error('service down'))
    const wrapper = await mountSheet()

    await wrapper.get('[aria-label="Remove Installed Source"]').trigger('click')
    await wrapper.get('[data-testid="confirm-yes"]').trigger('click')
    await flushPromises()

    expect(draft.novel.sourceIds).toEqual(['installed'])
    expect(wrapper.get('[role="alert"]').text()).toContain('service down')
  })

  it('labels the search, language and per-source controls, and names languages for the reader', async () => {
    const wrapper = await mountSheet()

    expect(wrapper.get('label[for="web-serial-novel-sources-search"]').text()).toBe('Search sources')
    expect(wrapper.get('label[for="web-serial-novel-sources-language"]').text()).toBe('Source language')
    expect(
      wrapper
        .get('select')
        .findAll('option')
        .map((option) => option.text()),
    ).toContain('Japanese')
    expect(wrapper.get('[role="switch"]').attributes('aria-label')).toBe('Search Installed Source')
    expect(wrapper.find('[aria-label="Update Installed Source"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="Install Available Source"]').exists()).toBe(true)
  })

  it('marks an installed source that failed to load as broken, with Reinstall and Remove', async () => {
    api.fetchInstalledNovelSources.mockResolvedValue([{ ...source('installed', true), broken: true }])
    const wrapper = await mountSheet()

    const row = wrapper.findAll('li').find((entry) => entry.text().includes('Installed Source'))!
    expect(row.text()).toContain('Broken')
    expect(row.text()).toContain('This source failed to load')
    expect(row.find('[aria-label="Update Installed Source"]').exists()).toBe(false)
    expect(row.find('[aria-label="Remove Installed Source"]').exists()).toBe(true)
    const healthy = wrapper.findAll('li').find((entry) => entry.text().includes('Available Source'))!
    expect(healthy.text()).not.toContain('Broken')

    await row.get('[aria-label="Reinstall Installed Source"]').trigger('click')
    await flushPromises()
    expect(api.runNovelSourceAction).toHaveBeenCalledWith('installed', 'install')
    expect(draft.novel.sourceIds).toEqual(['installed'])
  })

  it('shows the list of the language picked last when an older load answers late', async () => {
    let finishChinese: (value: WebSerialNovelSourceEntry[]) => void = () => undefined
    const wrapper = await mountSheet()
    api.fetchAvailableNovelSources.mockImplementation((lang) =>
      lang === 'Chinese'
        ? new Promise((resolve) => (finishChinese = resolve))
        : Promise.resolve([{ ...source('available', false), name: 'Korean Source', lang: 'Korean' }]),
    )

    await wrapper.find('select').setValue('Chinese')
    await wrapper.find('select').setValue('Korean')
    await flushPromises()
    finishChinese([{ ...source('available', false), name: 'Chinese Source', lang: 'Chinese' }])
    await flushPromises()

    expect(wrapper.text()).toContain('Korean Source')
    expect(wrapper.text()).not.toContain('Chinese Source')
  })
})
