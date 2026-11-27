import type { PassSlot } from '../pass/pass-cast';
import { escapeRegExp, WORD_CHAR } from '../../../story-guides/pipeline/name-text';
import type { Sentence } from '../../core/model';

const LEAD = String.raw`^[\s["/]*`;
const END = `(?!${WORD_CHAR})`;
const COPULA = String.raw`(?:is|are|was|were|means|represents|refers\s+to|occurs\s+when|allows|lets|grants)`;
const DEFINING_COPULA = String.raw`(?:(?:is|are|was|were)(?=\s+(?:a|an|the)\b)|means|refers\s+to)`;
const GLOSS_WORDS = 3;
const LIST_ITEMS = 3;

const SCORE = { gloss: 4, copula: 3, acquisition: 2, list: 1 } as const;

const alternation = (names: readonly string[]) =>
  [...new Set(names.map((name) => name.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');

const wordCount = (text: string) => (text.match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? []).length;

/** A system line that is only the name and its numbers ("Intermediate 7/8", "Extreme compatibility:"): it says nothing about what the name is. */
export function bareLabel(text: string, names: readonly string[]): boolean {
  const own = alternation(names);
  if (!own) return false;
  const named = new RegExp(`(?<!${WORD_CHAR})(?:${own})${END}`, 'giu');
  if (!named.test(text)) return false;
  return /^[\s\d%/()[\]]*[:.]?\s*$/u.test(text.replace(named, ' '));
}

/** Lowercase, one space, no digits: "Fireball 3/10" and "Fireball 4/10" are one line. */
export const sameText = (text: string) => text.toLowerCase().replace(/\d+/g, '').replace(/\s+/g, ' ').trim();

function inColonList(text: string, name: RegExp): boolean {
  for (let at = text.indexOf(':'); at >= 0; at = text.indexOf(':', at + 1)) {
    const items = text
      .slice(at + 1)
      .split(/\s*,\s*|\s+(?:and|or)\s+/iu)
      .map((item) =>
        item
          .replace(/^(?:and|or)\s+/iu, '')
          .replace(/[.;!?]+$/u, '')
          .trim(),
      )
      .filter(Boolean);
    if (items.length >= LIST_ITEMS && items.some((item) => name.test(item))) return true;
  }
  return false;
}

/** How plainly a sentence says what the name is: a gloss, a definition, how it was gained, or a place in a list. 0 when it does not. */
export function definitionScore(text: string, names: readonly string[], explicitOnly = false): number {
  const own = alternation(names);
  if (!own || bareLabel(text, names)) return 0;
  const name = `(?:${own})${END}`;
  const gloss = text.match(new RegExp(`${LEAD}${name}(?:\\s*:|\\s*\\(|\\s+-\\s)`, 'iu'));
  if (gloss && wordCount(text.slice(gloss[0].length)) >= GLOSS_WORDS) return SCORE.gloss;
  const copula = explicitOnly ? DEFINING_COPULA : COPULA;
  if (
    new RegExp(`${LEAD}(?:(?:the|a|an|your)\\s+)?${name}\\s+${copula}${END}`, 'iu').test(text) ||
    new RegExp(`(?<!${WORD_CHAR})(?:the|a|your)\\s+${name}\\s+${copula}${END}`, 'iu').test(text)
  )
    return SCORE.copula;
  if (explicitOnly) return 0;
  if (
    new RegExp(
      `(?<!${WORD_CHAR})(?:gained|learned|unlocked|acquired)\\s+(?:the\\s+)?(?:(?:skill|spell|ability|class|title)\\s*:?\\s*)?["[]?${name}`,
      'iu',
    ).test(text) ||
    new RegExp(`(?<!${WORD_CHAR})path\\s+of\\s+(?:the\\s+)?${name}`, 'iu').test(text) ||
    new RegExp(`(?<!${WORD_CHAR})suffering\\s+from(?!${WORD_CHAR}).*(?<!${WORD_CHAR})${name}`, 'iu').test(text)
  )
    return SCORE.acquisition;
  if (inColonList(text, new RegExp(`(?<!${WORD_CHAR})${name}`, 'iu'))) return SCORE.list;
  return 0;
}

/** The sentence that best defines the name among `ordinals`, the earliest on a tie; null when none does. */
export function definitionOf(
  ordinals: readonly number[],
  sentences: readonly Sentence[],
  names: readonly string[],
  style?: 'explicit',
): number | null {
  let best: { ordinal: number; score: number } | null = null;
  for (const ordinal of ordinals) {
    const score = definitionScore(sentences[ordinal - 1].text, names, style === 'explicit');
    if (score && (!best || score > best.score)) best = { ordinal, score };
  }
  return best?.ordinal ?? null;
}

/** The first sentence among `ordinals` that glosses the name outright ("Mana: the energy that..."); null when none does. */
export function glossOf(ordinals: readonly number[], sentences: readonly Sentence[], names: readonly string[]): number | null {
  return ordinals.find((ordinal) => definitionScore(sentences[ordinal - 1].text, names, true) === SCORE.gloss) ?? null;
}

export function definitionGloss(text: string, names: readonly string[], kind: PassSlot['kind']): string | null {
  const own = alternation(names);
  if (!own || kind === 'character') return null;
  const opened = text.match(new RegExp(`${LEAD}(?:${own})${END}\\s*(?::|\\(|\\s-\\s)\\s*(.+)`, 'iu'));
  if (!opened) return null;
  const gloss = opened[1].replace(/[)\]"]+\s*[.!]?$/, '').trim();
  if (wordCount(gloss) < GLOSS_WORDS) return null;
  return `${gloss[0].toUpperCase()}${gloss.slice(1)}`;
}
