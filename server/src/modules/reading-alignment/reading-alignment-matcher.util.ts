import { normalizeForMatch } from './reading-alignment-text.util';

/**
 * A single EPUB spine item's plain text, tagged with its position in the spine.
 * `text` is the ORIGINAL (un-normalized) text: the matcher normalizes internally
 * for scoring but always lifts the returned phrase verbatim from this string.
 */
export type SpineText = { spineIndex: number; text: string };

/**
 * The located anchor. `phrase` is a verbatim substring of the matched spine's
 * original `text`, extended until it occurs exactly once in that spine so the
 * client's later exact search is unambiguous. `confidence` is the Dice-based
 * similarity in [0, 1] of the best-scoring region. `null` means no region
 * cleared the confidence bar (we return null rather than a low-confidence guess).
 */
export type MatchResult = { spineIndex: number; phrase: string; confidence: number } | null;

export interface MatchOptions {
  // Inclusive spineIndex bounds (chapter-derived) the caller passes in to
  // restrict candidate spines. When absent, every spine is a candidate.
  spineWindow?: { min: number; max: number };
}

// A transcript shorter than this (in normalized words) is too weak to locate
// reliably, so we decline rather than risk a spurious anchor.
const MIN_TRANSCRIPT_WORDS = 4;
const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_PHRASE_WORDS = 8;

// The window scanner tries a few sizes around the transcript length so a dropped
// filler word or a small insertion in the book text still frames the region.
const WINDOW_SIZE_DELTA = 2;

// Blend of unigram (bag-of-words) and bigram (adjacency) Dice. Bigrams weigh
// more because word order is the stronger signal that we found the right region;
// unigrams keep the score from collapsing when a single token is substituted
// (for example whisper "mister" vs book "mr").
const UNIGRAM_WEIGHT = 0.4;
const BIGRAM_WEIGHT = 0.6;

interface SpineToken {
  norm: string;
  // Half-open [start, end) offsets into the spine's ORIGINAL text.
  start: number;
  end: number;
}

const NON_WHITESPACE = /\S+/g;

/**
 * Tokenize the ORIGINAL spine text into normalized tokens that remember where
 * they came from. Each raw whitespace-delimited chunk is normalized on its own
 * so the byte offsets of the original chunk survive; a normalized chunk that
 * splits into several words shares the chunk's span (fine, because phrase
 * lifting only uses the first and last token offsets of a region).
 */
function tokenizeWithOffsets(original: string): SpineToken[] {
  const tokens: SpineToken[] = [];
  NON_WHITESPACE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NON_WHITESPACE.exec(original)) !== null) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;
    const norm = normalizeForMatch(raw);
    if (!norm) continue;
    for (const word of norm.split(' ')) {
      if (word) tokens.push({ norm: word, start, end });
    }
  }
  return tokens;
}

function toBigrams(tokens: string[]): string[] {
  const grams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    grams.push(`${tokens[i]}\u0000${tokens[i + 1]}`);
  }
  return grams;
}

// Sorensen-Dice over two multisets: 2 * |shared| / (|a| + |b|). Counting is
// multiset-aware so repeated tokens do not over-credit.
function diceMultiset(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const item of a) counts.set(item, (counts.get(item) ?? 0) + 1);
  let shared = 0;
  for (const item of b) {
    const remaining = counts.get(item);
    if (remaining && remaining > 0) {
      shared++;
      counts.set(item, remaining - 1);
    }
  }
  return (2 * shared) / (a.length + b.length);
}

/**
 * Similarity of two token sequences in [0, 1]. A blend of unigram and bigram
 * Dice so it rewards both shared vocabulary and shared ordering. Falls back to
 * unigram-only when either side is too short to form a bigram.
 */
function similarity(a: string[], aBigrams: string[], b: string[]): number {
  const unigram = diceMultiset(a, b);
  const bBigrams = toBigrams(b);
  if (aBigrams.length === 0 || bBigrams.length === 0) return unigram;
  const bigram = diceMultiset(aBigrams, bBigrams);
  return UNIGRAM_WEIGHT * unigram + BIGRAM_WEIGHT * bigram;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    count++;
    from = at + needle.length;
  }
  return count;
}

interface BestRegion {
  spineIndex: number;
  tokens: SpineToken[];
  original: string;
  startToken: number;
  score: number;
}

function scanSpine(spine: SpineText, transcriptTokens: string[], transcriptBigrams: string[], best: BestRegion | null): BestRegion | null {
  const tokens = tokenizeWithOffsets(spine.text);
  if (tokens.length === 0) return best;

  const target = transcriptTokens.length;
  const normTokens = tokens.map((t) => t.norm);
  const sizes = new Set<number>();
  for (let d = -WINDOW_SIZE_DELTA; d <= WINDOW_SIZE_DELTA; d++) {
    const size = target + d;
    if (size >= 1 && size <= tokens.length) sizes.add(size);
  }
  if (sizes.size === 0) sizes.add(Math.min(target, tokens.length));

  let current = best;
  for (const size of sizes) {
    for (let start = 0; start + size <= normTokens.length; start++) {
      const window = normTokens.slice(start, start + size);
      const score = similarity(transcriptTokens, transcriptBigrams, window);
      // Ties resolve to the earlier spine/position already held, keeping results
      // deterministic regardless of iteration order over window sizes.
      if (!current || score > current.score) {
        current = { spineIndex: spine.spineIndex, tokens, original: spine.text, startToken: start, score };
      }
    }
  }
  return current;
}

/**
 * Lift a verbatim phrase from the matched region, then grow it until it occurs
 * exactly once in the spine's original text. It starts at the region's first
 * token spanning ~phraseWords words, extends forward, and only then extends
 * backward. If the whole spine is still ambiguous it returns the longest span
 * tried (never throws).
 */
function liftUniquePhrase(region: BestRegion, phraseWords: number): string {
  const { tokens, original, startToken } = region;
  const last = tokens.length - 1;
  let lo = startToken;
  let hi = Math.min(startToken + Math.max(1, phraseWords) - 1, last);

  const slice = (a: number, b: number): string => original.slice(tokens[a]!.start, tokens[b]!.end);

  let phrase = slice(lo, hi);
  while (countOccurrences(original, phrase) > 1) {
    if (hi < last) {
      hi++;
    } else if (lo > 0) {
      lo--;
    } else {
      break;
    }
    phrase = slice(lo, hi);
  }
  return phrase;
}

/**
 * Locate a whisper transcript inside an EPUB's spine text and return a verbatim,
 * uniquely-locatable phrase to use as an alignment anchor.
 *
 * Deterministic and total: any empty/too-short input, or no region above
 * `minConfidence`, yields null. Monotonic ordering across anchors is the
 * caller's responsibility, not this function's.
 */
export function matchTranscript(transcript: string, spines: SpineText[], opts?: MatchOptions): MatchResult {
  const transcriptTokens = normalizeForMatch(transcript ?? '')
    .split(' ')
    .filter(Boolean);
  if (transcriptTokens.length < MIN_TRANSCRIPT_WORDS) return null;
  if (!Array.isArray(spines) || spines.length === 0) return null;

  const window = opts?.spineWindow;

  const candidates = window ? spines.filter((s) => s.spineIndex >= window.min && s.spineIndex <= window.max) : spines;
  if (candidates.length === 0) return null;

  const transcriptBigrams = toBigrams(transcriptTokens);
  let best: BestRegion | null = null;
  for (const spine of candidates) {
    if (!spine || typeof spine.text !== 'string' || spine.text.length === 0) continue;
    best = scanSpine(spine, transcriptTokens, transcriptBigrams, best);
  }

  if (!best || best.score < DEFAULT_MIN_CONFIDENCE) return null;

  const phrase = liftUniquePhrase(best, DEFAULT_PHRASE_WORDS);
  if (!phrase) return null;

  return { spineIndex: best.spineIndex, phrase, confidence: best.score };
}
