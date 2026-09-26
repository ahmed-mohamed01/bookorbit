import type { ReadAlongBlockReason, ReadAlongPhase } from '@bookorbit/types'
import type { ReadAlongSectionState } from '@/features/book/composables/useReadAlong'

export type ReadAlongSectionMode = 'offer' | 'manage' | 'readOnly'
export type ReadAlongDisplayState = 'offerOn' | 'offerOff' | 'none' | 'building' | 'failed' | 'ready' | 'outOfReach'

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
  if (mode === 'offer') return generateOnLink && !toggleDisabled ? 'offerOn' : 'offerOff'
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
