import { ref } from 'vue'
import { i18n } from '@/i18n'
import { loadFoliate, openStreamingEpub } from '@/features/reader/epub/foliate-loader'
import type { FoliateMediaOverlay } from '@/features/reader/epub/composables/useFoliate'
import type { TocItem } from '@/features/reader/epub/composables/useToc'
import { createNarrationProgressWriter } from '@/features/reader/shared/lib/progress-writer'
import type { TtsCurrentBook } from '@/features/tts/lib/tts-state'
import { registerNarrationChapters } from '../composables/useNarrationChapters'
import type { MediaOverlayBackgroundSink } from '../composables/useMediaOverlay'

interface HeadlessEpub {
  toc?: TocItem[]
  sections?: { mediaOverlay?: unknown }[]
  resolveHref?: (href: string) => { index: number } | null
  getMediaOverlay?: () => FoliateMediaOverlay
  destroy?: () => void
}

export interface HeadlessNarration {
  mediaOverlay: FoliateMediaOverlay
  sink: MediaOverlayBackgroundSink
}

// Builds a narration engine for a book with no reader open: the engine only needs the book, so
// no view or renderer is created. Progress is saved through the same writer the reader uses.
export async function openHeadlessNarration(
  book: TtsCurrentBook,
  playSection: (sectionIndex: number) => void,
  trackingEnabled: boolean,
): Promise<HeadlessNarration> {
  await loadFoliate()
  const { book: epub } = await openStreamingEpub(book.bookId, book.bookFileId)
  const opened = epub as HeadlessEpub
  const mediaOverlay = opened.getMediaOverlay?.()
  if (!mediaOverlay) {
    opened.destroy?.()
    throw new Error(i18n.global.t('reader.narration.noEmbedded'))
  }

  try {
    const progress = createNarrationProgressWriter(book.bookFileId, trackingEnabled)
    await progress.load()

    const unregisterChapters = registerNarrationChapters({
      toc: ref(opened.toc ?? []),
      resolveSectionIndex: (href) => opened.resolveHref?.(href)?.index ?? null,
      hasNarration: (index) => !!opened.sections?.[index]?.mediaOverlay,
      playSection,
    })

    return {
      mediaOverlay,
      sink: {
        saveProgress: progress.setMediaOverlayProgress,
        flush: progress.flush,
        release: () => {
          unregisterChapters()
          opened.destroy?.()
        },
      },
    }
  } catch (e) {
    opened.destroy?.()
    throw e
  }
}
