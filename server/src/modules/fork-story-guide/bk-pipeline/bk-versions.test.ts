import { describe, expect, it } from 'vitest';

import { BK_PROMPT_VERSION, bkPromptVersion } from './bk-versions';

describe('bkPromptVersion', () => {
  it('changes when one part goes up and another goes down', () => {
    expect(bkPromptVersion([15, 1, 2, 5, 13, 5])).not.toBe(bkPromptVersion([16, 0, 2, 5, 13, 5]));
  });

  it('pads each part to two digits', () => {
    expect(bkPromptVersion([15, 1, 2])).toBe(150102);
  });

  it('throws for a part that does not fit two digits', () => {
    expect(() => bkPromptVersion([100, 1])).toThrow(RangeError);
  });

  it('stays a safe positive integer', () => {
    expect(Number.isSafeInteger(BK_PROMPT_VERSION)).toBe(true);
    expect(BK_PROMPT_VERSION).toBeGreaterThan(0);
  });
});
