import type { BookFileRef, EditionSyncBookState, ReadAloudProgressSyncMode } from '@bookorbit/types'
import { bookFormatEntries, isPlainEpubEntry } from '@/features/book/lib/book-formats'

export type EditionSyncToggleKind = 'readAlong' | 'index' | 'none'

export interface EditionSyncTogglePlan {
  setIndexOverride: boolean
  setReadAloudMode: ReadAloudProgressSyncMode | null
}

export function editionSyncToggleKind(state: EditionSyncBookState | null): EditionSyncToggleKind {
  if (!state) return 'none'
  if (state.hasReadAlong && state.hasAudio) return 'readAlong'
  return state.eligible ? 'index' : 'none'
}

/** What upstream's per-book read-aloud sync works with, read from the book's own files. */
export interface ReadAlongEditions {
  hasReadAlong: boolean
  hasAudio: boolean
  /** A second EPUB beside the read-along, which upstream keeps in step through the narration. */
  hasEpubCopy: boolean
}

export function readAlongEditions(
  files: readonly Pick<BookFileRef, 'id' | 'format' | 'role' | 'sizeBytes' | 'mediaOverlay'>[],
  formatPriority?: readonly string[] | null,
): ReadAlongEditions {
  const entries = bookFormatEntries(files, formatPriority)
  const readAlong = entries.find((entry) => entry.readAlong)
  return {
    hasReadAlong: readAlong !== undefined,
    hasAudio: entries.some((entry) => entry.audio),
    hasEpubCopy: readAlong !== undefined && (readAlong.files.length > 1 || entries.some(isPlainEpubEntry)),
  }
}

/** Editions upstream's read-aloud sync keeps together, or null when it has nothing to sync for this book. */
export function readAlongSyncCount(editions: ReadAlongEditions): number | null {
  if (!editions.hasReadAlong || !(editions.hasAudio || editions.hasEpubCopy)) return null
  return 1 + Number(editions.hasAudio) + Number(editions.hasEpubCopy)
}

export function editionSyncToggleValue(
  kind: EditionSyncToggleKind,
  state: EditionSyncBookState | null,
  readAloudMode: ReadAloudProgressSyncMode,
): boolean {
  if (kind === 'readAlong') return readAloudMode === 'auto'
  return state?.syncEnabled === true && readAloudMode !== 'disabled'
}

export function planEditionSyncToggle(kind: EditionSyncToggleKind, value: boolean, readAloudMode: ReadAloudProgressSyncMode): EditionSyncTogglePlan {
  if (kind === 'readAlong') return { setIndexOverride: false, setReadAloudMode: value ? 'auto' : 'disabled' }
  if (kind === 'index') return { setIndexOverride: true, setReadAloudMode: value && readAloudMode === 'disabled' ? 'auto' : null }
  return { setIndexOverride: false, setReadAloudMode: null }
}
