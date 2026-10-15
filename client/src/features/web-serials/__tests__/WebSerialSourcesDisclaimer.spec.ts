import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, reactive, ref } from 'vue'
import { i18n } from '@/i18n'

const api = vi.hoisted(() => ({
  fetchMangaExtensions: vi.fn<() => Promise<unknown>>(),
  fetchMangaRepos: vi.fn<() => Promise<unknown>>(),
  fetchAvailableNovelSources: vi.fn<() => Promise<unknown[]>>(),
  fetchInstalledNovelSources: vi.fn<() => Promise<unknown[]>>(),
}))

const context = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../api/webSerials', () => api)
vi.mock('../components/settings/settingsContext', () => ({
  useWebSerialSettingsContext: () => context.current,
}))

import WebSerialSourcesDisclaimer from '../components/WebSerialSourcesDisclaimer.vue'
import WebSerialMangaSources from '../components/settings/WebSerialMangaSources.vue'
import WebSerialNovelSources from '../components/settings/WebSerialNovelSources.vue'
import WebSerialExtensionsSheet from '../components/settings/WebSerialExtensionsSheet.vue'
import WebSerialNovelSourcesSheet from '../components/settings/WebSerialNovelSourcesSheet.vue'

const TEXT = i18n.global.t('webSerials.sources.disclaimer')
const passthrough = defineComponent({ template: '<div><slot /></div>' })
const stubs = { Sheet: passthrough, SheetContent: passthrough, SheetTitle: passthrough, SheetDescription: passthrough, ConfirmDialog: true }
const options = () => ({ attachTo: document.body, global: { plugins: [i18n], stubs } })

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  document.body.innerHTML = ''
  context.current = {
    draft: reactive({ manga: { sourceIds: [], languages: [] }, novel: { sourceIds: [], searchDomains: [] } }),
    settings: ref(null),
    mangaSources: ref([]),
    mangaSourcesLoading: ref(false),
    mangaSourcesError: ref(null),
    novelSources: ref([]),
    novelSourcesLoading: ref(false),
    novelSourcesError: ref(null),
  }
  api.fetchMangaExtensions.mockReset().mockResolvedValue({ items: [], total: 0 })
  api.fetchMangaRepos.mockReset().mockResolvedValue([])
  api.fetchAvailableNovelSources.mockReset().mockResolvedValue([])
  api.fetchInstalledNovelSources.mockReset().mockResolvedValue([])
})

describe('WebSerialSourcesDisclaimer', () => {
  it('is a labelled, focusable button that shows the disclaimer on focus', async () => {
    const wrapper = mount(WebSerialSourcesDisclaimer, options())
    const button = wrapper.get('button')
    expect(button.attributes('aria-label')).toBe('About these sources')
    expect(button.attributes('type')).toBe('button')

    await button.trigger('focus')
    await flushPromises()
    expect(document.body.textContent).toContain(TEXT)
    wrapper.unmount()
  })

  it('opens on tap for touch pointers', async () => {
    const wrapper = mount(WebSerialSourcesDisclaimer, options())
    const button = wrapper.get('button')

    await button.trigger('pointerdown', { pointerType: 'touch' })
    await button.trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain(TEXT)
    wrapper.unmount()
  })

  it.each([
    ['manga source selection', () => mount(WebSerialMangaSources, options())],
    ['light novel source selection', () => mount(WebSerialNovelSources, options())],
    ['manga extensions sheet', () => mount(WebSerialExtensionsSheet, { ...options(), props: { open: true } })],
    ['light novel sources sheet', () => mount(WebSerialNovelSourcesSheet, { ...options(), props: { open: true } })],
  ])('renders beside the heading in the %s', async (_name, build) => {
    const wrapper = build()
    await flushPromises()
    expect(wrapper.findComponent(WebSerialSourcesDisclaimer).exists()).toBe(true)
    expect(wrapper.find('button[aria-label="About these sources"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
