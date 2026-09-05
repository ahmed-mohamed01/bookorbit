import { describe, expect, it } from 'vitest';

import {
  chooseOwnedCandidate,
  OWNED_MATCH_TIER,
  seriesBridgeTokens,
  seriesPrefixMatch,
  spacedTitleTokens,
  titleMatchKeys,
} from './monitored-catalog.service';
import type { OwnedCandidate, OwnedClaim } from './monitored-catalog.service';

/** True when a catalog title and a library title share any key, which is what claims the file. */
function keysOverlap(catalogTitle: string, libraryTitle: string): boolean {
  const library = new Set(titleMatchKeys(libraryTitle));
  return titleMatchKeys(catalogTitle).some((key) => library.has(key));
}

describe('titleMatchKeys', () => {
  it('folds vs./versus so both title forms share a key', () => {
    expect(keysOverlap('Alcatraz vs. the Evil Librarians', 'Alcatraz versus the Evil Librarians')).toBe(true);
  });

  it('matches a subtitled library edition to the bare catalog title', () => {
    const catalog = titleMatchKeys('Elantris');
    const library = titleMatchKeys('Elantris: Tenth Anniversary Definitive Edition');
    expect(library).toContain(catalog[0]);
  });

  it('strips a trailing parenthetical, including an unclosed one', () => {
    const library = titleMatchKeys('Sunreach (Skyward Flight');
    expect(library).toContain('sunreach');
  });

  it('does not emit short stripped cores that could alias across works', () => {
    const keys = titleMatchKeys('Lux: A Novel');
    expect(keys).not.toContain('lux');
  });

  it('keeps edition variants of one book on the owned file', () => {
    for (const variant of [
      'The Way of Kings: The Stormlight Archive',
      'The Way of Kings: The first book of the breathtaking epic Stormlight Archive from the worldwide fantasy sensation',
      'The Way of Kings, Part 1',
      'The Way of Kings, Part 2',
      'The Way of Kings (3 of 5) [Dramatized Adaptation]',
      'The Way of Kings (Unabridged)',
    ]) {
      expect(keysOverlap(variant, 'The Way of Kings')).toBe(true);
    }
  });

  it('refuses a distinct book whose title merely starts with the owned title', () => {
    expect(keysOverlap('The Way of Kings Prime', 'The Way of Kings')).toBe(false);
  });

  it('refuses a sampler compilation that only names the owned book', () => {
    expect(keysOverlap('Brandon Sanderson Sampler: The Way of Kings and Mistborn', 'The Way of Kings')).toBe(false);
  });

  it('still matches the owned Way of Kings Prime file to its own work', () => {
    expect(keysOverlap('The Way of Kings Prime', 'The Way of Kings Prime')).toBe(true);
  });
});

describe('spacedTitleTokens', () => {
  it('produces space-separated folded tokens for token comparison', () => {
    expect(spacedTitleTokens("The Scrivener's Bones")).toBe('the scrivener s bones');
    expect(spacedTitleTokens('Alcatraz VERSUS the Shattered Lens')).toBe('alcatraz vs the shattered lens');
  });
});

describe('seriesPrefixMatch', () => {
  const bridge = (catalogSeries: string | null, librarySeries: string | null): Set<string> => seriesBridgeTokens(catalogSeries, librarySeries);

  it('bridges a series-prefixed library title to the bare catalog title', () => {
    expect(
      seriesPrefixMatch(
        spacedTitleTokens('The Shattered Lens'),
        spacedTitleTokens('Alcatraz versus the Shattered Lens'),
        bridge('Alcatraz vs. the Evil Librarians', 'Alcatraz'),
      ),
    ).toBe(true);
    expect(
      seriesPrefixMatch(
        spacedTitleTokens('The Knights of Crystallia'),
        spacedTitleTokens('Alcatraz versus the Knights of Crystallia'),
        bridge('Alcatraz vs. the Evil Librarians', 'Alcatraz'),
      ),
    ).toBe(true);
  });

  it('bridges a leading article that only one side carries', () => {
    expect(seriesPrefixMatch(spacedTitleTokens('Bands of Mourning'), spacedTitleTokens('The Bands of Mourning'), bridge(null, null))).toBe(true);
  });

  it('refuses a surplus token no series explains', () => {
    expect(
      seriesPrefixMatch(spacedTitleTokens('The Way of Kings Prime'), spacedTitleTokens('The Way of Kings'), bridge(null, 'The Stormlight Archive')),
    ).toBe(false);
  });

  it('refuses a sampler that merely contains the owned title', () => {
    expect(
      seriesPrefixMatch(
        spacedTitleTokens('Brandon Sanderson Sampler: The Way of Kings and Mistborn'),
        spacedTitleTokens('The Way of Kings'),
        bridge(null, 'The Stormlight Archive'),
      ),
    ).toBe(false);
  });

  it('rejects short titles that would swallow unrelated supersets', () => {
    expect(seriesPrefixMatch(spacedTitleTokens('Legion'), spacedTitleTokens('Legion Skin Deep'), bridge(null, null))).toBe(false);
    expect(seriesPrefixMatch(spacedTitleTokens('The One'), spacedTitleTokens('The Original One'), bridge(null, null))).toBe(false);
  });

  it('rejects overlapping-but-not-contained titles', () => {
    expect(seriesPrefixMatch(spacedTitleTokens('The Way of Kings'), spacedTitleTokens('The Way of Shadows'), bridge(null, null))).toBe(false);
  });
});

function candidate(bookId: number, patch: Partial<OwnedCandidate> = {}): OwnedCandidate {
  return { bookId, titleKey: `book${bookId}`, seriesName: null, seriesIndex: null, publishedYear: null, formats: new Set(['epub']), ...patch };
}

function claim(bookId: number, tier: number, patch: Partial<OwnedCandidate> = {}): OwnedClaim {
  return { candidate: candidate(bookId, patch), tier };
}

describe('chooseOwnedCandidate', () => {
  it('returns the only candidate untouched', () => {
    expect(
      chooseOwnedCandidate({ seriesName: null, seriesIndex: null, releaseYear: null }, [claim(1, OWNED_MATCH_TIER.titleCore)])?.candidate.bookId,
    ).toBe(1);
  });

  it('gives two same-core works of different years the file that matches each', () => {
    // "Collected Poems" 1990 and "Collected Poems" 2020 fold onto one core, so both see both files.
    const claims = [claim(11, OWNED_MATCH_TIER.titleCore, { publishedYear: 1990 }), claim(22, OWNED_MATCH_TIER.titleCore, { publishedYear: 2020 })];

    expect(chooseOwnedCandidate({ seriesName: null, seriesIndex: null, releaseYear: 1990 }, claims)?.candidate.bookId).toBe(11);
    expect(chooseOwnedCandidate({ seriesName: null, seriesIndex: null, releaseYear: 2020 }, claims)?.candidate.bookId).toBe(22);
  });

  it('refuses to guess between two candidates that disagree about which book they are', () => {
    const claims = [claim(11, OWNED_MATCH_TIER.titleCore), claim(22, OWNED_MATCH_TIER.titleCore)];

    expect(chooseOwnedCandidate({ seriesName: null, seriesIndex: null, releaseYear: 2001 }, claims)).toBeNull();
  });

  it('takes the stable copy when the candidates are the same book shelved more than once', () => {
    // Real libraries hold duplicates; three rows of one audiobook are not a namesake collision.
    const claims = [
      claim(249, OWNED_MATCH_TIER.titleCore, { titleKey: 'perfectstateunabridged', publishedYear: 2015 }),
      claim(196, OWNED_MATCH_TIER.titleCore, { titleKey: 'perfectstateunabridged', publishedYear: 2015 }),
      claim(197, OWNED_MATCH_TIER.titleCore, { titleKey: 'perfectstateunabridged', publishedYear: 2015 }),
    ];

    expect(chooseOwnedCandidate({ seriesName: null, seriesIndex: null, releaseYear: 2015 }, claims)?.candidate.bookId).toBe(196);
  });

  it('treats two printings of one book a year apart as the same book', () => {
    // "Alcatraz vs. the Shattered Lens" (2010) and "Alcatraz Versus the Shattered Lens" (2011).
    const claims = [
      claim(166, OWNED_MATCH_TIER.seriesPrefix, { titleKey: 'alcatrazvstheshatteredlens', publishedYear: 2011 }),
      claim(153, OWNED_MATCH_TIER.seriesPrefix, { titleKey: 'alcatrazvstheshatteredlens', publishedYear: 2010 }),
    ];

    expect(chooseOwnedCandidate({ seriesName: null, seriesIndex: null, releaseYear: 2010 }, claims)?.candidate.bookId).toBe(153);
  });

  it('still refuses two namesake editions whose printings are decades apart', () => {
    const claims = [
      claim(11, OWNED_MATCH_TIER.titleCore, { titleKey: 'collectedpoems', publishedYear: 1990 }),
      claim(22, OWNED_MATCH_TIER.titleCore, { titleKey: 'collectedpoems', publishedYear: 2020 }),
    ];

    expect(chooseOwnedCandidate({ seriesName: null, seriesIndex: null, releaseYear: null }, claims)).toBeNull();
  });

  it('refuses to guess when both candidates sit the same distance from the work year', () => {
    const claims = [claim(11, OWNED_MATCH_TIER.titleCore, { publishedYear: 1990 }), claim(22, OWNED_MATCH_TIER.titleCore, { publishedYear: 2020 })];

    expect(chooseOwnedCandidate({ seriesName: null, seriesIndex: null, releaseYear: 2005 }, claims)).toBeNull();
  });

  it('lets a provider-id match settle a tie a title tier could not', () => {
    const claims = [claim(11, OWNED_MATCH_TIER.providerId), claim(22, OWNED_MATCH_TIER.titleCore, { publishedYear: 2020 })];

    expect(chooseOwnedCandidate({ seriesName: null, seriesIndex: null, releaseYear: 2020 }, claims)?.candidate.bookId).toBe(11);
  });

  it('lets the work series slot settle a tie between same-tier candidates', () => {
    const claims = [
      claim(11, OWNED_MATCH_TIER.titleCore, { seriesName: 'The Stormlight Archive', seriesIndex: '1' }),
      claim(22, OWNED_MATCH_TIER.titleCore, { seriesName: 'Mistborn', seriesIndex: '3' }),
    ];

    expect(chooseOwnedCandidate({ seriesName: 'The Stormlight Archive', seriesIndex: '1.0', releaseYear: null }, claims)?.candidate.bookId).toBe(11);
  });
});
