import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { WebSerialCapabilities } from '@bookorbit/types'
import { i18n } from '@/i18n'
import { hit, novelDetail, suggestion } from './fixtures'

const api = vi.hoisted(() => ({
  fetchCapabilities: vi.fn<() => Promise<WebSerialCapabilities>>(),
  discoverSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  searchSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  suggestSerials: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  resolveSerialUrl: vi.fn<(input: unknown) => Promise<unknown>>(),
  fetchSeries: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}))

vi.mock('../api/webSerials', () => api)
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ replace: vi.fn<() => Promise<void>>() }) }))

import WebSerialsSearchPanel from '../components/WebSerialsSearchPanel.vue'

const BOTH: WebSerialCapabilities = {
  manga: { available: true, searchable: true, defaultLibraryId: null, targetFolderId: null },
  novel: { available: true, searchable: true, acceptsLinks: true, defaultLibraryId: null, targetFolderId: null },
}

const MATCHED = suggestion({
  title: 'Omniscient Reader',
  matchId: '777',
  cover: '/api/v1/web-serials/series/nl:a:x/cover',
  entries: [
    { sourceId: 'a', sourceName: 'Novel Fire', path: 'n/orv', mtl: false, seriesKey: 'nl:a:x' },
    { sourceId: 'c', sourceName: 'NovelBuddy', path: 'n/orv', mtl: false, seriesKey: 'nl:c:x' },
  ],
})
const UNMATCHED = suggestion({
  title: 'Omega Saga',
  sourcesCount: 1,
  mtlOnly: true,
  entries: [{ sourceId: 'b', sourceName: 'MTL Site', path: 'b/o', mtl: true, seriesKey: 'nl:b:Yi9v' }],
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  window.localStorage.clear()
  api.fetchCapabilities.mockResolvedValue(BOTH)
  api.discoverSerials.mockResolvedValue({ results: [], fallback: 'disabled' })
  api.searchSerials.mockResolvedValue({ query: 'om', hits: [hit()], failedSources: [] })
  api.suggestSerials.mockResolvedValue({ query: 'om', suggestions: [MATCHED, UNMATCHED] })
  api.fetchSeries.mockResolvedValue(novelDetail())
})

afterEach(() => {
  vi.useRealTimers()
})

async function mountPanel() {
  const wrapper = mount(WebSerialsSearchPanel, { attachTo: document.body, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

async function type(wrapper: Awaited<ReturnType<typeof mountPanel>>, text: string) {
  await wrapper.get('#web-serials-query').trigger('focus')
  await wrapper.get('#web-serials-query').setValue(text)
  await vi.advanceTimersByTimeAsync(150)
  await flushPromises()
}

describe('search box suggestions', () => {
  it('lists novel suggestions under the box as an accessible combobox after the debounce', async () => {
    const wrapper = await mountPanel()
    const input = wrapper.get('#web-serials-query')
    expect(input.attributes('role')).toBe('combobox')
    expect(input.attributes('aria-expanded')).toBe('false')

    await input.trigger('focus')
    await wrapper.get('#web-serials-query').setValue('om')
    await vi.advanceTimersByTimeAsync(100)
    expect(api.suggestSerials).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50)
    await flushPromises()

    expect(api.suggestSerials).toHaveBeenCalledWith('om', expect.any(AbortSignal))
    expect(input.attributes('aria-expanded')).toBe('true')
    expect(input.attributes('aria-controls')).toBe('web-serials-suggestions')
    const options = wrapper.findAll('[role="option"]')
    expect(options).toHaveLength(2)
    expect(options[0]!.text()).toContain('Omniscient Reader')
    const pills = options[0]!.findAll('[data-testid="source-pill"]').map((pill) => pill.text())
    expect(pills).toEqual(['Novel Fire', 'NovelBuddy'])
    expect(options[0]!.text()).not.toContain('sources')
    expect(options[0]!.find('[data-testid="mtl-chip"]').exists()).toBe(false)
    expect(options[1]!.find('[data-testid="mtl-chip"]').text()).toBe('MTL')
    wrapper.unmount()
  })

  it('shows at most three site pills and a +N for the rest', async () => {
    api.suggestSerials.mockResolvedValue({
      query: 'om',
      suggestions: [
        suggestion({
          entries: ['A', 'B', 'C', 'D', 'E'].map((name) => ({
            sourceId: name,
            sourceName: `Site ${name}`,
            path: name,
            mtl: false,
            seriesKey: `nl:${name}`,
          })),
        }),
      ],
    })
    const wrapper = await mountPanel()
    await type(wrapper, 'om')

    const option = wrapper.get('[role="option"]')
    expect(option.findAll('[data-testid="source-pill"]').map((pill) => pill.text())).toEqual(['Site A', 'Site B', 'Site C'])
    expect(option.get('[data-testid="source-pill-more"]').text()).toBe('+2')
    wrapper.unmount()
  })

  it('moves through suggestions with the arrow keys and opens the matched series on Enter', async () => {
    const wrapper = await mountPanel()
    await type(wrapper, 'om')
    const input = wrapper.get('#web-serials-query')

    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(input.attributes('aria-activedescendant')).toBe('web-serials-suggestion-0')
    expect(wrapper.findAll('[role="option"]')[0]!.attributes('aria-selected')).toBe('true')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(wrapper.emitted('open-suggestion')?.[0]?.[0]).toMatchObject({ matchId: '777', title: 'Omniscient Reader' })
    expect(api.discoverSerials).not.toHaveBeenCalled()
    expect(input.attributes('aria-expanded')).toBe('false')
    wrapper.unmount()
  })

  it('hands an unmatched suggestion, with all its copies, to the preview when clicked', async () => {
    const wrapper = await mountPanel()
    await type(wrapper, 'om')

    await wrapper.findAll('[role="option"]')[1]!.trigger('click')
    await flushPromises()

    expect(wrapper.emitted('open-suggestion')?.[0]?.[0]).toMatchObject({ title: 'Omega Saga', entries: [{ seriesKey: 'nl:b:Yi9v' }] })
    expect(api.fetchSeries).not.toHaveBeenCalled()
    expect(wrapper.emitted('open-entry')).toBeUndefined()
    wrapper.unmount()
  })

  it('closes on Escape and runs the normal search on Enter without a highlight', async () => {
    const wrapper = await mountPanel()
    await type(wrapper, 'om')
    const input = wrapper.get('#web-serials-query')

    await input.trigger('keydown', { key: 'Escape' })
    expect(input.attributes('aria-expanded')).toBe('false')

    await type(wrapper, 'omega')
    await input.trigger('keydown', { key: 'Enter' })
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(api.discoverSerials).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('open-entry')).toBeUndefined()
    expect(input.attributes('aria-expanded')).toBe('false')
    wrapper.unmount()
  })

  it('asks for no suggestions while the scope is manga', async () => {
    const wrapper = await mountPanel()
    const manga = wrapper.findAll('fieldset button').find((button) => button.text() === 'Manga')!
    await manga.trigger('click')
    await type(wrapper, 'om')
    expect(api.suggestSerials).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
