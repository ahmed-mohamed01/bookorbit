import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import type { WebSerialCapabilities } from '@bookorbit/types'
import { i18n } from '@/i18n'
import { hit, mangaDetail, novelDetail, suggestion } from './fixtures'

const api = vi.hoisted(() => ({
  fetchCapabilities: vi.fn<() => Promise<WebSerialCapabilities>>(),
  discoverSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  searchSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  suggestSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  resolveSerialUrl: vi.fn<(input: unknown) => Promise<unknown>>(),
  fetchSeries: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}))
const route = reactive<{ name: string; query: Record<string, string> }>({ name: 'web-serials', query: {} })
vi.mock('../api/webSerials', () => api)
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ replace: vi.fn<() => Promise<void>>(async () => {}), push: vi.fn<() => Promise<void>>(async () => {}) }),
}))

import WebSerialsSearchPanel from '../components/WebSerialsSearchPanel.vue'
import { clearStoredSearch } from '../composables/webSerialSearchStore'

const BOTH: WebSerialCapabilities = {
  manga: { available: true, searchable: true, defaultLibraryId: null, targetFolderId: null },
  novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: null, targetFolderId: null },
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  window.sessionStorage.clear()
  clearStoredSearch()
  route.query = {}
  api.fetchCapabilities.mockResolvedValue(BOTH)
  api.discoverSerials.mockResolvedValue({ results: [], fallback: 'disabled' })
  api.searchSerials.mockResolvedValue({ query: 'omniscient', hits: [hit()], failedSources: [] })
  api.suggestSerials.mockResolvedValue({ query: 'om', suggestions: [suggestion({ title: 'Omniscient Reader' })] })
})

afterEach(() => {
  vi.useRealTimers()
})

async function settle() {
  await flushPromises()
  await vi.advanceTimersByTimeAsync(200)
  await flushPromises()
}

function listShown(wrapper: ReturnType<typeof mount>): boolean {
  return (wrapper.get('[data-testid="suggestions"]').element as HTMLElement).style.display !== 'none'
}

describe('WebSerialsSearchPanel suggestions', () => {
  it('stays closed when a search is restored from the URL', async () => {
    route.query = { q: 'omniscient', kind: 'all' }
    const wrapper = mount(WebSerialsSearchPanel, { attachTo: document.body, global: { plugins: [i18n] } })
    await settle()

    expect(api.suggestSerials).not.toHaveBeenCalled()
    expect(listShown(wrapper)).toBe(false)
    wrapper.unmount()
  })

  it('opens while the user types in the focused box', async () => {
    const wrapper = mount(WebSerialsSearchPanel, { attachTo: document.body, global: { plugins: [i18n] } })
    await settle()
    const input = wrapper.get('#web-serials-query')
    await input.trigger('focus')
    await input.setValue('omni')
    await settle()

    expect(api.suggestSerials).toHaveBeenCalledTimes(1)
    expect(listShown(wrapper)).toBe(true)
    wrapper.unmount()
  })
})

describe('WebSerialsSearchPanel previews', () => {
  it('drops a hit that finishes opening after a link was opened instead', async () => {
    vi.useRealTimers()
    let finishHit: (value: unknown) => void = () => undefined
    api.fetchSeries.mockReturnValue(new Promise((resolve) => (finishHit = resolve)))
    api.resolveSerialUrl.mockResolvedValue(novelDetail({ seriesKey: 'nl:link' }))
    const wrapper = mount(WebSerialsSearchPanel, { global: { plugins: [i18n] } })
    await flushPromises()
    await wrapper.get('#web-serials-query').setValue('tower')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    await wrapper.get('li button').trigger('click')
    await wrapper.get('#web-serials-query').setValue('https://www.royalroad.com/fiction/1/x')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    finishHit(mangaDetail({ seriesKey: 'm:old' }))
    await flushPromises()

    expect(wrapper.emitted('open')).toEqual([[expect.objectContaining({ seriesKey: 'nl:link' })]])
    wrapper.unmount()
  })
})
