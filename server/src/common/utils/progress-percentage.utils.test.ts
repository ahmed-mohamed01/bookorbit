import { describe, expect, it } from 'vitest';

import { isStoredPercentageChanged } from './progress-percentage.utils';

describe('isStoredPercentageChanged', () => {
  it('treats a value read back from a real column as unchanged', () => {
    expect(isStoredPercentageChanged(Math.fround(85.240191542863), 85.240191542863)).toBe(false);
    expect(isStoredPercentageChanged(85.24019, 85.240191542863)).toBe(false);
  });

  it('reports real movement', () => {
    expect(isStoredPercentageChanged(85.24, 85.25)).toBe(true);
    expect(isStoredPercentageChanged(0, 0.01)).toBe(true);
  });

  it('reports a change when there is no previous value', () => {
    expect(isStoredPercentageChanged(null, 0)).toBe(true);
    expect(isStoredPercentageChanged(undefined, 50)).toBe(true);
  });
});
