import { describe, expect, it } from 'vitest';

import { foldedQueryWords, identityLikePattern, identityLikeRun, normalizeMonitoredName, titleAuthorKey } from './monitored-text.utils';

/** What PostgreSQL LIKE does with a pattern, flattened onto a regex the same way. */
function likeMatches(pattern: string, value: string): boolean {
  return new RegExp(
    `^${pattern
      .split('%')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  ).test(value);
}

describe('identityLikePattern', () => {
  it('folds punctuation runs into wildcards so "Ender\'s Game" finds "Enders Game"', () => {
    const pattern = identityLikePattern("Ender's Game");
    expect(pattern).toBe('Ender%s%Game');
    expect(likeMatches(pattern ?? '', 'Enders Game')).toBe(true);
    expect(likeMatches(pattern ?? '', 'Ender’s  Game')).toBe(true);
    expect(likeMatches(pattern ?? '', 'Ender Game')).toBe(false);
  });

  it('keeps every word of a colon-separated title', () => {
    expect(identityLikePattern('Mistborn: The Final Empire')).toBe('Mistborn%The%Final%Empire');
  });

  it('keeps escaping invisible: a percent sign is just another separator', () => {
    expect(identityLikePattern('50% off')).toBe('50%off');
  });

  it('still matches its own stored title when it ends in punctuation', () => {
    const pattern = identityLikePattern('Who Moved My Cheese?');

    expect(pattern).toBe('Who%Moved%My%Cheese%');
    expect(likeMatches(pattern ?? '', 'Who Moved My Cheese?')).toBe(true);
  });

  it('still matches its own stored name when it ends in an abbreviation', () => {
    const pattern = identityLikePattern('Martin Luther King Jr.');

    expect(likeMatches(pattern ?? '', 'Martin Luther King Jr.')).toBe(true);
  });

  it('returns null when nothing but separators remains', () => {
    expect(identityLikePattern('...')).toBeNull();
    expect(identityLikePattern(' - ')).toBeNull();
    expect(identityLikePattern('')).toBeNull();
  });
});

describe('identityLikeRun', () => {
  it('takes the longest letter-or-digit run of the folded value, ties going to the earliest', () => {
    expect(['leguin', 'ursula']).toContain(identityLikeRun('Ursula K. LeGuin'));
    expect(identityLikeRun("Ender's Game")).toBe('ender');
    expect(identityLikeRun('Spider-Man')).toBe('spider');
  });

  it('accent-folds and lowercases before picking the run', () => {
    expect(identityLikeRun('Sousou no Frieren')).toBe('frieren');
    expect(identityLikeRun('Métal Hurlant')).toBe('hurlant');
  });

  it('keeps a run shorter than three chars when nothing longer exists', () => {
    expect(identityLikeRun('Jo Xu')).toBe('jo');
  });

  it('keeps non-Latin runs intact', () => {
    expect(identityLikeRun('宮崎 駿')).toBe('宮崎');
  });

  it('returns null when nothing but separators remains', () => {
    expect(identityLikeRun('...')).toBeNull();
    expect(identityLikeRun(' - ')).toBeNull();
    expect(identityLikeRun('')).toBeNull();
  });
});

describe('titleAuthorKey', () => {
  it('joins the folded title and author with a pipe', () => {
    expect(titleAuthorKey('The Final Empire', 'Brandon Sanderson')).toBe('thefinalempire|brandonsanderson');
  });

  it('treats null halves as empty rather than undefined', () => {
    expect(titleAuthorKey(null, 'Brandon Sanderson')).toBe('|brandonsanderson');
    expect(titleAuthorKey('Mistborn', undefined)).toBe('mistborn|');
  });
});

describe('foldedQueryWords', () => {
  it('accent-folds before lowercasing and splits on anything not a letter or digit', () => {
    expect(foldedQueryWords('Red Rising')).toEqual(['red', 'rising']);
    expect(foldedQueryWords('Sandé: The   Legend')).toEqual(['sande', 'the', 'legend']);
  });

  it('keeps non-Latin letters, which is what keeps two non-Latin names distinct', () => {
    expect(foldedQueryWords('宮崎 駿')).toEqual(['宮崎', '駿']);
    expect(normalizeMonitoredName('宮崎 駿')).toBe('宮崎駿');
  });

  it('returns no words for a punctuation-only query', () => {
    expect(foldedQueryWords('...!?')).toEqual([]);
  });
});
