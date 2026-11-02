import type {
  AudiobookshelfBookSyncLink,
  AudiobookshelfBookSyncLive,
  EditionSyncBookState,
  EditionSyncIndexState,
  ReadAloudProgressSync,
} from '@bookorbit/types'

export function readAloudSync(overrides: Partial<ReadAloudProgressSync> = {}): ReadAloudProgressSync {
  return {
    mode: 'auto',
    state: 'enabled',
    unavailableReason: null,
    overlayFileId: 3,
    audioDurationSeconds: 3600,
    overlayDurationSeconds: 3600,
    durationDifferenceSeconds: 0,
    durationDifferenceRatio: 0,
    koreaderDownloadAvailable: false,
    ...overrides,
  }
}

export function absLink(overrides: Partial<AudiobookshelfBookSyncLink> = {}): AudiobookshelfBookSyncLink {
  return {
    audioBookId: 7,
    absLibraryItemId: 'li_1',
    title: 'He Who Fights',
    authorName: 'Shirtaloon',
    libraryName: 'Fiction',
    direction: 'two_way',
    syncing: true,
    pausedReason: null,
    webUrl: 'https://abs.example/item/li_1',
    ...overrides,
  }
}

export function absLive(overrides: Partial<AudiobookshelfBookSyncLive> = {}): AudiobookshelfBookSyncLive {
  return { status: 'synced', progress: { percentage: 52.4, isFinished: false, lastUpdate: 1 }, local: null, divergedReason: null, ...overrides }
}

export function editionSyncIndex(overrides: Partial<EditionSyncIndexState> = {}): EditionSyncIndexState {
  return {
    status: 'ready',
    stage: null,
    progress: null,
    queuePosition: null,
    nextRunAt: null,
    indexedAt: '2026-10-30T02:10:00.000Z',
    indexFileId: 91,
    sentences: 4200,
    matchedSentences: 4150,
    failedAt: null,
    errorCode: null,
    error: null,
    attemptCount: 1,
    whisperFallback: false,
    workerVersion: '2.0.0',
    ...overrides,
  }
}

export function editionSyncState(
  index: Partial<EditionSyncIndexState> = {},
  overrides: Partial<Omit<EditionSyncBookState, 'index'>> = {},
): EditionSyncBookState {
  return {
    bookId: 7,
    eligible: true,
    editionCount: 2,
    hasReadAlong: false,
    hasAudio: true,
    pinned: false,
    runActive: false,
    syncOverride: null,
    syncEnabled: true,
    effectiveReason: null,
    wanted: true,
    index: editionSyncIndex(index),
    canRunNow: true,
    canRetry: true,
    ...overrides,
  }
}

/** Echoes the key and its params, so a test can pin the exact message without the catalog. */
export function fakeT(key: string, params?: Record<string, unknown>): string {
  return params ? `${key}${JSON.stringify(params)}` : key
}
