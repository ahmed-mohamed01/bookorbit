import type { WebSerialKind } from '@bookorbit/types'

/** True only for a single http(s) link: anything with spaces is a title that happens to contain one. */
export function isSerialLink(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || /\s/.test(trimmed)) return false
  try {
    const url = new URL(trimmed)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.')
  } catch {
    return false
  }
}

export function formatSeriesParam(kind: WebSerialKind, matchId: string): string {
  return `${kind}:${matchId}`
}

export function parseSeriesParam(value: unknown): { kind: WebSerialKind; matchId: string } | null {
  if (typeof value !== 'string') return null
  const match = /^(manga|novel):([0-9]+)$/.exec(value)
  if (!match || (match[1] !== 'manga' && match[1] !== 'novel') || !match[2]) return null
  return { kind: match[1], matchId: match[2] }
}
