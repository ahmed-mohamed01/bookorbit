import { expect, it } from 'vitest'
import type { MonitoredFetchErrorKind, MonitoredFetchStatus } from '@bookorbit/types'
import { fetchStatusCopy } from './fetch-status-copy'
const now = new Date('2026-10-20T12:00:00Z')
const status = (errorKind: MonitoredFetchErrorKind, retryAt: string | null = null): MonitoredFetchStatus => ({
  state: 'failed',
  errorKind,
  retryAt,
  errorAt: now.toISOString(),
})
it.each(['timeout', 'rate_limited', 'unavailable', 'auth_failed', 'author_gone', 'not_configured'] as const)(
  'selects the %s title and action',
  (kind) => {
    const actions = {
      timeout: 'useRefresh',
      rate_limited: 'useRefresh',
      unavailable: 'useRefresh',
      auth_failed: 'checkKey',
      author_gone: 'authorGone',
      not_configured: 'addKey',
    }
    expect(fetchStatusCopy(status(kind), now, false)).toEqual({ titleKey: `monitored.fetch.${kind}`, actionKey: `monitored.fetch.${actions[kind]}` })
  },
)
it('rounds retry minutes up and uses the action after retry time passes', () => {
  expect(fetchStatusCopy(status('timeout', '2026-10-20T12:04:10Z'), now, true)?.actionParams).toEqual({ minutes: 5 })
  expect(fetchStatusCopy(status('timeout', '2026-10-20T11:00:00Z'), now, true)?.actionKey).toBe('monitored.fetch.useRefresh')
})
it('returns null for idle', () => {
  expect(fetchStatusCopy({ ...status('timeout'), state: 'idle' }, now, false)).toBeNull()
})
