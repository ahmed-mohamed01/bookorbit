import type { Sentence } from './model';

export function fractionToOrdinal(sentences: Sentence[], fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  const target = Math.min(fraction, 1) * sentences.reduce((sum, sentence) => sum + sentence.text.length, 0);
  let characters = 0;
  let cutoff = 0;
  for (const sentence of sentences) {
    characters += sentence.text.length;
    if (characters > target) break;
    if (sentence.structure === 'body') cutoff = sentence.ordinal;
  }
  return cutoff;
}
const EPSILON = 1e-9;
const usableBytes = (spineBytes: readonly number[] | undefined): spineBytes is readonly number[] =>
  !!spineBytes?.length && spineBytes.every((size) => Number.isFinite(size) && size >= 0) && spineBytes.some((size) => size > 0);

/** A position without a CFI only says how far through the book the reader is, so it reveals whole spine items. */
function itemFloor(sentences: Sentence[], fraction: number, spineBytes: readonly number[] | undefined): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  const ends = new Map<number, number>();
  let total = 0;
  if (usableBytes(spineBytes)) {
    spineBytes.forEach((size, spineIndex) => ends.set(spineIndex, (total += size)));
  } else {
    for (const sentence of sentences) ends.set(sentence.spineIndex, (total += sentence.text.length));
  }
  const target = Math.min(fraction, 1) * total + EPSILON * total;
  let cutoff = 0;
  for (const sentence of sentences) {
    if ((ends.get(sentence.spineIndex) ?? Infinity) > target) break;
    if (sentence.structure === 'body') cutoff = sentence.ordinal;
  }
  return cutoff;
}

/**
 * Foliate's percentage weighs each spine item by its uncompressed byte size, so the share of the CFI's item already
 * read comes from bytes; that share then maps to the item's own sentences by characters.
 */
export function progressToOrdinal(
  sentences: Sentence[],
  progress: { percentage: number | null; cfi?: string | null },
  spineBytes?: readonly number[],
): number {
  const fraction = (progress.percentage ?? 0) / 100;
  const match = progress.cfi?.match(/^epubcfi\(\/6(?:\[[^\]]*\])?\/(\d+)(?:\[[^\]]*\])?!/);
  const step = match && progress.cfi?.endsWith(')') ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(step) || step < 2 || step % 2 !== 0) return itemFloor(sentences, fraction, spineBytes);
  const spineIndex = step / 2 - 1;
  let cutoff = 0;
  const item: Sentence[] = [];
  for (const sentence of sentences) {
    if (sentence.spineIndex < spineIndex && sentence.structure === 'body') cutoff = sentence.ordinal;
    else if (sentence.spineIndex === spineIndex) item.push(sentence);
  }
  const size = spineBytes?.[spineIndex] ?? 0;
  if (progress.percentage == null || !usableBytes(spineBytes) || !(size > 0)) return cutoff;
  const total = spineBytes.reduce((sum, value) => sum + value, 0);
  const before = spineBytes.slice(0, spineIndex).reduce((sum, value) => sum + value, 0);
  const inItem = Math.min(1, Math.max(0, (Math.min(fraction, 1) * total - before) / size));
  const characters = item.reduce((sum, sentence) => sum + sentence.text.length, 0);
  let seen = 0;
  for (const sentence of item) {
    seen += sentence.text.length;
    if (seen / characters > inItem + EPSILON) break;
    if (sentence.structure === 'body') cutoff = sentence.ordinal;
  }
  return cutoff;
}
export function checkpoints(sentences: Sentence[]): number[] {
  const body = sentences.filter((sentence) => sentence.structure === 'body');
  return body
    .filter((sentence, index) => (index + 1) % 200 === 0 || sentence.spineIndex !== body[index + 1]?.spineIndex)
    .map((sentence) => sentence.ordinal);
}
export function cardCutoff(sentences: Sentence[], cutoff: number, firstOccurrence: number): number {
  const checkpoint =
    checkpoints(sentences)
      .filter((value) => value <= cutoff)
      .at(-1) ?? 0;
  return firstOccurrence > checkpoint ? Math.max(firstOccurrence, Math.floor(cutoff / 20) * 20) : checkpoint;
}
