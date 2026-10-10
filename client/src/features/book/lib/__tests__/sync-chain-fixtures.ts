import type { AudiobookshelfBookSyncLink, AudiobookshelfBookSyncLive, EditionLinkMember } from '@bookorbit/types'
import {
  buildSyncChain,
  type ChainAvailableRow,
  type ChainCardRow,
  type ChainConnectorRow,
  type ConnectorKey,
  type EditionKey,
  type SyncChain,
  type SyncChainAbs,
  type SyncChainAlignment,
  type SyncChainBook,
  type SyncChainReadAlong,
  type SyncChainSide,
  type SyncChainSnapshot,
} from '../sync-chain'

export function chainBook(id: number, title: string | null, progress: number | null = null): SyncChainBook {
  return { id, title, authorName: `Author ${id}`, coverVersion: `v${id}`, progress }
}

export function chainMember(id: number, title: string): EditionLinkMember {
  return { id, title, authorName: 'Narrator', coverVersion: 'rv', progress: { percentage: 41, updatedAt: '2026-10-01' }, narrationPercentage: null }
}

export function chainSide(overrides: Partial<SyncChainSide> = {}): SyncChainSide {
  return { book: null, isMember: false, isThisBook: false, match: null, ...overrides }
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

export function chainReadAlong(overrides: Partial<SyncChainReadAlong> = {}): SyncChainReadAlong {
  return {
    member: null,
    status: 'none',
    blocked: null,
    phase: null,
    remoteTask: null,
    remoteProgress: null,
    queuePosition: null,
    outputBook: null,
    thisBook: null,
    error: null,
    mutating: false,
    memberPending: false,
    targetLibraryName: null,
    ...overrides,
  }
}

export function absLink(overrides: Partial<AudiobookshelfBookSyncLink> = {}): AudiobookshelfBookSyncLink {
  return {
    audioBookId: 2,
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
  return { link: absLink(link), live, checking }
}

/** Ebook page, ebook and audiobook linked and aligned, no read-along, no Audiobookshelf. */
export function chainSnapshot(overrides: Partial<SyncChainSnapshot> = {}): SyncChainSnapshot {
  return {
    thisBook: 'ebook',
    linked: true,
    ebook: chainSide({ book: chainBook(1, 'Ebook', 41), isMember: true, isThisBook: true }),
    audiobook: chainSide({ book: chainBook(2, 'Audiobook', 63), isMember: true }),
    alignment: chainAlignment(),
    readAlong: chainReadAlong(),
    readAloudIssue: null,
    abs: null,
    can: { editLink: true, generate: true, rebuild: true },
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

export function availableRow(chain: SyncChain, edition: EditionKey): ChainAvailableRow {
  const row = chain.rows.find((r): r is ChainAvailableRow => r.kind === 'available' && r.edition === edition)
  if (!row) throw new Error(`no ${edition} row`)
  return row
}
