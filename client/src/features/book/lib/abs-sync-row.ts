import type { AudiobookshelfBookSyncLink, AudiobookshelfBookSyncLive } from '@bookorbit/types'
import { absStatusHint, displayPercentage } from './abs-sync-status'
import { syncIssue, syncStatus, type SyncIssueAction, type SyncStatus, type Translate } from '@/lib/sync-issue'

/**
 * The Audiobookshelf row of the book page's Details list: one line of status beside a switch, with any problem
 * behind an icon whose dropdown explains it and offers the fix. Pure, so every state is pinned by a unit test.
 */

export type AbsRowState = 'notMatched' | 'paused' | 'needsReview' | 'offInSettings' | 'linked' | 'receiving' | 'sending' | 'diverged' | 'unreachable'

export type AbsRowActionId = 'confirm' | 'change' | 'pull' | 'push' | 'retry'

/** What flipping the switch runs: open the match search, resume or confirm a paused match, or ask to pause. */
export type AbsRowToggleAction = 'match' | 'resume' | 'confirm' | 'pause'

export interface AbsSyncRow {
  state: AbsRowState
  status: SyncStatus<AbsRowActionId>
  /** Hover text on the status, such as the sending hint. */
  statusTitle: string | null
  toggle: { on: boolean; disabled: boolean; action: AbsRowToggleAction | null }
  /** A matched item with no problem: the status opens a dropdown with the item's details and Change match. */
  details: boolean
  /** The dropdown links to the Audiobookshelf settings. */
  settingsLink: boolean
  /** Extra actions in the details dropdown, ahead of Change match, such as Use now while receiving. */
  detailActions: SyncIssueAction<AbsRowActionId>[]
}

export interface AbsRowInput {
  link: AudiobookshelfBookSyncLink | null
  live: AudiobookshelfBookSyncLive | null
}

const ABS = 'book.detail.editionLink.abs.'
const ROW = `${ABS}row.`

const DIRECTION_STATUS: Record<AudiobookshelfBookSyncLink['direction'], string> = {
  two_way: 'status.twoWay',
  to_abs: 'status.oneWay',
  from_abs: 'status.oneWay',
}

// One-way names its direction on hover, so the row label stays short enough for the rail.
const DIRECTION_TITLE: Record<AudiobookshelfBookSyncLink['direction'], string | null> = {
  two_way: null,
  to_abs: 'status.toAbs',
  from_abs: 'status.fromAbs',
}

const DIRECTION_EXPLAIN: Record<AudiobookshelfBookSyncLink['direction'], string> = {
  two_way: 'explain.twoWay',
  to_abs: 'explain.toAbs',
  from_abs: 'explain.fromAbs',
}

function absRowState(link: AudiobookshelfBookSyncLink | null, live: AudiobookshelfBookSyncLive | null): AbsRowState {
  if (!link) return 'notMatched'
  if (!link.syncing) {
    if (link.pausedReason === 'position_sync_off') return 'offInSettings'
    if (link.pausedReason === 'needs_review') return 'needsReview'
    return 'paused'
  }
  switch (live?.status) {
    case 'unreachable':
      return 'unreachable'
    case 'diverged':
      return 'diverged'
    case 'receiving':
      return 'receiving'
    case 'sending':
      return 'sending'
    default:
      return 'linked'
  }
}

/** Ahead or behind by the two positions; equal or unknown positions read as plainly out of sync. */
function divergedText(live: AudiobookshelfBookSyncLive | null, t: Translate): string {
  const abs = displayPercentage(live?.progress?.percentage, live?.progress?.isFinished ?? false)
  const local = displayPercentage(live?.local?.percentage, false)
  if (abs !== null && local !== null && abs > local) return t(`${ROW}status.ahead`)
  if (abs !== null && local !== null && abs < local) return t(`${ROW}status.behind`)
  return t(`${ABS}status.diverged`)
}

export function buildAbsSyncRow({ link, live }: AbsRowInput, t: Translate): AbsSyncRow {
  const state = absRowState(link, live)
  const row = (spec: Partial<AbsSyncRow> & Pick<AbsSyncRow, 'status' | 'toggle'>): AbsSyncRow => ({
    state,
    statusTitle: null,
    details: false,
    settingsLink: false,
    detailActions: [],
    ...spec,
  })
  const on = { on: true, disabled: false, action: 'pause' as const }

  switch (state) {
    case 'notMatched':
      return row({ status: syncStatus(t(`${ROW}status.notLinked`), 'muted'), toggle: { on: false, disabled: false, action: 'match' } })
    case 'paused':
      return row({ status: syncStatus(t(`${ROW}status.paused`), 'muted'), toggle: { on: false, disabled: false, action: 'resume' }, details: true })
    case 'needsReview': {
      const text = t(`${ROW}status.needsReview`)
      return row({
        status: syncStatus(
          text,
          'warning',
          syncIssue({
            tone: 'warning',
            icon: 'alert',
            title: text,
            detail: t(`${ROW}detail.needsReview`),
            actions: [
              { id: 'confirm', label: t(`${ROW}action.confirm`) },
              { id: 'change', label: t(`${ROW}action.change`), keepOpen: true },
            ],
          }),
        ),
        toggle: { on: false, disabled: false, action: 'confirm' },
      })
    }
    case 'offInSettings': {
      const text = t(`${ROW}status.offInSettings`)
      return row({
        status: syncStatus(text, 'muted', syncIssue({ tone: 'info', icon: 'alert', title: text, detail: t(`${ROW}detail.offInSettings`) })),
        toggle: { on: false, disabled: true, action: null },
        settingsLink: true,
      })
    }
    case 'linked': {
      const title = DIRECTION_TITLE[link!.direction]
      return row({
        status: syncStatus(t(ROW + DIRECTION_STATUS[link!.direction]), 'success'),
        statusTitle: title ? t(ROW + title) : null,
        toggle: on,
        details: true,
        settingsLink: link!.direction !== 'two_way',
      })
    }
    case 'sending':
      return row({
        status: syncStatus(t(`${ROW}status.sending`), 'success'),
        statusTitle: t(`${ABS}status.sendingHint`),
        toggle: on,
        details: true,
      })
    case 'receiving':
      return row({
        status: syncStatus(t(`${ROW}status.receiving`), 'info'),
        statusTitle: absStatusHint(live, t),
        toggle: on,
        details: true,
        detailActions: [{ id: 'pull', label: t(`${ABS}reconcile.useNow`) }],
      })
    case 'diverged': {
      const text = divergedText(live, t)
      return row({
        status: syncStatus(
          text,
          'warning',
          syncIssue({
            tone: 'warning',
            icon: 'alert',
            title: text,
            detail: absStatusHint(live, t),
            actions: [
              { id: 'pull', label: t(`${ROW}action.useAbs`) },
              { id: 'push', label: t(`${ROW}action.sendThis`) },
            ],
          }),
        ),
        toggle: on,
      })
    }
    case 'unreachable': {
      const text = t(`${ROW}status.unreachable`)
      return row({
        status: syncStatus(
          text,
          'warning',
          syncIssue({
            tone: 'warning',
            icon: 'alert',
            title: text,
            detail: t(`${ROW}detail.unreachable`),
            actions: [{ id: 'retry', label: t(`${ABS}reconcile.retry`) }],
          }),
        ),
        toggle: on,
        settingsLink: true,
      })
    }
  }
}

/** What a matched item's details dropdown says about how its progress travels. */
export function absDirectionExplain(link: AudiobookshelfBookSyncLink, t: Translate): string {
  return t(ROW + DIRECTION_EXPLAIN[link.direction])
}
