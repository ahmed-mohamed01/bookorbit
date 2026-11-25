import { wordRarity } from './common-words';
import { bookIndex } from './book-index';
import type { Artifact, VisibleTerm } from './model';
import { termKey } from './text-utils';
import { modelVotedFor } from './model-votes';

export interface RankedTerm extends VisibleTerm {
  score: number;
  named: boolean;
}

const CALENDAR =
  /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)$/;
const INDEX_BOOST = 7;
const RECURRING_INDEX_BOOST = 10;
const RECURRING_INDEX_SCORE_FLOOR = 20.5;
const MODEL_VOTE_BOOST = 1.5;
const MODEL_VOTE_RARE_NOUN_FLOOR = 22;

function isNamed(term: VisibleTerm): boolean {
  const mentions = term.mentions;
  const mid = mentions.filter((mention) => mention.capitalized || mention.lowercase);
  const upperMid = mid.filter((mention) => mention.capitalized).length;
  return (
    (term.wordCount === 1 && mid.length >= 5 && upperMid / mid.length >= 0.9) ||
    (mentions.filter((mention) => /^\p{Lu}/u.test(mention.alias)).length / term.count > 0.7 &&
      (term.type !== 'concept' || upperMid > 0) &&
      (term.wordCount > 1 || mentions.filter((mention) => mention.proper).length / term.count > 0.5))
  );
}

function isJunk(term: VisibleTerm): boolean {
  if (term.wordCount !== 1) return false;
  const mentions = term.mentions;
  return (
    mentions.filter((mention) => mention.functionWord).length > term.count / 2 ||
    (CALENDAR.test(term.key) && !mentions.some((mention) => mention.person || mention.explicitDefinition))
  );
}

export function rankVisibleTerms(artifact: Artifact, visible: VisibleTerm[], cutoff: number): RankedTerm[] {
  const index = bookIndex(artifact);
  const total = Math.max(
    1,
    visible.reduce((sum, term) => sum + (term.wordCount === 1 ? term.count : 0), 0),
  );
  const ranked: RankedTerm[] = [];
  for (const term of visible) {
    if (isJunk(term)) continue;

    const named = isNamed(term);
    const mentions = term.mentions;
    const definitions = mentions.filter((mention) => mention.definition).length;
    const introduced = mentions.some((mention) => mention.introduced);
    const predominantlyAttributive =
      term.wordCount === 1 &&
      !named &&
      mentions.filter((mention) => mention.modifier).length / term.count >= 0.45 &&
      !mentions.some((mention) => mention.explicitDefinition || (mention.definition && !mention.introduced && mention.noun && !mention.nested));
    const spread = new Set(mentions.map((mention) => artifact.sentences[mention.ordinal - 1].spineIndex)).size;
    const independent = mentions.filter((mention) => !mention.nested).length;
    const rarity = named ? 1 : term.rarity;
    const frequency = Math.log1p(independent);
    const parts = term.key.split(' ');
    const specificity =
      parts.reduce((sum, word) => {
        const expected = 0.01 * Math.exp(-(named ? 1 : wordRarity(word)) * 8);
        return sum + Math.log1p(Math.max(1, independent) / (total * expected));
      }, 0) / term.wordCount;
    const coherence = Math.log2(1 + term.wordCount) * frequency;
    const indexed =
      index.size > 0 && (index.has(term.key) || index.has(termKey(term.displayName)) || term.aliases.some((alias) => index.has(termKey(alias))));
    const genericPair =
      term.wordCount === 2 &&
      !named &&
      parts.every((word) => wordRarity(word) <= 0.1) &&
      !mentions.some((mention) => mention.explicitDefinition || (mention.definition && !mention.introduced && !mention.nested)) &&
      definitions * 30 < term.count;
    let score =
      rarity * 2 +
      specificity * (term.wordCount === 1 ? 2.5 : 0.8) +
      (definitions && !genericPair ? (term.wordCount > 1 ? (introduced ? 16 : 6) : introduced ? 6 : 2) + Math.log1p(definitions) : 0) +
      coherence * 1.5 +
      (named ? Math.min(3, frequency) : 0) +
      Math.log1p(spread) * rarity -
      (term.wordCount === 1 && !named ? (1 - rarity) * 5 : 0) -
      (genericPair ? 5 : 0) -
      (predominantlyAttributive ? 10 : 0) -
      (independent === 0 ? 2 : 0);
    if (indexed) {
      score += independent >= 2 ? RECURRING_INDEX_BOOST : INDEX_BOOST;
      if (independent >= 2) {
        // A listed subject discussed independently can be significant even if its words are common.
        const chapters = new Set(mentions.filter((mention) => !mention.nested).map((mention) => artifact.sentences[mention.ordinal - 1].spineIndex));
        score = Math.max(score, RECURRING_INDEX_SCORE_FLOOR + Math.min(chapters.size, 3) * 0.5);
      }
    }
    if (modelVotedFor(artifact, term, cutoff)) {
      score += named ? 0.25 : genericPair ? 1 : MODEL_VOTE_BOOST;
      if (
        term.wordCount === 1 &&
        term.type === 'concept' &&
        !named &&
        !predominantlyAttributive &&
        term.rarity >= 0.6 &&
        mentions.filter((mention) => mention.noun && !mention.nested).length >= 2
      ) {
        score = Math.max(score, MODEL_VOTE_RARE_NOUN_FLOOR);
      }
    }
    ranked.push({ ...term, score, named });
  }
  return ranked.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}
