import { describe, expect, it } from 'vitest';

import { authorMatches, normalizeTitleTokens, titleTokensMatch } from './title-match';

describe('title matching', () => {
  it('normalizes accents and punctuation into tokens', () => {
    expect(normalizeTitleTokens('  Café: Book #2  ')).toEqual(['cafe', 'book', '2']);
  });

  it.each([
    ['The Infinite Extent', 'The Infinite Extent: Bobiverse, Book 6'],
    ['Antdustrial Revolution', 'Chrysalis 9: Antdustrial Revolution: A LitRPG Adventure'],
    ['The Path of Ascension 13', 'The Path of Ascension 13: A LitRPG Adventure'],
    ['Dungeon Crawler Carl, Vol. 2', 'Dungeon Crawler Carl, Vol. 2 (Graphic Novel) (Dungeon Crawler Carl Graphic Novels)'],
    ["Merlin's Way", 'Merlin’s Way'],
    ['Blightfall', 'Blightfall (Riftwake Book 1)'],
    ['Infinite Extent', 'The Infinite Extent'],
  ])('matches %s within %s', (work, candidate) => {
    expect(titleTokensMatch(work, candidate)).toBe(true);
  });

  it.each([
    ['Dune', 'Dune Messiah'],
    ['Scion', 'Scion of the Storm'],
    ['Untitled Stormlight Archive #7', 'Stormlight Archive MM Boxed Set I, Books 1-3'],
    ['Ghostbloods 2', 'Brandon Sanderson 3 Books Collection Set'],
    ['New Novella', 'New James S. A. Corey Novella #2'],
  ])('rejects %s against %s', (work, candidate) => {
    expect(titleTokensMatch(work, candidate)).toBe(false);
  });

  it.each([
    ['Dennis E. Taylor', 'Dennis E. Taylor (Author), Ray Porter (Narrator)'],
    ['J.R.R. Tolkien', 'J. R. R. Tolkien'],
    ['RinoZ', 'by RinoZ | Jul 15, 2026'],
    ['James S. A. Corey', 'James S. A. Corey'],
  ])('matches author %s within %s', (workAuthor, candidateAuthor) => {
    expect(authorMatches(workAuthor, candidateAuthor)).toBe(true);
  });

  it('rejects an author who only shares a surname', () => {
    expect(authorMatches('Frank Herbert', 'Brian Herbert, Kevin J. Anderson')).toBe(false);
  });
});
