import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, mount, flushPromises } from '@vue/test-utils'
import { reactive, ref } from 'vue'
import { catalogEntry } from './fixtures'
import { toast } from 'vue-sonner'
import { i18n } from '@/i18n'

enableAutoUnmount(afterEach)

const state = vi.hoisted(() => ({
  allowed: true,
  api: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  replace: vi.fn<(to: unknown) => Promise<void>>(),
  start: vi.fn<() => void>(),
  cancelPreview: vi.fn<() => void>(),
}))
const route = reactive<{ name: string; query: Record<string, string> }>({ name: 'web-serials', query: {} })

vi.mock('@/lib/api', () => ({ api: state.api }))
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ replace: state.replace }) }))
vi.mock('vue-sonner', () => ({ toast: { success: vi.fn<() => void>(), error: vi.fn<() => void>() } }))
vi.mock('@/features/auth/composables/useAuth', () => ({ useAuth: () => ({ user: ref({ id: 7 }) }) }))
vi.mock('@/features/auth/composables/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => state.allowed }) }))
vi.mock('../composables/useWebSerialQueue', () => ({
  useWebSerialQueue: () => ({
    jobs: ref([]),
    activeCount: ref(0),
    queuePaused: ref(false),
    scope: ref('mine'),
    loading: ref(false),
    loaded: ref(true),
    error: ref(null),
    busyIds: ref(new Set()),
    queueBusy: ref(false),
    clearing: ref(false),
    expandedIds: ref(new Set()),
    details: ref({}),
    hasMore: ref(false),
    loadingMore: ref(false),
    start: state.start,
    refresh: vi.fn<() => Promise<void>>(),
  }),
}))

import WebSerialsPage from '../WebSerialsPage.vue'

const stubs = {
  WebSerialsSearchPanel: { template: '<div data-testid="search" />' },
  WebSerialQueue: { template: '<div data-testid="queue" />' },
  WebSerialPreviewSheet: true,
  WebSerialMoveSheet: true,
  WebSerialNovelProvidersSheet: true,
}

function mountPage() {
  return mount(WebSerialsPage, { global: { plugins: [i18n], stubs } })
}

beforeEach(() => {
  vi.clearAllMocks()
  state.allowed = true
  state.api.mockResolvedValue(new Response(JSON.stringify(catalogEntry()), { status: 200 }))
  route.name = 'web-serials'
  route.query = {}
})

describe('WebSerialsPage novel sources tip', () => {
  const searchStub = { emits: ['novel-available'], template: '<button data-testid="search" @click="$emit(\'novel-available\', true)" />' }

  function mountWithSearch() {
    return mount(WebSerialsPage, { global: { plugins: [i18n], stubs: { ...stubs, WebSerialsSearchPanel: searchStub } } })
  }

  it('hides the info tip until light novels are available', async () => {
    const wrapper = mountWithSearch()
    expect(wrapper.find('[aria-label="About light novel sources"]').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'WebSerialNovelProvidersSheet' }).exists()).toBe(false)
    await wrapper.get('[data-testid="search"]').trigger('click')
    expect(wrapper.find('[aria-label="About light novel sources"]').exists()).toBe(true)
  })

  it('opens the sources sheet from the tip', async () => {
    const wrapper = mountWithSearch()
    await wrapper.get('[data-testid="search"]').trigger('click')
    await wrapper.get('[aria-label="About light novel sources"]').trigger('click')
    expect(wrapper.findComponent({ name: 'WebSerialNovelProvidersSheet' }).props('open')).toBe(true)
  })
})

describe('WebSerialsPage', () => {
  it('does not poll the queue for someone without Web Serial access', () => {
    state.allowed = false
    mountPage()
    expect(state.start).not.toHaveBeenCalled()
    state.allowed = true
    mountPage()
    expect(state.start).toHaveBeenCalledTimes(1)
  })

  it('switches tabs on the same route so the page keeps its search and open rows', async () => {
    const wrapper = mountPage()
    const tabs = wrapper.findAll('[role="tab"]')
    await tabs[1]!.trigger('click')
    expect(state.replace).toHaveBeenCalledWith({ name: 'web-serials', query: { tab: 'queue' } })

    route.query = { tab: 'queue' }
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="queue"]').exists()).toBe(true)
    await tabs[0]!.trigger('click')
    expect(state.replace).toHaveBeenLastCalledWith({ name: 'web-serials', query: {} })
  })

  it('keeps the search params when switching tabs', async () => {
    route.query = { q: 'one piece', kind: 'all' }
    const wrapper = mountPage()
    const tabs = wrapper.findAll('[role="tab"]')
    await tabs[1]!.trigger('click')
    expect(state.replace).toHaveBeenCalledWith({ name: 'web-serials', query: { q: 'one piece', kind: 'all', tab: 'queue' } })
  })

  it('still opens the queue from the old queue route', () => {
    route.name = 'web-serials-queue'
    expect(mountPage().find('[data-testid="queue"]').exists()).toBe(true)
  })

  it('moves between the tabs with the arrow keys', async () => {
    const wrapper = mountPage()
    await wrapper.get('[role="tablist"]').trigger('keydown', { key: 'ArrowRight' })
    expect(state.replace).toHaveBeenLastCalledWith({ name: 'web-serials', query: { tab: 'queue' } })

    route.query = { tab: 'queue' }
    await wrapper.vm.$nextTick()
    await wrapper.get('[role="tablist"]').trigger('keydown', { key: 'Home' })
    expect(state.replace).toHaveBeenLastCalledWith({ name: 'web-serials', query: {} })
  })
})

describe('WebSerialsPage preview answers', () => {
  const panelStub = {
    name: 'WebSerialsSearchPanel',
    emits: ['open', 'preview-loading', 'preview-error', 'preview-pending', 'open-entry'],
    props: ['canSetUp', 'userId'],
    template: '<div data-testid="search" />',
    setup: () => ({ cancelPreview: state.cancelPreview }),
  }

  function mountWithPanel() {
    return mount(WebSerialsPage, { global: { plugins: [i18n], stubs: { ...stubs, WebSerialsSearchPanel: panelStub } } })
  }

  it('drops a preview that arrives after the sheet moved on to another series', async () => {
    const wrapper = mountWithPanel()
    const panel = wrapper.findComponent({ name: 'WebSerialsSearchPanel' })
    panel.vm.$emit('preview-loading')
    await wrapper.vm.$nextTick()
    const entry = { kind: 'manga', matchId: '9', title: 'Entry' }
    panel.vm.$emit('open-entry', entry)
    await wrapper.vm.$nextTick()

    panel.vm.$emit('open', { seriesKey: 'm:old', title: 'Old hit' })
    await wrapper.vm.$nextTick()

    const sheet = wrapper.findComponent({ name: 'WebSerialPreviewSheet' })
    expect(sheet.props('entry')).toEqual(entry)
    expect(sheet.props('detail')).toBeNull()
  })

  it('drops a preview that arrives after the sheet was closed', async () => {
    const wrapper = mountWithPanel()
    const panel = wrapper.findComponent({ name: 'WebSerialsSearchPanel' })
    panel.vm.$emit('preview-loading')
    await wrapper.vm.$nextTick()
    wrapper.findComponent({ name: 'WebSerialPreviewSheet' }).vm.$emit('update:open', false)
    await wrapper.vm.$nextTick()

    panel.vm.$emit('open', { seriesKey: 'm:old', title: 'Old hit' })
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'WebSerialPreviewSheet' }).props('detail')).toBeNull()
  })

  it('stops waiting for a long chapter list when the sheet is closed', async () => {
    const wrapper = mountWithPanel()
    const panel = wrapper.findComponent({ name: 'WebSerialsSearchPanel' })
    panel.vm.$emit('preview-loading')
    panel.vm.$emit('preview-pending', 'Royal Road')
    await wrapper.vm.$nextTick()
    const sheet = wrapper.findComponent({ name: 'WebSerialPreviewSheet' })
    expect(sheet.props('loadingNotice')).toBe('Loading the full chapter list from Royal Road. Long series can take several minutes.')

    sheet.vm.$emit('update:open', false)
    await wrapper.vm.$nextTick()
    expect(state.cancelPreview).toHaveBeenCalledTimes(1)
    expect(sheet.props('loadingNotice')).toBeNull()
  })

  it('tells the search panel whether the user can set the feature up', () => {
    state.allowed = false
    expect(mountWithPanel().findComponent({ name: 'WebSerialsSearchPanel' }).props('canSetUp')).toBe(false)
    state.allowed = true
    expect(mountWithPanel().findComponent({ name: 'WebSerialsSearchPanel' }).props('canSetUp')).toBe(true)
  })

  it('shows a preview the sheet is waiting for', async () => {
    const wrapper = mountWithPanel()
    const panel = wrapper.findComponent({ name: 'WebSerialsSearchPanel' })
    panel.vm.$emit('preview-loading')
    await wrapper.vm.$nextTick()
    panel.vm.$emit('open', { seriesKey: 'm:new', title: 'New hit' })
    await wrapper.vm.$nextTick()

    expect(wrapper.findComponent({ name: 'WebSerialPreviewSheet' }).props('detail')).toMatchObject({ seriesKey: 'm:new' })
  })
})

describe('series deep links', () => {
  it('fetches and opens once, strips the param, and handles a new link on the same page', async () => {
    route.query = { series: 'manga:1995', q: 'frieren' }
    const wrapper = mountPage()
    await flushPromises()
    expect(state.api).toHaveBeenCalledExactlyOnceWith('/api/v1/web-serials/discover/manga/1995', { signal: expect.any(AbortSignal) })
    expect(wrapper.findComponent({ name: 'WebSerialPreviewSheet' }).props()).toMatchObject({ open: true, entry: catalogEntry() })
    expect(state.replace).toHaveBeenLastCalledWith({ name: 'web-serials', query: { q: 'frieren' } })
    route.query = { series: 'manga:1995', q: 'another search' }
    await flushPromises()
    expect(state.api).toHaveBeenCalledTimes(1)
    route.query = { q: 'frieren' }
    await flushPromises()
    expect(state.api).toHaveBeenCalledTimes(1)
    state.api.mockResolvedValue(new Response(JSON.stringify(catalogEntry({ kind: 'novel', matchId: '77' })), { status: 200 }))
    route.query = { series: 'novel:77' }
    await flushPromises()
    expect(wrapper.findComponent({ name: 'WebSerialPreviewSheet' }).props('entry')).toMatchObject({ kind: 'novel', matchId: '77' })
    wrapper.unmount()
  })
  it.each(['manga:no', 'other:1', 'novel:1:2', 'manga:-1', ''])('ignores and strips invalid link %s', async (series) => {
    route.query = { series }
    const wrapper = mountPage()
    await flushPromises()
    expect(state.api).not.toHaveBeenCalled()
    expect(state.replace).toHaveBeenLastCalledWith({ name: 'web-serials', query: {} })
    wrapper.unmount()
  })
  it('shows an error and strips a failed link', async () => {
    state.api.mockResolvedValue(new Response('{}', { status: 502 }))
    route.query = { series: 'manga:1995' }
    const wrapper = mountPage()
    await flushPromises()
    expect(toast.error).toHaveBeenCalled()
    expect(state.replace).toHaveBeenLastCalledWith({ name: 'web-serials', query: {} })
    wrapper.unmount()
  })
})
