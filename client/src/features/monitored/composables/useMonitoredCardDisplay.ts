import { effectScope, ref, watch, type Ref } from 'vue'
import { storage } from '@/services/storage'

export const WORK_CARD_SIZE = { min: 90, max: 240, fallback: 122 }
export const CARD_GAP = { min: 4, max: 40, fallback: 16 }

export function persistedNumber(key: string, fallback: number, min: number, max: number): Ref<number> {
  const raw = Number(storage.get<number | string | null>(key, null))
  const value = ref(Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback)
  watch(value, (next) => storage.set(key, next))
  return value
}

let shared: { workCardSize: Ref<number>; cardGap: Ref<number> } | null = null

/** One book card size and gap for every watchlist grid, so the Releases tab and author pages stay in step. */
export function useMonitoredCardDisplay() {
  // A detached scope, so the saving watchers outlive whichever view happened to create them.
  shared ??= effectScope(true).run(() => ({
    workCardSize: persistedNumber('monitored:cards:size', WORK_CARD_SIZE.fallback, WORK_CARD_SIZE.min, WORK_CARD_SIZE.max),
    cardGap: persistedNumber('monitored:cards:gap', CARD_GAP.fallback, CARD_GAP.min, CARD_GAP.max),
  }))!
  return shared
}
