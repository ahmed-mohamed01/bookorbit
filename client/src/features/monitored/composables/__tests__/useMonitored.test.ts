import { expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import type { MonitoredAuthorItem } from '@bookorbit/types'
import { fetchMonitoredAuthors } from '../../api/monitored'
import { useMonitored } from '../useMonitored'
const { events } = vi.hoisted(() => ({
  events: { current: null as null | { onItem: (item: MonitoredAuthorItem) => void; onReconnect: () => void } },
}))
vi.mock('../../api/monitored', () => ({ fetchMonitoredAuthors: vi.fn<typeof fetchMonitoredAuthors>() }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../useMonitoredFetchEvents', () => ({
  useMonitoredFetchEvents: (handlers: typeof events.current) => {
    events.current = handlers
  },
}))
it('updates loaded authors and ignores removed or unloaded ids', () => {
  const scope = effectScope()
  const reconnect = vi.fn<() => void>()
  const state = scope.run(() => useMonitored(reconnect))!
  state.authors.value = [{ id: 'a', authorName: 'before' } as MonitoredAuthorItem]
  events.current!.onItem({ id: 'a', authorName: 'after' } as MonitoredAuthorItem)
  events.current!.onItem({ id: 'deleted' } as MonitoredAuthorItem)
  expect(state.authors.value.map((item) => item.authorName)).toEqual(['after'])
  events.current!.onReconnect()
  expect(reconnect).toHaveBeenCalledOnce()
  scope.stop()
})

it('keeps a terminal event newer than an in-flight list response', async () => {
  vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(101)
  let resolve!: (value: Awaited<ReturnType<typeof fetchMonitoredAuthors>>) => void
  vi.mocked(fetchMonitoredAuthors).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    }),
  )
  const scope = effectScope()
  const state = scope.run(() => useMonitored())!
  const loading = state.loadAuthors({ sort: 'added', order: 'desc' }, true)
  events.current!.onItem({ id: 'a', fetch: { state: 'idle' } } as MonitoredAuthorItem)
  resolve({ items: [{ id: 'a', fetch: { state: 'fetching' } } as MonitoredAuthorItem], page: 0, size: 50, total: 1 })
  await loading
  expect(state.authors.value[0]!.fetch.state).toBe('idle')
  scope.stop()
  vi.restoreAllMocks()
})
