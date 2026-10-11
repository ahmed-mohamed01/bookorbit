import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSyncChain, type SyncChainSnapshot } from '../sync-chain'
import { chainViewItems, chainViewSegments, groupChromeClass, transitionView, viewTransitionName } from '../sync-chain-view'

type FakeTransition = { updateCallbackDone: Promise<void>; ready: Promise<void>; finished: Promise<void>; skipTransition: () => void }

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
  },
  readAloudIssue: null,
  abs: {
    configured: true,
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
    expect(items.map((item) => item.kind)).toEqual(['card', 'connector', 'card', 'connector', 'card', 'connector', 'readAlongSlot'])
    expect(items.map((item) => item.frame)).toEqual(['spine', 'spine', 'group', 'group', 'group', 'spine', 'spine'])
  })

  it('swaps the slot being changed for its search, by kind', () => {
    expect(chainViewItems(rows, 'audiobook').find((item) => item.id === 'card:audiobook')).toMatchObject({ kind: 'cardSearch', format: 'audiobook' })
    expect(chainViewItems(rows, 'abs').find((item) => item.id === 'card:abs')).toMatchObject({ kind: 'absSearch' })
    expect(chainViewItems(rows, 'audiobook').find((item) => item.id === 'card:ebook')).toMatchObject({ kind: 'card' })
  })

  it('swaps a ghost for its search too, and leaves a read-along slot alone', () => {
    const ghostRows = buildSyncChain({ ...snapshot, linked: false, audiobook: { book: null, isMember: false, isThisBook: false, match: null } }).rows
    expect(chainViewItems(ghostRows, null).find((item) => item.id === 'card:audiobook')).toMatchObject({ kind: 'ghost' })
    expect(chainViewItems(ghostRows, 'audiobook').find((item) => item.id === 'card:audiobook')).toMatchObject({
      kind: 'cardSearch',
      format: 'audiobook',
    })
    expect(chainViewItems(rows, 'ebook').find((item) => item.id === 'slot:readAlong')).toMatchObject({ kind: 'readAlongSlot' })
  })

  it('carries the group frame of the audio rows and the spine frame of the read-along rows', () => {
    const raRows = buildSyncChain({
      ...snapshot,
      readAlong: { ...snapshot.readAlong, status: 'ready', outputBook: { id: 3, title: 'RA' } },
    }).rows
    const frames = Object.fromEntries(chainViewItems(raRows, null).map((item) => [item.id, item.frame]))
    expect(frames['connector:readAlong-audiobook']).toBe('spine')
    expect(frames['card:readAlong']).toBe('spine')
    expect(frames['card:audiobook']).toBe('group')
    expect(frames['connector:audiobook-abs']).toBe('group')
    expect(frames['card:abs']).toBe('group')
    expect(frames['card:ebook']).toBe('spine')
  })
})

describe('chainViewSegments', () => {
  it('folds the contiguous group items into one box between the spine rows', () => {
    const segments = chainViewSegments(chainViewItems(buildSyncChain(snapshot).rows, null))
    expect(segments.map((segment) => (segment.kind === 'group' ? segment.items.map((item) => item.id) : segment.item.id))).toEqual([
      'card:ebook',
      'connector:ebook-audiobook',
      ['card:audiobook', 'connector:audiobook-abs', 'card:abs'],
      'connector:readAlong-audiobook',
      'slot:readAlong',
    ])
  })

  it('keeps the audiobook alone in its box when Audiobookshelf is not configured', () => {
    const segments = chainViewSegments(chainViewItems(buildSyncChain({ ...snapshot, abs: null }).rows, null))
    const group = segments.find((segment) => segment.kind === 'group')
    expect(group?.kind === 'group' && group.items.map((item) => item.id)).toEqual(['card:audiobook'])
  })
})

describe('groupChromeClass', () => {
  const itemsFor = (overrides: Partial<SyncChainSnapshot>) => {
    const segment = chainViewSegments(chainViewItems(buildSyncChain({ ...snapshot, ...overrides }).rows, null)).find((s) => s.kind === 'group')
    return segment?.kind === 'group' ? segment.items : []
  }

  it('is primary when the audiobook is this book', () => {
    const items = itemsFor({
      thisBook: 'audiobook',
      audiobook: { ...snapshot.audiobook, isThisBook: true },
      ebook: { ...snapshot.ebook, isThisBook: false },
    })
    expect(groupChromeClass(items)).toBe('border-primary bg-card')
  })

  it('is plain for a linked member', () => {
    expect(groupChromeClass(itemsFor({}))).toBe('border-border bg-card')
  })

  it('is dashed for a candidate and for a ghost', () => {
    const candidate = itemsFor({ linked: false, audiobook: { ...snapshot.audiobook, isMember: false, match: { source: 'manual' } } })
    expect(groupChromeClass(candidate)).toBe('border-dashed border-border bg-transparent')
    const ghost = itemsFor({ audiobook: { book: null, isMember: false, isThisBook: false, match: null } })
    expect(groupChromeClass(ghost)).toBe('border-dashed border-border bg-transparent')
  })
})

describe('viewTransitionName', () => {
  it('turns a row id into a CSS identifier', () => {
    expect(viewTransitionName('connector:readAlong-audiobook')).toBe('sync-chain-connector-readAlong-audiobook')
    expect(viewTransitionName('slot:readAlong')).toBe('sync-chain-slot-readAlong')
  })
})

describe('transitionView', () => {
  afterEach(() => {
    delete (document as { startViewTransition?: unknown }).startViewTransition
    vi.unstubAllGlobals()
  })

  it('applies the change directly when the browser has no view transitions', async () => {
    const order: string[] = []
    await transitionView(
      () => order.push('apply'),
      async () => {
        order.push('flush')
      },
    )
    expect(order).toEqual(['apply', 'flush'])
  })

  it('runs the change inside a view transition and resolves once the DOM is updated', async () => {
    const order: string[] = []
    const start = vi.fn<(update: () => Promise<void>) => FakeTransition>((update) => {
      order.push('start')
      const updateCallbackDone = update()
      return { updateCallbackDone, ready: updateCallbackDone, finished: updateCallbackDone, skipTransition: () => {} }
    })
    Object.defineProperty(document, 'startViewTransition', { value: start, configurable: true, writable: true })

    await transitionView(
      () => order.push('apply'),
      async () => {
        order.push('flush')
      },
    )
    expect(order).toEqual(['start', 'apply', 'flush'])
  })

  it('skips the view transition when the viewer prefers reduced motion', async () => {
    const start = vi.fn<(update: () => Promise<void>) => FakeTransition>()
    Object.defineProperty(document, 'startViewTransition', { value: start, configurable: true, writable: true })
    vi.stubGlobal('matchMedia', vi.fn<() => { matches: boolean }>().mockReturnValue({ matches: true }))
    const apply = vi.fn<() => void>()

    await transitionView(apply, async () => {})
    expect(start).not.toHaveBeenCalled()
    expect(apply).toHaveBeenCalledTimes(1)
  })
})
