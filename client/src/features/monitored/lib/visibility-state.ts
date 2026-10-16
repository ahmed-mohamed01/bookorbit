import { isWorkVisible, type MonitoredWork } from '@bookorbit/types'

/**
 * Why a work is not in its plain state, most pressing first, or null when it is. Each state has its
 * own way out, so the panel says only the one that applies.
 */
export type MonitoredVisibilityState = 'author-paused' | 'work-paused' | 'work-stopped' | 'hidden' | 'kept' | 'review'

export function monitoredVisibilityState(work: MonitoredWork, authorPaused = false): MonitoredVisibilityState | null {
  if (authorPaused) return 'author-paused'
  if (work.monitorState === 'paused') return 'work-paused'
  if (work.monitorState === 'stopped') return 'work-stopped'
  if (work.userVisibility === 'hidden') return 'hidden'
  if (work.userKind && work.userKind !== 'book') return 'review'
  const verdictShows = work.verdict === 'verified' && work.flags.length === 0
  // Keeping a work, by the Keep button or by marking it Book, changes nothing when the verdict already shows it.
  if (work.userVisibility === 'visible' || work.userKind === 'book') return verdictShows ? null : 'kept'
  return isWorkVisible(work) ? null : 'review'
}
