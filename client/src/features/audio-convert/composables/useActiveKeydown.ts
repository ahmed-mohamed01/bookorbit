// Fork: Convert to M4B. Document keydown that only listens while the view is on screen. The Tools
// view keeps tabs alive, and a hidden tab must not react to shortcuts meant for the visible one.
import { onActivated, onDeactivated, onMounted, onUnmounted } from 'vue'

export function useActiveKeydown(handler: (event: KeyboardEvent) => void): void {
  let listening = false

  function start(): void {
    if (listening) return
    document.addEventListener('keydown', handler)
    listening = true
  }

  function stop(): void {
    if (!listening) return
    document.removeEventListener('keydown', handler)
    listening = false
  }

  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onUnmounted(stop)
}
