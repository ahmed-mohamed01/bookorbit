import { describe, expect, it } from 'vitest';

import { computeAnchorFraction } from './reading-alignment-fraction.util';

const SPINES = [
  { spineIndex: 0, text: 'aaaaa' }, // 5 chars, offsets 0-4
  { spineIndex: 1, text: 'bbbbbbbbbb' }, // 10 chars, offsets 5-14
  { spineIndex: 2, text: 'ccccCTARGETcccc' }, // 15 chars, offsets 15-29
];
// Total chars = 30.

describe('computeAnchorFraction', () => {
  it('computes the cumulative offset across earlier spines', () => {
    // Phrase at the very start of spine 1: cumulativeBefore = 5, indexInSpine = 0 -> 5/30.
    expect(computeAnchorFraction(SPINES, 1, 'bbbbbbbbbb')).toBeCloseTo(5 / 30, 9);
  });

  it('locates a phrase inside a later spine', () => {
    // 'TARGET' starts at index 5 within spine 2; cumulativeBefore = 5 + 10 = 15 -> (15+5)/30.
    expect(computeAnchorFraction(SPINES, 2, 'TARGET')).toBeCloseTo(20 / 30, 9);
  });

  it('returns 0 for a phrase at the very start of the first spine', () => {
    expect(computeAnchorFraction(SPINES, 0, 'aaaaa')).toBeCloseTo(0, 9);
  });

  it('sorts defensively when spines arrive out of order', () => {
    const shuffled = [SPINES[2]!, SPINES[0]!, SPINES[1]!];
    expect(computeAnchorFraction(shuffled, 2, 'TARGET')).toBeCloseTo(20 / 30, 9);
  });

  it('returns null when the phrase is not found in the target spine', () => {
    expect(computeAnchorFraction(SPINES, 1, 'not-present')).toBeNull();
  });

  it('returns null when the target spine is absent', () => {
    expect(computeAnchorFraction(SPINES, 99, 'aaaaa')).toBeNull();
  });

  it('returns null for empty input or empty concatenation', () => {
    expect(computeAnchorFraction([], 0, 'x')).toBeNull();
    expect(computeAnchorFraction([{ spineIndex: 0, text: '' }], 0, 'x')).toBeNull();
  });
});
