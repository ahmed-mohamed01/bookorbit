import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KeepAlive, defineComponent, h, nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { toast } from 'vue-sonner'
import type { MonitoredAuthorDetail, MonitoredAuthorSearchResult } from '@bookorbit/types'
import { deleteMonitoredAuthor, fetchMonitoredLocalAuthors, searchMonitoredAuthors } from '../api/monitored'
import { MonitoredApiError } from '../lib/api-error'
import { useMonitorAuthorAction } from './useMonitorAuthorAction'

vi.mock('../api/monitored', () => ({
  searchMonitoredAuthors: vi.fn<() => Promise<MonitoredAuthorSearchResult[]>>(),
  fetchMonitoredLocalAuthors: vi.fn<(ids: number[]) => Promise<Record<number, string>>>(),
  deleteMonitoredAuthor: vi.fn<(id: string) => Promise<void>>(),
}))

vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
    info: vi.fn<(message: string) => void>(),
  },
}))

const searchMock = vi.mocked(searchMonitoredAuthors)
const lookupMock = vi.mocked(fetchMonitoredLocalAuthors)
const deleteMock = vi.mocked(deleteMonitoredAuthor)

const localAuthor = { id: 7, name: 'Blake Crouch', bookCount: 1 }

function searchResult(extra: Partial<MonitoredAuthorSearchResult> = {}): MonitoredAuthorSearchResult {
  return {
    name: 'Blake Crouch',
    providerIds: { hardcover: 'hc-1' },
    localAuthorId: null,
    bookCount: 12,
    imageUrl: null,
    genres: [],
    alreadyMonitoredId: null,
    ...extra,
  }
}

function syntheticFallback(): MonitoredAuthorSearchResult {
  return {
    name: 'Blake Crouch',
    providerIds: {},
    localAuthorId: 7,
    bookCount: 1,
    imageUrl: null,
    genres: [],
    alreadyMonitoredId: null,
  }
}

function detail(authorName: string, id = 'mon-new'): MonitoredAuthorDetail {
  return { author: { id, authorName }, works: [] } as unknown as MonitoredAuthorDetail
}

function mountComposable() {
  let composable!: ReturnType<typeof useMonitorAuthorAction>
  const wrapper = mount(
    defineComponent({
      setup() {
        composable = useMonitorAuthorAction()
        return () => null
      },
    }),
  )
  return { composable, wrapper }
}

describe('useMonitorAuthorAction', () => {
  beforeEach(() => {
    searchMock.mockReset()
    vi.clearAllMocks()
  })

  it('prefers the result already mapped to the local author', async () => {
    const match = searchResult({ name: 'Someone Else', localAuthorId: 7 })
    searchMock.mockResolvedValue([searchResult(), match])
    const { composable, wrapper } = mountComposable()

    await composable.beginMonitor(localAuthor)

    expect(searchMock).toHaveBeenCalledWith('Blake Crouch')
    expect(composable.target.value).toEqual(match)
    expect(composable.resolvingId.value).toBeNull()
    wrapper.unmount()
  })

  it('claims an unbound result by name', async () => {
    const match = searchResult({ name: 'blake crouch  ' })
    searchMock.mockResolvedValue([match])
    const { composable, wrapper } = mountComposable()

    await composable.beginMonitor(localAuthor)

    expect(composable.target.value).toEqual(match)
    wrapper.unmount()
  })

  it('skips a same-name result bound to a different local author', async () => {
    searchMock.mockResolvedValue([searchResult({ localAuthorId: 9 })])
    const { composable, wrapper } = mountComposable()

    await composable.beginMonitor(localAuthor)

    expect(composable.target.value).toEqual(syntheticFallback())
    wrapper.unmount()
  })

  it('falls back to the local author when nothing matches', async () => {
    searchMock.mockResolvedValue([searchResult({ name: 'Someone Else' })])
    const { composable, wrapper } = mountComposable()

    await composable.beginMonitor(localAuthor)

    expect(composable.target.value).toEqual(syntheticFallback())
    expect(composable.initialFormats).toEqual(['ebook', 'audiobook'])
    wrapper.unmount()
  })

  it('says so and opens nothing when the author is already monitored', async () => {
    searchMock.mockResolvedValue([searchResult({ localAuthorId: 7, alreadyMonitoredId: 'mon-1' })])
    const { composable, wrapper } = mountComposable()

    await composable.beginMonitor(localAuthor)

    expect(toast.info).toHaveBeenCalledWith('Blake Crouch is already on your watchlist')
    expect(composable.target.value).toBeNull()
    wrapper.unmount()
  })

  it('reports a failed search and releases the author', async () => {
    searchMock.mockRejectedValue(new Error('network down'))
    const { composable, wrapper } = mountComposable()

    await composable.beginMonitor(localAuthor)

    expect(toast.error).toHaveBeenCalledWith('Failed to search authors.')
    expect(composable.target.value).toBeNull()
    expect(composable.resolvingId.value).toBeNull()
    wrapper.unmount()
  })

  it('shows the server message when the search fails with one', async () => {
    searchMock.mockRejectedValue(new MonitoredApiError(503, 'Provider unavailable'))
    const { composable, wrapper } = mountComposable()

    await composable.beginMonitor(localAuthor)

    expect(toast.error).toHaveBeenCalledWith('Provider unavailable')
    wrapper.unmount()
  })

  it('ignores a second author while the first search is still in flight', async () => {
    let settle = () => {}
    searchMock.mockImplementation(() => new Promise<MonitoredAuthorSearchResult[]>((resolve) => (settle = () => resolve([]))))
    const { composable, wrapper } = mountComposable()

    const first = composable.beginMonitor(localAuthor)
    expect(composable.resolvingId.value).toBe(7)

    await composable.beginMonitor({ id: 8, name: 'Someone Else', bookCount: 3 })
    expect(searchMock).toHaveBeenCalledTimes(1)

    settle()
    await first

    expect(composable.target.value).toEqual(syntheticFallback())
    expect(composable.resolvingId.value).toBeNull()
    wrapper.unmount()
  })

  it('clears the target when the modal closes', async () => {
    searchMock.mockResolvedValue([])
    const { composable, wrapper } = mountComposable()

    await composable.beginMonitor(localAuthor)
    composable.closeModal()

    expect(composable.target.value).toBeNull()
    wrapper.unmount()
  })

  it('closes the modal and confirms once the author is monitored', () => {
    const { composable, wrapper } = mountComposable()

    composable.handleCreated(detail('Blake Crouch'))

    expect(composable.target.value).toBeNull()
    expect(toast.success).toHaveBeenCalledWith('Added Blake Crouch to your watchlist.')
    wrapper.unmount()
  })

  it('remembers the monitor it finds when the author is already monitored', async () => {
    searchMock.mockResolvedValue([searchResult({ localAuthorId: 7, alreadyMonitoredId: 'mon-1' })])
    const { composable, wrapper } = mountComposable()

    await composable.beginMonitor(localAuthor)

    expect(composable.monitoredIdFor(7)).toBe('mon-1')
    wrapper.unmount()
  })

  it('marks the local author as monitored once the monitor is created', async () => {
    searchMock.mockResolvedValue([])
    const { composable, wrapper } = mountComposable()

    await composable.beginMonitor(localAuthor)
    composable.handleCreated(detail('Blake Crouch', 'mon-9'))

    expect(composable.monitoredIdFor(7)).toBe('mon-9')
    wrapper.unmount()
  })

  it('looks each author up once, in batches the server accepts', async () => {
    lookupMock.mockResolvedValue({ 3: 'mon-3' })
    const { composable, wrapper } = mountComposable()
    const ids = Array.from({ length: 250 }, (_, index) => index + 1)

    await composable.loadMonitoredStatus(ids)
    await composable.loadMonitoredStatus([1, 2, 3])

    expect(lookupMock).toHaveBeenCalledTimes(2)
    expect(lookupMock.mock.calls[0]![0]).toHaveLength(200)
    expect(lookupMock.mock.calls[1]![0]).toHaveLength(50)
    expect(composable.monitoredIdFor(3)).toBe('mon-3')
    expect(composable.monitoredIdFor(4)).toBeNull()
    wrapper.unmount()
  })

  it('retries a lookup that failed', async () => {
    lookupMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ 7: 'mon-7' })
    const { composable, wrapper } = mountComposable()

    await composable.loadMonitoredStatus([7])
    await composable.loadMonitoredStatus([7])

    expect(composable.monitoredIdFor(7)).toBe('mon-7')
    wrapper.unmount()
  })

  it('removes the author from the watchlist after confirmation', async () => {
    lookupMock.mockResolvedValue({ 7: 'mon-7' })
    deleteMock.mockResolvedValue()
    const { composable, wrapper } = mountComposable()
    await composable.loadMonitoredStatus([7])

    composable.beginStop(localAuthor)
    expect(composable.stopTarget.value).toEqual({ localId: 7, monitoredId: 'mon-7', name: 'Blake Crouch' })
    await composable.confirmStop()

    expect(deleteMock).toHaveBeenCalledWith('mon-7')
    expect(composable.monitoredIdFor(7)).toBeNull()
    expect(composable.stopTarget.value).toBeNull()
    expect(toast.success).toHaveBeenCalledWith('Removed Blake Crouch from your watchlist.')
    wrapper.unmount()
  })

  it('keeps the author monitored when removal fails', async () => {
    lookupMock.mockResolvedValue({ 7: 'mon-7' })
    deleteMock.mockRejectedValue(new MonitoredApiError(500, 'boom'))
    const { composable, wrapper } = mountComposable()
    await composable.loadMonitoredStatus([7])

    composable.beginStop(localAuthor)
    await composable.confirmStop()

    expect(composable.monitoredIdFor(7)).toBe('mon-7')
    expect(toast.error).toHaveBeenCalledWith('boom')
    wrapper.unmount()
  })

  it('asks again when a cached view comes back, so a change made elsewhere shows', async () => {
    lookupMock.mockResolvedValueOnce({ 7: 'mon-7' }).mockResolvedValueOnce({})
    let composable!: ReturnType<typeof useMonitorAuthorAction>
    const Cached = defineComponent({
      name: 'CachedView',
      setup() {
        composable = useMonitorAuthorAction()
        return () => null
      },
    })
    const Other = defineComponent({ name: 'OtherView', setup: () => () => null })
    const showCached = ref(true)
    const wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, [showCached.value ? h(Cached) : h(Other)]) }))

    await composable.loadMonitoredStatus([7])
    expect(composable.monitoredIdFor(7)).toBe('mon-7')

    showCached.value = false
    await nextTick()
    showCached.value = true
    await nextTick()
    await flushPromises()

    expect(lookupMock).toHaveBeenCalledTimes(2)
    expect(lookupMock.mock.calls[1]![0]).toEqual([7])
    expect(composable.monitoredIdFor(7)).toBeNull()
    wrapper.unmount()
  })

  it('drops the mark when the monitor was already removed elsewhere', async () => {
    lookupMock.mockResolvedValue({ 7: 'mon-7' })
    deleteMock.mockRejectedValue(new MonitoredApiError(404, 'Monitored author not found'))
    const { composable, wrapper } = mountComposable()
    await composable.loadMonitoredStatus([7])

    composable.beginStop(localAuthor)
    await composable.confirmStop()

    expect(composable.monitoredIdFor(7)).toBeNull()
    wrapper.unmount()
  })
})
