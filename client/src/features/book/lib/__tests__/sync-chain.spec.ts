// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  absLive,
  cardRow as cardOf,
  chainAbs as abs,
  chainAlignment as alignment,
  chainEdition as edition,
  chainReadAloud as readAloud,
  chainSnapshot as snapshot,
  connectorRow as connectorOf,
  ghostRow as ghostOf,
  chainReadAloudJob as job,
  chainReadAloudSlot as slot,
  readAloudSlotRow as slotOf,
} from './sync-chain-fixtures'
import { availableHeightFromTrigger, buildSyncChain, initialViewMode, type SyncChain, type SyncChainSnapshot } from '../sync-chain'

const C = 'book.detail.editionLink.chain.'
const RA = 'book.detail.details.readAloudSync.'

const readAlongFile = edition({ title: 'Book (read-along)', formatName: 'Read-aloud EPUB', progress: 12 })

const fullChain = (overrides: Partial<SyncChainSnapshot> = {}) =>
  snapshot({
    readAlong: readAlongFile,
    readAloud: readAloud(),
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

describe('rows from the book’s own files', () => {
  it('orders ebook, read-along and the audio group, joined by upstream’s two read-aloud connectors', () => {
    expect(ids(buildSyncChain(fullChain()))).toEqual([
      'card:ebook',
      'connector:ebook-readAlong',
      'card:readAlong',
      'connector:readAlong-audiobook',
      'card:audiobook',
      'connector:audiobook-abs',
      'card:abs',
    ])
  })

  it('joins the ebook to the audio through whisper only when the book has no read-along', () => {
    expect(ids(buildSyncChain(snapshot({ abs: abs() })))).toEqual([
      'card:ebook',
      'connector:ebook-audiobook',
      'card:audiobook',
      'connector:audiobook-abs',
      'card:abs',
    ])
    expect(ids(buildSyncChain(fullChain()))).not.toContain('connector:ebook-audiobook')
  })

  it('counts the plain EPUB as synced through the read-along, with no whisper alignment', () => {
    const chain = buildSyncChain(fullChain({ abs: null, alignment: alignment({ status: 'none' }) }))
    expect(connectorOf(chain, 'ebook-readAlong')).toMatchObject({
      state: 'epubCopiesSynced',
      tone: 'success',
      qualifier: { key: `${C}qualifier.direct` },
    })
    expect(chain.header.label).toEqual({ key: `${C}header.inSync`, params: { n: 3, m: 3 } })
  })

  it('draws the audiobook and Audiobookshelf rows in the group frame and everything else on the spine', () => {
    const frames = Object.fromEntries(buildSyncChain(fullChain()).rows.map((row) => [row.id, row.frame]))
    expect(frames).toEqual({
      'card:ebook': 'spine',
      'connector:ebook-readAlong': 'spine',
      'card:readAlong': 'spine',
      'connector:readAlong-audiobook': 'spine',
      'card:audiobook': 'group',
      'connector:audiobook-abs': 'group',
      'card:abs': 'group',
    })
  })

  it('describes each file with the book cover, its file name and a file summary', () => {
    const chain = buildSyncChain(
      snapshot({ audiobook: edition({ title: 'Book Part', formatName: 'MP3 audio', fileCount: 12, sizeBytes: 2048, progress: 63 }) }),
    )
    expect(cardOf(chain, 'ebook')).toMatchObject({
      cover: { kind: 'book', bookId: 7, coverVersion: 'v7' },
      title: 'Book',
      subtitle: { key: `${C}fileSummarySingle`, params: { format: 'EPUB e-book', count: 1 } },
      progress: 41,
      linked: true,
      change: false,
      chip: null,
    })
    expect(cardOf(chain, 'audiobook')).toMatchObject({
      title: 'Book Part',
      subtitle: { key: `${C}fileSummary`, params: { format: 'MP3 audio', count: 12 } },
      progress: 63,
    })
  })

  it('shows only the ebook for a book with no audio, and no connector', () => {
    const chain = buildSyncChain(snapshot({ audiobook: null, abs: abs() }))
    expect(ids(chain)).toEqual(['card:ebook'])
    expect(chain.header).toEqual({ tone: 'muted', label: { key: `${C}header.notSyncing` } })
  })

  it('shows only the audio group for an audiobook alone', () => {
    const chain = buildSyncChain(snapshot({ ebook: null, abs: abs() }))
    expect(ids(chain)).toEqual(['card:audiobook', 'connector:audiobook-abs', 'card:abs'])
    expect(chain.header.label).toEqual({ key: `${C}header.inSync`, params: { n: 2, m: 2 } })
  })

  it('joins an audiobook and its read-along without an ebook', () => {
    const chain = buildSyncChain(snapshot({ ebook: null, readAlong: readAlongFile, readAloud: readAloud() }))
    expect(ids(chain)).toEqual(['card:readAlong', 'connector:readAlong-audiobook', 'card:audiobook'])
  })

  it('joins an ebook and a read-along without audio through upstream’s EPUB copies sync', () => {
    const chain = buildSyncChain(
      snapshot({ audiobook: null, readAlong: readAlongFile, readAloud: readAloud({ state: 'unavailable', unavailableReason: 'no_audio_files' }) }),
    )
    expect(ids(chain)).toEqual(['card:ebook', 'connector:ebook-readAlong', 'card:readAlong'])
  })
})

describe('ebook to read-along: upstream’s EPUB copies only', () => {
  const copies = (overrides: Partial<SyncChainSnapshot> = {}) =>
    snapshot({
      audiobook: null,
      readAlong: readAlongFile,
      readAloud: readAloud({ state: 'unavailable', unavailableReason: 'no_audio_files', audioDurationSeconds: null }),
      ...overrides,
    })

  it('synced: the copies stay in step, with a switch that turns it off', () => {
    const chain = buildSyncChain(copies())
    expect(connectorOf(chain, 'ebook-readAlong')).toMatchObject({
      state: 'epubCopiesSynced',
      tone: 'success',
      pill: { key: `${RA}chip.enabled` },
      qualifier: { key: `${RA}state.epubCopiesOnly` },
      explainer: { key: `${RA}epubCopiesDescription` },
      switch: { on: true, disabled: false, onAction: 'enableReadAloudSync', offAction: 'disableReadAloudSync' },
    })
    expect(chain.header).toEqual({ tone: 'success', label: { key: `${C}header.inSync`, params: { n: 2, m: 2 } } })
    expect(chain.needsAttention).toBe(false)
  })

  it('off: an off switch that turns it back on', () => {
    const chain = buildSyncChain(copies({ readAloud: readAloud({ mode: 'disabled', state: 'disabled' }) }))
    expect(connectorOf(chain, 'ebook-readAlong')).toMatchObject({
      state: 'available',
      tone: 'muted',
      qualifier: { key: `${RA}chip.disabled` },
      switch: { on: false, onAction: 'enableReadAloudSync' },
    })
    expect(chain.header.label).toEqual({ key: `${C}header.notSyncing` })
  })

  it('a read-along alone has no connector', () => {
    expect(ids(buildSyncChain(copies({ ebook: null })))).toEqual(['card:readAlong'])
  })
})

describe('read-aloud slot', () => {
  const FR = 'book.detail.files.readAloud.'
  const available = slot({ entry: { kind: 'available' } })
  const withJob = (overrides: Parameters<typeof job>[0] = {}) => slot({ entry: { kind: 'hidden' }, job: job(overrides) })

  it('notCreated: Create and Modify after the audio group, behind a dashed rail', () => {
    const chain = buildSyncChain(snapshot({ readAloudSlot: available }))
    expect(ids(chain).slice(-2)).toEqual(['connector:readAlong-audiobook', 'slot:readAlong'])
    expect(slotOf(chain)).toMatchObject({
      variant: 'notCreated',
      label: { key: `${C}short.readAlong` },
      note: { key: `${C}slot.notCreated` },
      action: { id: 'createReadAloud', label: { key: `${FR}action` }, disabled: false },
      secondary: { id: 'modifyReadAloud', label: { key: `${C}modify` } },
      cancel: null,
      progress: null,
    })
    expect(connectorOf(chain, 'readAlong-audiobook')).toMatchObject({ state: 'available', tone: 'muted', switch: null })
  })

  it('notCreated: a failed start replaces the note and a start in flight locks and spins Create', () => {
    const failed = slotOf(buildSyncChain(snapshot({ readAloudSlot: slot({ entry: { kind: 'available' }, errorKey: `${FR}errors.createConflict` }) })))
    expect(failed.note).toEqual({ key: `${FR}errors.createConflict` })
    const starting = slotOf(buildSyncChain(snapshot({ readAloudSlot: slot({ entry: { kind: 'available' }, pending: 'create' }) })))
    expect(starting).toMatchObject({ pending: 'createReadAloud', action: { disabled: true }, secondary: { disabled: true } })
  })

  it('unavailable: upstream reason text and no actions', () => {
    const entry = { kind: 'unavailable' as const, reason: 'worker_unavailable' as const, reasonKey: `${FR}reasons.worker_unavailable` }
    expect(slotOf(buildSyncChain(snapshot({ readAloudSlot: slot({ entry }) })))).toMatchObject({
      variant: 'unavailable',
      note: { key: `${FR}reasons.worker_unavailable` },
      action: null,
      secondary: null,
      cancel: null,
    })
  })

  it('queued: queue position when known, a cancel and a stepper without percent', () => {
    expect(slotOf(buildSyncChain(snapshot({ readAloudSlot: withJob({ status: 'queued', stage: 'queued', queuePosition: 2 }) })))).toMatchObject({
      variant: 'queued',
      note: { key: `${FR}job.queueAhead`, params: { count: 2 } },
      cancel: { id: 'cancelReadAloud', label: { key: `${FR}job.cancel` } },
      progress: { stage: 'queued', percent: null },
    })
    expect(slotOf(buildSyncChain(snapshot({ readAloudSlot: withJob({ status: 'queued', stage: 'queued' }) }))).note).toEqual({
      key: `${FR}job.queuedTitle`,
    })
  })

  it('processing: upstream stage label, rounded percent, cancel only while it is accepted', () => {
    const chain = buildSyncChain(snapshot({ readAloudSlot: withJob() }))
    expect(slotOf(chain)).toMatchObject({
      variant: 'processing',
      note: { key: `${FR}stages.aligning` },
      action: null,
      cancel: { id: 'cancelReadAloud' },
      progress: { stage: 'aligning', percent: 42 },
    })
    expect(slotOf(buildSyncChain(snapshot({ readAloudSlot: withJob({ canCancel: false }) }))).cancel).toBeNull()
    const stopping = slotOf(buildSyncChain(snapshot({ readAloudSlot: withJob({ stopping: true }) })))
    expect(stopping).toMatchObject({ note: { key: `${FR}job.stoppingTitle` }, cancel: null })
  })

  it('review: Ready for review with Review', () => {
    expect(slotOf(buildSyncChain(snapshot({ readAloudSlot: withJob({ status: 'awaiting_review', stage: 'awaiting_review' }) })))).toMatchObject({
      variant: 'review',
      note: { key: `${FR}job.reviewTitle` },
      action: { id: 'reviewReadAloud', label: { key: `${C}action.review` } },
      cancel: null,
      progress: null,
    })
  })

  it('failed: upstream error text, Retry and Review, or Review alone when it cannot retry', () => {
    const failed = { status: 'failed' as const, errorKey: `${FR}errors.job.alignment_failed` }
    expect(slotOf(buildSyncChain(snapshot({ readAloudSlot: withJob(failed) })))).toMatchObject({
      variant: 'failed',
      note: { key: `${FR}errors.job.alignment_failed` },
      action: { id: 'retryReadAloud', label: { key: `${FR}job.retry` } },
      secondary: { id: 'reviewReadAloud' },
      cancel: null,
      progress: null,
    })
    expect(slotOf(buildSyncChain(snapshot({ readAloudSlot: withJob({ ...failed, canRetry: false }) })))).toMatchObject({
      action: { id: 'reviewReadAloud' },
      secondary: null,
    })
  })

  it('shows a running job even where upstream hides its entry', () => {
    expect(slotOf(buildSyncChain(snapshot({ readAloudSlot: withJob() }))).variant).toBe('processing')
    expect(
      slotOf(buildSyncChain(snapshot({ readAloudSlot: slot({ entry: { kind: 'unavailable', reason: 'job_active', reasonKey: 'x' }, job: job() }) })))
        .variant,
    ).toBe('processing')
  })

  it('offers nothing while upstream hides its entry and holds no job', () => {
    expect(ids(buildSyncChain(snapshot()))).not.toContain('slot:readAlong')
    expect(ids(buildSyncChain(snapshot({ readAloudSlot: slot({ entry: { kind: 'loadFailed' } }) })))).not.toContain('slot:readAlong')
    const busy = { kind: 'unavailable' as const, reason: 'job_active' as const, reasonKey: `${FR}reasons.job_active` }
    expect(ids(buildSyncChain(snapshot({ readAloudSlot: slot({ entry: busy }) })))).not.toContain('slot:readAlong')
  })

  it('never offers a second read-aloud, and needs both an EPUB and audio', () => {
    expect(ids(buildSyncChain(fullChain({ readAloudSlot: available })))).not.toContain('slot:readAlong')
    expect(ids(buildSyncChain(snapshot({ ebook: null, readAloudSlot: available })))).not.toContain('slot:readAlong')
    expect(ids(buildSyncChain(snapshot({ audiobook: null, readAloudSlot: available })))).not.toContain('slot:readAlong')
  })

  it('never counts as a synced side', () => {
    const plain = buildSyncChain(snapshot())
    for (const readAloudSlot of [available, withJob(), withJob({ status: 'failed', errorKey: 'x' })]) {
      const chain = buildSyncChain(snapshot({ readAloudSlot }))
      expect(chain.header).toEqual(plain.header)
      expect(chain.intro).toEqual(plain.intro)
      expect(chain.needsAttention).toBe(plain.needsAttention)
    }
  })

  it('a stepper makes the Modify estimate taller', () => {
    expect(modifyHeight(buildSyncChain(snapshot({ readAloudSlot: withJob() })))).toBeGreaterThan(
      modifyHeight(buildSyncChain(snapshot({ readAloudSlot: available }))),
    )
  })
})

describe('ebook to audiobook: Whisper alignment of the same book', () => {
  it('ready: linked via Whisper, no switch', () => {
    expect(connectorOf(buildSyncChain(snapshot()), 'ebook-audiobook')).toMatchObject({
      state: 'linkedViaWhisper',
      tone: 'success',
      qualifier: { key: `${C}qualifier.viaWhisper` },
      explainer: { key: `${C}explain.whisper` },
      switch: null,
    })
  })

  it('aligning: ticks and a cancel', () => {
    const row = connectorOf(
      buildSyncChain(snapshot({ alignment: alignment({ running: true, builtAt: null, samplesDone: 2, samplesTotal: 8 }) })),
      'ebook-audiobook',
    )
    expect(row).toMatchObject({
      state: 'aligning',
      tone: 'info',
      icon: 'spinner',
      pill: { key: `${C}pill.aligning` },
      note: { key: `${C}note.aligning` },
      cancel: { id: 'cancelAlignment' },
      ticks: { samplesDone: 2, samplesTotal: 8 },
    })
  })

  it('rebuilding: cancel only stops the rebuild', () => {
    const row = connectorOf(buildSyncChain(snapshot({ alignment: alignment({ status: 'building' }) })), 'ebook-audiobook')
    expect(row).toMatchObject({ state: 'rebuilding', cancel: { id: 'cancelAlignment' }, note: null })
  })

  it('failed: destructive, retry and the build error', () => {
    const chain = buildSyncChain(snapshot({ alignment: alignment({ status: 'failed', buildError: 'whisper exited' }) }))
    expect(connectorOf(chain, 'ebook-audiobook')).toMatchObject({
      state: 'alignmentFailed',
      tone: 'destructive',
      detail: 'whisper exited',
      actions: [{ id: 'retryAlignment' }],
      mini: { action: { id: 'retryAlignment' } },
    })
    expect(chain.header).toEqual({ tone: 'destructive', label: { key: `${C}header.needsAttention` } })
    expect(chain.needsAttention).toBe(true)
  })

  it('stale: out of date with a forced rebuild', () => {
    const chain = buildSyncChain(snapshot({ alignment: alignment({ stale: true }) }))
    expect(connectorOf(chain, 'ebook-audiobook')).toMatchObject({ state: 'outOfDate', actions: [{ id: 'rebuildAlignment' }] })
    expect(chain.header.tone).toBe('warning')
  })

  it('never aligned: a quiet Align now that does not flag the panel', () => {
    const chain = buildSyncChain(snapshot({ alignment: alignment({ status: 'none', builtAt: null }) }))
    expect(connectorOf(chain, 'ebook-audiobook')).toMatchObject({
      state: 'notAligned',
      tone: 'muted',
      note: { key: 'book.detail.readingAlignment.idleHint' },
      actions: [{ id: 'alignNow' }],
    })
    expect(chain.needsAttention).toBe(false)
    expect(chain.header.tone).toBe('muted')
  })

  it('busy server keeps Align now with the busy note', () => {
    const row = connectorOf(
      buildSyncChain(snapshot({ alignment: alignment({ status: 'none', builtAt: null, buildBlocked: 'busy' }) })),
      'ebook-audiobook',
    )
    expect(row).toMatchObject({ note: { key: 'book.detail.readingAlignment.buildBlocked.busy' }, actions: [{ id: 'alignNow' }] })
  })

  it('unalignable and terminal blocks offer nothing', () => {
    expect(connectorOf(buildSyncChain(snapshot({ alignment: alignment({ status: 'unalignable' }) })), 'ebook-audiobook')).toMatchObject({
      state: 'cantAlign',
      actions: [],
    })
    expect(
      connectorOf(buildSyncChain(snapshot({ alignment: alignment({ status: 'none', buildBlocked: 'disabled' }) })), 'ebook-audiobook'),
    ).toMatchObject({
      state: 'alignmentBlocked',
      note: { key: 'book.detail.readingAlignment.buildBlocked.disabled' },
      actions: [],
    })
  })

  it('drops every alignment action without the edit permission', () => {
    const chain = buildSyncChain(snapshot({ alignment: alignment({ status: 'failed' }), can: { align: false } }))
    expect(connectorOf(chain, 'ebook-audiobook')).toMatchObject({ actions: [], mini: { action: null } })
  })
})

describe('read-along to audiobook: upstream read-aloud sync', () => {
  it('enabled: synced, with a switch that turns it off', () => {
    const chain = buildSyncChain(fullChain())
    expect(connectorOf(chain, 'readAlong-audiobook')).toMatchObject({
      state: 'readAloudSynced',
      tone: 'success',
      pill: { key: `${RA}chip.enabled` },
      switch: { on: true, disabled: false, onAction: 'enableReadAloudSync', offAction: 'disableReadAloudSync' },
    })
    expect(chain.header.label).toEqual({ key: `${C}header.inSync`, params: { n: 4, m: 4 } })
  })

  it('disabled: an off switch that turns it back on', () => {
    const row = connectorOf(buildSyncChain(fullChain({ readAloud: readAloud({ mode: 'disabled', state: 'disabled' }) })), 'readAlong-audiobook')
    expect(row).toMatchObject({ state: 'available', tone: 'muted', qualifier: { key: `${RA}chip.disabled` }, switch: { on: false } })
  })

  it('partly synced: the plain EPUB still follows the read-along while the audio half carries upstream’s reason', () => {
    const chain = buildSyncChain(fullChain({ readAloud: readAloud({ state: 'unavailable', unavailableReason: 'missing_duration' }) }))
    expect(connectorOf(chain, 'ebook-readAlong')).toMatchObject({ state: 'epubCopiesSynced', tone: 'success' })
    expect(connectorOf(chain, 'readAlong-audiobook')).toMatchObject({
      state: 'readAloudIssue',
      tone: 'warning',
      note: { key: `${RA}reason.missing_duration` },
      switch: { on: true },
    })
    expect(chain.header.tone).toBe('warning')
    expect(chain.needsAttention).toBe(true)
  })

  it('partly synced without a plain EPUB: a second read-along copy keeps upstream’s partial state on the audio connector', () => {
    const chain = buildSyncChain(
      snapshot({
        ebook: null,
        readAlong: edition({ ...readAlongFile, fileCount: 2 }),
        readAloud: readAloud({ state: 'unavailable', unavailableReason: 'missing_duration' }),
      }),
    )
    expect(connectorOf(chain, 'readAlong-audiobook')).toMatchObject({
      state: 'readAloudPartial',
      tone: 'warning',
      pill: { key: `${RA}chip.partial` },
      explainer: { key: `${RA}epubCopiesDescription` },
      note: { key: `${RA}reason.missing_duration` },
      mini: { text: { key: `${RA}chip.partial` } },
    })
  })

  it('unavailable: warns with upstream’s reason and keeps the mode switch', () => {
    const chain = buildSyncChain(
      snapshot({ ebook: null, readAlong: readAlongFile, readAloud: readAloud({ state: 'unavailable', unavailableReason: 'missing_duration' }) }),
    )
    expect(connectorOf(chain, 'readAlong-audiobook')).toMatchObject({
      state: 'readAloudIssue',
      tone: 'warning',
      pill: { key: `${RA}chip.unavailable` },
      note: { key: `${RA}reason.missing_duration` },
      switch: { on: true },
    })
    expect(chain.header.tone).toBe('warning')
    expect(chain.needsAttention).toBe(true)
  })

  it('a duration mismatch names both durations', () => {
    const row = connectorOf(
      buildSyncChain(
        fullChain({
          readAloud: {
            ...readAloud({ state: 'unavailable', unavailableReason: 'duration_mismatch' }),
            audioDuration: '9h 2m',
            overlayDuration: '8h 1m',
          },
        }),
      ),
      'readAlong-audiobook',
    )
    expect(row.note).toEqual({ key: `${RA}reason.durationMismatch`, params: { audio: '9h 2m', overlay: '8h 1m' } })
  })
})

describe('Audiobookshelf', () => {
  it('unreachable: retry and settings', () => {
    const chain = buildSyncChain(snapshot({ abs: abs({}, absLive({ status: 'unreachable' })) }))
    expect(connectorOf(chain, 'audiobook-abs')).toMatchObject({
      state: 'absUnreachable',
      tone: 'warning',
      pill: { key: `${C}pill.cantReach` },
      note: { key: `${C}note.absUnreachable` },
      actions: [{ id: 'retryAbs' }],
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
    expect(row.actions.map((a) => a.id)).toEqual(['absPush', 'absPull'])
  })

  it('a syncing match: its switch pauses through the confirm', () => {
    expect(connectorOf(buildSyncChain(snapshot({ abs: abs() })), 'audiobook-abs').switch).toEqual({
      on: true,
      disabled: false,
      onAction: null,
      offAction: 'pauseAbs',
    })
  })

  it('needs review: a dashed card to confirm, a switch that confirms, and the panel opens in Modify', () => {
    const chain = buildSyncChain(snapshot({ abs: abs({ syncing: false, pausedReason: 'needs_review' }) }))
    expect(cardOf(chain, 'abs')).toMatchObject({
      linked: false,
      chip: { key: `${C}chip.needsReview` },
      confirm: { id: 'confirmAbs' },
      change: true,
      subtitle: { key: 'book.detail.editionLink.abs.library', params: { name: 'Fiction' } },
    })
    expect(connectorOf(chain, 'audiobook-abs').switch).toMatchObject({ on: false, disabled: false, onAction: 'confirmAbs' })
    expect(chain.needsAttention).toBe(true)
  })

  it('excluded: a switch that resumes sync', () => {
    const chain = buildSyncChain(snapshot({ abs: abs({ syncing: false, pausedReason: 'excluded' }) }))
    expect(connectorOf(chain, 'audiobook-abs').switch).toMatchObject({ on: false, onAction: 'resumeAbs' })
  })

  it('position sync off in settings: a ghost with a Settings link and a disabled switch', () => {
    const chain = buildSyncChain(snapshot({ abs: abs({ syncing: false, pausedReason: 'position_sync_off' }) }))
    expect(ghostOf(chain, 'abs')).toMatchObject({ settingsLink: true, action: null })
    expect(connectorOf(chain, 'audiobook-abs').switch).toMatchObject({ on: false, disabled: true })
  })

  it('no match: a Match ghost and a disabled switch', () => {
    const chain = buildSyncChain(snapshot({ abs: noAbsMatch }))
    expect(ghostOf(chain, 'abs').action).toMatchObject({ id: 'change' })
    expect(connectorOf(chain, 'audiobook-abs')).toMatchObject({ disabledReason: { key: `${C}disabled.nothingToLink` }, switch: { disabled: true } })
  })

  it('stays out of the chain without its permission or while not configured', () => {
    expect(ids(buildSyncChain(snapshot({ abs: null }))).some((id) => id.includes('abs'))).toBe(false)
    expect(ids(buildSyncChain(snapshot({ abs: { ...abs(), configured: false } }))).some((id) => id.includes('abs'))).toBe(false)
  })

  it.each([
    [0, false, 0],
    [0.2, false, 1],
    [99.6, false, 99],
    [99.6, true, 100],
  ])('card progress %s finished=%s reads %s', (percentage, isFinished, expected) => {
    const chain = buildSyncChain(snapshot({ abs: abs({}, absLive({ progress: { percentage, isFinished, lastUpdate: 1 } })) }))
    expect(cardOf(chain, 'abs').progress).toBe(expected)
  })
})

describe('header priority', () => {
  it('failure beats check-sync beats aligning', () => {
    expect(
      buildSyncChain(snapshot({ alignment: alignment({ status: 'failed' }), abs: abs({}, absLive({ status: 'unreachable' })) })).header.tone,
    ).toBe('destructive')
    const warning = snapshot({ alignment: alignment({ running: true, builtAt: null }), abs: abs({}, absLive({ status: 'unreachable' })) })
    expect(buildSyncChain(warning).header.tone).toBe('warning')
    expect(buildSyncChain(fullChain({ readAloud: readAloud({ state: 'unavailable', unavailableReason: 'missing_duration' }) })).header.tone).toBe(
      'warning',
    )
    expect(buildSyncChain(snapshot({ alignment: alignment({ running: true, builtAt: null }) })).header).toEqual({
      tone: 'info',
      label: { key: `${C}header.aligning` },
    })
  })

  it('reads the intro from whether anything syncs', () => {
    expect(buildSyncChain(snapshot()).intro).toEqual({ key: `${C}intro.synced` })
    expect(buildSyncChain(snapshot({ audiobook: null })).intro).toEqual({ key: `${C}intro.notSynced` })
  })
})

describe('view mode', () => {
  it('estimates taller with more rows', () => {
    expect(modifyHeight(buildSyncChain(fullChain()))).toBeGreaterThan(modifyHeight(buildSyncChain(snapshot())))
  })

  it('counts notes, actions and ticks on connectors', () => {
    const plain = buildSyncChain(snapshot())
    const aligning = buildSyncChain(snapshot({ alignment: alignment({ running: true, builtAt: null }) }))
    const failed = buildSyncChain(snapshot({ alignment: alignment({ status: 'failed' }) }))
    expect(modifyHeight(plain)).toBe(96 + 24 + 66 + 32 + 66)
    expect(modifyHeight(aligning)).toBe(96 + 24 + 66 + 32 + 30 + 20 + 66)
    expect(modifyHeight(failed)).toBe(96 + 24 + 66 + 32 + 30 + 32 + 66)
  })

  it('sizes the inner Audiobookshelf connector smaller than a spine connector, and a ghost as the spec does', () => {
    expect(modifyHeight(buildSyncChain(snapshot({ abs: abs() })))).toBe(96 + 24 + 66 + 32 + 66 + 28 + 66)
    expect(modifyHeight(buildSyncChain(snapshot({ abs: noAbsMatch })))).toBe(96 + 24 + 66 + 32 + 66 + 28 + 46)
  })

  it('opens Modify exactly when the estimate fits or something needs attention', () => {
    const chain = buildSyncChain(snapshot())
    const height = 96 + 24 + 66 + 32 + 66
    expect(initialViewMode(chain, height)).toBe('modify')
    expect(initialViewMode(chain, height - 1)).toBe('compact')
    expect(initialViewMode(buildSyncChain(snapshot({ alignment: alignment({ status: 'failed' }) })), 0)).toBe('modify')
  })

  it('availableHeightFromTrigger takes the taller side less padding and offset', () => {
    expect(availableHeightFromTrigger({ top: 100, bottom: 140 }, 800)).toBe(800 - 140 - 16 - 4)
    expect(availableHeightFromTrigger({ top: 700, bottom: 740 }, 800)).toBe(700 - 20)
    expect(availableHeightFromTrigger({ top: 300, bottom: 340 }, 800, 8, 0)).toBe(460 - 8)
  })
})
