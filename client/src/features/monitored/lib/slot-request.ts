import { monitoredAcquisitionState, type BookRequestStatus } from '@bookorbit/types'

export const SLOT_REQUEST_KINDS = ['requested', 'searching', 'downloading', 'importing', 'review', 'failed'] as const
export type SlotRequestKind = (typeof SLOT_REQUEST_KINDS)[number]

/**
 * The one word the request button states for a format. Settled requests that are not a failure
 * (available, cancelled, rejected) read as no request at all, so the button offers a new one.
 */
export function slotRequestKind(status: BookRequestStatus | null | undefined, optimistic = false): SlotRequestKind | null {
  const acquisition = monitoredAcquisitionState(status)
  if (acquisition === 'downloading') return 'downloading'
  if (acquisition === 'moving') return 'importing'
  if (acquisition === 'needs_review') return 'review'
  if (acquisition === 'queued') {
    if (status === 'pending') return 'requested'
    return status === 'grabbed' ? 'downloading' : 'searching'
  }
  if (status === 'failed') return 'failed'
  return optimistic ? 'requested' : null
}
