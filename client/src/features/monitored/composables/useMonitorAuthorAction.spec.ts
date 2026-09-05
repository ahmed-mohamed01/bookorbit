import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { toast } from 'vue-sonner'
import type { MonitoredAuthorDetail, MonitoredAuthorSearchResult } from '@bookorbit/types'
import { searchMonitoredAuthors } from '../api/monitored'
import { MonitoredApiError } from '../lib/api-error'
import { useMonitorAuthorAction } from './useMonitorAuthorAction'

vi.mock('../api/monitored', () => ({
  searchMonitoredAuthors: vi.fn<() => Promise<MonitoredAuthorSearchResult[]>>(),
}))

vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
    info: vi.fn<(message: string) => void>(),
  },
}))

const searchMock = vi.mocked(searchMonitoredAuthors)

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

function detail(authorName: string): MonitoredAuthorDetail {
  return { author: { authorName }, works: [] } as unknown as MonitoredAuthorDetail
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

    expect(toast.info).toHaveBeenCalledWith('Already monitoring Blake Crouch')
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
    expect(toast.success).toHaveBeenCalledWith('Now monitoring Blake Crouch.')
    wrapper.unmount()
  })
})
