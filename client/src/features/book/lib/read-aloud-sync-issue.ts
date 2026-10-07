import type { ReadAloudProgressSync } from '@bookorbit/types'
import { formatPlaybackClock } from '@/features/podcast/lib/podcast-format'

/** The read-aloud sync failures a rebuild of the read-along fixes. */
export type ReadAloudSyncIssue = 'narration_mismatch' | 'audio_changed'

type Translate = (key: string, params?: Record<string, unknown>) => string

export function readAloudSyncIssue(sync: ReadAloudProgressSync | null | undefined): ReadAloudSyncIssue | null {
  if (!sync || sync.state !== 'unavailable') return null
  const reason = sync.unavailableReason
  return reason === 'narration_mismatch' || reason === 'audio_changed' ? reason : null
}

// A narration file and its chapter differ by seconds, so a minutes-only duration would print the same
// value on both sides of the mismatch.
export function describeReadAloudSyncIssue(sync: ReadAloudProgressSync, t: Translate): string {
  const mismatch = sync.unavailableReason === 'narration_mismatch' ? sync.narrationMismatch : null
  if (mismatch) {
    return t('book.detail.details.readAloudSync.reason.narrationMismatch', {
      file: mismatch.narrationFile,
      narration: formatPlaybackClock(mismatch.narrationSeconds),
      chapter: mismatch.chapter,
      chapterLength: formatPlaybackClock(mismatch.chapterSeconds),
    })
  }
  return t(`book.detail.details.readAloudSync.reason.${sync.unavailableReason ?? 'missing_duration'}`)
}
