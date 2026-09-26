import type { AlignmentBuildBlockReason, AlignmentStatus } from '@/features/book/composables/useReadingAlignment'

// Only a 'ready' alignment needs force: an unforced build of unchanged content is skipped as up to
// date, while a 'failed' one must resume rather than start over.
export function needsForce(status: AlignmentStatus): boolean {
  return status === 'ready'
}

// 'disabled' and 'unavailable' only change with a server config update, so there is nothing to retry.
// 'busy' clears on its own.
export function isTerminalBlock(reason: AlignmentBuildBlockReason | null): boolean {
  return reason === 'disabled' || reason === 'unavailable'
}
