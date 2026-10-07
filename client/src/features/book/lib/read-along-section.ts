import type { ReadAlongBlockReason, ReadAlongPhase, ReadAlongStatus } from '@bookorbit/types'
import type { ReadAlongSectionState } from '@/features/book/composables/useReadAlong'

export type ReadAlongSectionMode = 'offer' | 'manage' | 'readOnly'
export type ReadAlongDisplayState = 'offerOn' | 'offerOff' | 'offerExisting' | 'none' | 'queued' | 'building' | 'failed' | 'ready' | 'outOfReach'

/** Queued and building both end on their own, so both are polled and both count as a build in flight. */
export function isReadAlongInFlight(status: ReadAlongStatus): boolean {
  return status === 'building' || status === 'queued'
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

export function resolveReadAlongSectionState(
  mode: ReadAlongSectionMode,
  state: Pick<ReadAlongSectionState, 'status' | 'hasOutputBook'>,
  hasMember: boolean,
  generateOnLink: boolean,
  toggleDisabled: boolean,
): ReadAlongDisplayState {
  if (mode === 'readOnly') return 'ready'
  // A read-along built for this pair before it was unlinked rejoins it on the next link, so there is
  // nothing to generate: offering the toggle would build a second copy.
  if (mode === 'offer' && state.status === 'ready' && state.hasOutputBook) return 'offerExisting'
  if (mode === 'offer') return generateOnLink && !toggleDisabled ? 'offerOn' : 'offerOff'
  if (state.status === 'queued') return 'queued'
  if (state.status === 'building') return 'building'
  if (state.status === 'failed') return 'failed'
  if (state.status !== 'ready') return 'none'
  // A ready build the server described without its book landed in a library this user cannot open.
  // The server reports a ready build whose output was deleted as 'none' instead, which stays generatable.
  return hasMember || state.hasOutputBook ? 'ready' : 'outOfReach'
}

// 'busy' clears on its own once Storyteller frees a slot, so actions stay clickable for a retry. Every
// other reason needs a change elsewhere first, so the action is disabled instead of refused again.
export function isActionBlocked(blocked: ReadAlongBlockReason | null): boolean {
  return blocked !== null && blocked !== 'busy'
}

/** The slice of the link panel that decides whether its ready read-along can be rebuilt. */
export interface ReadAlongRebuildInputs {
  readAlongSlot: unknown
  link: unknown
  readAlongSection: { sectionState: { status: ReadAlongStatus }; canGenerate: boolean; canRebuild: boolean }
}

// A build belongs to a linked pair, so a detached read-along is rebuilt only once its pair is linked
// again, and only a read-along BookOrbit built (status ready) has a build to replace.
export function canRebuildReadAlong(panel: ReadAlongRebuildInputs): boolean {
  return (
    panel.readAlongSlot !== null &&
    panel.readAlongSection.sectionState.status === 'ready' &&
    panel.link !== null &&
    panel.readAlongSection.canGenerate &&
    panel.readAlongSection.canRebuild
  )
}
