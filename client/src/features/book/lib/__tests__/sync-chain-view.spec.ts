import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSyncChain, type SyncChainSnapshot } from '../sync-chain'
import { chainViewItems, chainViewSegments, groupChromeClass, segmentNeedsGap, transitionView, viewTransitionName } from '../sync-chain-view'
import { chainAbs, chainReadAloudSlot, chainSnapshot } from './sync-chain-fixtures'

type FakeTransition = { updateCallbackDone: Promise<void>; ready: Promise<void>; finished: Promise<void>; skipTransition: () => void }

const snapshot: SyncChainSnapshot = chainSnapshot({ abs: chainAbs() })

describe('chainViewItems', () => {
  const rows = buildSyncChain(snapshot).rows

  it('keeps every row in order, keyed by its id', () => {
    const items = chainViewItems(rows, null)

    expect(items.map((item) => item.id)).toEqual(rows.map((row) => row.id))
    expect(items.map((item) => item.kind)).toEqual(['card', 'connector', 'card', 'connector', 'card'])
    expect(items.map((item) => item.frame)).toEqual(['spine', 'spine', 'group', 'group', 'group'])
  })

  it('swaps only the Audiobookshelf slot for its search', () => {
    expect(chainViewItems(rows, 'abs').find((item) => item.id === 'card:abs')).toMatchObject({ kind: 'absSearch' })
    expect(chainViewItems(rows, 'audiobook').find((item) => item.id === 'card:audiobook')).toMatchObject({ kind: 'card' })
  })

  it('passes the read-aloud slot through as its own kind on the spine', () => {
    const slotRows = buildSyncChain({ ...snapshot, readAloudSlot: chainReadAloudSlot({ entry: { kind: 'available' } }) }).rows
    expect(chainViewItems(slotRows, null).at(-1)).toMatchObject({ kind: 'readAloudSlot', id: 'slot:readAlong', frame: 'spine' })
  })

  it('swaps the Audiobookshelf ghost for its search too', () => {
    const ghostRows = buildSyncChain({ ...snapshot, abs: { configured: true, link: null, live: null, checking: false } }).rows
    expect(chainViewItems(ghostRows, null).find((item) => item.id === 'card:abs')).toMatchObject({ kind: 'ghost' })
    expect(chainViewItems(ghostRows, 'abs').find((item) => item.id === 'card:abs')).toMatchObject({ kind: 'absSearch' })
  })
})

describe('chainViewSegments', () => {
  it('folds the contiguous group items into one box between the spine rows', () => {
    const segments = chainViewSegments(chainViewItems(buildSyncChain(snapshot).rows, null))
    expect(segments.map((segment) => (segment.kind === 'group' ? segment.items.map((item) => item.id) : segment.item.id))).toEqual([
      'card:ebook',
      'connector:ebook-audiobook',
      ['card:audiobook', 'connector:audiobook-abs', 'card:abs'],
    ])
  })

  it('keeps the audiobook alone in its box when Audiobookshelf is not configured', () => {
    const segments = chainViewSegments(chainViewItems(buildSyncChain({ ...snapshot, abs: null }).rows, null))
    const group = segments.find((segment) => segment.kind === 'group')
    expect(group?.kind === 'group' && group.items.map((item) => item.id)).toEqual(['card:audiobook'])
  })
})

describe('segmentNeedsGap', () => {
  it('spaces two slots that have no connector between them and nothing else', () => {
    const joined = chainViewSegments(chainViewItems(buildSyncChain(snapshot).rows, null))
    expect(joined.map((_, index) => segmentNeedsGap(joined, index))).toEqual([false, false, false])
    const withSlot = buildSyncChain({ ...snapshot, readAloudSlot: chainReadAloudSlot({ entry: { kind: 'available' } }) }).rows
    const apart = chainViewSegments(
      chainViewItems(
        withSlot.filter((row) => row.kind !== 'connector' || row.key !== 'readAlong-audiobook'),
        null,
      ),
    )
    expect(apart.map((_, index) => segmentNeedsGap(apart, index))).toEqual([false, false, false, true])
  })
})

describe('groupChromeClass', () => {
  it('is plain for the book’s audiobook', () => {
    const segment = chainViewSegments(chainViewItems(buildSyncChain(snapshot).rows, null)).find((s) => s.kind === 'group')
    expect(groupChromeClass(segment?.kind === 'group' ? segment.items : [])).toBe('border-border bg-card')
  })

  it('is dashed for an empty box', () => {
    expect(groupChromeClass([])).toBe('border-dashed border-border bg-transparent')
  })
})

describe('viewTransitionName', () => {
  it('turns a row id into a CSS identifier', () => {
    expect(viewTransitionName('connector:readAlong-audiobook')).toBe('sync-chain-connector-readAlong-audiobook')
    expect(viewTransitionName('card:readAlong')).toBe('sync-chain-card-readAlong')
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
