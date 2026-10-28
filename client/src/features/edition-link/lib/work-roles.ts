import type { WorkVariant, WorkVariantRole } from '@bookorbit/types'

export const ROLE_COLOR: Record<WorkVariantRole, string> = {
  text: 'var(--pill-media-ebook)',
  audio: 'var(--pill-media-audiobook)',
  readAlong: 'var(--pill-media-ebook)',
}

/** The label a variant's chip carries: its first format, else the role's own name. */
export function variantChipCode(variant: Pick<WorkVariant, 'formats'>, fallback: string): string {
  const first = variant.formats[0]
  return first ? first.toUpperCase() : fallback
}
