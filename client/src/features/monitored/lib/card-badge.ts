import type { MonitoredFormat } from '@bookorbit/types'
import type { MonitoredFormatStatus } from './format-status'

export const CARD_BADGE_KINDS = ['owned', 'missing', 'requested', 'downloading', 'review', 'failed', 'upcoming'] as const
export type CardBadgeKind = (typeof CARD_BADGE_KINDS)[number]

/** The badge a watched format wears on a card cover. A format nobody watches wears none. */
export function cardBadgeKind(status: MonitoredFormatStatus): CardBadgeKind | null {
  switch (status) {
    case 'owned':
      return 'owned'
    case 'missing':
      return 'missing'
    case 'queued':
      return 'requested'
    case 'downloading':
    case 'importing':
      return 'downloading'
    case 'needs_choice':
      return 'review'
    case 'failed':
      return 'failed'
    case 'upcoming':
    case 'unannounced':
      return 'upcoming'
    default:
      return null
  }
}

/** Solid pills sit on a cover, so their text takes the page background: dark on a light pill, light on a dark one. */
const BADGE_TONES: Record<CardBadgeKind, string> = {
  owned: 'border-transparent bg-[var(--pill-format-epub)] text-background',
  missing: 'border-dashed border-[var(--pill-warning)] bg-black/70 text-[var(--pill-warning)]',
  requested: 'border-[var(--pill-info)] bg-black/70 text-[var(--pill-info)]',
  downloading: 'border-transparent bg-[var(--pill-info)] text-background',
  review: 'border-transparent bg-[var(--pill-warning)] text-background',
  failed: 'border-transparent bg-destructive text-destructive-foreground',
  upcoming: 'border-white/30 bg-black/70 text-white',
}

const OWNED_AUDIOBOOK_TONE = 'border-transparent bg-[var(--pill-media-audiobook)] text-background'

export function cardBadgeTone(kind: CardBadgeKind, format?: MonitoredFormat): string {
  if (kind === 'owned' && format === 'audiobook') return OWNED_AUDIOBOOK_TONE
  return BADGE_TONES[kind]
}
