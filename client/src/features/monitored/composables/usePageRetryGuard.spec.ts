import { describe, expect, it } from 'vitest'
import { usePageRetryGuard } from './usePageRetryGuard'

describe('usePageRetryGuard', () => {
  it('blocks auto-paging only after the cap of consecutive failures', () => {
    const guard = usePageRetryGuard(2)

    expect(guard.blocked.value).toBe(false)
    guard.record(true)
    expect(guard.blocked.value).toBe(false)
    guard.record(true)
    expect(guard.blocked.value).toBe(true)
  })

  it('forgets earlier failures as soon as a page succeeds', () => {
    const guard = usePageRetryGuard(2)

    guard.record(true)
    guard.record(false)
    guard.record(true)

    expect(guard.failures.value).toBe(1)
    expect(guard.blocked.value).toBe(false)
  })

  it('lifts the block on an explicit reset, as a manual retry or new query does', () => {
    const guard = usePageRetryGuard(2)

    guard.record(true)
    guard.record(true)
    expect(guard.blocked.value).toBe(true)

    guard.reset()
    expect(guard.blocked.value).toBe(false)
  })
})
