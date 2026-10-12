import type { TtsCurrentBook } from '@/features/tts/lib/tts-state'

export interface NarrationPosition {
  fragment: string
  sectionIndex: number
}

export interface NarrationSnapshot extends NarrationPosition {
  userId: number
  book: TtsCurrentBook
  rate: number
  trackingEnabled: boolean
}

const SNAPSHOT_KEY = 'bookorbit.narration.background'
const SNAPSHOT_WRITE_INTERVAL_MS = 1000

let lastWriteAt = 0

function isSnapshot(value: unknown): value is NarrationSnapshot {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const book = v.book as Record<string, unknown> | null
  return (
    typeof v.userId === 'number' &&
    !!book &&
    typeof book.bookId === 'number' &&
    typeof book.bookFileId === 'number' &&
    typeof book.title === 'string' &&
    typeof v.fragment === 'string' &&
    Number.isInteger(v.sectionIndex) &&
    typeof v.rate === 'number' &&
    typeof v.trackingEnabled === 'boolean'
  )
}

export function readSnapshot(): NarrationSnapshot | null {
  try {
    const raw = sessionStorage.getItem(SNAPSHOT_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isSnapshot(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function clearSnapshot() {
  lastWriteAt = 0
  try {
    sessionStorage.removeItem(SNAPSHOT_KEY)
  } catch {
    // Storage can be unavailable; the dock then simply does not survive a refresh.
  }
}

// Sentences arrive faster than a snapshot is worth writing, so unforced writes are throttled.
export function writeSnapshot(snapshot: NarrationSnapshot, force = false) {
  const now = Date.now()
  if (!force && now - lastWriteAt < SNAPSHOT_WRITE_INTERVAL_MS) return
  lastWriteAt = now
  try {
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot))
  } catch {
    // Same as clearSnapshot.
  }
}
