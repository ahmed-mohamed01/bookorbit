import { stageLabelKey, type ReadAloudEntryState } from '@/features/read-aloud/lib/read-aloud'
import { formatPercent } from '@/i18n/formatters'
import { clampPercent, syncIssue, syncStatus, type SyncIssueAction, type SyncStatus, type Translate } from '@/lib/sync-issue'

/**
 * The read-aloud row of the Editions card, for a book with a plain EPUB and audio and no read-along yet: what
 * upstream's generator can do for it, or the job it is running. Pure, so every state is pinned by a unit test.
 */

/** A read-aloud job the row follows: running, waiting for review, or failed and not dismissed. */
export interface ReadAloudCreateJob {
  status: 'queued' | 'processing' | 'awaiting_review' | 'failed'
  stage: string
  /** 0..100 for the current run. */
  progress: number
  queuePosition: number | null
  /** A cancel was asked for and the worker has not stopped yet. */
  stopping: boolean
  canCancel: boolean
  canRetry: boolean
  /** Upstream's error text for a failed job. */
  errorKey: string | null
}

export type ReadAloudCreatePending = 'create' | 'cancel' | 'retry' | 'other'

export interface ReadAloudCreateSlot {
  entry: ReadAloudEntryState
  job: ReadAloudCreateJob | null
  /** The job action in flight, which locks the row's buttons. */
  pending: ReadAloudCreatePending | null
  /** The last failed start or job action. */
  errorKey: string | null
}

export type ReadAloudRowVariant = 'notCreated' | 'unavailable' | 'queued' | 'processing' | 'review' | 'failed'
export type ReadAloudRowActionId = 'cancel' | 'retry' | 'review'
type RowStatus = SyncStatus<ReadAloudRowActionId>
type RowAction = SyncIssueAction<ReadAloudRowActionId>

export interface ReadAloudRow {
  variant: ReadAloudRowVariant
  status: RowStatus
  /** Create and Options. */
  create: boolean
  /** The Review button of a job waiting for review. */
  review: boolean
  /** A job action is in flight. */
  pending: ReadAloudCreatePending | null
}

const READ_ALOUD = 'book.detail.files.readAloud.'
const ROW = 'book.detail.editionLink.readAloud.'
/** Longer reasons move into the dropdown; the row keeps a truncated line. */
const LONG_REASON_CHARS = 32

function withError(status: RowStatus, slot: ReadAloudCreateSlot, t: Translate): RowStatus {
  if (!slot.errorKey) return status
  const detail = t(slot.errorKey)
  const issue = status.issue
    ? { ...status.issue, tone: 'destructive' as const, icon: 'alert' as const, detail }
    : syncIssue<ReadAloudRowActionId>({ tone: 'destructive', icon: 'alert', title: status.text, detail })
  return { ...status, issue }
}

function lock(actions: RowAction[], slot: ReadAloudCreateSlot): RowAction[] {
  return slot.pending === null ? actions : actions.map((a) => ({ ...a, disabled: true }))
}

function jobStatus(slot: ReadAloudCreateSlot, job: ReadAloudCreateJob, t: Translate): Pick<ReadAloudRow, 'variant' | 'status' | 'review'> {
  const cancel: RowAction[] = job.canCancel && !job.stopping ? [{ id: 'cancel', label: t(`${READ_ALOUD}job.cancel`) }] : []
  const running = (variant: ReadAloudRowVariant, text: string) => ({
    variant,
    review: false,
    status: syncStatus(
      text,
      'info',
      cancel.length ? syncIssue({ tone: 'info', icon: 'clock', title: text, actions: lock(cancel, slot) }) : null,
      true,
    ),
  })
  switch (job.status) {
    case 'queued':
      return running(
        'queued',
        job.stopping
          ? t(`${READ_ALOUD}job.stoppingTitle`)
          : job.queuePosition === null
            ? t(`${READ_ALOUD}job.queuedTitle`)
            : t(`${READ_ALOUD}job.queueAhead`, { count: job.queuePosition }),
      )
    case 'processing': {
      if (job.stopping) return running('processing', t(`${READ_ALOUD}job.stoppingTitle`))
      const percent = clampPercent(job.progress) ?? 0
      return running('processing', t(`${ROW}running`, { stage: t(stageLabelKey(job.stage)), percent: formatPercent(percent / 100) }))
    }
    case 'awaiting_review':
      return { variant: 'review', review: true, status: syncStatus(t(`${ROW}readyToReview`), 'success') }
    case 'failed': {
      const text = t(`${ROW}failed`)
      const actions: RowAction[] = [
        ...(job.canRetry ? [{ id: 'retry' as const, label: t(`${READ_ALOUD}job.retry`) }] : []),
        { id: 'review', label: t(`${READ_ALOUD}job.details`) },
      ]
      return {
        variant: 'failed',
        review: false,
        status: syncStatus(
          text,
          'destructive',
          syncIssue({
            tone: 'destructive',
            icon: 'alert',
            title: text,
            detail: t(job.errorKey ?? `${READ_ALOUD}errors.job.unknown`),
            actions: lock(actions, slot),
          }),
        ),
      }
    }
  }
}

/** Upstream hides its entry when the generator can never run here; a job it already holds still shows. */
export function buildReadAloudRow(slot: ReadAloudCreateSlot, t: Translate): ReadAloudRow | null {
  if (slot.job) {
    const row = jobStatus(slot, slot.job, t)
    return { ...row, status: withError(row.status, slot, t), create: false, pending: slot.pending }
  }
  const entry = slot.entry
  if (entry.kind === 'available') {
    const status: RowStatus = slot.errorKey ? syncStatus(t(`${ROW}failed`), 'destructive') : syncStatus(t(`${ROW}notCreated`), 'muted')
    return { variant: 'notCreated', status: withError(status, slot, t), create: true, review: false, pending: slot.pending }
  }
  if (entry.kind === 'unavailable' && entry.reason !== 'job_active') {
    const reason = t(entry.reasonKey)
    const issue =
      reason.length > LONG_REASON_CHARS
        ? syncIssue<ReadAloudRowActionId>({ tone: 'info', icon: 'alert', title: t(`${ROW}unavailable`), detail: reason })
        : null
    const status = syncStatus(reason, 'muted', issue)
    return { variant: 'unavailable', status: withError(status, slot, t), create: false, review: false, pending: slot.pending }
  }
  return null
}
