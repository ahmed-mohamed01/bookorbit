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
} from './sync-chain-fixtures'
import {
  availableHeightFromTrigger,
  buildSyncChain,
  estimateChainHeight,
  initialViewMode,
  offTargetFor,
  type ChainAvailableRow,
  type EditionKey,
  type SyncChain,
  type SyncChainSnapshot,
} from '../sync-chain'

const C = 'book.detail.editionLink.chain.'

const fullChain = (overrides: Partial<SyncChainSnapshot> = {}) =>
  snapshot({
    readAlong: readAlong({ member: member(3, 'Read-along'), status: 'ready', outputBook: { id: 3, title: 'Read-along' } }),
    abs: abs(),
    ...overrides,
  })

const ids = (chain: SyncChain) => chain.rows.map((row) => row.id)

function availableOf(chain: SyncChain, edition: EditionKey): ChainAvailableRow | undefined {
  return chain.rows.find((r): r is ChainAvailableRow => r.kind === 'available' && r.edition === edition)
}

describe('buildSyncChain boards', () => {
  it('A: every edition linked from the ebook page', () => {
    const chain = buildSyncChain(fullChain())

    expect(ids(chain)).toEqual([
      'card:ebook',
      'connector:ebook-readAlong',
      'card:readAlong',
      'connector:readAlong-audiobook',
      'card:audiobook',
      'connector:audiobook-abs',
      'card:abs',
    ])
    expect(connectorOf(chain, 'ebook-readAlong')).toMatchObject({ state: 'linked', tone: 'success', pill: { key: `${C}pill.linked` }, dashed: false })
    expect(connectorOf(chain, 'readAlong-audiobook').state).toBe('linked')
    expect(connectorOf(chain, 'audiobook-abs')).toMatchObject({ state: 'absLinked', absDetails: true, switch: { on: true, offTarget: 'abs' } })
    expect(chain.header).toEqual({ tone: 'success', label: { key: `${C}header.inSync`, params: { n: 4, m: 4 } } })
    expect(chain.intro).toEqual({ key: `${C}intro.linked` })
    expect(chain.needsAttention).toBe(false)
    expect(cardOf(chain, 'ebook')).toMatchObject({ isThisBook: true, routeBookId: null, change: 'none', progress: 41 })
    expect(cardOf(chain, 'readAlong')).toMatchObject({
      cover: { kind: 'book', bookId: 3, coverVersion: 'rv' },
      routeBookId: 3,
      progress: 41,
      change: 'none',
      rebuild: { id: 'rebuildReadAlong', label: { key: 'book.detail.editionLink.actions.rebuild' }, disabled: false },
    })
    expect(cardOf(chain, 'abs')).toMatchObject({
      external: true,
      cover: { kind: 'abs', absLibraryItemId: 'li_1' },
      subtitle: 'Fiction',
      href: 'https://abs.example/item/li_1',
      routeBookId: null,
      progress: 52,
      change: 'available',
    })
    const connectors = chain.rows.filter((row) => row.kind === 'connector')
    expect(connectors.map((row) => row.mini.text)).toEqual(connectors.map(() => null))
  })

  it('B: the full chain opens compact when Modify does not fit', () => {
    const chain = buildSyncChain(fullChain())
    expect(initialViewMode(chain, 400)).toBe('compact')
    expect(initialViewMode(chain, 2000)).toBe('modify')
  })

  it('C: from the read-along page, an unbuilt alignment shows on Ebook to Read-along', () => {
    const chain = buildSyncChain(
      fullChain({
        thisBook: 'readAlong',
        ebook: side({ book: book(1, 'Ebook'), isMember: true }),
        alignment: alignment({ status: 'none', builtAt: null }),
      }),
    )

    expect(cardOf(chain, 'readAlong')).toMatchObject({ isThisBook: true, routeBookId: null })
    expect(cardOf(chain, 'ebook').routeBookId).toBe(1)
    const er = connectorOf(chain, 'ebook-readAlong')
    expect(er).toMatchObject({
      state: 'notAligned',
      tone: 'warning',
      icon: 'alert',
      note: { key: 'book.detail.readingAlignment.idleHint' },
      actions: [{ id: 'alignNow', label: { key: `${C}action.alignNow` } }],
      switch: { on: true, offTarget: 'pair' },
      mini: { text: { key: `${C}pill.notAligned` }, action: { id: 'alignNow' } },
    })
    expect(connectorOf(chain, 'readAlong-audiobook').switch?.offTarget).toBe('pair')
    expect(chain.header.tone).toBe('warning')
    expect(chain.needsAttention).toBe(true)
    expect(initialViewMode(chain, 10)).toBe('modify')
  })

  it('D: ebook and audiobook only, read-along offered to generate', () => {
    const chain = buildSyncChain(snapshot())

    expect(ids(chain)).toEqual(['card:ebook', 'connector:ebook-audiobook', 'card:audiobook', 'available-header', 'available:readAlong'])
    expect(connectorOf(chain, 'ebook-audiobook')).toMatchObject({ state: 'linkedViaWhisper', pill: { key: `${C}pill.linkedViaWhisper` } })
    expect(availableOf(chain, 'readAlong')).toMatchObject({
      variant: 'readAlongNotGenerated',
      cover: { kind: 'readAlongTile' },
      label: { key: `${C}short.readAlong` },
      note: { key: `${C}available.readAlong.notGenerated` },
      action: { id: 'openGenerate', label: { key: `${C}action.generate` }, disabled: false },
      expandable: true,
      present: false,
    })
    expect(chain.header.label).toEqual({ key: `${C}header.inSync`, params: { n: 2, m: 2 } })
    expect(cardOf(chain, 'audiobook').change).toBe('available')
  })

  it('E: linking right after the pair was linked', () => {
    const chain = buildSyncChain(
      snapshot({
        alignment: alignment({ status: 'none', builtAt: null, running: true, samplesDone: 3, samplesTotal: 12 }),
        abs: abs({ syncing: false, pausedReason: 'excluded' }),
      }),
    )

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
    expect(availableOf(chain, 'abs')).toMatchObject({
      variant: 'absPaused',
      note: { key: `${C}available.abs.paused`, params: { library: 'Fiction' } },
      action: { id: 'resumeAbs', label: { key: `${C}action.link` } },
      present: true,
    })
    expect(chain.header).toEqual({ tone: 'info', label: { key: `${C}header.linking` } })
    expect(chain.needsAttention).toBe(false)
  })

  it('F: a read-along building in Available', () => {
    const chain = buildSyncChain(
      snapshot({ readAlong: readAlong({ status: 'building', phase: 'wait', remoteTask: 'SYNC_CHAPTERS', remoteProgress: 0.4 }), abs: abs() }),
    )

    const row = availableOf(chain, 'readAlong')
    expect(row).toMatchObject({
      variant: 'readAlongBuilding',
      note: { key: `${C}available.readAlong.generating` },
      cancel: { id: 'cancelReadAlong' },
      job: { stage: 2, remoteProgress: 0.4, failed: false, retry: null, error: null },
      present: false,
    })
    expect(ids(chain)).toContain('card:abs')
    expect(chain.present).toBe(3)
    expect(chain.header.tone).toBe('info')
  })

  it('F: no cancel once Storyteller is importing', () => {
    const chain = buildSyncChain(snapshot({ readAlong: readAlong({ status: 'building', phase: 'collect' }) }))
    expect(availableOf(chain, 'readAlong')).toMatchObject({ cancel: null, job: { stage: 3, cancel: null } })
  })

  it('G: a detached read-along waits in Available', () => {
    const chain = buildSyncChain(snapshot({ readAlong: readAlong({ status: 'ready', outputBook: { id: 3, title: 'RA' } }), abs: abs() }))

    expect(ids(chain)).toEqual([
      'card:ebook',
      'connector:ebook-audiobook',
      'card:audiobook',
      'connector:audiobook-abs',
      'card:abs',
      'available-header',
      'available:readAlong',
    ])
    expect(availableOf(chain, 'readAlong')).toMatchObject({
      variant: 'readAlongDetached',
      cover: { kind: 'book', bookId: 3 },
      action: { id: 'attachReadAlong', disabled: false },
      locked: false,
      present: true,
    })
    expect(chain.header.label.params).toEqual({ n: 3, m: 4 })
  })

  it("H': read-along page after the link is gone, Audiobookshelf on the pair's audiobook", () => {
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

    expect(ids(chain)).toEqual(['card:readAlong', 'available-header', 'available:ebook', 'available:audiobook', 'available:abs'])
    expect(cardOf(chain, 'readAlong')).toMatchObject({
      isThisBook: true,
      title: 'My read-along',
      routeBookId: null,
      cover: { kind: 'book', bookId: 30 },
    })
    expect(availableOf(chain, 'ebook')).toMatchObject({
      variant: 'candidate',
      note: { key: `${C}available.candidatePair`, params: { title: 'Ebook' } },
      action: { id: 'linkPair' },
      secondary: null,
      present: true,
    })
    expect(availableOf(chain, 'abs')).toMatchObject({ variant: 'absNeedsAudio', action: { disabled: true }, locked: true, present: true })
    expect(chain.header).toEqual({ tone: 'muted', label: { key: `${C}header.notLinked` } })
    expect(chain.intro.key).toBe(`${C}intro.unlinked`)
    expect(chain.present).toBe(4)
  })

  it("I': ebook page with a candidate audiobook excluded from Audiobookshelf", () => {
    const chain = buildSyncChain(
      snapshot({
        linked: false,
        ebook: side({ book: book(1, 'Ebook'), isThisBook: true }),
        audiobook: side({ book: book(2, 'Audiobook'), match: { source: 'auto', score: 96 } }),
        alignment: alignment({ status: 'none', builtAt: null }),
        readAlong: readAlong({ blocked: 'no_pair' }),
        abs: abs({ syncing: false, pausedReason: 'excluded' }),
      }),
    )

    expect(ids(chain)).toEqual(['card:ebook', 'available-header', 'available:readAlong', 'available:audiobook', 'available:abs'])
    expect(availableOf(chain, 'audiobook')).toMatchObject({
      variant: 'candidate',
      note: { key: `${C}available.candidateAuto`, params: { score: 96, title: 'Audiobook' } },
      action: { id: 'linkPair', label: { key: `${C}action.link` }, disabled: false },
      secondary: { id: 'openSearch', label: { key: `${C}action.notThisOne` } },
      expandable: true,
    })
    expect(availableOf(chain, 'readAlong')).toMatchObject({
      variant: 'readAlongNeedsPair',
      action: { id: 'openGenerate', disabled: true },
      locked: true,
    })
    expect(availableOf(chain, 'abs')?.variant).toBe('absNeedsAudio')
    expect(chain.header.tone).toBe('muted')
    expect(chain.needsAttention).toBe(false)
  })

  it('J: audiobook page syncing with Audiobookshelf, ebook as a candidate', () => {
    const chain = buildSyncChain(
      snapshot({
        thisBook: 'audiobook',
        linked: false,
        ebook: side({ book: book(1, 'Ebook'), match: { source: 'auto', score: 88 } }),
        audiobook: side({ book: book(2, 'Audiobook'), isThisBook: true }),
        alignment: alignment({ status: 'none', builtAt: null }),
        abs: abs(),
      }),
    )

    expect(ids(chain)).toEqual([
      'card:audiobook',
      'connector:audiobook-abs',
      'card:abs',
      'available-header',
      'available:ebook',
      'available:readAlong',
    ])
    expect(chain.header.label).toEqual({ key: `${C}header.inSync`, params: { n: 2, m: 3 } })
    expect(chain.intro.key).toBe(`${C}intro.linked`)
  })

  it('ebook next to Audiobookshelf: ABS waits for the audiobook instead of joining the chain', () => {
    const chain = buildSyncChain(
      snapshot({
        linked: false,
        ebook: side({ book: book(1, 'Ebook'), isThisBook: true }),
        audiobook: side(),
        alignment: alignment({ status: 'none' }),
        abs: abs(),
      }),
    )

    expect(chain.rows.some((row) => row.kind === 'connector')).toBe(false)
    expect(availableOf(chain, 'abs')).toMatchObject({ variant: 'absNeedsAudio', note: { key: `${C}available.abs.needsAudio` } })
    expect(availableOf(chain, 'audiobook')).toMatchObject({
      variant: 'search',
      cover: { kind: 'none' },
      note: { key: `${C}available.noMatchAudiobook` },
      present: false,
    })
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
  it('failed in Available: retry, view log and the failed step', () => {
    const chain = buildSyncChain(snapshot({ readAlong: readAlong({ status: 'failed', phase: 'wait', remoteTask: 'TRANSCRIBE', error: 'boom' }) }))
    expect(availableOf(chain, 'readAlong')).toMatchObject({
      variant: 'readAlongFailed',
      note: { key: `${C}available.readAlong.failed`, params: { step: 'transcribing' } },
      action: { id: 'retryReadAlong', disabled: false },
      secondary: { id: 'toggleLog', label: { key: `${C}action.viewLog` } },
      job: null,
      log: 'boom',
    })
    expect(chain.header.tone).toBe('destructive')
  })

  it('failed in Available: retry disabled while blocked, no log without an error', () => {
    const row = availableOf(buildSyncChain(snapshot({ readAlong: readAlong({ status: 'failed', blocked: 'unreachable' }) })), 'readAlong')
    expect(row).toMatchObject({ action: { disabled: true }, secondary: null })
  })

  it('failed as a card job on the linked read-along', () => {
    const chain = buildSyncChain(fullChain({ readAlong: readAlong({ member: member(3, 'RA'), status: 'failed', error: 'stopped' }) }))
    expect(availableOf(chain, 'readAlong')).toBeUndefined()
    expect(cardOf(chain, 'readAlong')).toMatchObject({
      rebuild: null,
      job: { failed: true, retry: { id: 'retryReadAlong' }, cancel: null, error: 'stopped' },
    })
    expect(chain.header.tone).toBe('destructive')
  })

  it('queued: cancel with the generate permission and the queue position', () => {
    const chain = buildSyncChain(snapshot({ readAlong: readAlong({ status: 'queued', queuePosition: 2 }) }))
    expect(availableOf(chain, 'readAlong')).toMatchObject({
      variant: 'readAlongQueued',
      note: { key: 'book.detail.editionLink.readAlong.body.queued', params: { position: 2 } },
      cancel: { id: 'cancelReadAlong', label: { key: 'book.detail.editionLink.readAlong.cancelLabel' } },
      job: { stage: 0 },
    })
    const unknown = availableOf(
      buildSyncChain(snapshot({ readAlong: readAlong({ status: 'queued' }), can: { editLink: true, generate: false, rebuild: false } })),
      'readAlong',
    )
    expect(unknown).toMatchObject({ note: { key: 'book.detail.editionLink.readAlong.body.queuedUnknown' }, cancel: null })
  })

  it('ready output while unlinked waits for the pair', () => {
    const chain = buildSyncChain(
      snapshot({
        linked: false,
        ebook: side({ book: book(1, 'Ebook'), isThisBook: true }),
        audiobook: side({ book: book(2, 'Audio'), match: { source: 'manual' } }),
        readAlong: readAlong({ status: 'ready', outputBook: { id: 3, title: 'RA' } }),
      }),
    )
    expect(availableOf(chain, 'readAlong')).toMatchObject({
      variant: 'readAlongWaitingForPair',
      action: { disabled: true },
      locked: true,
      present: true,
    })
    expect(availableOf(chain, 'audiobook')?.note).toEqual({ key: `${C}available.candidatePicked`, params: { title: 'Audio' } })
  })

  it('ready without a reachable output is out of reach', () => {
    const row = availableOf(buildSyncChain(snapshot({ readAlong: readAlong({ status: 'ready' }) })), 'readAlong')
    expect(row).toMatchObject({
      variant: 'readAlongOutOfReach',
      note: { key: 'book.detail.editionLink.readAlong.body.outOfReach' },
      action: null,
      present: false,
    })
  })

  it('blocked: generate disabled with the block reason', () => {
    const row = availableOf(buildSyncChain(snapshot({ readAlong: readAlong({ blocked: 'no_target_library' }) })), 'readAlong')
    expect(row).toMatchObject({
      variant: 'readAlongBlocked',
      note: { key: 'book.detail.editionLink.readAlong.blocked.noTargetLibrary' },
      locked: true,
    })
  })

  it('memberPending and not_configured hide the row', () => {
    expect(
      availableOf(
        buildSyncChain(snapshot({ readAlong: readAlong({ status: 'ready', memberPending: true, outputBook: { id: 3, title: 'RA' } }) })),
        'readAlong',
      ),
    ).toBeUndefined()
    expect(availableOf(buildSyncChain(snapshot({ readAlong: readAlong({ blocked: 'not_configured' }) })), 'readAlong')).toBeUndefined()
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

  it('a detached read-along page on a linked pair offers attach on both sides', () => {
    const chain = buildSyncChain(
      snapshot({
        thisBook: 'readAlong',
        ebook: side({ book: book(1, 'E'), isMember: true }),
        readAlong: readAlong({ status: 'ready', outputBook: { id: 3, title: 'RA' } }),
      }),
    )
    expect(ids(chain)).toEqual(['card:ebook', 'connector:ebook-readAlong', 'card:readAlong', 'connector:readAlong-audiobook', 'card:audiobook'])
    for (const key of ['ebook-readAlong', 'readAlong-audiobook'] as const) {
      expect(connectorOf(chain, key)).toMatchObject({
        state: 'available',
        tone: 'muted',
        pill: { key: `${C}pill.available` },
        switch: { on: false, onAction: 'attachReadAlong', offTarget: null },
        mini: { text: { key: `${C}mini.notLinked` }, action: { id: 'attachReadAlong', label: { key: `${C}action.link` } } },
      })
    }
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
      mini: { text: null },
    })
    expect(chain.header.tone).toBe('success')
  })

  it('one way: settings link and direction note', () => {
    const row = connectorOf(buildSyncChain(snapshot({ abs: abs({ direction: 'from_abs' }) })), 'audiobook-abs')
    expect(row).toMatchObject({
      state: 'absOneWay',
      pill: { key: `${C}pill.oneWay` },
      note: { key: 'book.detail.editionLink.abs.fromAbs' },
      settingsLink: true,
    })
  })

  it('sending and checking', () => {
    expect(connectorOf(buildSyncChain(snapshot({ abs: abs({}, absLive({ status: 'sending' })) })), 'audiobook-abs').state).toBe('absSending')
    const chain = buildSyncChain(snapshot({ abs: abs({}, null, true) }))
    expect(connectorOf(chain, 'audiobook-abs').state).toBe('absLinked')
    expect(cardOf(chain, 'abs')).toMatchObject({ progress: null, progressPending: true })
  })

  it('needs review: confirm, and the panel opens in Modify', () => {
    const chain = buildSyncChain(snapshot({ abs: abs({ syncing: false, pausedReason: 'needs_review' }) }))
    expect(availableOf(chain, 'abs')).toMatchObject({
      variant: 'absNeedsReview',
      note: { key: `${C}available.abs.needsReview`, params: { library: 'Fiction' } },
      action: { id: 'confirmAbs', label: { key: `${C}action.confirm` } },
    })
    expect(chain.header.tone).toBe('success')
    expect(chain.needsAttention).toBe(true)
  })

  it('position sync off in settings', () => {
    const row = availableOf(buildSyncChain(snapshot({ abs: abs({ syncing: false, pausedReason: 'position_sync_off' }) })), 'abs')
    expect(row).toMatchObject({ variant: 'absPositionSyncOff', action: null, locked: true, settingsLink: true, present: true })
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
  it('without editLink: switches disabled, edit actions dropped, candidate locked, no search row', () => {
    const can = { editLink: false, generate: true, rebuild: true }
    const linked = buildSyncChain(snapshot({ can, alignment: alignment({ status: 'none', builtAt: null }), abs: abs() }))
    expect(connectorOf(linked, 'ebook-audiobook')).toMatchObject({ switch: { disabled: true }, actions: [], mini: { action: null } })
    expect(connectorOf(linked, 'audiobook-abs').switch?.disabled).toBe(false)
    expect(cardOf(linked, 'audiobook').change).toBe('none')

    const linking = buildSyncChain(snapshot({ can, alignment: alignment({ running: true, builtAt: null }) }))
    expect(connectorOf(linking, 'ebook-audiobook').cancel).toBeNull()

    const unlinked = buildSyncChain(
      snapshot({
        can,
        linked: false,
        ebook: side({ book: book(1, 'E'), isThisBook: true }),
        audiobook: side({ book: book(2, 'A'), match: { source: 'auto', score: 90 } }),
      }),
    )
    expect(availableOf(unlinked, 'audiobook')).toMatchObject({
      action: { id: 'linkPair', disabled: true },
      locked: true,
      secondary: null,
      expandable: false,
    })

    const noMatch = buildSyncChain(snapshot({ can, linked: false, ebook: side({ book: book(1, 'E'), isThisBook: true }), audiobook: side() }))
    expect(availableOf(noMatch, 'audiobook')).toBeUndefined()
    const searchable = buildSyncChain(snapshot({ linked: false, ebook: side({ book: book(1, 'E'), isThisBook: true }), audiobook: side() }))
    expect(availableOf(searchable, 'audiobook')).toMatchObject({
      variant: 'search',
      action: { id: 'openSearch', label: { key: `${C}action.search` } },
      expandable: true,
    })
  })

  it('without generate the idle read-along row is hidden; without rebuild the card has no Rebuild', () => {
    expect(availableOf(buildSyncChain(snapshot({ can: { editLink: true, generate: false, rebuild: true } })), 'readAlong')).toBeUndefined()
    expect(cardOf(buildSyncChain(fullChain({ can: { editLink: true, generate: true, rebuild: false } })), 'readAlong').rebuild).toBeNull()
  })

  it('without editLink a detached read-along is locked', () => {
    const row = availableOf(
      buildSyncChain(
        snapshot({
          can: { editLink: false, generate: true, rebuild: true },
          readAlong: readAlong({ status: 'ready', outputBook: { id: 3, title: 'RA' } }),
        }),
      ),
      'readAlong',
    )
    expect(row).toMatchObject({ action: { disabled: true }, locked: true })
  })
})

describe('Change on the pair cards', () => {
  it.each([
    ['member', readAlong({ member: member(3, 'RA'), status: 'ready', outputBook: { id: 3, title: 'RA' } })],
    ['detached output', readAlong({ status: 'ready', outputBook: { id: 3, title: 'RA' } })],
    ['queued', readAlong({ status: 'queued' })],
    ['building', readAlong({ status: 'building', phase: 'wait' })],
    ['failed', readAlong({ status: 'failed' })],
  ])('is blocked on both cards while a read-along exists (%s)', (_label, ra) => {
    const chain = buildSyncChain(snapshot({ thisBook: 'readAlong', ebook: side({ book: book(1, 'E'), isMember: true }), readAlong: ra }))
    expect(cardOf(chain, 'ebook').change).toBe('blocked')
    expect(cardOf(chain, 'audiobook').change).toBe('blocked')
  })

  it('is offered without a read-along and never on this book', () => {
    const chain = buildSyncChain(snapshot())
    expect(cardOf(chain, 'ebook').change).toBe('none')
    expect(cardOf(chain, 'audiobook').change).toBe('available')
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

describe('offTargetFor', () => {
  it.each([
    ['ebook', 'ebook', 'readAlong', 'readAlong'],
    ['ebook', 'readAlong', 'audiobook', 'pair'],
    ['ebook', 'ebook', 'audiobook', 'pair'],
    ['ebook', 'audiobook', 'abs', 'abs'],
    ['audiobook', 'ebook', 'readAlong', 'pair'],
    ['audiobook', 'readAlong', 'audiobook', 'readAlong'],
    ['audiobook', 'ebook', 'audiobook', 'pair'],
    ['audiobook', 'audiobook', 'abs', 'abs'],
    ['readAlong', 'ebook', 'readAlong', 'pair'],
    ['readAlong', 'readAlong', 'audiobook', 'pair'],
    ['readAlong', 'audiobook', 'abs', 'abs'],
  ] as const)('on the %s page, %s to %s turns off %s', (thisBook, from, to, expected) => {
    expect(offTargetFor(from, to, thisBook)).toBe(expected)
  })
})

describe('view mode', () => {
  it('estimates taller with more rows, with an expanded row, and in Modify than compact', () => {
    const small = buildSyncChain(snapshot({ readAlong: readAlong({ blocked: 'not_configured' }) }))
    const large = buildSyncChain(fullChain())
    const withRow = buildSyncChain(snapshot())

    expect(estimateChainHeight(large, 'modify')).toBeGreaterThan(estimateChainHeight(small, 'modify'))
    expect(estimateChainHeight(large, 'compact')).toBeGreaterThan(estimateChainHeight(small, 'compact'))
    expect(estimateChainHeight(withRow, 'modify', 'available:readAlong')).toBeGreaterThan(estimateChainHeight(withRow, 'modify'))
    for (const chain of [small, large, withRow]) expect(estimateChainHeight(chain, 'compact')).toBeLessThan(estimateChainHeight(chain, 'modify'))
  })

  it('counts notes, actions and ticks on connectors in Modify', () => {
    const plain = buildSyncChain(snapshot({ readAlong: readAlong({ blocked: 'not_configured' }) }))
    const aligning = buildSyncChain(
      snapshot({ readAlong: readAlong({ blocked: 'not_configured' }), alignment: alignment({ running: true, builtAt: null }) }),
    )
    const failed = buildSyncChain(snapshot({ readAlong: readAlong({ blocked: 'not_configured' }), alignment: alignment({ status: 'failed' }) }))
    expect(estimateChainHeight(plain, 'modify')).toBe(96 + 24 + 76 + 52 + 76)
    expect(estimateChainHeight(aligning, 'modify')).toBe(96 + 24 + 76 + 52 + 34 + 20 + 76)
    expect(estimateChainHeight(failed, 'modify')).toBe(96 + 24 + 76 + 52 + 34 + 36 + 76)
    expect(estimateChainHeight(plain, 'compact')).toBe(96 + 24 + 56 + 30 + 56)
    expect(estimateChainHeight(failed, 'compact')).toBe(96 + 24 + 56 + 34 + 56)
  })

  it('opens Modify exactly when the estimate fits or something needs attention', () => {
    const chain = buildSyncChain(snapshot())
    const height = estimateChainHeight(chain, 'modify')
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
