import { onScopeDispose } from 'vue'
import type { Socket } from 'socket.io-client'
import type { MonitoredAuthorItem } from '@bookorbit/types'
import { createAuthenticatedSocket } from '@/lib/socket'

type Handlers = { onItem: (item: MonitoredAuthorItem) => void; onReconnect: () => void }
const subscribers = new Set<Handlers>()
let socket: Socket | null = null
function handleItem(event: { item: MonitoredAuthorItem }): void {
  for (const subscriber of subscribers) subscriber.onItem(event.item)
}
function handleConnect(): void {
  for (const subscriber of subscribers) subscriber.onReconnect()
}
export function useMonitoredFetchEvents(handlers: Handlers): void {
  subscribers.add(handlers)
  if (!socket) {
    socket = createAuthenticatedSocket('/monitored')
    socket.on('monitored:fetch', handleItem)
    socket.on('connect', handleConnect)
  }
  onScopeDispose(() => {
    subscribers.delete(handlers)
    if (subscribers.size || !socket) return
    socket.off('monitored:fetch', handleItem)
    socket.off('connect', handleConnect)
    socket.disconnect()
    socket = null
  })
}
