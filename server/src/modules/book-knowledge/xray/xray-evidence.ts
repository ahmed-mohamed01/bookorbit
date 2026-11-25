import type { Sentence } from '../core/model';

export const LINKS_PER_ENTITY = 20;

export function inBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

/** Up to `count` items: the first two, then evenly spread over the rest, in their original order. */
export function spread<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  const head = items.slice(0, Math.min(2, count));
  const rest = items.slice(head.length);
  const want = count - head.length;
  const picked = Array.from({ length: want }, (_, index) => rest[Math.floor(((index + 0.5) * rest.length) / want)]);
  return [...head, ...picked];
}

export interface XraySection {
  s: number;
  /** Body sentence ordinals in the section, in order. */
  ordinals: number[];
}

export function bodySections(sentences: readonly Sentence[], through: number): XraySection[] {
  const sections: XraySection[] = [];
  for (const sentence of sentences) {
    if (sentence.ordinal > through) break;
    if (sentence.structure !== 'body' || sentence.heading) continue;
    const last = sections.at(-1);
    if (last?.s === sentence.spineIndex) last.ordinals.push(sentence.ordinal);
    else sections.push({ s: sentence.spineIndex, ordinals: [sentence.ordinal] });
  }
  return sections;
}

export function sectionCharacters(sentences: readonly Sentence[], sections: readonly XraySection[]): number {
  let characters = 0;
  for (const section of sections) for (const ordinal of section.ordinals) characters += sentences[ordinal - 1].text.length;
  return characters;
}
