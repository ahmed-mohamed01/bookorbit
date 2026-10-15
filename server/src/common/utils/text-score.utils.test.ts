import { describe, expect, it } from 'vitest';
import { textScore } from './text-score.utils';

describe('textScore', () => {
  it('scores exact, prefix, contains and fuzzy in that order', () => {
    const exact = textScore('One Piece', 'one piece');
    const prefix = textScore('One Piece Story', 'one piece');
    const contains = textScore('The One Piece', 'one piece');
    const fuzzy = textScore('One Pice', 'one piece');
    expect(exact).toBe(1);
    expect(prefix).toBe(0.85);
    expect(contains).toBe(0.65);
    expect(fuzzy).toBeGreaterThan(0);
    expect(fuzzy).toBeLessThan(0.4);
  });

  it('ignores case and diacritics', () => {
    expect(textScore('Café Noir', 'cafe noir')).toBe(1);
  });

  it('scores unrelated text near zero', () => {
    expect(textScore('Berserk', 'zzzz')).toBe(0);
  });
});
