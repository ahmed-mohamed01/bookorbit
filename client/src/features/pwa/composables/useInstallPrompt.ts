import { computed, ref } from 'vue'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const _deferredPrompt = ref<BeforeInstallPromptEvent | null>(null)

function _onBeforeInstallPrompt(e: Event) {
  e.preventDefault()
  _deferredPrompt.value = e as BeforeInstallPromptEvent
}

function _onAppInstalled() {
  _deferredPrompt.value = null
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', _onBeforeInstallPrompt)
  window.addEventListener('appinstalled', _onAppInstalled)
}

export function useInstallPrompt() {
  const isInstallable = computed(() => _deferredPrompt.value !== null)

  async function installApp(): Promise<void> {
    const prompt = _deferredPrompt.value
    if (!prompt) return

    await prompt.prompt()

    const { outcome } = await prompt.userChoice
    if (outcome === 'accepted') {
      _deferredPrompt.value = null
    }
  }

  return { isInstallable, installApp }
}

/** Resets module-level singleton state. For use in tests only. */
export function _resetInstallPromptForTest() {
  _deferredPrompt.value = null
}
