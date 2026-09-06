import { describe, expect, it } from 'vitest';

import { audioSecondsToEbook, ebookFractionToAudioSeconds, type Anchor } from './reading-alignment-resolver.util';

// audioSeconds and ebookFraction both ascend monotonically.
const ANCHORS: Anchor[] = [
  { audioSeconds: 0, ebookFraction: 0, spineIndex: 0, phrase: 'the beginning' },
  { audioSeconds: 100, ebookFraction: 0.25, spineIndex: 2, phrase: 'a quarter in' },
  { audioSeconds: 300, ebookFraction: 0.75, spineIndex: 6, phrase: 'three quarters' },
  { audioSeconds: 400, ebookFraction: 1, spineIndex: 9, phrase: 'the very end' },
];

describe('audioSecondsToEbook', () => {
  it('interpolates the percentage between two bracketing anchors', () => {
    // Halfway (200s) between the 100s (0.25) and 300s (0.75) anchors -> fraction 0.5.
    const result = audioSecondsToEbook(ANCHORS, 200);
    expect(result?.percentage).toBeCloseTo(50, 6);
  });

  it('returns the nearest anchor phrase and spineIndex', () => {
    // 120s is closer to the 100s anchor than the 300s anchor.
    expect(audioSecondsToEbook(ANCHORS, 120)).toMatchObject({ spineIndex: 2, phrase: 'a quarter in' });
    // 280s is closer to the 300s anchor.
    expect(audioSecondsToEbook(ANCHORS, 280)).toMatchObject({ spineIndex: 6, phrase: 'three quarters' });
  });

  it('clamps below the first anchor to the start', () => {
    const result = audioSecondsToEbook(ANCHORS, -50);
    expect(result).toMatchObject({ spineIndex: 0, phrase: 'the beginning' });
    expect(result?.percentage).toBeCloseTo(0, 6);
  });

  it('clamps above the last anchor to the end', () => {
    const result = audioSecondsToEbook(ANCHORS, 99999);
    expect(result).toMatchObject({ spineIndex: 9, phrase: 'the very end' });
    expect(result?.percentage).toBeCloseTo(100, 6);
  });

  it('sorts defensively when anchors arrive out of order', () => {
    const shuffled = [ANCHORS[3]!, ANCHORS[0]!, ANCHORS[2]!, ANCHORS[1]!];
    expect(audioSecondsToEbook(shuffled, 200)?.percentage).toBeCloseTo(50, 6);
  });

  it('ignores anchors with a null (missing) fraction', () => {
    const withNull: Anchor[] = [
      { audioSeconds: 0, ebookFraction: 0, spineIndex: 0, phrase: 'start' },
      { audioSeconds: 50, ebookFraction: null as unknown as number, spineIndex: 1, phrase: 'dropped' },
      { audioSeconds: 100, ebookFraction: 1, spineIndex: 2, phrase: 'end' },
    ];
    const result = audioSecondsToEbook(withNull, 50);
    // With the middle anchor dropped, 50s sits halfway between the 0s and 100s anchors -> 50%.
    expect(result?.percentage).toBeCloseTo(50, 6);
    expect(result?.phrase === 'start' || result?.phrase === 'end').toBe(true);
  });

  it('returns null with fewer than two usable anchors', () => {
    expect(audioSecondsToEbook([ANCHORS[0]!], 10)).toBeNull();
    expect(audioSecondsToEbook([], 10)).toBeNull();
  });
});

describe('ebookFractionToAudioSeconds', () => {
  it('interpolates audioSeconds on the fraction axis', () => {
    // Fraction 0.5 sits halfway between the 0.25 (100s) and 0.75 (300s) anchors -> 200s.
    expect(ebookFractionToAudioSeconds(ANCHORS, 0.5)).toBeCloseTo(200, 6);
  });

  it('clamps below the first fraction', () => {
    expect(ebookFractionToAudioSeconds(ANCHORS, -1)).toBeCloseTo(0, 6);
  });

  it('clamps above the last fraction', () => {
    expect(ebookFractionToAudioSeconds(ANCHORS, 5)).toBeCloseTo(400, 6);
  });

  it('is the inverse of audioSecondsToEbook at anchor points', () => {
    expect(ebookFractionToAudioSeconds(ANCHORS, 0.25)).toBeCloseTo(100, 6);
    expect(ebookFractionToAudioSeconds(ANCHORS, 0.75)).toBeCloseTo(300, 6);
  });

  it('returns null with fewer than two usable anchors', () => {
    expect(ebookFractionToAudioSeconds([ANCHORS[0]!], 0.5)).toBeNull();
  });
});
