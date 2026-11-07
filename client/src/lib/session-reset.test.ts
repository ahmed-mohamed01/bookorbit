import { describe, expect, it, vi } from 'vitest'

describe('session resets', () => {
  it('runs registered resets on every session clear', async () => {
    vi.resetModules()
    const { onSessionCleared, clearSessionState } = await import('./session-reset')
    const reset = vi.fn<() => void>()
    onSessionCleared(reset)
    clearSessionState()
    clearSessionState()
    expect(reset).toHaveBeenCalledTimes(2)
  })
})
