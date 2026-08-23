import { describe, expect, it } from 'vitest';

import { normalizeForMatch } from './reading-alignment-text.util';

describe('normalizeForMatch', () => {
  it('lowercases, removes punctuation, and collapses whitespace', () => {
    expect(normalizeForMatch("Mr. O'Brien,")).toBe('mr obrien');
  });

  it('makes book text and a stripped transcript substring-comparable', () => {
    const bookText = normalizeForMatch("It was Mr. O'Brien, of course.");
    const transcript = normalizeForMatch('mr obrien');
    expect(bookText).toContain(transcript);
  });

  it('folds smart single and double quotes to a matchable form', () => {
    const smart = normalizeForMatch('“don’t”');
    const straight = normalizeForMatch('"don\'t"');
    expect(smart).toBe(straight);
    expect(smart).toBe('dont');
  });

  it('removes soft hyphens so hyphenated line breaks do not block a match', () => {
    expect(normalizeForMatch('encyclo­pedia')).toBe('encyclopedia');
  });

  it('normalizes unicode compatibility forms via NFKC', () => {
    const combining = normalizeForMatch('café');
    const precomposed = normalizeForMatch('café');
    expect(combining).toBe(precomposed);
    expect(precomposed).toBe('café');
  });

  it('treats non-breaking spaces as ordinary spaces', () => {
    expect(normalizeForMatch('New York')).toBe('new york');
  });

  it("does NOT expand abbreviations - that is the fuzzy matcher's job", () => {
    const bookForm = normalizeForMatch("Mr. O'Brien");
    const whisperForm = normalizeForMatch('Mister OBrien');
    expect(bookForm).toBe('mr obrien');
    expect(whisperForm).toBe('mister obrien');
    expect(bookForm).not.toBe(whisperForm);
  });

  it('returns an empty string for empty input', () => {
    expect(normalizeForMatch('')).toBe('');
  });
});
