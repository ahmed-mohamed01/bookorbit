import { expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import type { MonitoredAuthorItem } from '@bookorbit/types'
import { useMonitoredFetchEvents } from '../useMonitoredFetchEvents'
const { socket, listeners } = vi.hoisted(() => {
  const listeners = new Map<string, (event?: unknown) => void>()
  return {
    listeners,
    socket: {
      on: vi.fn<(name: string, fn: (event?: unknown) => void) => void>((name, fn) => {
        listeners.set(name, fn)
      }),
      off: vi.fn<() => void>(),
      disconnect: vi.fn<() => void>(),
    },
  }
})
vi.mock('@/lib/socket', () => ({ createAuthenticatedSocket: vi.fn<() => typeof socket>(() => socket) }))
it('shares one socket, broadcasts items, reconciles connections and cleans up the last scope', () => {
  const first = effectScope(),
    second = effectScope()
  const a = { onItem: vi.fn<(item: MonitoredAuthorItem) => void>(), onReconnect: vi.fn<() => void>() },
    b = { onItem: vi.fn<(item: MonitoredAuthorItem) => void>(), onReconnect: vi.fn<() => void>() }
  first.run(() => useMonitoredFetchEvents(a))
  second.run(() => useMonitoredFetchEvents(b))
  expect(socket.on).toHaveBeenCalledTimes(2)
  const item = { id: 'a' } as MonitoredAuthorItem
  listeners.get('monitored:fetch')!({ item })
  expect(a.onItem).toHaveBeenCalledWith(item)
  expect(b.onItem).toHaveBeenCalledWith(item)
  listeners.get('connect')!()
  listeners.get('connect')!()
  expect(a.onReconnect).toHaveBeenCalledTimes(2)
  first.stop()
  expect(socket.disconnect).not.toHaveBeenCalled()
  second.stop()
  expect(socket.disconnect).toHaveBeenCalledOnce()
  expect(socket.off).toHaveBeenCalledTimes(2)
})
