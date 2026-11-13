import { computed, type Ref } from 'vue'
import type { EditionSyncBookState } from '@bookorbit/types'
import { isPlainEpubEntry, type BookFormatEntry } from '@/features/book/lib/book-formats'

/**
 * Fork: whether the book reads along from its timing index: no read-along EPUB, and the plain EPUB
 * the book's ready index was aligned to is still one of its files. The server narrates only that
 * EPUB (its file id is the index provenance's).
 */
export function useTimingIndexReadAlong(
  editionSync: { state: Ref<EditionSyncBookState | null>; visible: Ref<boolean> },
  entries: () => readonly (Pick<BookFormatEntry, 'key' | 'audio' | 'readAlong'> & { files: readonly { id: number }[] })[],
) {
  return computed(() => {
    const state = editionSync.state.value
    if (!editionSync.visible.value || !state) return false
    if (!state.syncEnabled || state.index.status !== 'ready' || !state.hasAudio || state.hasReadAlong) return false
    const epubFileId = state.index.epubFileId ?? null
    if (epubFileId === null) return false
    return entries().some((entry) => isPlainEpubEntry(entry) && entry.files.some((file) => file.id === epubFileId))
  })
}
