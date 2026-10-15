import { isMachineTranslationTitle, stripEditionQualifiers } from '@bookorbit/types';
import type { WebSerialKind } from '@bookorbit/types';
import { normalizeText, textScore } from '../../common/utils/text-score.utils';

export const SPIN_OFF_PENALTY = 0.5;
export const MTL_PENALTY = 0.8;
const MTL_CANONICAL_PENALTY = 0.25;
const CANONICAL_TIER = 100;

export const SPIN_OFF_MARKERS = [
  'dj',
  'doujinshi',
  'doujin',
  'colored',
  'coloured',
  'digital colored',
  'fan colored',
  'party',
  'anthology',
  'oneshot',
  'one-shot',
  'side story',
  'spin-off',
  'spinoff',
  'parody',
  'omake',
  'gaiden',
  'databook',
  'official guide',
] as const;

const MARKER_PATTERNS = SPIN_OFF_MARKERS.map((marker) => ({
  marker,
  pattern: new RegExp(`(?<![\\p{L}\\p{N}])${marker.replace(/[\s-]/g, '[\\s-]?')}(?![\\p{L}\\p{N}])`, 'iu'),
}));

function markersIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const { marker, pattern } of MARKER_PATTERNS) {
    if (pattern.test(text)) found.add(marker);
  }
  return found;
}

export function spinOffPenalty(title: string, query: string): number {
  const inTitle = markersIn(title);
  if (inTitle.size === 0) return 1;
  const inQuery = markersIn(query);
  for (const marker of inTitle) {
    if (!inQuery.has(marker)) return SPIN_OFF_PENALTY;
  }
  return 1;
}

export function relevanceScore(title: string, query: string): number {
  const base = stripEditionQualifiers(title);
  const score = textScore(base, stripEditionQualifiers(query)) * spinOffPenalty(base, query);
  return isMachineTranslationTitle(title) ? score * MTL_PENALTY : score;
}

export interface CanonicalTitleEntry {
  rank: number;
  titles: string[];
}

export type CanonicalTitles = Partial<Record<WebSerialKind, CanonicalTitleEntry[]>>;

function canonicalIndex(entries: CanonicalTitleEntry[] | undefined): Map<string, number> {
  const index = new Map<string, number>();
  for (const entry of entries ?? []) {
    for (const title of entry.titles) {
      const key = normalizeText(stripEditionQualifiers(title));
      if (key && !index.has(key)) index.set(key, entry.rank);
    }
  }
  return index;
}

/**
 * Hits matching a MangaBaka title come first in MangaBaka's order; the rest follow by text relevance, ties by original order.
 * `relevance` puts every MangaBaka match above every text-only hit so the client can merge separately searched kinds.
 */
export function rankByRelevance<T extends { title: string; kind: WebSerialKind }>(
  hits: T[],
  query: string,
  canonical: CanonicalTitles = {},
): Array<T & { relevance: number; mtl?: boolean }> {
  const indexes = { manga: canonicalIndex(canonical.manga), novel: canonicalIndex(canonical.novel) };
  return hits
    .map((hit, index) => {
      const score = relevanceScore(hit.title, query);
      const rank = indexes[hit.kind].get(normalizeText(stripEditionQualifiers(hit.title)));
      const mtl = isMachineTranslationTitle(hit.title);
      const relevance = rank === undefined ? score : CANONICAL_TIER - rank + score / 2 - (mtl ? MTL_CANONICAL_PENALTY : 0);
      return { hit, index, relevance, mtl };
    })
    .sort((left, right) => right.relevance - left.relevance || left.index - right.index)
    .map((entry) => ({ ...entry.hit, relevance: entry.relevance, ...(entry.mtl ? { mtl: true } : {}) }));
}
