import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import type { WebSerialMangaExtension } from '@bookorbit/types'
import { i18n } from '@/i18n'

const api = vi.hoisted(() => ({
  fetchMangaExtensions: vi.fn<(query: Record<string, unknown>) => Promise<unknown>>(),
  refreshMangaExtensions: vi.fn<() => Promise<unknown>>(),
  runMangaExtensionAction: vi.fn<(pkg: string, action: string) => Promise<unknown>>(),
  fetchMangaRepos: vi.fn<() => Promise<unknown>>(),
  addMangaRepo: vi.fn<(input: unknown) => Promise<unknown>>(),
  removeMangaRepo: vi.fn<(url: string) => Promise<unknown>>(),
}))

vi.mock('../api/webSerials', () => api)

import WebSerialExtensionsSheet from '../components/settings/WebSerialExtensionsSheet.vue'

const passthrough = defineComponent({ template: '<div><slot /></div>' })
const stubs = { Sheet: passthrough, SheetContent: passthrough, SheetTitle: passthrough, SheetDescription: passthrough, ConfirmDialog: true }

function ext(pkgName: string, overrides: Partial<WebSerialMangaExtension> = {}): WebSerialMangaExtension {
  return {
    pkgName,
    name: `Name ${pkgName}`,
    lang: 'en',
    versionName: '1.2',
    installed: false,
    hasUpdate: false,
    adult: false,
    iconUrl: null,
    repo: null,
    ...overrides,
  }
}

function mountSheet() {
  return mount(WebSerialExtensionsSheet, { props: { open: true }, global: { plugins: [i18n], stubs } })
}

async function openTab(wrapper: ReturnType<typeof mountSheet>, id: string) {
  await wrapper.get(`#web-serials-ext-tab-${id}`).trigger('click')
  await flushPromises()
}

describe('WebSerialExtensionsSheet', () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset())
    api.fetchMangaRepos.mockResolvedValue(['https://r.example/index.pb'])
    api.fetchMangaExtensions.mockImplementation(async (query) => ({
      items: query.installed ? [ext('a.inst', { installed: true, hasUpdate: true })] : [ext('a.one'), ext('a.two', { installed: true })],
      total: query.installed ? 1 : 2,
      languages: ['en'],
    }))
  })

  it('lists installed extensions with an update pill and offers uninstall', async () => {
    const wrapper = mountSheet()
    await flushPromises()
    expect(wrapper.text()).toContain('Name a.inst')
    expect(wrapper.text()).toContain('Update available')
    expect(wrapper.text()).toContain('Uninstall')
  })

  it('shows the empty state when nothing is installed', async () => {
    api.fetchMangaExtensions.mockResolvedValue({ items: [], total: 0, languages: [] })
    const wrapper = mountSheet()
    await flushPromises()
    expect(wrapper.text()).toContain('No extensions are installed yet')
  })

  it('asks for confirmation before uninstalling', async () => {
    const wrapper = mountSheet()
    await flushPromises()
    const uninstall = wrapper.findAll('button').find((b) => b.text() === 'Uninstall')!
    await uninstall.trigger('click')
    expect(api.runMangaExtensionAction).not.toHaveBeenCalled()
    const dialog = wrapper.findComponent({ name: 'ConfirmDialog' })
    expect(dialog.props('open')).toBe(true)
    expect(dialog.props('title')).toBe('Uninstall Name a.inst?')
  })

  it('installs from the Available tab and shows Installed afterwards', async () => {
    api.runMangaExtensionAction.mockResolvedValue(ext('a.one', { installed: true }))
    const wrapper = mountSheet()
    await flushPromises()
    await openTab(wrapper, 'available')
    expect(wrapper.text()).toContain('2 extensions')
    const install = wrapper.findAll('button').find((b) => b.text() === 'Install')!
    await install.trigger('click')
    await flushPromises()
    expect(api.runMangaExtensionAction).toHaveBeenCalledWith('a.one', 'install')
    expect(wrapper.emitted('changed')).toHaveLength(1)
    expect(wrapper.findAll('button').find((b) => b.text() === 'Install')).toBeUndefined()
  })

  it('points to Repositories when none are configured', async () => {
    api.fetchMangaRepos.mockResolvedValue([])
    const wrapper = mountSheet()
    await flushPromises()
    await openTab(wrapper, 'available')
    expect(wrapper.text()).toContain('Add a repository first')
    const go = wrapper.findAll('button').find((b) => b.text() === 'Open Repositories')!
    await go.trigger('click')
    expect(wrapper.text()).toContain('No repositories are set up.')
  })

  it('shows an error on the Available tab', async () => {
    api.fetchMangaExtensions.mockImplementation(async (query) => {
      if (query.installed) return { items: [], total: 0, languages: [] }
      throw new Error('The manga engine did not answer.')
    })
    const wrapper = mountSheet()
    await flushPromises()
    await openTab(wrapper, 'available')
    expect(wrapper.get('[role="alert"]').text()).toBe('The manga engine did not answer.')
  })

  it('lists repositories, validates the add input and shows the trust note', async () => {
    const wrapper = mountSheet()
    await flushPromises()
    await openTab(wrapper, 'repositories')
    expect(wrapper.text()).toContain('https://r.example/index.pb')
    expect(wrapper.text()).toContain('only add repositories you trust')
    const input = wrapper.get('#web-serials-repo-url')
    await input.setValue('nope')
    expect(wrapper.text()).toContain('Enter a web address')
    expect(
      wrapper
        .findAll('button')
        .find((b) => b.text() === 'Add')!
        .attributes('disabled'),
    ).toBeDefined()
    api.addMangaRepo.mockResolvedValue(undefined)
    await input.setValue('https://x.example/index.pb')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(api.addMangaRepo).toHaveBeenCalledWith({ url: 'https://x.example/index.pb' })
  })

  it('keeps the loaded installed list when Load more fails', async () => {
    api.fetchMangaExtensions.mockImplementation(async (query) => {
      if (query.installed && query.offset) throw new Error('Server down')
      return { items: [ext('a.inst', { installed: true })], total: 5, languages: ['en'] }
    })
    const wrapper = mountSheet()
    await flushPromises()
    const more = wrapper.findAll('button').find((button) => button.text() === 'Load more')
    await more?.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Name a.inst')
    expect(wrapper.text()).toContain('Server down')
  })
})
