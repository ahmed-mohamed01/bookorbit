import { visibleTerm } from './artifact';
import { retrievalTokens, sentenceTokens, words } from './text-utils';
import type { Artifact, Sentence } from './model';

export interface Passage {
  number: number;
  text: string;
  ordinals: number[];
  spineIndex: number;
  paragraphIndex: number;
  href: string;
}
export function bodyParagraphs(artifact: Artifact, cutoff: number): Sentence[][] {
  const groups: Sentence[][] = [];
  for (const sentence of artifact.sentences) {
    if (sentence.ordinal > cutoff) break;
    if (sentence.structure !== 'body') continue;
    const previous = groups.at(-1);
    if (previous && previous[0].spineIndex === sentence.spineIndex && previous[0].paragraphIndex === sentence.paragraphIndex) previous.push(sentence);
    else groups.push([sentence]);
  }
  return groups;
}
export function expandLead(groups: Sentence[][], index: number): Sentence[] {
  const expanded = expandOnce(groups, index);
  const after = groups[index + 2];
  // A heading absorbs its lead-in first, and that lead-in may itself end by announcing the definition.
  if (
    expanded.length > groups[index].length &&
    /:\s*$/.test(expanded.at(-1)!.text) &&
    after &&
    after[0].spineIndex === expanded[0].spineIndex &&
    !after[0].heading
  )
    return [...expanded, ...after];
  return expanded;
}
function expandOnce(groups: Sentence[][], index: number): Sentence[] {
  const lead = groups[index];
  const next = groups[index + 1];
  if (!next || next[0].spineIndex !== lead[0].spineIndex || next[0].heading) return lead[0].heading ? [] : lead;
  if (
    lead
      .map((s) => s.text)
      .join(' ')
      .toLowerCase() ===
    next
      .map((s) => s.text)
      .join(' ')
      .toLowerCase()
  )
    return lead;
  const explanation = /\b(?:means|refers to|is (?:a|an|the)|are (?:a|an|the)|holds that)\b/i;
  const list = /^(?:first|second|third|[0-9]+[.)]|[-*•])/i;
  if (
    lead[0].heading ||
    /:\s*$/.test(lead.at(-1)!.text) ||
    (lead.length === 1 &&
      !explanation.test(lead[0].text) &&
      (words(lead[0].text).length <= 8 || (words(lead[0].text).length < 25 && (explanation.test(next[0].text) || list.test(next[0].text)))))
  )
    return [...lead, ...next];
  return lead;
}
export function expandContinuation(groups: Sentence[][], index: number, query: string): Sentence[] {
  const base = expandLead(groups, index);
  if (!base.length) return base;
  const content = new Set(retrievalTokens(query).filter((w) => w.length > 3));
  const shares = (group: Sentence[]) => group.some((s) => sentenceTokens(s, true).some((w) => content.has(w)));
  const reference = /^(?:this|these|such|it|thus|however|for example|therefore|they|that|in particular)\b/i;
  let start = index;
  let end = index;
  while (end + 1 < groups.length && groups[end + 1][0].ordinal <= base.at(-1)!.ordinal) end++;
  if (start > 0 && reference.test(base[0].text) && groups[start - 1][0].spineIndex === base[0].spineIndex && !groups[start - 1][0].heading) start--;
  const next = groups[end + 1];
  if (
    next &&
    next.map((s) => s.text).join(' ') !== base.map((s) => s.text).join(' ') &&
    next[0].spineIndex === base[0].spineIndex &&
    !next[0].heading &&
    (reference.test(next[0].text) || shares(next))
  )
    end++;
  return groups.slice(start, end + 1).flat();
}
export function passageFrom(sentences: Sentence[]): Passage {
  const first = sentences[0];
  return {
    number: 0,
    text: sentences.map((s) => s.text).join(' '),
    ordinals: sentences.map((s) => s.ordinal),
    spineIndex: first.spineIndex,
    paragraphIndex: first.paragraphIndex,
    href: first.href,
  };
}
export const contrast = /^(?:however|but|yet|nevertheless|on the other hand|this apparent|this advantage)/i;
export function trimEvidence(sentences: Sentence[], mentions: number[], budget: number, maxCharacters = Infinity): Sentence[] {
  const size = (values: Sentence[]) => values.reduce((sum, s) => sum + sentenceTokens(s).length, 0);
  const fits = (values: Sentence[]) => size(values) <= budget && JSON.stringify(values.map((s) => s.text).join(' ')).length <= maxCharacters;
  if (fits(sentences)) return sentences;
  const anchor = sentences.findIndex((s) => mentions.includes(s.ordinal));
  if (anchor < 0) return [];
  let start = anchor;
  const safeEnd = (initial: number): number => {
    let end = initial;
    for (let index = start; index < end; index++) {
      if (mentions.includes(sentences[index].ordinal)) end = Math.max(end, Math.min(sentences.length, index + 3));
      if (index === end - 1 && end < sentences.length && contrast.test(sentences[end].text)) end++;
    }
    return end;
  };
  let end = safeEnd(Math.min(sentences.length, anchor + 3));
  if (!fits(sentences.slice(start, end))) return [];
  while (end < sentences.length) {
    const next = safeEnd(end + 1);
    if (!fits(sentences.slice(start, next))) break;
    end = next;
  }
  while (start > 0 && fits(sentences.slice(start - 1, end))) start--;
  if (sentences[0].heading && start !== 0) return [];
  return sentences.slice(start, end);
}
export function selectEvidence(
  artifact: Artifact,
  key: string,
  cutoff: number,
  options: { maxParagraphs?: number; maxWords?: number; maxCharacters?: number } = {},
): Passage[] {
  const term = visibleTerm(artifact, key, cutoff);
  if (!term) return [];
  const maxParagraphs = Math.min(10, Math.max(1, options.maxParagraphs ?? 10));
  let budget = Math.max(1, options.maxWords ?? 600);
  let characters = options.maxCharacters ?? 4000;
  const groups = bodyParagraphs(artifact, cutoff);
  const mentionMap = new Map(term.mentions.map((m) => [m.ordinal, m]));
  const aliases = [...new Set(term.mentions.map((mention) => words(mention.alias).join(' ')))];
  const hasAlias = (sentence: Sentence) => {
    const text = ` ${sentenceTokens(sentence).join(' ')} `;
    return aliases.some((alias) => text.includes(` ${alias} `));
  };
  const seen = new Set<string>();
  const candidates = groups
    .map((group, index) => ({ group, index, mentioned: group.some((s) => mentionMap.has(s.ordinal)) }))
    .sort((a, b) => Number(b.mentioned) - Number(a.mentioned))
    .flatMap(({ group, index }) => {
      if (!group.some((s) => mentionMap.has(s.ordinal) || hasAlias(s))) return [];
      const sentences = expandContinuation(groups, index, term.displayName);
      if (!sentences.length) return [];
      const text = sentences.map((s) => s.text).join(' ');
      const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(normalized)) return [];
      seen.add(normalized);
      const mentions = sentences.filter((s) => mentionMap.has(s.ordinal) || hasAlias(s)).map((s) => s.ordinal);
      const definition = sentences.some(
        (s) =>
          mentionMap.get(s.ordinal)?.definition ||
          ((mentionMap.has(s.ordinal) || hasAlias(s) || sentences[0].heading || /:\s*$/.test(sentences[0].text)) &&
            /\b(?:means|refers to|is (?:a|an|the)|are (?:a|an|the)|in other words|because|holds that)\b/i.test(s.text)),
      );
      const explanation = (
        text.match(
          /\b(?:because|therefore|thus|means|refers to|allows|requires|enables|rather than|in order to|so that|cannot|depends|causes|is a|is an)\b/gi,
        ) ?? []
      ).length;
      const density = mentions.length / Math.sqrt(Math.max(1, words(text).length));
      return [
        {
          sentences,
          mentions,
          definition,
          explanation: explanation * 8 + density * 12,
          substantive: words(text).length >= 25,
          vocabulary: new Set(words(text)),
        },
      ];
    });
  candidates.sort((a, b) => a.sentences[0].ordinal - b.sentences[0].ordinal);
  const first = candidates.find((c) => c.substantive) ?? candidates[0];
  const latest = candidates.at(-1);
  const retained = new Set([first, latest, ...candidates.filter((candidate) => candidate.definition)]);
  const chapters = new Set<number>();
  for (const candidate of candidates) {
    const chapter = candidate.sentences[0].spineIndex;
    if (!chapters.has(chapter)) retained.add(candidate);
    chapters.add(chapter);
  }
  for (let i = 0; i < 96; i++) retained.add(candidates[Math.floor((i * candidates.length) / 96)]);
  const pool = candidates.filter((candidate) => retained.has(candidate));
  const selected: Passage[] = [];
  const selectedVocabulary: Set<string>[] = [];
  const covered = new Set<number>();
  const usedOrdinals = new Set<number>();
  const explanatory = [...candidates].sort((a, b) => b.explanation - a.explanation);
  for (const candidate of explanatory.slice(0, 32)) if (!pool.includes(candidate)) pool.push(candidate);
  const priority = [explanatory[0], first, latest].filter((candidate, index, values) => candidate && values.indexOf(candidate) === index);
  priority.splice(maxParagraphs);
  while (pool.length && selected.length < maxParagraphs && budget > 0) {
    const score = (c: (typeof candidates)[number]) => {
      let overlap = 0;
      for (const vocabulary of selectedVocabulary) {
        let common = 0;
        for (const word of c.vocabulary) if (vocabulary.has(word)) common++;
        overlap = Math.max(overlap, common / Math.max(1, c.vocabulary.size));
      }
      return c.explanation + (c.definition ? 20 : 0) + (!covered.has(c.sentences[0].spineIndex) ? 10 : 0) + (1 - overlap) * 5;
    };
    const mandatory = priority.shift();
    let best = mandatory ? pool.indexOf(mandatory) : 0;
    if (best < 0) continue;
    if (!mandatory) {
      let bestScore = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const value = score(pool[i]);
        if (value > bestScore) {
          best = i;
          bestScore = value;
        }
      }
    }
    const candidate = pool.splice(best, 1)[0];
    if (candidate.sentences.some((s) => usedOrdinals.has(s.ordinal))) continue;
    const reserve = priority.length > 0 && maxParagraphs > 1;
    let kept = trimEvidence(
      candidate.sentences,
      candidate.mentions,
      reserve ? Math.floor(budget / (priority.length + 1)) : budget,
      (reserve ? Math.floor(characters / (priority.length + 1)) : characters) - 32,
    );
    if (!kept.length && reserve) kept = trimEvidence(candidate.sentences, candidate.mentions, budget, characters - 32);
    if (!kept.length) continue;
    budget -= kept.reduce((sum, s) => sum + sentenceTokens(s).length, 0);
    characters -= JSON.stringify(kept.map((s) => s.text).join(' ')).length + 32;
    kept.forEach((s) => usedOrdinals.add(s.ordinal));
    covered.add(kept[0].spineIndex);
    selected.push(passageFrom(kept));
    selectedVocabulary.push(new Set(words(kept.map((sentence) => sentence.text).join(' '))));
  }
  return selected.sort((a, b) => a.ordinals[0] - b.ordinals[0]).map((p, i) => ({ ...p, number: i + 1 }));
}
