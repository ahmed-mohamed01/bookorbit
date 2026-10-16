import { useStorage } from '@vueuse/core'

const STORAGE_KEY = 'bookorbit:monitored:dismissed-banners'
// Oldest dismissals drop off first, so the list never grows with the library.
const MAX_REMEMBERED = 500

/** Panel notices the reader closed, per work and notice, remembered in this browser only. */
export function useDismissedBanners() {
  const stored = useStorage<string[]>(STORAGE_KEY, [])
  // A foreign or hand-edited value must not break the panel; it reads as nothing dismissed.
  const keys = () => (Array.isArray(stored.value) ? stored.value : [])

  function isDismissed(key: string): boolean {
    return keys().includes(key)
  }

  function dismiss(key: string) {
    stored.value = [...keys().filter((entry) => entry !== key), key].slice(-MAX_REMEMBERED)
  }

  /** Forgets a dismissal, so the notice shows again the next time the reader makes that choice. */
  function forget(key: string) {
    if (keys().includes(key)) stored.value = keys().filter((entry) => entry !== key)
  }

  return { isDismissed, dismiss, forget }
}
