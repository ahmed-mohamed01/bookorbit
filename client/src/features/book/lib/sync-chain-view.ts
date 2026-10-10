import type {
  ChainAvailableHeaderRow,
  ChainAvailableRow,
  ChainCardRow,
  ChainConnectorRow,
  ChainRow,
  ChainTone,
  EditionFormat,
  EditionKey,
} from './sync-chain'

/** One rendered entry of the chain: a row as the model gives it, or a card swapped for its Change search. */
type ChainViewItem =
  | { kind: 'card'; id: string; row: ChainCardRow }
  | { kind: 'cardSearch'; id: string; row: ChainCardRow; format: EditionFormat }
  | { kind: 'absSearch'; id: string; row: ChainCardRow }
  | { kind: 'connector'; id: string; row: ChainConnectorRow }
  | { kind: 'availableHeader'; id: string; row: ChainAvailableHeaderRow }
  | { kind: 'available'; id: string; row: ChainAvailableRow; searchFormat: EditionFormat | null }

function editionFormat(edition: EditionKey): EditionFormat | null {
  return edition === 'ebook' || edition === 'audiobook' ? edition : null
}

function cardItem(row: ChainCardRow, changing: EditionKey | null): ChainViewItem {
  if (changing !== row.edition) return { kind: 'card', id: row.id, row }
  const format = editionFormat(row.edition)
  if (format) return { kind: 'cardSearch', id: row.id, row, format }
  return row.edition === 'abs' ? { kind: 'absSearch', id: row.id, row } : { kind: 'card', id: row.id, row }
}

export function chainViewItems(rows: readonly ChainRow[], changing: EditionKey | null): ChainViewItem[] {
  return rows.map((row): ChainViewItem => {
    switch (row.kind) {
      case 'card':
        return cardItem(row, changing)
      case 'connector':
        return { kind: 'connector', id: row.id, row }
      case 'availableHeader':
        return { kind: 'availableHeader', id: row.id, row }
      case 'available':
        return { kind: 'available', id: row.id, row, searchFormat: editionFormat(row.edition) }
    }
  })
}

export const TONE_PILL_CLASS: Record<ChainTone, string> = {
  success: 'bg-success/15 text-success',
  info: 'bg-info/15 text-info',
  warning: 'bg-warning/15 text-warning',
  destructive: 'bg-destructive/15 text-destructive',
  muted: 'bg-muted text-muted-foreground',
}
