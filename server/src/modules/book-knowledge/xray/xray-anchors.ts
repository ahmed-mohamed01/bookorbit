import type { BookKnowledgeXrayAnchor } from '@bookorbit/types';
import { ANCHOR_WORDS, flattenWithOffsets } from '../../story-guides/pipeline/anchors';
import type { Sentence } from '../core/model';

/** Characters of a sentence's start used to find it in the section text. */
const PROBE_CHARS = 40;
const SHORT_PROBE_CHARS = 20;
const SHORT_PROBE_REACH = 2000;
const INVISIBLE = /[\u200b\u00ad\u2060\ufeff]/g;

/** One-to-one character folding, so offsets in the folded text are offsets in the flattened text. */
function fold(text: string): string {
  return text.replace(/[‘’‛′]/g, "'").replace(/[“”‟″]/g, '"');
}

function normalized(text: string): string {
  return fold(text.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim());
}

/** Length of the first `words` words of a flattened text. */
function leadingWords(text: string, words: number): number {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== ' ' && (index === 0 || text[index - 1] === ' ') && ++count > words) return index - 1;
  }
  return text.length;
}

export interface AnchorSection {
  text: string;
}

/**
 * Upstream anchors (`{s, o, q}` on foliate's raw section text) for Book Knowledge sentence ordinals,
 * so one spoiler check serves every arm. A sentence that cannot be found keeps the last found offset
 * in its section, which never moves an anchor later than the text it came from.
 */
export class XrayAnchors {
  private readonly anchors = new Map<number, BookKnowledgeXrayAnchor>();
  readonly missed: number;

  constructor(sentences: readonly Sentence[], sections: readonly AnchorSection[]) {
    let missed = 0;
    const flat = new Map<number, { text: string; folded: string; at: number[]; cursor: number; lastAt: number }>();
    for (const sentence of sentences) {
      const s = sentence.spineIndex;
      let section = flat.get(s);
      if (!section) {
        const raw = sections[s]?.text ?? '';
        const flattened = flattenWithOffsets(raw);
        section = { text: flattened.text, folded: fold(flattened.text), at: flattened.at, cursor: 0, lastAt: 0 };
        flat.set(s, section);
      }
      const target = normalized(sentence.text);
      const probe = target.slice(0, PROBE_CHARS);
      let found = probe ? section.folded.indexOf(probe, section.cursor) : -1;
      // A short sentence ("Yes.") found far ahead is a later repeat, and would drag the cursor past real matches.
      if (found >= 0 && probe.length < SHORT_PROBE_CHARS && found - section.cursor > SHORT_PROBE_REACH) found = -1;
      if (found < 0) {
        missed++;
        this.anchors.set(sentence.ordinal, { s, o: section.lastAt, q: '', n: sentence.ordinal });
        continue;
      }
      const length = Math.min(target.length, section.text.length - found);
      const quote = section.text.slice(found, found + length);
      const o = section.at[found] ?? 0;
      section.cursor = found + Math.max(1, length);
      section.lastAt = o;
      this.anchors.set(sentence.ordinal, { s, o, q: quote.slice(0, leadingWords(quote, ANCHOR_WORDS)).trim(), n: sentence.ordinal });
    }
    this.missed = missed;
  }

  at(ordinal: number): BookKnowledgeXrayAnchor {
    const anchor = this.anchors.get(ordinal);
    if (!anchor) throw new Error(`No anchor for sentence ${ordinal}`);
    return anchor;
  }
}
