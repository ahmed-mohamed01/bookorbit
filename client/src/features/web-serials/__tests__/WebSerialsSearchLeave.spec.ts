import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import type { WebSerialCapabilities } from '@bookorbit/types'
import { i18n } from '@/i18n'
import { catalogEntry } from './fixtures'

const api = vi.hoisted(() => ({
  fetchCapabilities: vi.fn<() => Promise<WebSerialCapabilities>>(),
  discoverSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  searchSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  suggestSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  resolveSerialUrl: vi.fn<(input: unknown) => Promise<unknown>>(),
  fetchSeries: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}))
vi.mock('../api/webSerials', () => api)

import WebSerialsSearchPanel from '../components/WebSerialsSearchPanel.vue'
import { clearStoredSearch } from '../composables/webSerialSearchStore'

const BOTH: WebSerialCapabilities = {
  manga: { available: true, searchable: true, defaultLibraryId: null, targetFolderId: null },
  novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: null, targetFolderId: null },
}

const Page = defineComponent({ setup: () => () => h(WebSerialsSearchPanel, { userId: 1 }) })
const Library = defineComponent({ setup: () => () => h('div', 'library') })

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/web-serials', name: 'web-serials', component: Page },
      { path: '/library', name: 'library', component: Library },
    ],
  })
}

function hangUntilAborted(...args: unknown[]): Promise<unknown> {
  const signal = args[2] as AbortSignal
  return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
}

async function mountAt(router: ReturnType<typeof makeRouter>) {
  await router.push('/web-serials')
  const wrapper = mount({ render: () => h(RouterView) }, { global: { plugins: [router, i18n] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  clearStoredSearch()
  api.fetchCapabilities.mockResolvedValue(BOTH)
  api.suggestSerials.mockResolvedValue({ suggestions: [] })
})

describe('leaving the page during a search', () => {
  it('stays on the page the user went to and does not search again', async () => {
    api.discoverSerials.mockImplementation(hangUntilAborted)
    const router = makeRouter()
    const wrapper = await mountAt(router)
    await wrapper.get('#web-serials-query').setValue('omniscient')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    await router.push('/library')
    await flushPromises()
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe('/library')
    expect(api.discoverSerials).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('still records a search that finished before leaving', async () => {
    api.discoverSerials.mockResolvedValue({ results: [catalogEntry()], fallback: null })
    const router = makeRouter()
    const wrapper = await mountAt(router)
    await wrapper.get('#web-serials-query').setValue('omniscient')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(router.currentRoute.value.query).toMatchObject({ q: 'omniscient', kind: 'all' })

    await router.push('/library')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/library')
    wrapper.unmount()
  })
})
