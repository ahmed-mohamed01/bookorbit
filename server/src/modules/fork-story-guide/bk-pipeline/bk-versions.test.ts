import { describe, expect, it } from 'vitest';

import { BK_PROMPT_VERSION, bkPromptVersion } from './bk-versions';

describe('bkPromptVersion', () => {
  it('changes when one part goes up and another goes down', () => {
    expect(bkPromptVersion([15, 1, 2, 5, 13, 5])).not.toBe(bkPromptVersion([16, 0, 2, 5, 13, 5]));
  });

  it('tells apart parts that would run together as digits', () => {
    expect(bkPromptVersion([1, 12])).not.toBe(bkPromptVersion([11, 2]));
  });

  it('is the same for the same parts', () => {
    expect(bkPromptVersion([24, 3, 1])).toBe(bkPromptVersion([24, 3, 1]));
  });

  it('accepts a part past two digits', () => {
    expect(Number.isSafeInteger(bkPromptVersion([100, 1]))).toBe(true);
  });

  it('throws for a part that is not a whole number', () => {
    expect(() => bkPromptVersion([1.5])).toThrow(RangeError);
  });

  it('stays a safe positive integer', () => {
    expect(Number.isSafeInteger(BK_PROMPT_VERSION)).toBe(true);
    expect(BK_PROMPT_VERSION).toBeGreaterThan(0);
  });
});
