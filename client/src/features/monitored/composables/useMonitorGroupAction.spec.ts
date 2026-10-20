import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { toast } from 'vue-sonner'
import type { MonitoredAuthorItem } from '@bookorbit/types'
import { monitorAuthor } from '../api/monitored'
import { MonitoredApiError } from '../lib/api-error'
import { useMonitorGroupAction, type MonitorGroupTarget } from './useMonitorGroupAction'

vi.mock('../api/monitored', () => ({
  monitorAuthor: vi.fn<() => Promise<MonitoredAuthorItem>>(),
}))

vi.mock('vue-sonner', () => ({
  toast: {
    success: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
    info: vi.fn<(message: string) => void>(),
  },
}))

const monitorMock = vi.mocked(monitorAuthor)

const group: MonitorGroupTarget = { key: 'group-1', authors: ['Blake Crouch'] }

function detail(): MonitoredAuthorItem {
  return { authorName: 'Blake Crouch' } as unknown as MonitoredAuthorItem
}

function mountComposable() {
  let composable!: ReturnType<typeof useMonitorGroupAction>
  const wrapper = mount(
    defineComponent({
      setup() {
        composable = useMonitorGroupAction()
        return () => null
      },
    }),
  )
  return { composable, wrapper }
}

describe('useMonitorGroupAction', () => {
  beforeEach(() => {
    monitorMock.mockReset()
    vi.clearAllMocks()
  })

  it('monitors the first author for ebook notifications and marks the row', async () => {
    monitorMock.mockResolvedValue(detail())
    const { composable, wrapper } = mountComposable()

    await composable.monitorGroupAuthor(group)

    expect(monitorMock).toHaveBeenCalledWith({
      authorName: 'Blake Crouch',
      formats: {
        ebook: { mode: 'notify', libraryId: null, folderId: null },
        audiobook: { mode: 'off', libraryId: null, folderId: null },
      },
    })
    expect(composable.isGroupMonitored(group)).toBe(true)
    expect(composable.isGroupMonitoring(group)).toBe(false)
    expect(composable.monitorAuthorLabel(group)).toBe('Blake Crouch is already on your watchlist')
    expect(toast.success).toHaveBeenCalledWith('Added Blake Crouch to your watchlist.')
    wrapper.unmount()
  })

  it('does nothing on a second click for an author already monitored', async () => {
    monitorMock.mockResolvedValue(detail())
    const { composable, wrapper } = mountComposable()

    await composable.monitorGroupAuthor(group)
    await composable.monitorGroupAuthor({ key: 'group-2', authors: ['Blake Crouch'] })

    expect(monitorMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('ignores a second click while the first request is still in flight', async () => {
    let settle = () => {}
    monitorMock.mockImplementation(() => new Promise<MonitoredAuthorItem>((resolve) => (settle = () => resolve(detail()))))
    const { composable, wrapper } = mountComposable()

    const first = composable.monitorGroupAuthor(group)
    expect(composable.isGroupMonitoring(group)).toBe(true)
    await composable.monitorGroupAuthor(group)

    expect(monitorMock).toHaveBeenCalledTimes(1)
    settle()
    await first
    expect(composable.isGroupMonitoring(group)).toBe(false)
    wrapper.unmount()
  })

  it('reports a failure with the shared error text and leaves the row clickable', async () => {
    monitorMock.mockRejectedValue(new Error('network down'))
    const { composable, wrapper } = mountComposable()

    await composable.monitorGroupAuthor(group)

    expect(toast.error).toHaveBeenCalledWith('Failed to add author to watchlist.')
    expect(composable.isGroupMonitored(group)).toBe(false)
    expect(composable.monitorAuthorLabel(group)).toBe('Add Blake Crouch to your watchlist and get notified about new ebook releases')
    wrapper.unmount()
  })

  it('shows the server message when the request fails with one', async () => {
    monitorMock.mockRejectedValue(new MonitoredApiError(503, 'Provider unavailable'))
    const { composable, wrapper } = mountComposable()

    await composable.monitorGroupAuthor(group)

    expect(toast.error).toHaveBeenCalledWith('Provider unavailable')
    wrapper.unmount()
  })

  it('treats the duplicate guard as an author already monitored', async () => {
    monitorMock.mockRejectedValue(new MonitoredApiError(400, 'Already monitoring this author'))
    const { composable, wrapper } = mountComposable()

    await composable.monitorGroupAuthor(group)

    expect(toast.info).toHaveBeenCalledWith('Already monitoring this author')
    expect(toast.error).not.toHaveBeenCalled()
    expect(composable.isGroupMonitored(group)).toBe(true)
    wrapper.unmount()
  })

  it('marks an author monitored elsewhere without issuing a request', () => {
    const { composable, wrapper } = mountComposable()

    composable.markGroupMonitored('Blake Crouch')

    expect(composable.isGroupMonitored(group)).toBe(true)
    expect(monitorMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('skips a group with no author', async () => {
    const { composable, wrapper } = mountComposable()

    await composable.monitorGroupAuthor({ key: 'group-3', authors: [] })

    expect(monitorMock).not.toHaveBeenCalled()
    expect(composable.monitorAuthorLabel({ key: 'group-3', authors: [] })).toBe('Add  to your watchlist and get notified about new ebook releases')
    wrapper.unmount()
  })
})
