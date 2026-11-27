import { wordRarity } from '../../core/common-words';
import { retrievalStem, retrievalTokens } from '../../core/text-utils';
import { escapeRegExp, WORD_EDGE } from '../../../story-guides/pipeline/name-text';

const MIN_LENGTH = 4;
export const EXACT_TERM_NAMES =
  'Write the name of a skill, class, spell or item exactly as the sentences write it, in full; never reword or shorten it. ';

/**
 * The capitalised names in a description that nothing it was given mentions: a place, a creature or another
 * character the model brought in from a neighbouring sentence or from what it knows of the book. Lowercase words
 * are left alone, since a line retells its sentences in its own words.
 */
export function ungroundedNames(line: string, support: readonly string[]): string[] {
  const known = new Set(support.flatMap(retrievalTokens));
  const missing = new Set<string>();
  for (const match of line.matchAll(/[\p{L}][\p{L}'’-]*/gu)) {
    const word = match[0].replace(/['’]s$/u, '');
    if (match.index === 0 || !/^\p{Lu}/u.test(word) || word.length < MIN_LENGTH) continue;
    // "They", "Aboard": a capital that only opens a sentence names nothing.
    if (/[.!?;:]["”’)]?\s+$/u.test(line.slice(0, match.index)) && wordRarity(word.toLowerCase()) < 1) continue;
    if (
      word
        .toLowerCase()
        .split(/[-'’]/u)
        .every((part) => !part || known.has(retrievalStem(part)))
    )
      continue;
    missing.add(word);
  }
  return [...missing];
}

export function garbledTerm(line: string, support: readonly string[], own: readonly string[]): string | null {
  const names = own.map((name) => new RegExp(WORD_EDGE + escapeRegExp(name) + WORD_EDGE, 'iu'));
  const ownWords = new Set(own.map((name) => name.toLowerCase()));
  const lineWords = line.match(/\p{L}+/gu) ?? [];
  for (const text of support) {
    const terms = text.matchAll(/"([^"\n]+)"|(?<!\p{L})'([^'\n]+)'|“([^”\n]+)”|‘([^’\n]+)’|^\s*\[([^:\]\n]+):/gmu);
    for (const [, double, single, curlyDouble, curlySingle, head] of terms) {
      const term = (double ?? single ?? curlyDouble ?? curlySingle ?? head).trim();
      if (term.split(/\s+/u).length > 4 || !names.some((name) => name.test(term))) continue;
      if (new RegExp(WORD_EDGE + escapeRegExp(term).replace(/\s+/gu, '\\s+') + WORD_EDGE, 'iu').test(line)) continue;
      for (const word of term.toLowerCase().match(/\p{L}+/gu) ?? []) {
        if (ownWords.has(word)) continue;
        for (const candidate of lineWords) {
          const lower = candidate.toLowerCase();
          if (lower === word || retrievalStem(lower) === retrievalStem(word)) continue;
          if (Math.min(word.length, lower.length) >= 5 && (lower.startsWith(word) || word.startsWith(lower))) return candidate;
        }
      }
    }
  }
  return null;
}
