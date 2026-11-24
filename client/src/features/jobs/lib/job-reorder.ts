import type { JobActionKind, JobListItem } from '@bookorbit/types'

export type JobMove = 'move-up' | 'move-down'

export function isJobMove(action: JobActionKind): action is JobMove {
  return action === 'move-up' || action === 'move-down'
}

export function isEditionSyncDropAnchor(item: JobListItem): boolean {
  return item.type === 'edition-sync' && item.status === 'queued' && (item.kind === 'backlog-head' || (item.kind === null && item.position === 1))
}
