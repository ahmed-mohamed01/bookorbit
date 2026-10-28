import type { EditionLinkMatch, EditionLinkMatchBucket } from '@bookorbit/types'

export const BUCKET_COLOR: Record<EditionLinkMatchBucket, string> = {
  strong: 'var(--pill-success)',
  weak: 'var(--pill-warning)',
  linked_suspect: 'var(--pill-warning)',
  conflict: 'var(--destructive)',
  linked_ok: 'var(--pill-info)',
}

export interface MatchActions {
  /** 'link' covers both a proposed link and a reviewed weak one; 'relink' replaces a suspect link. */
  primary: 'link' | 'relink' | null
  canDismiss: boolean
  canUnlink: boolean
}

export function actionsFor(match: EditionLinkMatch): MatchActions {
  const primary = match.proposedAction === 'relink' ? 'relink' : match.proposedAction === 'none' ? null : 'link'
  return { primary, canDismiss: match.bucket !== 'linked_ok', canUnlink: match.linkId !== null }
}
