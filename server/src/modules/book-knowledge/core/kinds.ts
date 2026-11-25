import type { BookKnowledgeKind, BookKnowledgeKindSubtype } from '@bookorbit/types';
import { wordRarity } from './common-words';
import { CUE, isPluralSurface, KIND_LABELS } from './kind-cues';
import type { Artifact, BookMetadata, Mention, VisibleTerm } from './model';
import { termKey } from './text-utils';

export const KINDS: readonly BookKnowledgeKind[] = ['person', 'animal', 'place', 'group', 'object', 'idea', 'title'];
const LABEL_KIND: readonly BookKnowledgeKind[] = [
  'person',
  'animal',
  'place',
  'group',
  'object',
  'idea',
  'idea',
  'idea',
  'title',
  'person',
  'person',
  'idea',
];
const SUBTYPES = new Map<number, BookKnowledgeKindSubtype>([
  [KIND_LABELS.indexOf('animal or creature'), 'animal'],
  [KIND_LABELS.indexOf('god or deity'), 'god'],
  [KIND_LABELS.indexOf('spirit or supernatural being'), 'spirit'],
]);
const ANIMAL_LABEL = KIND_LABELS.indexOf('animal or creature');

export type KindRule = 'J1 metadata' | 'J4 bracket label' | 'R5 none' | 'R5 majority' | 'R2 specific' | 'R3 class';
export interface KindDecision {
  kind: BookKnowledgeKind | 'junk' | null;
  subtype: BookKnowledgeKindSubtype | null;
  rule: KindRule;
  votes: Partial<Record<BookKnowledgeKind, number>>;
  mentions: number;
}

export function metadataKeys(metadata?: BookMetadata): Set<string> {
  const keys = new Set<string>();
  for (const title of metadata?.titles ?? []) {
    keys.add(termKey(title));
    keys.add(termKey(title.replace(/^\s*(?:the|a|an)\s+/i, '')));
  }
  for (const author of metadata?.authors ?? []) {
    const parts = author.split(/\s+/).filter(Boolean);
    keys.add(termKey(parts.join(' ')));
    keys.add(termKey([...parts].reverse().join(' ')));
  }
  keys.delete('');
  return keys;
}

const isCommon = (word: string): boolean => wordRarity(word) < 1 || (word.endsWith('s') && wordRarity(word.slice(0, -1)) < 1);

export function majorityKind(votes: Partial<Record<BookKnowledgeKind, number>>): BookKnowledgeKind | null {
  const ordered = KINDS.filter((kind) => votes[kind]).sort((a, b) => votes[b]! - votes[a]! || KINDS.indexOf(a) - KINDS.indexOf(b));
  const total = ordered.reduce((sum, kind) => sum + votes[kind]!, 0);
  const top = ordered[0];
  return top && votes[top]! >= 2 && 5 * votes[top]! >= 2 * total ? top : null;
}

export function closeTopTwo(votes: Partial<Record<BookKnowledgeKind, number>>): boolean {
  const counts = KINDS.map((kind) => votes[kind] ?? 0)
    .filter(Boolean)
    .sort((a, b) => b - a);
  const total = counts.reduce((sum, count) => sum + count, 0);
  return counts.length >= 2 && counts[0] - counts[1] <= 0.1 * total;
}

// Bench P0 (kinds_v5 decide, rules J1, J4, R5, R2, R3). Only votes whose window ended by the cut-off count.
export function decideKind(
  term: Pick<VisibleTerm, 'key' | 'displayName' | 'aliases' | 'mentions'>,
  cutoff: number,
  junkKeys: Set<string>,
): KindDecision {
  const displayLower = term.displayName === term.displayName.toLowerCase() && term.displayName !== term.displayName.toUpperCase();
  const mentions: Mention[] = displayLower
    ? term.mentions.filter((m) => m.ordinal <= cutoff)
    : term.mentions.filter((m) => m.ordinal <= cutoff && /^\p{Lu}/u.test(m.alias));
  const n = mentions.length;
  const raw = new Map<number, number>();
  const votes: Partial<Record<BookKnowledgeKind, number>> = {};
  let bracket = 0;
  let classLike = 0;
  let indefinite = 0;
  let plural = 0;
  const pluralCapable =
    mentions.some((m) => (m.cues ?? 0) & CUE.plural) || [term.displayName, ...term.aliases].some((name) => isPluralSurface(name, term.key));
  for (const mention of mentions) {
    const cues = mention.cues ?? 0;
    if (cues & CUE.bracket) bracket++;
    if (cues & CUE.indefinite) indefinite++;
    if (cues & CUE.plural) plural++;
    const lowerCue = !!mention.lowercase && (!displayLower || pluralCapable);
    if (cues & (CUE.classDeterminer | CUE.plural | CUE.pluralFollower) || lowerCue) classLike++;
    if (mention.kindLabel === undefined || mention.kindAt === undefined || mention.kindAt > cutoff) continue;
    raw.set(mention.kindLabel, (raw.get(mention.kindLabel) ?? 0) + 1);
    const kind = LABEL_KIND[mention.kindLabel];
    if (kind) votes[kind] = (votes[kind] ?? 0) + 1;
  }
  const decision: KindDecision = { kind: null, subtype: null, rule: 'R5 none', votes, mentions: n };
  if (junkKeys.has(term.key)) return { ...decision, kind: 'junk', rule: 'J1 metadata' };
  if (n && bracket >= 0.6 * n && term.key.split(/[\s-]+/).every((word) => !word || isCommon(word)))
    return { ...decision, kind: 'junk', rule: 'J4 bracket label' };
  let kind = majorityKind(votes);
  if (!kind) return decision;
  decision.kind = kind;
  decision.rule = 'R5 majority';
  if (kind !== 'person' && kind !== 'animal') return decision;
  const total = [...raw.values()].reduce((sum, count) => sum + count, 0);
  const qualified = [...SUBTYPES.keys()]
    .filter((label) => (raw.get(label) ?? 0) >= 5 && (raw.get(label) ?? 0) >= 0.3 * total)
    .sort((a, b) => raw.get(b)! - raw.get(a)! || a - b);
  if (qualified.length) {
    const best = qualified[0];
    const specific = best === ANIMAL_LABEL ? 'animal' : 'person';
    if (specific !== kind) decision.rule = 'R2 specific';
    kind = specific;
    decision.kind = kind;
    decision.subtype = SUBTYPES.get(best)!;
  }
  if ((n && classLike >= 0.5 * n) || (displayLower && kind === 'person' && (indefinite > 0 || plural > 0))) {
    decision.kind = 'group';
    decision.rule = 'R3 class';
  }
  return decision;
}

const kindCache = new WeakMap<Artifact, Map<number, Map<string, KindDecision>>>();
export function termKinds(artifact: Artifact, terms: readonly VisibleTerm[], cutoff: number): Map<string, KindDecision> {
  let cache = kindCache.get(artifact);
  if (!cache) {
    cache = new Map();
    kindCache.set(artifact, cache);
  }
  const cached = cache.get(cutoff);
  if (cached && terms.every((term) => cached.has(term.key))) return cached;
  const junkKeys = metadataKeys(artifact.metadata);
  const result = cached ?? new Map<string, KindDecision>();
  for (const term of terms) if (!result.has(term.key)) result.set(term.key, decideKind(term, cutoff, junkKeys));
  cache.set(cutoff, result);
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return result;
}
