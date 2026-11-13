import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import type { EditionSyncBookState } from '@bookorbit/types'
import { useTimingIndexReadAlong } from '../useTimingIndexReadAlong'

type Entry = { key: string; audio: boolean; readAlong: boolean; files: { id: number }[] }

const ALIGNED_EPUB_ID = 7
const PLAIN_EPUB: Entry = { key: 'epub', audio: false, readAlong: false, files: [{ id: ALIGNED_EPUB_ID }] }

function makeState(overrides: Partial<EditionSyncBookState> = {}, status: EditionSyncBookState['index']['status'] = 'ready'): EditionSyncBookState {
  return {
    bookId: 1,
    eligible: true,
    editionCount: 2,
    syncOverride: null,
    syncEnabled: true,
    effectiveReason: null,
    wanted: true,
    canRunNow: false,
    canRetry: false,
    hasReadAlong: false,
    hasAudio: true,
    pinned: false,
    runActive: false,
    index: {
      status,
      stage: null,
      progress: null,
      queuePosition: null,
      nextRunAt: null,
      indexedAt: null,
      indexFileId: null,
      epubFileId: ALIGNED_EPUB_ID,
      sentences: null,
      matchedSentences: null,
      failedAt: null,
      errorCode: null,
      error: null,
      attemptCount: 0,
      whisperFallback: false,
      workerVersion: null,
    },
    ...overrides,
  }
}

function readsAlong(state: EditionSyncBookState | null, entries: Entry[] = [PLAIN_EPUB], visible = true): boolean {
  return useTimingIndexReadAlong({ state: ref(state), visible: ref(visible) }, () => entries).value
}

function withIndexEpub(epubFileId: number | null | undefined): EditionSyncBookState {
  const state = makeState()
  return { ...state, index: { ...state.index, epubFileId } }
}

const TWO_PLAIN_EPUBS: Entry[] = [{ key: 'epub', audio: false, readAlong: false, files: [{ id: ALIGNED_EPUB_ID }, { id: 8 }] }]

describe('useTimingIndexReadAlong', () => {
  it('reads along with a ready index, audio, no read-along EPUB and a plain EPUB', () => {
    expect(readsAlong(makeState())).toBe(true)
  })

  it('reads along when the aligned EPUB is one of two plain EPUBs', () => {
    expect(readsAlong(makeState(), TWO_PLAIN_EPUBS)).toBe(true)
  })

  it('reads along when the primary file is the audiobook', () => {
    expect(readsAlong(makeState(), [{ key: 'm4b', audio: true, readAlong: false, files: [{ id: 3 }] }, PLAIN_EPUB])).toBe(true)
  })

  it.each([
    ['edition sync is hidden', () => readsAlong(makeState(), [PLAIN_EPUB], false)],
    ['the state has not loaded', () => readsAlong(null)],
    ['sync is off for the book', () => readsAlong(makeState({ syncEnabled: false }))],
    ['the index is not ready', () => readsAlong(makeState({}, 'running'))],
    ['the book has no audio', () => readsAlong(makeState({ hasAudio: false }))],
    ['the book has a read-along EPUB', () => readsAlong(makeState({ hasReadAlong: true }))],
    ['the book has no plain EPUB', () => readsAlong(makeState(), [{ key: 'epub', audio: false, readAlong: true, files: [{ id: ALIGNED_EPUB_ID }] }])],
    [
      'the aligned EPUB is gone and another plain EPUB remains',
      () => readsAlong(makeState(), [{ key: 'epub', audio: false, readAlong: false, files: [{ id: 8 }] }]),
    ],
    ['the index was aligned to a different EPUB', () => readsAlong(withIndexEpub(99))],
    ['the index has no provenance EPUB (null)', () => readsAlong(withIndexEpub(null))],
    ['the index has no provenance EPUB (older server)', () => readsAlong(withIndexEpub(undefined))],
  ])('does not when %s', (_, check) => {
    expect(check()).toBe(false)
  })
})
