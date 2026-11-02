import type { EditionSyncBookListItem, EditionSyncBookSyncMode, EditionSyncDisabledReason, EditionSyncInvalidatedReason } from '@bookorbit/types'
import { clampPercent, type SyncStatus, type Translate } from '@/lib/sync-issue'
import { formatBytes } from '@/lib/formatting'
import { formatDate, formatNumber, formatPercent } from '@/i18n/formatters'
import { stageLabelKey } from '@/features/read-aloud/lib/read-aloud'
import { indexStatus } from './header-status'

/** The facts an expanded books list row shows, already worded, per index status. */

export interface BookRowDetail {
  key: string
  label: string
  value: string
}

export interface BookRowContext {
  bookSyncMode: EditionSyncBookSyncMode
  disabledReason: EditionSyncDisabledReason | null
}

type RowStatus = EditionSyncBookListItem['status']

/** Waiting for a run: queued, or indexed once but out of date. */
export function isPendingStatus(status: RowStatus): boolean {
  return status === 'queued' || status === 'stale'
}

/** Still moving through the queue, so the list keeps refreshing while such a row is on the page. */
export function isActiveStatus(status: RowStatus): boolean {
  return status === 'running' || isPendingStatus(status)
}

const BOOKS = 'editionSync.books.'
const DATE_TIME: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
const DATE: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }

const REASON_KEY: Record<EditionSyncInvalidatedReason, string> = {
  audio_changed: 'audioChanged',
  epub_changed: 'epubChanged',
  file_missing: 'fileMissing',
  files_changed: 'filesChanged',
  index_missing: 'indexMissing',
  yielded: 'yielded',
  interrupted: 'interrupted',
}

function detail(key: string, value: string, t: Translate): BookRowDetail {
  return { key, label: t(`${BOOKS}details.${key}`), value }
}

function failedDetails(item: EditionSyncBookListItem, t: Translate): BookRowDetail[] {
  const rows: BookRowDetail[] = []
  if (item.error) rows.push(detail('error', item.error, t))
  if (item.errorCode) rows.push(detail('code', item.errorCode, t))
  const attempts = item.lastAttemptAt
    ? t(`${BOOKS}values.attempts`, { count: formatNumber(item.attemptCount), when: formatDate(new Date(item.lastAttemptAt), DATE_TIME) })
    : formatNumber(item.attemptCount)
  rows.push(detail('attempts', attempts, t))
  rows.push(detail('positionSync', t(item.whisperFallback ? `${BOOKS}values.whisperFallback` : `${BOOKS}values.notAvailable`), t))
  return rows
}

function queuedDetails(item: EditionSyncBookListItem, t: Translate): BookRowDetail[] {
  const reason = item.invalidatedReason ? REASON_KEY[item.invalidatedReason] : 'notIndexed'
  const rows = [
    detail('queuedBecause', t(`${BOOKS}reasons.${reason}`), t),
    detail(
      'placeInQueue',
      item.queuePosition === null
        ? t(`${BOOKS}values.notInRunOrder`)
        : t(`${BOOKS}values.queuePlace`, { position: formatNumber(item.queuePosition) }),
      t,
    ),
  ]
  if (item.status === 'stale' && item.indexedAt) rows.push(detail('positionSync', t(`${BOOKS}values.previousIndex`), t))
  return rows
}

function runningDetails(item: EditionSyncBookListItem, t: Translate): BookRowDetail[] {
  const rows = [detail('stage', t(stageLabelKey(item.stage)), t)]
  const percent = clampPercent(item.progress)
  if (percent !== null) rows.push(detail('progress', formatPercent(percent / 100), t))
  return rows
}

function readyDetails(item: EditionSyncBookListItem, t: Translate): BookRowDetail[] {
  const rows: BookRowDetail[] = []
  if (item.sentences !== null && item.sentences > 0 && item.matchedSentences !== null) {
    rows.push(
      detail('matched', t(`${BOOKS}values.matched`, { percent: formatPercent(item.matchedSentences / item.sentences), count: item.sentences }), t),
    )
  }
  if (item.indexedAt) {
    const date = formatDate(new Date(item.indexedAt), DATE)
    rows.push(detail('indexed', item.workerVersion ? t(`${BOOKS}values.indexed`, { date, version: item.workerVersion }) : date, t))
  }
  if (item.indexBytes !== null) rows.push(detail('indexSize', formatBytes(item.indexBytes), t))
  return rows
}

function offReason(item: EditionSyncBookListItem, context: BookRowContext): string {
  if (context.disabledReason === 'user_disabled') return 'userDisabled'
  if (item.syncOverride === 'excluded') return 'excluded'
  if (context.bookSyncMode === 'selected_only' && item.syncOverride === null) return 'notSelected'
  return 'excluded'
}

export function bookRowDetails(item: EditionSyncBookListItem, context: BookRowContext, t: Translate): BookRowDetail[] {
  if (isPendingStatus(item.status)) return queuedDetails(item, t)
  switch (item.status) {
    case 'failed':
      return failedDetails(item, t)
    case 'running':
      return runningDetails(item, t)
    case 'ready':
      return readyDetails(item, t)
    case 'off':
      return [detail('why', t(`${BOOKS}offReasons.${offReason(item, context)}`), t)]
    default:
      return []
  }
}

export type BookRowActionId = 'retry' | 'run' | 'toggle'

export interface BookRowAction {
  id: BookRowActionId
  label: string
  primary: boolean
  disabled: boolean
}

export interface BookRowView {
  item: EditionSyncBookListItem
  status: SyncStatus
  problem: boolean
  details: BookRowDetail[]
  actions: BookRowAction[]
}

export interface BookRowViewContext extends BookRowContext {
  /** The Queue tab numbers rows in its own column, so the status leaves the place out. */
  onQueueTab: boolean
  /** A toggle, run or retry for this book is in flight. */
  pending: boolean
  /** The row took its status from an action and waits for the re-fetch before showing details. */
  detailsPending: boolean
  toggleOn: boolean
  canToggle: boolean
}

function bookRowActions(item: EditionSyncBookListItem, context: BookRowViewContext, t: Translate): BookRowAction[] {
  if (item.status === 'running') return []
  if (item.status === 'failed') {
    return item.canRetry ? [{ id: 'retry', label: t(`${BOOKS}actions.retry`), primary: true, disabled: context.pending }] : []
  }
  const actions: BookRowAction[] = []
  if (isPendingStatus(item.status) && item.canRunNow) {
    actions.push({ id: 'run', label: t(`${BOOKS}actions.runNext`), primary: false, disabled: context.pending })
  }
  actions.push({
    id: 'toggle',
    label: t(context.toggleOn ? `${BOOKS}actions.turnOff` : `${BOOKS}actions.turnOn`),
    primary: false,
    disabled: !context.canToggle,
  })
  return actions
}

function visibleDetails(item: EditionSyncBookListItem, context: BookRowViewContext, t: Translate): BookRowDetail[] {
  if (!context.detailsPending) return bookRowDetails(item, context, t)
  return item.status === 'running' ? runningDetails(item, t) : []
}

/** Everything one books list row shows, worded, from the list item and the page's state around it. */
export function bookRowView(item: EditionSyncBookListItem, context: BookRowViewContext, t: Translate): BookRowView {
  const status = indexStatus(
    {
      status: item.status,
      stage: item.stage,
      progress: item.progress,
      queuePosition: context.onQueueTab ? null : item.queuePosition,
      error: item.error,
      whisperFallback: item.whisperFallback,
      canRunNow: item.canRunNow,
      canRetry: item.canRetry,
      startingSoon: false,
      when: null,
    },
    context.pending,
    t,
  )
  return {
    item,
    status,
    problem: status.tone === 'warning' || status.tone === 'destructive',
    details: visibleDetails(item, context, t),
    actions: bookRowActions(item, context, t),
  }
}
