import type { ChainMessage } from './sync-chain'

type Translate = (key: string, params?: Record<string, unknown>) => string

const UNKNOWN_TITLE_KEY = 'book.detail.editionLink.unknownTitle'

/** Resolves a chain line with `t`. A missing title arrives from the model as an empty string, so it is translated here. */
export function chainText(message: ChainMessage, t: Translate): string {
  const params: Record<string, unknown> = { ...message.params }
  if (params.title === '') params.title = t(UNKNOWN_TITLE_KEY)
  return t(message.key, params)
}

export function chainTitle(title: string | null, t: Translate): string {
  return title || t(UNKNOWN_TITLE_KEY)
}

/** A card's progress as a whole percentage: anything started reads at least 1%. */
export function cardProgress(value: number | null): number | null {
  if (typeof value !== 'number') return null
  if (value <= 0) return 0
  return Math.min(100, Math.max(1, Math.round(value)))
}
