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
  const verdictShows = work.verdict === 'verified' && work.flags.length === 0
  // A "kept" choice on a work the verdict already shows changes nothing, so it is not news.
  if (work.userVisibility === 'visible') return verdictShows ? null : 'kept'
  return isWorkVisible(work) ? null : 'review'
}
