import { ACTIVE_WEB_SERIAL_JOB_STATUSES } from '@bookorbit/types'
import type { WebSerialJob, WebSerialJobCurrentUnit, WebSerialJobStatus } from '@bookorbit/types'

export type SerialStatusTone = 'waiting' | 'progress' | 'done' | 'warning' | 'failed' | 'stopped'

export const SERIAL_STATUS_TONES: Record<WebSerialJobStatus, SerialStatusTone> = {
  queued: 'waiting',
  paused: 'stopped',
  running: 'progress',
  importing: 'progress',
  completed: 'done',
  completed_with_gaps: 'warning',
  failed: 'failed',
  cancelled: 'stopped',
}

export function isActiveJob(job: Pick<WebSerialJob, 'status'>): boolean {
  return ACTIVE_WEB_SERIAL_JOB_STATUSES.includes(job.status)
}

/** Finished books plus the share of the one being worked on, so a single long book still moves. */
export function jobProgressPercent(job: Pick<WebSerialJob, 'unitsDone' | 'unitsSkipped' | 'unitsTotal' | 'current'>): number {
  if (job.unitsTotal <= 0) return 0
  const inFlight = job.current ? (currentUnitFraction(job.current) ?? 0) : 0
  return Math.max(0, Math.min(100, Math.round(((job.unitsDone + job.unitsSkipped + inFlight) / job.unitsTotal) * 100)))
}

/** Fraction 0..1 of the book being worked on, from chapter counts first and the engine's own figure second. */
export function currentUnitFraction(current: Pick<WebSerialJobCurrentUnit, 'chaptersDone' | 'chaptersTotal' | 'progress'>): number | null {
  const { chaptersDone, chaptersTotal, progress } = current
  const raw = chaptersDone !== null && chaptersTotal !== null && chaptersTotal > 0 ? chaptersDone / chaptersTotal : progress
  if (raw === null || !Number.isFinite(raw)) return null
  return Math.max(0, Math.min(1, raw))
}

export type SerialJobAction = 'pause' | 'resume' | 'moveToTop' | 'cancel' | 'retry' | 'remove' | 'open' | 'move'

/** Actions that sit as icon buttons in the row; the rest go in the overflow menu. */
export const INLINE_JOB_ACTIONS: readonly SerialJobAction[] = ['pause', 'resume', 'retry', 'open', 'cancel']

export function jobActions(job: Pick<WebSerialJob, 'status' | 'queuePosition' | 'kind'>): SerialJobAction[] {
  const actions = baseJobActions(job)
  if (job.kind !== 'manga' || !canMoveJob(job)) return actions
  const removeAt = actions.indexOf('remove')
  return removeAt === -1 ? [...actions, 'move'] : [...actions.slice(0, removeAt), 'move', ...actions.slice(removeAt)]
}

/** Moving needs chapters still to download, so finished and cancelled jobs have nothing to move. */
export function canMoveJob(job: Pick<WebSerialJob, 'status'>): boolean {
  return job.status !== 'completed' && job.status !== 'cancelled'
}

function baseJobActions(job: Pick<WebSerialJob, 'status' | 'queuePosition'>): SerialJobAction[] {
  switch (job.status) {
    case 'running':
    case 'importing':
      return ['pause', 'cancel']
    case 'queued':
      return job.queuePosition === 1 ? ['pause', 'cancel'] : ['moveToTop', 'pause', 'cancel']
    case 'paused':
      return ['resume', 'cancel']
    case 'failed':
    case 'completed_with_gaps':
      return ['retry', 'remove']
    case 'completed':
      return ['open', 'remove']
    default:
      return ['remove']
  }
}

export function isFinishedJob(job: Pick<WebSerialJob, 'status'>): boolean {
  return FINISHED_STATUSES.includes(job.status)
}

const FINISHED_STATUSES: readonly WebSerialJobStatus[] = ['completed', 'completed_with_gaps', 'failed', 'cancelled']
