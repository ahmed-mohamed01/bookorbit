import type { EditionLinkMatch, EditionLinkMatchBook, EditionLinkScanStatus, WorkForBook, WorkVariant } from '@bookorbit/types'

export function variant(overrides: Partial<WorkVariant> = {}): WorkVariant {
  return {
    bookId: 1,
    role: 'text',
    isPrimary: true,
    isThisBook: false,
    title: 'Dune',
    authorName: 'Frank Herbert',
    coverVersion: null,
    libraryId: 1,
    libraryName: 'Ebooks',
    formats: ['epub'],
    sizeBytes: 1_048_576,
    durationSeconds: null,
    progress: 40,
    progressUpdatedAt: null,
    progressSource: null,
    ...overrides,
  }
}

export function work(overrides: Partial<WorkForBook> = {}): WorkForBook {
  return {
    linkId: 5,
    canonicalBookId: 2,
    variants: [
      variant({ bookId: 1, isThisBook: true }),
      variant({
        bookId: 2,
        role: 'audio',
        libraryId: 2,
        libraryName: 'Audiobooks',
        formats: ['m4b'],
        sizeBytes: null,
        durationSeconds: 7200,
        progress: 42,
        progressSource: 'mirror',
      }),
    ],
    sharedState: true,
    inSync: true,
    canGenerateReadAlong: false,
    ...overrides,
  }
}

export function matchBook(overrides: Partial<EditionLinkMatchBook> = {}): EditionLinkMatchBook {
  return {
    id: 1,
    title: 'Dune',
    authorName: 'Frank Herbert',
    coverVersion: null,
    libraryId: 1,
    libraryName: 'Ebooks',
    formats: ['epub'],
    role: 'text',
    seriesName: null,
    seriesIndex: null,
    isbn: null,
    readStatus: null,
    progress: null,
    ...overrides,
  }
}

export function match(overrides: Partial<EditionLinkMatch> = {}): EditionLinkMatch {
  return {
    id: 10,
    bucket: 'strong',
    score: 0.95,
    titleScore: 0.95,
    authorScore: 1,
    isbnMatch: false,
    reason: 'title 0.95 author 1',
    source: matchBook(),
    target: matchBook({ id: 2, role: 'audio', libraryId: 2, libraryName: 'Audiobooks', formats: ['m4b'] }),
    targetRole: 'audio',
    linkId: null,
    proposedAction: 'link',
    competingBookIds: [],
    ...overrides,
  }
}

export function scanStatus(overrides: Partial<EditionLinkScanStatus> = {}): EditionLinkScanStatus {
  return {
    state: 'done',
    scanId: 3,
    processed: 10,
    total: 10,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    error: null,
    counts: { linked_ok: 4, linked_suspect: 2, conflict: 1, strong: 5, weak: 8 },
    dismissed: 1,
    autoLinked: 0,
    ...overrides,
  }
}
