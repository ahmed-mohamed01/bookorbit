import type { ReadAlongBlockReason } from '@bookorbit/types'

// Blockers that make ticking the generate toggle pointless: they can only be cleared in the Storyteller
// settings, never by retrying. 'busy' and the pair-shaped reasons stay tickable, since linking is what
// creates the pair in the first place (the server answers 'no_pair' for every unlinked book).
export const TICK_BLOCK_REASONS: ReadonlySet<ReadAlongBlockReason> = new Set<ReadAlongBlockReason>([
  'not_configured',
  'unreachable',
  'no_target_library',
  'target_not_allowed',
  'format_not_allowed',
])

export function isTickBlockReason(reason: ReadAlongBlockReason | null): reason is ReadAlongBlockReason {
  return reason !== null && TICK_BLOCK_REASONS.has(reason)
}
