import type { AudiobookshelfBookSyncLive, AudiobookshelfReconcileDirection } from '@bookorbit/types'
import { AudiobookshelfReconcileError } from '@/features/audiobookshelf/api/audiobookshelf.api'
import { formatRelativeTimeFromNow } from '@/i18n/formatters'
import type { ChainActionId, ChainConnectorState } from './sync-chain'

type Translate = (key: string, params?: Record<string, unknown>) => string

const ABS = 'book.detail.editionLink.abs.'

/** 0..100 for display; rounding alone would read 100% for an unfinished item at 99.5%. */
export function displayPercentage(value: number | undefined, finished: boolean): number | null {
  if (typeof value !== 'number') return null
  if (value <= 0) return 0
  if (finished) return 100
  return Math.min(99, Math.max(1, Math.round(value)))
}

/** The hint the live status adds: when a newer position landed, and why both sides diverged. */
export function absStatusHint(live: AudiobookshelfBookSyncLive | null, t: Translate): string | null {
  switch (live?.status) {
    case 'receiving': {
      const lastUpdate = live.progress?.lastUpdate
      if (!lastUpdate) return t(`${ABS}status.receivingHint`)
      return t(`${ABS}status.receivingUpdated`, { time: formatRelativeTimeFromNow(lastUpdate, { smallestUnit: 'minute' }) })
    }
    case 'diverged': {
      const positions = t(`${ABS}status.divergedHint`, {
        abs: displayPercentage(live.progress?.percentage, live.progress?.isFinished ?? false) ?? 0,
        local: displayPercentage(live.local?.percentage, false) ?? 0,
      })
      return live.divergedReason ? `${positions} ${t(`${ABS}status.divergedReason.${live.divergedReason}`)}` : positions
    }
    default:
      return null
  }
}

/** The states whose live hint replaces the chain's static note: it carries the time or the reason. */
const LIVE_HINT_STATES = new Set<ChainConnectorState>(['absReceiving', 'absDiverged'])

export function absConnectorHint(
  state: ChainConnectorState,
  live: AudiobookshelfBookSyncLive | null,
  fallback: string | null,
  t: Translate,
): string | null {
  if (!LIVE_HINT_STATES.has(state)) return fallback
  return absStatusHint(live, t) ?? fallback
}

export type AbsReconcileActionId = Extract<ChainActionId, 'absPush' | 'absPull' | 'retryAbs'>

/** Which reconcile each chain action runs; a retry has no direction and only asks for a fresh live check. */
export const ABS_RECONCILE_ACTIONS: Record<AbsReconcileActionId, AudiobookshelfReconcileDirection | 'retry'> = {
  absPush: 'push',
  absPull: 'pull',
  retryAbs: 'retry',
}

export function isAbsReconcileAction(id: ChainActionId): id is AbsReconcileActionId {
  return id in ABS_RECONCILE_ACTIONS
}

export function reconcileFailureKey(error: unknown): string {
  const status = error instanceof AudiobookshelfReconcileError ? error.status : null
  if (status === 409) return `${ABS}reconcile.busy`
  if (status === 502) return `${ABS}reconcile.unreachable`
  return `${ABS}reconcile.failed`
}
