import { onBeforeUnmount, type Ref } from 'vue'
import type { ReleasedNarration } from '@/features/reader/epub/composables/useFoliate'
import type { TocItem } from '@/features/reader/epub/composables/useToc'
import type { TtsCurrentBook } from '@/features/tts/lib/tts-state'
import { registerNarrationChapters } from './useNarrationChapters'
import { useMediaOverlay, type MediaOverlayTakeover } from './useMediaOverlay'

export interface ReaderNarrationHandoffDeps {
  fileId: number
  trackingEnabled: Readonly<Ref<boolean>>
  isNarratingHere: Readonly<Ref<boolean>>
  isMediaOverlayAvailable: Readonly<Ref<boolean>>
  chapters: Readonly<Ref<TocItem[]>>
  releaseNarration: () => ReleasedNarration | null
  progress: {
    setMediaOverlayProgress: (fragment: string, sectionIndex: number) => void
    flush: () => void
  }
  saveNarrationPos: (sectionIndex: number, fragment: string) => void
  bookDetailsLoaded: () => Promise<void>
  buildTtsBook: () => Promise<TtsCurrentBook | null>
  beginNarration: (sectionIndex: number, matches: ((item: { text: string }) => boolean) | null) => Promise<void>
  adoptRate: (rate: number) => void
}

// Narration outlives its reader: when the reader closes it hands the running engine to the app,
// and a reader opened on the same book takes it back from the sentence it had reached.
export function useReaderNarrationHandoff(deps: ReaderNarrationHandoffDeps) {
  const mediaOverlay = useMediaOverlay()
  let unmounted = false

  function recordPosition(takeover: MediaOverlayTakeover) {
    deps.progress.setMediaOverlayProgress(takeover.fragment, takeover.sectionIndex)
    deps.saveNarrationPos(takeover.sectionIndex, takeover.fragment)
  }

  function settleWithoutResuming(takeover: MediaOverlayTakeover) {
    recordPosition(takeover)
    mediaOverlay.stopBackground()
  }

  // Every await re-checks the reader and re-reads the background state: the background narration
  // is only ended at the moment this reader adopts or restarts it, so a reader that goes away first
  // leaves it playing.
  async function resumeHandedOffNarration() {
    const initial = mediaOverlay.takeOver(deps.fileId)
    if (!initial) return
    if (!deps.isMediaOverlayAvailable.value || (initial.hasEngine && !initial.wasPlaying)) {
      settleWithoutResuming(initial)
      return
    }

    await deps.bookDetailsLoaded()
    if (unmounted) return
    const book = await deps.buildTtsBook()
    if (unmounted || !book) return
    const current = mediaOverlay.takeOver(deps.fileId)
    if (!current) return

    if (current.hasEngine && !current.wasPlaying) {
      settleWithoutResuming(current)
      return
    }
    recordPosition(current)
    deps.adoptRate(mediaOverlay.rate.value)
    const resumeAtSentence = () => deps.beginNarration(current.sectionIndex, (item) => item.text === current.fragment)
    if (current.hasEngine) await resumeAtSentence()
    else mediaOverlay.adoptPaused(book, current, resumeAtSentence, { trackingEnabled: deps.trackingEnabled.value })
  }

  // Runs before the foliate view is torn down, while its narration engine can still be released.
  onBeforeUnmount(() => {
    unmounted = true
    if (!deps.isNarratingHere.value) return
    const released = deps.releaseNarration()
    if (!released) return
    const unregisterChapters = registerNarrationChapters({
      toc: deps.chapters,
      resolveSectionIndex: released.resolveSectionIndex,
      hasNarration: released.hasNarration,
      playSection: mediaOverlay.playSection,
    })
    mediaOverlay.handOff(
      {
        saveProgress: deps.progress.setMediaOverlayProgress,
        flush: deps.progress.flush,
        release: unregisterChapters,
      },
      released.mediaOverlay,
    )
  })

  return { resumeHandedOffNarration }
}
