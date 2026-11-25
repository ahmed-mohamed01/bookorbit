import { describe, expect, it } from 'vitest';
import { bestLongForm, extractAbbreviationLinks } from './abbreviations';
import type { Sentence } from './model';

function sentence(ordinal: number, text: string, structure: Sentence['structure'] = 'body'): Sentence {
  return { ordinal, spineIndex: 1, paragraphIndex: ordinal, href: 'a.xhtml', text, structure, heading: false, emphasis: [] };
}
const keys = (...values: string[]) => new Set(values);

describe('bestLongForm', () => {
  it('finds the long form whose words spell the short form', () => {
    expect(bestLongForm('SGD', 'we train it with stochastic gradient descent')).toBe('stochastic gradient descent');
    expect(bestLongForm('WBE', 'see also whole brain emulation')).toBe('whole brain emulation');
    expect(bestLongForm('CEV', 'the idea of coherent extrapolated volition')).toBe('coherent extrapolated volition');
  });

  it('rejects brackets whose letters are not in the words before', () => {
    expect(bestLongForm('IBM', 'a system called Watson')).toBeNull();
    expect(bestLongForm('XYZ', 'stochastic gradient descent')).toBeNull();
  });
});

describe('extractAbbreviationLinks', () => {
  const terms = keys(
    'stochastic gradient descent',
    'sgd',
    'whole brain emulation',
    'wbe',
    'watson',
    'ibm',
    'moral permissibility',
    'moral principle',
    'mp',
  );

  it('links "long form (SHORT)" from the sentence that states it', () => {
    const links = extractAbbreviationLinks(
      [sentence(1, 'SGD appears here first.'), sentence(2, 'We use stochastic gradient descent (SGD) throughout.'), sentence(3, 'SGD converges.')],
      terms,
    );
    expect(links).toEqual([{ left: 'stochastic gradient descent', right: 'sgd', ordinal: 2 }]);
  });

  it('links "SHORT (long form)", quoted short forms and plurals', () => {
    expect(extractAbbreviationLinks([sentence(4, 'Most work on SGD (stochastic gradient descent) is recent.')], terms)).toEqual([
      { left: 'stochastic gradient descent', right: 'sgd', ordinal: 4 },
    ]);
    expect(extractAbbreviationLinks([sentence(5, 'Consider whole brain emulations (“WBEs”) next.')], terms)).toEqual([
      { left: 'whole brain emulation', right: 'wbe', ordinal: 5 },
    ]);
  });

  it('ignores mismatched brackets, text outside the body and unknown terms', () => {
    expect(extractAbbreviationLinks([sentence(6, 'A program named Watson (IBM) won.')], terms)).toEqual([]);
    expect(extractAbbreviationLinks([sentence(7, 'stochastic gradient descent (SGD)', 'notes')], terms)).toEqual([]);
    expect(extractAbbreviationLinks([sentence(8, 'Use gradient boosting (GB) here.')], terms)).toEqual([]);
    expect(extractAbbreviationLinks([sentence(9, 'Words in brackets (see below) are not short forms.')], terms)).toEqual([]);
  });

  it('keeps the first meaning when a short form is reused', () => {
    const links = extractAbbreviationLinks(
      [sentence(10, 'Call it moral permissibility (MP) for now.'), sentence(11, 'Later moral principle (MP) is meant.')],
      terms,
    );
    expect(links).toEqual([{ left: 'moral permissibility', right: 'mp', ordinal: 10 }]);
  });
});
