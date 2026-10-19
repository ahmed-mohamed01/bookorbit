import { ref, watch, type Ref } from 'vue'
import type { MonitoredReleaseCardCounts } from '@bookorbit/types'
import { storage } from '@/services/storage'
import { MONITORED_RELEASE_GROUPS, type MonitoredReleaseGroup } from '../composables/useMonitored'

export type MonitoredReleaseView = 'table' | 'cards'

function persisted<T extends string>(key: string, fallback: T, allowed: readonly T[]): Ref<T> {
  const stored = storage.get<string | null>(key, null)
  const value = ref((allowed as readonly string[]).includes(stored ?? '') ? (stored as T) : fallback) as Ref<T>
  watch(value, (next) => storage.set(key, next))
  return value
}

// Module-scoped so the sidebar badge counts releases the same way the Releases tab currently draws them.
export const releasesView = persisted<MonitoredReleaseView>('monitored:view:releases', 'table', ['table', 'cards'])
export const releaseGroup = persisted<MonitoredReleaseGroup>('monitored:releases:group', 'status', MONITORED_RELEASE_GROUPS)

/** The list draws a row per format while the cards merge a work's formats, so each view counts what it draws. */
export function releaseCount(rows: number, cards: MonitoredReleaseCardCounts): number {
  if (releasesView.value === 'table') return rows
  return releaseGroup.value === 'none' ? cards.byWork : cards.byStatus
}

/** Released means dated on or before today in UTC, the same cut the server counts cards by. */
export function isReleasedByUtcDate(releaseDate: string | null, todayUtc: string = new Date().toISOString().slice(0, 10)): boolean {
  return releaseDate !== null && releaseDate <= todayUtc
}

export type MonitoredReleaseSection = 'released' | 'upcoming' | 'undated'

export function releaseSectionOf(releaseDate: string | null, todayUtc: string = new Date().toISOString().slice(0, 10)): MonitoredReleaseSection {
  if (releaseDate === null) return 'undated'
  return isReleasedByUtcDate(releaseDate, todayUtc) ? 'released' : 'upcoming'
}
