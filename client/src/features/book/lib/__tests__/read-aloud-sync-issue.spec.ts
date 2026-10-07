import { describe, expect, it } from 'vitest'
import type { ReadAloudProgressSync } from '@bookorbit/types'
import { i18n } from '@/i18n'
import { describeReadAloudSyncIssue, readAloudSyncIssue } from '../read-aloud-sync-issue'

const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string

function makeSync(overrides: Partial<ReadAloudProgressSync> = {}): ReadAloudProgressSync {
  return {
    mode: 'auto',
    state: 'unavailable',
    unavailableReason: 'audio_changed',
    overlayFileId: 1,
    audioDurationSeconds: null,
    overlayDurationSeconds: null,
    durationDifferenceSeconds: null,
    durationDifferenceRatio: null,
    koreaderDownloadAvailable: false,
    narrationMismatch: null,
    offsetsSource: null,
    ...overrides,
  }
}

describe('read-aloud sync issue', () => {
  it('only flags the failures a rebuild fixes', () => {
    expect(readAloudSyncIssue(makeSync())).toBe('audio_changed')
    expect(readAloudSyncIssue(makeSync({ unavailableReason: 'narration_mismatch' }))).toBe('narration_mismatch')
    expect(readAloudSyncIssue(makeSync({ unavailableReason: 'duration_mismatch' }))).toBeNull()
    expect(readAloudSyncIssue(makeSync({ state: 'enabled', unavailableReason: null }))).toBeNull()
    expect(readAloudSyncIssue(null)).toBeNull()
  })

  it('names the narration file and chapter to the second', () => {
    const sync = makeSync({
      unavailableReason: 'narration_mismatch',
      narrationMismatch: { narrationFile: 3, narrationSeconds: 724.6, chapter: 4, chapterSeconds: 3725 },
    })

    expect(describeReadAloudSyncIssue(sync, t)).toBe("Narration does not follow this audiobook's chapters: file 3 is 12:04, chapter 4 is 1:02:05.")
  })

  it('falls back to the plain sentence without mismatch details', () => {
    expect(describeReadAloudSyncIssue(makeSync({ unavailableReason: 'narration_mismatch' }), t)).toBe(
      "Narration does not follow this audiobook's chapters.",
    )
    expect(describeReadAloudSyncIssue(makeSync(), t)).toBe('The audiobook files changed after this read-along was built.')
  })
})
