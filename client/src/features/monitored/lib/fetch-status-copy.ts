import type { MonitoredFetchStatus } from '@bookorbit/types'

export function fetchStatusCopy(
  status: MonitoredFetchStatus,
  now: Date,
  hasCatalog: boolean,
): { titleKey: string; actionKey: string; actionParams?: Record<string, string | number> } | null {
  if (status.state === 'idle') return null
  if (status.state !== 'failed') {
    return { titleKey: `monitored.fetch.${status.state}`, actionKey: hasCatalog ? 'monitored.fetch.refreshing' : 'monitored.fetch.fetching' }
  }
  const titleKey = `monitored.fetch.${status.errorKind ?? 'unavailable'}`
  const retryMs = status.retryAt ? new Date(status.retryAt).getTime() - now.getTime() : 0
  if (retryMs > 0) return { titleKey, actionKey: 'monitored.fetch.retryIn', actionParams: { minutes: Math.max(1, Math.ceil(retryMs / 60_000)) } }
  const action =
    status.errorKind === 'author_gone'
      ? 'authorGone'
      : status.errorKind === 'auth_failed'
        ? 'checkKey'
        : status.errorKind === 'not_configured'
          ? 'addKey'
          : 'useRefresh'
  return { titleKey, actionKey: `monitored.fetch.${action}` }
}
