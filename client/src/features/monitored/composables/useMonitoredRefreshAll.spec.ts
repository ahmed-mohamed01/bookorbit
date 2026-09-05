import { beforeEach, describe, expect, it } from 'vitest'
import { useMonitoredRefreshAll } from './useMonitoredRefreshAll'

describe('useMonitoredRefreshAll', () => {
  beforeEach(() => {
    useMonitoredRefreshAll().finish()
  })

  it('refuses a second concurrent pass over the same authors', () => {
    const first = useMonitoredRefreshAll()

    expect(first.start()).toBe(true)
    expect(first.start()).toBe(false)
  })

  it('shares running state across callers, so a remount cannot show idle mid-run', () => {
    const view = useMonitoredRefreshAll()
    view.start()
    view.report(3, 10)

    // A fresh call site stands in for the view remounting under KeepAlive.
    const remounted = useMonitoredRefreshAll()

    expect(remounted.running.value).toBe(true)
    expect(remounted.progress.value).toEqual({ processed: 3, total: 10 })
    expect(remounted.start()).toBe(false)
  })

  it('reports no progress before a total is known and clears on finish', () => {
    const refresh = useMonitoredRefreshAll()
    refresh.start()

    expect(refresh.progress.value).toBeNull()

    refresh.report(1, 4)
    expect(refresh.progress.value).toEqual({ processed: 1, total: 4 })

    refresh.finish()
    expect(refresh.running.value).toBe(false)
    expect(refresh.progress.value).toBeNull()
  })
})
