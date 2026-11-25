import { termKey } from './text-utils';
import type { AliasLink, Sentence } from './model';

const SHORT_FORM = /^[\p{L}\p{N}][\p{L}\p{N}&.-]{1,9}$/u;
const BRACKETED = /\(\s*["“‘']?([^()"“”‘’']{2,80}?)["”’']?\s*(?:[;,][^()]*)?\)/gu;

export function shortFormLike(value: string): boolean {
  return SHORT_FORM.test(value) && (value.match(/\p{Lu}/gu) ?? []).length >= 2 && !/\p{Ll}{2}/u.test(value);
}

const singular = (shortForm: string): string => shortForm.replace(/(?<=\p{Lu})s$/u, '');

const alphanumeric = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/**
 * Schwartz and Hearst (2003): walk the short form's characters from the end, finding each in order
 * in the candidate long form, with the first one at the start of a word.
 */
export function bestLongForm(shortForm: string, longForm: string): string | null {
  const short = shortForm.toLowerCase();
  const long = longForm.toLowerCase();
  let l = long.length - 1;
  for (let s = short.length - 1; s >= 0; s--) {
    const char = short[s];
    if (!alphanumeric(char)) continue;
    while (l >= 0 && (long[l] !== char || (s === 0 && alphanumeric(long[l - 1])))) l--;
    if (l < 0) return null;
    l--;
  }
  const start = longForm.lastIndexOf(' ', l) + 1;
  const result = longForm.slice(start).trim();
  if (result.length <= shortForm.length || result.toLowerCase().includes(short)) return null;
  return result;
}

const lettersIn = (value: string): number => (value.match(/[\p{L}\p{N}]/gu) ?? []).length;

function pairs(text: string): { short: string; long: string }[] {
  const found: { short: string; long: string }[] = [];
  for (const match of text.matchAll(BRACKETED)) {
    const inside = match[1].trim();
    const before = text.slice(0, match.index).trimEnd();
    if (shortFormLike(inside)) {
      const limit = Math.min(lettersIn(inside) + 5, lettersIn(inside) * 2);
      const window = before.split(/\s+/).slice(-limit).join(' ');
      const long = bestLongForm(singular(inside), window);
      if (long) found.push({ short: inside, long });
      continue;
    }
    const last = /([\p{L}\p{N}][\p{L}\p{N}&.-]*)["”’']?$/u.exec(before)?.[1];
    const insideWords = inside.split(/\s+/).length;
    if (last && shortFormLike(last) && insideWords >= 2 && insideWords <= Math.min(lettersIn(last) + 5, lettersIn(last) * 2)) {
      const long = bestLongForm(singular(last), inside);
      if (long === inside) found.push({ short: last, long });
    }
  }
  return found;
}

/** Links "long form (SHORT)" and "SHORT (long form)", from the sentence that states them on. */
export function extractAbbreviationLinks(sentences: Sentence[], keys: Set<string>): AliasLink[] {
  const links: AliasLink[] = [];
  const meaning = new Map<string, string>();
  for (const sentence of sentences) {
    if (sentence.structure !== 'body' || !sentence.text.includes('(')) continue;
    for (const pair of pairs(sentence.text)) {
      const short = termKey(pair.short);
      const long = termKey(pair.long);
      if (!short || short === long || !keys.has(short) || !keys.has(long)) continue;
      // A book that reuses a short form for something else keeps its first meaning.
      if (meaning.has(short)) continue;
      meaning.set(short, long);
      links.push({ left: long, right: short, ordinal: sentence.ordinal });
    }
  }
  return links;
}
