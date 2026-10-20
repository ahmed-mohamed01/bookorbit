import { expect, it, vi, afterEach, beforeEach } from 'vitest'
import { effectScope } from 'vue'
import { flushPromises } from '@vue/test-utils'
import type { MonitoredAuthorDetail, MonitoredAuthorItem } from '@bookorbit/types'
import { useMonitoredAuthorDetail } from '../useMonitoredAuthorDetail'
const { fetchDetail, events } = vi.hoisted(() => ({
  fetchDetail: vi.fn<(id: string) => Promise<MonitoredAuthorDetail>>(),
  events: { current: null as null | { onItem: (item: MonitoredAuthorItem) => void; onReconnect: () => void } },
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { id: 'a' }, query: {} }), useRouter: () => ({ replace: vi.fn<() => Promise<void>>() }) }))
vi.mock('../useMonitoredFetchEvents', () => ({
  useMonitoredFetchEvents: (handlers: typeof events.current) => {
    events.current = handlers
  },
}))
vi.mock('../../api/monitored', () => ({ fetchMonitoredAuthorDetail: fetchDetail }))
let scope: ReturnType<typeof effectScope>
beforeEach(() => {
  scope = effectScope()
})
afterEach(() => {
  scope.stop()
  fetchDetail.mockReset()
})
const item = (id: string, state = 'idle') => ({ id, fetch: { state, errorKind: null, retryAt: null, errorAt: null } }) as MonitoredAuthorItem
it('drops stale overlapping loads', async () => {
  const state = scope.run(() => useMonitoredAuthorDetail())!
  let resolve!: (value: MonitoredAuthorDetail) => void
  fetchDetail
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    .mockResolvedValueOnce({ author: item('new'), works: [] })
  const older = state.load()
  await state.load()
  resolve({ author: item('old'), works: [] } as unknown as MonitoredAuthorDetail)
  await older
  expect(state.detail.value?.author.id).toBe('new')
})
it('ignores other authors and reloads once for an idle event', async () => {
  const state = scope.run(() => useMonitoredAuthorDetail())!
  fetchDetail.mockResolvedValue({ author: item('a', 'fetching'), works: [] })
  await state.load()
  events.current!.onItem(item('b'))
  expect(fetchDetail).toHaveBeenCalledTimes(1)
  events.current!.onItem(item('a'))
  await flushPromises()
  expect(fetchDetail).toHaveBeenCalledTimes(2)
})

it('reconciles a pending author on connect and reconnect but leaves idle alone', async () => {
  const state = scope.run(() => useMonitoredAuthorDetail())!
  fetchDetail.mockResolvedValue({ author: item('a', 'queued'), works: [] })
  await state.load()
  events.current!.onReconnect()
  await flushPromises()
  expect(fetchDetail).toHaveBeenCalledTimes(2)
  fetchDetail.mockResolvedValue({ author: item('a'), works: [] })
  events.current!.onReconnect()
  await flushPromises()
  events.current!.onReconnect()
  expect(fetchDetail).toHaveBeenCalledTimes(3)
})
it('updates a failed author without reloading its catalog', async () => {
  const state = scope.run(() => useMonitoredAuthorDetail())!
  fetchDetail.mockResolvedValue({ author: item('a', 'fetching'), works: [] })
  await state.load()
  events.current!.onItem(item('a', 'failed'))
  expect(state.fetchStatus.value.state).toBe('failed')
  expect(fetchDetail).toHaveBeenCalledTimes(1)
})
