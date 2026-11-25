import { wordRarity } from './common-words';
import type { Artifact, VisibleTerm } from './model';
import { rankVisibleTerms } from './rank-visible-terms';
import { speakerExchanges } from './speaker-exchanges';

interface RelatedTerm {
  key: string;
  displayName: string;
  count: number;
  first: number;
}

const exchangeCache = new WeakMap<VisibleTerm[], ReturnType<typeof speakerExchanges>>();

function paragraphMentions(artifact: Artifact, term: VisibleTerm): Map<string, number> {
  const paragraphs = new Map<string, number>();
  for (const mention of term.mentions) {
    const sentence = artifact.sentences[mention.ordinal - 1];
    if (sentence?.structure !== 'body') continue;
    const unit = `${sentence.spineIndex}:${sentence.paragraphIndex}`;
    if (!paragraphs.has(unit)) paragraphs.set(unit, mention.ordinal);
  }
  return paragraphs;
}

function wordPart(part: string, whole: string): boolean {
  return ` ${whole} `.includes(` ${part} `);
}

function canRelate(term: VisibleTerm, selected: VisibleTerm): boolean {
  return (
    !wordPart(term.key, selected.key) &&
    !wordPart(selected.key, term.key) &&
    !(term.wordCount === 1 && wordRarity(term.key) === 0 && term.displayName === term.displayName.toLowerCase())
  );
}

function relatedByParagraph(artifact: Artifact, selected: VisibleTerm, visible: VisibleTerm[], cutoff: number): RelatedTerm[] {
  const selectedUnits = paragraphMentions(artifact, selected);
  if (selectedUnits.size < 2) return [];

  const units = new Set(selectedUnits.keys());
  const ranked = rankVisibleTerms(artifact, visible, cutoff);
  const pool = ranked.slice(0, 150);
  for (let i = 150; i < ranked.length && pool.length < 300; i++) {
    const term = ranked[i];
    if (term.key !== selected.key && term.wordCount === 1 && term.named && term.count >= 5) pool.push(term);
  }
  const candidates = pool
    .filter((term) => term.key !== selected.key)
    .map((term) => {
      const paragraphs = paragraphMentions(artifact, term);
      let count = 0;
      let first = Infinity;
      for (const [unit, ordinal] of paragraphs) {
        units.add(unit);
        if (selectedUnits.has(unit)) {
          count++;
          first = Math.min(first, ordinal);
        }
      }
      return { term, count, first, df: paragraphs.size };
    });
  const scored = candidates
    .filter(({ term, count }) => count >= 2 && canRelate(term, selected))
    .map(({ term, count, first, df }) => ({
      key: term.key,
      displayName: term.displayName,
      count,
      first,
      score: count * Math.min(6, Math.log2((count * units.size) / (selectedUnits.size * df))),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return scored
    .filter(
      (candidate) =>
        !scored.some((other) => other.key.length > candidate.key.length && other.score >= candidate.score && wordPart(candidate.key, other.key)),
    )
    .map(({ key, displayName, count, first }) => ({ key, displayName, count, first }));
}

export function relatedTerms(artifact: Artifact, selected: VisibleTerm, visible: VisibleTerm[], cutoff: number, limit: number): RelatedTerm[] {
  const size = Math.max(0, Math.min(100, limit));
  const paragraphs = relatedByParagraph(artifact, selected, visible, cutoff);
  if (selected.type !== 'person') return paragraphs.slice(0, size);

  let exchanges = exchangeCache.get(visible);
  if (!exchanges) {
    exchanges = speakerExchanges(artifact.sentences, visible, cutoff);
    exchangeCache.set(visible, exchanges);
  }
  const partners = exchanges.get(selected.key);
  if (!partners) return paragraphs.slice(0, size);
  const speakers = visible
    .flatMap((term) => {
      const evidence = partners.get(term.key);
      return evidence && evidence.count >= 2 && canRelate(term, selected) ? [{ key: term.key, displayName: term.displayName, ...evidence }] : [];
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  if (!speakers.length) return paragraphs.slice(0, size);

  const offset = 5;
  const speakerWeight = 1.55;
  const fused = new Map(paragraphs.map((term, index) => [term.key, { term, score: 1 / (offset + index + 1) }]));
  speakers.forEach((term, index) => {
    const score = speakerWeight / (offset + index + 1);
    const existing = fused.get(term.key);
    if (existing) existing.score += score;
    else fused.set(term.key, { term, score });
  });
  const covered = new Set<string>();
  for (const { term, score } of fused.values()) {
    const words = term.key.split(' ');
    for (let start = 0; start < words.length; start++) {
      for (let end = start + 1; end <= words.length; end++) {
        const part = words.slice(start, end).join(' ');
        if (part !== term.key && (fused.get(part)?.score ?? Infinity) <= score) covered.add(part);
      }
    }
  }
  return [...fused.values()]
    .filter(({ term }) => !covered.has(term.key))
    .sort((a, b) => b.score - a.score || a.term.key.localeCompare(b.term.key))
    .slice(0, size)
    .map(({ term }) => term);
}
