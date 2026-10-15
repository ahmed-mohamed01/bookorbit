import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebSerialNovelProviders } from '@bookorbit/types'

const api = vi.hoisted(() => ({
  fetchNovelProviders: vi.fn<() => Promise<WebSerialNovelProviders>>(),
  saveNovelProviders: vi.fn<(input: { disabledDomains: string[] }) => Promise<WebSerialNovelProviders>>(),
}))
const toastError = vi.hoisted(() => vi.fn<(message: string) => void>())

vi.mock('../api/webSerials', () => api)
vi.mock('vue-sonner', () => ({ toast: { error: toastError } }))

import { useWebSerialNovelProviders } from '../composables/useWebSerialNovelProviders'
import { readStoredSearch, saveStoredSearch } from '../composables/webSerialSearchStore'

function providers(overrides: Partial<WebSerialNovelProviders> = {}): WebSerialNovelProviders {
  return {
    search: [
      { domain: 'royalroad.com', name: 'Royal Road', enabled: true },
      { domain: 'scribblehub.com', name: 'Scribble Hub', enabled: true },
    ],
    linkSites: [
      { domain: 'royalroad.com', name: 'Royal Road' },
      { domain: 'webnovel.com', name: 'Webnovel' },
      { domain: 'wuxiaworld.com', name: 'Wuxiaworld' },
    ],
    linkSitesTotal: 3,
    unavailable: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchNovelProviders.mockResolvedValue(providers())
})

describe('useWebSerialNovelProviders', () => {
  it('saves the full disabled list when a site is switched off', async () => {
    api.saveNovelProviders.mockImplementation(async (input) =>
      providers({ search: providers().search.map((item) => ({ ...item, enabled: !input.disabledDomains.includes(item.domain) })) }),
    )
    const state = useWebSerialNovelProviders()
    await state.load()
    await state.toggle('scribblehub.com', false)
    expect(api.saveNovelProviders).toHaveBeenCalledWith({ disabledDomains: ['scribblehub.com'] })
    expect(state.search.value.map((item) => item.enabled)).toEqual([true, false])
  })

  it('shows the change at once and reverts with a toast when saving fails', async () => {
    let reject: (error: Error) => void = () => undefined
    api.saveNovelProviders.mockReturnValue(new Promise((_resolve, rejecter) => (reject = rejecter)))
    const state = useWebSerialNovelProviders()
    await state.load()
    const pending = state.toggle('royalroad.com', false)
    expect(state.search.value[0]?.enabled).toBe(false)
    reject(new Error('nope'))
    await pending
    expect(state.search.value[0]?.enabled).toBe(true)
    expect(toastError).toHaveBeenCalledWith('nope')
  })

  it('filters the link sites by name or domain', async () => {
    const state = useWebSerialNovelProviders()
    await state.load()
    expect(state.filteredLinkSites.value).toHaveLength(3)
    state.setLinkQuery('WUXIA')
    expect(state.filteredLinkSites.value.map((site) => site.domain)).toEqual(['wuxiaworld.com'])
    state.setLinkQuery('webnovel.com')
    expect(state.filteredLinkSites.value.map((site) => site.name)).toEqual(['Webnovel'])
    state.setLinkQuery('zzz')
    expect(state.filteredLinkSites.value).toEqual([])
  })

  it('starts collapsed and toggles the link list', () => {
    const state = useWebSerialNovelProviders()
    expect(state.linkOpen.value).toBe(false)
    state.toggleLinkOpen()
    expect(state.linkOpen.value).toBe(true)
  })

  it('reports the unavailable engine and load failures', async () => {
    api.fetchNovelProviders.mockResolvedValueOnce(providers({ linkSites: [], linkSitesTotal: 0, unavailable: true }))
    const state = useWebSerialNovelProviders()
    await state.load()
    expect(state.unavailable.value).toBe(true)

    api.fetchNovelProviders.mockRejectedValueOnce(new Error('down'))
    const failing = useWebSerialNovelProviders()
    await failing.load()
    expect(failing.error.value).toBe('down')
    expect(failing.providers.value).toBeNull()
  })
})

describe('useWebSerialNovelProviders and the kept search', () => {
  it('drops the kept search once a change of sites is saved', async () => {
    saveStoredSearch({
      q: 'tower',
      kind: 'novel',
      mode: 'sites',
      source: null,
      showMachineTranslations: false,
      entries: [],
      entriesQuery: '',
      mangaHits: [],
      novelHits: [],
      failedSources: [],
      novelSourcesDisabled: false,
      fallbackReason: null,
      fetchedAt: Date.now(),
    })
    api.saveNovelProviders.mockResolvedValue(providers())
    const state = useWebSerialNovelProviders()
    await state.load()

    await state.toggle('royalroad.com', false)

    expect(readStoredSearch()).toBeNull()
  })

  it('keeps the kept search when the save is refused', async () => {
    const stored = {
      q: 'tower',
      kind: 'novel' as const,
      mode: 'sites' as const,
      source: null,
      showMachineTranslations: false,
      entries: [],
      entriesQuery: '',
      mangaHits: [],
      novelHits: [],
      failedSources: [],
      novelSourcesDisabled: false,
      fallbackReason: null,
      fetchedAt: Date.now(),
    }
    saveStoredSearch(stored)
    api.saveNovelProviders.mockRejectedValue(new Error('nope'))
    const state = useWebSerialNovelProviders()
    await state.load()

    await state.toggle('royalroad.com', false)

    expect(readStoredSearch()?.q).toBe('tower')
  })
})
