import { describe, expect, it } from 'vitest'
import { cardBadgeKind, cardBadgeTone } from './card-badge'

describe('cardBadgeKind', () => {
  it('folds importing into the download badge and keeps a queued request apart from it', () => {
    expect(cardBadgeKind('downloading')).toBe('downloading')
    expect(cardBadgeKind('importing')).toBe('downloading')
    expect(cardBadgeKind('queued')).toBe('requested')
  })

  it('marks a watched format that is not out yet, and leaves an unwatched one bare', () => {
    expect(cardBadgeKind('upcoming')).toBe('upcoming')
    expect(cardBadgeKind('unannounced')).toBe('upcoming')
    expect(cardBadgeKind('not_watching')).toBeNull()
  })
})

describe('cardBadgeTone', () => {
  it('outlines a waiting request on a dark backing and fills one that is moving', () => {
    const waiting = cardBadgeTone('requested')
    const moving = cardBadgeTone('downloading')

    expect(waiting).toContain('bg-black/70')
    expect(waiting).toContain('border-[var(--pill-info)]')
    expect(moving).toContain('bg-[var(--pill-info)]')
    expect(moving).not.toContain('bg-black/70')
  })

  it('tells an owned audiobook from an owned ebook', () => {
    expect(cardBadgeTone('owned', 'ebook')).toContain('--pill-format-epub')
    expect(cardBadgeTone('owned', 'audiobook')).toContain('--pill-media-audiobook')
  })

  it('takes its text colour from theme tokens, never a literal white or black', () => {
    for (const kind of ['owned', 'missing', 'requested', 'downloading', 'review', 'failed'] as const) {
      expect(cardBadgeTone(kind)).not.toMatch(/text-(white|black)/)
    }
  })
})
