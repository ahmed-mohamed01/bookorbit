import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { MonitoredBookWork, MonitoredFormat } from '@bookorbit/types'
import { fetchMonitoredBookWork } from '../api/monitored'
import { useBookMonitoredWork } from './useBookMonitoredWork'

vi.mock('../api/monitored', () => ({ fetchMonitoredBookWork: vi.fn<() => Promise<MonitoredBookWork | null>>() }))

const fetchMock = vi.mocked(fetchMonitoredBookWork)

function bookWork(patch: Record<string, unknown> = {}): MonitoredBookWork {
  return {
    monitorAuthorId: 'monitor-1',
    authorModes: { ebook: 'notify', audiobook: 'auto-all' },
    work: {
      id: 'w1',
      ebookReleaseDate: null,
      ebookDatePrecision: null,
      audioReleaseDate: '2099-01-01',
      audioDatePrecision: 'day',
      ownedFormats: ['ebook'],
      matchedBookIds: { ebook: 5 },
      requestIds: {},
      ...patch,
    },
  } as unknown as MonitoredBookWork
}

function setup(options: { bookId?: number | null; enabled?: boolean } = {}) {
  const bookId = ref<number | null>(options.bookId === undefined ? 5 : options.bookId)
  const enabled = ref(options.enabled ?? true)
  const format = ref<MonitoredFormat | null>('audiobook')
  let result!: ReturnType<typeof useBookMonitoredWork>
  const wrapper = mount(
    defineComponent({
      setup() {
        result = useBookMonitoredWork(bookId, format, enabled)
        return () => null
      },
    }),
  )
  return { result, bookId, enabled, wrapper }
}

describe('useBookMonitoredWork', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('fetches the book once and reads the status of the missing format', async () => {
    fetchMock.mockResolvedValue(bookWork())
    const { result, wrapper } = setup()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(5)
    expect(result.status.value).toBe('upcoming')
    expect(result.mode.value).toBe('auto-all')
    wrapper.unmount()
  })

  it('shares one request between readers of the same book', async () => {
    fetchMock.mockResolvedValue(bookWork())
    const first = setup()
    const second = setup()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(second.result.entry.value).not.toBeNull()
    first.wrapper.unmount()
    second.wrapper.unmount()
  })

  it('treats a book that is not on the watchlist as having no entry', async () => {
    fetchMock.mockResolvedValue(null)
    const { result, wrapper } = setup()
    await flushPromises()

    expect(result.entry.value).toBeNull()
    expect(result.status.value).toBeNull()
    wrapper.unmount()
  })

  it('treats a failed read as no entry', async () => {
    fetchMock.mockRejectedValue(new Error('network'))
    const { result, wrapper } = setup()
    await flushPromises()

    expect(result.entry.value).toBeNull()
    wrapper.unmount()
  })

  it('does not fetch while disabled, and fetches once enabled', async () => {
    fetchMock.mockResolvedValue(bookWork())
    const { result, enabled, wrapper } = setup({ enabled: false })
    await flushPromises()
    expect(fetchMock).not.toHaveBeenCalled()

    enabled.value = true
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.entry.value).not.toBeNull()
    wrapper.unmount()
  })

  it('does not fetch without a book', async () => {
    const { wrapper } = setup({ bookId: null })
    await flushPromises()

    expect(fetchMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('reports an author who does not watch the format as not watching', async () => {
    fetchMock.mockResolvedValue({ ...bookWork(), authorModes: { ebook: 'notify', audiobook: 'off' } })
    const { result, wrapper } = setup()
    await flushPromises()

    expect(result.status.value).toBe('not_watching')
    wrapper.unmount()
  })

  it('reports whether the missing format already has a request', async () => {
    fetchMock.mockResolvedValue(bookWork({ requestIds: { audiobook: 3 }, requestStatuses: { audiobook: 'downloading' } }))
    const { result, wrapper } = setup()
    await flushPromises()

    expect(result.hasRequest.value).toBe(true)
    wrapper.unmount()
  })
})
