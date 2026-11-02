import { describe, expect, it } from 'vitest'
import { absDirectionExplain, buildAbsSyncRow } from '../abs-sync-row'
import { absLink, absLive, fakeT as t } from './sync-fixtures'

const ABS = 'book.detail.editionLink.abs.'
const ROW = `${ABS}row.`

describe('row state', () => {
  it('reads every paused reason and live status', () => {
    const absRowState = (link: Parameters<typeof buildAbsSyncRow>[0]['link'], live: Parameters<typeof buildAbsSyncRow>[0]['live']) =>
      buildAbsSyncRow({ link, live }, t).state
    expect(absRowState(null, null)).toBe('notMatched')
    expect(absRowState(absLink({ syncing: false, pausedReason: 'excluded' }), null)).toBe('paused')
    expect(absRowState(absLink({ syncing: false, pausedReason: null }), null)).toBe('paused')
    expect(absRowState(absLink({ syncing: false, pausedReason: 'needs_review' }), null)).toBe('needsReview')
    expect(absRowState(absLink({ syncing: false, pausedReason: 'position_sync_off' }), null)).toBe('offInSettings')
    expect(absRowState(absLink(), null)).toBe('linked')
    expect(absRowState(absLink(), absLive())).toBe('linked')
    expect(absRowState(absLink(), absLive({ status: 'unreachable' }))).toBe('unreachable')
    expect(absRowState(absLink(), absLive({ status: 'diverged' }))).toBe('diverged')
    expect(absRowState(absLink(), absLive({ status: 'receiving' }))).toBe('receiving')
    expect(absRowState(absLink(), absLive({ status: 'sending' }))).toBe('sending')
  })
})

describe('buildAbsSyncRow', () => {
  it('offers the match search from the switch when nothing is matched', () => {
    const row = buildAbsSyncRow({ link: null, live: null }, t)
    expect(row.status).toEqual({ text: `${ROW}status.notLinked`, tone: 'muted', spinner: false, issue: null })
    expect(row.toggle).toEqual({ on: false, disabled: false, action: 'match' })
    expect(row.details).toBe(false)
  })

  it('resumes a paused match from the switch, with no problem icon', () => {
    const row = buildAbsSyncRow({ link: absLink({ syncing: false, pausedReason: 'excluded' }), live: null }, t)
    expect(row.status.text).toBe(`${ROW}status.paused`)
    expect(row.status.issue).toBeNull()
    expect(row.toggle).toEqual({ on: false, disabled: false, action: 'resume' })
    expect(row.details).toBe(true)
  })

  it('asks to confirm or change a match that needs review', () => {
    const row = buildAbsSyncRow({ link: absLink({ syncing: false, pausedReason: 'needs_review' }), live: null }, t)
    expect(row.status.tone).toBe('warning')
    expect(row.status.issue).toMatchObject({ tone: 'warning', icon: 'alert', title: `${ROW}status.needsReview`, detail: `${ROW}detail.needsReview` })
    expect(row.status.issue?.actions.map((a) => a.id)).toEqual(['confirm', 'change'])
    expect(row.toggle).toEqual({ on: false, disabled: false, action: 'confirm' })
  })

  it('locks the switch and points to the settings when position sync is off there', () => {
    const row = buildAbsSyncRow({ link: absLink({ syncing: false, pausedReason: 'position_sync_off' }), live: null }, t)
    expect(row.status.text).toBe(`${ROW}status.offInSettings`)
    expect(row.status.issue).toMatchObject({ tone: 'info', actions: [] })
    expect(row.toggle).toEqual({ on: false, disabled: true, action: null })
    expect(row.settingsLink).toBe(true)
  })

  it('names the direction of a healthy match and opens its details from the status', () => {
    for (const [direction, key, title] of [
      ['two_way', 'twoWay', null],
      ['to_abs', 'oneWay', `${ROW}status.toAbs`],
      ['from_abs', 'oneWay', `${ROW}status.fromAbs`],
    ] as const) {
      const row = buildAbsSyncRow({ link: absLink({ direction }), live: absLive() }, t)
      expect(row.status).toEqual({ text: `${ROW}status.${key}`, tone: 'success', spinner: false, issue: null })
      expect(row.statusTitle).toBe(title)
      expect(row.settingsLink).toBe(direction !== 'two_way')
      expect(row.toggle).toEqual({ on: true, disabled: false, action: 'pause' })
      expect(row.details).toBe(true)
    }
  })

  it('puts the sending hint in the status title, not behind an icon', () => {
    const row = buildAbsSyncRow({ link: absLink(), live: absLive({ status: 'sending' }) }, t)
    expect(row.status.text).toBe(`${ROW}status.sending`)
    expect(row.status.issue).toBeNull()
    expect(row.statusTitle).toBe(`${ABS}status.sendingHint`)
  })

  it('keeps receiving as plain text and offers Use now in its details', () => {
    const row = buildAbsSyncRow({ link: absLink(), live: absLive({ status: 'receiving', progress: null }) }, t)
    expect(row.status).toEqual({ text: `${ROW}status.receiving`, tone: 'info', spinner: false, issue: null })
    expect(row.statusTitle).toBe(`${ABS}status.receivingHint`)
    expect(row.details).toBe(true)
    expect(row.detailActions).toEqual([{ id: 'pull', label: `${ABS}reconcile.useNow` }])
  })

  it('says which side is ahead when the two diverge, and offers both directions', () => {
    const ahead = buildAbsSyncRow(
      {
        link: absLink(),
        live: absLive({
          status: 'diverged',
          progress: { percentage: 94, isFinished: false, lastUpdate: 1 },
          local: { percentage: 91, capturedAt: 'x' },
        }),
      },
      t,
    )
    expect(ahead.status.text).toBe(`${ROW}status.ahead`)
    expect(ahead.status.issue?.detail).toBe(`${ABS}status.divergedHint{"abs":94,"local":91}`)
    expect(ahead.status.issue?.actions.map((a) => a.id)).toEqual(['pull', 'push'])

    const behind = buildAbsSyncRow(
      {
        link: absLink(),
        live: absLive({
          status: 'diverged',
          progress: { percentage: 10, isFinished: false, lastUpdate: 1 },
          local: { percentage: 91, capturedAt: 'x' },
        }),
      },
      t,
    )
    expect(behind.status.text).toBe(`${ROW}status.behind`)

    const unknown = buildAbsSyncRow({ link: absLink(), live: absLive({ status: 'diverged', progress: null, local: null }) }, t)
    expect(unknown.status.text).toBe(`${ABS}status.diverged`)
  })

  it('offers a retry when Audiobookshelf cannot be reached', () => {
    const row = buildAbsSyncRow({ link: absLink(), live: absLive({ status: 'unreachable' }) }, t)
    expect(row.status.text).toBe(`${ROW}status.unreachable`)
    expect(row.status.issue).toMatchObject({ tone: 'warning', icon: 'alert', detail: `${ROW}detail.unreachable` })
    expect(row.status.issue?.actions).toEqual([{ id: 'retry', label: `${ABS}reconcile.retry` }])
    expect(row.toggle.on).toBe(true)
  })

  it('explains each direction', () => {
    expect(absDirectionExplain(absLink({ direction: 'from_abs' }), t)).toBe(`${ROW}explain.fromAbs`)
  })
})
