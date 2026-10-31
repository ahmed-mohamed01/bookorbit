import type { AudiobookshelfBookSyncLink, AudiobookshelfBookSyncLive, ReadAloudProgressSync } from '@bookorbit/types'
import {
  buildSyncChain,
  type ChainCardRow,
  type ChainConnectorRow,
  type ChainGhostRow,
  type ChainReadAloudSlotRow,
  type ConnectorKey,
  type EditionKey,
  type SyncChain,
  type SyncChainAbs,
  type SyncChainAlignment,
  type SyncChainEdition,
  type SyncChainReadAloud,
  type SyncChainReadAloudJob,
  type SyncChainReadAloudSlot,
  type SyncChainSnapshot,
} from '../sync-chain'

export function chainEdition(overrides: Partial<SyncChainEdition> = {}): SyncChainEdition {
  return { title: 'Book', formatName: 'EPUB e-book', fileCount: 1, sizeBytes: 1024, progress: null, ...overrides }
}

export function chainAlignment(overrides: Partial<SyncChainAlignment> = {}): SyncChainAlignment {
  return {
    status: 'ready',
    stale: false,
    builtAt: '2026-10-01T00:00:00Z',
    samplesDone: null,
    samplesTotal: null,
    buildBlocked: null,
    buildError: null,
    running: false,
    ...overrides,
  }
}

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

export function chainReadAloud(overrides: Partial<ReadAloudProgressSync> = {}): SyncChainReadAloud {
  return { sync: readAloudSync(overrides), audioDuration: '1h 0m', overlayDuration: '1h 0m' }
}

/** Upstream's generator with nothing to offer: no slot unless a test says otherwise. */
export function chainReadAloudSlot(overrides: Partial<SyncChainReadAloudSlot> = {}): SyncChainReadAloudSlot {
  return { entry: { kind: 'hidden' }, job: null, pending: null, errorKey: null, ...overrides }
}

export function chainReadAloudJob(overrides: Partial<SyncChainReadAloudJob> = {}): SyncChainReadAloudJob {
  return {
    status: 'processing',
    stage: 'aligning',
    progress: 42.4,
    queuePosition: null,
    stopping: false,
    canCancel: true,
    canRetry: true,
    errorKey: null,
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

export function chainAbs(
  link: Partial<AudiobookshelfBookSyncLink> = {},
  live: AudiobookshelfBookSyncLive | null = absLive(),
  checking = false,
): SyncChainAbs {
  return { configured: true, link: absLink(link), live, checking }
}

/** A book holding a plain EPUB and its audiobook, aligned, with no read-along and no Audiobookshelf. */
export function chainSnapshot(overrides: Partial<SyncChainSnapshot> = {}): SyncChainSnapshot {
  return {
    bookId: 7,
    coverVersion: 'v7',
    ebook: chainEdition({ title: 'Book', progress: 41 }),
    audiobook: chainEdition({ title: 'Book', formatName: 'M4B audiobook', progress: 63 }),
    readAlong: null,
    readAloudSlot: chainReadAloudSlot(),
    alignment: chainAlignment(),
    readAloud: chainReadAloud({ state: 'unavailable', unavailableReason: 'no_media_overlay_epub', overlayFileId: null }),
    abs: null,
    can: { align: true },
    ...overrides,
  }
}

export function chainOf(overrides: Partial<SyncChainSnapshot> = {}): SyncChain {
  return buildSyncChain(chainSnapshot(overrides))
}

export function cardRow(chain: SyncChain, edition: EditionKey): ChainCardRow {
  const row = chain.rows.find((r): r is ChainCardRow => r.kind === 'card' && r.edition === edition)
  if (!row) throw new Error(`no ${edition} card`)
  return row
}

export function connectorRow(chain: SyncChain, key: ConnectorKey): ChainConnectorRow {
  const row = chain.rows.find((r): r is ChainConnectorRow => r.kind === 'connector' && r.key === key)
  if (!row) throw new Error(`no ${key} connector`)
  return row
}

export function ghostRow(chain: SyncChain, edition: EditionKey): ChainGhostRow {
  const row = chain.rows.find((r): r is ChainGhostRow => r.kind === 'ghost' && r.edition === edition)
  if (!row) throw new Error(`no ${edition} ghost`)
  return row
}

export function readAloudSlotRow(chain: SyncChain): ChainReadAloudSlotRow {
  const row = chain.rows.find((r): r is ChainReadAloudSlotRow => r.kind === 'readAloudSlot')
  if (!row) throw new Error('no read-aloud slot')
  return row
}
