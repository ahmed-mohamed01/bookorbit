import { computed } from 'vue'
import { useTtsMiniPlayerUi } from '@/features/tts/composables/useTtsMiniPlayerUi'
import { useNarrationOutsideReader } from './useNarrationOutsideReader'

export const NARRATION_ABOVE_FOOTER_CLASS = 'bottom-[calc(1rem+2.5rem)] sm:bottom-[calc(1rem+2.75rem)]'
// Tailwind needs the literal class, so this repeats NARRATION_BASE_CLEARANCE (useNarrationDockClearance).
const NARRATION_OUTSIDE_READER_CLASS = 'bottom-[max(1.5rem,var(--podcast-mini-player-clearance,0px))]'

// Without the reader footer, the bottom page margin still holds the page-number and time-left
// line, so the narration controls sit above it instead of on top of it.
export function useNarrationDockPosition() {
  const { isReaderFooterVisible } = useTtsMiniPlayerUi()
  const isOutsideReader = useNarrationOutsideReader()
  return computed(() => {
    if (isReaderFooterVisible.value) return NARRATION_ABOVE_FOOTER_CLASS
    return isOutsideReader.value ? NARRATION_OUTSIDE_READER_CLASS : 'bottom-10'
  })
}
