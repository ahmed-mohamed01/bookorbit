import type { Sentence } from '../../core/model';
import type { XraySection } from '../xray-evidence';

/** A chapter longer than this is read in parts, cut at paragraph ends, so one call stays a few thousand tokens. */
export const PASS_UNIT_CHARS = 30000;

/** A chapter, or one part of a long chapter: the one-pass step's unit, in reading order. */
export interface PassUnit {
  id: string;
  index: number;
  /** The reader's section index. */
  s: number;
  /** Body sentences, in order. */
  ordinals: number[];
  /** Whether the unit ends its section, so its end is the section's. */
  sectionEnd: boolean;
}

/** Units from the body sections up to the cut: a section, or even parts of it cut at paragraph ends. */
export function passUnits(sentences: readonly Sentence[], sections: readonly XraySection[], limit = PASS_UNIT_CHARS): PassUnit[] {
  const units: PassUnit[] = [];
  for (const section of sections) {
    const total = section.ordinals.reduce((sum, ordinal) => sum + sentences[ordinal - 1].text.length + 1, 0);
    const count = Math.max(1, Math.ceil(total / limit));
    const target = total / count;
    const parts: number[][] = [];
    let current: number[] = [];
    let size = 0;
    for (const ordinal of section.ordinals) {
      const sentence = sentences[ordinal - 1];
      const startsParagraph = current.length > 0 && sentences[current.at(-1)! - 1].paragraphIndex !== sentence.paragraphIndex;
      // Text with no paragraph breaks is cut between sentences at twice the target, so one unit never holds a whole section.
      if ((startsParagraph ? size >= target : size >= 2 * target) && parts.length + 1 < count) {
        parts.push(current);
        current = [];
        size = 0;
      }
      current.push(ordinal);
      size += sentence.text.length + 1;
    }
    if (current.length) parts.push(current);
    parts.forEach((ordinals, part) =>
      units.push({
        id: `u${units.length + 1}`,
        index: units.length,
        s: section.s,
        ordinals,
        sectionEnd: part === parts.length - 1,
      }),
    );
  }
  return units;
}

function folded(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The sentence of the unit a quote comes from: the one holding it, or the one it starts in when it runs on; null when the unit has no such words. */
export function quoteOrdinal(sentences: readonly Sentence[], unit: PassUnit, quote: unknown): number | null {
  if (typeof quote !== 'string') return null;
  const wanted = folded(quote).replace(/^["']+|["']+$/g, '');
  if (wanted.length < 3) return null;
  const head = wanted.slice(0, 30);
  for (const probe of [wanted, head]) for (const ordinal of unit.ordinals) if (folded(sentences[ordinal - 1].text).includes(probe)) return ordinal;
  // A quote with a word or two changed: the sentence holding most of its words, when that is most of them.
  const words = new Set(wanted.split(/[^\p{L}\p{N}']+/u).filter((word) => word.length > 2));
  if (words.size < QUOTE_MIN_WORDS) return null;
  let best: number | null = null;
  let score = 0;
  for (const ordinal of unit.ordinals) {
    const own = new Set(folded(sentences[ordinal - 1].text).split(/[^\p{L}\p{N}']+/u));
    const shared = [...words].filter((word) => own.has(word)).length / words.size;
    if (shared > score) [best, score] = [ordinal, shared];
  }
  return score >= QUOTE_OVERLAP ? best : null;
}

const QUOTE_MIN_WORDS = 4;
const QUOTE_OVERLAP = 0.75;
