import { describe, expect, it } from 'vitest'
import { buildSyncChain, type SyncChainSnapshot } from '../sync-chain'
import { chainViewItems } from '../sync-chain-view'

const snapshot: SyncChainSnapshot = {
  thisBook: 'ebook',
  linked: true,
  ebook: { book: { id: 1, title: 'Ebook', authorName: null, coverVersion: null, progress: 10 }, isMember: true, isThisBook: true, match: null },
  audiobook: {
    book: { id: 2, title: 'Audiobook', authorName: null, coverVersion: null, progress: 20 },
    isMember: true,
    isThisBook: false,
    match: null,
  },
  alignment: {
    status: 'ready',
    stale: false,
    builtAt: 'x',
    samplesDone: null,
    samplesTotal: null,
    buildBlocked: null,
    buildError: null,
    running: false,
  },
  readAlong: {
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
  },
  readAloudIssue: null,
  abs: {
    link: {
      audioBookId: 2,
      absLibraryItemId: 'li',
      title: null,
      authorName: null,
      libraryName: null,
      direction: 'two_way',
      syncing: true,
      pausedReason: null,
      webUrl: null,
    },
    live: null,
    checking: false,
  },
  can: { editLink: true, generate: true, rebuild: true },
}

describe('chainViewItems', () => {
  const rows = buildSyncChain(snapshot).rows

  it('keeps every row in order, keyed by its id', () => {
    const items = chainViewItems(rows, null)

    expect(items.map((item) => item.id)).toEqual(rows.map((row) => row.id))
    expect(items.map((item) => item.kind)).toEqual(['card', 'connector', 'card', 'connector', 'card', 'availableHeader', 'available'])
  })

  it('swaps the card being changed for its search, by kind', () => {
    expect(chainViewItems(rows, 'audiobook').find((item) => item.id === 'card:audiobook')).toMatchObject({ kind: 'cardSearch', format: 'audiobook' })
    expect(chainViewItems(rows, 'abs').find((item) => item.id === 'card:abs')).toMatchObject({ kind: 'absSearch' })
    expect(chainViewItems(rows, 'audiobook').find((item) => item.id === 'card:ebook')).toMatchObject({ kind: 'card' })
  })

  it('offers a search format only on ebook and audiobook rows', () => {
    expect(chainViewItems(rows, null).find((item) => item.id === 'available:readAlong')).toMatchObject({ kind: 'available', searchFormat: null })
  })
})
