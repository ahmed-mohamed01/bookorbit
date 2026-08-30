import { describe, expect, it } from 'vitest';

import { normalizeName, scoreTitle, titleVolumeConflict } from './fuzzy-match.utils';

describe('titleVolumeConflict', () => {
  it('flags two volumes of the same series, which edit distance is nearly blind to', () => {
    expect(titleVolumeConflict('The Primal Hunter 3', 'The Primal Hunter 16')).toBe(true);
  });

  it('reads the full title including the subtitle, so a volume in either subtitle still conflicts', () => {
    expect(titleVolumeConflict('The Primal Hunter 3', 'The Primal Hunter: A LitRPG Adventure, Book 16')).toBe(true);
  });

  it('allows the same volume written differently on each side', () => {
    expect(titleVolumeConflict('The Primal Hunter 3', 'The Primal Hunter: A LitRPG Adventure, Book 3')).toBe(false);
  });

  it('allows a one-sided number, because subtitles and editions often drop the volume', () => {
    expect(titleVolumeConflict('The Primal Hunter', 'The Primal Hunter 3')).toBe(false);
    expect(titleVolumeConflict('The Primal Hunter 3', 'The Primal Hunter')).toBe(false);
    expect(titleVolumeConflict('The Hobbit', 'The Hobbit')).toBe(false);
  });

  it('ignores ordinal edition numbers, which name a printing rather than a volume', () => {
    expect(
      titleVolumeConflict('The Fellowship of the Ring: 50th Anniversary Edition', 'The Fellowship of the Ring: The Lord of the Rings, Part 1'),
    ).toBe(false);
    expect(titleVolumeConflict('Dune: 1st Edition', 'Dune: 2nd Edition')).toBe(false);
    expect(titleVolumeConflict('The Book: 3rd Printing', 'The Book: 20th Printing')).toBe(false);
  });

  it('still conflicts when an ordinal edition sits beside a real volume number', () => {
    expect(titleVolumeConflict('The Primal Hunter 3: 50th Anniversary Edition', 'The Primal Hunter 16')).toBe(true);
  });

  it('compares decimal volumes by value', () => {
    expect(titleVolumeConflict('Series Name 3.5', 'Series Name 3.5')).toBe(false);
    expect(titleVolumeConflict('Series Name 3.5', 'Series Name 3')).toBe(true);
  });

  it('compares the last number on each side, so a leading year does not decide it', () => {
    expect(titleVolumeConflict('1984 Annotated 2', '1984 Annotated 2')).toBe(false);
    expect(titleVolumeConflict('1984 Annotated 2', '1984 Annotated 3')).toBe(true);
  });
});

describe('scoreTitle', () => {
  it('scores identical titles 1 and unrelated titles low', () => {
    expect(scoreTitle('The Two Towers', 'The Two Towers')).toBe(1);
    expect(scoreTitle('The Hobbit', 'Cooking for Beginners')).toBeLessThan(0.5);
  });

  it('ignores the subtitle, so an edition subtitle does not depress the score', () => {
    expect(scoreTitle('The Fellowship of the Ring: 50th Anniversary Edition', 'The Fellowship of the Ring')).toBe(1);
  });

  it('scores an empty side 0', () => {
    expect(scoreTitle('', 'The Two Towers')).toBe(0);
    expect(scoreTitle('   ', 'The Two Towers')).toBe(0);
  });
});

describe('normalizeName', () => {
  it('lowercases, strips diacritics and punctuation, and collapses whitespace', () => {
    expect(normalizeName('  J.R.R.   Tolkien  ')).toBe('j r r tolkien');
    expect(normalizeName('Émile Zola')).toBe('emile zola');
  });

  it('keeps digits, which is what the volume guard reads', () => {
    expect(normalizeName('The Primal Hunter #3')).toBe('the primal hunter 3');
  });
});
