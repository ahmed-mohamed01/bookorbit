import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, markRaw, reactive, shallowRef, type Component } from 'vue'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { requestMonitoredWork, updateMonitoredWork } from '../api/monitored'
import { workFixture } from '../testing/work-fixture'
import MonitoredView from './MonitoredView.vue'

const mocks = vi.hoisted(() => ({
  route: null as unknown as { name: string; query: Record<string, unknown>; fullPath: string },
  requestsChanged: null as (() => void) | null,
  routerReplace: vi.fn<(to: unknown) => Promise<void>>(),
  searchMonitoredWorks: vi.fn<(options: { q: string; page: number; size: number }) => Promise<unknown>>(),
}))

vi.mock('vue-router', () => ({
  useRoute: () => mocks.route,
  useRouter: () => ({ replace: mocks.routerReplace, push: vi.fn<(to: unknown) => Promise<void>>() }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => true }) }))
vi.mock('@/features/book/composables/useScrollRestoreOnActivate', () => ({ useScrollRestoreOnActivate: vi.fn<() => void>() }))
vi.mock('@/features/book-requests/composables/useBookRequestProgress', () => ({
  useBookRequestProgress: () => ({
    onRequestsChanged: (callback: () => void) => {
      mocks.requestsChanged = callback
      return () => undefined
    },
  }),
}))
vi.mock('../api/monitored', () => ({
  fetchMonitoredSummary: vi.fn<() => Promise<unknown>>(() =>
    Promise.resolve({
      authors: 0,
      books: 0,
      releases: 0,
      releaseCards: { byStatus: 0, byWork: 0 },
      hardcoverConfigured: true,
      audibleConfigured: false,
    }),
  ),
  fetchMonitoredAuthors: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ items: [], total: 0, page: 0, size: 50 })),
  fetchMonitoredReleases: vi.fn<() => Promise<unknown>>(() =>
    Promise.resolve({ items: [], total: 0, page: 0, size: 50, cards: { byStatus: 0, byWork: 0 } }),
  ),
  fetchClassCounts: vi.fn<() => Promise<unknown>>(() => Promise.resolve({})),
  searchMonitoredWorks: mocks.searchMonitoredWorks,
  refreshMonitoredAuthor: vi.fn<() => Promise<unknown>>(),
  requestMonitoredWork: vi.fn<() => Promise<unknown>>(),
  updateMonitoredWork: vi.fn<() => Promise<unknown>>(),
  updateMonitoredAuthor: vi.fn<() => Promise<unknown>>(),
  deleteMonitoredAuthor: vi.fn<() => Promise<unknown>>(),
}))

const observerCallbacks: IntersectionObserverCallback[] = []
class MockIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    observerCallbacks.push(callback)
  }
  observe = vi.fn<(target: Element) => void>()
  unobserve = vi.fn<(target: Element) => void>()
  disconnect = vi.fn<() => void>()
  takeRecords = vi.fn<() => IntersectionObserverEntry[]>(() => [])
}

function mountView() {
  return shallowMount(MonitoredView, {
    global: {
      stubs: { BrowseHeader: { name: 'BrowseHeader', template: '<div><slot name="facts" /><slot name="tabs" /><slot name="bar" /></div>' } },
    },
  })
}

function mountKeptView() {
  const current = shallowRef<Component>(MonitoredView)
  const dummy = markRaw(defineComponent({ template: '<div>Other</div>' }))
  const parent = shallowMount(defineComponent({ setup: () => ({ current }), template: '<KeepAlive><component :is="current" /></KeepAlive>' }), {
    global: {
      stubs: {
        KeepAlive: false,
        MonitoredView: false,
        BrowseHeader: { props: ['foldedCount'], template: '<div><slot name="facts" /><slot name="tabs" /><slot name="bar" /></div>' },
      },
    },
  })
  return {
    parent,
    leave: () => {
      current.value = dummy
    },
    enter: () => {
      current.value = markRaw(MonitoredView)
    },
  }
}

describe('MonitoredView search and the route', () => {
  beforeEach(() => {
    observerCallbacks.length = 0
    vi.useFakeTimers()
    HTMLElement.prototype.scrollTo = vi.fn<() => void>()
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
    mocks.route = reactive({ name: 'monitored', query: {}, fullPath: '/watchlist' })
    mocks.routerReplace.mockReset().mockResolvedValue()
    mocks.searchMonitoredWorks.mockReset().mockResolvedValue({ items: [], total: 0, page: 0, size: 50 })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("ignores another page's ?q= while it stays alive in the background", async () => {
    mountView()
    await flushPromises()
    mocks.routerReplace.mockClear()

    mocks.route.name = 'web-serials'
    mocks.route.query = { q: 'fire' }
    await flushPromises()
    vi.advanceTimersByTime(1000)
    await flushPromises()

    expect(mocks.routerReplace).not.toHaveBeenCalled()
    expect(mocks.searchMonitoredWorks).not.toHaveBeenCalled()
  })

  it('follows ?q= on its own route', async () => {
    mountView()
    await flushPromises()

    mocks.route.query = { q: 'fire' }
    await flushPromises()
    vi.advanceTimersByTime(300)
    await flushPromises()

    expect(mocks.searchMonitoredWorks).toHaveBeenCalledWith(expect.objectContaining({ q: 'fire', page: 0 }))
  })
  it('does not page a detached sentinel when a pending search lands', async () => {
    let resolve!: (value: unknown) => void
    mocks.route.query = { q: 'fire' }
    mocks.searchMonitoredWorks.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const view = mountKeptView()
    await flushPromises()
    view.leave()
    await flushPromises()
    resolve({ items: [], total: 200, page: 0, size: 50 })
    await flushPromises()
    expect(mocks.searchMonitoredWorks).toHaveBeenCalledTimes(1)
    observerCallbacks[0]!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    await flushPromises()
    expect(mocks.searchMonitoredWorks).toHaveBeenCalledTimes(1)
    view.enter()
    await flushPromises()
    expect(mocks.searchMonitoredWorks).toHaveBeenCalledTimes(2)
    view.parent.unmount()
  })

  it('uses the URL on return when q disappeared while away', async () => {
    mocks.route.query = { q: 'fire' }
    const view = mountKeptView()
    await flushPromises()
    view.leave()
    mocks.route.name = 'other'
    mocks.route.query = {}
    await flushPromises()
    mocks.route.name = 'monitored'
    view.enter()
    await flushPromises()
    expect(view.parent.findComponent({ name: 'BrowseSearchField' }).props('modelValue')).toBe('')
    view.parent.unmount()
  })

  it('restores a typed query whose debounce was cancelled on leaving', async () => {
    const view = mountKeptView()
    await flushPromises()
    view.parent.findComponent({ name: 'BrowseSearchField' }).vm.$emit('update:modelValue', 'typed')
    await flushPromises()
    view.leave()
    mocks.route.name = 'other'
    await flushPromises()
    mocks.route.name = 'monitored'
    view.enter()
    await flushPromises()
    expect(mocks.routerReplace).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ q: 'typed' }) }))
    expect(mocks.searchMonitoredWorks).toHaveBeenCalledWith(expect.objectContaining({ q: 'typed' }))
    view.parent.unmount()
  })

  it('patches requests and hides locally without resetting search pages', async () => {
    const work = workFixture()
    mocks.route.query = { q: 'fire' }
    mocks.searchMonitoredWorks.mockResolvedValue({
      items: [{ work, authorModes: { ebook: 'notify', audiobook: 'off' } }],
      total: 1,
      page: 0,
      size: 50,
    })
    const view = mountView()
    await flushPromises()
    const results = view.findComponent({ name: 'MonitoredWorkSearchResults' })
    vi.mocked(requestMonitoredWork).mockResolvedValue({ ...work, requestStatuses: { ebook: 'pending' } })
    results.vm.$emit('download-ebook', work)
    await flushPromises()
    expect(mocks.searchMonitoredWorks).toHaveBeenCalledTimes(1)
    expect(results.props('items')[0].work.requestStatuses.ebook).toBe('pending')
    mocks.requestsChanged?.()
    vi.advanceTimersByTime(1600)
    await flushPromises()
    expect(mocks.searchMonitoredWorks).toHaveBeenCalledTimes(1)
    view.findComponent({ name: 'MonitoredBookPanel' }).vm.$emit('filed', { ...work, ownedFormats: ['ebook'] })
    await flushPromises()
    expect(results.props('items')[0].work.ownedFormats).toEqual(['ebook'])
    expect(mocks.searchMonitoredWorks).toHaveBeenCalledTimes(1)
    vi.mocked(updateMonitoredWork).mockResolvedValue({ ...work, userVisibility: 'hidden' })
    results.vm.$emit('stop', work)
    await flushPromises()
    expect(results.props('items')).toEqual([])
    expect(mocks.searchMonitoredWorks).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('shows a hint without counts for two code points and hides Audible during search', async () => {
    mocks.route.query = { q: '😀a', tab: 'releases' }
    const view = mountView()
    await flushPromises()
    expect(view.text()).toContain('monitored.search.hint')
    expect(view.text()).not.toContain('monitored.search.count')
    expect(view.findComponent({ name: 'BrowseHeader' }).attributes('folded-count')).toBeUndefined()
    expect(view.findComponent({ name: 'MonitoredAudibleNotice' }).exists()).toBe(false)
    expect(mocks.searchMonitoredWorks).not.toHaveBeenCalled()
    view.unmount()
  })

  it('does not hydrate or serialize q on the Add tab', async () => {
    mocks.route.query = { q: 'fire', tab: 'add' }
    const view = mountView()
    await flushPromises()
    expect(mocks.searchMonitoredWorks).not.toHaveBeenCalled()
    expect((view.vm as unknown as { filterQuery: string }).filterQuery).toBe('')
    await view.findAll('[role="tab"]')[0]!.trigger('click')
    await flushPromises()
    expect(view.findComponent({ name: 'BrowseSearchField' }).props('modelValue')).toBe('')
    await view.findAll('[role="tab"]')[2]!.trigger('click')
    expect(mocks.routerReplace).toHaveBeenLastCalledWith(expect.objectContaining({ query: expect.objectContaining({ q: undefined, tab: 'add' }) }))
    view.unmount()
  })
  it('reloads search page zero when scrolling to a dropped top', async () => {
    mocks.route.query = { q: 'fire' }
    mocks.searchMonitoredWorks.mockImplementation(async ({ page }) => ({
      items: Array.from({ length: 50 }, (_, i) => ({ work: workFixture({ id: String(page * 50 + i) }) })),
      total: 1600,
      page,
      size: 50,
    }))
    const view = mountView()
    for (let i = 0; i < 35; i++) await flushPromises()
    expect(view.findComponent({ name: 'MonitoredWorkSearchResults' }).props('items')).toHaveLength(1500)
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ top: 10000 } as DOMRect)
    observerCallbacks[1]!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    await flushPromises()
    expect(mocks.searchMonitoredWorks).toHaveBeenLastCalledWith({ q: 'fire', page: 0, size: 50 })
    rect.mockRestore()
    view.unmount()
  })
  it('hides a search card locally without fetching page zero', async () => {
    const work = workFixture()
    mocks.route.query = { q: 'fire' }
    mocks.searchMonitoredWorks.mockResolvedValue({ items: [{ work }], total: 1, page: 0, size: 50 })
    vi.mocked(updateMonitoredWork).mockResolvedValue({ ...work, userVisibility: 'hidden' })
    const view = mountView()
    await flushPromises()
    const results = view.findComponent({ name: 'MonitoredWorkSearchResults' })
    results.vm.$emit('stop', work)
    await flushPromises()
    expect(results.props('items')).toEqual([])
    expect(updateMonitoredWork).toHaveBeenLastCalledWith(work.id, { hidden: true })
    expect(mocks.searchMonitoredWorks).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('omits both counts for an ASCII query below the minimum', async () => {
    mocks.route.query = { q: 'ab' }
    const view = mountView()
    await flushPromises()
    expect(view.text()).not.toContain('monitored.search.count')
    expect(view.findComponent({ name: 'BrowseHeader' }).attributes('folded-count')).toBeUndefined()
    view.unmount()
  })

  it('omits the Audible notice for a ready search on Releases', async () => {
    mocks.route.query = { q: 'fire', tab: 'releases' }
    const view = mountView()
    await flushPromises()
    expect(view.findComponent({ name: 'MonitoredAudibleNotice' }).exists()).toBe(false)
    view.unmount()
  })
})
