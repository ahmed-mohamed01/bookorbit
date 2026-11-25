import type { Artifact, Sentence } from './core/model';
import type { BookKnowledgePassage } from '@bookorbit/types';
import { bodyParagraphs, contrast, expandLead, passageFrom, selectEvidence } from './core/evidence';
import { answerCharacterBudget } from './book-knowledge-prompts';
import { retrievalTokens, sentenceTokens } from './core/text-utils';
import { wordRarity } from './core/common-words';
import { namedTerms, tokens } from './book-knowledge-question';
export { tokens } from './book-knowledge-question';
export function paragraphs(artifact: Artifact, cutoff: number): BookKnowledgePassage[] {
  const groups = bodyParagraphs(artifact, cutoff);
  return groups.flatMap((_, index) => {
    const sentences = expandLead(groups, index);
    return sentences.length ? [passageFrom(sentences)] : [];
  });
}
function queryWords(question: string): string[] {
  const all = [...new Set(retrievalTokens(question))];
  const content = all.filter((word) => wordRarity(word) > 0);
  return content.length ? content : all;
}
function rankPassages(docs: BookKnowledgePassage[], sentences: Map<number, Sentence>, query: string[]): BookKnowledgePassage[] {
  const bags = docs.map((p) => p.ordinals.flatMap((o) => sentenceTokens(sentences.get(o)!, true)));
  const average = bags.reduce((sum, bag) => sum + bag.length, 0) / docs.length;
  const counts = bags.map((bag) => {
    const values = new Map<string, number>();
    for (const word of bag) values.set(word, (values.get(word) ?? 0) + 1);
    return values;
  });
  const df = new Map(query.map((q) => [q, counts.reduce((n, bag) => n + Number(bag.has(q)), 0)]));
  return docs
    .map((p, i) => {
      let score = 0;
      for (const q of query) {
        const frequency = counts[i].get(q) ?? 0;
        const n = df.get(q)!;
        score +=
          (Math.log(1 + (docs.length - n + 0.5) / (n + 0.5)) * frequency * 2.2) / (frequency + 1.2 * (0.25 + (0.75 * bags[i].length) / average));
      }
      return { p, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50)
    .map(({ p }) => p);
}
function namedPassages(artifact: Artifact, cutoff: number, question: string): BookKnowledgePassage[] {
  return namedTerms(artifact, cutoff, question)
    .slice(0, 3)
    .flatMap((term) =>
      selectEvidence(artifact, term.key, cutoff, {
        maxParagraphs: 1,
        maxWords: 160,
        maxCharacters: 1100,
      }),
    );
}
function passageWindow(p: BookKnowledgePassage, sentences: Map<number, Sentence>, query: string[]): BookKnowledgePassage {
  const size = (s: Sentence) => s.text.split(/\s+/).length;
  if (p.text.split(/\s+/).length <= 150) return p;
  const values = p.ordinals.map((o) => sentences.get(o)!);
  const scores = values.map((s) => {
    const vocabulary = new Set(sentenceTokens(s, true));
    return query.filter((word) => vocabulary.has(word)).length;
  });
  let best = 0;
  scores.forEach((score, index) => {
    if (score > scores[best]) best = index;
  });
  let lo = best,
    hi = best + 1,
    words = size(values[best]);
  while (true) {
    const nextHi = hi < values.length ? size(values[hi]) : Infinity;
    const nextLo = lo > 0 ? size(values[lo - 1]) : Infinity;
    if (Math.min(nextHi, nextLo) + words > 150) break;
    if (nextHi + words <= 150 && (contrast.test(values[hi].text) || nextHi <= nextLo * 1.5)) {
      words += nextHi;
      hi++;
    } else {
      words += nextLo;
      lo--;
    }
  }
  return passageFrom(values.slice(lo, hi));
}
const MAX_ASK_PASSAGES = 16;
function fillPassages(candidates: BookKnowledgePassage[], characters: number): BookKnowledgePassage[] {
  const selected: BookKnowledgePassage[] = [];
  const normalized = (text: string) => tokens(text).join(' ');
  for (const p of candidates) {
    if (selected.length >= MAX_ASK_PASSAGES) break;
    const cost = JSON.stringify({ number: selected.length + 1, text: p.text }).length + 1;
    if (cost > characters || selected.some((old) => old.ordinals.some((o) => p.ordinals.includes(o)) || normalized(old.text) === normalized(p.text)))
      continue;
    selected.push({ ...p, number: selected.length + 1 });
    characters -= cost;
  }
  return selected;
}
export function retrieve(artifact: Artifact, cutoff: number, question: string, focusKey?: string): BookKnowledgePassage[] {
  const docs = paragraphs(artifact, cutoff);
  if (!docs.length) return [];
  const sentences = new Map<number, Sentence>();
  for (const sentence of artifact.sentences) {
    if (sentence.ordinal > cutoff) break;
    sentences.set(sentence.ordinal, sentence);
  }
  const query = queryWords(question);
  const pool = rankPassages(docs, sentences, query).map((p) => passageWindow(p, sentences, query));
  const budget = answerCharacterBudget(question, Boolean(focusKey));
  const focused = focusKey ? selectEvidence(artifact, focusKey, cutoff, { maxCharacters: Math.floor(budget / 2) }) : [];
  return fillPassages([...focused, ...namedPassages(artifact, cutoff, question), ...pool], budget);
}
