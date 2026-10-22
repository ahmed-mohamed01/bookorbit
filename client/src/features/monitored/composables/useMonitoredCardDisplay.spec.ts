import { effectScope, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { storage } from '@/services/storage'

async function freshComposable() {
  vi.resetModules()
  return (await import('./useMonitoredCardDisplay')).useMonitoredCardDisplay
}

describe('useMonitoredCardDisplay', () => {
  beforeEach(() => {
    storage.remove('monitored:cards:size')
    storage.remove('monitored:cards:gap')
  })

  it('gives every watchlist grid the same size and gap, and remembers them', async () => {
    const useMonitoredCardDisplay = await freshComposable()
    const releases = useMonitoredCardDisplay()
    const authorPage = useMonitoredCardDisplay()

    releases.workCardSize.value = 180
    authorPage.cardGap.value = 24
    await nextTick()

    expect(authorPage.workCardSize.value).toBe(180)
    expect(releases.cardGap.value).toBe(24)
    expect(storage.get('monitored:cards:size', null)).toBe(180)
    expect(storage.get('monitored:cards:gap', null)).toBe(24)
  })

  it('keeps saving after the view that first used it is gone', async () => {
    const useMonitoredCardDisplay = await freshComposable()
    const scope = effectScope()
    const first = scope.run(() => useMonitoredCardDisplay())!
    scope.stop()

    first.workCardSize.value = 200
    await nextTick()

    expect(storage.get('monitored:cards:size', null)).toBe(200)
  })
})
