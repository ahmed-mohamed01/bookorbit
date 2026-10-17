import { describe, expect, it } from 'vitest';

import type { HardcoverAuthorSearchDocument } from '../metadata-fetch/providers/hardcover/hardcover.types';
import { strongestHitPerName } from './hardcover-author-hits.utils';

function hit(patch: Partial<HardcoverAuthorSearchDocument> = {}): HardcoverAuthorSearchDocument {
  return { id: 1, name: 'Some Author', books_count: 0, ...patch };
}

describe('strongestHitPerName', () => {
  it('keeps the hit with the most books when several records fold onto one name', () => {
    const result = strongestHitPerName([
      hit({ id: 1, name: 'Brandon Sanderson', books_count: 2 }),
      hit({ id: 2, name: 'brandon sanderson', books_count: 60 }),
      hit({ id: 3, name: 'Brandon Sanderson', books_count: 30 }),
    ]);

    expect(result.map((candidate) => candidate.id)).toEqual([2]);
  });

  it('keeps one hit per distinct folded name and treats a missing count as zero', () => {
    const result = strongestHitPerName([
      hit({ id: 1, name: 'Sandé Brandt', books_count: 5 }),
      hit({ id: 2, name: 'Sande Brandt' }),
      hit({ id: 3, name: 'Wes Craven', books_count: 12 }),
    ]);

    expect(result.map((candidate) => candidate.id)).toEqual([1, 3]);
  });

  it('returns nothing for an empty list', () => {
    expect(strongestHitPerName([])).toEqual([]);
  });
});
