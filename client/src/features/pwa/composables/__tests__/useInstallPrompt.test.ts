import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useInstallPrompt, _resetInstallPromptForTest } from '../useInstallPrompt'

// The composable uses module-level singleton state for the deferred prompt.
// Each test resets that state via the exported helper before running.

function makePromptEvent(outcome: 'accepted' | 'dismissed' = 'accepted'): Event & {
  prompt: ReturnType<typeof vi.fn>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
  preventDefault: ReturnType<typeof vi.fn>
} {
  let resolveChoice!: (v: { outcome: 'accepted' | 'dismissed' }) => void
  const userChoice = new Promise<{ outcome: 'accepted' | 'dismissed' }>((res) => {
    resolveChoice = res
  })

  const evt = new Event('beforeinstallprompt') as Event & {
    prompt: ReturnType<typeof vi.fn>
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
    preventDefault: ReturnType<typeof vi.fn>
  }
  evt.preventDefault = vi.fn<() => void>()
  evt.prompt = vi.fn<() => Promise<void>>(() => {
    resolveChoice({ outcome })
    return Promise.resolve()
  })
  Object.defineProperty(evt, 'userChoice', { get: () => userChoice })
  return evt
}

describe('useInstallPrompt', () => {
  beforeEach(() => {
    _resetInstallPromptForTest()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('isInstallable is false before beforeinstallprompt fires', () => {
    const { isInstallable } = useInstallPrompt()
    expect(isInstallable.value).toBe(false)
  })

  it('isInstallable becomes true after beforeinstallprompt fires', () => {
    const { isInstallable } = useInstallPrompt()
    const evt = makePromptEvent()
    window.dispatchEvent(evt)
    expect(isInstallable.value).toBe(true)
  })

  it('preventDefault is called on beforeinstallprompt', () => {
    const evt = makePromptEvent()
    window.dispatchEvent(evt)
    expect(evt.preventDefault).toHaveBeenCalledOnce()
  })

  it('installApp calls prompt() on the deferred event', async () => {
    const { installApp } = useInstallPrompt()
    const evt = makePromptEvent('accepted')
    window.dispatchEvent(evt)
    await installApp()
    expect(evt.prompt).toHaveBeenCalledOnce()
  })

  it('isInstallable resets to false after user accepts', async () => {
    const { isInstallable, installApp } = useInstallPrompt()
    const evt = makePromptEvent('accepted')
    window.dispatchEvent(evt)
    expect(isInstallable.value).toBe(true)
    await installApp()
    expect(isInstallable.value).toBe(false)
  })

  it('isInstallable stays true after user dismisses', async () => {
    const { isInstallable, installApp } = useInstallPrompt()
    const evt = makePromptEvent('dismissed')
    window.dispatchEvent(evt)
    expect(isInstallable.value).toBe(true)
    await installApp()
    expect(isInstallable.value).toBe(true)
  })

  it('isInstallable resets to false on appinstalled event', () => {
    const { isInstallable } = useInstallPrompt()
    const evt = makePromptEvent()
    window.dispatchEvent(evt)
    expect(isInstallable.value).toBe(true)
    window.dispatchEvent(new Event('appinstalled'))
    expect(isInstallable.value).toBe(false)
  })

  it('installApp is a no-op when isInstallable is false', async () => {
    const { isInstallable, installApp } = useInstallPrompt()
    expect(isInstallable.value).toBe(false)
    await expect(installApp()).resolves.toBeUndefined()
  })

  it('prompt is not called again after app was accepted and installed', async () => {
    const { installApp } = useInstallPrompt()
    const evt = makePromptEvent('accepted')
    window.dispatchEvent(evt)
    await installApp()
    // prompt was cleared - second call is a no-op
    await installApp()
    expect(evt.prompt).toHaveBeenCalledOnce()
  })
})
