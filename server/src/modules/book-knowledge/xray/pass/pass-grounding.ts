import { retrievalStem, retrievalTokens } from '../../core/text-utils';

const MIN_LENGTH = 4;

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
