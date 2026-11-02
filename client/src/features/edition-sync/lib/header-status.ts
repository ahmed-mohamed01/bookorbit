import type { EditionSyncIndexStatus, ReadAloudProgressSync, ReadAloudWorkerStage } from '@bookorbit/types'
import { clampPercent, syncIssue, syncStatus, type SyncIssueAction, type SyncStatus, type Translate } from '@/lib/sync-issue'
import { stageLabelKey } from '@/features/read-aloud/lib/read-aloud'
import { formatPercent } from '@/i18n/formatters'
import type { EditionSyncToggleKind } from './toggle-plan'

/**
 * The Editions card header's one-line sync status, left of its switch: plain text while things are normal,
 * an icon with a dropdown when there is a problem or a run that can start now. Also words the settings books list.
 */

export type EditionSyncStatusActionId = 'run' | 'retry'
type HeaderStatus = SyncStatus<EditionSyncStatusActionId>
type HeaderAction = SyncIssueAction<EditionSyncStatusActionId>

/** One book's timing index as the status needs it, from the book page's state or a books list row. */
export interface IndexStatusView {
  status: EditionSyncIndexStatus | 'off'
  stage: ReadAloudWorkerStage | null
  progress: number | null
  queuePosition: number | null
  error: string | null
  whisperFallback: boolean
  canRunNow: boolean
  canRetry: boolean
  /** A run is already starting for it: pinned or picked up by the active run. */
  startingSoon: boolean
  /** When the next scheduled run starts, already worded, such as "tonight 02:00". */
  when: string | null
}

export interface ReadAlongStatusView {
  sync: ReadAloudProgressSync
  /** Formatted durations for the mismatch copy. */
  audioDuration: string
  overlayDuration: string
  /** A second EPUB beside the read-along, which upstream keeps in step through the narration. */
  hasEpubCopy: boolean
  hasAudio: boolean
}

export interface HeaderStatusInput {
  kind: EditionSyncToggleKind
  checked: boolean
  index: IndexStatusView | null
  readAlong: ReadAlongStatusView
  /** A run-now or retry request is in flight. */
  acting: boolean
}

const STATUS = 'editionSync.status.'
const HEADER = 'editionSync.header.'
const READ_ALOUD_SYNC = 'book.detail.details.readAloudSync.'

const SHORT_REASON_KEY: Record<NonNullable<ReadAloudProgressSync['unavailableReason']>, string> = {
  duration_mismatch: 'reason.durationMismatch',
  missing_duration: 'reason.missingDuration',
  no_audio_files: 'reason.noAudioFiles',
  no_media_overlay_epub: 'reason.noMediaOverlayEpub',
}

function present(...actions: (HeaderAction | null)[]): HeaderAction[] {
  return actions.filter((a): a is HeaderAction => a !== null)
}

function runNowAction(view: IndexStatusView, acting: boolean, t: Translate): HeaderAction | null {
  return view.canRunNow && !view.startingSoon ? { id: 'run', label: t(`${STATUS}runNow`), disabled: acting } : null
}

function retryAction(view: IndexStatusView, acting: boolean, t: Translate): HeaderAction | null {
  return view.canRetry ? { id: 'retry', label: t(`${HEADER}action.retry`), disabled: acting } : null
}

function runningText(stage: ReadAloudWorkerStage | null, progress: number | null, t: Translate): string {
  const label = t(stageLabelKey(stage))
  const percent = clampPercent(progress)
  return percent === null ? label : t(`${HEADER}running`, { stage: label, percent: formatPercent(percent / 100) })
}

function queuedText(view: IndexStatusView, t: Translate): string {
  const head = view.queuePosition === null ? t(`${STATUS}queued`) : t(`${STATUS}queuedAt`, { position: view.queuePosition })
  const tail = view.startingSoon ? t(`${STATUS}startingSoon`) : view.when
  return tail ? `${head} · ${tail}` : head
}

function queuedDetail(view: IndexStatusView, t: Translate): string {
  if (view.startingSoon) return t(`${HEADER}detail.queuedSoon`)
  return view.when ? t(`${HEADER}detail.queued`, { when: view.when }) : t(`${HEADER}detail.waiting`)
}

function staleDetail(view: IndexStatusView, t: Translate): string {
  if (view.startingSoon) return t(`${HEADER}detail.staleSoon`)
  return view.when ? t(`${HEADER}detail.staleAt`, { when: view.when }) : t(`${HEADER}detail.stale`)
}

/** The timing index's status for a book with an EPUB and audio and no read-along. */
export function indexStatus(view: IndexStatusView, acting: boolean, t: Translate): HeaderStatus {
  switch (view.status) {
    case 'off':
      return syncStatus(t(`${HEADER}off`), 'muted')
    case 'ready':
      if (!view.whisperFallback) return syncStatus(t(`${HEADER}synced`), 'success')
      break
    case 'running':
      return syncStatus(runningText(view.stage, view.progress, t), 'info', null, true)
    case 'queued':
    case 'none': {
      const text = queuedText(view, t)
      const runNow = runNowAction(view, acting, t)
      if (!runNow) return syncStatus(text, 'info')
      return syncStatus(text, 'info', syncIssue({ tone: 'info', icon: 'clock', title: text, detail: queuedDetail(view, t), actions: [runNow] }))
    }
    case 'stale': {
      const text = t(`${HEADER}outOfDate`)
      return syncStatus(
        text,
        'warning',
        syncIssue({
          tone: 'warning',
          icon: 'clock',
          title: text,
          detail: staleDetail(view, t),
          actions: present(runNowAction(view, acting, t)),
        }),
      )
    }
    case 'failed':
      if (!view.whisperFallback) {
        const text = t(`${HEADER}cantIndex`)
        return syncStatus(
          text,
          'destructive',
          syncIssue({
            tone: 'destructive',
            icon: 'alert',
            title: text,
            detail: view.error || t(`${HEADER}detail.failed`),
            actions: present(retryAction(view, acting, t)),
          }),
        )
      }
      break
  }
  const text = t(`${HEADER}viaWhisper`)
  return syncStatus(
    text,
    'warning',
    syncIssue({
      tone: 'warning',
      icon: 'alert',
      title: text,
      detail: t(`${HEADER}detail.whisperFallback`),
      actions: present(retryAction(view, acting, t)),
    }),
  )
}

function readAloudReasonText(view: ReadAlongStatusView, t: Translate): string {
  const reason = view.sync.unavailableReason ?? 'missing_duration'
  if (reason === 'duration_mismatch') {
    return t(`${READ_ALOUD_SYNC}reason.durationMismatch`, { audio: view.audioDuration, overlay: view.overlayDuration })
  }
  return t(`${READ_ALOUD_SYNC}reason.${reason}`)
}

/** Upstream's "EPUB copies only": the audiobook half is unavailable, but the EPUB copies still sync. */
function syncsEpubCopiesOnly(view: ReadAlongStatusView): boolean {
  return view.sync.state === 'unavailable' && view.sync.unavailableReason !== 'no_media_overlay_epub' && view.hasEpubCopy
}

/** Upstream's read-aloud sync for a book with a read-along and audio. */
function readAlongStatus(view: ReadAlongStatusView, checked: boolean, t: Translate): HeaderStatus {
  if (!checked || view.sync.state === 'disabled') return syncStatus(t(`${HEADER}off`), 'muted')
  if (view.sync.state === 'enabled') return syncStatus(t(`${HEADER}synced`), 'success')
  // Without audio the EPUB copies are all there is to sync, so copies-only is the normal synced state.
  if (syncsEpubCopiesOnly(view) && !view.hasAudio) return syncStatus(t(`${READ_ALOUD_SYNC}state.epubCopiesOnly`), 'success')
  const reason = readAloudReasonText(view, t)
  if (syncsEpubCopiesOnly(view)) {
    const text = t(`${HEADER}epubOnly`)
    return syncStatus(
      text,
      'warning',
      syncIssue({
        tone: 'warning',
        icon: 'alert',
        title: text,
        detail: `${t(`${READ_ALOUD_SYNC}epubCopiesDescription`)} ${reason}`,
      }),
    )
  }
  const text = t(HEADER + SHORT_REASON_KEY[view.sync.unavailableReason ?? 'missing_duration'])
  return syncStatus(text, 'warning', syncIssue({ tone: 'warning', icon: 'alert', title: text, detail: reason }))
}

export function headerStatus(input: HeaderStatusInput, t: Translate): HeaderStatus | null {
  if (input.kind === 'readAlong') return readAlongStatus(input.readAlong, input.checked, t)
  if (input.kind !== 'index' || !input.index) return null
  return indexStatus(input.checked ? input.index : { ...input.index, status: 'off' }, input.acting, t)
}
