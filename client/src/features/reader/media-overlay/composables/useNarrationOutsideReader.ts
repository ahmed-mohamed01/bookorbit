import { computed } from 'vue'
import { useTtsMiniPlayerUi } from '@/features/tts/composables/useTtsMiniPlayerUi'
import { useMediaOverlay } from './useMediaOverlay'

// Narration left running in the background keeps its own place on screen only while no reader is
// open; inside any reader, even another book's, the dock follows the reader's rules.
export function useNarrationOutsideReader() {
  const { isBackground } = useMediaOverlay()
  const { isReaderOpen } = useTtsMiniPlayerUi()
  return computed(() => isBackground.value && !isReaderOpen.value)
}
