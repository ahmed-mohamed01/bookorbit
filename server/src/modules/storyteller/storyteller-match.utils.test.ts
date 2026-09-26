import { describe, expect, it } from 'vitest';

import type { StorytellerBookSummary } from './storyteller-client.types';
import { canonicalStorytellerIdentifier, matchExistingBooks } from './storyteller-match.utils';

function remoteBook(overrides: Partial<StorytellerBookSummary> = {}): StorytellerBookSummary {
  return {
    uuid: 'uuid-1',
    title: 'Foundation',
    authors: ['Isaac Asimov'],
    identifiers: [],
    aligned: true,
    hasEbook: true,
    hasAudiobook: true,
    readaloudPath: null,
    processing: { state: 'completed', task: null, progress: null, error: null },
    ...overrides,
  };
}

describe('canonicalStorytellerIdentifier', () => {
  it('keeps ISBN-13 and ASIN values', () => {
    expect(canonicalStorytellerIdentifier('978-0-553-29335-7')).toBe('9780553293357');
    expect(canonicalStorytellerIdentifier(' B00X57B4KG ')).toBe('b00x57b4kg');
  });

  it('widens ISBN-10 to its ISBN-13 form, check digit included', () => {
    expect(canonicalStorytellerIdentifier('0-553-29335-4')).toBe('9780553293357');
    expect(canonicalStorytellerIdentifier('080442957X')).toBe('9780804429573');
  });

  it('refuses anything that is not a book identifier', () => {
    expect(canonicalStorytellerIdentifier('1')).toBeNull();
    expect(canonicalStorytellerIdentifier('42')).toBeNull();
    expect(canonicalStorytellerIdentifier('goodreads-12345')).toBeNull();
    expect(canonicalStorytellerIdentifier('A00X57B4KG')).toBeNull();
    expect(canonicalStorytellerIdentifier(null)).toBeNull();
  });
});

describe('matchExistingBooks', () => {
  it('scores a shared identifier as certain even when the titles disagree', () => {
    const matches = matchExistingBooks({ title: 'Completely Different', authors: [], identifiers: ['978-0-553-29335-7'] }, [
      remoteBook({ identifiers: ['9780553293357'] }),
    ]);

    expect(matches).toEqual([{ uuid: 'uuid-1', title: 'Foundation', authors: ['Isaac Asimov'], aligned: true, score: 100 }]);
  });

  it('matches an ISBN-10 on one side against the ISBN-13 on the other', () => {
    const matches = matchExistingBooks({ title: 'Completely Different', authors: [], identifiers: ['0-553-29335-4'] }, [
      remoteBook({ identifiers: ['9780553293357'] }),
    ]);

    expect(matches[0].score).toBe(100);
  });

  it('does not let a junk identifier prove a match', () => {
    const matches = matchExistingBooks({ title: 'Completely Different', authors: ['Nobody'], identifiers: ['1'] }, [
      remoteBook({ identifiers: ['1'] }),
    ]);

    expect(matches).toEqual([]);
  });

  it('scores title and author similarity on the edition-link scale', () => {
    const matches = matchExistingBooks({ title: 'Foundation', authors: ['Isaac Asimov'], identifiers: [] }, [remoteBook()]);

    expect(matches).toHaveLength(1);
    expect(matches[0].score).toBe(100);
  });

  it('drops candidates below the match floor', () => {
    const matches = matchExistingBooks({ title: 'Foundation', authors: ['Isaac Asimov'], identifiers: [] }, [
      remoteBook({ uuid: 'uuid-2', title: 'Nightfall', authors: ['Robert Silverberg'] }),
    ]);

    expect(matches).toEqual([]);
  });

  it('refuses a different volume of the same series', () => {
    const matches = matchExistingBooks({ title: 'The Primal Hunter 3', authors: ['Zogarth'], identifiers: [] }, [
      remoteBook({ uuid: 'uuid-3', title: 'The Primal Hunter 16', authors: ['Zogarth'] }),
    ]);

    expect(matches).toEqual([]);
  });

  it('sorts by score and keeps unaligned candidates visible', () => {
    const matches = matchExistingBooks({ title: 'Foundation', authors: ['Isaac Asimov'], identifiers: ['b00x57b4kg'] }, [
      remoteBook({ uuid: 'uuid-weak', title: 'Foundation', authors: ['I. Asimov'], aligned: false }),
      remoteBook({ uuid: 'uuid-exact', identifiers: ['B00X57B4KG'] }),
    ]);

    expect(matches.map((match) => match.uuid)).toEqual(['uuid-exact', 'uuid-weak']);
    expect(matches[0].score).toBe(100);
    expect(matches[1].aligned).toBe(false);
    expect(matches[1].score).toBeLessThan(100);
  });

  it('falls back to the title alone when one side has no authors', () => {
    const matches = matchExistingBooks({ title: 'Foundation', authors: [], identifiers: [] }, [remoteBook({ authors: [] })]);

    expect(matches[0].score).toBe(100);
  });

  it('returns nothing without a usable title and no identifiers', () => {
    expect(matchExistingBooks({ title: '', authors: ['Isaac Asimov'], identifiers: [] }, [remoteBook()])).toEqual([]);
    expect(matchExistingBooks({ title: 'Foundation', authors: [], identifiers: [] }, [remoteBook({ title: '' })])).toEqual([]);
  });

  it('lets an unrelated identifier fall through to title scoring', () => {
    const matches = matchExistingBooks({ title: 'Foundation', authors: ['Isaac Asimov'], identifiers: ['9999999999999'] }, [
      remoteBook({ identifiers: ['9780553293357'] }),
    ]);

    expect(matches[0].score).toBe(100);
  });
});
