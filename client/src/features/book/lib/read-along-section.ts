import type { ReadAlongBlockReason, ReadAlongPhase, ReadAlongStatus } from '@bookorbit/types'

/** Queued and building both end on their own, so both are polled and both count as a build in flight. */
export function isReadAlongInFlight(status: ReadAlongStatus): boolean {
  return status === 'building' || status === 'queued'
}

/** The four build stages a read-along job moves through, in order. */
export const READ_ALONG_STAGES = ['sending', 'transcribing', 'aligning', 'importing'] as const
export type ReadAlongStage = (typeof READ_ALONG_STAGES)[number]

export const READ_ALONG_STAGE_KEYS: Record<ReadAlongStage, string> = {
  sending: 'book.detail.editionLink.readAlong.stages.sending',
  transcribing: 'book.detail.editionLink.readAlong.stages.transcribing',
  aligning: 'book.detail.editionLink.readAlong.stages.aligning',
  importing: 'book.detail.editionLink.readAlong.stages.importing',
}

export function isReadAlongStage(value: unknown): value is ReadAlongStage {
  return typeof value === 'string' && (READ_ALONG_STAGES as readonly string[]).includes(value)
}

/** Index into the four build stages (Sending, Transcribing, Aligning, Importing). Any Storyteller task other than syncing counts as transcription. */
export function stageIndex(phase: ReadAlongPhase | null, remoteTask: string | null): number {
  switch (phase) {
    case 'wait':
      return remoteTask?.toUpperCase() === 'SYNC_CHAPTERS' ? 2 : 1
    case 'collect':
    case 'link':
      return 3
    default:
      return 0
  }
}

// 'busy' clears on its own once Storyteller frees a slot, so actions stay clickable for a retry. Every
// other reason needs a change elsewhere first, so the action is disabled instead of refused again.
export function isActionBlocked(blocked: ReadAlongBlockReason | null): boolean {
  return blocked !== null && blocked !== 'busy'
}

export type ReadAlongStepState = 'done' | 'current' | 'todo'

export interface ReadAlongStep {
  stage: ReadAlongStage
  key: string
  state: ReadAlongStepState
}

export function readAlongSteps(currentStage: number): ReadAlongStep[] {
  return READ_ALONG_STAGES.map((stage, index) => ({
    stage,
    key: READ_ALONG_STAGE_KEYS[stage],
    state: index < currentStage ? 'done' : index === currentStage ? 'current' : 'todo',
  }))
}

// Storyteller only reports its own progress while it transcribes and aligns.
const REPORTING_STAGES = new Set([1, 2])

/** Storyteller's own progress as a whole percentage, or null outside the stages that report one. */
export function readAlongPercent(currentStage: number, remoteProgress: number | null): number | null {
  if (!REPORTING_STAGES.has(currentStage) || typeof remoteProgress !== 'number' || Number.isNaN(remoteProgress)) return null
  return Math.min(100, Math.max(0, Math.round(remoteProgress * 100)))
}
