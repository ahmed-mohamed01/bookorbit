import type { Sentence } from './model';
export const words = (text: string): string[] =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+(?:[-\u2013’'][\p{L}\p{N}]+)*/gu) ?? []).map((word) => word.replace(/\u2013/g, '-'));

export function normalizeLast(word: string): string {
  if (/ises$/.test(word)) return word.slice(0, -2);
  if (/ies$/.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(ches|shes|xes|zes|sses)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/(ss|us|is)$/.test(word) && word.length > 3) return word.slice(0, -1);
  return word;
}
export function termKey(text: string): string {
  const parts = words(text);
  if (parts.length) parts[parts.length - 1] = normalizeLast(parts[parts.length - 1]);
  return parts.join(' ');
}

export function retrievalStem(word: string): string {
  let stem = normalizeLast(word);
  if (stem.length > 5) stem = stem.replace(/(?:ing|ed)$/, '');
  if (/(?:bb|dd|gg|mm|nn|pp|rr|tt)$/.test(stem)) stem = stem.slice(0, -1);
  if (stem.length > 5) stem = stem.replace(/(?:ation|ement|ment|ness|ly)$/, '');
  if (stem.length > 4) stem = stem.replace(/i?our$/, '');
  if (stem.length > 3) stem = stem.replace(/e$/, '');
  return stem;
}
export const retrievalTokens = (text: string): string[] => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(retrievalStem);

const sentenceVocabulary = new WeakMap<Sentence, { text: string; words: string[]; stems?: string[] }>();
export function sentenceTokens(sentence: Sentence, stemmed = false): string[] {
  let cached = sentenceVocabulary.get(sentence);
  if (!cached || cached.text !== sentence.text) {
    cached = { text: sentence.text, words: words(sentence.text) };
    sentenceVocabulary.set(sentence, cached);
  }
  if (stemmed) return (cached.stems ??= retrievalTokens(sentence.text));
  return cached.words;
}
