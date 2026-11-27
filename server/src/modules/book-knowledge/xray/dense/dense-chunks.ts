import type { Sentence } from '../../core/model';
import type { PassUnit } from '../pass/pass-units';
import { WRITTEN_CLOSE, WRITTEN_OPEN } from '../xray-description-context';

/** About this many sentences a chunk, so a low-effort reply covers every name in it. */
export const CHUNK_SENTENCES = 100;

/**
 * A unit cut into chunks of about `CHUNK_SENTENCES` sentences at paragraph ends. Each chunk has a
 * unit's shape so the state and the spoiler check read it the same way; only the unit's last chunk
 * ends its section.
 */
export function denseChunks(sentences: readonly Sentence[], unit: PassUnit, size = CHUNK_SENTENCES): PassUnit[] {
  const body = unit.ordinals.filter((ordinal) => sentences[ordinal - 1].structure === 'body');
  const count = Math.max(1, Math.round(body.length / size));
  const target = body.length / count;
  const parts: number[][] = [];
  let current: number[] = [];
  for (const ordinal of body) {
    const startsParagraph = current.length > 0 && sentences[current.at(-1)! - 1].paragraphIndex !== sentences[ordinal - 1].paragraphIndex;
    // Text with no paragraph breaks is cut between sentences at twice the target, so one chunk never holds a whole section.
    if ((startsParagraph ? current.length >= target : current.length >= 2 * target) && parts.length + 1 < count) {
      parts.push(current);
      current = [];
    }
    current.push(ordinal);
  }
  if (current.length) parts.push(current);
  return parts.map((ordinals, index) => ({
    id: `${unit.id}c${index + 1}`,
    index,
    s: unit.s,
    ordinals,
    sectionEnd: unit.sectionEnd && index === parts.length - 1,
  }));
}

/**
 * The chunk as the model reads it: one paragraph a line, each sentence led by its number, such as [1234]. A run of inset
 * sentences (a quoted letter or log) sits between written tags, so its "I" is not read as the narrator.
 */
export function numberedText(sentences: readonly Sentence[], ordinals: readonly number[]): string {
  const lines: string[] = [];
  let paragraph: number | null = null;
  let written = false;
  for (const ordinal of ordinals) {
    const sentence = sentences[ordinal - 1];
    const text = `[${ordinal}] ${sentence.text.replace(/\s+/g, ' ').trim()}`;
    const inset = !!sentence.inset;
    if (inset !== written) {
      lines.push(inset ? WRITTEN_OPEN : WRITTEN_CLOSE);
      written = inset;
      paragraph = null;
    }
    if (paragraph === sentence.paragraphIndex && lines.length) lines[lines.length - 1] += ` ${text}`;
    else lines.push(text);
    paragraph = sentence.paragraphIndex;
  }
  if (written) lines.push(WRITTEN_CLOSE);
  return lines.join('\n');
}

/** Whether a numbered stretch holds quoted writing, so its prompt explains the tags. */
export const hasWritten = (text: string): boolean => text.includes(WRITTEN_OPEN);

/** The cited sentence numbers that fall in the chunk, at most `limit`, in reading order; the rest are dropped. */
export function citesIn(value: unknown, ordinals: ReadonlySet<number>, limit = 3): { cites: number[]; outside: number } {
  const given = (Array.isArray(value) ? value : [value])
    .map((item) => (typeof item === 'string' ? Number(item.replace(/[[\]\s]/g, '')) : item))
    .filter((item): item is number => typeof item === 'number' && Number.isInteger(item));
  const cites = [...new Set(given.filter((n) => ordinals.has(n)))].sort((a, b) => a - b).slice(0, limit);
  return { cites, outside: given.length - given.filter((n) => ordinals.has(n)).length };
}
