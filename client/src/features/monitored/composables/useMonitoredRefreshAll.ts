import { computed, ref } from 'vue'

/**
 * Refresh-all state lives at module scope, like the author feature's refreshing set: the loop
 * outlives the view under KeepAlive, so a remount must not show an idle button or start a
 * second concurrent pass over the same authors.
 */
const running = ref(false)
const processed = ref(0)
const total = ref(0)

export function useMonitoredRefreshAll() {
  const progress = computed(() => (running.value && total.value > 0 ? { processed: processed.value, total: total.value } : null))

  function start(): boolean {
    if (running.value) return false
    running.value = true
    processed.value = 0
    total.value = 0
    return true
  }

  function report(done: number, all: number) {
    processed.value = done
    total.value = all
  }

  function finish() {
    running.value = false
    processed.value = 0
    total.value = 0
  }

  return { running, progress, start, report, finish }
}
