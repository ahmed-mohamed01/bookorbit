import { onUnmounted, ref } from 'vue'

export type RefreshFeedbackState = 'idle' | 'loading' | 'done'

// Drives the refresh affordance's icon: idle (refresh glyph) -> loading (spinner) -> done (tick, for a
// beat) -> idle. Shared by the monitored list, author cards, and the author detail Actions menu.
export function useRefreshFeedback(resetMs = 1400) {
  const state = ref<RefreshFeedbackState>('idle')
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearTimer() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  async function run(task: () => Promise<void>): Promise<void> {
    if (state.value === 'loading') return
    clearTimer()
    state.value = 'loading'
    try {
      await task()
      state.value = 'done'
      timer = setTimeout(() => {
        state.value = 'idle'
        timer = null
      }, resetMs)
    } catch (error) {
      state.value = 'idle'
      throw error
    }
  }

  onUnmounted(clearTimer)
  return { state, run }
}
