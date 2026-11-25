import type { Sentence, Term } from './model';

// Order matters: the labels form the model prompt, and the specific-over-general rule breaks ties by it.
export const KIND_LABELS = [
  'person or character',
  'animal or creature',
  'place or location',
  'group, people or organization',
  'object or artifact',
  'event',
  'concept or idea',
  'magic or power system',
  'title or honorific',
  'god or deity',
  'spirit or supernatural being',
  'force or energy',
] as const;

export const CUE = { classDeterminer: 1, indefinite: 2, plural: 4, pluralFollower: 8, bracket: 16 } as const;
const CLASS_DETERMINERS = new Set(['a', 'an', 'every', 'each', 'other', 'some', 'many', 'few', 'several', 'these', 'those', 'all', 'no']);
const PLURAL_FOLLOWERS = new Set(['were', 'are', 'have', 'they', 'them', 'their']);
const PREVIOUS_WORD = /([\p{L}\p{N}\p{M}_'-]+)\s+$/u;
const WORD = /[\p{L}\p{N}\p{M}_'-]+/gu;
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;

export interface BodyText {
  text: string;
  starts: Map<number, number>;
  ordinals: number[];
  offsets: number[];
}

// Body sentences joined by newlines; every kind span offset refers to this text.
export function bodyText(sentences: readonly Sentence[]): BodyText {
  const parts: string[] = [];
  const starts = new Map<number, number>();
  const ordinals: number[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const sentence of sentences) {
    if (sentence.structure !== 'body') continue;
    if (parts.length) offset++;
    starts.set(sentence.ordinal, offset);
    ordinals.push(sentence.ordinal);
    offsets.push(offset);
    parts.push(sentence.text);
    offset += sentence.text.length;
  }
  return { text: parts.join('\n'), starts, ordinals, offsets };
}

const straightQuotes = (text: string): string => text.replace(/[‘’]/g, "'");

export function isPluralSurface(surface: string, key: string): boolean {
  const last = surface.split(/\s+/).at(-1)!.toLowerCase();
  return last.endsWith('s') && !last.endsWith('ss') && last !== key.split(' ').at(-1);
}

export function locateAlias(text: string, alias: string, nth: number): number {
  let seen = 0;
  for (let index = text.indexOf(alias); index >= 0; index = text.indexOf(alias, index + 1)) {
    if (WORD_CHARACTER.test(text[index - 1] ?? '') || WORD_CHARACTER.test(text[index + alias.length] ?? '')) continue;
    if (seen++ === nth) return index;
  }
  return -1;
}

export function mentionCues(text: string, start: number, end: number, key: string): number {
  const plain = straightQuotes(text);
  const before = plain.slice(Math.max(0, start - 80), start);
  const after = plain.slice(end, end + 80);
  const previous = PREVIOUS_WORD.exec(before)?.[1].toLowerCase();
  const next = (after.match(WORD) ?? []).slice(0, 3).map((value) => value.toLowerCase());
  let cues = 0;
  if (previous && CLASS_DETERMINERS.has(previous)) cues |= CUE.classDeterminer;
  if (previous === 'a' || previous === 'an') cues |= CUE.indefinite;
  if (isPluralSurface(plain.slice(start, end), key)) cues |= CUE.plural;
  if (next.some((value) => PLURAL_FOLLOWERS.has(value))) cues |= CUE.pluralFollower;
  if (/\[\s*$/.test(before) && /^\s*\]/.test(after)) cues |= CUE.bracket;
  return cues;
}

// Adds each mention's text cues and, when kind spans exist, the label of the span that contains it plus the
// ordinal from which that label may be used. Mentions are only read from their own sentence.
export function annotateKindCues(sentences: readonly Sentence[], terms: Term[], spans?: readonly number[]): void {
  const body = spans?.length ? bodyText(sentences) : undefined;
  const starts: number[] = [];
  if (spans) for (let index = 0; index < spans.length; index += 4) starts.push(spans[index]);
  for (const term of terms) {
    const seen = new Map<string, number>();
    let ordinal = 0;
    term.features.forEach((feature, index) => {
      ordinal += term.deltas[index];
      const text = sentences[ordinal - 1]?.text;
      if (!text) return;
      const id = `${ordinal}\u0000${feature.alias}`;
      const nth = seen.get(id) ?? 0;
      seen.set(id, nth + 1);
      const start = locateAlias(text, feature.alias, nth);
      if (start < 0) return;
      const end = start + feature.alias.length;
      const cues = mentionCues(text, start, end, term.key);
      if (cues) feature.cues = cues;
      const offset = body?.starts.get(ordinal);
      if (offset === undefined || !spans) return;
      const span = containingSpan(starts, spans, offset + start, offset + end);
      if (span >= 0) {
        feature.kindLabel = spans[span + 2];
        feature.kindAt = spans[span + 3];
      }
    });
  }
}

function containingSpan(starts: number[], spans: readonly number[], start: number, end: number): number {
  let low = 0;
  let high = starts.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= start) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found >= 0 && spans[found * 4 + 1] >= end ? found * 4 : -1;
}
