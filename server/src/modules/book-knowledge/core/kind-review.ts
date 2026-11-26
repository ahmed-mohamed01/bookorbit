import type { BookKnowledgeXrayMode } from '@bookorbit/types';
import { wordRarity } from './common-words';
import { isGenericTerm } from './generic-terms';
import { locateAlias } from './kind-cues';
import { closeTopTwo, termKinds, type KindDecision } from './kinds';
import type { Artifact, Sentence, VisibleTerm } from './model';
import { termFragments } from './term-fragments';
import { rankTerms, type RankedTerm } from './term-ranking';
import { words } from './text-utils';

export const KIND_REVIEW_VERSION = 1;
export const KIND_REVIEW_LIMIT = 60;
export const KIND_REVIEW_BATCH = 12;
export const KIND_REVIEW_SEED = 20261119;
export const KIND_REVIEW_MAX_TOKENS = 4000;
const PROPER_NAME_LIMIT = 150;
const CONCEPT_LIMIT = 150;
/** Lowercase in-world names a novel uses at least this often are worth a review before the common-word rule drops them. */
const NAMED_TERM_MIN_MENTIONS = 3;
/** A word this rare in English reads as the book's own coinage; tagger votes and definition marks fire on common words too. */
const NAMED_TERM_RARITY = 0.5;
const NAMED_TERM_LIMIT = 40;
/**
 * The cast admits an untyped term at this many body sentences, so the review only adds terms below it: reviewing one
 * already in risks a junk answer that removes it. Mirrors `UNTYPED_MIN_SENTENCES` in the X-Ray entities.
 */
const ADMITTED_UNTYPED = 5;
const NAME_CONNECTORS = new Set('of the and in on to a an'.split(' '));
export const PLACE_NOUNS = new Set(
  'springs spring river lake sea mountains mountain hills forest woods gate gates palace camp city town village fort keep tower temple ruins road pass valley desert plains bay island isles'.split(
    ' ',
  ),
);
const PASSAGES = 3;
const PASSAGE_WORDS = 30;
export const KIND_ANSWERS = ['person', 'animal', 'place', 'group', 'object', 'idea', 'title', 'junk'] as const;
export type KindAnswer = (typeof KIND_ANSWERS)[number];

export const KIND_REVIEW_SYSTEM = [
  'You sort index entries found in a book. Classify each entry by how this text uses it, judging from the passages only, with no outside knowledge.',
  'Answers:',
  '- person: any individual character, including gods, spirits and named beings (use animal for an animal)',
  '- animal: an individual animal or creature',
  '- place',
  '- group: a kind, class, race, order, organisation or people',
  '- object',
  '- idea: a concept, skill, spell, force, system or ability',
  '- title: an honorific or rank used before or instead of a name',
  "- junk: not a real entry (an exclamation, sound, curse, generic word, system message fragment, or the book's own title or author)",
  'Reply with JSON only, one answer per id: {"<id>": "<answer>"}.',
].join('\n');

export interface KindReviewEntry {
  key: string;
  reason: 'no kind' | 'top two close' | 'proper name' | 'concept' | 'named term';
}
export interface KindReviewBatch {
  keys: string[];
  user: string;
  /** The sentences the passages are cut from, for the privacy record. */
  ordinals: number[];
}

export const isReviewCandidate = (decision: KindDecision): boolean => decision.kind === null || closeTopTwo(decision.votes);

const CHECKPOINT_SENTENCES = 300;
interface Checkpoint {
  at: number;
  cutoff: number;
}
const checkpointCache = new WeakMap<readonly Sentence[], Checkpoint[]>();
// A review checkpoint is the last body sentence before a new spine item, usable once the reader reaches that spine item,
// or every 300th body sentence inside one spine item. Nothing past the reader's position decides either kind.
export function reviewCheckpoints(sentences: readonly Sentence[]): Checkpoint[] {
  let cached = checkpointCache.get(sentences);
  if (cached) return cached;
  cached = [];
  let previous: Sentence | undefined;
  let inSpine = 0;
  for (const sentence of sentences) {
    if (sentence.structure !== 'body') continue;
    if (previous && previous.spineIndex !== sentence.spineIndex) {
      cached.push({ at: sentence.ordinal, cutoff: previous.ordinal });
      inSpine = 0;
    }
    if (++inSpine % CHECKPOINT_SENTENCES === 0) cached.push({ at: sentence.ordinal, cutoff: sentence.ordinal });
    previous = sentence;
  }
  checkpointCache.set(sentences, cached);
  return cached;
}
export function reviewCheckpoint(sentences: readonly Sentence[], cutoff: number): number {
  const checkpoints = reviewCheckpoints(sentences);
  let low = 0;
  let high = checkpoints.length - 1;
  let found = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (checkpoints[middle].at <= cutoff) {
      found = checkpoints[middle].cutoff;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/**
 * A novel's own lowercase coinages (a spell, a metal) fail the common-word rule or the untyped threshold, so they were
 * dropped unasked. One with a rare word goes to the review instead, whose answer decides; only terms that would
 * otherwise be left out are sent, so a junk answer never removes one.
 */
export function namedTermCandidates(ranked: readonly RankedTerm[], decisions: ReadonlyMap<string, KindDecision>): RankedTerm[] {
  return ranked
    .filter((term) => {
      const name = term.displayName;
      const decision = decisions.get(term.key);
      if (!decision || name !== name.toLowerCase() || /\p{Nd}/u.test(name) || term.count < NAMED_TERM_MIN_MENTIONS) return false;
      const left = isGenericTerm(name, 'fiction') || (decision.kind === null && term.count < ADMITTED_UNTYPED);
      return left && Math.max(...name.split(/[\s-]+/).map((word) => wordRarity(word))) >= NAMED_TERM_RARITY;
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, NAMED_TERM_LIMIT);
}

export function properNameCandidates(ranked: readonly RankedTerm[], decisions: ReadonlyMap<string, KindDecision>): RankedTerm[] {
  const candidates = ranked.filter((term) => {
    const name = term.displayName;
    if (
      decisions.get(term.key)?.kind !== null ||
      isGenericTerm(name, 'fiction') ||
      !/^\p{Lu}/u.test(name) ||
      (name.length > 4 && name === name.toUpperCase()) ||
      /\p{Nd}/u.test(name)
    )
      return false;
    const parts = name.split(/\s+/);
    if (parts.length >= 2 && parts.length <= 3 && parts.slice(1).every((part) => PLACE_NOUNS.has(part))) return true;
    return (
      parts.length <= 5 &&
      parts.every((part) => /^\p{Lu}/u.test(part) || NAME_CONNECTORS.has(part)) &&
      (term.named || term.mentions.some((mention) => mention.capitalized) || parts.length >= 2)
    );
  });
  const fragments = termFragments(candidates, ranked);
  return candidates.filter((term) => !fragments.has(term.key)).slice(0, PROPER_NAME_LIMIT);
}

export function conceptCandidates(
  ranked: readonly RankedTerm[],
  decisions: ReadonlyMap<string, KindDecision>,
  sentences: readonly Sentence[],
): RankedTerm[] {
  const candidates = ranked.filter((term) => {
    const name = term.displayName;
    if (decisions.get(term.key)?.kind !== null || isGenericTerm(name, 'nonfiction') || /\p{Nd}/u.test(name)) return false;
    const parts = words(name);
    if (!parts.length || parts.length > 4) return false;
    const body = term.mentions.filter(({ ordinal }) => sentences[ordinal - 1]?.structure === 'body');
    if (parts.length === 1 && !parts[0].includes('-')) return false;
    const distinct = new Set(body.map(({ ordinal }) => ordinal)).size;
    return distinct >= 2 && distinct < ADMITTED_UNTYPED;
  });
  const fragments = termFragments(candidates, ranked, false);
  return candidates.filter((term) => !fragments.has(term.key)).slice(0, CONCEPT_LIMIT);
}

export function selectForReview(
  ranked: readonly RankedTerm[],
  decisions: ReadonlyMap<string, KindDecision>,
  mode?: BookKnowledgeXrayMode,
  sentences: readonly Sentence[] = [],
): KindReviewEntry[] {
  const selected: KindReviewEntry[] = [];
  for (const term of ranked.slice(0, KIND_REVIEW_LIMIT)) {
    const decision = decisions.get(term.key);
    if (!decision) continue;
    if (decision.kind === null) selected.push({ key: term.key, reason: 'no kind' });
    else if (isReviewCandidate(decision)) selected.push({ key: term.key, reason: 'top two close' });
  }
  if (mode) {
    const seen = new Set(selected.map(({ key }) => key));
    const candidates = mode === 'fiction' ? properNameCandidates(ranked, decisions) : conceptCandidates(ranked, decisions, sentences);
    const reason = mode === 'fiction' ? 'proper name' : 'concept';
    for (const { key } of candidates) {
      if (!seen.has(key)) selected.push({ key, reason });
      seen.add(key);
    }
    if (mode === 'fiction')
      for (const { key } of namedTermCandidates(ranked, decisions)) if (!seen.has(key)) selected.push({ key, reason: 'named term' });
  }
  return selected;
}

export function planKindReview(artifact: Artifact, cutoff: number, mode: BookKnowledgeXrayMode, bodyOnly = false): KindReviewBatch[] {
  if (cutoff < 1) return [];
  const ranked = rankTerms(artifact, cutoff, bodyOnly);
  const decisions = termKinds(artifact, ranked, cutoff);
  const entries = selectForReview(ranked, decisions, mode, artifact.sentences);
  return reviewBatches(artifact, entries, new Map(ranked.map((term) => [term.key, term])), decisions, cutoff);
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(text: string): number {
  let hash = KIND_REVIEW_SEED;
  for (const character of text) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return hash >>> 0;
}

export function trimPassage(text: string, start: number, end: number): string {
  const tokens = Array.from(text.matchAll(/\S+/gu), (match) => ({ start: match.index, end: match.index + match[0].length }));
  const first = tokens.findIndex((token) => token.end > start);
  let last = first;
  tokens.forEach((token, index) => {
    if (token.start < end) last = index;
  });
  const extra = Math.max(0, PASSAGE_WORDS - (last - first + 1));
  let a = first - Math.floor(extra / 2);
  let b = last + (extra - Math.floor(extra / 2));
  if (a < 0) {
    b -= a;
    a = 0;
  }
  if (b > tokens.length - 1) {
    a = Math.max(0, a - (b - tokens.length + 1));
    b = tokens.length - 1;
  }
  return `${a > 0 ? '... ' : ''}${text.slice(tokens[a].start, tokens[b].end)}${b < tokens.length - 1 ? ' ...' : ''}`;
}

// Passages come only from the term's own mentions at or before the cut-off.
export function reviewPassages(artifact: Artifact, term: Pick<VisibleTerm, 'key' | 'displayName' | 'mentions'>, cutoff: number): string[] {
  return reviewHits(artifact, term, cutoff).map(([ordinal, alias]) => {
    const text = artifact.sentences[ordinal - 1].text.replace(/[‘’]/g, "'");
    const start = locateAlias(text, alias.replace(/[‘’]/g, "'"), 0);
    return trimPassage(text, start, start + alias.length);
  });
}

function reviewHits(artifact: Artifact, term: Pick<VisibleTerm, 'key' | 'displayName' | 'mentions'>, cutoff: number): [number, string][] {
  const capitalised = !(term.displayName === term.displayName.toLowerCase() && term.displayName !== term.displayName.toUpperCase());
  const firstHit = new Map<number, string>();
  for (const mention of term.mentions) {
    if (mention.ordinal > cutoff || (capitalised && !/^\p{Lu}/u.test(mention.alias))) continue;
    if (!firstHit.has(mention.ordinal)) firstHit.set(mention.ordinal, mention.alias);
  }
  const hits = [...firstHit].filter(([ordinal, alias]) => locateAlias(artifact.sentences[ordinal - 1]?.text ?? '', alias, 0) >= 0);
  const next = random(seedOf(term.key));
  for (let index = 0; index < Math.min(PASSAGES, hits.length); index++) {
    const swap = index + Math.floor(next() * (hits.length - index));
    [hits[index], hits[swap]] = [hits[swap], hits[index]];
  }
  return hits.slice(0, PASSAGES).sort((a, b) => a[0] - b[0]);
}

export function reviewBatches(
  artifact: Artifact,
  entries: readonly KindReviewEntry[],
  terms: Map<string, VisibleTerm>,
  decisions: Map<string, KindDecision>,
  cutoff: number,
): KindReviewBatch[] {
  const book = `Book: ${(artifact.metadata?.titles ?? []).join('; ')} by ${(artifact.metadata?.authors ?? []).join('; ')}`;
  const batches: KindReviewBatch[] = [];
  for (let start = 0; start < entries.length; start += KIND_REVIEW_BATCH) {
    const keys = entries.slice(start, start + KIND_REVIEW_BATCH).map((entry) => entry.key);
    const ordinals = new Set<number>();
    const items = keys.map((key, index) => {
      const term = terms.get(key)!;
      for (const [ordinal] of reviewHits(artifact, term, cutoff)) ordinals.add(ordinal);
      return {
        id: `e${index + 1}`,
        name: term.displayName,
        aliases: term.aliases,
        mentions: decisions.get(key)?.mentions ?? 0,
        passages: reviewPassages(artifact, term, cutoff),
      };
    });
    batches.push({ keys, user: `${book}\nEntries:\n${JSON.stringify(items, null, 1)}`, ordinals: [...ordinals].sort((a, b) => a - b) });
  }
  return batches;
}

export function parseReviewAnswers(raw: string, keys: readonly string[]): Map<string, KindAnswer> | undefined {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/g, '')
    .trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const answers = new Map<string, KindAnswer>();
  keys.forEach((key, index) => {
    const value = (data as Record<string, unknown>)[`e${index + 1}`];
    const answer = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if ((KIND_ANSWERS as readonly string[]).includes(answer)) answers.set(key, answer as KindAnswer);
  });
  return answers;
}
