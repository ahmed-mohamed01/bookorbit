import { MONITORED_WORK_SEARCH_MIN_LENGTH } from '@bookorbit/types'

export function isSearchReady(q: string): boolean {
  return [...q.trim()].length >= MONITORED_WORK_SEARCH_MIN_LENGTH
}
