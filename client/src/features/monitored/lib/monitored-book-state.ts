import type { MonitoredBookEntry } from '@bookorbit/types'

const createdListeners = new Set<() => void>()

export function isMonitoredBookForWork(entries: readonly MonitoredBookEntry[], monitorAuthorId: string, workId: string): boolean {
  return entries.some((entry) => entry.monitorAuthorId === monitorAuthorId && entry.workId === workId)
}

export function notifyMonitoredBookCreated(): void {
  for (const listener of createdListeners) listener()
}

export function onMonitoredBookCreated(listener: () => void): () => void {
  createdListeners.add(listener)
  return () => createdListeners.delete(listener)
}
