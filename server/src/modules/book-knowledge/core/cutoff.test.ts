import { describe, expect, it } from 'vitest';
import { cardCutoff, fractionToOrdinal, progressToOrdinal } from './cutoff';
import type { Sentence } from './model';
const sentence = (ordinal: number, spineIndex: number, length: number, structure: Sentence['structure'] = 'body'): Sentence => ({
  ordinal,
  spineIndex,
  text: 'x'.repeat(length),
  structure,
  paragraphIndex: ordinal,
  href: 'part.xhtml',
  heading: false,
  emphasis: [],
});
describe('reader position cut-off', () => {
  it('reaches body end with 40 percent back matter at 60 percent', () => {
    const sentences = [sentence(1, 0, 30), sentence(2, 1, 30), sentence(3, 2, 40, 'notes')];
    expect(progressToOrdinal(sentences, { percentage: 60 })).toBe(2);
    expect(fractionToOrdinal(sentences, 1)).toBe(2);
  });
  it('does not reveal body in heavy front matter or incomplete sentences', () => {
    const sentences = [sentence(1, 0, 80, 'front'), sentence(2, 1, 20)];
    for (const percentage of [1, 10, 99]) expect(progressToOrdinal(sentences, { percentage })).toBe(0);
  });
  it('falls back for bad CFI and takes the smaller position including skipped itemrefs', () => {
    const sentences = [sentence(1, 0, 10), sentence(2, 2, 10), sentence(3, 3, 10)];
    expect(progressToOrdinal(sentences, { percentage: 100, cfi: 'broken' })).toBe(3);
    expect(progressToOrdinal(sentences, { percentage: 100, cfi: 'epubcfi(/6/4!/4/2)' })).toBe(1);
    expect(progressToOrdinal(sentences, { percentage: 100, cfi: 'epubcfi(/6/6[id]!/4/2)' })).toBe(1);
    expect(progressToOrdinal(sentences, { percentage: null })).toBe(0);
    expect(progressToOrdinal(sentences, { percentage: null, cfi: 'epubcfi(/6/6!/4/2)' })).toBe(1);
  });
  it('floors a percentage-only position to the last spine item that ends at or before it', () => {
    const sentences = [sentence(1, 0, 10), sentence(2, 1, 10), sentence(3, 2, 30), sentence(4, 2, 30), sentence(5, 3, 20)];
    expect(progressToOrdinal(sentences, { percentage: 50 })).toBe(2);
    expect(progressToOrdinal(sentences, { percentage: 80 })).toBe(4);
    expect(progressToOrdinal(sentences, { percentage: 100 })).toBe(5);
  });
  it('weighs a percentage-only position by spine item bytes when the artifact has them', () => {
    const sentences = [sentence(1, 0, 10), ...[2, 3, 4, 5, 6].map((ordinal) => sentence(ordinal, 1, 100))];
    expect(progressToOrdinal(sentences, { percentage: 50 }, [9000, 1000])).toBe(0);
    expect(progressToOrdinal(sentences, { percentage: 95 }, [9000, 1000])).toBe(1);
  });
  it('cuts inside the CFI item by its byte share, not by the character share of the whole book', () => {
    const sentences = [sentence(1, 0, 10), ...[2, 3, 4, 5, 6].map((ordinal) => sentence(ordinal, 1, 100))];
    const cfi = 'epubcfi(/6/4!/4/2/1:0)';
    expect(progressToOrdinal(sentences, { percentage: 91, cfi }, [9000, 1000])).toBe(1);
    expect(progressToOrdinal(sentences, { percentage: 96, cfi }, [9000, 1000])).toBe(4);
    expect(progressToOrdinal(sentences, { percentage: 100, cfi }, [9000, 1000])).toBe(6);
    expect(progressToOrdinal(sentences, { percentage: 96, cfi })).toBe(1);
  });
});
describe('card cut-off', () => {
  it('never rounds the cut below a term first seen after the last checkpoint', () => {
    const sentences = Array.from({ length: 1100 }, (_, index) => sentence(index + 1, 0, 10));
    expect(cardCutoff(sentences, 1018, 1015)).toBe(1015);
    expect(cardCutoff(sentences, 1018, 1003)).toBe(1003);
    expect(cardCutoff(sentences, 1050, 1015)).toBe(1040);
    expect(cardCutoff(sentences, 1018, 900)).toBe(1000);
  });
});
