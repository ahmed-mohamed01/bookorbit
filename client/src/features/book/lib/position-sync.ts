import type { AlignmentBuildBlockReason } from '@bookorbit/types'

// 'disabled' and 'unavailable' only change with a server config update, so there is nothing to retry.
// 'busy' clears on its own.
export function isTerminalBlock(reason: AlignmentBuildBlockReason | null): boolean {
  return reason === 'disabled' || reason === 'unavailable'
}
