import { computed } from 'vue'
import { useTtsMiniPlayerUi } from '@/features/tts/composables/useTtsMiniPlayerUi'

export const NARRATION_ABOVE_FOOTER_CLASS = 'bottom-[calc(1rem+2.5rem)] sm:bottom-[calc(1rem+2.75rem)]'

// Without the reader footer, the bottom page margin still holds the page-number and time-left
// line, so the narration controls sit above it instead of on top of it.
export function useNarrationDockPosition() {
  const { isReaderFooterVisible } = useTtsMiniPlayerUi()
  return computed(() => (isReaderFooterVisible.value ? NARRATION_ABOVE_FOOTER_CLASS : 'bottom-10'))
}
