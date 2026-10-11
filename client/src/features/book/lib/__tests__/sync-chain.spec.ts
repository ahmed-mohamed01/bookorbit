// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ReadAloudProgressSync } from '@bookorbit/types'
import {
  absLive,
  cardRow as cardOf,
  chainAbs as abs,
  chainAlignment as alignment,
  chainBook as book,
  chainMember as member,
  chainReadAlong as readAlong,
  chainSide as side,
  chainSnapshot as snapshot,
  connectorRow as connectorOf,
  ghostRow as ghostOf,
  slotRow as slotOf,
} from './sync-chain-fixtures'
import { availableHeightFromTrigger, buildSyncChain, initialViewMode, type SyncChain, type SyncChainSnapshot } from '../sync-chain'

const C = 'book.detail.editionLink.chain.'

const fullChain = (overrides: Partial<SyncChainSnapshot> = {}) =>
  snapshot({
    readAlong: readAlong({ member: member(3, 'Read-along'), status: 'ready', outputBook: { id: 3, title: 'Read-along' } }),
    abs: abs(),
    ...overrides,
  })

const noAbsMatch = { configured: true, link: null, live: null, checking: false }

/** The Modify estimate, read back as the smallest space in which `initialViewMode` still picks Modify. */
const modifyHeight = (chain: SyncChain) => {
  const calm = { ...chain, needsAttention: false }
  let low = 0
  let high = 10_000
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (initialViewMode(calm, mid) === 'modify') high = mid
    else low = mid + 1
  }
  return low
}

const ids = (chain: SyncChain) => chain.rows.map((row) => row.id)
const hasSlot = (chain: SyncChain) => chain.rows.some((row) => row.kind === 'readAlongSlot')
const cardCount = (chain: SyncChain) => chain.rows.filter((row) => row.kind === 'card').length

describe('buildSyncChain boards', () => {
  it('A: every edition linked from the ebook page', () => {
    const chain = buildSyncChain(fullChain())

    expect(ids(chain)).toEqual([
      'card:ebook',
      'connector:ebook-audiobook',
      'card:audiobook',
      'connector:audiobook-abs',
      'card:abs',
      'connector:readAlong-audiobook',
      'card:readAlong',
    ])
    expect(connectorOf(chain, 'ebook-audiobook')).toMatchObject({
      frame: 'spine',
      state: 'linkedViaWhisper',
      tone: 'success',
      arrow: 'both',
      pill: { key: `${C}pill.linkedViaWhisper` },
      qualifier: { key: `${C}qualifier.viaWhisper` },
      explainer: { key: `${C}explain.whisper` },
      switch: { on: true, disabled: false, offTarget: 'pair' },
      disabledReason: null,
      dashed: false,
    })
    expect(connectorOf(chain, 'readAlong-audiobook')).toMatchObject({
      frame: 'spine',
      state: 'linked',
      qualifier: { key: `${C}qualifier.direct` },
      explainer: { key: `${C}explain.readAlongAudio` },
      switch: { on: true, offTarget: 'readAlong' },
    })
    expect(connectorOf(chain, 'audiobook-abs')).toMatchObject({
      frame: 'group',
      state: 'absLinked',
      absDetails: true,
      switch: { on: true, offTarget: 'abs' },
    })
    expect(chain.header).toEqual({ tone: 'success', label: { key: `${C}header.inSync`, params: { n: 4, m: 4 } } })
    expect(chain.intro).toEqual({ key: `${C}intro.linked` })
    expect(chain.needsAttention).toBe(false)
    expect(cardOf(chain, 'ebook')).toMatchObject({
      frame: 'spine',
      linked: true,
      chip: null,
      isThisBook: true,
      routeBookId: null,
      change: 'none',
      progress: 41,
    })
    expect(cardOf(chain, 'audiobook')).toMatchObject({ linked: true, chip: null, change: 'blocked' })
    expect(cardOf(chain, 'readAlong')).toMatchObject({
      frame: 'spine',
      linked: true,
      chip: null,
      cover: { kind: 'book', bookId: 3, coverVersion: 'rv' },
      routeBookId: 3,
      progress: 41,
      change: 'none',
      rebuild: { id: 'rebuildReadAlong', label: { key: 'book.detail.editionLink.actions.rebuild' }, disabled: false },
    })
    expect(cardOf(chain, 'abs')).toMatchObject({
      linked: true,
      chip: null,
      external: true,
      cover: { kind: 'abs', absLibraryItemId: 'li_1' },
      subtitle: 'Fiction',
      href: 'https://abs.example/item/li_1',
      routeBookId: null,
      progress: 52,
      change: 'available',
      confirm: null,
    })
    const connectors = chain.rows.filter((row) => row.kind === 'connector')
    expect(connectors.map((row) => row.mini.text)).toEqual([null, { key: `${C}mini.syncedWithAbs` }, null])
  })

  it('A: the audiobook and Audiobookshelf rows share the group frame and everything else is spine', () => {
    const chain = buildSyncChain(fullChain())
    const frames = Object.fromEntries(chain.rows.map((row) => [row.id, 'frame' in row ? row.frame : 'spine']))
    expect(frames).toEqual({
      'card:ebook': 'spine',
      'connector:ebook-audiobook': 'spine',
      'card:audiobook': 'group',
      'connector:audiobook-abs': 'group',
      'card:abs': 'group',
      'connector:readAlong-audiobook': 'spine',
      'card:readAlong': 'spine',
    })
    expect(chain).not.toHaveProperty('branchRail')
  })

  it('A: an unreachable Audiobookshelf link keeps its warning mini text and not the synced line', () => {
    const chain = buildSyncChain(snapshot({ abs: abs({}, absLive({ status: 'unreachable' })) }))
    expect(connectorOf(chain, 'audiobook-abs').mini.text).toEqual({ key: `${C}mini.cantReach` })
  })

  it('A: the inner Audiobookshelf connector says synced for every syncing state and never while it warns', () => {
    const miniKey = (snap: SyncChainSnapshot) => connectorOf(buildSyncChain(snap), 'audiobook-abs').mini.text?.key ?? null
    const synced = `${C}mini.syncedWithAbs`
    expect(miniKey(snapshot({ abs: abs() }))).toBe(synced)
    expect(miniKey(snapshot({ abs: abs({ direction: 'from_abs' }) }))).toBe(synced)
    expect(miniKey(snapshot({ abs: abs({}, absLive({ status: 'receiving' })) }))).toBe(synced)
    expect(miniKey(snapshot({ abs: abs({}, absLive({ status: 'sending' })) }))).toBe(synced)
    expect(miniKey(snapshot({ abs: abs({}, absLive({ status: 'unreachable' })) }))).not.toBe(synced)
    expect(miniKey(snapshot({ abs: abs({}, absLive({ status: 'diverged' })) }))).not.toBe(synced)
  })

  it('A: an audiobook ghost and the Audiobookshelf ghost stay in the group frame', () => {
    const chain = buildSyncChain(snapshot({ audiobook: side(), abs: abs() }))
    expect(ghostOf(chain, 'audiobook').frame).toBe('group')
    expect(ghostOf(chain, 'abs').frame).toBe('group')
    expect(connectorOf(chain, 'audiobook-abs').frame).toBe('group')
  })

  it('F: the un-generated slot hangs off a muted connector without a switch', () => {
    const chain = buildSyncChain(snapshot())
    expect(connectorOf(chain, 'readAlong-audiobook')).toMatchObject({
      frame: 'spine',
      state: 'available',
      tone: 'muted',
      dashed: true,
      pill: { key: `${C}off.notGenerated` },
      qualifier: { key: `${C}off.notGenerated` },
      explainer: null,
      switch: null,
      actions: [],
      cancel: null,
      mini: { text: null, action: null },
    })
    expect(chain.rows.at(-1)?.kind).toBe('readAlongSlot')
  })

  it('F: no slot connector when the slot is hidden', () => {
    const chain = buildSyncChain(snapshot({ readAlong: readAlong({ blocked: 'not_configured' as const }) }))
    expect(ids(chain)).not.toContain('connector:readAlong-audiobook')
  })

  describe('row order', () => {
    const audiobookPage = (overrides: Partial<SyncChainSnapshot> = {}) =>
      fullChain({
        thisBook: 'audiobook',
        ebook: side({ book: book(1, 'Ebook'), isMember: true }),
        audiobook: side({ book: book(2, 'Audiobook'), isMember: true, isThisBook: true }),
        ...overrides,
      })
    const readAlongPage = (overrides: Partial<SyncChainSnapshot> = {}) =>
      fullChain({
        thisBook: 'readAlong',
        ebook: side({ book: book(1, 'Ebook'), isMember: true }),
        readAlong: readAlong({ member: member(3, 'Read-along'), status: 'ready', thisBook: book(3, 'Read-along') }),
        ...overrides,
      })
    const order = (snap: SyncChainSnapshot) => ids(buildSyncChain(snap))
    const audioGroup = ['card:audiobook', 'connector:audiobook-abs', 'card:abs']
    const ebookRows = ['connector:ebook-audiobook', 'card:ebook']
    const readAlongRows = ['connector:readAlong-audiobook', 'card:readAlong']

    it('leads with the ebook on its own page', () => {
      expect(order(fullChain())).toEqual(['card:ebook', 'connector:ebook-audiobook', ...audioGroup, ...readAlongRows])
    })

    it('leads with the audiobook group on the audiobook page and keeps the read-along last', () => {
      expect(order(audiobookPage())).toEqual([...audioGroup, ...ebookRows, ...readAlongRows])
      expect(order(audiobookPage({ readAlong: readAlong() }))).toEqual([
        ...audioGroup,
        ...ebookRows,
        'connector:readAlong-audiobook',
        'slot:readAlong',
      ])
      expect(order(audiobookPage({ readAlong: readAlong({ status: 'ready' }) }))).toEqual([...audioGroup, ...ebookRows, ...readAlongRows])
      expect(order(audiobookPage({ abs: null }))).toEqual(['card:audiobook', ...ebookRows, ...readAlongRows])
    })

    it('leads with the read-along on its own page, then the audio group, then the ebook', () => {
      expect(order(readAlongPage())).toEqual(['card:readAlong', 'connector:readAlong-audiobook', ...audioGroup, ...ebookRows])
      expect(order(readAlongPage({ abs: null }))).toEqual(['card:readAlong', 'connector:readAlong-audiobook', 'card:audiobook', ...ebookRows])
    })

    it('keeps the order for a link with no ebook on the audiobook and read-along pages', () => {
      const noText = { ebook: side() }
      expect(order(audiobookPage(noText))).toEqual([...audioGroup, ...ebookRows, ...readAlongRows])
      expect(order(readAlongPage(noText))).toEqual(['card:readAlong', 'connector:readAlong-audiobook', ...audioGroup, ...ebookRows])
    })

    it('keeps the order for an unlinked page that only sees the members on the audiobook and read-along pages', () => {
      const membersOnly = {
        linked: false,
        ebook: side({ book: book(1, 'Ebook'), match: { source: 'pair' as const } }),
        alignment: alignment({ status: 'none', builtAt: null }),
      }
      expect(order(audiobookPage(membersOnly))).toEqual([...audioGroup, ...ebookRows, ...readAlongRows])
      expect(order(readAlongPage({ ...membersOnly, audiobook: side({ book: book(2, 'Audiobook'), match: { source: 'pair' } }) }))).toEqual([
        'card:readAlong',
        'connector:readAlong-audiobook',
        ...audioGroup,
        ...ebookRows,
      ])
    })
  })

  it('B: the full chain opens compact when Modify does not fit', () => {
    const chain = buildSyncChain(fullChain())
    expect(initialViewMode(chain, 400)).toBe('compact')
    expect(initialViewMode(chain, 2000)).toBe('modify')
  })

  it('C: every success connector carries an explainer for the chevron', () => {
    const chain = buildSyncChain(fullChain())
    expect(chain.rows.filter((row) => row.kind === 'connector').map((row) => row.explainer?.key)).toEqual([
      `${C}explain.whisper`,
      `${C}explain.absTwoWay`,
      `${C}explain.readAlongAudio`,
    ])
  })

  it('D: from the read-along page the same rows read through the pair', () => {
    const chain = buildSyncChain(fullChain({ thisBook: 'readAlong', ebook: side({ book: book(1, 'Ebook'), isMember: true }) }))

    expect(ids(chain)).toEqual([
      'card:readAlong',
      'connector:readAlong-audiobook',
      'card:audiobook',
      'connector:audiobook-abs',
      'card:abs',
      'connector:ebook-audiobook',
      'card:ebook',
    ])
    expect(cardOf(chain, 'readAlong')).toMatchObject({ isThisBook: true, routeBookId: null, linked: true })
    expect(cardOf(chain, 'ebook')).toMatchObject({ routeBookId: 1, isThisBook: false })
    expect(connectorOf(chain, 'ebook-audiobook').switch?.offTarget).toBe('pair')
    expect(connectorOf(chain, 'readAlong-audiobook').switch?.offTarget).toBe('readAlong')
    expect(connectorOf(chain, 'audiobook-abs').switch?.offTarget).toBe('abs')
    expect(hasSlot(chain)).toBe(false)
  })

  it('E: linking the pair while Audiobookshelf is already syncing', () => {
    const chain = buildSyncChain(
      snapshot({ alignment: alignment({ status: 'none', builtAt: null, running: true, samplesDone: 3, samplesTotal: 12 }), abs: abs() }),
    )

    expect(ids(chain)).toEqual([
      'card:ebook',
      'connector:ebook-audiobook',
      'card:audiobook',
      'connector:audiobook-abs',
      'card:abs',
      'connector:readAlong-audiobook',
      'slot:readAlong',
    ])
    expect(connectorOf(chain, 'ebook-audiobook')).toMatchObject({
      state: 'linking',
      tone: 'info',
      icon: 'spinner',
      note: { key: `${C}note.linking` },
      cancel: { id: 'cancelLinking', label: { key: `${C}cancelLinking` } },
      ticks: { samplesDone: 3, samplesTotal: 12 },
      switch: { on: true },
      mini: { text: { key: `${C}mini.linking` }, action: null },
    })
    expect(chain.header).toEqual({ tone: 'info', label: { key: `${C}header.linking` } })
    expect(chain.needsAttention).toBe(false)
  })

  it('F: ebook and audiobook linked, the read-along waits in the bottom slot, no Audiobookshelf rows', () => {
    const chain = buildSyncChain(snapshot())

    expect(ids(chain)).toEqual(['card:ebook', 'connector:ebook-audiobook', 'card:audiobook', 'connector:readAlong-audiobook', 'slot:readAlong'])
    expect(slotOf(chain)).toMatchObject({
      variant: 'notGenerated',
      label: { key: `${C}short.readAlong` },
      note: { key: `${C}slot.notGenerated` },
      action: { id: 'openGenerate', label: { key: `${C}action.generate` }, disabled: false },
      expandable: true,
      cancel: null,
      job: null,
    })
    expect(chain.header.label).toEqual({ key: `${C}header.inSync`, params: { n: 2, m: 2 } })
    expect(cardOf(chain, 'audiobook').change).toBe('available')
  })

  it('G: audiobook page with Audiobookshelf, the ebook match and the generated read-along wait unlinked behind their switches', () => {
    const chain = buildSyncChain(
      snapshot({
        thisBook: 'audiobook',
        linked: false,
        ebook: side({ book: book(1, 'Ebook'), match: { source: 'auto', score: 100 } }),
        audiobook: side({ book: book(2, 'Audiobook'), isThisBook: true }),
        alignment: alignment({ status: 'none', builtAt: null }),
        readAlong: readAlong({ status: 'ready', outputBook: { id: 3, title: 'Generated' } }),
        abs: abs(),
      }),
    )

    expect(ids(chain)).toEqual([
      'card:audiobook',
      'connector:audiobook-abs',
      'card:abs',
      'connector:ebook-audiobook',
      'card:ebook',
      'connector:readAlong-audiobook',
      'card:readAlong',
    ])
    expect(cardOf(chain, 'ebook')).toMatchObject({
      linked: false,
      chip: { key: `${C}chip.match`, params: { score: 100 } },
      change: 'available',
      routeBookId: 1,
    })
    expect(cardOf(chain, 'audiobook')).toMatchObject({ linked: true, isThisBook: true })
    expect(cardOf(chain, 'readAlong')).toMatchObject({
      linked: false,
      frame: 'spine',
      chip: { key: `${C}chip.generated` },
      cover: { kind: 'book', bookId: 3 },
      change: 'none',
    })
    expect(connectorOf(chain, 'ebook-audiobook')).toMatchObject({
      state: 'available',
      tone: 'muted',
      arrow: 'both',
      frame: 'spine',
      qualifier: { key: `${C}off.notLinked` },
      switch: { on: false, disabled: false, onAction: 'linkPair', offTarget: null },
      disabledReason: null,
      mini: { text: { key: `${C}off.notLinked` }, action: null },
    })
    expect(connectorOf(chain, 'readAlong-audiobook')).toMatchObject({
      frame: 'spine',
      state: 'available',
      qualifier: { key: `${C}off.notLinked` },
      switch: { on: false, disabled: false, onAction: 'attachReadAlong' },
      disabledReason: null,
    })
    expect(connectorOf(chain, 'audiobook-abs').state).toBe('absLinked')
    expect(chain.header).toEqual({ tone: 'success', label: { key: `${C}header.inSync`, params: { n: 2, m: 4 } } })
    expect(hasSlot(chain)).toBe(false)
  })

  it('C3: a candidate that came from a build shows Selected, never a score', () => {
    const chain = buildSyncChain(
      snapshot({
        linked: false,
        ebook: side({ book: book(1, 'E'), isThisBook: true }),
        audiobook: side({ book: book(2, 'A'), match: { source: 'build' } }),
      }),
    )
    expect(cardOf(chain, 'audiobook').chip).toEqual({ key: `${C}chip.selected` })
  })

  it('G: the read-along switch turns on once the pair is linked', () => {
    const chain = buildSyncChain(snapshot({ readAlong: readAlong({ status: 'ready', outputBook: { id: 3, title: 'Generated' } }) }))

    expect(cardOf(chain, 'readAlong')).toMatchObject({ linked: false, chip: { key: `${C}chip.generated` } })
    expect(connectorOf(chain, 'readAlong-audiobook')).toMatchObject({
      qualifier: { key: `${C}off.notLinked` },
      switch: { on: false, disabled: false, onAction: 'attachReadAlong' },
      disabledReason: null,
    })
    expect(cardCount(chain)).toBe(3)
    expect(chain.header.label.params).toEqual({ n: 2, m: 3 })
  })

  it('H: no ebook known, the audiobook waits on a pick and the read-along slot says so', () => {
    const chain = buildSyncChain(
      snapshot({
        thisBook: 'audiobook',
        linked: false,
        ebook: side(),
        audiobook: side({ book: book(2, 'Audiobook'), isThisBook: true }),
        alignment: alignment({ status: 'none', builtAt: null }),
        abs: abs(),
      }),
    )

    expect(ids(chain)).toEqual([
      'card:audiobook',
      'connector:audiobook-abs',
      'card:abs',
      'connector:ebook-audiobook',
      'card:ebook',
      'connector:readAlong-audiobook',
      'slot:readAlong',
    ])
    expect(ghostOf(chain, 'ebook')).toMatchObject({
      frame: 'spine',
      label: { key: `${C}short.ebook` },
      note: { key: `${C}ghost.noMatchEbook` },
      action: { id: 'change', label: { key: `${C}action.search` }, disabled: false },
      settingsLink: false,
    })
    expect(connectorOf(chain, 'ebook-audiobook')).toMatchObject({
      switch: { on: false, disabled: true, onAction: 'linkPair' },
      disabledReason: { key: `${C}disabled.nothingToLink` },
    })
    expect(slotOf(chain)).toMatchObject({
      variant: 'needsEbook',
      note: { key: `${C}slot.needsEbook` },
      action: { id: 'openGenerate', disabled: true },
      expandable: false,
    })
    expect(chain.header.label.params).toEqual({ n: 2, m: 2 })
  })

  it('I: a read-along building shows its stepper in the bottom slot', () => {
    const chain = buildSyncChain(
      snapshot({ readAlong: readAlong({ status: 'building', phase: 'wait', remoteTask: 'SYNC_CHAPTERS', remoteProgress: 0.4 }), abs: abs() }),
    )

    expect(slotOf(chain)).toMatchObject({
      variant: 'building',
      note: { key: `${C}slot.generating` },
      cancel: { id: 'cancelReadAlong' },
      action: null,
      job: { stage: 2, remoteProgress: 0.4, failed: false, retry: null, error: null },
    })
    expect(ids(chain)).toContain('card:abs')
    expect(cardCount(chain)).toBe(3)
    expect(chain.header.tone).toBe('info')
  })

  it('I: no cancel once Storyteller is importing', () => {
    const chain = buildSyncChain(snapshot({ readAlong: readAlong({ status: 'building', phase: 'collect' }) }))
    expect(slotOf(chain)).toMatchObject({ cancel: null, job: { stage: 3, cancel: null } })
  })

  it('J: a failed read-along offers Retry and the log in the bottom slot', () => {
    const chain = buildSyncChain(snapshot({ readAlong: readAlong({ status: 'failed', phase: 'wait', remoteTask: 'TRANSCRIBE', error: 'boom' }) }))

    expect(slotOf(chain)).toMatchObject({
      variant: 'failed',
      note: { key: `${C}slot.failed`, params: { step: 'transcribing' } },
      action: { id: 'retryReadAlong', label: { key: `${C}action.retry` }, disabled: false },
      secondary: { id: 'toggleLog', label: { key: `${C}action.viewLog` } },
      error: 'boom',
      job: null,
    })
    expect(chain.header).toEqual({ tone: 'destructive', label: { key: `${C}header.needsAttention` } })
    expect(chain.needsAttention).toBe(true)
  })

  it('K: alignment failed removes the switch and offers Retry and Unlink', () => {
    const chain = buildSyncChain(snapshot({ alignment: alignment({ status: 'failed', buildError: 'whisper crashed' }) }))
    const row = connectorOf(chain, 'ebook-audiobook')

    expect(row).toMatchObject({ state: 'alignmentFailed', tone: 'destructive', switch: null, detail: 'whisper crashed' })
    expect(row.actions.map((a) => a.id)).toEqual(['retryAlignment', 'unlinkPair'])
    expect(chain.header.tone).toBe('destructive')
    expect(slotOf(chain).variant).toBe('notGenerated')
  })

  it('L: out of date alignment and a read-along that is not syncing both ask for a rebuild', () => {
    const issue = {
      mode: 'auto',
      state: 'unavailable',
      unavailableReason: 'audio_changed',
    } as unknown as ReadAloudProgressSync
    const chain = buildSyncChain(
      fullChain({
        thisBook: 'audiobook',
        ebook: side({ book: book(1, 'E'), isMember: true }),
        audiobook: side({ book: book(2, 'A'), isMember: true, isThisBook: true }),
        alignment: alignment({ stale: true }),
        readAloudIssue: issue,
      }),
    )

    expect(connectorOf(chain, 'ebook-audiobook')).toMatchObject({
      state: 'outOfDate',
      tone: 'warning',
      icon: 'alert',
      switch: { on: true },
      actions: [{ id: 'rebuildAlignment', label: { key: `${C}action.rebuildAlignment` } }],
    })
    expect(connectorOf(chain, 'readAlong-audiobook')).toMatchObject({
      state: 'readAloudIssue',
      frame: 'spine',
      tone: 'warning',
      actions: [{ id: 'rebuildReadAlong' }],
    })
    expect(chain.header).toEqual({ tone: 'warning', label: { key: `${C}header.checkSync` } })
    expect(chain.needsAttention).toBe(true)
  })

  it('M: Audiobookshelf out of step offers both reconcile directions', () => {
    const chain = buildSyncChain(
      fullChain({ abs: abs({}, absLive({ status: 'diverged', local: { percentage: 30.2, capturedAt: 'x' }, divergedReason: 'stale' })) }),
    )
    const row = connectorOf(chain, 'audiobook-abs')

    expect(row).toMatchObject({ state: 'absDiverged', tone: 'warning', absDetails: true })
    expect(row.actions.map((a) => a.id)).toEqual(['absPush', 'absPull'])
    expect(chain.header.tone).toBe('warning')
  })

  it('O: without edit, generate or rebuild permissions every link switch is disabled and nothing offers an edit', () => {
    const can = { editLink: false, generate: false, rebuild: false }
    const chain = buildSyncChain(fullChain({ can }))

    expect(connectorOf(chain, 'ebook-audiobook').switch?.disabled).toBe(true)
    expect(connectorOf(chain, 'readAlong-audiobook').switch?.disabled).toBe(true)
    expect(connectorOf(chain, 'audiobook-abs').switch?.disabled).toBe(false)
    expect(cardOf(chain, 'audiobook').change).toBe('none')
    expect(cardOf(chain, 'readAlong').rebuild).toBeNull()

    const idle = buildSyncChain(snapshot({ can }))
    expect(hasSlot(idle)).toBe(false)
  })

  it('O: a link switch that cannot be turned on says why', () => {
    const chain = buildSyncChain(
      snapshot({
        can: { editLink: false, generate: true, rebuild: true },
        linked: false,
        ebook: side({ book: book(1, 'E'), isThisBook: true }),
        audiobook: side({ book: book(2, 'A'), match: { source: 'auto', score: 90 } }),
      }),
    )
    expect(connectorOf(chain, 'ebook-audiobook')).toMatchObject({
      switch: { on: false, disabled: true },
      disabledReason: { key: `${C}disabled.noPermission` },
    })
    expect(cardOf(chain, 'audiobook').change).toBe('none')
  })

  it('P: an ebook alone leaves an audiobook ghost, a waiting hub and everything dependent on it', () => {
    const chain = buildSyncChain(
      snapshot({
        linked: false,
        ebook: side({ book: book(1, 'E'), isThisBook: true }),
        audiobook: side(),
        alignment: alignment({ status: 'none', builtAt: null }),
        abs: noAbsMatch,
      }),
    )

    expect(ids(chain)).toEqual([
      'card:ebook',
      'connector:ebook-audiobook',
      'card:audiobook',
      'connector:audiobook-abs',
      'card:abs',
      'connector:readAlong-audiobook',
      'slot:readAlong',
    ])
    expect(ghostOf(chain, 'audiobook')).toMatchObject({
      note: { key: `${C}ghost.noMatchAudiobook` },
      action: { id: 'change', label: { key: `${C}action.search` } },
    })
    expect(ghostOf(chain, 'abs')).toMatchObject({ note: { key: `${C}ghost.absNeedsAudio` }, action: null })
    expect(connectorOf(chain, 'audiobook-abs')).toMatchObject({
      qualifier: { key: `${C}off.pickAudiobookFirst` },
      switch: { on: false, disabled: true, onAction: null },
    })
    expect(slotOf(chain)).toMatchObject({ variant: 'needsAudio', note: { key: `${C}slot.needsAudio` }, action: { disabled: true } })
    expect(chain.header).toEqual({ tone: 'muted', label: { key: `${C}header.notLinked` } })
    expect(chain.intro.key).toBe(`${C}intro.unlinked`)
    expect(cardCount(chain)).toBe(1)
  })

  it('read-along page with the link gone: the pair waits dashed and the switch relinks it', () => {
    const chain = buildSyncChain(
      snapshot({
        thisBook: 'readAlong',
        linked: false,
        ebook: side({ book: book(1, 'Ebook'), match: { source: 'pair' } }),
        audiobook: side({ book: book(2, 'Audiobook'), match: { source: 'pair' } }),
        alignment: alignment(),
        readAlong: readAlong({ status: 'ready', thisBook: book(30, 'My read-along') }),
        abs: abs(),
      }),
    )

    expect(ids(chain)).toEqual([
      'card:readAlong',
      'connector:readAlong-audiobook',
      'card:audiobook',
      'connector:audiobook-abs',
      'card:abs',
      'connector:ebook-audiobook',
      'card:ebook',
    ])
    expect(cardOf(chain, 'readAlong')).toMatchObject({
      isThisBook: true,
      linked: true,
      title: 'My read-along',
      routeBookId: null,
      cover: { kind: 'book', bookId: 30 },
    })
    expect(cardOf(chain, 'ebook')).toMatchObject({
      linked: false,
      chip: { key: `${C}chip.generatedFrom`, params: { title: 'Ebook' } },
      change: 'none',
    })
    expect(connectorOf(chain, 'ebook-audiobook').switch).toMatchObject({ on: false, disabled: false, onAction: 'linkPair' })
    expect(connectorOf(chain, 'readAlong-audiobook')).toMatchObject({
      qualifier: { key: `${C}off.notLinked` },
      switch: { disabled: false, onAction: 'attachReadAlong' },
    })
    expect(cardOf(chain, 'abs')).toMatchObject({ linked: true })
    expect(connectorOf(chain, 'audiobook-abs')).toMatchObject({ state: 'absLinked', switch: { on: true } })
    expect(chain.header).toEqual({ tone: 'success', label: { key: `${C}header.inSync`, params: { n: 2, m: 4 } } })
    expect(cardCount(chain)).toBe(4)
  })
})

describe('alignment carrier states', () => {
  it('failed: destructive, no switch, retry and unlink, build error line', () => {
    const chain = buildSyncChain(snapshot({ alignment: alignment({ status: 'failed', buildError: 'whisper crashed' }) }))
    const row = connectorOf(chain, 'ebook-audiobook')

    expect(row).toMatchObject({
      state: 'alignmentFailed',
      tone: 'destructive',
      dashed: true,
      switch: null,
      note: { key: `${C}note.alignmentFailed` },
      detail: 'whisper crashed',
      mini: { text: { key: `${C}pill.alignmentFailed` }, action: { id: 'retryAlignment' } },
    })
    expect(row.actions.map((a) => a.id)).toEqual(['retryAlignment', 'unlinkPair'])
    expect(chain.header).toEqual({ tone: 'destructive', label: { key: `${C}header.needsAttention` } })
    expect(chain.needsAttention).toBe(true)
  })

  it('stale: out of date with a forced rebuild', () => {
    const row = connectorOf(buildSyncChain(snapshot({ alignment: alignment({ stale: true }) })), 'ebook-audiobook')
    expect(row).toMatchObject({
      state: 'outOfDate',
      tone: 'warning',
      dashed: false,
      switch: { on: true },
      note: { key: `${C}note.stale` },
      actions: [{ id: 'rebuildAlignment', label: { key: `${C}action.rebuildAlignment` } }],
      mini: { action: { id: 'rebuildAlignment', label: { key: 'book.detail.editionLink.actions.rebuild' } } },
    })
  })

  it('rebuilding: cancel only stops the rebuild', () => {
    const chain = buildSyncChain(snapshot({ alignment: alignment({ status: 'building', running: true, samplesDone: 1, samplesTotal: 4 }) }))
    expect(connectorOf(chain, 'ebook-audiobook')).toMatchObject({
      state: 'rebuilding',
      cancel: { id: 'cancelAlignment', label: { key: `${C}cancelAlignment` } },
      ticks: { samplesDone: 1, samplesTotal: 4 },
      note: null,
      mini: { text: { key: `${C}mini.rebuilding` } },
    })
    expect(chain.header.tone).toBe('info')
  })

  it('not aligned while the server is busy keeps Align now', () => {
    const row = connectorOf(
      buildSyncChain(snapshot({ alignment: alignment({ status: 'none', builtAt: null, buildBlocked: 'busy' }) })),
      'ebook-audiobook',
    )
    expect(row).toMatchObject({ state: 'notAligned', note: { key: 'book.detail.readingAlignment.buildBlocked.busy' }, actions: [{ id: 'alignNow' }] })
  })

  it('unalignable: muted Can’t align', () => {
    const chain = buildSyncChain(snapshot({ alignment: alignment({ status: 'unalignable' }) }))
    expect(connectorOf(chain, 'ebook-audiobook')).toMatchObject({
      state: 'cantAlign',
      tone: 'muted',
      icon: 'ban',
      dashed: true,
      pill: { key: `${C}pill.cantAlign` },
      note: { key: 'book.detail.readingAlignment.unalignableHint' },
      actions: [],
    })
    expect(chain.header.tone).toBe('warning')
  })

  it('terminal block: not aligned without an action', () => {
    const row = connectorOf(buildSyncChain(snapshot({ alignment: alignment({ status: 'none', buildBlocked: 'disabled' }) })), 'ebook-audiobook')
    expect(row).toMatchObject({
      state: 'alignmentBlocked',
      tone: 'muted',
      pill: { key: `${C}pill.notAligned` },
      note: { key: 'book.detail.readingAlignment.buildBlocked.disabled' },
      actions: [],
      mini: { action: null },
    })
  })
})

describe('read-along states', () => {
  it('failed: retry disabled while blocked, no log without an error', () => {
    const row = slotOf(buildSyncChain(snapshot({ readAlong: readAlong({ status: 'failed', blocked: 'unreachable' }) })))
    expect(row).toMatchObject({ action: { disabled: true }, secondary: null, error: null })
  })

  it('failed: a reader who can generate gets Retry and a Dismiss that cancels the failed build', () => {
    const row = slotOf(buildSyncChain(snapshot({ readAlong: readAlong({ status: 'failed' }) })))
    expect(row).toMatchObject({
      variant: 'failed',
      action: { id: 'retryReadAlong' },
      cancel: { id: 'cancelReadAlong', label: { key: `${C}slot.dismiss` } },
    })
  })

  it('failed without the generate permission has no retry but still shows', () => {
    const row = slotOf(
      buildSyncChain(snapshot({ readAlong: readAlong({ status: 'failed' }), can: { editLink: true, generate: false, rebuild: false } })),
    )
    expect(row).toMatchObject({ variant: 'failed', action: null, cancel: null })
  })

  it('failed as a card job on the linked read-along', () => {
    const chain = buildSyncChain(fullChain({ readAlong: readAlong({ member: member(3, 'RA'), status: 'failed', error: 'stopped' }) }))
    expect(hasSlot(chain)).toBe(false)
    expect(cardOf(chain, 'readAlong')).toMatchObject({
      rebuild: null,
      job: { failed: true, retry: { id: 'retryReadAlong' }, cancel: null, error: 'stopped' },
    })
    expect(chain.header.tone).toBe('destructive')
  })

  it('queued: cancel with the generate permission and the queue position', () => {
    const chain = buildSyncChain(snapshot({ readAlong: readAlong({ status: 'queued', queuePosition: 2 }) }))
    expect(slotOf(chain)).toMatchObject({
      variant: 'queued',
      note: { key: 'book.detail.editionLink.readAlong.body.queued', params: { position: 2 } },
      cancel: { id: 'cancelReadAlong', label: { key: 'book.detail.editionLink.readAlong.cancelLabel' } },
      job: { stage: 0 },
    })
    const unknown = slotOf(
      buildSyncChain(snapshot({ readAlong: readAlong({ status: 'queued' }), can: { editLink: true, generate: false, rebuild: false } })),
    )
    expect(unknown).toMatchObject({ note: { key: 'book.detail.editionLink.readAlong.body.queuedUnknown' }, cancel: null })
  })

  it('ready without a reachable output is a ghost at the end of the spine, under the muted slot connector', () => {
    const chain = buildSyncChain(snapshot({ readAlong: readAlong({ status: 'ready' }), abs: abs() }))
    expect(ids(chain)).toEqual([
      'card:ebook',
      'connector:ebook-audiobook',
      'card:audiobook',
      'connector:audiobook-abs',
      'card:abs',
      'connector:readAlong-audiobook',
      'card:readAlong',
    ])
    expect(connectorOf(chain, 'readAlong-audiobook')).toMatchObject({
      tone: 'muted',
      switch: null,
      explainer: null,
      qualifier: null,
      mini: { text: null },
    })
    expect(ghostOf(chain, 'readAlong')).toMatchObject({
      frame: 'spine',
      note: { key: 'book.detail.editionLink.readAlong.body.outOfReach' },
      action: null,
    })
    expect(cardCount(chain)).toBe(3)
  })

  it('blocked: generate disabled with the block reason', () => {
    const row = slotOf(buildSyncChain(snapshot({ readAlong: readAlong({ blocked: 'no_target_library' }) })))
    expect(row).toMatchObject({
      variant: 'blocked',
      note: { key: 'book.detail.editionLink.readAlong.blocked.noTargetLibrary' },
      action: { id: 'openGenerate', disabled: true },
      expandable: false,
    })
  })

  it('an unlinked pair with both editions known can still be generated, and a missing pair status does not block it', () => {
    const chain = buildSyncChain(
      snapshot({
        linked: false,
        ebook: side({ book: book(1, 'Ebook'), isThisBook: true }),
        audiobook: side({ book: book(2, 'Audio'), match: { source: 'manual' } }),
        readAlong: readAlong({ blocked: 'no_pair' }),
      }),
    )
    expect(slotOf(chain)).toMatchObject({
      variant: 'notGenerated',
      note: { key: `${C}slot.notGenerated` },
      action: { id: 'openGenerate', disabled: false },
      expandable: true,
    })
    expect(cardOf(chain, 'audiobook').chip).toEqual({ key: `${C}chip.selected` })
  })

  it('a missing audiobook wins over a missing ebook in the slot note', () => {
    const chain = buildSyncChain(snapshot({ linked: false, ebook: side(), audiobook: side() }))
    expect(slotOf(chain).variant).toBe('needsAudio')
  })

  it('memberPending, not_configured and a missing generate permission hide the idle slot', () => {
    const pending = buildSyncChain(snapshot({ readAlong: readAlong({ status: 'ready', memberPending: true, outputBook: { id: 3, title: 'RA' } }) }))
    expect(hasSlot(pending)).toBe(false)
    expect(ids(pending)).not.toContain('card:readAlong')
    expect(hasSlot(buildSyncChain(snapshot({ readAlong: readAlong({ blocked: 'not_configured' }) })))).toBe(false)
    expect(hasSlot(buildSyncChain(snapshot({ can: { editLink: true, generate: false, rebuild: true } })))).toBe(false)
  })

  it('a read-aloud issue on Read-along to Audiobook asks for a rebuild', () => {
    const issue: ReadAloudProgressSync = {
      mode: 'auto',
      state: 'unavailable',
      unavailableReason: 'narration_mismatch',
      narrationMismatch: { narrationFile: 'ch3.mp3', narrationSeconds: 3725, chapter: 3, chapterSeconds: 65 },
    } as unknown as ReadAloudProgressSync
    const chain = buildSyncChain(
      fullChain({
        thisBook: 'audiobook',
        ebook: side({ book: book(1, 'E'), isMember: true }),
        audiobook: side({ book: book(2, 'A'), isMember: true, isThisBook: true }),
        readAloudIssue: issue,
      }),
    )
    const row = connectorOf(chain, 'readAlong-audiobook')

    expect(row).toMatchObject({
      state: 'readAloudIssue',
      tone: 'warning',
      pill: { key: 'book.detail.details.readAloudSync.state.notSyncing' },
      note: {
        key: 'book.detail.details.readAloudSync.reason.narrationMismatch',
        params: { file: 'ch3.mp3', narration: '1:02:05', chapter: 3, chapterLength: '1:05' },
      },
      actions: [{ id: 'rebuildReadAlong' }],
      switch: { offTarget: 'readAlong' },
      mini: { action: { id: 'rebuildReadAlong', label: { key: 'book.detail.editionLink.actions.rebuild' } } },
    })
    expect(chain.header.tone).toBe('warning')

    const noPerm = buildSyncChain(
      fullChain({ readAloudIssue: { ...issue, unavailableReason: 'audio_changed' }, can: { editLink: true, generate: true, rebuild: false } }),
    )
    expect(connectorOf(noPerm, 'readAlong-audiobook')).toMatchObject({
      note: { key: 'book.detail.details.readAloudSync.reason.audio_changed' },
      actions: [],
      mini: { action: null },
    })
  })

  it('a read-aloud issue offers no Rebuild while the read-along status is not ready', () => {
    const issue = { mode: 'auto', state: 'unavailable', unavailableReason: 'audio_changed' } as unknown as ReadAloudProgressSync
    const chain = buildSyncChain(
      snapshot({
        thisBook: 'audiobook',
        ebook: side({ book: book(1, 'E'), match: { source: 'auto', score: 90 } }),
        audiobook: side({ book: book(2, 'A'), isMember: true, isThisBook: true }),
        readAlong: readAlong({ member: member(3, 'Read-along'), status: 'none' }),
        readAloudIssue: issue,
      }),
    )
    expect(connectorOf(chain, 'readAlong-audiobook')).toMatchObject({ state: 'readAloudIssue', actions: [], mini: { action: null } })
    expect(cardOf(chain, 'readAlong').rebuild).toBeNull()
  })

  it('a detached read-along page on a linked pair is a card whose switch attaches it', () => {
    const chain = buildSyncChain(
      snapshot({
        thisBook: 'readAlong',
        ebook: side({ book: book(1, 'E'), isMember: true }),
        readAlong: readAlong({ status: 'ready', outputBook: { id: 3, title: 'RA' } }),
      }),
    )
    expect(ids(chain)).toEqual(['card:readAlong', 'connector:readAlong-audiobook', 'card:audiobook', 'connector:ebook-audiobook', 'card:ebook'])
    expect(cardOf(chain, 'readAlong')).toMatchObject({ isThisBook: true, linked: true, chip: null })
    expect(connectorOf(chain, 'readAlong-audiobook')).toMatchObject({
      state: 'available',
      arrow: 'both',
      tone: 'muted',
      frame: 'spine',
      qualifier: { key: `${C}off.notLinked` },
      switch: { on: false, disabled: false, onAction: 'attachReadAlong', offTarget: null },
      mini: { text: { key: `${C}off.notLinked` }, action: null },
    })
  })

  it('attaching a detached read-along needs an audiobook and the permission, not a linked pair', () => {
    const detached = readAlong({ status: 'ready', outputBook: { id: 3, title: 'RA' } })
    const unlinkedPair = buildSyncChain(
      snapshot({
        linked: false,
        ebook: side({ book: book(1, 'E'), isThisBook: true }),
        audiobook: side({ book: book(2, 'A'), match: { source: 'manual' } }),
        readAlong: detached,
      }),
    )
    expect(connectorOf(unlinkedPair, 'readAlong-audiobook')).toMatchObject({
      qualifier: { key: `${C}off.notLinked` },
      switch: { disabled: false, onAction: 'attachReadAlong' },
      disabledReason: null,
    })

    const noAudio = buildSyncChain(
      snapshot({ linked: false, ebook: side({ book: book(1, 'E'), isThisBook: true }), audiobook: side({ book: null }), readAlong: detached }),
    )
    expect(connectorOf(noAudio, 'readAlong-audiobook')).toMatchObject({
      qualifier: { key: `${C}off.pickAudiobookFirst` },
      switch: { disabled: true, onAction: 'attachReadAlong' },
      disabledReason: { key: `${C}off.pickAudiobookFirst` },
    })

    const noPerm = buildSyncChain(snapshot({ readAlong: detached, can: { editLink: false, generate: true, rebuild: true } }))
    expect(connectorOf(noPerm, 'readAlong-audiobook')).toMatchObject({
      switch: { disabled: true },
      disabledReason: { key: `${C}disabled.noPermission` },
    })
  })
})

describe('Audiobookshelf states', () => {
  it('unreachable: retry and settings', () => {
    const chain = buildSyncChain(snapshot({ abs: abs({}, absLive({ status: 'unreachable' })) }))
    expect(connectorOf(chain, 'audiobook-abs')).toMatchObject({
      state: 'absUnreachable',
      tone: 'warning',
      pill: { key: `${C}pill.cantReach` },
      note: { key: `${C}note.absUnreachable` },
      actions: [{ id: 'retryAbs', label: { key: 'book.detail.editionLink.abs.reconcile.retry' } }],
      settingsLink: true,
      mini: { text: { key: `${C}mini.cantReach` }, action: { id: 'retryAbs' } },
    })
    expect(chain.header.tone).toBe('warning')
  })

  it('diverged: push and pull', () => {
    const row = connectorOf(
      buildSyncChain(
        snapshot({ abs: abs({}, absLive({ status: 'diverged', local: { percentage: 30.2, capturedAt: 'x' }, divergedReason: 'stale' })) }),
      ),
      'audiobook-abs',
    )
    expect(row).toMatchObject({
      state: 'absDiverged',
      pill: { key: 'book.detail.editionLink.abs.status.diverged' },
      note: null,
      settingsLink: false,
      mini: { text: { key: 'book.detail.editionLink.abs.status.diverged' } },
    })
    expect(row.actions.map((a) => [a.id, a.label.key])).toEqual([
      ['absPush', 'book.detail.editionLink.abs.reconcile.push'],
      ['absPull', 'book.detail.editionLink.abs.reconcile.pull'],
    ])
  })

  it('receiving: use it now, still linked', () => {
    const chain = buildSyncChain(snapshot({ abs: abs({}, absLive({ status: 'receiving' })) }))
    expect(connectorOf(chain, 'audiobook-abs')).toMatchObject({
      state: 'absReceiving',
      tone: 'success',
      pill: { key: `${C}pill.linked` },
      note: null,
      actions: [{ id: 'absPull', label: { key: 'book.detail.editionLink.abs.reconcile.useNow' } }],
      mini: { text: { key: `${C}mini.syncedWithAbs` } },
    })
    expect(chain.header.tone).toBe('success')
  })

  it('one way: settings link and direction explainer', () => {
    const row = connectorOf(buildSyncChain(snapshot({ abs: abs({ direction: 'from_abs' }) })), 'audiobook-abs')
    expect(row).toMatchObject({
      state: 'absOneWay',
      arrow: 'left',
      pill: { key: `${C}pill.oneWay` },
      qualifier: { key: `${C}qualifier.oneWay` },
      note: null,
      explainer: { key: `${C}explain.absFromAbs` },
      settingsLink: true,
    })
  })

  it('one way while receiving keeps the one-way qualifier and the settings link', () => {
    const row = connectorOf(buildSyncChain(snapshot({ abs: abs({ direction: 'from_abs' }, absLive({ status: 'receiving' })) })), 'audiobook-abs')
    expect(row).toMatchObject({
      state: 'absReceiving',
      arrow: 'left',
      qualifier: { key: `${C}qualifier.oneWay` },
      settingsLink: true,
    })
  })

  it('a paused one-way link keeps its settings link', () => {
    const row = connectorOf(
      buildSyncChain(snapshot({ abs: abs({ direction: 'from_abs', syncing: false, pausedReason: 'needs_review' }) })),
      'audiobook-abs',
    )
    expect(row).toMatchObject({ switch: { on: false }, settingsLink: true })
    const twoWay = connectorOf(buildSyncChain(snapshot({ abs: abs({ syncing: false, pausedReason: 'needs_review' }) })), 'audiobook-abs')
    expect(twoWay.settingsLink).toBe(false)
  })

  it('a two-way link that is reachable has no settings link', () => {
    const row = connectorOf(buildSyncChain(snapshot({ abs: abs({}, absLive({ status: 'receiving' })) })), 'audiobook-abs')
    expect(row).toMatchObject({ qualifier: { key: `${C}qualifier.twoWay` }, settingsLink: false })
  })

  it('a paused one-way match draws the direction it would sync in', () => {
    const chain = buildSyncChain(snapshot({ abs: abs({ direction: 'from_abs', syncing: false, pausedReason: 'excluded' }) }))
    expect(connectorOf(chain, 'audiobook-abs')).toMatchObject({ state: 'available', arrow: 'left' })
  })

  it('sending and checking', () => {
    expect(connectorOf(buildSyncChain(snapshot({ abs: abs({}, absLive({ status: 'sending' })) })), 'audiobook-abs').state).toBe('absSending')
    const chain = buildSyncChain(snapshot({ abs: abs({}, null, true) }))
    expect(connectorOf(chain, 'audiobook-abs').state).toBe('absLinked')
    expect(cardOf(chain, 'abs')).toMatchObject({ progress: null, progressPending: true })
  })

  it('needs review: a dashed card to confirm, a switch that confirms, and the panel opens in Modify', () => {
    const chain = buildSyncChain(snapshot({ abs: abs({ syncing: false, pausedReason: 'needs_review' }) }))
    expect(cardOf(chain, 'abs')).toMatchObject({
      linked: false,
      chip: { key: `${C}chip.needsReview` },
      confirm: { id: 'confirmAbs', label: { key: `${C}action.confirm` } },
      change: 'available',
    })
    expect(connectorOf(chain, 'audiobook-abs')).toMatchObject({
      state: 'available',
      qualifier: { key: `${C}off.needsReview` },
      switch: { on: false, disabled: false, onAction: 'confirmAbs' },
    })
    expect(chain.header.label.params).toEqual({ n: 2, m: 3 })
    expect(chain.needsAttention).toBe(true)
    expect(cardCount(chain)).toBe(3)
  })

  it('excluded: a paused dashed card whose switch resumes sync', () => {
    const chain = buildSyncChain(snapshot({ abs: abs({ syncing: false, pausedReason: 'excluded' }) }))
    expect(cardOf(chain, 'abs')).toMatchObject({ linked: false, chip: { key: `${C}chip.paused` }, confirm: null })
    expect(connectorOf(chain, 'audiobook-abs')).toMatchObject({
      qualifier: { key: `${C}off.syncPaused` },
      switch: { on: false, disabled: false, onAction: 'resumeAbs' },
    })
    expect(chain.needsAttention).toBe(false)
  })

  it('position sync off in settings: a ghost with a Settings link and a disabled switch', () => {
    const chain = buildSyncChain(snapshot({ abs: abs({ syncing: false, pausedReason: 'position_sync_off' }) }))
    expect(ghostOf(chain, 'abs')).toMatchObject({
      note: { key: `${C}ghost.absPositionSyncOff` },
      action: null,
      settingsLink: true,
    })
    expect(connectorOf(chain, 'audiobook-abs')).toMatchObject({
      qualifier: { key: `${C}off.syncOffInSettings` },
      switch: { on: false, disabled: true },
    })
  })

  it('no match: a Match ghost and a disabled switch', () => {
    const chain = buildSyncChain(snapshot({ abs: noAbsMatch }))
    expect(ghostOf(chain, 'abs')).toMatchObject({
      note: { key: `${C}ghost.noMatchAbs` },
      action: { id: 'change', label: { key: `${C}action.match` } },
    })
    expect(connectorOf(chain, 'audiobook-abs')).toMatchObject({
      qualifier: { key: `${C}off.notMatched` },
      switch: { on: false, disabled: true },
    })
  })

  it('a paused match on a candidate audiobook can be resumed without the pair link', () => {
    const chain = buildSyncChain(
      snapshot({
        linked: false,
        ebook: side({ book: book(1, 'Ebook'), isThisBook: true }),
        audiobook: side({ book: book(2, 'Audiobook'), match: { source: 'auto', score: 96 } }),
        alignment: alignment({ status: 'none', builtAt: null }),
        abs: abs({ syncing: false, pausedReason: 'excluded' }),
      }),
    )
    expect(cardOf(chain, 'abs')).toMatchObject({ linked: false })
    expect(connectorOf(chain, 'audiobook-abs')).toMatchObject({
      qualifier: { key: `${C}off.syncPaused` },
      switch: { on: false, disabled: false, onAction: 'resumeAbs' },
    })
    expect(chain.header.tone).toBe('muted')
  })

  it('an unlinked ebook page shows the candidate audiobook syncing with Audiobookshelf on its own', () => {
    const chain = buildSyncChain(
      snapshot({
        linked: false,
        ebook: side({ book: book(1, 'Ebook'), isThisBook: true }),
        audiobook: side({ book: book(2, 'Audiobook'), match: { source: 'auto', score: 96 } }),
        alignment: alignment({ status: 'none', builtAt: null }),
        abs: abs(),
      }),
    )
    expect(cardOf(chain, 'audiobook')).toMatchObject({ linked: false })
    expect(cardOf(chain, 'abs')).toMatchObject({ linked: true })
    expect(connectorOf(chain, 'audiobook-abs')).toMatchObject({ state: 'absLinked', switch: { on: true, disabled: false } })
    expect(connectorOf(chain, 'ebook-audiobook').switch).toMatchObject({ on: false, onAction: 'linkPair' })
    expect(chain.header).toEqual({ tone: 'success', label: { key: `${C}header.inSync`, params: { n: 2, m: 3 } } })
  })

  it('Audiobookshelf still waits when no audiobook is on screen at all', () => {
    const chain = buildSyncChain(
      snapshot({
        linked: false,
        ebook: side({ book: book(1, 'Ebook'), isThisBook: true }),
        audiobook: side(),
        alignment: alignment({ status: 'none', builtAt: null }),
        abs: abs(),
      }),
    )
    expect(ghostOf(chain, 'abs').note).toEqual({ key: `${C}ghost.absNeedsAudio` })
    expect(connectorOf(chain, 'audiobook-abs')).toMatchObject({ qualifier: { key: `${C}off.pickAudiobookFirst` }, switch: { disabled: true } })
  })

  it('Audiobookshelf stays out of the chain without its permission', () => {
    const chain = buildSyncChain(snapshot({ abs: null }))
    expect(ids(chain).some((id) => id.includes('abs'))).toBe(false)
  })

  it('Audiobookshelf stays out of the chain while the integration is not configured, even with a stored match', () => {
    for (const absSnapshot of [
      { ...noAbsMatch, configured: false },
      { ...abs(), configured: false },
    ]) {
      const chain = buildSyncChain(fullChain({ abs: absSnapshot }))
      expect(ids(chain).some((id) => id.includes('abs'))).toBe(false)
      expect(chain.header.label).toEqual({ key: `${C}header.inSync`, params: { n: 3, m: 3 } })
    }
  })

  it('a configured integration with no match keeps the Match ghost', () => {
    const chain = buildSyncChain(snapshot({ abs: noAbsMatch }))
    expect(ids(chain)).toContain('connector:audiobook-abs')
    expect(ghostOf(chain, 'abs').action?.id).toBe('change')
  })

  it.each([
    [0, false, 0],
    [-1, false, 0],
    [0.2, false, 1],
    [99.6, false, 99],
    [99.6, true, 100],
  ])('card progress %s finished=%s reads %s', (percentage, isFinished, expected) => {
    const chain = buildSyncChain(snapshot({ abs: abs({}, absLive({ progress: { percentage, isFinished, lastUpdate: 1 } })) }))
    expect(cardOf(chain, 'abs').progress).toBe(expected)
  })
})

describe('permissions', () => {
  it('without editLink: the pair switch is disabled, edit actions dropped, a candidate keeps no Change, a ghost no Search', () => {
    const can = { editLink: false, generate: true, rebuild: true }
    const linked = buildSyncChain(snapshot({ can, alignment: alignment({ status: 'none', builtAt: null }), abs: abs() }))
    expect(connectorOf(linked, 'ebook-audiobook')).toMatchObject({ switch: { disabled: true }, actions: [], mini: { action: null } })
    expect(connectorOf(linked, 'audiobook-abs').switch?.disabled).toBe(false)
    expect(cardOf(linked, 'audiobook').change).toBe('none')

    const linking = buildSyncChain(snapshot({ can, alignment: alignment({ running: true, builtAt: null }) }))
    expect(connectorOf(linking, 'ebook-audiobook').cancel).toBeNull()

    const noMatch = buildSyncChain(snapshot({ can, linked: false, ebook: side({ book: book(1, 'E'), isThisBook: true }), audiobook: side() }))
    expect(ghostOf(noMatch, 'audiobook').action).toBeNull()
    const searchable = buildSyncChain(snapshot({ linked: false, ebook: side({ book: book(1, 'E'), isThisBook: true }), audiobook: side() }))
    expect(ghostOf(searchable, 'audiobook').action).toMatchObject({ id: 'change', label: { key: `${C}action.search` } })
  })

  it('a ready member offers Rebuild only through a real link, never on a members-only ebook page', () => {
    const base = {
      ebook: side({ book: book(1, 'E'), isThisBook: true }),
      audiobook: side({ book: book(2, 'A'), match: { source: 'auto' as const, score: 90 } }),
      alignment: alignment({ status: 'none', builtAt: null }),
      readAlong: readAlong({ member: member(3, 'RA'), status: 'ready', outputBook: { id: 3, title: 'RA' } }),
    }
    expect(cardOf(buildSyncChain(snapshot({ ...base, linked: false })), 'readAlong').rebuild).toBeNull()
    expect(cardOf(buildSyncChain(snapshot({ ...base, linked: true })), 'readAlong').rebuild).toMatchObject({
      id: 'rebuildReadAlong',
      disabled: false,
    })
  })

  it('without rebuild the read-along card has no Rebuild', () => {
    expect(cardOf(buildSyncChain(fullChain({ can: { editLink: true, generate: true, rebuild: false } })), 'readAlong').rebuild).toBeNull()
  })
})

describe('Change on the cards', () => {
  const B = `${C}change.blocked`
  const W = `${C}change.building`

  it.each([
    ['member', readAlong({ member: member(3, 'RA'), status: 'ready', outputBook: { id: 3, title: 'RA' } }), B],
    ['queued', readAlong({ status: 'queued' }), W],
    ['building', readAlong({ status: 'building', phase: 'wait' }), W],
  ])('is blocked on both linked pair cards while the read-along holds the pair (%s)', (_label, ra, hint) => {
    const chain = buildSyncChain(snapshot({ thisBook: 'readAlong', ebook: side({ book: book(1, 'E'), isMember: true }), readAlong: ra }))
    expect(cardOf(chain, 'ebook')).toMatchObject({ change: 'blocked', changeHint: { key: hint } })
    expect(cardOf(chain, 'audiobook')).toMatchObject({ change: 'blocked', changeHint: { key: hint } })
  })

  it.each([
    ['detached output', readAlong({ status: 'ready', outputBook: { id: 3, title: 'RA' } })],
    ['failed', readAlong({ status: 'failed' })],
  ])('is offered on a linked pair whose read-along is not a member and not running (%s)', (_label, ra) => {
    const chain = buildSyncChain(snapshot({ readAlong: ra }))
    expect(cardOf(chain, 'audiobook')).toMatchObject({ change: 'available', changeHint: null })
  })

  it('is offered without a read-along and never on this book', () => {
    const chain = buildSyncChain(snapshot())
    expect(cardOf(chain, 'ebook')).toMatchObject({ change: 'none', changeHint: null })
    expect(cardOf(chain, 'audiobook')).toMatchObject({ change: 'available', changeHint: null })
  })

  it('is offered on an unlinked candidate', () => {
    const candidate = buildSyncChain(
      snapshot({
        linked: false,
        ebook: side({ book: book(1, 'E'), isThisBook: true }),
        audiobook: side({ book: book(2, 'A'), match: { source: 'auto', score: 88 } }),
        readAlong: readAlong({ status: 'ready', outputBook: { id: 3, title: 'RA' } }),
      }),
    )
    expect(cardOf(candidate, 'audiobook')).toMatchObject({ linked: false, change: 'available', changeHint: null })
  })

  it('is not offered on the audiobook that is the read-along page pair', () => {
    const pair = buildSyncChain(
      snapshot({
        linked: false,
        ebook: side({ book: book(1, 'E'), isThisBook: true }),
        audiobook: side({ book: book(2, 'A'), match: { source: 'pair' } }),
        readAlong: readAlong({ status: 'ready', outputBook: { id: 3, title: 'RA' } }),
      }),
    )
    expect(cardOf(pair, 'audiobook')).toMatchObject({ change: 'none', changeHint: null })
  })

  const unlinkedCandidate = (ra: ReturnType<typeof readAlong>, can = { editLink: true, generate: true, rebuild: true }) =>
    buildSyncChain(
      snapshot({
        can,
        linked: false,
        ebook: side({ book: book(1, 'E'), isThisBook: true }),
        audiobook: side({ book: book(2, 'A'), match: { source: 'manual' } }),
        alignment: alignment({ status: 'none', builtAt: null }),
        readAlong: ra,
      }),
    )

  it.each([
    ['queued', readAlong({ status: 'queued' }), W],
    ['building', readAlong({ status: 'building', phase: 'wait' }), W],
    ['failed', readAlong({ status: 'failed' }), `${C}change.failed`],
  ])('is blocked on an unlinked candidate while the slot shows a build for that pair (%s)', (_label, ra, hint) => {
    const chain = unlinkedCandidate(ra)
    expect(slotOf(chain).variant).toBe(_label)
    expect(cardOf(chain, 'audiobook')).toMatchObject({ linked: false, change: 'blocked', changeHint: { key: hint } })
  })

  it('is blocked on an unlinked candidate while a build runs even when a read-along card is shown', () => {
    const chain = unlinkedCandidate(readAlong({ member: member(3, 'RA'), status: 'building', phase: 'wait', outputBook: { id: 3, title: 'RA' } }))
    expect(cardOf(chain, 'audiobook')).toMatchObject({ linked: false, change: 'blocked', changeHint: { key: W } })
  })

  it('leaves Change offered on an unlinked candidate with a failed build when the reader cannot retry it', () => {
    const can = { editLink: true, generate: false, rebuild: false }
    const failed = unlinkedCandidate(readAlong({ status: 'failed' }), can)
    expect(slotOf(failed)).toMatchObject({ variant: 'failed', action: null })
    expect(cardOf(failed, 'audiobook')).toMatchObject({ change: 'available', changeHint: null })
    for (const status of ['queued', 'building'] as const) {
      expect(cardOf(unlinkedCandidate(readAlong({ status, phase: 'wait' }), can), 'audiobook')).toMatchObject({
        change: 'blocked',
        changeHint: { key: `${C}change.building` },
      })
    }
  })
})

describe('header priority', () => {
  it('failure beats check-sync beats linking', () => {
    const many = snapshot({
      alignment: alignment({ status: 'failed' }),
      readAlong: readAlong({ status: 'building', phase: 'wait' }),
      abs: abs({}, absLive({ status: 'unreachable' })),
    })
    expect(buildSyncChain(many).header.tone).toBe('destructive')
    expect(buildSyncChain({ ...many, alignment: alignment() }).header).toEqual({ tone: 'warning', label: { key: `${C}header.checkSync` } })
    expect(buildSyncChain({ ...many, alignment: alignment(), abs: abs() }).header.tone).toBe('info')
    expect(buildSyncChain({ ...many, alignment: alignment(), abs: abs(), readAlong: readAlong() }).header.tone).toBe('success')
  })

  it('a read-along failure needs attention even before the pair is linked', () => {
    const chain = buildSyncChain(
      snapshot({
        linked: false,
        ebook: side({ book: book(1, 'E'), isThisBook: true }),
        audiobook: side(),
        readAlong: readAlong({ status: 'failed' }),
      }),
    )
    expect(chain.header.tone).toBe('destructive')
    expect(chain.needsAttention).toBe(true)
  })

  it('an alignment failure only counts while linked', () => {
    const chain = buildSyncChain(
      snapshot({
        linked: false,
        ebook: side({ book: book(1, 'E'), isThisBook: true }),
        audiobook: side({ book: book(2, 'A'), match: { source: 'manual' } }),
        alignment: alignment({ status: 'failed' }),
      }),
    )
    expect(chain.header.tone).toBe('muted')
  })
})

describe('switch off targets', () => {
  it.each([
    ['ebook', fullChain()],
    [
      'audiobook',
      fullChain({
        thisBook: 'audiobook',
        ebook: side({ book: book(1, 'E'), isMember: true }),
        audiobook: side({ book: book(2, 'A'), isMember: true, isThisBook: true }),
      }),
    ],
    [
      'readAlong',
      fullChain({
        thisBook: 'readAlong',
        ebook: side({ book: book(1, 'E'), isMember: true }),
        readAlong: readAlong({ member: member(3, 'RA'), status: 'ready', thisBook: book(3, 'RA') }),
      }),
    ],
  ] as const)('on the %s page each switch turns off its own link', (_page, snap) => {
    const chain = buildSyncChain(snap)
    expect(connectorOf(chain, 'ebook-audiobook').switch?.offTarget).toBe('pair')
    expect(connectorOf(chain, 'readAlong-audiobook').switch?.offTarget).toBe('readAlong')
    expect(connectorOf(chain, 'audiobook-abs').switch?.offTarget).toBe('abs')
  })
})

describe('view mode', () => {
  it('estimates taller with more rows', () => {
    const small = buildSyncChain(snapshot({ readAlong: readAlong({ blocked: 'not_configured' }) }))
    const large = buildSyncChain(fullChain())
    const withSlot = buildSyncChain(snapshot())

    expect(modifyHeight(large)).toBeGreaterThan(modifyHeight(small))
    expect(modifyHeight(withSlot)).toBeGreaterThan(modifyHeight(small))
  })

  it('counts notes, actions and ticks on connectors', () => {
    const base = { readAlong: readAlong({ blocked: 'not_configured' as const }) }
    const plain = buildSyncChain(snapshot(base))
    const aligning = buildSyncChain(snapshot({ ...base, alignment: alignment({ running: true, builtAt: null }) }))
    const failed = buildSyncChain(snapshot({ ...base, alignment: alignment({ status: 'failed' }) }))
    expect(modifyHeight(plain)).toBe(96 + 24 + 66 + 32 + 66)
    expect(modifyHeight(aligning)).toBe(96 + 24 + 66 + 32 + 30 + 20 + 66)
    expect(modifyHeight(failed)).toBe(96 + 24 + 66 + 32 + 30 + 32 + 66)
  })

  it('counts a ghost, a dashed card and the bottom slot as the spec sizes them', () => {
    const chain = buildSyncChain(
      snapshot({
        linked: false,
        ebook: side({ book: book(1, 'E'), isThisBook: true }),
        audiobook: side(),
        alignment: alignment({ status: 'none', builtAt: null }),
      }),
    )
    expect(modifyHeight(chain)).toBe(96 + 24 + 66 + 32 + 46 + 32 + 75)
    const candidate = buildSyncChain(
      snapshot({
        linked: false,
        ebook: side({ book: book(1, 'E'), isThisBook: true }),
        audiobook: side({ book: book(2, 'A'), match: { source: 'manual' } }),
        alignment: alignment({ status: 'none', builtAt: null }),
      }),
    )
    expect(modifyHeight(candidate)).toBe(96 + 24 + 66 + 32 + 66 + 32 + 75)
  })

  it('sizes the inner Audiobookshelf connector smaller than a spine connector', () => {
    const chain = buildSyncChain(snapshot({ abs: abs(), readAlong: readAlong({ blocked: 'not_configured' as const }) }))
    expect(modifyHeight(chain)).toBe(96 + 24 + 66 + 32 + 66 + 28 + 66)
  })

  it.each([
    ['receiving', absLive({ status: 'receiving' }), 1],
    ['diverged', absLive({ status: 'diverged', local: { percentage: 30.2, capturedAt: 'x' }, divergedReason: 'stale' }), 2],
  ] as const)('counts the live hint line under a %s Audiobookshelf connector', (_label, live, buttons) => {
    const chain = buildSyncChain(snapshot({ abs: abs({}, live), readAlong: readAlong({ blocked: 'not_configured' as const }) }))
    expect(connectorOf(chain, 'audiobook-abs').actions).toHaveLength(buttons)
    expect(modifyHeight(chain)).toBe(96 + 24 + 66 + 32 + 66 + 28 + 30 + 32 + 66)
  })

  it('opens Modify exactly when the estimate fits or something needs attention', () => {
    const chain = buildSyncChain(snapshot())
    const height = 96 + 24 + 66 + 32 + 66 + 32 + 75
    expect(initialViewMode(chain, height)).toBe('modify')
    expect(initialViewMode(chain, height - 1)).toBe('compact')
    const failing = buildSyncChain(snapshot({ alignment: alignment({ status: 'failed' }) }))
    expect(initialViewMode(failing, 0)).toBe('modify')
  })

  it('availableHeightFromTrigger takes the taller side less padding and offset', () => {
    expect(availableHeightFromTrigger({ top: 100, bottom: 140 }, 800)).toBe(800 - 140 - 16 - 4)
    expect(availableHeightFromTrigger({ top: 700, bottom: 740 }, 800)).toBe(700 - 20)
    expect(availableHeightFromTrigger({ top: 300, bottom: 340 }, 800, 8, 0)).toBe(460 - 8)
  })
})
