import type {
  ChainCardRow,
  ChainConnectorRow,
  ChainFrame,
  ChainGhostRow,
  ChainReadAlongSlotRow,
  ChainRow,
  ChainTone,
  EditionFormat,
  EditionKey,
} from './sync-chain'

/** One rendered entry of the chain: a row as the model gives it, or a slot swapped for its in-place search. */
export type ChainViewItem =
  | { kind: 'card'; id: string; frame: ChainFrame; row: ChainCardRow }
  | { kind: 'ghost'; id: string; frame: ChainFrame; row: ChainGhostRow }
  | { kind: 'cardSearch'; id: string; frame: ChainFrame; row: ChainCardRow | ChainGhostRow; format: EditionFormat }
  | { kind: 'absSearch'; id: string; frame: ChainFrame; row: ChainCardRow | ChainGhostRow }
  | { kind: 'connector'; id: string; frame: ChainFrame; row: ChainConnectorRow }
  | { kind: 'readAlongSlot'; id: string; frame: ChainFrame; row: ChainReadAlongSlotRow }

function editionFormat(edition: EditionKey): EditionFormat | null {
  return edition === 'ebook' || edition === 'audiobook' ? edition : null
}

function slotItem(row: ChainCardRow | ChainGhostRow, changing: EditionKey | null): ChainViewItem {
  const plain: ChainViewItem =
    row.kind === 'card' ? { kind: 'card', id: row.id, frame: row.frame, row } : { kind: 'ghost', id: row.id, frame: row.frame, row }
  if (changing !== row.edition) return plain
  const format = editionFormat(row.edition)
  if (format) return { kind: 'cardSearch', id: row.id, frame: row.frame, row, format }
  return row.edition === 'abs' ? { kind: 'absSearch', id: row.id, frame: row.frame, row } : plain
}

export function chainViewItems(rows: readonly ChainRow[], changing: EditionKey | null): ChainViewItem[] {
  return rows.map((row): ChainViewItem => {
    switch (row.kind) {
      case 'card':
      case 'ghost':
        return slotItem(row, changing)
      case 'connector':
        return { kind: 'connector', id: row.id, frame: row.frame, row }
      case 'readAlongSlot':
        return { kind: 'readAlongSlot', id: row.id, frame: 'spine', row }
    }
  })
}

type ChainViewSegment = { kind: 'row'; item: ChainViewItem } | { kind: 'group'; id: string; items: ChainViewItem[] }

const AUDIO_GROUP_ID = 'group-audio'

/** Each contiguous run of `group` items becomes one box; spine items stay on their own. */
export function chainViewSegments(items: readonly ChainViewItem[]): ChainViewSegment[] {
  const segments: ChainViewSegment[] = []
  for (const item of items) {
    const last = segments[segments.length - 1]
    if (item.frame !== 'group') {
      segments.push({ kind: 'row', item })
    } else if (last?.kind === 'group') {
      last.items.push(item)
    } else {
      segments.push({ kind: 'group', id: AUDIO_GROUP_ID, items: [item] })
    }
  }
  return segments
}

/** The box mirrors the audiobook card's own chrome: primary for this book, dashed for a candidate or a ghost, else plain. */
export function groupChromeClass(items: readonly ChainViewItem[]): string {
  const row = items[0]?.row
  if (row?.kind !== 'card' || !row.linked) return 'border-dashed border-border bg-transparent'
  return row.isThisBook ? 'border-primary bg-card' : 'border-border bg-card'
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** A CSS-safe view-transition-name for a chain row, so a view switch morphs each row in place. */
export function viewTransitionName(rowId: string): string {
  return `sync-chain-${rowId.replace(/[^\w-]/g, '-')}`
}

/**
 * Applies a view change inside a View Transition when the browser offers one and the viewer welcomes motion,
 * otherwise straight away. Resolves once the DOM holds the new view, not when the animation ends.
 */
export async function transitionView(apply: () => void, flush: () => Promise<void>): Promise<void> {
  const animate =
    typeof document !== 'undefined' && typeof document.startViewTransition === 'function' && !window.matchMedia?.(REDUCED_MOTION_QUERY).matches
  if (!animate) {
    apply()
    await flush()
    return
  }
  const transition = document.startViewTransition(async () => {
    apply()
    await flush()
  })
  // A skipped transition (hidden document, another one in flight) still applies the change, so its rejection is noise.
  transition.ready.catch(() => {})
  transition.finished.catch(() => {})
  await transition.updateCallbackDone
}

/** The rail is the same colour as the switch track it runs through, so a linked chain reads as one line. */
export const TONE_LINE_CLASS: Record<ChainTone, string> = {
  success: 'border-success',
  info: 'border-info',
  warning: 'border-warning',
  destructive: 'border-destructive',
  muted: 'border-border',
}

export const TONE_PILL_CLASS: Record<ChainTone, string> = {
  success: 'bg-success/15 text-success',
  info: 'bg-info/15 text-info',
  warning: 'bg-warning/15 text-warning',
  destructive: 'bg-destructive/15 text-destructive',
  muted: 'bg-muted text-muted-foreground',
}
